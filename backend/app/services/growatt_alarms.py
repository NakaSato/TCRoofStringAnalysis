"""Growatt alarm / fault log in SQL: worker sync and the fleet-wide DB read.

`device/max/alarm_data` answers one inverter-day per call. The worker's `alarms` job runs every
WORKER_ALARMS_TICK_MIN in the daytime window and reads today only for the inverters that are due
by tier (`Tiers`): **hot** (an open alarm today, or the newest stored `max_data` status is fault)
every WORKER_ALARMS_HOT_MIN, **warm** (alarms today, all closed) every _WARM_MIN, **cold** (no
alarms today) every _COLD_MIN. Most of the fleet is cold on a normal day, so a tick reads a few
dozen inverters instead of all 629. A fault seen by `history` makes an inverter hot on the next
tick, with no extra Growatt call. `alarms_yesterday` reads the previous day in full once after
midnight, so alarms that closed late or happened in the evening are complete. Each successful
read replaces that inverter-day's rows and stamps `growatt_alarm_syncs`; a failed read keeps
what was stored.

The Active Alarm page reads `alarm_day` (one DB query for the whole fleet); it never calls
Growatt. Alarms are source-timestamped history (Growatt's own start/end times), like max_data.
"""

from __future__ import annotations

import logging
import math
import time
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from typing import Any, Dict, List, Optional, Set

from sqlalchemy import delete, func, insert, select
from sqlalchemy.orm import Session

from app.db.models import GrowattAlarm, GrowattAlarmSync, GrowattInverter, GrowattInverterReading, GrowattPlant, inverter_installed
from solar_core.growatt import GrowattAPIError, GrowattClient

log = logging.getLogger("growatt_alarms")

RATE_LIMIT_CODE = 10012
# Consecutive 10012 answers that end an account's sweep (the rest wait for the next run,
# which starts with the inverters read longest ago).
MAX_RATE_LIMITED = 3
_TIME_FMT = "%Y-%m-%d %H:%M:%S"
# `max_data` status of a MAX inverter in fault (0 waiting, 1 normal, 3 fault)
FAULT_STATUS = 3
# Growatt re-reports an alarm that is still present every ~5 min, each record with end = start
# (it practically never leaves end_time empty): an alarm reported within this of an inverter's
# last read is ongoing. Same as EVENT_GAP_MIN in the frontend (components/alarmEvents.ts).
ONGOING_GAP = timedelta(minutes=10)


@dataclass(frozen=True)
class Tiers:
    """How often an inverter's alarm log of today is re-read, by what is known about it."""

    hot: timedelta  # alarm still being reported at the last read, or newest stored status is fault
    warm: timedelta  # alarms today, all closed
    cold: timedelta  # no alarms today
    # the job's tick: caps the cold reads per run at COLD_SPREAD x their fair share
    # (cold count x tick / cold), so the fleet read at 05:00 does not come due again all at once
    tick: Optional[timedelta] = None


COLD_SPREAD = 1.5


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


def _aware(ts: datetime) -> datetime:
    return ts if ts.tzinfo else ts.replace(tzinfo=timezone.utc)


def inverter_tiers(db: Session, day: date, sns: List[str]) -> Dict[str, str]:
    """`hot` / `warm` / `cold` per serial for `day` (see `Tiers`), from SQL only."""
    if not sns:
        return {}
    # ongoing: no end time, or last reported within ONGOING_GAP of the inverter's last read
    from app.services.jobs import PLANT_TZ

    read_at = {
        sn: _aware(at).astimezone(PLANT_TZ).replace(tzinfo=None)
        for sn, at in db.execute(
            select(GrowattAlarmSync.device_sn, GrowattAlarmSync.synced_at).where(
                GrowattAlarmSync.day == day, GrowattAlarmSync.device_sn.in_(sns)
            )
        )
    }
    open_sns: Set[str] = set()
    for sn, last_start, last_end, no_end in db.execute(
        select(
            GrowattAlarm.device_sn,
            func.max(GrowattAlarm.start_time),
            func.max(GrowattAlarm.end_time),
            func.count().filter(GrowattAlarm.end_time.is_(None)),
        )
        .where(GrowattAlarm.day == day, GrowattAlarm.device_sn.in_(sns))
        .group_by(GrowattAlarm.device_sn)
    ):
        latest = max((t for t in (last_start, last_end) if t is not None), default=None)
        at = read_at.get(sn)
        if no_end or (latest is not None and at is not None and latest >= at - ONGOING_GAP):
            open_sns.add(sn)
    with_alarms = set(
        db.scalars(
            select(GrowattAlarmSync.device_sn).where(
                GrowattAlarmSync.day == day, GrowattAlarmSync.alarm_count > 0, GrowattAlarmSync.device_sn.in_(sns)
            )
        )
    )
    # newest stored reading of the day per inverter (plant-local timestamps): fault = hot
    start = datetime.combine(day, datetime.min.time())
    newest = (
        select(GrowattInverterReading.device_sn, func.max(GrowattInverterReading.timestamp).label("ts"))
        .where(
            GrowattInverterReading.timestamp >= start,
            GrowattInverterReading.timestamp < start + timedelta(days=1),
            GrowattInverterReading.device_sn.in_(sns),
        )
        .group_by(GrowattInverterReading.device_sn)
        .subquery()
    )
    faulted = set(
        db.scalars(
            select(GrowattInverterReading.device_sn)
            .join(
                newest,
                (newest.c.device_sn == GrowattInverterReading.device_sn) & (newest.c.ts == GrowattInverterReading.timestamp),
            )
            .where(GrowattInverterReading.status == FAULT_STATUS)
        )
    )
    return {sn: "hot" if sn in open_sns or sn in faulted else "warm" if sn in with_alarms else "cold" for sn in sns}


