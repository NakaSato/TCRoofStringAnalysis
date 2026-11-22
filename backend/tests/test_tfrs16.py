"""TFRS 16 lease model import (services/tfrs16.py) and the admin-only /tfrs16 routes, on a tiny
synthetic workbook built here (the real model workbook is never read in tests)."""

from __future__ import annotations

import io
from datetime import datetime

import openpyxl
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import func, select
from sqlalchemy.orm import sessionmaker

from app.db.models import Tfrs16Period, Tfrs16RolloutStation
from app.db.seed import ensure_seeded
from app.db.session import Base, build_engine, get_db
from app.main import create_app
from app.services import tfrs16 as svc

HDR = ["งวด", "เดือน", "ปีงบ", "ปีสัญญา", "ค่าจัดการพลังงานขั้นต่ำ", "หน่วยประมาณการ (kWh)", "หนี้สินต้นงวด", "ดอกเบี้ย",
       "ชำระ", "หนี้สินปลายงวด", "ค่าเสื่อมราคา", "สินทรัพย์สิทธิการใช้สุทธิ", "สิ้นปีงบ"]
# phase -> (first month, opening liability, monthly rate, payment); 3 periods each
PHASES = {1: ((2025, 8), 1000.0, 0.01, 100.0), 2: ((2025, 9), 2000.0, 0.01, 150.0)}


