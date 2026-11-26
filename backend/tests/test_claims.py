"""Claims (docs/plans/claims.md): workflow, evidence, links, numbering and plant scoping."""

from __future__ import annotations

from datetime import date, datetime, timedelta

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import sessionmaker

from app.db.models import (
    GrowattInverter,
    GrowattIssue,
    GrowattIvSweep,
    GrowattPlant,
    SiteEvent,
    User,
    UserPlantAssignment,
)
from app.db.seed import ensure_seeded
from app.db.session import Base, build_engine, get_db
from app.main import create_app
from app.services import claims, growatt_issues, site_events

TODAY = date(2026, 11, 20)
P1, P2 = 9101, 9102
SN, SN2 = "INV_C1", "INV_C2"


@pytest.fixture()
def api(tmp_path, monkeypatch):
    monkeypatch.setattr(claims, "_today", lambda: TODAY)
    monkeypatch.setattr(site_events, "_today", lambda: TODAY)
    engine = build_engine(f"sqlite:///{tmp_path / 'claims.db'}")
    Base.metadata.create_all(bind=engine)
    f = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)
    with f() as db:
        ensure_seeded(db)
        for pid in (P1, P2):
            db.add(GrowattPlant(plant_id=pid, name=f"Plant {pid}"))
        db.add(GrowattInverter(device_sn=SN, plant_id=P1, alias="Inverter C1"))
        db.add(GrowattInverter(device_sn=SN2, plant_id=P2))
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


def _body(**kw):
    b = {
        "type": "inverter_warranty",
        "cause": "manufacturing_defect",
        "plant_id": P1,
        "device_sn": SN,
        "counterparty": " Growatt ",
        "incident_day": "2026-11-10",
        "discovered_day": "2026-11-11",
    }
    b.update(kw)
    return b


def _issue(f, plant=P1, shadow=False):
    with f() as db:
        growatt_issues.sync(db, TODAY - timedelta(days=2), [{
            "rule": "R2", "tier": "P2", "plant_id": plant, "device_sn": SN if plant == P1 else SN2,
            "string_no": 3, "day": (TODAY - timedelta(days=2)).isoformat(), "lost_kwh_est": 2.0, "thb_est": 10.0,
            "evidence": {}, "safety": False, "shadow": shadow,
        }])
        return db.scalars(select(GrowattIssue).order_by(GrowattIssue.id.desc())).first().id


def test_engineer_opens_a_claim_with_numbering_evidence_and_links(api):
    f, client, admin, eng = api
    iid = _issue(f)
    res = client.post("/claims", headers=eng, json=_body(links=[{"kind": "issue", "ref_id": iid}]))
    assert res.status_code == 201, res.text
    c = res.json()
    assert c["number"] == "CL-2026-001" and c["status"] == "draft" and c["waiting_on"] == "us"
    assert c["counterparty"] == "Growatt" and c["old_sn"] == SN and c["new_sn"] is None
    assert c["created_by"] == "engineer" and c["plant_name"] == f"Plant {P1}"
    assert (c["evidence_done"], c["evidence_required"]) == (0, 3)

    d = client.get(f"/claims/{c['id']}", headers=eng).json()
    assert [e["kind"] for e in d["events"]] == ["created"]
    assert [e["key"] for e in d["evidence"]] == ["alarm_log", "photos", "site_log", "case_no"]
    assert d["links"] == [{"id": d["links"][0]["id"], "kind": "issue", "ref_id": iid, "label": d["links"][0]["label"]}]
    assert d["links"][0]["label"].startswith("R2 ")

    assert client.post("/claims", headers=admin, json=_body()).json()["number"] == "CL-2026-002"


def test_scoping_hides_other_plants(api):
    f, client, admin, eng = api
    other = client.post("/claims", headers=admin, json=_body(plant_id=P2, device_sn=SN2)).json()
    mine = client.post("/claims", headers=admin, json=_body()).json()
    assert client.post("/claims", headers=eng, json=_body(plant_id=P2, device_sn=SN2)).status_code == 404
    assert client.get(f"/claims/{other['id']}", headers=eng).status_code == 404
    assert client.patch(f"/claims/{other['id']}", headers=eng, json={"description": "x"}).status_code == 404
    assert client.patch(f"/claims/{mine['id']}", headers=eng, json={"plant_id": P2}).status_code == 404
    lst = client.get("/claims", headers=eng).json()
    assert [c["id"] for c in lst["claims"]] == [mine["id"]]
    assert lst["summary"] == {"open": 1, "waiting_us": 1, "waiting_them": 0, "followup_overdue": 0}
    assert lst["meta"] == {"source": "db", "today": "2026-11-20"}
    assert len(client.get("/claims", headers=admin).json()["claims"]) == 2
    assert client.get(f"/claims?plant_id={P2}", headers=eng).status_code == 404


