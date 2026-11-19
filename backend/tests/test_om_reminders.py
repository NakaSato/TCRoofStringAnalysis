"""Calendar Team (Phase 3): push reminders (evening before, Monday week) and the ICS feed."""

from __future__ import annotations

from datetime import date, datetime, timezone

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import sessionmaker

from app.auth import hash_password
from app.config import settings
from app.db.models import GrowattPlant, OmPushMark, OmTask, OmTaskAssignee, OmTeam, OmTeamMember, PushToken, User, UserPlantAssignment
from app.db.seed import ensure_seeded
from app.db.session import Base, build_engine, get_db
from app.main import create_app
from app.services import om_ics, om_reminders, site_events
from app.worker import Schedule

TODAY = date(2026, 11, 23)  # a Monday
NOW = datetime(2026, 11, 23, 11, 0, tzinfo=timezone.utc)  # 18:00 Bangkok
P1, P2 = 9201, 9202  # eng: P1 only


class Sender:
    def __init__(self):
        self.msgs = []

    def __call__(self, msgs):
        self.msgs.extend(msgs)
        return [None] * len(msgs)


@pytest.fixture()
def env(tmp_path, monkeypatch):
    monkeypatch.setattr(site_events, "_today", lambda: TODAY)
    for k, v in {
        "firebase_web_api_key": "web-key",
        "firebase_web_app_id": "1:23:web:abc",
        "firebase_messaging_sender_id": "23",
        "firebase_vapid_key": "vapid",
        "firebase_project_id": "demo",
    }.items():
        monkeypatch.setattr(settings, k, v)
    engine = build_engine(f"sqlite:///{tmp_path / 'rem.db'}")
    Base.metadata.create_all(bind=engine)
    f = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)
    with f() as db:
        ensure_seeded(db)
        db.add_all([GrowattPlant(plant_id=P1, name="Roof One"), GrowattPlant(plant_id=P2, name="Roof Two")])
        eng = db.scalars(select(User).where(User.username == "engineer")).one()
        admin = db.scalars(select(User).where(User.username == "admin")).one()
        crew = User(username="crew", email="crew@example.com", full_name="Crew Member",
                    hashed_password=hash_password("crewpass"), role="engineer")
        db.add(crew)
        db.flush()
        db.add_all([UserPlantAssignment(user_id=eng.id, plant_id=P1), UserPlantAssignment(user_id=crew.id, plant_id=P1)])
        team = OmTeam(name="Crew North")
        db.add(team)
        db.flush()
        db.add(OmTeamMember(team_id=team.id, user_id=crew.id))
        for uid, tok in ((eng.id, "tok-eng"), (admin.id, "tok-admin"), (crew.id, "tok-crew")):
            db.add(PushToken(user_id=uid, token=tok, created_at=NOW, last_seen_at=NOW))
        db.commit()
        ids = {"admin": admin.id, "eng": eng.id, "crew": crew.id, "team": team.id}
    return f, ids


def _add(db, plant, start, end=None, status="planned", users=(), team=None, title=None):
    t = OmTask(plant_id=plant, task_type="cleaning", start_day=start, end_day=end or start, status=status, team_id=team, title=title)
    db.add(t)
    db.flush()
    for u in users:
        db.add(OmTaskAssignee(task_id=t.id, user_id=u))
    db.commit()
    return t


def _by_token(sender):
    out = {}
    for m in sender.msgs:
        out.setdefault(m.token, []).append(m.data)
    return out


