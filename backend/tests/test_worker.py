"""Worker schedule, job lock / run log, sync API, and incremental Growatt paging (no network)."""

from __future__ import annotations

from datetime import date, datetime, time as dtime, timedelta, timezone
from unittest.mock import MagicMock

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import func, select
from sqlalchemy.orm import sessionmaker

from app.db.models import GrowattInverter, GrowattPlant, SyncRun
from app.services.growatt_sync import store_string_rows
from app.db.seed import ensure_seeded
from app.db.session import Base, build_engine, get_db
from app.main import create_app
from app import worker as worker_mod
from app.services import jobs
from app.worker import REGISTRY_RETRY, Schedule, default_schedule, tick
from solar_core.growatt import GrowattClient

BKK = jobs.PLANT_TZ


@pytest.fixture()
def factory(tmp_path):
    engine = build_engine(f"sqlite:///{tmp_path / 'worker.db'}")
    Base.metadata.create_all(bind=engine)
    return sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)


@pytest.fixture()
def fake_jobs(monkeypatch):
    calls: list = []

    def ok(db):
        calls.append("ok")
        return "ok", {"n": 1, "when": date(2026, 11, 12)}

    def boom(db):
        calls.append("boom")
        raise RuntimeError("growatt down")

    monkeypatch.setattr(jobs, "JOBS", {"history": ok, "fleet": boom, "publish_today": ok})
    return calls


# --------------------------------------------------------------------------- schedule


def test_interval_and_daily_due_rules():
    every = Schedule("history", every=timedelta(minutes=30))
    now = datetime(2026, 11, 12, 10, 0, tzinfo=BKK)
    assert every.is_due(now, None)
    assert not every.is_due(now, now - timedelta(minutes=29))
    assert every.is_due(now, now - timedelta(minutes=30))

    daily = Schedule("publish_today", at=dtime(19, 30))
    assert not daily.is_due(datetime(2026, 11, 12, 19, 29, tzinfo=BKK), None)
    assert daily.is_due(datetime(2026, 11, 12, 19, 30, tzinfo=BKK), None)
    # already ran after today's slot
    assert not daily.is_due(datetime(2026, 11, 12, 20, 0, tzinfo=BKK), datetime(2026, 11, 12, 19, 31, tzinfo=BKK))
    # yesterday's run does not count for today
    assert daily.is_due(datetime(2026, 11, 12, 20, 0, tzinfo=BKK), datetime(2026, 11, 11, 19, 31, tzinfo=BKK))
    # worker started long after the slot: don't publish a stale/half day
    assert not daily.is_due(datetime(2026, 11, 12, 23, 0, tzinfo=BKK), None)
    # UTC input is converted to plant-local time (12:30 UTC = 19:30 Bangkok)
    assert daily.is_due(datetime(2026, 11, 12, 12, 30, tzinfo=timezone.utc), None)


def test_publish_today_runs_at_each_check_snapshot_and_after_sunset():
    slots = [s for s in default_schedule() if s.job == "publish_today"]
    assert [s.at for s in slots] == [dtime(8, 50), dtime(12, 50), dtime(16, 50), dtime(19, 30)]

    def due(h, m, last):
        now = datetime(2026, 11, 12, h, m, tzinfo=BKK)
        return any(s.is_due(now, last) for s in slots)

    yesterday = datetime(2026, 11, 11, 19, 31, tzinfo=BKK)
    assert not due(8, 49, yesterday)
    assert due(8, 50, yesterday)
    at_0850 = datetime(2026, 11, 12, 8, 51, tzinfo=BKK)
    assert not due(11, 0, at_0850)  # once per slot
    assert due(12, 50, at_0850)
    at_1650 = datetime(2026, 11, 12, 16, 51, tzinfo=BKK)
    assert not due(19, 29, at_1650)
    assert due(19, 30, at_1650)


