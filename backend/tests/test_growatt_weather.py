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
    assert w["meta"] == {"source": "db", "day": "2026-11-11", "data_until": "2026-11-11 20:25:00", "window": None}
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


def test_weather_route_without_sensor_and_unknown_plant(env):
    c, _app, _S = env
    bare = c.get(f"/api/growatt/plants/{BARE}/weather").json()
    assert bare["has_sensor"] is False and bare["series"] == [] and bare["kpis"]["insolation_kwh_m2"] is None
    assert c.get("/api/growatt/plants/999/weather").status_code == 404


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
    from app.api.routes import growatt as routes

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
