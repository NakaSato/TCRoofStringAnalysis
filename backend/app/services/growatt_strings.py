"""String analytics from stored history (DB only): classification against peers, inactive / dead
strings, and one string's day detail with its I-V / P-V curve.

Split out of `growatt_overview`, which re-exports these names. Timestamps are plant-local
(Thai) time; values that cannot be computed from stored data are `None`.
"""

from __future__ import annotations

import math
import statistics
from datetime import date, datetime, timedelta
from typing import Any, Dict, List, Optional, Tuple

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.services.growatt_common import GrowattNotFound, S, SAMPLE_H, _bucket, _day_bounds, _fmt_ts, _get_plant, _integrate_kwh, _mean, _round
from app.services.growatt_layout import Layout, load_layout, newest_string_ts


def _synthesize_iv_pv_curve(
    v_oc: float,
    i_sc: float,
    v_mpp: float,
    i_mpp: float,
    n_points: int = 45,
) -> List[Dict[str, float]]:
    """Generate a smooth single-diode-like I-V and P-V curve from key parameters (modelled, not measured)."""
    if v_oc <= 1.0 or i_sc <= 0.05:
        return []
    v_ratio = min(0.95, max(0.55, v_mpp / v_oc))
    i_ratio = min(0.97, max(0.55, i_mpp / i_sc))
    try:
        m = math.log(max(0.02, 1.0 - i_ratio)) / math.log(v_ratio)
        m = max(4.5, min(22.0, m))
    except (ValueError, ZeroDivisionError):
        m = 10.5

    pts: List[Dict[str, float]] = []
    for k in range(n_points + 1):
        v = (v_oc * k) / n_points
        frac = min(1.0, max(0.0, v / v_oc))
        i = max(0.0, i_sc * (1.0 - (frac**m)))
        pts.append({"v": round(v, 2), "i": round(i, 3), "p": round(v * i, 1)})
    return pts


