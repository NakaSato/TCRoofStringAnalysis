"""Background jobs shared by the worker (`app.worker`) and the `/growatt/sync` API.

Each run is recorded in `sync_runs`, which doubles as a per-job lock: while a run is
`running` (and younger than `STALE_AFTER`), another run of the same job is refused.

Jobs only ever execute in the worker. The API *queues* a run (`status = queued`) and the
worker picks it up on its next tick (≤ 1 min): on Cloud Run a request's background task loses
its CPU after the response and the instance can scale to zero mid-job.
"""

from __future__ import annotations

import contextvars
import logging
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import asdict
from datetime import date, datetime, timedelta, timezone
from typing import Any, Callable, Dict, List, Optional, Tuple, overload
from zoneinfo import ZoneInfo

from sqlalchemy import or_, select
from sqlalchemy.orm import Session, sessionmaker

from app import logging_db
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
        phase: GrowattClient(
            token=token, base_url=settings.growatt_base_url, timeout=60, blocked_plant_ids=settings.blocked_plant_ids()
        )
        for phase, token in accounts.items()
    }


def _per_phase(
    db: Session, fn: Callable[[Session, GrowattClient, int, bool], Dict[str, Any]]
) -> Tuple[str, Dict[str, Any]]:
    """Run `fn(db, client, phase, include_untagged)` for every account; one failing account
    does not stop the others. Plants without a phase yet go with the first account.

    Each account gets its own session and, with `worker_parallel_accounts`, its own thread:
    the accounts touch disjoint plants/inverters and Growatt rate-limits per token.

    Detail: totals summed over phases plus `phases: {phase: detail | {"error": ...}}`.
    """
    clients = _clients()
    first = min(clients)
    new_session = sessionmaker(bind=db.get_bind(), autoflush=False, expire_on_commit=False)

    def run(phase: int, client: GrowattClient) -> Dict[str, Any]:
        t0 = time.monotonic()
        with new_session() as s:
            try:
                d = fn(s, client, phase, phase == first)
            except Exception as exc:  # keep going with the other accounts
                s.rollback()
                log.exception("phase %s failed", phase)
                return {"error": f"{type(exc).__name__}: {exc}"}
        log.info("phase %s done in %.0f s", phase, time.monotonic() - t0)
        return d

    if settings.worker_parallel_accounts and len(clients) > 1:
        with ThreadPoolExecutor(max_workers=len(clients), thread_name_prefix="growatt") as pool:
            # each thread gets a copy of the context, so phase logs keep the job's run id
            futures = {
                phase: pool.submit(contextvars.copy_context().run, run, phase, client) for phase, client in clients.items()
            }
            results = {phase: f.result() for phase, f in futures.items()}
    else:
        results = {phase: run(phase, client) for phase, client in clients.items()}

    per: Dict[str, Any] = {}
    totals: Dict[str, Any] = {}
    errors = 0
    for phase, d in results.items():
        per[str(phase)] = d
        if "error" in d:
            errors += 1
            continue
        for k, v in d.items():
            if isinstance(v, (int, float)) and not isinstance(v, bool):
                totals[k] = totals.get(k, 0) + v
            elif isinstance(v, list):
                totals[k] = totals.get(k, []) + v
    if errors == len(clients):
        raise RuntimeError("; ".join(f"phase {p}: {d['error']}" for p, d in per.items()))
    totals["phases"] = per
    partial = errors > 0 or bool(totals.get("failed")) or bool(totals.get("env_failed"))
    return ("partial" if partial else "ok"), totals


def _today() -> date:
    return datetime.now(PLANT_TZ).date()


# --------------------------------------------------------------------------- job bodies
# Each returns (status, detail). status: ok | partial.


def job_history(db: Session) -> Tuple[str, Dict[str, Any]]:
    """New inverter/string, weather-sensor and energy-meter records since the last run."""
    from app.services.growatt_sync import sync_env_incremental, sync_incremental, sync_meter_incremental

    today = _today()
    return _per_phase(
        db,
        lambda db, c, phase, untagged: {
            **sync_incremental(
                db, c, today, phase=phase, include_untagged=untagged, batch_size=settings.worker_history_batch_size
            ),
            **sync_env_incremental(db, c, today, phase=phase, include_untagged=untagged),
            # last: a rate-limited meter sweep stops early and never delays inverter history
            **sync_meter_incremental(db, c, today, phase=phase, include_untagged=untagged),
        },
    )


