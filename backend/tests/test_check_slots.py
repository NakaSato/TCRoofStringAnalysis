"""PWA check slots: snapshot at hh:00 − CHECK_OFFSET_MIN, readiness, freezing, publish."""

from __future__ import annotations

from datetime import date, datetime, time, timedelta, timezone

import pytest
from sqlalchemy.orm import sessionmaker

from app.config import settings
from app.db.models import (
    GoogleWeatherHourly,
    GrowattAlarm,
    GrowattEnvReading,
    GrowattEnvSensor,
    GrowattInverter,
    GrowattInverterReading,
    GrowattPlant,
    PwaCheckSlot,
    SyncRun,
)
from app.db.session import Base, build_engine
from app.services import check_slots as cs
from sqlalchemy import select

from app.services import daily_summary, google_weather

DAY = date(2026, 11, 12)
BKK = timezone(timedelta(hours=7))
PLANT = 7
DL, ADDR = "DL7", 1


def at(h, m, day=DAY):
    return datetime.combine(day, time(h, m))


@pytest.fixture()
def db(tmp_path):
    engine = build_engine(f"sqlite:///{tmp_path / 'slots.db'}")
    Base.metadata.create_all(bind=engine)
    with sessionmaker(bind=engine, expire_on_commit=False)() as s:
        s.add_all([
            GrowattPlant(plant_id=PLANT, name="P", latitude=13.7, longitude=100.5),
            GrowattPlant(plant_id=8, name="Silent all day"),
            GrowattPlant(plant_id=9, name="No inverters"),
        ])
        s.flush()
        s.add_all([
            GrowattInverter(device_sn="A", plant_id=PLANT, alias="INVERTER 1", datalogger_sn=DL),
            GrowattInverter(device_sn="B", plant_id=PLANT, alias="INVERTER 2", datalogger_sn=DL),
            GrowattInverter(device_sn="S", plant_id=8, alias="INVERTER 1"),
            GrowattEnvSensor(datalogger_sn=DL, address=ADDR, plant_id=PLANT),
        ])
        s.flush()

        def rd(sn, h, m, pac, status=1):
            s.add(GrowattInverterReading(device_sn=sn, timestamp=at(h, m), status=status, pac_w=pac, ppv_w=pac))

        # the 08:50 snapshot takes each inverter's latest reading in 08:35–08:50
        rd("A", 8, 30, 9000)   # before the window
        rd("A", 8, 40, 20000)
        rd("A", 8, 45, 21000)  # A's reading for check 09
        rd("A", 8, 55, 50000)  # after the snapshot: never used
        rd("B", 8, 35, 15000, status=3)  # window start is inclusive: B in fault
        rd("A", 9, 0, 60000), rd("B", 9, 5, 60000)  # what hh:00 ± 10 min used to take
        for m in range(0, 60, 5):  # a full hour so the overview has a day
            rd("A", 10, m, 30000)
        s.add_all([
            GrowattEnvReading(datalogger_sn=DL, address=ADDR, timestamp=at(8, 45), irradiance_wm2=512.0, module_temp_c=35.0),
            GrowattEnvReading(datalogger_sn=DL, address=ADDR, timestamp=at(8, 55), irradiance_wm2=700.0, module_temp_c=40.0),
            GrowattAlarm(device_sn="A", plant_id=PLANT, day=DAY, start_time=at(8, 0), end_time=at(8, 49),
                         alarm_message="Closed before the snapshot", fault_type="Error"),
            GrowattAlarm(device_sn="B", plant_id=PLANT, day=DAY, start_time=at(8, 20), end_time=None,
                         alarm_message="PV Isolation Low", fault_type="Error"),
            GrowattAlarm(device_sn="B", plant_id=PLANT, day=DAY, start_time=at(8, 30), end_time=at(8, 31),
                         alarm_message="undown error", alarm_code="25", fault_type="Error"),
            GrowattAlarm(device_sn="B", plant_id=PLANT, day=DAY, start_time=at(8, 40), end_time=at(8, 41),
                         alarm_message="undown error", alarm_code="25", fault_type="Error"),
            GrowattAlarm(device_sn="A", plant_id=PLANT, day=DAY, start_time=at(8, 10), end_time=at(8, 12),
                         alarm_message="Fan function abnormal", fault_type="Warning"),
            GrowattAlarm(device_sn="A", plant_id=PLANT, day=DAY, start_time=at(8, 52), end_time=None,
                         alarm_message="After the snapshot", fault_type="Error"),
        ])
        cell = google_weather.cell_of(13.7, 100.5)[0]
        s.add_all([
            GoogleWeatherHourly(cell_key=cell, hour=at(8, 0), condition="LIGHT_RAIN", precip_mm=0.6),
            GoogleWeatherHourly(cell_key=cell, hour=at(9, 0), condition="CLEAR", precip_mm=0.0),
        ])
        s.commit()
        yield s