def _classify_strings(
    string_aggs: List[Dict[str, Any]], inv_cap_kwp: Optional[float], layout: Optional[Layout] = None
) -> Tuple[List[Dict[str, Any]], List[Dict[str, Any]], Dict[str, int], Dict[str, List[float]]]:
    """Peer-relative string diagnostics per inverter (same-inverter median as reference).

    Strings of one inverter can have different module counts. When every string of the
    inverter has a count in `layout`, energy is compared per module (per kWp when every
    module rating is known too) and voltage per module, so a 16-module string is not flagged
    against 18-module peers. Otherwise the raw values are compared (`peer_basis = "raw"`).
    Current needs no scaling: modules in a string are in series.
    """
    layout = layout or {}
    by_inv: Dict[str, List[Dict[str, Any]]] = {}
    for x in string_aggs:
        by_inv.setdefault(x["device_sn"], []).append(x)

    strings_summary: List[Dict[str, Any]] = []
    anomalies: List[Dict[str, Any]] = []
    inv_string_counts: Dict[str, int] = {}
    inv_pr_list: Dict[str, List[float]] = {}

    for sn, s_list in by_inv.items():
        inv_string_counts[sn] = len(s_list)
        spec = {x["string_no"]: layout.get((sn, x["string_no"])) for x in s_list}
        per_module = all(v is not None for v in spec.values())
        per_kwp = per_module and all(v[1] for v in spec.values() if v is not None)
        peer_basis = "per_kwp" if per_kwp else "per_module" if per_module else "raw"

        def size(x: Dict[str, Any]) -> float:
            """Relative DC size used to scale energy (1 when not normalizing)."""
            v = spec[x["string_no"]]
            if v is None or not per_module:
                return 1.0
            return v[0] * (v[1] or 1.0) if per_kwp else float(v[0])

        def n_mod(x: Dict[str, Any]) -> float:
            v = spec[x["string_no"]]
            return float(v[0]) if per_module and v is not None else 1.0

        active_energies = [x["energy_kwh"] / size(x) for x in s_list if x["energy_kwh"] > 0.5]
        active_currents = [x["i_avg"] for x in s_list if x["i_avg"] > 0.2]
        active_voltages = [x["v_avg"] / n_mod(x) for x in s_list if x["v_avg"] > 50.0]

        med_energy = statistics.median(active_energies) if active_energies else None
        med_current = statistics.median(active_currents) if active_currents else None
        med_voltage = statistics.median(active_voltages) if active_voltages else None
        total_modules = sum(v[0] for v in spec.values() if v is not None) if per_module else 0

        for x in s_list:
            sno = x["string_no"]
            sid = f"{sn} · STR-{sno:02d}"
            own = spec[sno]
            if own is not None and own[1]:
                str_cap_kwp: Optional[float] = round(own[0] * own[1] / 1000.0, 2)
            elif per_module and own is not None and inv_cap_kwp and total_modules:
                str_cap_kwp = round(inv_cap_kwp * own[0] / total_modules, 2)
            else:
                str_cap_kwp = round(inv_cap_kwp / len(s_list), 2) if inv_cap_kwp else None
            expected = med_energy * size(x) if med_energy is not None else None
            e_ratio = x["energy_kwh"] / expected if expected else None
            i_dev_pct = (x["i_avg"] - med_current) / med_current * 100.0 if med_current else None
            v_norm = x["v_avg"] / n_mod(x)
            v_basis = " per module" if per_module else ""
            v_dev_pct = (v_norm - med_voltage) / med_voltage * 100.0 if med_voltage else None
            i_dev, v_dev = i_dev_pct or 0.0, v_dev_pct or 0.0

            # Peer-relative performance index (88.5 % nominal for top peers) — not IEC 61724 PR,
            # which needs irradiance.
            pr_pct = min(96.5, max(0.0, 88.5 * min(1.08, e_ratio))) if e_ratio is not None else None
            health_score = (
                min(100.0, max(10.0, 92.0 * min(1.08, e_ratio) - max(0.0, abs(v_dev) * 0.5)))
                if e_ratio is not None
                else None
            )

            if x["i_max"] < 0.3 or (pr_pct is not None and pr_pct < 68.0):
                status = "Critical"
                if x["i_max"] < 0.3:
                    diagnosis = "Zero/Near-Zero String Current (Open Circuit / Fuse / Disconnected String)"
                elif v_dev < -8.0:
                    diagnosis = f"Severe Voltage Drop ({v_dev:+.1f}% vs peer{v_basis}) — Possible Bypass Diode / Module Fault"
                else:
                    diagnosis = f"Severe String Underperformance ({i_dev:+.1f}% current vs peer median)"
            elif (pr_pct is not None and pr_pct < 81.0) or i_dev < -12.0 or v_dev < -5.0:
                status = "Warning"
                if v_dev < -5.0:
                    diagnosis = f"Voltage Mismatch ({v_dev:+.1f}% vs MPPT peer{v_basis}) — Partial Shading or Diode Bypass"
                else:
                    diagnosis = f"Current Mismatch ({i_dev:+.1f}% vs peer) — Soiling or Localized Shading"
            else:
                status = "Healthy"
                diagnosis = "Operating within nominal MPPT envelope"

            if pr_pct is not None:
                inv_pr_list.setdefault(sn, []).append(pr_pct)
            loss = round(max(0.0, expected - x["energy_kwh"]), 2) if expected is not None else None

            strings_summary.append(
                {
                    "string_id": sid,
                    "short_label": f"STR-{sno:02d}",
                    "inverter_id": sn,
                    "device_sn": sn,
                    "string_no": sno,
                    "mppt_id": f"MPPT-{x['mppt_no']}",
                    "mppt_no": x["mppt_no"],
                    "capacity_kwp": str_cap_kwp,
                    "modules": own[0] if own is not None else None,
                    "module_wp": own[1] if own is not None else None,
                    "peer_basis": peer_basis,
                    "actual_energy_kwh": x["energy_kwh"],
                    "expected_energy_kwh": _round(expected, 2),
                    "energy_loss_kwh": loss,
                    "pr_pct": _round(pr_pct, 1),
                    "v_avg": x["v_avg"],
                    "v_max": x["v_max"],
                    "i_avg": x["i_avg"],
                    "i_max": x["i_max"],
                    "p_max_w": x["p_max_w"],
                    "current_mismatch_pct": _round(i_dev_pct, 1),
                    "voltage_mismatch_pct": _round(v_dev_pct, 1),
                    "underperf_pct": round(max(0.0, (1.0 - e_ratio) * 100.0), 1) if e_ratio is not None else None,
                    "availability_pct": 100.0 if x["i_max"] >= 0.3 else 0.0,
                    "health_score": _round(health_score, 1),
                    "status": status,
                    "diagnosis": diagnosis,
                }
            )

            if status in ("Critical", "Warning"):
                anomalies.append(
                    {
                        "string_id": sid,
                        "inverter_id": sn,
                        "device_sn": sn,
                        "string_no": sno,
                        "severity": status,
                        "category": "String Mismatch / Underperformance" if x["i_max"] >= 0.3 else "Open String Fault",
                        "description": diagnosis,
                        "pr_pct": _round(pr_pct, 1),
                        "energy_loss_kwh": loss,
                        "recommended_action": "Inspect string connector, fuse holder, and module surface / I-V curve."
                        if status == "Critical"
                        else "Monitor MPPT current balance and schedule module cleaning.",
                    }
                )

    anomalies.sort(key=lambda a: (0 if a["severity"] == "Critical" else 1, a["pr_pct"] if a["pr_pct"] is not None else -1))
    return strings_summary, anomalies, inv_string_counts, inv_pr_list


