"""Project phases: one Growatt account (token) per phase, plants tagged by the account listing them."""

from __future__ import annotations

import threading
from datetime import datetime, timedelta

import pytest
from sqlalchemy import create_engine, inspect, text
from sqlalchemy.orm import sessionmaker

from app.config import Settings
from app.db.models import GrowattInverter, GrowattPlant
from app.db.session import Base, build_engine, ensure_schema
from app.services import growatt_sync, jobs
from app.services.growatt_live import GrowattLiveService, LiveUnavailable
from app.worker import UNTAGGED_RETRY, default_schedule, tick
from solar_core.growatt import GrowattAPIError

BKK = jobs.PLANT_TZ


class _Account:
    """Fake Growatt account: its own plants and inverters; records every call."""

    def __init__(self, plants: dict[int, list[str]]):
        self.plants = plants
        self.calls: list = []
        self.fail: GrowattAPIError | None = None

    def list_plants(self, refresh=False):
        self.calls.append("plants")
        if self.fail:
            raise self.fail
        return [{"plant_id": str(pid), "name": f"P{pid}", "current_power": "100"} for pid in self.plants]

    def list_inverters(self, plant_id, refresh=False):
        self.calls.append(("inverters", plant_id))
        if plant_id not in self.plants:
            raise GrowattAPIError("plant not in this account", error_code=10002)
        return [
            {"device_sn": sn, "datalogger_sn": None, "model": "MAX", "device_types": ["inverter", "max"]}
            for sn in self.plants[plant_id]
        ]

    def max_history(self, sn, a, b, stop_before=None):
        self.calls.append(("history", sn))
        return []


@pytest.fixture()
def factory(tmp_path):
    engine = build_engine(f"sqlite:///{tmp_path / 'phases.db'}")
    Base.metadata.create_all(bind=engine)
    return sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)


@pytest.fixture()
def accounts(monkeypatch):
    accs = {1: _Account({10: ["A1"]}), 2: _Account({20: ["B1", "B2"]}), 4: _Account({40: ["D1"]})}
    monkeypatch.setattr(jobs, "_clients", lambda: dict(accs))
    monkeypatch.setattr(growatt_sync.time, "sleep", lambda s: None)
    return accs


def test_settings_accounts_skip_empty_and_fall_back_to_legacy_token():
    s = Settings(_env_file=None, growatt_api_token="legacy", growatt_token_phase3=" t3 ")
    assert s.growatt_accounts() == {1: "legacy", 3: "t3"}
    s = Settings(_env_file=None, growatt_api_token="legacy", growatt_token_phase1="t1", growatt_token_phase2="t2")
    assert s.growatt_accounts() == {1: "t1", 2: "t2"}
    assert Settings(_env_file=None).growatt_accounts() == {}


def test_fleet_tags_each_plant_with_its_account_phase(factory, accounts):
    with factory() as db:
        status, detail = jobs.job_fleet(db)
        phases = {p.plant_id: p.phase for p in db.query(GrowattPlant)}
    assert status == "ok"
    assert phases == {10: 1, 20: 2, 40: 4}
    assert detail["inverters"] == 4 and detail["phases"]["2"] == {"inverters": 2}


def test_history_uses_each_plants_own_token_and_untagged_goes_to_first(factory, accounts):
    with factory() as db:
        db.add_all([GrowattPlant(plant_id=10, name="a", phase=1), GrowattPlant(plant_id=20, name="b", phase=2),
                    GrowattPlant(plant_id=99, name="untagged")])
        db.flush()
        db.add_all([GrowattInverter(device_sn="A1", plant_id=10), GrowattInverter(device_sn="B1", plant_id=20),
                    GrowattInverter(device_sn="U1", plant_id=99)])
        db.commit()
        status, detail = jobs.job_history(db)

    hist = {k: [c[1] for c in a.calls if c[0] == "history"] for k, a in accounts.items()}
    assert hist == {1: ["A1", "U1"], 2: ["B1"], 4: []}
    assert status == "ok" and detail["inverters"] == 3


def _seed_one_inverter_per_account(factory):
    with factory() as db:
        db.add_all([GrowattPlant(plant_id=10, name="a", phase=1), GrowattPlant(plant_id=20, name="b", phase=2),
                    GrowattPlant(plant_id=40, name="d", phase=4)])
        db.flush()
        db.add_all([GrowattInverter(device_sn=sn, plant_id=pid) for sn, pid in (("A1", 10), ("B1", 20), ("D1", 40))])
        db.commit()


def test_accounts_sync_in_parallel(factory, accounts, monkeypatch):
    """Every account must be inside max_history at once: a barrier only opens when all 3 arrive."""
    monkeypatch.setattr(jobs.settings, "worker_parallel_accounts", True)
    _seed_one_inverter_per_account(factory)
    barrier = threading.Barrier(len(accounts), timeout=5)
    for a in accounts.values():
        a.max_history = lambda sn, a_, b_, stop_before=None: (barrier.wait(), [])[1]
    with factory() as db:
        status, detail = jobs.job_history(db)
    assert status == "ok", detail
    assert detail["inverters"] == 3 and set(detail["phases"]) == {"1", "2", "4"}
    with factory() as db:  # each thread's session committed its own inverters
        assert db.query(GrowattInverter).count() == 3


