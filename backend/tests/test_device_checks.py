"""Device checks (docs/plans/devices-page.md §4.5): each check fires / does not fire at its boundary,
scoping, and not-installed inverters left out."""

from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy.orm import sessionmaker

from app.db.models import (
    AppSetting,
    GrowattEnvReading,
    GrowattEnvSensor,
    GrowattInverter,
    GrowattMeter,
    GrowattPlant,
    GrowattStringLayout,
    SiteDevice,
    SiteRegister,
    SyncRun,
)
from app.db.session import Base, build_engine
from app.services import device_checks as dc
from app.services.growatt_sync import INFO_REFRESH_HOURS, PARAM_REFRESH_DAYS

# 2026-11-25 12:00 Bangkok (daylight); plants have no coordinates -> 06-18 fallback window
NOW = datetime(2026, 11, 25, 5, 0, tzinfo=timezone.utc)
LOCAL = datetime(2026, 11, 25, 12, 0)
FRESH = NOW - timedelta(hours=1)


@pytest.fixture()
def db(tmp_path):
    engine = build_engine(f"sqlite:///{tmp_path / 'dc.db'}")
    Base.metadata.create_all(bind=engine)
    with sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)() as s:
        yield s


def _plant(db, pid=1, name="Alpha", count=None, meter=True):
    db.add(GrowattPlant(plant_id=pid, name=name, growatt_inverter_count=count))
    db.flush()
    if meter:
        db.add(GrowattMeter(datalogger_sn=f"DL{pid}", address=36, plant_id=pid, device_name="CHNT", history_synced_until=LOCAL - timedelta(minutes=10)))
    db.flush()


def _inv(db, sn, pid=1, **kw):
    base = dict(
        device_sn=sn,
        plant_id=pid,
        datalogger_sn=f"DL{pid}",
        alias=None,
        nominal_power_w=50000.0,
        on_off=1,
        info_synced_at=FRESH,
        param_synced_at=FRESH,
        growatt_created_at=datetime(2025, 1, 1),
        history_synced_until=LOCAL - timedelta(minutes=5),
    )
    base.update(kw)
    db.add(GrowattInverter(**base))
    db.add(GrowattStringLayout(device_sn=sn, string_no=1, modules=18))
    db.flush()


def _codes(out, sn=None, code=None):
    return [c for c in out["checks"] if (sn is None or c["device_key"] == sn) and (code is None or c["code"] == code)]


def _run(db, plants=None):
    db.commit()
    return dc.build(db, plants, True, now=NOW)


def test_clean_plant_has_no_checks_and_meta_shape(db):
    _plant(db, count=2)
    _inv(db, "A")
    _inv(db, "B")
    out = _run(db)
    assert out["checks"] == []
    assert out["meta"]["source"] == "db" and out["meta"]["day"] == "2026-11-25"
    assert out["meta"]["synced_at"] is None
    assert out["meta"]["thresholds"]["silent_hours"] == 2
    assert out["summary"] == {"total": 0, "warn": 0, "info": 0, "by_code": {}}


def test_never_reported_boundary_and_unknown_create_date(db):
    _plant(db)
    _inv(db, "OLD", history_synced_until=None, growatt_created_at=LOCAL - timedelta(days=3, minutes=1))
    _inv(db, "NEW", history_synced_until=None, growatt_created_at=LOCAL - timedelta(days=2, hours=23))
    _inv(db, "UNK", history_synced_until=None, growatt_created_at=None)
    out = _run(db)
    old = _codes(out, "OLD", "inverter_never_reported")
    assert len(old) == 1 and old[0]["severity"] == "warn" and old[0]["fix_path"] == "/plant/1/inverters?sn=OLD"
    assert not _codes(out, "NEW", "inverter_never_reported")
    unk = _codes(out, "UNK", "inverter_never_reported")
    assert len(unk) == 1 and unk[0]["severity"] == "info" and unk[0]["params"]["growatt_created_at"] is None
    # nothing stored = not "silent"
    assert not _codes(out, code="inverter_silent")


