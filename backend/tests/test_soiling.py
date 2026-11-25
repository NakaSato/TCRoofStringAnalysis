"""Soiling: cleaning steps and R13 incomplete recovery after rain (services/soiling.py,
docs/plans/decision-rules.md §6)."""

from __future__ import annotations

from datetime import date, datetime, timedelta

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import sessionmaker

from app.db.models import (
    GoogleWeatherHourly,
    GrowattPlant,
    GrowattPlantDaily,
    GrowattPlantEpiFit,
    OmPlantSettings,
    SiteEvent,
    User,
    UserPlantAssignment,
)
from app.db.seed import ensure_seeded
from app.db.session import Base, build_engine, get_db
from app.main import create_app
from app.services import epi_fit, google_weather, growatt_rules, om_center, soiling

LAT, LON = 13.75, 100.5
PID = 7001
CLEAN = date(2026, 11, 1)


@pytest.fixture()
def factory(tmp_path):
    engine = build_engine(f"sqlite:///{tmp_path / 'soil.db'}")
    Base.metadata.create_all(bind=engine)
    return sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)


@pytest.fixture()
def db(factory):
    with factory() as s:
        s.add(GrowattPlant(plant_id=PID, name="Soil plant", latitude=LAT, longitude=LON, peak_power_kwp=100.0))
        s.commit()
        yield s


def _day(db, day: date, epi: float, clearness: float = 0.9, energy: float = 500.0):
    yr = clearness * epi_fit.clear_sky_kwh_m2(day, LAT, LON)
    db.add(GrowattPlantDaily(plant_id=PID, day=day, epi=epi, yr_h=yr, energy_kwh=energy, filtered_slots=60))


def _rain(db, day: date, mm: float):
    """A complete stored daytime (06–18) with `mm` of rain in the noon hour."""
    key = google_weather.cell_of(LAT, LON)[0]
    for h in range(6, 18):
        db.add(GoogleWeatherHourly(cell_key=key, hour=datetime(day.year, day.month, day.day, h), precip_mm=mm if h == 12 else 0.0))


def _cleaning(db, day: date, **kw):
    db.add(SiteEvent(plant_id=PID, event_type="cleaning", day=day, **kw))


def _span(start: date, n: int):
    return [start + timedelta(days=k) for k in range(n)]


CFG = dict(growatt_rules.DEFAULT_RULES)


def test_cleaning_step_compares_good_days_before_and_after(db):
    prev = CLEAN - timedelta(days=21)
    _cleaning(db, prev)
    _cleaning(db, CLEAN, cost_thb=4000)
    cloudy = CLEAN - timedelta(days=3)
    for d in _span(CLEAN - timedelta(days=10), 10):
        # a cloudy day is not a good day: its high EPI is ignored
        _day(db, d, 1.30 if d == cloudy else 0.90, clearness=0.3 if d == cloudy else 0.9)
    for d in _span(CLEAN + timedelta(days=1), 6):
        _day(db, d, 0.99)
    for d in _span(prev, 30):  # rain record complete, dry
        _rain(db, d, 0.0)
    db.commit()

    out = soiling.plant_soiling(db, PID, CLEAN + timedelta(days=10), 30, CFG)
    step = out["cleanings"][0]
    assert step["day"] == CLEAN.isoformat() and step["status"] == "measured"
    assert step["epi_before"] == 0.9 and step["epi_after"] == 0.99
    assert step["step_pct"] == pytest.approx(10.0, abs=0.01)
    assert len(step["before_days"]) == 5 and len(step["after_days"]) == 5
    assert cloudy.isoformat() not in step["before_days"]
    # 10 % over the 21 days since the previous cleaning
    assert step["soiling_rate_pct_per_day"] == pytest.approx(10.0 / 21, abs=0.001)
    assert step["rain_between"] == []
    assert out["summary"]["measured"] == 1


