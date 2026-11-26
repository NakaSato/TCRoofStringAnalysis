"""O&M site register (docs/plans/om-asset-network.md): workbook → JSON, matching to Growatt plants, the import,
checks, access by plant assignment and the blocked-plant cleanup."""

from __future__ import annotations

import io
import json
from datetime import datetime

import openpyxl
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import sessionmaker

from app.db.models import (
    GrowattInverter,
    GrowattPlant,
    PwaMeterSite,
    SiteDevice,
    SiteRegister,
    User,
    UserPlantAssignment,
)
from app.db.seed import ensure_seeded
from app.db.session import Base, build_engine, get_db
from app.main import create_app
from app.services import site_register as sr

# plants: A exact logger, B its logger SN is truncated in the sheet, C only its name carries the code,
# D a plant whose logger shares B's prefix but is taken by station P1-004
A, B, C, D = 9301, 9302, 9303, 9304

STATION_HDR = ["รหัส", "สถานี", "ระยะ", "kWp", "เลขมิเตอร์ กฟภ.", "จังหวัด", "SN Data logger", "Firmware logger",
               "จำนวน Revenue meter", "วันตัดรอบบิล", "COD จริง", "อุปกรณ์ที่ยังไม่มี SN"]
COD_HDR = ["รหัส", "สถานี", "สาขา กปภ.", "กันย้อน", "บัญชีผู้ใช้ไฟ", "วิศวกรดูแล", "COD Baseline", "COD จริง"]
LOGGER_HDR = ["รหัส", "สถานี", "ยี่ห้อ / รุ่น", "Serial Number", "Firmware", "สถานะ", "วันเริ่มประกัน (COD)", "วันหมดประกัน", "หมายเหตุ"]
METER_HDR = ["รหัส", "สถานี", "ลำดับ", "ยี่ห้อ / รุ่น", "Serial Number", "IP", "CT ตั้งค่า", "CT หน้างาน", "สถานะ"]
ROUTER_HDR = ["รหัส", "สถานี", "ยี่ห้อ / รุ่น", "Serial Number", "IP (Teltonika)", "Network", "SIM (AIS)", "สถานะ", "หมายเหตุ"]


def _workbook(stations=None) -> bytes:
    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = sr.STATION_SHEET
    ws.append(STATION_HDR)
    for row in stations or [
        ["P1-001", "สถานี A", 1, 100.0, 23063810, "ชลบุรี", "DYDAAAAAA1", "1.0.5.8", 2, "30,31", datetime(2025, 4, 1), 3],
        ["P1-002", "สถานี B", 1, 200.0, "6000548698", "ระยอง", "DYDBBBBB0", "1.0.5.8", 1, "19,20", None, None],
        ["P2-039", "สถานีจ่ายน้ำบางแสน", 2, 50.0, "27668006", "ชลบุรี", "DYDWRONG99", None, 1, None, None, None],
        ["P1-004", "สถานี D", 1, 80.0, "1", "ตราด", "DYDBBBBB09", None, None, None, None, None],
        ["P3-001", "สถานีไม่มีใน Growatt", 3, 10.0, "2", "ตาก", "NOPE000001", None, None, None, None, None],
    ]:
        ws.append(row)
    cod = wb.create_sheet(sr.COD_SHEET)
    cod.append(COD_HDR)
    cod.append(["P1-001", "สถานี A", "กปภ.สาขาชลบุรี", "HV", 20017704622, "ต้า, เปรม", datetime(2027, 3, 25), datetime(2025, 4, 1)])
    lg = wb.create_sheet("อุปกรณ์ - Data logger")
    lg.append(LOGGER_HDR)
    lg.append(["P1-001", "สถานี A", "Growatt", "DYDAAAAAA1", "1.0.5.8", "ใช้งาน", datetime(2025, 4, 1), None, None])
    m = wb.create_sheet("อุปกรณ์ - Revenue meter")
    m.append([None] * 9)  # the sheet's blank first row
    m.append(METER_HDR)
    m.append(["P1-001", "สถานี A", 1, "CEWE Prometer", "WP076110", "10.1.1.2", "250/5", "250", "ใช้งาน"])
    m.append(["P1-001", "สถานี A", 2, "CEWE Prometer", "WP076111", "10.1.1.3", "1600/5A", "2000/5", "ใช้งาน"])
    r = wb.create_sheet("อุปกรณ์ - Router 4G")
    r.append(ROUTER_HDR)
    r.append(["P1-001", "สถานี A", "Teltonika RUT", 6001868862, "10.100.54.254", "10.2.1.0/24", "0653480924", "ใช้งาน", None])
    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()