def test_history_pulled_before_each_check_publish():
    slots = [s.at for s in default_schedule() if s.job == "history" and s.at]
    assert slots == [dtime(8, 47), dtime(12, 47), dtime(16, 47)]
    pull = next(s for s in default_schedule() if s.job == "history" and s.at == dtime(8, 47))
    # an interval pull at 08:30 does not cover 08:50 well enough: pull again at 08:47
    assert pull.is_due(datetime(2026, 11, 12, 8, 47, tzinfo=BKK), datetime(2026, 11, 12, 8, 30, tzinfo=BKK))
    assert not pull.is_due(datetime(2026, 11, 12, 9, 0, tzinfo=BKK), datetime(2026, 11, 12, 8, 48, tzinfo=BKK))


def test_alarms_keep_out_of_the_check_pull_and_publish():
    alarms = next(s for s in default_schedule() if s.job == "alarms")
    assert alarms.skip[0] == (dtime(8, 42), dtime(8, 51))
    at = lambda h, m: datetime(2026, 11, 12, h, m, tzinfo=BKK)
    long_ago = at(6, 0)
    assert not alarms.is_due(at(8, 45), long_ago)
    assert alarms.is_due(at(8, 51), long_ago)


def _seed_registry(factory) -> None:
    with factory() as db:
        db.add(GrowattPlant(plant_id=1, name="P"))
        db.flush()
        db.add(GrowattInverter(device_sn="INV1", plant_id=1))
        db.commit()


def test_tick_runs_due_jobs_once_and_records_failures(factory, fake_jobs):
    _seed_registry(factory)  # non-empty registry: fleet follows its daily slot only
    schedule = [Schedule("history", every=timedelta(minutes=30)), Schedule("fleet", at=dtime(5, 30))]
    now = datetime(2026, 11, 12, 6, 0, tzinfo=BKK)
    assert tick(factory, schedule, now) == ["history", "fleet"]
    assert tick(factory, schedule, now + timedelta(minutes=5)) == []  # nothing due again yet
    assert tick(factory, schedule, now + timedelta(minutes=31)) == ["history"]

    with factory() as db:
        runs = db.query(SyncRun).order_by(SyncRun.id).all()
    assert [(r.job, r.status) for r in runs] == [("history", "ok"), ("fleet", "failed"), ("history", "ok")]
    assert "growatt down" in runs[1].error
    assert runs[0].detail_json == {"n": 1, "when": "2026-11-12"}
    assert runs[0].finished_at is not None


def test_empty_registry_runs_fleet_outside_its_slot_and_retries(factory, monkeypatch):
    """Fresh deploy at noon: fleet runs at once (before history), retrying while Growatt fails."""
    calls: list = []
    fleet_ok = [False]

    def history(db):
        calls.append("history")
        return "ok", {}

    def fleet(db):
        calls.append("fleet")
        if not fleet_ok[0]:
            raise RuntimeError("growatt down")
        db.add(GrowattPlant(plant_id=1, name="P"))
        db.flush()
        db.add(GrowattInverter(device_sn="INV1", plant_id=1))
        db.commit()
        return "ok", {"inverters": 1}

    monkeypatch.setattr(jobs, "JOBS", {"history": history, "fleet": fleet})
    # a 30-min history interval, so the ticks below fall between history pulls
    monkeypatch.setattr(worker_mod.settings, "worker_history_interval_min", 30)
    schedule = default_schedule()
    schedule = [s for s in schedule if s.job in ("fleet", "history")]
    noon = datetime(2026, 11, 12, 12, 0, tzinfo=BKK)  # far outside the 05:30 fleet slot

    assert tick(factory, schedule, noon) == ["fleet", "history"]  # fleet first, even though it failed
    assert tick(factory, schedule, noon + timedelta(minutes=10)) == []  # retry waits REGISTRY_RETRY
    fleet_ok[0] = True
    assert tick(factory, schedule, noon + REGISTRY_RETRY) == ["fleet"]
    # registry filled: fleet goes back to its daily slot
    assert tick(factory, schedule, noon + timedelta(hours=1)) == ["history"]
    assert calls == ["fleet", "history", "fleet", "history"]


