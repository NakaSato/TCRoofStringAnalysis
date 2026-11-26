"""Site events (Phase 4 groundwork): cleaning / repair log per plant, scoped like the Issues queue."""

from __future__ import annotations

from datetime import date, timedelta

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import sessionmaker

from app.db.models import GrowattInverter, GrowattIssue, GrowattPlant, SiteEvent, User, UserPlantAssignment
from app.db.seed import ensure_seeded
from app.db.session import Base, build_engine, get_db
from app.main import create_app
from app.services import growatt_issues, site_events

TODAY = date(2026, 11, 15)
P1, P2 = 9001, 9002
SN = "INV_E1"


@pytest.fixture()
def api(tmp_path, monkeypatch):
    monkeypatch.setattr(site_events, "_today", lambda: TODAY)
    engine = build_engine(f"sqlite:///{tmp_path / 'events.db'}")
    Base.metadata.create_all(bind=engine)
    f = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)
    with f() as db:
        ensure_seeded(db)
        for pid in (P1, P2):
            db.add(GrowattPlant(plant_id=pid, name=f"Plant {pid}"))
        db.add(GrowattInverter(device_sn=SN, plant_id=P1, alias="Inverter E1"))
        db.add(GrowattInverter(device_sn="INV_OTHER", plant_id=P2))
        eng = db.scalars(select(User).where(User.username == "engineer")).one()
        db.add(UserPlantAssignment(user_id=eng.id, plant_id=P1))
        db.commit()
    app = create_app()

    def override():
        with f() as db:
            yield db

    app.dependency_overrides[get_db] = override
    client = TestClient(app)

    def hdr(user, pw):
        tok = client.post("/auth/login", json={"username": user, "password": pw}).json()["access_token"]
        return {"Authorization": f"Bearer {tok}"}

    return f, client, hdr("admin", "admin123"), hdr("engineer", "engineer123")


def _issue(f, plant=P1, shadow=False, sno=3):
    with f() as db:
        growatt_issues.sync(db, TODAY - timedelta(days=2), [{
            "rule": "R2", "tier": "P2", "plant_id": plant, "device_sn": SN if plant == P1 else "INV_OTHER",
            "string_no": sno, "day": (TODAY - timedelta(days=2)).isoformat(), "lost_kwh_est": 2.0, "thb_est": 10.0,
            "evidence": {}, "safety": False, "shadow": shadow,
        }])
        return db.scalars(select(GrowattIssue).order_by(GrowattIssue.id.desc())).first().id


def test_engineer_records_a_cleaning_and_lists_it(api):
    f, client, admin, eng = api
    res = client.post(f"/growatt/plants/{P1}/events", headers=eng, json={
        "event_type": "cleaning", "day": "2026-11-12", "end_day": "2026-11-13", "cost_thb": 4500, "note": " whole roof ",
    })
    assert res.status_code == 201, res.text
    ev = res.json()
    assert ev["label"] == "Cleaning" and ev["end_day"] == "2026-11-13" and ev["note"] == "whole roof"
    assert ev["created_by"] == "engineer" and ev["cost_thb"] == 4500

    client.post(f"/growatt/plants/{P1}/events", headers=admin, json={"event_type": "ir_flight", "day": "2026-11-14"})
    body = client.get(f"/growatt/plants/{P1}/events", headers=eng).json()
    assert [e["event_type"] for e in body["events"]] == ["ir_flight", "cleaning"]  # newest first
    assert body["summary"] == {"by_type": {"ir_flight": 1, "cleaning": 1}, "cost_thb": 4500, "costed": 1}
    assert client.get(f"/growatt/plants/{P1}/events?type=cleaning", headers=eng).json()["total"] == 1
    # since matches any day the event covers
    assert client.get(f"/growatt/plants/{P1}/events?since=2026-11-13&type=cleaning", headers=eng).json()["total"] == 1
    assert client.get(f"/growatt/plants/{P1}/events?until=2026-11-11", headers=eng).json()["total"] == 0


def test_scoping_and_validation(api):
    f, client, admin, eng = api
    ok = {"event_type": "repair", "day": "2026-11-14"}
    assert client.post(f"/growatt/plants/{P2}/events", headers=eng, json=ok).status_code == 404
    assert client.get(f"/growatt/plants/{P2}/events", headers=eng).status_code == 404
    assert client.post(f"/growatt/plants/{P2}/events", headers=admin, json=ok).status_code == 201
    assert client.get("/growatt/events", headers=eng).json()["total"] == 0
    assert client.get("/growatt/events", headers=admin).json()["total"] == 1
    assert client.get(f"/growatt/events?plant_id={P2}", headers=eng).status_code == 404

    bad = [
        {"event_type": "cleaning", "day": "2026-11-16"},  # future
        {"event_type": "cleaning", "day": "2026-11-14", "end_day": "2026-11-13"},
        {"event_type": "repair", "day": "2026-11-14", "string_no": 3},  # string without inverter
        {"event_type": "repair", "day": "2026-11-14", "device_sn": "INV_OTHER"},  # other plant's inverter
        {"event_type": "cleaning", "day": "2026-11-14", "close_issue": True},  # nothing to close
    ]
    for b in bad:
        assert client.post(f"/growatt/plants/{P1}/events", headers=eng, json=b).status_code == 422, b
    assert client.post(f"/growatt/plants/{P1}/events", headers=eng, json={"event_type": "party", "day": "2026-11-14"}).status_code == 422
    assert client.post(f"/growatt/plants/{P1}/events", headers=eng, json={"event_type": "repair", "day": "2026-11-14", "cost_thb": -1}).status_code == 422
    # same day as end_day collapses to a one-day event
    one = client.post(f"/growatt/plants/{P1}/events", headers=eng, json={**ok, "end_day": "2026-11-14"}).json()
    assert one["end_day"] is None


