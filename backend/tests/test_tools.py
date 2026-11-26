"""Measuring Tools (docs/plans/measuring-tools.md): register, due states, check-out / in, access."""

from __future__ import annotations

from datetime import date

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import sessionmaker

from app.db.models import GrowattPlant, User, UserPlantAssignment
from app.db.seed import ensure_seeded
from app.db.session import Base, build_engine, get_db
from app.main import create_app
from app.services import tools

TODAY = date(2026, 11, 21)
P1, P2 = 9201, 9202


@pytest.fixture()
def api(tmp_path, monkeypatch):
    monkeypatch.setattr(tools, "_today", lambda: TODAY)
    engine = build_engine(f"sqlite:///{tmp_path / 'tools.db'}")
    Base.metadata.create_all(bind=engine)
    f = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)
    with f() as db:
        ensure_seeded(db)
        for pid in (P1, P2):
            db.add(GrowattPlant(plant_id=pid, name=f"Plant {pid}"))
        eng = db.scalars(select(User).where(User.username == "engineer")).one()
        db.add(UserPlantAssignment(user_id=eng.id, plant_id=P1))
        db.commit()
        eng_id = eng.id
    app = create_app()

    def override():
        with f() as db:
            yield db

    app.dependency_overrides[get_db] = override
    client = TestClient(app)

    def hdr(user, pw):
        tok = client.post("/auth/login", json={"username": user, "password": pw}).json()["access_token"]
        return {"Authorization": f"Bearer {tok}"}

    return client, hdr("admin", "admin123"), hdr("engineer", "engineer123"), eng_id


def _add(client, adm, **kw):
    body = {"asset_tag": "MT-001", "name": "DC clamp meter", "category": "clamp_meter", "specs": {"cat_rating": " CAT III 1500 V ", "max_dc_v": 1500, "max_a": 999.5}}
    body.update(kw)
    r = client.post("/tools", json=body, headers=adm)
    assert r.status_code == 201, r.text
    return r.json()


def test_add_edit_and_unique_tag(api):
    client, adm, eng, _ = api
    i = _add(client, adm, calibration_interval_months=12)
    assert i["status"] == "available"
    assert i["specs"] == {"cat_rating": "CAT III 1500 V", "max_dc_v": 1500, "max_a": 999.5}
    assert isinstance(i["specs"]["max_dc_v"], int)
    # nothing recorded: no date, never ok
    assert i["due"] == [{"kind": "calibration", "last_day": None, "next_due": None, "state": "none", "number": None, "issuer": None}]
    assert i["due_state"] == "none" and i["next_due"] is None
    assert client.post("/tools", json={"asset_tag": "mt-001", "name": "x", "category": "other"}, headers=adm).status_code == 409
    # engineers can't add, edit, delete or record
    assert client.post("/tools", json={"asset_tag": "MT-9", "name": "x", "category": "other"}, headers=eng).status_code == 403
    assert client.patch(f"/tools/{i['id']}", json={"name": "y"}, headers=eng).status_code == 403
    assert client.post(f"/tools/{i['id']}/due", json={"kind": "calibration", "day": "2026-11-01"}, headers=eng).status_code == 403
    r = client.patch(f"/tools/{i['id']}", json={"name": "Clamp", "make": "Fluke", "name_ignored": 1}, headers=adm)
    assert r.status_code == 200 and r.json()["name"] == "Clamp" and r.json()["updated_by"] == "admin"
    assert client.patch(f"/tools/{i['id']}", json={"status": "checked_out"}, headers=adm).status_code == 422