DEAD_LOOKBACK = timedelta(days=7)
DEAD_PEER_MIN_A = 1.0  # peers must produce this much before a silent string counts as a fault


def _split_inactive(
    db: Session,
    active: List[Dict[str, Any]],
    idle: Dict[Tuple[str, int], Dict[str, Any]],
    mppt_max: Dict[str, int],
    day_start: datetime,
) -> Tuple[List[Dict[str, Any]], List[Dict[str, Any]]]:
    """String inputs without current today, one per input slot 1..2 x highest MPPT seen.

    An input that carried current in the last DEAD_LOOKBACK while its inverter's other strings
    produce today is a fault (open circuit / fuse): returned as a zero aggregate for
    `_classify_strings` (→ Critical). The rest are "Not Active": `reason` is `no_current`
    (MPPT has voltage, string has no current) or `no_data` (input not reported at all).
    """
    present = {(x["device_sn"], x["string_no"]) for x in active} | set(idle)
    peer_ok = {x["device_sn"] for x in active if x["i_max"] >= DEAD_PEER_MIN_A}
    slots: List[Tuple[str, int]] = [
        (sn, n) for sn, m in sorted(mppt_max.items()) for n in range(1, 2 * m + 1)
        if (sn, n) not in present or (sn, n) in idle
    ]
    recent: set = set()
    check = sorted({sn for sn, _ in slots if sn in peer_ok})
    if check:
        recent = {
            (sn, int(no))
            for sn, no in db.execute(
                select(S.device_sn, S.string_no)
                .where(
                    S.device_sn.in_(check),
                    S.timestamp >= day_start - DEAD_LOOKBACK,
                    S.timestamp < day_start,
                    S.current_a >= 0.3,
                )
                .group_by(S.device_sn, S.string_no)
            )
        }
    dead: List[Dict[str, Any]] = []
    inactive: List[Dict[str, Any]] = []
    for sn, n in slots:
        mppt_no = (n + 1) // 2
        row = idle.get((sn, n))
        if (sn, n) in recent:
            v = row["v_max"] if row else 0.0
            dead.append({"device_sn": sn, "string_no": n, "mppt_no": mppt_no, "samples": 0, "v_avg": v, "v_max": v,
                         "i_avg": 0.0, "i_max": 0.0, "p_max_w": 0.0, "energy_kwh": 0.0})
            continue
        inactive.append({
            "string_id": f"{sn} · STR-{n:02d}",
            "short_label": f"STR-{n:02d}",
            "device_sn": sn,
            "string_no": n,
            "mppt_no": mppt_no,
            "mppt_id": f"MPPT-{mppt_no}",
            "status": "Not Active",
            "reason": "no_current" if row else "no_data",
            "v_max": row["v_max"] if row else None,
        })
    return dead, inactive


