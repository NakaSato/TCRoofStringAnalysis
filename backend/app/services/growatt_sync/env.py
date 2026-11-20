"""Weather sensors: registration and `env_data` history."""

from __future__ import annotations

import time
from datetime import date, datetime, timedelta
from typing import Any, Dict, List, Optional, Sequence

from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from app.db.models import GrowattEnvReading, GrowattEnvSensor, GrowattPlant
from solar_core.growatt import GrowattAPIError, GrowattClient, parse_env_records
from app.services.growatt_sync.common import RATE_LIMIT_CODE, _date_chunks, _retry, _upsert, log

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
    """Fetch and upsert weather history for one sensor. Returns rows written.
    With `stop_before` only records from that time on are written (see `sync_inverter_history`)."""
    n = 0
    for a, b in _date_chunks(start, end):
        records = _retry(
            lambda: client.env_history(sensor.datalogger_sn, sensor.address, a, b, stop_before=stop_before),
            f"env {sensor.datalogger_sn}/{sensor.address} {a}..{b}",
            retries,
        )
        rows = parse_env_records(sensor.datalogger_sn, sensor.address, records)
        if stop_before is not None:
            rows = [r for r in rows if r["timestamp"] >= stop_before]
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
