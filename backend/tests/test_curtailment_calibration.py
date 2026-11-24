"""Curtailment calibration (services/growatt_curtailment.py): free-running slots, the per-plant
model scale from the days before, and the fleet summary from the stored daily rows."""
from datetime import date

import pytest
from sqlalchemy.orm import sessionmaker

from app.db.models import GrowattPlant, GrowattPlantDaily
from app.db.session import Base, build_engine
from app.services import growatt_curtailment as gc

KW = dict(kwp=100.0, rated_ac_kw=100.0, limit_kw=None, gamma_pct=0.0, factor=1.0, inverter_count=2)


def _row(hhmm, pac, g=800.0, imp=None, exp=None, day="2026-11-20"):
    return {"timestamp": f"{day} {hhmm}:00", "pac_kw": pac, "irradiance_wm2": g, "module_temp_c": 25.0,
            "grid_import_kw": imp, "grid_export_kw": exp, "inverters": 2}


def test_free_slots_need_midday_sun_and_a_real_import():
    # model = 80 kW. Free: 10:00 (import 60 > 30 % of 80), 11:00. Not free: import 20 (< 24 kW),
    # 08:00 (outside 09–15), POA 300 (< 400), meter ~0 (curtailed run)
    rows = [
        _row("10:00", 60, imp=60), _row("11:00", 64, imp=70), _row("12:00", 60, imp=20), _row("08:00", 40, imp=90),
        _row("13:00", 20, g=300.0, imp=90), _row("14:00", 40, imp=0.5, exp=0.0), _row("14:05", 40, imp=0.5, exp=0.0),
    ]
    s = gc.annotate(rows, **KW)
    assert s["free_slots"] == 2 and s["free_ratio"] == 0.775  # median of 0.75 and 0.80
    assert s["calibration"] == {"status": "not_checked", "ratio": None, "slots": 0, "days": gc.CALIBRATION_DAYS}


def test_calibration_scales_the_model_and_shrinks_the_estimate():
    rows = [_row("10:00", 50, imp=0.5, exp=0.0), _row("10:05", 50, imp=1.0, exp=0.0)]
    plain = gc.annotate([dict(r) for r in rows], **KW)
    s = gc.annotate(rows, **KW, calibration={"2026-11-20": {"ratio": 0.8, "slots": 40, "source": "plant"}})
    assert plain["kwh"] == 5.0  # 2 × (80 − 50) kW × 5 min
    assert [r["available_kw"] for r in rows] == [64.0, 64.0]  # 80 × 0.8 (still modelled)
    assert s["kwh"] == pytest.approx(2.3, abs=0.05)  # 2 × (64 − 50) × 5 min
    assert s["calibration"]["status"] == "plant" and s["calibration"]["ratio"] == 0.8


@pytest.fixture()
def db(tmp_path):
    engine = build_engine(f"sqlite:///{tmp_path / 'c.db'}")
    Base.metadata.create_all(bind=engine)
    with sessionmaker(bind=engine, expire_on_commit=False)() as s:
        s.add_all([GrowattPlant(plant_id=1, name="A", phase=1), GrowattPlant(plant_id=2, name="B", phase=2)])
        s.commit()
        yield s


def _pd(plant, d, **kw):
    return GrowattPlantDaily(plant_id=plant, day=d, **kw)


def test_calibration_uses_only_the_days_before_and_needs_enough_slots(db):
    db.add_all([
        _pd(1, date(2026, 11, 1), free_ratio=0.5, free_slots=10),  # outside the 14 days before the 20th
        _pd(1, date(2026, 11, 10), free_ratio=0.8, free_slots=6),
        _pd(1, date(2026, 11, 19), free_ratio=0.7, free_slots=6),
        _pd(1, date(2026, 11, 20), free_ratio=0.1, free_slots=50),  # the day itself: never used for itself
    ])
    db.commit()
    out = gc.calibration(db, 1, [date(2026, 11, 20), date(2026, 11, 3)])
    assert out["2026-11-20"] == {"ratio": 0.75, "slots": 12, "source": "plant"}  # (0.8×6 + 0.7×6) / 12
    assert out["2026-11-03"] == {"ratio": None, "slots": 10, "source": None}  # too few, and no fleet: the plain model
    assert gc.calibration(db, 2, [date(2026, 11, 20)])["2026-11-20"] == {"ratio": None, "slots": 0, "source": None}


