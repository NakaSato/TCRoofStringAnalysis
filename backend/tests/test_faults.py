"""Field faults (defect register, docs/plans/defects.md step 1): scoping, numbering, the
one-active-fault-per-device rule, the status workflow, restore time, links and `df:` labels."""

from __future__ import annotations

from datetime import date, datetime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import sessionmaker

from app.db.models import (
    FieldFault,
    GrowattInverter,
    GrowattIssue,
    GrowattMeter,
    GrowattPlant,
    SiteDevice,
    SiteRegister,
    User,
    UserPlantAssignment,
)
from app.db.seed import ensure_seeded
from app.db.session import Base, build_engine, get_db
from app.main import create_app
from app.services import growatt_issues

P1, P2 = 9101, 9102
SN = "INVF1"
NOW = datetime.now(timezone.utc)


@pytest.fixture()
def api(tmp_path):
    engine = build_engine(f"sqlite:///{tmp_path / 'faults.db'}")
    Base.metadata.create_all(bind=engine)
    f = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)
    with f() as db:
        ensure_seeded(db)
        for pid in (P1, P2):
            db.add(GrowattPlant(plant_id=pid, name=f"Roof {pid}"))
        db.flush()
        db.add(GrowattInverter(device_sn=SN, plant_id=P1, alias="INVERTER 1"))
        db.add(GrowattInverter(device_sn="INVF2", plant_id=P2))
        db.add(GrowattMeter(datalogger_sn="DLF1", address=36, plant_id=P1))
        db.add(SiteRegister(site_code="P1-901", plant_id=P1, name="Roof one"))
        db.add(SiteRegister(site_code="P1-902", plant_id=P2, name="Roof two"))
        db.flush()
        db.add(SiteDevice(site_code="P1-901", kind="router", seq=1, serial="RUT-0001", ip="10.0.0.1"))
        db.add(SiteDevice(site_code="P1-902", kind="router", seq=1, serial="RUT-0002"))
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


def _new(client, h, **kw):
    body = {"plant_id": P1, "kind": "inverter", "severity": "S2", "how_found": "site_visit", "symptom": "Fan noise, derating"}
    body.update(kw)
    return client.post("/faults", headers=h, json=body)


def _router_id(f, site_code="P1-901"):
    with f() as db:
        return db.scalars(select(SiteDevice.id).where(SiteDevice.site_code == site_code)).one()


def test_create_numbers_reads_register_serial_and_lists(api):
    f, client, adm, eng = api
    r = _new(client, eng, inverter_sn=SN, serial="TYPED-ONE", serial_input="manual")
    assert r.status_code == 201, r.text
    d = r.json()
    year = datetime.now().year
    assert d["no"] == f"DF-{year}-0001" and d["status"] == "open" and d["active"] is True
    # a picked device: the register's serial wins, recorded as read from the register
    assert d["serial"] == SN and d["serial_input"] == "register" and d["device_label"] == f"INVERTER 1 · {SN}"
    assert d["found_by"] == "engineer" and d["waiting_on"] == "us" and d["restore_hours"] is None and d["age_days"] == 0
    assert [e["kind"] for e in d["events"]] == ["created"]
    # a typed serial without a device keeps how it was entered
    d2 = _new(client, eng, kind="pv_module", serial=" zx-123 ", serial_input="camera", serial_raw="S/N: ZX-123",
              position={"mppt": 2, "string_no": 3, "module_no": 14}).json()
    assert d2["no"] == f"DF-{year}-0002" and d2["serial"] == "zx-123" and d2["serial_input"] == "camera" and d2["serial_raw"] == "S/N: ZX-123"
    assert d2["position"] == {"mppt": 2, "string_no": 3, "module_no": 14}
    body = client.get("/faults", headers=eng).json()
    assert [x["no"] for x in body["faults"]] == [d2["no"], d["no"]] and body["total"] == 2
    assert body["summary"]["open"] == 2 and body["summary"]["waiting_us"] == 2
    assert client.get("/faults?q=zx-123", headers=eng).json()["total"] == 1
    assert client.get("/faults?kind=inverter", headers=eng).json()["total"] == 1
    assert client.get("/faults?tab=closed", headers=eng).json()["total"] == 0


