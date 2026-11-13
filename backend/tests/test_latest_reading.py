"""Newest stored reading over a plant's inverters (one primary-key lookup per inverter)."""
from __future__ import annotations

from datetime import datetime

from sqlalchemy.orm import sessionmaker

from app.db.models import Base, GrowattInverter, GrowattInverterReading, GrowattPlant, GrowattStringReading
from app.db.session import build_engine
from app.services.growatt_overview import newest_inverter_ts, newest_string_ts


def test_newest_ts_over_inverters(tmp_path):
    engine = build_engine(f"sqlite:///{tmp_path / 'latest.db'}")
    Base.metadata.create_all(engine)
    db = sessionmaker(bind=engine, expire_on_commit=False)()
    db.add_all(
        [
            GrowattPlant(plant_id=1, name="p"),
            GrowattInverter(device_sn="A", plant_id=1),
            GrowattInverter(device_sn="B", plant_id=1),
            GrowattInverter(device_sn="C", plant_id=1),  # never reported
        ]
    )
    db.commit()
    db.add_all(
        [
            GrowattInverterReading(device_sn="A", timestamp=datetime(2026, 11, 13, 9, 0)),
            GrowattInverterReading(device_sn="B", timestamp=datetime(2026, 11, 13, 9, 5)),
            GrowattStringReading(
                device_sn="A", timestamp=datetime(2026, 11, 12, 17, 0), string_no=1, mppt_no=1,
                voltage_v=600.0, current_a=5.0, power_w=3000.0,
            ),
        ]
    )
    db.commit()

    assert newest_inverter_ts(db, ["A", "B", "C"]) == datetime(2026, 11, 13, 9, 5)
    assert newest_string_ts(db, ["A", "B", "C"]) == datetime(2026, 11, 12, 17, 0)
    assert newest_inverter_ts(db, ["C"]) is None  # plant with no stored history
    assert newest_inverter_ts(db, []) is None