def test_validation(api):
    f, client, admin, eng = api
    assert client.post("/claims", headers=admin, json=_body(device_sn=SN2)).status_code == 422  # not the plant's
    assert client.post("/claims", headers=admin, json=_body(device_sn=None)).status_code == 422  # inverter claim needs it
    assert client.post("/claims", headers=admin, json=_body(incident_day="2026-11-21")).status_code == 422
    assert client.post("/claims", headers=admin, json=_body(discovered_day="2026-11-01")).status_code == 422
    assert client.post("/claims", headers=admin, json=_body(counterparty="  ")).status_code == 422
    assert client.post("/claims", headers=admin, json=_body(type="insurance", device_sn=None, string_nos=[2])).status_code == 422
    assert client.post("/claims", headers=admin, json=_body(plant_id=1)).status_code == 404
    iid = _issue(f, plant=P2)  # an issue of another plant cannot be linked
    assert client.post("/claims", headers=admin, json=_body(links=[{"kind": "issue", "ref_id": iid}])).status_code == 422
    with f() as db:
        assert db.scalar(select(claims.Claim.id)) is None  # nothing left behind


def test_status_workflow_is_admin_only_and_checked(api):
    f, client, admin, eng = api
    c = client.post("/claims", headers=eng, json=_body()).json()
    url = f"/claims/{c['id']}/status"
    assert client.post(url, headers=eng, json={"status": "submitted", "note": "sent"}).status_code == 403
    assert client.post(url, headers=admin, json={"status": "approved", "note": "x"}).status_code == 409
    r = client.post(url, headers=admin, json={"status": "submitted", "note": "Sent to Growatt", "next_action_day": "2026-11-18"})
    assert r.status_code == 200, r.text
    s = r.json()
    assert s["submitted_day"] == "2026-11-20" and s["waiting_on"] == "them" and s["followup_overdue"] is True
    assert client.get("/claims", headers=eng).json()["summary"]["followup_overdue"] == 1

    client.post(url, headers=admin, json={"status": "approved", "note": "RMA approved"})
    s = client.post(url, headers=admin, json={"status": "fulfilled", "note": "Swapped", "new_sn": " INV_NEW "}).json()
    assert (s["old_sn"], s["new_sn"]) == (SN, "INV_NEW")
    assert s["next_action_day"] == "2026-11-18"  # not sent = unchanged
    s = client.post(url, headers=admin, json={"status": "closed", "note": "Done"}).json()
    assert s["closed_day"] == "2026-11-20" and s["next_action_day"] is None and s["waiting_on"] is None
    assert s["followup_overdue"] is False

    # closed: engineers can no longer edit, admins can
    assert client.patch(f"/claims/{c['id']}", headers=eng, json={"description": "late"}).status_code == 409
    assert client.patch(f"/claims/{c['id']}", headers=admin, json={"description": "late"}).status_code == 200

    d = client.get(f"/claims/{c['id']}", headers=eng).json()
    st = [(e["from_status"], e["to_status"]) for e in d["events"] if e["kind"] == "status"]
    assert st[0] == ("fulfilled", "closed") and st[-1] == ("draft", "submitted")
    assert d["events"][0]["kind"] == "edit"


def test_edit_records_changes_and_type_change_swaps_checklist(api):
    f, client, admin, eng = api
    c = client.post("/claims", headers=eng, json=_body()).json()
    client.put(f"/claims/{c['id']}/evidence/photos", headers=eng, json={"done": True})
    r = client.patch(f"/claims/{c['id']}", headers=eng, json={"type": "insurance", "cause": "theft"})
    assert r.status_code == 200, r.text
    e = r.json()
    # insurance: incident report, photos, quotation + police report for theft; photos kept
    assert (e["type"], e["evidence_required"], e["evidence_done"]) == ("insurance", 4, 1)
    d = client.get(f"/claims/{c['id']}", headers=eng).json()
    assert d["events"][0]["kind"] == "edit" and "type" in d["events"][0]["summary"]
    # nothing changed → no event
    client.patch(f"/claims/{c['id']}", headers=eng, json={"cause": "theft"})
    assert len(client.get(f"/claims/{c['id']}", headers=eng).json()["events"]) == len(d["events"])


def test_evidence_items(api):
    f, client, admin, eng = api
    c = client.post("/claims", headers=eng, json=_body()).json()
    base = f"/claims/{c['id']}/evidence"
    r = client.put(f"{base}/alarm_log", headers=eng, json={"done": True, "url": "/alarms?sn=INV_C1", "note": " Jan log "})
    assert r.status_code == 200, r.text
    item = r.json()
    assert item["done"] and item["url"] == "/alarms?sn=INV_C1" and item["note"] == "Jan log" and item["by"] == "engineer"
    assert client.put(f"{base}/alarm_log", headers=eng, json={"done": True, "url": "javascript:alert(1)"}).status_code == 422
    assert client.put(f"{base}/serials", headers=eng, json={"done": True}).status_code == 404  # not an inverter item
    # only the fields sent change
    item = client.put(f"{base}/alarm_log", headers=eng, json={"done": False}).json()
    assert not item["done"] and item["url"] == "/alarms?sn=INV_C1"
    assert client.get(f"/claims/{c['id']}", headers=eng).json()["evidence_done"] == 0


