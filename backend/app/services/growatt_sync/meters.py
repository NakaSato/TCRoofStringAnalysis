"""Energy meters: registration and `meter_data` history."""

from __future__ import annotations

import time
from datetime import date, datetime, timedelta
from typing import Any, Dict, List, Optional, Sequence

from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from app.config import settings
from app.db.models import GrowattMeter, GrowattMeterReading, GrowattPlant
from solar_core.growatt import GrowattAPIError, GrowattClient, parse_meter_records
from app.services.growatt_sync.common import MAX_RATE_LIMITED, RATE_LIMIT_CODE, _date_chunks, _retry, _upsert, log

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
    rows: Dict[tuple, Dict[str, Any]] = {}
    for dl in dataloggers:
        for m in _retry(lambda: client.list_meters(dl, refresh=True), f"{dl} meter_list"):
            try:
                addr = int(str(m.get("address")))
            except ValueError:
                continue
            if (dl, addr) in rows:
                # meter_list can name one bus address twice (e.g. CHNT_THREE type 71 and CHNT_ONE
                # type 70 on 18 Nov 2026); readings are keyed by (datalogger, address), so keep the
                # first entry: two rows with one key make Postgres refuse the whole upsert
                log.warning(
                    "plant %s: meter_list names %s address %s twice (%s / %s); keeping %s",
                    plant_id, dl, addr, rows[(dl, addr)]["device_name"], m.get("device_name"),
                    rows[(dl, addr)]["device_name"],
                )
                continue
            rows[(dl, addr)] = {
                "datalogger_sn": dl,
                "address": addr,
                "plant_id": plant_id,
                "device_name": m.get("device_name"),
                "device_type": str(m.get("device_type")) if m.get("device_type") not in (None, "") else None,
                # lost / lastUpdateTime are realtime: never stored
                "synced_at": now or datetime.now().astimezone(),
            }
    _upsert(db, GrowattMeter, list(rows.values()))
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
    """Fetch and upsert one meter's history. Returns rows written.
    With `stop_before` only records from that time on are written (see `sync_inverter_history`)."""
    n = 0
    for a, b in _date_chunks(start, end):
        records = _retry(
            lambda: client.meter_history(meter.datalogger_sn, meter.address, a, b, stop_before=stop_before),
            f"meter {meter.datalogger_sn}/{meter.address} {a}..{b}",
            retries,
        )
        rows = parse_meter_records(meter.datalogger_sn, meter.address, records)
        if stop_before is not None:
            rows = [r for r in rows if r["timestamp"] >= stop_before]
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
