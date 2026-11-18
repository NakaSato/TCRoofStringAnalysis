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


def plant_meters(db: Session, plant_id: int) -> List[Tuple[str, int]]:
    """(datalogger SN, bus address) of each registered meter of the plant."""
    rows = db.execute(
        select(GrowattMeter.datalogger_sn, GrowattMeter.address)
        .where(GrowattMeter.plant_id == plant_id)
        .order_by(GrowattMeter.datalogger_sn, GrowattMeter.address)
    ).all()
    return [(str(dl), int(a)) for dl, a in rows]


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
    integrated), export and load (integrated from the 5-minute series). Each figure is integrated
    over the slots that have it only (a slot with a null load is left out, never counted as 0 W)
    and is null without any. A meter's counter is used only with at least two records in the
    period: one record spans nothing."""
    pts = [(datetime.strptime(r["timestamp"], "%Y-%m-%d %H:%M:%S"), r) for r in timeseries if r.get("load_kw") is not None or r.get("grid_import_kw") is not None]
    if not pts:
        return {"grid_import_kwh": None, "grid_export_kwh": None, "load_kwh": None}

    def integ(key: str) -> Optional[float]:
        # every slot stays on the timeline (a slot without the value adds no energy): dropping it
        # would credit its interval to the next slot that has one
        vals = [(t, None if r.get(key) is None else float(r[key]) * 1000.0) for t, r in pts]
        return round(_integrate_kwh(vals), 1) if any(v is not None for _t, v in vals) else None

    counter = db.execute(
        select(func.max(M.import_counter_kwh) - func.min(M.import_counter_kwh), func.count())
        .join(GrowattMeter, (GrowattMeter.datalogger_sn == M.datalogger_sn) & (GrowattMeter.address == M.address))
        .where(GrowattMeter.plant_id == plant_id, M.timestamp >= start, M.timestamp < end, M.import_counter_kwh > 0)
        .group_by(M.datalogger_sn, M.address)
    ).all()
    spanned = bool(counter) and all(span is not None and n >= 2 for span, n in counter)
    imp = sum(float(span) for span, _n in counter) if spanned else None
    return {
        "grid_import_kwh": _round(imp, 1) if imp is not None else integ("grid_import_kw"),
        "grid_export_kwh": integ("grid_export_kw"),
        "load_kwh": integ("load_kw"),
    }


LIVE_LOAD_MATCH_S = 600  # an inverter record counts towards the live load only this close to the meter's


def live_load(grid: Dict[str, Any], device_sns: List[str], inverters: List[Dict[str, Any]], errors: Dict[str, str]) -> Dict[str, Any]:
    """Live load = PV AC + grid power at the meter's newest record (derived, never measured).

    PV AC sums each inverter's newest live record (`/live/plants/{id}/latest`). An inverter
    counts as 0 W when it has no record today, or when its newest record is older than the
    meter's and read 0 W (it shut down for the night). Any other inverter without a record
    within `LIVE_LOAD_MATCH_S` of the meter's (failed call, silent while producing) leaves
    PV, and so load, unknown: null with a `reason`, never a partial sum."""
    out: Dict[str, Any] = {"timestamp": grid.get("timestamp"), "pv_kw": None, "load_kw": None, "reason": None}
    kw = grid.get("grid_power_kw")
    if kw is None or not grid.get("timestamp"):
        out["reason"] = "no complete meter record"
        return out
    t_meter = datetime.strptime(grid["timestamp"], "%Y-%m-%d %H:%M:%S")
    by_sn = {r["device_sn"]: r for r in inverters}
    pv_w = 0.0
    unknown: List[str] = []
    for sn in device_sns:
        r = by_sn.get(sn)
        if r is None:
            if sn in errors:
                unknown.append(sn)  # not read: may be producing
            continue  # no record today: off
        try:
            t = datetime.strptime(r["timestamp"], "%Y-%m-%d %H:%M:%S")
        except (KeyError, TypeError, ValueError):
            unknown.append(sn)
            continue
        pac = r.get("pac_w")
        if abs((t - t_meter).total_seconds()) <= LIVE_LOAD_MATCH_S and pac is not None:
            pv_w += pac
        elif t < t_meter and pac == 0:
            continue  # shut down before the meter's record
        else:
            unknown.append(sn)
    if unknown:
        out["reason"] = f"no inverter record near the meter's for {len(unknown)} of {len(device_sns)} inverters"
        return out
    out["pv_kw"] = round(pv_w / 1000.0, 2)
    load = pv_w / 1000.0 + kw
    if load < 0:
        out["reason"] = "export above PV (inconsistent records)"
        return out
    out["load_kw"] = round(load, 2)
    return out