def test_timeline_entries(api):
    f, client, admin, eng = api
    c = client.post("/claims", headers=eng, json=_body()).json()
    url = f"/claims/{c['id']}/events"
    r = client.post(url, headers=eng, json={
        "kind": "shipment", "day": "2026-11-19", "direction": "out", "summary": "Failed unit sent",
        "carrier": "Kerry", "tracking_no": "KE1", "sn": SN,
    })
    assert r.status_code == 201, r.text
    assert r.json()["carrier"] == "Kerry" and r.json()["direction"] == "out" and r.json()["by"] == "engineer"
    assert client.post(url, headers=eng, json={"kind": "message", "day": "2026-11-19", "summary": "x"}).status_code == 422
    assert client.post(url, headers=eng, json={"kind": "message", "day": "2026-11-25", "direction": "in", "summary": "x"}).status_code == 422
    n = client.post(url, headers=eng, json={"kind": "note", "day": "2026-11-19", "direction": "in", "summary": "Called"}).json()
    assert n["day"] is None and n["direction"] is None and n["carrier"] is None


def test_links(api):
    f, client, admin, eng = api
    c = client.post("/claims", headers=eng, json=_body()).json()
    url = f"/claims/{c['id']}/links"
    with f() as db:
        sw = GrowattIvSweep(
            plant_id=P1, device_sn=SN, string_no=4, swept_at=datetime(2026, 11, 18, 11, 30), irradiance_wm2=900,
            module_temp_c=45, p_max_stc_w=5000, expected_pmax_stc_w=5500, pmax_dev_pct=-9, signature="degradation",
        )
        ev = SiteEvent(plant_id=P1, event_type="repair", day=date(2026, 11, 12))
        db.add_all([sw, ev])
        db.commit()
        sweep_id, event_id = sw.id, ev.id
    r = client.post(url, headers=eng, json={"kind": "iv_sweep", "ref_id": sweep_id})
    assert r.status_code == 201, r.text
    assert r.json()["label"] == "I-V sweep 2026-11-18 11:30 · INV_C1 · string 4"
    assert client.post(url, headers=eng, json={"kind": "iv_sweep", "ref_id": sweep_id}).status_code == 409
    site = client.post(url, headers=eng, json={"kind": "site_log", "ref_id": event_id}).json()
    assert site["label"] == "Repair 2026-11-12"
    # a shadow issue is admin only
    sid = _issue(f, shadow=True)
    assert client.post(url, headers=eng, json={"kind": "issue", "ref_id": sid}).status_code == 422
    shadow_link = client.post(url, headers=admin, json={"kind": "issue", "ref_id": sid}).json()
    # an engineer does not see the shadow issue's link at all, and cannot unlink it
    assert "issue" not in {l["kind"] for l in client.get(f"/claims/{c['id']}", headers=eng).json()["links"]}
    assert client.get(f"/claims/{c['id']}", headers=admin).json()["links"][-1]["label"].startswith("R2")
    assert client.delete(f"{url}/{shadow_link['id']}", headers=eng).status_code == 404
    assert client.delete(f"{url}/{site['id']}", headers=eng).status_code == 204
    assert client.delete(f"{url}/{site['id']}", headers=eng).status_code == 404
    assert client.delete(f"{url}/{shadow_link['id']}", headers=admin).status_code == 204
    # moving a linked claim to another plant is refused
    assert client.patch(f"/claims/{c['id']}", headers=admin, json={"plant_id": P2, "device_sn": SN2}).status_code == 422


def test_delete_only_drafts_by_admins(api):
    f, client, admin, eng = api
    a = client.post("/claims", headers=eng, json=_body()).json()
    b = client.post("/claims", headers=eng, json=_body()).json()
    assert client.delete(f"/claims/{a['id']}", headers=eng).status_code == 403
    assert client.delete(f"/claims/{a['id']}", headers=admin).status_code == 204
    assert client.get(f"/claims/{a['id']}", headers=admin).status_code == 404
    client.post(f"/claims/{b['id']}/status", headers=admin, json={"status": "submitted", "note": "sent"})
    assert client.delete(f"/claims/{b['id']}", headers=admin).status_code == 409
    # numbers are never reused: the next one follows the highest
    assert client.post("/claims", headers=eng, json=_body()).json()["number"] == "CL-2026-003"