def _schedule(phase):
    (y, m), liab, rate, pay = PHASES[phase]
    rows, rou = [], liab
    for k in range(3):
        mo = m + k
        yy, mm = (y + (mo - 1) // 12, (mo - 1) % 12 + 1)
        fy = (yy + 543) + (1 if mm >= 10 else 0)
        interest = liab * rate
        closing = liab + interest - pay
        rou -= liab / 3 if k == 0 else PHASES[phase][1] / 3
        rows.append([k + 1, datetime(yy, mm, 1), f"FY{fy}", 1, pay, 10.0, liab, interest, -pay, closing, PHASES[phase][1] / 3, rou, 0])
        liab = closing
    return rows


def _workbook(break_closing=False, remeasure_book=None):
    wb = openpyxl.Workbook()
    wb.remove(wb.active)
    sched = {p: _schedule(p) for p in PHASES}
    if break_closing:
        sched[2][1][9] += 50  # closing no longer = opening + interest + payment
    for p in PHASES:
        ws = wb.create_sheet(f"ระยะ{p}")
        ws.append([None, f"ระยะที่ {p} · ตารางหนี้สินตามสัญญาเช่า" + (" (ประมาณการ)" if p == 2 else "")])
        ws.append([])
        ws.append([None, *HDR])
        for r in sched[p]:
            ws.append([None, *r])
        ws.append([None, "รวม"])
    ws = wb.create_sheet("รวมทั้งโครงการ")
    ws.append([None, "ก. สรุปแต่ละระยะ"])
    ws.append([None, "รายการ", "ระยะที่ 1", "ระยะที่ 2", "รวมทั้งสัญญา"])
    fee = {p: sum(r[4] for r in sched[p]) for p in PHASES}
    interest = {p: sum(r[7] for r in sched[p]) for p in PHASES}
    for lab, vals in [
        ("จำนวนสถานี (แห่ง)", {1: 2, 2: 3}),
        ("กำลังติดตั้ง (kWp)", {1: 100.0, 2: 150.0}),
        ("วันเริ่มสัญญา", {p: datetime(*PHASES[p][0], 1) for p in PHASES}),
        ("วันสิ้นสุดสัญญา", {1: datetime(2045, 7, 31), 2: datetime(2045, 8, 31)}),
        ("อัตราคิดลด", {1: 0.03, 2: 0.03}),
        ("ค่าจัดการพลังงาน 20 ปี", fee),
        ("หน่วยไฟประมาณการ 20 ปี (kWh)", {1: 30.0, 2: 30.0}),
        ("สินทรัพย์สิทธิการใช้เริ่มแรก", {p: PHASES[p][1] for p in PHASES}),
        ("ดอกเบี้ยจ่ายรอตัดบัญชีเริ่มแรก", interest),
    ]:
        ws.append([None, lab, vals[1], vals[2], None])
    ws.append([])
    ws.append([None, "ข. รวมรายปีงบประมาณ"])
    ws.append([None, "ปีงบประมาณ", "ดอกเบี้ยจ่ายรวม", "ค่าเสื่อมราคารวม"])
    fy = {}
    for p in PHASES:
        for r in sched[p]:
            t = fy.setdefault(int(r[2][2:]), [0.0, 0.0])
            t[0] += r[7]
            t[1] += r[10]
    for y, (i, d) in sorted(fy.items()):
        ws.append([None, y, i, d])
    ws.append([None, "รวม"])
    ws = wb.create_sheet("วงเงินโครงการ")
    ws.append([None, "วงเงินโครงการตามเอกสาร (ไม่รวม VAT)", fee[1] + fee[2], "บาท"])
    ws = wb.create_sheet("ประเมินใหม่")
    book = sched[1][1][9] if remeasure_book is None else remeasure_book
    ws.append([None, "การประเมินหนี้สินตามสัญญาเช่าใหม่"])
    ws.append([None, "ขั้นที่ 1 · วัดหนี้สินใหม่"])
    ws.append([None, None, None, None, "บาท", "ล้านบาท"])
    ws.append([None, None, "วันที่ประเมิน", None, datetime(2025, 9, 30)])
    ws.append([None, None, "หนี้สินตามบัญชี (ปลายงวดที่ประเมิน)", None, book])
    ws.append([None, None, "% ที่คาดว่าจะผลิตได้ในงวดที่เหลือ", None, 0.9])
    ws.append([None, None, "หนี้สินที่วัดใหม่ (PV ด้วยอัตราคิดลดเดิม)", None, book - 80])
    ws.append([None, None, "ส่วนต่าง (บวก = หนี้สินลดลง · ลบ = เพิ่มขึ้น)", None, 80.0])
    ws.append([None, None, "ส่วนต่างเป็น % ของหนี้สินตามบัญชี", None, 80 / book])
    ws.append([None, None, "เกณฑ์ที่ต้องปรับ", None, 0.05])
    ws.append([None, None, "ผลการพิจารณา", None, "ปรับ: หนี้สินลดลง"])
    ws.append([None, "ขั้นที่ 2 · คู่บัญชี"])
    ws.append([None, None, "กำไรจากการเปลี่ยนแปลงสัญญาเช่า", "6279030", None, 80.0])
    ws = wb.create_sheet("รายได้รายเดือน")
    ws.append([None, None, None, "กรณีที่เลือก", None, "2 ราคา TOU จริง · P50"])
    ws.append([None, None, None, "ราคาสุทธิต่อหน่วยที่ใช้ (บาท/kWh)", None, 2.6])
    months = ["ต.ค.", "พ.ย.", "ธ.ค.", "ม.ค.", "ก.พ.", "มี.ค.", "เม.ย.", "พ.ค.", "มิ.ย.", "ก.ค.", "ส.ค.", "ก.ย."]
    ws.append([None, "ระยะ", None, "รายการ", None, *months, "รวมปีแรก"])
    ws.append([None, 1, None, "ระยะที่ 1 (รวมทุกสถานี)", None, *range(1, 13), 78])
    ws.append([None, 2, None, "ระยะที่ 2 (รวมทุกสถานี)", None, *[10] * 12, 120])
    ws.append([None, None, None, "รวมทุกระยะ"])
    ws = wb.create_sheet("ระยะ3-4_สถานี")
    ws.append([None, "สถานีระยะที่ 3–4"])
    ws.append([None, "ที่มา: ไฟล์สรุปสถานะ (ทดสอบ)"])
    ws.append([None, "ลำดับ", "ระยะ", "สถานที่ติดตั้ง", "kWp (แผง)", "สถานะขนานไฟ (กฟภ.)", "ค่าธรรมเนียมขนานไฟ", "สถานะชำระ", "First Sync"])
    ws.append([None, 1, 3, "A", 10.0, "เชื่อมต่อเรียบร้อยแล้ว", 100, "ชำระเงินแล้ว", datetime(2026, 10, 20)])
    ws.append([None, 2, 3, "B", 10.0, "เชื่อมต่อเรียบร้อยแล้ว", 100, "ชำระเงินแล้ว", None])
    ws.append([None, 3, 3, "C", 10.0, "รอตรวจสอบแบบคำขอ", 100, "ชำระเงินแล้ว", None])
    ws.append([None, 1, 4, "D", 10.0, "รอผู้ยื่นคำขอชำระเงิน", None, None, None])
    ws.append([None, None, None, "รวม"])
    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()


@pytest.fixture()
def api(tmp_path):
    engine = build_engine(f"sqlite:///{tmp_path / 'tfrs16.db'}")
    Base.metadata.create_all(bind=engine)
    f = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)
    with f() as db:
        ensure_seeded(db)
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


