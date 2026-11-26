"""Devices page lists (`/growatt/devices/*`): DB only, scoped, nulls never 0."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import sessionmaker

from app.db.models import (
    GrowattAlarm,
    GrowattAlarmSync,
    GrowattEnvSensor,
    GrowattInverter,
    GrowattInverterReading,
    GrowattIssue,
    GrowattMeter,
    GrowattMeterReading,
    GrowattPlant,
    GrowattStringLayout,
    SiteDevice,
    SiteRegister,
    SyncRun,
    User,
    UserPlantAssignment,
)
from app.db.seed import ensure_seeded
from app.db.session import Base, build_engine, get_db
from app.main import create_app
from app.services.devices import local_today, register_match
from tests.test_growatt_routes import PLANT, SN_A, SN_B, _seed_growatt

OTHER = 222
TODAY = local_today()


def _seed_devices(s) -> None:
    today0 = datetime.combine(TODAY, datetime.min.time())
    s.add(GrowattPlant(plant_id=OTHER, name="Other Plant", city="Chiang Mai", growatt_datalogger_count=2))
    s.flush()
    s.add_all(
        [
            GrowattInverter(device_sn="OTH1", plant_id=OTHER, datalogger_sn="DLO1"),
            GrowattInverter(
                device_sn="GONE", plant_id=PLANT, datalogger_sn="DLA",
                not_installed_at=datetime(2026, 11, 1, tzinfo=timezone.utc), not_installed_by="admin", not_installed_note="not on roof",
            ),
        ]
    )
    for sn in (SN_A, SN_B):
        inv = s.get(GrowattInverter, sn)
        inv.datalogger_sn = "DLA12345"
        inv.datalogger_model = "ShineMaster"
        inv.alias = "INVERTER 1" if sn == SN_A else "INVERTER 2"
        inv.history_synced_until = today0 + timedelta(hours=11)
    s.get(GrowattInverter, SN_A).power_limit_pct = 80.0
    # today: INVA 30 kWh, INVB 10 kWh (the counter's last value of today counts); INVC nothing today
    for sn, vals in ((SN_A, (10.0, 30.0)), (SN_B, (4.0, 10.0))):
        for h, v in zip((9, 11), vals):
            s.add(GrowattInverterReading(device_sn=sn, timestamp=today0 + timedelta(hours=h), pac_w=1000, ppv_w=1000, eac_today_kwh=v))
    s.add(GrowattStringLayout(device_sn=SN_A, string_no=1, modules=20))
    s.add_all(
        [
            GrowattIssue(plant_id=PLANT, device_sn=SN_A, rule="R8", tier="P2", opened_day=TODAY, last_seen_day=TODAY, status="open", shadow=False),
            GrowattIssue(plant_id=PLANT, device_sn=SN_A, rule="R2", tier="P1", opened_day=TODAY, last_seen_day=TODAY, status="acknowledged", shadow=False),
            GrowattIssue(plant_id=PLANT, device_sn=SN_A, rule="R1", tier="P1", opened_day=TODAY, last_seen_day=TODAY, status="resolved", shadow=False),
            GrowattIssue(plant_id=PLANT, device_sn=SN_B, rule="R1", tier="P1", opened_day=TODAY, last_seen_day=TODAY, status="open", shadow=True),
        ]
    )
    # alarm log: INVA read today (2 records, 1 open); INVB not read today (its row is from another day)
    s.add(GrowattAlarmSync(device_sn=SN_A, day=TODAY, plant_id=PLANT, synced_at=datetime.now(timezone.utc)))
    s.add(GrowattAlarmSync(device_sn=SN_B, day=TODAY - timedelta(days=1), plant_id=PLANT, synced_at=datetime.now(timezone.utc)))
    s.add_all(
        [
            GrowattAlarm(device_sn=SN_A, plant_id=PLANT, day=TODAY, start_time=today0 + timedelta(hours=8), end_time=None, alarm_code="102"),
            GrowattAlarm(device_sn=SN_A, plant_id=PLANT, day=TODAY, start_time=today0 + timedelta(hours=7), end_time=today0 + timedelta(hours=7, minutes=5), alarm_code="102"),
        ]
    )
    # meter on PLANT: import counter 100 → 112 today; export integrated from negative power
    s.add(GrowattMeter(datalogger_sn="DLA12345", address=36, plant_id=PLANT, device_name="CHNT_THREE", history_synced_until=today0 + timedelta(hours=12)))
    s.flush()
    for i, (p, c) in enumerate(((5000.0, 100.0), (-6000.0, 104.0), (-6000.0, 112.0))):
        s.add(GrowattMeterReading(datalogger_sn="DLA12345", address=36, timestamp=today0 + timedelta(hours=10, minutes=5 * i), active_power_w=p, import_counter_kwh=c))
    s.add(GrowattEnvSensor(datalogger_sn="DLA12345", address=1, plant_id=PLANT, history_synced_until=today0 + timedelta(hours=12, minutes=5)))
    s.add(SiteRegister(site_code="P1-001", plant_id=PLANT, name="Station", province="Lamphun"))
    s.flush()
    s.add(SiteDevice(site_code="P1-001", kind="datalogger", seq=1, serial="DLA1234"))
    started = datetime(2026, 11, 25, 3, 0, tzinfo=timezone.utc)
    s.add(SyncRun(job="history", trigger="schedule", status="ok", started_at=started, finished_at=started + timedelta(minutes=5)))
    eng = s.scalar(select(User).where(User.username == "engineer"))
    s.add(UserPlantAssignment(user_id=eng.id, plant_id=OTHER))
    s.commit()


@pytest.fixture()
def client(tmp_path):
    engine = build_engine(f"sqlite:///{tmp_path / 'devices.db'}")
    Session = sessionmaker(bind=engine, autoflush=False, autocommit=False, expire_on_commit=False)
    Base.metadata.create_all(bind=engine)
    with Session() as s:
        ensure_seeded(s)
        _seed_growatt(s)
        _seed_devices(s)
    app = create_app()

    def _db():
        db = Session()
        try:
            yield db
        finally:
            db.close()

    app.dependency_overrides[get_db] = _db
    c = TestClient(app)

    def hdr(user, pw):
        tok = c.post("/api/auth/login", json={"username": user, "password": pw}).json()["access_token"]
        return {"Authorization": f"Bearer {tok}"}

    c.admin = hdr("admin", "admin123")  # type: ignore[attr-defined]
    c.eng = hdr("engineer", "engineer123")  # type: ignore[attr-defined]
    return c


def _get(client, path, h):
    r = client.get(f"/api/growatt/devices/{path}", headers=h)
    assert r.status_code == 200, r.text
    return r.json()


def test_inverters_list_fields_nulls_and_not_installed(client):
    res = _get(client, "inverters", client.admin)
    assert res["meta"] == {"source": "db", "day": TODAY.isoformat(), "synced_at": "2026-11-25T03:00:00+00:00"}
    rows = {r["device_sn"]: r for r in res["inverters"]}
    assert "GONE" not in rows  # not installed: left out by default
    assert res["summary"] == {"inverters": 5, "installed": 4, "not_installed": 1, "plants": 2}

    a, b, c = rows[SN_A], rows[SN_B], rows["INVC"]
    assert a["label"] == "INV1" and b["label"] == "INV2"
    assert a["province"] == "Lamphun" and a["site_code"] == "P1-001"
    assert rows["OTH1"]["province"] == "Chiang Mai" and rows["OTH1"]["site_code"] is None
    assert a["power_limit_pct"] == 80.0 and a["power_limit_source"] == "read_power"
    assert b["power_limit_pct"] is None and b["power_limit_source"] is None
    assert a["last_record"] == f"{TODAY.isoformat()}T11:00:00"
    assert c["last_record"] is None
    # yield = last eac_today of today; % of the plant mean of inverters with a yield (30, 10 → 20)
    assert a["yield_today_kwh"] == 30.0 and b["yield_today_kwh"] == 10.0
    assert a["pct_of_plant_avg"] == 150.0 and b["pct_of_plant_avg"] == 50.0
    assert c["yield_today_kwh"] is None and c["pct_of_plant_avg"] is None  # no record today: null, never 0
    # active non-shadow issues only
    assert a["open_issues"] == 2 and a["top_tier"] == "P1"
    assert b["open_issues"] == 0 and b["top_tier"] is None
    # alarm log read today → counts; not read today → null
    assert a["alarms_today"] == 2 and a["alarms_open"] == 1
    assert b["alarms_today"] is None and b["alarms_open"] is None
    assert a["has_string_layout"] is True and b["has_string_layout"] is False
    assert a["not_installed"] is None


def test_inverters_include_not_installed(client):
    res = _get(client, "inverters?include_not_installed=true", client.admin)
    gone = next(r for r in res["inverters"] if r["device_sn"] == "GONE")
    assert gone["not_installed"]["by"] == "admin" and gone["not_installed"]["note"] == "not on roof"
    assert gone["pct_of_plant_avg"] is None
    assert res["summary"]["inverters"] == 5


def test_engineer_sees_only_assigned_plants(client):
    inv = _get(client, "inverters", client.eng)
    assert {r["plant_id"] for r in inv["inverters"]} == {OTHER}
    assert inv["summary"] == {"inverters": 1, "installed": 1, "not_installed": 0, "plants": 1}
    met = _get(client, "meters", client.eng)
    assert met["meters"] == [] and met["plants_without_meter"] == [{"plant_id": OTHER, "plant_name": "Other Plant"}]
    dl = _get(client, "dataloggers", client.eng)
    assert {d["datalogger_sn"] for d in dl["dataloggers"]} == {"DLO1"}
    assert [p["plant_id"] for p in dl["plants"]] == [OTHER]


def test_meters_today_energy(client):
    res = _get(client, "meters", client.admin)
    (m,) = res["meters"]
    assert m["plant_id"] == PLANT and m["address"] == 36 and m["province"] == "Lamphun"
    assert m["records_today"] == 3
    assert m["import_today_kwh"] == 12.0  # import counter span
    assert m["export_today_kwh"] is not None and m["export_today_kwh"] > 0
    assert m["last_record"] == f"{TODAY.isoformat()}T12:00:00"
    assert res["plants_without_meter"] == [{"plant_id": OTHER, "plant_name": "Other Plant"}]


def test_dataloggers_grouped_with_register_match(client):
    res = _get(client, "dataloggers", client.admin)
    rows = {d["datalogger_sn"]: d for d in res["dataloggers"]}
    assert set(rows) == {"DLA12345", "DLO1"}  # GONE's logger left out (not installed)
    a = rows["DLA12345"]
    assert (a["inverters"], a["sensors"], a["meters"]) == (2, 1, 1)
    assert a["model"] == "ShineMaster"
    assert a["last_record"] == f"{TODAY.isoformat()}T12:05:00"
    assert a["register_sn"] == "DLA1234" and a["register_match"] == "prefix"
    assert rows["DLO1"]["register_sn"] is None and rows["DLO1"]["register_match"] is None
    plants = {p["plant_id"]: p for p in res["plants"]}
    assert plants[OTHER] == {"plant_id": OTHER, "plant_name": "Other Plant", "growatt_count": 2, "found": 1}
    assert plants[PLANT]["growatt_count"] is None


def test_register_match():
    assert register_match(None, "ABC") is None
    assert register_match("abc123", "ABC123") == "match"
    assert register_match("ABC12", "ABC123") == "prefix"
    assert register_match("XYZ", "ABC123") == "differs"


def test_dataloggers_second_logger_not_a_register_mismatch(tmp_path):
    """A plant's other loggers (e.g. behind a sensor) are null, not "differs", when one matches the register;
    "differs" only when none of its serials matches (the site register's logger_sn_differs rule)."""
    from app.services.devices import list_dataloggers

    engine = build_engine(f"sqlite:///{tmp_path / 'dl.db'}")
    Session = sessionmaker(bind=engine, autoflush=False, autocommit=False, expire_on_commit=False)
    Base.metadata.create_all(bind=engine)
    with Session() as s:
        ensure_seeded(s)
        _seed_growatt(s)
        _seed_devices(s)
        s.add(GrowattEnvSensor(datalogger_sn="DLB999", address=1, plant_id=PLANT))
        s.commit()
        rows = {d["datalogger_sn"]: d for d in list_dataloggers(s, None)["dataloggers"]}
        assert rows["DLA12345"]["register_match"] == "prefix"
        assert rows["DLB999"]["register_sn"] == "DLA1234" and rows["DLB999"]["register_match"] is None

        s.get(SiteDevice, s.scalar(select(SiteDevice.id).where(SiteDevice.site_code == "P1-001"))).serial = "ZZZ1"
        s.commit()
        rows = {d["datalogger_sn"]: d for d in list_dataloggers(s, None)["dataloggers"]}
        assert rows["DLA12345"]["register_match"] == "differs"
        assert rows["DLB999"]["register_match"] == "differs"


def test_checks_route_auth_scope_and_not_installed_logger(client):
    """`/devices/checks` needs a login, scopes engineers to their plants, and a not-installed
    inverter's datalogger is not one of the plant's Growatt loggers (audit #125)."""
    assert client.get("/api/growatt/devices/checks").status_code == 401
    res = _get(client, "checks", client.admin)
    assert res["meta"]["source"] == "db"
    (mis,) = [c for c in res["checks"] if c["code"] == "logger_sn_mismatch"]
    assert mis["plant_id"] == PLANT and mis["params"]["register_sn"] == "DLA1234"
    assert mis["params"]["growatt_sns"] == "DLA12345"  # GONE's "DLA" left out (not installed)
    assert all(c["device_key"] != "GONE" for c in res["checks"])
    eng = _get(client, "checks", client.eng)
    assert {c["plant_id"] for c in eng["checks"]} <= {OTHER}
    assert not [c for c in eng["checks"] if c["code"] == "logger_sn_mismatch"]
    assert eng["summary"]["total"] == len(eng["checks"])


def test_inverters_summary_plants_count_installed_only(tmp_path):
    """A plant whose inverters are all marked not installed is not counted in `summary.plants`."""
    from app.services.devices import list_inverters

    engine = build_engine(f"sqlite:///{tmp_path / 'ni.db'}")
    Session = sessionmaker(bind=engine, autoflush=False, autocommit=False, expire_on_commit=False)
    Base.metadata.create_all(bind=engine)
    with Session() as s:
        ensure_seeded(s)
        _seed_growatt(s)
        _seed_devices(s)
        s.get(GrowattInverter, "OTH1").not_installed_at = datetime(2026, 11, 2, tzinfo=timezone.utc)
        s.commit()
        res = list_inverters(s, None)
        assert res["summary"] == {"inverters": 5, "installed": 3, "not_installed": 2, "plants": 1}
        assert list_inverters(s, {OTHER})["summary"] == {"inverters": 1, "installed": 0, "not_installed": 1, "plants": 0}
