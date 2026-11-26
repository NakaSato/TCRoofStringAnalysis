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
    body = _resolve(client, eng, "/s/df/D-0001")
    assert body["unsupported_kind"] == "df" and body["matches"] == [] and body["code"] == "D-0001"
    _resolve(client, eng, "/s/sp/P-ROUTER-RUT", 404)  # spares have records now: an unknown part code
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


# ------------------------------------------------------------------ did you mean (O/0, I/1)


def test_lookalike_variants():
    assert sorted(scan.lookalike_variants("A0I")) == ["A01", "AO1", "AOI"]
    assert scan.lookalike_variants("ABC") == []
    assert scan.lookalike_variants("0" * 9) == []  # too many positions
    assert len(scan.lookalike_variants("0" * 8)) == 255


def test_did_you_mean_only_when_asked_and_nothing_matches(api):
    client, adm, eng, _, _ = api
    # typed with O for 0 and I for 1: BNE4C1Z00A as BNE4CIZOOA
    r = client.get("/scan/resolve", params={"code": "bne4cizooa", "suggest": True}, headers=eng).json()
    assert r["matches"] == []
    assert [s["code"] for s in r["did_you_mean"]] == ["BNE4C1Z00A"]
    (m,) = r["did_you_mean"][0]["matches"]
    assert m["kind"] == "inverter" and m["plant_name"] == f"Plant {P1}"
    # not asked (a camera read): no suggestions
    assert _resolve(client, eng, "bne4cizooa")["did_you_mean"] == []
    # an exact match: no suggestions
    r = client.get("/scan/resolve", params={"code": "BNE4C1Z00A", "suggest": True}, headers=eng).json()
    assert len(r["matches"]) == 1 and r["did_you_mean"] == []
    # scoped: another plant's inverter is never suggested to the engineer
    r = client.get("/scan/resolve", params={"code": "OTHERPLANTI", "suggest": True}, headers=eng).json()
    assert r["did_you_mean"] == []
    r = client.get("/scan/resolve", params={"code": "OTHERPLANTI", "suggest": True}, headers=adm).json()
    assert [s["code"] for s in r["did_you_mean"]] == ["OTHERPLANT1"]
    # site device SIM: 0812345678 typed as O8I2345678
    r = client.get("/scan/resolve", params={"code": "O8I2345678", "suggest": True}, headers=eng).json()
    assert r["did_you_mean"][0]["matches"][0]["field"] == "sim"


# ------------------------------------------------------------------ field hints


def test_field_hints_first_by_anyone_changes_by_admin(api):
    client, adm, eng, _, _ = api
    body = {"category": "router", "model": "  Teltonika   rut241 ", "field_key": "S/N", "field_index": 0, "field_count": 3}
    r = client.put("/scan/field-hints", json=body, headers=eng)
    assert r.status_code == 200, r.text
    hint = r.json()
    assert hint["model"] == "Teltonika rut241" and hint["field_key"] == "S/N"
    # the same choice again is fine; a different one needs an admin
    assert client.put("/scan/field-hints", json=body, headers=eng).status_code == 200
    other = {**body, "field_key": None, "field_index": 2}
    assert client.put("/scan/field-hints", json=other, headers=eng).status_code == 403
    r = client.put("/scan/field-hints", json={**other, "model": "TELTONIKA RUT241"}, headers=adm)
    assert r.status_code == 200 and r.json()["id"] == hint["id"] and r.json()["field_index"] == 2
    # looked up by category + model, case and spaces ignored
    got = client.get("/scan/field-hints", params={"category": "router", "model": "teltonika rut241"}, headers=eng).json()
    assert [h["id"] for h in got] == [hint["id"]]
    assert client.get("/scan/field-hints", params={"category": "pqm"}, headers=eng).json() == []
    # bad input
    assert client.put("/scan/field-hints", json={**body, "category": "Bad Cat"}, headers=adm).status_code == 422
    assert client.put("/scan/field-hints", json={**body, "field_index": 3}, headers=adm).status_code == 422
    assert client.put("/scan/field-hints", json={**body, "model": "  "}, headers=adm).status_code == 422
    # delete: admin only
    assert client.delete(f"/scan/field-hints/{hint['id']}", headers=eng).status_code == 403
    assert client.delete(f"/scan/field-hints/{hint['id']}", headers=adm).status_code == 204
    assert client.delete(f"/scan/field-hints/{hint['id']}", headers=adm).status_code == 404


# ------------------------------------------------------------------ labels and red tags (step 5)


def test_red_tag_code_parsing():
    from app.services import scan_labels as labels

    assert labels.red_tag_code(7) == "RT-0007" and labels.red_tag_code(12345) == "RT-12345"
    assert labels.parse_red_tag("rt-103") == 103 and labels.parse_red_tag("RT0103") == 103
    assert labels.parse_red_tag("RX-1") is None and labels.parse_red_tag("RT-") is None


