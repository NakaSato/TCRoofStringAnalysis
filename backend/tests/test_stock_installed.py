"""Inventory linked to the installed equipment (docs/plans/inventory-installed-base.md): the installed
list, spares per model, catalogue parts from the installed models and where the registry has a serial."""

from __future__ import annotations

from datetime import datetime, timezone

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import func, select
from sqlalchemy.orm import sessionmaker

from app.db.models import GrowattInverter, GrowattMeter, GrowattPlant, Part, SiteDevice, SiteRegister, User, UserPlantAssignment
from app.db.seed import ensure_seeded
from app.db.session import Base, build_engine, get_db
from app.main import create_app
from app.services import stock_installed

P1, P2 = 9801, 9802


@pytest.fixture()
def api(tmp_path):
    engine = build_engine(f"sqlite:///{tmp_path / 'installed.db'}")
    Base.metadata.create_all(bind=engine)
    f = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)
    with f() as db:
        ensure_seeded(db)
        db.add(GrowattPlant(plant_id=P1, name="Alpha plant", phase=1))
        db.add(GrowattPlant(plant_id=P2, name="Beta plant", phase=2))
        db.add(SiteRegister(site_code="P1-001", plant_id=P1, name="Site one"))
        db.add(SiteRegister(site_code="P2-001", plant_id=P2, name="Site two"))
        db.add(SiteRegister(site_code="P9-001", plant_id=None, name="Unmatched station"))
        db.flush()
        db.add_all([
            SiteDevice(site_code="P1-001", kind="datalogger", seq=1, serial="dl-alpha", brand_model="Growatt"),
            SiteDevice(site_code="P1-001", kind="router", seq=1, serial="RTR-A1", brand_model="Teltonika  RUT", ip="10.3.2.254", network="10.3.2.0/24", sim="0653480608", status="OK"),
            SiteDevice(site_code="P1-001", kind="revenue_meter", seq=1, serial="CW-1", brand_model="CEWE Prometer"),
            SiteDevice(site_code="P1-001", kind="revenue_meter", seq=2, serial="CW-2", brand_model="cewe prometer"),
            SiteDevice(site_code="P1-001", kind="pqm", seq=1),
            SiteDevice(site_code="P2-001", kind="router", seq=1, serial="RTR-B1", brand_model="Teltonika RUT"),
            SiteDevice(site_code="P9-001", kind="router", seq=1, serial="RTR-NOPLANT", brand_model="Teltonika RUT"),
        ])
        db.add_all([
            # DL-ALPHA is the register's datalogger (other case); DL-EXTRA is not in the register
            GrowattInverter(device_sn="INVA000001", plant_id=P1, alias="INVERTER 2", device_model="MAX 80KTL3 LV", datalogger_sn="DL-ALPHA", datalogger_model="ShineMaster"),
            GrowattInverter(device_sn="INVA000002", plant_id=P1, alias="INVERTER 10", device_model="MAX 80KTL3 LV", datalogger_sn="DL-EXTRA", datalogger_model="ShineMaster"),
            GrowattInverter(device_sn="INVGONE001", plant_id=P1, device_model="MAX 80KTL3 LV", datalogger_sn="DL-GONE", not_installed_at=datetime.now(timezone.utc)),
            GrowattInverter(device_sn="INVB000001", plant_id=P2, model="MID 40KTL3-X", datalogger_sn="DL-BETA"),
        ])
        db.add(GrowattMeter(datalogger_sn="DL-ALPHA", address=36, plant_id=P1, device_name="CHNT_THREE"))
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
    return {"c": c, "adm": adm, "eng": login("engineer", "engineer123"), "keeper": login("keeper", "keeper12345"), "f": f}


def _installed(t, h, **q):
    r = t["c"].get("/stock/installed", params=q, headers=h)
    assert r.status_code == 200, r.text
    return r.json()


