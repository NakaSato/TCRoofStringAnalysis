"""Alarm push notifications: device tokens, which alarm events are pushed to whom, the test push."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import select

from app.config import settings
from app.db.models import AlarmPushMark, PushToken, SyncRun, User, UserPlantAssignment
from app.services import growatt_alarms as ga
from app.services import jobs, push
from tests.test_growatt_alarms import DAY, _alarm, _api, _Client, _invs, factory  # noqa: F401 - fixture

TOKEN_A = "token-admin-" + "a" * 40
TOKEN_E = "token-engineer-" + "e" * 40


def _at(h: int, m: int = 0) -> datetime:
    """Plant-local time on DAY as the aware `now` of a run."""
    return datetime(DAY.year, DAY.month, DAY.day, h, m, tzinfo=push.PLANT_TZ)


class _Sender:
    def __init__(self, gone=()):
        self.msgs, self.gone = [], set(gone)

    def __call__(self, msgs):
        self.msgs.extend(msgs)
        return [push.GONE if m.token in self.gone else None for m in msgs]


@pytest.fixture()
def configured(monkeypatch):
    monkeypatch.setattr(settings, "firebase_web_api_key", "web-key")
    monkeypatch.setattr(settings, "firebase_web_app_id", "1:23:web:abc")
    monkeypatch.setattr(settings, "firebase_messaging_sender_id", "23")
    monkeypatch.setattr(settings, "firebase_vapid_key", "vapid")
    monkeypatch.setattr(settings, "firebase_project_id", "demo")
    monkeypatch.setattr(settings, "push_alarm_levels", "fault")
    monkeypatch.setattr(ga.time, "sleep", lambda _s: None)


def _devices(db, engineer_plants=(2,)):
    """Admin and engineer each with one device; the engineer assigned `engineer_plants`."""
    admin = db.scalar(select(User).where(User.username == "admin"))
    eng = db.scalar(select(User).where(User.username == "engineer"))
    push.register_token(db, admin, TOKEN_A, "Chrome")
    push.register_token(db, eng, TOKEN_E, "Safari")
    db.add_all(UserPlantAssignment(user_id=eng.id, plant_id=p) for p in engineer_plants)
    db.commit()


def _sync(db, logs):
    since = datetime.now(timezone.utc) - timedelta(seconds=5)
    ga.sync_alarms(db, _Client(logs), DAY, _invs(db), pause_s=0)
    return since


def test_status_is_off_until_the_web_config_is_complete(factory, configured, monkeypatch):
    c = _api(factory, "engineer")
    s = c.get("/api/push/status").json()
    assert s["enabled"] is True and s["vapid_key"] == "vapid" and s["devices"] == 0
    assert s["config"] == {"apiKey": "web-key", "appId": "1:23:web:abc", "messagingSenderId": "23", "projectId": "demo"}
    assert s["levels"] == ["fault"]

    monkeypatch.setattr(settings, "firebase_vapid_key", "")
    s = c.get("/api/push/status").json()
    assert (s["enabled"], s["config"], s["vapid_key"]) == (False, None, None)
    assert c.post("/api/push/tokens", json={"token": TOKEN_E}).status_code == 409


def test_a_token_belongs_to_one_user_and_only_its_owner_removes_it(factory, configured):
    eng, admin = _api(factory, "engineer"), _api(factory, "admin")
    assert eng.post("/api/push/tokens", json={"token": TOKEN_E, "label": "Safari"}).json() == {"devices": 1}
    assert eng.post("/api/push/tokens", json={"token": TOKEN_E}).json() == {"devices": 1}  # again: no duplicate
    assert admin.post("/api/push/tokens/remove", json={"token": TOKEN_E}).json() == {"devices": 0}
    assert eng.get("/api/push/status").json()["devices"] == 1  # not the admin's to remove
    # the same browser, now signed in as the admin: the token moves
    assert admin.post("/api/push/tokens", json={"token": TOKEN_E}).json() == {"devices": 1}
    assert eng.get("/api/push/status").json()["devices"] == 0
    assert admin.post("/api/push/tokens", json={"token": "short"}).status_code == 422


def test_new_fault_goes_to_the_users_who_may_see_the_plant_once(factory, configured):
    with factory() as db:
        _devices(db)
        # plant 1 (A1): a fault now and one long over; plant 2 (B1): only a warning
        since = _sync(db, {"A1": [_alarm(6, code=7), _alarm(9, end=False)], "B1": [_alarm(9, code="E5", fault="Warning")]})
        s = _Sender()
        d = push.notify_new_alarms(db, DAY, since, s, now=_at(9, 5))
        assert (d["events"], d["plants"], d["sent"]) == (1, 1, 1)
        (m,) = s.msgs
        assert m.token == TOKEN_A  # the engineer is not assigned plant 1
        assert m.data == {
            "title": "Alarm · Alpha",
            "body": "A1 Fault: 101 Grid fault (09:00)",
            "url": "/alarms?plant=1",
            "tag": "plant-1",
        }

        # Growatt reports the same alarm again 5 min later: the same event, no second push
        since = _sync(db, {"A1": [_alarm(9, end=False), {**_alarm(9), "start_time": "2026-11-13 09:05:00"}]})
        assert push.notify_new_alarms(db, DAY, since, s, now=_at(9, 15))["events"] == 0
        assert len(s.msgs) == 1


def test_a_returning_alarm_is_pushed_again_only_after_the_repeat_time(factory, configured):
    with factory() as db:
        _devices(db, engineer_plants=(1,))
        s = _Sender()
        since = _sync(db, {"A1": [_alarm(9)]})
        assert push.notify_new_alarms(db, DAY, since, s, now=_at(9, 5))["sent"] == 2  # admin + engineer
        since = _sync(db, {"A1": [_alarm(9), _alarm(10)]})
        assert push.notify_new_alarms(db, DAY, since, s, now=_at(10, 5))["events"] == 0  # 60 min < 120
        since = _sync(db, {"A1": [_alarm(9), _alarm(10), _alarm(11)]})
        d = push.notify_new_alarms(db, DAY, since, s, now=_at(11, 10))
        assert (d["events"], d["sent"]) == (1, 2)
        assert s.msgs[-1].data["body"] == "A1 Fault: 101 Grid fault (11:00)"
        assert db.get(AlarmPushMark, ("A1", "101", DAY)).event_start == datetime(2026, 11, 13, 11, 0)


def test_many_plants_in_one_run_become_one_summary_and_warnings_can_be_pushed(factory, configured, monkeypatch):
    monkeypatch.setattr(settings, "push_alarm_levels", "fault,warning")
    monkeypatch.setattr(settings, "push_max_plants_per_user", 1)
    with factory() as db:
        _devices(db)
        since = _sync(db, {"A1": [_alarm(9)], "A2": [_alarm(9, code=5)], "B1": [_alarm(9, code="E5", fault="Warning")]})
        s = _Sender()
        d = push.notify_new_alarms(db, DAY, since, s, now=_at(9, 5))
        assert (d["events"], d["plants"], d["sent"]) == (3, 2, 2)
        by_token = {m.token: m.data for m in s.msgs}
        assert by_token[TOKEN_A] == {"title": "New alarms at 2 plants", "body": "Alpha, Beta", "url": "/alarms", "tag": "fleet"}
        assert by_token[TOKEN_E]["title"] == "Alarm · Beta"  # one plant: its own notification
        assert by_token[TOKEN_E]["body"] == "INV1 Warning: E5 Grid fault (09:00)"  # the plant's only inverter


def test_gone_tokens_are_deleted_and_no_devices_means_no_marks(factory, configured):
    with factory() as db:
        since = _sync(db, {"A1": [_alarm(9)]})
        s = _Sender(gone={TOKEN_A})
        assert push.notify_new_alarms(db, DAY, since, s, now=_at(9, 5)) == {"devices": 0}
        assert db.scalars(select(AlarmPushMark)).all() == []  # the first device still hears of it

        _devices(db, engineer_plants=(1,))
        d = push.notify_new_alarms(db, DAY, since, s, now=_at(9, 5))
        assert (d["sent"], d["removed"]) == (1, 1)
        assert [t.token for t in db.scalars(select(PushToken))] == [TOKEN_E]

        # a disabled user gets nothing
        db.scalar(select(User).where(User.username == "engineer")).is_active = False
        db.commit()
        since = _sync(db, {"A1": [_alarm(9)], "A2": [_alarm(9)]})
        s2 = _Sender()
        assert push.notify_new_alarms(db, DAY, since, s2, now=_at(9, 6))["sent"] == 0 and s2.msgs == []


def test_alarms_job_reports_push_and_survives_a_failing_sender(factory, configured, monkeypatch):
    monkeypatch.setattr(jobs, "_clients", lambda: {1: _Client({"A1": [_alarm(9)]})})
    monkeypatch.setattr(jobs, "_today", lambda: DAY)
    monkeypatch.setattr(settings, "firebase_credentials_file", "secrets/none.json")
    monkeypatch.setattr(settings, "push_alarm_max_age_min", 10**7)  # DAY is in the past
    s = _Sender()
    monkeypatch.setattr(push, "firebase_sender", lambda: s)
    with factory() as db:
        _devices(db)
        status, detail = jobs.job_alarms(db)
        assert status == "ok" and detail["push"]["sent"] == 1 and detail["push"]["tests"] == 0

    def broken():
        raise RuntimeError("no credentials")

    monkeypatch.setattr(push, "firebase_sender", broken)
    monkeypatch.setattr(jobs, "_clients", lambda: {1: _Client({"A1": [_alarm(9)], "A2": [_alarm(9)]})})
    with factory() as db:
        status, detail = jobs.job_alarms(db)
        assert status == "ok" and detail["alarm_inverters"] == 3  # the sync's own result stands
        assert detail["push"] == {"error": "RuntimeError: no credentials"}


def test_test_push_is_queued_by_the_api_and_sent_by_the_worker(factory, configured):
    c = _api(factory, "engineer")
    assert c.post("/api/push/test").status_code == 409  # no device yet
    c.post("/api/push/tokens", json={"token": TOKEN_E})
    r = c.post("/api/push/test")
    assert r.status_code == 202 and r.json() == {"queued": True, "devices": 1}
    assert c.post("/api/push/test").status_code == 202  # already queued: still accepted
    with factory() as db:
        assert [(r.job, r.status) for r in db.scalars(select(SyncRun))] == [("push_test", "queued")]
        s = _Sender()
        assert push.send_tests(db, s) == {"tests": 1, "sent": 1, "failed": 0, "removed": 0}
        assert s.msgs[0].token == TOKEN_E and s.msgs[0].data["tag"] == "test"
        assert push.send_tests(db, s) == {"tests": 0}  # the request was cleared

        # a request the worker finds too late is dropped, not sent
        eng = db.scalar(select(User).where(User.username == "engineer"))
        push.request_test(db, eng, now=datetime.now(timezone.utc) - timedelta(hours=1))
        assert push.send_tests(db, s)["tests"] == 0 and len(s.msgs) == 1