@pytest.fixture()
def api(tmp_path):
    engine = build_engine(f"sqlite:///{tmp_path / 'reg.db'}")
    Base.metadata.create_all(bind=engine)
    f = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)
    with f() as db:
        ensure_seeded(db)
        db.add_all(
            [
                GrowattPlant(plant_id=A, name="P1_1 สถานี A", phase=1, peak_power_kwp=100.5),
                GrowattPlant(plant_id=B, name="สถานี B", phase=1, peak_power_kwp=150.0),
                GrowattPlant(plant_id=C, name="P2A_39 สถานีจ่ายน้ำบางแสน กปภ.สาขาชลบุรี", phase=2),
                GrowattPlant(plant_id=D, name="สถานี D", phase=1),
                GrowattInverter(device_sn="INV-A", plant_id=A, datalogger_sn="DYDAAAAAA1"),
                GrowattInverter(device_sn="INV-B", plant_id=B, datalogger_sn="DYDBBBBB0X"),
                GrowattInverter(device_sn="INV-C", plant_id=C, datalogger_sn="DYDDF46072"),
                GrowattInverter(device_sn="INV-D", plant_id=D, datalogger_sn="DYDBBBBB09"),
                PwaMeterSite(site_id="P1-001", phase=1, name="สถานี A", kwp=100.0),
            ]
        )
        eng = db.scalars(select(User).where(User.username == "engineer")).one()
        db.add(UserPlantAssignment(user_id=eng.id, plant_id=A))
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


def test_convert_keeps_values_as_written_and_nulls_empty_cells():
    doc = sr.convert_workbook(_workbook(), source_name="reg.xlsx")
    assert doc["format"] == sr.FORMAT and doc["source"] == "reg.xlsx"
    sites = {s["site_code"]: s for s in doc["sites"]}
    a = sites["P1-001"]
    assert a["pea_meter_no"] == "23063810"  # a number cell becomes text, no ".0"
    assert a["pea_account_no"] == "20017704622"
    assert a["cod_actual"] == "2025-04-01" and a["cod_baseline"] == "2027-03-25"
    assert a["export_limit"] == "HV" and a["engineers_text"] == "ต้า, เปรม"
    assert [(d["kind"], d["seq"]) for d in a["devices"]] == [("datalogger", 1), ("revenue_meter", 1), ("revenue_meter", 2), ("router", 1)]
    router = a["devices"][-1]
    assert router["serial"] == "6001868862" and router["sim"] == "0653480924" and router["network"] == "10.2.1.0/24"
    b = sites["P1-002"]
    assert b["cod_actual"] is None and b["missing_sn_count"] is None and b["pwa_branch"] is None
    assert b["logger_sn"] == "DYDBBBBB0"  # no Data logger row: the station sheet's serial, kept as its device
    assert [(d["kind"], d["serial"]) for d in b["devices"]] == [("datalogger", "DYDBBBBB0")]
    assert any("Weather station" in w for w in doc["warnings"])  # missing sheets are reported, not invented
    json.dumps(doc)  # JSON-ready


