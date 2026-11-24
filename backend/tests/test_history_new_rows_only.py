"""Incremental `history` writes only the records from its cut-off (stored high-water mark minus
the overlap) on; the rest of the page Growatt answers is already stored and is not rewritten.
The `backfill` (no cut-off) still rewrites its whole range. No network."""

from __future__ import annotations

from datetime import date, datetime
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import sessionmaker

from app.db.models import (
    GrowattEnvReading,
    GrowattEnvSensor,
    GrowattInverter,
    GrowattInverterRaw,
    GrowattInverterReading,
    GrowattMeter,
    GrowattMeterReading,
    GrowattPlant,
    GrowattStringReading,
)
from app.db.session import Base, build_engine
from app.services import growatt_sync

TODAY = date(2026, 11, 20)
STORED = datetime(2026, 11, 20, 11, 30)  # newest stored record; cut-off = 11:00 (30 min overlap)
OLD = datetime(2026, 11, 20, 8, 0)  # on Growatt's page, but before the cut-off
NEW = [datetime(2026, 11, 20, 11, 0), datetime(2026, 11, 20, 11, 35), datetime(2026, 11, 20, 11, 40)]
DL, ADDR = "DL1", 3


def _db(tmp_path) -> Any:
    engine = build_engine(f"sqlite:///{tmp_path / 'h.db'}")
    Base.metadata.create_all(bind=engine)
    db = sessionmaker(bind=engine, expire_on_commit=False)()
    db.add(GrowattPlant(plant_id=1, name="P1", phase=1))
    db.commit()
    db.add(GrowattInverter(device_sn="A", plant_id=1, history_synced_until=STORED))
    db.add(GrowattEnvSensor(datalogger_sn=DL, address=ADDR, plant_id=1, history_synced_until=STORED))
    db.add(GrowattMeter(datalogger_sn=DL, address=ADDR, plant_id=1, history_synced_until=STORED))
    db.commit()
    # what an earlier run stored at OLD
    db.add(GrowattInverterReading(device_sn="A", timestamp=OLD, pac_w=500.0))
    db.add(GrowattEnvReading(datalogger_sn=DL, address=ADDR, timestamp=OLD, irradiance_wm2=300.0))
    db.add(GrowattMeterReading(datalogger_sn=DL, address=ADDR, timestamp=OLD, active_power_w=50.0))
    db.commit()
    return db


def _t(ts: datetime) -> str:
    return ts.strftime("%Y-%m-%d %H:%M:%S")


class _Acct:
    """One page, newest first, reaching back past the cut-off; OLD carries a different value."""

    def __init__(self) -> None:
        self.stop_before: list = []

    def _page(self, rec) -> list:
        return [rec(ts, 1000.0) for ts in reversed(NEW)] + [rec(OLD, 999.0)]

    def max_history(self, sn, start, end, stop_before=None):
        self.stop_before.append(stop_before)
        return self._page(lambda ts, v: {"time": _t(ts), "pac": v, "ppv": v + 50, "status": 1, "vString1": 600.0, "currentString1": 5.0})

    def env_history(self, dl, addr, start, end, stop_before=None):
        self.stop_before.append(stop_before)
        return self._page(lambda ts, v: {"timeText": _t(ts), "radiant": v, "envTemp": 31.0, "panelTemp": 48.0})

    def meter_history(self, dl, addr, start, end, stop_before=None):
        self.stop_before.append(stop_before)
        return self._page(lambda ts, v: {"timeText": _t(ts), "activePower": v})


