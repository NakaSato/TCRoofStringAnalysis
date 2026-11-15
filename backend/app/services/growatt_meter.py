"""Grid import / export and load from the plant's energy meter (`growatt_meter_readings`).

The meter (a CHNT three-phase meter at the grid connection point, read through the datalogger)
reports `active_power_w` as signed power at that point: positive = drawn from the grid (import),
negative = fed into the grid (export). Probed 15 Nov 2026: 260 kW at night with PV at 0, and the
import counter rose by the energy drawn. Export is taken from the sign; no export reading has
been checked against a site yet, so the UI labels these "meter".

Load is not measured: it is derived as PV AC + grid power (PV + import − export) in the slots
where both are stored, and null where that sum would be negative (inconsistent data).
"""

from __future__ import annotations

import statistics
from datetime import datetime
from typing import Any, Dict, List, Optional, Tuple

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.db.models import GrowattMeter, GrowattMeterReading
from app.services.growatt_common import _bucket, _integrate_kwh, _round

M = GrowattMeterReading


def meter_slots(db: Session, plant_id: int, start: datetime, end: datetime) -> Tuple[bool, Dict[str, float]]:
    """(plant has a meter, {slot "YYYY-MM-DD HH:MM:SS": grid power W}) for [start, end).
    Each meter's records are averaged within the 5-minute slot, then summed across meters."""
    meters = db.execute(
        select(GrowattMeter.datalogger_sn, GrowattMeter.address).where(GrowattMeter.plant_id == plant_id)
    ).all()
    if not meters:
        return False, {}
    keys = {(dl, int(a)) for dl, a in meters}
    rows = db.execute(
        select(M.datalogger_sn, M.address, M.timestamp, M.active_power_w).where(
            M.datalogger_sn.in_({k[0] for k in keys}), M.timestamp >= start, M.timestamp < end
        )
    ).all()
    per: Dict[Tuple[datetime, Tuple[str, int]], List[float]] = {}
    for dl, addr, ts, p in rows:
        if (dl, int(addr)) not in keys or p is None:
            continue
        per.setdefault((_bucket(ts), (dl, int(addr))), []).append(float(p))
    out: Dict[str, float] = {}
    for (slot, _meter), vals in per.items():
        key = slot.strftime("%Y-%m-%d %H:%M:%S")
        out[key] = out.get(key, 0.0) + statistics.mean(vals)
    return True, out


def attach_grid(timeseries: List[Dict[str, Any]], slots: Dict[str, float]) -> None:
    """Adds grid_import_kw / grid_export_kw (measured) and load_kw (derived) to each curve row;
    null where the meter has no record for the slot."""
    for r in timeseries:
        p = slots.get(r["timestamp"])
        if p is None:
            r["grid_import_kw"] = r["grid_export_kw"] = r["load_kw"] = None
            continue
        kw = p / 1000.0
        r["grid_import_kw"] = round(max(kw, 0.0), 2)
        r["grid_export_kw"] = round(max(-kw, 0.0), 2)
        load = (r.get("pac_kw") or 0.0) + kw
        r["load_kw"] = round(load, 2) if load >= 0 else None


def day_energy(db: Session, plant_id: int, start: datetime, end: datetime, timeseries: List[Dict[str, Any]]) -> Dict[str, Optional[float]]:
    """The period's grid import (from the meters' import counters where they span it, else
    integrated), export and load (integrated from the 5-minute series). Null without readings."""
    pts = [(datetime.strptime(r["timestamp"], "%Y-%m-%d %H:%M:%S"), r) for r in timeseries if r.get("load_kw") is not None or r.get("grid_import_kw") is not None]
    if not pts:
        return {"grid_import_kwh": None, "grid_export_kwh": None, "load_kwh": None}
    integ = lambda key: round(_integrate_kwh((t, (r.get(key) or 0.0) * 1000.0) for t, r in pts), 1)
    counter = db.execute(
        select(func.max(M.import_counter_kwh) - func.min(M.import_counter_kwh))
        .join(GrowattMeter, (GrowattMeter.datalogger_sn == M.datalogger_sn) & (GrowattMeter.address == M.address))
        .where(GrowattMeter.plant_id == plant_id, M.timestamp >= start, M.timestamp < end, M.import_counter_kwh > 0)
        .group_by(M.datalogger_sn, M.address)
    ).scalars().all()
    imp = sum(float(c) for c in counter if c is not None) if counter else None
    return {
        "grid_import_kwh": _round(imp, 1) if imp is not None else integ("grid_import_kw"),
        "grid_export_kwh": integ("grid_export_kw"),
        "load_kwh": integ("load_kw"),
    }
