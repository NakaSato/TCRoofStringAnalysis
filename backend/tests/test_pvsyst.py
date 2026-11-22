"""PVsyst design data (services/pvsyst.py): workbook reader, import, scoping, D1 meter join."""

from __future__ import annotations

import io
from datetime import date

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import func, select
from sqlalchemy.orm import sessionmaker

from app.db.models import GrowattPlant, PvsystPhase, PvsystStation, User, UserPlantAssignment
from app.db.seed import ensure_seeded
from app.db.session import Base, build_engine, get_db
from app.main import create_app
from app.services import pvsyst as svc
from app.services import pwa_meter

P1, P2 = 9301, 9302
MONTHS = list(svc.MONTHS_TH)
HDR = ["ลำดับ", "โปรเจกต์", "สถานที่", "กปภ.สาขา", "Lat", "Long", "Tilt/Azimuth", "แผง (แผ่น)", "kWp", "kWac", "PR", *MONTHS,
       "รวม MWh/ปี", "ตามรายงาน", "kWh/kWp/ปี", "รวมรายเดือน − รายงาน", "Wp/แผ่น", "kWp ในแบบจำลอง", "kWp PVsyst − แบบจำลอง", "ไฟล์รายงาน", "หมายเหตุการอ่านค่า"]

# (seq, name, tilt/azimuth text, kWp, kWac, PR, monthly MWh, model kWp, note)
STATIONS = {
    1: [(1, "สถานีเอ", "15/0°", 100.0, 80.0, 0.84, [12.4] * 12, 100.0, None),
        (2, "สถานีบี", "15/-10° Tilt/Azimuth 15/170 °", 50.0, 50.0, 0.82, [6.0] * 12, 250.0, "รายงานบางส่วน"),
        (3, "สถานีซี", "710° Tilt/Azimuth 15/90 °", 40.0, 40.0, 0.80, [4.5] * 11 + [None], 40.0, None)],
    2: [(1, "สถานีดี", "15 / -90 °", 120.0, 100.0, 0.87, [15.0] * 12, None, None),
        (2, "สถานีอี", "13/147 °", 60.0, 60.0, 0.86, [7.5] * 12, None, None)],
    3: [(1, "สถานีเอฟ", "15/0°", 80.0, 80.0, 0.87, [10.0] * 12, 80.0, None)],
    4: [(1, "สถานีจี", "30/0°", 90.0, 75.0, 0.88, [11.0] * 12, 90.0, None)],
}
CONTRACT = {1: [1100.0 * 100, 1000.0 * 250, 1000.0 * 40], 2: [1400.0 * 120, 1400.0 * 60], 3: [1450.0 * 80], 4: [1450.0 * 90]}


def _station_row(phase, s):
    seq, name, ta, kwp, kwac, pr, months, kwp_model, note = s
    year = sum(v or 0 for v in months)
    # data columns: like the model, one blank column after `รวมรายเดือน − รายงาน`, so the trailing
    # fields sit one column right of their header
    return [None, seq, None, name, "สาขา", 14.0, 100.0, ta, int(kwp * 1000 / 570), kwp, kwac, pr, *months,
            year, year, year * 1000 / kwp, 0, None, 570, kwp_model, None, f"{seq} report", note]


def _workbook(drop_sheet: str | None = None) -> bytes:
    import openpyxl

    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = "PVsyst_สรุป"
    ws.append(["สรุปรายงาน PVsyst"])
    ws.append([])
    ws.append([None, "ก. ภาพรวมต่อระยะ"])
    ws.append([None, "ระยะ", "สถานีในแบบจำลอง", "รายงาน PVsyst", "kWp PVsyst", "kWp แบบจำลอง", "kWp ต่าง", "MWh/ปี PVsyst", "kWh/kWp/ปี PVsyst",
               "PR (ถ่วงน้ำหนัก)", "kWh/kWp/ปี สัญญาปีแรก", "สัญญา ÷ PVsyst", "หน่วยไฟสัญญาปีแรก (kWh)"])
    ws.append([None, "ระยะ 1", 3, 3, 190.0, 390.0, -200.0, 249.6, 1313.7, 0.83, 1000.0, 1.5625, 390000.0])
    ws.append([None, "ระยะ 2", 2, 2, 180.0, 180.0, 0, 270.0, 1500.0, 0.8667, 1400.0, 0.9333, 252000.0])
    ws.append([None, "ระยะ 3", 1, 1, 80.0, 80.0, 0, 120.0, 1500.0, 0.87, 1450.0, 0.9667, 116000.0])
    ws.append([None, "ระยะ 4", 1, 1, 90.0, 90.0, 0, 132.0, 1466.7, 0.88, 1450.0, 0.9886, 130500.0])
    ws.append([None, "รวม", 7, 7, 540.0, 740.0, -200.0, 771.6, 1428.9, 0.86, 1200.0, 1.1, 888500.0])
    ws.append([])
    for phase, rows in STATIONS.items():
        sh = wb.create_sheet(f"PVsyst_ระยะ{phase}")
        sh.append([None, f"รายงาน PVsyst ระยะที่ {phase}"])
        sh.append([])
        sh.append([None, "ก. ข้อมูลจากรายงาน PVsyst"])
        sh.append([None, *HDR])
        for s in rows:
            sh.append(_station_row(phase, s))
        sh.append([None, None, None, f"รวม {len(rows)} สถานี", None, None, None, None, None, sum(s[3] for s in rows)])
        sh.append([])
        sh.append([None, "ค. ต่อสถานี · ปีแรก (บาท)"])
        word = "หน่วยไฟตามสัญญา (ปีแรก)" if phase == 1 else "หน่วยไฟตามสัญญา (ประมาณ)"
        sh.append([None, None, None, "สถานที่", "kWp", "หน่วยไฟ PVsyst", word, "ขั้นต่ำทางบัญชี"])
        for s, c in zip(rows, CONTRACT[phase]):
            sh.append([None, None, None, s[1], s[3], sum(v or 0 for v in s[6]) * 1000, c, 1.0])
        sh.append([None, None, None, "รวม"])
    codes = wb.create_sheet("ประมาณการ_kWh_ระยะ2")
    codes.append([None, "หน่วยไฟประมาณการรายเดือน ระยะ 2 (kWh)"])
    codes.append([None, "ลำดับ PVsyst", "สถานี", "รหัสในรายงานประจำวัน", "เขต", "kWp"])
    codes.append([None, 1, "สถานีดี", "P2-1109", "เขต 9", 120.0])
    codes.append([None, 2, "สถานีอี", "P2-1110", "เขต 9", 60.0])
    if drop_sheet:
        del wb[drop_sheet]
    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()