def test_scope_and_validation(api):
    f, client, adm, eng = api
    other = _new(client, adm, plant_id=P2).json()
    # another plant: 404 everywhere, never revealed
    assert _new(client, eng, plant_id=P2).status_code == 404
    assert client.get(f"/faults/{other['id']}", headers=eng).status_code == 404
    assert client.post(f"/faults/{other['id']}/notes", headers=eng, json={"text": "x"}).status_code == 404
    assert client.get(f"/faults?plant_id={P2}", headers=eng).status_code == 404
    assert client.get("/faults", headers=eng).json()["total"] == 0
    assert client.get("/faults", headers=adm).json()["total"] == 1
    # the device must be the plant's
    assert _new(client, eng, inverter_sn="INVF2").status_code == 422
    assert _new(client, eng, site_device_id=_router_id(f, "P1-902")).status_code == 422
    assert _new(client, eng, inverter_sn=SN, site_device_id=_router_id(f)).status_code == 422  # one device at most
    assert _new(client, eng, meter={"datalogger_sn": "DLF1", "address": 99}).status_code == 422
    assert _new(client, eng, meter={"datalogger_sn": "DLF1", "address": 36}, kind="grid_meter").status_code == 201
    # lists and required fields
    assert _new(client, eng, kind="toaster").status_code == 422
    assert _new(client, eng, severity="S9").status_code == 422
    assert _new(client, eng, symptom="  ").status_code == 422
    assert _new(client, eng, kind="service").status_code == 422  # needs its sub kind
    assert _new(client, eng, found_at=(NOW + timedelta(hours=2)).isoformat()).status_code == 422
    assert _new(client, eng, evidence_urls=["javascript:alert(1)"]).status_code == 422
    assert _new(client, eng, position={"string_no": 0}).status_code == 422
    with f() as db:
        admin_id = db.scalars(select(User.id).where(User.username == "admin")).one()
        eng2 = User(username="eng2", email="eng2@example.com", hashed_password="x", role="engineer")
        db.add(eng2)
        db.commit()
        eng2_id = eng2.id
    assert _new(client, eng, owner_user_id=eng2_id).status_code == 422  # not assigned to the plant
    assert _new(client, eng, kind="other", owner_user_id=admin_id).json()["owner"]["username"] == "admin"


def test_one_active_fault_per_device_kind_and_position(api):
    f, client, adm, eng = api
    rid = _router_id(f)
    first = _new(client, eng, kind="router_4g", site_device_id=rid, severity="S3").json()
    assert first["serial"] == "RUT-0001" and first["device_label"] == "4G router"
    r = _new(client, eng, kind="router_4g", site_device_id=rid)
    assert r.status_code == 409 and r.json()["detail"]["fault_id"] == first["id"] and r.json()["detail"]["no"] == first["no"]
    # the same serial typed in, without picking the device, is the same device
    assert _new(client, eng, kind="router_4g", serial="rut-0001", serial_input="manual").status_code == 409
    assert _new(client, eng, kind="router_4g", site_device_id=rid, allow_duplicate=True).status_code == 201
    # another kind on the device, or another position, is another fault
    assert _new(client, eng, kind="service", sub_kind="sim", site_device_id=rid).status_code == 201
    a = _new(client, eng, kind="pv_module", inverter_sn=SN, position={"string_no": 3, "module_no": 1}).json()
    assert _new(client, eng, kind="pv_module", inverter_sn=SN, position={"string_no": 3, "module_no": 2}).status_code == 201
    assert _new(client, eng, kind="pv_module", inverter_sn=SN, position={"string_no": 3, "module_no": 1}).status_code == 409
    # BOS faults without a device are told apart by people: never a duplicate
    for _ in range(2):
        assert _new(client, eng, kind="dc_bos", position={"location": "Combiner 2"}).status_code == 201
    on = client.get(f"/faults/open-on-device?site_device_id={rid}", headers=eng).json()["faults"]
    assert {x["kind"] for x in on} == {"router_4g", "service"}
    # restored: the device works again, a new fault is fine
    client.post(f"/faults/{a['id']}/status", headers=eng, json={"status": "restored"})
    assert _new(client, eng, kind="pv_module", inverter_sn=SN, position={"string_no": 3, "module_no": 1}).status_code == 201