def test_installed_admin_sees_everything_in_order(api):
    t = api
    d = _installed(t, t["adm"])
    keys = [i["key"] for i in d["items"]]
    assert d["meta"] == {"source": "db"}
    assert d["total"] == len(keys) == 13
    # not installed inverter left out, with its datalogger
    assert "inv:INVGONE001" not in keys and not any("DL-GONE" in k for k in keys)
    # order: plant name (no plant last), category, label (natural: INVERTER 2 before INVERTER 10)
    alpha = [i for i in d["items"] if i["plant_id"] == P1]
    assert [i["category"] for i in alpha] == ["inverter", "inverter", "datalogger", "datalogger", "revenue_meter", "revenue_meter", "router", "pqm", "grid_meter"]
    assert [i["label"] for i in alpha[:2]] == ["INVERTER 2", "INVERTER 10"]
    assert d["items"][-1]["serial"] == "RTR-NOPLANT" and d["items"][-1]["plant_id"] is None and d["items"][-1]["path"] == "/settings?tab=register"
    assert d["counts"] == {"inverter": 3, "datalogger": 3, "revenue_meter": 2, "router": 3, "pqm": 1, "grid_meter": 1}

    router = next(i for i in d["items"] if i["serial"] == "RTR-A1")
    assert router["label"] == "4G router" and router["site_code"] == "P1-001" and router["phase"] == 1
    assert (router["ip"], router["network"], router["sim"], router["status"]) == ("10.3.2.254", "10.3.2.0/24", "0653480608", "OK")
    assert router["site_device_id"] is not None and router["inverter_sn"] is None and router["path"] == f"/plant/{P1}/documents"
    assert router["spare_unit_id"] is None and router["failed_open"] is False
    meter2 = next(i for i in d["items"] if i["serial"] == "CW-2")
    assert meter2["label"] == "Revenue meter 2"
    inv = next(i for i in d["items"] if i["key"] == "inv:INVB000001")
    assert inv["model"] == "MID 40KTL3-X" and inv["inverter_sn"] == "INVB000001" and inv["site_code"] == "P2-001" and inv["ip"] is None
    gm = next(i for i in d["items"] if i["source"] == "grid_meter")
    assert gm == {**gm, "key": "gm:DL-ALPHA:36", "label": "Grid meter · addr 36", "serial": None, "model": "CHNT_THREE", "category": "grid_meter"}
    pqm = next(i for i in d["items"] if i["category"] == "pqm")
    assert pqm["serial"] is None and pqm["model"] is None


def test_datalogger_dedup_register_wins(api):
    d = _installed(api, api["adm"], category="datalogger")
    by_key = {i["key"]: i for i in d["items"]}
    # DL-ALPHA: the register's (case-insensitive match), not Growatt's; DL-EXTRA and DL-BETA from Growatt
    assert sorted(i["source"] for i in d["items"]) == ["datalogger", "datalogger", "site_device"]
    assert f"dl:DL-EXTRA:{P1}" in by_key and f"dl:DL-BETA:{P2}" in by_key and f"dl:DL-ALPHA:{P1}" not in by_key
    assert by_key[f"dl:DL-EXTRA:{P1}"]["model"] == "ShineMaster" and by_key[f"dl:DL-EXTRA:{P1}"]["label"] == "Data logger"
    assert by_key[f"dl:DL-BETA:{P2}"]["model"] is None


def test_engineer_scope(api):
    d = _installed(api, api["eng"])
    assert {i["plant_id"] for i in d["items"]} == {P1}
    assert d["total"] == 9
    assert not any(i["serial"] in ("RTR-NOPLANT", "RTR-B1") for i in d["items"])


def test_filters_q_and_counts(api):
    t = api
    d = _installed(t, t["adm"], q="10.3.2")
    assert [i["serial"] for i in d["items"]] == ["RTR-A1"]
    assert _installed(t, t["adm"], q="0653480608")["total"] == 1
    assert _installed(t, t["adm"], q="beta")["total"] == 3  # plant name
    assert _installed(t, t["adm"], q="p1-001")["total"] == 9  # site code
    assert _installed(t, t["adm"], q="prometer")["counts"] == {"revenue_meter": 2}
    d = _installed(t, t["adm"], phase=2)
    assert d["total"] == 3 and d["counts"] == {"inverter": 1, "datalogger": 1, "router": 1}
    # category narrows total, the chips' counts keep every category of the scope
    d = _installed(t, t["adm"], plant_id=P1, category="router")
    assert d["total"] == 1 and d["counts"]["inverter"] == 2 and d["counts"]["router"] == 1
    d = _installed(t, t["adm"], limit=2, offset=1)
    assert d["total"] == 13 and len(d["items"]) == 2