_TIER_RANK = {"hot": 0, "warm": 1, "cold": 2}


def sync_alarms(
    db: Session,
    client: GrowattClient,
    day: date,
    inverters: List[GrowattInverter],
    pause_s: float = 0.3,
    tiers: Optional[Tiers] = None,
    now: Optional[datetime] = None,
) -> Dict[str, Any]:
    """Read `day`'s alarm log of `inverters` (one account), never-read and oldest-read first.

    With `tiers`, only the inverters whose tier interval has passed since their last read
    (never-read ones always) are read, hot ones first."""
    synced = {
        sn: at
        for sn, at in db.execute(
            select(GrowattAlarmSync.device_sn, GrowattAlarmSync.synced_at).where(GrowattAlarmSync.day == day)
        )
    }
    epoch = datetime.min.replace(tzinfo=timezone.utc)

    def last(inv: GrowattInverter) -> datetime:
        at = synced.get(inv.device_sn)
        return epoch if at is None else _aware(at)

    totals: Dict[str, Any] = {"alarm_inverters": len(inverters), "alarm_read": 0, "alarm_rows": 0, "failed": []}
    if tiers is None:
        order = sorted(inverters, key=lambda i: (last(i), i.plant_id, i.device_sn))
    else:
        now = now or datetime.now(timezone.utc)
        tier_of = inverter_tiers(db, day, [i.device_sn for i in inverters])
        every = {"hot": tiers.hot, "warm": tiers.warm, "cold": tiers.cold}
        # a little slack, so an interval equal to the tick does not slip a tick on run-time jitter
        slack = timedelta(minutes=1)
        due = [i for i in inverters if now - last(i) + slack >= every[tier_of[i.device_sn]]]
        order = sorted(due, key=lambda i: (_TIER_RANK[tier_of[i.device_sn]], last(i), i.plant_id, i.device_sn))
        if tiers.tick:
            n_cold = sum(1 for v in tier_of.values() if v == "cold")
            cap = math.ceil(COLD_SPREAD * n_cold * (tiers.tick / tiers.cold))
            kept: List[GrowattInverter] = []
            for i in order:  # never-read cold inverters are not capped
                if tier_of[i.device_sn] == "cold" and i.device_sn in synced:
                    if cap <= 0:
                        continue
                    cap -= 1
                kept.append(i)
            order = kept
        for t in every:  # flat ints, so the per-account totals add up
            totals[f"alarm_{t}"] = sum(1 for v in tier_of.values() if v == t)
        totals["alarm_due"] = len(order)
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


def _tick() -> timedelta:
    from app.config import settings

    return timedelta(minutes=settings.worker_alarms_tick_min)


def next_run_at(now: datetime, last_start: Optional[datetime]) -> Optional[datetime]:
    """When the worker's `alarms` job will next start (UTC), from its last start, tick and
    daytime window (plant-local). In the past when the run is overdue (the worker is busy or
    down), so the page can tell. Approximate: it ignores the PWA skip windows."""
    from app.config import settings
    from app.services.jobs import PLANT_TZ

    start_h, end_h = settings.worker_alarms_start_h, settings.worker_alarms_end_h
    cand = _aware(last_start) + _tick() if last_start else now
    local = cand.astimezone(PLANT_TZ)
    if local.hour < start_h:
        local = local.replace(hour=start_h, minute=0, second=0, microsecond=0)
    elif local.hour >= end_h:
        local = (local + timedelta(days=1)).replace(hour=start_h, minute=0, second=0, microsecond=0)
    return local.astimezone(timezone.utc)


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
        .where(inverter_installed())
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
        .where(GrowattAlarmSync.day == day, inverter_installed())
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
        select(GrowattAlarm, GrowattPlant.name, GrowattAlarmSync.synced_at)
        .join(GrowattPlant, GrowattPlant.plant_id == GrowattAlarm.plant_id)
        .outerjoin(
            GrowattAlarmSync,
            (GrowattAlarmSync.device_sn == GrowattAlarm.device_sn) & (GrowattAlarmSync.day == GrowattAlarm.day),
        )
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
            # when this inverter's log was last read (UTC): an alarm reported shortly before is ongoing
            "read_at": _iso_utc(read),
        }
        for a, name, read in rows
    ]
    return {
        "day": day.isoformat(),
        "alarms": alarms,
        "plants": out_plants,
        "meta": {"source": "db", "synced_at": _iso_utc(newest)},
    }
