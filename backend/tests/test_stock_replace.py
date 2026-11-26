"""Spares register, phase 3 (docs/plans/spares-failed-units.md §5.3, D-4): a device replaced on site in
one transaction: red tag → failed unit, spare installed, site register serial updated."""

from __future__ import annotations

from collections import defaultdict
from datetime import datetime, timezone

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import func, select
from sqlalchemy.orm import sessionmaker

from app.db.models import FailedUnit, GrowattInverter, GrowattPlant, RedTag, SiteDevice, SiteRegister, SpareUnit, StockMovement, User, UserPlantAssignment
from app.db.seed import ensure_seeded
from app.db.session import Base, build_engine, get_db
from app.main import create_app
from app.services import scan

P1, P2 = 9701, 9702


@pytest.fixture()
def api(tmp_path, monkeypatch):
    monkeypatch.setattr(scan, "limiter", scan.SlidingWindowLimiter())
    engine = build_engine(f"sqlite:///{tmp_path / 'replace.db'}")
    Base.metadata.create_all(bind=engine)
    f = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)
    with f() as db:
        ensure_seeded(db)
        for pid in (P1, P2):
            db.add(GrowattPlant(plant_id=pid, name=f"Plant {pid}"))
        db.add(SiteRegister(site_code="P1-001", plant_id=P1, name="Site one"))
        db.add(SiteRegister(site_code="P1-002", plant_id=P2, name="Site two"))
        db.flush()
        db.add(SiteDevice(site_code="P1-001", kind="router", seq=1, serial="RTR-OLD-1", brand_model="Teltonika RUT241"))
        db.add(SiteDevice(site_code="P1-001", kind="revenue_meter", seq=2, serial=None, brand_model="Cewe Prometer"))
        db.add(SiteDevice(site_code="P1-002", kind="router", seq=1, serial="RTR-P2"))
        db.add(GrowattInverter(device_sn="INVOLD0001", plant_id=P1, alias="INVERTER 1", device_model="MAX 80KTL3 LV"))
        db.add(GrowattInverter(device_sn="INVGONE001", plant_id=P1, not_installed_at=datetime.now(timezone.utc)))
        db.add(GrowattInverter(device_sn="INVP200001", plant_id=P2))
        eng = db.scalars(select(User).where(User.username == "engineer")).one()
        db.add(UserPlantAssignment(user_id=eng.id, plant_id=P1))
        db.commit()
        devs = {(d.site_code, d.kind): d.id for d in db.scalars(select(SiteDevice))}
    app = create_app()

    def override():
        with f() as db:
            yield db

    app.dependency_overrides[get_db] = override
    c = TestClient(app)

    def login(u, p):
        return {"Authorization": "Bearer " + c.post("/auth/login", json={"username": u, "password": p}).json()["access_token"]}

    adm = login("admin", "admin123")
    r = c.post("/users", json={"username": "keeper", "full_name": "Store Keeper", "password": "keeper12345", "role": "engineer", "store_keeper": True, "plant_ids": [P1]}, headers=adm)
    assert r.status_code == 201, r.text
    keeper_id = r.json()["id"]
    keeper = login("keeper", "keeper12345")
    assert c.post("/scan/labels/redtags", json={"count": 10}, headers=adm).status_code == 200
    locs = {}
    for code, kind, holder in (("STORE", "store", None), ("VAN-CREW1", "van", None), ("VAN-CREW2", "van", keeper_id)):
        r = c.post("/stock/locations", json={"code": code, "name": code, "kind": kind, "holder_user_id": holder}, headers=keeper)
        assert r.status_code == 201, r.text
        locs[code] = r.json()["id"]
    router = c.post("/stock/parts", json={"code": "P-ROUTER-RUT241", "name": "Teltonika RUT241", "category": "router", "make": "Teltonika", "model": "RUT241"}, headers=keeper).json()
    inverter = c.post("/stock/parts", json={"code": "P-INV-MAX80", "name": "MAX 80KTL3 LV", "category": "inverter", "make": "Growatt", "model": "MAX 80KTL3 LV"}, headers=keeper).json()
    rows = [
        {"kind": "receive", "part_id": router["id"], "serial": "RTR-NEW-1", "to_location_id": locs["VAN-CREW1"]},
        {"kind": "receive", "part_id": router["id"], "serial": "RTR-NEW-2", "to_location_id": locs["VAN-CREW2"]},
        {"kind": "receive", "part_id": router["id"], "serial": "RTR-NEW-3", "to_location_id": locs["STORE"]},
        {"kind": "receive", "part_id": inverter["id"], "serial": "INVNEW0001", "to_location_id": locs["STORE"]},
    ]
    r = c.post("/stock/movements/batch", json={"rows": rows}, headers=keeper)
    assert r.status_code == 201, r.text
    with f() as db:
        units = {u.serial: u.id for u in db.scalars(select(SpareUnit))}
    router240 = c.post("/stock/parts", json={"code": "P-ROUTER-RUT240", "name": "Teltonika RUT240", "category": "router", "make": "Teltonika", "model": "RUT240"},
                       headers=keeper).json()
    return {"c": c, "adm": adm, "router240": router240, "eng": login("engineer", "engineer123"), "keeper": keeper, "f": f, "locs": locs, "devs": devs, "units": units,
            "router": router, "inverter": inverter}


