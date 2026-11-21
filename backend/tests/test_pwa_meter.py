"""PWA daily meter report (docs/plans/pwa-meter-daily.md): import, criteria-driven summaries, scoping."""

from __future__ import annotations

import copy
from datetime import date, timedelta

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import sessionmaker

from app.db.models import GrowattPlant, GrowattPlantEnergyDay, PwaMeterDay, User, UserPlantAssignment
from app.db.seed import ensure_seeded
from app.db.session import Base, build_engine, get_db
from app.main import create_app
from app.services import pwa_meter as svc

P1, P2 = 9201, 9202
D0 = date(2026, 3, 1)


def _sites():
    return [
        {"site_id": "P1-01", "phase": "1", "name": "Free site", "region": "เขต 1", "kwp": "100", "growatt_plant_id": str(P1), "kwp_mismatch": "0"},
        {"site_id": "P1-02", "phase": "1", "name": "Curtailed site", "region": "เขต 2", "kwp": "100", "growatt_plant_id": str(P2), "kwp_mismatch": "0"},
        {"site_id": "P1-03", "phase": "1", "name": "No Growatt plant", "region": "เขต 2", "kwp": "100", "growatt_plant_id": "", "kwp_mismatch": "1"},
    ]


def _days(n=40):
    rows = []
    for i in range(n):
        d = (D0 + timedelta(days=i)).isoformat()
        # P1-01: 400 kWh vs PVsyst 400 (PI 100 %), outage on days 10-12, meter reads 10 % low on days 20-24
        if 10 <= i <= 12:
            rows.append({"day": d, "site_id": "P1-01", "meter_kwh": "0", "inverter_kwh": "0", "contract_kwh": "380", "pvsyst_kwh": "400",
                         "status": "outage", "curtailment_note": "0", "weather": "rain", "note": "เบรคเกอร์ทริป แผนเข้าแก้ไข"})
        else:
            inv = 400 / 0.99
            meter = 360 if 20 <= i <= 24 else 400
            rows.append({"day": d, "site_id": "P1-01", "meter_kwh": str(meter), "inverter_kwh": f"{inv:.2f}", "contract_kwh": "380", "pvsyst_kwh": "400",
                         "status": "ok", "curtailment_note": "0", "weather": "cloudy", "note": ""})
        # P1-02: curtailed every day, 300 of 400
        rows.append({"day": d, "site_id": "P1-02", "meter_kwh": "300", "inverter_kwh": "303", "contract_kwh": "380", "pvsyst_kwh": "400",
                     "status": "ok", "curtailment_note": "1", "weather": "cloudy", "note": "ระบบหรี่ให้พอดีกับโหลด"})
        # P1-03: inverter data missing on day 0
        rows.append({"day": d, "site_id": "P1-03", "meter_kwh": "390", "inverter_kwh": "" if i == 0 else "394", "contract_kwh": "380", "pvsyst_kwh": "400",
                     "status": "loss_inv" if i == 0 else "ok", "curtailment_note": "0", "weather": "", "note": ""})
    return rows


@pytest.fixture()
def api(tmp_path):
    engine = build_engine(f"sqlite:///{tmp_path / 'pwa.db'}")
    Base.metadata.create_all(bind=engine)
    f = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)
    with f() as db:
        ensure_seeded(db)
        for pid in (P1, P2):
            db.add(GrowattPlant(plant_id=pid, name=f"Plant {pid}"))
        eng = db.scalars(select(User).where(User.username == "engineer")).one()
        db.add(UserPlantAssignment(user_id=eng.id, plant_id=P1))
        db.commit()
        svc.import_rows(db, _sites(), _days())
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


def test_classify_follows_criteria():
    assert svc.classify(0, 0) == "outage"
    assert svc.classify(500, None) == "loss_inv"
    assert svc.classify(None, 500) == "loss_meter"
    assert svc.classify(0.5, 600) == "loss_meter"
    assert svc.classify(500, 505) == "ok"


def test_import_is_idempotent_and_keeps_missing_as_null(api):
    f, *_ = api
    with f() as db:
        again = svc.import_rows(db, _sites(), _days())
        assert again == {"sites_added": 0, "sites_updated": 3, "days_added": 0, "days_updated": 120}
        assert db.query(PwaMeterDay).count() == 120
        gap = db.scalars(select(PwaMeterDay).where(PwaMeterDay.site_id == "P1-03", PwaMeterDay.day == D0)).one()
        assert gap.inverter_kwh is None and gap.status == "loss_inv"


