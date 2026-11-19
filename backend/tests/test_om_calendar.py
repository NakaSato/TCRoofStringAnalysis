"""Calendar Team (Phase 1): planned O&M tasks, access scoping, Busy masking, done → Site log, teams."""

from __future__ import annotations

from datetime import date

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import sessionmaker

from app.auth import hash_password
from app.db.models import GrowattInverter, GrowattPlant, OmTask, OmTaskHistory, SiteEvent, User, UserPlantAssignment
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
