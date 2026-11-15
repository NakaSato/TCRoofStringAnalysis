"""Growatt routes, split by data source.

- `/growatt/live/*`   realtime values straight from the Growatt cloud, cached in memory only
                      (`app.services.growatt_live`). Never written to the database.
- `/growatt/plants*`  persisted data only: the registry and max_data history (1–5 min) mirrored by
                      `app.services.growatt_sync`. No Growatt calls happen here.

Each project phase is a separate Growatt account; live calls for a plant use its phase's token
(the phase is read from the registry, nothing is written).

Timestamps in the reading tables are plant-local (Thai) time. DB responses carry
`meta.source = "db"`; live responses carry `source = "live"`, `fetched_at` and `stale`.
"""

from __future__ import annotations

import logging

from datetime import date, datetime, time, timedelta, timezone
from typing import Any, Dict, List, Optional, Set, Tuple

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.auth import (
    allowed_plant_ids,
    get_current_user,
    require_admin,
    require_plant_read,
    require_plant_write,
    require_write_access,
)
from app.config import settings
from app.db.models import GrowattPlant, SyncRun, User
from app.db.session import get_db
from app.schemas.api_schemas import FleetModule, GrowattStringLayoutEntry, IssueAction, Tariff
from app.services import fleet_settings
from app.services import growatt_alarms
from app.services import growatt_sensors
from app.services import growatt_overview as ov
from app.services import growatt_weather as wx
from app.services import google_weather as gw
from app.services import live_string_check
from app.services import jobs
from app.services.growatt_live import GrowattLiveService, LiveUnavailable, get_live_service

router = APIRouter(prefix="/growatt", tags=["Growatt OpenAPI & Plant Telemetry"])
audit = logging.getLogger("app.audit")

DAY_QUERY = Query(None, description="Plant-local date (YYYY-MM-DD); default = latest day with data")


# --------------------------------------------------------------------------- live (memory only)


@router.get("/live/plants")
def live_plants(
    db: Session = Depends(get_db),
    live: GrowattLiveService = Depends(get_live_service),
    user: User = Depends(get_current_user),
) -> Dict[str, Any]:
    """Realtime plant power/status for the fleet (an engineer's assigned plants). Not persisted.

    The memory cache stays fleet-wide (same Growatt calls for every user); only the answer is filtered.
    """
    allowed = allowed_plant_ids(db, user)
    try:
        env = live.plants(coords=ov.plant_coords(db))
    except LiveUnavailable as exc:
        raise HTTPException(status_code=503, detail=f"Growatt live data unavailable: {exc}") from exc
    if allowed is None:
        return env
    return {**env, "data": [p for p in env["data"] if p["plant_id"] in allowed]}


@router.get("/live/plants/today")
def live_plants_today(
    db: Session = Depends(get_db),
    live: GrowattLiveService = Depends(get_live_service),
    user: User = Depends(get_current_user),
) -> Dict[str, Any]:
    """Today's energy of every plant the user may see (`plant/data`, memory only; the plant
    directory's Yield today). `plant/list` has no today energy, so this is one call per plant,
    swept like `/live/sensors/status`: each request refreshes at most
    `PLANT_TODAY_SWEEP_PER_REQUEST` plants (oldest first) and serves the rest from the shared
    memory cache (`PLANT_TODAY_TTL_S`). `data.plants` is keyed by plant id; `today_energy_kwh`
    is null when the plant's last upload is not from today. Never written to SQL."""
    allowed = allowed_plant_ids(db, user)
    q = select(GrowattPlant.plant_id, GrowattPlant.phase)
    if allowed is not None:
        q = q.where(GrowattPlant.plant_id.in_(allowed))
    plants = [(int(pid), ph) for pid, ph in db.execute(q).all()]
    try:
        return live.plant_today(plants, coords=ov.plant_coords(db))
    except LiveUnavailable as exc:
        raise HTTPException(status_code=503, detail=f"Growatt live data unavailable: {exc}") from exc