def _sites():
    return [
        {"site_id": "P1-01", "phase": "1", "name": "Site A", "kwp": "100", "pvsyst_seq": "1", "growatt_plant_id": str(P1)},
        {"site_id": "P1-02", "phase": "1", "name": "Site B", "kwp": "250", "pvsyst_seq": "2", "growatt_plant_id": str(P2)},
        {"site_id": "P1-09", "phase": "1", "name": "No station", "kwp": "10", "pvsyst_seq": "9", "growatt_plant_id": str(P1)},
        # phase 2 joins on the report code; its pvsyst_seq agrees
        {"site_id": "P2-1109", "phase": "2", "name": "Site D", "kwp": "120", "pvsyst_seq": "1", "growatt_plant_id": str(P2)},
        # code matches but the seq disagrees: never guessed, left out
        {"site_id": "P2-1110", "phase": "2", "name": "Site E", "kwp": "60", "pvsyst_seq": "7", "growatt_plant_id": str(P2)},
    ]


def _days():
    rows = []
    for d in (date(2026, 3, 1), date(2026, 3, 2), date(2026, 4, 1)):
        for sid, kwh in (("P1-01", 380.0), ("P1-02", 900.0), ("P2-1109", 520.0)):
            rows.append({"day": d.isoformat(), "site_id": sid, "meter_kwh": str(kwh), "inverter_kwh": str(kwh * 1.01), "status": "ok"})
    # a day without a meter reading is not counted
    rows.append({"day": "2026-03-03", "site_id": "P1-01", "meter_kwh": "", "inverter_kwh": "380", "status": "loss_meter"})
    return rows


@pytest.fixture()
def api(tmp_path):
    engine = build_engine(f"sqlite:///{tmp_path / 'pvsyst.db'}")
    Base.metadata.create_all(bind=engine)
    f = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)
    with f() as db:
        ensure_seeded(db)
        for pid in (P1, P2):
            db.add(GrowattPlant(plant_id=pid, name=f"Plant {pid}"))
        eng = db.scalars(select(User).where(User.username == "engineer")).one()
        db.add(UserPlantAssignment(user_id=eng.id, plant_id=P1))
        db.commit()
        pwa_meter.import_rows(db, _sites(), _days())
        svc.import_workbook(db, svc.read_workbook(_workbook()))
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


def test_orientations():
    assert svc.parse_orientations("15/0°") == [[15.0, 0.0]]
    assert svc.parse_orientations("15 / -90 °") == [[15.0, -90.0]]
    assert svc.parse_orientations("15/-10° Tilt/Azimuth 15/170 °") == [[15.0, -10.0], [15.0, 170.0]]
    assert svc.parse_orientations("15/0° No 3D scene defined Diffuse Perez, Meteonorm") == [[15.0, 0.0]]
    # an OCR slip in any part: nothing is guessed
    assert svc.parse_orientations("710° Tilt/Azimuth 15/90 °") is None
    assert svc.parse_orientations("15/270°") is None
    assert svc.parse_orientations(None) is None


