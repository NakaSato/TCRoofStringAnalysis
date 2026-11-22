"""Fleet registry: plants, inverters and their static details (the `fleet` job)."""

from __future__ import annotations

import time
from datetime import datetime, timedelta, timezone
from typing import Any, Callable, Dict, Iterable, List, Optional, Sequence, Tuple

from sqlalchemy import delete, or_, select
from sqlalchemy.orm import Session

from app.db.models import GrowattInverter, GrowattIssue, GrowattPlant, OmTask, inverter_installed
from solar_core.growatt import GrowattAPIError, GrowattClient
from app.services.growatt_sync.common import RATE_LIMIT_CODE, _fnum, _retry, _upsert, log
from app.services.growatt_sync.env import sync_env_sensors
from app.services.growatt_sync.meters import sync_meters

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


def remove_blocked_plants(db: Session, plant_ids: Iterable[int]) -> List[int]:
    """Take the blocked plants (`GROWATT_BLOCKED_PLANT_IDS`) out of the registry. Returns the ids removed.

    Deleting the plant row cascades to its inverters, sensors, meters, their readings and the
    alarm log; its issues and planned tasks (Calendar Team) go too, so none stays without a plant. Unblocking brings
    the plant back on the next `fleet` run (history from then on, older days by backfill).
    """
    ids = sorted(set(plant_ids))
    if not ids:
        return []
    found = list(db.scalars(select(GrowattPlant.plant_id).where(GrowattPlant.plant_id.in_(ids))))
    if found:
        db.execute(delete(GrowattIssue).where(GrowattIssue.plant_id.in_(found)))
        db.execute(delete(OmTask).where(OmTask.plant_id.in_(found)))  # assignees + history cascade
        from app.services import om_plans  # local: keeps the sync package free of the calendar's imports

        om_plans.delete_plant_rows(db, found)  # plan links, per-plant planning figures
        from app.services import plant_documents

        plant_documents.delete_plant_rows(db, found)  # as-built / photo links
        db.execute(delete(GrowattPlant).where(GrowattPlant.plant_id.in_(found)))
        db.commit()
        log.info("blocked plants removed from the registry: %s", found)
    return found


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
            .where(GrowattInverter.plant_id.in_(pids), inverter_installed())
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
        .where(GrowattInverter.plant_id.in_(plant_ids), inverter_installed())
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
            .where(GrowattInverter.plant_id.in_(plant_ids), inverter_installed())
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
            .where(GrowattInverter.plant_id.in_(plant_ids), inverter_installed(), GrowattInverter.growatt_created_at.is_(None))
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
        .where(GrowattInverter.plant_id.in_(plant_ids), inverter_installed(), or_(GrowattInverter.datalogger_sn.is_(None), GrowattInverter.datalogger_sn == ""))
        .order_by(GrowattInverter.device_sn)
    )
    return _registry_sweep(
        db, list(invs), lambda i: {"datalogger_sn": client.device_datalogger(i.device_sn)}, "synced_at", "device/sn_datalog", now, pause_s
    )