@router.get("/live/plants/{plant_id}/inverters")
def live_inverters(
    plant_id: int,
    db: Session = Depends(get_db),
    live: GrowattLiveService = Depends(get_live_service),
    _user: User = Depends(require_plant_read),
) -> Dict[str, Any]:
    """Realtime inverter status for one plant. Not persisted."""
    try:
        return live.inverters(plant_id, phase=ov.plant_phase(db, plant_id), coords=ov.plant_coords(db, plant_id))
    except LiveUnavailable as exc:
        raise HTTPException(status_code=503, detail=f"Growatt live data unavailable: {exc}") from exc


@router.get("/live/plants/{plant_id}/latest")
def live_plant_latest(
    plant_id: int,
    db: Session = Depends(get_db),
    live: GrowattLiveService = Depends(get_live_service),
    _user: User = Depends(require_plant_read),
) -> Dict[str, Any]:
    """Newest record per inverter (power, MPPT, per-string V/I) for one plant. Not persisted.

    `data.string_check` = each string judged against its inverter's other strings in the same
    record, flagged only when the 6 newest records agree (`services/live_string_check.py`),
    realtime only. The DB is read only for the plant's inverter list, String Layout module counts
    and which inputs are wired; nothing is written.
    """
    sns = [inv["device_sn"] for inv in ov.list_inverters(db, plant_id)]
    if not sns:
        raise HTTPException(status_code=404, detail=f"Plant {plant_id} has no inverters")
    try:
        env = live.plant_latest(
            plant_id,
            sns,
            datetime.now(jobs.PLANT_TZ).date(),
            phase=ov.plant_phase(db, plant_id),
            coords=ov.plant_coords(db, plant_id),
        )
    except LiveUnavailable as exc:
        raise HTTPException(status_code=503, detail=f"Growatt live data unavailable: {exc}") from exc
    check = live_string_check.check_plant(env["data"]["inverters"], ov.load_layout(db, sns, fleet_wp=False), ov.wired_inputs(db, sns))
    # the older records were only input to the check: don't send them to the browser
    invs = [{k: v for k, v in inv.items() if k != "previous_strings"} for inv in env["data"]["inverters"]]
    return {**env, "data": {**env["data"], "inverters": invs, "string_check": check}}


@router.get("/live/plants/{plant_id}/alarms")
def live_plant_alarms(
    plant_id: int,
    day: Optional[date] = Query(None, description="Last plant-local day (YYYY-MM-DD) of the window; default = today"),
    days: int = Query(7, ge=1, le=31, description="Number of days ending at `day`"),
    db: Session = Depends(get_db),
    live: GrowattLiveService = Depends(get_live_service),
    _user: User = Depends(require_plant_read),
) -> Dict[str, Any]:
    """Growatt alarm / fault log (`device/max/alarm_data`) of the plant's inverters over the last
    `days` days, newest first. Cached in memory only; the DB is read only for the inverter list."""
    sns = [inv["device_sn"] for inv in ov.list_inverters(db, plant_id)]
    if not sns:
        raise HTTPException(status_code=404, detail=f"Plant {plant_id} has no inverters")
    end = day or datetime.now(jobs.PLANT_TZ).date()
    try:
        return live.plant_alarms(
            plant_id,
            sns,
            [end - timedelta(days=i) for i in range(days)],
            phase=ov.plant_phase(db, plant_id),
            coords=ov.plant_coords(db, plant_id),
        )
    except LiveUnavailable as exc:
        raise HTTPException(status_code=503, detail=f"Growatt live data unavailable: {exc}") from exc


def _sensor_scope(db: Session, user: User, plant_id: Optional[int]) -> Optional[Set[int]]:
    """Plants whose sensors a request covers: the user's visible plants, narrowed to `plant_id`
    when given (an invisible plant gives the empty set, so nothing is revealed)."""
    allowed = allowed_plant_ids(db, user)
    if plant_id is None:
        return allowed
    return {plant_id} if allowed is None or plant_id in allowed else set()