def test_a_plant_without_free_slots_takes_the_fleet_ratio(db):
    db.add_all([GrowattPlant(plant_id=100 + i, name=f"P{i}") for i in range(10)])
    db.flush()
    db.add_all([_pd(100 + i, date(2026, 11, 19), free_ratio=0.8 if i < 5 else 0.9, free_slots=10) for i in range(10)])
    db.add(_pd(1, date(2026, 11, 19), free_ratio=0.5, free_slots=3))  # its own 3 slots count in the fleet too
    db.commit()
    assert gc.calibration(db, 1, [date(2026, 11, 20)])["2026-11-20"] == {"ratio": 0.84, "slots": 3, "source": "fleet"}
    # (0.8×50 + 0.9×50 + 0.5×3) / 103
    assert gc.calibration(db, 100, [date(2026, 11, 19)])["2026-11-19"]["source"] is None  # no rows before the 19th


def test_fleet_sums_ranks_and_scopes(db):
    db.add_all([
        _pd(1, date(2026, 11, 20), energy_kwh=900.0, curtailed_kwh=100.0, curtailed_slots=20, curtailed_export_kwh=100.0,
            curtailed_limit_kwh=0.0, curtail_ratio=0.8, curtail_ratio_slots=40, curtail_ratio_source="plant"),
        _pd(1, date(2026, 11, 21), energy_kwh=1000.0, curtailed_kwh=0.0, curtailed_slots=0, curtailed_export_kwh=0.0,
            curtailed_limit_kwh=0.0, curtail_ratio=0.8, curtail_ratio_slots=44, curtail_ratio_source="plant"),
        _pd(2, date(2026, 11, 20), energy_kwh=500.0, curtailed_kwh=None),  # no sensor: never judged
    ])
    db.commit()
    out = gc.fleet(db, date(2026, 11, 20), date(2026, 11, 21))
    a, b = out["plants"]
    assert (a["plant_id"], a["curtailed_kwh"], a["energy_kwh"], a["curtailed_pct"]) == (1, 100.0, 1900.0, 5.0)
    assert (a["curtailed_days"], a["judged_days"], a["last_curtailed_day"]) == (1, 2, "2026-11-20")
    assert a["calibration"] == {"ratio": 0.8, "slots": 44, "status": "plant"}
    assert b["plant_id"] == 2 and b["curtailed_kwh"] is None and b["calibration"]["status"] == "not_checked"
    assert out["summary"] == {"plants": 2, "judged_plants": 1, "curtailed_plants": 1, "plant_calibrated": 1,
                              "fleet_calibrated": 0, "curtailed_kwh": 100.0, "energy_kwh": 2400.0}
    assert [(d["day"], d["kwh"], d["plants"]) for d in out["days"]] == [("2026-11-20", 100.0, 1), ("2026-11-21", 0.0, 0)]
    assert [p["plant_id"] for p in gc.fleet(db, date(2026, 11, 20), date(2026, 11, 21), plant_ids=[2])["plants"]] == [2]


def test_fleet_route_scopes_engineers_and_checks_the_period(tmp_path):
    from fastapi.testclient import TestClient

    from app.db.models import User, UserPlantAssignment
    from app.db.seed import ensure_seeded
    from app.db.session import get_db
    from app.main import create_app

    engine = build_engine(f"sqlite:///{tmp_path / 'r.db'}")
    Base.metadata.create_all(bind=engine)
    f = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)
    with f() as s:
        ensure_seeded(s)
        s.add_all([GrowattPlant(plant_id=1, name="A"), GrowattPlant(plant_id=2, name="B")])
        s.flush()
        s.add_all([_pd(1, date(2026, 11, 20), curtailed_kwh=10.0), _pd(2, date(2026, 11, 20), curtailed_kwh=20.0)])
        eng = s.query(User).filter_by(username="engineer").one()
        s.add(UserPlantAssignment(user_id=eng.id, plant_id=1))
        s.commit()
    app = create_app()

    def _db():
        with f() as s:
            yield s

    app.dependency_overrides[get_db] = _db
    c = TestClient(app)

    def login(u, p):
        return {"Authorization": "Bearer " + c.post("/auth/login", json={"username": u, "password": p}).json()["access_token"]}

    q = "/growatt/curtailment?start=2026-11-20&end=2026-11-20"
    admin = c.get(q, headers=login("admin", "admin123")).json()
    assert [p["plant_id"] for p in admin["plants"]] == [2, 1]
    engineer = c.get(q, headers=login("engineer", "engineer123")).json()
    assert [p["plant_id"] for p in engineer["plants"]] == [1]
    h = login("admin", "admin123")
    assert c.get("/growatt/curtailment?start=2026-11-21&end=2026-11-20", headers=h).status_code == 422
    assert c.get("/growatt/curtailment?start=2026-01-01&end=2026-11-20", headers=h).status_code == 422