def job_env_history(db: Session) -> Tuple[str, Dict[str, Any]]:
    """Weather-sensor records only, more often than `history` (daytime), so the stored day's
    irradiance, peak and insolation lag the sensor by minutes instead of up to half an hour.
    No retries on 10012: 3 in a row end the account's sweep (run `partial`); the next run
    starts with the sensors stored longest ago."""
    from app.services.growatt_sync import MAX_RATE_LIMITED, sync_env_incremental

    today = _today()
    return _per_phase(
        db,
        lambda db, c, phase, untagged: sync_env_incremental(
            db, c, today, phase=phase, include_untagged=untagged, retries=0, max_rate_limited=MAX_RATE_LIMITED
        ),
    )


LATEST_MIN_INTERVAL_MIN = 5  # `maxs_data` answers an account again only about 5 min after a sweep


def job_inverter_latest(db: Session) -> Tuple[str, Dict[str, Any]]:
    """Each inverter's newest record of today (`maxs_data`, 50 inverters per call) into the
    history tables, between `history` runs, so stored data lags Growatt by one record instead of
    up to a `history` interval. The first 10012 ends an account's sweep (run `partial`); the
    starting chunk moves on with every interval, so the next run reads what this one missed."""
    from app.services.growatt_sync import sync_latest_records

    now = datetime.now(PLANT_TZ)
    turn = (now.hour * 60 + now.minute) // max(LATEST_MIN_INTERVAL_MIN, settings.worker_latest_interval_min)
    today = _today()
    return _per_phase(
        db,
        lambda db, c, phase, untagged: sync_latest_records(
            db, c, today, phase=phase, include_untagged=untagged, first_chunk=turn
        ),
    )


def job_power_limits(db: Session) -> Tuple[str, Dict[str, Any]]:
    """Each inverter's active power limit (`readPower`), once a day in daylight: the read goes
    through the datalogger to the inverter, which answers only while it is running."""
    from app.services.growatt_sync import sync_power_limits

    return _per_phase(
        db, lambda db, c, phase, untagged: sync_power_limits(db, c, phase=phase, include_untagged=untagged)
    )


def job_growatt_energy(db: Session) -> Tuple[str, Dict[str, Any]]:
    """Growatt's own figures for finished days: each plant's daily kWh (`plant/energy`, last
    7 days), its 5-minute curve (`plant/power`) and each inverter's kWh (`day_energy`) for the
    days not stored yet. Never today (realtime)."""
    from app.services.growatt_energy import sync_growatt_energy

    today = _today()
    return _per_phase(
        db, lambda db, c, phase, untagged: sync_growatt_energy(db, c, today, phase=phase, include_untagged=untagged)
    )


def job_energy_backfill(db: Session) -> Tuple[str, Dict[str, Any]]:
    """Growatt's daily kWh (`plant/energy`) for the last HISTORY_RETENTION_DAYS finished days of
    every plant missing some (not scheduled: queue once after deploy)."""
    from app.services.growatt_energy import backfill_plant_energy

    today = _today()
    return _per_phase(
        db,
        lambda db, c, phase, untagged: backfill_plant_energy(
            db, c, today, days=settings.history_retention_days, phase=phase, include_untagged=untagged
        ),
    )


def job_backfill(db: Session) -> Tuple[str, Dict[str, Any]]:
    """Re-read the previous two full days to catch uploads that arrived late."""
    from app.services.growatt_sync import sync_all_history, sync_env_all, sync_meter_all

    today = _today()
    start, end = today - timedelta(days=2), today - timedelta(days=1)
    return _per_phase(
        db,
        lambda db, c, phase, untagged: {
            **sync_all_history(db, c, start, end, phase=phase, include_untagged=untagged),
            **sync_env_all(db, c, start, end, phase=phase, include_untagged=untagged),
            **sync_meter_all(db, c, start, end, phase=phase, include_untagged=untagged),
        },
    )


