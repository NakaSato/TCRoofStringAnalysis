"""Site visit route phase 2: `/growatt/routes/candidates` (reasons, scoping, filters, ranking, service time)."""

from __future__ import annotations

from datetime import date, datetime

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import sessionmaker

from app.auth import hash_password
from app.db.models import (
    Claim,
    GrowattAlarm,
    GrowattInverter,
    GrowattIssue,
    GrowattPlant,
    OmPlantSettings,
    OmTask,
    OmTaskAssignee,
    OmTeam,
    OmTeamMember,
    User,
    UserPlantAssignment,
)
from app.db.seed import ensure_seeded
from app.db.session import Base, build_engine, get_db
from app.main import create_app
from app.services import site_events
from app.services import visit_route_candidates as vrc

TODAY = date(2026, 11, 19)
DAY = TODAY.isoformat()
# A: cleaning task today (eng, team T1) · B: repair task today (eng2) at 0,0 · C: P1 issue (nobody)
# D: P2 issue + shadow P1 · E: open fault alarm · F: claim due · G: overdue cleaning · H: overdue PM
# I: nothing worth a visit (done task, Info issue, warning alarm, claim later, closed fault)
A, B, C, D, E, F, G, H, I = range(9201, 9210)
NAMES = {A: "Alpha", B: "Bravo", C: "Charlie", D: "Delta", E: "Echo", F: "Foxtrot", G: "Golf", H: "Hotel", I: "India"}


def _issue(plant, rule, tier, thb, *, shadow=False, sno=None):
    return GrowattIssue(
        plant_id=plant, device_sn=f"SN{plant}", string_no=sno, rule=rule, tier=tier, safety=False, status="open",
        shadow=shadow, opened_day=date(2026, 11, 10), last_seen_day=date(2026, 11, 18), days_seen=5, daily={},
        lost_kwh_est=10.0, thb_per_day_est=thb,
    )


def _claim(plant, number, next_day, status="submitted"):
    return Claim(number=number, claim_type="inverter_warranty", status=status, cause="unknown", plant_id=plant,
                 counterparty="Growatt", next_action_day=next_day)


def _task(plant, kind, start, end=None, status="planned", team=None):
    return OmTask(plant_id=plant, task_type=kind, title=f"{kind} {NAMES[plant]}", start_day=date.fromisoformat(start),
                  end_day=date.fromisoformat(end or start), status=status, team_id=team)


