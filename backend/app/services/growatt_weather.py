"""Weather-sensor data from persisted history (DB only, no Growatt calls).

A plant's weather sensors (`growatt_env_sensors`) report every 5 min: plane-of-array
irradiance, ambient and module temperature, humidity and wind. Readings are stored as
Growatt reports them. A probe the sensor is not fitted with reads 0, so a field that is
0 for a sensor all day is returned as null for that day (it was not measured), never as 0.

With measured irradiance the plant gets a real IEC 61724-1 performance ratio:

    PR = Yf / Yr = (E_AC / P0) / (H_POA / G_STC)

with E_AC the day's AC yield (kWh), P0 the DC capacity (kWp), H_POA the plane-of-array
insolation (kWh/m², integrated from irradiance) and G_STC = 1 kW/m². It is only reported
when the sensor covered most of the plant's producing time; otherwise it is null.
"""

from __future__ import annotations

import math
from datetime import date, datetime, timedelta
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple, cast

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.db.models import GrowattEnvReading, GrowattEnvSensor

E = GrowattEnvReading

FIELDS = ("irradiance_wm2", "ambient_temp_c", "module_temp_c", "humidity_pct", "wind_speed_ms", "wind_dir_deg")
DAYLIGHT_WM2 = 50.0  # irradiance above which a slot counts as daylight (module-temperature mean)
MIN_PR_COVERAGE = 0.9  # share of producing slots that must have an irradiance sample for IEC PR


def _bucket(ts: datetime) -> datetime:
    return ts.replace(minute=ts.minute - ts.minute % 5, second=0, microsecond=0)


def _mean(vals: Iterable[Optional[float]]) -> Optional[float]:
    v = [float(x) for x in vals if x is not None]
    return sum(v) / len(v) if v else None


def _round(v: Optional[float], digits: int) -> Optional[float]:
    return None if v is None else round(float(v), digits)


def _circular_mean_deg(vals: Sequence[float]) -> Optional[float]:
    if not vals:
        return None
    s = sum(math.sin(math.radians(v)) for v in vals)
    c = sum(math.cos(math.radians(v)) for v in vals)
    if abs(s) < 1e-9 and abs(c) < 1e-9:
        return None
    return math.degrees(math.atan2(s, c)) % 360.0