# --------------------------------------------------------------------------- lock


def test_daily_run_abandoned_by_restart_is_retried_within_grace(factory, fake_jobs):
    """A deploy that restarts the worker mid-run must not make the scheduler skip the day."""
    schedule = [Schedule("publish_today", at=dtime(19, 30))]
    slot = datetime(2026, 11, 13, 19, 30, tzinfo=BKK)
    with factory() as db:
        jobs.claim(db, "publish_today", "schedule", now=slot)
        assert jobs.fail_abandoned(db, now=slot + timedelta(minutes=5))  # worker restarted
    assert tick(factory, schedule, slot + timedelta(minutes=6)) == ["publish_today"]
    assert tick(factory, schedule, slot + timedelta(minutes=7)) == []  # done: once per slot again

    # a run that failed by itself is not retried until the next slot
    fake_jobs.clear()
    later = slot + timedelta(days=1)
    with factory() as db:
        run = db.get(SyncRun, jobs.claim(db, "publish_today", "schedule", now=later))
        run.status, run.error = "failed", "RuntimeError: growatt down"
        db.commit()
    assert tick(factory, schedule, later + timedelta(minutes=1)) == []


def test_claim_blocks_concurrent_runs_and_recovers_stale(factory, fake_jobs):
    now = datetime(2026, 11, 12, 3, 0, tzinfo=timezone.utc)
    with factory() as db:
        first = jobs.claim(db, "history", "api", now=now)
        with pytest.raises(jobs.JobBusy):
            jobs.claim(db, "history", "schedule", now=now + timedelta(minutes=10))
        jobs.claim(db, "fleet", "api", now=now)  # other jobs are independent

        later = now + jobs.STALE_AFTER + timedelta(minutes=1)
        second = jobs.claim(db, "history", "schedule", now=later)
        assert second != first
        stale = db.get(SyncRun, first)
        assert stale.status == "failed" and "abandoned" in stale.error

        with pytest.raises(KeyError):
            jobs.claim(db, "nope", "api")


# --------------------------------------------------------------------------- API


@pytest.fixture()
def api(factory, fake_jobs):
    with factory() as s:
        ensure_seeded(s)
    app = create_app()

    def _db():
        db = factory()
        try:
            yield db
        finally:
            db.close()

    app.dependency_overrides[get_db] = _db
    return TestClient(app)


def _auth(client, email, pw):
    tok = client.post("/api/auth/login", json={"email": email, "password": pw}).json()["access_token"]
    return {"Authorization": f"Bearer {tok}"}


def test_sync_api_roles_trigger_and_status(api, factory, fake_jobs):
    engineer = _auth(api, "engineer@tcroofsolar.com", "engineer123")
    admin = _auth(api, "admin@tcroofsolar.com", "admin123")

    # jobs are fleet-wide: admin only
    assert api.post("/api/growatt/sync/history", headers=engineer).status_code == 403
    assert api.get("/api/growatt/sync/status", headers=engineer).status_code == 403
    assert api.post("/api/growatt/sync/nope", headers=admin).status_code == 404

    r = api.post("/api/growatt/sync/history", headers=admin)
    assert r.status_code == 202, r.text
    assert r.json()["status"] == "queued"
    assert fake_jobs == []  # the API never runs jobs itself
    assert api.post("/api/growatt/sync/history", headers=admin).status_code == 409  # already queued

    status = api.get("/api/growatt/sync/status", headers=admin).json()
    assert status["jobs"]["history"]["status"] == "queued"

    # the worker's next tick picks the queued run up, before (and instead of) the schedule
    now = datetime.now(BKK)
    assert tick(factory, [Schedule("history", every=timedelta(minutes=30))], now) == ["history"]
    assert fake_jobs == ["ok"]
    status = api.get("/api/growatt/sync/status", headers=admin).json()
    assert status["jobs"]["history"]["status"] == "ok"
    assert status["jobs"]["history"]["trigger"] == "api"
    assert status["jobs"]["fleet"] is None

    with factory() as db:
        jobs.claim(db, "publish_today", "schedule")
    assert api.post("/api/growatt/sync/publish_today", headers=admin).status_code == 409