def test_event_resolves_its_issue(api):
    f, client, admin, eng = api
    iid = _issue(f)
    res = client.post(f"/growatt/plants/{P1}/events", headers=eng, json={
        "event_type": "repair", "day": "2026-11-14", "device_sn": SN, "string_no": 3,
        "issue_id": iid, "close_issue": True, "note": "MC4 replaced",
    })
    assert res.status_code == 201, res.text
    ev = res.json()
    assert ev["issue"]["status"] == "resolved" and ev["inverter_name"] == "Inverter E1"
    with f() as db:
        i = db.get(GrowattIssue, iid)
        assert i.feedback == "confirmed" and i.closed_by == "engineer"
        assert f"site event #{ev['id']}" in (i.note or "") and "MC4 replaced" in (i.note or "")

    # an issue of another plant, or (for engineers) a shadow issue, can't be linked
    other = _issue(f, plant=P2)
    shadow = _issue(f, shadow=True, sno=5)
    for iid2 in (other, shadow):
        r = client.post(f"/growatt/plants/{P1}/events", headers=eng, json={"event_type": "repair", "day": "2026-11-14", "issue_id": iid2})
        assert r.status_code == 422
    r = client.post(f"/growatt/plants/{P1}/events", headers=admin, json={"event_type": "repair", "day": "2026-11-14", "issue_id": shadow})
    assert r.status_code == 201


def test_patch_and_delete(api):
    f, client, admin, eng = api
    ev = client.post(f"/growatt/plants/{P1}/events", headers=admin, json={
        "event_type": "cleaning", "day": "2026-11-10", "device_sn": SN, "string_no": 2, "cost_thb": 100,
    }).json()
    url = f"/growatt/plants/{P1}/events/{ev['id']}"
    out = client.patch(url, headers=eng, json={"cost_thb": None, "device_sn": None, "note": "rescheduled"}).json()
    assert out["cost_thb"] is None and out["device_sn"] is None and out["string_no"] is None
    assert out["note"] == "rescheduled" and out["updated_by"] == "engineer" and out["day"] == "2026-11-10"
    assert client.patch(url, headers=eng, json={"day": None}).json()["day"] == "2026-11-10"  # required: unchanged
    assert client.patch(url, headers=eng, json={"day": "2026-11-20"}).status_code == 422
    assert client.patch(f"/growatt/plants/{P2}/events/{ev['id']}", headers=admin, json={"note": "x"}).status_code == 404

    iid = _issue(f)
    out = client.patch(url, headers=eng, json={"issue_id": iid, "close_issue": True}).json()
    assert out["issue"]["status"] == "resolved"

    # only an admin or the person who recorded it deletes it
    assert client.delete(url, headers=eng).status_code == 403
    mine = client.post(f"/growatt/plants/{P1}/events", headers=eng, json={"event_type": "other", "day": "2026-11-14"}).json()
    assert client.delete(f"/growatt/plants/{P1}/events/{mine['id']}", headers=eng).status_code == 204
    assert client.delete(url, headers=admin).status_code == 204
    with f() as db:
        assert db.scalars(select(SiteEvent)).all() == []
        assert db.get(GrowattIssue, iid).status == "resolved"  # stays resolved


def test_engineer_never_sees_or_unlinks_a_shadow_issue_link(api):
    """An admin's link to a shadow issue: engineers get neither its id nor its details, and an
    engineer's edit sending `issue_id: null` (they never saw the link) keeps it (#149)."""
    f, client, admin, eng = api
    shadow = _issue(f, shadow=True, sno=5)
    ev = client.post(f"/growatt/plants/{P1}/events", headers=admin, json={"event_type": "repair", "day": "2026-11-14", "issue_id": shadow}).json()
    url = f"/growatt/plants/{P1}/events/{ev['id']}"
    listed = lambda h: client.get(f"/growatt/plants/{P1}/events", headers=h).json()["events"][0]  # noqa: E731
    assert listed(admin)["issue_id"] == shadow and listed(admin)["issue"]["id"] == shadow
    assert listed(eng)["issue_id"] is None and listed(eng)["issue"] is None
    fleet = client.get("/growatt/events", headers=eng).json()["events"][0]
    assert fleet["issue_id"] is None and fleet["issue"] is None

    out = client.patch(url, headers=eng, json={"issue_id": None, "note": "fuse swapped"})
    assert out.status_code == 200, out.text
    assert out.json()["issue_id"] is None and out.json()["note"] == "fuse swapped"
    with f() as db:
        assert db.get(SiteEvent, ev["id"]).issue_id == shadow  # the admin's link stays

    # an admin clearing it does clear it
    assert client.patch(url, headers=admin, json={"issue_id": None}).json()["issue_id"] is None
    with f() as db:
        assert db.get(SiteEvent, ev["id"]).issue_id is None
