"""Persisted data only (`/growatt/plants*`, `/growatt/sensors`, `/growatt/alarms`): the registry and
the history mirrored by `app.services.growatt_sync`. No Growatt calls happen here.

Timestamps in the reading tables are plant-local (Thai) time; responses carry `meta.source = "db"`."""

from __future__ import annotations

from datetime import date, datetime, time, timezone
from typing import Any, Dict, List, Optional, Tuple

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from app.auth import allowed_plant_ids, get_current_user, require_plant_read
from app.db.models import User
from app.db.session import get_db
from app.services import growatt_alarms
from app.services import growatt_sensors
from app.services import growatt_overview as ov
from app.services import growatt_weather as wx
from app.services import google_weather as gw
from app.services import jobs
from app.api.routes.growatt._common import DAY_QUERY, sensor_scope

router = APIRouter()


# --------------------------------------------------------------------------- persisted (DB only)


@router.get("/plants")
def list_growatt_plants(
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> List[Dict[str, Any]]:
    """Plant registry from the DB, with inverter counts and the latest synced day's energy.
    Engineers get only the plants assigned to them.

    `current_power_w` / `status` are the last values written by the sync job (see `synced_at`);
    use `/growatt/live/plants` for realtime values.
    """
    return ov.list_plants_summary_shared(db, plant_ids=allowed_plant_ids(db, user))


@router.get("/plants/{plant_id}/inverters")
def list_growatt_inverters(
    plant_id: int,
    include_not_installed: bool = Query(False, description="Also the inverters marked not installed (`not_installed` set)"),
    db: Session = Depends(get_db),
    _user: User = Depends(require_plant_read),
) -> List[Dict[str, Any]]:
    """Inverter registry for a plant from the DB (status = last synced value)."""
    return ov.list_inverters(db, plant_id, include_not_installed=include_not_installed)


@router.get("/plants/{plant_id}/overview")
def get_growatt_plant_overview(
    plant_id: int,
    day: Optional[date] = DAY_QUERY,
    db: Session = Depends(get_db),
    _user: User = Depends(require_plant_read),
) -> Dict[str, Any]:
    """Single-plant overview for one day from persisted max_data history (nulls where not measured)."""
    try:
        return ov.build_plant_overview(db, plant_id, day)
    except ov.GrowattNotFound as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@router.get("/plants/{plant_id}/power")
def get_growatt_plant_power(
    plant_id: int,
    day: date = Query(..., description="Plant-local first day (YYYY-MM-DD)"),
    end_day: Optional[date] = Query(None, description="Last day of a day range starting at `day` (inclusive, at most 31 days)"),
    start: Optional[time] = Query(None, description="Plant-local start time (HH:MM, inclusive) on every day"),
    end: Optional[time] = Query(None, description="Plant-local end time (HH:MM, inclusive) on every day"),
    records: bool = Query(True, description="false = only Growatt's own figures (no records read)"),
    db: Session = Depends(get_db),
    _user: User = Depends(require_plant_read),
) -> Dict[str, Any]:
    """The plant's stored 5-minute AC / DC curve over a day or day range (DB only)."""
    if start is not None and end is not None and start > end:
        raise HTTPException(status_code=422, detail="start must not be after end")
    if end_day is not None and end_day < day:
        raise HTTPException(status_code=422, detail="end_day must not be before day")
    try:
        return ov.build_plant_power(db, plant_id, day, end_day=end_day, start_time=start, end_time=end, include_records=records)
    except ov.GrowattNotFound as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@router.get("/plants/{plant_id}/inverters/{device_sn}/timeseries")
def get_growatt_inverter_timeseries(
    plant_id: int,
    device_sn: str,
    day: Optional[date] = DAY_QUERY,
    db: Session = Depends(get_db),
    _user: User = Depends(require_plant_read),
) -> Dict[str, Any]:
    """Stored 5-minute AC/DC power and temperature of one inverter for one day,
    plus a modelled clear-sky reference (`expected_kw`)."""
    try:
        return ov.build_inverter_timeseries(db, plant_id, device_sn, day)
    except ov.GrowattNotFound as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@router.get("/plants/{plant_id}/inverters/{device_sn}/raw")
def get_growatt_inverter_raw(
    plant_id: int,
    device_sn: str,
    day: Optional[date] = DAY_QUERY,
    db: Session = Depends(get_db),
    _user: User = Depends(require_plant_read),
) -> Dict[str, Any]:
    """Every field of one inverter's stored `max_data` records for one day, exactly as Growatt
    reported them (Growatt's field names). Kept `HISTORY_RAW_RETENTION_DAYS`; older days are empty."""
    try:
        return ov.build_inverter_raw(db, plant_id, device_sn, day)
    except ov.GrowattNotFound as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@router.get("/plants/{plant_id}/inverters/{device_sn}/daily")
def get_growatt_inverter_daily(
    plant_id: int,
    device_sn: str,
    day: Optional[date] = DAY_QUERY,
    days: int = Query(30, ge=1, le=ov.MAX_TREND_DAYS),
    db: Session = Depends(get_db),
    _user: User = Depends(require_plant_read),
) -> Dict[str, Any]:
    """Stored daily yield / peak AC / max temperature of one inverter for `days` days ending
    at `day`, with the plant's average inverter yield per day."""
    try:
        return ov.build_inverter_daily(db, plant_id, device_sn, day, days)
    except ov.GrowattNotFound as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@router.get("/plants/{plant_id}/weather")
def get_growatt_plant_weather(
    plant_id: int,
    day: Optional[date] = Query(None, description="Plant-local date (YYYY-MM-DD); default = latest day with weather data"),
    start: Optional[time] = Query(None, description="Plant-local start time (HH:MM, inclusive); default = start of day"),
    end: Optional[time] = Query(None, description="Plant-local end time (HH:MM, inclusive); default = end of day"),
    sensor: Optional[str] = Query(
        None, pattern=r"^[A-Za-z0-9_-]+:\d+$", description="One sensor, `DATALOGGER_SN:ADDRESS`; default = average of all sensors"
    ),
    db: Session = Depends(get_db),
    _user: User = Depends(require_plant_read),
) -> Dict[str, Any]:
    """Stored weather-sensor data for one day: 5-minute irradiance, module/ambient temperature,
    humidity and wind, plus insolation and peaks. Probes that read only 0 all day are null.
    `start` / `end` narrow the series and KPIs to a time-of-day window (`meta.window`).
    `has_sensor = false` when the plant has no weather sensor."""
    if start is not None and end is not None and start > end:
        raise HTTPException(status_code=422, detail="start must not be after end")
    try:
        ov._get_plant(db, plant_id)
    except ov.GrowattNotFound as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    one: Optional[Tuple[str, int]] = None
    if sensor:
        sn, addr = sensor.rsplit(":", 1)
        one = (sn, int(addr))
    try:
        return wx.build_weather_day(db, plant_id, day, start_time=start, end_time=end, sensor=one)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=f"Plant {plant_id} has no such weather sensor") from exc


