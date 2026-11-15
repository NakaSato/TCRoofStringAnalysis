"""Sync Growatt OpenAPI data into the app database.

Usage (from repo root):
    PYTHONPATH=backend uv run python -m app.services.growatt_sync               # fleet + yesterday..today
    PYTHONPATH=backend uv run python -m app.services.growatt_sync --start 2026-11-05 --end 2026-11-11
    PYTHONPATH=backend uv run python -m app.services.growatt_sync --fleet-only
    PYTHONPATH=backend uv run python -m app.services.growatt_sync --sn GKLLEXC006 --sn GKLLEXC005
    PYTHONPATH=backend uv run python -m app.services.growatt_sync --phase 2     # one account only

Weather sensors (`device/env/*`) are registered by the fleet sync and their history is
synced with the inverters' (skipped when `--sn` limits the run to some inverters).

Each project phase is a separate Growatt account (`GROWATT_TOKEN_PHASE1..4`). The fleet sync
tags every plant with the phase whose token lists it, and history for a plant's inverters is
always pulled with that phase's token.

Re-running is safe: readings are upserted on their primary keys.
"""

from __future__ import annotations

import argparse
import logging
import time
from datetime import date, datetime, timedelta, timezone
from typing import Any, Callable, Dict, Iterable, List, Optional, Sequence, Tuple, TypeVar

from sqlalchemy import delete, func, or_, select
from sqlalchemy.orm import Session

from app.config import settings
from app.logging_db import setup_logging
from app.db.models import (
    GrowattEnvReading,
    GrowattEnvSensor,
    GrowattInverter,
    GrowattInverterReading,
    GrowattMeter,
    GrowattMeterReading,
    GrowattPlant,
    GrowattStringReading,
)
from app.db.session import SessionLocal, ensure_schema
from solar_core.growatt import GrowattAPIError, GrowattClient, parse_env_records, parse_max_records, parse_meter_records

RATE_LIMIT_CODE = 10012

log = logging.getLogger("growatt_sync")

_BATCH = 2000


def _upsert(db: Session, model, rows: Sequence[Dict[str, Any]], update_cols: Optional[Iterable[str]] = None) -> None:
    """Dialect-aware INSERT .. ON CONFLICT on the model's primary key (SQLite / PostgreSQL)."""
    if not rows:
        return
    dialect = db.get_bind().dialect.name
    if dialect == "postgresql":
        from sqlalchemy.dialects.postgresql import insert
    else:
        from sqlalchemy.dialects.sqlite import insert
    pk = [c.name for c in model.__table__.primary_key.columns]
    for i in range(0, len(rows), _BATCH):
        stmt = insert(model).values(list(rows[i : i + _BATCH]))
        cols = list(update_cols) if update_cols is not None else [c for c in rows[0] if c not in pk]
        if cols:
            stmt = stmt.on_conflict_do_update(index_elements=pk, set_={c: stmt.excluded[c] for c in cols})
        else:
            stmt = stmt.on_conflict_do_nothing(index_elements=pk)
        db.execute(stmt)


def _fnum(v: Any) -> Optional[float]:
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


# Fleet bounding box (Thailand). Growatt returns some plants with lat/lon swapped.
_LAT_RANGE = (5.0, 21.0)
_LON_RANGE = (97.0, 106.0)


def normalize_coords(lat: Any, lon: Any) -> Tuple[Optional[float], Optional[float]]:
    """(lat, lon) as floats, swapped back when Growatt reported them reversed.

    A pair that fits the fleet area neither way round is dropped (None, None) rather than guessed.
    """
    la, lo = _fnum(lat), _fnum(lon)
    if la is None or lo is None:
        return None, None

    def fits(a: float, b: float) -> bool:
        return _LAT_RANGE[0] <= a <= _LAT_RANGE[1] and _LON_RANGE[0] <= b <= _LON_RANGE[1]

    if fits(la, lo):
        return la, lo
    if fits(lo, la):
        return lo, la
    return None, None


def _coords_row(p: Dict[str, Any]) -> Dict[str, Optional[float]]:
    lat, lon = normalize_coords(p.get("latitude"), p.get("longitude"))
    return {"latitude": lat, "longitude": lon}


T = TypeVar("T")


def _retry(fn: Callable[[], T], label: str, retries: int = 3) -> T:
    """Call `fn()`, retrying Growatt errors; 10012 (per-endpoint rate limit) waits minutes."""
    attempt = 0
    while True:
        try:
            return fn()
        except GrowattAPIError as exc:
            if attempt >= retries:
                raise
            # 10012's window is minutes, so short retries just fail again
            wait = min(60 * (attempt + 1), 120) if exc.error_code == RATE_LIMIT_CODE else 5 * (attempt + 1)
            log.warning("%s: %s — retry in %ss", label, exc, wait)
            time.sleep(wait)
            attempt += 1