def test_incremental_writes_only_records_from_the_cut_off(tmp_path, monkeypatch):
    from app.config import settings

    monkeypatch.setattr(settings, "history_store_raw", True)  # raw copies are off by default
    db = _db(tmp_path)
    acct = _Acct()
    inv = growatt_sync.sync_incremental(db, acct, TODAY, pause_s=0, phase=1)  # type: ignore[arg-type]
    env = growatt_sync.sync_env_incremental(db, acct, TODAY, pause_s=0, phase=1)  # type: ignore[arg-type]
    meter = growatt_sync.sync_meter_incremental(db, acct, TODAY, pause_s=0, phase=1)  # type: ignore[arg-type]
    assert acct.stop_before == [datetime(2026, 11, 20, 11, 0)] * 3

    # counts: the 3 records from 11:00 on, not the 4 on the page
    assert (inv["inverter_rows"], inv["string_rows"], inv["failed"]) == (3, 3, [])
    assert (env["env_rows"], meter["meter_rows"]) == (3, 3)

    # the stored record before the cut-off is left as it was
    assert db.get(GrowattInverterReading, ("A", OLD)).pac_w == 500.0
    assert db.get(GrowattEnvReading, (DL, ADDR, OLD)).irradiance_wm2 == 300.0
    assert db.get(GrowattMeterReading, (DL, ADDR, OLD)).active_power_w == 50.0
    assert list(db.scalars(select(GrowattStringReading.timestamp).order_by(GrowattStringReading.timestamp))) == NEW
    assert list(db.scalars(select(GrowattInverterRaw.timestamp).order_by(GrowattInverterRaw.timestamp))) == NEW

    # new records are stored and the high-water marks move on
    assert db.get(GrowattInverterReading, ("A", NEW[-1])).pac_w == 1000.0
    assert db.get(GrowattInverter, "A").history_synced_until == NEW[-1]
    assert db.get(GrowattEnvSensor, (DL, ADDR)).history_synced_until == NEW[-1]
    assert db.get(GrowattMeter, (DL, ADDR)).history_synced_until == NEW[-1]


def test_backfill_without_cut_off_still_rewrites_the_whole_range(tmp_path):
    db = _db(tmp_path)
    out = growatt_sync.sync_all_history(db, _Acct(), TODAY, TODAY, pause_s=0, phase=1)  # type: ignore[arg-type]
    assert out["inverter_rows"] == 4
    assert db.get(GrowattInverterReading, ("A", OLD)).pac_w == 999.0


class _NightAcct:
    """A night page, newest first: standby records, one with a warning, one fault, one producing."""

    PAGE = [
        ("2026-11-20 23:55:00", {"status": 0, "pac": 0.0}),
        ("2026-11-20 23:50:00", {"status": "0", "pac": 0.0, "warnCode": 7}),
        ("2026-11-20 23:45:00", {"status": 3, "pac": 0.0, "faultType": 117}),
        ("2026-11-20 23:40:00", {"status": 0, "pac": 12.0}),
        ("2026-11-20 23:35:00", {"status": 0, "pac": 0.0}),
        ("2026-11-20 18:55:00", {"status": 0, "pac": 0.0}),  # daytime hours: kept even in standby
    ]

    def __init__(self) -> None:
        self.stop_before: list = []

    def max_history(self, sn, start, end, stop_before=None):
        self.stop_before.append(stop_before)
        return [{"time": t, "ppv": 4.0, "vString1": 60.0, "currentString1": 0.02, **r} for t, r in self.PAGE]


def test_night_standby_records_are_not_stored_but_the_marker_moves_on(tmp_path):
    engine = build_engine(f"sqlite:///{tmp_path / 'n.db'}")
    Base.metadata.create_all(bind=engine)
    db = sessionmaker(bind=engine, expire_on_commit=False)()
    db.add(GrowattPlant(plant_id=1, name="P1", phase=1))
    db.commit()
    db.add(GrowattInverter(device_sn="A", plant_id=1, history_synced_until=datetime(2026, 11, 20, 18, 50)))
    db.commit()
    acct = _NightAcct()
    out = growatt_sync.sync_incremental(db, acct, TODAY, pause_s=0, phase=1)  # type: ignore[arg-type]
    stored = [t.strftime("%H:%M") for t in db.scalars(select(GrowattInverterReading.timestamp).order_by(GrowattInverterReading.timestamp))]
    assert stored == ["18:55", "23:40", "23:45", "23:50"]  # producing, fault, warning; daytime standby
    assert out["inverter_rows"] == 4
    # their string rows go with them
    strings = [t.strftime("%H:%M") for t in db.scalars(select(GrowattStringReading.timestamp).order_by(GrowattStringReading.timestamp))]
    assert strings == stored
    # the marker is the newest record read (23:55), not the newest stored: the night is not read again
    assert db.get(GrowattInverter, "A").history_synced_until == datetime(2026, 11, 20, 23, 55)