@pytest.mark.parametrize("patch,msg", [
    ({"status": "ok", "meter_kwh": "0", "inverter_kwh": "0"}, "does not match"),
    ({"site_id": "P9-99"}, "not in the sites file"),
    ({"day": "1/3/2026"}, "YYYY-MM-DD"),
    ({"meter_kwh": "-5"}, "≥ 0"),
    ({"weather": "sunny"}, "weather"),
])
def test_bad_row_rolls_back_the_whole_import(api, patch, msg):
    f, *_ = api
    rows = _days(2)
    rows[0] = {**rows[0], "day": "2026-06-01", **patch}
    rows.append({**rows[1], "day": "2026-06-02"})
    with f() as db:
        before = db.query(PwaMeterDay).count()
        with pytest.raises(svc.PwaImportError, match=msg):
            svc.import_rows(db, [], rows)
        assert db.query(PwaMeterDay).count() == before


def test_summary_losses_and_issues(api, monkeypatch):
    f, *_ = api
    crit = copy.deepcopy(svc.criteria())
    crit["issue_flags"]["curtailment_kwh_min"] = 1000  # the 40-day test fleet loses ~3.6 MWh
    monkeypatch.setattr(svc, "criteria", lambda: crit)
    with f() as db:
        s = svc.summary(db, None)
    sites = {r["site_id"]: r for r in s["sites"]}
    free, cur = sites["P1-01"], sites["P1-02"]
    assert cur["curtailed"] and not free["curtailed"]
    # PI_free pools P1-01 and P1-03 ok days: below 100 %, so the curtailed site's loss is (PI_free - 0.75) x PVsyst
    ph = s["phases"][0]
    assert ph["curtailed_sites"] == 1 and 96 < ph["pi_free_pct"] < 100
    assert cur["curtailment_loss_mwh"] == pytest.approx((ph["pi_free_pct"] / 100 - 0.75) * 40 * 400 / 1000, abs=0.05)
    assert free["outage_days"] == 3 and free["outage_loss_mwh"] == pytest.approx(3 * 400 * ph["pi_free_pct"] / 100 / 1000, abs=0.01)
    assert "หรี่กำลัง" in cur["issues"] and cur["owner"] == "PM"
    assert sites["P1-03"]["data_gap_days"] == 1
    assert s["sites"][0]["rank"] == 1 and s["labels"]["loss_thb"] == "estimated"


def test_outage_events_and_meter_check(api):
    f, *_ = api
    with f() as db:
        ev = svc.outage_events(db, None)
        mc = {r["site_id"]: r for r in svc.meter_check(db, None)}
    assert len(ev) == 1 and ev[0]["days"] == 3 and ev[0]["start"] == "2026-03-11"
    assert ev[0]["cause"] == "เบรกเกอร์/อุปกรณ์ไฟฟ้า"
    m = mc["P1-01"]
    assert m["low_days"] == 5 and "มิเตอร์อ่านต่ำ/ขาด" in m["flags"]
    assert m["gap_mwh"] == pytest.approx(5 * 40 / 1000, abs=0.01)


def test_engineer_sees_only_assigned_sites(api):
    _, client, admin, eng = api
    assert [s["site_id"] for s in client.get("/pwa/meter/sites", headers=admin).json()] == ["P1-01", "P1-02", "P1-03"]
    assert [s["site_id"] for s in client.get("/api/pwa/meter/sites", headers=eng).json()] == ["P1-01"]
    assert client.get("/pwa/meter/sites/P1-02/days", headers=eng).status_code == 404
    assert client.get("/pwa/meter/sites/P1-03/days", headers=eng).status_code == 404
    days = client.get("/pwa/meter/sites/P1-01/days?start=2026-03-11&end=2026-03-13", headers=eng).json()["days"]
    assert [d["status"] for d in days] == ["outage"] * 3
    s = client.get("/pwa/meter/summary", headers=eng).json()
    assert s["phases"] == [] and [r["site_id"] for r in s["sites"]] == ["P1-01"]
    assert [e["site_id"] for e in client.get("/pwa/meter/outages", headers=eng).json()] == ["P1-01"]
    assert client.get("/pwa/meter/summary?start=2026-04-01&end=2026-03-01", headers=admin).status_code == 422
    assert client.get("/pwa/meter/criteria", headers=eng).json()["tariff"]["book_price_thb_per_kwh"] == 2.7647
    assert client.get("/pwa/meter/sites").status_code == 401