@pytest.fixture()
def api(tmp_path, monkeypatch):
    monkeypatch.setattr(site_events, "_today", lambda: TODAY)
    engine = build_engine(f"sqlite:///{tmp_path / 'candidates.db'}")
    Base.metadata.create_all(bind=engine)
    f = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)
    with f() as db:
        ensure_seeded(db)
        for pid, name in NAMES.items():
            lat, lon = (0.0, 0.0) if pid == B else (13.5 + (pid - A) / 10, 100.5)
            db.add(GrowattPlant(plant_id=pid, name=name, city=f"City {name}", latitude=lat, longitude=lon))
        db.flush()
        for pid in NAMES:
            db.add(GrowattInverter(device_sn=f"SN{pid}", plant_id=pid, alias=f"INV {NAMES[pid]}"))
        eng = db.scalars(select(User).where(User.username == "engineer")).one()
        eng2 = User(username="eng2", email="eng2@example.com", full_name="Second Engineer",
                    hashed_password=hash_password("eng2pass"), role="engineer")
        outsider = User(username="eng3", email="eng3@example.com", full_name="Third Engineer",
                        hashed_password=hash_password("eng3pass"), role="engineer")
        db.add_all([eng2, outsider])
        db.flush()
        # the engineer sees A, B, D and G (not C, the P1 issue plant); eng2 shares A and B
        for pid in (A, B, D, G):
            db.add(UserPlantAssignment(user_id=eng.id, plant_id=pid))
        for pid in (A, B):
            db.add(UserPlantAssignment(user_id=eng2.id, plant_id=pid))
        db.add(UserPlantAssignment(user_id=outsider.id, plant_id=I))
        t1, t2 = OmTeam(name="Team 1"), OmTeam(name="Team 2")
        db.add_all([t1, t2])
        db.flush()
        db.add(OmTeamMember(team_id=t1.id, user_id=eng.id))

        ta = _task(A, "cleaning", "2026-11-18", "2026-11-20", team=t1.id)
        tb = _task(B, "repair", DAY, status="in_progress")
        tg = _task(G, "cleaning", "2026-11-10", "2026-11-11")  # overdue
        th = _task(H, "pm_inspection", "2026-07-01", "2026-07-02")  # overdue for months (beyond one 100-day window)
        ti = _task(I, "site_visit", DAY, status="done")
        tc = _task(C, "other", DAY, status="cancelled")
        db.add_all([ta, tb, tg, th, ti, tc])
        db.flush()
        db.add(OmTaskAssignee(task_id=tb.id, user_id=eng2.id))
        db.add(OmPlantSettings(plant_id=A, cleaning_crew_days=0.5))
        db.add(OmPlantSettings(plant_id=G, cleaning_crew_days=None))  # never entered

        db.add_all([
            _issue(C, "R8", "P1", 900.0),
            _issue(D, "R2", "P2", 120.0, sno=3),
            _issue(D, "R1", "P1", 5000.0, shadow=True),  # shadow: nobody gets it here
            _issue(I, "R18", "Info", None),
        ])
        db.add_all([
            GrowattAlarm(device_sn=f"SN{E}", plant_id=E, day=TODAY, start_time=datetime(2026, 11, 19, 9, 5),
                         end_time=None, alarm_code="102", alarm_message="Grid fault", fault_type="Fault"),
            GrowattAlarm(device_sn=f"SN{E}", plant_id=E, day=TODAY, start_time=datetime(2026, 11, 19, 8, 0),
                         end_time=None, alarm_code="102", alarm_message="Grid fault", fault_type="Fault"),
            GrowattAlarm(device_sn=f"SN{I}", plant_id=I, day=TODAY, start_time=datetime(2026, 11, 19, 9, 0),
                         end_time=None, alarm_code="1", alarm_message="Fan", fault_type="Warning"),
            GrowattAlarm(device_sn=f"SN{I}", plant_id=I, day=TODAY, start_time=datetime(2026, 11, 19, 7, 0),
                         end_time=datetime(2026, 11, 19, 7, 30), alarm_code="102", alarm_message="Grid fault", fault_type="Fault"),
        ])
        db.add_all([
            _claim(F, "CL-2026-001", date(2026, 11, 18)),
            _claim(I, "CL-2026-002", date(2026, 11, 25)),
            _claim(I, "CL-2026-003", date(2026, 11, 1), status="closed"),
        ])
        db.commit()
        ids = {
            "eng": eng.id, "eng2": eng2.id, "eng3": outsider.id, "t1": t1.id, "t2": t2.id,
            "ta": ta.id, "tb": tb.id, "tg": tg.id, "th": th.id,
        }
    app = create_app()

    def override():
        with f() as db:
            yield db

    app.dependency_overrides[get_db] = override
    client = TestClient(app)

    def hdr(user, pw):
        tok = client.post("/auth/login", json={"username": user, "password": pw}).json()["access_token"]
        return {"Authorization": f"Bearer {tok}"}

    return client, ids, hdr("admin", "admin123"), hdr("engineer", "engineer123")


def _get(client, h, qs=""):
    res = client.get(f"/growatt/routes/candidates?day={DAY}{qs}", headers=h)
    assert res.status_code == 200, res.text
    return res.json()


def _by_plant(body):
    return {c["plant_id"]: c for c in body["candidates"]}


def _kinds(c):
    return sorted({r["kind"] for r in c["reasons"]})


