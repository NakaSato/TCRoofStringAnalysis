"""Background worker: Growatt history sync + daily summary publishing.

Run one worker process only (docker-compose service `growatt-worker`), not inside uvicorn:
several API workers would each start a scheduler and multiply Growatt calls.

    PYTHONPATH=backend uv run python -m app.worker              # run the schedule forever
    PYTHONPATH=backend uv run python -m app.worker --once history
    PYTHONPATH=backend uv run python -m app.worker --list       # schedule + last runs

Schedule (plant-local time, Asia/Bangkok):
    history            every WORKER_HISTORY_INTERVAL_MIN (30) min  incremental max_data pull
    backfill           02:00   re-read the previous two days (late uploads)
    fleet              05:30   plant / inverter registry
    publish_yesterday  06:00   finalize yesterday's daily summaries
    publish_today      09:45, 13:45, 17:45   today so far, after each O&M check (09 / 13 / 17:00), so the
                               PWA report sheet can fill each check the same day; 19:30 the full day
    retention          03:00   delete raw readings older than HISTORY_RETENTION_DAYS (90)
    google_weather     18:15   Google Maps Weather: previous 24 h hourly (incl. 17:00), one call per
                               plant cell; then re-publishes yesterday's daily docs
    alarms             every WORKER_ALARMS_INTERVAL_MIN (30) min, WORKER_ALARMS_START_H..END_H (05–21)
                               today's alarm_data per inverter → SQL (Active Alarm page)
    alarms_yesterday   00:30   yesterday's alarm log once more (evening alarms, late closings)
Runs queued from the API (`POST /growatt/sync/{job}`) start on the next tick (≤ 1 min).
Daily jobs only fire within `GRACE` after their slot, so a worker started at noon does not
publish a half day. Exception: `fleet` also runs at once when the inverter registry is empty
(fresh database), otherwise `history` would have nothing to sync until 05:30, and every
UNTAGGED_RETRY while plants have no project phase yet (e.g. right after phase tokens were
added), so live calls reach the right Growatt account the same day. Last-run times come from `sync_runs`, so restarts don't re-run jobs.
"""

from __future__ import annotations

import argparse
import logging
import signal
import time
from dataclasses import dataclass
from datetime import datetime, time as dtime, timedelta
from typing import List, Optional, Tuple

from sqlalchemy import select

from app.config import settings
from app.db.models import GrowattInverter, GrowattPlant
from app.db.session import SessionLocal, ensure_schema
from app.services import jobs

log = logging.getLogger("worker")

GRACE = timedelta(hours=3)
TICK_S = 60
REGISTRY_RETRY = timedelta(minutes=15)
UNTAGGED_RETRY = timedelta(hours=6)  # bounded: a plant no account lists stays untagged
# after a `fleet` run that did not finish ok (an account failed, e.g. Growatt 10012, or the run was
# abandoned): its plants keep a stale registry and no weather sensors until fleet succeeds
FLEET_RETRY = timedelta(hours=6)
PWA_CHECK_HOURS = (9, 13, 17)  # O&M check times; publish_today runs at hh:45 after each


@dataclass(frozen=True)
class Schedule:
    job: str
    every: Optional[timedelta] = None
    at: Optional[dtime] = None
    # `every` jobs only: plant-local hours [start, end) the job may start in
    between: Optional[Tuple[int, int]] = None

    def is_due(self, now: datetime, last: Optional[datetime]) -> bool:
        """`now` and `last` are timezone-aware."""
        if self.every is not None:
            if self.between is not None:
                h = now.astimezone(jobs.PLANT_TZ).hour
                if not (self.between[0] <= h < self.between[1]):
                    return False
            return last is None or now - last >= self.every
        assert self.at is not None
        local = now.astimezone(jobs.PLANT_TZ)
        slot = local.replace(hour=self.at.hour, minute=self.at.minute, second=0, microsecond=0)
        if not (slot <= local < slot + GRACE):
            return False
        return last is None or last < slot