def test_convert_refuses_a_file_that_is_not_the_register():
    with pytest.raises(sr.RegisterError):
        sr.convert_workbook(b"not a workbook")
    wb = openpyxl.Workbook()
    wb.active.title = "Sheet1"
    buf = io.BytesIO()
    wb.save(buf)
    with pytest.raises(sr.RegisterError, match="missing"):
        sr.convert_workbook(buf.getvalue())


def test_matching_rules_and_checks(api):
    f, *_ = api
    doc = sr.convert_workbook(_workbook())
    with f() as db:
        rep = sr.import_register(db, doc)
    rows = {r["site_code"]: r for r in rep["rows"]}
    assert (rows["P1-001"]["plant_id"], rows["P1-001"]["rule"]) == (A, "logger_sn")
    # exact serial of D first; B's truncated serial is a prefix of B's and D's loggers, D is taken → B
    assert (rows["P1-004"]["plant_id"], rows["P1-004"]["rule"]) == (D, "logger_sn")
    assert (rows["P1-002"]["plant_id"], rows["P1-002"]["rule"], rows["P1-002"]["growatt_logger_sn"]) == (B, "logger_sn_prefix", "DYDBBBBB0X")
    assert (rows["P2-039"]["plant_id"], rows["P2-039"]["rule"]) == (C, "name_code")
    assert rows["P3-001"]["plant_id"] is None and rows["P3-001"]["rule"] is None
    assert rep["matched"] == 4 and rep["applied"] is False

    keys = lambda code: [c["key"] for c in rows[code]["checks"]]
    a_checks = rows["P1-001"]["checks"]
    assert [c for c in a_checks if c["key"] == "ct_differs"] == [{"key": "ct_differs", "text": "Meter 2: CT set 1600/5A, on site 2000/5"}]
    assert "meter_count_differs" not in keys("P1-001")  # 2 listed, 2 in the station sheet
    assert "kwp_differs" not in keys("P1-001")  # 100.5 vs 100: within 1 %
    assert "kwp_differs" in keys("P1-002") and "logger_sn_differs" in keys("P1-002")
    assert keys("P3-001") == ["unmatched"]
    with f() as db:
        assert db.scalar(select(SiteRegister)) is None  # a preview writes nothing


def test_apply_replaces_everything_and_fills_the_pwa_meter_number(api):
    f, *_ = api
    with f() as db:
        out = sr.import_register(db, sr.convert_workbook(_workbook()), apply=True, who="admin")
        assert out["applied"] and out["meter_no_filled"] == 1
        assert db.get(PwaMeterSite, "P1-001").meter_no == "WP076110"
        assert len(list(db.scalars(select(SiteRegister)))) == 5
        assert len(list(db.scalars(select(SiteDevice)))) == 8  # 4 of P1-001 + a logger row for each other station
        a = db.get(SiteRegister, "P1-001")
        assert a.plant_id == A and a.cod_actual.isoformat() == "2025-04-01" and a.imported_by == "admin"

        # a later file without P3-001 removes it; matches made by a rule that no longer fires are kept
        fewer = sr.convert_workbook(_workbook())
        fewer["sites"] = [s for s in fewer["sites"] if s["site_code"] != "P3-001"]
        out = sr.import_register(db, fewer, apply=True)
        assert out["removed"] == ["P3-001"] and db.get(SiteRegister, "P3-001") is None

        # a bad document changes nothing
        broken = json.loads(json.dumps(fewer))
        broken["sites"][0]["devices"].append({"kind": "toaster"})
        with pytest.raises(sr.RegisterError, match="unknown kind"):
            sr.import_register(db, broken, apply=True)
        assert len(list(db.scalars(select(SiteRegister)))) == 4