def _post(t, h, status=201, **kw):
    body = {
        "plant_id": P1,
        "site_device_id": t["devs"][("P1-001", "router")],
        "old_serial": "RTR-OLD-1",
        "old_input_method": "camera",
        "old_raw_scan": "S/N RTR-OLD-1",
        "red_tag": "RT-0001",
        "fault": "No 4G link, LEDs off",
        "new_unit_id": t["units"]["RTR-NEW-1"],
        "new_input_method": "hid",
        "failed_to_location_id": t["locs"]["VAN-CREW1"],
        "note": "Swapped after power cycle failed",
    }
    body.update(kw)
    body = {k: v for k, v in body.items() if v is not None}
    r = t["c"].post("/stock/replacements", json=body, headers=h)
    assert r.status_code == status, r.text
    return r.json()


def _snapshot(t):
    """Everything a replacement writes, to prove a refused one wrote nothing."""
    with t["f"]() as db:
        return (
            db.scalar(select(func.count()).select_from(StockMovement)),
            db.scalar(select(func.count()).select_from(FailedUnit)),
            tuple(db.execute(select(SpareUnit.serial, SpareUnit.state, SpareUnit.location_id, SpareUnit.plant_id).order_by(SpareUnit.id)).all()),
            tuple(db.execute(select(SiteDevice.id, SiteDevice.serial).order_by(SiteDevice.id)).all()),
            tuple(db.execute(select(RedTag.code, RedTag.status).order_by(RedTag.id)).all()),
        )


def test_targets(api):
    t = api
    c = t["c"]
    r = c.get("/stock/replacements/targets", params={"plant_id": P1}, headers=t["eng"])
    assert r.status_code == 200, r.text
    d = r.json()
    assert d["plant_id"] == P1 and d["plant_name"] == f"Plant {P1}"
    assert [(x["kind"], x["label"], x["category"], x["serial"], x["model"]) for x in d["devices"]] == [
        ("site_device", "Revenue meter 2 · P1-001", "revenue_meter", None, "Cewe Prometer"),
        ("site_device", "4G router · P1-001", "router", "RTR-OLD-1", "Teltonika RUT241"),
        ("inverter", "INVERTER 1", "inverter", "INVOLD0001", "MAX 80KTL3 LV"),
    ]
    assert d["devices"][1]["site_device_id"] == t["devs"][("P1-001", "router")] and d["devices"][1]["inverter_sn"] is None
    assert d["devices"][2]["inverter_sn"] == "INVOLD0001" and d["devices"][2]["site_device_id"] is None
    assert set(d["devices"][0]) == {"kind", "site_device_id", "inverter_sn", "label", "category", "serial", "model"}
    # scoping: a hidden plant and an unknown plant are 404; admin sees P2
    assert c.get("/stock/replacements/targets", params={"plant_id": P2}, headers=t["eng"]).status_code == 404
    assert c.get("/stock/replacements/targets", params={"plant_id": 1}, headers=t["adm"]).status_code == 404
    assert [x["serial"] for x in c.get("/stock/replacements/targets", params={"plant_id": P2}, headers=t["adm"]).json()["devices"]] == ["RTR-P2", "INVP200001"]