def test_workflow_restore_close_reopen(api):
    f, client, adm, eng = api
    found = NOW - timedelta(days=2, hours=3)
    d = _new(client, eng, found_at=found.isoformat()).json()
    url = f"/faults/{d['id']}"
    st = lambda **b: client.post(f"{url}/status", headers=eng, json=b)  # noqa: E731
    assert st(status="waiting").status_code == 422  # needs a reason
    w = st(status="waiting", waiting_reason="claim").json()
    assert w["status"] == "waiting" and w["waiting_reason"] == "claim" and w["waiting_on"] == "them"
    assert st(status="waiting", waiting_reason="part").json()["waiting_on"] == "us"
    assert st(status="closed").status_code == 409  # waiting → closed is not a step
    assert st(status="restored", restored_at=(found - timedelta(minutes=1)).isoformat()).status_code == 422
    assert st(status="restored", restored_at=(NOW + timedelta(hours=1)).isoformat()).status_code == 422
    r = st(status="restored", restored_at=(found + timedelta(hours=27)).isoformat()).json()
    assert r["status"] == "restored" and r["waiting_reason"] is None and r["restore_hours"] == 27.0 and r["active"] is False
    c = st(status="closed", note="fan replaced").json()
    assert c["status"] == "closed" and c["closed_by"] == "engineer" and c["restore_hours"] == 27.0
    assert client.post(f"{url}/decision", headers=eng, json={"decision": "replace", "reason": "x"}).status_code == 409
    # reopened by anyone with the plant: not restored any more
    o = st(status="open", note="fan noise is back").json()
    assert o["status"] == "open" and o["restored_at"] is None and o["closed_at"] is None and o["restore_hours"] is None
    steps = [(e["from"], e["to"]) for e in o["events"] if e["kind"] == "status"]
    assert steps == [("closed", "open"), ("restored", "closed"), ("waiting", "restored"), ("waiting", "waiting"), ("open", "waiting")]
    # monitor / no_action close only with a note
    m = _new(client, eng, kind="pv_module", position={"string_no": 4}).json()
    murl = f"/faults/{m['id']}/status"
    client.post(murl, headers=eng, json={"status": "monitor"})
    assert client.post(murl, headers=eng, json={"status": "closed"}).status_code == 422
    assert client.post(murl, headers=eng, json={"status": "closed", "note": "no change in 30 days"}).json()["status"] == "closed"
    x = _new(client, eng, kind="other").json()
    assert client.post(f"/faults/{x['id']}/status", headers=eng, json={"status": "cancelled", "note": "duplicate"}).json()["status"] == "cancelled"
    summary = client.get("/faults?tab=all", headers=eng).json()["summary"]
    assert summary["open"] == 1 and summary["restored"] == 0


def test_decision_edit_followup_and_timeline(api):
    _, client, adm, eng = api
    d = _new(client, eng).json()
    url = f"/faults/{d['id']}"
    out = client.post(f"{url}/decision", headers=eng, json={"decision": "replace", "reason": "fan bearing worn"}).json()
    assert out["decision"] == "replace" and out["decision_reason"] == "fan bearing worn"
    assert client.post(f"{url}/decision", headers=eng, json={"decision": "remote_fix", "reason": "x"}).status_code == 422  # service only
    yesterday = (date.today() - timedelta(days=1)).isoformat()
    p = client.patch(url, headers=eng, json={"severity": "S1", "next_action_day": yesterday, "reference": "TKT-77", "cause": "degradation"}).json()
    assert p["severity"] == "S1" and p["followup_overdue"] is True and p["reference"] == "TKT-77"
    s = client.get("/faults", headers=eng).json()["summary"]
    assert s["s1_open"] == 1 and s["followup_overdue"] == 1
    assert client.get("/faults?overdue=true", headers=eng).json()["total"] == 1
    assert client.patch(url, headers=eng, json={"next_action_day": None}).json()["followup_overdue"] is False
    client.post(f"{url}/notes", headers=eng, json={"text": "Spare ordered"})
    ev = client.get(url, headers=eng).json()["events"]
    kinds = [e["kind"] for e in ev]
    assert kinds == ["note", "edit", "edit", "severity", "decision", "created"]
    assert ev[3]["from"] == "S2" and ev[3]["to"] == "S1" and ev[0]["text"] == "Spare ordered"
    assert ev[2]["text"] == "cause, next_action_day, reference" and ev[1]["text"] == "next_action_day"
    assert client.patch(url, headers=eng, json={"sub_kind": "vpn"}).json()["sub_kind"] is None  # not a service fault


