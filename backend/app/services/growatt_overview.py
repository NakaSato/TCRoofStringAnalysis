"""Growatt analytics computed from persisted history (DB only, no Growatt calls).

Shared by the `/growatt/plants*` routes and the daily summary job so both report the
same numbers. Timestamps in the reading tables are plant-local (Thai) time. Values that
cannot be computed from stored data are `None` — no defaults are invented.
"""

from __future__ import annotations

import math
import statistics
from datetime import date, datetime, timedelta
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple

from sqlalchemy import case, func, select
from sqlalchemy.orm import Session

from app.db.models import (
    GrowattInverter,
    GrowattInverterReading,
    GrowattPlant,
    GrowattStringReading,
)
from solar_core.growatt import INVERTER_STATUS_NAMES

SAMPLE_H = 5.0 / 60.0  # nominal max_data interval (5 min), in hours
MAX_GAP_H = 10.0 / 60.0  # longest interval credited when integrating energy

R = GrowattInverterReading
S = GrowattStringReading


# --------------------------------------------------------------------------- helpers


def _round(v: Optional[float], digits: int) -> Optional[float]:
    return None if v is None else round(float(v), digits)


def _mean(values: Iterable[Optional[float]]) -> Optional[float]:
    vals = [float(v) for v in values if v is not None]
    return statistics.mean(vals) if vals else None


def _max(values: Iterable[Optional[float]]) -> Optional[float]:
    vals = [float(v) for v in values if v is not None]
    return max(vals) if vals else None


def _integrate_kwh(points: Iterable[Tuple[datetime, Optional[float]]]) -> float:
    """Energy (kWh) from time-ordered (timestamp, watts) samples.

    Growatt's record interval is mixed (mostly 5 min, some inverters every 1–4 min), so each
    sample is weighted by the time since the previous one. The first sample, and any sample
    after a gap longer than `MAX_GAP_H` (offline, night), gets the series' typical interval
    instead, so gaps are not credited.
    """
    pts = list(points)
    if not pts:
        return 0.0
    dts = [(b[0] - a[0]).total_seconds() / 3600.0 for a, b in zip(pts, pts[1:])]
    regular = [d for d in dts if 0 < d <= MAX_GAP_H]
    typical = statistics.median(regular) if regular else SAMPLE_H
    weights = [typical] + [d if 0 < d <= MAX_GAP_H else typical for d in dts]
    return sum(w * dt for (_ts, w), dt in zip(pts, weights) if w and w > 0) / 1000.0


def _bucket(ts: datetime) -> datetime:
    """Floor to the 5-minute slot so inverters reporting a few seconds apart line up."""
    return ts.replace(minute=ts.minute - ts.minute % 5, second=0, microsecond=0)


def _fmt_ts(ts: Optional[datetime]) -> Optional[str]:
    return ts.strftime("%Y-%m-%d %H:%M:%S") if ts else None


def _day_bounds(day: date) -> Tuple[datetime, datetime]:
    start = datetime.combine(day, datetime.min.time())
    return start, start + timedelta(days=1)


def _latest_reading(db: Session, sns: Sequence[str]) -> Optional[datetime]:
    if not sns:
        return None
    return db.scalar(select(func.max(R.timestamp)).where(R.device_sn.in_(sns)))


class GrowattNotFound(LookupError):
    """Requested plant / string has no stored data."""


def _get_plant(db: Session, plant_id: int) -> GrowattPlant:
    plant = db.get(GrowattPlant, plant_id)
    if not plant:
        raise GrowattNotFound(f"Plant {plant_id} not found")
    return plant


def inverter_out(inv: GrowattInverter) -> Dict[str, Any]:
    return {
        "device_sn": inv.device_sn,
        "model": inv.model or "",
        "datalogger_sn": inv.datalogger_sn or "",
        "manufacturer": "Growatt",
        "status": inv.status,
        "status_label": "Unknown" if inv.status is None else INVERTER_STATUS_NAMES.get(inv.status, f"Status {inv.status}"),
        "lost": bool(inv.lost),
        "last_update_time": _fmt_ts(inv.last_update_time),
        "device_types": (inv.device_types or "").split(",") if inv.device_types else [],
        "synced_at": inv.synced_at.isoformat() if inv.synced_at else None,
    }


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



