"""Serial shape warnings per device type (docs/plans/barcode-scanning.md §6.3)."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import sessionmaker

from app.db.models import GrowattInverter, GrowattPlant, Instrument, Part, SiteDevice, SiteRegister, SpareUnit
from app.db.seed import ensure_seeded
from app.db.session import Base, build_engine, get_db
from app.main import create_app
from app.services import scan_serials as ss


@pytest.fixture()
def api(tmp_path):
    ss.clear_cache()
    engine = build_engine(f"sqlite:///{tmp_path / 'serials.db'}")
    Base.metadata.create_all(bind=engine)
    f = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)
    with f() as db:
        ensure_seeded(db)
        db.add(GrowattPlant(plant_id=9501, name="Plant"))
        for i in range(6):
            db.add(SiteRegister(site_code=f"P1-00{i}", plant_id=None, name=f"Site {i}"))
        db.flush()
        for i in range(6):
            db.add(SiteDevice(site_code=f"P1-00{i}", kind="revenue_meter", seq=1, serial=f"WP07611{i}", brand_model="CEWE Prometer"))
            db.add(SiteDevice(site_code=f"P1-00{i}", kind="router", seq=1, serial=f"600175832{i}", sim=f"065348092{i}", brand_model="Teltonika RUT"))
            db.add(GrowattInverter(device_sn=f"CWQFG4V00{i}", plant_id=9501, datalogger_sn=f"DYD1E7R00{i}", device_model="MAX 125KTL3-X LV", datalogger_model="ShineMaster"))
        # a second model with only 2 serials: too few on its own, so the category is used
        db.add(GrowattInverter(device_sn="EXJ0DA705R", plant_id=9501, device_model="MID 40KTL3-X"))
        db.add(GrowattInverter(device_sn="EXJ0DA706R", plant_id=9501, device_model="MID 40KTL3-X"))
        for i in range(3):
            db.add(Instrument(asset_tag=f"MT-{i}", name="Clamp", category="clamp_meter", serial_no=f"FL{i}"))
        p = Part(code="P-PQM", name="PQM", category="pqm", make="Acme", model="Q1")
        db.add(p)
        db.flush()
        for i in range(5):
            db.add(SpareUnit(part_id=p.id, serial=f"Q-{i}00", serial_key=f"Q-{i}00", state="in_stock"))
        db.commit()
    app = create_app()

    def override():
        with f() as db:
            yield db

    app.dependency_overrides[get_db] = override
    client = TestClient(app)
    tok = client.post("/auth/login", json={"username": "engineer", "password": "engineer123"}).json()["access_token"]
    yield client, {"Authorization": f"Bearer {tok}"}
    ss.clear_cache()


def _check(client, h, **params):
    r = client.get("/scan/serial-check", params=params, headers=h)
    assert r.status_code == 200, r.text
    return r.json()


def _codes(out):
    return [w["code"] for w in out["warnings"]]


def test_luhn_imei_iccid():
    assert ss.luhn_ok("79927398713")
    assert not ss.luhn_ok("79927398710")
    assert ss.looks_like_imei("490154203237518")
    assert not ss.looks_like_imei("490154203237517")
    assert ss.looks_like_iccid("8966012345678901236") == ss.luhn_ok("8966012345678901236")


def test_learn_shape():
    assert ss.learn(["A1", "A2"]) is None  # too few
    shape = ss.learn([f"WP07611{i}" for i in range(6)])
    assert shape == {"count": 6, "min_len": 8, "max_len": 8, "charset": "alnum", "prefix": "WP"}
    # a digits-only prefix is not an expectation (serial ranges move on)
    assert ss.learn([f"600175832{i}" for i in range(6)])["prefix"] is None
    assert ss.learn([f"600175832{i}" for i in range(6)])["charset"] == "digits"


def test_meter_prefix_and_length(api):
    client, h = api
    ok = _check(client, h, category="revenue_meter", model="CEWE Prometer", serial="wp076120")
    assert ok["warnings"] == [] and ok["basis"] == "model" and ok["serial"] == "WP076120"
    bad = _check(client, h, category="revenue_meter", serial="076120")
    assert _codes(bad) == ["length", "prefix"]
    assert bad["warnings"][0] == {"code": "length", "min": 8, "max": 8, "got": 6}
    assert bad["basis"] == "category"


def test_router_imei_and_digits(api):
    client, h = api
    out = _check(client, h, category="router", model="Teltonika RUT", serial="490154203237518")
    assert _codes(out) == ["imei", "length"]
    assert _codes(_check(client, h, category="router", serial="60017583X9")) == ["digits"]
    # the SIM field learns from the SIM numbers, and an IMEI there is not flagged as one
    assert _check(client, h, category="router:sim", serial="0653480929")["warnings"] == []


def test_inverter_model_scope_falls_back_to_category(api):
    client, h = api
    out = _check(client, h, category="inverter", model="MID 40KTL3-X", serial="EXJ0DA70")
    assert out["basis"] == "category" and _codes(out) == ["length"]
    assert _check(client, h, category="inverter", model="MAX 125KTL3-X LV", serial="CWQFG4V009")["warnings"] == []
    assert _codes(_check(client, h, category="inverter", serial="CWQFG4V-09")) == ["alnum"]


def test_datalogger_tool_and_spare_sources(api):
    client, h = api
    assert _check(client, h, category="datalogger", serial="DYD1E7R00Z")["expected"]["prefix"] == "DYD"
    # 3 instruments: too few to expect anything
    tool = _check(client, h, category="tool:clamp_meter", serial="anything at all")
    assert tool["expected"] is None and tool["warnings"] == [] and tool["basis"] is None
    # spare units teach their part's category; '-' is allowed when the known ones have it
    pqm = _check(client, h, category="pqm", model="Acme Q1", serial="Q-900")
    assert pqm["basis"] == "model" and pqm["warnings"] == []


def test_unknown_category_and_empty_serial(api):
    client, h = api
    assert _check(client, h, category="nothing", serial="ABC")["warnings"] == []
    assert _check(client, h, category="router", serial="  ")["warnings"] == []
    r = client.get("/scan/serial-check", params={"category": "router"}, headers=h)
    assert r.status_code == 422