def test_spare_and_failed_marks(api):
    t = api
    from app.db.models import FailedUnit, RedTag, SpareUnit

    with t["f"]() as db:
        p = Part(code="P-ROUTER-RUT", name="Teltonika RUT", category="router", model="RUT", make="Teltonika")
        db.add(p)
        db.flush()
        u = SpareUnit(part_id=p.id, serial="rtr-a1", serial_key="RTR-A1", state="installed", plant_id=P1)
        tag = RedTag(number=9001, code="RT-9001", batch="T", status="bound")
        db.add_all([u, tag])
        db.flush()
        db.add(FailedUnit(red_tag_id=tag.id, part_id=p.id, serial="CW-1", serial_key="CW-1", plant_id=P1, removed_day=datetime.now(timezone.utc).date(), fault="dead", status="tagged"))
        db.commit()
        uid, pid = u.id, p.id
    d = _installed(t, t["adm"], plant_id=P1)
    by_serial = {i["serial"]: i for i in d["items"]}
    assert by_serial["RTR-A1"]["spare_unit_id"] == uid
    # #143: the part too, so the Stock tab can open the unit (/inventory?tab=stock&part=&unit=)
    assert by_serial["RTR-A1"]["spare_part_id"] == pid
    assert by_serial["CW-2"]["spare_unit_id"] is None and by_serial["CW-2"]["spare_part_id"] is None
    gm = next(i for i in d["items"] if i["source"] == "grid_meter")
    assert gm["spare_unit_id"] is None and gm["spare_part_id"] is None
    assert by_serial["CW-1"]["failed_open"] is True and by_serial["CW-2"]["failed_open"] is False


def test_models_rows_and_part_matching(api):
    t = api
    with t["f"]() as db:
        db.add_all([
            Part(code="P-METER-PROM", name="CEWE Prometer", category="revenue_meter", make="CEWE", model="Prometer", min_qty=2),  # make + model
            Part(code="P-ROUTER-RUT", name="Teltonika RUT", category="router", model="teltonika rut"),  # model key
            Part(code="P-ROUTER-RUT-X", name="RUT on the wrong category", category="pqm", model="Teltonika RUT"),
            Part(code="P-MODULE-550", name="Module 550 W", category="module", model="JA 550"),
        ])
        db.commit()
    r = t["c"].get("/stock/installed/models", headers=t["adm"])
    assert r.status_code == 200, r.text
    rows = {(i["category"], i["model_key"]): i for i in r.json()["items"]}
    meter = rows[("revenue_meter", "CEWE PROMETER")]
    assert meter["installed"] == 2 and meter["installed_by_phase"] == {"1": 2} and [p["code"] for p in meter["parts"]] == ["P-METER-PROM"]
    assert meter["parts"][0]["min_qty"] == 2
    router = rows[("router", "TELTONIKA RUT")]
    assert router["installed"] == 3 and router["installed_by_phase"] == {"1": 1, "2": 1, "none": 1}
    assert [p["code"] for p in router["parts"]] == ["P-ROUTER-RUT"]
    # a model not recorded is its own row; a part matching nothing installed gets one (installed 0)
    assert rows[("pqm", None)]["installed"] == 1 and rows[("pqm", None)]["model"] is None and rows[("pqm", None)]["parts"] == []
    assert rows[("pqm", "TELTONIKA RUT")]["installed"] == 0 and [p["code"] for p in rows[("pqm", "TELTONIKA RUT")]["parts"]] == ["P-ROUTER-RUT-X"]
    assert rows[("module", "JA 550")]["installed"] == 0
    assert rows[("inverter", "MAX 80KTL3 LV")]["installed"] == 2  # the not installed one left out
    # engineer: only their plant's installed devices
    rows = {(i["category"], i["model_key"]): i for i in t["c"].get("/stock/installed/models", headers=t["eng"]).json()["items"]}
    assert rows[("router", "TELTONIKA RUT")]["installed"] == 1 and ("inverter", "MID 40KTL3-X") not in rows


