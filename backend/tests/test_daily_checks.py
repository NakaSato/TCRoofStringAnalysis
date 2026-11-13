"""Inverter state at the 09/13/17 report checks (offline / fault / open alarms)."""

from __future__ import annotations

from datetime import date, datetime

import pytest
from sqlalchemy.orm import sessionmaker

from app.db.models import GrowattAlarm, GrowattInverter, GrowattInverterReading, GrowattPlant
from app.db.session import Base, build_engine
from app.services.daily_checks import build_checks, inverter_label, is_replaced

DAY = date(2026, 11, 12)
PLANT = 7


@pytest.fixture()
def db(tmp_path):
    engine = build_engine(f"sqlite:///{tmp_path / 'checks.db'}")
    Base.metadata.create_all(bind=engine)
    with sessionmaker(bind=engine, expire_on_commit=False)() as s:
        s.add_all([GrowattPlant(plant_id=PLANT, name="P"), GrowattPlant(plant_id=8, name="Empty")])
        s.flush()
        s.add_all(
            [
                GrowattInverter(device_sn="A", plant_id=PLANT, alias="INVERTER 1"),
                GrowattInverter(device_sn="B", plant_id=PLANT, alias="Inverter no.2"),
                GrowattInverter(device_sn="C", plant_id=PLANT, alias="inverter03"),
                GrowattInverter(device_sn="OLD", plant_id=PLANT, alias="INV 1 old"),  # replaced, never reports
            ]
        )
        s.flush()

        def rd(sn, hh, mm, status=1):
            s.add(GrowattInverterReading(device_sn=sn, timestamp=datetime(2026, 11, 12, hh, mm), status=status, pac_w=1000))

        # 09:00 — A and B report, C silent; 13:00 — all report, C in fault; 17:00 — only A, 12 min late (too far)
        rd("A", 9, 4), rd("B", 8, 55), rd("A", 13, 0), rd("B", 13, 5), rd("C", 12, 58, status=3), rd("C", 13, 20), rd("A", 17, 12)
        s.add_all(
            [
                GrowattAlarm(device_sn="B", plant_id=PLANT, day=DAY, start_time=datetime(2026, 11, 12, 8, 0),
                             end_time=datetime(2026, 11, 12, 10, 0), alarm_message="Relay fault", fault_type="Error"),
                GrowattAlarm(device_sn="C", plant_id=PLANT, day=DAY, start_time=datetime(2026, 11, 12, 12, 0),
                             end_time=None, alarm_message="PV Isolation Low", fault_type="Error"),
                GrowattAlarm(device_sn="A", plant_id=PLANT, day=DAY, start_time=datetime(2026, 11, 12, 6, 0),
                             end_time=None, alarm_message="undown error", fault_type="Warning"),
            ]
        )
        s.commit()
        yield s


def test_inverter_label_normalises_growatt_aliases():
    for alias, want in [("INVERTER 3", "INV3"), ("inverter 3", "INV3"), ("Inverter no.3", "INV3"), ("Inverter03", "INV3")]:
        assert inverter_label(GrowattInverter(device_sn="X", alias=alias)) == want
    assert inverter_label(GrowattInverter(device_sn="X", alias=None)) == "X"


def test_checks_offline_fault_and_open_alarms(db):
    c = build_checks(db, PLANT, DAY)
    assert set(c) == {"09", "13", "17"}
    assert c["09"] == {"inverters": 3, "offline": ["INV3"], "fault": [], "alarms": ["INV2 Relay fault"]}
    assert c["13"] == {"inverters": 3, "offline": [], "fault": ["INV3"], "alarms": ["INV3 PV Isolation Low"]}
    assert c["17"]["offline"] == ["INV1", "INV2", "INV3"] and c["17"]["alarms"] == ["INV3 PV Isolation Low"]
    assert build_checks(db, 8, DAY) is None


def test_replaced_inverters_are_left_out():
    assert is_replaced(GrowattInverter(device_sn="X", alias="GKLNF3901P(old)"))
    assert is_replaced(GrowattInverter(device_sn="X", alias="inverter 2 old"))
    assert not is_replaced(GrowattInverter(device_sn="X", alias="INVERTER 2"))