@router.get("/live/sensors/status")
def live_sensor_status(
    plant_id: Optional[int] = Query(None, description="Only this plant's sensors (the plant Sensors tab)"),
    db: Session = Depends(get_db),
    live: GrowattLiveService = Depends(get_live_service),
    user: User = Depends(get_current_user),
) -> Dict[str, Any]:
    """Live online state of every weather sensor the user may see (`env_list`, memory only).

    Swept incrementally: each request refreshes at most `SENSOR_SWEEP_PER_REQUEST` dataloggers
    (oldest first) and serves the rest from the shared memory cache; `data.sweep` says how many
    are fresh, and `refresh_in_s` is short until the sweep is complete. An engineer's request
    sweeps only their plants' dataloggers; with `plant_id`, only that plant's. Never written to SQL."""
    sensors = growatt_sensors.visible_sensors(db, _sensor_scope(db, user, plant_id))
    dataloggers = sorted({(dl, ph) for dl, _addr, ph, _su in sensors})
    try:
        env = live.sensor_status(dataloggers, coords=ov.plant_coords(db, plant_id))
    except LiveUnavailable as exc:
        raise HTTPException(status_code=503, detail=f"Growatt live data unavailable: {exc}") from exc
    return growatt_sensors.overlay_live_status(
        env,
        sensors,
        datetime.now(jobs.PLANT_TZ).replace(tzinfo=None),
        settings.sensor_late_min,
        settings.sensor_offline_min,
    )


@router.get("/live/sensors/{datalogger_sn}/{address}")
def live_sensor(
    datalogger_sn: str,
    address: int,
    db: Session = Depends(get_db),
    live: GrowattLiveService = Depends(get_live_service),
    user: User = Depends(get_current_user),
) -> Dict[str, Any]:
    """One weather sensor for the Info view (memory only): live online state (its datalogger's
    `env_list`, shared with the fleet sweep) and the newest `env_last_data` record. Probes not
    measured in the last 7 days are null. `raw` = the record as Growatt reported it, admins only
    (engineers get null). 404 when the sensor is not registered or its plant is not visible."""
    found = growatt_sensors.find_sensor(db, datalogger_sn, address, allowed_plant_ids(db, user))
    if found is None:
        raise HTTPException(status_code=404, detail=f"Weather sensor {datalogger_sn}#{address} not found")
    sensor, phase = found
    now_local = datetime.now(jobs.PLANT_TZ).replace(tzinfo=None)
    measured = growatt_sensors.measured_for(db, sensor, now_local)
    try:
        env = live.sensor_live(
            datalogger_sn, address, phase=phase, measured=measured, coords=ov.plant_coords(db, sensor.plant_id)
        )
    except LiveUnavailable as exc:
        raise HTTPException(status_code=503, detail=f"Growatt live data unavailable: {exc}") from exc
    d = env["data"]
    return {
        **env,
        "data": {
            "status": growatt_sensors.live_row(
                datalogger_sn,
                address,
                d["datalogger"],
                now_local,
                settings.sensor_late_min,
                settings.sensor_offline_min,
                sensor.history_synced_until,
            ),
            "measured": measured,
            "reading": d["reading"],
            "raw": d["raw"] if user.role == "admin" else None,
            "errors": d["errors"],
            "thresholds": {"late_min": settings.sensor_late_min, "offline_min": settings.sensor_offline_min},
        },
    }


@router.get("/live/sensors/{datalogger_sn}/{address}/today")
def live_sensor_today(
    datalogger_sn: str,
    address: int,
    db: Session = Depends(get_db),
    live: GrowattLiveService = Depends(get_live_service),
    user: User = Depends(get_current_user),
) -> Dict[str, Any]:
    """Today's 5-minute records of one weather sensor straight from Growatt (`env_data`, today
    only; memory only, never stored), so the sensor page's chart is complete between the
    worker's syncs. A past day is read from the DB (`/plants/{id}/weather`). 404 when the sensor
    is not registered or its plant is not visible."""
    found = growatt_sensors.find_sensor(db, datalogger_sn, address, allowed_plant_ids(db, user))
    if found is None:
        raise HTTPException(status_code=404, detail=f"Weather sensor {datalogger_sn}#{address} not found")
    sensor, phase = found
    try:
        return live.sensor_today(datalogger_sn, address, phase=phase, coords=ov.plant_coords(db, sensor.plant_id))
    except LiveUnavailable as exc:
        raise HTTPException(status_code=503, detail=f"Growatt live data unavailable: {exc}") from exc


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
    return growatt_sensors.list_sensors(db, _sensor_scope(db, user, plant_id), day=day)


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


