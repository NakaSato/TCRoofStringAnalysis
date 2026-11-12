"""Worker schedule, job lock / run log, sync API, and incremental Growatt paging (no network)."""

from __future__ import annotations

from datetime import date, datetime, time as dtime, timedelta, timezone
from unittest.mock import MagicMock

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import sessionmaker

from app.api.routes.growatt import get_session_factory
from app.db.models import GrowattInverter, GrowattPlant, SyncRun
from app.db.seed import ensure_seeded
from app.db.session import Base, build_engine, get_db
from app.main import create_app
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
    app.dependency_overrides[get_session_factory] = lambda: factory
    return TestClient(app)


def _auth(client, email, pw):
    tok = client.post("/api/auth/login", json={"email": email, "password": pw}).json()["access_token"]
    return {"Authorization": f"Bearer {tok}"}


def test_sync_api_roles_trigger_and_status(api, factory, fake_jobs):
    viewer = _auth(api, "viewer@tcroofsolar.com", "viewer123")
    engineer = _auth(api, "engineer@tcroofsolar.com", "engineer123")

    assert api.post("/api/growatt/sync/history", headers=viewer).status_code == 403
    assert api.post("/api/growatt/sync/nope", headers=engineer).status_code == 404

    r = api.post("/api/growatt/sync/history", headers=engineer)
    assert r.status_code == 202, r.text
    assert fake_jobs == ["ok"]  # TestClient runs background tasks before returning

    status = api.get("/api/growatt/sync/status", headers=viewer).json()
    assert status["jobs"]["history"]["status"] == "ok"
    assert status["jobs"]["history"]["trigger"] == "api"
    assert status["jobs"]["fleet"] is None

    with factory() as db:
        jobs.claim(db, "publish_today", "schedule")
    assert api.post("/api/growatt/sync/publish_today", headers=engineer).status_code == 409


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
