"""Growatt analytics computed from persisted history (DB only, no Growatt calls).

Shared by the `/growatt/plants*` routes and the daily summary job so both report the
same numbers. Timestamps in the reading tables are plant-local (Thai) time. Values that
cannot be computed from stored data are `None` — no defaults are invented.
"""

from __future__ import annotations

import math
import statistics
from datetime import date, datetime, timedelta
from typing import Any, Dict, Iterable, List, Optional, Sequence, Set, Tuple

from sqlalchemy import case, delete, func, select
from sqlalchemy.orm import Session

from app.services import growatt_weather
from app.services.fleet_settings import get_fleet_module
from app.db.models import (
    GrowattInverter,
    GrowattInverterReading,
    GrowattPlant,
    GrowattStringLayout,
    GrowattStringReading,
)

SAMPLE_H = 5.0 / 60.0  # nominal max_data interval (5 min), in hours
MAX_GAP_H = 10.0 / 60.0  # longest interval credited when integrating energy

R = GrowattInverterReading
S = GrowattStringReading


# --------------------------------------------------------------------------- plant capacity

# A plant's DC capacity is never this many times its inverters' rated AC power (real plants
# run about 1.0-1.5). Above it, Growatt's `peak_power` is wrong at the source (e.g. typed in
# W instead of kW in the portal), so it is treated as unknown rather than corrected by guess.
MAX_DC_AC_RATIO = 3.0


def plant_rated_ac_w(db: Session, plant_ids: Optional[Sequence[int]] = None) -> Dict[int, float]:
    """Summed rated AC power (W) per plant, only for plants where every inverter has one."""
    q = select(
        GrowattInverter.plant_id,
        func.sum(GrowattInverter.nominal_power_w),
        func.count(GrowattInverter.nominal_power_w),
        func.count(),
    ).group_by(GrowattInverter.plant_id)
    if plant_ids is not None:
        q = q.where(GrowattInverter.plant_id.in_(list(plant_ids)))
    return {int(pid): float(w) for pid, w, known, n in db.execute(q) if w and known == n}


def plausible_capacity_kwp(peak_kwp: Optional[float], rated_ac_w: Optional[float]) -> Optional[float]:
    """Growatt's plant peak power, or None when missing or impossible for its inverters
    (more than `MAX_DC_AC_RATIO` x their rated AC power). Unknown rating: kept as reported."""
    if not peak_kwp or peak_kwp <= 0:
        return None
    if rated_ac_w and peak_kwp > MAX_DC_AC_RATIO * rated_ac_w / 1000.0:
        return None
    return float(peak_kwp)


def capacity_check(db: Session, plant: GrowattPlant) -> Tuple[Optional[float], Optional[float]]:
    """(capacity used, Growatt's value when it was rejected as implausible, else None)."""
    cap = plausible_capacity_kwp(plant.peak_power_kwp, plant_rated_ac_w(db, [plant.plant_id]).get(plant.plant_id))
    rejected = plant.peak_power_kwp if cap is None and plant.peak_power_kwp else None
    return cap, rejected


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


def plant_phase(db: Session, plant_id: int) -> Optional[int]:
    """Project phase (Growatt account) of a plant; None if unknown or not yet tagged."""
    return db.scalar(select(GrowattPlant.phase).where(GrowattPlant.plant_id == plant_id))


def plant_coords(db: Session, plant_id: Optional[int] = None) -> List[Tuple[float, float]]:
    """(lat, lon) of one plant, or of every plant; plants without coordinates are left out."""
    q = select(GrowattPlant.latitude, GrowattPlant.longitude).where(
        GrowattPlant.latitude.is_not(None), GrowattPlant.longitude.is_not(None)
    )
    if plant_id is not None:
        q = q.where(GrowattPlant.plant_id == plant_id)
    return [(float(lat), float(lon)) for lat, lon in db.execute(q).all() if lat is not None and lon is not None]