def history_run(db, started_local, status="ok"):
    started = started_local.replace(tzinfo=BKK).astimezone(timezone.utc)
    db.add(SyncRun(job="history", status=status, started_at=started, finished_at=started + timedelta(minutes=4)))
    db.commit()


def test_slot_times_and_schedule_clocks(monkeypatch):
    assert [cs.slot_time(DAY, h).strftime("%H:%M") for h in cs.CHECK_HOURS] == ["08:50", "12:50", "16:50"]
    assert [cs.publish_clock(h) for h in cs.CHECK_HOURS] == [time(8, 50), time(12, 50), time(16, 50)]
    assert [cs.history_clock(h) for h in cs.CHECK_HOURS] == [time(8, 47), time(12, 47), time(16, 47)]
    monkeypatch.setattr(settings, "check_offset_min", 5)
    assert cs.slot_time(DAY, 9) == at(8, 55) and cs.history_clock(9) == time(8, 52)


def test_slot_is_the_latest_reading_before_hh_minus_10(db):
    slot = cs.compute_slots(db, db.get(GrowattPlant, PLANT), DAY, [9])["09"]
    assert slot["at"] == "08:50"
    assert slot["reading_at"] == "08:45"
    assert slot["kw"] == 36.0  # A 21 kW (08:45) + B 15 kW (08:35); not 09:00's 120 kW
    assert slot["offline"] == [] and slot["fault"] == ["INV2"]
    # only the alarm log of 08:30–08:50: the alarm that closed at 08:49 is in, the warning that ended 08:12 is not
    assert slot["alarms"] == ["INV1 Closed before the snapshot", "INV2 PV Isolation Low", "INV2 25 undown error"]
    # the Fault Error log of the same 30 min: closed ones too, Warnings and later ones left out
    assert slot["errors"] == ["INV1 Closed before the snapshot", "INV2 PV Isolation Low", "INV2 Error 25 (×2)"]
    assert slot["irradiance_wm2"] == 512.0 and slot["sensor_at"] == "08:45" and slot["module_temp_c"] == 35.0
    # Google: the hour that contains 08:50 (08:00), modelled
    assert slot["google"] == {"source": "hourly", "hour": "08:00", "modelled": True, "condition": "LIGHT_RAIN", "raining": True,
                              "precip_mm": 0.6, "cloud_cover_pct": None}

    silent = cs.compute_slots(db, db.get(GrowattPlant, 8), DAY, [9])["09"]
    assert silent["offline"] == ["INV1"] and silent["kw"] is None and silent["irradiance_wm2"] is None


def test_readiness_needs_the_pre_check_history_pull(db):
    assert not cs.slot_ready(db, DAY, 9, at(8, 49))  # before the snapshot time
    assert not cs.slot_ready(db, DAY, 9, at(8, 50))  # no history pull since 08:46
    history_run(db, at(8, 30))  # the regular 30-min pull is too early
    assert not cs.slot_ready(db, DAY, 9, at(8, 50))
    history_run(db, at(8, 47), status="failed")
    assert not cs.slot_ready(db, DAY, 9, at(8, 52))
    history_run(db, at(8, 47))
    assert cs.slot_ready(db, DAY, 9, at(8, 52))
    assert cs.ready_hours(db, DAY, at(8, 52)) == [9]
    assert cs.ready_hours(db, DAY - timedelta(days=1), at(8, 52)) == [9, 13, 17]  # a past day


