"""GET /report/pwa/{day}: shared-key access for the PWA Report sheet."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import sessionmaker

from app.api.routes import report
from app.config import settings
from app.db.models import GrowattInverter, GrowattPlant
from app.db.session import Base, build_engine, get_db
from app.main import create_app

DOC = {"hourly_kw": [None] * 9 + [12.5], "checks": {"09": {"inverters": 1, "offline": [], "fault": [], "alarms": []}}}


@pytest.fixture()
def client(tmp_path, monkeypatch):
    engine = build_engine(f"sqlite:///{tmp_path / 'r.db'}")
    Session = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)
    Base.metadata.create_all(bind=engine)
    with Session() as s:
        s.add(GrowattPlant(plant_id=7, name="สถานี A", latitude=14.1, longitude=100.5))
        s.flush()
        s.add(GrowattInverter(device_sn="INV1", plant_id=7, datalogger_sn="DL1"))
        s.add(GrowattInverter(device_sn="INV2", plant_id=7))
        s.commit()
    app = create_app()

    def _db():
        with Session() as db:
            yield db

    seen = []
    app.dependency_overrides[get_db] = _db
    app.dependency_overrides[report.get_day_docs] = lambda: (lambda day: seen.append(day) or [("7", DOC)])
    monkeypatch.setattr(settings, "report_api_key", "s3cret")
    c = TestClient(app)
    c.seen = seen
    return c


def test_needs_the_key(client, monkeypatch):
    assert client.get("/api/report/pwa/2026-11-13").status_code == 401
    assert client.get("/api/report/pwa/2026-11-13", headers={"X-Report-Key": "nope"}).status_code == 401
    monkeypatch.setattr(settings, "report_api_key", "")
    assert client.get("/api/report/pwa/2026-11-13", headers={"X-Report-Key": ""}).status_code == 503


def test_returns_registry_and_day_docs(client):
    r = client.get("/api/report/pwa/2026-11-13", headers={"X-Report-Key": "s3cret"})
    assert r.status_code == 200
    body = r.json()
    assert body["day"] == "2026-11-13"
    assert body["plants"] == {"7": {"name": "สถานี A", "latitude": 14.1, "longitude": 100.5}}
    assert body["loggers"] == {"DL1": "7"}
    assert body["days"]["7"]["hourly_kw"][9] == 12.5
    assert str(client.seen[0]) == "2026-11-13"
    assert client.get("/api/report/pwa/13.11", headers={"X-Report-Key": "s3cret"}).status_code == 422


def test_cells_are_the_sheet_values(client):
    r = client.get("/api/report/pwa/2026-11-13/cells?hours=9", headers={"X-Report-Key": "s3cret"})
    assert r.status_code == 200
    body = r.json()
    assert body["hours"] == ["09"] and body["published_plants"] == 1
    assert body["columns"] == ["status", "note", "irr", "wx", "log", "kw", "inv"]
    assert body["loggers"] == {"DL1": "7"} and body["names"] == {"7": "สถานี A"}
    p = body["plants"]["7"]
    assert p["checks"] == {"09": ["normal", "INV ทำงานปกติ", "—", "—", "online", 12.5, "1/1"]}
    assert p["weather_status"] == "ไม่มีเซนเซอร์" and p["yield_kwh"] == "—"


def test_cells_hours_param(client):
    h = {"X-Report-Key": "s3cret"}
    assert list(client.get("/api/report/pwa/2026-11-13/cells", headers=h).json()["plants"]["7"]["checks"]) == ["09", "13", "17"]
    assert client.get("/api/report/pwa/2026-11-13/cells?hours=09,17", headers=h).json()["hours"] == ["09", "17"]
    assert client.get("/api/report/pwa/2026-11-13/cells?hours=10", headers=h).status_code == 422
    assert client.get("/api/report/pwa/2026-11-13/cells?hours=x", headers=h).status_code == 422
    assert client.get("/api/report/pwa/2026-11-13/cells").status_code == 401


def test_gzip_when_asked(client):
    r = client.get("/api/report/pwa/2026-11-13", headers={"X-Report-Key": "s3cret", "Accept-Encoding": "gzip"})
    assert r.status_code == 200
    # tiny test payload stays under the gzip threshold; real days (~100 KB) are compressed
    assert r.headers.get("content-encoding") in (None, "gzip")