def test_models_spare_counts(api):
    t = api
    from app.db.models import FailedUnit, RedTag, SpareUnit

    with t["f"]() as db:
        p = Part(code="P-ROUTER-RUT", name="Teltonika RUT", category="router", make="Teltonika", model="RUT")
        db.add(p)
        db.flush()
        db.add_all([SpareUnit(part_id=p.id, serial=f"S{i}", serial_key=f"S{i}", state="in_stock") for i in range(3)])
        tags = [RedTag(number=9000 + i, code=f"RT-90{i}", batch="T", status="bound") for i in range(3)]
        db.add_all(tags)
        db.flush()
        today = datetime.now(timezone.utc).date()
        for tag, status, pid in ((tags[0], "tagged", P1), (tags[1], "sent", P1), (tags[2], "in_store", P2)):
            db.add(FailedUnit(red_tag_id=tag.id, part_id=p.id, serial=tag.code, serial_key=tag.code, plant_id=pid, removed_day=today, fault="x", status=status))
        db.commit()
    row = next(i for i in t["c"].get("/stock/installed/models", headers=t["adm"]).json()["items"] if i["category"] == "router")
    assert (row["in_stock"], row["failed_open"], row["at_supplier"]) == (3, 3, 1)
    row = next(i for i in t["c"].get("/stock/installed/models", headers=t["eng"]).json()["items"] if i["category"] == "router")
    assert (row["in_stock"], row["failed_open"], row["at_supplier"]) == (3, 2, 1)  # P2's failed unit hidden


def test_proposals(api):
    t = api
    c = t["c"]
    assert c.post("/stock/parts/from-models", json={"apply": False}, headers=t["eng"]).status_code == 403
    # an existing part takes the code a proposal would get, another matches the router model
    with t["f"]() as db:
        db.add(Part(code="P-REVENUE-METER-PROMETER", name="Something else", category="other"))
        db.add(Part(code="P-RTR", name="Teltonika RUT", category="router", make="Teltonika", model="RUT"))
        db.commit()
        rtr_id = db.scalar(select(Part.id).where(Part.code == "P-RTR"))
    r = c.post("/stock/parts/from-models", json={"apply": False}, headers=t["adm"])
    assert r.status_code == 200, r.text
    props = {(p["category"], p["model"]): p for p in r.json()["proposals"]}
    inv = props[("inverter", "MAX 80KTL3 LV")]
    assert inv == {"category": "inverter", "model": "MAX 80KTL3 LV", "make": "Growatt", "code": "P-INVERTER-MAX-80KTL3-LV", "name": "Growatt MAX 80KTL3 LV", "installed": 2, "part_id": None, "model_key": "MAX 80KTL3 LV"}
    meter = props[("revenue_meter", "Prometer")]
    assert meter["make"] == "CEWE" and meter["name"] == "CEWE Prometer" and meter["code"] == "P-REVENUE-METER-PROMETER-2" and meter["installed"] == 2
    assert props[("grid_meter", "CHNT_THREE")]["code"] == "P-GRID-METER-CHNT-THREE" and props[("grid_meter", "CHNT_THREE")]["make"] == "Chint"
    assert props[("datalogger", "ShineMaster")]["installed"] == 1 and props[("datalogger", "Growatt")]["name"] == "Growatt"
    router = props[("router", "RUT")]
    assert router["part_id"] == rtr_id and router["code"] == "P-RTR" and router["installed"] == 3
    # no proposal for a model not recorded
    assert not any(p["category"] == "pqm" for p in r.json()["proposals"])
    # the keeper (scoped to P1) proposes from their plant only
    props = {(p["category"], p["model"]) for p in c.post("/stock/parts/from-models", json={"apply": False}, headers=t["keeper"]).json()["proposals"]}
    assert ("inverter", "MID 40KTL3-X") not in props and ("inverter", "MAX 80KTL3 LV") in props


