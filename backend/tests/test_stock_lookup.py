"""Spares phase 4 (docs/plans/spares-failed-units.md §8 step 4): `sp` / `loc` app codes in the scan
resolver, spare units matched by serial, `sp` / `loc` labels and the batch page's `/stock/lookup`."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import sessionmaker

from app.db.models import GrowattPlant, User, UserPlantAssignment
from app.db.seed import ensure_seeded
from app.db.session import Base, build_engine, get_db
from app.main import create_app
from app.services import scan

P1, P2 = 9701, 9702


@pytest.fixture()
def api(tmp_path, monkeypatch):
    monkeypatch.setattr(scan, "limiter", scan.SlidingWindowLimiter())
    engine = build_engine(f"sqlite:///{tmp_path / 'lookup.db'}")
    Base.metadata.create_all(bind=engine)
    f = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)
    with f() as db:
        ensure_seeded(db)
        for pid in (P1, P2):
            db.add(GrowattPlant(plant_id=pid, name=f"Plant {pid}"))
        eng = db.scalars(select(User).where(User.username == "engineer")).one()
        db.add(UserPlantAssignment(user_id=eng.id, plant_id=P1))
        db.commit()
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
    eng = login("engineer", "engineer123")

    store = c.post("/stock/locations", json={"code": "STORE", "name": "Main store", "kind": "store"}, headers=keeper).json()
    bin_ = c.post("/stock/locations", json={"code": "STORE-A-03", "name": "Shelf A3", "kind": "bin", "parent_id": store["id"]}, headers=keeper).json()
    van = c.post("/stock/locations", json={"code": "VAN-1", "name": "Crew 1 van", "kind": "van"}, headers=keeper).json()
    old = c.post("/stock/locations", json={"code": "OLD-BIN", "name": "Old shelf", "kind": "bin", "parent_id": store["id"]}, headers=keeper).json()
    assert c.patch(f"/stock/locations/{old['id']}", json={"active": False}, headers=keeper).status_code == 200
    router = c.post("/stock/parts", json={"code": "P-ROUTER-RUT", "name": "Teltonika RUT241", "category": "router"}, headers=keeper).json()
    logger = c.post("/stock/parts", json={"code": "P-LOGGER", "name": "ShineWiFi-X", "category": "datalogger"}, headers=keeper).json()
    rows = [
        {"kind": "receive", "part_id": router["id"], "serial": "R1", "to_location_id": bin_["id"]},
        {"kind": "receive", "part_id": router["id"], "serial": "R2", "to_location_id": bin_["id"]},
        {"kind": "receive", "part_id": router["id"], "serial": "R3", "to_location_id": bin_["id"]},
        {"kind": "receive", "part_id": logger["id"], "serial": "R1", "to_location_id": van["id"]},  # same serial, another part
    ]
    r = c.post("/stock/movements/batch", json={"rows": rows}, headers=keeper)
    assert r.status_code == 201, r.text
    units = {(m["part_code"], m["serial"]): m["unit_id"] for m in r.json()["movements"]}
    # R2 installed on P1 (the engineer's), R3 on P2 (hidden from the engineer)
    for serial, plant in (("R2", P1), ("R3", P2)):
        r = c.post("/stock/movements/batch", json={"rows": [{"kind": "issue", "part_id": router["id"], "serial": serial, "plant_id": plant}]}, headers=adm)
        assert r.status_code == 201, r.text
    return {"c": c, "adm": adm, "eng": eng, "store": store, "bin": bin_, "van": van, "old": old, "router": router, "logger": logger, "units": units}


def _resolve(t, h, code, status=200):
    r = t["c"].get("/scan/resolve", params={"code": code}, headers=h)
    assert r.status_code == status, r.text
    return r.json()


def _lookup(t, h, code):
    r = t["c"].get("/stock/lookup", params={"code": code}, headers=h)
    assert r.status_code == 200, r.text
    return r.json()


def _labels(t, h, **params):
    r = t["c"].get("/scan/labels", params=params, headers=h)
    assert r.status_code == 200, r.text
    return r.json()


# ------------------------------------------------------------------------------- resolver


def test_resolver_sp_by_unit_id_and_part_code(api):
    t = api
    rid, r1 = t["router"]["id"], t["units"][("P-ROUTER-RUT", "R1")]
    m = _resolve(t, t["eng"], f"sp:{r1}")["matches"]
    assert m == [{
        "kind": "spare_unit", "id": str(r1), "label": "P-ROUTER-RUT · R1", "field": "id",
        "path": f"/inventory?tab=stock&part={rid}&unit={r1}", "plant_id": None, "plant_name": None, "detail": "in stock · STORE-A-03",
    }]
    # installed on the engineer's plant: plant set, detail names the plant
    r2 = t["units"][("P-ROUTER-RUT", "R2")]
    m = _resolve(t, t["eng"], f"/s/sp/{r2}")["matches"][0]
    assert m["plant_id"] == P1 and m["plant_name"] == f"Plant {P1}" and m["detail"] == f"installed · Plant {P1}"
    # part code, case-insensitive (also as a URL)
    body = _resolve(t, t["eng"], "https://example.test/s/sp/p-router-rut")
    assert body["unsupported_kind"] is None
    assert body["matches"] == [{
        "kind": "part", "id": str(rid), "label": "P-ROUTER-RUT · Teltonika RUT241", "field": "code",
        "path": f"/inventory?tab=stock&part={rid}", "plant_id": None, "plant_name": None, "detail": "1 in stock",
    }]
    _resolve(t, t["eng"], "sp:NO-SUCH-PART", 404)
    _resolve(t, t["eng"], "sp:99999", 404)


def test_resolver_loc_by_code(api):
    t = api
    b = t["bin"]
    m = _resolve(t, t["eng"], "loc:store-a-03")["matches"]
    assert m == [{
        "kind": "location", "id": str(b["id"]), "label": "STORE-A-03 · Shelf A3", "field": "code",
        "path": f"/inventory/scan?loc={b['id']}", "plant_id": None, "plant_name": None, "detail": "Bin · 1 unit",
    }]
    # an inactive location still resolves
    assert _resolve(t, t["eng"], "/s/loc/OLD-BIN")["matches"][0]["detail"] == "Bin · 0 units · inactive"
    _resolve(t, t["eng"], "loc:NOWHERE", 404)


def test_resolver_raw_serial_matches_spare_units_and_scoping(api):
    t = api
    # R1 is a unit of two parts: both match, field serial
    m = _resolve(t, t["eng"], "S/N: r1")["matches"]
    assert sorted(x["label"] for x in m) == ["P-LOGGER · R1", "P-ROUTER-RUT · R1"] and {x["field"] for x in m} == {"serial"}
    assert next(x for x in m if x["label"].startswith("P-LOGGER"))["detail"] == "in stock · VAN-1"
    # R3 is installed on P2: hidden from the engineer (resolver 404 for its id, no raw match), seen by the admin
    r3 = t["units"][("P-ROUTER-RUT", "R3")]
    _resolve(t, t["eng"], f"sp:{r3}", 404)
    assert _resolve(t, t["eng"], "R3")["matches"] == []
    assert _resolve(t, t["adm"], f"sp:{r3}")["matches"][0]["plant_id"] == P2
    assert _resolve(t, t["adm"], "R3")["matches"][0]["kind"] == "spare_unit"


# ---------------------------------------------------------------------------------- labels


def test_sp_labels(api):
    t = api
    r1, r2, r3 = (t["units"][("P-ROUTER-RUT", s)] for s in ("R1", "R2", "R3"))
    body = _labels(t, t["eng"], kind="sp", ids=f"{r1},{r2},{r3}")
    assert body["kind"] == "sp"
    # R3 (hidden plant) left out
    assert body["items"] == [
        {"kind": "sp", "key": str(r1), "code": f"sp:{r1}", "path": f"/s/sp/{r1}", "title": "R1", "lines": ["P-ROUTER-RUT", "Teltonika RUT241"]},
        {"kind": "sp", "key": str(r2), "code": f"sp:{r2}", "path": f"/s/sp/{r2}", "title": "R2", "lines": ["P-ROUTER-RUT", "Teltonika RUT241"]},
    ]
    # by part: units in stock only
    assert [i["title"] for i in _labels(t, t["adm"], kind="sp", part_id=t["router"]["id"])["items"]] == ["R1"]
    assert t["c"].get("/scan/labels", params={"kind": "sp"}, headers=t["eng"]).status_code == 422


def test_loc_labels(api):
    t = api
    items = _labels(t, t["eng"], kind="loc")["items"]
    assert [i["title"] for i in items] == ["STORE", "STORE-A-03", "VAN-1"]  # active only
    b = t["bin"]
    assert items[1] == {"kind": "loc", "key": str(b["id"]), "code": "loc:STORE-A-03", "path": "/s/loc/STORE-A-03", "title": "STORE-A-03", "lines": ["Shelf A3", "Bin"]}
    assert items[2]["lines"] == ["Crew 1 van", "Van"]
    by_ids = _labels(t, t["eng"], kind="loc", ids=f"{t['old']['id']},{t['store']['id']}")["items"]
    assert [(i["title"], i["lines"]) for i in by_ids] == [("OLD-BIN", ["Old shelf", "Bin"]), ("STORE", ["Main store", "Store"])]


# ---------------------------------------------------------------------------------- lookup


def test_lookup_app_codes(api):
    t = api
    b = _lookup(t, t["eng"], "loc:store-a-03")
    assert b["kind"] == "location" and b["code"] == "STORE-A-03" and b["location"]["id"] == t["bin"]["id"] and b["location"]["units"] == 1
    assert b["part"] is None and b["units"] == []
    assert _lookup(t, t["eng"], "https://example.test/s/loc/VAN-1")["location"]["code"] == "VAN-1"
    r1 = t["units"][("P-ROUTER-RUT", "R1")]
    b = _lookup(t, t["eng"], f"sp:{r1}")
    assert b["kind"] == "unit" and [u["id"] for u in b["units"]] == [r1] and b["units"][0]["location_code"] == "STORE-A-03"
    b = _lookup(t, t["eng"], "/s/sp/p-logger")
    assert b["kind"] == "part" and b["part"]["id"] == t["logger"]["id"] and b["part"]["on_hand"] == 1
    # hidden / unknown / other kinds: unknown, never 404
    r3 = t["units"][("P-ROUTER-RUT", "R3")]
    assert _lookup(t, t["eng"], f"sp:{r3}") == {"code": str(r3), "kind": "unknown", "location": None, "part": None, "units": []}
    assert _lookup(t, t["adm"], f"sp:{r3}")["kind"] == "unit"
    assert _lookup(t, t["eng"], "sp:99999")["kind"] == "unknown"
    assert _lookup(t, t["eng"], "loc:NOWHERE")["kind"] == "unknown"
    assert _lookup(t, t["eng"], "rt:RT-0001") == {"code": "RT-0001", "kind": "unknown", "location": None, "part": None, "units": []}
    assert _lookup(t, t["eng"], "tool:MT-01")["kind"] == "unknown"


def test_lookup_raw_values_in_order(api):
    t = api
    # a plain location code, then a part code (also after P/N:)
    assert _lookup(t, t["eng"], " store \r\n")["kind"] == "location"
    b = _lookup(t, t["eng"], "p-router-rut")
    assert b["kind"] == "part" and b["code"] == "P-ROUTER-RUT" and b["part"]["on_hand"] == 1
    assert _lookup(t, t["eng"], "P/N:P-LOGGER")["part"]["code"] == "P-LOGGER"
    # a serial: exact across parts, S/N prefix stripped
    b = _lookup(t, t["eng"], "S/N: r1")
    assert b["kind"] == "serial" and b["code"] == "R1" and sorted(u["part_code"] for u in b["units"]) == ["P-LOGGER", "P-ROUTER-RUT"]
    assert _lookup(t, t["eng"], "R")["units"] == []  # exact only
    # installed on the engineer's plant: listed; on a hidden plant: not
    assert [u["state"] for u in _lookup(t, t["eng"], "R2")["units"]] == ["installed"]
    b = _lookup(t, t["eng"], "R3")
    assert b["kind"] == "serial" and b["units"] == []
    assert len(_lookup(t, t["adm"], "R3")["units"]) == 1
    # a new serial: kind serial, no units (the page receives it)
    assert _lookup(t, t["eng"], "NEW-999") == {"code": "NEW-999", "kind": "serial", "location": None, "part": None, "units": []}
    assert _lookup(t, t["eng"], "   ")["kind"] == "unknown"
    assert t["c"].get("/stock/lookup", params={"code": "x" * 513}, headers=t["eng"]).status_code == 422


def test_lookup_not_rate_limited(api, monkeypatch):
    from app.config import settings

    t = api
    monkeypatch.setattr(settings, "scan_resolve_per_min", 1)
    for _ in range(5):
        _lookup(t, t["eng"], "R1")