def test_site_device_replacement(api):
    t = api
    c, eng = t["c"], t["eng"]
    d = _post(t, eng)
    fu, unit, reg = d["failed_unit"], d["installed_unit"], d["register"]
    assert set(d) == {"batch_id", "failed_unit", "installed_unit", "register", "warnings", "claim_prefill"}
    assert (fu["red_tag"], fu["status"], fu["location_code"], fu["serial"], fu["plant_id"], fu["part_id"]) == ("RT-0001", "tagged", "VAN-CREW1", "RTR-OLD-1", P1, t["router"]["id"])
    assert fu["site_device_label"] == "4G router · P1-001" and fu["inverter_sn"] is None
    assert (unit["serial"], unit["state"], unit["plant_id"], unit["location_id"]) == ("RTR-NEW-1", "installed", P1, None)
    assert reg == {"kind": "site_device", "updated": True, "site_device_id": t["devs"][("P1-001", "router")], "inverter_sn": None,
                   "old_serial": "RTR-OLD-1", "new_serial": "RTR-NEW-1"}
    assert d["warnings"] == []
    assert d["claim_prefill"] == {"type": "equipment_warranty", "plant_id": P1, "device_sn": "RTR-OLD-1", "new_sn": "RTR-NEW-1",
                                  "device_label": "4G router · P1-001", "failed_unit_id": fu["id"], "red_tag": "RT-0001"}
    with t["f"]() as db:
        assert db.get(SiteDevice, t["devs"][("P1-001", "router")]).serial == "RTR-NEW-1"
        rows = list(db.scalars(select(StockMovement).where(StockMovement.batch_id == d["batch_id"]).order_by(StockMovement.id)))
    assert [(m.kind, m.plant_id, m.failed_unit_id, m.input_method) for m in rows] == [("failed_in", P1, fu["id"], "camera"), ("issue", P1, fu["id"], "hid")]
    assert all(m.note == "Replacement: RTR-OLD-1 → RTR-NEW-1 · Swapped after power cycle failed" for m in rows)
    assert rows[1].from_location_id == t["locs"]["VAN-CREW1"] and rows[1].raw_scan is None and rows[0].raw_scan == "S/N RTR-OLD-1"
    # the failed unit's trail shows both; phase 1's correct refuses the issue half
    trail = c.get(f"/stock/failed-units/{fu['id']}", headers=eng).json()["trail"]
    assert {m["kind"] for m in trail} == {"failed_in", "issue"}
    assert c.post(f"/stock/movements/{rows[1].id}/correct", json={"note": "x"}, headers=t["keeper"]).status_code == 409


def test_register_mismatch_then_confirm(api):
    t = api
    before = _snapshot(t)
    r = _post(t, t["eng"], 409, old_serial="RTR-LABEL-9")
    det = r["detail"]
    assert det["code"] == "register_mismatch" and det["register_serial"] == "RTR-OLD-1" and det["label_serial"] == "RTR-LABEL-9"
    assert det["message"] and det["errors"][0]["error"] == det["message"]
    assert _snapshot(t) == before
    # case and spaces do not count as a mismatch
    assert _post(t, t["eng"], old_serial=" rtr-old-1 ", red_tag="RT-0003", new_unit_id=t["units"]["RTR-NEW-3"])["register"]["updated"] is True
    with t["f"]() as db:  # put the register back for the confirm case
        db.get(SiteDevice, t["devs"][("P1-001", "router")]).serial = "RTR-OLD-1"
        db.commit()
    d = _post(t, t["eng"], old_serial="RTR-LABEL-9", confirm_register_update=True)
    assert d["failed_unit"]["serial"] == "RTR-LABEL-9" and d["register"]["old_serial"] == "RTR-OLD-1" and d["register"]["new_serial"] == "RTR-NEW-1"
    assert d["claim_prefill"]["device_sn"] == "RTR-LABEL-9"