def test_stale_queued_run_is_failed_not_run(factory, fake_jobs):
    t0 = datetime(2026, 11, 12, 3, 0, tzinfo=timezone.utc)
    with factory() as db:
        rid = jobs.enqueue(db, "history", now=t0)
        assert jobs.claim_queued(db, now=t0 + jobs.STALE_AFTER + timedelta(minutes=1)) == []
        run = db.get(SyncRun, rid)
        assert run.status == "failed" and "never picked up" in run.error
        # a running job blocks queuing; a stale running one is failed with the right message
        rid2 = jobs.claim(db, "fleet", "schedule", now=t0)
        with pytest.raises(jobs.JobBusy):
            jobs.enqueue(db, "fleet", now=t0 + timedelta(minutes=5))
        jobs.enqueue(db, "fleet", now=t0 + jobs.STALE_AFTER + timedelta(minutes=1))
        assert "abandoned" in db.get(SyncRun, rid2).error


def test_worker_startup_fails_runs_left_running_but_keeps_queued(factory, fake_jobs):
    t0 = datetime(2026, 11, 12, 3, 0, tzinfo=timezone.utc)
    with factory() as db:
        running = jobs.claim(db, "history", "schedule", now=t0)
        queued = jobs.enqueue(db, "fleet", now=t0)
        assert jobs.fail_abandoned(db, now=t0 + timedelta(minutes=5)) == [running]
        assert db.get(SyncRun, running).status == "failed" and "abandoned" in db.get(SyncRun, running).error
        assert db.get(SyncRun, queued).status == "queued"
        jobs.claim(db, "history", "schedule", now=t0 + timedelta(minutes=5))  # no longer blocked


# --------------------------------------------------------------------------- incremental paging


def _page(times):
    r = MagicMock()
    r.raise_for_status.return_value = None
    r.json.return_value = {"error_code": 0, "data": {"count": 1000, "datas": [{"time": t} for t in times]}}
    return r


def test_max_history_stops_paging_at_stop_before():
    client = GrowattClient(token="t")
    pages = [
        _page([f"2026-11-12 10:{m:02d}:00" for m in range(59, 9, -1)]),  # 10:59 … 10:10
        _page([f"2026-11-12 09:{m:02d}:00" for m in range(59, 9, -1)]),  # 09:59 … 09:10
        _page([f"2026-11-12 08:{m:02d}:00" for m in range(59, 9, -1)]),
    ]
    client.session.post = MagicMock(side_effect=pages)
    recs = client.max_history("SN", date(2026, 11, 12), date(2026, 11, 12), stop_before=datetime(2026, 11, 12, 9, 30))
    assert client.session.post.call_count == 2
    assert len(recs) == 100

    client.session.post = MagicMock(side_effect=pages)
    client.max_history("SN", date(2026, 11, 12), date(2026, 11, 12), stop_before=datetime(2026, 11, 12, 10, 30))
    assert client.session.post.call_count == 1