def test_step_waits_for_after_days_and_flags_rain(db):
    _cleaning(db, CLEAN)
    for d in _span(CLEAN - timedelta(days=5), 5):
        _day(db, d, 0.9)
    _day(db, CLEAN + timedelta(days=1), 0.97)
    db.commit()
    step = soiling.plant_soiling(db, PID, CLEAN + timedelta(days=2), 30, CFG)["cleanings"][0]
    assert step["status"] == "waiting" and step["step_pct"] is None
    assert step["rate_reason"] is None

    for d in _span(CLEAN + timedelta(days=2), 3):
        _day(db, d, 0.97)
    _rain(db, CLEAN - timedelta(days=1), 15.0)
    db.commit()
    step = soiling.plant_soiling(db, PID, CLEAN + timedelta(days=6), 30, CFG)["cleanings"][0]
    assert step["status"] == "measured"
    assert step["rain_between"] == [{"day": (CLEAN - timedelta(days=1)).isoformat(), "rain_mm": 15.0}]
    # the heavy rain the day before is the last reset: the step is spread over 1 day
    assert step["soiling_rate_pct_per_day"] == pytest.approx(step["step_pct"], abs=0.01)


def test_no_epi_no_step(db):
    _cleaning(db, CLEAN)
    db.commit()
    step = soiling.plant_soiling(db, PID, CLEAN + timedelta(days=5), 30, CFG)["cleanings"][0]
    assert step["status"] == "no_epi" and step["step_pct"] is None


def _soiled_after_rain(db, after: float):
    """Cleaned on CLEAN (EPI 1.0 after), soiled to 0.90 by the rain day, then `after`."""
    _cleaning(db, CLEAN)
    for d in _span(CLEAN + timedelta(days=1), 4):
        _day(db, d, 1.0)
    for d in _span(CLEAN + timedelta(days=5), 10):
        _day(db, d, 0.95)
    rain_day = CLEAN + timedelta(days=20)
    for d in _span(rain_day - timedelta(days=5), 5):
        _day(db, d, 0.90)
    _rain(db, rain_day, 22.0)
    _day(db, rain_day, 0.80, clearness=0.2)
    for d in _span(rain_day + timedelta(days=1), 3):
        _day(db, d, after)
    db.commit()
    return rain_day + timedelta(days=3)


def test_r13_fires_when_rain_left_the_dirt(db):
    day = _soiled_after_rain(db, 0.92)
    v = soiling.r13_verdicts(db, day, None, CFG)[PID]
    assert v["fires"] and v["clean_basis"] == "cleaning" and v["clean_day"] == CLEAN.isoformat()
    assert v["epi_clean"] == 1.0 and v["epi_before"] == 0.9 and v["epi_after"] == 0.92
    assert v["recovery_pct"] == pytest.approx(20.0, abs=0.1)

    findings = [f for f in growatt_rules.evaluate(db, day) if f["rule"] == "R13"]
    assert len(findings) == 1
    f = findings[0]
    assert f["tier"] == "P3" and f["shadow"] is True
    assert f["lost_kwh_est"] == pytest.approx(500.0 * 0.08 / 0.92, abs=0.01)


def test_r13_quiet_when_the_rain_washed_it(db):
    day = _soiled_after_rain(db, 0.98)
    v = soiling.r13_verdicts(db, day, None, CFG)[PID]
    assert not v["fires"] and v["recovery_pct"] == pytest.approx(80.0, abs=0.1)
    assert not [f for f in growatt_rules.evaluate(db, day) if f["rule"] == "R13"]


def test_r13_needs_a_clean_reference(db):
    rain_day = CLEAN + timedelta(days=10)
    for d in _span(rain_day - timedelta(days=5), 5):
        _day(db, d, 0.90)
    _rain(db, rain_day, 22.0)
    for d in _span(rain_day + timedelta(days=1), 3):
        _day(db, d, 0.91)
    db.commit()
    day = rain_day + timedelta(days=3)
    assert soiling.r13_verdicts(db, day, None, CFG) == {}  # no cleaning, no fitted factor: no verdict

    db.add(GrowattPlantEpiFit(plant_id=PID, status="fitted", factor=0.8))
    db.commit()
    v = soiling.r13_verdicts(db, day, None, CFG)[PID]
    assert v["clean_basis"] == "epi_fit" and v["epi_clean"] == 1.0 and v["fires"]