def test_silent_boundary_needs_daylight_and_peer_today(db):
    _plant(db)
    ref = LOCAL - timedelta(minutes=5)
    _inv(db, "REF", history_synced_until=ref)
    _inv(db, "LATE", history_synced_until=ref - timedelta(hours=2, minutes=1))
    _inv(db, "EDGE", history_synced_until=ref - timedelta(hours=2))
    out = _run(db)
    late = _codes(out, "LATE", "inverter_silent")
    assert len(late) == 1 and late[0]["params"]["behind_h"] == 2.0 and late[0]["severity"] == "warn"
    assert not _codes(out, "EDGE", "inverter_silent")
    # at night nothing is judged
    night = dc.build(db, None, True, now=datetime(2026, 11, 25, 13, 0, tzinfo=timezone.utc))  # 20:00 local
    assert not _codes(night, code="inverter_silent")


def test_silent_needs_another_inverter_with_a_record_today(db):
    _plant(db)
    _inv(db, "Y1", history_synced_until=datetime(2026, 11, 24, 17, 0))
    _inv(db, "Y2", history_synced_until=datetime(2026, 11, 24, 12, 0))
    assert not _codes(_run(db), code="inverter_silent")


def test_switched_off_limited_nameplate(db):
    _plant(db)
    _inv(db, "OFF", on_off=0)
    _inv(db, "UNREAD", on_off=None)
    _inv(db, "LIM", power_limit_pct=99.9)
    _inv(db, "FULL", power_limit_pct=100.0, active_rate_pct=50.0)  # readPower wins
    _inv(db, "RATE", active_rate_pct=60.0)
    _inv(db, "NONAME", nominal_power_w=None, rated_power_w=None)
    _inv(db, "RATED", nominal_power_w=None, rated_power_w=50000.0)
    out = _run(db)
    assert [c["device_key"] for c in _codes(out, code="inverter_switched_off")] == ["OFF"]
    lim = {c["device_key"]: c for c in _codes(out, code="inverter_limited")}
    assert set(lim) == {"LIM", "RATE"}
    assert lim["LIM"]["params"]["source"] == "read_power" and lim["RATE"]["params"]["source"] == "max_data_info"
    assert lim["LIM"]["severity"] == "info"
    assert [c["device_key"] for c in _codes(out, code="nameplate_missing")] == ["NONAME"]


def test_info_not_read_boundary(db):
    _plant(db)
    info_lim = NOW - timedelta(hours=3 * INFO_REFRESH_HOURS)
    param_lim = NOW - timedelta(days=3 * PARAM_REFRESH_DAYS)
    _inv(db, "OK", info_synced_at=info_lim + timedelta(minutes=1), param_synced_at=param_lim + timedelta(minutes=1))
    _inv(db, "INFO", info_synced_at=info_lim - timedelta(minutes=1))
    _inv(db, "PARAM", param_synced_at=param_lim - timedelta(minutes=1))
    _inv(db, "NEVER", info_synced_at=None, param_synced_at=None)
    out = _run(db)
    got = {c["device_key"]: c for c in _codes(out, code="info_not_read")}
    assert set(got) == {"INFO", "PARAM", "NEVER"}
    assert got["NEVER"]["params"]["info_synced_at"] is None and "never read" in got["NEVER"]["reason"]


def test_firmware_minority_group_size_and_tie(db):
    _plant(db)
    for i in range(4):
        _inv(db, f"M{i}", device_model="MAX 50KTL3", fw_version="TL1.0")
    _inv(db, "MX", device_model="MAX 50KTL3", fw_version="TL0.9")
    # a model with 4 inverters: too small a group
    for i in range(3):
        _inv(db, f"S{i}", device_model="MAX 80KTL3", fw_version="A")
    _inv(db, "SX", device_model="MAX 80KTL3", fw_version="B")
    out = _run(db)
    fw = _codes(out, code="firmware_minority")
    assert [c["device_key"] for c in fw] == ["MX"]
    assert fw[0]["params"]["majority_fw"] == "TL1.0" and fw[0]["params"]["group"] == 5