def test_proposal_helpers():
    assert stock_installed._split_make("router", "Teltonika RUT") == ("Teltonika", "RUT")
    assert stock_installed._split_make("router", "RUT241") == (None, "RUT241")
    assert stock_installed._split_make("weather_station", "Growatt Weather Station") == ("Growatt", "Weather Station")
    assert stock_installed._code_base("weather_station", "Weather Station") == "P-WEATHER-STATION-WEATHER-STATION"
    long = stock_installed._code_base("inverter", "X" * 60)
    assert len(long) == 40
    assert stock_installed._free_code(long, {long}) == long[:38] + "-2"
    assert stock_installed.model_key("  cewe   Prometer ") == "CEWE PROMETER" and stock_installed.model_key(" ") is None


def test_apply_all_or_nothing(api):
    t = api
    c = t["c"]
    items = [
        {"category": "router", "model": "RUT", "make": "Teltonika", "code": "P-ROUTER-RUT", "name": "Teltonika RUT"},
        {"category": "revenue_meter", "model": "Prometer", "make": "CEWE", "code": "P-REVENUE-METER-PROMETER", "name": "CEWE Prometer"},
    ]
    r = c.post("/stock/parts/from-models", json={"apply": True, "items": items}, headers=t["eng"])
    assert r.status_code == 403
    bad = items + [
        {"category": "nope", "model": "X", "code": "P-X", "name": "X"},
        {"category": "router", "model": "RUT", "code": "P-ROUTER-RUT", "name": "Twice"},
        {"category": "router", "model": "RUT", "code": "bad code!", "name": "Bad"},
    ]
    r = c.post("/stock/parts/from-models", json={"apply": True, "items": bad}, headers=t["keeper"])
    assert r.status_code == 409, r.text
    detail = r.json()["detail"]
    assert detail["message"] and [e["row"] for e in detail["errors"]] == [2, 3, 4]
    with t["f"]() as db:
        assert db.scalar(select(func.count()).select_from(Part)) == 0
    r = c.post("/stock/parts/from-models", json={"apply": True, "items": items}, headers=t["keeper"])
    assert r.status_code == 200, r.text
    created = r.json()["created"]
    assert [p["code"] for p in created] == ["P-ROUTER-RUT", "P-REVENUE-METER-PROMETER"]
    assert created[0]["make"] == "Teltonika" and created[0]["model"] == "RUT" and created[0]["category"] == "router"
    # applied again: the codes are taken now
    r = c.post("/stock/parts/from-models", json={"apply": True, "items": items}, headers=t["keeper"])
    assert r.status_code == 409 and [e["row"] for e in r.json()["detail"]["errors"]] == [0, 1]
    # the preview now points at the created parts
    props = {(p["category"], p["model"]): p for p in c.post("/stock/parts/from-models", json={"apply": False}, headers=t["adm"]).json()["proposals"]}
    assert props[("router", "RUT")]["part_id"] == created[0]["id"] and props[("revenue_meter", "Prometer")]["part_id"] == created[1]["id"]
    assert c.post("/stock/parts/from-models", json={"apply": True, "items": []}, headers=t["keeper"]).status_code == 422


def test_registry_where(api):
    t = api
    c = t["c"]

    def where(h, serials):
        r = c.get("/stock/registry-where", params={"serials": serials}, headers=h)
        assert r.status_code == 200, r.text
        return r.json()["items"]

    d = where(t["adm"], " inva000001 ,RTR-B1,dl-extra,DL-ALPHA,INVGONE001,RTR-NOPLANT,unknown,,")
    assert sorted(d) == ["DL-ALPHA", "DL-EXTRA", "INVA000001", "RTR-B1", "RTR-NOPLANT"]  # not installed: no hit
    assert d["INVA000001"] == [{"source": "inverter", "category": "inverter", "label": "INVERTER 2", "plant_id": P1, "plant_name": "Alpha plant",
                                "site_code": "P1-001", "ip": None, "network": None, "sim": None, "path": f"/plant/{P1}/inverters?sn=INVA000001"}]
    assert [h["source"] for h in d["DL-ALPHA"]] == ["site_device"]  # the register's, deduped
    assert d["DL-EXTRA"][0]["source"] == "datalogger" and d["DL-EXTRA"][0]["path"] == "/devices?tab=dataloggers&dq=DL-EXTRA"
    assert d["RTR-NOPLANT"][0]["plant_id"] is None
    e = where(t["eng"], "INVA000001,RTR-B1,RTR-NOPLANT,DL-BETA,RTR-A1")
    assert sorted(e) == ["INVA000001", "RTR-A1"]
    assert e["RTR-A1"][0]["ip"] == "10.3.2.254" and e["RTR-A1"][0]["sim"] == "0653480608" and e["RTR-A1"][0]["label"] == "4G router"
    assert where(t["adm"], "") == {}
    assert c.get("/stock/registry-where", params={"serials": ",".join(f"S{i}" for i in range(201))}, headers=t["adm"]).status_code == 422
    assert c.get("/stock/registry-where", params={"serials": "X" * 65}, headers=t["adm"]).status_code == 422
    # 200 distinct (repeats counted once) is fine
    assert c.get("/stock/registry-where", params={"serials": ",".join(f"S{i}" for i in range(200)) + ",s0"}, headers=t["adm"]).status_code == 200