def _integrate_kwh_m2(points: Sequence[Tuple[datetime, float]], max_gap_h: float = 10.0 / 60.0) -> float:
    """Insolation (kWh/m²) from time-ordered (timestamp, W/m²) samples; gaps are not credited."""
    if not points:
        return 0.0
    dts = [(b[0] - a[0]).total_seconds() / 3600.0 for a, b in zip(points, points[1:])]
    regular = sorted(d for d in dts if 0 < d <= max_gap_h)
    typical = regular[len(regular) // 2] if regular else 5.0 / 60.0
    weights = [typical] + [d if 0 < d <= max_gap_h else typical for d in dts]
    return sum(g * w for (_ts, g), w in zip(points, weights) if g and g > 0) / 1000.0


def plant_sensors(db: Session, plant_id: int) -> List[GrowattEnvSensor]:
    return list(
        db.scalars(
            select(GrowattEnvSensor)
            .where(GrowattEnvSensor.plant_id == plant_id)
            .order_by(GrowattEnvSensor.datalogger_sn, GrowattEnvSensor.address)
        )
    )


def measured_fields(db: Session, plant_id: int, since: datetime) -> Dict[Tuple[str, int], Optional[List[str]]]:
    """Per sensor of the plant, the fields that read non-zero at least once since `since`.

    None for a sensor with no stored readings in that window (unknown: keep every field).
    """
    cols = [getattr(E, f) for f in FIELDS]
    aggs = [a for c in cols for a in (func.min(c), func.max(c))]
    rows: Dict[Tuple[str, int], Sequence[Any]] = {
        (str(t[0]), int(t[1])): t[2:]
        for t in (tuple(r) for r in db.execute(
            select(E.datalogger_sn, E.address, *aggs)
            .join(GrowattEnvSensor, (GrowattEnvSensor.datalogger_sn == E.datalogger_sn) & (GrowattEnvSensor.address == E.address))
            .where(GrowattEnvSensor.plant_id == plant_id, E.timestamp >= since)
            .group_by(E.datalogger_sn, E.address)
        ).all())
    }
    out: Dict[Tuple[str, int], Optional[List[str]]] = {}
    for s in plant_sensors(db, plant_id):
        mm = rows.get((s.datalogger_sn, s.address))
        out[(s.datalogger_sn, s.address)] = (
            None
            if mm is None
            else [f for i, f in enumerate(FIELDS) if (mm[2 * i] or 0) != 0 or (mm[2 * i + 1] or 0) != 0]
        )
    return out


def latest_day(db: Session, plant_id: int) -> Optional[date]:
    ts = db.scalar(
        select(func.max(E.timestamp)).join(
            GrowattEnvSensor,
            (GrowattEnvSensor.datalogger_sn == E.datalogger_sn) & (GrowattEnvSensor.address == E.address),
        ).where(GrowattEnvSensor.plant_id == plant_id)
    )
    return ts.date() if ts else None


def build_weather_day(
    db: Session, plant_id: int, day: Optional[date] = None, latest_if_none: bool = True
) -> Dict[str, Any]:
    """5-minute weather series and daily KPIs for one plant-local day.

    `day=None` means the latest day with weather data (or no day at all when `latest_if_none`
    is false). Several sensors on one plant are averaged per 5-minute slot (wind direction as
    a circular mean).
    """
    sensors = plant_sensors(db, plant_id)
    if day is None and latest_if_none:
        day = latest_day(db, plant_id)
    out_sensors: List[Dict[str, Any]] = []
    series: List[Dict[str, Any]] = []
    if not sensors or day is None:
        return _result(day, sensors, out_sensors, series, {})

    start = datetime.combine(day, datetime.min.time())
    end = start + timedelta(days=1)
    slots: Dict[datetime, Dict[str, List[float]]] = {}
    for s in sensors:
        rows = db.execute(
            select(E.timestamp, *(getattr(E, f) for f in FIELDS))
            .where(E.datalogger_sn == s.datalogger_sn, E.address == s.address, E.timestamp >= start, E.timestamp < end)
            .order_by(E.timestamp)
        ).all()
        # A field that never leaves 0 all day was not measured (probe not fitted / broken).
        measured = {f: any((r[i + 1] or 0) != 0 for r in rows) for i, f in enumerate(FIELDS)}
        out_sensors.append(
            {
                "datalogger_sn": s.datalogger_sn,
                "address": s.address,
                "device_name": s.device_name,
                "samples": len(rows),
                "first_reading": rows[0][0].strftime("%Y-%m-%d %H:%M:%S") if rows else None,
                "last_reading": rows[-1][0].strftime("%Y-%m-%d %H:%M:%S") if rows else None,
                "measured": [f for f in FIELDS if measured[f]],
            }
        )
        per_sensor: Dict[datetime, Dict[str, List[float]]] = {}
        for r in rows:
            ts: datetime = r[0]
            vals = cast(Sequence[Optional[float]], tuple(r)[1:])
            b = per_sensor.setdefault(_bucket(ts), {f: [] for f in FIELDS})
            for f, v in zip(FIELDS, vals):
                if measured[f] and v is not None:
                    b[f].append(float(v))
        for ts, b in per_sensor.items():
            slot = slots.setdefault(ts, {f: [] for f in FIELDS})
            for f in FIELDS:
                # average within the slot per sensor first, then across sensors
                v = _circular_mean_deg(b[f]) if f == "wind_dir_deg" else (sum(b[f]) / len(b[f]) if b[f] else None)
                if v is not None:
                    slot[f].append(v)

    for ts in sorted(slots):
        b = slots[ts]
        series.append(
            {
                "timestamp": ts.strftime("%Y-%m-%d %H:%M:%S"),
                "irradiance_wm2": _round(_mean(b["irradiance_wm2"]), 1),
                "ambient_temp_c": _round(_mean(b["ambient_temp_c"]), 1),
                "module_temp_c": _round(_mean(b["module_temp_c"]), 1),
                "humidity_pct": _round(_mean(b["humidity_pct"]), 1),
                "wind_speed_ms": _round(_mean(b["wind_speed_ms"]), 1),
                "wind_dir_deg": _round(_circular_mean_deg(b["wind_dir_deg"]), 0),
            }
        )
    return _result(day, sensors, out_sensors, series, _kpis(series))


def _kpis(series: List[Dict[str, Any]]) -> Dict[str, Any]:
    irr = [(datetime.strptime(p["timestamp"], "%Y-%m-%d %H:%M:%S"), p["irradiance_wm2"]) for p in series if p["irradiance_wm2"] is not None]
    day_pts = [p for p in series if (p["irradiance_wm2"] or 0) >= DAYLIGHT_WM2]

    def col(name: str, pts: Sequence[Dict[str, Any]] = series) -> List[float]:
        return [p[name] for p in pts if p[name] is not None]

    return {
        "insolation_kwh_m2": round(_integrate_kwh_m2(irr), 3) if irr else None,
        "peak_irradiance_wm2": _round(max((g for _t, g in irr), default=None), 0) if irr else None,
        "avg_ambient_temp_c": _round(_mean(col("ambient_temp_c")), 1),
        "max_ambient_temp_c": _round(max(col("ambient_temp_c"), default=None), 1) if col("ambient_temp_c") else None,
        "avg_module_temp_daylight_c": _round(_mean(col("module_temp_c", day_pts)), 1),
        "max_module_temp_c": _round(max(col("module_temp_c"), default=None), 1) if col("module_temp_c") else None,
        "avg_humidity_pct": _round(_mean(col("humidity_pct")), 0),
        "avg_wind_speed_ms": _round(_mean(col("wind_speed_ms")), 1),
        "max_wind_speed_ms": _round(max(col("wind_speed_ms"), default=None), 1) if col("wind_speed_ms") else None,
    }


def _result(
    day: Optional[date],
    sensors: Sequence[GrowattEnvSensor],
    out_sensors: List[Dict[str, Any]],
    series: List[Dict[str, Any]],
    kpis: Dict[str, Any],
) -> Dict[str, Any]:
    empty = {
        "insolation_kwh_m2": None,
        "peak_irradiance_wm2": None,
        "avg_ambient_temp_c": None,
        "max_ambient_temp_c": None,
        "avg_module_temp_daylight_c": None,
        "max_module_temp_c": None,
        "avg_humidity_pct": None,
        "avg_wind_speed_ms": None,
        "max_wind_speed_ms": None,
    }
    data_until = max((s["last_reading"] for s in out_sensors if s["last_reading"]), default=None)
    return {
        "meta": {"source": "db", "day": day.isoformat() if day else None, "data_until": data_until},
        "has_sensor": bool(sensors),
        # without a day the sensors are still listed, with no readings
        "sensors": out_sensors
        or [
            {
                "datalogger_sn": s.datalogger_sn,
                "address": s.address,
                "device_name": s.device_name,
                "samples": 0,
                "first_reading": None,
                "last_reading": None,
                "measured": [],
            }
            for s in sensors
        ],
        "kpis": {**empty, **kpis},
        "series": series,
    }


def iec_pr(
    yield_kwh: Optional[float],
    capacity_kwp: Optional[float],
    weather: Dict[str, Any],
    producing_slots: Sequence[str],
) -> Dict[str, Any]:
    """IEC 61724-1 performance ratio from measured irradiance, with the coverage it rests on.

    `producing_slots` are the 5-minute slots (timestamps) in which the plant produced AC power.
    PR is null (with a `reason`) without a sensor, capacity or yield, or when the sensor covers
    less than `MIN_PR_COVERAGE` of the producing slots (a gap would inflate PR).
    """
    irr_slots = {p["timestamp"] for p in weather["series"] if p["irradiance_wm2"] is not None}
    coverage = (sum(1 for t in producing_slots if t in irr_slots) / len(producing_slots)) if producing_slots else None
    h = weather["kpis"]["insolation_kwh_m2"]
    reason: Optional[str] = None
    if not weather["has_sensor"]:
        reason = "no weather sensor"
    elif not h:
        reason = "no irradiance measured"
    elif not capacity_kwp:
        reason = "plant capacity unknown"
    elif yield_kwh is None:
        reason = "no yield"
    elif coverage is None or coverage < MIN_PR_COVERAGE:
        reason = f"irradiance covers {0 if coverage is None else round(coverage * 100)}% of producing time"
    pr = None
    if reason is None and yield_kwh is not None and capacity_kwp and h:
        pr = round(yield_kwh / capacity_kwp / h * 100.0, 1)
    return {
        "pr_pct": pr,
        "reference_yield_h": _round(h, 3),  # Yr = H / 1 kW/m², hours at STC irradiance
        "final_yield_h": _round(yield_kwh / capacity_kwp, 3) if yield_kwh is not None and capacity_kwp else None,
        "coverage_pct": _round(coverage * 100.0 if coverage is not None else None, 0),
        "reason": reason,
    }