def sync_fleet(
    db: Session, client: GrowattClient, pause_s: float = 0.5, phase: Optional[int] = None
) -> List[GrowattInverter]:
    """Upsert the plants and inverters of one Growatt account. Returns that account's inverters.

    `phase` tags each listed plant with the account's project phase (None keeps the stored tag).
    """
    now = datetime.now().astimezone()
    plants = _retry(lambda: client.list_plants(refresh=True), f"phase {phase} plant/list")
    _upsert(
        db,
        GrowattPlant,
        [
            {
                "plant_id": int(p["plant_id"]),
                "name": p.get("name") or str(p["plant_id"]),
                "city": p.get("city"),
                "country": p.get("country"),
                **_coords_row(p),
                "peak_power_kwp": _fnum(p.get("peak_power")),
                # current power / total energy / status are realtime: served live, never stored
                "create_date": p.get("create_date"),
                "synced_at": now,
                **({"phase": phase} if phase is not None else {}),
            }
            for p in plants
        ],
    )
    db.commit()
    log.info("phase %s plants: %d", phase, len(plants))

    for p in plants:
        pid = int(p["plant_id"])
        invs = _retry(lambda: client.list_inverters(pid, refresh=True), f"plant {pid} device/list")
        _upsert(
            db,
            GrowattInverter,
            [
                {
                    "device_sn": inv["device_sn"],
                    "plant_id": pid,
                    "datalogger_sn": inv["datalogger_sn"],
                    "model": inv["model"],
                    "device_types": ",".join(inv["device_types"]),
                    # status / lost / last_update_time are realtime: served live, never stored
                    "synced_at": now,
                }
                for inv in invs
            ],
        )
        db.commit()
        log.info("plant %s: %d inverters", pid, len(invs))
        try:
            n_env = sync_env_sensors(db, client, pid, now)
            if n_env:
                log.info("plant %s: %d weather sensors", pid, n_env)
        except Exception as exc:  # weather discovery must not break the inverter registry
            db.rollback()
            log.error("plant %s weather-sensor discovery failed: %s", pid, exc)
        try:
            n_meter = sync_meters(db, client, pid, now)
            if n_meter:
                log.debug("plant %s: %d meters", pid, n_meter)
        except Exception as exc:  # meter discovery must not break the inverter registry
            db.rollback()
            log.error("plant %s meter discovery failed: %s", pid, exc)
        time.sleep(pause_s)
    pids = [int(p["plant_id"]) for p in plants]
    try:
        n_info = _sync_inverter_info(db, client, pids, now, pause_s)
        log.info("phase %s: inverter info/settings read for %d inverters", phase, n_info)
    except Exception as exc:  # never break the registry over it
        db.rollback()
        log.error("phase %s inverter info sweep failed: %s", phase, exc)
    for label, sweep in (
        ("plant details", _sync_plant_details),
        ("inverter model", _sync_device_params),
        ("inverter creation date", _sync_create_dates),
        ("inverter datalogger", _sync_missing_dataloggers),
    ):
        try:
            n = sweep(db, client, pids, now, pause_s)
            log.info("phase %s: %s read for %d", phase, label, n)
        except Exception as exc:  # never break the registry over it
            db.rollback()
            log.error("phase %s %s sweep failed: %s", phase, label, exc)
    return list(
        db.scalars(
            select(GrowattInverter)
            .where(GrowattInverter.plant_id.in_(pids))
            .order_by(GrowattInverter.plant_id, GrowattInverter.device_sn)
        )
    )


INFO_REFRESH_HOURS = 20  # settings (power limit, on/off) can change: re-read on each daily fleet run


INFO_MAX_RATE_LIMITED = 3  # 10012s in a row from queryDeviceInfo (after max_data_info refused) end the sweep


def _sync_inverter_info(
    db: Session, client: GrowattClient, plant_ids: Sequence[int], now: datetime, pause_s: float = 0.5
) -> int:
    """Read name, rating, firmware and settings of the plants' inverters that were never read or
    were read more than INFO_REFRESH_HOURS ago, oldest first.

    `max_data_info` is tightly rate limited (about one call per account every few minutes). At
    its first 10012 the sweep goes on with `new-api/queryDeviceInfo`, which answers the same
    fields (`GrowattClient.device_info`); INFO_MAX_RATE_LIMITED 10012s in a row from that one end
    the sweep (the rest are read on the next run, still oldest first). Any other failure skips
    that inverter.
    """
    now = now.astimezone(timezone.utc)  # bookkeeping is UTC (SQLite drops tzinfo; read back as UTC)
    cutoff = now - timedelta(hours=INFO_REFRESH_HOURS)
    done = 0
    fallback = False  # max_data_info refused: the rest of this sweep reads queryDeviceInfo
    in_a_row = 0

    def read(sn: str) -> Dict[str, Any]:
        nonlocal fallback
        if not fallback:
            try:
                return client.max_info(sn)
            except GrowattAPIError as exc:
                if exc.error_code != RATE_LIMIT_CODE:
                    raise
                fallback = True
                log.info("max_data_info rate limited after %d inverters; continuing with queryDeviceInfo", done)
        return client.device_info(sn)

    invs = db.scalars(
        select(GrowattInverter)
        .where(GrowattInverter.plant_id.in_(plant_ids))
        .order_by(GrowattInverter.info_synced_at.is_not(None), GrowattInverter.info_synced_at, GrowattInverter.device_sn)
    )
    for inv in list(invs):
        last = inv.info_synced_at
        if last is not None and (last if last.tzinfo else last.replace(tzinfo=timezone.utc)) > cutoff:
            continue
        try:
            info = read(inv.device_sn)
        except GrowattAPIError as exc:
            if exc.error_code == RATE_LIMIT_CODE:
                in_a_row += 1
                if in_a_row >= INFO_MAX_RATE_LIMITED:
                    log.warning("inverter info rate limited after %d inverters; the rest wait for the next run", done)
                    break
                time.sleep(pause_s)
                continue
            in_a_row = 0
            log.warning("inverter %s info failed: %s", inv.device_sn, exc)
            continue
        except Exception as exc:
            in_a_row = 0
            log.warning("inverter %s info failed: %s", inv.device_sn, exc)
            continue
        in_a_row = 0
        if all(v is None for v in info.values()):  # answered without data: try again next run
            log.warning("inverter %s info returned no data", inv.device_sn)
            continue
        for k, v in info.items():
            setattr(inv, k, v)
        inv.info_synced_at = now
        db.commit()
        done += 1
        time.sleep(pause_s)
    return done


DETAILS_REFRESH_DAYS = 7  # plant/details: static, rarely edited in Growatt
PARAM_REFRESH_DAYS = 30  # queryDeviceInfoParam: the model does not change
REGISTRY_MAX_RATE_LIMITED = 3


def _due(last: Optional[datetime], cutoff: datetime) -> bool:
    return last is None or (last if last.tzinfo else last.replace(tzinfo=timezone.utc)) <= cutoff