def test_read_and_import(api):
    f, client, admin, _ = api
    m = svc.read_model(_workbook(), source="test.xlsx")
    assert m.warnings == []
    with f() as db:
        res = svc.import_model(db, m)
    assert res["periods"] == 6 and res["remeasurements"] == [1] and res["rollout_stations"] == 4
    assert res["funnel"] == {"stations": 4, "fee_paid": 3, "interconnected": 2, "first_sync": 1}

    s = client.get("/tfrs16/schedule", headers=admin).json()
    assert s["imported"] and s["labels"]["schedule"] == "accounting (model)"
    p1 = s["phases"][0]
    assert p1["phase"] == 1 and not p1["estimated"] and s["phases"][1]["estimated"]
    r0 = p1["periods"][0]
    assert r0["month"] == "2025-08" and r0["fiscal_year"] == 2568
    assert r0["payment_thb"] == 100.0 and r0["interest_thb"] == 10.0 and r0["principal_thb"] == 90.0 and r0["closing_thb"] == 910.0
    # Aug 2025: only phase 1 has started; Sep 2025: both
    tot = {t["month"]: t for t in s["total"]}
    assert tot["2025-08"]["phases"] == [1] and tot["2025-09"]["phases"] == [1, 2]
    assert tot["2025-09"]["liability_thb"] == pytest.approx(p1["periods"][1]["closing_thb"] + s["phases"][1]["periods"][0]["closing_thb"])
    fy = {y["fiscal_year"]: y for y in s["fiscal_years"]}
    assert set(fy) == {2568, 2569} and fy[2568]["partial"]
    assert fy[2568]["expense_thb"] == pytest.approx(fy[2568]["interest_thb"] + fy[2568]["depreciation_thb"])

    sm = client.get("/tfrs16/summary", headers=admin).json()
    assert sm["min_fee_total_thb"] == 300 + 450 == sm["project_budget_thb"]
    rm = sm["remeasurements"][0]
    assert rm["phase"] == 1 and rm["difference_thb"] == 80.0 and rm["account"] == "6279030" and rm["production_share"] == 0.9
    rev = sm["revenue"]
    assert rev["months"][0] == 10 and rev["months"][-1] == 9 and rev["case"].startswith("2 ราคา")
    assert rev["phases"][0]["revenue_thb"][:3] == [1, 2, 3] and rev["phases"][0]["total_thb"] == 78
    assert sm["rollout"]["phases"] == [{"phase": 3, "stations": 3, "fee_paid": 3, "interconnected": 2, "first_sync": 1},
                                       {"phase": 4, "stations": 1, "fee_paid": 0, "interconnected": 0, "first_sync": 0}]
    ro = client.get("/tfrs16/rollout", headers=admin).json()
    assert [x["name"] for x in ro["stations"]] == ["A", "B", "C", "D"] and ro["stations"][0]["first_sync"] == "2026-10-20"


def test_reimport_replaces_and_bad_workbook_changes_nothing(api):
    f, *_ = api
    with f() as db:
        svc.import_model(db, svc.read_model(_workbook()))
        svc.import_model(db, svc.read_model(_workbook()))
        assert db.scalar(select(func.count()).select_from(Tfrs16Period)) == 6
        assert db.scalar(select(func.count()).select_from(Tfrs16RolloutStation)) == 4
    with pytest.raises(svc.ModelError, match="closing"):
        svc.read_model(_workbook(break_closing=True))
    with f() as db:
        assert db.scalar(select(func.count()).select_from(Tfrs16Period)) == 6


def test_remeasurement_without_matching_phase_is_skipped():
    m = svc.read_model(_workbook(remeasure_book=12345.0))
    assert m.remeasurements == {}
    assert any("sheet skipped" in w for w in m.warnings)


def test_missing_required_sheet():
    wb = openpyxl.Workbook()
    buf = io.BytesIO()
    wb.save(buf)
    with pytest.raises(svc.ModelError, match="phase sheet"):
        svc.read_model(buf.getvalue())


def test_admin_only_and_empty(api):
    _, client, admin, engineer = api
    assert client.get("/tfrs16/summary").status_code == 401
    for path in ("/tfrs16/summary", "/tfrs16/schedule", "/tfrs16/rollout"):
        assert client.get(path, headers=engineer).status_code == 403
    s = client.get("/api/tfrs16/summary", headers=admin).json()
    assert s["imported"] is False and s["phases"] == [] and s["min_fee_total_thb"] is None and s["remeasurements"] == []
    assert client.get("/tfrs16/schedule", headers=admin).json()["fiscal_years"] == []