def alarm_tiers() -> Any:
    from app.services.growatt_alarms import Tiers

    return Tiers(
        hot=timedelta(minutes=settings.worker_alarms_hot_min),
        warm=timedelta(minutes=settings.worker_alarms_warm_min),
        cold=timedelta(minutes=settings.worker_alarms_cold_min),
        tick=timedelta(minutes=settings.worker_alarms_tick_min),
    )


def _alarms(db: Session, day: date, tiered: bool = False) -> Tuple[str, Dict[str, Any]]:
    from app.services.growatt_alarms import sync_alarms
    from app.services.growatt_sync import _inverters_query

    tiers = alarm_tiers() if tiered else None

    def one(db: Session, c: GrowattClient, phase: int, untagged: bool) -> Dict[str, Any]:
        return sync_alarms(db, c, day, list(db.scalars(_inverters_query(phase, untagged))), tiers=tiers)

    status, detail = _per_phase(db, one)
    detail["day"] = day.isoformat()
    return status, detail


def job_alarms(db: Session) -> Tuple[str, Dict[str, Any]]:
    """Today's Growatt alarm log → SQL (replaces each inverter-day), only the inverters due by
    tier: hot (open alarm / fault status) often, cold (no alarms today) rarely."""
    started = datetime.now(timezone.utc)
    status, detail = _alarms(db, _today(), tiered=True)
    detail["push"] = _push(db, lambda push: {**push.notify_new_alarms(db, _today(), started), **push.send_tests(db)})
    return status, detail


def _push(db: Session, fn: Callable[[Any], Dict[str, Any]]) -> Dict[str, Any]:
    """Alarm push notifications (services/push.py). Trouble there is reported in the run detail
    and never fails the job it follows."""
    from app.services import push

    try:
        return fn(push)
    except Exception as exc:  # noqa: BLE001 - FCM / credentials trouble must not undo a sync
        db.rollback()
        log.exception("push notifications failed")
        return {"error": f"{type(exc).__name__}: {exc}"}


def job_push_test(db: Session) -> Tuple[str, Dict[str, Any]]:
    """Test notifications asked for from the UI (POST /push/test queues this)."""
    detail = _push(db, lambda push: push.send_tests(db))
    return ("partial" if "error" in detail or detail.get("failed") else "ok"), detail


def job_alarms_yesterday(db: Session) -> Tuple[str, Dict[str, Any]]:
    """Yesterday's alarm log once more after midnight: evening alarms and late closings."""
    return _alarms(db, _today() - timedelta(days=1))


def job_fleet(db: Session) -> Tuple[str, Dict[str, Any]]:
    from app.services.growatt_sync import remove_blocked_plants, sync_fleet

    remove_blocked_plants(db, settings.blocked_plant_ids())
    return _per_phase(db, lambda db, c, phase, _untagged: {"inverters": len(sync_fleet(db, c, phase=phase))})


def _publish(db: Session, day: date) -> Tuple[str, Dict[str, Any]]:
    from app.services import daily_summary

    rep = daily_summary.run(db, [day], daily_summary.make_sink(settings.publish_sink))
    detail = asdict(rep)
    detail["day"] = day.isoformat()
    return ("partial" if rep.over_budget or rep.too_large else "ok"), detail


def _pwa_sheet(now: datetime, db: Session) -> Optional[Dict[str, Any]]:
    """Today's tab of the PWA Report Google Sheet, checks published so far. Errors are reported
    in the run detail instead of failing the publish."""
    from app.services import pwa_sheet

    try:
        return pwa_sheet.run_for_now(db, now)
    except Exception as exc:  # noqa: BLE001 - sheet trouble must not undo a publish
        log.exception("PWA sheet fill failed")
        return {"error": f"{type(exc).__name__}: {exc}"}


def job_publish_today(db: Session) -> Tuple[str, Dict[str, Any]]:
    status, detail = _publish(db, _today())
    sheet = _pwa_sheet(datetime.now(PLANT_TZ), db)
    if sheet is not None:
        detail["pwa_sheet"] = sheet
        if "error" in sheet:
            status = "partial"
    return status, detail


