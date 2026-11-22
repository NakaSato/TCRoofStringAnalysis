"""Calendar Team (Phase 1): planned O&M tasks, access scoping, Busy masking, done → Site log, teams."""

from __future__ import annotations

from datetime import date

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import sessionmaker

from app.auth import hash_password
from app.db.models import (
    GrowattInverter,
    GrowattIssue,
    GrowattPlant,
    OmTask,
    OmTaskHistory,
    OmTeam,
    OmTeamMember,
    SiteEvent,
    User,
    UserPlantAssignment,
)
from app.db.seed import ensure_seeded
from app.db.session import Base, build_engine, get_db
from app.main import create_app
from app.services import site_events
from app.services.growatt_sync.registry import remove_blocked_plants

TODAY = date(2026, 11, 19)
P1, P2, P3 = 9101, 9102, 9103  # P1: eng + eng2, P2: eng2 only, P3: nobody
SN = "INV_C1"
RANGE = "from=2026-11-01&to=2026-12-31"


@pytest.fixture()
def api(tmp_path, monkeypatch):
    monkeypatch.setattr(site_events, "_today", lambda: TODAY)
    engine = build_engine(f"sqlite:///{tmp_path / 'calendar.db'}")
    Base.metadata.create_all(bind=engine)
    f = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)
    with f() as db:
        ensure_seeded(db)
        for pid in (P1, P2, P3):
            db.add(GrowattPlant(plant_id=pid, name=f"Plant {pid}"))
        db.add(GrowattInverter(device_sn=SN, plant_id=P1, alias="Inverter C1"))
        eng = db.scalars(select(User).where(User.username == "engineer")).one()
        eng2 = User(username="eng2", email="eng2@example.com", full_name="Second Engineer",
                    hashed_password=hash_password("eng2pass"), role="engineer")
        db.add(eng2)
        db.flush()
        db.add_all([
            UserPlantAssignment(user_id=eng.id, plant_id=P1),
            UserPlantAssignment(user_id=eng2.id, plant_id=P1),
            UserPlantAssignment(user_id=eng2.id, plant_id=P2),
        ])
        db.commit()
        ids = {"admin": db.scalars(select(User.id).where(User.username == "admin")).one(), "eng": eng.id, "eng2": eng2.id}
    app = create_app()

    def override():
        with f() as db:
            yield db

    app.dependency_overrides[get_db] = override
    client = TestClient(app)

    def hdr(user, pw):
        tok = client.post("/auth/login", json={"username": user, "password": pw}).json()["access_token"]
        return {"Authorization": f"Bearer {tok}"}

    return f, client, ids, hdr("admin", "admin123"), hdr("engineer", "engineer123"), hdr("eng2", "eng2pass")


def _task(client, h, plant, **kw):
    body = {"task_type": "cleaning", "start_day": "2026-11-24", **kw}
    res = client.post(f"/growatt/plants/{plant}/tasks", headers=h, json=body)
    assert res.status_code == 201, res.text
    return res.json()


def test_engineer_plans_and_lists_on_own_plant_only(api):
    f, client, ids, admin, eng, eng2 = api
    t = _task(client, eng, P1, end_day="2026-11-25", assignee_ids=[ids["eng"], ids["eng2"]], title=" Whole roof ")
    assert t["status"] == "planned" and t["label"] == "Cleaning" and t["title"] == "Whole roof"
    assert {a["id"] for a in t["assignees"]} == {ids["eng"], ids["eng2"]} and t["created_by"] == "engineer"

    body = client.get(f"/growatt/calendar/tasks?{RANGE}", headers=eng).json()
    assert [x["id"] for x in body["tasks"]] == [t["id"]] and body["busy"] == []
    # overlap: a range that only touches the end day still returns it
    assert client.get("/growatt/calendar/tasks?from=2026-11-25&to=2026-11-30", headers=eng).json()["total"] == 1
    assert client.get("/growatt/calendar/tasks?from=2026-11-26&to=2026-11-30", headers=eng).json()["total"] == 0

    assert client.post(f"/growatt/plants/{P2}/tasks", headers=eng, json={"task_type": "repair", "start_day": "2026-11-24"}).status_code == 404
    assert client.get(f"/growatt/calendar/tasks?{RANGE}&plant_id={P2}", headers=eng).status_code == 404
    assert client.get(f"/growatt/plants/{P1}/tasks/{t['id']}", headers=eng).json()["history"][0]["change"]["created"]


