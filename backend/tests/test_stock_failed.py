"""Spares register, phase 2 (docs/plans/spares-failed-units.md §5.3–5.5): failed units bound to red
tags, their moves (transfer, ship out, back from the supplier, scrap), claim shipments, plant
scoping, the scan resolver and the summary counts."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import sessionmaker

from app.config import settings
from app.db.models import Claim, ClaimEvent, GrowattPlant, RedTag, SiteDevice, SiteRegister, SpareUnit, StockMovement, User, UserPlantAssignment
from app.db.seed import ensure_seeded
from app.db.session import Base, build_engine, get_db
from app.main import create_app
from app.services import scan

P1, P2 = 9601, 9602


@pytest.fixture()
def api(tmp_path, monkeypatch):
    monkeypatch.setattr(scan, "limiter", scan.SlidingWindowLimiter())
    engine = build_engine(f"sqlite:///{tmp_path / 'failed.db'}")
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
        db.add(SiteDevice(site_code="P1-002", kind="router", seq=1, serial="RTR-P2"))
        eng = db.scalars(select(User).where(User.username == "engineer")).one()
        db.add(UserPlantAssignment(user_id=eng.id, plant_id=P1))
        db.add(Claim(number="CL-2026-001", claim_type="equipment_warranty", status="submitted", cause="manufacturing_defect", plant_id=P1, counterparty="Teltonika"))
        db.add(Claim(number="CL-2026-002", claim_type="equipment_warranty", status="submitted", cause="manufacturing_defect", plant_id=P2, counterparty="Teltonika"))
        db.commit()
        devs = {d.site_code: d.id for d in db.scalars(select(SiteDevice))}
        claims = {c.plant_id: c.id for c in db.scalars(select(Claim))}
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
    keeper = login("keeper", "keeper12345")
    assert c.post("/scan/labels/redtags", json={"count": 10}, headers=adm).status_code == 200
    locs = {}
    for code, kind in (("STORE", "store"), ("VAN-CREW1", "van"), ("SUPPLIER-TEL", "supplier")):
        r = c.post("/stock/locations", json={"code": code, "name": code, "kind": kind}, headers=keeper)
        assert r.status_code == 201, r.text
        locs[kind] = r.json()["id"]
    r = c.post("/stock/locations", json={"code": "STORE-FAILED", "name": "Failed bin", "kind": "bin", "parent_id": locs["store"]}, headers=keeper)
    locs["bin"] = r.json()["id"]
    part = c.post("/stock/parts", json={"code": "P-ROUTER-RUT241", "name": "Teltonika RUT241", "category": "router"}, headers=keeper).json()
    return {"c": c, "adm": adm, "eng": login("engineer", "engineer123"), "keeper": keeper, "f": f, "locs": locs, "part": part, "devs": devs, "claims": claims}


def _new(t, h, status=201, **kw):
    body = {"red_tag": "RT-0001", "fault": "No 4G link, LEDs off", "to_location_id": t["locs"]["van"], "plant_id": P1}
    body.update(kw)
    r = t["c"].post("/stock/failed-units", json=body, headers=h)
    assert r.status_code == status, r.text
    return r.json()


def _move(t, h, fid, status=201, **body):
    r = t["c"].post(f"/stock/failed-units/{fid}/move", json=body, headers=h)
    assert r.status_code == status, r.text
    return r.json()


def _tag_status(t, code):
    with t["f"]() as db:
        return db.scalars(select(RedTag.status).where(RedTag.code == code)).one()


def test_bind_red_tag(api):
    t = api
    c, eng = t["c"], t["eng"]
    fu = _new(t, eng, serial=" rtr-old-1 ", site_device_id=t["devs"]["P1-001"], input_method="camera", raw_scan="S/N RTR-OLD-1")
    assert fu["red_tag"] == "RT-0001" and fu["status"] == "tagged" and fu["location_code"] == "VAN-CREW1"
    assert fu["serial"] == "rtr-old-1" and fu["site_device_label"] == "4G router · P1-001" and fu["plant_name"] == f"Plant {P1}"
    assert fu["part_id"] is None and fu["age_days"] == 0 and fu["unsent_overdue"] is False and fu["created_by"] == "engineer"
    assert set(fu) == {
        "id", "red_tag", "part_id", "part_code", "part_name", "serial", "plant_id", "plant_name", "site_device_id", "site_device_label",
        "inverter_sn", "removed_day", "fault", "status", "location_id", "location_code", "claim_id", "claim_number", "age_days",
        "unsent_overdue", "created_by",
    }
    assert _tag_status(t, "RT-0001") == "bound"
    # the same tag again; the same serial on another tag while open; unknown tag; a void tag
    assert _new(t, eng, 409)["detail"]["errors"][0]["error"] == "RT-0001 is already on a failed unit"
    assert "RT-0001" in _new(t, eng, 409, red_tag="RT-0002", serial="RTR-OLD-1")["detail"]["errors"][0]["error"]
    assert _new(t, eng, 422, red_tag="RT-0103")["detail"] == "No red tag RT-0103"
    with t["f"]() as db:
        db.scalars(select(RedTag).where(RedTag.code == "RT-0009")).one().status = "void"
        db.commit()
    _new(t, eng, 409, red_tag="RT-0009")
    # URL, `rt:` and short forms; a store gives in_store
    assert _new(t, eng, red_tag="https://x.example/s/rt/RT-0002", to_location_id=t["locs"]["bin"])["status"] == "in_store"
    assert _new(t, eng, red_tag="rt:RT-0003")["red_tag"] == "RT-0003"
    assert _new(t, eng, red_tag="rt-4", serial=None)["red_tag"] == "RT-0004"
    # bad input
    _new(t, eng, 422, red_tag="RT-0005", to_location_id=t["locs"]["supplier"])
    _new(t, eng, 422, red_tag="RT-0005", part_id=999)
    _new(t, eng, 422, red_tag="RT-0005", site_device_id=t["devs"]["P1-002"])
    _new(t, eng, 422, red_tag="RT-0005", removed_day="2999-01-01")
    _new(t, eng, 422, red_tag="RT-0005", fault="")
    assert _tag_status(t, "RT-0005") == "reserved"
    # trail: one failed_in row carrying the scan
    d = c.get(f"/stock/failed-units/{fu['id']}", headers=eng).json()
    (m,) = d["trail"]
    assert (m["kind"], m["failed_unit_id"], m["to_state"], m["part_id"], m["part_code"], m["input_method"]) == ("failed_in", fu["id"], "failed", None, None, "camera")


def test_installed_spare_is_linked(api):
    t = api
    c, keeper, eng = t["c"], t["keeper"], t["eng"]
    pid = t["part"]["id"]
    r = c.post("/stock/movements/batch", json={"rows": [{"kind": "receive", "part_id": pid, "serial": "SP-100", "to_location_id": t["locs"]["store"]}]}, headers=keeper)
    assert r.status_code == 201, r.text
    assert c.post("/stock/movements/batch", json={"rows": [{"kind": "issue", "part_id": pid, "serial": "SP-100", "plant_id": P1}]}, headers=eng).status_code == 201
    fu = _new(t, eng, serial="sp-100", plant_id=None)
    assert fu["part_id"] == pid and fu["part_code"] == "P-ROUTER-RUT241" and fu["plant_id"] == P1
    with t["f"]() as db:
        u = db.scalars(select(SpareUnit).where(SpareUnit.serial_key == "SP-100")).one()
        assert (u.state, u.location_id, u.plant_id) == ("failed", None, P1)
    m = c.get(f"/stock/failed-units/{fu['id']}", headers=eng).json()["trail"][0]
    assert (m["unit_id"] is not None, m["from_state"], m["to_state"], m["part_code"]) == (True, "installed", "failed", "P-ROUTER-RUT241")
    # the spare's movements cannot be corrected around the failed unit
    issue = c.get("/stock/movements", params={"kind": "issue"}, headers=keeper).json()["movements"][0]
    assert c.post(f"/stock/movements/{issue['id']}/correct", json={"note": "x"}, headers=keeper).status_code == 409
    assert c.post(f"/stock/movements/{m['id']}/correct", json={"note": "x"}, headers=keeper).status_code == 409
    # back from the supplier repaired: the same unit in stock again
    _move(t, eng, fu["id"], kind="transfer", to_location_id=t["locs"]["bin"])
    _move(t, keeper, fu["id"], kind="ship_out", to_location_id=t["locs"]["supplier"])
    d = _move(t, keeper, fu["id"], kind="supplier_return", outcome="repaired", to_location_id=t["locs"]["store"])
    assert d["status"] == "repaired" and d["location_code"] == "STORE"
    with t["f"]() as db:
        u = db.scalars(select(SpareUnit).where(SpareUnit.serial_key == "SP-100")).one()
        assert (u.state, u.location_id, u.plant_id) == ("in_stock", t["locs"]["store"], None)
        assert db.scalars(select(SpareUnit)).all() == [u]


def test_plant_scoping(api):
    t = api
    c, adm, eng = t["c"], t["adm"], t["eng"]
    _new(t, eng, 422, plant_id=P2)
    _new(t, eng, 422, plant_id=12345)
    _new(t, eng, 422, site_device_id=t["devs"]["P1-002"], plant_id=None)
    hidden = _new(t, adm, plant_id=P2, serial="HID-1", red_tag="RT-0002")
    mine = _new(t, eng, serial="MINE-1", red_tag="RT-0003")
    nowhere = _new(t, adm, plant_id=None, serial="NOPLANT-1", red_tag="RT-0004")
    assert {x["id"] for x in c.get("/stock/failed-units", headers=eng).json()} == {mine["id"], nowhere["id"]}
    assert len(c.get("/stock/failed-units", headers=adm).json()) == 3
    for path in (f"/stock/failed-units/{hidden['id']}",):
        assert c.get(path, headers=eng).status_code == 404
    assert c.patch(f"/stock/failed-units/{hidden['id']}", json={"fault": "x"}, headers=eng).status_code == 404
    assert c.post(f"/stock/failed-units/{hidden['id']}/move", json={"kind": "transfer", "to_location_id": t["locs"]["bin"]}, headers=eng).status_code == 404
    # the ledger hides the row too
    assert all(m["failed_unit_id"] != hidden["id"] for m in c.get("/stock/movements", headers=eng).json()["movements"])
    # resolver: a bound tag opens its failed unit, a hidden one is 404
    r = c.get("/scan/resolve", params={"code": "https://x.example/s/rt/RT-0003"}, headers=eng).json()
    assert r["unsupported_kind"] is None and r["red_tag"]["status"] == "bound"
    assert r["matches"] == [{
        "kind": "failed_unit", "id": str(mine["id"]), "label": "Failed unit · RT-0003", "field": "red_tag",
        "path": f"/inventory?tab=failed&fu={mine['id']}", "plant_id": P1, "plant_name": f"Plant {P1}", "detail": "No 4G link, LEDs off",
    }]
    assert c.get("/scan/resolve", params={"code": "rt:RT-0002"}, headers=eng).status_code == 404
    assert c.get("/scan/resolve", params={"code": "rt:RT-0002"}, headers=adm).json()["matches"][0]["id"] == str(hidden["id"])
    # a reserved tag is still known and blank
    assert c.get("/scan/resolve", params={"code": "rt:RT-0007"}, headers=eng).json()["unsupported_kind"] == "rt"
    # a raw serial finds an open failed unit (scoped)
    assert [m["kind"] for m in c.get("/scan/resolve", params={"code": "S/N mine-1"}, headers=eng).json()["matches"]] == ["failed_unit"]
    assert c.get("/scan/resolve", params={"code": "HID-1"}, headers=eng).json()["matches"] == []
    # search by serial or tag
    assert [x["id"] for x in c.get("/stock/failed-units", params={"q": "rt-0003"}, headers=eng).json()] == [mine["id"]]
    assert [x["id"] for x in c.get("/stock/failed-units", params={"q": "noplant"}, headers=eng).json()] == [nowhere["id"]]


def test_moves_claims_and_ledger(api):
    t = api
    c, eng, keeper, locs = t["c"], t["eng"], t["keeper"], t["locs"]
    cid = t["claims"][P1]
    _new(t, eng, 422, claim_id=t["claims"][P2])
    fu = _new(t, eng, serial="RT-SN-1", claim_id=cid)
    assert fu["claim_number"] == "CL-2026-001"
    # transfer: van → bin, not to the same place, not to a supplier
    d = _move(t, eng, fu["id"], kind="transfer", to_location_id=locs["bin"])
    assert d["status"] == "in_store" and d["location_code"] == "STORE-FAILED"
    _move(t, eng, fu["id"], 422, kind="transfer", to_location_id=locs["bin"])
    _move(t, eng, fu["id"], 422, kind="transfer", to_location_id=locs["supplier"])
    # ship out: store keeper, supplier location
    _move(t, eng, fu["id"], 403, kind="ship_out", to_location_id=locs["supplier"])
    _move(t, keeper, fu["id"], 422, kind="ship_out", to_location_id=locs["store"])
    d = _move(t, keeper, fu["id"], kind="ship_out", to_location_id=locs["supplier"], carrier="Kerry", tracking_no="KER123")
    assert d["status"] == "sent" and d["location_code"] == "SUPPLIER-TEL"
    _move(t, eng, fu["id"], 409, kind="transfer", to_location_id=locs["van"])
    # back: needs a part first; replaced → a new spare unit in stock
    _move(t, keeper, fu["id"], 422, kind="supplier_return", outcome="replaced", new_serial="NEW-1", to_location_id=locs["store"])
    assert c.patch(f"/stock/failed-units/{fu['id']}", json={"part_id": t["part"]["id"], "fault": "Dead modem"}, headers=eng).json()["part_code"] == "P-ROUTER-RUT241"
    _move(t, keeper, fu["id"], 422, kind="supplier_return", outcome="replaced", to_location_id=locs["store"])  # no new serial
    d = _move(t, keeper, fu["id"], kind="supplier_return", outcome="replaced", new_serial="NEW-1", to_location_id=locs["store"])
    assert d["status"] == "replaced" and d["fault"] == "Dead modem"
    assert [m["kind"] for m in d["trail"]] == ["supplier_return", "supplier_return", "ship_out", "transfer", "failed_in"]
    units = {u["serial"]: u for u in c.get("/stock/units", headers=eng).json()}
    assert units["NEW-1"]["state"] == "in_stock" and units["NEW-1"]["location_code"] == "STORE"
    _move(t, keeper, fu["id"], 409, kind="scrap")
    # claim timeline: shipment out and in
    with t["f"]() as db:
        ev = [(e.direction, e.carrier, e.tracking_no, e.sn) for e in db.scalars(select(ClaimEvent).where(ClaimEvent.claim_id == cid, ClaimEvent.kind == "shipment").order_by(ClaimEvent.id))]
        assert ev == [("out", "Kerry", "KER123", "RT-SN-1"), ("in", None, None, "NEW-1")]
    # replaced with a serial already a spare: 409
    fu2 = _new(t, eng, red_tag="RT-0002", serial="RT-SN-2", part_id=t["part"]["id"])
    _move(t, keeper, fu2["id"], kind="ship_out", to_location_id=locs["supplier"])
    _move(t, keeper, fu2["id"], 409, kind="supplier_return", outcome="replaced", new_serial="new-1", to_location_id=locs["store"])
    # repaired without a linked spare: a spare unit is created under its serial
    d = _move(t, keeper, fu2["id"], kind="supplier_return", outcome="repaired", to_location_id=locs["van"])
    assert d["status"] == "repaired"
    assert c.get("/stock/units", params={"q": "RT-SN-2"}, headers=eng).json()[0]["location_code"] == "VAN-CREW1"
    # scrap: keeper only
    fu3 = _new(t, eng, red_tag="RT-0003", serial="RT-SN-3")
    _move(t, eng, fu3["id"], 403, kind="scrap")
    d = _move(t, keeper, fu3["id"], kind="scrap", note="burnt")
    assert d["status"] == "scrapped" and d["location_id"] is None
    # every ledger row of a failed unit names it
    with t["f"]() as db:
        rows = list(db.scalars(select(StockMovement).where(StockMovement.kind.in_(("failed_in", "ship_out", "supplier_return", "scrap")))))
        assert rows and all(m.failed_unit_id is not None for m in rows)
    assert all("failed_unit_id" in m for m in c.get("/stock/movements", headers=keeper).json()["movements"])


def test_replacement_serial_keeps_its_scan(api):
    """supplier_return / replaced: the new serial's input_method / raw_scan go on the spare unit's row;
    a bad method is 422, an over-long raw scan 422, a raw scan without a method is dropped."""
    t = api
    eng, keeper, locs, pid = t["eng"], t["keeper"], t["locs"], t["part"]["id"]

    def sent(tag, serial):
        fu = _new(t, eng, red_tag=tag, serial=serial, part_id=pid)
        _move(t, keeper, fu["id"], kind="ship_out", to_location_id=locs["supplier"])
        return fu["id"]

    def unit_row(fid):
        with t["f"]() as db:
            (m,) = db.scalars(select(StockMovement).where(StockMovement.failed_unit_id == fid, StockMovement.kind == "supplier_return",
                                                          StockMovement.unit_id.is_not(None)))
            return m.input_method, m.raw_scan, m.serial

    f1 = sent("RT-0001", "OLD-1")
    back = {"kind": "supplier_return", "outcome": "replaced", "to_location_id": locs["store"]}
    _move(t, keeper, f1, 422, **back, new_serial="NEW-A", input_method="laser")
    _move(t, keeper, f1, 422, **back, new_serial="NEW-A", input_method="camera", raw_scan="x" * 513)
    raw = "SN:NEW-A;PN:RUT241;https://example.com/very/long/label"
    _move(t, keeper, f1, **back, new_serial="NEW-A", input_method="camera", raw_scan=raw)
    assert unit_row(f1) == ("camera", raw, "NEW-A")
    with t["f"]() as db:  # the failed unit's own row is not the scanned serial
        own = db.scalars(select(StockMovement).where(StockMovement.failed_unit_id == f1, StockMovement.kind == "supplier_return",
                                                     StockMovement.unit_id.is_(None))).one()
        assert (own.input_method, own.raw_scan) == (None, None)
    # no method: the raw scan is dropped; typed: method only
    f2 = sent("RT-0002", "OLD-2")
    _move(t, keeper, f2, **back, new_serial="NEW-B", raw_scan="NEW-B")
    assert unit_row(f2) == (None, None, "NEW-B")
    f3 = sent("RT-0003", "OLD-3")
    _move(t, keeper, f3, **back, new_serial="NEW-C", input_method="manual")
    assert unit_row(f3) == ("manual", None, "NEW-C")
    # repaired: nothing scanned, nothing recorded
    f4 = sent("RT-0004", "OLD-4")
    _move(t, keeper, f4, kind="supplier_return", outcome="repaired", to_location_id=locs["store"], input_method="hid", raw_scan="OLD-4")
    assert unit_row(f4)[:2] == (None, None)


def test_overdue_and_summary(api, monkeypatch):
    t = api
    c, eng, adm, keeper = t["c"], t["eng"], t["adm"], t["keeper"]
    a = _new(t, eng, removed_day="2026-01-05")
    _new(t, adm, red_tag="RT-0002", plant_id=P2)
    b = _new(t, eng, red_tag="RT-0003")
    _move(t, keeper, b["id"], kind="ship_out", to_location_id=t["locs"]["supplier"])
    assert c.get(f"/stock/failed-units/{a['id']}", headers=eng).json()["unsent_overdue"] is True
    monkeypatch.setattr(settings, "stock_failed_unsent_days", 0)
    rows = {x["red_tag"]: x for x in c.get("/stock/failed-units", headers=adm).json()}
    assert rows["RT-0001"]["unsent_overdue"] is True and rows["RT-0003"]["unsent_overdue"] is False
    assert rows["RT-0002"]["unsent_overdue"] is False  # removed today: age 0 is not over 0 days
    assert [x["red_tag"] for x in c.get("/stock/failed-units", params={"status": "sent"}, headers=adm).json()] == ["RT-0003"]
    assert len(c.get("/stock/failed-units", params={"open": True, "plant_id": P2}, headers=adm).json()) == 1
    s = c.get("/stock/summary", headers=adm).json()
    assert (s["failed_open"], s["failed_unsent_overdue"]) == (3, 1)
    s = c.get("/stock/summary", headers=eng).json()
    assert (s["failed_open"], s["failed_unsent_overdue"]) == (2, 1)


def test_startup_relaxes_part_id_on_an_old_sqlite_table(tmp_path):
    """A local SQLite DB from phase 1 has stock_movements.part_id NOT NULL with its indexes: startup
    rebuilds the table (rows and indexes kept) and a second startup changes nothing."""
    from sqlalchemy import inspect as sa_inspect
    from sqlalchemy import text as sa_text

    from app.db.session import Base as B
    from app.db.session import build_engine as be
    from app.db.session import ensure_schema

    eng = be(f"sqlite:///{tmp_path / 'old.db'}")
    B.metadata.create_all(bind=eng)
    with eng.begin() as conn:
        ddl = conn.execute(sa_text("SELECT sql FROM sqlite_master WHERE type='table' AND name='stock_movements'")).scalar_one()
        conn.execute(sa_text("DROP TABLE stock_movements"))
        conn.execute(sa_text(ddl.replace("part_id INTEGER,", "part_id INTEGER NOT NULL,")))
        conn.execute(sa_text("CREATE INDEX ix_stock_movements_batch_id ON stock_movements (batch_id)"))
        conn.execute(sa_text("CREATE INDEX ix_stock_movements_at ON stock_movements (at)"))
        conn.execute(sa_text("INSERT INTO stock_parts (id, code, name, category, serialised, unit, active, created_at, updated_at) VALUES (1, 'P1', 'p', 'other', 1, 'pc', 1, '2026-11-26', '2026-11-26')"))
        conn.execute(sa_text("INSERT INTO stock_movements (batch_id, kind, part_id, qty, at, day) VALUES ('b', 'receive', 1, 1, '2026-11-26', '2026-11-26')"))
    assert not next(c for c in sa_inspect(eng).get_columns("stock_movements") if c["name"] == "part_id")["nullable"]
    for _ in range(2):
        ensure_schema(eng)
        insp = sa_inspect(eng)
        assert next(c for c in insp.get_columns("stock_movements") if c["name"] == "part_id")["nullable"]
        assert {"ix_stock_movements_batch_id", "ix_stock_movements_at"} <= {i["name"] for i in insp.get_indexes("stock_movements")}
        with eng.connect() as conn:
            assert conn.execute(sa_text("SELECT count(*) FROM stock_movements")).scalar_one() == 1
            assert conn.execute(sa_text("PRAGMA foreign_key_check")).all() == []
    with eng.begin() as conn:  # a movement without a part is accepted now
        conn.execute(sa_text("INSERT INTO stock_movements (batch_id, kind, part_id, qty, at, day) VALUES ('c', 'failed_in', NULL, 1, '2026-11-26', '2026-11-26')"))


def test_closed_claim_is_read_only_for_engineers(api):
    """#137: a closed claim is not linked, and ship-out / back-from-supplier do not write on it, unless an admin."""
    t = api
    c, adm, eng, keeper, locs = t["c"], t["adm"], t["eng"], t["keeper"], t["locs"]
    cid = t["claims"][P1]
    fu = _new(t, eng, serial="CC-1", claim_id=cid)
    with t["f"]() as db:
        db.get(Claim, cid).status = "closed"
        db.commit()
    assert "closed" in _new(t, eng, 409, red_tag="RT-0002", serial="CC-2", claim_id=cid)["detail"]["errors"][0]["error"]
    # the claim already linked stays linked through an edit; another closed one cannot be linked
    assert c.patch(f"/stock/failed-units/{fu['id']}", json={"fault": "x", "claim_id": cid}, headers=eng).status_code == 200
    r = _move(t, keeper, fu["id"], 409, kind="ship_out", to_location_id=locs["supplier"])
    assert "CL-2026-001" in r["detail"]["errors"][0]["error"]
    assert _move(t, adm, fu["id"], kind="ship_out", to_location_id=locs["supplier"])["status"] == "sent"
    assert _new(t, adm, red_tag="RT-0003", serial="CC-3", claim_id=cid)["claim_id"] == cid