def test_reserve_red_tags_batches_and_resolve(api):
    client, adm, eng, _, _ = api
    assert client.post("/scan/labels/redtags", json={"count": 3}, headers=eng).status_code == 403
    assert client.post("/scan/labels/redtags", json={"count": 0}, headers=adm).status_code == 422
    assert client.post("/scan/labels/redtags", json={"count": 501}, headers=adm).status_code == 422
    r = client.post("/scan/labels/redtags", json={"count": 3}, headers=adm).json()
    assert r == {"batch": 1, "first": "RT-0001", "last": "RT-0003", "count": 3}
    r = client.post("/scan/labels/redtags", json={"count": 2}, headers=adm).json()
    assert (r["batch"], r["first"], r["last"]) == (2, "RT-0004", "RT-0005")
    batches = client.get("/scan/labels/redtags", headers=adm).json()
    assert [(b["batch"], b["first"], b["last"], b["count"], b["bound"], b["reserved_by"]) for b in batches] == [
        (2, "RT-0004", "RT-0005", 2, 0, "admin"),
        (1, "RT-0001", "RT-0003", 3, 0, "admin"),
    ]
    assert client.get("/scan/labels/redtags", headers=eng).status_code == 403
    # labels of a batch
    items = client.get("/scan/labels", params={"kind": "rt", "batch": 1}, headers=eng).json()["items"]
    assert [(i["title"], i["code"], i["path"]) for i in items] == [
        ("RT-0001", "rt:RT-0001", "/s/rt/RT-0001"),
        ("RT-0002", "rt:RT-0002", "/s/rt/RT-0002"),
        ("RT-0003", "rt:RT-0003", "/s/rt/RT-0003"),
    ]
    assert client.get("/scan/labels", params={"kind": "rt", "batch": 9}, headers=adm).status_code == 404
    assert client.get("/scan/labels", params={"kind": "rt"}, headers=adm).status_code == 422
    # scanning a reserved tag: known and blank; an unknown number: 404
    body = _resolve(client, eng, "https://x.example/s/rt/RT-0002")
    assert body["unsupported_kind"] == "rt" and body["matches"] == []
    assert body["red_tag"]["code"] == "RT-0002" and body["red_tag"]["status"] == "reserved"
    assert _resolve(client, eng, "rt:rt-2")["red_tag"]["code"] == "RT-0002"
    _resolve(client, eng, "/s/rt/RT-0103", 404)
    assert _resolve(client, eng, "BNE4C1Z00A")["red_tag"] is None


def test_tool_and_device_labels_scoped(api):
    client, adm, eng, ids, tool_id = api
    (t,) = client.get("/scan/labels", params={"kind": "tool"}, headers=eng).json()["items"]
    assert t["code"] == "tool:MT-INS-02" and t["path"] == "/s/tool/MT-INS-02" and t["key"] == str(tool_id)
    assert t["lines"] == ["Insulation tester", "Fluke", "S/N FL1587-0042"]
    # the label's path resolves to the instrument
    assert _resolve(client, eng, "https://x.example" + t["path"])["matches"][0]["kind"] == "instrument"
    # devices of a plant the engineer is assigned to
    items = client.get("/scan/labels", params={"kind": "dev", "plant_id": P1}, headers=eng).json()["items"]
    assert [(i["title"], i["code"]) for i in items] == [("4G router · P1-001", f"dev:{ids['1102345678']}")]
    assert items[0]["lines"] == ["Teltonika RUT241", "S/N 1102345678", f"Plant {P1}"]
    assert _resolve(client, eng, items[0]["path"])["matches"][0]["kind"] == "site_device"
    # another plant / an unmatched station / ids of hidden devices: not revealed
    assert client.get("/scan/labels", params={"kind": "dev", "plant_id": P2}, headers=eng).status_code == 404
    assert client.get("/scan/labels", params={"kind": "dev", "site_code": "P1-099"}, headers=eng).status_code == 404
    assert client.get("/scan/labels", params={"kind": "dev", "ids": str(ids["WP12345"])}, headers=eng).json()["items"] == []
    assert len(client.get("/scan/labels", params={"kind": "dev", "site_code": "P1-099"}, headers=adm).json()["items"]) == 1
    assert client.get("/scan/labels", params={"kind": "dev"}, headers=adm).status_code == 422
    assert client.get("/scan/labels", params={"kind": "dev", "ids": "1,x"}, headers=adm).status_code == 422
    assert client.get("/scan/labels", params={"kind": "nope"}, headers=adm).status_code == 422