def test_due_states_and_summary(api):
    client, adm, _, _ = api
    cal = _add(client, adm, calibration_interval_months=12)
    # interval from the instrument: 2025-12-10 + 12 months = 2026-12-10 (within 30 days)
    r = client.post(f"/tools/{cal['id']}/due", json={"kind": "calibration", "day": "2025-12-10", "issuer": "Lab", "number": "C-1"}, headers=adm)
    assert r.status_code == 201
    d = r.json()["due"][0]
    assert d == {"kind": "calibration", "last_day": "2025-12-10", "next_due": "2026-12-10", "state": "due_soon", "number": "C-1", "issuer": "Lab"}
    # a calibration can't be recorded ahead; next due must be after the day
    assert client.post(f"/tools/{cal['id']}/due", json={"kind": "calibration", "day": "2026-12-01"}, headers=adm).status_code == 422
    assert client.post(f"/tools/{cal['id']}/due", json={"kind": "calibration", "day": "2026-11-01", "next_due": "2026-10-01"}, headers=adm).status_code == 422
    assert client.post(f"/tools/{cal['id']}/due", json={"kind": "calibration", "day": "2026-11-01", "url": "javascript:x"}, headers=adm).status_code == 422

    drone = _add(client, adm, asset_tag="MT-002", name="Drone", category="drone", specs={})
    assert [x["kind"] for x in drone["due"]] == ["caat", "nbtc", "insurance"]
    client.post(f"/tools/{drone['id']}/due", json={"kind": "caat", "day": "2025-01-01", "next_due": "2026-11-01"}, headers=adm)
    r = client.post(f"/tools/{drone['id']}/due", json={"kind": "pilot_licence", "day": "2026-12-01", "next_due": "2028-12-01"}, headers=adm)
    due = {x["kind"]: x for x in r.json()["due"]}
    assert due["caat"]["state"] == "overdue" and due["nbtc"]["state"] == "none" and due["pilot_licence"]["state"] == "ok"
    assert r.json()["due_state"] == "overdue" and r.json()["next_due"] == "2026-11-01"

    lst = client.get("/tools", headers=adm).json()
    assert lst["summary"] == {"total": 2, "available": 2, "checked_out": 0, "overdue_back": 0, "due_soon": 1, "overdue": 1}
    assert lst["meta"] == {"source": "db", "due_soon_days": 30, "today": "2026-11-21"}


def test_checkout_return_and_warnings(api):
    client, adm, eng, eng_id = api
    i = _add(client, adm)
    client.post(f"/tools/{i['id']}/due", json={"kind": "calibration", "day": "2025-01-01", "next_due": "2026-01-01"}, headers=adm)
    body = {"plant_id": P1, "due_back": "2026-11-23", "note": "string test"}
    # calibration overdue: must be acknowledged
    r = client.post(f"/tools/{i['id']}/checkout", json=body, headers=eng)
    assert r.status_code == 409 and "calibration_overdue" in r.json()["detail"]
    # engineers only to themselves and to their plants
    assert client.post(f"/tools/{i['id']}/checkout", json={**body, "holder_user_id": 1, "ack_warnings": ["calibration_overdue"]}, headers=eng).status_code == 403
    assert client.post(f"/tools/{i['id']}/checkout", json={**body, "plant_id": P2, "ack_warnings": ["calibration_overdue"]}, headers=eng).status_code == 404
    assert client.post(f"/tools/{i['id']}/checkout", json={**body, "due_back": "2026-11-20", "ack_warnings": ["calibration_overdue"]}, headers=eng).status_code == 422
    r = client.post(f"/tools/{i['id']}/checkout", json={**body, "ack_warnings": ["calibration_overdue"]}, headers=eng)
    assert r.status_code == 201, r.text
    c = r.json()
    assert c["holder"]["id"] == eng_id and c["plant_id"] == P1 and c["plant_name"] == f"Plant {P1}"
    assert c["ack_warnings"] == ["calibration_overdue"] and c["overdue"] is False and c["returned_at"] is None

    got = client.get(f"/tools/{i['id']}", headers=adm).json()
    assert got["status"] == "checked_out" and got["holder"]["id"] == eng_id and got["checkout_count"] == 1
    assert client.post(f"/tools/{i['id']}/checkout", json={"due_back": "2026-11-23", "ack_warnings": ["calibration_overdue"]}, headers=adm).status_code == 409
    assert client.patch(f"/tools/{i['id']}", json={"status": "repair"}, headers=adm).status_code == 409

    # overdue back once the day passes
    tools_today = tools._today
    try:
        tools._today = lambda: date(2026, 11, 25)  # type: ignore[assignment]
        s = client.get("/tools", headers=adm).json()["summary"]
        assert s["overdue_back"] == 1 and s["checked_out"] == 1
    finally:
        tools._today = tools_today  # type: ignore[assignment]

    r = client.post(f"/tools/{i['id']}/return", json={"condition": "damaged", "note": "cracked jaw"}, headers=eng)
    assert r.status_code == 200 and r.json()["condition"] == "damaged" and r.json()["returned_at"]
    assert client.get(f"/tools/{i['id']}", headers=eng).json()["status"] == "repair"
    assert client.post(f"/tools/{i['id']}/return", json={"condition": "ok"}, headers=eng).status_code == 409
    # checked out before: delete refused, retire instead
    assert client.delete(f"/tools/{i['id']}", headers=adm).status_code == 409
    assert client.patch(f"/tools/{i['id']}", json={"status": "retired"}, headers=adm).json()["status"] == "retired"
    assert client.get("/tools", headers=adm).json()["instruments"] == []
    assert len(client.get("/tools?include_retired=true", headers=adm).json()["instruments"]) == 1