def test_daily_gives_phase_days_to_admins_and_site_days_in_scope(api):
    _, client, admin, eng = api
    d = client.get("/pwa/meter/daily?start=2026-03-10&end=2026-03-11", headers=admin).json()
    assert d["days"] == ["2026-03-10", "2026-03-11"] and d["labels"]["contract_mwh"] == "modelled"
    ok, out = d["phases"]
    # 10 Mar: 400 + 300 + 390 kWh over 300 kWp, contract 3 × 380
    assert (ok["phase"], ok["day"], ok["sites"], ok["meter_mwh"], ok["contract_mwh"]) == (1, "2026-03-10", 3, 1.09, 1.14)
    assert ok["yield_kwh_kwp"] == pytest.approx(3.633) and ok["vs_contract_pct"] == 95.6
    assert out["meter_mwh"] == 0.69 and out["yield_kwh_kwp"] == 2.3  # P1-01 is down and still counts with 0 kWh
    assert [s["site_id"] for s in d["sites"]] == ["P1-01", "P1-02", "P1-03"]
    assert d["sites"][0]["yield_kwh_kwp"] == [4.0, 0.0] and d["sites"][0]["status"] == ["ok", "outage"]
    e = client.get("/pwa/meter/daily?start=2026-03-10&end=2026-03-11", headers=eng).json()
    assert e["phases"] == [] and [s["site_id"] for s in e["sites"]] == ["P1-01"]
    assert client.get("/pwa/meter/daily?start=2027-01-01", headers=admin).json() == {"days": [], "phases": [], "sites": [], "labels": {"contract_mwh": "modelled"}}
    assert client.get("/pwa/meter/daily?start=2026-04-01&end=2026-03-01", headers=admin).status_code == 422
    assert client.get("/pwa/meter/daily").status_code == 401


def test_plant_days_compare_meter_with_growatt(api):
    f, client, admin, eng = api
    with f() as db:
        # Growatt's own day energy for days 30-34 of P1-01 (meter 400 kWh); day 34 is a glitch (> 10 kWh/kWp)
        for i, kwh in [(30, 404.0), (31, 404.0), (32, 404.0), (33, 404.0), (34, 5000.0)]:
            db.add(GrowattPlantEnergyDay(plant_id=P1, day=D0 + timedelta(days=i), energy_kwh=kwh))
        db.commit()
    r = client.get(f"/pwa/meter/plants/{P1}", headers=eng)
    assert r.status_code == 200
    body = r.json()
    assert body["site"]["site_id"] == "P1-01" and body["last_report_day"] == "2026-04-09"
    assert len(body["days"]) == 40  # whole test report is shorter than the 60-day default
    by = {d["day"]: d for d in body["days"]}
    assert by["2026-03-31"]["growatt_kwh"] == 404.0 and by["2026-03-31"]["meter_vs_growatt_pct"] == pytest.approx(99.01, abs=0.01)
    glitch = by["2026-04-04"]
    assert glitch["growatt_kwh"] is None and glitch["growatt_implausible"] and glitch["meter_vs_growatt_pct"] is None
    assert by["2026-03-01"]["growatt_kwh"] is None  # no Growatt day stored: null, never 0
    assert body["summary"]["compared_days"] == 4 and body["summary"]["median_meter_vs_growatt_pct"] == pytest.approx(99.01, abs=0.01)
    assert len(client.get(f"/pwa/meter/plants/{P1}?start=2026-03-31&end=2026-04-01", headers=eng).json()["days"]) == 2
    assert client.get(f"/pwa/meter/plants/{P2}", headers=eng).status_code == 404  # not assigned
    assert client.get("/pwa/meter/plants/9999", headers=admin).status_code == 404  # no report site


# ---------- daily report import (Excel) and monthly expected energy ----------

import io  # noqa: E402

import openpyxl  # noqa: E402

from app.db.models import PwaMeterExpected, PwaMeterSite  # noqa: E402
from app.services import pwa_meter_model as model  # noqa: E402
from app.services.pwa_meter_report import parse_workbook, sheet_day_months, title_day  # noqa: E402

TODAY = date(2026, 4, 30)
TABLE = ["ลำดับ", "สถานที่", "กำลังการผลิตติดตั้ง (kw)", "ชั่วโมงเเดดสูงสุด (hr)", "หน่วยจากมิเตอร์", "หน่วยจากอินเวอร์เตอร์",
         "Diff", "%Diff", "หน่วยประมาณการ\nจากเล่มข้อเสนอ", "Diff", "%Diff", "สภาพอากาศ", "หมายเหตุ"]


