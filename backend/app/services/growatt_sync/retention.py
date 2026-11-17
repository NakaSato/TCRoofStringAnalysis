"""Deleting readings older than the retention period."""

from __future__ import annotations

from datetime import date, datetime, timedelta
from typing import Any, Dict

from sqlalchemy import delete, func, select
from sqlalchemy.orm import Session

from app.db.models import (
    GrowattEnvReading,
    GrowattInverterRaw,
    GrowattInverterReading,
    GrowattMeterReading,
    GrowattStringReading,
)
from app.services.growatt_sync.common import log

def _rowcount(result: Any) -> int:
    """Rows a DELETE touched (`CursorResult.rowcount`; typed as plain `Result` by `Session.execute`)."""
    return getattr(result, "rowcount", 0) or 0


def prune_raw(db: Session, today: date, keep_days: int) -> int:
    """Delete whole-record copies (`growatt_inverter_raw`) older than `keep_days` before `today`,
    one day per transaction, oldest first. Returns rows deleted."""
    if keep_days < 1:
        raise ValueError("keep_days must be >= 1")
    cutoff = datetime.combine(today - timedelta(days=keep_days), datetime.min.time())
    oldest = db.scalar(select(func.min(GrowattInverterRaw.timestamp)))
    if oldest is None:
        return 0
    n = 0
    day = datetime.combine(oldest.date(), datetime.min.time())
    while day < cutoff:
        end = min(day + timedelta(days=1), cutoff)
        n += _rowcount(db.execute(delete(GrowattInverterRaw).where(GrowattInverterRaw.timestamp >= day, GrowattInverterRaw.timestamp < end)))
        db.commit()
        day = end
    return n


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
        n_str = _rowcount(db.execute(
            delete(GrowattStringReading).where(GrowattStringReading.timestamp >= day, GrowattStringReading.timestamp < end)
        ))
        n_inv = _rowcount(db.execute(
            delete(GrowattInverterReading).where(
                GrowattInverterReading.timestamp >= day, GrowattInverterReading.timestamp < end
            )
        ))
        n_env = _rowcount(db.execute(
            delete(GrowattEnvReading).where(GrowattEnvReading.timestamp >= day, GrowattEnvReading.timestamp < end)
        ))
        n_meter = _rowcount(db.execute(
            delete(GrowattMeterReading).where(GrowattMeterReading.timestamp >= day, GrowattMeterReading.timestamp < end)
        ))
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