@router.get("/live/plants/{plant_id}/weather")
def live_plant_weather(
    plant_id: int,
    db: Session = Depends(get_db),
    live: GrowattLiveService = Depends(get_live_service),
    _user: User = Depends(require_plant_read),
) -> Dict[str, Any]:
    """Newest weather-sensor reading (irradiance, temperatures, humidity, wind) per sensor. Not persisted.

    Each sensor row carries `interval_s` (gap between its last two live records, memory only;
    null until measured) and `stored_until` (newest stored reading, `history_synced_until`), so
    the UI knows which live points the DB series doesn't hold yet. The DB is read only for the
    plant's sensors and which probes they have; nothing is written.
    """
    since = datetime.now(jobs.PLANT_TZ).replace(tzinfo=None) - timedelta(days=7)
    measured = wx.measured_fields(db, plant_id, since)
    if not measured:
        raise HTTPException(status_code=404, detail=f"Plant {plant_id} has no weather sensor")
    try:
        env = live.plant_weather(
            plant_id,
            [(dl, addr, fields) for (dl, addr), fields in measured.items()],
            phase=ov.plant_phase(db, plant_id),
            coords=ov.plant_coords(db, plant_id),
        )
    except LiveUnavailable as exc:
        raise HTTPException(status_code=503, detail=f"Growatt live data unavailable: {exc}") from exc
    stored = {(s.datalogger_sn, s.address): s.history_synced_until for s in wx.plant_sensors(db, plant_id)}
    for row in env["data"]["sensors"]:
        until = stored.get((row["datalogger_sn"], row["address"]))
        row["stored_until"] = until.strftime("%Y-%m-%d %H:%M:%S") if until else None
    return env


@router.get("/live/plants/{plant_id}/google-weather")
def live_plant_google_weather(
    plant_id: int,
    db: Session = Depends(get_db),
    live: gw.GoogleWeatherLive = Depends(gw.get_google_live),
    _user: User = Depends(require_plant_read),
) -> Dict[str, Any]:
    """Current conditions from the Google Maps Weather API for the plant's grid cell (modelled,
    not measured). Cached in memory per cell (`GOOGLE_WEATHER_LIVE_TTL_S`), never stored, and
    capped per day; over the cap the last value is served as stale."""
    try:
        plant = ov._get_plant(db, plant_id)
    except ov.GrowattNotFound as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    try:
        return gw.live_plant(db, plant, live)
    except gw.GoogleWeatherUnavailable as exc:
        raise HTTPException(status_code=503, detail=f"Google Weather unavailable: {exc}") from exc


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
    db: Session = Depends(get_db),
    _user: User = Depends(require_plant_read),
) -> List[Dict[str, Any]]:
    """Inverter registry for a plant from the DB (status = last synced value)."""
    return ov.list_inverters(db, plant_id)


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
    db: Session = Depends(get_db),
    _user: User = Depends(require_plant_read),
) -> Dict[str, Any]:
    """The plant's stored 5-minute AC / DC curve over a day or day range (DB only)."""
    if start is not None and end is not None and start > end:
        raise HTTPException(status_code=422, detail="start must not be after end")
    if end_day is not None and end_day < day:
        raise HTTPException(status_code=422, detail="end_day must not be before day")
    try:
        return ov.build_plant_power(db, plant_id, day, end_day=end_day, start_time=start, end_time=end)
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


@router.get("/fleet-module")
def get_fleet_module(
    db: Session = Depends(get_db),
    _user: User = Depends(get_current_user),
) -> Dict[str, Any]:
    """PV module used across the fleet (global). `source = "default"` until someone saves it."""
    return fleet_settings.get_fleet_module(db)


@router.put("/fleet-module")
def put_fleet_module(
    payload: FleetModule,
    db: Session = Depends(get_db),
    user: User = Depends(require_admin),
) -> Dict[str, Any]:
    """Save the fleet module (admin only: it applies to every plant) to SQL, then publish `config/fleet_module` to the summary sink.

    A failed publish does not undo the save: the next publish job retries it.
    """
    from app.services import daily_summary  # firebase_admin is imported lazily by the sink

    saved = fleet_settings.put_fleet_module(db, payload.model_dump(), user.username or user.email)
    audit.info("%s saved the fleet module", user.username or user.email)
    return {**saved, "published": _publish_safely(db, lambda: daily_summary.publish_config(db))}