def test_tomorrow_goes_to_assignees_and_team_members_once(env):
    f, ids = env
    tomorrow = date(2026, 11, 24)
    with f() as db:
        _add(db, P1, tomorrow, date(2026, 11, 25), users=[ids["eng"]], title="Whole roof")
        _add(db, P1, tomorrow, team=ids["team"])
        _add(db, P2, tomorrow, users=[ids["eng"], ids["admin"]])  # eng can't see P2
        _add(db, P1, tomorrow, status="in_progress", users=[ids["admin"]])  # not planned
        _add(db, P1, date(2026, 11, 26), users=[ids["admin"]])  # not tomorrow
        s = Sender()
        detail = om_reminders.notify_tomorrow(db, sender=s, now=NOW)
    msgs = _by_token(s)
    assert detail["people"] == 3 and detail["sent"] == 3
    assert msgs["tok-eng"] == [{
        "title": "Tomorrow: Cleaning · Roof One",
        "body": "Whole roof\n2 days, until Wed 25 Nov",
        "url": "/calendar?view=list&d=2026-11-24&user=me",
        "tag": "om-tomorrow",
    }]
    assert msgs["tok-crew"][0]["title"] == "Tomorrow: Cleaning · Roof One"
    assert msgs["tok-admin"][0]["title"] == "Tomorrow: Cleaning · Roof Two"

    with f() as db:  # a re-run pushes nothing
        s2 = Sender()
        again = om_reminders.notify_tomorrow(db, sender=s2, now=NOW)
        assert s2.msgs == [] and again["already"] == 3
        assert {m.user_id for m in db.scalars(select(OmPushMark))} == {ids["eng"], ids["crew"], ids["admin"]}


def test_several_tasks_tomorrow_become_one_count(env):
    f, ids = env
    with f() as db:
        for _ in range(5):
            _add(db, P1, date(2026, 11, 24), users=[ids["eng"]])
        s = Sender()
        om_reminders.notify_tomorrow(db, sender=s, now=NOW)
    (data,) = _by_token(s)["tok-eng"]
    assert data["title"] == "Tomorrow: 5 tasks" and data["body"].endswith("+2 more")


def test_week_summary_counts_this_week_and_overdue(env):
    f, ids = env
    with f() as db:
        _add(db, P1, date(2026, 11, 20), date(2026, 11, 24), status="in_progress", users=[ids["eng"]])  # spans Monday
        _add(db, P1, date(2026, 11, 27), users=[ids["eng"]])
        _add(db, P1, date(2026, 11, 10), users=[ids["eng"]])  # overdue
        _add(db, P1, date(2026, 11, 25), status="done", users=[ids["eng"]])  # done: not counted
        _add(db, P1, date(2026, 12, 1), users=[ids["eng"]])  # next week
        _add(db, P1, date(2026, 11, 3), users=[ids["crew"]])  # crew: only overdue
        s = Sender()
        om_reminders.notify_week(db, sender=s, now=NOW)
    msgs = _by_token(s)
    assert msgs["tok-eng"] == [{
        "title": "This week: 2 tasks, 1 overdue",
        "body": "Mon 23 · Cleaning · Roof One\nFri 27 · Cleaning · Roof One",
        "url": "/calendar?view=week&d=2026-11-23&user=me",
        "tag": "om-week",
    }]
    assert msgs["tok-crew"][0]["title"] == "This week: 0 tasks, 1 overdue"
    assert "tok-admin" not in msgs


def test_worker_without_web_config_still_sends_and_no_devices_sends_nothing(env, monkeypatch):
    f, ids = env
    for k in ("firebase_web_api_key", "firebase_web_app_id", "firebase_messaging_sender_id", "firebase_vapid_key"):
        monkeypatch.setattr(settings, k, "")  # the VM worker's .env has none of these
    with f() as db:
        _add(db, P1, date(2026, 11, 24), users=[ids["eng"]])
        s = Sender()
        assert om_reminders.notify_tomorrow(db, sender=s, now=NOW)["sent"] == 1
        db.query(PushToken).delete()
        db.commit()
        s2 = Sender()
        assert om_reminders.notify_week(db, sender=s2, now=NOW) == {"day": "2026-11-23", "devices": 0}
        assert s2.msgs == []


def test_my_work_filter_includes_team_tasks(env):
    f, ids = env
    with f() as db:
        team_task = _add(db, P1, date(2026, 11, 24), team=ids["team"])
        _add(db, P1, date(2026, 11, 25), users=[ids["eng"]])
    client, hdr = _client(f)
    crew = hdr("crew", "crewpass")
    body = client.get(f"/growatt/calendar/tasks?from=2026-11-23&to=2026-11-29&user_id={ids['crew']}", headers=crew).json()
    assert [t["id"] for t in body["tasks"]] == [team_task.id]