def inverter_out(inv: GrowattInverter) -> Dict[str, Any]:
    """Registry fields. Status, lost and last upload time are realtime: null here, the UI
    fills them from `/growatt/live/plants/{id}/inverters`."""
    return {
        "device_sn": inv.device_sn,
        "model": inv.model or "",
        "datalogger_sn": inv.datalogger_sn or "",
        "manufacturer": "Growatt",
        "status": None,
        "status_label": None,
        "lost": None,
        "last_update_time": None,
        "device_types": (inv.device_types or "").split(",") if inv.device_types else [],
        "alias": inv.alias,
        "nominal_power_kw": round(inv.nominal_power_w / 1000, 1) if inv.nominal_power_w else None,
        "fw_version": inv.fw_version,
        "inner_version": inv.inner_version,
        # configured settings (as read at info_synced_at), not measurements
        "settings": {
            "active_rate_pct": inv.active_rate_pct,
            "reactive_rate_pct": inv.reactive_rate_pct,
            "pf_setting": inv.pf_setting,
            "pf_model": inv.pf_model,
            "export_limit": inv.export_limit,
            "export_limit_rate_pct": inv.export_limit_rate_pct,
            "on_off": inv.on_off,
            "read_at": inv.info_synced_at.isoformat() if inv.info_synced_at else None,
        },
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



def list_plants_summary(db: Session, plant_ids: Optional[Set[int]] = None) -> List[Dict[str, Any]]:
    """Plant registry from the DB, with inverter counts and energy from stored history.

    `total_energy_kwh` is the sum of each inverter's newest stored `eac_total`.
    `current_power_w` and `status` are realtime and always null here; the UI fills them from
    `/growatt/live/plants`. `plant_ids` limits the list (an engineer's assignments); None = all.
    """
    q = select(GrowattPlant).order_by(GrowattPlant.phase.is_(None), GrowattPlant.phase, GrowattPlant.plant_id)
    if plant_ids is not None:
        if not plant_ids:
            return []
        q = q.where(GrowattPlant.plant_id.in_(plant_ids))
    db_plants = list(db.scalars(q))

    rated_ac = plant_rated_ac_w(db)
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

    # Lifetime energy: each inverter's newest stored eac_total counter, summed per plant.
    last_total_ts = (
        select(R.device_sn, func.max(R.timestamp).label("ts"))
        .where(R.eac_total_kwh.is_not(None))
        .group_by(R.device_sn)
    ).subquery()
    lifetime: Dict[int, float] = {}
    for pid, kwh in db.execute(
        select(GrowattInverter.plant_id, func.sum(R.eac_total_kwh))
        .join(last_total_ts, (R.device_sn == last_total_ts.c.device_sn) & (R.timestamp == last_total_ts.c.ts))
        .join(GrowattInverter, GrowattInverter.device_sn == R.device_sn)
        .group_by(GrowattInverter.plant_id)
    ):
        if kwh is not None:
            lifetime[int(pid)] = float(kwh)

    return [
        {
            "plant_id": p.plant_id,
            "phase": p.phase,
            "name": p.name,
            "city": p.city,
            "country": p.country,
            "latitude": p.latitude,
            "longitude": p.longitude,
            "peak_power_kwp": plausible_capacity_kwp(p.peak_power_kwp, rated_ac.get(p.plant_id)),
            # Growatt's peak power when rejected as impossible for the plant's inverters
            "reported_peak_power_kwp": (
                p.peak_power_kwp
                if p.peak_power_kwp and plausible_capacity_kwp(p.peak_power_kwp, rated_ac.get(p.plant_id)) is None
                else None
            ),
            "current_power_w": None,  # realtime: /growatt/live/plants
            "today_energy_kwh": _round(day_energy.get(p.plant_id), 2),
            "energy_date": energy_date.isoformat() if energy_date and p.plant_id in day_energy else None,
            "total_energy_kwh": _round(lifetime.get(p.plant_id), 2),
            "inverter_count": inv_counts.get(p.plant_id, 0),
            "status": None,  # realtime: /growatt/live/plants
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


# --------------------------------------------------------------------------- string layout

# (device_sn, string_no) -> (modules, module_wp or None)
Layout = Dict[Tuple[str, int], Tuple[int, Optional[float]]]

LAYOUT_SEEN_LOOKBACK = timedelta(days=7)


def load_layout(db: Session, sns: Sequence[str], fleet_wp: bool = True) -> Layout:
    """Registry rows for `sns`. A string without its own `module_wp` gets the fleet module's
    rating (global setting) unless `fleet_wp` is False (raw rows, for the editor)."""
    if not sns:
        return {}
    default_wp = get_fleet_module(db).get("wp") if fleet_wp else None
    return {
        (r.device_sn, int(r.string_no)): (int(r.modules), r.module_wp if r.module_wp is not None else default_wp)
        for r in db.scalars(select(GrowattStringLayout).where(GrowattStringLayout.device_sn.in_(list(sns))))
    }


def get_string_layout(db: Session, plant_id: int) -> Dict[str, Any]:
    """Module count per string input of a plant: registry rows plus inputs seen in the last week.

    `modules` is null where nobody has entered it yet; nothing is guessed.
    """
    plant = _get_plant(db, plant_id)
    invs = list(
        db.scalars(select(GrowattInverter).where(GrowattInverter.plant_id == plant_id).order_by(GrowattInverter.device_sn))
    )
    sns = [inv.device_sn for inv in invs]
    layout = load_layout(db, sns, fleet_wp=False)
    seen: Dict[Tuple[str, int], int] = {}
    latest = db.scalar(select(func.max(S.timestamp)).where(S.device_sn.in_(sns))) if sns else None
    if latest is not None:
        for sn, sno, mppt in db.execute(
            select(S.device_sn, S.string_no, func.max(S.mppt_no))
            .where(S.device_sn.in_(sns), S.timestamp >= latest - LAYOUT_SEEN_LOOKBACK, S.current_a > INACTIVE_MAX_A)
            .group_by(S.device_sn, S.string_no)
        ):
            seen[(sn, int(sno))] = int(mppt)
    out = []
    for inv in invs:
        nos = sorted({n for s, n in seen if s == inv.device_sn} | {n for s, n in layout if s == inv.device_sn})
        out.append(
            {
                "device_sn": inv.device_sn,
                "model": inv.model or "",
                "strings": [
                    {
                        "string_no": n,
                        "mppt_no": seen.get((inv.device_sn, n), (n + 1) // 2),
                        "modules": layout[(inv.device_sn, n)][0] if (inv.device_sn, n) in layout else None,
                        "module_wp": layout[(inv.device_sn, n)][1] if (inv.device_sn, n) in layout else None,
                        "active": (inv.device_sn, n) in seen,
                    }
                    for n in nos
                ],
            }
        )
    return {
        "plant_id": plant.plant_id,
        "plant_name": plant.name,
        # used for strings whose module_wp is null
        "fleet_module_wp": get_fleet_module(db).get("wp"),
        "inverters": out,
    }


def put_string_layout(db: Session, plant_id: int, entries: Iterable[Dict[str, Any]]) -> Dict[str, Any]:
    """Replace the plant's module-count registry with `entries` (strings left out are cleared)."""
    _get_plant(db, plant_id)
    sns = set(db.scalars(select(GrowattInverter.device_sn).where(GrowattInverter.plant_id == plant_id)))
    rows: Dict[Tuple[str, int], GrowattStringLayout] = {}
    for e in entries:
        sn = str(e["device_sn"])
        if sn not in sns:
            raise ValueError(f"Inverter {sn} does not belong to plant {plant_id}")
        key = (sn, int(e["string_no"]))
        if key in rows:
            raise ValueError(f"Duplicate entry for {sn} string {key[1]}")
        rows[key] = GrowattStringLayout(
            device_sn=sn, string_no=key[1], modules=int(e["modules"]), module_wp=e.get("module_wp")
        )
    if sns:
        db.execute(delete(GrowattStringLayout).where(GrowattStringLayout.device_sn.in_(sns)))
    db.add_all(rows.values())
    db.commit()
    return get_string_layout(db, plant_id)


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



INACTIVE_MAX_A = 0.15  # a string whose current never exceeds this all day carries no PV
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


def _expected_kw(cap_kwp: Optional[float], hr: float) -> Optional[float]:
    """Modelled clear-sky envelope (not measured): 82 % of kWp at solar noon."""
    if not cap_kwp:
        return None
    if not 6.0 <= hr <= 18.0:
        return 0.0
    x = (hr - 12.15) / 5.85
    return round(cap_kwp * 0.82 * max(0.0, math.cos(x * math.pi / 2.0)) ** 1.3, 2)


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
    cap_kwp, rejected_kwp = capacity_check(db, plant)
    inv_cap_kwp = cap_kwp / len(sns) if cap_kwp and sns else None

    data_until = _latest_reading(db, sns)
    if day is None and data_until is not None:
        day = data_until.date()

    inv_metrics: Dict[str, Dict[str, Any]] = {}
    latest_mppt: Dict[str, Dict[str, Any]] = {}
    timeseries: List[Dict[str, Any]] = []
    string_aggs: List[Dict[str, Any]] = []
    inactive_strings: List[Dict[str, Any]] = []

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
            expected_kw = _expected_kw(cap_kwp, hr)
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
        mppt_max: Dict[str, int] = {}
        idle: Dict[Tuple[str, int], Dict[str, Any]] = {}
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
            .order_by(S.device_sn, S.string_no)
        ):
            mppt_max[sn] = max(mppt_max.get(sn, 0), int(mppt_no))
            if float(i_max or 0.0) <= INACTIVE_MAX_A:
                idle[(sn, int(sno))] = {"mppt_no": int(mppt_no), "v_max": round(float(v_max or 0.0), 1)}
                continue
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

        dead, inactive_strings = _split_inactive(db, string_aggs, idle, mppt_max, start)
        string_aggs.extend(dead)
        string_aggs.sort(key=lambda x: (x["device_sn"], x["string_no"]))

    layout = load_layout(db, sns)
    strings_summary, anomalies, inv_string_counts, inv_pr_list = _classify_strings(string_aggs, inv_cap_kwp, layout)

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
    total_yield_kwh = _round(sum(inv_totals) if inv_totals else None, 2)
    peak_power_kw = _round(_max(r["pac_kw"] for r in timeseries), 2)
    avg_temp_c = _round(_mean(i["avg_temp_c"] for i in inverters_out), 1)
    max_temp_c = _round(_max(i["max_temp_c"] for i in inverters_out), 1)
    avg_freq_hz = _round(_mean(i["avg_freq_hz"] for i in inverters_out), 2)
    avg_eff_pct = _round(_mean(i["efficiency_pct"] for i in inverters_out), 2)

    # Weather sensor (measured irradiance / temperatures) for the same day, merged onto the
    # 5-minute curve, and the IEC 61724-1 PR it allows. Null where the plant has no sensor.
    weather = growatt_weather.build_weather_day(db, plant_id, day, latest_if_none=False)
    wx_by_ts = {p["timestamp"]: p for p in weather["series"]}
    for r in timeseries:
        wx = wx_by_ts.get(r["timestamp"]) or {}
        r["irradiance_wm2"] = wx.get("irradiance_wm2")  # measured, plane of array
        r["module_temp_c"] = wx.get("module_temp_c")
        r["ambient_temp_c"] = wx.get("ambient_temp_c")
    pr = growatt_weather.iec_pr(
        yield_today_kwh, cap_kwp, weather, [r["timestamp"] for r in timeseries if r["pac_kw"] > 0]
    )
    wk = weather["kpis"]

    # Loss waterfall — a modelled breakdown; only built when every input is measured. With a
    # weather sensor the reference is the measured POA insolation × kWp (IEC reference yield)
    # and thermal derating uses the measured module temperature.
    loss_waterfall: List[Dict[str, Any]] = []
    insolation: Optional[float] = wk["insolation_kwh_m2"]
    reference_kwh = (
        round(cap_kwp * insolation, 1) if pr["pr_pct"] is not None and cap_kwp and insolation else None
    )
    reference_measured = reference_kwh is not None
    module_temp_c = wk["avg_module_temp_daylight_c"] if reference_measured else None
    if yield_today_kwh and (reference_measured or plant_pr_pct) and avg_temp_c is not None and avg_eff_pct is not None:
        if reference_kwh is not None:
            nominal_dc_kwh = reference_kwh
        else:
            nominal_dc_kwh = round(yield_today_kwh / max(0.65, (plant_pr_pct or 0.0) / 100.0), 1)
        cell_temp_c = module_temp_c if module_temp_c is not None else avg_temp_c
        thermal_loss_kwh = round(nominal_dc_kwh * max(0.015, (cell_temp_c - 25.0) * 0.0034), 1)
        mismatch_loss_kwh = round(sum(s["energy_loss_kwh"] or 0.0 for s in strings_summary), 1)
        conv_loss_kwh = round(yield_today_kwh * max(0.0, 100.0 - avg_eff_pct) / 100.0, 1)
        optical_loss_kwh = round(
            max(0.0, nominal_dc_kwh - yield_today_kwh - thermal_loss_kwh - mismatch_loss_kwh - conv_loss_kwh), 1
        )
        loss_waterfall = [
            {
                "stage": "POA Insolation × kWp (measured)" if reference_measured else "Nominal DC Reference",
                "kwh": nominal_dc_kwh,
                "type": "base",
            },
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
            "reported_peak_power_kwp": rejected_kwp,
            "current_power_w": None,  # realtime: the UI overlays /growatt/live/*
            "total_energy_kwh": total_yield_kwh,
            "status": None,  # realtime: the UI overlays /growatt/live/plants
            "create_date": plant.create_date,
        },
        "kpis": {
            "capacity_kwp": cap_kwp,
            "current_power_kw": None,  # realtime: the UI overlays /growatt/live/*
            "peak_power_kw": peak_power_kw,
            "yield_today_kwh": yield_today_kwh,
            "total_yield_kwh": total_yield_kwh,
            "specific_yield_kwh_per_kwp": round(yield_today_kwh / cap_kwp, 2) if yield_today_kwh is not None and cap_kwp else None,
            # peer-relative string index (not IEC: compares strings with each other)
            "plant_pr_pct": plant_pr_pct,
            # IEC 61724-1 PR from the weather sensor's measured irradiance (null without one)
            "iec_pr_pct": pr["pr_pct"],
            "insolation_kwh_m2": wk["insolation_kwh_m2"],
            "peak_irradiance_wm2": wk["peak_irradiance_wm2"],
            "avg_module_temp_c": wk["avg_module_temp_daylight_c"],
            "avg_ambient_temp_c": wk["avg_ambient_temp_c"],
            "target_pr_pct": 85.0,
            "conversion_efficiency_pct": avg_eff_pct,
            "avg_temp_c": avg_temp_c,
            "max_temp_c": max_temp_c,
            "avg_freq_hz": avg_freq_hz,
            "inverter_count": len(inverters_out),
            "online_inverters": None,  # realtime: the UI counts live inverter status
            "string_count": len(strings_summary),
            "healthy_strings": healthy_cnt,
            "warning_strings": warning_cnt,
            "critical_strings": critical_cnt,
            "inactive_strings": len(inactive_strings),
            # strings whose module count is in the registry / compared per module with peers
            "strings_with_module_count": sum(1 for s in strings_summary if s["modules"] is not None),
            "strings_normalized": sum(1 for s in strings_summary if s["peer_basis"] != "raw"),
            "avg_health_score": avg_health,
            "tariff_thb_per_kwh": 4.2,
        },
        "inverters": inverters_out,
        "timeseries": timeseries,
        "weather": {
            "has_sensor": weather["has_sensor"],
            "sensors": weather["sensors"],
            "data_until": weather["meta"]["data_until"],
            "kpis": wk,
            "iec_pr": pr,
        },
        "loss_waterfall": loss_waterfall,
        "strings": strings_summary,
        # String inputs with no current today (unused inputs, or no light yet). Kept out of
        # `strings` so KPIs and diagnostics only cover connected strings.
        "inactive_strings": inactive_strings,
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


def build_inverter_timeseries(
    db: Session, plant_id: int, device_sn: str, day: Optional[date] = None
) -> Dict[str, Any]:
    """5-minute AC / DC power and temperature of one inverter for one day (stored history).

    `expected_kw` is modelled, from the inverter's share of the plant kWp: the sum of its
    strings' modules × Wp when every string has a layout entry, else plant kWp / inverters.
    """
    plant = _get_plant(db, plant_id)
    inv = db.scalar(
        select(GrowattInverter).where(GrowattInverter.plant_id == plant_id, GrowattInverter.device_sn == device_sn)
    )
    if inv is None:
        raise GrowattNotFound(f"Inverter {device_sn} not found on plant {plant_id}")

    if day is None:
        latest = db.scalar(select(func.max(R.timestamp)).where(R.device_sn == device_sn))
        day = latest.date() if latest else None

    # Capacity share for the modelled envelope: the inverter's own strings when every one
    # that carried current that day has a module count (Wp falls back to the fleet module).
    cap_kwp: Optional[float] = None
    cap_basis: Optional[str] = None
    if day is not None:
        d_start, d_end = _day_bounds(day)
        seen = {
            int(n)
            for (n,) in db.execute(
                select(S.string_no)
                .where(S.device_sn == device_sn, S.timestamp >= d_start, S.timestamp < d_end, S.current_a > INACTIVE_MAX_A)
                .distinct()
            )
        }
        layout = load_layout(db, [device_sn])
        if seen and all((device_sn, n) in layout and layout[(device_sn, n)][1] for n in seen):
            w = sum(layout[(device_sn, n)][0] * (layout[(device_sn, n)][1] or 0.0) for n in seen)
            cap_kwp, cap_basis = round(w / 1000.0, 2), "string_layout"
    plant_cap_kwp = capacity_check(db, plant)[0] if cap_kwp is None else None
    if plant_cap_kwp:
        n_inv = db.scalar(select(func.count()).select_from(GrowattInverter).where(GrowattInverter.plant_id == plant_id))
        if n_inv:
            cap_kwp, cap_basis = round(plant_cap_kwp / n_inv, 2), "plant_share"

    timeseries: List[Dict[str, Any]] = []
    strings_heat: Dict[str, Any] = {"string_nos": [], "timestamps": [], "current_a": []}
    if day is not None:
        start, end = _day_bounds(day)
        slots: Dict[datetime, Dict[str, List[float]]] = {}
        for ts, pac, ppv, temp in db.execute(
            select(R.timestamp, R.pac_w, R.ppv_w, R.temperature_c)
            .where(R.device_sn == device_sn, R.timestamp >= start, R.timestamp < end)
            .order_by(R.timestamp)
        ):
            b = slots.setdefault(_bucket(ts), {"pac": [], "ppv": [], "temp": []})
            b["pac"].append(pac or 0.0)
            b["ppv"].append(ppv or 0.0)
            if temp is not None and temp > 0:
                b["temp"].append(temp)
        # string current per 5-min slot (rows exist only while the inverter produces)
        str_slots: Dict[Tuple[datetime, int], List[float]] = {}
        for ts, n, a in db.execute(
            select(S.timestamp, S.string_no, S.current_a)
            .where(S.device_sn == device_sn, S.timestamp >= start, S.timestamp < end)
            .order_by(S.timestamp)
        ):
            str_slots.setdefault((_bucket(ts), int(n)), []).append(float(a))
        string_nos = sorted({n for _, n in str_slots})
        str_times = sorted({t for t, _ in str_slots})
        strings_heat = {
            "string_nos": string_nos,
            "timestamps": [_fmt_ts(t) for t in str_times],
            # [string][slot]; null = no record for that string in that slot
            "current_a": [
                [_round(_mean(str_slots[(t, n)]), 2) if (t, n) in str_slots else None for t in str_times]
                for n in string_nos
            ],
        }
        for ts in sorted(slots):
            b = slots[ts]
            timeseries.append(
                {
                    "timestamp": _fmt_ts(ts),
                    "pac_kw": round(statistics.mean(b["pac"]) / 1000.0, 3),
                    "ppv_kw": round(statistics.mean(b["ppv"]) / 1000.0, 3),
                    "expected_kw": _expected_kw(cap_kwp, ts.hour + ts.minute / 60.0),
                    "temp_c": _round(_mean(b["temp"]), 1),
                }
            )

    return {
        "meta": {"source": "db", "day": day.isoformat() if day else None},
        "plant_id": plant.plant_id,
        "device_sn": device_sn,
        "capacity_kwp": cap_kwp,
        # "string_layout": modules × Wp of its strings; "plant_share": plant kWp / inverters (modelled)
        "capacity_basis": cap_basis,
        # rated AC power from Growatt (max_data_info); null until the fleet job has read it
        "nominal_power_kw": round(inv.nominal_power_w / 1000, 1) if inv.nominal_power_w else None,
        "timeseries": timeseries,
        "strings": strings_heat,
    }


MAX_TREND_DAYS = 90  # = raw history retention


def build_inverter_daily(
    db: Session, plant_id: int, device_sn: str, end: Optional[date] = None, days: int = 30
) -> Dict[str, Any]:
    """Daily yield, peak AC and max temperature of one inverter over `days` days ending at `end`,
    with the plant's per-inverter average yield for the same days (stored history only).

    Yield is `eac_today` of each day's last record (the counter carries yesterday's total for
    a few minutes after midnight, so not MAX()). Days without records are null.
    """
    plant = _get_plant(db, plant_id)
    sns = list(db.scalars(select(GrowattInverter.device_sn).where(GrowattInverter.plant_id == plant_id)))
    if device_sn not in sns:
        raise GrowattNotFound(f"Inverter {device_sn} not found on plant {plant_id}")
    days = max(1, min(int(days), MAX_TREND_DAYS))
    if end is None:
        latest = db.scalar(select(func.max(R.timestamp)).where(R.device_sn == device_sn))
        end = latest.date() if latest else date.today()

    out: List[Dict[str, Any]] = []
    for k in range(days - 1, -1, -1):
        d = end - timedelta(days=k)
        start, stop = _day_bounds(d)
        last_ts = (
            select(R.device_sn, func.max(R.timestamp).label("ts"))
            .where(R.device_sn.in_(sns), R.timestamp >= start, R.timestamp < stop, R.eac_today_kwh.is_not(None))
            .group_by(R.device_sn)
        ).subquery()
        yields = {
            sn: float(kwh)
            for sn, kwh in db.execute(
                select(R.device_sn, R.eac_today_kwh).join(
                    last_ts, (R.device_sn == last_ts.c.device_sn) & (R.timestamp == last_ts.c.ts)
                )
            )
            if kwh is not None
        }
        peak_ac, max_temp = db.execute(
            select(func.max(R.pac_w), func.max(R.temperature_c)).where(
                R.device_sn == device_sn, R.timestamp >= start, R.timestamp < stop
            )
        ).one()
        own = yields.get(device_sn)
        avg = statistics.mean(yields.values()) if yields else None
        out.append(
            {
                "day": d.isoformat(),
                "yield_kwh": _round(own, 2),
                "plant_avg_yield_kwh": _round(avg, 2),
                "inverters_reporting": len(yields),
                # own yield / plant average × 100; null when either is missing or the average is 0
                "vs_plant_pct": _round(own / avg * 100.0, 1) if own is not None and avg else None,
                "peak_ac_kw": _round(peak_ac / 1000.0, 2) if peak_ac is not None else None,
                "max_temp_c": _round(max_temp, 1) if max_temp is not None and max_temp > 0 else None,
            }
        )
    inv = db.get(GrowattInverter, device_sn)
    return {
        "meta": {"source": "db", "from": out[0]["day"], "to": out[-1]["day"], "days": days},
        "plant_id": plant.plant_id,
        "device_sn": device_sn,
        "nominal_power_kw": round(inv.nominal_power_w / 1000, 1) if inv and inv.nominal_power_w else None,
        "daily": out,
    }