def test_empty_register_serial_needs_no_confirm(api):
    t = api
    d = _post(t, t["eng"], site_device_id=t["devs"][("P1-001", "revenue_meter")], old_serial="MTR-1234", new_unit_id=t["units"]["RTR-NEW-1"])
    assert d["register"]["old_serial"] is None and d["register"]["new_serial"] == "RTR-NEW-1" and d["register"]["updated"] is True
    # a router spare on a revenue meter: allowed, with a warning, and the failed unit has no part
    assert d["failed_unit"]["part_id"] is None
    assert len(d["warnings"]) == 1 and "revenue meter" in d["warnings"][0]


def test_inverter_replacement(api):
    t = api
    d = _post(t, t["eng"], site_device_id=None, inverter_sn="INVOLD0001", old_serial="INVOLD0001", new_unit_id=t["units"]["INVNEW0001"],
              failed_to_location_id=t["locs"]["STORE"])
    assert d["register"]["kind"] == "inverter" and d["register"]["updated"] is False and d["register"]["inverter_sn"] == "INVOLD0001"
    assert "fleet" in d["register"]["note"]
    assert d["failed_unit"]["inverter_sn"] == "INVOLD0001" and d["failed_unit"]["status"] == "in_store" and d["failed_unit"]["part_id"] == t["inverter"]["id"]
    assert d["claim_prefill"]["type"] == "inverter_warranty" and d["claim_prefill"]["new_sn"] == "INVNEW0001" and d["claim_prefill"]["device_label"] == "INVERTER 1"
    assert d["warnings"] == []
    with t["f"]() as db:
        inv = db.get(GrowattInverter, "INVOLD0001")
        assert inv.plant_id == P1 and inv.not_installed_at is None
        assert db.get(GrowattInverter, "INVNEW0001") is None
    # a not-installed inverter and another plant's are not targets
    _post(t, t["eng"], 422, site_device_id=None, inverter_sn="INVGONE001", old_serial="INVGONE001", red_tag="RT-0002", new_unit_id=t["units"]["RTR-NEW-3"])
    _post(t, t["adm"], 422, site_device_id=None, inverter_sn="INVP200001", old_serial="INVP200001", red_tag="RT-0002", new_unit_id=t["units"]["RTR-NEW-3"])


def test_refusals_write_nothing(api):
    t = api
    eng = t["eng"]
    before = _snapshot(t)
    # exactly one target
    _post(t, eng, 422, inverter_sn="INVOLD0001")
    _post(t, eng, 422, site_device_id=None)
    # the device must be the plant's
    _post(t, t["adm"], 422, site_device_id=t["devs"][("P1-002", "router")])
    # the new unit: same serial as the old, unknown
    with t["f"]() as db:
        db.get(SiteDevice, t["devs"][("P1-001", "router")]).serial = "RTR-NEW-3"
        db.commit()
    _post(t, eng, 422, old_serial="rtr-new-3", new_unit_id=t["units"]["RTR-NEW-3"])
    with t["f"]() as db:
        db.get(SiteDevice, t["devs"][("P1-001", "router")]).serial = "RTR-OLD-1"
        db.commit()
    _post(t, eng, 422, new_unit_id=99999)
    # a bad location / fault / day
    _post(t, eng, 422, failed_to_location_id=99999)
    _post(t, eng, 422, removed_day="2999-01-01")
    assert t["c"].post("/stock/replacements", json={"plant_id": P1}, headers=eng).status_code == 422
    assert _snapshot(t) == before
    # a red tag already bound: 409 and nothing written (spare still in stock, register unchanged)
    _post(t, eng, red_tag="RT-0001", site_device_id=t["devs"][("P1-001", "revenue_meter")], old_serial="MTR-1", new_unit_id=t["units"]["RTR-NEW-3"])
    before = _snapshot(t)
    r = _post(t, eng, 409, red_tag="RT-0001")
    assert "RT-0001" in r["detail"]["message"]
    assert _snapshot(t) == before
    with t["f"]() as db:
        assert db.get(SpareUnit, t["units"]["RTR-NEW-1"]).state == "in_stock"
        assert db.get(SiteDevice, t["devs"][("P1-001", "router")]).serial == "RTR-OLD-1"
    # the new unit not in stock (installed above)
    assert _post(t, eng, 409, red_tag="RT-0002", new_unit_id=t["units"]["RTR-NEW-3"])["detail"]["errors"][0]["error"].endswith("not in stock")
    assert _snapshot(t) == before


