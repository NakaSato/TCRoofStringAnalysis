"""EPI system factor fitted per plant (services/epi_fit.py, docs/plans/decision-rules.md §5.1)."""

from __future__ import annotations

from datetime import date, datetime, timedelta

import pytest
from sqlalchemy import select
from sqlalchemy.orm import sessionmaker

from app.db.models import (
    GrowattEnvReading,
    GrowattEnvSensor,
    GrowattInverter,
    GrowattInverterDaily,
    GrowattInverterReading,
    GrowattPlant,
    GrowattPlantDaily,
    GrowattPlantEpiFit,
)
from app.db.session import Base, build_engine
from app.services import epi_fit, growatt_daily, growatt_overview, jobs
from solar_core.sun import clear_sky_ghi

LAT, LON = 13.75, 100.5
END = date(2026, 11, 20)


@pytest.fixture()
def db(tmp_path):
    engine = build_engine(f"sqlite:///{tmp_path / 'epi.db'}")
    Base.metadata.create_all(bind=engine)
    f = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)
    with f() as s:
        yield s


def _plant_row(db, pid: int = 1, lat: "float | None" = LAT, lon: "float | None" = LON):
    db.add(GrowattPlant(plant_id=pid, name=f"Plant {pid}", latitude=lat, longitude=lon, peak_power_kwp=100.0))
    db.commit()


def _day_row(db, pid: int, day: date, raw: float, clearness: float = 0.9, slots: int = 60, **kw):
    """A stored plant day whose measured ÷ modelled-without-factor is `raw` (default factor)."""
    yr = clearness * epi_fit.clear_sky_kwh_m2(day, LAT, LON)
    f = epi_fit.DEFAULT_SYSTEM_FACTOR
    db.add(GrowattPlantDaily(plant_id=pid, day=day, epi=round(raw / f, 4), system_factor=f, yr_h=yr,
                             modelled_energy_kwh=500.0, filtered_slots=slots, **kw))


def _days(n: int, end: date = END):
    return [end - timedelta(days=k) for k in range(n)]


def test_fit_takes_the_median_of_the_clearest_days_and_rescales_history(db):
    _plant_row(db)
    raws = [0.70, 0.72, 0.74, 0.73, 0.71, 0.75, 0.74, 0.72, 0.73, 0.74]
    for d, r in zip(_days(10), raws):
        _day_row(db, 1, d, r)
    # cloudy days (clearness below 0.7) are not used, even with a high ratio
    for d in _days(5, END - timedelta(days=10)):
        _day_row(db, 1, d, 0.95, clearness=0.4)
    db.commit()

    out = epi_fit.fit(db, END)
    assert out["fitted"] == 1 and out["rescaled_rows"] == 15
    fit = db.get(GrowattPlantEpiFit, 1)
    assert fit.status == "fitted" and fit.days_used == 10 and fit.candidate_days == 10
    assert fit.factor == pytest.approx(0.73, abs=1e-4)
    assert epi_fit.active_factor(db, 1) == pytest.approx(0.73, abs=1e-4)
    rows = {r.day: r for r in db.scalars(select(GrowattPlantDaily))}
    # stored EPI is now on the plant's factor: its clear days sit around 1.0
    assert rows[END].epi == pytest.approx(0.70 / 0.73, abs=1e-3)
    assert rows[END].system_factor == pytest.approx(0.73)
    assert rows[END].modelled_energy_kwh == pytest.approx(500.0 * 0.73 / 0.985, abs=0.01)

    # a fitted plant is left alone by the daily run; epi_refit fits again
    db.get(GrowattPlantDaily, (1, END)).epi = round(0.90 / 0.73, 4)
    db.commit()
    assert epi_fit.fit(db, END)["plants"] == 0
    assert epi_fit.fit(db, END, refit=True)["fitted"] == 1


def test_too_few_good_days_keeps_the_default(db):
    _plant_row(db)
    for d in _days(9):
        _day_row(db, 1, d, 0.74)
    _day_row(db, 1, END - timedelta(days=9), 0.74, slots=20)  # too few filtered slots
    db.commit()
    epi_fit.fit(db, END)
    fit = db.get(GrowattPlantEpiFit, 1)
    assert fit.status == "too_few_days" and fit.candidate_days == 9 and "10 needed" in fit.reason
    assert epi_fit.active_factor(db, 1) == epi_fit.DEFAULT_SYSTEM_FACTOR
    assert db.get(GrowattPlantDaily, (1, END)).epi == pytest.approx(0.74 / 0.985, abs=1e-4)


def test_days_with_downtime_or_a_failed_sensor_are_not_used(db):
    _plant_row(db)
    for d in _days(12):
        _day_row(db, 1, d, 0.74)
    db.add(GrowattInverterDaily(plant_id=1, device_sn="A", day=END, fault_min=40, off_min=0, standby_min=0,
                                no_data_min=0, producing_min=560, limited_min=0, daylight_min=600))
    db.flush()
    db.get(GrowattPlantDaily, (1, END - timedelta(days=1))).sensor_stale_slots = 50  # R16 stale
    db.commit()
    epi_fit.fit(db, END)
    assert db.get(GrowattPlantEpiFit, 1).candidate_days == 10


