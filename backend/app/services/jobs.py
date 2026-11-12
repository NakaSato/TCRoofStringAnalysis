"""Background jobs shared by the worker (`app.worker`) and the `/growatt/sync` API.

Each run is recorded in `sync_runs`, which doubles as a per-job lock: while a run is
`running` (and younger than `STALE_AFTER`), another run of the same job is refused.
"""

from __future__ import annotations

import logging
from dataclasses import asdict
from datetime import date, datetime, timedelta, timezone
from typing import Any, Callable, Dict, Optional, Tuple, overload
from zoneinfo import ZoneInfo

from sqlalchemy import select
from sqlalchemy.orm import Session, sessionmaker

from app.config import settings
from app.db.models import SyncRun
from solar_core.growatt import GrowattClient

log = logging.getLogger("jobs")

PLANT_TZ = ZoneInfo("Asia/Bangkok")
STALE_AFTER = timedelta(hours=2)  # a `running` row older than this is treated as crashed


class JobBusy(RuntimeError):
    pass


@overload
def _aware(ts: datetime) -> datetime: ...
@overload
def _aware(ts: None) -> None: ...
def _aware(ts: Optional[datetime]) -> Optional[datetime]:
    """SQLite returns naive datetimes; they were stored as UTC."""
    if ts is None:
        return None
    return ts if ts.tzinfo else ts.replace(tzinfo=timezone.utc)


def _client() -> GrowattClient:
    return GrowattClient(token=settings.growatt_api_token, base_url=settings.growatt_base_url, timeout=60)


def _today() -> date:
    return datetime.now(PLANT_TZ).date()


# --------------------------------------------------------------------------- job bodies
# Each returns (status, detail). status: ok | partial.


def job_history(db: Session) -> Tuple[str, Dict[str, Any]]:
    from app.services.growatt_sync import sync_incremental

    t = sync_incremental(db, _client(), _today())
    return ("partial" if t["failed"] else "ok"), t


def job_backfill(db: Session) -> Tuple[str, Dict[str, Any]]:
    """Re-read the previous two full days to catch uploads that arrived late."""
    from app.services.growatt_sync import sync_all_history

    today = _today()
    t = sync_all_history(db, _client(), today - timedelta(days=2), today - timedelta(days=1))
    return ("partial" if t["failed"] else "ok"), t


def job_fleet(db: Session) -> Tuple[str, Dict[str, Any]]:
    from app.services.growatt_sync import sync_fleet

    invs = sync_fleet(db, _client())
    return "ok", {"inverters": len(invs)}


def _publish(db: Session, day: date) -> Tuple[str, Dict[str, Any]]:
    from app.services import daily_summary

    rep = daily_summary.run(db, [day], daily_summary.make_sink(settings.publish_sink))
    detail = asdict(rep)
    detail["day"] = day.isoformat()
    return ("partial" if rep.over_budget or rep.too_large else "ok"), detail


def job_publish_today(db: Session) -> Tuple[str, Dict[str, Any]]:
    return _publish(db, _today())


def job_publish_yesterday(db: Session) -> Tuple[str, Dict[str, Any]]:
    return _publish(db, _today() - timedelta(days=1))


JOBS: Dict[str, Callable[[Session], Tuple[str, Dict[str, Any]]]] = {
    "history": job_history,
    "backfill": job_backfill,
    "fleet": job_fleet,
    "publish_today": job_publish_today,
    "publish_yesterday": job_publish_yesterday,
}


# --------------------------------------------------------------------------- run log / lock


def claim(db: Session, job: str, trigger: str, now: Optional[datetime] = None) -> int:
    """Record a new `running` run, or raise JobBusy if one is already in progress."""
    if job not in JOBS:
        raise KeyError(job)
    # Always store UTC: SQLite drops tzinfo, and `_aware` reads naive values back as UTC.
    now = (now or datetime.now(timezone.utc)).astimezone(timezone.utc)
    for run in db.scalars(select(SyncRun).where(SyncRun.job == job, SyncRun.status == "running")):
        if now - _aware(run.started_at) < STALE_AFTER:
            raise JobBusy(f"{job} is already running (run {run.id}, started {run.started_at:%Y-%m-%d %H:%M})")
        run.status, run.finished_at, run.error = "failed", now, "abandoned (worker stopped mid-run)"
    run = SyncRun(job=job, trigger=trigger, status="running", started_at=now)
    db.add(run)
    db.commit()
    return run.id


def execute(session_factory: sessionmaker, run_id: int) -> SyncRun:
    """Run a claimed job in its own session and record the outcome."""
    with session_factory() as db:
        run = db.get(SyncRun, run_id)
        assert run is not None
        try:
            status, detail = JOBS[run.job](db)
            run.status, run.detail_json = status, _jsonable(detail)
        except Exception as exc:  # recorded, never raised into the worker loop
            db.rollback()
            run = db.get(SyncRun, run_id)
            run.status, run.error = "failed", f"{type(exc).__name__}: {exc}"
            log.exception("job %s failed", run.job)
        run.finished_at = datetime.now(timezone.utc)
        db.commit()
        db.refresh(run)
        return run


def run_job(session_factory: sessionmaker, job: str, trigger: str = "cli") -> SyncRun:
    with session_factory() as db:
        run_id = claim(db, job, trigger)
    return execute(session_factory, run_id)


def last_started(db: Session, job: str) -> Optional[datetime]:
    run = db.scalars(select(SyncRun).where(SyncRun.job == job).order_by(SyncRun.started_at.desc()).limit(1)).first()
    return _aware(run.started_at) if run else None


def run_out(run: SyncRun) -> Dict[str, Any]:
    return {
        "id": run.id,
        "job": run.job,
        "trigger": run.trigger,
        "status": run.status,
        "started_at": _aware(run.started_at).isoformat(),
        "finished_at": _aware(run.finished_at).isoformat() if run.finished_at else None,
        "detail": run.detail_json,
        "error": run.error,
    }


def _jsonable(v: Any) -> Any:
    if isinstance(v, dict):
        return {str(k): _jsonable(x) for k, x in v.items()}
    if isinstance(v, (list, tuple)):
        return [_jsonable(x) for x in v]
    if isinstance(v, (datetime, date)):
        return v.isoformat()
    return v
