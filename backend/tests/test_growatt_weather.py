"""Weather sensors (`device/env/*`): client parsing, sync, DB weather + IEC PR, live endpoint. No network."""

from __future__ import annotations

from datetime import date, datetime, timedelta
from unittest.mock import MagicMock

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import func, select
from sqlalchemy.orm import sessionmaker

from app.db.models import (
    GrowattEnvReading,
    GrowattEnvSensor,
    GrowattInverter,
    GrowattInverterReading,
    GrowattPlant,
)
from app.db.seed import ensure_seeded
from app.db.session import Base, build_engine, get_db
from app.main import create_app
from app.services import growatt_sync
from app.services.growatt_live import GrowattLiveService, get_live_service
from solar_core.growatt import GrowattAPIError, GrowattClient, parse_env_records

PLANT, BARE = 444, 555  # BARE has no weather sensor
SN = "INVW"
DL, ADDR = "DLW1", 6
DAY = datetime(2026, 11, 11)
LOW_COVERAGE_DAY = datetime(2026, 11, 10)


def _env(ts: datetime, radiant: float, **kw) -> dict:
    """An env_data record as Growatt sends it (unfitted probes read 0)."""
    return {
        "timeText": ts.strftime("%Y-%m-%d %H:%M:%S"),
        "radiant": radiant,
        "envTemp": kw.get("amb", 31.0),
        "panelTemp": kw.get("mod", 48.0),
        "envHumidity": kw.get("hum", 0),
        "windSpeed": kw.get("ws", 2.0),
        "windAngle": kw.get("wd", 0),
        "rainfallIntensity": 0,
        "airPressure": 0,
        "addr": ADDR,
        "dataLogSn": DL,
        "calendar": {"time": {"time": 0}},
    }