def test_attribution_counts_soiling_after_inverter_loss():
    entries = [
        (PID, "INV", None, "R8", 30.0, 120.0),
        (PID, None, None, "R13", 50.0, 200.0),
        (PID, None, None, "R10", 70.0, 280.0),
    ]
    loss = om_center.attribute(entries)[PID]
    assert loss["down"][0] == 30.0
    assert loss["soiling"][0] == pytest.approx(20.0)
    assert loss["plant"][0] == pytest.approx(20.0)


def test_route_scoped_and_hides_shadow_r13_from_engineers(factory, monkeypatch):
    day = None
    with factory() as s:
        ensure_seeded(s)
        s.add(GrowattPlant(plant_id=PID, name="Soil plant", latitude=LAT, longitude=LON, peak_power_kwp=100.0))
        s.add(GrowattPlant(plant_id=PID + 1, name="Other"))
        s.commit()
        day = _soiled_after_rain(s, 0.92)
        eng = s.scalars(select(User).where(User.username == "engineer")).one()
        s.add(UserPlantAssignment(user_id=eng.id, plant_id=PID))
        s.commit()
    monkeypatch.setattr(soiling, "local_today", lambda: day)
    app = create_app()

    def override():
        with factory() as s:
            yield s

    app.dependency_overrides[get_db] = override
    client = TestClient(app)

    def hdr(u, p):
        return {"Authorization": "Bearer " + client.post("/auth/login", json={"username": u, "password": p}).json()["access_token"]}

    admin, eng_h = hdr("admin", "admin123"), hdr("engineer", "engineer123")
    body = client.get(f"/growatt/plants/{PID}/soiling?days=30", headers=admin).json()
    assert body["meta"]["source"] == "db" and body["r13"]["fires"] is True
    assert body["cleanings"][0]["day"] == CLEAN.isoformat() and len(body["days"]) == 30
    e = client.get(f"/growatt/plants/{PID}/soiling", headers=eng_h).json()
    assert e["r13"] is None and e["r13_rule"]["shadow"] is True and e["cleanings"]
    assert "wallet" in body and e["wallet"] is None and e["r12_rule"]["shadow"] is True
    assert client.get(f"/growatt/plants/{PID + 1}/soiling", headers=eng_h).status_code == 404


# --------------------------------------------------------------------------- R12 soiling wallet


class _Pricer:
    def thb(self, plant_id, kwh, on_peak_kwh):
        return None if kwh is None else kwh * 4.0


def _dry(start: date, n: int):
    return {start + timedelta(days=k): 0.0 for k in range(n)}


def _wallet(day, events, rain, energy=1000.0, rate=(1.0, "plant"), cost=(100.0, "plant_setting")):
    en = {CLEAN + timedelta(days=k): energy for k in range(1, 60)}
    return soiling.wallet(PID, day, events, rain, en, rate, cost, _Pricer(), CFG)


def test_wallet_sums_the_linear_soiling_loss_since_the_cleaning():
    ev = [SiteEvent(id=1, plant_id=PID, event_type="cleaning", day=CLEAN)]
    w = _wallet(CLEAN + timedelta(days=3), ev, _dry(CLEAN, 3))
    lost = [1000 * s / (1 - s) for s in (0.01, 0.02, 0.03)]
    assert w["status"] == "ok" and w["reset_by"] == "cleaning" and w["days_since_reset"] == 3
    assert w["wallet_kwh"] == pytest.approx(sum(lost), abs=0.1)
    assert w["wallet_thb"] == pytest.approx(round(sum(lost) * 4), abs=1)
    assert w["day_lost_kwh"] == pytest.approx(lost[-1], abs=0.01) and w["soiling_pct"] == 3.0
    assert w["fires"] is True and w["optimal_interval_days"] is not None

    # same wallet in the monsoon: no suggestion
    jun = date(2026, 6, 1)
    w = _wallet(jun + timedelta(days=3), [SiteEvent(id=1, plant_id=PID, event_type="cleaning", day=jun)], _dry(jun, 3))
    assert w["monsoon"] is True and w["fires"] is False


