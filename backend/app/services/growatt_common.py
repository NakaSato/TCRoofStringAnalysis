"""Shared pieces of the Growatt analytics (DB only): reading-table aliases, number and time helpers,
plant lookup, capacity checks and the inverter row shape.

Split out of `growatt_overview`, which re-exports these names. Timestamps are plant-local
(Thai) time; values that cannot be computed from stored data are `None`.
"""

from __future__ import annotations

import math
import statistics
from datetime import date, datetime, timedelta
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.db.models import (
    GrowattInverter,
    GrowattInverterReading,
    GrowattPlant,
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


def newest_inverter_ts(db: Session, sns: Sequence[str]) -> Optional[datetime]:
    """Newest stored inverter record of these inverters, or None: one primary-key-ordered lookup
    per inverter. `max(timestamp) WHERE device_sn IN (…)` lets Postgres walk ix_growatt_inv_ts
    backwards instead, which reads most of the table for an inverter without recent records."""
    best: Optional[datetime] = None
    for sn in dict.fromkeys(sns):
        ts = db.scalar(
            select(R.timestamp).where(R.device_sn == sn).order_by(R.device_sn.desc(), R.timestamp.desc()).limit(1)
        )
        if ts is not None and (best is None or ts > best):
            best = ts
    return best


def _latest_reading(db: Session, sns: Sequence[str]) -> Optional[datetime]:
    return newest_inverter_ts(db, sns)


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
        # from Growatt `queryDeviceInfoParam` (registry, monthly)
        "device_model": inv.device_model,
        "datalogger_model": inv.datalogger_model,
        "rated_power_kw": round(inv.rated_power_w / 1000, 1) if inv.rated_power_w else None,
        # configured settings (as read at info_synced_at), not measurements. The power limit
        # comes from readPower when it was read (max_data_info answers it as 0 = unknown)
        "settings": {
            "active_rate_pct": inv.active_limit_pct,
            "active_rate_source": (
                "read_power" if inv.power_limit_pct is not None
                else "max_data_info" if inv.active_rate_pct is not None
                else None
            ),
            "power_limit_read_at": inv.power_limit_read_at.isoformat() if inv.power_limit_read_at else None,
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


INACTIVE_MAX_A = 0.15  # a string whose current never exceeds this all day carries no PV


def _expected_kw(cap_kwp: Optional[float], hr: float) -> Optional[float]:
    """Modelled clear-sky envelope (not measured): 82 % of kWp at solar noon."""
    if not cap_kwp:
        return None
    if not 6.0 <= hr <= 18.0:
        return 0.0
    x = (hr - 12.15) / 5.85
    return round(cap_kwp * 0.82 * max(0.0, math.cos(x * math.pi / 2.0)) ** 1.3, 2)