def test_sync_incremental_starts_from_last_synced(factory, monkeypatch):
    from app.services import growatt_sync

    with factory() as db:
        db.add(GrowattPlant(plant_id=1, name="P"))
        db.flush()
        db.add_all(
            [
                GrowattInverter(device_sn="NEW", plant_id=1),
                GrowattInverter(device_sn="SYNCED", plant_id=1, history_synced_until=datetime(2026, 11, 12, 9, 0)),
                GrowattInverter(device_sn="OLD", plant_id=1, history_synced_until=datetime(2026, 10, 1, 9, 0)),
            ]
        )
        db.commit()

        seen = {}

        class Fake:
            def max_history(self, sn, a, b, stop_before=None):
                seen.setdefault(sn, []).append((a, b, stop_before))
                return []

        monkeypatch.setattr(growatt_sync.time, "sleep", lambda s: None)
        t = growatt_sync.sync_incremental(db, Fake(), date(2026, 11, 12))

    assert t["failed"] == []
    assert seen["SYNCED"] == [(date(2026, 11, 12), date(2026, 11, 12), datetime(2026, 11, 12, 8, 30))]
    assert seen["NEW"] == [(date(2026, 11, 11), date(2026, 11, 12), datetime(2026, 11, 11, 0, 0))]
    # long-offline inverter looks back at most 7 days
    assert seen["OLD"][0][0] == date(2026, 11, 5) and seen["OLD"][-1][1] == date(2026, 11, 12)


# --------------------------------------------------------------------------- retention


def test_prune_history_deletes_only_readings_older_than_keep_days(factory):
    from app.db.models import GrowattInverterReading, GrowattStringReading
    from app.services.growatt_sync import prune_history

    today = date(2026, 11, 12)
    with factory() as db:
        db.add(GrowattPlant(plant_id=1, name="P"))
        db.flush()
        db.add(GrowattInverter(device_sn="I", plant_id=1))
        db.flush()
        for ts in (datetime(2026, 8, 1, 12), datetime(2026, 8, 13, 23, 59), datetime(2026, 8, 14, 0, 0), datetime(2026, 11, 12, 9)):
            db.add(GrowattInverterReading(device_sn="I", timestamp=ts, ppv_w=1.0))
            store_string_rows(db, [dict(device_sn="I", timestamp=ts, string_no=1, mppt_no=1, voltage_v=1, current_a=1)])
        db.commit()

        t = prune_history(db, today, 90)  # cutoff 2026-08-14 00:00
        left = sorted(db.scalars(select(GrowattInverterReading.timestamp)))
        left_str = sorted(db.scalars(select(GrowattStringReading.timestamp)))
    assert t["inverter_rows"] == 2 and t["string_records"] == 2 and t["cutoff"] == "2026-08-14T00:00:00"
    assert left == left_str == [datetime(2026, 8, 14, 0, 0), datetime(2026, 11, 12, 9)]
    with factory() as db:
        assert prune_history(db, today, 90)["inverter_rows"] == 0  # idempotent


def test_prune_history_keeps_string_readings_a_shorter_time(factory):
    from app.db.models import GrowattInverterReading, GrowattStringReading
    from app.services import growatt_daily
    from app.services.growatt_sync import prune_history

    today = date(2026, 11, 12)
    with factory() as db:
        db.add(GrowattPlant(plant_id=1, name="P"))
        db.flush()
        db.add(GrowattInverter(device_sn="I", plant_id=1))
        db.flush()
        for ts in (datetime(2026, 9, 1, 12), datetime(2026, 10, 12, 23, 59), datetime(2026, 10, 13, 0, 0), datetime(2026, 11, 12, 9)):
            db.add(GrowattInverterReading(device_sn="I", timestamp=ts, ppv_w=1.0))
            store_string_rows(db, [dict(device_sn="I", timestamp=ts, string_no=1, mppt_no=1, voltage_v=1, current_a=1)])
        db.commit()

        t = prune_history(db, today, 90, 30)  # strings: cutoff 2026-10-13; inverters: 2026-08-14
        left = sorted(db.scalars(select(GrowattInverterReading.timestamp)))
        left_str = sorted(db.scalars(select(GrowattStringReading.timestamp)))
        assert t["inverter_rows"] == 0 and t["string_records"] == 2 and t["string_cutoff"] == "2026-10-13T00:00:00"
        assert len(left) == 4
        assert left_str == [datetime(2026, 10, 13, 0, 0), datetime(2026, 11, 12, 9)]
        # a recompute must not start on a day whose string readings are gone
        assert growatt_daily.stored_days(db) == (date(2026, 10, 13), date(2026, 11, 12))
        assert prune_history(db, today, 90, 30)["string_records"] == 0  # idempotent
        assert prune_history(db, today, 90, 120)["string_cutoff"] == t["cutoff"]  # capped at keep_days