def test_implausible_or_scattered_fits_are_rejected(db):
    _plant_row(db, 1)
    _plant_row(db, 2)
    for d in _days(10):
        _day_row(db, 1, d, 0.30)  # e.g. a kWp three times too big
    for d, r in zip(_days(10), [0.5, 0.9, 0.55, 0.95, 0.6, 0.85, 0.5, 0.9, 0.6, 0.95]):
        _day_row(db, 2, d, r)
    db.commit()
    out = epi_fit.fit(db, END)
    assert out["rejected"] == 2
    one, two = db.get(GrowattPlantEpiFit, 1), db.get(GrowattPlantEpiFit, 2)
    assert "outside" in one.reason and one.factor == pytest.approx(0.30)
    assert "disagree" in two.reason
    assert epi_fit.active_factors(db) == {}
    # the odd EPI stays visible on the default factor
    assert db.get(GrowattPlantDaily, (1, END)).epi == pytest.approx(0.30 / 0.985, abs=1e-4)


def test_no_coordinates_no_fit(db):
    _plant_row(db, 1, lat=None, lon=None)
    for d in _days(10):
        _day_row(db, 1, d, 0.74)
    db.commit()
    epi_fit.fit(db, END)
    assert db.get(GrowattPlantEpiFit, 1).status == "too_few_days"


def _readings(db, pid: int, day: date, share: float = 0.9):
    """06:00–18:00 sensor + inverter readings at `share` of clear sky (as in test_sensor_health)."""
    if db.get(GrowattPlant, pid) is None:
        _plant_row(db, pid)
        db.add(GrowattInverter(device_sn=f"INV{pid}", plant_id=pid, nominal_power_w=100000.0))
        db.add(GrowattEnvSensor(datalogger_sn=f"DL{pid}", address=1, plant_id=pid, device_name="POA"))
        db.flush()
    eac = 0.0
    t = datetime.combine(day, datetime.min.time()) + timedelta(hours=6)
    while t.hour < 18:
        irr = round(share * clear_sky_ghi(day, LAT, LON, t.hour * 60 + t.minute + 2.5), 1) + (t.minute // 5) % 3
        pac_w = 100.0 * min(irr, 1000.0) * 0.7
        eac += pac_w * (5 / 60) / 1000
        db.add(GrowattEnvReading(datalogger_sn=f"DL{pid}", address=1, timestamp=t, irradiance_wm2=irr,
                                 module_temp_c=50.0, ambient_temp_c=33.0))
        db.add(GrowattInverterReading(device_sn=f"INV{pid}", timestamp=t, status=1, pac_w=pac_w,
                                      ppv_w=pac_w / 0.97, eac_today_kwh=round(eac, 3)))
        t += timedelta(minutes=5)
    db.commit()


def test_daily_rows_and_overview_use_the_fitted_factor(db):
    days = _days(10)
    for d in days:
        _readings(db, 1, d)
        growatt_daily.compute_day(db, d)
    before = db.get(GrowattPlantDaily, (1, END))
    assert before.system_factor == epi_fit.DEFAULT_SYSTEM_FACTOR and before.epi is not None
    epi_fit.fit(db, END)
    factor = epi_fit.active_factor(db, 1)
    assert factor != epi_fit.DEFAULT_SYSTEM_FACTOR
    # a recomputed day lands on the same scale as the rescaled history
    rescaled = db.get(GrowattPlantDaily, (1, END)).epi
    growatt_daily.compute_day(db, END)
    db.expire_all()
    row = db.get(GrowattPlantDaily, (1, END))
    assert row.system_factor == pytest.approx(factor) and row.epi == pytest.approx(rescaled, abs=2e-3)
    assert row.epi == pytest.approx(1.0, abs=0.02)

    k = growatt_overview.build_plant_overview(db, 1, END)["kpis"]
    assert k["epi_factor"]["basis"] == "fitted" and k["epi_factor"]["factor"] == pytest.approx(factor)
    assert k["epi"] == pytest.approx(1.0, abs=0.03)


def test_rules_yesterday_fits_and_refit_job_exists(db, monkeypatch):
    for d in _days(10):
        _readings(db, 1, d)
    monkeypatch.setattr(jobs, "_today", lambda: END + timedelta(days=1))
    for d in sorted(_days(10))[:-1]:
        growatt_daily.compute_day(db, d)
    status, detail = jobs.job_rules_yesterday(db)
    assert detail["epi_fit"]["fitted"] == 1
    assert "epi_refit" in jobs.JOBS
    status, detail = jobs.JOBS["epi_refit"](db)
    assert status == "ok" and detail["epi_fit"]["fitted"] == 1