@router.get("/plants/{plant_id}/google-weather")
def get_growatt_plant_google_weather(
    plant_id: int,
    day: Optional[date] = Query(None, description="Plant-local date (YYYY-MM-DD); default = latest complete stored day"),
    db: Session = Depends(get_db),
    _user: User = Depends(require_plant_read),
) -> Dict[str, Any]:
    """Stored hourly Google Maps Weather for one day (modelled): cloud cover, rain, temperature,
    UV, wind; daily totals and days since the last rain day. Written by the `google_weather` job."""
    try:
        plant = ov._get_plant(db, plant_id)
    except ov.GrowattNotFound as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    return gw.build_day(db, plant, day)


@router.get("/plants/{plant_id}/strings/{device_sn}/{string_no}")
def get_growatt_string_detail(
    plant_id: int,
    device_sn: str,
    string_no: int,
    day: Optional[date] = DAY_QUERY,
    start: Optional[time] = Query(None, description="Plant-local start time (HH:MM, inclusive); default = start of day"),
    end: Optional[time] = Query(None, description="Plant-local end time (HH:MM, inclusive); default = end of day"),
    end_day: Optional[date] = Query(None, description="Last day of a day range starting at `day` (inclusive, at most 31 days)"),
    db: Session = Depends(get_db),
    _user: User = Depends(require_plant_read),
) -> Dict[str, Any]:
    """Stored telemetry for one string on one day (or `day`..`end_day`), plus modelled I-V / P-V
    curves and per-day energy (`daily`). `start` / `end` narrow everything to a time-of-day window
    (`meta.window`), on every day of a range."""
    if start is not None and end is not None and start > end:
        raise HTTPException(status_code=422, detail="start must not be after end")
    if end_day is not None and (day is None or end_day < day):
        raise HTTPException(status_code=422, detail="end_day needs day and must not be before it")
    try:
        return ov.build_string_detail(db, plant_id, device_sn, string_no, day, start_time=start, end_time=end, end_day=end_day)
    except ov.GrowattNotFound as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@router.get("/sensors")