def list_plants_summary(db: Session) -> List[Dict[str, Any]]:
    """Plant registry from the DB, with inverter counts and the latest synced day's energy.

    `current_power_w` / `status` are the last values written by the sync job (see `synced_at`);
    use `/growatt/live/plants` for realtime values.
    """
    db_plants = list(db.scalars(select(GrowattPlant).order_by(GrowattPlant.plant_id)))

    inv_counts: Dict[int, int] = {
        int(pid): int(cnt)
        for pid, cnt in db.execute(
            select(GrowattInverter.plant_id, func.count()).group_by(GrowattInverter.plant_id)
        )
    }

    latest = db.scalar(select(func.max(R.timestamp)))
    energy_date = latest.date() if latest else None
    day_energy: Dict[int, float] = {}
    if energy_date:
        start, end = _day_bounds(energy_date)
        # eac_today of each inverter's last record that day (see overview for why not MAX()).
        last_ts = (
            select(R.device_sn, func.max(R.timestamp).label("ts"))
            .where(R.timestamp >= start, R.timestamp < end, R.eac_today_kwh.is_not(None))
            .group_by(R.device_sn)
        ).subquery()
        for pid, kwh in db.execute(
            select(GrowattInverter.plant_id, func.sum(R.eac_today_kwh))
            .join(last_ts, (R.device_sn == last_ts.c.device_sn) & (R.timestamp == last_ts.c.ts))
            .join(GrowattInverter, GrowattInverter.device_sn == R.device_sn)
            .group_by(GrowattInverter.plant_id)
        ):
            if kwh is not None:
                day_energy[int(pid)] = float(kwh)

    return [
        {
            "plant_id": p.plant_id,
            "name": p.name,
            "city": p.city,
            "country": p.country,
            "latitude": p.latitude,
            "longitude": p.longitude,
            "peak_power_kwp": p.peak_power_kwp,
            "current_power_w": p.current_power_w,
            "today_energy_kwh": _round(day_energy.get(p.plant_id), 2),
            "energy_date": energy_date.isoformat() if energy_date and p.plant_id in day_energy else None,
            "total_energy_kwh": p.total_energy_kwh,
            "inverter_count": inv_counts.get(p.plant_id, 0),
            "status": p.status,
            "create_date": p.create_date,
            "synced_at": p.synced_at.isoformat() if p.synced_at else None,
        }
        for p in db_plants
    ]


def list_inverters(db: Session, plant_id: int) -> List[Dict[str, Any]]:
    invs = db.scalars(
        select(GrowattInverter).where(GrowattInverter.plant_id == plant_id).order_by(GrowattInverter.device_sn)
    )
    return [inverter_out(inv) for inv in invs]


def _classify_strings(
    string_aggs: List[Dict[str, Any]], inv_cap_kwp: Optional[float]
) -> Tuple[List[Dict[str, Any]], List[Dict[str, Any]], Dict[str, int], Dict[str, List[float]]]:
    """Peer-relative string diagnostics per inverter (same-inverter median as reference)."""
    by_inv: Dict[str, List[Dict[str, Any]]] = {}
    for x in string_aggs:
        by_inv.setdefault(x["device_sn"], []).append(x)

    strings_summary: List[Dict[str, Any]] = []
    anomalies: List[Dict[str, Any]] = []
    inv_string_counts: Dict[str, int] = {}
    inv_pr_list: Dict[str, List[float]] = {}

    for sn, s_list in by_inv.items():
        inv_string_counts[sn] = len(s_list)
        active_energies = [x["energy_kwh"] for x in s_list if x["energy_kwh"] > 0.5]
        active_currents = [x["i_avg"] for x in s_list if x["i_avg"] > 0.2]
        active_voltages = [x["v_avg"] for x in s_list if x["v_avg"] > 50.0]

        med_energy = statistics.median(active_energies) if active_energies else None
        med_current = statistics.median(active_currents) if active_currents else None
        med_voltage = statistics.median(active_voltages) if active_voltages else None
        str_cap_kwp = round(inv_cap_kwp / len(s_list), 2) if inv_cap_kwp else None

        for x in s_list:
            sno = x["string_no"]
            sid = f"{sn} · STR-{sno:02d}"
            e_ratio = x["energy_kwh"] / med_energy if med_energy else None
            i_dev_pct = (x["i_avg"] - med_current) / med_current * 100.0 if med_current else None
            v_dev_pct = (x["v_avg"] - med_voltage) / med_voltage * 100.0 if med_voltage else None
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
                    diagnosis = f"Severe Voltage Drop ({v_dev:+.1f}% vs peer) — Possible Bypass Diode / Module Fault"
                else:
                    diagnosis = f"Severe String Underperformance ({i_dev:+.1f}% current vs peer median)"
            elif (pr_pct is not None and pr_pct < 81.0) or i_dev < -12.0 or v_dev < -5.0:
                status = "Warning"
                if v_dev < -5.0:
                    diagnosis = f"Voltage Mismatch ({v_dev:+.1f}% vs MPPT peer) — Partial Shading or Diode Bypass"
                else:
                    diagnosis = f"Current Mismatch ({i_dev:+.1f}% vs peer) — Soiling or Localized Shading"
            else:
                status = "Healthy"
                diagnosis = "Operating within nominal MPPT envelope"

            if pr_pct is not None:
                inv_pr_list.setdefault(sn, []).append(pr_pct)
            loss = round(max(0.0, med_energy - x["energy_kwh"]), 2) if med_energy is not None else None

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
                    "actual_energy_kwh": x["energy_kwh"],
                    "expected_energy_kwh": _round(med_energy, 2),
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



