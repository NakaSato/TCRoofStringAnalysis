"""One inverter's stored day curve and daily trend (DB only).

Split out of `growatt_overview`, which re-exports these names. Timestamps are plant-local
(Thai) time; values that cannot be computed from stored data are `None`.
"""

from __future__ import annotations

import statistics
from datetime import date, datetime, timedelta
from typing import Any, Dict, List, Optional, Tuple

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.db.models import (
    GrowattInverter,
)
from app.services.growatt_common import GrowattNotFound, INACTIVE_MAX_A, R, S, _bucket, _day_bounds, _expected_kw, _fmt_ts, _get_plant, _mean, _round, capacity_check, newest_inverter_ts
from app.services.growatt_layout import load_layout


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
        latest = newest_inverter_ts(db, [device_sn])
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
        latest = newest_inverter_ts(db, [device_sn])
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