@router.get("/plants/{plant_id}/string-layout")
def get_growatt_string_layout(
    plant_id: int,
    db: Session = Depends(get_db),
    _user: User = Depends(require_plant_read),
) -> Dict[str, Any]:
    """As-built module count per string input (null = not entered), plus inputs seen in the last week."""
    try:
        return ov.get_string_layout(db, plant_id)
    except ov.GrowattNotFound as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@router.put("/plants/{plant_id}/string-layout")
def put_growatt_string_layout(
    plant_id: int,
    entries: List[GrowattStringLayoutEntry],
    db: Session = Depends(get_db),
    _user: User = Depends(require_plant_write),
) -> Dict[str, Any]:
    """Replace the plant's module-count registry; strings left out are cleared."""
    try:
        saved = ov.put_string_layout(db, plant_id, [e.model_dump() for e in entries])
    except ov.GrowattNotFound as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    from app.services import daily_summary

    return {**saved, "published": _publish_safely(db, lambda: daily_summary.publish_plant_inverters(db, plant_id))}


def _publish_safely(db: Session, fn: Any) -> Dict[str, Any]:
    """Mirror a just-saved registry change to the summary sink. A failure does not undo the
    save (the next publish job retries); it is reported instead."""
    try:
        rep = fn()
        return {"sink": rep.sink, "written": rep.written, "deferred": bool(rep.over_budget)}
    except Exception as exc:  # noqa: BLE001 — sink errors (credentials, network) are reported, not raised
        db.rollback()
        return {"sink": None, "written": 0, "error": str(exc)}


# --------------------------------------------------------------------------- decision rules


@router.get("/rules/findings")
def rule_findings(
    day: Optional[date] = Query(None, description="plant-local day (default today)"),
    plant_id: Optional[int] = Query(None),
    db: Session = Depends(get_db),
    _user: User = Depends(require_admin),
) -> Dict[str, Any]:
    """Decision-rule findings for a day, from the stored daily tables (Phase 1: admin only,
    evaluated on request, not stored; docs/plans/decision-rules.md). Lost kWh is estimated."""
    from app.services import growatt_rules

    d = day or jobs._today()
    findings = growatt_rules.evaluate(db, d, [plant_id] if plant_id is not None else None)
    return {
        "day": d.isoformat(),
        "summary": growatt_rules.summarize(findings),
        "findings": findings,
        "settings": growatt_rules.rule_settings(db),
        "meta": {"source": "db", "estimated": ["lost_kwh_est", "thb_est"], "stored": False},
    }


@router.get("/rules")
def get_rules(
    since_days: int = Query(90, ge=1, le=730, description="Rule review covers issues opened in the last N days"),
    db: Session = Depends(get_db),
    _user: User = Depends(require_admin),
) -> Dict[str, Any]:
    """Rule settings (thresholds, enabled, shadow) and Rule review: per rule, how many issues it
    opened, how they ended (auto-closed / resolved / dismissed, confirmed vs false alarm) and the
    estimated baht they found. Admin only."""
    from app.services import growatt_issues, growatt_rules

    since = jobs._today() - timedelta(days=since_days)
    return {
        "settings": growatt_rules.rule_settings(db),
        "defaults": {**growatt_rules.DEFAULT_RULES, "rules": {r: dict(growatt_rules.DEFAULT_RULE_STATE) for r in growatt_rules.RULE_NAMES}},
        "names": growatt_rules.RULE_NAMES,
        "review": growatt_issues.review(db, since),
        "since": since.isoformat(),
        "meta": {"source": "db", "estimated": ["thb_total_est"]},
    }


@router.put("/rules")
def put_rules(
    payload: Dict[str, Any],
    db: Session = Depends(get_db),
    user: User = Depends(require_admin),
) -> Dict[str, Any]:
    """Change rule settings (any subset of the keys of `GET /growatt/rules` `settings`). Each
    changed value is logged to System → Logs with its old and new value. Applies from the next
    `rules_*` run. Admin only."""
    from app.services import growatt_rules

    try:
        old, new = growatt_rules.put_rule_settings(db, payload, user.username or user.email)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    who = user.username or user.email
    for k in new:
        if k == "rules":
            for r, st in new["rules"].items():
                if st != old["rules"].get(r):
                    audit.info("%s changed rule %s: %s -> %s", who, r, old["rules"].get(r), st)
        elif new[k] != old.get(k):
            audit.info("%s changed rule setting %s: %s -> %s", who, k, old.get(k), new[k])
    return {"settings": new}