def test_every_reason_kind_for_an_admin(api):
    client, ids, admin, _ = api
    body = _get(client, admin)
    got = _by_plant(body)
    assert set(got) == {A, B, C, D, E, F, G, H}  # India has nothing worth a visit
    assert body["day"] == DAY and body["team_id"] is None and body["user_id"] is None
    assert body["labels"]["thb_per_day"] == "estimated"

    ra = got[A]["reasons"]
    assert [(r["kind"], r["label"], r["task_id"], r["task_type"], r["since"]) for r in ra] == [
        ("task", "Cleaning (planned)", ids["ta"], "cleaning", "2026-11-18")
    ]
    assert ra[0]["priority"] is None and ra[0]["thb_per_day"] is None and "on_day" not in ra[0]
    assert got[B]["reasons"][0]["label"] == "Repair (in progress)"

    rc = got[C]["reasons"]
    assert [(r["kind"], r["label"], r["priority"], r["thb_per_day"], r["since"]) for r in rc] == [
        ("issue", "P1 R8 Inverter down", "P1", 900.0, "2026-11-10")
    ]
    assert rc[0]["issue_id"] is not None
    rd = got[D]["reasons"]
    assert [(r["kind"], r["priority"]) for r in rd] == [("issue", "P2")]  # the shadow P1 is left out
    assert rd[0]["detail"] == "INV Delta · string 3"

    re_ = got[E]["reasons"]  # two records of the same open fault → one reason, earliest start
    assert [(r["kind"], r["label"], r["since"]) for r in re_] == [("alarm", "Open fault alarm", DAY)]
    assert "102 Grid fault" in re_[0]["detail"]

    rf = got[F]["reasons"]
    assert [(r["kind"], r["label"], r["since"]) for r in rf] == [("claim", "Claim CL-2026-001 next action", "2026-11-18")]
    assert rf[0]["claim_id"] is not None

    # G: its overdue cleaning is both a (overdue) task and cleaning_due; H: overdue PM
    assert _kinds(got[G]) == ["cleaning_due", "task"]
    due = next(r for r in got[G]["reasons"] if r["kind"] == "cleaning_due")
    assert due["task_id"] == ids["tg"] and due["since"] == "2026-11-11" and "no cleaning recorded" in due["detail"]
    assert next(r for r in got[G]["reasons"] if r["kind"] == "task")["label"] == "Cleaning (overdue)"
    assert _kinds(got[H]) == ["pm_due", "task"]
    assert next(r for r in got[H]["reasons"] if r["kind"] == "pm_due")["task_id"] == ids["th"]

    assert body["counts"] == {"task": 4, "issue": 2, "alarm": 1, "claim": 1, "cleaning_due": 1, "pm_due": 1}


def test_location_and_default_service_time(api):
    client, ids, admin, _ = api
    got = _by_plant(_get(client, admin))
    assert got[A]["has_location"] is True and got[A]["lat"] == pytest.approx(13.5) and got[A]["city"] == "City Alpha"
    assert got[B]["has_location"] is False and got[B]["lat"] is None and got[B]["lon"] is None  # 0,0 = not set
    # cleaning with 0.5 crew days entered
    assert (got[A]["default_service_min"], got[A]["service_basis"]) == (240.0, "cleaning_crew_days")
    assert (got[B]["default_service_min"], got[B]["service_basis"]) == (45.0, "task_type")  # repair
    assert (got[C]["default_service_min"], got[C]["service_basis"]) == (45.0, "default")  # no task
    assert (got[G]["default_service_min"], got[G]["service_basis"]) == (45.0, "default")  # crew days never entered
    assert (got[H]["default_service_min"], got[H]["service_basis"]) == (60.0, "task_type")  # PM


def test_service_time_rules():
    st = vrc.service_time
    clean = [{"kind": "task", "task_type": "cleaning"}]
    assert st(clean, 1) == (480.0, "cleaning_crew_days")
    assert st(clean, 3) == (600.0, "cleaning_crew_days")  # capped
    assert st(clean, None) == (45.0, "default")
    assert st(clean, 0) == (45.0, "default")
    assert st([{"kind": "cleaning_due"}], 0.25) == (120.0, "cleaning_crew_days")
    assert st(clean + [{"kind": "task", "task_type": "pm_inspection"}], None) == (60.0, "task_type")
    assert st([{"kind": "task", "task_type": "site_visit"}], 2) == (45.0, "task_type")
    assert st([{"kind": "issue"}, {"kind": "alarm"}], 2) == (45.0, "default")


def test_ranking_order(api):
    client, ids, admin, _ = api
    body = _get(client, admin)
    # 1 tasks today (Alpha, Bravo by name) · 2 P1 / fault alarm (Charlie ฿900 before Echo ฿0) · 3 P2 Delta
    # · 4 claim Foxtrot · 5 overdue cleaning / PM (Golf, Hotel by name)
    assert [c["plant_id"] for c in body["candidates"]] == [A, B, C, E, D, F, G, H]
    assert [c["rank"] for c in body["candidates"]] == list(range(1, 9))