def default_schedule() -> List[Schedule]:
    # `fleet` first: on an empty registry it runs before `history` in the same tick.
    return [
        Schedule("fleet", at=dtime(5, 30)),
        Schedule("history", every=timedelta(minutes=settings.worker_history_interval_min)),
        Schedule("backfill", at=dtime(2, 0)),
        Schedule("publish_yesterday", at=dtime(6, 0)),
        # one job, several slots: each slot runs once (last run < slot); docs are overwritten
        *(Schedule("publish_today", at=dtime(h, 45)) for h in PWA_CHECK_HOURS),
        Schedule("publish_today", at=dtime(19, 30)),
        Schedule("retention", at=dtime(3, 0)),
        Schedule("google_weather", at=dtime(18, 15)),
        Schedule(
            "alarms",
            every=timedelta(minutes=settings.worker_alarms_interval_min),
            between=(settings.worker_alarms_start_h, settings.worker_alarms_end_h),
        ),
        Schedule("alarms_yesterday", at=dtime(0, 30)),
    ]


def _registry_empty(db) -> bool:
    return db.scalar(select(GrowattInverter.device_sn).limit(1)) is None


def _has_untagged_plants(db) -> bool:
    return db.scalar(select(GrowattPlant.plant_id).where(GrowattPlant.phase.is_(None)).limit(1)) is not None


def _last_fleet_incomplete(db) -> bool:
    run = jobs.last_run(db, "fleet")
    return run is not None and run.status in ("partial", "failed")


def _bootstrap_due(job: str, db, now: datetime, last: Optional[datetime]) -> bool:
    """`fleet` also runs whenever the inverter registry is empty (fresh deploy), retrying every
    REGISTRY_RETRY if Growatt fails, so `history` is not idle until the next 05:30 slot; every
    UNTAGGED_RETRY while some plants have no phase yet; and every FLEET_RETRY while the last
    fleet run was partial / failed (one account rate-limited, or the run abandoned), since the
    05:30 slot alone can be missed while a long job holds the worker."""
    if job != "fleet":
        return False
    if _registry_empty(db):
        return last is None or now - last >= REGISTRY_RETRY
    if (last is None or now - last >= UNTAGGED_RETRY) and _has_untagged_plants(db):
        return True
    return last is not None and now - last >= FLEET_RETRY and _last_fleet_incomplete(db)


def tick(session_factory, schedule: List[Schedule], now: datetime) -> List[str]:
    """Run queued (API-requested) runs, then every due job once, sequentially. Returns the jobs started."""
    started = []
    with session_factory() as db:
        queued = jobs.claim_queued(db, now=now)
    for run_id in queued:
        run = jobs.execute(session_factory, run_id)
        log.info("%s (queued) → %s %s", run.job, run.status, run.error or run.detail_json)
        started.append(run.job)
    for s in schedule:
        with session_factory() as db:
            last = jobs.last_started(db, s.job)
            if not (s.is_due(now, last) or _bootstrap_due(s.job, db, now, last)):
                continue
            try:
                run_id = jobs.claim(db, s.job, "schedule", now=now)
            except jobs.JobBusy as exc:
                log.info("skip %s: %s", s.job, exc)
                continue
        run = jobs.execute(session_factory, run_id)
        log.info("%s → %s %s", s.job, run.status, run.error or run.detail_json)
        started.append(s.job)
    return started


def main(argv: Optional[List[str]] = None) -> int:
    ap = argparse.ArgumentParser(description="Growatt sync + daily summary worker")
    ap.add_argument("--once", choices=sorted(jobs.JOBS), help="Run one job now and exit")
    ap.add_argument("--list", action="store_true", help="Show schedule and last runs")
    args = ap.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")

    with SessionLocal() as db:
        ensure_schema(db.get_bind())

    schedule = default_schedule()
    if args.list:
        with SessionLocal() as db:
            for s in schedule:
                when = f"every {s.every}" if s.every else f"daily {s.at:%H:%M}"
                print(f"{s.job:18} {when:22} last start: {jobs.last_started(db, s.job)}")
        return 0
    if args.once:
        run = jobs.run_job(SessionLocal, args.once, trigger="cli")
        print(jobs.run_out(run))
        return 0 if run.status == "ok" else 1

    stop = False

    def _stop(*_):
        nonlocal stop
        stop = True

    signal.signal(signal.SIGTERM, _stop)
    signal.signal(signal.SIGINT, _stop)
    log.info("worker started; publish sink=%s", settings.publish_sink)
    with SessionLocal() as db:
        if abandoned := jobs.fail_abandoned(db):
            log.warning("marked runs %s abandoned (left running by the previous worker)", abandoned)
    while not stop:
        tick(SessionLocal, schedule, datetime.now(jobs.PLANT_TZ))
        for _ in range(TICK_S):
            if stop:
                break
            time.sleep(1)
    log.info("worker stopped")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