def test_unwired_string_inputs_are_not_stored(factory):
    from app.db.models import GrowattStringDaily, GrowattStringLayout, GrowattStringReading
    from app.services.growatt_sync import inverters

    day = datetime(2026, 11, 12, 10, 0)

    def row(n, i, ts=day):
        return {"device_sn": "I", "timestamp": ts, "string_no": n, "mppt_no": (n + 1) // 2,
                "voltage_v": 600.0, "current_a": i}

    with factory() as db:
        db.add(GrowattPlant(plant_id=1, name="P"))
        db.flush()
        db.add(GrowattInverter(device_sn="I", plant_id=1))
        db.flush()
        db.add(GrowattStringLayout(device_sn="I", string_no=4, modules=20))
        # 3: a daily row with energy 10 days ago (a weak string, never above 0.15 A, counts too)
        db.add(GrowattStringDaily(device_sn="I", string_no=3, day=date(2026, 11, 2), plant_id=1, energy_kwh=0.06))
        # 6: carried current earlier today (stored); 7: only a daily row older than 30 days
        store_string_rows(db, [dict(**row(6, 5.0, datetime(2026, 11, 12, 8, 0)))])
        db.add(GrowattStringDaily(device_sn="I", string_no=7, day=date(2026, 10, 1), plant_id=1, energy_kwh=5.0))
        db.commit()
        batch = [row(1, 8.1), row(2, 0.0), row(3, 0.0), row(4, 0.0), row(5, 0.02), row(6, 0.0), row(7, 0.0),
                 row(8, 0.0, day.replace(hour=6)), row(8, 2.0, day.replace(hour=7))]
        kept = sorted((r["string_no"], r["timestamp"].hour) for r in inverters._wired_only(db, batch))
        # 2 and 7 read the MPPT voltage at 0 A and are not wired: dropped. 8 carries current later
        # in the same batch, so its 06:00 row at 0 A is kept.
        assert kept == [(1, 10), (3, 10), (4, 10), (5, 10), (6, 10), (8, 6), (8, 7)]
        assert inverters._wired_only(db, []) == []
        # string power is derived (V × I), on a row and in SQL
        stored = db.get(GrowattStringReading, ("I", datetime(2026, 11, 12, 8, 0), 6))
        assert stored is not None and stored.power_w == 3000.0
        assert db.scalar(select(func.max(GrowattStringReading.power_w))) == 3000.0


def test_raw_records_are_stored_served_and_pruned(api, factory, monkeypatch):
    from app.config import settings
    from app.db.models import GrowattInverterRaw
    from app.services import growatt_sync

    rec = {"time": "2026-11-13 00:03:45", "serialNum": "I", "calendar": {}, "status": 0, "temperature2": 23.2, "pvIso": 143}
    with factory() as db:
        db.add(GrowattPlant(plant_id=1, name="P"))
        db.flush()
        db.add(GrowattInverter(device_sn="I", plant_id=1))
        db.commit()
        monkeypatch.setattr(settings, "history_store_raw", False)
        assert growatt_sync._store_raw(db, "I", [rec]) == 0
        monkeypatch.setattr(settings, "history_store_raw", True)
        assert growatt_sync._store_raw(db, "I", [rec]) == 1
        assert growatt_sync._store_raw(db, "I", [rec]) == 1  # same record again: upsert, one row
        db.commit()
        assert db.scalar(select(func.count()).select_from(GrowattInverterRaw)) == 1

    admin = _auth(api, "admin@tcroofsolar.com", "admin123")
    assert api.get("/api/growatt/plants/1/inverters/I/raw").status_code == 401
    body = api.get("/api/growatt/plants/1/inverters/I/raw?day=2026-11-13", headers=admin).json()
    assert body["meta"]["records"] == 1 and body["fields"] == ["pvIso", "status", "temperature2"]
    assert body["records"] == [{"time": "2026-11-13 00:03:45", "status": 0, "temperature2": 23.2, "pvIso": 143}]
    assert api.get("/api/growatt/plants/1/inverters/I/raw?day=2026-11-12", headers=admin).json()["records"] == []
    assert api.get("/api/growatt/plants/1/inverters/NOPE/raw", headers=admin).status_code == 404

    with factory() as db:
        assert growatt_sync.prune_raw(db, date(2026, 12, 12), 30) == 0  # cutoff 12 Nov: kept
        assert growatt_sync.prune_raw(db, date(2026, 12, 14), 30) == 1