def test_wallet_resets_on_heavy_rain_and_needs_the_rain_record():
    ev = [SiteEvent(id=1, plant_id=PID, event_type="cleaning", day=CLEAN)]
    rain = _dry(CLEAN, 10)
    rain[CLEAN + timedelta(days=8)] = 15.0
    w = _wallet(CLEAN + timedelta(days=10), ev, rain)
    assert w["reset_by"] == "rain" and w["days_since_reset"] == 2

    gap = _dry(CLEAN, 10)
    gap[CLEAN + timedelta(days=4)] = None  # hours missing: a heavy rain may be hidden
    w = _wallet(CLEAN + timedelta(days=10), ev, gap)
    assert w["status"] == "rain_unknown" and w["wallet_thb"] is None and not w["fires"]


def test_wallet_needs_rate_reset_and_cost():
    ev = [SiteEvent(id=1, plant_id=PID, event_type="cleaning", day=CLEAN)]
    day = CLEAN + timedelta(days=3)
    assert _wallet(day, ev, _dry(CLEAN, 3), rate=None)["status"] == "no_rate"
    part = [SiteEvent(id=2, plant_id=PID, event_type="cleaning", day=CLEAN, device_sn="INV")]
    assert _wallet(day, part, _dry(CLEAN, 3))["status"] == "no_reset"  # one inverter is not the plant
    w = _wallet(day, ev, _dry(CLEAN, 3), cost=None)
    assert w["status"] == "ok" and w["wallet_thb"] and w["fires"] is False and w["cost_thb"] is None


def test_r12_fires_from_the_measured_rate_and_entered_cost(db):
    prev = CLEAN - timedelta(days=21)
    _cleaning(db, prev)
    _cleaning(db, CLEAN, cost_thb=4000)
    for d in _span(CLEAN - timedelta(days=10), 10):
        _day(db, d, 0.90)
    for d in _span(CLEAN + timedelta(days=1), 25):
        _day(db, d, 0.99, energy=3000.0)
    for d in _span(prev, 50):
        _rain(db, d, 0.0)
    db.commit()
    day = CLEAN + timedelta(days=25)
    w = soiling.wallets(db, day, None, CFG, growatt_rules.load_pricer(db))[PID]
    assert w["rate_basis"] == "plant" and w["rate_pct_per_day"] == pytest.approx(10.0 / 21, abs=0.001)
    assert w["cost_thb"] == 4000 and w["cost_basis"] == "site_log" and w["wallet_thb"] >= 4000
    f = [f for f in growatt_rules.evaluate(db, day) if f["rule"] == "R12"]
    assert len(f) == 1 and f[0]["tier"] == "P3" and f[0]["shadow"] is True
    assert f[0]["evidence"]["wallet_thb"] == w["wallet_thb"] and f[0]["lost_kwh_est"] == w["day_lost_kwh"]

    # an entered planning cost wins over the Site log's
    db.add(OmPlantSettings(plant_id=PID, cleaning_cost_thb=1_000_000))
    db.commit()
    w = soiling.wallets(db, day, None, CFG, growatt_rules.load_pricer(db))[PID]
    assert w["cost_basis"] == "plant_setting" and not w["fires"]


def test_attribution_takes_the_larger_soiling_rule():
    entries = [(PID, None, None, "R12", 40.0, 160.0), (PID, None, None, "R13", 25.0, 100.0)]
    assert om_center.attribute(entries)[PID]["soiling"][0] == pytest.approx(40.0)
