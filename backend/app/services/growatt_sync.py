"""Sync Growatt OpenAPI data into the app database.

Usage (from repo root):
    PYTHONPATH=backend uv run python -m app.services.growatt_sync               # fleet + yesterday..today
    PYTHONPATH=backend uv run python -m app.services.growatt_sync --start 2026-11-05 --end 2026-11-11
    PYTHONPATH=backend uv run python -m app.services.growatt_sync --fleet-only
    PYTHONPATH=backend uv run python -m app.services.growatt_sync --sn GKLLEXC006 --sn GKLLEXC005

Re-running is safe: readings are upserted on their primary keys.
"""

from __future__ import annotations

import argparse
import logging
import time
from datetime import date, datetime, timedelta
from typing import Any, Dict, Iterable, List, Optional, Sequence

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.config import settings
from app.db.models import (
    GrowattInverter,
    GrowattInverterReading,
    GrowattPlant,
    GrowattStringReading,
)
from app.db.session import Base, SessionLocal
from solar_core.growatt import GrowattAPIError, GrowattClient, parse_max_records

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


def sync_fleet(db: Session, client: GrowattClient, pause_s: float = 0.5) -> List[GrowattInverter]:
    """Upsert all plants and their inverters. Returns the inverters."""
    now = datetime.now().astimezone()
    plants = client.list_plants(refresh=True)
    _upsert(
        db,
        GrowattPlant,
        [
            {
                "plant_id": int(p["plant_id"]),
                "name": p.get("name") or str(p["plant_id"]),
                "city": p.get("city"),
                "country": p.get("country"),
                "latitude": _fnum(p.get("latitude")),
                "longitude": _fnum(p.get("longitude")),
                "peak_power_kwp": _fnum(p.get("peak_power")),
                # current power / total energy / status are realtime: served live, never stored
                "create_date": p.get("create_date"),
                "synced_at": now,
            }
            for p in plants
        ],
    )
    db.commit()
    log.info("plants: %d", len(plants))

    for p in plants:
        pid = int(p["plant_id"])
        invs = client.list_inverters(pid, refresh=True)
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
        time.sleep(pause_s)
    return list(db.scalars(select(GrowattInverter).order_by(GrowattInverter.plant_id, GrowattInverter.device_sn)))


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
        records: List[Dict[str, Any]] = []
        for attempt in range(retries + 1):
            try:
                records = client.max_history(inverter.device_sn, a, b, stop_before=stop_before)
                break
            except GrowattAPIError as exc:
                if attempt == retries:
                    raise
                # 10012 = per-device rate limit; its window is minutes, so short retries just fail again
                wait = min(60 * (attempt + 1), 120) if exc.error_code == RATE_LIMIT_CODE else 5 * (attempt + 1)
                log.warning("%s %s..%s: %s — retry in %ss", inverter.device_sn, a, b, exc, wait)
                time.sleep(wait)
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
) -> Dict[str, Any]:
    q = select(GrowattInverter).order_by(GrowattInverter.plant_id, GrowattInverter.device_sn)
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
) -> Dict[str, Any]:
    """Fetch only what is new for each inverter since its `history_synced_until`.

    The overlap re-reads the last half hour (Growatt uploads arrive late); upserts make the
    overlap free. Inverters never synced start yesterday; long-offline ones look back at
    most `max_back_days` (older gaps are for the `--start/--end` backfill).
    """
    floor = datetime.combine(today - timedelta(days=max_back_days), datetime.min.time())
    inverters = list(db.scalars(select(GrowattInverter).order_by(GrowattInverter.plant_id, GrowattInverter.device_sn)))
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


def main(argv: Optional[Sequence[str]] = None) -> None:
    today = date.today()
    ap = argparse.ArgumentParser(description="Sync Growatt plants, inverters and string history into the app DB")
    ap.add_argument("--start", type=date.fromisoformat, default=today - timedelta(days=1))
    ap.add_argument("--end", type=date.fromisoformat, default=today)
    ap.add_argument("--sn", action="append", help="Only these inverter serials (repeatable)")
    ap.add_argument("--fleet-only", action="store_true", help="Only sync plants and inverters")
    ap.add_argument("--skip-fleet", action="store_true", help="Use inverters already in the DB")
    args = ap.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")

    client = GrowattClient(token=settings.growatt_api_token, base_url=settings.growatt_base_url, timeout=60)
    with SessionLocal() as db:
        Base.metadata.create_all(bind=db.get_bind())
        if not args.skip_fleet:
            sync_fleet(db, client)
        if args.fleet_only:
            return
        totals = sync_all_history(db, client, args.start, args.end, device_sns=args.sn)
        log.info(
            "done %s..%s: %d inverters, %d inverter records, %d string rows, %d failed",
            args.start, args.end, totals["inverters"], totals["inverter_rows"], totals["string_rows"], len(totals["failed"]),
        )
        for sn, err in totals["failed"]:
            log.info("  failed %s: %s", sn, err)


if __name__ == "__main__":
    main()