def build_string_detail(
    db: Session, plant_id: int, device_sn: str, string_no: int, day: Optional[date] = None
) -> Dict[str, Any]:
    """Stored telemetry for one string on one day, plus modelled I-V / P-V curves."""
    """Stored telemetry for one string on one day, plus modelled I-V / P-V curves."""
    plant = _get_plant(db, plant_id)

    if day is None:
        latest = newest_string_ts(db, [device_sn], string_no)
        day = latest.date() if latest else None
    if day is None:
        raise GrowattNotFound(f"No telemetry found for {device_sn} string {string_no}")
    start, end = _day_bounds(day)
    in_day = (S.device_sn == device_sn, S.timestamp >= start, S.timestamp < end)

    rows = db.execute(
        select(S.timestamp, S.mppt_no, S.voltage_v, S.current_a, S.power_w)
        .where(*in_day, S.string_no == string_no)
        .order_by(S.timestamp)
    ).all()
    if not rows:
        raise GrowattNotFound(f"No telemetry found for {device_sn} string {string_no} on {day}")

    # Peer (other strings, same inverter) mean per 5-minute slot. With every module count known,
    # peer voltage / power are scaled to this string's size (current is not: series string).
    peer_rows = db.execute(
        select(S.timestamp, S.string_no, S.voltage_v, S.current_a, S.power_w).where(
            *in_day, S.string_no != string_no, S.current_a > 0.1
        )
    ).all()
    layout = load_layout(db, [device_sn])
    own = layout.get((device_sn, string_no))
    peer_nos = {int(r[1]) for r in peer_rows}
    per_module = own is not None and all((device_sn, n) in layout for n in peer_nos)
    per_kwp = per_module and own is not None and bool(own[1]) and all(layout[(device_sn, n)][1] for n in peer_nos)
    peer_basis = "per_kwp" if per_kwp else "per_module" if per_module else "raw"

    def _scale(n: int) -> Tuple[float, float]:
        """(voltage factor, power factor) mapping peer string `n` onto this string."""
        if not per_module or own is None:
            return 1.0, 1.0
        m, wp = layout[(device_sn, n)]
        v_f = own[0] / m
        return v_f, (own[0] * (own[1] or 1.0)) / (m * (wp or 1.0)) if per_kwp else v_f

    peer_acc: Dict[datetime, List[Tuple[float, float, float]]] = {}
    for ts, n, v, i, p in peer_rows:
        v_f, p_f = _scale(int(n))
        peer_acc.setdefault(_bucket(ts), []).append((v * v_f, i, p * p_f))
    peer_map: Dict[datetime, Tuple[float, float, float]] = {
        ts: tuple(statistics.mean(col) for col in zip(*vals)) for ts, vals in peer_acc.items()  # type: ignore[misc]
    }

    mppt_no = int(rows[0][1])
    timeseries: List[Dict[str, Any]] = []
    voltages: List[float] = []
    currents: List[float] = []

    for ts, _mppt, v, i, p in rows:
        v, i, p = float(v or 0.0), float(i or 0.0), float(p or 0.0)
        peer = peer_map.get(_bucket(ts))
        if v > 50.0:
            voltages.append(v)
        if i > 0.05:
            currents.append(i)
        timeseries.append(
            {
                "timestamp": _fmt_ts(ts.replace(second=0, microsecond=0)),
                "voltage_v": round(v, 2),
                "current_a": round(i, 3),
                "power_w": round(p, 1),
                "peer_voltage_v": round(peer[0], 2) if peer else None,
                "peer_current_a": round(peer[1], 3) if peer else None,
                "peer_power_w": round(peer[2], 1) if peer else None,
            }
        )

    # Operating point at peak measured power; I-V curves below are modelled from it.
    best_row = max(timeseries, key=lambda x: x["power_w"])
    v_mpp_actual = max(250.0, float(best_row["voltage_v"] or 620.0))
    i_mpp_actual = max(0.5, float(best_row["current_a"] or 9.5))
    p_max_w = round(v_mpp_actual * i_mpp_actual, 1)

    v_max = max(voltages) if voltages else v_mpp_actual * 1.16
    v_oc_actual = round(max(v_max * 1.08, v_mpp_actual * 1.18), 1)
    i_sc_actual = round(max(max(currents, default=i_mpp_actual) * 1.07, i_mpp_actual * 1.08), 2)

    peer_v_list = [v[0] for v in peer_map.values() if v[0] > 100]
    peer_i_list = [v[1] for v in peer_map.values() if v[1] > 0.2]

    v_mpp_nom = round(max(v_mpp_actual, max(peer_v_list, default=v_mpp_actual) * 0.98), 1)
    i_mpp_nom = round(max(i_mpp_actual, max(peer_i_list, default=i_mpp_actual)), 2)
    v_oc_nom = round(max(v_oc_actual, v_mpp_nom * 1.19), 1)
    i_sc_nom = round(max(i_sc_actual, i_mpp_nom * 1.08), 2)

    nominal_curve = _synthesize_iv_pv_curve(v_oc_nom, i_sc_nom, v_mpp_nom, i_mpp_nom)
    actual_curve = _synthesize_iv_pv_curve(v_oc_actual, i_sc_actual, v_mpp_actual, i_mpp_actual)

    active_pts = [pt for pt in timeseries if pt["voltage_v"] > 100 and pt["current_a"] > 0.1]
    step = max(1, len(active_pts) // 60)
    scatter_pts = [
        {"v": pt["voltage_v"], "i": pt["current_a"], "p": pt["power_w"], "timestamp": pt["timestamp"]}
        for pt in active_pts[::step]
    ]

    energy_kwh = round(_integrate_kwh((r[0], r[4]) for r in rows), 2)
    # Mean peer power per 5-minute slot × slot length ≈ energy of an average peer string.
    peer_energy_kwh = round(sum(v[2] for v in peer_map.values()) * SAMPLE_H / 1000.0, 2) if peer_map else None
    pr_pct = (
        round(min(96.5, max(0.0, 88.5 * min(1.08, energy_kwh / peer_energy_kwh))), 1) if peer_energy_kwh else None
    )

    return {
        "meta": {"source": "db", "day": day.isoformat()},
        "plant_id": plant.plant_id,
        "plant_name": plant.name,
        "device_sn": device_sn,
        "string_no": string_no,
        "mppt_no": mppt_no,
        "string_id": f"{device_sn} · STR-{string_no:02d}",
        "modules": own[0] if own is not None else None,
        "module_wp": own[1] if own is not None else None,
        # "raw": peers compared as measured; otherwise scaled to this string's module count / kWp
        "peer_basis": peer_basis,
        "summary": {
            "v_avg": _round(_mean(voltages), 1),
            "v_max": round(v_max, 1),
            "v_mpp": round(v_mpp_actual, 1),
            "v_oc_est": v_oc_actual,
            "i_avg": _round(_mean(currents), 2),
            "i_max": round(max(currents, default=0.0), 2),
            "i_mpp": round(i_mpp_actual, 2),
            "i_sc_est": i_sc_actual,
            "p_max_w": p_max_w,
            "energy_kwh": energy_kwh,
            "peer_energy_kwh": peer_energy_kwh,
            "pr_pct": pr_pct,
        },
        "timeseries": timeseries,
        "iv_pv_curve": {
            "nominal_points": nominal_curve,
            "actual_points": actual_curve,
            "measured_scatter": scatter_pts,
            "mpp_nominal": {"v": v_mpp_nom, "i": i_mpp_nom, "p": round(v_mpp_nom * i_mpp_nom, 1)},
            "mpp_actual": {"v": round(v_mpp_actual, 1), "i": round(i_mpp_actual, 2), "p": p_max_w},
        },
    }