def test_first_build_is_frozen(db):
    plant = db.get(GrowattPlant, PLANT)
    first = cs.day_slots(db, plant, DAY, [9])
    assert set(first) == {"09"} and first["09"]["kw"] == 36.0
    # a late upload inside the window would change a recomputation ...
    db.add(GrowattInverterReading(device_sn="B", timestamp=at(8, 49), status=1, pac_w=1000))
    db.commit()
    assert cs.compute_slots(db, plant, DAY, [9])["09"]["kw"] == 22.0
    # ... but every later build reuses the frozen slot
    assert cs.day_slots(db, plant, DAY, [9, 13])["09"] == first["09"]
    assert db.get(PwaCheckSlot, (DAY, PLANT, 9)).slot_json == first["09"]
    # not frozen in a dry run
    assert cs.day_slots(db, db.get(GrowattPlant, 8), DAY, [9], freeze=False)
    assert db.get(PwaCheckSlot, (DAY, 8, 9)) is None


def _docs(db, now):
    return dict(daily_summary.build_day_docs(db, DAY, now=now))


def test_publish_lists_ready_checks_last_and_keeps_slots(db):
    history_run(db, at(8, 47))
    paths = [p for p, _ in daily_summary.build_day_docs(db, DAY, now=at(8, 52))]
    assert paths[-1] == f"daily/{DAY}"  # the fleet doc goes after every plant doc
    docs = _docs(db, at(8, 52))
    assert docs[f"daily/{DAY}"]["checks_ready"] == ["09"]
    plant = docs[f"daily/{DAY}/plants/{PLANT}"]
    assert set(plant["checks"]) == {"09"} and plant["checks"]["09"]["kw"] == 36.0
    assert plant["weather"]["slots"] == {"09": {"at": "08:45", "irradiance_wm2": 512.0, "module_temp_c": 35.0}, "13": None, "17": None}
    # a plant with inverters but no data all day is published once a check is ready: offline then
    silent = docs[f"daily/{DAY}/plants/8"]
    assert silent["has_data"] is False and silent["checks"]["09"]["offline"] == ["INV1"]
    assert f"daily/{DAY}/plants/9" not in docs  # no inverters: nothing to check

    # 19:30, after late uploads: check 09 unchanged, later checks built
    db.add(GrowattInverterReading(device_sn="B", timestamp=at(8, 49), status=1, pac_w=1000))
    db.commit()
    history_run(db, at(12, 47))
    history_run(db, at(16, 47))
    later = _docs(db, at(19, 30))
    assert later[f"daily/{DAY}"]["checks_ready"] == ["09", "13", "17"]
    assert later[f"daily/{DAY}/plants/{PLANT}"]["checks"]["09"] == plant["checks"]["09"]


def test_publish_before_any_check(db):
    docs = _docs(db, at(7, 0))
    assert docs[f"daily/{DAY}"]["checks_ready"] == []
    assert f"daily/{DAY}/plants/8" not in docs  # no data and no check yet


class FakeCurrent:
    def __init__(self):
        self.calls = 0

    def current(self, lat, lon):
        self.calls += 1
        return {"condition": "PARTLY_CLOUDY", "precip_mm": 0.0, "cloud_cover_pct": 40.0, "time_utc": "2026-11-12T01:50:00+00:00"}


def test_frozen_slot_takes_google_current_at_the_slot_time(db, monkeypatch):
    fake = FakeCurrent()
    monkeypatch.setattr(settings, "google_weather_api_key", "k")
    monkeypatch.setattr(google_weather, "make_client", lambda: fake)
    monkeypatch.setattr(google_weather, "_slot_current", {})
    plant = db.get(GrowattPlant, PLANT)
    # too late for current conditions: the stored hour, no call
    assert google_weather.slot_current(db, DAY, 9, at(8, 50), now_local=at(9, 30)) == {}
    monkeypatch.setattr(google_weather, "datetime", type("D", (datetime,), {"now": staticmethod(lambda tz=None: datetime(2026, 11, 12, 1, 52, tzinfo=timezone.utc).astimezone(tz))}))
    slot = cs.day_slots(db, plant, DAY, [9])["09"]
    assert slot["google"] == {"source": "current", "at": "08:50", "modelled": True, "condition": "PARTLY_CLOUDY",
                              "raining": False, "precip_mm": 0.0, "cloud_cover_pct": 40.0}
    assert fake.calls == 1  # one call per cell, once per check
    cs.day_slots(db, db.get(GrowattPlant, 8), DAY, [9])
    assert fake.calls == 1
    assert google_weather.calls_today(db, google_weather.API_CURRENT, google_weather.billing_day()) == 1
    # a dry run never calls Google
    assert cs.compute_slots(db, plant, DAY, [13])["13"]["google"] is None and fake.calls == 1


