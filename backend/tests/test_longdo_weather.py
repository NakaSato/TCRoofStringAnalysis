"""Longdo rain radar: parsing, the memory cache with stale fallback, routes (no network)."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import sessionmaker

from app.config import settings
from app.db.models import GrowattPlant
from app.db.seed import ensure_seeded
from app.db.session import Base, build_engine, get_db
from app.main import create_app
from app.services import longdo_weather as longdo
from app.db.models import User, UserPlantAssignment
from solar_core.longdo_weather import (
    parse_area_stats,
    parse_forecast_area,
    LongdoWeatherClient,
    LongdoWeatherError,
    parse_forecast,
    parse_frames,
    parse_legend,
    parse_rain,
)


class FakeClient:
    def __init__(self):
        self.calls = {"frames": 0, "legend": 0, "rain": 0, "forecast": 0, "area": 0}
        self.fail: set[str] = set()
        self.areas: list = []
        self.dry_regions: set = set()

    def _call(self, name: str):
        self.calls[name] += 1
        if name in self.fail:
            raise LongdoWeatherError(f"{name}: HTTP 503 down")

    def frames(self):
        self._call("frames")
        return [1740448800, 1740449400]

    def legend(self):
        self._call("legend")
        return [{"intensity": 1, "label": "Very light", "color": "#7accff"}]

    def rain_at(self, lat, lon):
        self._call("rain")
        return {"intensity": 3, "description": "ฝนปานกลาง"}

    def forecast_at(self, lat, lon):
        self._call("forecast")
        return [{"lead_min": 15, "time": 1740450300, "rain": {"intensity": 2, "description": "x"}}]

    def area_at(self, lat, lon, radius_km):
        self._call("area")
        self.areas.append((lat, lon, radius_km))
        if radius_km > 50 and (lat, lon) in self.dry_regions:
            return {"coverage_pct": 0.0, "max_intensity": 0}
        return {"coverage_pct": 20.0, "max_intensity": 4}

    def forecast_area_at(self, lat, lon, radius_km):
        self._call("area")
        return [{"lead_min": 15, "time": 1740450300, "stats": {"coverage_pct": 35.5, "max_intensity": 4}}]

    def tile_url(self):
        return "https://weather.example/rain/api/v1/layer/{time}/{z}/{x}/{y}.png?key=k"


def test_parsing():
    assert parse_frames({"radar": {"past": [{"time": 20}, {"time": 10}, {"time": None}, "x"]}}) == [10, 20]
    assert parse_frames({}) == [] and parse_frames(None) == []
    assert parse_rain({"level": "moderate", "description": "ฝนปานกลาง", "intensity": 3}) == {"intensity": 3, "description": "ฝนปานกลาง"}
    assert parse_rain({"intensity": 0})["intensity"] == 0  # no rain is a value, not missing
    assert parse_rain({"description": "x"}) is None and parse_rain({"intensity": 9}) is None and parse_rain(None) is None
    rows = parse_forecast(
        {
            "lead_minutes": [15, 30],
            "forecast": [
                {"unix_time": 100, "available": True, "rain": {"intensity": 1, "description": "a"}},
                {"unix_time": 200, "available": False, "rain": {"intensity": 4}},
            ],
        }
    )
    assert [(r["lead_min"], r["time"]) for r in rows] == [(15, 100), (30, 200)]
    assert rows[0]["rain"]["intensity"] == 1 and rows[1]["rain"] is None  # unavailable is never a 0
    assert parse_legend({"levels": [{"intensity": 2, "label": "Light", "hex": "#40adfa"}, {"intensity": 1}]}) == [
        {"intensity": 2, "label": "Light", "color": "#40adfa"}
    ]


def test_client_error_never_shows_the_key():
    class Resp:
        status_code, reason = 403, "Forbidden"

        def json(self):
            return {"detail": "bad key SECRETKEY"}

    class Http:
        def get(self, url, params, timeout):
            return Resp()

    c = LongdoWeatherClient("SECRETKEY", session=Http())  # type: ignore[arg-type]
    with pytest.raises(LongdoWeatherError) as exc:
        c.frames()
    assert "SECRETKEY" not in str(exc.value) and "403" in str(exc.value)
    assert c.tile_url().endswith("/rain/api/v1/layer/{time}/{z}/{x}/{y}.png?key=SECRETKEY")
    with pytest.raises(LongdoWeatherError):
        LongdoWeatherClient("")


def test_cache_cooldown_and_stale_fallback():
    t = [0.0]
    fake = FakeClient()
    live = longdo.LongdoLive(lambda: fake, cooldown_s=60, clock=lambda: t[0])  # type: ignore[arg-type,return-value]
    a = live.cached("frames", 120, lambda c: c.frames())
    b = live.cached("frames", 120, lambda c: c.frames())
    assert fake.calls["frames"] == 1 and not a["stale"] and b["refresh_in_s"] <= 120
    t[0], fake.fail = 130, {"frames"}
    c = live.cached("frames", 120, lambda c: c.frames())
    assert c["stale"] and "503" in c["error"] and c["data"] == a["data"] and fake.calls["frames"] == 2
    t[0] = 150  # inside the cooldown: no new call
    assert live.cached("frames", 120, lambda c: c.frames())["stale"] and fake.calls["frames"] == 2
    with pytest.raises(longdo.LongdoUnavailable):
        live.cached("other", 120, lambda c: c.frames())


@pytest.fixture()
def client(tmp_path, monkeypatch):
    engine = build_engine(f"sqlite:///{tmp_path / 'longdo.db'}")
    S = sessionmaker(bind=engine, autoflush=False, autocommit=False, expire_on_commit=False)
    Base.metadata.create_all(bind=engine)
    with S() as s:
        ensure_seeded(s)
        s.add_all(
            [
                GrowattPlant(plant_id=1, name="A", latitude=13.7501, longitude=100.5001),
                GrowattPlant(plant_id=2, name="B (same cell as A)", latitude=13.7499, longitude=100.4999),
                GrowattPlant(plant_id=3, name="C (another region)", latitude=18.8, longitude=99.0),
                GrowattPlant(plant_id=4, name="no coordinates"),
                GrowattPlant(plant_id=5, name="0,0 = not set", latitude=0.0, longitude=0.0),
            ]
        )
        s.commit()
    monkeypatch.setattr(settings, "longdo_api_key", "test-key")
    app = create_app()

    def _db():
        db = S()
        try:
            yield db
        finally:
            db.close()

    fake = FakeClient()
    live = longdo.LongdoLive(lambda: fake)  # type: ignore[arg-type,return-value]
    app.dependency_overrides[get_db] = _db
    app.dependency_overrides[longdo.get_longdo_live] = lambda: live
    c = TestClient(app)
    tok = c.post("/api/auth/login", json={"username": "admin", "password": "admin123"}).json()["access_token"]
    c.headers["Authorization"] = f"Bearer {tok}"
    c.fake = fake  # type: ignore[attr-defined]
    c.Session = S  # type: ignore[attr-defined]
    return c


def test_routes(client, monkeypatch):
    r = client.get("/api/growatt/live/rain-radar").json()
    assert r["source"] == "live" and r["data"]["frames"] == [1740448800, 1740449400]
    assert "{time}" in r["data"]["tile_url"] and r["data"]["legend"][0]["color"] == "#7accff"
    assert (r["data"]["min_zoom"], r["data"]["max_zoom"]) == (5, 13) and r["data"]["radar"] is True

    r1 = client.get("/api/growatt/live/plants/1/rain").json()
    r2 = client.get("/api/growatt/live/plants/2/rain").json()  # same cell -> cached
    assert r1["data"]["now"]["intensity"] == 3 and r1["data"]["forecast"][0]["lead_min"] == 15 and r1["data"]["radar"]
    assert r2["data"]["plant_id"] == 2 and client.fake.calls["rain"] == 1  # type: ignore[attr-defined]

    assert client.get("/api/growatt/live/plants/4/rain").status_code == 503  # no coordinates
    assert client.get("/api/growatt/live/plants/999/rain").status_code == 404
    tok = client.post("/api/auth/login", json={"username": "engineer", "password": "engineer123"}).json()["access_token"]
    assert client.get("/api/growatt/live/plants/1/rain", headers={"Authorization": f"Bearer {tok}"}).status_code == 404
    monkeypatch.setattr(settings, "longdo_api_key", "")  # not configured: the UI hides the radar
    assert client.get("/api/growatt/live/rain-radar").status_code == 404
    assert client.get("/api/growatt/live/plants/1/rain").status_code == 404


def test_forecast_failure_keeps_now(client):
    client.fake.fail = {"forecast", "legend"}  # type: ignore[attr-defined]
    d = client.get("/api/growatt/live/plants/1/rain").json()["data"]
    assert d["now"]["intensity"] == 3 and d["forecast"] == [] and "503" in d["forecast_error"]
    assert client.get("/api/growatt/live/rain-radar").json()["data"]["legend"] == []


def test_area_parsing():
    assert parse_area_stats({"rain_coverage_pct": 20.014, "max_intensity": 4}) == {"coverage_pct": 20.0, "max_intensity": 4}
    assert parse_area_stats({"rain_coverage_pct": 0.0, "max_intensity": 0}) == {"coverage_pct": 0.0, "max_intensity": 0}
    assert parse_area_stats({}) is None and parse_area_stats(None) is None
    rows = parse_forecast_area(
        {"lead_minutes": [15, 30], "forecast": [{"unix_time": 1, "available": True, "stats": {"rain_coverage_pct": 5}}, {"unix_time": 2, "available": False, "stats": {"rain_coverage_pct": 9}}]}
    )
    assert rows[0]["stats"] == {"coverage_pct": 5.0, "max_intensity": None} and rows[1]["stats"] is None


def test_plant_rain_area(client):
    d = client.get("/api/growatt/live/plants/1/rain").json()["data"]
    assert d["area"]["now"] == {"coverage_pct": 20.0, "max_intensity": 4} and d["area"]["radius_km"] == 10
    assert d["area"]["forecast"][0]["stats"]["coverage_pct"] == 35.5 and d["area"]["error"] is None


def test_plant_rain_area_failure_keeps_point(client):
    client.fake.fail = {"area"}  # type: ignore[attr-defined]
    d = client.get("/api/growatt/live/plants/1/rain").json()["data"]
    assert d["now"]["intensity"] == 3 and d["area"]["now"] is None and "503" in d["area"]["error"]


def test_fleet_rain_region_then_plants(client, monkeypatch):
    fake = client.fake  # type: ignore[attr-defined]
    fake.dry_regions = {(19.0, 99.0)}  # plant 3's region has no rain pixel
    monkeypatch.setattr(settings, "longdo_rain_sweep_per_request", 2)
    r = client.get("/api/growatt/live/rain").json()
    d = r["data"]
    assert fake.calls == {**fake.calls, "area": 2, "rain": 0} and r["refresh_in_s"] == 15  # the 2 regions first
    by_id = {p["plant_id"]: p for p in d["plants"]}
    assert by_id[3]["rain"]["intensity"] == 0 and by_id[3]["via"] == "area"  # dry region: no call of its own
    assert not by_id[1]["checked"] and by_id[1]["rain"] is None  # wet region, not asked yet: never "no rain"
    assert d["located"] == 3 and d["checked"] == 1 and d["raining"] == 0

    r = client.get("/api/growatt/live/rain").json()
    d = r["data"]
    by_id = {p["plant_id"]: p for p in d["plants"]}
    assert fake.calls["rain"] == 1 and fake.calls["area"] == 2  # plants 1 + 2 share a cell
    assert by_id[1]["rain"]["intensity"] == 3 and by_id[2]["via"] == "point" and d["raining"] == 2 and d["checked"] == 3
    assert not by_id[4]["checked"] and not by_id[5]["checked"] and r["refresh_in_s"] > 15
    assert d["usage"]["used_today"] == 3
    client.get("/api/growatt/live/rain")
    assert fake.calls["rain"] == 1 and fake.calls["area"] == 2  # all cached


def test_fleet_rain_engineer_scope(client):
    with client.Session() as db:  # type: ignore[attr-defined]
        eng = db.query(User).filter(User.username == "engineer").one()
        db.add(UserPlantAssignment(user_id=eng.id, plant_id=3))
        db.commit()
    tok = client.post("/api/auth/login", json={"username": "engineer", "password": "engineer123"}).json()["access_token"]
    client.fake.fail = {"area"}  # type: ignore[attr-defined]
    d = client.get("/api/growatt/live/rain", headers={"Authorization": f"Bearer {tok}"}).json()["data"]
    assert [p["plant_id"] for p in d["plants"]] == [3] and d["checked"] == 0 and d["plants"][0]["rain"] is None
    assert client.fake.calls["area"] == 1  # type: ignore[attr-defined]  # only the engineer's region was asked


def test_rate_limit_and_budget(client, monkeypatch):
    live = longdo.LongdoLive(lambda: client.fake, calls_per_min=2)  # type: ignore[arg-type,return-value]
    assert live.take(5) == 2 and live.take(1) == 0
    # the fleet sweep leaves slots for the selected plant's lookup
    roomy = longdo.LongdoLive(lambda: client.fake, calls_per_min=10)  # type: ignore[arg-type,return-value]
    assert roomy.take(20, keep=4) == 6 and roomy.take(1, keep=4) == 0 and roomy.take(9) == 4
    with pytest.raises(longdo.LongdoUnavailable) as exc:
        live.cached("frames", 120, lambda c: c.frames())
    assert "rate limit" in str(exc.value) and client.fake.calls["frames"] == 0  # type: ignore[attr-defined]

    monkeypatch.setattr(settings, "longdo_monthly_budget", 0)  # nothing left today
    assert client.get("/api/growatt/live/rain-radar").status_code == 503
    r = client.get("/api/growatt/live/rain").json()
    assert r["stale"] and "budget" in r["error"] and r["data"]["checked"] == 0 and r["refresh_in_s"] == 60
    assert client.fake.calls["frames"] == 0 and client.fake.calls["area"] == 0  # type: ignore[attr-defined]
