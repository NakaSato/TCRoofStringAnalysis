"""Growatt plant capacity sanity check: impossible `peak_power` is treated as unknown."""
from __future__ import annotations

from sqlalchemy.orm import sessionmaker

from app.db.models import Base, GrowattInverter, GrowattPlant
from app.db.session import build_engine
from app.services.growatt_overview import (
    build_plant_overview,
    list_plants_summary,
    plant_rated_ac_w,
    plausible_capacity_kwp,
)


def test_plausible_capacity_rules():
    assert plausible_capacity_kwp(140.22, 125_000.0) == 140.22
    assert plausible_capacity_kwp(140_220.0, 125_000.0) is None  # entered in W at Growatt
    assert plausible_capacity_kwp(375.0, 125_000.0) == 375.0  # exactly 3x: kept
    assert plausible_capacity_kwp(140_220.0, None) == 140_220.0  # rating unknown: kept as reported
    assert plausible_capacity_kwp(0.0, 125_000.0) is None
    assert plausible_capacity_kwp(None, 125_000.0) is None


def _db(tmp_path):
    engine = build_engine(f"sqlite:///{tmp_path / 'cap.db'}")
    Base.metadata.create_all(engine)
    return sessionmaker(bind=engine, expire_on_commit=False)()


def test_list_and_overview_reject_impossible_capacity(tmp_path):
    db = _db(tmp_path)
    db.add_all(
        [
            GrowattPlant(plant_id=1, name="bad", peak_power_kwp=140_220.0),
            GrowattPlant(plant_id=2, name="good", peak_power_kwp=140.22),
            GrowattPlant(plant_id=3, name="partly rated", peak_power_kwp=900.0),
            GrowattInverter(device_sn="A1", plant_id=1, nominal_power_w=125_000.0),
            GrowattInverter(device_sn="B1", plant_id=2, nominal_power_w=125_000.0),
            GrowattInverter(device_sn="C1", plant_id=3, nominal_power_w=100_000.0),
            GrowattInverter(device_sn="C2", plant_id=3, nominal_power_w=None),
        ]
    )
    db.commit()

    # plant 3 has an inverter without a rating: no sum, so no check
    assert plant_rated_ac_w(db) == {1: 125_000.0, 2: 125_000.0}

    by_id = {p["plant_id"]: p for p in list_plants_summary(db)}
    assert (by_id[1]["peak_power_kwp"], by_id[1]["reported_peak_power_kwp"]) == (None, 140_220.0)
    assert (by_id[2]["peak_power_kwp"], by_id[2]["reported_peak_power_kwp"]) == (140.22, None)
    assert by_id[3]["peak_power_kwp"] == 900.0

    ov = build_plant_overview(db, 1)
    assert ov["kpis"]["capacity_kwp"] is None
    assert ov["plant"]["reported_peak_power_kwp"] == 140_220.0