def _p1_book(day_title="15 เมษายน 2569", extra_unknown=False):
    """Phase 1 layout: one sheet, title with the day, site row then the meter number two rows down."""
    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = "สรุปหน่วยรายวัน"
    ws.append([f"สรุปผลการผลิตระบบผลิตไฟฟ้าพลังงานแสงอาทิตย์ประจำวันที่ {day_title}"])
    ws.append(TABLE)
    rows = [(1, "Free site กปภ.สาขาบางไทร", 410.4567, 414.2, "มีเมฆมาก", None, "WP000001"),
            (2, "Curtailed site กปภ.สาขาบางไทร", 300, 303, "ฝนคก", "ระบบหรี่ให้พอดีกับโหลด", "WP000002")]
    if extra_unknown:
        rows.append((3, "Unknown place กปภ.สาขาไหน", 100, 101, "มีเมฆมาก", None, None))
    for seq, name, m, i, w, note, meter in rows:
        ws.append([seq, name, 100, 4.0, m, i, None, None, None, None, None, w, note])
        ws.append([None, "หมายเลขมิเตอร์"])
        ws.append([None, f"{meter} (23:45:00)" if meter else None])
    ws2 = wb.create_sheet("รายงานปัญหา ")
    ws2.append(["รายงานสรุปปัญหา"])
    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()


P2_ROWS = ((1046, "สถานีผลิตน้ำบ้านนางเลง กปภ.สาขากบินทร์บุรี", 500.123, 0.0),)


def _p2_book(sheet_names=("16.04",), rows=P2_ROWS):
    """Phase 2 layout: per-day sheets named by day, comp_id + the system pull (Cewe / Growatt /
    Weather) on the left of the header row, the typed table from column Y. The phase 1 workbook uses
    it too, with its own comp_id (`rows` = (comp_id, name, Cewe, Growatt))."""
    wb = openpyxl.Workbook()
    wb.remove(wb.active)
    for name in sheet_names:
        ws = wb.create_sheet(name)
        ws.append(["รายงาน"])
        hdr = [None] * 37
        hdr[0], hdr[6], hdr[9], hdr[16], hdr[17], hdr[21] = "Selection", "comp_id", "comp_name_th", "Cewe", "Growatt", "Weather"
        hdr[24:37] = TABLE
        ws.append(hdr)
        row = [None] * 37
        for comp_id, name, meter, inverter in rows:
            row = [None] * 37
            # system: meter, inverter 0 (comms down); the typed table repeats an old inverter figure
            row[6], row[16], row[17], row[21] = comp_id, meter, inverter, "ฝนตก"
            row[24:37] = [1, name, 190.38, 3.9, round(meter, 2), 999.0, None, None, 724.9, None, None, "มีเมฆมาก", "ระบบสื่อสารมีปัญหา"]
            ws.append(row)
        sub = [None] * 37
        sub[15], sub[28] = "WP081205 (23:45:00)", "WP081205 (23:45:00)"
        ws.append(sub)
    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()


def _add_p2_site(f):
    with f() as db:
        svc.import_rows(db, [{"site_id": "P2-1046", "phase": "2", "name": "สถานีผลิตน้ำบ้านนางเลง", "region": "เขต 1", "kwp": "190.38",
                              "growatt_plant_id": "", "kwp_mismatch": "0"}], [])


def _expected(f, site_id, month, con, pvs):
    with f() as db:
        db.add(PwaMeterExpected(site_id=site_id, month=month, contract_kwh_day=con, pvsyst_kwh_day=pvs, basis="test", source="test"))
        db.commit()


def test_report_dates_from_title_and_sheet_names():
    assert title_day("…ประจำวันที่ 11 พฤศจิกายน 2569") == date(2026, 11, 11)
    assert title_day("ประจำวันที่ 7 พ.ย. 2025") == date(2025, 11, 7)
    assert sheet_day_months("18.11") == [(18, 11)]
    assert sheet_day_months("711") == [(7, 11)]
    assert (1, 7) in sheet_day_months("017") and (1, 9) in sheet_day_months("19")
    assert sheet_day_months("Sheet") == []
    # names read in sequence: 017 after 30 Jun is 1 Jul, 107 after 9 Jul is 10 Jul; the year rolls over
    sheets = parse_workbook(_p2_book(("3006", "017", "097", "107", "3112", "0101", "Sheet")), "p2.xlsx", date(2027, 2, 1))
    days = [(s.sheet, s.day) for s in sheets]
    assert days[:6] == [("3006", date(2026, 6, 30)), ("017", date(2026, 7, 1)), ("097", date(2026, 7, 9)), ("107", date(2026, 7, 10)),
                        ("3112", date(2026, 12, 31)), ("0101", date(2027, 1, 1))]
    assert days[6] == ("Sheet", None) and sheets[6].errors