def job_pwa_sheet(db: Session) -> Tuple[str, Dict[str, Any]]:
    """PWA Report Google Sheet: today's tab (created if missing) with the checks published so far."""
    sheet = _pwa_sheet(datetime.now(PLANT_TZ), db)
    if sheet is None:
        return "ok", {"skipped": "PWA_SHEET_ID not set"}
    return ("failed" if "error" in sheet else "ok"), sheet


def job_publish_yesterday(db: Session) -> Tuple[str, Dict[str, Any]]:
    return _publish(db, _today() - timedelta(days=1))


def job_retention(db: Session) -> Tuple[str, Dict[str, Any]]:
    """Delete raw readings and alarm logs older than HISTORY_RETENTION_DAYS (daily summaries are
    kept), and app logs older than LOG_RETENTION_DAYS or beyond LOG_MAX_ROWS."""
    from app.services.system_logs import prune_logs
    from app.services import google_weather
    from app.services.growatt_alarms import prune_alarms
    from app.services.growatt_energy import prune_plant_power
    from app.services.growatt_sync import prune_history, prune_raw

    detail = prune_history(db, _today(), settings.history_retention_days)
    detail["raw_rows"] = prune_raw(db, _today(), min(settings.history_raw_retention_days, settings.history_retention_days))
    detail["google_weather_rows"] = google_weather.prune(db, _today(), settings.history_retention_days)
    detail["alarm_rows"] = prune_alarms(db, _today(), settings.history_retention_days)
    from app.services import check_slots

    detail["pwa_check_slots"] = check_slots.prune(db, _today(), settings.history_retention_days)
    detail["growatt_power_rows"] = prune_plant_power(db, _today(), settings.history_retention_days)
    from app.services import push

    detail["alarm_push_marks"] = push.prune(db, _today())
    detail["log_rows"] = prune_logs(db, datetime.now(timezone.utc), settings.log_retention_days, settings.log_max_rows)
    return "ok", detail


def job_google_weather(db: Session) -> Tuple[str, Dict[str, Any]]:
    """Past 24 h of Google Maps Weather (hourly, modelled) for every plant grid cell."""
    from app.services import google_weather

    status, detail = google_weather.run_history_job(db)
    if detail.get("hours_stored"):
        # Yesterday's 18:00–23:00 hours only arrive now: re-publish its daily docs (only docs
        # whose content changed are written). Today's slots go out with publish_today (19:30).
        pub_status, pub = _publish(db, _today() - timedelta(days=1))
        detail["republished_yesterday"] = {k: pub[k] for k in ("written", "unchanged", "over_budget")}
        if pub_status != "ok":
            status = "partial"
    return status, detail


def _rules(db: Session, day: date, close: bool = True) -> Tuple[str, Dict[str, Any]]:
    """Daily string / inverter rows for `day`, the decision rules over them, then the Issues
    queue (docs/plans/decision-rules.md §3.4, §4.2). `close`: auto-close issues whose rule stayed
    quiet (past days only; today is partial). Nothing is published."""
    from app.services import growatt_daily, growatt_issues, growatt_rules, tariff

    pr = tariff.pricer(db)
    detail = growatt_daily.compute_day(db, day)
    findings = growatt_rules.evaluate(db, day, pricer=pr)
    detail["rules"] = growatt_rules.summarize(findings)
    detail["issues"] = growatt_issues.sync(db, day, findings, close=close)
    return ("partial" if detail["failed"] else "ok"), detail


def job_rules_today(db: Session) -> Tuple[str, Dict[str, Any]]:
    """Today so far, after each `history` pull, so an open string or a down inverter shows the same day."""
    return _rules(db, _today(), close=False)


def _epi_fit(db: Session, detail: Dict[str, Any], end: date, refit: bool = False) -> None:
    """Fit plants' EPI system factors into `detail["epi_fit"]`; never fails the rules run."""
    from app.services import epi_fit

    try:
        detail["epi_fit"] = epi_fit.fit(db, end, refit=refit)
    except Exception as exc:  # noqa: BLE001 - a modelled factor must not undo the day's rows
        db.rollback()
        log.exception("EPI system factor fit failed")
        detail["epi_fit"] = {"error": f"{type(exc).__name__}: {exc}"}