def test_firmware_with_masked_digits_is_unread(db):
    _plant(db)
    for i in range(5):
        _inv(db, f"M{i}", device_model="MAX 60KTL3 LV", fw_version="TI1.0")
    _inv(db, "MASKED", device_model="MAX 60KTL3 LV", fw_version="xx1.0")
    assert not _codes(_run(db), code="firmware_minority")


def test_firmware_tie_judges_nothing(db):
    _plant(db)
    for i, fw in enumerate(["A", "A", "B", "B", "C", "D"]):
        _inv(db, f"T{i}", device_model="MAX 60KTL3", fw_version=fw)
    assert not _codes(_run(db), code="firmware_minority")


def test_no_string_layout_is_one_check_per_plant(db):
    _plant(db)
    _inv(db, "L")
    _inv(db, "NOL")
    _inv(db, "NOL2")
    db.query(GrowattStringLayout).filter(GrowattStringLayout.device_sn.in_(["NOL", "NOL2"])).delete()
    _plant(db, 2, "Beta")
    _inv(db, "OK", 2)
    out = _run(db)
    c = _codes(out, code="no_string_layout")
    assert len(c) == 1 and c[0]["kind"] == "plant" and c[0]["plant_id"] == 1 and c[0]["device_key"] is None
    assert c[0]["params"] == {"missing": 2, "installed": 3, "inverters": "NOL, NOL2"}
    assert c[0]["fix_path"] == "/plant/1/string-layout?inv=NOL"
    assert "2 of 3 installed inverters" in c[0]["reason"]


def test_inverter_count_mismatch(db):
    # Growatt's count equal to the installed count: no mismatch
    _plant(db, 1, "Alpha", count=2)
    _inv(db, "A", 1)
    _inv(db, "B", 1)
    _inv(db, "GONE", 1, not_installed_at=NOW, on_off=0, nominal_power_w=None)
    # Growatt's count equal to the registry total (the not-installed one included): no mismatch
    _plant(db, 4, "Delta", count=2)
    _inv(db, "D", 4)
    _inv(db, "DGONE", 4, not_installed_at=NOW)
    # neither: mismatch
    _plant(db, 2, "Beta", count=2)
    _inv(db, "C", 2)
    _plant(db, 3, "Gamma", count=None)
    out = _run(db)
    mm = _codes(out, code="inverter_count_mismatch")
    assert [(c["plant_id"], c["kind"], c["params"]["installed"], c["params"]["registry_total"]) for c in mm] == [(2, "plant", 1, 1)]
    # the not-installed inverters are in no check at all
    assert not _codes(out, "GONE") and not _codes(out, "DGONE")


def test_meters_no_meter_and_silent(db):
    _plant(db, 1, "Alpha", meter=False)
    _plant(db, 2, "Beta", meter=False)
    db.add(GrowattMeter(datalogger_sn="DL2", address=36, plant_id=2, history_synced_until=LOCAL - timedelta(hours=2, minutes=1)))
    _plant(db, 3, "Gamma", meter=False)
    db.add(GrowattMeter(datalogger_sn="DL3", address=36, plant_id=3, history_synced_until=LOCAL - timedelta(hours=2)))
    _plant(db, 4, "Delta", meter=False)
    db.add(GrowattMeter(datalogger_sn="DL4", address=36, plant_id=4, history_synced_until=None))
    out = _run(db)
    assert [c["plant_id"] for c in _codes(out, code="no_meter")] == [1]
    silent = {c["plant_id"]: c for c in _codes(out, code="meter_silent")}
    assert set(silent) == {2, 4}
    assert silent[2]["device_key"] == "DL2:36" and silent[2]["kind"] == "meter"
    assert silent[4]["params"]["last_record"] is None and "never" in silent[4]["reason"]
    # judged against the last history run when that is older than now
    db.add(SyncRun(job="history", status="ok", started_at=NOW - timedelta(hours=1), finished_at=NOW))
    out = _run(db)
    assert set(c["plant_id"] for c in _codes(out, code="meter_silent")) == {4}
    assert out["meta"]["synced_at"] is not None
    # not in the dark
    night = dc.build(db, None, True, now=datetime(2026, 11, 25, 13, 0, tzinfo=timezone.utc))
    assert not _codes(night, code="meter_silent")