def test_worker_health_needs_a_recent_finished_history_run(api, factory):
    assert api.get("/api/health/worker").status_code == 503  # no run yet

    now = datetime.now(timezone.utc)
    with factory() as db:
        db.add(SyncRun(job="history", status="ok", started_at=now - timedelta(minutes=50), finished_at=now - timedelta(minutes=10)))
        db.add(SyncRun(job="history", status="running", started_at=now - timedelta(minutes=5)))
        db.commit()
    r = api.get("/api/health/worker")  # open: no token
    assert r.status_code == 200 and r.json()["ok"] is True
    assert set(r.json()) == {"ok", "last_history_at"}  # times only, no plant data

    with factory() as db:
        assert jobs.worker_health(db, now=now + jobs.WORKER_STALE_AFTER)["ok"] is False
        db.add(SyncRun(job="history", status="failed", started_at=now, finished_at=now + timedelta(minutes=1)))
        db.commit()
        # a failed run doesn't count as a sync
        assert jobs.worker_health(db, now=now + jobs.WORKER_STALE_AFTER)["ok"] is False


def test_started_at_is_when_each_job_starts_not_the_tick(factory, monkeypatch):
    """Jobs of one tick run one after another: a job after a long one is stamped when it starts,
    so `sync_runs` durations are its own (a 0-page kb_ocr used to look as long as history)."""
    clock = {"t": 1000.0}
    monkeypatch.setattr(worker_mod, "_monotonic", lambda: clock["t"])

    def slow(db):
        clock["t"] += 300
        return "ok", {}

    def quick(db):
        return "ok", {}

    monkeypatch.setattr(jobs, "JOBS", {"history": slow, "kb_ocr": quick, "fleet": slow, "publish_today": quick})
    now = datetime(2026, 11, 12, 10, 0, tzinfo=BKK)
    every = timedelta(minutes=10)
    assert tick(factory, [Schedule("history", every=every), Schedule("kb_ocr", every=every)], now) == ["history", "kb_ocr"]
    with factory() as db:
        h = db.scalars(select(SyncRun).where(SyncRun.job == "history")).one()
        k = db.scalars(select(SyncRun).where(SyncRun.job == "kb_ocr")).one()
        assert jobs._aware(h.started_at) == now
        assert jobs._aware(k.started_at) == now + timedelta(seconds=300)

    # queued runs: claimed together, each stamped when it really starts
    with factory() as db:
        jobs.enqueue(db, "fleet", now=now)
        jobs.enqueue(db, "publish_today", now=now)
    later = now + timedelta(hours=1)
    clock["t"] = 5000.0
    assert tick(factory, [], later) == ["fleet", "publish_today"]
    with factory() as db:
        f = db.scalars(select(SyncRun).where(SyncRun.job == "fleet")).one()
        p = db.scalars(select(SyncRun).where(SyncRun.job == "publish_today")).one()
        assert jobs._aware(f.started_at) == later
        assert jobs._aware(p.started_at) == later + timedelta(seconds=300)