def job_rules_yesterday(db: Session) -> Tuple[str, Dict[str, Any]]:
    """Yesterday in full, after `alarms_yesterday` (00:30) stored its late alarms; then fits the
    EPI system factor of plants that have none yet (services/epi_fit.py)."""
    yesterday = _today() - timedelta(days=1)
    status, detail = _rules(db, yesterday)
    _epi_fit(db, detail, yesterday)
    return status, detail


def job_epi_refit(db: Session) -> Tuple[str, Dict[str, Any]]:
    """Fit every plant's EPI system factor again on the last 60 days and rescale its stored EPI
    (not scheduled; queue it after a sensor, inverter or module change)."""
    detail: Dict[str, Any] = {}
    _epi_fit(db, detail, _today() - timedelta(days=1), refit=True)
    return ("failed" if "error" in detail["epi_fit"] else "ok"), detail


def job_rules_backfill(db: Session) -> Tuple[str, Dict[str, Any]]:
    """Daily rows for every day of stored history, then the rules and issues day by day, oldest
    first (not scheduled; queue it once, or use the CLI)."""
    from app.services import growatt_daily, growatt_issues, growatt_rules, tariff

    end = _today() - timedelta(days=1)
    detail = growatt_daily.backfill(db, end)
    first, _ = growatt_daily.stored_days(db)
    pr = tariff.pricer(db)
    opened = closed = 0
    d = first
    while d is not None and d <= end:
        r = growatt_issues.sync(db, d, growatt_rules.evaluate(db, d, pricer=pr))
        opened += r["opened"]
        closed += r["closed"]
        d += timedelta(days=1)
    detail["issues"] = {"opened": opened, "closed": closed}
    _epi_fit(db, detail, end)
    return ("partial" if detail["failed"] else "ok"), detail


def job_om_plans(db: Session) -> Tuple[str, Dict[str, Any]]:
    """Calendar Team recurring plans: keep each plan's planned tasks up to 90 days ahead (moved,
    started or finished tasks are never touched; services/om_plans.py)."""
    from app.services import om_plans

    return "ok", om_plans.generate_all(db)


def job_om_reminders(db: Session) -> Tuple[str, Dict[str, Any]]:
    """Calendar Team: push "Tomorrow: …" to each person with planned work starting tomorrow
    (services/om_reminders.py; off while push is not configured)."""
    from app.services import om_reminders

    detail = _push(db, lambda _push_mod: om_reminders.notify_tomorrow(db))
    return ("partial" if "error" in detail or detail.get("failed") else "ok"), detail


def job_om_weekly(db: Session) -> Tuple[str, Dict[str, Any]]:
    """Calendar Team: push each person's week (this Monday … Sunday) and overdue count."""
    from app.services import om_reminders

    detail = _push(db, lambda _push_mod: om_reminders.notify_week(db))
    return ("partial" if "error" in detail or detail.get("failed") else "ok"), detail