def test_issues_carry_the_fault_code_and_text_at_the_check(db):
    plant = db.get(GrowattPlant, PLANT)
    issues = cs.compute_slots(db, plant, DAY, [9])["09"]["issues"]
    # the DATA LOG takes the fault messages present from 08:30 (30 min before 09:00) to the 08:50 snapshot:
    # A's error that cleared at 08:49 is still reported, its warning that ended at 08:12 is not.
    # B is in fault at 08:35 with an alarm still open; an alarm Growatt has no text for keeps Growatt's own name
    assert issues == [
        {"inv": "INV1", "state": "Alarm", "items": [
            {"code": None, "message": "Closed before the snapshot", "since": "08:00", "count": 1},
        ]},
        {"inv": "INV2", "state": "Fault", "items": [
            {"code": None, "message": "PV Isolation Low", "since": "08:20", "count": 1},
            {"code": "25", "message": "undown error", "since": "08:30", "count": 2},
        ]},
    ]

    # Growatt re-reports a present alarm every ~5 min with end = start: listed when reported from 08:30 on
    db.add_all([
        GrowattAlarm(device_sn="B", plant_id=PLANT, day=DAY, start_time=at(8, 44), end_time=at(8, 44),
                     alarm_code="117", alarm_message="Relay check fail", fault_type="Error"),
        GrowattAlarm(device_sn="A", plant_id=PLANT, day=DAY, start_time=at(8, 46), end_time=at(8, 46),
                     alarm_code="400", alarm_message="Fan function abnormal", fault_type="Warning"),
        GrowattAlarm(device_sn="A", plant_id=PLANT, day=DAY, start_time=at(8, 47), end_time=at(8, 47),
                     alarm_code="912", alarm_message="undown error", fault_type="Warning"),
    ])
    db.commit()
    issues = cs.compute_slots(db, plant, DAY, [9])["09"]["issues"]
    assert issues == [
        {"inv": "INV1", "state": "Alarm", "items": [
            {"code": None, "message": "Closed before the snapshot", "since": "08:00", "count": 1},
            {"code": "400", "message": "Fan function abnormal", "since": "08:46", "count": 1},
            {"code": "912", "message": "undown error", "since": "08:47", "count": 1},
        ]},
        {"inv": "INV2", "state": "Fault", "items": [
            {"code": None, "message": "PV Isolation Low", "since": "08:20", "count": 1},
            {"code": "25", "message": "undown error", "since": "08:30", "count": 2},
            {"code": "117", "message": "Relay check fail", "since": "08:44", "count": 1},
        ]},
    ]
    silent = cs.compute_slots(db, db.get(GrowattPlant, 8), DAY, [9])["09"]
    assert silent["issues"] == [{"inv": "INV1", "state": "Offline", "items": [], "last": None}]  # no reading that day


def test_issue_items_say_since_when_and_how_many_times(db):
    plant = db.get(GrowattPlant, PLANT)
    # Growatt repeats a present alarm: only the reports of 08:30–08:50 count (06:19 and 08:25 are
    # before the look-back, 08:51 is after the check)
    db.add_all([
        GrowattAlarm(device_sn="B", plant_id=PLANT, day=DAY, start_time=at(h, m), end_time=at(h, m),
                     alarm_code="409", alarm_message="Bus voltage abnormal", fault_type="Error")
        for h, m in ((6, 19), (8, 25), (8, 39), (8, 44), (8, 51))
    ])
    db.commit()
    items = cs.compute_slots(db, plant, DAY, [9])["09"]["issues"][1]["items"]
    assert items == [
        {"code": None, "message": "PV Isolation Low", "since": "08:20", "count": 1},
        {"code": "25", "message": "undown error", "since": "08:30", "count": 2},
        {"code": "409", "message": "Bus voltage abnormal", "since": "08:39", "count": 2},  # listed once
    ]