def fleet_sensors(
    plant_id: Optional[int] = Query(None, description="Only this plant's sensors (the plant Sensors tab)"),
    day: Optional[date] = Query(None, description="Plant-local day for coverage and flags (YYYY-MM-DD); default = today"),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> Dict[str, Any]:
    """Every weather sensor of the plants the user may see, from the registry and stored history
    (DB only, never calls Growatt): newest stored reading, probes reporting in the last 7 days and
    today's daylight coverage. `status` is `not_synced` (nothing stored) or `unknown`: online state
    is realtime and comes from the live sweep, never from SQL. `plant_id` narrows it to one plant.
    `day` judges coverage (`coverage_pct`) and the stored-data flags on a past day (Active Alarm)."""
    return growatt_sensors.list_sensors(db, sensor_scope(db, user, plant_id), day=day)


@router.get("/alarms")
def fleet_alarms(
    day: Optional[date] = Query(None, description="Plant-local day (YYYY-MM-DD); default = today"),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> Dict[str, Any]:
    """Stored Growatt alarm log of every plant the user may see for one plant-local day (DB only;
    the worker's `alarms` jobs fill it). `plants[]` tells, per plant, how many inverters have been
    read for the day and when (`synced_at`, UTC, the oldest read): unread is not "no alarms".
    `meta.last_run_at` / `next_run_at` (UTC; next only for today) let the page re-read right
    after the worker's next `alarms` run instead of polling blindly."""
    now = datetime.now(timezone.utc)
    today = now.astimezone(jobs.PLANT_TZ).date()
    d = day or today
    out = growatt_alarms.alarm_day(db, d, allowed_plant_ids(db, user))
    last = jobs.last_started(db, "alarms")
    nxt = growatt_alarms.next_run_at(now, last) if d == today else None
    out["meta"]["last_run_at"] = last.isoformat() if last else None
    out["meta"]["next_run_at"] = nxt.isoformat() if nxt else None
    return out


CURTAILMENT_MAX_DAYS = 92


@router.get("/curtailment")
def fleet_curtailment(
    start: Optional[date] = Query(None, description="First plant-local day (default: 6 days before `end`)"),
    end: Optional[date] = Query(None, description="Last plant-local day (default: today)"),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> Dict[str, Any]:
    """Curtailment of every plant the user may see over `start`..`end` (≤ 92 days), from the
    stored daily rows (DB only; the `rules_*` jobs fill them): curtailed kWh (**estimated**, the
    model calibrated per plant on how it runs when free), produced kWh, share, cause and the
    calibration behind it, plus fleet totals per day (services/growatt_curtailment.fleet)."""
    from datetime import timedelta

    from app.services import growatt_curtailment

    e = end or datetime.now(timezone.utc).astimezone(jobs.PLANT_TZ).date()
    s = start or e - timedelta(days=6)
    if s > e:
        raise HTTPException(status_code=422, detail="start is after end")
    if (e - s).days + 1 > CURTAILMENT_MAX_DAYS:
        raise HTTPException(status_code=422, detail=f"A period covers at most {CURTAILMENT_MAX_DAYS} days")
    return growatt_curtailment.fleet(db, s, e, allowed_plant_ids(db, user))
