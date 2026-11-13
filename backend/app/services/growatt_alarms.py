"""Growatt alarm / fault log in SQL: worker sync and the fleet-wide DB read.

`device/max/alarm_data` answers one inverter-day per call. The worker's `alarms` job reads
today for every inverter (every WORKER_ALARMS_INTERVAL_MIN in the daytime window) and
`alarms_yesterday` reads the previous day once after midnight, so alarms that closed late or
happened in the evening are complete. Each successful read replaces that inverter-day's rows
and stamps `growatt_alarm_syncs`; a failed read keeps what was stored.

The Active Alarm page reads `alarm_day` (one DB query for the whole fleet); it never calls
Growatt. Alarms are source-timestamped history (Growatt's own start/end times), like max_data.
"""

from __future__ import annotations

import logging
import time
from datetime import date, datetime, timedelta, timezone
from typing import Any, Dict, List, Optional, Set

from sqlalchemy import delete, func, insert, select
from sqlalchemy.orm import Session

from app.db.models import GrowattAlarm, GrowattAlarmSync, GrowattInverter, GrowattPlant
from solar_core.growatt import GrowattAPIError, GrowattClient

log = logging.getLogger("growatt_alarms")

RATE_LIMIT_CODE = 10012
# Consecutive 10012 answers that end an account's sweep (the rest wait for the next run,
# which starts with the inverters read longest ago).
MAX_RATE_LIMITED = 3
_TIME_FMT = "%Y-%m-%d %H:%M:%S"


def _parse_time(v: Any) -> Optional[datetime]:
    if not v:
        return None
    try:
        return datetime.strptime(str(v)[:19], _TIME_FMT)
    except ValueError:
        return None


def _code(v: Any) -> Optional[str]:
    return None if v is None or v == "" else str(v)


def _int(v: Any) -> Optional[int]:
    try:
        return int(v)
    except (TypeError, ValueError):
        return None