def test_validation(api):
    f, client, ids, admin, eng, eng2 = api
    bad = [
        {"task_type": "cleaning", "start_day": "2026-11-24", "end_day": "2026-11-23"},
        {"task_type": "cleaning", "start_day": "2026-11-01", "end_day": "2027-01-15"},  # > 62 days
        {"task_type": "repair", "start_day": "2026-11-24", "string_no": 2},  # string without inverter
        {"task_type": "repair", "start_day": "2026-11-24", "device_sn": "NOPE"},
        {"task_type": "cleaning", "start_day": "2026-11-24", "assignee_ids": [ids["eng2"] + 99]},
        {"task_type": "cleaning", "start_day": "2026-11-24", "team_id": 999},
        {"task_type": "curtailment", "start_day": "2026-11-24"},  # Site-log-only type
    ]
    for b in bad:
        assert client.post(f"/growatt/plants/{P1}/tasks", headers=eng, json=b).status_code == 422, b
    # eng2 is not assigned to P3: nobody may put them on it, not even an admin
    assert client.post(f"/growatt/plants/{P3}/tasks", headers=admin,
                       json={"task_type": "cleaning", "start_day": "2026-11-24", "assignee_ids": [ids["eng2"]]}).status_code == 422
    assert client.get("/growatt/calendar/tasks?from=2026-01-01&to=2026-12-31", headers=eng).status_code == 422
    # a task in the future is fine (the Site log is the one that refuses future dates)
    assert _task(client, eng, P1, start_day="2027-01-10")["start_day"] == "2027-01-10"


def test_busy_blocks_hide_other_plants(api):
    f, client, ids, admin, eng, eng2 = api
    hidden = _task(client, admin, P2, task_type="repair", title="Secret roof", start_day="2026-11-26", assignee_ids=[ids["eng2"]])
    _task(client, admin, P3, start_day="2026-11-27", assignee_ids=[ids["admin"]])  # admin: not one of eng's lanes

    body = client.get(f"/growatt/calendar/tasks?{RANGE}", headers=eng).json()
    assert body["tasks"] == []
    assert len(body["busy"]) == 1
    b = body["busy"][0]
    assert b == {
        "id": None, "busy": True, "plant_id": None, "plant_name": None, "title": "Busy", "label": "Busy",
        "start_day": "2026-11-26", "end_day": "2026-11-26",
        "assignees": [{"id": ids["eng2"], "username": "eng2", "full_name": "Second Engineer", "role": "engineer"}],
    }
    assert hidden["title"] == "Secret roof" and "Secret" not in str(body) and str(P2) not in str(body)
    # filtering to one lane keeps it; a plant / type filter drops the Busy blocks
    assert len(client.get(f"/growatt/calendar/tasks?{RANGE}&user_id={ids['eng2']}", headers=eng).json()["busy"]) == 1
    assert client.get(f"/growatt/calendar/tasks?{RANGE}&user_id={ids['eng']}", headers=eng).json()["busy"] == []
    assert client.get(f"/growatt/calendar/tasks?{RANGE}&type=repair", headers=eng).json()["busy"] == []
    # eng2 sees the P2 task in full; the admin sees both with no Busy blocks
    assert client.get(f"/growatt/calendar/tasks?{RANGE}", headers=eng2).json()["tasks"][0]["title"] == "Secret roof"
    full = client.get(f"/growatt/calendar/tasks?{RANGE}", headers=admin).json()
    assert full["total"] == 2 and full["busy"] == []
    # lanes: eng sees itself and its P1 colleague, not the admin-only world
    lanes = client.get("/growatt/calendar/assignees", headers=eng).json()
    assert {u["id"] for u in lanes["users"]} == {ids["eng"], ids["eng2"]}
    on_p1 = client.get(f"/growatt/calendar/assignees?plant_id={P1}", headers=eng).json()
    assert {u["id"] for u in on_p1["users"]} == {ids["admin"], ids["eng"], ids["eng2"]}


