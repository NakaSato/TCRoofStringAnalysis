"""Weather sensors fleet list (DB only): newest stored reading, probes, coverage, access."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import func, select
from sqlalchemy.orm import sessionmaker

from app.db.models import GrowattEnvReading, GrowattEnvSensor, GrowattPlant, SyncRun, User, UserPlantAssignment
from app.db.seed import ensure_seeded
from app.db.session import Base, build_engine, get_db
from app.main import create_app
from app.services import growatt_sensors as gs
from app.services.growatt_live import GrowattLiveService, get_live_service
from solar_core.growatt import GrowattAPIError

TODAY = datetime(2026, 11, 13)
NOW = TODAY.replace(hour=12)
SYNC_LOCAL = TODAY.replace(hour=10)  # last history run started 10:00 Bangkok = 03:00 UTC


def _reading(dl, addr, ts, g=500.0):
    return GrowattEnvReading(
        datalogger_sn=dl, address=addr, timestamp=ts, irradiance_wm2=g, ambient_temp_c=31.0, module_temp_c=45.0,
        humidity_pct=0.0, wind_speed_ms=2.0, wind_dir_deg=90.0,
    )


@pytest.fixture()
def factory(tmp_path):
    engine = build_engine(f"sqlite:///{tmp_path / 'sensors.db'}")
    Base.metadata.create_all(bind=engine)
    f = sessionmaker(bind=engine, autoflush=False, autocommit=False, expire_on_commit=False)
    with f() as s:
        ensure_seeded(s)
        s.add_all([GrowattPlant(plant_id=1, name="Alpha", phase=2), GrowattPlant(plant_id=2, name="Beta")])
        s.flush()
        start = TODAY.replace(hour=6)
        # DL1#1 every 5 min 06:00–09:55, but silent 07:00–07:55 (12 slots); humidity probe not fitted
        five = [start + timedelta(minutes=m) for m in range(0, 240, 5) if not 60 <= m < 120]
        # DL1#2 every minute 06:00–09:59: several records per slot still count once
        one = [start + timedelta(minutes=m) for m in range(240)]
        s.add_all(
            [
                GrowattEnvSensor(datalogger_sn="DL1", address=1, plant_id=1, device_name="ENV_A", history_synced_until=five[-1]),
                GrowattEnvSensor(datalogger_sn="DL1", address=2, plant_id=1, device_name="ENV_B", history_synced_until=one[-1]),
                GrowattEnvSensor(datalogger_sn="DL2", address=1, plant_id=2, device_name="ENV_C"),  # nothing stored yet
            ]
        )
        s.flush()
        s.add_all([_reading("DL1", 1, t, g=600.0 if t == five[-1] else 500.0) for t in five])
        s.add_all([_reading("DL1", 2, t) for t in one])
        s.add(
            SyncRun(
                job="history", status="ok",
                started_at=SYNC_LOCAL.replace(tzinfo=timezone(timedelta(hours=7))).astimezone(timezone.utc),
                finished_at=datetime(2026, 11, 13, 3, 5, tzinfo=timezone.utc),
            )
        )
        s.commit()
    return f


def test_list_sensors_last_reading_probes_and_coverage(factory):
    with factory() as db:
        body = gs.list_sensors(db, None, now_local=lambda: NOW)
    assert body["meta"]["source"] == "db"
    # judged up to the last sync (10:00), not up to now (12:00): later slots are not fetched yet
    assert body["meta"]["coverage_window"] == {"start": "06:00", "until": "10:00"}
    by = {s["key"]: s for s in body["sensors"]}
    assert list(by) == ["DL1:1", "DL1:2", "DL2:1"]  # by plant name, then sensor

    a = by["DL1:1"]
    assert a["plant_name"] == "Alpha" and a["phase"] == 2 and a["status"] == "unknown"
    assert a["last_reading_at"] == "2026-11-13 09:55:00"
    assert a["last"]["irradiance_wm2"] == 600.0
    assert "humidity_pct" not in a["measured"] and a["last"]["humidity_pct"] is None  # unfitted: null, not 0
    assert a["coverage_today_pct"] == 75.0  # 36 of 48 slots

    assert by["DL1:2"]["coverage_today_pct"] == 100.0  # 1-min records: 48 slots, not 240

    c = by["DL2:1"]
    assert c["status"] == "not_synced" and c["last_reading_at"] is None
    assert c["last"] is None and c["measured"] is None and c["coverage_today_pct"] == 0.0


def test_coverage_is_null_without_a_sync_run_or_before_daylight(factory):
    with factory() as db:
        assert gs.list_sensors(db, None, now_local=lambda: TODAY.replace(hour=5))["sensors"][0]["coverage_today_pct"] is None
        for run in db.scalars(select(SyncRun)):
            db.delete(run)
        db.commit()
        body = gs.list_sensors(db, None, now_local=lambda: NOW)
    assert body["meta"]["coverage_window"]["until"] is None
    assert all(s["coverage_today_pct"] is None for s in body["sensors"])


def _api(factory, username):
    app = create_app()

    def _db():
        db = factory()
        try:
            yield db
        finally:
            db.close()

    app.dependency_overrides[get_db] = _db
    c = TestClient(app)
    pw = {"admin": "admin123", "engineer": "engineer123"}[username]
    tok = c.post("/api/auth/login", json={"username": username, "password": pw}).json()["access_token"]
    c.headers["Authorization"] = f"Bearer {tok}"
    c.app_ref = app  # type: ignore[attr-defined]
    return c


def test_route_filters_engineer_to_assigned_plants(factory):
    admin = _api(factory, "admin")
    assert [s["key"] for s in admin.get("/api/growatt/sensors").json()["sensors"]] == ["DL1:1", "DL1:2", "DL2:1"]

    eng = _api(factory, "engineer")
    assert eng.get("/api/growatt/sensors").json()["sensors"] == []
    with factory() as db:
        uid = db.scalar(select(User.id).where(User.username == "engineer"))
        db.add(UserPlantAssignment(user_id=uid, plant_id=2))
        db.commit()
    assert [s["key"] for s in eng.get("/api/growatt/sensors").json()["sensors"]] == ["DL2:1"]


# --------------------------------------------------------------------------- live status (memory only)


class _EnvList:
    """Fake `env_list`: per-datalogger answers, a call log, and dataloggers that fail."""

    def __init__(self, answers=None):
        self.answers = answers or {}
        self.calls: list = []
        self.fail: dict = {}

    def list_env_sensors(self, datalogger_sn, refresh=False):
        self.calls.append(datalogger_sn)
        if datalogger_sn in self.fail:
            raise self.fail[datalogger_sn]
        return self.answers.get(datalogger_sn, [{"address": "1", "lost": "0", "lastUpdateTime": "2026-11-13 11:58:00"}])


class _Clock:
    def __init__(self):
        self.t = 1000.0

    def __call__(self):
        return self.t


def _svc(fake, clock, **kw):
    return GrowattLiveService(client_factory=lambda phase: fake, clock=clock, phases=(1, 2), sensor_ttl_s=300, **kw)  # type: ignore[arg-type,return-value]


def test_sweep_refreshes_at_most_n_per_request_oldest_first():
    fake, clock = _EnvList(), _Clock()
    svc = _svc(fake, clock, sensor_sweep=12)
    dls = [(f"DL{i:02d}", 1) for i in range(30)]

    env = svc.sensor_status(dls)
    assert len(fake.calls) == 12 and env["refresh_in_s"] == 15  # sweep not complete: come back soon
    assert env["data"]["sweep"] == {"fresh": 12, "checked": 12, "total": 30, "oldest_age_s": 0}
    first = set(fake.calls)
    clock.t += 15
    svc.sensor_status(dls)
    clock.t += 15
    env = svc.sensor_status(dls)
    assert len(fake.calls) == 30 and len(set(fake.calls)) == 30  # each datalogger once
    assert env["data"]["sweep"]["fresh"] == 30
    assert env["refresh_in_s"] == 270  # until the first batch expires (300 s after it was fetched)
    assert env["data"]["dataloggers"]["DL00"]["sensors"] == [
        {"address": 1, "lost": False, "last_update_time": "2026-11-13 11:58:00"}
    ]

    svc.sensor_status(dls)
    assert len(fake.calls) == 30  # all fresh: served from memory
    clock.t += 300  # everything expired: the oldest (first) batch goes first
    svc.sensor_status(dls)
    assert set(fake.calls[30:]) == first


def test_rate_limit_cools_one_datalogger_down_and_serves_the_others():
    fake, clock = _EnvList(), _Clock()
    svc = _svc(fake, clock, sensor_sweep=12, cooldown_s=60)
    dls = [("A", 1), ("B", 2)]
    fake.fail["B"] = GrowattAPIError("rate limited", error_code=10012)
    env = svc.sensor_status(dls)
    assert set(env["data"]["dataloggers"]) == {"A"} and "B" in env["data"]["errors"]
    assert env["refresh_in_s"] == 60  # A fresh, B cooling down: the cooldown ends first

    clock.t += 30
    svc.sensor_status(dls)
    assert fake.calls.count("B") == 1  # not retried during its cooldown
    del fake.fail["B"]
    clock.t += 31
    env = svc.sensor_status(dls)
    assert fake.calls.count("B") == 2 and set(env["data"]["dataloggers"]) == {"A", "B"}


def test_live_status_thresholds():
    now = datetime(2026, 11, 13, 12, 0)
    st = lambda lost, t: gs.live_status(lost, t, now, 15, 60)
    assert st(False, "2026-11-13 11:45:00") == "online"
    assert st(False, "2026-11-13 11:44:00") == "late"
    assert st(False, "2026-11-13 11:00:00") == "late"
    assert st(False, "2026-11-13 10:59:00") == "offline"
    assert st(True, "2026-11-13 11:59:00") == "offline"  # Growatt says lost
    assert st(False, None) == "unknown" and st(None, "garbage") == "unknown"


def test_status_route_engineer_sweeps_own_dataloggers_and_writes_nothing(factory, monkeypatch):
    from app.api.routes import growatt as routes

    class _Now(datetime):
        @classmethod
        def now(cls, tz=None):
            return NOW.replace(tzinfo=tz) if tz else NOW

    monkeypatch.setattr(routes, "datetime", _Now)
    fake = _EnvList(
        {
            "DL1": [
                {"address": "1", "lost": "0", "lastUpdateTime": "2026-11-13 11:58:00"},
                {"address": "2", "lost": "1", "lastUpdateTime": "2026-11-13 11:59:00"},
            ],
            "DL2": [{"address": "1", "lost": "0", "lastUpdateTime": "2026-11-13 11:30:00"}],
        }
    )
    svc = _svc(fake, _Clock())

    def counts():
        with factory() as db:
            return [db.scalar(select(func.count()).select_from(t)) for t in (GrowattEnvReading, GrowattEnvSensor, SyncRun)]

    before = counts()
    eng = _api(factory, "engineer")
    eng.app_ref.dependency_overrides[get_live_service] = lambda: svc  # type: ignore[attr-defined]
    with factory() as db:
        uid = db.scalar(select(User.id).where(User.username == "engineer"))
        db.add(UserPlantAssignment(user_id=uid, plant_id=2))
        db.commit()
    body = eng.get("/api/growatt/live/sensors/status").json()
    assert fake.calls == ["DL2"]  # only the engineer's datalogger is swept
    assert [(s["key"], s["status"]) for s in body["data"]["sensors"]] == [("DL2:1", "late")]

    admin = _api(factory, "admin")
    admin.app_ref.dependency_overrides[get_live_service] = lambda: svc  # type: ignore[attr-defined]
    body = admin.get("/api/growatt/live/sensors/status").json()
    assert sorted(fake.calls) == ["DL1", "DL2"]  # DL2 came from the shared cache
    by = {s["key"]: s for s in body["data"]["sensors"]}
    assert by["DL1:1"]["status"] == "online" and by["DL1:1"]["last_update_time"] == "2026-11-13 11:58:00"
    assert by["DL1:2"]["status"] == "offline" and by["DL1:2"]["lost"] is True
    assert body["source"] == "live" and body["data"]["sweep"]["fresh"] == 2
    assert counts() == before  # nothing stored