def _alarm_rows(inv: GrowattInverter, day: date, records: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    return [
        {
            "device_sn": inv.device_sn,
            "plant_id": inv.plant_id,
            "day": day,
            "start_time": _parse_time(a.get("start_time")),
            "end_time": _parse_time(a.get("end_time")),
            "alarm_code": _code(a.get("alarm_code")),
            "alarm_message": (str(a.get("alarm_message"))[:255] or None) if a.get("alarm_message") else None,
            "fault_type": (str(a.get("fault_type"))[:32] or None) if a.get("fault_type") else None,
            "status": _int(a.get("status")),
        }
        for a in records
    ]


def store_inverter_day(db: Session, inv: GrowattInverter, day: date, records: List[Dict[str, Any]], now: datetime) -> int:
    """Replace one inverter-day's alarms with a complete read and stamp it synced. Commits."""
    rows = _alarm_rows(inv, day, records)
    db.execute(delete(GrowattAlarm).where(GrowattAlarm.device_sn == inv.device_sn, GrowattAlarm.day == day))
    if rows:
        db.execute(insert(GrowattAlarm), rows)
    sync = db.get(GrowattAlarmSync, (inv.device_sn, day))
    if sync is None:
        db.add(GrowattAlarmSync(device_sn=inv.device_sn, day=day, plant_id=inv.plant_id, synced_at=now, alarm_count=len(rows)))
    else:
        sync.plant_id, sync.synced_at, sync.alarm_count = inv.plant_id, now, len(rows)
    db.commit()
    return len(rows)


def sync_alarms(
    db: Session,
    client: GrowattClient,
    day: date,
    inverters: List[GrowattInverter],
    pause_s: float = 0.3,
) -> Dict[str, Any]:
    """Read `day`'s alarm log of `inverters` (one account), never-read and oldest-read first."""
    synced = {
        sn: at
        for sn, at in db.execute(
            select(GrowattAlarmSync.device_sn, GrowattAlarmSync.synced_at).where(GrowattAlarmSync.day == day)
        )
    }
    epoch = datetime.min.replace(tzinfo=timezone.utc)

    def last(inv: GrowattInverter) -> datetime:
        at = synced.get(inv.device_sn)
        if at is None:
            return epoch
        return at if at.tzinfo else at.replace(tzinfo=timezone.utc)

    order = sorted(inverters, key=lambda i: (last(i), i.plant_id, i.device_sn))
    totals: Dict[str, Any] = {"alarm_inverters": len(order), "alarm_read": 0, "alarm_rows": 0, "failed": []}
    limited = 0
    for idx, inv in enumerate(order):
        try:
            records = client.max_alarms(inv.device_sn, day)
        except GrowattAPIError as exc:
            if exc.error_code == RATE_LIMIT_CODE:
                limited += 1
                if limited >= MAX_RATE_LIMITED:
                    left = len(order) - idx
                    totals["failed"].append(("rate limited", f"{left} inverters left for the next run"))
                    log.warning("alarm_data rate limited; %d inverters wait for the next run", left)
                    break
            totals["failed"].append((inv.device_sn, str(exc)))
            time.sleep(pause_s)
            continue
        except Exception as exc:  # network etc.: keep going
            totals["failed"].append((inv.device_sn, str(exc)))
            time.sleep(pause_s)
            continue
        limited = 0
        try:
            totals["alarm_rows"] += store_inverter_day(db, inv, day, records, datetime.now(timezone.utc))
            totals["alarm_read"] += 1
        except Exception as exc:
            db.rollback()
            totals["failed"].append((inv.device_sn, f"store: {exc}"))
            log.error("%s alarms %s store failed: %s", inv.device_sn, day, exc)
        time.sleep(pause_s)
    return totals


def prune_alarms(db: Session, today: date, keep_days: int) -> int:
    """Delete alarm rows and sync stamps older than `keep_days` before `today`."""
    cutoff = today - timedelta(days=keep_days)
    res = db.execute(delete(GrowattAlarm).where(GrowattAlarm.day < cutoff))
    n = getattr(res, "rowcount", 0) or 0
    db.execute(delete(GrowattAlarmSync).where(GrowattAlarmSync.day < cutoff))
    db.commit()
    return n


def _iso_utc(ts: Optional[datetime]) -> Optional[str]:
    if ts is None:
        return None
    return (ts if ts.tzinfo else ts.replace(tzinfo=timezone.utc)).isoformat()


def _fmt(ts: Optional[datetime]) -> Optional[str]:
    return ts.strftime(_TIME_FMT) if ts else None


def alarm_day(db: Session, day: date, allowed: Optional[Set[int]]) -> Dict[str, Any]:
    """Every stored alarm of `day` for the plants the user may see (`allowed` None = all), with
    per-plant sync coverage. A plant with inverters not yet read for the day reports that,
    rather than showing as "no alarms"."""
    plant_q = (
        select(GrowattPlant.plant_id, GrowattPlant.name, func.count(GrowattInverter.device_sn))
        .join(GrowattInverter, GrowattInverter.plant_id == GrowattPlant.plant_id)
        .group_by(GrowattPlant.plant_id, GrowattPlant.name)
        .order_by(GrowattPlant.plant_id)
    )
    if allowed is not None:
        plant_q = plant_q.where(GrowattPlant.plant_id.in_(allowed or {-1}))
    plants = {pid: {"plant_id": pid, "name": name, "inverters": n} for pid, name, n in db.execute(plant_q)}

    cover = (
        select(
            GrowattAlarmSync.plant_id,
            func.count(GrowattAlarmSync.device_sn),
            func.min(GrowattAlarmSync.synced_at),
            func.max(GrowattAlarmSync.synced_at),
        )
        .join(GrowattInverter, GrowattInverter.device_sn == GrowattAlarmSync.device_sn)
        .where(GrowattAlarmSync.day == day)
        .group_by(GrowattAlarmSync.plant_id)
    )
    stamps: Dict[int, tuple] = {pid: (n, lo, hi) for pid, n, lo, hi in db.execute(cover)}

    out_plants = []
    newest: Optional[datetime] = None
    for pid, p in plants.items():
        n, lo, hi = stamps.get(pid, (0, None, None))
        if hi is not None:
            hi_aware = hi if hi.tzinfo else hi.replace(tzinfo=timezone.utc)
            newest = hi_aware if newest is None or hi_aware > newest else newest
        out_plants.append(
            {
                **p,
                "synced_inverters": n,
                # oldest read among the plant's inverters = how current the plant's log is at worst
                "synced_at": _iso_utc(lo),
            }
        )

    rows = db.execute(
        select(GrowattAlarm, GrowattPlant.name)
        .join(GrowattPlant, GrowattPlant.plant_id == GrowattAlarm.plant_id)
        .where(GrowattAlarm.day == day, GrowattAlarm.plant_id.in_(list(plants) or [-1]))
        .order_by(GrowattAlarm.start_time.desc(), GrowattAlarm.id)
    ).all()
    alarms = [
        {
            "plant_id": a.plant_id,
            "plant_name": name,
            "device_sn": a.device_sn,
            "start_time": _fmt(a.start_time),
            "end_time": _fmt(a.end_time),
            "alarm_code": int(a.alarm_code) if a.alarm_code and a.alarm_code.isdigit() else a.alarm_code,
            "alarm_message": a.alarm_message,
            "fault_type": a.fault_type,
            "status": a.status,
        }
        for a, name in rows
    ]
    return {
        "day": day.isoformat(),
        "alarms": alarms,
        "plants": out_plants,
        "meta": {"source": "db", "synced_at": _iso_utc(newest)},
    }