def test_proposals_carry_installed_model_key(api):
    """#143: "Add to catalogue" on a Spares per model row filters the proposals by (category, model key);
    a split-make proposal's `model` no longer matches the row's model, its `model_key` does."""
    t = api
    rows = t["c"].get("/stock/installed/models", headers=t["adm"]).json()["items"]
    props = t["c"].post("/stock/parts/from-models", json={"apply": False}, headers=t["keeper"]).json()["proposals"]
    by_key = {(p["category"], p["model_key"]): p for p in props}
    for cat, key, model in (("router", "TELTONIKA RUT", "RUT"), ("revenue_meter", "CEWE PROMETER", "Prometer")):
        row = next(r for r in rows if r["category"] == cat and r["model_key"] == key)
        p = by_key[(row["category"], row["model_key"])]
        assert p["model"] == model and stock_installed.model_key(p["model"]) != row["model_key"]
    # Growatt Weather Station: make Growatt split off, key still the installed one
    with t["f"]() as db:
        db.add(SiteDevice(site_code="P1-001", kind="weather_station", seq=1, serial="WS-1", brand_model="Growatt Weather Station"))
        db.commit()
    props = t["c"].post("/stock/parts/from-models", json={"apply": False}, headers=t["keeper"]).json()["proposals"]
    ws = next(p for p in props if p["category"] == "weather_station")
    assert (ws["make"], ws["model"], ws["model_key"]) == ("Growatt", "Weather Station", "GROWATT WEATHER STATION")
    # a proposal for an existing part keeps the installed key too
    with t["f"]() as db:
        db.add(Part(code="P-RTR", name="Teltonika RUT", category="router", make="Teltonika", model="RUT"))
        db.commit()
    props = t["c"].post("/stock/parts/from-models", json={"apply": False}, headers=t["keeper"]).json()["proposals"]
    rtr = next(p for p in props if p["category"] == "router")
    assert rtr["part_id"] is not None and rtr["model_key"] == "TELTONIKA RUT"
    assert all(p["model_key"] for p in props)


def test_models_parts_carry_active(api):
    """#143: "Thin" sums the minimum of active parts only (as `below_min`), so each part says whether it is."""
    t = api
    with t["f"]() as db:
        db.add_all([
            Part(code="P-RTR-ON", name="RUT", category="router", make="Teltonika", model="RUT", min_qty=1),
            Part(code="P-RTR-OFF", name="RUT old", category="router", model="Teltonika RUT", min_qty=5, active=False),
        ])
        db.commit()
    row = next(i for i in t["c"].get("/stock/installed/models", headers=t["adm"]).json()["items"] if i["category"] == "router" and i["model_key"] == "TELTONIKA RUT")
    parts = {p["code"]: p for p in row["parts"]}
    assert parts["P-RTR-ON"]["active"] is True and parts["P-RTR-OFF"]["active"] is False
    assert sum(p["min_qty"] for p in row["parts"] if p["active"] and p["min_qty"] is not None) == 1
    # the catalogue agrees: the inactive part is never below its minimum
    listed = {p["code"]: p for p in t["c"].get("/stock/parts", params={"include_inactive": True}, headers=t["adm"]).json()}
    assert listed["P-RTR-OFF"]["below_min"] is False