def _registry_sweep(
    db: Session,
    rows: Sequence[Any],
    read: Callable[[Any], Dict[str, Any]],
    stamp: str,
    label: str,
    now: datetime,
    pause_s: float,
) -> int:
    """Read `read(row)` for each due row (never read / oldest first), set its fields and `stamp`.
    REGISTRY_MAX_RATE_LIMITED 10012s in a row end the sweep; other refusals skip the row."""
    done = 0
    in_a_row = 0
    asked = 0
    for row in rows:
        if asked:
            time.sleep(pause_s)
        asked += 1
        try:
            fields = read(row)
        except GrowattAPIError as exc:
            if exc.error_code == RATE_LIMIT_CODE:
                in_a_row += 1
                if in_a_row >= REGISTRY_MAX_RATE_LIMITED:
                    log.warning("%s rate limited after %d reads; the rest wait for the next run", label, done)
                    break
                continue
            in_a_row = 0
            log.debug("%s failed: %s", label, exc)
            continue
        except Exception as exc:
            in_a_row = 0
            log.warning("%s failed: %s", label, exc)
            continue
        in_a_row = 0
        for k, v in fields.items():
            if v is not None:  # a blank answer never erases a value read before
                setattr(row, k, v)
        setattr(row, stamp, now)
        db.commit()
        done += 1
    return done


def _sync_plant_details(
    db: Session, client: GrowattClient, plant_ids: Sequence[int], now: datetime, pause_s: float = 0.5
) -> int:
    """`plant/details` (time zone, address, Growatt's inverter / datalogger counts) for the plants
    never read or read more than DETAILS_REFRESH_DAYS ago, oldest first."""
    now = now.astimezone(timezone.utc)
    cutoff = now - timedelta(days=DETAILS_REFRESH_DAYS)
    plants = [
        p
        for p in db.scalars(
            select(GrowattPlant)
            .where(GrowattPlant.plant_id.in_(plant_ids))
            .order_by(GrowattPlant.details_synced_at.is_not(None), GrowattPlant.details_synced_at, GrowattPlant.plant_id)
        )
        if _due(p.details_synced_at, cutoff)
    ]
    return _registry_sweep(
        db, plants, lambda p: client.plant_details(p.plant_id), "details_synced_at", "plant/details", now, pause_s
    )


def _sync_device_params(
    db: Session, client: GrowattClient, plant_ids: Sequence[int], now: datetime, pause_s: float = 0.5
) -> int:
    """`queryDeviceInfoParam` (model text, datalogger model, rated power) for the inverters never
    read or read more than PARAM_REFRESH_DAYS ago, oldest first."""
    now = now.astimezone(timezone.utc)
    cutoff = now - timedelta(days=PARAM_REFRESH_DAYS)
    invs = [
        i
        for i in db.scalars(
            select(GrowattInverter)
            .where(GrowattInverter.plant_id.in_(plant_ids))
            .order_by(GrowattInverter.param_synced_at.is_not(None), GrowattInverter.param_synced_at, GrowattInverter.device_sn)
        )
        if _due(i.param_synced_at, cutoff)
    ]
    return _registry_sweep(
        db, invs, lambda i: client.device_info_param(i.device_sn), "param_synced_at", "queryDeviceInfoParam", now, pause_s
    )


CREATE_DATE_CHUNK = 50  # serials per `device/all/create_date` call


def _sync_create_dates(
    db: Session, client: GrowattClient, plant_ids: Sequence[int], now: datetime, pause_s: float = 0.5
) -> int:
    """`device/all/create_date` (when Growatt registered the device) for the inverters that have
    none yet, CREATE_DATE_CHUNK serials per call. The date never changes, so an inverter is read
    once; one Growatt does not answer is asked again on the next run. REGISTRY_MAX_RATE_LIMITED
    10012s in a row end the sweep."""
    invs = list(
        db.scalars(
            select(GrowattInverter)
            .where(GrowattInverter.plant_id.in_(plant_ids), GrowattInverter.growatt_created_at.is_(None))
            .order_by(GrowattInverter.device_sn)
        )
    )
    done = 0
    in_a_row = 0
    for i in range(0, len(invs), CREATE_DATE_CHUNK):
        chunk = invs[i : i + CREATE_DATE_CHUNK]
        if i:
            time.sleep(pause_s)
        try:
            created = client.devices_create_time([inv.device_sn for inv in chunk])
        except GrowattAPIError as exc:
            if exc.error_code == RATE_LIMIT_CODE:
                in_a_row += 1
                if in_a_row >= REGISTRY_MAX_RATE_LIMITED:
                    log.warning("device/all/create_date rate limited after %d inverters; the rest wait for the next run", done)
                    break
                continue
            in_a_row = 0
            log.warning("device/all/create_date failed: %s", exc)
            continue
        in_a_row = 0
        for inv in chunk:
            at = created.get(inv.device_sn)
            if at is not None:
                inv.growatt_created_at = at
                done += 1
        db.commit()
    missing = [inv for inv in invs if inv.growatt_created_at is None]
    if missing:  # the account's own device list carries the same date (`new-api/queryDeviceList`)
        try:
            listed = client.account_create_times()
        except Exception as exc:
            log.warning("queryDeviceList failed: %s", exc)
            listed = {}
        for inv in missing:
            at = listed.get(inv.device_sn)
            if at is not None:
                inv.growatt_created_at = at
                done += 1
        db.commit()
    return done


def _sync_missing_dataloggers(
    db: Session, client: GrowattClient, plant_ids: Sequence[int], now: datetime, pause_s: float = 0.5
) -> int:
    """`device/sn_datalog` for the inverters `device/list` named no datalogger for (the live
    datalogger status and the meter / sensor lookups go by that serial). Usually none."""
    invs = db.scalars(
        select(GrowattInverter)
        .where(GrowattInverter.plant_id.in_(plant_ids), or_(GrowattInverter.datalogger_sn.is_(None), GrowattInverter.datalogger_sn == ""))
        .order_by(GrowattInverter.device_sn)
    )
    return _registry_sweep(
        db, list(invs), lambda i: {"datalogger_sn": client.device_datalogger(i.device_sn)}, "synced_at", "device/sn_datalog", now, pause_s
    )


POWER_LIMIT_REFRESH_HOURS = 20  # one read per inverter per day (the job runs daily)
POWER_LIMIT_PAUSE_S = 2.0  # between calls: a full account at this pace hit no 10012 (15 Nov 2026)


