"""Inverter state at the 09/13/17 report checks (snapshots at 08:50 / 12:50 / 16:50)."""

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

        # checks are snapshots at 08:50 / 12:50 / 16:50: each inverter's latest reading in the 15 min before
        # 08:50 — A and B report (B's 08:55 record is after the snapshot), C silent
        rd("A", 8, 45), rd("B", 8, 40), rd("B", 8, 55, status=3)
        # 12:50 — all report, C in fault (its 12:51 recovery is after the snapshot)
        rd("A", 12, 50), rd("B", 12, 36), rd("C", 12, 40, status=3), rd("C", 12, 51)
        # 16:50 — A only at 16:30, before the window: everyone offline
        rd("A", 16, 30)
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
    pick = lambda hh: {k: c[hh][k] for k in ("at", "inverters", "offline", "fault", "alarms", "kw")}
    assert pick("09") == {"at": "08:50", "inverters": 3, "offline": ["INV3"], "fault": [], "alarms": ["INV2 Relay fault"], "kw": 2.0}
    assert pick("13") == {"at": "12:50", "inverters": 3, "offline": [], "fault": ["INV3"], "alarms": ["INV3 PV Isolation Low"], "kw": 3.0}
    assert c["17"]["offline"] == ["INV1", "INV2", "INV3"] and c["17"]["kw"] is None
    assert c["17"]["alarms"] == ["INV3 PV Isolation Low"]
    assert build_checks(db, 8, DAY) is None


def test_replaced_inverters_are_left_out():
    assert is_replaced(GrowattInverter(device_sn="X", alias="GKLNF3901P(old)"))
    assert is_replaced(GrowattInverter(device_sn="X", alias="inverter 2 old"))
    assert not is_replaced(GrowattInverter(device_sn="X", alias="INVERTER 2"))