def test_done_writes_the_site_event(api):
    f, client, ids, admin, eng, eng2 = api
    t = _task(client, eng, P1, task_type="pm_inspection", start_day="2026-11-17", end_day="2026-11-21",
              device_sn=SN, string_no=3, note="torque check", title="Quarterly PM")
    res = client.post(f"/growatt/plants/{P1}/tasks/{t['id']}/done", headers=eng, json={"cost_thb": 1200})
    assert res.status_code == 200, res.text
    done = res.json()
    assert done["status"] == "done" and done["done_by"] == "engineer" and done["site_event_id"]
    with f() as db:
        ev = db.get(SiteEvent, done["site_event_id"])
        assert ev.event_type == "pm_inspection" and ev.day == date(2026, 11, 17)
        assert ev.end_day == TODAY  # planned end (21st) capped at today
        assert ev.device_sn == SN and ev.string_no == 3 and ev.cost_thb == 1200
        assert ev.note == "Quarterly PM: torque check"
    events = client.get(f"/growatt/plants/{P1}/events?type=pm_inspection", headers=eng).json()
    assert events["total"] == 1 and events["events"][0]["label"] == "PM inspection"

    # done is final: no second done, no moving; the note can still change
    assert client.post(f"/growatt/plants/{P1}/tasks/{t['id']}/done", headers=eng, json={}).status_code == 409
    assert client.patch(f"/growatt/plants/{P1}/tasks/{t['id']}", headers=eng, json={"start_day": "2026-11-30"}).status_code == 409
    assert client.patch(f"/growatt/plants/{P1}/tasks/{t['id']}", headers=eng, json={"note": "ok"}).status_code == 200

    # a future task done early: both dates become today
    fut = _task(client, eng, P1, start_day="2026-12-02", end_day="2026-12-03")
    ev_id = client.post(f"/growatt/plants/{P1}/tasks/{fut['id']}/done", headers=eng, json={}).json()["site_event_id"]
    with f() as db:
        ev = db.get(SiteEvent, ev_id)
        assert ev.day == TODAY and ev.end_day is None


def test_move_status_history_and_overdue(api):
    f, client, ids, admin, eng, eng2 = api
    t = _task(client, eng, P1, start_day="2026-11-10", end_day="2026-11-12")
    assert t["overdue"] is True
    res = client.patch(f"/growatt/plants/{P1}/tasks/{t['id']}", headers=eng,
                       json={"start_day": "2026-11-23", "comment": "rain"})
    moved = res.json()
    assert (moved["start_day"], moved["end_day"], moved["status"], moved["overdue"]) == ("2026-11-23", "2026-11-25", "planned", False)
    hist = client.get(f"/growatt/plants/{P1}/tasks/{t['id']}", headers=eng).json()["history"]
    assert hist[0]["change"]["start_day"] == ["2026-11-10", "2026-11-23"] and hist[0]["comment"] == "rain"
    assert hist[0]["change"]["end_day"] == ["2026-11-12", "2026-11-25"]

    assert client.patch(f"/growatt/plants/{P1}/tasks/{t['id']}", headers=eng, json={"status": "in_progress"}).json()["status"] == "in_progress"
    assert client.patch(f"/growatt/plants/{P1}/tasks/{t['id']}", headers=eng, json={"status": "done"}).status_code == 422
    assert client.patch(f"/growatt/plants/{P1}/tasks/{t['id']}", headers=eng, json={"assignee_ids": [ids["eng2"]]}).json()["assignees"][0]["id"] == ids["eng2"]
    # nothing changed: no history row
    with f() as db:
        n = len(list(db.scalars(select(OmTaskHistory).where(OmTaskHistory.task_id == t["id"]))))
    client.patch(f"/growatt/plants/{P1}/tasks/{t['id']}", headers=eng, json={"status": "in_progress"})
    with f() as db:
        assert len(list(db.scalars(select(OmTaskHistory).where(OmTaskHistory.task_id == t["id"])))) == n
    # overdue filter
    _task(client, eng, P1, start_day="2026-11-02")
    od = client.get(f"/growatt/calendar/tasks?{RANGE}&overdue=true", headers=eng).json()
    assert od["total"] == 1 and od["summary"]["overdue"] == 1


def test_delete_rules(api):
    f, client, ids, admin, eng, eng2 = api
    mine = _task(client, eng, P1)
    theirs = _task(client, admin, P1)
    started = _task(client, eng, P1)
    client.patch(f"/growatt/plants/{P1}/tasks/{started['id']}", headers=eng, json={"status": "in_progress"})
    assert client.get(f"/growatt/plants/{P1}/tasks/{mine['id']}", headers=eng).json()["can_delete"] is True
    assert client.delete(f"/growatt/plants/{P1}/tasks/{theirs['id']}", headers=eng).status_code == 403
    assert client.delete(f"/growatt/plants/{P1}/tasks/{started['id']}", headers=eng).status_code == 403
    assert client.delete(f"/growatt/plants/{P1}/tasks/{mine['id']}", headers=eng).status_code == 204
    assert client.delete(f"/growatt/plants/{P1}/tasks/{started['id']}", headers=admin).status_code == 204
    assert client.delete(f"/growatt/plants/{P2}/tasks/{theirs['id']}", headers=admin).status_code == 404  # wrong plant