def test_an_offline_inverter_says_when_it_last_reported(db):
    plant = db.get(GrowattPlant, PLANT)
    # check 13 (12:50, window 12:35–12:50): A reported until 10:55, B not since 09:05
    issues = cs.compute_slots(db, plant, DAY, [13])["13"]["issues"]
    assert issues == [
        {"inv": "INV1", "state": "Offline", "items": [], "last": "10:55"},
        {"inv": "INV2", "state": "Offline", "items": [], "last": "09:05"},
    ]
    # a reading of the day before does not count
    db.add(GrowattInverterReading(device_sn="S", timestamp=at(18, 0) - timedelta(days=1), status=1, pac_w=100))
    db.commit()
    assert cs.compute_slots(db, db.get(GrowattPlant, 8), DAY, [9])["09"]["issues"][0]["last"] is None


def test_issues_fall_back_to_the_readings_own_codes(db):
    from app.db.models import GrowattAlarmSync

    plant = db.get(GrowattPlant, PLANT)
    for a in db.query(GrowattAlarm).filter(GrowattAlarm.end_time.is_(None)):  # the morning's open alarms were closed
        a.end_time = at(9, 30)
    # check 13: A in fault with faultType 203 on the record, nothing in the alarm log at that time;
    # the log has Growatt's text for 203 from the morning. B warns with a code the log never named.
    db.add_all([
        GrowattInverterReading(device_sn="A", timestamp=at(12, 45), status=3, pac_w=0, fault_code=203),
        GrowattInverterReading(device_sn="B", timestamp=at(12, 45), status=1, pac_w=9000, warn_code=77),
        # Growatt numbers warnings and faults separately: warning 203 is not fault 203
        GrowattAlarm(device_sn="A", plant_id=PLANT, day=DAY, start_time=at(6, 0), end_time=at(6, 5),
                     alarm_code="203", alarm_message="PV Circuit short", fault_type="Warning"),
        GrowattAlarm(device_sn="A", plant_id=PLANT, day=DAY, start_time=at(7, 0), end_time=at(7, 5),
                     alarm_code="203", alarm_message="PV Isolation Low", fault_type="Error"),
    ])
    db.commit()
    issues = cs.compute_slots(db, plant, DAY, [13])["13"]["issues"]
    assert issues == [
        {"inv": "INV1", "state": "Fault", "items": [{"code": "203", "message": "PV Isolation Low"}]},
        {"inv": "INV2", "state": "Alarm", "items": [{"code": "77", "message": None}]},
    ]

    # warning code 1 on a reading is not reported (PWA_IGNORE_WARN_CODES): no "Alarm: 1"
    b = db.query(GrowattInverterReading).filter_by(device_sn="B", timestamp=at(12, 45)).one()
    b.warn_code = 1
    db.commit()
    assert [i["inv"] for i in cs.compute_slots(db, plant, DAY, [13])["13"]["issues"]] == ["INV1"]
    b.warn_code = 77
    db.commit()

    # only the alarm log of 12:30–12:50 counts: a report at 12:29 is not listed, whenever the log was read
    db.add(GrowattAlarm(device_sn="B", plant_id=PLANT, day=DAY, start_time=at(12, 29), end_time=at(12, 29),
                        alarm_code="302", alarm_message="No AC Connection", fault_type="Error"))
    db.add(GrowattAlarmSync(device_sn="B", day=DAY, plant_id=PLANT, alarm_count=1,
                            synced_at=at(12, 30).replace(tzinfo=BKK).astimezone(timezone.utc)))
    db.commit()
    assert cs.compute_slots(db, plant, DAY, [13])["13"]["issues"][1]["items"] == [{"code": "77", "message": None}]
    db.add(GrowattAlarm(device_sn="B", plant_id=PLANT, day=DAY, start_time=at(12, 30), end_time=at(12, 30),
                        alarm_code="302", alarm_message="No AC Connection", fault_type="Error"))
    db.commit()
    assert cs.compute_slots(db, plant, DAY, [13])["13"]["issues"][1]["items"] == [
        {"code": "302", "message": "No AC Connection", "since": "12:30", "count": 1}]


