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
