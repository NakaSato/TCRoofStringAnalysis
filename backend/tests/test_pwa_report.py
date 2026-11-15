"""GET /report/pwa/{day}: shared-key access for the PWA Report sheet."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import sessionmaker

from datetime import date

from app.api.routes import report
from app.services import pwa_report
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
        s.add(GrowattInverter(device_sn="INV1", plant_id=7, datalogger_sn="DL1", fw_version="TI1.0", inner_version="TIAA25220401"))
        s.add(GrowattInverter(device_sn="INV3", plant_id=7, datalogger_sn="DL1", fw_version="TN1.0"))
        s.add(GrowattInverter(device_sn="INV4", plant_id=7, datalogger_sn="DL1", alias="INV 4 old", inner_version="ZZ"))
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
    c.app = app
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
    assert p["weather_status"] == "Abnormal" and p["weather_detail"] == "ไม่มีเซนเซอร์" and p["yield_kwh"] == "—"
    assert p["datalogger_sn"] == ["DL1"]
    # inverter firmware per datalogger: innerVersion, else fwVersion; replaced inverters left out
    assert body["firmware"] == {"DL1": "TIAA25220401, TN1.0"}
    assert body["checks_ready"] == ["09"]  # an older day without `checks_ready`: what is there counts


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


def test_cells_gate_on_the_published_checks(client):
    """`checks_ready` of daily/{day}: a check not in it is "—" for every plant."""
    doc = {**DOC, "checks": {"09": {**DOC["checks"]["09"], "at": "08:50", "kw": 3.0}}}
    h = {"X-Report-Key": "s3cret"}
    client.app.dependency_overrides[report.get_day_docs] = lambda: (lambda day: [(pwa_report.DAY_KEY, {"checks_ready": []}), ("7", doc)])
    body = client.get("/api/report/pwa/2026-11-13/cells?hours=9", headers=h).json()
    assert body["checks_ready"] == [] and body["published_plants"] == 1
    assert body["plants"]["7"]["checks"]["09"] == ["—"] * 7
    client.app.dependency_overrides[report.get_day_docs] = lambda: (lambda day: [(pwa_report.DAY_KEY, {"checks_ready": ["09"]}), ("7", doc)])
    body = client.get("/api/report/pwa/2026-11-13/cells?hours=9,13", headers=h).json()
    assert body["checks_ready"] == ["09"]
    assert body["plants"]["7"]["checks"]["09"][5] == 3.0  # kW of the 08:50 slot, not hourly_kw[9]
    assert body["plants"]["7"]["checks"]["13"] == ["—"] * 7


def test_firestore_reader_reads_the_fleet_doc_first(monkeypatch):
    calls = []

    class Snap:
        def __init__(self, id_, data):
            self.id, self._d, self.exists = id_, data, True

        def to_dict(self):
            return self._d

    class Ref:
        def get(self, field_paths=None):
            calls.append(("fleet", field_paths))
            return Snap("2026-11-13", {"checks_ready": ["09"]})

    class Query:
        def select(self, _fields):
            return self

        def stream(self):
            calls.append(("plants", None))
            return iter([Snap("7", {"yield_kwh": 1.0})])

    class Client:
        def document(self, path):
            assert path == "daily/2026-11-13"
            return Ref()

        def collection(self, path):
            assert path == "daily/2026-11-13/plants"
            return Query()

    monkeypatch.setattr(pwa_report, "_client", Client())
    from datetime import date

    out = list(pwa_report.firestore_day_docs(date(2026, 11, 13)))
    assert [c[0] for c in calls] == ["fleet", "plants"]
    assert out == [(pwa_report.DAY_KEY, {"checks_ready": ["09"]}), ("7", {"yield_kwh": 1.0})]


def test_water_plants_sharing_a_name_match_by_datalogger(tmp_path):
    """Two sheet rows are both named "สถานีผลิตน้ำศูนย์ราชการ": DYDDG1X02W is P4-001 Kamphaeng Phet
    (plant 11140629), DYDDG1X03H is P4-031 Maha Sarakham (plant 11192895)."""
    from app.services.pwa_sheet import match_plant

    engine = build_engine(f"sqlite:///{tmp_path / 'w.db'}")
    Base.metadata.create_all(bind=engine)
    with sessionmaker(bind=engine, expire_on_commit=False)() as db:
        db.add_all([GrowattPlant(plant_id=11140629, name="สถานีผลิตน้ำศูนย์ราชการ กำแพงเพชร"),
                    GrowattPlant(plant_id=11192895, name="สถานีผลิตน้ำศูนย์ฯ สารคาม")])
        db.flush()
        db.add_all([GrowattInverter(device_sn="GKLXG3L03R", plant_id=11140629, datalogger_sn="DYDDG1X02W"),
                    GrowattInverter(device_sn="CWQFG4V00S", plant_id=11192895, datalogger_sn="DYDDG1X03H"),
                    GrowattInverter(device_sn="FYLXG4V00V", plant_id=11192895, datalogger_sn="DYDDG1X03H")])
        db.commit()
        data = pwa_report.cells(db, date(2026, 11, 13), [9], day_docs=lambda _d: [])
    names = data["names"]
    assert match_plant("DYDDG1X02W", "สถานีผลิตน้ำศูนย์ราชการ", data["loggers"], names) == "11140629"
    assert match_plant("DYDDG1X03H", "สถานีผลิตน้ำศูนย์ราชการ", data["loggers"], names) == "11192895"
    assert data["plants"]["11140629"]["datalogger_sn"] == ["DYDDG1X02W"]
    assert data["plants"]["11192895"]["datalogger_sn"] == ["DYDDG1X03H"]