def _seed(session) -> None:
    session.add_all(
        [GrowattPlant(plant_id=PLANT, name="Weather", peak_power_kwp=10.0), GrowattPlant(plant_id=BARE, name="Bare", peak_power_kwp=10.0)]
    )
    session.flush()
    session.add_all([GrowattInverter(device_sn=SN, plant_id=PLANT), GrowattInverter(device_sn="INVBARE", plant_id=BARE)])
    session.add(GrowattEnvSensor(datalogger_sn=DL, address=ADDR, plant_id=PLANT, device_name="ENV_DEVICE"))
    session.flush()
    for day in (DAY, LOW_COVERAGE_DAY):
        # 08:00–16:00 every 5 min at 5 kW; eac_today ends at 40 kWh
        for m in range(0, 8 * 60 + 1, 5):
            ts = day + timedelta(hours=8, minutes=m)
            for sn in (SN, "INVBARE"):
                session.add(
                    GrowattInverterReading(
                        device_sn=sn, timestamp=ts, pac_w=5000, ppv_w=5200, eac_today_kwh=round(m / 12, 2), temperature_c=45.0
                    )
                )
    # DAY: irradiance 600 W/m² over the same window; wind direction 350° / 10° alternating
    recs = [_env(DAY + timedelta(hours=8, minutes=m), 600, wd=350 if (m // 5) % 2 else 10) for m in range(0, 8 * 60 + 1, 5)]
    # night records: irradiance 0 is a real measurement
    recs += [_env(DAY + timedelta(hours=20, minutes=m), 0, mod=26.0) for m in range(0, 30, 5)]
    # LOW_COVERAGE_DAY: the sensor only reported 08:00–10:00
    recs += [_env(LOW_COVERAGE_DAY + timedelta(hours=8, minutes=m), 600) for m in range(0, 121, 5)]
    for row in parse_env_records(DL, ADDR, recs):
        session.add(GrowattEnvReading(**row))
    session.commit()


@pytest.fixture()
def env(tmp_path):
    engine = build_engine(f"sqlite:///{tmp_path / 'weather.db'}")
    Session = sessionmaker(bind=engine, autoflush=False, autocommit=False, expire_on_commit=False)
    Base.metadata.create_all(bind=engine)
    with Session() as s:
        ensure_seeded(s)
        _seed(s)
    app = create_app()

    def _db():
        db = Session()
        try:
            yield db
        finally:
            db.close()

    app.dependency_overrides[get_db] = _db
    c = TestClient(app)
    tok = c.post("/api/auth/login", json={"username": "admin", "password": "admin123"}).json()["access_token"]
    c.headers["Authorization"] = f"Bearer {tok}"
    return c, app, Session


# --------------------------------------------------------------------------- client


def _resp(body):
    r = MagicMock()
    r.json.return_value = body
    r.raise_for_status.return_value = None
    return r


def test_parse_env_records_keeps_measured_fields_and_local_time():
    rows = parse_env_records(DL, ADDR, [_env(DAY + timedelta(hours=12), 812.0, hum=64), {"timeText": "bad"}])
    assert rows == [
        {
            "datalogger_sn": DL,
            "address": ADDR,
            "timestamp": DAY + timedelta(hours=12),  # timeText as-is (plant-local), not the calendar millis
            "irradiance_wm2": 812.0,
            "ambient_temp_c": 31.0,
            "module_temp_c": 48.0,
            "humidity_pct": 64.0,
            "wind_speed_ms": 2.0,
            "wind_dir_deg": 0.0,
        }
    ]


def test_env_history_pages_newest_first_and_stops_early():
    client = GrowattClient(token="t")
    page1 = [_env(DAY + timedelta(hours=12, minutes=-5 * i), 500) for i in range(100)]
    page2 = [_env(DAY + timedelta(hours=12, minutes=-500 - 5 * i), 400) for i in range(100)]
    client.session.get = MagicMock(
        side_effect=[
            _resp({"error_code": 0, "data": {"count": 250, "env_data": page1}}),
            _resp({"error_code": 0, "data": {"count": 250, "env_data": page2}}),
        ]
    )
    # page 1 ends at 03:45, still after stop_before; page 2 reaches past it: no page 3
    recs = client.env_history(DL, ADDR, DAY.date(), DAY.date(), stop_before=DAY + timedelta(hours=1))
    assert len(recs) == 200 and client.session.get.call_count == 2
    params = client.session.get.call_args_list[0].kwargs["params"]
    assert params["datalog_sn"] == DL and params["address"] == ADDR and params["perpage"] == 100
    with pytest.raises(ValueError):
        client.env_history(DL, ADDR, date(2026, 11, 1), date(2026, 11, 9))


def test_env_list_and_latest():
    client = GrowattClient(token="t")
    client.session.get = MagicMock(
        side_effect=[
            _resp({"error_code": 0, "data": {"count": 1, "envs": [{"address": "6", "device_name": "ENV_DEVICE", "lost": "0"}]}}),
            _resp({"error_code": 0, "data": _env(DAY, 300)}),
            _resp({"error_code": 0, "data": ""}),
        ]
    )
    assert client.list_env_sensors(DL)[0]["address"] == "6"
    assert client.env_latest(DL, 6)["radiant"] == 300
    assert client.env_latest(DL, 7) is None  # sensor without data


# --------------------------------------------------------------------------- sync


class _Account:
    """Fake account: one plant whose datalogger lists the "env" device twice (Growatt does)."""

    def __init__(self):
        self.env_calls: list = []

    def list_plants(self, refresh=False):
        return [{"plant_id": "777", "name": "Synced"}]

    def list_inverters(self, plant_id, refresh=False):
        return [{"device_sn": "INVS", "model": "", "datalogger_sn": "DLS", "device_types": ["inverter", "max"]}]

    def list_devices(self, plant_id, refresh=False):
        return [
            {"device_sn": "INVS", "type": 1, "datalogger_sn": "DLS"},
            {"device_sn": "env", "type": 3, "datalogger_sn": "DLS"},
            {"device_sn": "env", "type": 3, "datalogger_sn": "DLS"},
            {"device_sn": "meter", "type": 3, "datalogger_sn": "DLS"},
        ]

    def list_env_sensors(self, datalogger_sn, refresh=False):
        return [{"address": "3", "device_name": "ENV_DEVICE", "lost": "0", "lastUpdateTime": "2026-11-12 10:00:00"}]

    def env_history(self, datalogger_sn, address, start, end, stop_before=None):
        self.env_calls.append((datalogger_sn, address, start, end, stop_before))
        return [_env(DAY + timedelta(hours=10, minutes=m), 700) for m in (10, 5, 0)]

    def max_history(self, *a, **kw):
        return []


def test_fleet_registers_sensors_and_history_syncs_them(tmp_path):
    engine = build_engine(f"sqlite:///{tmp_path / 's.db'}")
    Base.metadata.create_all(bind=engine)
    Session = sessionmaker(bind=engine, expire_on_commit=False)
    acct = _Account()
    with Session() as db:
        growatt_sync.sync_fleet(db, acct, pause_s=0, phase=1)  # type: ignore[arg-type]
        sensors = list(db.scalars(select(GrowattEnvSensor)))
        assert [(s.datalogger_sn, s.address, s.plant_id) for s in sensors] == [("DLS", 3, 777)]

        totals = growatt_sync.sync_env_incremental(db, acct, DAY.date(), pause_s=0, phase=1)  # type: ignore[arg-type]
        assert totals == {"env_sensors": 1, "env_rows": 3, "env_failed": []}
        assert db.get(GrowattEnvSensor, ("DLS", 3)).history_synced_until == DAY + timedelta(hours=10, minutes=10)

        # next run starts from the stored high-water mark minus the overlap
        growatt_sync.sync_env_incremental(db, acct, DAY.date(), pause_s=0, phase=1)  # type: ignore[arg-type]
        assert acct.env_calls[-1][4] == DAY + timedelta(hours=9, minutes=40)
        assert db.scalar(select(func.count()).select_from(GrowattEnvReading)) == 3  # upserts, no duplicates

        # retention removes weather readings with the rest of the raw history
        out = growatt_sync.prune_history(db, DAY.date() + timedelta(days=5), keep_days=1)
        assert out["env_rows"] == 3


def test_failed_sensor_is_reported_not_raised(tmp_path, monkeypatch):
    engine = build_engine(f"sqlite:///{tmp_path / 'f.db'}")
    Base.metadata.create_all(bind=engine)
    Session = sessionmaker(bind=engine, expire_on_commit=False)
    acct = _Account()
    monkeypatch.setattr(growatt_sync.time, "sleep", lambda s: None)
    with Session() as db:
        growatt_sync.sync_fleet(db, acct, pause_s=0, phase=1)  # type: ignore[arg-type]

        def boom(*a, **kw):
            raise GrowattAPIError("offline", error_code=10001)

        acct.env_history = boom  # type: ignore[method-assign]
        totals = growatt_sync.sync_env_all(db, acct, DAY.date(), DAY.date(), pause_s=0)  # type: ignore[arg-type]
        assert totals["env_rows"] == 0 and totals["env_failed"][0][0] == "DLS/3"


# --------------------------------------------------------------------------- DB routes


def test_weather_route_series_kpis_and_unmeasured_fields(env):
    c, _app, _S = env
    w = c.get(f"/api/growatt/plants/{PLANT}/weather", params={"day": "2026-11-11"}).json()
    assert w["meta"] == {"source": "db", "day": "2026-11-11", "data_until": "2026-11-11 20:25:00", "window": None, "sensor": None}
    assert w["has_sensor"] is True
    s = w["sensors"][0]
    assert s["datalogger_sn"] == DL and s["address"] == ADDR
    # humidity read 0 all day: not fitted -> null, never 0
    assert "humidity_pct" not in s["measured"] and "irradiance_wm2" in s["measured"]
    assert all(p["humidity_pct"] is None for p in w["series"])
    noon = next(p for p in w["series"] if p["timestamp"] == "2026-11-11 12:00:00")
    assert noon["irradiance_wm2"] == 600 and noon["module_temp_c"] == 48.0
    night = next(p for p in w["series"] if p["timestamp"] == "2026-11-11 20:00:00")
    assert night["irradiance_wm2"] == 0  # a measured zero stays zero

    k = w["kpis"]
    assert k["insolation_kwh_m2"] == pytest.approx(97 * 5 / 60 * 0.6, abs=0.01)  # 97 samples × 5 min × 0.6 kW/m²
    assert k["peak_irradiance_wm2"] == 600
    assert k["avg_module_temp_daylight_c"] == 48.0  # night readings excluded
    assert k["avg_humidity_pct"] is None
    # default day = latest day with weather data
    assert c.get(f"/api/growatt/plants/{PLANT}/weather").json()["meta"]["day"] == "2026-11-11"


def test_weather_route_time_window_narrows_series_and_kpis(env):
    c, _app, _S = env
    url = f"/api/growatt/plants/{PLANT}/weather"
    w = c.get(url, params={"day": "2026-11-11", "start": "10:00", "end": "12:00"}).json()
    assert w["meta"]["window"] == {"start": "10:00", "end": "12:00"}
    ts = [p["timestamp"] for p in w["series"]]
    assert ts[0] == "2026-11-11 10:00:00" and ts[-1] == "2026-11-11 12:00:00" and len(ts) == 25  # both ends inclusive
    assert w["kpis"]["insolation_kwh_m2"] == pytest.approx(25 * 5 / 60 * 0.6, abs=0.01)
    assert w["sensors"][0]["samples"] > 25  # sensor info still describes the whole day
    # open-ended window: evening only holds the night readings
    night = c.get(url, params={"day": "2026-11-11", "start": "19:00"}).json()
    assert night["meta"]["window"] == {"start": "19:00", "end": None}
    assert night["kpis"]["insolation_kwh_m2"] == 0 and night["kpis"]["avg_module_temp_daylight_c"] is None
    assert c.get(url, params={"day": "2026-11-11", "start": "12:00", "end": "10:00"}).status_code == 422


def test_weather_route_one_sensor_of_several(env):
    """A second sensor reading 800 W/m²: default = average of both, `sensor=` = that sensor only."""
    c, _app, Session = env
    with Session() as s:
        s.add(GrowattEnvSensor(datalogger_sn="DLW2", address=1, plant_id=PLANT, device_name="ENV_2"))
        s.flush()
        recs = [_env(DAY + timedelta(hours=8, minutes=m), 800) for m in range(0, 8 * 60 + 1, 5)]
        for row in parse_env_records("DLW2", 1, recs):
            s.add(GrowattEnvReading(**row))
        s.commit()
    url = f"/api/growatt/plants/{PLANT}/weather"
    noon = lambda w: next(p for p in w["series"] if p["timestamp"] == "2026-11-11 12:00:00")["irradiance_wm2"]
    both = c.get(url, params={"day": "2026-11-11"}).json()
    assert noon(both) == 700 and both["meta"]["sensor"] is None
    one = c.get(url, params={"day": "2026-11-11", "sensor": "DLW2:1"}).json()
    assert noon(one) == 800 and one["kpis"]["peak_irradiance_wm2"] == 800
    assert one["meta"]["sensor"] == {"datalogger_sn": "DLW2", "address": 1}
    assert len(one["sensors"]) == 2  # every sensor is still listed
    first = c.get(url, params={"day": "2026-11-11", "sensor": f"{DL}:{ADDR}"}).json()
    assert noon(first) == 600
    assert c.get(url, params={"sensor": "NOPE:9"}).status_code == 404
    assert c.get(url, params={"sensor": "bad value"}).status_code == 422


def test_weather_route_without_sensor_and_unknown_plant(env):
    c, _app, _S = env
    bare = c.get(f"/api/growatt/plants/{BARE}/weather").json()
    assert bare["has_sensor"] is False and bare["series"] == [] and bare["kpis"]["insolation_kwh_m2"] is None
    assert c.get("/api/growatt/plants/999/weather").status_code == 404


def test_power_range_carries_measured_irradiance_per_day(env):
    """The day-range curve gets the sensor's POA irradiance slot by slot, as the day view; null without a sensor."""
    c, _app, _S = env
    rng = c.get(f"/api/growatt/plants/{PLANT}/power", params={"day": "2026-11-10", "end_day": "2026-11-11"}).json()
    by_ts = {r["timestamp"]: r["irradiance_wm2"] for r in rng["timeseries"]}
    assert by_ts["2026-11-11 12:00:00"] == 600 and by_ts["2026-11-10 09:00:00"] == 600
    assert by_ts["2026-11-10 12:00:00"] is None  # the sensor stopped at 10:00 that day
    ov = c.get(f"/api/growatt/plants/{PLANT}/overview", params={"day": "2026-11-11"}).json()
    one = c.get(f"/api/growatt/plants/{PLANT}/power", params={"day": "2026-11-11"}).json()
    assert [r["irradiance_wm2"] for r in one["timeseries"]] == [r["irradiance_wm2"] for r in ov["timeseries"]]
    bare = c.get(f"/api/growatt/plants/{BARE}/power", params={"day": "2026-11-11"}).json()
    assert bare["timeseries"] and all(r["irradiance_wm2"] is None for r in bare["timeseries"])


def test_overview_iec_pr_from_measured_irradiance(env):
    c, _app, _S = env
    ov = c.get(f"/api/growatt/plants/{PLANT}/overview", params={"day": "2026-11-11"}).json()
    k = ov["kpis"]
    h = 97 * 5 / 60 * 0.6
    # PR = (E / P0) / (H / 1 kW/m²) = (40 kWh / 10 kWp) / 4.85 h
    assert k["iec_pr_pct"] == pytest.approx(40 / 10 / h * 100, abs=0.2)
    assert k["insolation_kwh_m2"] == pytest.approx(h, abs=0.01)
    assert ov["weather"]["iec_pr"]["coverage_pct"] == 100 and ov["weather"]["iec_pr"]["reason"] is None
    assert ov["timeseries"][0]["irradiance_wm2"] == 600
    # daily check times: the sensor reported 08:00–16:00, so nothing near 17:00
    slots = ov["weather"]["check_slots"]
    assert set(slots) == {"09", "13", "17"} and slots["17"] is None
    assert slots["09"] == {"at": "09:00", "irradiance_wm2": 600, "module_temp_c": 48.0}
    assert slots["13"]["irradiance_wm2"] == 600
    assert ov["loss_waterfall"][0]["stage"].startswith("POA Insolation")
    assert ov["loss_waterfall"][0]["kwh"] == pytest.approx(10 * h, abs=0.1)

    bare = c.get(f"/api/growatt/plants/{BARE}/overview", params={"day": "2026-11-11"}).json()
    assert bare["kpis"]["iec_pr_pct"] is None and bare["weather"]["iec_pr"]["reason"] == "no weather sensor"
    assert all(p["irradiance_wm2"] is None for p in bare["timeseries"])


def test_iec_pr_is_null_when_the_sensor_missed_most_of_the_day(env):
    c, _app, _S = env
    ov = c.get(f"/api/growatt/plants/{PLANT}/overview", params={"day": "2026-11-10"}).json()
    pr = ov["weather"]["iec_pr"]
    # yield over 8 h against 2 h of irradiance would read ~400 %: refuse instead
    assert ov["kpis"]["iec_pr_pct"] is None
    assert pr["coverage_pct"] == 26 and "26%" in pr["reason"]


# --------------------------------------------------------------------------- live


class _EnvLive:
    def __init__(self):
        self.calls = 0

    def env_latest(self, datalogger_sn, address):
        self.calls += 1
        return _env(datetime(2026, 11, 12, 11, 45), 777, hum=0)


def test_live_weather_nulls_unfitted_probes_and_writes_nothing(env, monkeypatch):
    c, app, Session = env
    fake = _EnvLive()
    svc = GrowattLiveService(client_factory=lambda phase: fake, ttl_s=60)  # type: ignore[arg-type,return-value]
    app.dependency_overrides[get_live_service] = lambda: svc
    # the route looks back 7 days for which probes report; pin "now" right after the seeded days
    from app.api.routes.growatt import live as routes

    class _Now(datetime):
        @classmethod
        def now(cls, tz=None):
            return datetime(2026, 11, 12, 12, 0, tzinfo=tz)

    monkeypatch.setattr(routes, "datetime", _Now)

    with Session() as db:
        before = db.scalar(select(func.count()).select_from(GrowattEnvReading))
    r = c.get(f"/api/growatt/live/plants/{PLANT}/weather")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["source"] == "live"
    s = body["data"]["sensors"][0]
    assert s["timestamp"] == "2026-11-12 11:45:00" and s["irradiance_wm2"] == 777
    assert s["humidity_pct"] is None  # never measured in the stored week
    c.get(f"/api/growatt/live/plants/{PLANT}/weather")
    assert fake.calls == 1  # served from memory until the next record is due
    with Session() as db:
        assert db.scalar(select(func.count()).select_from(GrowattEnvReading)) == before
    assert c.get(f"/api/growatt/live/plants/{BARE}/weather").status_code == 404


class _EnvSeq:
    """env_last_data returning whatever record time the test sets."""

    def __init__(self):
        self.ts = datetime(2026, 11, 12, 11, 45)
        self.calls = 0

    def env_latest(self, datalogger_sn, address):
        self.calls += 1
        return _env(self.ts, 700)


def test_live_weather_measures_interval_from_consecutive_records_and_ttl_follows_it():
    t = [1_000.0]
    now = [datetime(2026, 11, 12, 11, 45, 30)]
    fake = _EnvSeq()
    svc = GrowattLiveService(
        client_factory=lambda phase: fake,  # type: ignore[arg-type,return-value]
        clock=lambda: t[0],
        now_local=lambda: now[0],
    )
    sensors = [(DL, ADDR, None)]

    first = svc.plant_weather(PLANT, sensors)
    assert first["data"]["sensors"][0]["interval_s"] is None  # one record: not measured yet
    assert first["refresh_in_s"] == pytest.approx(330)  # default 300 s rhythm + 60 s grace - 30 s since the record

    # next record 2 min later: the sensor's real rhythm is 120 s
    t[0] += 330
    fake.ts, now[0] = datetime(2026, 11, 12, 11, 47), datetime(2026, 11, 12, 11, 47, 30)
    second = svc.plant_weather(PLANT, sensors)
    assert second["data"]["sensors"][0]["interval_s"] == 120
    assert second["refresh_in_s"] == pytest.approx(150)  # 120 + 60 - 30, not the 5-min default

    # the same record fetched again keeps the measured interval
    t[0] += 150
    now[0] = datetime(2026, 11, 12, 11, 50)
    assert svc.plant_weather(PLANT, sensors)["data"]["sensors"][0]["interval_s"] == 120

    # a 2 h outage is not the rhythm: keep 120
    t[0] += 3600
    fake.ts, now[0] = datetime(2026, 11, 12, 13, 50), datetime(2026, 11, 12, 13, 50, 10)
    assert svc.plant_weather(PLANT, sensors)["data"]["sensors"][0]["interval_s"] == 120
    assert fake.calls == 4


def test_live_weather_carries_stored_until_per_sensor(env, monkeypatch):
    c, app, Session = env
    app.dependency_overrides[get_live_service] = lambda: GrowattLiveService(client_factory=lambda phase: _EnvLive(), ttl_s=60)  # type: ignore[arg-type,return-value]
    from app.api.routes.growatt import live as routes

    class _Now(datetime):
        @classmethod
        def now(cls, tz=None):
            return datetime(2026, 11, 12, 12, 0, tzinfo=tz)

    monkeypatch.setattr(routes, "datetime", _Now)
    with Session() as db:
        stored_max = db.scalar(select(func.max(GrowattEnvReading.timestamp)))
        sensor = db.get(GrowattEnvSensor, (DL, ADDR))
        sensor.history_synced_until = stored_max  # as `sync_env` sets it
        db.commit()
    s = c.get(f"/api/growatt/live/plants/{PLANT}/weather").json()["data"]["sensors"][0]
    assert s["stored_until"] == stored_max.strftime("%Y-%m-%d %H:%M:%S") == "2026-11-11 20:25:00"
    assert s["timestamp"] > s["stored_until"]  # the live record is newer than the DB series


# --------------------------------------------------------------------------- env_history job


def _sensors_db(tmp_path, n: int):
    """n sensors on one phase-1 plant; sensor i last stored i hours before 10:00 (0 = never)."""
    engine = build_engine(f"sqlite:///{tmp_path / 'eh.db'}")
    Base.metadata.create_all(bind=engine)
    Session = sessionmaker(bind=engine, expire_on_commit=False)
    with Session() as db:
        db.add(GrowattPlant(plant_id=PLANT, name="P", phase=1))
        db.flush()
        for i in range(n):
            synced = None if i == 0 else DAY + timedelta(hours=10 - i)
            db.add(GrowattEnvSensor(datalogger_sn=f"DL{i}", address=1, plant_id=PLANT, history_synced_until=synced))
        db.commit()
    return Session


def test_env_sweep_goes_oldest_first_and_stops_after_three_rate_limits(tmp_path, monkeypatch):
    waits: list = []
    monkeypatch.setattr(growatt_sync.time, "sleep", waits.append)
    Session = _sensors_db(tmp_path, 6)
    calls: list = []

    class Limited:
        def env_history(self, dl, addr, start, end, stop_before=None):
            calls.append(dl)
            raise GrowattAPIError("rate limited", error_code=10012)

    with Session() as db:
        totals = growatt_sync.sync_env_incremental(
            db, Limited(), DAY.date(), pause_s=0, phase=1, retries=0, max_rate_limited=3  # type: ignore[arg-type]
        )
    # never synced first, then the sensor stored longest ago; no retries; 3 × 10012 ends the sweep
    assert calls == ["DL0", "DL5", "DL4"]
    assert totals["env_failed"][-1] == ("rate limited", "3 sensors left for the next run")
    assert not any(waits)  # retries=0: no 60–120 s rate-limit waits


def test_env_sweep_keeps_going_after_one_rate_limit(tmp_path, monkeypatch):
    monkeypatch.setattr(growatt_sync.time, "sleep", lambda s: None)
    Session = _sensors_db(tmp_path, 4)
    calls: list = []

    class Flaky:
        def env_history(self, dl, addr, start, end, stop_before=None):
            calls.append(dl)
            if dl in ("DL0", "DL2"):  # never two in a row
                raise GrowattAPIError("rate limited", error_code=10012)
            return []

    with Session() as db:
        totals = growatt_sync.sync_env_incremental(
            db, Flaky(), DAY.date(), pause_s=0, phase=1, retries=0, max_rate_limited=3  # type: ignore[arg-type]
        )
    assert sorted(calls) == ["DL0", "DL1", "DL2", "DL3"]
    assert [f[0] for f in totals["env_failed"]] == ["DL0/1", "DL2/1"]


def test_env_history_job_upserts_alongside_history(tmp_path, monkeypatch):
    from app.services import jobs

    engine = build_engine(f"sqlite:///{tmp_path / 'j.db'}")
    Base.metadata.create_all(bind=engine)
    Session = sessionmaker(bind=engine, expire_on_commit=False)
    acct = _Account()
    monkeypatch.setattr(jobs, "_clients", lambda: {1: acct})
    monkeypatch.setattr(jobs, "_today", lambda: DAY.date())
    monkeypatch.setattr(growatt_sync.time, "sleep", lambda s: None)
    with Session() as db:
        growatt_sync.sync_fleet(db, acct, pause_s=0, phase=1)  # type: ignore[arg-type]
        status, detail = jobs.job_env_history(db)
        assert status == "ok" and detail["env_rows"] == 3 and detail["env_sensors"] == 1
        jobs.job_history(db)  # same records again from the full history job
        status, _ = jobs.job_env_history(db)
        assert status == "ok"
        assert db.scalar(select(func.count()).select_from(GrowattEnvReading)) == 3  # idempotent
        assert "env_history" in jobs.JOBS


def test_env_history_schedule_window_history_overlap_and_off(tmp_path, monkeypatch):
    from app import worker
    from app.services import jobs
    from app.worker import Schedule, tick

    bkk = jobs.PLANT_TZ
    s = Schedule("env_history", every=timedelta(minutes=10), between=(5, 20), covered_by=("history",))
    assert s.is_due(datetime(2026, 11, 13, 5, 0, tzinfo=bkk), None)
    assert not s.is_due(datetime(2026, 11, 13, 4, 59, tzinfo=bkk), None)
    assert not s.is_due(datetime(2026, 11, 13, 20, 0, tzinfo=bkk), None)

    names = lambda: [x.job for x in worker.default_schedule()]  # noqa: E731
    monkeypatch.setattr(worker.settings, "worker_env_interval_min", 10)
    assert "env_history" in names()
    monkeypatch.setattr(worker.settings, "worker_env_interval_min", 0)
    assert "env_history" not in names()

    # a `history` start counts as an env sync: the two never both run in one tick
    engine = build_engine(f"sqlite:///{tmp_path / 'w.db'}")
    Base.metadata.create_all(bind=engine)
    factory = sessionmaker(bind=engine, expire_on_commit=False)
    with factory() as db:
        db.add(GrowattPlant(plant_id=1, name="P"))
        db.flush()
        db.add(GrowattInverter(device_sn="I", plant_id=1))
        db.commit()
    ran: list = []
    monkeypatch.setattr(jobs, "JOBS", {j: (lambda db, j=j: ran.append(j) or ("ok", {})) for j in ("history", "env_history")})
    sched = [Schedule("history", every=timedelta(minutes=30)), s]
    t0 = datetime(2026, 11, 13, 10, 0, tzinfo=bkk)
    assert tick(factory, sched, t0) == ["history"]
    assert tick(factory, sched, t0 + timedelta(minutes=5)) == []
    assert tick(factory, sched, t0 + timedelta(minutes=10)) == ["env_history"]
    assert tick(factory, sched, t0 + timedelta(minutes=20)) == ["env_history"]
    assert tick(factory, sched, t0 + timedelta(minutes=30)) == ["history"]
