"""Background jobs shared by the worker (`app.worker`) and the `/growatt/sync` API.

Each run is recorded in `sync_runs`, which doubles as a per-job lock: while a run is
`running` (and younger than `STALE_AFTER`), another run of the same job is refused.

Jobs only ever execute in the worker. The API *queues* a run (`status = queued`) and the
worker picks it up on its next tick (≤ 1 min): on Cloud Run a request's background task loses
its CPU after the response and the instance can scale to zero mid-job.
"""

from __future__ import annotations

import logging
from dataclasses import asdict
from datetime import date, datetime, timedelta, timezone
from typing import Any, Callable, Dict, List, Optional, Tuple, overload
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


class NoGrowattAccount(RuntimeError):
    pass


def _clients() -> Dict[int, GrowattClient]:
    """One client per project phase / Growatt account, ascending by phase."""
    accounts = settings.growatt_accounts()
    if not accounts:
        raise NoGrowattAccount("No Growatt token configured (GROWATT_TOKEN_PHASE1..4 or GROWATT_API_TOKEN)")
    return {
        phase: GrowattClient(token=token, base_url=settings.growatt_base_url, timeout=60)
        for phase, token in accounts.items()
    }


def _per_phase(
    db: Session, fn: Callable[[Session, GrowattClient, int, bool], Dict[str, Any]]
) -> Tuple[str, Dict[str, Any]]:
    """Run `fn(db, client, phase, include_untagged)` for every account; one failing account
    does not stop the others. Plants without a phase yet go with the first account.

    Detail: totals summed over phases plus `phases: {phase: detail | {"error": ...}}`.
    """
    clients = _clients()
    first = min(clients)
    per: Dict[str, Any] = {}
    totals: Dict[str, Any] = {}
    errors = 0
    for phase, client in clients.items():
        try:
            d = fn(db, client, phase, phase == first)
        except Exception as exc:  # keep going with the other accounts
            db.rollback()
            errors += 1
            per[str(phase)] = {"error": f"{type(exc).__name__}: {exc}"}
            log.exception("phase %s failed", phase)
            continue
        per[str(phase)] = d
        for k, v in d.items():
            if isinstance(v, (int, float)) and not isinstance(v, bool):
                totals[k] = totals.get(k, 0) + v
            elif isinstance(v, list):
                totals[k] = totals.get(k, []) + v
    if errors == len(clients):
        raise RuntimeError("; ".join(f"phase {p}: {d['error']}" for p, d in per.items()))
    totals["phases"] = per
    partial = errors > 0 or bool(totals.get("failed"))
    return ("partial" if partial else "ok"), totals


def _today() -> date:
    return datetime.now(PLANT_TZ).date()


# --------------------------------------------------------------------------- job bodies
# Each returns (status, detail). status: ok | partial.


def job_history(db: Session) -> Tuple[str, Dict[str, Any]]:
    from app.services.growatt_sync import sync_incremental

    today = _today()
    return _per_phase(
        db, lambda db, c, phase, untagged: sync_incremental(db, c, today, phase=phase, include_untagged=untagged)
    )


def job_backfill(db: Session) -> Tuple[str, Dict[str, Any]]:
    """Re-read the previous two full days to catch uploads that arrived late."""
    from app.services.growatt_sync import sync_all_history

    today = _today()
    start, end = today - timedelta(days=2), today - timedelta(days=1)
    return _per_phase(
        db,
        lambda db, c, phase, untagged: sync_all_history(db, c, start, end, phase=phase, include_untagged=untagged),
    )


def job_fleet(db: Session) -> Tuple[str, Dict[str, Any]]:
    from app.services.growatt_sync import sync_fleet

    return _per_phase(db, lambda db, c, phase, _untagged: {"inverters": len(sync_fleet(db, c, phase=phase))})


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


def job_retention(db: Session) -> Tuple[str, Dict[str, Any]]:
    """Delete raw readings older than HISTORY_RETENTION_DAYS (daily summaries are kept)."""
    from app.services.growatt_sync import prune_history

    return "ok", prune_history(db, _today(), settings.history_retention_days)


JOBS: Dict[str, Callable[[Session], Tuple[str, Dict[str, Any]]]] = {
    "history": job_history,
    "backfill": job_backfill,
    "fleet": job_fleet,
    "publish_today": job_publish_today,
    "publish_yesterday": job_publish_yesterday,
    "retention": job_retention,
}


# --------------------------------------------------------------------------- run log / lock


def _check_free(db: Session, job: str, now: datetime, ignore_id: Optional[int] = None) -> None:
    """Raise JobBusy while a live running/queued run exists; fail stale ones."""
    for run in db.scalars(select(SyncRun).where(SyncRun.job == job, SyncRun.status.in_(("running", "queued")))):
        if run.id == ignore_id:
            continue
        if now - _aware(run.started_at) < STALE_AFTER:
            raise JobBusy(f"{job} is already {run.status} (run {run.id}, since {run.started_at:%Y-%m-%d %H:%M})")
        _fail_stale(run, now)


def _fail_stale(run: SyncRun, now: datetime) -> None:
    run.error = (
        "abandoned (worker stopped mid-run)" if run.status == "running" else "never picked up (is the worker running?)"
    )
    run.status, run.finished_at = "failed", now


def _utc(now: Optional[datetime]) -> datetime:
    # Always store UTC: SQLite drops tzinfo, and `_aware` reads naive values back as UTC.
    return (now or datetime.now(timezone.utc)).astimezone(timezone.utc)


def claim(db: Session, job: str, trigger: str, now: Optional[datetime] = None) -> int:
    """Record a new `running` run, or raise JobBusy if one is already running or queued."""
    if job not in JOBS:
        raise KeyError(job)
    now = _utc(now)
    _check_free(db, job, now)
    run = SyncRun(job=job, trigger=trigger, status="running", started_at=now)
    db.add(run)
    db.commit()
    return run.id


def enqueue(db: Session, job: str, trigger: str = "api", now: Optional[datetime] = None) -> int:
    """Queue a run for the worker (`started_at` = when it was requested)."""
    if job not in JOBS:
        raise KeyError(job)
    now = _utc(now)
    _check_free(db, job, now)
    run = SyncRun(job=job, trigger=trigger, status="queued", started_at=now)
    db.add(run)
    db.commit()
    return run.id


def claim_queued(db: Session, now: Optional[datetime] = None) -> List[int]:
    """Worker side: turn queued runs (oldest first) into running ones. Returns their ids."""
    now = _utc(now)
    ids: List[int] = []
    for run in list(db.scalars(select(SyncRun).where(SyncRun.status == "queued").order_by(SyncRun.id))):
        if run.job not in JOBS:
            run.status, run.finished_at, run.error = "failed", now, f"unknown job {run.job!r}"
            continue
        if now - _aware(run.started_at) >= STALE_AFTER:
            _fail_stale(run, now)
            continue
        try:
            _check_free(db, run.job, now, ignore_id=run.id)
        except JobBusy:
            continue  # the same job is running now; this one waits for the next tick
        run.status, run.started_at = "running", now
        ids.append(run.id)
    db.commit()
    return ids


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