def test_location_with_failed_units_stays(api):
    """#137: a location holding open failed units cannot be switched off or change kind."""
    t = api
    c, keeper, locs = t["c"], t["keeper"], t["locs"]
    fu = _new(t, t["eng"], serial="LOC-1")
    r = c.patch(f"/stock/locations/{locs['van']}", json={"active": False}, headers=keeper)
    assert r.status_code == 409 and "1 failed units" in r.text
    assert c.patch(f"/stock/locations/{locs['van']}", json={"kind": "store"}, headers=keeper).status_code == 409
    _move(t, keeper, fu["id"], kind="ship_out", to_location_id=locs["supplier"])
    assert c.patch(f"/stock/locations/{locs['supplier']}", json={"active": False}, headers=keeper).status_code == 409
    assert c.patch(f"/stock/locations/{locs['van']}", json={"active": False}, headers=keeper).status_code == 200


def test_serial_is_in_one_place(api):
    """#137: a failed unit's serial must not be a spare in stock, installed on another plant or a hidden one;
    the plant comes from the installed spare before the claim is checked."""
    t = api
    c, adm, eng, keeper = t["c"], t["adm"], t["eng"], t["keeper"]
    pid = t["part"]["id"]

    def batch(h, rows):
        r = c.post("/stock/movements/batch", json={"rows": rows}, headers=h)
        assert r.status_code == 201, r.text

    batch(keeper, [{"kind": "receive", "part_id": pid, "serial": s, "to_location_id": t["locs"]["store"]} for s in ("ONE-P1", "ONE-P2", "ONE-STOCK")])
    batch(adm, [{"kind": "issue", "part_id": pid, "serial": "ONE-P1", "plant_id": P1}, {"kind": "issue", "part_id": pid, "serial": "ONE-P2", "plant_id": P2}])
    assert "in stock" in _new(t, eng, 409, serial="ONE-STOCK")["detail"]["errors"][0]["error"]
    r = _new(t, eng, 409, serial="ONE-P2")["detail"]["errors"][0]["error"]
    assert "another plant" in r and str(P2) not in r
    _new(t, adm, 422, serial="ONE-P2", plant_id=P1)  # installed at P2, not P1
    fu = _new(t, eng, serial="ONE-P1", plant_id=None, claim_id=t["claims"][P1])
    assert (fu["plant_id"], fu["claim_id"]) == (P1, t["claims"][P1])
    with t["f"]() as db:
        assert db.scalars(select(SpareUnit.state).where(SpareUnit.serial_key == "ONE-P2")).one() == "installed"