def test_links_scope_and_shadow_issues(api):
    f, client, adm, eng = api
    with f() as db:
        day = date.today() - timedelta(days=2)
        growatt_issues.sync(db, day, [{  # one call: a day's sync replaces that day's findings
            "rule": "R2", "tier": "P2", "plant_id": P1, "device_sn": SN, "string_no": sno, "day": day.isoformat(),
            "lost_kwh_est": 1.0, "thb_est": 5.0, "evidence": {}, "safety": False, "shadow": sh,
        } for sh, sno in ((False, 1), (True, 2))])
        by_string = {i.string_no: i.id for i in db.scalars(select(GrowattIssue))}
    live, shadow = by_string[1], by_string[2]
    r = _new(client, eng, how_found="issue", links=[{"kind": "issue", "ref_id": live}])
    assert r.status_code == 201, r.text
    d = r.json()
    assert d["links"] == {"issue": 1} and d["link_list"][0]["label"].startswith("R2")
    assert _new(client, eng, kind="other", links=[{"kind": "issue", "ref_id": shadow}]).status_code == 422  # engineers: live issues only
    url = f"/faults/{d['id']}"
    assert client.post(f"{url}/links", headers=adm, json={"kind": "issue", "ref_id": shadow}).status_code == 201
    assert client.post(f"{url}/links", headers=adm, json={"kind": "issue", "ref_id": shadow}).status_code == 409
    admin_view = client.get(url, headers=adm).json()
    assert admin_view["links"] == {"issue": 2} and any(e["kind"] == "link" for e in admin_view["events"])
    eng_view = client.get(url, headers=eng).json()
    assert eng_view["links"] == {"issue": 1} and [x["ref_id"] for x in eng_view["link_list"]] == [live]
    assert not any(e["kind"] == "link" for e in eng_view["events"])  # the shadow link's entry is left out too
    hidden_link = next(x["id"] for x in admin_view["link_list"] if x["ref_id"] == shadow)
    assert client.delete(f"{url}/links/{hidden_link}", headers=eng).status_code == 404
    # by key: an alarm (device + code + time as text); a stock batch must exist
    assert client.post(f"{url}/links", headers=eng, json={"kind": "alarm", "ref_key": f"{SN}|117|2026-11-20 06:19"}).status_code == 201
    assert client.post(f"{url}/links", headers=eng, json={"kind": "stock_batch", "ref_key": "nope"}).status_code == 422
    assert client.post(f"{url}/links", headers=eng, json={"kind": "claim", "ref_id": 999}).status_code == 422
    alarm = next(x for x in client.get(url, headers=eng).json()["link_list"] if x["kind"] == "alarm")
    assert alarm["label"] == f"{SN}|117|2026-11-20 06:19"
    assert client.delete(f"{url}/links/{alarm['id']}", headers=eng).status_code == 204
    with f() as db:
        assert db.get(FieldFault, d["id"]).status == "open"


def test_df_label_resolves_to_the_fault(api):
    f, client, adm, eng = api
    mine = _new(client, eng).json()
    other = _new(client, adm, plant_id=P2).json()
    body = client.get("/scan/resolve", params={"code": f"df:{mine['no'].lower()}"}, headers=eng).json()
    [m] = body["matches"]
    assert body["unsupported_kind"] is None
    assert m["kind"] == "field_fault" and m["path"] == f"/faults?fault={mine['id']}" and m["plant_id"] == P1 and m["plant_name"] == f"Roof {P1}"
    assert client.get("/scan/resolve", params={"code": f"/s/df/{other['no']}"}, headers=eng).status_code == 404  # another plant: not revealed
    assert client.get("/scan/resolve", params={"code": f"/s/df/{other['no']}"}, headers=adm).status_code == 200
