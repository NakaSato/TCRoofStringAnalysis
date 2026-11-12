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
from app.db.models import (
    GrowattEnvReading,
    GrowattEnvSensor,
    GrowattInverter,
    GrowattInverterReading,
    GrowattPlant,
    GrowattStringReading,
)
from app.db.session import SessionLocal, ensure_schema
from solar_core.growatt import GrowattAPIError, GrowattClient, parse_env_records, parse_max_records

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
        time.sleep(pause_s)
    pids = [int(p["plant_id"]) for p in plants]
    try:
        n_info = _sync_inverter_info(db, client, pids, now, pause_s)
        log.info("phase %s: inverter info/settings read for %d inverters", phase, n_info)
    except Exception as exc:  # never break the registry over it
        db.rollback()
        log.error("phase %s inverter info sweep failed: %s", phase, exc)
    return list(
        db.scalars(
            select(GrowattInverter)
            .where(GrowattInverter.plant_id.in_(pids))
            .order_by(GrowattInverter.plant_id, GrowattInverter.device_sn)
        )
    )


INFO_REFRESH_HOURS = 20  # settings (power limit, on/off) can change: re-read on each daily fleet run


def _sync_inverter_info(
    db: Session, client: GrowattClient, plant_ids: Sequence[int], now: datetime, pause_s: float = 0.5
) -> int:
    """Read name, rating, firmware and settings (`max_data_info`) of the plants' inverters that
    were never read or were read more than INFO_REFRESH_HOURS ago, oldest first.

    `max_data_info` is tightly rate limited: the first 10012 ends the sweep (the rest are read on
    the next run, still oldest first); any other failure skips that inverter.
    """
    now = now.astimezone(timezone.utc)  # bookkeeping is UTC (SQLite drops tzinfo; read back as UTC)
    cutoff = now - timedelta(hours=INFO_REFRESH_HOURS)
    done = 0
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
            info = client.max_info(inv.device_sn)
        except GrowattAPIError as exc:
            if exc.error_code == RATE_LIMIT_CODE:
                log.warning("max_data_info rate limited after %d inverters; the rest wait for the next run", done)
                break
            log.warning("inverter %s max_data_info failed: %s", inv.device_sn, exc)
            continue
        except Exception as exc:
            log.warning("inverter %s max_data_info failed: %s", inv.device_sn, exc)
            continue
        if all(v is None for v in info.values()):  # answered without a `max` block: try again next run
            log.warning("inverter %s max_data_info returned no data", inv.device_sn)
            continue
        for k, v in info.items():
            setattr(inv, k, v)
        inv.info_synced_at = now
        db.commit()
        done += 1
        time.sleep(pause_s)
    return done


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


def _sync_envs(db: Session, client: GrowattClient, sensors: Sequence[GrowattEnvSensor], window, pause_s: float) -> Dict[str, Any]:
    totals: Dict[str, Any] = {"env_sensors": len(sensors), "env_rows": 0, "env_failed": []}
    for sensor in sensors:
        start, end, stop_before = window(sensor)
        try:
            totals["env_rows"] += sync_env_history(db, client, sensor, start, end, stop_before=stop_before)
        except Exception as exc:  # keep going; report at the end
            db.rollback()
            totals["env_failed"].append((f"{sensor.datalogger_sn}/{sensor.address}", str(exc)))
            log.error("env %s/%s sync failed: %s", sensor.datalogger_sn, sensor.address, exc)
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
) -> Dict[str, Any]:
    """Weather records new since each sensor's `history_synced_until` (same rules as inverters)."""
    floor = datetime.combine(today - timedelta(days=max_back_days), datetime.min.time())

    def window(s: GrowattEnvSensor):
        since = (s.history_synced_until - overlap) if s.history_synced_until else datetime.combine(
            today - timedelta(days=1), datetime.min.time()
        )
        since = max(since, floor)
        return since.date(), today, since

    sensors = list(db.scalars(_env_sensors_query(phase, include_untagged)))
    return _sync_envs(db, client, sensors, window, pause_s)


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
        select(func.max(GrowattInverterReading.timestamp)).where(GrowattInverterReading.device_sn == inverter.device_sn)
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
            log.info("[%d/%d] %s (plant %s): %d records, %d string rows", idx, len(inverters), inv.device_sn, inv.plant_id, n_inv, n_str)
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
) -> Dict[str, Any]:
    """Fetch only what is new for each inverter since its `history_synced_until`.

    The overlap re-reads the last half hour (Growatt uploads arrive late); upserts make the
    overlap free. Inverters never synced start yesterday; long-offline ones look back at
    most `max_back_days` (older gaps are for the `--start/--end` backfill).
    """
    floor = datetime.combine(today - timedelta(days=max_back_days), datetime.min.time())
    inverters = list(db.scalars(_inverters_query(phase, include_untagged)))
    totals: Dict[str, Any] = {"inverters": len(inverters), "inverter_rows": 0, "string_rows": 0, "failed": []}
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
            totals["failed"].append((inv.device_sn, str(exc)))
            log.error("%s incremental sync failed: %s", inv.device_sn, exc)
        time.sleep(pause_s)
    return totals


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
    starts = [t for t in (oldest, oldest_str, oldest_env) if t is not None]
    totals: Dict[str, Any] = {"cutoff": cutoff.isoformat(), "inverter_rows": 0, "string_rows": 0, "env_rows": 0, "days": 0}
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
        db.commit()
        totals["env_rows"] += n_env or 0
        totals["string_rows"] += n_str or 0
        totals["inverter_rows"] += n_inv or 0
        totals["days"] += 1
        day = end
    log.info(
        "retention: deleted %d inverter / %d string / %d weather rows before %s",
        totals["inverter_rows"], totals["string_rows"], totals["env_rows"], cutoff,
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
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")

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