def sync_power_limits(
    db: Session,
    client: GrowattClient,
    phase: Optional[int] = None,
    include_untagged: bool = False,
    now: Optional[datetime] = None,
    pause_s: float = POWER_LIMIT_PAUSE_S,
    max_rate_limited: int = 3,
) -> Dict[str, Any]:
    """Read each inverter's active power limit (`readPower`) and store it as `power_limit_pct`.

    Inverters never read / read longest ago first, skipping ones read within
    POWER_LIMIT_REFRESH_HOURS. The read goes through the datalogger to the inverter, so it runs
    in daylight; refusals (offline inverter, a datalogger that doesn't pass it on: about 1 in 5)
    leave the stored value and its `power_limit_read_at` as they were, never write a default.
    `max_rate_limited` 10012s in a row end the sweep (the run is `partial`).
    """
    now = (now or datetime.now(timezone.utc)).astimezone(timezone.utc)
    cutoff = now - timedelta(hours=POWER_LIMIT_REFRESH_HOURS)
    q = _inverters_query(phase, include_untagged).order_by(None).order_by(
        GrowattInverter.power_limit_read_at.is_not(None), GrowattInverter.power_limit_read_at, GrowattInverter.device_sn
    )
    out: Dict[str, Any] = {"power_limits_read": 0, "power_limited": 0, "power_limit_unreadable": 0, "failed": []}
    errors: Dict[str, int] = {}
    in_a_row = 0
    asked = 0
    for inv in list(db.scalars(q)):
        last = inv.power_limit_read_at
        if last is not None and (last if last.tzinfo else last.replace(tzinfo=timezone.utc)) > cutoff:
            continue
        if asked:
            time.sleep(pause_s)
        asked += 1
        try:
            pct = client.read_power(inv.device_sn)
        except GrowattAPIError as exc:
            if exc.error_code == RATE_LIMIT_CODE:
                in_a_row += 1
                if in_a_row >= max_rate_limited:
                    log.warning("readPower rate limited %d times in a row; the rest wait for the next run", in_a_row)
                    out["failed"].append(f"phase {phase}: readPower rate limited")
                    break
                continue
            in_a_row = 0
            out["power_limit_unreadable"] += 1
            key = str(exc.error_code)
            errors[key] = errors.get(key, 0) + 1
            log.debug("inverter %s readPower refused: %s", inv.device_sn, exc)
            continue
        except Exception as exc:  # network etc.: skip this inverter
            in_a_row = 0
            out["power_limit_unreadable"] += 1
            errors["error"] = errors.get("error", 0) + 1
            log.warning("inverter %s readPower failed: %s", inv.device_sn, exc)
            continue
        in_a_row = 0
        # a change of a known limit is worth a line; the first read of each inverter is not
        if inv.power_limit_pct is not None and inv.power_limit_pct != pct:
            log.info("inverter %s power limit %s -> %s %%", inv.device_sn, inv.power_limit_pct, pct)
        inv.power_limit_pct = pct
        inv.power_limit_read_at = now
        db.commit()
        out["power_limits_read"] += 1
        if pct < 100:
            out["power_limited"] += 1
    out["power_limit_errors"] = errors
    log.info(
        "phase %s readPower: %d read (%d below 100 %%), %d refused %s",
        phase, out["power_limits_read"], out["power_limited"], out["power_limit_unreadable"], errors,
    )
    return out


def sync_env_sensors(db: Session, client: GrowattClient, plant_id: int, now: Optional[datetime] = None) -> int:
    """Register the plant's weather sensors. Returns how many were found.

    device/list shows a weather sensor as a type-3 device with `device_sn` "env" (the same
    for every sensor); `env_list` on that datalogger gives each sensor's bus address.
    `list_devices` is served from the client cache filled by the `list_inverters` call before.
    """
    dataloggers = sorted(
        {
            str(d.get("datalogger_sn"))
            for d in client.list_devices(plant_id)
            if d.get("type") == 3 and str(d.get("device_sn") or "").lower() == "env" and d.get("datalogger_sn")
        }
    )
    rows: List[Dict[str, Any]] = []
    for dl in dataloggers:
        for e in _retry(lambda: client.list_env_sensors(dl, refresh=True), f"{dl} env_list"):
            try:
                addr = int(str(e.get("address")))
            except ValueError:
                continue
            rows.append(
                {
                    "datalogger_sn": dl,
                    "address": addr,
                    "plant_id": plant_id,
                    "device_name": e.get("device_name"),
                    # lost / lastUpdateTime are realtime: never stored
                    "synced_at": now or datetime.now().astimezone(),
                }
            )
    _upsert(db, GrowattEnvSensor, rows)
    db.commit()
    return len(rows)


def _env_sensors_query(phase: Optional[int], include_untagged: bool):
    q = select(GrowattEnvSensor).order_by(GrowattEnvSensor.plant_id, GrowattEnvSensor.datalogger_sn, GrowattEnvSensor.address)
    if phase is None:
        return q
    cond = GrowattPlant.phase == phase
    if include_untagged:
        cond = or_(cond, GrowattPlant.phase.is_(None))
    return q.join(GrowattPlant, GrowattPlant.plant_id == GrowattEnvSensor.plant_id).where(cond)


def sync_env_history(
    db: Session,
    client: GrowattClient,
    sensor: GrowattEnvSensor,
    start: date,
    end: date,
    retries: int = 3,
    stop_before: Optional[datetime] = None,
) -> int:
    """Fetch and upsert weather history for one sensor. Returns rows written."""
    n = 0
    for a, b in _date_chunks(start, end):
        records = _retry(
            lambda: client.env_history(sensor.datalogger_sn, sensor.address, a, b, stop_before=stop_before),
            f"env {sensor.datalogger_sn}/{sensor.address} {a}..{b}",
            retries,
        )
        rows = parse_env_records(sensor.datalogger_sn, sensor.address, records)
        _upsert(db, GrowattEnvReading, rows)
        n += len(rows)
    latest = db.scalar(
        select(func.max(GrowattEnvReading.timestamp)).where(
            GrowattEnvReading.datalogger_sn == sensor.datalogger_sn, GrowattEnvReading.address == sensor.address
        )
    )
    sensor.history_synced_until = latest
    db.commit()
    return n


