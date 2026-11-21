"""R16 weather-sensor health (docs/plans/decision-rules.md §5): stale readings, irradiance above
clear sky, and a sensor far below its neighbouring plants' sensors on a day Google calls clear.
A failing day greys out PR / PR' / EPI (overview `sensor_health`) and R10 skips it."""

from __future__ import annotations

from datetime import date, datetime, timedelta

import pytest
from sqlalchemy.orm import sessionmaker

from app.db.models import (
    AppSetting,
    GoogleWeatherHourly,
    GrowattEnvReading,
    GrowattEnvSensor,
    GrowattInverter,
    GrowattInverterReading,
    GrowattIssue,
    GrowattPlant,
    GrowattPlantDaily,
)
from app.db.session import Base, build_engine
from app.services import growatt_daily, growatt_issues, growatt_overview, growatt_rules
from app.services.google_weather import cell_of
from solar_core.sun import clear_sky_ghi

DAY = date(2026, 11, 10)
LAT, LON = 13.75, 100.5


@pytest.fixture()
def db(tmp_path):
    engine = build_engine(f"sqlite:///{tmp_path / 'r16.db'}")
    Base.metadata.create_all(bind=engine)
    f = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)
    with f() as s:
        yield s


def _sky(share: float = 0.9):
    """Irradiance at `share` of clear sky (with a little jitter so it is never stale)."""
    return lambda t: round(share * clear_sky_ghi(t.date(), LAT, LON, t.hour * 60 + t.minute + 2.5), 1) + (t.minute // 5) % 3


def _plant(db, pid: int, lat: float = LAT, lon: float = LON, g=_sky(), day: date = DAY):
    """A 100 kWp plant with one inverter and one sensor, 08:00–16:00 readings; `g(t)` = irradiance."""
    if db.get(GrowattPlant, pid) is None:
        db.add(GrowattPlant(plant_id=pid, name=f"Plant {pid}", latitude=lat, longitude=lon, peak_power_kwp=100.0))
        db.flush()
        db.add(GrowattInverter(device_sn=f"INV{pid}", plant_id=pid, nominal_power_w=100000.0))
        db.add(GrowattEnvSensor(datalogger_sn=f"DL{pid}", address=1, plant_id=pid, device_name="POA"))
        db.flush()
    eac = 0.0
    t = datetime.combine(day, datetime.min.time()) + timedelta(hours=8)
    while t < datetime.combine(day, datetime.min.time()) + timedelta(hours=16):
        irr = g(t)
        pac_w = 100.0 * min(irr, 1000.0) * 0.8
        eac += pac_w * (5 / 60) / 1000
        db.add(GrowattEnvReading(datalogger_sn=f"DL{pid}", address=1, timestamp=t, irradiance_wm2=irr,
                                 module_temp_c=50.0, ambient_temp_c=33.0))
        db.add(GrowattInverterReading(device_sn=f"INV{pid}", timestamp=t, status=1, pac_w=pac_w,
                                      ppv_w=pac_w / 0.97, eac_today_kwh=round(eac, 3)))
        t += timedelta(minutes=5)
    db.commit()


def _cloud(db, lat: float, lon: float, pct: float, day: date = DAY):
    key = cell_of(lat, lon)[0]
    for h in range(6, 18):
        db.merge(GoogleWeatherHourly(cell_key=key, hour=datetime.combine(day, datetime.min.time()) + timedelta(hours=h),
                                     cloud_cover_pct=pct))
    db.commit()


def _r16(db, day: date = DAY):
    return {f["plant_id"]: f for f in growatt_rules.evaluate(db, day) if f["rule"] == "R16"}


def test_clear_sky_model_moved_to_solar_core_keeps_the_pwa_values():
    from app.services.pwa_sheet import clear_sky

    assert clear_sky(LAT, LON, DAY, 12, 0) == pytest.approx(clear_sky_ghi(DAY, LAT, LON, 720))
    assert 800 < clear_sky_ghi(DAY, LAT, LON, 720) < 950  # Bangkok noon, November
    assert clear_sky_ghi(DAY, LAT, LON, 3 * 60) == 0.0


def test_healthy_sensor_has_evidence_and_no_finding(db):
    _plant(db, 1)
    growatt_daily.compute_day(db, DAY)
    row = db.get(GrowattPlantDaily, (1, DAY))
    assert row.sensor_stale_slots == 0 and row.sensor_high_slots == 0
    assert row.sensor_midday_slots == 48 and 700 < row.sensor_midday_wm2 < 850
    assert row.cloud_midday_pct is None  # no Google hours stored: no neighbour verdict
    assert _r16(db) == {}
    health = growatt_overview.build_plant_overview(db, 1, DAY)["kpis"]["sensor_health"]
    assert health == {"ok": True, "flags": [], "reasons": []}


def test_no_sensor_reading_means_no_verdict(db):
    db.add(GrowattPlant(plant_id=1, name="No sensor", latitude=LAT, longitude=LON, peak_power_kwp=100.0))
    db.commit()
    growatt_daily.compute_day(db, DAY)
    row = db.get(GrowattPlantDaily, (1, DAY))
    assert row is None or row.sensor_stale_slots is None
    assert growatt_rules.sensor_verdict(row, growatt_rules.rule_settings(db)) is None


def _frozen(t):
    """Frozen at one non-zero value 10:00–14:00 (forward-filled by the logger)."""
    return 650.0 if 10 <= t.hour < 14 else _sky()(t)


def test_frozen_sensor_is_stale(db):
    _plant(db, 1, g=_frozen)
    growatt_daily.compute_day(db, DAY)
    f = _r16(db)[1]
    assert f["tier"] == "P3" and f["lost_kwh_est"] is None and f["shadow"] is True
    assert f["evidence"]["flags"] == ["stale"]
    assert f["evidence"]["stale_slots"] >= 12
    health = growatt_overview.build_plant_overview(db, 1, DAY)["kpis"]["sensor_health"]
    assert health["ok"] is False and health["flags"] == ["stale"]


def test_short_stale_run_is_below_the_threshold(db):
    # one 15-min run of identical readings at 11:00 (a logger hiccup), the rest varies
    _plant(db, 1, g=lambda t: 777.0 if t.hour == 11 and t.minute < 15 else _sky()(t))
    growatt_daily.compute_day(db, DAY)
    assert db.get(GrowattPlantDaily, (1, DAY)).sensor_stale_slots == 3
    assert _r16(db) == {}


def test_irradiance_above_clear_sky(db):
    _plant(db, 1, g=lambda t: 1400.0 + (t.minute // 5) % 3 if 10 <= t.hour < 14 else _sky()(t))
    growatt_daily.compute_day(db, DAY)
    f = _r16(db)[1]
    assert f["evidence"]["flags"] == ["above_clear_sky"]
    assert f["evidence"]["high_slots"] >= 6


def _neighbourhood(db, low: float, cloud: float):
    """Four plants ~10 km apart; plant 1's sensor reads `low` × clear sky, the others 0.9 ×."""
    for pid, (dlat, dlon) in enumerate([(0, 0), (0.08, 0), (0, 0.08), (-0.08, 0.02)], start=1):
        _plant(db, pid, LAT + dlat, LON + dlon, g=_sky(low if pid == 1 else 0.9))
        _cloud(db, LAT + dlat, LON + dlon, cloud)
    growatt_daily.compute_day(db, DAY)


def test_sensor_far_below_neighbours_on_a_clear_day(db):
    _neighbourhood(db, low=0.45, cloud=10.0)
    row = db.get(GrowattPlantDaily, (1, DAY))
    assert row.sensor_neighbours == 3
    assert row.sensor_neighbour_ratio == pytest.approx(0.5, abs=0.01)
    assert row.cloud_midday_pct == 10.0
    found = _r16(db)
    assert set(found) == {1}
    assert found[1]["evidence"]["flags"] == ["below_neighbours"]
    assert found[1]["evidence"]["neighbour_judged"] is True


def test_neighbour_check_waits_for_a_clear_day(db):
    _neighbourhood(db, low=0.45, cloud=60.0)  # cloudy: local shade differences are normal
    assert db.get(GrowattPlantDaily, (1, DAY)).sensor_neighbour_ratio == pytest.approx(0.5, abs=0.01)
    assert _r16(db) == {}


def test_too_few_neighbours_gives_no_ratio(db):
    _plant(db, 1, g=_sky(0.45))
    _plant(db, 2, LAT + 0.05, LON)
    _plant(db, 3, LAT + 3.0, LON)  # ~330 km away
    _cloud(db, LAT, LON, 5.0)
    growatt_daily.compute_day(db, DAY)
    row = db.get(GrowattPlantDaily, (1, DAY))
    assert row.sensor_neighbours == 1 and row.sensor_neighbour_ratio is None
    assert _r16(db) == {}


def test_thresholds_are_settings_and_rule_can_be_disabled(db):
    _plant(db, 1, g=_frozen)
    growatt_daily.compute_day(db, DAY)
    assert 1 in _r16(db)
    db.add(AppSetting(key="decision_rules", value={"r16_stale_slots": 1000}))
    db.commit()
    assert _r16(db) == {}
    row = db.get(AppSetting, "decision_rules")
    row.value = {"rules": {"R16": {"enabled": False}}}
    db.commit()
    assert _r16(db) == {}


def _epi_history(db, pid: int, end: date, today_epi: float):
    for k in range(15, 0, -1):
        db.merge(GrowattPlantDaily(plant_id=pid, day=end - timedelta(days=k), capacity_kwp=100.0, energy_kwh=450.0,
                                   epi=0.96 + (0.005 if k % 2 else -0.005), filtered_slots=50, sensor_stale_slots=0))
    db.merge(GrowattPlantDaily(plant_id=pid, day=end, capacity_kwp=100.0, energy_kwh=380.0, epi=today_epi,
                               filtered_slots=50, sensor_stale_slots=0))
    db.commit()


def test_r10_skips_a_day_whose_sensor_failed(db):
    db.add(GrowattPlant(plant_id=1, name="P", latitude=LAT, longitude=LON, peak_power_kwp=100.0))
    db.commit()
    _epi_history(db, 1, DAY, today_epi=0.82)
    rules = {f["rule"] for f in growatt_rules.evaluate(db, DAY)}
    assert "R10" in rules and "R16" not in rules
    db.get(GrowattPlantDaily, (1, DAY)).sensor_stale_slots = 40  # the low EPI came from a frozen sensor
    db.commit()
    rules = {f["rule"] for f in growatt_rules.evaluate(db, DAY)}
    assert "R16" in rules and "R10" not in rules


def test_r16_issue_closes_only_after_days_the_sensor_was_judged(db):
    _plant(db, 1, g=_frozen)
    growatt_daily.compute_day(db, DAY)
    growatt_issues.sync(db, DAY, growatt_rules.evaluate(db, DAY))
    issue = db.query(GrowattIssue).filter_by(rule="R16").one()
    assert issue.status == "open" and issue.device_sn is None

    # two following days without any sensor reading: no verdict, so the issue stays open
    for k in (1, 2):
        d = DAY + timedelta(days=k)
        growatt_daily.compute_day(db, d)
        growatt_issues.sync(db, d, growatt_rules.evaluate(db, d))
    db.refresh(issue)
    assert issue.status == "open"

    # two healthy days: auto-closed
    for k in (3, 4):
        d = DAY + timedelta(days=k)
        _plant(db, 1, day=d)
        growatt_daily.compute_day(db, d)
        growatt_issues.sync(db, d, growatt_rules.evaluate(db, d))
    db.refresh(issue)
    assert issue.status != "open" and issue.close_reason == "auto"