def test_scoping(api):
    t = api
    before = _snapshot(t)
    # the engineer does not see P2: 404, nothing written
    _post(t, t["eng"], 404, plant_id=P2, site_device_id=t["devs"][("P1-002", "router")], old_serial="RTR-P2")
    _post(t, t["eng"], 404, plant_id=1)
    assert _snapshot(t) == before
    # admin may
    assert _post(t, t["adm"], plant_id=P2, site_device_id=t["devs"][("P1-002", "router")], old_serial="RTR-P2")["register"]["new_serial"] == "RTR-NEW-1"


def test_warning_for_someone_elses_van(api):
    t = api
    d = _post(t, t["eng"], new_unit_id=t["units"]["RTR-NEW-2"])
    assert d["warnings"] == ["RTR-NEW-2 is from VAN-CREW2 (Store Keeper)"]
    # the holder takes from their own van: no warning
    d = _post(t, t["keeper"], site_device_id=t["devs"][("P1-001", "router")], old_serial="RTR-NEW-2", red_tag="RT-0002",
              new_unit_id=t["units"]["RTR-NEW-3"])
    assert d["warnings"] == []


def test_ledger_replay(api):
    t = api
    eng = t["eng"]
    _post(t, eng)
    _post(t, eng, site_device_id=t["devs"][("P1-001", "revenue_meter")], old_serial="MTR-1", red_tag="RT-0002", new_unit_id=t["units"]["RTR-NEW-2"])
    # the router installed above fails in turn: the linked spare goes failed
    d = _post(t, eng, old_serial="RTR-NEW-1", red_tag="RT-0003", new_unit_id=t["units"]["RTR-NEW-3"])
    with t["f"]() as db:
        u = db.get(SpareUnit, t["units"]["RTR-NEW-1"])
        assert u.state == "failed" and db.get(FailedUnit, d["failed_unit"]["id"]).spare_unit_id == u.id
        state = defaultdict(lambda: ("void", None, None))
        for m in db.scalars(select(StockMovement).where(StockMovement.unit_id.is_not(None)).order_by(StockMovement.id)):
            assert m.from_state == state[m.unit_id][0] or (m.from_state is None and state[m.unit_id][0] == "void")
            state[m.unit_id] = (m.to_state, m.to_location_id if m.to_state == "in_stock" else None, m.plant_id if m.to_state == "installed" else None)
        for u in db.scalars(select(SpareUnit)):
            assert state[u.id][:2] == (u.state, u.location_id), u.serial
            if u.state == "installed":
                assert state[u.id][2] == u.plant_id, u.serial
        assert db.get(SiteDevice, t["devs"][("P1-001", "router")]).serial == "RTR-NEW-3"


