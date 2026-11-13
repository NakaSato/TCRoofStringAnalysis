"""Alarm log in SQL: worker sync (replace per inverter-day, rate limits) and the fleet DB route."""

from __future__ import annotations

from datetime import date, datetime, time as dtime, timedelta

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import sessionmaker

from app.db.models import GrowattAlarm, GrowattAlarmSync, GrowattInverter, GrowattPlant, User, UserPlantAssignment
from app.db.seed import ensure_seeded
from app.db.session import Base, build_engine, get_db
from app.main import create_app
from app.services import growatt_alarms as ga
from app.services import jobs
from app.worker import Schedule
from solar_core.growatt import GrowattAPIError, GrowattClient

DAY = date(2026, 11, 13)


class _Client(GrowattClient):
    """`alarm_data` per serial from `logs`; serials in `fail` raise the given error code."""

    def __init__(self, logs, fail=None):
        self.logs, self.fail, self.calls = logs, fail or {}, []

    def _request(self, method, path, params):
        assert path == "device/max/alarm_data"
        sn = params["max_sn"]
        self.calls.append(sn)
        if sn in self.fail:
            raise GrowattAPIError("refused", error_code=self.fail[sn])
        rows = self.logs.get(sn, [])
        return {"alarms": rows, "count": len(rows)}


def _alarm(h, code=101, end=True, fault="Fault"):
    return {
        "start_time": f"2026-11-13 {h:02d}:00:00",
        "end_time": f"2026-11-13 {h:02d}:10:00" if end else "",
        "alarm_code": code,
        "alarm_message": "Grid fault",
        "fault_type": fault,
        "status": 1,
    }


@pytest.fixture()
def factory(tmp_path):
    engine = build_engine(f"sqlite:///{tmp_path / 'alarms.db'}")
    Base.metadata.create_all(bind=engine)
    f = sessionmaker(bind=engine, autoflush=False, autocommit=False, expire_on_commit=False)
    with f() as s:
        ensure_seeded(s)
        s.add_all([GrowattPlant(plant_id=1, name="Alpha"), GrowattPlant(plant_id=2, name="Beta"), GrowattPlant(plant_id=3, name="Empty")])
        s.flush()
        s.add_all(
            [
                GrowattInverter(device_sn="A1", plant_id=1),
                GrowattInverter(device_sn="A2", plant_id=1),
                GrowattInverter(device_sn="B1", plant_id=2),
            ]
        )
        s.commit()
    return f


def _invs(db):
    return list(db.scalars(select(GrowattInverter).order_by(GrowattInverter.device_sn)))


def test_open_alarm_closes_in_place_and_failed_read_keeps_rows(factory):
    with factory() as db:
        c = _Client({"A1": [_alarm(9, end=False)], "B1": [_alarm(10)]})
        t = ga.sync_alarms(db, c, DAY, _invs(db), pause_s=0)
        assert (t["alarm_read"], t["alarm_rows"], t["failed"]) == (3, 2, [])
        open_ = db.scalars(select(GrowattAlarm).where(GrowattAlarm.device_sn == "A1")).one()
        assert open_.end_time is None

        # Growatt closes the alarm: the inverter-day is replaced, not duplicated
        c.logs["A1"] = [_alarm(9)]
        c.fail = {"B1": 10001}  # B1 unreadable now: its stored rows stay
        t = ga.sync_alarms(db, c, DAY, _invs(db), pause_s=0)
        assert [sn for sn, _ in t["failed"]] == ["B1"]
        rows = db.scalars(select(GrowattAlarm).order_by(GrowattAlarm.device_sn)).all()
        assert [(r.device_sn, r.end_time) for r in rows] == [
            ("A1", datetime(2026, 11, 13, 9, 10)),
            ("B1", datetime(2026, 11, 13, 10, 10)),
        ]


def test_rate_limit_stops_the_sweep_and_next_run_starts_with_unread(factory):
    with factory() as db:
        c = _Client({}, fail={"A1": 10012, "A2": 10012, "B1": 10012})
        t = ga.sync_alarms(db, c, DAY, _invs(db), pause_s=0)
        assert t["alarm_read"] == 0 and t["failed"][-1][0] == "rate limited"
        assert db.scalars(select(GrowattAlarmSync)).all() == []

        # read only B1, then the next sweep starts with the never-read A1/A2
        c.fail = {}
        ga.sync_alarms(db, c, DAY, [i for i in _invs(db) if i.device_sn == "B1"], pause_s=0)
        c.calls.clear()
        ga.sync_alarms(db, c, DAY, _invs(db), pause_s=0)
        assert c.calls == ["A1", "A2", "B1"]


