"""Alarm log in SQL: worker sync (replace per inverter-day, rate limits) and the fleet DB route."""

from __future__ import annotations

from datetime import date, datetime, time as dtime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import sessionmaker

from app.db.models import (
    GrowattAlarm,
    GrowattAlarmSync,
    GrowattInverter,
    GrowattInverterReading,
    GrowattPlant,
    User,
    UserPlantAssignment,
)
from app.db.seed import ensure_seeded
from app.db.session import Base, build_engine, get_db
from app.main import create_app
from app.services import growatt_alarms as ga
from app.services import jobs
from app.worker import Schedule, default_schedule
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
    assert body["meta"]["next_run_at"] is None  # a past day has no next sync
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


TIERS = ga.Tiers(hot=timedelta(minutes=10), warm=timedelta(minutes=30), cold=timedelta(minutes=60))
T0 = datetime(2026, 11, 13, 2, 0, tzinfo=timezone.utc)  # 09:00 Bangkok


def test_tiers_read_only_due_inverters_hot_first(factory):
    with factory() as db:
        # A1: open alarm (hot), B1: alarm closed (warm), A2: no alarms (cold)
        c = _Client({"A1": [_alarm(8, end=False)], "B1": [_alarm(8)]})
        t = ga.sync_alarms(db, c, DAY, _invs(db), pause_s=0, tiers=TIERS, now=T0)
        assert t["alarm_due"] == 3  # never read: all due
        assert ga.inverter_tiers(db, DAY, ["A1", "A2", "B1"]) == {"A1": "hot", "A2": "cold", "B1": "warm"}

        def run(minutes):
            c.calls.clear()
            t = ga.sync_alarms(db, c, DAY, _invs(db), pause_s=0, tiers=TIERS, now=datetime.now(timezone.utc) + timedelta(minutes=minutes))
            return c.calls, t

        assert run(5)[0] == []
        calls, t = run(10)
        assert calls == ["A1"] and (t["alarm_hot"], t["alarm_warm"], t["alarm_cold"]) == (1, 1, 1)
        assert run(30)[0] == ["A1", "B1"]
        assert run(60)[0] == ["A1", "B1", "A2"]


def test_fault_status_makes_an_inverter_hot(factory):
    with factory() as db:
        c = _Client({})
        ga.sync_alarms(db, c, DAY, _invs(db), pause_s=0, tiers=TIERS, now=T0)
        db.add_all(
            [
                GrowattInverterReading(device_sn="A2", timestamp=datetime(2026, 11, 13, 8, 0), status=3),
                GrowattInverterReading(device_sn="A2", timestamp=datetime(2026, 11, 13, 8, 5), status=3),
                # B1 faulted earlier but is normal now: not hot
                GrowattInverterReading(device_sn="B1", timestamp=datetime(2026, 11, 13, 8, 0), status=3),
                GrowattInverterReading(device_sn="B1", timestamp=datetime(2026, 11, 13, 8, 5), status=1),
            ]
        )
        db.commit()
        assert ga.inverter_tiers(db, DAY, ["A1", "A2", "B1"]) == {"A1": "cold", "A2": "hot", "B1": "cold"}
        c.calls.clear()
        ga.sync_alarms(db, c, DAY, _invs(db), pause_s=0, tiers=TIERS, now=datetime.now(timezone.utc) + timedelta(minutes=10))
        assert c.calls == ["A2"]


def test_cold_reads_are_spread_over_ticks(factory):
    with factory() as db:
        db.add_all([GrowattInverter(device_sn=f"C{i:02d}", plant_id=3) for i in range(20)])
        db.commit()
        c = _Client({})
        tiers = ga.Tiers(hot=TIERS.hot, warm=TIERS.warm, cold=TIERS.cold, tick=timedelta(minutes=10))
        t = ga.sync_alarms(db, c, DAY, _invs(db), pause_s=0, tiers=tiers, now=T0)
        assert t["alarm_read"] == 23  # never read: not capped
        c.calls.clear()
        t = ga.sync_alarms(db, c, DAY, _invs(db), pause_s=0, tiers=tiers, now=datetime.now(timezone.utc) + timedelta(minutes=60))
        # 23 cold, all due: at most ceil(1.5 x 23 x 10/60) = 6 this tick, the rest on later ticks
        assert t["alarm_due"] == 6 and len(c.calls) == 6


def test_alarm_schedule_skips_pwa_checks_and_ends_at_20():
    s = next(x for x in default_schedule() if x.job == "alarms")
    bkk = jobs.PLANT_TZ
    # checks are snapshots at hh:00 − 10 min: history pull 08:47, publish 08:50
    assert s.is_due(datetime(2026, 11, 13, 8, 41, tzinfo=bkk), None)
    assert not s.is_due(datetime(2026, 11, 13, 8, 42, tzinfo=bkk), None)
    assert not s.is_due(datetime(2026, 11, 13, 12, 50, tzinfo=bkk), None)
    assert s.is_due(datetime(2026, 11, 13, 12, 51, tzinfo=bkk), None)
    assert s.is_due(datetime(2026, 11, 13, 9, 20, tzinfo=bkk), None)
    assert s.is_due(datetime(2026, 11, 13, 19, 55, tzinfo=bkk), None)
    assert not s.is_due(datetime(2026, 11, 13, 20, 0, tzinfo=bkk), None)


def test_next_run_at_follows_tick_and_window():
    bkk = jobs.PLANT_TZ
    at = lambda h, m, d=13: datetime(2026, 11, d, h, m, tzinfo=bkk)  # noqa: E731
    assert ga.next_run_at(at(9, 3), at(9, 0)) == at(9, 10)
    assert ga.next_run_at(at(9, 45), at(9, 0)) == at(9, 10)  # overdue: stays in the past
    assert ga.next_run_at(at(19, 55), at(19, 52)) == at(5, 0, 14)  # after the window: tomorrow 05:00
    assert ga.next_run_at(at(3, 0), None) == at(5, 0)
    # last run yesterday evening: due at 05:00 today, overdue if the worker has not run by 06:00
    assert ga.next_run_at(at(6, 0, 14), at(19, 50)) == at(5, 0, 14)


def test_alarm_still_reported_at_last_read_is_hot(factory):
    """Growatt's real shape: an ongoing alarm is re-reported every ~5 min with end = start."""

    def rec(hm):
        t = f"2026-11-13 {hm}:00"
        return {"start_time": t, "end_time": t, "alarm_code": 7, "alarm_message": "PV iso low", "fault_type": "Warning", "status": 1}

    with factory() as db:
        inv = {i.device_sn: i for i in _invs(db)}
        read = datetime(2026, 11, 13, 3, 0, tzinfo=timezone.utc)  # 10:00 Bangkok
        ga.store_inverter_day(db, inv["A1"], DAY, [rec("09:50"), rec("09:55")], read)  # still reported
        ga.store_inverter_day(db, inv["B1"], DAY, [rec("08:00")], read)  # stopped 2 h before the read
        assert ga.inverter_tiers(db, DAY, ["A1", "B1"]) == {"A1": "hot", "B1": "warm"}

    body = _api(factory, "admin").get("/api/growatt/alarms", params={"day": DAY.isoformat()}).json()
    assert {a["device_sn"]: a["read_at"] for a in body["alarms"]}["B1"] == read.isoformat()