# Consecutive 10012 answers that end a sweep with `max_rate_limited` (the `env_history` job): the
# rest wait for the next run, which starts with the sensors stored longest ago.
MAX_RATE_LIMITED = 3


def _sync_envs(
    db: Session,
    client: GrowattClient,
    sensors: Sequence[GrowattEnvSensor],
    window,
    pause_s: float,
    retries: int = 3,
    max_rate_limited: Optional[int] = None,
) -> Dict[str, Any]:
    totals: Dict[str, Any] = {"env_sensors": len(sensors), "env_rows": 0, "env_failed": []}
    limited = 0
    for idx, sensor in enumerate(sensors):
        start, end, stop_before = window(sensor)
        try:
            totals["env_rows"] += sync_env_history(db, client, sensor, start, end, retries=retries, stop_before=stop_before)
            limited = 0
        except Exception as exc:  # keep going; report at the end
            db.rollback()
            totals["env_failed"].append((f"{sensor.datalogger_sn}/{sensor.address}", str(exc)))
            log.error("env %s/%s sync failed: %s", sensor.datalogger_sn, sensor.address, exc)
            if max_rate_limited and isinstance(exc, GrowattAPIError) and exc.error_code == RATE_LIMIT_CODE:
                limited += 1
                if limited >= max_rate_limited:
                    left = len(sensors) - idx - 1
                    totals["env_failed"].append(("rate limited", f"{left} sensors left for the next run"))
                    log.warning("env_data rate limited; %d sensors wait for the next run", left)
                    break
        time.sleep(pause_s)
    return totals


def sync_env_all(
    db: Session,
    client: GrowattClient,
    start: date,
    end: date,
    pause_s: float = 0.3,
    phase: Optional[int] = None,
    include_untagged: bool = False,
) -> Dict[str, Any]:
    """Weather history for every sensor (of one phase) over a fixed date range."""
    sensors = list(db.scalars(_env_sensors_query(phase, include_untagged)))
    return _sync_envs(db, client, sensors, lambda _s: (start, end, None), pause_s)


def sync_env_incremental(
    db: Session,
    client: GrowattClient,
    today: date,
    overlap: timedelta = timedelta(minutes=30),
    max_back_days: int = 7,
    pause_s: float = 0.3,
    phase: Optional[int] = None,
    include_untagged: bool = False,
    retries: int = 3,
    max_rate_limited: Optional[int] = None,
) -> Dict[str, Any]:
    """Weather records new since each sensor's `history_synced_until` (same rules as inverters).

    Sensors go never-synced / stored-longest-ago first, so a sweep cut short by `max_rate_limited`
    consecutive 10012s (with `retries=0`, the `env_history` job) continues where it lagged most."""
    floor = datetime.combine(today - timedelta(days=max_back_days), datetime.min.time())

    def window(s: GrowattEnvSensor):
        since = (s.history_synced_until - overlap) if s.history_synced_until else datetime.combine(
            today - timedelta(days=1), datetime.min.time()
        )
        since = max(since, floor)
        return since.date(), today, since

    sensors = sorted(
        db.scalars(_env_sensors_query(phase, include_untagged)),
        key=lambda s: (s.history_synced_until is not None, s.history_synced_until or datetime.min),
    )
    return _sync_envs(db, client, sensors, window, pause_s, retries=retries, max_rate_limited=max_rate_limited)


# --------------------------------------------------------------------------- energy meters


def sync_meters(db: Session, client: GrowattClient, plant_id: int, now: Optional[datetime] = None) -> int:
    """Register the plant's energy meters (type-3 devices named "meter"; `meter_list` on the
    datalogger gives each one's bus address). Returns how many were found."""
    dataloggers = sorted(
        {
            str(d.get("datalogger_sn"))
            for d in client.list_devices(plant_id)
            if d.get("type") == 3 and str(d.get("device_sn") or "").lower() == "meter" and d.get("datalogger_sn")
        }
    )
    rows: List[Dict[str, Any]] = []
    for dl in dataloggers:
        for m in _retry(lambda: client.list_meters(dl, refresh=True), f"{dl} meter_list"):
            try:
                addr = int(str(m.get("address")))
            except ValueError:
                continue
            rows.append(
                {
                    "datalogger_sn": dl,
                    "address": addr,
                    "plant_id": plant_id,
                    "device_name": m.get("device_name"),
                    "device_type": str(m.get("device_type")) if m.get("device_type") not in (None, "") else None,
                    # lost / lastUpdateTime are realtime: never stored
                    "synced_at": now or datetime.now().astimezone(),
                }
            )
    _upsert(db, GrowattMeter, rows)
    db.commit()
    return len(rows)


def _meters_query(phase: Optional[int], include_untagged: bool):
    q = select(GrowattMeter).order_by(GrowattMeter.plant_id, GrowattMeter.datalogger_sn, GrowattMeter.address)
    if phase is None:
        return q
    cond = GrowattPlant.phase == phase
    if include_untagged:
        cond = or_(cond, GrowattPlant.phase.is_(None))
    return q.join(GrowattPlant, GrowattPlant.plant_id == GrowattMeter.plant_id).where(cond)


def sync_meter_history(
    db: Session,
    client: GrowattClient,
    meter: GrowattMeter,
    start: date,
    end: date,
    retries: int = 3,
    stop_before: Optional[datetime] = None,
) -> int:
    """Fetch and upsert one meter's history. Returns rows written."""
    n = 0
    for a, b in _date_chunks(start, end):
        records = _retry(
            lambda: client.meter_history(meter.datalogger_sn, meter.address, a, b, stop_before=stop_before),
            f"meter {meter.datalogger_sn}/{meter.address} {a}..{b}",
            retries,
        )
        rows = parse_meter_records(meter.datalogger_sn, meter.address, records)
        _upsert(db, GrowattMeterReading, rows)
        n += len(rows)
    latest = db.scalar(
        select(func.max(GrowattMeterReading.timestamp)).where(
            GrowattMeterReading.datalogger_sn == meter.datalogger_sn, GrowattMeterReading.address == meter.address
        )
    )
    meter.history_synced_until = latest
    db.commit()
    return n


