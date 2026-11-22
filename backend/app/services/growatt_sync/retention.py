"""Deleting readings older than the retention period."""

from __future__ import annotations

from datetime import date, datetime, timedelta
from typing import Any, Dict, Optional

from sqlalchemy import delete, func, select
from sqlalchemy.orm import Session

from app.db.models import (
    GrowattEnvReading,
    GrowattInverter,
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


def prune_history(db: Session, today: date, keep_days: int, string_keep_days: Optional[int] = None) -> Dict[str, Any]:
    """Delete inverter/string/weather readings older than `keep_days` before `today` (plant-local).
    `string_keep_days` (at most `keep_days`): per-string readings get this shorter retention.

    Deletes one day per transaction, oldest first (string readings: one inverter per
    transaction), so a large first run never holds a huge lock or WAL. Postgres autovacuum
    then reuses the freed space, which keeps the disk at a steady size instead of growing
    forever.
    """
    if keep_days < 1:
        raise ValueError("keep_days must be >= 1")
    cutoff = datetime.combine(today - timedelta(days=keep_days), datetime.min.time())
    str_days = keep_days if string_keep_days is None else min(string_keep_days, keep_days)
    if str_days < 1:
        raise ValueError("string_keep_days must be >= 1")
    str_cutoff = datetime.combine(today - timedelta(days=str_days), datetime.min.time())
    oldest = db.scalar(select(func.min(GrowattInverterReading.timestamp)))
    oldest_env = db.scalar(select(func.min(GrowattEnvReading.timestamp)))
    oldest_meter = db.scalar(select(func.min(GrowattMeterReading.timestamp)))
    starts = [t for t in (oldest, oldest_env, oldest_meter) if t is not None]
    totals: Dict[str, Any] = {
        "cutoff": cutoff.isoformat(), "string_cutoff": str_cutoff.isoformat(), "inverter_rows": 0, "string_rows": 0, "env_rows": 0, "meter_rows": 0, "days": 0,
    }
    # String readings: one inverter per transaction, through the primary key (device_sn, timestamp,
    # string_no); the table has no timestamp index of its own.
    S = GrowattStringReading
    for sn in db.scalars(select(GrowattInverter.device_sn)).all():
        totals["string_rows"] += _rowcount(db.execute(delete(S).where(S.device_sn == sn, S.timestamp < str_cutoff)))
        db.commit()
    if starts:
        day = datetime.combine(min(starts).date(), datetime.min.time())
        while day < cutoff:
            end = min(day + timedelta(days=1), cutoff)
            totals["inverter_rows"] += _rowcount(db.execute(
                delete(GrowattInverterReading).where(
                    GrowattInverterReading.timestamp >= day, GrowattInverterReading.timestamp < end
                )
            ))
            totals["env_rows"] += _rowcount(db.execute(
                delete(GrowattEnvReading).where(GrowattEnvReading.timestamp >= day, GrowattEnvReading.timestamp < end)
            ))
            totals["meter_rows"] += _rowcount(db.execute(
                delete(GrowattMeterReading).where(GrowattMeterReading.timestamp >= day, GrowattMeterReading.timestamp < end)
            ))
            totals["days"] += 1
            db.commit()
            day = end
    log.info(
        "retention: deleted %d inverter / %d weather / %d meter rows before %s, %d string rows before %s",
        totals["inverter_rows"], totals["env_rows"], totals["meter_rows"], cutoff, totals["string_rows"], str_cutoff,
    )
    return totals