def test_rank_is_pure_and_breaks_ties_by_thb_then_name():
    def cand(pid, name, *reasons):
        return {"plant_id": pid, "name": name, "reasons": list(reasons)}

    issue = lambda tier, thb: {"kind": "issue", "priority": tier, "thb_per_day": thb}  # noqa: E731
    out = vrc.rank([
        cand(1, "zulu", {"kind": "claim"}),
        cand(2, "bravo", issue("P2", 10.0)),
        cand(3, "alpha", issue("P2", 10.0)),
        cand(4, "yankee", issue("P2", 50.0), issue("P3", None)),
        cand(5, "mike", {"kind": "task", "on_day": False}),  # an overdue task alone is "the rest"
        cand(6, "kilo", {"kind": "alarm"}),
        cand(7, "lima", {"kind": "task", "on_day": True}),
        cand(8, "oscar", {"kind": "pm_due"}),
        cand(9, "papa", issue("P1", None)),
    ])
    assert [c["plant_id"] for c in out] == [7, 6, 9, 4, 3, 2, 1, 8, 5]
    assert [c["rank"] for c in out] == list(range(1, 10))


def test_engineer_scope_and_no_shadow(api):
    client, ids, _, eng = api
    body = _get(client, eng)
    got = _by_plant(body)
    # only assigned plants with a reason: A, B, D, G (C's P1 issue, E, F, H are other people's plants)
    assert set(got) == {A, B, D, G}
    assert [(r["kind"], r["priority"]) for r in got[D]["reasons"]] == [("issue", "P2")]  # never the shadow issue
    assert body["counts"]["issue"] == 1 and body["counts"]["alarm"] == 0 and body["counts"]["pm_due"] == 0


def test_team_and_user_filters_apply_to_tasks_only(api):
    client, ids, admin, eng = api
    got = _by_plant(_get(client, admin, f"&team_id={ids['t1']}"))
    tasks = {pid for pid, c in got.items() if "task" in _kinds(c)}
    assert tasks == {A}  # only Team 1's task
    assert {C, D, E, F, G, H} <= set(got)  # other reasons are not filtered
    assert _kinds(got[G]) == ["cleaning_due"] and _kinds(got[H]) == ["pm_due"]

    # the engineer's own work: through Team 1 (A); eng2's work: assigned directly (B)
    got = _by_plant(_get(client, admin, f"&user_id={ids['eng']}"))
    assert {pid for pid, c in got.items() if "task" in _kinds(c)} == {A}
    got = _by_plant(_get(client, admin, f"&user_id={ids['eng2']}"))
    assert {pid for pid, c in got.items() if "task" in _kinds(c)} == {B}
    assert _get(client, admin, f"&team_id={ids['t2']}")["counts"]["task"] == 0

    # an engineer may look at a colleague's work, still only on their own plants
    body = _get(client, eng, f"&user_id={ids['eng2']}")
    assert body["user_id"] == ids["eng2"] and set(_by_plant(body)) == {B, D, G}


def test_unknown_team_or_user_is_404(api):
    client, ids, admin, eng = api
    assert client.get(f"/growatt/routes/candidates?day={DAY}&team_id=999", headers=admin).status_code == 404
    assert client.get(f"/growatt/routes/candidates?day={DAY}&user_id=999", headers=admin).status_code == 404
    # someone the engineer can't see in the Calendar is "not found" too
    assert client.get(f"/growatt/routes/candidates?day={DAY}&user_id={ids['eng3']}", headers=eng).status_code == 404
    assert client.get(f"/growatt/routes/candidates?day={DAY}&user_id={ids['eng3']}", headers=admin).status_code == 200
    assert client.get("/growatt/routes/candidates", headers=admin).json()["day"] == DAY  # default: today
    assert client.get("/growatt/routes/candidates").status_code == 401


def test_a_later_day(api):
    client, ids, admin, _ = api
    res = client.get("/growatt/routes/candidates?day=2026-11-21", headers=admin)
    assert res.status_code == 200, res.text
    got = _by_plant(res.json())
    # A's cleaning ended on the 20th: on the 21st it is an overdue task (no longer "on the day")
    assert next(r for r in got[A]["reasons"] if r["kind"] == "task")["label"] == "Cleaning (overdue)"
    assert got[F]["reasons"][0]["kind"] == "claim"
    assert E in got  # a future day uses today's stored alarm log