def _sync_meter_list(
    db: Session,
    client: GrowattClient,
    meters: Sequence[GrowattMeter],
    window,
    pause_s: float,
    retries: int = 3,
    max_rate_limited: Optional[int] = MAX_RATE_LIMITED,
) -> Dict[str, Any]:
    """Like `_sync_envs`: 3 rate-limited meters in a row end the sweep (the rest wait for the
    next run, which starts with the meters stored longest ago), so meters never starve the
    inverter history of the same account."""
    totals: Dict[str, Any] = {"meters": len(meters), "meter_rows": 0, "meter_failed": []}
    limited = 0
    for idx, meter in enumerate(meters):
        start, end, stop_before = window(meter)
        try:
            totals["meter_rows"] += sync_meter_history(db, client, meter, start, end, retries=retries, stop_before=stop_before)
            limited = 0
        except Exception as exc:  # keep going; report at the end
            db.rollback()
            totals["meter_failed"].append((f"{meter.datalogger_sn}/{meter.address}", str(exc)))
            log.error("meter %s/%s sync failed: %s", meter.datalogger_sn, meter.address, exc)
            if max_rate_limited and isinstance(exc, GrowattAPIError) and exc.error_code == RATE_LIMIT_CODE:
                limited += 1
                if limited >= max_rate_limited:
                    left = len(meters) - idx - 1
                    totals["meter_failed"].append(("rate limited", f"{left} meters left for the next run"))
                    log.warning("meter_data rate limited; %d meters wait for the next run", left)
                    break
        time.sleep(pause_s)
    return totals


def sync_meter_all(
    db: Session,
    client: GrowattClient,
    start: date,
    end: date,
    pause_s: float = 0.3,
    phase: Optional[int] = None,
    include_untagged: bool = False,
) -> Dict[str, Any]:
    """Meter history for every meter (of one phase) over a fixed date range."""
    if not settings.meter_history_enabled:
        return {}
    meters = list(db.scalars(_meters_query(phase, include_untagged)))
    return _sync_meter_list(db, client, meters, lambda _m: (start, end, None), pause_s)


def sync_meter_incremental(
    db: Session,
    client: GrowattClient,
    today: date,
    overlap: timedelta = timedelta(minutes=30),
    max_back_days: int = 7,
    pause_s: float = 0.3,
    phase: Optional[int] = None,
    include_untagged: bool = False,
) -> Dict[str, Any]:
    """Meter records new since each meter's `history_synced_until` (same rules as sensors)."""
    if not settings.meter_history_enabled:
        return {}
    floor = datetime.combine(today - timedelta(days=max_back_days), datetime.min.time())

    def window(m: GrowattMeter):
        since = (m.history_synced_until - overlap) if m.history_synced_until else datetime.combine(
            today - timedelta(days=1), datetime.min.time()
        )
        since = max(since, floor)
        return since.date(), today, since

    meters = sorted(
        db.scalars(_meters_query(phase, include_untagged)),
        key=lambda m: (m.history_synced_until is not None, m.history_synced_until or datetime.min),
    )
    return _sync_meter_list(db, client, meters, window, pause_s)


def _inverters_query(phase: Optional[int], include_untagged: bool):
    """Inverters ordered by plant; restricted to one phase's plants when `phase` is given.

    `include_untagged` also takes plants with no phase yet (they default to the first account).
    """
    q = select(GrowattInverter).order_by(GrowattInverter.plant_id, GrowattInverter.device_sn)
    if phase is None:
        return q
    cond = GrowattPlant.phase == phase
    if include_untagged:
        cond = or_(cond, GrowattPlant.phase.is_(None))
    return q.join(GrowattPlant, GrowattPlant.plant_id == GrowattInverter.plant_id).where(cond)


def _date_chunks(start: date, end: date, days: int = 7) -> Iterable[tuple[date, date]]:
    cur = start
    while cur <= end:
        stop = min(cur + timedelta(days=days - 1), end)
        yield cur, stop
        cur = stop + timedelta(days=1)


def sync_inverter_history(
    db: Session,
    client: GrowattClient,
    inverter: GrowattInverter,
    start: date,
    end: date,
    retries: int = 3,
    stop_before: Optional[datetime] = None,
) -> tuple[int, int]:
    """Fetch and upsert MAX history for one inverter. Returns (inverter_rows, string_rows)."""
    n_inv = n_str = 0
    for a, b in _date_chunks(start, end):
        records: List[Dict[str, Any]] = _retry(
            lambda: client.max_history(inverter.device_sn, a, b, stop_before=stop_before),
            f"{inverter.device_sn} {a}..{b}",
            retries,
        )
        inv_rows, str_rows = parse_max_records(inverter.device_sn, records)
        _upsert(db, GrowattInverterReading, inv_rows)
        _upsert(db, GrowattStringReading, str_rows)
        n_inv += len(inv_rows)
        n_str += len(str_rows)
    latest = db.scalar(
        # primary-key order, so Postgres does not walk ix_growatt_inv_ts for an idle inverter
        select(GrowattInverterReading.timestamp)
        .where(GrowattInverterReading.device_sn == inverter.device_sn)
        .order_by(GrowattInverterReading.device_sn.desc(), GrowattInverterReading.timestamp.desc())
        .limit(1)
    )
    inverter.history_synced_until = latest
    db.commit()
    return n_inv, n_str


def sync_all_history(
    db: Session,
    client: GrowattClient,
    start: date,
    end: date,
    device_sns: Optional[Sequence[str]] = None,
    pause_s: float = 0.3,
    phase: Optional[int] = None,
    include_untagged: bool = False,
) -> Dict[str, Any]:
    q = _inverters_query(phase, include_untagged)
    if device_sns:
        q = q.where(GrowattInverter.device_sn.in_(device_sns))
    inverters = list(db.scalars(q))
    totals = {"inverters": len(inverters), "inverter_rows": 0, "string_rows": 0, "failed": []}
    for idx, inv in enumerate(inverters, 1):
        try:
            n_inv, n_str = sync_inverter_history(db, client, inv, start, end)
            totals["inverter_rows"] += n_inv
            totals["string_rows"] += n_str
            # DEBUG: 629 lines per run would be ~30 k rows/day in app_logs; the phase summary stays INFO
            log.debug("[%d/%d] %s (plant %s): %d records, %d string rows", idx, len(inverters), inv.device_sn, inv.plant_id, n_inv, n_str)
        except Exception as exc:  # keep going; report at the end
            db.rollback()
            totals["failed"].append((inv.device_sn, str(exc)))
            log.error("[%d/%d] %s failed: %s", idx, len(inverters), inv.device_sn, exc)
        time.sleep(pause_s)
    return totals


