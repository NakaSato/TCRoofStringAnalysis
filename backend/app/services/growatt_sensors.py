"""Fleet list of Growatt weather sensors from the registry and stored history (DB only).

Online state (`lost`, last upload) is realtime and never stored, so this list carries only what
SQL knows: identity, the newest stored reading, which probes report, and today's coverage. A
sensor's live status is `unknown` here; the live sweep (`/growatt/live/sensors/status`) sets it.
"""

from __future__ import annotations

from datetime import date, datetime, time, timedelta
from typing import Any, Callable, Dict, List, Optional, Set, Tuple

from sqlalchemy import and_, select
from sqlalchemy.orm import Session

from app.db.models import GrowattEnvReading, GrowattEnvSensor, GrowattPlant, SyncRun
from app.services import growatt_weather as wx
from app.services.jobs import PLANT_TZ, _aware

E = GrowattEnvReading
S = GrowattEnvSensor

# Daylight window over which coverage is counted (plant-local, end exclusive)
COVERAGE_START_H, COVERAGE_END_H = 6, 18
SLOT_MIN = 5
MEASURED_LOOKBACK = timedelta(days=7)
# jobs whose finished runs mean "env history fetched up to the run's start"
ENV_SYNC_JOBS = ("history", "backfill")


def _key(dl: str, addr: int) -> str:
    return f"{dl}:{addr}"


def _fmt(ts: Optional[datetime]) -> Optional[str]:
    return ts.strftime("%Y-%m-%d %H:%M:%S") if ts else None


def _slot(ts: datetime) -> datetime:
    return ts.replace(minute=ts.minute - ts.minute % SLOT_MIN, second=0, microsecond=0)


def last_env_sync(db: Session) -> Optional[datetime]:
    """Start (UTC) of the newest finished `history` / `backfill` run: env history is in SQL up to then."""
    ts = db.scalar(
        select(SyncRun.started_at)
        .where(SyncRun.job.in_(ENV_SYNC_JOBS), SyncRun.status.in_(("ok", "partial")))
        .order_by(SyncRun.started_at.desc())
        .limit(1)
    )
    return _aware(ts)


def coverage_until(day: date, now_local: datetime, synced_utc: Optional[datetime]) -> Optional[datetime]:
    """End (plant-local, exclusive) of the slots of `day` that can be judged: inside the daylight
    window, already over, and already fetched by a sync run. None = nothing to judge yet."""
    start = datetime.combine(day, time(COVERAGE_START_H))
    end = datetime.combine(day, time(COVERAGE_END_H))
    cap = min(end, now_local)
    if synced_utc is None:
        return None
    cap = min(cap, synced_utc.astimezone(PLANT_TZ).replace(tzinfo=None))
    cap = _slot(cap)  # the slot in progress at `cap` is not complete
    return cap if cap > start else None


def sensor_status(last_reading_at: Optional[datetime]) -> str:
    """Status from stored data alone: `not_synced` without any stored reading, else `unknown`
    (online / late / offline need the live sweep)."""
    return "not_synced" if last_reading_at is None else "unknown"


def list_sensors(
    db: Session,
    allowed: Optional[Set[int]],
    now_local: Optional[Callable[[], datetime]] = None,
) -> Dict[str, Any]:
    """Every registered weather sensor of the plants the user may see (`allowed` None = all)."""
    now = (now_local or (lambda: datetime.now(PLANT_TZ).replace(tzinfo=None)))()
    today = now.date()

    q = (
        select(S, GrowattPlant.name, GrowattPlant.phase)
        .join(GrowattPlant, GrowattPlant.plant_id == S.plant_id)
        .order_by(GrowattPlant.name, S.datalogger_sn, S.address)
    )
    plant_filter = None
    if allowed is not None:
        plant_filter = list(allowed) or [-1]
        q = q.where(S.plant_id.in_(plant_filter))
    rows: List[Tuple[GrowattEnvSensor, str, Optional[int]]] = [tuple(r) for r in db.execute(q).all()]  # type: ignore[misc]

    # newest stored reading: `history_synced_until` is the stored max, so an exact key lookup
    last_q = select(E).join(
        S, and_(S.datalogger_sn == E.datalogger_sn, S.address == E.address, S.history_synced_until == E.timestamp)
    )
    if plant_filter is not None:
        last_q = last_q.where(S.plant_id.in_(plant_filter))
    last: Dict[Tuple[str, int], GrowattEnvReading] = {(r.datalogger_sn, r.address): r for r in db.scalars(last_q)}

    measured = wx.measured_by_sensor(db, now - MEASURED_LOOKBACK, plant_filter)

    synced = last_env_sync(db)
    until = coverage_until(today, now, synced)
    expected = 0
    seen: Dict[Tuple[str, int], Set[datetime]] = {}
    if until is not None:
        start = datetime.combine(today, time(COVERAGE_START_H))
        expected = int((until - start).total_seconds() // (SLOT_MIN * 60))
        cov_q = (
            select(E.datalogger_sn, E.address, E.timestamp)
            .join(S, and_(S.datalogger_sn == E.datalogger_sn, S.address == E.address))
            .where(E.timestamp >= start, E.timestamp < until)
        )
        if plant_filter is not None:
            cov_q = cov_q.where(S.plant_id.in_(plant_filter))
        for dl, addr, ts in db.execute(cov_q):
            seen.setdefault((dl, addr), set()).add(_slot(ts))  # mixed intervals: one count per 5-min slot

    sensors: List[Dict[str, Any]] = []
    for s, plant_name, phase in rows:
        k = (s.datalogger_sn, s.address)
        fields = measured.get(k)
        rec = last.get(k)
        last_at = s.history_synced_until
        sensors.append(
            {
                "key": _key(*k),
                "datalogger_sn": s.datalogger_sn,
                "address": s.address,
                "device_name": s.device_name,
                "plant_id": s.plant_id,
                "plant_name": plant_name,
                "phase": phase,
                "status": sensor_status(last_at),
                "last_reading_at": _fmt(last_at),
                # null = no stored reading in the last 7 days: which probes report is unknown
                "measured": fields,
                # probes that read only 0 for the week were not measured: null, never 0
                "last": (
                    None
                    if rec is None
                    else {f: (getattr(rec, f) if fields is None or f in fields else None) for f in wx.FIELDS}
                ),
                "coverage_today_pct": round(100.0 * len(seen.get(k, ())) / expected, 1) if expected else None,
                "flags": [],
            }
        )
    return {
        "meta": {
            "source": "db",
            "day": today.isoformat(),
            "coverage_window": {"start": f"{COVERAGE_START_H:02d}:00", "until": until.strftime("%H:%M") if until else None},
            "synced_at": synced.isoformat() if synced else None,
        },
        "sensors": sensors,
    }