def test_list_filters(api):
    f, client, admin, eng = api
    client.post("/claims", headers=admin, json=_body())
    w = client.post("/claims", headers=admin, json=_body(type="workmanship", cause="installation", device_sn=None)).json()
    client.post(f"/claims/{w['id']}/status", headers=admin, json={"status": "withdrawn", "note": "not needed"})
    assert len(client.get("/claims?status=withdrawn,closed", headers=admin).json()["claims"]) == 1
    assert len(client.get("/claims?type=inverter_warranty", headers=admin).json()["claims"]) == 1
    summary = client.get("/claims", headers=admin).json()["summary"]
    assert summary["open"] == 1


def test_closed_claim_is_read_only_for_engineers(api):
    f, client, admin, eng = api
    c = client.post("/claims", headers=eng, json=_body()).json()
    base = f"/claims/{c['id']}"
    with f() as db:
        ev = SiteEvent(plant_id=P1, event_type="repair", day=date(2026, 11, 12))
        ev2 = SiteEvent(plant_id=P1, event_type="repair", day=date(2026, 11, 13))
        db.add_all([ev, ev2])
        db.commit()
        event_id, event2_id = ev.id, ev2.id
    link = client.post(f"{base}/links", headers=eng, json={"kind": "site_log", "ref_id": event_id}).json()
    client.post(f"{base}/status", headers=admin, json={"status": "withdrawn", "note": "not needed"})

    note = {"kind": "note", "summary": "late note"}
    assert client.put(f"{base}/evidence/photos", headers=eng, json={"done": True}).status_code == 409
    assert client.post(f"{base}/links", headers=eng, json={"kind": "site_log", "ref_id": event2_id}).status_code == 409
    assert client.delete(f"{base}/links/{link['id']}", headers=eng).status_code == 409
    assert client.post(f"{base}/events", headers=eng, json=note).status_code == 409

    assert client.put(f"{base}/evidence/photos", headers=admin, json={"done": True}).status_code == 200
    assert client.post(f"{base}/links", headers=admin, json={"kind": "site_log", "ref_id": event2_id}).status_code == 201
    assert client.delete(f"{base}/links/{link['id']}", headers=admin).status_code == 204
    assert client.post(f"{base}/events", headers=admin, json=note).status_code == 201
    d = client.get(base, headers=admin).json()
    assert d["updated_by"] == "admin"


def test_claim_number_taken_meanwhile_is_retried(api, monkeypatch):
    f, client, admin, eng = api
    first = client.post("/claims", headers=eng, json=_body()).json()
    real = claims._next_number
    calls = []

    def stale(db, year):  # the first try sees the numbers as they were before `first` was saved
        calls.append(year)
        return first["number"] if len(calls) == 1 else real(db, year)

    monkeypatch.setattr(claims, "_next_number", stale)
    r = client.post("/claims", headers=eng, json=_body())
    assert r.status_code == 201, r.text
    assert r.json()["number"] != first["number"] and len(calls) == 2


def test_serial_inputs_follow_the_serial(api):
    """How device_sn / new_sn were entered (barcode-scanning.md §9): kept while the SN stays."""
    f, client, admin, eng = api
    scan = {"method": "camera", "raw": f"S/N: {SN}"}
    c = client.post("/claims", headers=eng, json=_body(device_sn_input=scan)).json()
    assert c["serial_inputs"] == {"device_sn": scan}
    url = f"/claims/{c['id']}"
    # another field changed: the record stays
    assert client.patch(url, headers=eng, json={"description": "x"}).json()["serial_inputs"] == {"device_sn": scan}
    # the same SN scanned again by keyboard scanner: recorded, no edit event
    hid = {"method": "hid", "raw": SN}
    d = client.patch(url, headers=eng, json={"device_sn": SN, "device_sn_input": hid}).json()
    assert d["serial_inputs"] == {"device_sn": hid}
    # SN cleared without saying how: not recorded any more
    d = client.patch(url, headers=eng, json={"type": "insurance", "device_sn": None}).json()
    assert d["device_sn"] is None and d["serial_inputs"] == {}
    # a bad method is refused by the schema
    assert client.patch(url, headers=eng, json={"device_sn_input": {"method": "guess"}}).status_code == 422

    # new SN at fulfilment, typed
    c2 = client.post("/claims", headers=eng, json=_body()).json()
    assert c2["serial_inputs"] == {}
    s_url = f"/claims/{c2['id']}/status"
    client.post(s_url, headers=admin, json={"status": "submitted", "note": "sent"})
    client.post(s_url, headers=admin, json={"status": "approved", "note": "ok"})
    s = client.post(s_url, headers=admin, json={"status": "fulfilled", "note": "swap", "new_sn": "INV_NEW", "new_sn_input": {"method": "manual"}}).json()
    assert s["serial_inputs"] == {"new_sn": {"method": "manual", "raw": None}}