def test_a_plants_only_unnamed_inverter_is_inv1_and_others_keep_the_serial(db):
    db.add_all([
        GrowattPlant(plant_id=20, name="One unnamed"),
        GrowattPlant(plant_id=21, name="Two unnamed"),
    ])
    db.flush()
    db.add_all([
        GrowattInverter(device_sn="FYLXG4V00E", plant_id=20, alias="FYLXG4V00E"),
        GrowattInverter(device_sn="GKLLEXC031", plant_id=21, alias="GKLLEXC031"),
        GrowattInverter(device_sn="GKLLEXC00A", plant_id=21, alias="GKLLEXC00A"),
        GrowattInverterReading(device_sn="FYLXG4V00E", timestamp=at(8, 45), status=3, pac_w=0),
        GrowattInverterReading(device_sn="GKLLEXC031", timestamp=at(8, 45), status=3, pac_w=0),
        GrowattInverterReading(device_sn="GKLLEXC00A", timestamp=at(8, 45), status=1, pac_w=5000),
    ])
    db.commit()
    assert cs.compute_slots(db, db.get(GrowattPlant, 20), DAY, [9])["09"]["issues"] == [{"inv": "INV1", "state": "Fault", "items": []}]
    assert cs.compute_slots(db, db.get(GrowattPlant, 21), DAY, [9])["09"]["issues"] == [{"inv": "GKLLEXC031", "state": "Fault", "items": []}]


def test_frozen_slot_without_google_takes_the_stored_hour_later(db):
    """Google failed at the publish (quota): the slot is frozen with no weather, and filled from
    the stored hour at a later publish. Nothing else of the frozen slot changes."""
    plant = db.get(GrowattPlant, PLANT)
    cell = google_weather.cell_of(13.7, 100.5)[0]
    hour = db.scalars(select(GoogleWeatherHourly).where(GoogleWeatherHourly.cell_key == cell, GoogleWeatherHourly.hour == at(8, 0))).one()
    db.delete(hour)
    db.commit()
    first = cs.day_slots(db, plant, DAY, [9])["09"]
    assert first["google"] is None
    assert cs.day_slots(db, plant, DAY, [9])["09"]["google"] is None  # still not stored
    db.add(GoogleWeatherHourly(cell_key=cell, hour=at(8, 0), condition="MOSTLY_CLOUDY", precip_mm=0.0, cloud_cover_pct=80.0))
    db.commit()
    assert cs.day_slots(db, plant, DAY, [9], freeze=False)["09"]["google"] is None  # a dry run writes nothing
    later = cs.day_slots(db, plant, DAY, [9])["09"]
    assert later["google"] == {"source": "hourly", "hour": "08:00", "modelled": True, "condition": "MOSTLY_CLOUDY",
                               "raining": False, "precip_mm": 0.0, "cloud_cover_pct": 80.0}
    assert {k: v for k, v in later.items() if k != "google"} == {k: v for k, v in first.items() if k != "google"}
    # a slot that has Google weather keeps it
    hour = db.scalars(select(GoogleWeatherHourly).where(GoogleWeatherHourly.cell_key == cell, GoogleWeatherHourly.hour == at(8, 0))).one()
    hour.condition = "CLEAR"
    db.commit()
    assert cs.day_slots(db, plant, DAY, [9])["09"]["google"]["condition"] == "MOSTLY_CLOUDY"


def test_slot_current_stops_at_the_daily_quota(db, monkeypatch):
    class Quota:
        calls = 0

        def current(self, lat, lon):
            self.calls += 1
            raise google_weather.GoogleWeatherError("currentConditions:lookup: HTTP 429 Quota exceeded")

    fake = Quota()
    monkeypatch.setattr(settings, "google_weather_api_key", "k")
    monkeypatch.setattr(google_weather, "_slot_current", {})
    cells = {f"c{i}": (13.0 + i, 100.0) for i in range(20)}
    monkeypatch.setattr(google_weather, "fleet_cells", lambda db: cells)
    monkeypatch.setattr(google_weather, "remaining", lambda *a, **k: 1000)
    out = google_weather.slot_current(db, DAY, 9, at(8, 50), now_local=at(8, 52), client=fake, workers=1)
    assert out == {} and fake.calls == 1  # the other 19 cells are not called
