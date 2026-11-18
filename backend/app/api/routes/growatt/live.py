"""Realtime values straight from the Growatt cloud (`/growatt/live/*`), cached in memory only
(`app.services.growatt_live`). Never written to the database.

Each project phase is a separate Growatt account; live calls for a plant use its phase's token
(the phase is read from the registry, nothing is written). Responses carry `source = "live"`,
`fetched_at` and `stale`."""

from __future__ import annotations

from datetime import date, datetime, timedelta
from typing import Any, Dict, Optional, Set

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.auth import allowed_plant_ids, get_current_user, require_plant_read
from app.config import settings
from app.db.models import GrowattInverter, GrowattPlant, User
from app.db.session import get_db
from app.services import growatt_meter
from app.services import growatt_sensors
from app.services import growatt_overview as ov
from app.services import growatt_weather as wx
from app.services import google_weather as gw
from app.services import longdo_weather as longdo
from app.services import live_string_check
from app.services import jobs
from app.api.routes.growatt._common import sensor_scope
from app.services.growatt_live import GrowattLiveService, LiveUnavailable, get_live_service

router = APIRouter()


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


@router.get("/live/inverters/snapshot")
def live_inverter_snapshot(
    plant_id: Optional[int] = Query(None, description="Only this plant's inverters"),
    db: Session = Depends(get_db),
    live: GrowattLiveService = Depends(get_live_service),
    user: User = Depends(get_current_user),
) -> Dict[str, Any]:
    """Newest record (status, AC/DC power, today's kWh, temperature) of every inverter the user may
    see, from `maxs_data` (50 inverters per call, memory only; never written to SQL). Swept like
    `/live/sensors/status`: each request refreshes at most `INVERTER_SNAPSHOT_SWEEP_PER_REQUEST`
    chunks and serves the rest from the shared cache (`INVERTER_SNAPSHOT_TTL_S`). Each record
    carries its own `record_time` (plant-local): a silent inverter's record can be months old.
    `data.inverters` is keyed by serial, with `plant_id` from the registry."""
    allowed = allowed_plant_ids(db, user)
    if plant_id is not None and allowed is not None and plant_id not in allowed:
        raise HTTPException(status_code=404, detail="Plant not found")
    rows = db.execute(
        select(GrowattInverter.device_sn, GrowattInverter.plant_id, GrowattPlant.phase).join(
            GrowattPlant, GrowattPlant.plant_id == GrowattInverter.plant_id
        )
    ).all()
    plant_of = {sn: int(pid) for sn, pid, _ph in rows}
    wanted: Optional[Set[str]] = None
    if plant_id is not None:
        wanted = {sn for sn, pid, _ph in rows if pid == plant_id}
    elif allowed is not None:
        wanted = {sn for sn, pid, _ph in rows if pid in allowed}
    try:
        out = live.inverter_snapshot(
            [(sn, ph) for sn, _pid, ph in rows],
            wanted=wanted,
            coords=ov.plant_coords(db, plant_id),
        )
    except LiveUnavailable as exc:
        raise HTTPException(status_code=503, detail=f"Growatt live data unavailable: {exc}") from exc
    for sn, row in out["data"]["inverters"].items():
        row["plant_id"] = plant_of.get(sn)
    return out


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

    `data.dataloggers` = the plant's dataloggers with Growatt's `lost` flag and last upload time
    (`device/datalogger/list`, realtime only); null with `data.dataloggers_error` when that call
    failed, which never fails the inverters' part.
    """
    sns = [inv["device_sn"] for inv in ov.list_inverters(db, plant_id)]
    if not sns:
        raise HTTPException(status_code=404, detail=f"Plant {plant_id} has no inverters")
    phase, coords = ov.plant_phase(db, plant_id), ov.plant_coords(db, plant_id)
    try:
        env = live.plant_latest(plant_id, sns, datetime.now(jobs.PLANT_TZ).date(), phase=phase, coords=coords)
    except LiveUnavailable as exc:
        raise HTTPException(status_code=503, detail=f"Growatt live data unavailable: {exc}") from exc
    loggers, loggers_error = live.plant_dataloggers(plant_id, phase=phase, coords=coords)
    check = live_string_check.check_plant(env["data"]["inverters"], ov.load_layout(db, sns, fleet_wp=False), ov.wired_inputs(db, sns))
    # the older records were only input to the check: don't send them to the browser
    invs = [{k: v for k, v in inv.items() if k != "previous_strings"} for inv in env["data"]["inverters"]]
    return {
        **env,
        "data": {
            **env["data"],
            "inverters": invs,
            "string_check": check,
            "dataloggers": loggers,
            "dataloggers_error": loggers_error,
        },
    }


@router.get("/live/plants/{plant_id}/meter")
def live_plant_meter(
    plant_id: int,
    load: bool = Query(True, description="Also derive load = PV AC + grid from the live inverter records (shared `/latest` cache)"),
    db: Session = Depends(get_db),
    live: GrowattLiveService = Depends(get_live_service),
    _user: User = Depends(require_plant_read),
) -> Dict[str, Any]:
    """Grid import / export now, from the newest record of the plant's energy meter(s)
    (`meter_last_data`), and the derived load. Memory only, never stored.

    `data.grid`: measured at the meter (+ import / − export). `data.load` (with `load=true`):
    PV AC + grid, **derived**; PV from each inverter's newest `max_data` record, the same cache
    as `/live/plants/{id}/latest`, so a page polling both costs no extra Growatt calls. Null with
    a `reason` when PV at the meter's time is not known for every inverter. 404 without a meter."""
    meters = growatt_meter.plant_meters(db, plant_id)
    if not meters:
        raise HTTPException(status_code=404, detail=f"Plant {plant_id} has no energy meter")
    phase, coords = ov.plant_phase(db, plant_id), ov.plant_coords(db, plant_id)
    try:
        env = live.plant_meter(plant_id, meters, phase=phase, coords=coords)
    except LiveUnavailable as exc:
        raise HTTPException(status_code=503, detail=f"Growatt live data unavailable: {exc}") from exc
    if not load:
        return env
    sns = [inv["device_sn"] for inv in ov.list_inverters(db, plant_id)]
    try:
        inv = live.plant_latest(plant_id, sns, datetime.now(jobs.PLANT_TZ).date(), phase=phase, coords=coords)
        d = inv["data"]
        derived = growatt_meter.live_load(env["data"]["grid"], sns, d["inverters"], d["errors"])
        # the inverter cache can expire sooner than the meter's: poll on the earlier of the two
        env = {**env, "refresh_in_s": min(env["refresh_in_s"], inv["refresh_in_s"])}
    except LiveUnavailable as exc:
        derived = {"timestamp": env["data"]["grid"]["timestamp"], "pv_kw": None, "load_kw": None, "reason": f"inverters unavailable: {exc}"}
    return {**env, "data": {**env["data"], "load": {**derived, "derived": True}}}


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
    sensors = growatt_sensors.visible_sensors(db, sensor_scope(db, user, plant_id))
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