def test_teams(api):
    f, client, ids, admin, eng, eng2 = api
    assert client.post("/growatt/calendar/teams", headers=eng, json={"name": "Crew A"}).status_code == 403
    crew = client.post("/growatt/calendar/teams", headers=admin, json={"name": "Crew North", "color": "#0ea5e9", "member_ids": [ids["eng"]]}).json()
    contractor = client.post("/growatt/calendar/teams", headers=admin, json={"name": "SolarClean contractor"}).json()
    assert contractor["members"] == [] and crew["members"][0]["id"] == ids["eng"]
    assert client.post("/growatt/calendar/teams", headers=admin, json={"name": "Crew North"}).status_code == 422
    assert {t["name"] for t in client.get("/growatt/calendar/teams", headers=eng).json()} == {"Crew North", "SolarClean contractor"}

    t = _task(client, eng, P1, team_id=contractor["id"])
    assert t["team"]["name"] == "SolarClean contractor"
    assert client.get(f"/growatt/calendar/tasks?{RANGE}&team_id={contractor['id']}", headers=eng).json()["total"] == 1
    client.patch(f"/growatt/calendar/teams/{contractor['id']}", headers=admin, json={"active": False})
    assert {t["name"] for t in client.get("/growatt/calendar/teams", headers=eng).json()} == {"Crew North"}
    # the task keeps an inactive team; saving it unchanged still works
    assert client.patch(f"/growatt/plants/{P1}/tasks/{t['id']}", headers=eng, json={"team_id": contractor["id"], "note": "x"}).status_code == 200
    assert client.delete(f"/growatt/calendar/teams/{contractor['id']}", headers=admin).status_code == 204
    assert client.get(f"/growatt/plants/{P1}/tasks/{t['id']}", headers=eng).json()["team"] is None


def test_blocked_plant_removes_its_tasks(api):
    f, client, ids, admin, eng, eng2 = api
    _task(client, admin, P3)
    keep = _task(client, eng, P1)
    with f() as db:
        remove_blocked_plants(db, [P3])
        assert [t.id for t in db.scalars(select(OmTask))] == [keep["id"]]


def test_new_site_log_types(api):
    f, client, ids, admin, eng, eng2 = api
    for t in ("pm_inspection", "inverter_service", "site_visit"):
        res = client.post(f"/growatt/plants/{P1}/events", headers=eng, json={"event_type": t, "day": "2026-11-18"})
        assert res.status_code == 201, (t, res.text)
    body = client.get(f"/growatt/plants/{P1}/events?type=site_visit", headers=eng).json()
    assert body["total"] == 1 and {"value": "inverter_service", "label": "Inverter service"} in body["types"]


# --------------------------------------------------------------------------- Phase 2: plans, due, rounds


def _plan(client, h, **kw):
    body = {"name": "Monthly clean", "task_type": "cleaning", "every_n": 1, "unit": "month",
            "starts_on": "2026-11-24", "plant_ids": [P1, P2], **kw}
    return client.post("/growatt/calendar/plans", headers=h, json=body)


def _plan_tasks(f, plan_id=None):
    with f() as db:
        q = select(OmTask).order_by(OmTask.plant_id, OmTask.start_day)
        if plan_id is not None:
            q = q.where(OmTask.plan_id == plan_id)
        return list(db.scalars(q))