def test_weekly_schedule_fires_only_on_monday():
    s = Schedule("om_weekly", at=datetime(2026, 1, 1, 7, 30).time(), weekdays=(0,))
    monday = datetime(2026, 11, 23, 0, 31, tzinfo=timezone.utc)  # 07:31 Bangkok
    assert s.is_due(monday, None)
    assert not s.is_due(datetime(2026, 11, 24, 0, 31, tzinfo=timezone.utc), None)


# --------------------------------------------------------------------------- ICS feed


def _client(f):
    app = create_app()

    def override():
        with f() as db:
            yield db

    app.dependency_overrides[get_db] = override
    client = TestClient(app)

    def hdr(user, pw):
        tok = client.post("/auth/login", json={"username": user, "password": pw}).json()["access_token"]
        return {"Authorization": f"Bearer {tok}"}

    return client, hdr


def test_feed_link_lists_only_my_tasks_and_can_be_revoked(env):
    f, ids = env
    with f() as db:
        mine = _add(db, P1, date(2026, 11, 24), date(2026, 11, 25), users=[ids["eng"]], title="North, east; west")
        _add(db, P1, date(2026, 11, 26), users=[ids["crew"]])  # someone else's
        _add(db, P2, date(2026, 11, 26), users=[ids["eng"]])  # plant eng can't see
        _add(db, P1, date(2026, 11, 27), status="cancelled", users=[ids["eng"]])
        _add(db, P1, date(2027, 9, 1), users=[ids["eng"]])  # beyond 180 days
    client, hdr = _client(f)
    eng = hdr("engineer", "engineer123")
    assert client.get("/growatt/calendar/feed", headers=eng).json()["enabled"] is False

    first = client.post("/growatt/calendar/feed", headers=eng).json()
    assert first["enabled"] is True and first["path"].startswith("/api/ics/calendar/")
    with f() as db:  # only the hash is stored
        token = first["path"].rsplit("/", 1)[1][: -len(".ics")]
        assert token not in {r.token_hash for r in db.scalars(select(om_ics.OmIcsFeed))}

    res = client.get(first["path"][len("/api"):], headers={"x-forwarded-host": "app.example.com", "x-forwarded-proto": "https"})
    assert res.status_code == 200 and res.headers["content-type"].startswith("text/calendar")
    body = res.text
    assert body.count("BEGIN:VEVENT") == 1 and f"UID:om-task-{mine.id}@tcroof" in body
    assert "DTSTART;VALUE=DATE:20261124" in body and "DTEND;VALUE=DATE:20261126" in body
    assert "SUMMARY:Cleaning · Roof One: North\\, east\\; west" in body
    assert all(len(line.encode()) <= 75 for line in body.split("\r\n"))
    assert "https://app.example.com/calendar?view=list" in body.replace("\r\n ", "")

    second = client.post("/growatt/calendar/feed", headers=eng).json()  # a new link replaces the old
    assert client.get(first["path"][len("/api"):]).status_code == 404
    assert client.get(second["path"][len("/api"):]).status_code == 200
    assert client.delete("/growatt/calendar/feed", headers=eng).status_code == 204
    assert client.get(second["path"][len("/api"):]).status_code == 404
    assert client.get("/ics/calendar/nonsense.ics").status_code == 404


def test_feed_includes_team_work_and_stops_for_an_inactive_user(env):
    f, ids = env
    with f() as db:
        _add(db, P1, date(2026, 11, 24), team=ids["team"])
    client, hdr = _client(f)
    crew = hdr("crew", "crewpass")
    path = client.post("/growatt/calendar/feed", headers=crew).json()["path"][len("/api"):]
    assert client.get(path).text.count("BEGIN:VEVENT") == 1
    with f() as db:
        db.get(User, ids["crew"]).is_active = False
        db.commit()
    assert client.get(path).status_code == 404