@router.get("/issues")
def list_issues(
    plant_id: Optional[int] = Query(None),
    status: str = Query("active", pattern="^(active|open|acknowledged|resolved|dismissed|closed|all)$"),
    tier: Optional[str] = Query(None, pattern="^(P1|P2|P3|P4|Info)$"),
    rule: Optional[str] = Query(None, max_length=8),
    shadow: Optional[bool] = Query(False, description="admin only: true = shadow issues (Rule review); omit for live"),
    include_shadow: bool = Query(False, description="admin only: live and shadow issues together"),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> Dict[str, Any]:
    """The Issues queue: decision-rule issues of the plants the user may see, safety first, then
    tier and estimated THB/day. Engineers never see shadow issues (rules still being calibrated).
    kWh and baht are estimates."""
    from app.services import growatt_issues

    allowed = allowed_plant_ids(db, user)
    if allowed is not None:
        shadow, include_shadow = False, False
        if plant_id is not None and plant_id not in allowed:
            raise HTTPException(status_code=404, detail=f"Plant {plant_id} not found")
    out = growatt_issues.list_issues(
        db, allowed, plant_id=plant_id, status=status, tier=tier, rule=rule, shadow=None if include_shadow else shadow
    )
    return {**out, "meta": {"source": "db", "estimated": ["lost_kwh_est", "thb_per_day_est", "lost_kwh_total_est", "thb_total_est"]}}


def _issue_for(db: Session, user: User, issue_id: int) -> Any:
    from app.db.models import GrowattIssue

    i = db.get(GrowattIssue, issue_id)
    allowed = allowed_plant_ids(db, user)
    if i is None or (allowed is not None and (i.plant_id not in allowed or i.shadow)):
        raise HTTPException(status_code=404, detail=f"Issue {issue_id} not found")
    return i


@router.get("/issues/{issue_id}")
def get_issue(issue_id: int, db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> Dict[str, Any]:
    from app.services import growatt_issues

    i = _issue_for(db, user, issue_id)
    plants, inverters = growatt_issues._names(db, [i])
    return growatt_issues.serialize(i, plants, inverters)


@router.patch("/issues/{issue_id}")
def patch_issue(
    issue_id: int,
    payload: IssueAction,
    db: Session = Depends(get_db),
    user: User = Depends(require_write_access),
) -> Dict[str, Any]:
    """Acknowledge, resolve or dismiss an issue (with a note and feedback: confirmed / false
    alarm, which Rule review counts), reopen a closed one, or only edit the note. Engineers act
    on their assigned plants' live issues; admins on any."""
    from app.services import growatt_issues

    i = _issue_for(db, user, issue_id)
    who = user.username or user.email
    try:
        growatt_issues.apply_action(db, i, payload.action, who, payload.note, payload.feedback)
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    audit.info("%s %s issue %s (%s %s)", who, payload.action, i.id, i.rule, i.device_sn or i.plant_id)
    plants, inverters = growatt_issues._names(db, [i])
    return growatt_issues.serialize(i, plants, inverters)


@router.get("/plants/{plant_id}/rules/daily")
def plant_rule_daily(
    plant_id: int,
    sn: str = Query(..., max_length=64),
    string_no: Optional[int] = Query(None, ge=1, le=64),
    days: int = Query(30, ge=1, le=365),
    day: Optional[date] = DAY_QUERY,
    db: Session = Depends(get_db),
    _user: User = Depends(require_plant_read),
) -> Dict[str, Any]:
    """The daily rows behind the rules for one inverter (or one of its strings): the last `days`
    days up to `day`. Ratios are vs the inverter's other strings in gated slots (null = no
    verdict that day); lost kWh are estimates."""
    from app.db.models import GrowattInverterDaily as ID, GrowattStringDaily as SD

    end = day or jobs._today()
    start = end - timedelta(days=days - 1)
    if string_no is not None:
        rows = db.scalars(
            select(SD).where(SD.plant_id == plant_id, SD.device_sn == sn, SD.string_no == string_no, SD.day >= start, SD.day <= end).order_by(SD.day)
        )
        cols = ["gated_slots", "ratio_median", "low_min", "severe_min", "open_min", "v_ratio_median", "energy_kwh", "lost_kwh_est"]
    else:
        rows = db.scalars(select(ID).where(ID.plant_id == plant_id, ID.device_sn == sn, ID.day >= start, ID.day <= end).order_by(ID.day))
        cols = [
            "daylight_min", "producing_min", "fault_min", "off_min", "standby_min", "limited_min", "no_data_min",
            "energy_kwh", "kwp", "yf_kwh_kwp", "yf_vs_median_pct", "plant_kwp_share_pct",
            "lost_fault_kwh_est", "lost_off_kwh_est", "lost_standby_kwh_est", "lost_no_data_kwh_est",
        ]
    data = [{"day": r.day.isoformat(), **{c: getattr(r, c) for c in cols}} for r in rows]
    return {"plant_id": plant_id, "device_sn": sn, "string_no": string_no, "start": start.isoformat(), "end": end.isoformat(),
            "days": data, "meta": {"source": "db", "estimated": [c for c in cols if c.endswith("_est")]}}


@router.get("/tariff")
def get_tariff(db: Session = Depends(get_db), _user: User = Depends(get_current_user)) -> Dict[str, Any]:
    """Electricity tariff (TOU + Ft, per-plant PPA rates). `source = "default"` until an admin saves it."""
    from app.services import tariff

    return tariff.get_tariff(db)


@router.put("/tariff")
def put_tariff(payload: Tariff, db: Session = Depends(get_db), user: User = Depends(require_admin)) -> Dict[str, Any]:
    """Save the tariff (admin), then publish `config/tariff`. Lost-energy baht use it from the
    next `rules_*` run; a changed on-peak window applies to past days after `rules_backfill`."""
    from app.services import daily_summary, tariff

    who = user.username or user.email
    old = tariff.get_tariff(db)
    saved = tariff.put_tariff(db, payload.model_dump(), who)
    for k in tariff.DEFAULT_TARIFF:
        if old.get(k) != saved.get(k):
            audit.info("%s changed tariff %s: %s -> %s", who, k, old.get(k), saved.get(k))
    return {**saved, "published": _publish_safely(db, lambda: daily_summary.publish_config(db))}


# --------------------------------------------------------------------------- background jobs


@router.get("/sync/status")
def sync_status(
    limit: int = Query(20, ge=1, le=200),
    db: Session = Depends(get_db),
    _user: User = Depends(require_admin),
) -> Dict[str, Any]:
    """Latest run per job plus the most recent runs (worker, API and CLI)."""
    latest: Dict[str, Any] = {}
    for job in jobs.JOBS:
        run = db.scalars(select(SyncRun).where(SyncRun.job == job).order_by(SyncRun.started_at.desc()).limit(1)).first()
        latest[job] = jobs.run_out(run) if run else None
    recent = db.scalars(select(SyncRun).order_by(SyncRun.started_at.desc()).limit(limit))
    return {"jobs": latest, "recent": [jobs.run_out(r) for r in recent]}


@router.post("/sync/{job}", status_code=202)
def trigger_sync(
    job: str,
    db: Session = Depends(get_db),
    user: User = Depends(require_admin),
) -> Dict[str, Any]:
    """Queue a job for the worker (history | backfill | fleet | publish_today | publish_yesterday | retention).

    The API never runs jobs itself (Cloud Run would cut its CPU after the response); the worker
    starts queued runs within a minute. Poll `/growatt/sync/status` for the outcome.
    """
    if job not in jobs.JOBS:
        raise HTTPException(status_code=404, detail=f"Unknown job {job!r}; choose one of {sorted(jobs.JOBS)}")
    try:
        run_id = jobs.enqueue(db, job, "api")
    except jobs.JobBusy as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    audit.info("%s queued job %s (run %s)", user.username or user.email, job, run_id)
    return {"run_id": run_id, "job": job, "status": "queued"}
