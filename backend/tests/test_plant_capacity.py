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


def test_plant_list_is_computed_once_for_concurrent_callers(monkeypatch):
    import threading
    import time

    from app.services import growatt_overview as ov

    calls: list = []
    rows = [{"plant_id": 1}, {"plant_id": 2}]

    def slow(db, plant_ids=None):
        calls.append(plant_ids)
        time.sleep(0.3)
        return rows

    class _Db:
        bind = object()
        rolled_back = 0

        def get_bind(self):
            return _Db.bind

        def rollback(self):
            _Db.rolled_back += 1

    monkeypatch.setattr(ov, "list_plants_summary", slow)
    out: dict = {}

    def call(name, ids):
        out[name] = ov.list_plants_summary_shared(_Db(), ids)

    threads = [threading.Thread(target=call, args=(n, ids)) for n, ids in (("all", None), ("eng", {2}), ("all2", None))]
    threads[0].start()
    time.sleep(0.05)  # the first caller leads; the others arrive while it runs
    for t in threads[1:]:
        t.start()
    for t in threads:
        t.join()

    assert calls == [None]  # one computation, for every plant
    assert out["all"] == rows and out["all2"] == rows and out["eng"] == [{"plant_id": 2}]
    assert _Db.rolled_back == 2  # waiters released their connection
    assert ov.list_plants_summary_shared(_Db(), set()) == []

    # finished: the next caller computes again (nothing cached)
    ov.list_plants_summary_shared(_Db(), None)
    assert calls == [None, None]


def test_newest_string_ts_per_inverter_and_input(tmp_path):
    from datetime import datetime

    from sqlalchemy import create_engine
    from sqlalchemy.orm import Session

    from app.db.models import Base, GrowattInverter, GrowattPlant, GrowattStringReading as S
    from app.services.growatt_overview import newest_string_ts

    eng = create_engine(f"sqlite:///{tmp_path / 't.db'}")
    Base.metadata.create_all(eng)
    t = lambda h: datetime(2026, 11, 13, h, 0)
    with Session(eng) as db:
        db.add(GrowattPlant(plant_id=1, name="P"))
        db.add_all([GrowattInverter(device_sn=sn, plant_id=1) for sn in ("A", "B", "C")])
        db.flush()
        row = lambda sn, h, no: S(device_sn=sn, timestamp=t(h), string_no=no, mppt_no=1, voltage_v=600, current_a=9, power_w=5400)
        db.add_all([row("A", 9, 1), row("A", 10, 2), row("B", 12, 1)])
        db.commit()
        assert newest_string_ts(db, ["A", "B", "C"]) == t(12)
        assert newest_string_ts(db, ["A"]) == t(10)
        assert newest_string_ts(db, ["A"], string_no=1) == t(9)
        assert newest_string_ts(db, ["C"]) is None  # no rows: None, not an error
        assert newest_string_ts(db, []) is None
