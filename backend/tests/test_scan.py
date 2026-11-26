"""Scan resolver (docs/plans/barcode-scanning.md §6, §9): parsing, matching, plant scoping, limits."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import sessionmaker

from app.config import settings
from app.db.models import GrowattInverter, GrowattPlant, Instrument, SiteDevice, SiteRegister, User, UserPlantAssignment
from app.db.seed import ensure_seeded
from app.db.session import Base, build_engine, get_db
from app.main import create_app
from app.services import scan

P1, P2 = 9401, 9402


@pytest.fixture()
def api(tmp_path, monkeypatch):
    monkeypatch.setattr(scan, "limiter", scan.SlidingWindowLimiter())
    engine = build_engine(f"sqlite:///{tmp_path / 'scan.db'}")
    Base.metadata.create_all(bind=engine)
    f = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)
    with f() as db:
        ensure_seeded(db)
        for pid in (P1, P2):
            db.add(GrowattPlant(plant_id=pid, name=f"Plant {pid}"))
        db.flush()
        db.add(GrowattInverter(device_sn="BNE4C1Z00A", plant_id=P1, datalogger_sn="XGD6CHB01B", alias="INVERTER 1", device_model="MAX 80KTL3 LV"))
        db.add(GrowattInverter(device_sn="BNE4C1Z00B", plant_id=P1, datalogger_sn="XGD6CHB01B"))
        db.add(GrowattInverter(device_sn="OTHERPLANT1", plant_id=P2, datalogger_sn="XGDOTHER01"))
        db.add(Instrument(asset_tag="MT-INS-02", name="Insulation tester", category="insulation_tester", serial_no="FL1587-0042", make="Fluke"))
        db.add(SiteRegister(site_code="P1-001", plant_id=P1, name="Site one"))
        db.add(SiteRegister(site_code="P1-002", plant_id=P2, name="Site two"))
        db.add(SiteRegister(site_code="P1-099", plant_id=None, name="Unmatched site"))
        db.flush()
        db.add(SiteDevice(site_code="P1-001", kind="router", seq=1, serial="1102345678", sim="0812345678", brand_model="Teltonika RUT241"))
        db.add(SiteDevice(site_code="P1-002", kind="revenue_meter", seq=2, serial="WP12345"))
        db.add(SiteDevice(site_code="P1-099", kind="router", seq=1, serial="ORPHAN01"))
        eng = db.scalars(select(User).where(User.username == "engineer")).one()
        db.add(UserPlantAssignment(user_id=eng.id, plant_id=P1))
        db.commit()
        ids = {d.serial: d.id for d in db.scalars(select(SiteDevice))}
        tool_id = db.scalars(select(Instrument.id)).one()
    app = create_app()

    def override():
        with f() as db:
            yield db

    app.dependency_overrides[get_db] = override
    client = TestClient(app)

    def hdr(user, pw):
        tok = client.post("/auth/login", json={"username": user, "password": pw}).json()["access_token"]
        return {"Authorization": f"Bearer {tok}"}

    return client, hdr("admin", "admin123"), hdr("engineer", "engineer123"), ids, tool_id


def _resolve(client, h, code, status=200):
    r = client.get("/scan/resolve", params={"code": code}, headers=h)
    assert r.status_code == status, r.text
    return r.json()


# ------------------------------------------------------------------ parsing (pure)


def test_normalise_strips_prefix_controls_and_case():
    assert scan.normalise("  S/N: bne4c1z00a\r\n") == ("BNE4C1Z00A", False)
    assert scan.normalise("SN BNE4C1Z00A") == ("BNE4C1Z00A", False)
    assert scan.normalise("Serial No. 123") == ("123", False)
    assert scan.normalise("P/N:ABC-1") == ("ABC-1", True)
    # O and 0 are never swapped
    assert scan.normalise("O1I0") == ("O1I0", False)
    # a value that is only the prefix word stays as it is
    assert scan.normalise("SN") == ("SN", False)
    # GS kept (GS1 separator)
    assert scan.clean("01\x1d21X") == "01\x1d21X"


def test_parse_app_code_forms():
    assert scan.parse_app_code("https://tcroof.example/s/tool/MT-INS-02") == ("tool", "MT-INS-02")
    assert scan.parse_app_code("/s/rt/RT-0103") == ("rt", "RT-0103")
    assert scan.parse_app_code("s/dev/12/") == ("dev", "12")
    assert scan.parse_app_code("tool:MT-INS-02") == ("tool", "MT-INS-02")
    assert scan.parse_app_code("TOOL:mt-ins-02") == ("tool", "mt-ins-02")
    assert scan.parse_app_code("https://tcroof.example/s/tool/MT%2001") == ("tool", "MT 01")
    # not app codes
    assert scan.parse_app_code("BNE4C1Z00A") is None
    assert scan.parse_app_code("abc:123") is None  # unknown kind
    assert scan.parse_app_code("https://example.com/other/path") is None


# ------------------------------------------------------------------ resolve


def test_instrument_by_tag_serial_and_app_code(api):
    client, adm, eng, _, tool_id = api
    for code in ("mt-ins-02", "tool:MT-INS-02", "https://x.example/s/tool/MT-INS-02"):
        body = _resolve(client, eng, code)
        assert [m["kind"] for m in body["matches"]] == ["instrument"]
        assert body["matches"][0]["path"] == f"/tools?tool={tool_id}"
        assert body["matches"][0]["field"] == "asset_tag"
    body = _resolve(client, eng, "SN: fl1587-0042")
    assert body["matches"][0]["field"] == "serial"
    _resolve(client, eng, "tool:NOPE", 404)


def test_inverter_and_datalogger_scoped(api):
    client, adm, eng, _, _ = api
    body = _resolve(client, eng, "bne4c1z00a")
    (m,) = body["matches"]
    assert m["kind"] == "inverter" and m["plant_id"] == P1 and m["plant_name"] == f"Plant {P1}"
    assert m["path"] == f"/plant/{P1}/inverters?q=BNE4C1Z00A"
    assert m["detail"] == "MAX 80KTL3 LV"
    # one datalogger row per plant, though two inverters share it
    body = _resolve(client, eng, "XGD6CHB01B")
    assert [(m["kind"], m["plant_id"]) for m in body["matches"]] == [("datalogger", P1)]
    # another plant's inverter / datalogger: nothing, not even a hint
    assert _resolve(client, eng, "OTHERPLANT1")["matches"] == []
    assert _resolve(client, eng, "XGDOTHER01")["matches"] == []
    assert len(_resolve(client, adm, "OTHERPLANT1")["matches"]) == 1


def test_site_devices_serial_sim_and_scope(api):
    client, adm, eng, ids, _ = api
    (m,) = _resolve(client, eng, "1102345678")["matches"]
    assert m["kind"] == "site_device" and m["field"] == "serial" and m["path"] == f"/plant/{P1}/documents"
    assert m["label"] == "4G router · P1-001" and m["detail"] == "Teltonika RUT241"
    (m,) = _resolve(client, eng, "0812345678")["matches"]
    assert m["field"] == "sim"
    # other plant / unmatched station: engineer sees nothing, admin sees it
    assert _resolve(client, eng, "wp12345")["matches"] == []
    (m,) = _resolve(client, adm, "wp12345")["matches"]
    assert m["label"] == "Revenue meter 2 · P1-002"
    assert _resolve(client, eng, "ORPHAN01")["matches"] == []
    (m,) = _resolve(client, adm, "ORPHAN01")["matches"]
    assert m["plant_id"] is None and m["path"] == "/settings?tab=register"
    # app code dev:<id>
    assert _resolve(client, eng, f"/s/dev/{ids['1102345678']}")["matches"][0]["kind"] == "site_device"
    _resolve(client, eng, f"dev:{ids['WP12345']}", 404)
    _resolve(client, eng, "dev:abc", 404)
    assert _resolve(client, adm, f"dev:{ids['WP12345']}")["matches"][0]["plant_id"] == P2


def test_unsupported_kind_unknown_and_bad_input(api):
    client, adm, eng, _, _ = api
    body = _resolve(client, eng, "/s/rt/RT-0103")
    assert body["unsupported_kind"] == "rt" and body["matches"] == [] and body["code"] == "RT-0103"
    body = _resolve(client, eng, "NOTHING-HERE")
    assert body["matches"] == [] and body["app_code"] is None
    assert _resolve(client, eng, "P/N:ABC")["part_number"] is True
    _resolve(client, eng, "   \r\n", 422)
    _resolve(client, eng, "x" * 513, 422)


def test_rate_limit(api, monkeypatch):
    client, adm, eng, _, _ = api
    monkeypatch.setattr(settings, "scan_resolve_per_min", 2)
    _resolve(client, eng, "A1")
    _resolve(client, eng, "A2")
    r = client.get("/scan/resolve", params={"code": "A3"}, headers=eng)
    assert r.status_code == 429 and int(r.headers["Retry-After"]) >= 1
    # per user
    _resolve(client, adm, "A3")