def test_api_access_import_and_blocked_cleanup(api):
    f, c, admin, eng = api
    files = {"file": ("OM-Asset & Network.xlsx", _workbook(), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")}
    assert c.post("/growatt/site-register/import", files=files, headers=eng).status_code == 403
    dry = c.post("/growatt/site-register/import", files=files, headers=admin)
    assert dry.status_code == 200, dry.text
    assert dry.json()["applied"] is False and dry.json()["matched"] == 4
    doc = json.dumps(sr.convert_workbook(_workbook())).encode()
    out = c.post("/growatt/site-register/import?apply=true", files={"file": ("reg.json", doc, "application/json")}, headers=admin).json()
    assert out["applied"] is True
    assert c.post("/growatt/site-register/import", files={"file": ("x.csv", b"a,b", "text/csv")}, headers=admin).status_code == 422
    assert c.post("/growatt/site-register/import", files={"file": ("x.json", b"{}", "application/json")}, headers=admin).status_code == 422

    got = c.get(f"/growatt/plants/{A}/site-register", headers=eng).json()["register"]
    assert got["site"]["site_code"] == "P1-001" and got["site"]["province"] == "ชลบุรี"
    assert got["growatt"]["logger_sns"] == ["DYDAAAAAA1"]
    assert [d["kind"] for d in got["devices"]] == ["datalogger", "revenue_meter", "revenue_meter", "router"]
    assert c.get(f"/growatt/plants/{B}/site-register", headers=eng).status_code == 404  # not assigned
    assert c.get(f"/growatt/plants/{B}/site-register", headers=admin).json()["register"]["site"]["site_code"] == "P1-002"
    assert [s["site_code"] for s in c.get("/growatt/site-register", headers=eng).json()["sites"]] == ["P1-001"]
    listed = {s["site_code"]: s for s in c.get("/growatt/site-register", headers=admin).json()["sites"]}
    assert len(listed) == 5
    assert listed["P1-001"]["devices"] == {"datalogger": 1, "revenue_meter": 2, "router": 1}
    assert listed["P1-001"]["plant_name"] == "P1_1 สถานี A"
    assert [k["key"] for k in listed["P1-001"]["checks"]] == ["ct_differs"]
    assert [k["key"] for k in listed["P3-001"]["checks"]] == ["unmatched"]
    assert c.get("/growatt/site-register/provinces", headers=eng).json()["provinces"] == {str(A): "ชลบุรี"}

    with f() as db:
        sr.delete_plant_rows(db, [A])
        db.commit()
        assert db.get(SiteRegister, "P1-001") is None
        assert not list(db.scalars(select(SiteDevice).where(SiteDevice.site_code == "P1-001")))


def test_export_round_trips_through_the_import(api):
    f, c, admin, eng = api
    with f() as db:
        original = sr.convert_workbook(_workbook())
        sr.import_register(db, original, apply=True)
    r = c.get("/growatt/site-register/export", headers=admin)
    assert r.status_code == 200 and r.headers["content-type"].startswith("application/vnd.openxmlformats")
    again = sr.convert_workbook(r.content)
    strip = lambda doc: [{k: v for k, v in s.items()} for s in doc["sites"]]
    assert strip(again) == strip(original)  # every value, text and date, comes back as it went in
    router = next(d for d in again["sites"][0]["devices"] if d["kind"] == "router")
    assert router["sim"] == "0653480924"  # leading zero kept

    # engineers export their plants' stations only
    mine = sr.convert_workbook(c.get("/growatt/site-register/export", headers=eng).content)
    assert [s["site_code"] for s in mine["sites"]] == ["P1-001"]


def test_edit_devices_replaces_the_station_list(api):
    f, c, admin, eng = api
    doc = json.dumps(sr.convert_workbook(_workbook())).encode()
    assert c.post("/growatt/site-register/import?apply=true", files={"file": ("reg.json", doc, "application/json")}, headers=admin).json()["applied"]
    url = f"/growatt/plants/{A}/site-register/devices"
    devs = c.get(f"/growatt/plants/{A}/site-register", headers=eng).json()["register"]["devices"]
    devs[0]["brand_model"] = "  Growatt ShineLan-X  "
    devs[0]["warranty_end"] = "31/12/2027"
    devs = [d for d in devs if d["kind"] != "router"] + [{"kind": "pqm", "seq": 1, "serial": "PQ-1", "note": ""}]

    # the assigned engineer may edit; another plant answers 404
    out = c.put(url, json={"devices": devs}, headers=eng)
    assert out.status_code == 200, out.text
    got = out.json()["register"]["devices"]
    assert [d["kind"] for d in got] == ["datalogger", "revenue_meter", "revenue_meter", "pqm"]
    assert got[0]["brand_model"] == "Growatt ShineLan-X" and got[0]["warranty_end"] == "2027-12-31"
    assert got[-1]["serial"] == "PQ-1" and got[-1]["note"] is None
    assert c.put(f"/growatt/plants/{B}/site-register/devices", json={"devices": []}, headers=eng).status_code == 404

    # all or nothing: bad rows change nothing
    for bad in (
        [{"kind": "toaster", "seq": 1}],
        [{"kind": "pqm", "seq": 1}, {"kind": "pqm", "seq": 1}],
        [{"kind": "pqm", "seq": 0}],
        [{"kind": "pqm", "seq": 1, "sim": "x" * 17}],
        [{"kind": "pqm", "seq": 1, "sales_start": "soon"}],
        [{"kind": "pqm", "seq": 1, "colour": "red"}],
    ):
        assert c.put(url, json={"devices": bad}, headers=admin).status_code == 422, bad
    assert len(c.get(f"/growatt/plants/{A}/site-register", headers=admin).json()["register"]["devices"]) == 4


def test_device_ids_survive_edits_and_reimports(api):
    """Printed `dev:<id>` labels and failed units point at a device's id: an edit or a workbook import
    updates devices in place (matched on station, kind and number), so a device that stays keeps its id."""
    f, c, admin, eng = api
    doc = json.dumps(sr.convert_workbook(_workbook())).encode()

    def imp(body: bytes):
        r = c.post("/growatt/site-register/import?apply=true", files={"file": ("reg.json", body, "application/json")}, headers=admin)
        assert r.status_code == 200 and r.json()["applied"], r.text

    imp(doc)
    url = f"/growatt/plants/{A}/site-register"
    before = {(d["kind"], d["seq"]): d["id"] for d in c.get(url, headers=admin).json()["register"]["devices"]}
    assert all(isinstance(i, int) for i in before.values())
    # the editor sends the list back as read (ids included): same ids, a changed value updated in place
    devs = c.get(url, headers=admin).json()["register"]["devices"]
    devs[0]["serial"] = "NEW-SERIAL-1"
    r = c.put(url + "/devices", json={"devices": devs + [{"kind": "pqm", "seq": 1, "serial": "PQ-9"}]}, headers=admin)
    assert r.status_code == 200, r.text
    after = {(d["kind"], d["seq"]): d for d in r.json()["register"]["devices"]}
    assert all(after[k]["id"] == i for k, i in before.items())
    assert after[(devs[0]["kind"], devs[0]["seq"])]["serial"] == "NEW-SERIAL-1"
    pqm_id = after[("pqm", 1)]["id"]
    assert pqm_id not in before.values()
    # a re-import keeps the ids of devices still in the workbook; the one it lacks (the pqm) is removed
    imp(doc)
    again = {(d["kind"], d["seq"]): d["id"] for d in c.get(url, headers=admin).json()["register"]["devices"]}
    assert again == before
    with f() as db:
        assert db.get(SiteDevice, pqm_id) is None
        # a plant that moves to another station is not on two stations at once
        assert len({r.plant_id for r in db.scalars(select(SiteRegister)) if r.plant_id is not None}) == len(
            [r for r in db.scalars(select(SiteRegister)) if r.plant_id is not None]
        )