def sync_incremental(
    db: Session,
    client: GrowattClient,
    today: date,
    overlap: timedelta = timedelta(minutes=30),
    max_back_days: int = 7,
    pause_s: float = 0.3,
    phase: Optional[int] = None,
    include_untagged: bool = False,
    batch_size: int = 0,
) -> Dict[str, Any]:
    """Fetch only what is new for each inverter since its `history_synced_until`.

    The overlap re-reads the last half hour (Growatt uploads arrive late); upserts make the
    overlap free. Inverters never synced start yesterday; long-offline ones look back at
    most `max_back_days` (older gaps are for the `--start/--end` backfill).

    `batch_size` > 0: inverters already holding a record of today are first read `batch_size`
    per call (`_sync_today_batched`); the others, and any the batch did not cover, get their own
    `max_data` call as before (`batch_calls` / `batch_inverters` / `batch_fallback` /
    `batch_errors` in the totals). An inverter whose `max_data` call fails is tried once more
    through `new-api/queryHistoricalData` (`_sync_today_single`, `day_fallback` in the totals)
    before it counts as failed.
    """
    floor = datetime.combine(today - timedelta(days=max_back_days), datetime.min.time())
    inverters = list(db.scalars(_inverters_query(phase, include_untagged)))
    totals: Dict[str, Any] = {"inverters": len(inverters), "inverter_rows": 0, "string_rows": 0, "failed": [], "day_fallback": 0}
    if batch_size > 0:
        done = _sync_today_batched(db, client, inverters, today, overlap, batch_size, pause_s, totals)
        inverters = [inv for inv in inverters if inv.device_sn not in done]
    for inv in inverters:
        since = (inv.history_synced_until - overlap) if inv.history_synced_until else datetime.combine(
            today - timedelta(days=1), datetime.min.time()
        )
        since = max(since, floor)
        try:
            n_inv, n_str = sync_inverter_history(db, client, inv, since.date(), today, stop_before=since)
            totals["inverter_rows"] += n_inv
            totals["string_rows"] += n_str
        except Exception as exc:  # keep going; report at the end
            db.rollback()
            rows = _sync_today_single(db, client, inv, today, overlap)
            if rows is None:
                totals["failed"].append((inv.device_sn, str(exc)))
                log.error("%s incremental sync failed: %s", inv.device_sn, exc)
            else:
                totals["inverter_rows"] += rows[0]
                totals["string_rows"] += rows[1]
                totals["day_fallback"] += 1
                log.warning("%s max_data failed (%s): today read through queryHistoricalData", inv.device_sn, exc)
        time.sleep(pause_s)
    return totals


BATCH_MAX_ERRORS = 2  # refused batch calls in a row: stop batching for this run


def _store_today(
    db: Session, inv: GrowattInverter, records: Sequence[Dict[str, Any]], today: date, overlap: timedelta
) -> Optional[Tuple[int, int]]:
    """Store today's `records` of `inv` (max_data record fields) from an endpoint whose answer
    may be cut short: (inverter rows, string rows) written, or None when the answer is not
    proven complete, in which case nothing is written.

    Proof = the inverter's newest stored record is from today and the answer reaches back to it
    (that record is still on Growatt, so a complete answer includes it). Only rows inside the
    overlap window are written, like the `max_data` path."""
    stored = inv.history_synced_until
    if stored is None or stored < datetime.combine(today, datetime.min.time()):
        return None
    inv_rows, str_rows = parse_max_records(inv.device_sn, list(records))
    times = [r["timestamp"] for r in inv_rows]
    if not times or min(times) > stored:
        return None
    since = stored - overlap
    inv_rows = [r for r in inv_rows if r["timestamp"] >= since]
    str_rows = [r for r in str_rows if r["timestamp"] >= since]
    _upsert(db, GrowattInverterReading, inv_rows)
    _upsert(db, GrowattStringReading, str_rows)
    inv.history_synced_until = max(stored, max(times))
    db.commit()
    return len(inv_rows), len(str_rows)


def _sync_today_single(
    db: Session, client: GrowattClient, inv: GrowattInverter, today: date, overlap: timedelta
) -> Optional[Tuple[int, int]]:
    """Today's records of one inverter through `new-api/queryHistoricalData`, for an inverter
    `max_data` just refused. None = not used (refused too, more pages follow, or not proven
    complete): the inverter then counts as failed for this run, as before."""
    try:
        records = client.max_history_day(inv.device_sn, today)
        return None if records is None else _store_today(db, inv, records, today, overlap)
    except Exception as exc:
        db.rollback()
        log.debug("%s queryHistoricalData fallback failed: %s", inv.device_sn, exc)
        return None