def test_alarms_job_runs_per_account(factory, monkeypatch):
    c = _Client({"A2": [_alarm(8, code=7)]})
    monkeypatch.setattr(jobs, "_clients", lambda: {1: c})
    monkeypatch.setattr(jobs, "_today", lambda: DAY)
    monkeypatch.setattr(ga.time, "sleep", lambda _s: None)
    with factory() as db:
        status, detail = jobs.job_alarms(db)
        assert status == "ok" and detail["day"] == "2026-11-13" and detail["alarm_rows"] == 1
        status, detail = jobs.job_alarms_yesterday(db)
        assert detail["day"] == "2026-11-12"


def test_alarm_schedule_window():
    s = Schedule("alarms", every=timedelta(minutes=30), between=(5, 21))
    bkk = jobs.PLANT_TZ
    assert not s.is_due(datetime(2026, 11, 13, 4, 59, tzinfo=bkk), None)
    assert s.is_due(datetime(2026, 11, 13, 5, 0, tzinfo=bkk), None)
    assert not s.is_due(datetime(2026, 11, 13, 21, 0, tzinfo=bkk), None)
    assert Schedule("alarms_yesterday", at=dtime(0, 30)).is_due(datetime(2026, 11, 13, 0, 30, tzinfo=bkk), None)


def test_prune_alarms(factory):
    with factory() as db:
        c = _Client({"A1": [_alarm(9)]})
        ga.sync_alarms(db, c, DAY - timedelta(days=91), _invs(db), pause_s=0)
        ga.sync_alarms(db, c, DAY, _invs(db), pause_s=0)
        assert ga.prune_alarms(db, DAY, 90) == 1
        assert {r.day for r in db.scalars(select(GrowattAlarmSync))} == {DAY}


def _api(factory, username):
    app = create_app()

    def _db():
        db = factory()
        try:
            yield db
        finally:
            db.close()

    app.dependency_overrides[get_db] = _db
    c = TestClient(app)
    pw = {"admin": "admin123", "engineer": "engineer123"}[username]
    tok = c.post("/api/auth/login", json={"username": username, "password": pw}).json()["access_token"]
    c.headers["Authorization"] = f"Bearer {tok}"
    return c


def test_fleet_route_reports_coverage_and_filters_engineer(factory):
    with factory() as db:
        c = _Client({"A1": [_alarm(9, end=False), _alarm(7)], "B1": [_alarm(11, code="E5", fault="Warning")]})
        # A2 not read yet: plant 1 is only partly covered
        ga.sync_alarms(db, c, DAY, [i for i in _invs(db) if i.device_sn != "A2"], pause_s=0)

    admin = _api(factory, "admin")
    body = admin.get("/api/growatt/alarms", params={"day": DAY.isoformat()}).json()
    assert body["meta"]["source"] == "db" and body["day"] == "2026-11-13"
    assert [a["start_time"] for a in body["alarms"]] == ["2026-11-13 11:00:00", "2026-11-13 09:00:00", "2026-11-13 07:00:00"]
    assert body["alarms"][1]["end_time"] is None and body["alarms"][1]["alarm_code"] == 101
    assert body["alarms"][0]["alarm_code"] == "E5" and body["alarms"][0]["plant_name"] == "Beta"
    plants = {p["plant_id"]: p for p in body["plants"]}
    assert set(plants) == {1, 2}  # plant 3 has no inverters
    assert (plants[1]["inverters"], plants[1]["synced_inverters"]) == (2, 1)
    assert plants[2]["synced_at"] is not None

    # another day: nothing read yet, which is not the same as no alarms
    other = admin.get("/api/growatt/alarms", params={"day": "2026-11-01"}).json()
    assert other["alarms"] == [] and all(p["synced_inverters"] == 0 and p["synced_at"] is None for p in other["plants"])

    eng = _api(factory, "engineer")
    assert eng.get("/api/growatt/alarms", params={"day": DAY.isoformat()}).json()["plants"] == []
    with factory() as db:
        uid = db.scalar(select(User.id).where(User.username == "engineer"))
        db.add(UserPlantAssignment(user_id=uid, plant_id=2))
        db.commit()
    body = eng.get("/api/growatt/alarms", params={"day": DAY.isoformat()}).json()
    assert [p["plant_id"] for p in body["plants"]] == [2]
    assert {a["plant_id"] for a in body["alarms"]} == {2}