def test_plan_generates_occurrences_and_keeps_moved_tasks(api):
    f, client, ids, admin, eng, eng2 = api
    assert _plan(client, eng).status_code == 403
    res = _plan(client, admin, assignee_ids=[ids["eng"]])
    assert res.status_code == 201, res.text
    plan = res.json()
    # today 19 Nov, 90 days ahead → 24 Nov, 24 Dec, 24 Jan (a Sunday → Mon 25 Jan) on both plants
    assert plan["result"] == {"created": 6, "deleted": 0, "updated": 0}
    assert plan["next_days"] == ["2026-11-24", "2026-12-24", "2027-01-25"] and plan["upcoming_tasks"] == 6
    tasks = _plan_tasks(f, plan["id"])
    assert {(t.plant_id, t.start_day.isoformat()) for t in tasks} == {
        (p, d) for p in (P1, P2) for d in ("2026-11-24", "2026-12-24", "2027-01-25")
    }
    assert all(t.scheduled_day == t.start_day and t.title == "Monthly clean" for t in tasks)
    # eng may work on P1 only: assigned there, left off P2
    p1 = next(t for t in tasks if t.plant_id == P1 and t.start_day == date(2026, 12, 24))
    got = client.get(f"/growatt/plants/{P1}/tasks/{p1.id}", headers=eng).json()
    assert [a["id"] for a in got["assignees"]] == [ids["eng"]]
    p2 = next(t for t in tasks if t.plant_id == P2 and t.start_day == date(2026, 11, 24))
    assert client.get(f"/growatt/plants/{P2}/tasks/{p2.id}", headers=admin).json()["assignees"] == []

    # someone moves the P1 December task; the plan then changes to every 2 months and a new name
    assert client.patch(f"/growatt/plants/{P1}/tasks/{p1.id}", headers=eng, json={"start_day": "2026-12-28"}).status_code == 200
    res = client.patch(f"/growatt/calendar/plans/{plan['id']}", headers=admin, json={"every_n": 2, "name": "Bi-monthly clean"})
    assert res.status_code == 200, res.text
    # P2's untouched December task goes; P1's moved one stays; the 4 untouched others are renamed
    assert res.json()["result"] == {"created": 0, "deleted": 1, "updated": 4}
    tasks = _plan_tasks(f, plan["id"])
    assert {(t.plant_id, t.start_day.isoformat(), t.title) for t in tasks} == {
        (P1, "2026-11-24", "Bi-monthly clean"), (P1, "2026-12-28", "Monthly clean"), (P1, "2027-01-25", "Bi-monthly clean"),
        (P2, "2026-11-24", "Bi-monthly clean"), (P2, "2027-01-25", "Bi-monthly clean"),
    }
    # the nightly job is idempotent and never regenerates the moved task on its old day
    from app.services import jobs

    with f() as db:
        status, detail = jobs.job_om_plans(db)
    assert status == "ok" and detail == {"plans": 1, "created": 0, "deleted": 0, "updated": 0}
    assert "om_plans" in jobs.JOBS
    from app.worker import default_schedule

    assert any(s.job == "om_plans" for s in default_schedule())

    # engineers read the plans covering their plants, with only those plants
    seen = client.get("/growatt/calendar/plans", headers=eng).json()
    assert [p["id"] for p in seen["plans"]] == [plan["id"]] and seen["plans"][0]["plant_ids"] == [P1]
    assert {x["key"] for x in seen["presets"]} == {"cleaning_dry", "inverter_quarterly", "ir_yearly"}

    # deleting: untouched future tasks go, the moved one stays as a one-off
    res = client.delete(f"/growatt/calendar/plans/{plan['id']}", headers=admin)
    assert res.status_code == 200 and res.json() == {"deleted": 4, "kept": 1}
    left = _plan_tasks(f)
    assert [(t.start_day.isoformat(), t.plan_id) for t in left] == [("2026-12-28", None)]


def test_plan_validation_and_inactive(api):
    f, client, ids, admin, eng, eng2 = api
    assert _plan(client, admin, season_from_month=11).status_code == 422  # both season months or none
    assert _plan(client, admin, plant_ids=[424242]).status_code == 422
    assert _plan(client, admin, every_n=40).status_code == 422  # > 36 months
    res = _plan(client, admin, active=False)
    assert res.status_code == 201 and res.json()["result"]["created"] == 0 and res.json()["next_days"] == []
    pid = res.json()["id"]
    assert client.patch(f"/growatt/calendar/plans/{pid}", headers=admin, json={"active": True}).json()["result"]["created"] == 6
    assert client.patch(f"/growatt/calendar/plans/{pid}", headers=admin, json={"active": False}).json()["result"]["deleted"] == 6