def test_return_only_by_holder_or_admin_and_hidden_plant(api):
    client, adm, eng, _ = api
    i = _add(client, adm)
    # admin checks out to a plant the engineer can't see
    r = client.post(f"/tools/{i['id']}/checkout", json={"plant_id": P2, "due_back": "2026-11-22"}, headers=adm)
    assert r.status_code == 201
    seen = client.get("/tools", headers=eng).json()["instruments"][0]["open_checkout"]
    assert seen["plant_id"] is None and seen["plant_name"] is None
    assert client.get("/tools", headers=adm).json()["instruments"][0]["open_checkout"]["plant_id"] == P2
    assert client.post(f"/tools/{i['id']}/return", json={"condition": "ok"}, headers=eng).status_code == 403
    assert client.post(f"/tools/{i['id']}/return", json={"condition": "lost"}, headers=adm).status_code == 200
    assert client.get(f"/tools/{i['id']}", headers=adm).json()["status"] == "retired"


def test_drone_documents_and_calibration_brings_back(api):
    client, adm, _, _ = api
    d = _add(client, adm, asset_tag="MT-D", name="Drone", category="drone", specs={})
    client.post(f"/tools/{d['id']}/due", json={"kind": "insurance", "day": "2025-01-01", "next_due": "2026-01-01"}, headers=adm)
    r = client.post(f"/tools/{d['id']}/checkout", json={"due_back": "2026-11-22", "ack_warnings": []}, headers=adm)
    assert r.status_code == 409 and "drone_documents_expired" in r.json()["detail"]

    m = _add(client, adm, asset_tag="MT-M", calibration_interval_months=24)
    assert client.patch(f"/tools/{m['id']}", json={"status": "at_calibration"}, headers=adm).json()["status"] == "at_calibration"
    r = client.post(f"/tools/{m['id']}/due", json={"kind": "calibration", "day": "2026-11-20"}, headers=adm)
    assert r.json()["status"] == "available" and r.json()["next_due"] == "2028-11-20"
    # never checked out: may be deleted
    assert client.delete(f"/tools/{m['id']}", headers=adm).status_code == 204
    assert client.get(f"/tools/{m['id']}", headers=adm).status_code == 404


def test_add_months_clamps():
    assert tools.add_months(date(2026, 1, 31), 1) == date(2026, 2, 28)
    assert tools.add_months(date(2026, 11, 30), 14) == date(2028, 1, 30)


def test_checkout_records_a_scanned_asset_tag(api):
    client, adm, eng, eng_id = api
    i = _add(client, adm)
    r = client.post(f"/tools/{i['id']}/checkout", json={"due_back": "2026-11-23", "input_method": "camera", "raw_scan": "https://app/s/tool/MT-001"}, headers=eng)
    assert r.status_code == 201, r.text
    assert (r.json()["input_method"], r.json()["raw_scan"]) == ("camera", "https://app/s/tool/MT-001")
    client.post(f"/tools/{i['id']}/return", json={"condition": "ok"}, headers=eng)
    # picked in the app: nothing recorded, a stray raw_scan is dropped
    r = client.post(f"/tools/{i['id']}/checkout", json={"due_back": "2026-11-23", "raw_scan": "x"}, headers=eng)
    assert (r.json()["input_method"], r.json()["raw_scan"]) == (None, None)
    client.post(f"/tools/{i['id']}/return", json={"condition": "ok"}, headers=eng)
    assert client.post(f"/tools/{i['id']}/checkout", json={"due_back": "2026-11-23", "input_method": "telepathy"}, headers=eng).status_code == 422