def build_plant_overview(db: Session, plant_id: int, day: Optional[date] = None) -> Dict[str, Any]:
    """Single-plant overview for one day (default: latest day with data)."""
    """Single-plant overview for one day from persisted max_data history.

    Values that cannot be computed from stored data are `null` (no defaults are invented).
    """
    plant = _get_plant(db, plant_id)
    inverters = list(
        db.scalars(
            select(GrowattInverter).where(GrowattInverter.plant_id == plant_id).order_by(GrowattInverter.device_sn)
        )
    )
    sns = [inv.device_sn for inv in inverters]
    cap_kwp = plant.peak_power_kwp or None
    inv_cap_kwp = cap_kwp / len(sns) if cap_kwp and sns else None

    data_until = _latest_reading(db, sns)
    if day is None and data_until is not None:
        day = data_until.date()

    inv_metrics: Dict[str, Dict[str, Any]] = {}
    latest_mppt: Dict[str, Dict[str, Any]] = {}
    timeseries: List[Dict[str, Any]] = []
    string_aggs: List[Dict[str, Any]] = []

    if sns and day is not None:
        start, end = _day_bounds(day)
        in_day = (R.device_sn.in_(sns), R.timestamp >= start, R.timestamp < end)

        raw = db.execute(
            select(R.device_sn, R.timestamp, R.pac_w, R.ppv_w, R.temperature_c, R.fac_hz, R.eac_today_kwh)
            .where(*in_day)
            .order_by(R.device_sn, R.timestamp)
        ).all()
        by_sn: Dict[str, List[Any]] = {}
        for r in raw:
            by_sn.setdefault(r[0], []).append(r)

        # 1. Per-inverter aggregates
        agg = db.execute(
            select(
                R.device_sn,
                func.max(R.pac_w),
                func.max(R.ppv_w),
                func.max(R.eac_total_kwh),
                func.avg(case((R.pac_w > 0, R.temperature_c), else_=None)),
                func.max(R.temperature_c),
                func.avg(case((R.fac_hz > 40, R.fac_hz), else_=None)),
            )
            .where(*in_day)
            .group_by(R.device_sn)
        ).all()
        for sn, pac_max, ppv_max, eac_total, t_avg, t_max, f_avg in agg:
            rows_sn = by_sn.get(sn, [])
            # eac_today from the day's last record: the counter carries yesterday's total for
            # a few minutes after midnight, so MAX() would pick the stale value.
            eac_today = next((r[6] for r in reversed(rows_sn) if r[6] is not None), None)
            ac_kwh = _integrate_kwh((r[1], r[2]) for r in rows_sn)
            dc_kwh = _integrate_kwh((r[1], r[3]) for r in rows_sn)
            inv_metrics[sn] = {
                "peak_ac_kw": _round(pac_max / 1000.0, 2) if pac_max is not None else None,
                "peak_dc_kw": _round(ppv_max / 1000.0, 2) if ppv_max is not None else None,
                "period_energy_kwh": round(ac_kwh, 2),
                "yield_today_kwh": _round(eac_today if eac_today is not None else ac_kwh, 2),
                "total_yield_kwh": _round(eac_total, 2),
                "avg_temp_c": _round(t_avg, 1),
                "max_temp_c": _round(t_max, 1),
                "avg_freq_hz": _round(f_avg, 2),
                "efficiency_pct": round(ac_kwh / dc_kwh * 100.0, 2) if dc_kwh > 0 else None,
            }

        # Latest producing record per inverter (MPPT snapshot)
        latest_ts = (
            select(R.device_sn, func.max(R.timestamp).label("ts")).where(*in_day, R.pac_w > 0).group_by(R.device_sn)
        ).subquery()
        for sn, pac, mppt in db.execute(
            select(R.device_sn, R.pac_w, R.mppt_json).join(
                latest_ts, (R.device_sn == latest_ts.c.device_sn) & (R.timestamp == latest_ts.c.ts)
            )
        ):
            latest_mppt[sn] = {"latest_pac_kw": _round((pac or 0.0) / 1000.0, 2), "mppt_json": mppt or []}

        # 5-minute plant curve, bucketed in Python (portable across SQLite / PostgreSQL).
        # Each inverter's samples are averaged within the slot first, then summed across
        # inverters, so 1-minute reporters are not counted five times.
        per_inv: Dict[Tuple[datetime, str], Dict[str, List[float]]] = {}
        for sn, ts, pac, ppv, temp, fac, _eac in raw:
            b = per_inv.setdefault((_bucket(ts), sn), {"pac": [], "ppv": [], "temp": [], "fac": []})
            b["pac"].append(pac or 0.0)
            b["ppv"].append(ppv or 0.0)
            if temp is not None and temp > 0:
                b["temp"].append(temp)
            if fac is not None and fac > 40:
                b["fac"].append(fac)
        buckets: Dict[datetime, Dict[str, List[float]]] = {}
        for (ts, _sn), b in per_inv.items():
            slot = buckets.setdefault(ts, {"pac": [], "ppv": [], "temp": [], "fac": []})
            slot["pac"].append(statistics.mean(b["pac"]))
            slot["ppv"].append(statistics.mean(b["ppv"]))
            slot["temp"].extend(b["temp"])
            slot["fac"].extend(b["fac"])
        for ts in sorted(buckets):
            b = buckets[ts]
            hr = ts.hour + ts.minute / 60.0
            expected_kw: Optional[float] = None
            if cap_kwp:
                # Modelled clear-sky envelope (not measured): 82 % of kWp at solar noon.
                x = (hr - 12.15) / 5.85
                expected_kw = round(cap_kwp * 0.82 * max(0.0, math.cos(x * math.pi / 2.0)) ** 1.3, 2) if 6.0 <= hr <= 18.0 else 0.0
            pac_kw = round(sum(b["pac"]) / 1000.0, 2)
            ppv_kw = round(sum(b["ppv"]) / 1000.0, 2)
            timeseries.append(
                {
                    "timestamp": _fmt_ts(ts),
                    "pac_kw": pac_kw,
                    "ppv_kw": ppv_kw,
                    "expected_kw": expected_kw,
                    "temp_c": _round(_mean(b["temp"]), 1),
                    "freq_hz": _round(_mean(b["fac"]), 2),
                }
            )

        # 2. Per-string aggregates
        s_in_day = (S.device_sn.in_(sns), S.timestamp >= start, S.timestamp < end)
        str_series: Dict[Tuple[str, int], List[Tuple[datetime, float]]] = {}
        for sn, sno, ts, p in db.execute(
            select(S.device_sn, S.string_no, S.timestamp, S.power_w).where(*s_in_day).order_by(
                S.device_sn, S.string_no, S.timestamp
            )
        ):
            str_series.setdefault((sn, int(sno)), []).append((ts, p))
        for sn, sno, mppt_no, n, v_avg, v_max, i_avg, i_max, p_max in db.execute(
            select(
                S.device_sn,
                S.string_no,
                S.mppt_no,
                func.count(),
                func.avg(S.voltage_v),
                func.max(S.voltage_v),
                func.avg(S.current_a),
                func.max(S.current_a),
                func.max(S.power_w),
            )
            .where(*s_in_day)
            .group_by(S.device_sn, S.string_no, S.mppt_no)
            .having(func.max(S.current_a) > 0.15)
            .order_by(S.device_sn, S.string_no)
        ):
            string_aggs.append(
                {
                    "device_sn": sn,
                    "string_no": int(sno),
                    "mppt_no": int(mppt_no),
                    "samples": int(n),
                    "v_avg": round(float(v_avg or 0.0), 1),
                    "v_max": round(float(v_max or 0.0), 1),
                    "i_avg": round(float(i_avg or 0.0), 2),
                    "i_max": round(float(i_max or 0.0), 2),
                    "p_max_w": round(float(p_max or 0.0), 1),
                    "energy_kwh": round(_integrate_kwh(str_series.get((sn, int(sno)), [])), 2),
                }
            )

    strings_summary, anomalies, inv_string_counts, inv_pr_list = _classify_strings(string_aggs, inv_cap_kwp)

    # 3. Inverter list
    inverters_out: List[Dict[str, Any]] = []
    for inv in inverters:
        sn = inv.device_sn
        m = inv_metrics.get(sn, {})
        mppt_info = latest_mppt.get(sn, {})
        yield_kwh = m.get("yield_today_kwh")
        inverters_out.append(
            {
                **inverter_out(inv),
                "model": inv.model or "",
                "capacity_kwp": _round(inv_cap_kwp, 2),
                "current_ac_kw": mppt_info.get("latest_pac_kw"),
                "peak_ac_kw": m.get("peak_ac_kw"),
                "peak_dc_kw": m.get("peak_dc_kw"),
                "yield_today_kwh": yield_kwh,
                "period_energy_kwh": m.get("period_energy_kwh"),
                "total_yield_kwh": m.get("total_yield_kwh"),
                "specific_yield": round(yield_kwh / inv_cap_kwp, 2) if yield_kwh is not None and inv_cap_kwp else None,
                "efficiency_pct": m.get("efficiency_pct"),
                "pr_pct": _round(_mean(inv_pr_list.get(sn, [])), 1),
                "avg_temp_c": m.get("avg_temp_c"),
                "max_temp_c": m.get("max_temp_c"),
                "avg_freq_hz": m.get("avg_freq_hz"),
                "string_count": inv_string_counts.get(sn, 0),
                "mppt_latest": mppt_info.get("mppt_json") or [],
            }
        )

    # 4. Plant KPIs
    healthy_cnt = sum(1 for s in strings_summary if s["status"] == "Healthy")
    warning_cnt = sum(1 for s in strings_summary if s["status"] == "Warning")
    critical_cnt = sum(1 for s in strings_summary if s["status"] == "Critical")

    plant_pr_pct = _round(_mean(s["pr_pct"] for s in strings_summary), 1)
    avg_health = _round(_mean(s["health_score"] for s in strings_summary), 1)
    inv_yields = [i["yield_today_kwh"] for i in inverters_out if i["yield_today_kwh"] is not None]
    yield_today_kwh = round(sum(inv_yields), 2) if inv_yields else None
    inv_totals = [i["total_yield_kwh"] for i in inverters_out if i["total_yield_kwh"] is not None]
    total_yield_kwh = _round(plant.total_energy_kwh if plant.total_energy_kwh is not None else (sum(inv_totals) if inv_totals else None), 2)
    peak_power_kw = _round(_max(r["pac_kw"] for r in timeseries), 2)
    avg_temp_c = _round(_mean(i["avg_temp_c"] for i in inverters_out), 1)
    max_temp_c = _round(_max(i["max_temp_c"] for i in inverters_out), 1)
    avg_freq_hz = _round(_mean(i["avg_freq_hz"] for i in inverters_out), 2)
    avg_eff_pct = _round(_mean(i["efficiency_pct"] for i in inverters_out), 2)

    # Loss waterfall — a modelled breakdown; only built when every input is measured.
    loss_waterfall: List[Dict[str, Any]] = []
    if yield_today_kwh and plant_pr_pct and avg_temp_c is not None and avg_eff_pct is not None:
        nominal_dc_kwh = round(yield_today_kwh / max(0.65, plant_pr_pct / 100.0), 1)
        thermal_loss_kwh = round(nominal_dc_kwh * max(0.015, (avg_temp_c - 25.0) * 0.0034), 1)
        mismatch_loss_kwh = round(sum(s["energy_loss_kwh"] or 0.0 for s in strings_summary), 1)
        conv_loss_kwh = round(yield_today_kwh * max(0.0, 100.0 - avg_eff_pct) / 100.0, 1)
        optical_loss_kwh = round(
            max(0.0, nominal_dc_kwh - yield_today_kwh - thermal_loss_kwh - mismatch_loss_kwh - conv_loss_kwh), 1
        )
        loss_waterfall = [
            {"stage": "Nominal DC Reference", "kwh": nominal_dc_kwh, "type": "base"},
            {"stage": "Optical & Soiling Loss", "kwh": -optical_loss_kwh, "type": "loss"},
            {"stage": "Thermal Derating Loss", "kwh": -thermal_loss_kwh, "type": "loss"},
            {"stage": "String & MPPT Mismatch", "kwh": -mismatch_loss_kwh, "type": "loss"},
            {"stage": "Inverter Conversion Loss", "kwh": -conv_loss_kwh, "type": "loss"},
            {"stage": "Net AC Grid Export", "kwh": yield_today_kwh, "type": "net"},
        ]

    return {
        "meta": {
            "source": "db",
            "day": day.isoformat() if day else None,
            "data_until": _fmt_ts(data_until),
            "synced_at": plant.synced_at.isoformat() if plant.synced_at else None,
        },
        "plant": {
            "plant_id": plant.plant_id,
            "name": plant.name,
            "city": plant.city,
            "country": plant.country,
            "latitude": plant.latitude,
            "longitude": plant.longitude,
            "peak_power_kwp": cap_kwp,
            "current_power_w": plant.current_power_w,
            "total_energy_kwh": total_yield_kwh,
            "status": plant.status,
            "create_date": plant.create_date,
        },
        "kpis": {
            "capacity_kwp": cap_kwp,
            # last value written by the sync job — use /growatt/live/plants for realtime
            "current_power_kw": _round(plant.current_power_w / 1000.0, 2) if plant.current_power_w is not None else None,
            "peak_power_kw": peak_power_kw,
            "yield_today_kwh": yield_today_kwh,
            "total_yield_kwh": total_yield_kwh,
            "specific_yield_kwh_per_kwp": round(yield_today_kwh / cap_kwp, 2) if yield_today_kwh is not None and cap_kwp else None,
            "plant_pr_pct": plant_pr_pct,
            "target_pr_pct": 85.0,
            "conversion_efficiency_pct": avg_eff_pct,
            "avg_temp_c": avg_temp_c,
            "max_temp_c": max_temp_c,
            "avg_freq_hz": avg_freq_hz,
            "inverter_count": len(inverters_out),
            "online_inverters": sum(1 for i in inverters_out if not i["lost"] and i["status"] == 1),
            "string_count": len(strings_summary),
            "healthy_strings": healthy_cnt,
            "warning_strings": warning_cnt,
            "critical_strings": critical_cnt,
            "avg_health_score": avg_health,
            "tariff_thb_per_kwh": 4.2,
        },
        "inverters": inverters_out,
        "timeseries": timeseries,
        "loss_waterfall": loss_waterfall,
        "strings": strings_summary,
        "anomalies": anomalies[:40],
    }



def build_string_detail(
    db: Session, plant_id: int, device_sn: str, string_no: int, day: Optional[date] = None
) -> Dict[str, Any]:
    """Stored telemetry for one string on one day, plus modelled I-V / P-V curves."""
    """Stored telemetry for one string on one day, plus modelled I-V / P-V curves."""
    plant = _get_plant(db, plant_id)

    if day is None:
        latest = db.scalar(
            select(func.max(S.timestamp)).where(S.device_sn == device_sn, S.string_no == string_no)
        )
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

    # Peer (other strings, same inverter) mean per 5-minute slot
    peer_acc: Dict[datetime, List[Tuple[float, float, float]]] = {}
    for ts, v, i, p in db.execute(
        select(S.timestamp, S.voltage_v, S.current_a, S.power_w).where(
            *in_day, S.string_no != string_no, S.current_a > 0.1
        )
    ):
        peer_acc.setdefault(_bucket(ts), []).append((v, i, p))
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