def test_reader_maps_by_header_text():
    parsed = svc.read_workbook(_workbook())
    st = {(s["phase"], s["seq"]): s for s in parsed["stations"]}
    assert len(st) == 7 and [p["phase"] for p in parsed["phases"]] == [1, 2, 3, 4, 0]
    a = st[(1, 1)]
    assert a["kwp"] == 100.0 and a["kwac"] == 80.0 and a["pr"] == 0.84 and a["azimuth_deg"] == 0.0 and a["tilt_deg"] == 15.0
    assert a["mwh_month"] == [12.4] * 12 and a["contract_basis"] == "contract" and a["contract_kwh_y1"] == 110000.0
    # trailing columns placed one right of their header (the model's blank column)
    assert a["wp_per_module"] == 570 and a["kwp_model"] == 100.0
    b = st[(1, 2)]
    assert b["orientations"] == [[15.0, -10.0], [15.0, 170.0]] and b["azimuth_deg"] is None and b["note"] == "รายงานบางส่วน"
    c = st[(1, 3)]
    assert c["orientations"] is None and c["mwh_month"][11] is None
    assert st[(2, 1)]["report_code"] == "P2-1109" and st[(2, 1)]["contract_basis"] == "estimated" and st[(1, 1)]["report_code"] is None
    assert any("#3" in w for w in parsed["warnings"])


def test_import_is_idempotent_and_all_or_nothing(api):
    f, *_ = api
    with f() as db:
        res = svc.import_workbook(db, svc.read_workbook(_workbook()))
        assert res["stations"] == 7 and res["stations_by_phase"] == {1: 3, 2: 2, 3: 1, 4: 1}
        assert res["orientation_single"] == 5 and res["orientation_several"] == 1 and res["orientation_unread"] == 1
        assert db.scalar(select(func.count()).select_from(PvsystStation)) == 7
        assert db.scalar(select(func.count()).select_from(PvsystPhase)) == 5
    with pytest.raises(svc.PvsystImportError, match="PVsyst_ระยะ3"):
        svc.read_workbook(_workbook(drop_sheet="PVsyst_ระยะ3"))
    with f() as db:  # a refused workbook leaves the stored data as it was
        assert db.scalar(select(func.count()).select_from(PvsystStation)) == 7


def test_design_admin(api):
    _, client, admin, _ = api
    r = client.get("/pvsyst/design", headers=admin)
    assert r.status_code == 200
    d = r.json()
    assert [p["phase"] for p in d["phases"]] == [1, 2, 3, 4] and d["total"]["phase"] == 0
    p1 = d["phases"][0]
    assert p1["pr_weighted"] == 0.83 and p1["contract_over_pvsyst"] == 1.5625
    assert p1["contract_over_pvsyst_per_kwp"] == round(1000.0 / 1313.7, 4)
    st = {(s["phase"], s["seq"]): s for s in d["stations"]}
    assert len(st) == 7
    a = st[(1, 1)]
    assert a["dc_ac_ratio"] == 1.25 and a["kwh_kwp_month"][0] == 124.0 and a["site_ids"] == ["P1-01"]
    # contract per kWp of the model's kWp (250), PVsyst per the report's (50)
    b = st[(1, 2)]
    assert b["contract_specific_yield"] == 1000.0 and b["contract_over_pvsyst"] == round(1000.0 / 1440.0, 4)
    assert st[(2, 2)]["site_ids"] == []  # its site's pvsyst_seq disagrees with the code
    assert "modelled" in d["labels"]


def test_design_engineer_scoped(api):
    _, client, _, eng = api
    d = client.get("/pvsyst/design", headers=eng).json()
    assert d["phases"] == [] and d["total"] is None
    assert [(s["phase"], s["seq"]) for s in d["stations"]] == [(1, 1)]


def test_vs_meter(api):
    _, client, admin, eng = api
    d = client.get("/pvsyst/vs-meter", headers=admin).json()
    assert d["matched"] == 3 and d["unmatched"] == 2 and sorted(d["unmatched_sites"]) == ["P1-09", "P2-1110"]
    sites = {s["site_id"]: s for s in d["sites"]}
    a = sites["P1-01"]["months"]
    assert [m["month"] for m in a] == ["2026-03", "2026-04"]
    assert a[0]["days_read"] == 2 and a[0]["meter_kwh"] == 760.0
    assert a[0]["pvsyst_kwh"] == round(2 * 12.4 * 1000 / 31, 1) and a[1]["pvsyst_kwh"] == round(12.4 * 1000 / 30, 1)
    # PVsyst scaled to the site kWp: 50 kWp report, 250 kWp site
    b = sites["P1-02"]["months"][0]
    assert sites["P1-02"]["kwp_ratio"] == 5.0 and b["pvsyst_kwh"] == round(2 * 6.0 * 1000 * 5 / 31, 1)
    assert sites["P2-1109"]["station_seq"] == 1
    d = client.get("/pvsyst/vs-meter", params={"start": "2026-04-01"}, headers=admin).json()
    assert all(len(s["months"]) == 1 for s in d["sites"])
    e = client.get("/pvsyst/vs-meter", headers=eng).json()
    assert [s["site_id"] for s in e["sites"]] == ["P1-01"] and e["unmatched_sites"] == ["P1-09"]
    assert client.get("/pvsyst/vs-meter", params={"start": "2026-04-02", "end": "2026-04-01"}, headers=admin).status_code == 422