def test_report_sheet_out_of_order_keeps_its_year_and_is_flagged():
    """Phase 1 workbook: a second May block after 27 May (`0405` …) read as 2027 moved every later sheet
    a year ahead. The closest reading wins, so the block lands on May 2026 as repeats and June stays 2026."""
    assert sheet_day_months("17..11") == [(17, 11)]
    names = ("26.05", "27.05", "0405", "0505", "28.05", "01.06", "17..11")
    sheets = parse_workbook(_p2_book(names), "Phase 1.xlsx", date(2026, 11, 21))
    assert [s.day for s in sheets] == [date(2026, 5, 26), date(2026, 5, 27), date(2026, 5, 4), date(2026, 5, 5), date(2026, 5, 28),
                                       date(2026, 6, 1), date(2026, 11, 17)]
    assert not any(s.errors for s in sheets)  # no repeat yet: 4–5 May have no other sheet here
    again = parse_workbook(_p2_book(("04.05", "05.05", "27.05", "0405")), "p.xlsx", date(2026, 11, 21))
    assert again[3].day == date(2026, 5, 4) and again[3].errors == ["day 2026-05-04 is also sheet '04.05': skip one of them or set its day"]


def test_report_preview_commit_and_reimport(api):
    f, *_ = api
    _expected(f, "P1-01", date(2026, 4, 1), 380.0, 401.5)
    with f() as db:
        bad = svc.import_report(db, [("p1.xlsx", _p1_book(extra_unknown=True))], TODAY)
        assert not bad["ok"] and bad["totals"]["unmatched"] == 1
        assert bad["sheets"][0]["unmatched"][0]["name"].startswith("Unknown place")
        assert db.query(PwaMeterDay).filter(PwaMeterDay.day == date(2026, 4, 15)).count() == 0
        # refused: a commit with an unmatched row writes nothing
        assert not svc.import_report(db, [("p1.xlsx", _p1_book(extra_unknown=True))], TODAY, commit=True)["committed"]
        prev = svc.import_report(db, [("p1.xlsx", _p1_book())], TODAY)
        assert prev["ok"] and prev["totals"]["new"] == 2 and not prev["committed"]
        assert prev["sheets"][0]["day"] == "2026-04-15" and prev["sheets"][0]["day_source"] == "title"
        assert prev["months_without_expected"] == ["2026-04"]  # P1-02 has no expected month: left null
        done = svc.import_report(db, [("p1.xlsx", _p1_book())], TODAY, commit=True)
        assert done["committed"] and done["meter_numbers_learned"] == 2
    with f() as db:
        d1 = db.scalars(select(PwaMeterDay).where(PwaMeterDay.site_id == "P1-01", PwaMeterDay.day == date(2026, 4, 15))).one()
        assert (d1.meter_kwh, d1.inverter_kwh, d1.status, d1.weather) == (410.46, 414.2, "ok", "cloudy")
        assert (d1.contract_kwh, d1.pvsyst_kwh) == (380.0, 401.5)  # from the expected month
        d2 = db.scalars(select(PwaMeterDay).where(PwaMeterDay.site_id == "P1-02", PwaMeterDay.day == date(2026, 4, 15))).one()
        assert d2.weather == "rain" and d2.curtailment_note and d2.contract_kwh is None  # typo ฝนคก = rain; no expected = null
        assert db.get(PwaMeterSite, "P1-01").meter_no == "WP000001"
        again = svc.import_report(db, [("p1.xlsx", _p1_book())], TODAY)
        assert again["totals"]["unchanged"] == 2 and again["totals"]["new"] == 0


def test_report_phase2_uses_system_pull_and_nulls_missing_reading(api):
    f, *_ = api
    _add_p2_site(f)
    with f() as db:
        out = svc.import_report(db, [("p2.xlsx", _p2_book(("16.04",)))], TODAY, commit=True)
        assert out["committed"] and out["sheets"][0]["day_source"] == "sheet name" and out["sheets"][0]["day"] == "2026-04-16"
        d = db.scalars(select(PwaMeterDay).where(PwaMeterDay.site_id == "P2-1046")).one()
        # Cewe 500.123 (not the table's 500.12 typed value); Growatt 0 while the meter read = inverter data missing -> null
        assert d.meter_kwh == 500.12 and d.inverter_kwh is None and d.status == "loss_inv"
        assert d.weather == "rain" and d.note == "ระบบสื่อสารมีปัญหา"
        assert db.get(PwaMeterSite, "P2-1046").meter_no == "WP081205"