def test_due_and_plant_settings(api):
    f, client, ids, admin, eng, eng2 = api
    ev = client.post(f"/growatt/plants/{P1}/events", headers=eng, json={"event_type": "cleaning", "day": "2026-10-30", "end_day": "2026-11-01"})
    assert ev.status_code == 201, ev.text
    assert client.put(f"/growatt/plants/{P1}/om-settings", headers=eng, json={"cleaning_crew_days": 0.5}).status_code == 403
    res = client.put(f"/growatt/plants/{P1}/om-settings", headers=admin, json={"cleaning_crew_days": 0.5, "cleaning_cost_thb": 3000})
    assert res.status_code == 200 and res.json()["cleaning_cost_thb"] == 3000
    assert client.put("/growatt/plants/424242/om-settings", headers=admin, json={}).status_code == 404
    _task(client, admin, P1, start_day="2026-11-10")  # overdue (ends before 19 Nov)
    _task(client, admin, P1, start_day="2026-12-03")

    body = client.get("/growatt/calendar/due?month=2026-11", headers=admin).json()
    rows = {r["plant_id"]: r for r in body["plants"]}
    assert set(rows) == {P1, P2, P3}
    p1 = rows[P1]
    assert p1["last"] == {"cleaning": "2026-11-01"} and p1["days_since_cleaning"] == 18
    assert p1["next_cleaning"] == "2026-11-10" and p1["overdue"] == 1
    assert p1["month"] == {"total": 1, "done": 0, "open": 1}
    assert p1["settings"]["cleaning_crew_days"] == 0.5 and p1["settings"]["cleaning_cost_thb"] == 3000
    assert rows[P2]["days_since_cleaning"] is None and rows[P2]["settings"]["cleaning_cost_thb"] is None
    assert body["summary"]["never_cleaned"] == 2 and body["summary"]["with_overdue"] == 1
    # engineers: their plants only
    assert [r["plant_id"] for r in client.get("/growatt/calendar/due?month=2026-11", headers=eng).json()["plants"]] == [P1]
    assert client.get("/growatt/calendar/due?month=2026-13", headers=eng).status_code == 422


def test_cleaning_round_preview_and_save(api):
    f, client, ids, admin, eng, eng2 = api
    client.put(f"/growatt/plants/{P1}/om-settings", headers=admin, json={"cleaning_crew_days": 0.5, "cleaning_cost_thb": 3000})
    client.post(f"/growatt/plants/{P1}/events", headers=admin, json={"event_type": "cleaning", "day": "2026-11-01"})
    q = {"plant_ids": [P1, P2, P3], "start_day": "2026-11-23", "crews": 1, "group_by": "none"}
    assert client.post("/growatt/calendar/rounds/preview", headers=eng, json=q).status_code == 403
    assert client.post("/growatt/calendar/rounds/preview", headers=admin, json={**q, "start_day": "2026-11-18"}).status_code == 422
    res = client.post("/growatt/calendar/rounds/preview", headers=admin, json=q)
    assert res.status_code == 200, res.text
    pv = res.json()
    # never-cleaned plants first (by id), then P1; P1 is half a crew-day
    assert [(x["plant_id"], x["start_day"]) for x in pv["items"]] == [(P2, "2026-11-23"), (P3, "2026-11-24"), (P1, "2026-11-25")]
    assert pv["duration_missing"] == 2 and pv["cost_thb"] == 3000 and pv["cost_missing"] == 2
    assert pv["end_day"] == "2026-11-25" and pv["unscheduled"] == []

    items = [{"plant_id": x["plant_id"], "start_day": x["start_day"], "end_day": x["end_day"]} for x in pv["items"]]
    assert client.post("/growatt/calendar/rounds", headers=eng, json={"items": items}).status_code == 403
    res = client.post("/growatt/calendar/rounds", headers=admin, json={"title": "Dry season round 1", "assignee_ids": [ids["eng"]], "items": items})
    assert res.status_code == 201, res.text
    out = res.json()
    assert out["created"] == 3 and out["dropped_assignees"] == {str(P2): [ids["eng"]], str(P3): [ids["eng"]]}
    tasks = {t.plant_id: t for t in _plan_tasks(f)}
    assert tasks[P1].est_cost_thb == 3000 and tasks[P2].est_cost_thb is None
    assert tasks[P1].title == "Dry season round 1" and tasks[P1].task_type == "cleaning"
    got = client.get(f"/growatt/plants/{P1}/tasks/{tasks[P1].id}", headers=eng).json()
    assert [a["id"] for a in got["assignees"]] == [ids["eng"]]
    # the preview now shows the plants as already planned
    again = client.post("/growatt/calendar/rounds/preview", headers=admin, json=q).json()
    assert {x["plant_id"]: x["already_planned"] for x in again["items"]}[P1] == "2026-11-25"


def test_blocked_plant_cleanup_removes_plan_links_and_settings(api):
    f, client, ids, admin, eng, eng2 = api
    from app.db.models import OmPlanPlant, OmPlantSettings

    _plan(client, admin)
    client.put(f"/growatt/plants/{P2}/om-settings", headers=admin, json={"cleaning_cost_thb": 100})
    with f() as db:
        remove_blocked_plants(db, [P2])
        assert db.scalars(select(OmPlanPlant.plant_id)).all() == [P1]
        assert db.get(OmPlantSettings, P2) is None