def test_part_of_the_old_unit_is_never_assumed(api):
    """#138: the failed unit's part is the removed unit's, never the spare going in: a router of another
    model (RUT240 on the register, a RUT241 spare) gives no part; a device with no model recorded neither."""
    t = api
    with t["f"]() as db:
        db.get(SiteDevice, t["devs"][("P1-001", "router")]).brand_model = "Teltonika RUT240"
        db.commit()
    d = _post(t, t["eng"])
    assert d["failed_unit"]["part_id"] is None and d["warnings"] == []
    with t["f"]() as db:
        d2 = db.get(SiteDevice, t["devs"][("P1-001", "router")])
        d2.brand_model, d2.serial = None, "RTR-NEW-1"
        db.commit()
    d = _post(t, t["eng"], old_serial="RTR-NEW-1", red_tag="RT-0002", new_unit_id=t["units"]["RTR-NEW-3"])
    # the old unit is an installed spare (a RUT241): linked, its own part, though the register has no model
    assert d["failed_unit"]["part_id"] == t["router"]["id"]
    with t["f"]() as db:
        assert db.get(SpareUnit, t["units"]["RTR-NEW-1"]).state == "failed"


def test_installed_spare_of_another_part_is_linked(api):
    """#138: replacing an installed RUT240 spare with a RUT241 spare links (and fails) the RUT240 unit,
    under its own part; before, the lookup was filtered by the RUT241 part and left it installed."""
    t = api
    keeper = t["keeper"]
    r = t["c"].post("/stock/movements/batch", json={"rows": [{"kind": "receive", "part_id": t["router240"]["id"], "serial": "RTR-240-1",
                                                               "to_location_id": t["locs"]["STORE"]}]}, headers=keeper)
    assert r.status_code == 201, r.text
    with t["f"]() as db:
        u240 = db.scalars(select(SpareUnit).where(SpareUnit.serial == "RTR-240-1")).one()
    r = t["c"].post("/stock/movements/batch", json={"rows": [{"kind": "issue", "unit_id": u240.id, "plant_id": P1}]}, headers=keeper)
    assert r.status_code == 201, r.text
    with t["f"]() as db:
        db.get(SiteDevice, t["devs"][("P1-001", "router")]).serial = "RTR-240-1"
        db.commit()
    d = _post(t, t["eng"], old_serial="RTR-240-1")
    assert d["failed_unit"]["part_id"] == t["router240"]["id"]
    with t["f"]() as db:
        assert db.get(SpareUnit, u240.id).state == "failed"
        assert db.get(FailedUnit, d["failed_unit"]["id"]).spare_unit_id == u240.id


def test_spare_installed_on_another_plant_is_not_taken(api):
    """#138: a label serial that is a spare installed on another plant is refused (422 when visible,
    409 without naming it when hidden); that plant's unit is never linked or failed."""
    t = api
    adm = t["adm"]
    r = t["c"].post("/stock/movements/batch", json={"rows": [{"kind": "issue", "unit_id": t["units"]["RTR-NEW-3"], "plant_id": P2}]}, headers=adm)
    assert r.status_code == 201, r.text
    before = _snapshot(t)
    r = _post(t, adm, 422, old_serial="RTR-NEW-3", confirm_register_update=True)
    assert str(P2) in r["detail"]
    r = _post(t, t["eng"], 409, old_serial="RTR-NEW-3", confirm_register_update=True)
    assert "another plant" in r["detail"]["message"] and str(P2) not in r["detail"]["message"]
    assert _snapshot(t) == before
    with t["f"]() as db:
        u = db.get(SpareUnit, t["units"]["RTR-NEW-3"])
        assert (u.state, u.plant_id) == ("installed", P2)


def test_inverter_mismatch_does_not_promise_a_register_update(api):
    t = api
    r = _post(t, t["eng"], 409, site_device_id=None, inverter_sn="INVOLD0001", old_serial="INVLABEL01", new_unit_id=t["units"]["INVNEW0001"])
    msg = r["detail"]["message"]
    assert r["detail"]["code"] == "register_mismatch" and "update the register" not in msg and "failed unit" in msg