def _sync_today_batched(
    db: Session,
    client: GrowattClient,
    inverters: Sequence[GrowattInverter],
    today: date,
    overlap: timedelta,
    batch_size: int,
    pause_s: float,
    totals: Dict[str, Any],
) -> set:
    """Today's new records of several inverters per call (`new-api/queryDevicesHistoricalData`).
    Returns the serials fully synced here; the caller reads the rest with `max_data`.

    Only inverters whose newest stored record is from today take part, and an answer is stored
    only when proven complete (`_store_today`). BATCH_MAX_ERRORS refused calls in a row end
    batching for this run."""
    day_start = datetime.combine(today, datetime.min.time())
    eligible = [inv for inv in inverters if inv.history_synced_until and inv.history_synced_until >= day_start]
    totals.update({"batch_calls": 0, "batch_inverters": 0, "batch_fallback": 0, "batch_errors": 0})

    def count(key: str, n: int = 1) -> None:
        totals[key] += n

    done: set = set()
    in_a_row = 0
    for i in range(0, len(eligible), batch_size):
        chunk = eligible[i : i + batch_size]
        if i:
            time.sleep(pause_s)
        count("batch_calls")
        try:
            by_sn = client.max_history_batch([inv.device_sn for inv in chunk], today)
        except GrowattAPIError as exc:
            count("batch_errors")
            in_a_row += 1
            log.warning("batch history failed for %d inverters: %s", len(chunk), exc)
            if in_a_row >= BATCH_MAX_ERRORS:
                log.warning("batch history refused %d times in a row: the rest of this run uses max_data", in_a_row)
                count("batch_fallback", len(eligible) - i)
                return done
            count("batch_fallback", len(chunk))
            continue
        in_a_row = 0
        for inv in chunk:
            try:
                rows = _store_today(db, inv, by_sn.get(inv.device_sn) or [], today, overlap)
            except Exception as exc:  # this inverter goes through max_data instead
                db.rollback()
                log.warning("%s batch history rows failed: %s", inv.device_sn, exc)
                rows = None
            if rows is None:  # not answered, or cut short
                count("batch_fallback")
                continue
            totals["inverter_rows"] += rows[0]
            totals["string_rows"] += rows[1]
            count("batch_inverters")
            done.add(inv.device_sn)
    return done


def prune_history(db: Session, today: date, keep_days: int) -> Dict[str, Any]:
    """Delete inverter/string/weather readings older than `keep_days` before `today` (plant-local).

    Deletes one day per transaction, oldest first, so a large first run never holds a huge
    lock or WAL. Postgres autovacuum then reuses the freed space, which keeps the disk at a
    steady size instead of growing forever.
    """
    if keep_days < 1:
        raise ValueError("keep_days must be >= 1")
    cutoff = datetime.combine(today - timedelta(days=keep_days), datetime.min.time())
    oldest = db.scalar(select(func.min(GrowattInverterReading.timestamp)))
    oldest_str = db.scalar(select(func.min(GrowattStringReading.timestamp)))
    oldest_env = db.scalar(select(func.min(GrowattEnvReading.timestamp)))
    oldest_meter = db.scalar(select(func.min(GrowattMeterReading.timestamp)))
    starts = [t for t in (oldest, oldest_str, oldest_env, oldest_meter) if t is not None]
    totals: Dict[str, Any] = {
        "cutoff": cutoff.isoformat(), "inverter_rows": 0, "string_rows": 0, "env_rows": 0, "meter_rows": 0, "days": 0,
    }
    if not starts:
        return totals
    day = datetime.combine(min(starts).date(), datetime.min.time())
    while day < cutoff:
        end = min(day + timedelta(days=1), cutoff)
        n_str = db.execute(
            delete(GrowattStringReading).where(GrowattStringReading.timestamp >= day, GrowattStringReading.timestamp < end)
        ).rowcount
        n_inv = db.execute(
            delete(GrowattInverterReading).where(
                GrowattInverterReading.timestamp >= day, GrowattInverterReading.timestamp < end
            )
        ).rowcount
        n_env = db.execute(
            delete(GrowattEnvReading).where(GrowattEnvReading.timestamp >= day, GrowattEnvReading.timestamp < end)
        ).rowcount
        n_meter = db.execute(
            delete(GrowattMeterReading).where(GrowattMeterReading.timestamp >= day, GrowattMeterReading.timestamp < end)
        ).rowcount
        db.commit()
        totals["meter_rows"] += n_meter or 0
        totals["env_rows"] += n_env or 0
        totals["string_rows"] += n_str or 0
        totals["inverter_rows"] += n_inv or 0
        totals["days"] += 1
        day = end
    log.info(
        "retention: deleted %d inverter / %d string / %d weather / %d meter rows before %s",
        totals["inverter_rows"], totals["string_rows"], totals["env_rows"], totals["meter_rows"], cutoff,
    )
    return totals


def main(argv: Optional[Sequence[str]] = None) -> None:
    today = date.today()
    ap = argparse.ArgumentParser(description="Sync Growatt plants, inverters and string history into the app DB")
    ap.add_argument("--start", type=date.fromisoformat, default=today - timedelta(days=1))
    ap.add_argument("--end", type=date.fromisoformat, default=today)
    ap.add_argument("--sn", action="append", help="Only these inverter serials (repeatable)")
    ap.add_argument("--fleet-only", action="store_true", help="Only sync plants and inverters")
    ap.add_argument("--skip-fleet", action="store_true", help="Use inverters already in the DB")
    ap.add_argument("--phase", type=int, action="append", help="Only these project phases / accounts (repeatable)")
    args = ap.parse_args(argv)
    setup_logging("cli")

    accounts = settings.growatt_accounts()
    if not accounts:
        raise SystemExit("No Growatt token configured (GROWATT_TOKEN_PHASE1..4 or GROWATT_API_TOKEN)")
    first = min(accounts)
    phases = [p for p in sorted(accounts) if not args.phase or p in args.phase]
    with SessionLocal() as db:
        ensure_schema(db.get_bind())
        for phase in phases:
            client = GrowattClient(token=accounts[phase], base_url=settings.growatt_base_url, timeout=60)
            if not args.skip_fleet:
                sync_fleet(db, client, phase=phase)
            if args.fleet_only:
                continue
            totals = sync_all_history(
                db, client, args.start, args.end, device_sns=args.sn, phase=phase, include_untagged=phase == first
            )
            log.info(
                "phase %s done %s..%s: %d inverters, %d inverter records, %d string rows, %d failed",
                phase, args.start, args.end, totals["inverters"], totals["inverter_rows"], totals["string_rows"],
                len(totals["failed"]),
            )
            for sn, err in totals["failed"]:
                log.info("  failed %s: %s", sn, err)
            if args.sn:  # inverter-only run
                continue
            env = sync_env_all(db, client, args.start, args.end, phase=phase, include_untagged=phase == first)
            log.info(
                "phase %s weather: %d sensors, %d records, %d failed",
                phase, env["env_sensors"], env["env_rows"], len(env["env_failed"]),
            )


if __name__ == "__main__":
    main()