def test_plan_keeps_its_inactive_team(api):
    f, client, ids, admin, eng, eng2 = api
    team = client.post("/growatt/calendar/teams", headers=admin, json={"name": "Crew South"}).json()
    pid = _plan(client, admin, default_team_id=team["id"]).json()["id"]
    client.patch(f"/growatt/calendar/teams/{team['id']}", headers=admin, json={"active": False})
    # the plan can still be paused or edited with its (now inactive) team ...
    res = client.patch(f"/growatt/calendar/plans/{pid}", headers=admin, json={"active": False})
    assert res.status_code == 200, res.text
    assert client.patch(f"/growatt/calendar/plans/{pid}", headers=admin, json={"note": "x", "default_team_id": team["id"]}).status_code == 200
    # ... but can't be switched to an inactive team it doesn't already have
    other = _plan(client, admin).json()["id"]
    assert client.patch(f"/growatt/calendar/plans/{other}", headers=admin, json={"default_team_id": team["id"]}).status_code == 422


def test_round_leaves_out_plants_too_long_for_one_task(api):
    f, client, ids, admin, eng, eng2 = api
    client.put(f"/growatt/plants/{P1}/om-settings", headers=admin, json={"cleaning_crew_days": 60})
    q = {"plant_ids": [P1, P2], "start_day": "2026-11-23", "crews": 1, "group_by": "none"}
    body = client.post("/growatt/calendar/rounds/preview", headers=admin, json=q).json()
    assert [x["plant_id"] for x in body["too_long"]] == [P1]
    assert [x["plant_id"] for x in body["items"]] == [P2] and body["items"][0]["start_day"] == "2026-11-23"
    # the preview saves as shown
    res = client.post("/growatt/calendar/rounds", headers=admin, json={"items": body["items"]})
    assert res.status_code == 201, res.text


# --------------------------------------------------------------------------- audit fixes (#68, #70)


def _issue(f, plant, shadow):
    with f() as db:
        i = GrowattIssue(plant_id=plant, rule="R1", tier="P2", opened_day=TODAY, last_seen_day=TODAY, shadow=shadow)
        db.add(i)
        db.commit()
        return i.id


def test_shadow_issue_stays_hidden_from_engineers(api):
    f, client, ids, admin, eng, eng2 = api
    shadow = _issue(f, P1, shadow=True)
    live = _issue(f, P1, shadow=False)
    t = _task(client, admin, P1, start_day="2026-11-18", issue_id=shadow, assignee_ids=[ids["eng"]])
    assert t["issue_id"] == shadow and t["issue"]["id"] == shadow  # the admin sees the link

    # list, one task and its history: no shadow id anywhere for the engineer
    row = client.get(f"/growatt/calendar/tasks?{RANGE}", headers=eng).json()["tasks"][0]
    assert row["issue_id"] is None and row["issue"] is None
    client.patch(f"/growatt/plants/{P1}/tasks/{t['id']}", headers=admin, json={"issue_id": live})
    client.patch(f"/growatt/plants/{P1}/tasks/{t['id']}", headers=admin, json={"issue_id": shadow, "title": "Back"})
    one = client.get(f"/growatt/plants/{P1}/tasks/{t['id']}", headers=eng).json()
    assert one["issue_id"] is None
    assert all("issue_id" not in h["change"] for h in one["history"])
    assert any(h["change"].get("title") == [None, "Back"] for h in one["history"])  # the rest of that entry stays
    assert any("issue_id" in h["change"] for h in client.get(f"/growatt/plants/{P1}/tasks/{t['id']}", headers=admin).json()["history"])

    # editing what they see (issue_id null) keeps the admin's link
    res = client.patch(f"/growatt/plants/{P1}/tasks/{t['id']}", headers=eng, json={"issue_id": None, "note": "ladder"})
    assert res.status_code == 200, res.text
    with f() as db:
        assert db.get(OmTask, t["id"]).issue_id == shadow

    # done works for the engineer; the event is not linked and the shadow issue stays open
    res = client.post(f"/growatt/plants/{P1}/tasks/{t['id']}/done", headers=eng, json={"close_issue": True})
    assert res.status_code == 200, res.text
    with f() as db:
        ev = db.get(SiteEvent, res.json()["site_event_id"])
        assert ev.issue_id is None
        assert db.get(GrowattIssue, shadow).status == "open"

    # an admin finishing a shadow-linked task still links and closes it
    t2 = _task(client, admin, P1, start_day="2026-11-18", issue_id=shadow)
    res = client.post(f"/growatt/plants/{P1}/tasks/{t2['id']}/done", headers=admin, json={"close_issue": True})
    assert res.status_code == 200, res.text
    with f() as db:
        assert db.get(SiteEvent, res.json()["site_event_id"]).issue_id == shadow
        assert db.get(GrowattIssue, shadow).status == "resolved"


