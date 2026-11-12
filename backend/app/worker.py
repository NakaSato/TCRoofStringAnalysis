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
    publish_today      19:30   publish today after sunset
Daily jobs only fire within `GRACE` after their slot, so a worker started at noon does not
publish a half day. Last-run times come from `sync_runs`, so restarts don't re-run jobs.
"""

from __future__ import annotations

import argparse
import logging
import signal
import time
from dataclasses import dataclass
from datetime import datetime, time as dtime, timedelta
from typing import List, Optional

from app.config import settings
from app.db.session import Base, SessionLocal
from app.services import jobs

log = logging.getLogger("worker")

GRACE = timedelta(hours=3)
TICK_S = 60


@dataclass(frozen=True)
class Schedule:
    job: str
    every: Optional[timedelta] = None
    at: Optional[dtime] = None

    def is_due(self, now: datetime, last: Optional[datetime]) -> bool:
        """`now` and `last` are timezone-aware."""
        if self.every is not None:
            return last is None or now - last >= self.every
        assert self.at is not None
        local = now.astimezone(jobs.PLANT_TZ)
        slot = local.replace(hour=self.at.hour, minute=self.at.minute, second=0, microsecond=0)
        if not (slot <= local < slot + GRACE):
            return False
        return last is None or last < slot


def default_schedule() -> List[Schedule]:
    return [
        Schedule("history", every=timedelta(minutes=settings.worker_history_interval_min)),
        Schedule("backfill", at=dtime(2, 0)),
        Schedule("fleet", at=dtime(5, 30)),
        Schedule("publish_yesterday", at=dtime(6, 0)),
        Schedule("publish_today", at=dtime(19, 30)),
    ]


def tick(session_factory, schedule: List[Schedule], now: datetime) -> List[str]:
    """Run every due job once, sequentially. Returns the jobs started."""
    started = []
    for s in schedule:
        with session_factory() as db:
            if not s.is_due(now, jobs.last_started(db, s.job)):
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
        Base.metadata.create_all(bind=db.get_bind())

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
