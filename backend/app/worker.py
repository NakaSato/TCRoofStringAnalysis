"""Background worker: Growatt history sync + daily summary publishing.

Run one worker process only (docker-compose service `growatt-worker`), not inside uvicorn:
several API workers would each start a scheduler and multiply Growatt calls.

    PYTHONPATH=backend uv run python -m app.worker              # run the schedule forever
    PYTHONPATH=backend uv run python -m app.worker --once history
    PYTHONPATH=backend uv run python -m app.worker --list       # schedule + last runs

Schedule (plant-local time, Asia/Bangkok):
    history            every WORKER_HISTORY_INTERVAL_MIN (10) min  incremental max_data pull,
                       and at 08:47 / 12:47 / 16:47 so each PWA check's readings are in
    backfill           02:00   re-read the previous two days (late uploads)
    fleet              05:30   plant / inverter registry
    power_limits       10:40   each inverter's active power limit (readPower; daylight only:
                               it is read from the inverter through the datalogger)
    growatt_energy     00:50   Growatt's own figures for finished days: plant/energy (last 7 days),
                               plant/power curve and inverter day_energy (days not stored yet)
    energy_backfill    not scheduled: plant/energy for the last HISTORY_RETENTION_DAYS (queue once)
    publish_yesterday  06:00   finalize yesterday's daily summaries
    pwa_sheet          06:05   PWA Report Google Sheet: today's tab (skipped without PWA_SHEET_ID)
    publish_today      08:50 / 12:50 / 16:50   today so far, with each PWA check (09/13/17, a
                               snapshot at hh:00 − CHECK_OFFSET_MIN, check_slots.py); also fills
                               those checks into the PWA Report sheet (when PWA_SHEET_ID is set)
                       19:30   publish today after sunset
    retention          03:00   delete raw readings older than HISTORY_RETENTION_DAYS (90), string
                               readings older than HISTORY_STRING_RETENTION_DAYS (30), whole
                               max_data records older than HISTORY_RAW_RETENTION_DAYS (7)
    google_weather     18:15   Google Maps Weather: today's 06–17 h hourly (13 h lookback), one call per
                               plant cell; then re-publishes yesterday's daily docs
    alarms             every WORKER_ALARMS_TICK_MIN (10) min, WORKER_ALARMS_START_H..END_H (05–20),
                               not 08:42–08:51 / 12:42–12:51 / 16:42–16:51 (PWA history + publish):
                               today's alarm_data → SQL (Active Alarm page) for the inverters due
                               by tier: hot 10 min, warm 30 min, cold 60 min (growatt_alarms.Tiers)
                               then pushes the new alarm events of the logs it read (services/push.py)
    alarms_yesterday   00:30   yesterday's alarm log once more (evening alarms, late closings)
    push_test          not scheduled: queued by POST /push/test, sends the test notifications
    om_plans           00:40   Calendar Team recurring plans: planned tasks up to 90 days ahead
    om_reminders       18:00   Calendar Team: push "Tomorrow: …" to each person with planned work
                               starting tomorrow (services/om_reminders.py; off without push)
    om_weekly          Mon 07:30  Calendar Team: push each person's week and overdue count
    rules_yesterday    00:45   daily string / inverter rows for yesterday + decision rules (counts only),
                               then the EPI system factor of plants not fitted yet (services/epi_fit.py)
    rules_today        every WORKER_HISTORY_INTERVAL_MIN (10) min, 06–20: the same for today so far
    rules_backfill     not scheduled: daily rows for every stored day (queue once after deploy)
    epi_refit          not scheduled: every plant's EPI system factor fitted again, stored EPI rescaled
    env_history        every WORKER_ENV_INTERVAL_MIN (10) min, WORKER_ENV_START_H..END_H (05–20)
                               weather-sensor env_data only (0 = off); a `history` start counts as
                               one, since `history` syncs the sensors too
    inverter_latest    every WORKER_LATEST_INTERVAL_MIN (0 = off, at least 5) min,
                               WORKER_LATEST_START_H..END_H (05–20): each inverter's newest record
                               (maxs_data, 50 per call) into the history tables between `history` runs
    kb_ocr             every WORKER_KB_OCR_INTERVAL_MIN (30, 0 = off) min, and queued by each
                               Knowledge Base upload with pages that have no text layer: tesseract
                               OCR of those pages (KB_OCR_PAGES_PER_RUN at most; no Growatt calls)
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
from app.logging_db import setup_logging
from app.db.models import GrowattInverter, GrowattPlant
from app.db.session import SessionLocal, ensure_schema
from app.services import jobs
from app.services import check_slots
from app.services.check_slots import CHECK_HOURS as PWA_CHECK_HOURS

log = logging.getLogger("worker")

GRACE = timedelta(hours=3)
TICK_S = 60
# `power_limits` (readPower) needs the inverters running: mid-morning, and with GRACE it can
# still start up to 13:40 when the worker was busy, all in daylight
POWER_LIMITS_AT = (10, 40)
REGISTRY_RETRY = timedelta(minutes=15)
UNTAGGED_RETRY = timedelta(hours=6)  # bounded: a plant no account lists stays untagged
# after a `fleet` run that did not finish ok (an account failed, e.g. Growatt 10012, or the run was
# abandoned): its plants keep a stale registry and no weather sensors until fleet succeeds
FLEET_RETRY = timedelta(hours=6)
ALARMS_PWA_GAP_MIN = 5  # no `alarms` start this many minutes before a PWA history pull


@dataclass(frozen=True)
class Schedule:
    job: str
    every: Optional[timedelta] = None
    at: Optional[dtime] = None
    # `every` jobs only: plant-local hours [start, end) the job may start in
    between: Optional[Tuple[int, int]] = None
    # `every` jobs only: other jobs whose start also counts as a run of this one (they do its work too)
    covered_by: Tuple[str, ...] = ()
    # `every` jobs only: plant-local [from, to) windows the job does not start in
    skip: Tuple[Tuple[dtime, dtime], ...] = ()
    # `at` jobs only: plant-local weekdays (0 = Monday) the job runs on; None = every day
    weekdays: Optional[Tuple[int, ...]] = None

    def is_due(self, now: datetime, last: Optional[datetime]) -> bool:
        """`now` and `last` are timezone-aware."""
        if self.every is not None:
            local = now.astimezone(jobs.PLANT_TZ)
            if self.between is not None and not (self.between[0] <= local.hour < self.between[1]):
                return False
            t = local.time()
            if any(a <= t < b for a, b in self.skip):
                return False
            return last is None or now - last >= self.every
        assert self.at is not None
        local = now.astimezone(jobs.PLANT_TZ)
        slot = local.replace(hour=self.at.hour, minute=self.at.minute, second=0, microsecond=0)
        if self.weekdays is not None and slot.weekday() not in self.weekdays:
            return False
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
        # each PWA check is a snapshot at hh:00 − CHECK_OFFSET_MIN (08:50): fresh history
        # PWA_HISTORY_LEAD_MIN before it (08:47), then publish today so far (and fill the sheet) at 08:50
        *(Schedule("history", at=check_slots.history_clock(h)) for h in PWA_CHECK_HOURS),
        *(Schedule("publish_today", at=check_slots.publish_clock(h)) for h in PWA_CHECK_HOURS),
        Schedule("publish_today", at=dtime(19, 30)),
        Schedule("pwa_sheet", at=dtime(6, 5)),
        Schedule("retention", at=dtime(3, 0)),
        Schedule("google_weather", at=dtime(18, 15)),
        # daylight, between the 10:30 history pull and 11:00; not near a PWA check (hh:20–hh:31)
        Schedule("power_limits", at=dtime(*POWER_LIMITS_AT)),
        Schedule(
            "alarms",
            every=timedelta(minutes=settings.worker_alarms_tick_min),
            between=(settings.worker_alarms_start_h, settings.worker_alarms_end_h),
            # keep the worker free for each PWA check's history pull (08:47) and publish (08:50)
            skip=tuple(
                (
                    check_slots.clock(h, timedelta(minutes=settings.pwa_history_lead_min + ALARMS_PWA_GAP_MIN)),
                    check_slots.clock(h, timedelta(minutes=-1)),
                )
                for h in PWA_CHECK_HOURS
            ),
        ),
        Schedule("alarms_yesterday", at=dtime(0, 30)),
        # Calendar Team recurring plans → planned tasks 90 days ahead (DB only, no Growatt calls)
        Schedule("om_plans", at=dtime(0, 40)),
        Schedule("om_reminders", at=dtime(18, 0)),
        Schedule("om_weekly", at=dtime(7, 30), weekdays=(0,)),
        Schedule("rules_yesterday", at=dtime(0, 45)),
        # Growatt's own figures for yesterday, after its late alarms / rules; done long before 05:30 fleet
        Schedule("growatt_energy", at=dtime(0, 50)),
        # right behind `history` in the list: when both are due in a tick, the rules see the new records
        Schedule("rules_today", every=timedelta(minutes=settings.worker_history_interval_min), between=(6, 20)),
        *(
            [
                Schedule(
                    "env_history",
                    every=timedelta(minutes=settings.worker_env_interval_min),
                    between=(settings.worker_env_start_h, settings.worker_env_end_h),
                    covered_by=("history",),
                )
            ]
            if settings.worker_env_interval_min > 0
            else []
        ),
        *(
            [
                Schedule(
                    "inverter_latest",
                    every=timedelta(minutes=max(jobs.LATEST_MIN_INTERVAL_MIN, settings.worker_latest_interval_min)),
                    between=(settings.worker_latest_start_h, settings.worker_latest_end_h),
                )
            ]
            if settings.worker_latest_interval_min > 0
            else []
        ),
        *([Schedule("kb_ocr", every=timedelta(minutes=settings.worker_kb_ocr_interval_min))] if settings.worker_kb_ocr_interval_min > 0 else []),
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


def _last_start(db, s: Schedule) -> Optional[datetime]:
    """When the job (or one of the jobs covering it) last started."""
    starts = [t for t in (jobs.last_started(db, j) for j in (s.job, *s.covered_by)) if t is not None]
    return max(starts) if starts else None


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
            last = _last_start(db, s)
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
    with SessionLocal() as db:
        ensure_schema(db.get_bind())  # before the DB log handler: app_logs must exist
    setup_logging("worker")
    with SessionLocal() as db:  # a newly blocked plant leaves the registry now, not at the next `fleet` run
        from app.services.growatt_sync import remove_blocked_plants

        remove_blocked_plants(db, settings.blocked_plant_ids())

    schedule = default_schedule()
    if args.list:
        with SessionLocal() as db:
            for s in schedule:
                days = "daily" if not s.weekdays else ",".join(("Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun")[d] for d in s.weekdays)
                when = f"every {s.every}" if s.every else f"{days} {s.at:%H:%M}"
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