def test_plan_counts_and_assignees_are_scoped_for_engineers(api):
    f, client, ids, admin, eng, eng2 = api
    with f() as db:  # eng3 works only on P2, which eng cannot see
        eng3 = User(username="eng3", email="eng3@example.com", full_name="Third", hashed_password=hash_password("x" * 8), role="engineer")
        db.add(eng3)
        db.flush()
        db.add(UserPlantAssignment(user_id=eng3.id, plant_id=P2))
        db.commit()
        eng3_id = eng3.id
    res = _plan(client, admin, every_n=1, unit="week", assignee_ids=[ids["eng"], eng3_id])
    assert res.status_code == 201, res.text
    plan_id = res.json()["id"]
    per_plant = {pid: sum(1 for t in _plan_tasks(f, plan_id) if t.plant_id == pid and t.start_day >= TODAY) for pid in (P1, P2)}
    assert per_plant[P1] and per_plant[P2]

    full = next(p for p in client.get("/growatt/calendar/plans", headers=admin).json()["plans"] if p["id"] == plan_id)
    assert full["upcoming_tasks"] == per_plant[P1] + per_plant[P2]
    assert {a["id"] for a in full["assignees"]} == {ids["eng"], eng3_id}
    mine = next(p for p in client.get("/growatt/calendar/plans", headers=eng).json()["plans"] if p["id"] == plan_id)
    assert mine["plant_ids"] == [P1] and mine["upcoming_tasks"] == per_plant[P1]
    assert {a["id"] for a in mine["assignees"]} == {ids["eng"]}  # eng3 shares no plant with eng


def test_busy_blocks_and_my_work_include_team_tasks(api):
    f, client, ids, admin, eng, eng2 = api
    with f() as db:
        team = OmTeam(name="Crew")
        db.add(team)
        db.flush()
        db.add(OmTeamMember(team_id=team.id, user_id=ids["eng2"]))
        db.commit()
        team_id = team.id
    # P2 work of eng2's team (no direct assignee): eng sees only a Busy block in eng2's lane
    _task(client, admin, P2, task_type="repair", title="Secret", start_day="2026-11-26", team_id=team_id)
    body = client.get(f"/growatt/calendar/tasks?{RANGE}", headers=eng).json()
    assert body["tasks"] == [] and len(body["busy"]) == 1
    assert [a["id"] for a in body["busy"][0]["assignees"]] == [ids["eng2"]] and "Secret" not in str(body)
    assert len(client.get(f"/growatt/calendar/tasks?{RANGE}&user_id={ids['eng2']}", headers=eng).json()["busy"]) == 1
    assert client.get(f"/growatt/calendar/tasks?{RANGE}&user_id={ids['eng']}", headers=eng).json()["busy"] == []
    # eng2 sees it in full under their own filter
    mine = client.get(f"/growatt/calendar/tasks?{RANGE}&user_id={ids['eng2']}", headers=eng2).json()
    assert [t["title"] for t in mine["tasks"]] == ["Secret"]


def test_round_groups_by_the_site_register_province(api):
    f, client, ids, admin, eng, eng2 = api
    from app.db.models import SiteRegister

    with f() as db:
        db.get(GrowattPlant, P1).city = "Bang Lamung"  # Growatt's city: a district, not the province
        db.get(GrowattPlant, P3).city = "Chonburi"
        db.add(SiteRegister(site_code="P1-001", plant_id=P1, name="S1", province="ชลบุรี", imported_by="admin"))
        db.add(SiteRegister(site_code="P1-003", plant_id=P3, name="S3", province="ชลบุรี", imported_by="admin"))
        db.commit()
    q = {"plant_ids": [P1, P2, P3], "start_day": "2026-11-23", "crews": 1, "group_by": "city"}
    pv = client.post("/growatt/calendar/rounds/preview", headers=admin, json=q).json()
    assert {x["plant_id"]: x["city"] for x in pv["items"]} == {P1: "ชลบุรี", P2: None, P3: "ชลบุรี"}
    due = client.get("/growatt/calendar/due?month=2026-11", headers=admin)
    assert due.status_code == 200, due.text
    assert {r["plant_id"]: r["city"] for r in due.json()["plants"]} == {P1: "ชลบุรี", P2: None, P3: "ชลบุรี"}