def _day_with_zero_export(db, day, hold_kw=None):
    """06:00–18:00 at 90 % of clear sky; the plant gives 70 % of 100 kWp × POA. With `hold_kw`, a
    zero-export controller holds the AC at that from 10:00 to 14:00 while the meter reads ~0 kW."""
    from datetime import datetime, timedelta

    from app.db.models import GrowattEnvReading, GrowattEnvSensor, GrowattInverter, GrowattInverterReading, GrowattMeter, GrowattMeterReading
    from solar_core.sun import clear_sky_ghi

    if db.get(GrowattInverter, "INV9") is None:
        db.add(GrowattPlant(plant_id=9, name="Zero export", latitude=13.75, longitude=100.5, peak_power_kwp=100.0))
        db.flush()
        db.add(GrowattInverter(device_sn="INV9", plant_id=9, nominal_power_w=100000.0))
        db.add(GrowattEnvSensor(datalogger_sn="DL9", address=1, plant_id=9, device_name="POA"))
        db.add(GrowattMeter(datalogger_sn="DL9", address=36, plant_id=9, device_name="CHNT_THREE"))
        db.flush()
    eac = 0.0
    t = datetime.combine(day, datetime.min.time()) + timedelta(hours=6)
    while t.hour < 18:
        irr = round(0.9 * clear_sky_ghi(day, 13.75, 100.5, t.hour * 60 + t.minute + 2.5), 1)
        free_w = 100.0 * min(irr, 1000.0) * 0.7
        held = hold_kw is not None and 10 <= t.hour < 14 and free_w > hold_kw * 1000
        pac_w = hold_kw * 1000.0 if held else free_w
        eac += pac_w * (5 / 60) / 1000
        db.add(GrowattEnvReading(datalogger_sn="DL9", address=1, timestamp=t, irradiance_wm2=irr, module_temp_c=50.0, ambient_temp_c=33.0))
        db.add(GrowattInverterReading(device_sn="INV9", timestamp=t, status=1, pac_w=pac_w, ppv_w=pac_w / 0.97, eac_today_kwh=round(eac, 3)))
        # held: the meter holds ~0; free: the site buys a steady 40 kW on top of the PV
        db.add(GrowattMeterReading(datalogger_sn="DL9", address=36, timestamp=t, active_power_w=300.0 if held else 40000.0))
        t += timedelta(minutes=5)
    db.commit()


def test_held_back_slots_are_masked_from_epi(db):
    from app.services import growatt_daily, growatt_overview

    free_day, held_day = date(2026, 11, 18), date(2026, 11, 19)
    _day_with_zero_export(db, free_day)
    _day_with_zero_export(db, held_day, hold_kw=30.0)
    growatt_daily.compute_day(db, free_day)
    growatt_daily.compute_day(db, held_day)
    db.expire_all()
    free, held = db.get(GrowattPlantDaily, (9, free_day)), db.get(GrowattPlantDaily, (9, held_day))
    assert held.curtailed_kwh and held.curtailed_kwh > 50 and held.curtailed_masked_slots >= 40
    # the slots following the load do not pull EPI down: the day reads as the free day does
    assert held.epi == pytest.approx(free.epi, abs=0.02)
    ov = growatt_overview.build_plant_overview(db, 9, held_day)
    assert ov["kpis"]["curtailment"]["kwh"] and ov["kpis"]["curtailment"]["kwh"] > 50
    assert ov["kpis"]["epi"] == pytest.approx(free.epi, abs=0.03)