JOBS: Dict[str, Callable[[Session], Tuple[str, Dict[str, Any]]]] = {
    "history": job_history,
    "env_history": job_env_history,
    "inverter_latest": job_inverter_latest,
    "backfill": job_backfill,
    "fleet": job_fleet,
    "power_limits": job_power_limits,
    "growatt_energy": job_growatt_energy,
    "energy_backfill": job_energy_backfill,
    "publish_today": job_publish_today,
    "publish_yesterday": job_publish_yesterday,
    "retention": job_retention,
    "google_weather": job_google_weather,
    "alarms": job_alarms,
    "alarms_yesterday": job_alarms_yesterday,
    "push_test": job_push_test,
    "pwa_sheet": job_pwa_sheet,
    "rules_today": job_rules_today,
    "rules_yesterday": job_rules_yesterday,
    "rules_backfill": job_rules_backfill,
    "epi_refit": job_epi_refit,
    "om_plans": job_om_plans,
    "om_reminders": job_om_reminders,
    "om_weekly": job_om_weekly,
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


ABANDONED = "abandoned (worker stopped mid-run)"


def _fail_stale(run: SyncRun, now: datetime) -> None:
    run.error = ABANDONED if run.status == "running" else "never picked up (is the worker running?)"
    run.status, run.finished_at = "failed", now


def fail_abandoned(db: Session, now: Optional[datetime] = None) -> List[int]:
    """Worker startup: runs still `running` were left by a previous worker (there is only one),
    so fail them now instead of blocking their job until STALE_AFTER. Queued runs are kept."""
    now = _utc(now)
    runs = list(db.scalars(select(SyncRun).where(SyncRun.status == "running")))
    for run in runs:
        _fail_stale(run, now)
    db.commit()
    return [r.id for r in runs]


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
        # end the read transaction now: held through a long job, its snapshot keeps Postgres
        # from finishing CREATE INDEX CONCURRENTLY and VACUUM (seen in prod: 68 min "idle in
        # transaction" during a history run)
        db.commit()
        # every record logged during the run carries its id and job (System → Logs)
        tokens = (logging_db.run_id_var.set(run_id), logging_db.job_var.set(run.job))
        try:
            log.info("job %s started (run %s, %s)", run.job, run_id, run.trigger)
            try:
                status, detail = JOBS[run.job](db)
                run.status, run.detail_json = status, _jsonable(detail)
            except Exception as exc:  # recorded, never raised into the worker loop
                db.rollback()
                run = db.get(SyncRun, run_id)
                assert run is not None
                run.status, run.error = "failed", f"{type(exc).__name__}: {exc}"
                log.exception("job %s failed", run.job)
            run.finished_at = datetime.now(timezone.utc)
            db.commit()
            db.refresh(run)
            lvl = logging.INFO if run.status == "ok" else logging.WARNING
            log.log(lvl, "job %s finished: %s%s", run.job, run.status, f" ({run.error})" if run.error else "")
            return run
        finally:
            logging_db.run_id_var.reset(tokens[0])
            logging_db.job_var.reset(tokens[1])


def run_job(session_factory: sessionmaker, job: str, trigger: str = "cli") -> SyncRun:
    with session_factory() as db:
        run_id = claim(db, job, trigger)
    return execute(session_factory, run_id)


def last_run(db: Session, job: str) -> Optional[SyncRun]:
    """The job's newest run (any status), or None."""
    return db.scalars(select(SyncRun).where(SyncRun.job == job).order_by(SyncRun.started_at.desc()).limit(1)).first()


def last_started(db: Session, job: str) -> Optional[datetime]:
    """When the job last started, for the schedule. A run cut off by a worker restart (a deploy)
    doesn't count: its slot is still owed, so a daily job is retried within its grace window
    instead of skipping the day (e.g. `google_weather` stopped at 19:31 lost the day's hours)."""
    run = db.scalars(
        select(SyncRun)
        .where(SyncRun.job == job, or_(SyncRun.error.is_(None), SyncRun.error != ABANDONED))
        .order_by(SyncRun.started_at.desc())
        .limit(1)
    ).first()
    return _aware(run.started_at) if run else None


WORKER_STALE_AFTER = timedelta(minutes=120)  # a `history` run takes up to ~1 h; one starts every 30 min


def worker_health(db: Session, now: Optional[datetime] = None) -> Dict[str, Any]:
    """For the uptime check behind the "data sync failing" alert: ok while a `history` run ended
    ok / partial within WORKER_STALE_AFTER. Only times, no plant data (the route is open)."""
    now = _utc(now)
    run = db.scalars(
        select(SyncRun)
        .where(SyncRun.job == "history", SyncRun.status.in_(("ok", "partial")), SyncRun.finished_at.is_not(None))
        .order_by(SyncRun.finished_at.desc())
        .limit(1)
    ).first()
    last = _aware(run.finished_at) if run and run.finished_at else None
    return {"ok": last is not None and now - last < WORKER_STALE_AFTER, "last_history_at": last.isoformat() if last else None}


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
