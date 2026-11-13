"""Weather sensors fleet list (DB only): newest stored reading, probes, coverage, access."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import sessionmaker

from app.db.models import GrowattEnvReading, GrowattEnvSensor, GrowattPlant, SyncRun, User, UserPlantAssignment
from app.db.seed import ensure_seeded
from app.db.session import Base, build_engine, get_db
from app.main import create_app
from app.services import growatt_sensors as gs

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