@router.get("/live/rain-radar")
def live_rain_radar(
    db: Session = Depends(get_db), live: longdo.LongdoLive = Depends(longdo.get_longdo_live)
) -> Dict[str, Any]:
    """Longdo rain radar for the Plant Map: the snapshots available (Unix times, oldest first),
    the XYZ tile URL template (it carries the Longdo Map key, a browser key) and the legend.
    Memory only. 404 = not configured (`LONGDO_API_KEY`): the UI hides the radar button."""
    if not longdo.enabled():
        raise HTTPException(status_code=404, detail="Longdo rain radar is not configured")
    try:
        return longdo.radar(db, live)
    except longdo.LongdoUnavailable as exc:
        raise HTTPException(status_code=503, detail=f"Longdo rain radar unavailable: {exc}") from exc


@router.get("/live/rain")
def live_fleet_rain(
    db: Session = Depends(get_db),
    live: longdo.LongdoLive = Depends(longdo.get_longdo_live),
    user: User = Depends(get_current_user),
) -> Dict[str, Any]:
    """Radar rain class now over every plant the user may see: Longdo `area` per 1° region, then
    `location` only for plants in a region with rain. Swept `LONGDO_RAIN_SWEEP_PER_REQUEST`
    calls per request inside the rate limit and the monthly budget, memory only. Polled only
    while the Plant Map's radar is on. Radar-derived, not measured."""
    if not longdo.enabled():
        raise HTTPException(status_code=404, detail="Longdo rain radar is not configured")
    return longdo.fleet_rain(db, live, allowed_plant_ids(db, user))


@router.get("/live/plants/{plant_id}/rain")
def live_plant_rain(
    plant_id: int,
    db: Session = Depends(get_db),
    live: longdo.LongdoLive = Depends(longdo.get_longdo_live),
    _user: User = Depends(require_plant_read),
) -> Dict[str, Any]:
    """Rain over the plant from the Longdo weather radar: intensity class 0–5 now and the
    +15 / +30 min nowcast (radar-derived, not measured). Cached in memory per ~1 km cell
    (`LONGDO_RAIN_TTL_S`), never stored. 404 = not configured or unknown plant."""
    if not longdo.enabled():
        raise HTTPException(status_code=404, detail="Longdo rain radar is not configured")
    try:
        plant = ov._get_plant(db, plant_id)
    except ov.GrowattNotFound as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    try:
        return longdo.plant_rain(db, plant, live)
    except longdo.LongdoUnavailable as exc:
        raise HTTPException(status_code=503, detail=f"Longdo rain radar unavailable: {exc}") from exc