def test_report_phase1_in_phase2_layout_matches_by_name_not_comp_id(api):
    """The phase 1 workbook carries its own comp_id (1, 2, …), which is not a phase 2 site id: the rows
    are matched by name, not refused as "no site P2-1"; the system pull is still the source."""
    f, *_ = api
    _add_p2_site(f)
    rows = ((1, "Curtailed site กปภ.สาขาบางไทร", 300.456, 303.1), (2, "Free site กปภ.สาขาบางไทร", 410.4, 0.0))
    with f() as db:
        out = svc.import_report(db, [("Phase 1.xlsx", _p2_book(("16.04",), rows))], TODAY, commit=True)
        assert out["committed"] and out["totals"]["matched"] == 2 and out["totals"]["unmatched"] == 0
        got = {d.site_id: d for d in db.scalars(select(PwaMeterDay).where(PwaMeterDay.day == date(2026, 4, 16)))}
        assert set(got) == {"P1-01", "P1-02"}  # comp_id 1 is the Curtailed site here, not P1-01
        assert got["P1-02"].meter_kwh == 300.46 and got["P1-02"].inverter_kwh == 303.1
        assert got["P1-01"].inverter_kwh is None and got["P1-01"].status == "loss_inv"
        # a phase 2 sheet keeps matching by comp_id: an unknown one is refused, never matched by name
        mixed = P2_ROWS + ((1999, "Free site กปภ.สาขาบางไทร", 410.4, 411.0),)
        bad = svc.import_report(db, [("p2.xlsx", _p2_book(("17.04",), mixed))], TODAY)
        assert bad["sheets"][0]["unmatched"][0]["reason"] == "no site P2-1999"


def test_report_overrides_skip_and_pre_contract_sheets(api):
    f, *_ = api
    _add_p2_site(f)
    book = _p2_book(("1512", "Sheet", "16.04"))  # 15 Dec 2025 = before phase 2's start; "Sheet" has no date
    with f() as db:
        prev = svc.import_report(db, [("p2.xlsx", book)], TODAY)
        by = {s["sheet"]: s for s in prev["sheets"]}
        assert by["1512"]["before_start"] == 1 and not by["1512"]["errors"]
        assert by["Sheet"]["errors"] and not prev["ok"]
        ok = svc.import_report(db, [("p2.xlsx", book)], TODAY, {"p2.xlsx::Sheet": "2026-04-17"}, commit=True)
        assert ok["committed"] and ok["totals"]["new"] == 2
        assert {d.day for d in db.scalars(select(PwaMeterDay).where(PwaMeterDay.site_id == "P2-1046"))} == {date(2026, 4, 16), date(2026, 4, 17)}
        skipped = svc.import_report(db, [("p2.xlsx", book)], TODAY, {"p2.xlsx::Sheet": "skip"})
        assert skipped["ok"] and [s["skipped"] for s in skipped["sheets"] if s["sheet"] == "Sheet"] == [True]
        dup = svc.import_report(db, [("p2.xlsx", book)], TODAY, {"p2.xlsx::Sheet": "2026-04-16"})
        assert not dup["ok"] and any("also in" in e for s in dup["sheets"] for e in s["errors"])