def test_logger_sn_mismatch_from_site_register(db):
    _plant(db, 1, "Alpha")
    _inv(db, "A", 1)
    _plant(db, 2, "Beta", meter=False)
    db.add(GrowattMeter(datalogger_sn="DL2", address=36, plant_id=2, history_synced_until=LOCAL))
    db.add(SiteRegister(site_code="P1-001", plant_id=1, name="Alpha"))
    db.add(SiteRegister(site_code="P1-002", plant_id=2, name="Beta"))
    db.flush()
    db.add(SiteDevice(site_code="P1-001", kind="datalogger", seq=1, serial="XYZ999"))
    db.add(SiteDevice(site_code="P1-002", kind="datalogger", seq=1, serial="DL2"))
    out = _run(db)
    c = _codes(out, code="logger_sn_mismatch")
    assert len(c) == 1 and c[0]["plant_id"] == 1 and c[0]["kind"] == "datalogger" and c[0]["severity"] == "warn"
    assert c[0]["params"]["register_sn"] == "XYZ999" and c[0]["params"]["growatt_sns"] == "DL1"
    assert c[0]["fix_path"] == "/plant/1/documents"


def test_sensor_flags_mapped(db):
    _plant(db)
    _inv(db, "A")
    db.add(GrowattEnvSensor(datalogger_sn="DL1", address=1, plant_id=1, device_name="ENV", history_synced_until=LOCAL - timedelta(minutes=5)))
    db.flush()
    # reported irradiance last week, 0 in every slot today 06:00-12:00 (>= 24 midday slots from 09:00)
    db.add(GrowattEnvReading(datalogger_sn="DL1", address=1, timestamp=datetime(2026, 11, 20, 12, 0), irradiance_wm2=800.0))
    t = datetime(2026, 11, 25, 6, 0)
    while t < LOCAL:
        db.add(GrowattEnvReading(datalogger_sn="DL1", address=1, timestamp=t, irradiance_wm2=0.0))
        t += timedelta(minutes=5)
    out = _run(db)
    c = _codes(out, code="sensor_probe_missing")
    assert len(c) == 1 and c[0]["device_key"] == "DL1:1" and c[0]["kind"] == "sensor"
    assert c[0]["params"]["field"] == "irradiance_wm2"
    assert c[0]["fix_path"] == "/plant/1/sensors?sensor=DL1:1"


def test_scope_sort_and_summary(db):
    _plant(db, 1, "Zulu")
    _inv(db, "Z", 1, on_off=0)
    _plant(db, 2, "Alpha")
    _inv(db, "A1", 2, on_off=0)
    _inv(db, "A2", 2, nominal_power_w=None, rated_power_w=None)
    out = _run(db)
    keys = [(c["severity"], c["plant_name"], c["code"]) for c in out["checks"]]
    assert keys == [("warn", "Alpha", "inverter_switched_off"), ("warn", "Zulu", "inverter_switched_off"), ("info", "Alpha", "nameplate_missing")]
    assert out["summary"] == {"total": 3, "warn": 2, "info": 1, "by_code": {"inverter_switched_off": 2, "nameplate_missing": 1}}
    scoped = dc.build(db, {1}, False, now=NOW)
    assert [c["device_key"] for c in scoped["checks"]] == ["Z"]
    assert dc.build(db, set(), False, now=NOW)["checks"] == []


def test_threshold_override_from_app_settings(db):
    _plant(db)
    ref = LOCAL - timedelta(minutes=5)
    _inv(db, "REF", history_synced_until=ref)
    _inv(db, "LATE", history_synced_until=ref - timedelta(hours=1, minutes=30))
    assert not _codes(_run(db), code="inverter_silent")
    db.add(AppSetting(key="device_checks", value={"silent_hours": 1, "bogus": 5, "limit_below_pct": "x"}))
    out = _run(db)
    assert len(_codes(out, "LATE", "inverter_silent")) == 1
    assert out["meta"]["thresholds"]["silent_hours"] == 1 and "bogus" not in out["meta"]["thresholds"]
    assert out["meta"]["thresholds"]["limit_below_pct"] == 100