def test_linked_spare_follows_the_failed_unit(api):
    """#137: a linked spare goes to the supplier with its failed unit, its part is fixed, and a
    replaced failed unit is nowhere afterwards; Spares per model counts the unit at the supplier once."""
    t = api
    c, adm, eng, keeper, locs = t["c"], t["adm"], t["eng"], t["keeper"], t["locs"]
    pid = t["part"]["id"]
    other = c.post("/stock/parts", json={"code": "P-ROUTER-OTHER", "name": "Other router", "category": "router"}, headers=keeper).json()
    r = c.post("/stock/movements/batch", json={"rows": [{"kind": "receive", "part_id": pid, "serial": "LS-1", "to_location_id": locs["store"]}]}, headers=keeper)
    assert r.status_code == 201
    assert c.post("/stock/movements/batch", json={"rows": [{"kind": "issue", "part_id": pid, "serial": "LS-1", "plant_id": P1}]}, headers=eng).status_code == 201
    fu = _new(t, eng, serial="LS-1", plant_id=None)
    assert c.patch(f"/stock/failed-units/{fu['id']}", json={"part_id": other["id"]}, headers=eng).status_code == 409
    assert c.patch(f"/stock/failed-units/{fu['id']}", json={"part_id": pid}, headers=eng).status_code == 200  # unchanged is fine
    _move(t, keeper, fu["id"], kind="ship_out", to_location_id=locs["supplier"])
    with t["f"]() as db:
        assert db.scalars(select(SpareUnit.state).where(SpareUnit.serial_key == "LS-1")).one() == "at_supplier"
    rows = c.get("/stock/installed/models", headers=adm).json()["items"]
    (row,) = [x for x in rows if any(p["id"] == pid for p in x["parts"])]
    assert (row["at_supplier"], row["failed_open"]) == (1, 1)
    d = _move(t, keeper, fu["id"], kind="supplier_return", outcome="replaced", new_serial="LS-NEW", to_location_id=locs["store"])
    assert (d["status"], d["location_id"]) == ("replaced", None)
    with t["f"]() as db:
        assert db.scalars(select(SpareUnit.state).where(SpareUnit.serial_key == "LS-1")).one() == "scrapped"
    # a closed failed unit's part cannot change
    assert c.patch(f"/stock/failed-units/{fu['id']}", json={"part_id": other["id"]}, headers=eng).status_code == 409
    # a scrapped unit sent with a linked spare: the spare is scrapped from at_supplier
    batch = c.post("/stock/movements/batch", json={"rows": [{"kind": "issue", "part_id": pid, "serial": "LS-NEW", "plant_id": P1}]}, headers=eng)
    assert batch.status_code == 201
    fu2 = _new(t, eng, red_tag="RT-0002", serial="LS-NEW", plant_id=None)
    _move(t, keeper, fu2["id"], kind="ship_out", to_location_id=locs["supplier"])
    _move(t, keeper, fu2["id"], kind="scrap")
    with t["f"]() as db:
        assert db.scalars(select(SpareUnit.state).where(SpareUnit.serial_key == "LS-NEW")).one() == "scrapped"