def test_report_route_is_admin_only(api):
    _, client, admin, eng = api
    files = {"files": ("p1.xlsx", _p1_book(), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")}
    assert client.post("/pwa/meter/import", files=files, headers=eng).status_code == 403
    r = client.post("/pwa/meter/import", files=files, headers=admin)
    assert r.status_code == 200 and r.json()["totals"]["matched"] == 2 and not r.json()["committed"]
    r = client.post("/pwa/meter/import", files={"files": ("notes.csv", b"a,b", "text/csv")}, headers=admin)
    assert r.status_code == 422
    r = client.post("/pwa/meter/import", files=files, data={"days": "[1]"}, headers=admin)
    assert r.status_code == 422


def test_expected_rows_follow_the_model_rules(api):
    f, *_ = api
    _add_p2_site(f)
    m = model.Model(source="m.xlsx", spec2=1400.0)
    m.pvsyst[(1, 1)] = (50.0, [3.1] * 12)  # PVsyst kWp 50 vs contract 100 -> scaled ×2
    m.pvsyst[(2, 26)] = (190.38, [10.0] * 6 + [20.0] * 6)  # the only phase 2 station: its season is the fleet season
    m.p1_contract[1] = {date(2025, 12, 1): 3100.0, date(2026, 1, 1): 6200.0}
    with f() as db:
        for sid, cseq, pseq in (("P1-01", 1, 1), ("P2-1046", None, 26)):
            s = db.get(PwaMeterSite, sid)
            s.contract_seq, s.pvsyst_seq = cseq, pseq
        db.commit()
        sites = [db.get(PwaMeterSite, "P1-01"), db.get(PwaMeterSite, "P2-1046")]
        rows, warn = model.expected_rows(m, sites, date(2026, 1, 1), date(2027, 1, 1))
    by = {(r["site_id"], r["month"]): r for r in rows}
    assert by[("P1-01", date(2026, 1, 1))]["contract_kwh_day"] == 200.0  # 6200 / 31
    assert by[("P1-01", date(2026, 1, 1))]["pvsyst_kwh_day"] == 200.0  # 3.1 MWh × 1000 × 2 / 31
    assert by[("P1-01", date(2026, 12, 1))]["contract_kwh_day"] == round(3100 * 0.993 / 31, 2)  # Dec 2025 × 0.993
    assert by[("P1-01", date(2027, 1, 1))]["contract_kwh_day"] == round(6200 * 0.993 / 31, 2)
    assert by[("P1-01", date(2026, 3, 1))]["contract_kwh_day"] is None  # not in the sheet in any year: null, not made up
    jan = by[("P2-1046", date(2026, 1, 1))]["contract_kwh_day"]
    assert jan == round(190.38 * 1400 * 10 / 180 / 31, 2)
    assert by[("P2-1046", date(2027, 1, 1))]["contract_kwh_day"] == round(190.38 * 1400 * 10 / 180 / 31 * 0.993, 2)  # 2nd contract year
    assert not warn


def test_summary_counts_only_days_with_a_contract_figure(api):
    f, *_ = api
    with f() as db:
        base = {r["site_id"]: r for r in svc.summary(db, None)["sites"]}["P1-01"]
        for d in db.scalars(select(PwaMeterDay).where(PwaMeterDay.site_id == "P1-01", PwaMeterDay.day >= D0 + timedelta(days=30))):
            d.contract_kwh = None
        db.commit()
        after = {r["site_id"]: r for r in svc.summary(db, None)["sites"]}["P1-01"]
    # days 0-29 only: 22 × 400 + 5 × 360 + 3 outage days of 0 = 10,600 kWh over 30 × 380 = 11,400 kWh;
    # counting all 40 days of meter over 30 days of contract would give 128 %
    assert base["vs_contract_pct"] == 96.1
    assert after["vs_contract_pct"] == pytest.approx(100 * 10600 / 11400, abs=0.05)


def _p1_rows_book(rows, day_title="15 เมษายน 2569"):
    """Phase 1 layout with the given (seq, name, meter kWh, meter number) rows."""
    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = "สรุปหน่วยรายวัน"
    ws.append([f"สรุปผลการผลิตระบบผลิตไฟฟ้าพลังงานแสงอาทิตย์ประจำวันที่ {day_title}"])
    ws.append(TABLE)
    for seq, name, m, meter in rows:
        ws.append([seq, name, 100, 4.0, m, m + 4, None, None, None, None, None, "แดดจัด", None])
        ws.append([None, "หมายเลขมิเตอร์"])
        ws.append([None, f"{meter} (23:45:00)" if meter else None])
    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()


def test_report_matches_by_learned_meter_number_then_name(api):
    """PM-R7, PM-R8: a renamed row still matches by the meter number learned before; a name that
    fits two sites is listed, never guessed; a different meter number is a warning, not a change."""
    f, *_ = api
    with f() as db:
        assert svc.import_report(db, [("p1.xlsx", _p1_book())], TODAY, commit=True)["committed"]
        renamed = svc.import_report(db, [("p1.xlsx", _p1_rows_book([(1, "ชื่อใหม่ทั้งหมด", 420.0, "WP000001")], "16 เมษายน 2569"))], TODAY)
        assert renamed["ok"] and renamed["totals"]["matched"] == 1 and renamed["totals"]["new"] == 1
        # "site" is in both "Free site" and "Curtailed site": ambiguous, never guessed
        amb = svc.import_report(db, [("p1.xlsx", _p1_rows_book([(1, "site", 420.0, None)], "16 เมษายน 2569"))], TODAY)
        assert not amb["ok"] and amb["sheets"][0]["unmatched"][0]["reason"] == "several sites match the name"
        other = svc.import_report(db, [("p1.xlsx", _p1_rows_book([(1, "Free site กปภ.สาขาบางไทร", 420.0, "WP999999")], "16 เมษายน 2569"))],
                                  TODAY, commit=True)
        assert other["committed"] and any("differs from the stored WP000001" in w for w in other["sheets"][0]["warnings"])
        assert db.get(PwaMeterSite, "P1-01").meter_no == "WP000001"


def test_report_refuses_a_future_day(api):
    """PM-R11: a sheet dated after today blocks the import."""
    f, *_ = api
    with f() as db:
        out = svc.import_report(db, [("p1.xlsx", _p1_book(day_title="1 พฤษภาคม 2569"))], TODAY, commit=True)
        assert not out["ok"] and not out["committed"]
        assert any("in the future" in e for e in out["sheets"][0]["errors"])
        assert db.query(PwaMeterDay).filter(PwaMeterDay.day == date(2026, 5, 1)).count() == 0


def test_report_route_size_limit(api, monkeypatch):
    """PM-R18: over REPORT_MAX_BYTES in one request answers 413."""
    _, client, admin, _ = api
    monkeypatch.setattr(svc, "REPORT_MAX_BYTES", 1000)
    files = {"files": ("p1.xlsx", _p1_book(), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")}
    assert client.post("/pwa/meter/import", files=files, headers=admin).status_code == 413


def test_window_checks_and_empty_window(api):
    """PM-A (422 for end < start) and PM-P11: an empty window echoes the request with no rows."""
    _, client, admin, _ = api
    for path in ("summary", "outages", "meter-check", "sites/P1-01/days", f"plants/{P1}"):
        assert client.get(f"/pwa/meter/{path}?start=2026-04-02&end=2026-04-01", headers=admin).status_code == 422
    r = client.get("/pwa/meter/summary?start=2030-01-01&end=2030-01-31", headers=admin).json()
    assert r["window"] == {"start": "2030-01-01", "end": "2030-01-31"} and r["sites"] == [] and r["phases"] == []
    assert client.get("/pwa/meter/outages?start=2030-01-01", headers=admin).json() == []
    assert client.get("/pwa/meter/meter-check?start=2030-01-01", headers=admin).json() == []


def test_model_workbook_without_the_sheets_is_refused():
    """PM-E1: a workbook that is not the model says what is missing."""
    wb = openpyxl.Workbook()
    wb.active.title = "PVsyst_ระยะ1"
    buf = io.BytesIO()
    wb.save(buf)
    with pytest.raises(model.ModelError, match="ประมาณการ_kWh"):
        model.read_model(buf.getvalue())


def test_csv_missing_column_is_refused_before_reading(api, tmp_path):
    """PM-C1: a file without a required column is refused and nothing is written."""
    f, *_ = api
    sites, days = tmp_path / "sites.csv", tmp_path / "days.csv"
    sites.write_text("site_id,phase,name,region\nP1-09,1,New site,เขต 1\n", encoding="utf-8")
    days.write_text("day,site_id,meter_kwh,inverter_kwh\n", encoding="utf-8")
    with f() as db:
        with pytest.raises(svc.PwaImportError, match="sites file is missing column.*kwp"):
            svc.import_csv(db, sites, days)
        assert db.get(PwaMeterSite, "P1-09") is None
    sites.write_text("﻿site_id,phase,name,region,kwp\nP1-09,1,New site,เขต 1,50\n", encoding="utf-8")  # BOM accepted
    days.write_text("day,site_id,meter_kwh\n2026-04-01,P1-09,100\n", encoding="utf-8")
    with f() as db:
        with pytest.raises(svc.PwaImportError, match="days file is missing column.*inverter_kwh"):
            svc.import_csv(db, sites, days)
        assert db.get(PwaMeterSite, "P1-09") is None


def test_committed_report_import_is_audited(api, caplog):
    """PM-R19: a committed import logs who, what changed and the day range to app.audit; a preview does not."""
    import logging

    _, client, admin, _ = api
    files = {"files": ("p1.xlsx", _p1_book(), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")}
    with caplog.at_level(logging.INFO, logger="app.audit"):
        assert not client.post("/pwa/meter/import", files=files, headers=admin).json()["committed"]
        assert not [r for r in caplog.records if r.name == "app.audit" and "PWA meter" in r.getMessage()]
        r = client.post("/pwa/meter/import", files=files, data={"commit": "true"}, headers=admin)
        assert r.status_code == 200 and r.json()["committed"]
    lines = [r.getMessage() for r in caplog.records if r.name == "app.audit" and "PWA meter" in r.getMessage()]
    assert lines == ["PWA meter report imported by admin: 2 new, 0 changed days (2026-04-15 .. 2026-04-15), 1 file(s)"]


def test_expected_check_against_stored_days(api):
    """PM-E6 `--check`: the largest kWh/day difference between the expected table and the stored days."""
    f, *_ = api
    _expected(f, "P1-01", date(2026, 3, 1), 381.0, 400.0)  # stored days: contract 380, PVsyst 400
    with f() as db:
        out = model.check_against_days(db)
    # P1-01 has 31 days in March; the other 89 site-days have no expected month
    assert out == {"days_compared": 31, "days_without_expected": 89, "max_diff_kwh_day": {"contract": 1.0, "pvsyst": 0.0}}


def test_report_rounding_follows_criteria(monkeypatch):
    """PM-R5 / PM-G4: the kWh decimals come from `report_import.round_kwh`, not the code."""
    from app.services.pwa_meter_report import _number

    errs: list = []
    assert _number("1,234.5678", "x", errs) == 1234.57 and not errs
    crit = copy.deepcopy(svc.criteria())
    crit["report_import"]["round_kwh"] = 1
    monkeypatch.setattr(svc, "criteria", lambda: crit)
    assert _number(410.4567, "x", errs) == 410.5 and not errs