def test_accounts_run_one_by_one_when_parallel_is_off(factory, accounts, monkeypatch):
    monkeypatch.setattr(jobs.settings, "worker_parallel_accounts", False)
    _seed_one_inverter_per_account(factory)
    order, active = [], []
    for phase, a in accounts.items():
        def hist(sn, a_, b_, stop_before=None, phase=phase):
            active.append(phase)
            assert len(active) == 1, "accounts overlapped"
            order.append(phase)
            active.remove(phase)
            return []
        a.max_history = hist
    with factory() as db:
        status, _ = jobs.job_history(db)
    assert status == "ok" and order == [1, 2, 4]


def test_one_failing_account_makes_job_partial_not_failed(factory, accounts):
    accounts[2].fail = GrowattAPIError("token expired", error_code=10011)
    with factory() as db:
        status, detail = jobs.job_fleet(db)
        assert {p.plant_id for p in db.query(GrowattPlant)} == {10, 40}
    assert status == "partial"
    assert "token expired" in detail["phases"]["2"]["error"]

    for a in accounts.values():
        a.fail = GrowattAPIError("down")
    with factory() as db, pytest.raises(RuntimeError, match="phase 1"):
        jobs.job_fleet(db)


def _live(accs, clock):
    return GrowattLiveService(client_factory=lambda phase: accs[phase], ttl_s=60, cooldown_s=30,
                              clock=lambda: clock[0], phases=tuple(accs))


def test_live_plants_merges_accounts_and_marks_stale_per_account():
    accs, clock = {1: _Account({10: []}), 2: _Account({20: []})}, [0.0]
    svc = _live(accs, clock)
    env = svc.plants()
    assert {(p["plant_id"], p["phase"]) for p in env["data"]} == {(10, 1), (20, 2)}
    assert env["stale"] is False and env["error"] is None

    clock[0] = 61.0
    accs[2].fail = GrowattAPIError("rate limited", error_code=10012)
    env = svc.plants()
    assert env["stale"] is True and "phase 2" in env["error"]
    assert {p["plant_id"] for p in env["data"]} == {10, 20}  # phase 2 keeps its last list

    fresh = _live(accs, clock)  # no cache: phase 2 is missing, phase 1 still served
    env = fresh.plants()
    assert [p["plant_id"] for p in env["data"]] == [10] and env["stale"] is True

    accs[1].fail = GrowattAPIError("down")
    with pytest.raises(LiveUnavailable):
        _live(accs, clock).plants()


def test_live_plant_calls_use_the_plants_phase():
    accs, clock = {1: _Account({10: ["A1"]}), 3: _Account({30: ["C1"]})}, [0.0]
    svc = _live(accs, clock)
    assert svc.inverters(30, phase=3)["data"][0]["device_sn"] == "C1"
    assert accs[1].calls == []
    assert svc.inverters(10, phase=None)["data"][0]["device_sn"] == "A1"  # untagged -> first account
    with pytest.raises(LiveUnavailable, match="phase 2"):
        svc.inverters(20, phase=2)


def test_ensure_schema_adds_phase_to_an_existing_table(tmp_path):
    engine = create_engine(f"sqlite:///{tmp_path / 'old.db'}")
    with engine.begin() as conn:
        conn.execute(text("CREATE TABLE growatt_plants (plant_id INTEGER PRIMARY KEY, name VARCHAR(255) NOT NULL, "
                          "city VARCHAR(255), country VARCHAR(100), latitude FLOAT, longitude FLOAT, "
                          "peak_power_kwp FLOAT, create_date VARCHAR(32), synced_at DATETIME NOT NULL)"))
    ensure_schema(engine)
    ensure_schema(engine)  # idempotent
    insp = inspect(engine)
    assert "phase" in {c["name"] for c in insp.get_columns("growatt_plants")}
    assert "ix_growatt_plants_phase" in {i["name"] for i in insp.get_indexes("growatt_plants")}


def test_worker_reruns_fleet_while_plants_are_untagged(factory, monkeypatch):
    calls: list = []

    def fleet(db):
        calls.append("fleet")
        return "ok", {}

    monkeypatch.setattr(jobs, "JOBS", {"fleet": fleet})
    schedule = [s for s in default_schedule() if s.job == "fleet"]
    with factory() as db:
        db.add(GrowattPlant(plant_id=1, name="P"))
        db.flush()
        db.add(GrowattInverter(device_sn="I", plant_id=1))
        db.commit()

    noon = datetime(2026, 11, 12, 12, 0, tzinfo=BKK)
    assert tick(factory, schedule, noon) == ["fleet"]
    assert tick(factory, schedule, noon + timedelta(hours=1)) == []
    assert tick(factory, schedule, noon + UNTAGGED_RETRY) == ["fleet"]

    with factory() as db:
        db.get(GrowattPlant, 1).phase = 1
        db.commit()
    assert tick(factory, schedule, noon + 2 * UNTAGGED_RETRY) == []  # all tagged: daily slot only
