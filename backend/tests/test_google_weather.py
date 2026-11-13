"""Google Maps Weather: parsing, grid cells, budgeted history sync, stored day, live cache (no network)."""

from __future__ import annotations

from datetime import date, datetime, timedelta

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import func, select
from sqlalchemy.orm import sessionmaker

from app.config import settings
from app.db.models import GoogleWeatherHourly, GrowattPlant
from app.db.seed import ensure_seeded
from app.db.session import Base, build_engine, get_db
from app.main import create_app
from app.services import google_weather as gw
from solar_core.google_weather import GoogleWeatherError, parse_current, parse_history_hour

DAY = date(2026, 11, 11)
NOON = datetime(2026, 11, 11, 12, 0)


def _hour_item(h: int, rain: float = 0.0, cloud: int = 50, day: date = DAY) -> dict:
    start = datetime.combine(day, datetime.min.time()) + timedelta(hours=h) - timedelta(hours=7)
    return {
        "interval": {"startTime": start.strftime("%Y-%m-%dT%H:%M:%SZ")},
        "displayDateTime": {"year": day.year, "month": day.month, "day": day.day, "hours": h, "utcOffset": "25200s"},
        "isDaytime": 6 <= h < 18,
        "weatherCondition": {"type": "RAIN" if rain else "CLOUDY", "description": {"text": "x"}},
        "temperature": {"degrees": 25 + h / 4, "unit": "CELSIUS"},
        "relativeHumidity": 70,
        "cloudCover": cloud,
        "uvIndex": 5 if 10 <= h <= 14 else 0,
        "precipitation": {"qpf": {"quantity": rain, "unit": "MILLIMETERS"}, "probability": {"percent": 40, "type": "RAIN"}},
        "wind": {"speed": {"value": 36, "unit": "KILOMETERS_PER_HOUR"}, "gust": {"value": 18, "unit": "KILOMETERS_PER_HOUR"}, "direction": {"degrees": 90}},
    }


class FakeClient:
    def __init__(self, fail: set[tuple[float, float]] | None = None, rain_by_day: dict[date, float] | None = None):
        self.calls = 0
        self.current_calls = 0
        self.fail = fail or set()
        self.rain_by_day = rain_by_day or {DAY: 0.0}

    def history_hours(self, lat, lon, hours=24):
        self.calls += 1
        if (lat, lon) in self.fail:
            raise GoogleWeatherError("history/hours:lookup: HTTP 403 denied")
        rows = []
        for d, rain in self.rain_by_day.items():
            rows += [parse_history_hour(_hour_item(h, rain=rain / 4 if 12 <= h < 16 else 0.0, day=d)) for h in range(24)]
        return [r for r in rows if r]

    def current(self, lat, lon):
        self.calls += 1
        self.current_calls += 1
        return parse_current({"temperature": {"degrees": 30, "unit": "CELSIUS"}, "cloudCover": 80, "currentTime": "2026-11-12T05:00:00.123456789Z"})


# --------------------------------------------------------------------------- parsing / cells


def test_parse_converts_units_and_keeps_missing_as_none():
    r = parse_history_hour(_hour_item(10, rain=1.5))
    assert r is not None
    assert r["hour_local"] == datetime(2026, 11, 11, 10)
    assert r["wind_speed_ms"] == 10.0 and r["wind_gust_ms"] == 5.0
    assert r["precip_mm"] == 1.5 and r["cloud_cover_pct"] == 50
    assert r["pressure_hpa"] is None and r["visibility_km"] is None  # not in the item: None, not 0

    c = parse_current({"temperature": {"degrees": 86, "unit": "FAHRENHEIT"}, "currentConditionsHistory": {"qpf": {"quantity": 0.1, "unit": "INCHES"}}})
    assert c["temp_c"] == 30.0 and c["past24h_precip_mm"] == 2.54
    assert c["humidity_pct"] is None


def test_cell_of_groups_nearby_plants():
    assert gw.cell_of(13.7563, 100.5018, 0.01) == ("13.76,100.50", 13.76, 100.5)
    assert gw.cell_of(13.7549, 100.5049, 0.01)[0] == "13.75,100.50"
    assert gw.cell_of(13.76, 100.52, 0.1)[0] == "13.8,100.5"


# --------------------------------------------------------------------------- DB fixtures


@pytest.fixture()
def Session(tmp_path):
    engine = build_engine(f"sqlite:///{tmp_path / 'gw.db'}")
    S = sessionmaker(bind=engine, autoflush=False, autocommit=False, expire_on_commit=False)
    Base.metadata.create_all(bind=engine)
    with S() as s:
        ensure_seeded(s)
        s.add_all(
            [
                GrowattPlant(plant_id=1, name="A", latitude=13.7501, longitude=100.5001),
                GrowattPlant(plant_id=2, name="B (same cell as A)", latitude=13.7499, longitude=100.4999),
                GrowattPlant(plant_id=3, name="C", latitude=14.0, longitude=100.6),
                GrowattPlant(plant_id=4, name="no coordinates"),
            ]
        )
        s.commit()
    return S


@pytest.fixture(autouse=True)
def _budget(monkeypatch):
    monkeypatch.setattr(settings, "google_weather_cell_deg", 0.01)
    monkeypatch.setattr(settings, "google_weather_monthly_budget", 10000)


def test_sync_history_one_call_per_cell_idempotent(Session):
    with Session() as db:
        assert list(gw.fleet_cells(db)) == ["13.75,100.50", "14.00,100.60"]
        status, d = gw.sync_history(db, FakeClient(), workers=1)
        assert status == "ok" and d["calls"] == 2 and d["hours_stored"] == 24  # 06–17 only
        status, d = gw.sync_history(db, FakeClient(), workers=1)  # re-run replaces, no duplicates
        assert db.scalar(select(func.count()).select_from(GoogleWeatherHourly)) == 24
        assert gw.calls_today(db) == 4


def test_sync_history_respects_budget_and_reports_failures(Session, monkeypatch):
    d0 = gw.billing_day()
    days_left = (gw._month(d0)[1] - d0).days
    monkeypatch.setattr(settings, "google_weather_monthly_budget", days_left)  # allowance today = 1
    with Session() as db:
        status, d = gw.sync_history(db, FakeClient(), workers=1)
        assert status == "partial" and d["fetched"] == 1 and d["skipped_budget"] == 1
        status, d = gw.sync_history(db, FakeClient(), workers=1)
        assert d["calls"] == 0 and d["skipped_budget"] == 2

    monkeypatch.setattr(settings, "google_weather_monthly_budget", 10000)
    with Session() as db:
        status, d = gw.sync_history(db, FakeClient(fail={(14.0, 100.6)}), workers=1)
        assert status == "partial" and d["failed"] == 1 and "403" in d["errors"]["14.00,100.60"]
        with pytest.raises(RuntimeError):
            gw.sync_history(db, FakeClient(fail={(14.0, 100.6), (13.75, 100.5)}), workers=1)


def test_build_day_kpis_and_days_since_rain(Session):
    days = {DAY - timedelta(days=i): (8.0 if i == 3 else 0.0) for i in range(5)}
    with Session() as db:
        gw.sync_history(db, FakeClient(rain_by_day=days), workers=1)
        plant = db.get(GrowattPlant, 1)
        out = gw.build_day(db, plant, None)  # latest complete day
        assert out["meta"]["day"] == DAY.isoformat() and out["meta"]["modelled"] is True
        assert len(out["hours"]) == 12 and out["kpis"]["complete"]
        assert out["hours"][0]["hour"].endswith("06:00:00") and out["hours"][-1]["hour"].endswith("17:00:00")
        assert out["kpis"]["rain_mm"] == 0.0 and out["kpis"]["cloud_cover_daytime_pct"] == 50
        assert out["rain"] == {"days_since_rain": 3, "last_rain_day": (DAY - timedelta(days=3)).isoformat(), "last_rain_mm": 8.0}

        rainy = gw.build_day(db, plant, DAY - timedelta(days=3))
        assert rainy["kpis"]["rain_mm"] == 8.0 and rainy["kpis"]["rain_hours"] == 4
        assert rainy["rain"]["days_since_rain"] == 0
        assert rainy["slots"]["13"]["raining"] is True and rainy["slots"]["13"]["status_th"] == "ฝนตก"
        assert rainy["slots"]["09"]["status_th"] == "ไม่มีฝน" and rainy["slots"]["17"]["raining"] is False
        assert out["kpis"]["rained"] is False and rainy["kpis"]["rained"] is True

        # a gap (day without stored hours) before any rain: unknown, not "no rain"
        gap = gw.build_day(db, plant, DAY + timedelta(days=2))
        assert gap["hours"] == [] and gap["rain"]["days_since_rain"] is None

        assert gw.build_day(db, db.get(GrowattPlant, 4))["has_location"] is False
        summary = gw.day_summary(db, plant, DAY)
        assert summary["days_since_rain"] == 3 and set(summary["slots"]) == {"09", "13", "17"}
        assert gw.day_summary(db, plant, DAY + timedelta(days=9)) is None


# --------------------------------------------------------------------------- live cache


def test_live_cache_budget_and_stale_fallback(Session, monkeypatch):
    t = [0.0]
    fake = FakeClient()
    live = gw.GoogleWeatherLive(lambda: fake, ttl_s=1800, cooldown_s=300, clock=lambda: t[0], now_local=lambda: NOON)
    budget = {"left": 1}

    def reserve():
        if budget["left"] <= 0:
            return False
        budget["left"] -= 1
        return True

    a = live.current("k", 13.75, 100.5, reserve)
    b = live.current("k", 13.75, 100.5, reserve)
    assert fake.current_calls == 1 and not a["stale"] and b["refresh_in_s"] <= 1800
    t[0] = 1900  # expired, budget used up -> last value, stale
    c = live.current("k", 13.75, 100.5, reserve)
    assert c["stale"] and "budget" in c["error"] and fake.current_calls == 1
    with pytest.raises(gw.GoogleWeatherUnavailable):
        live.current("other", 14.0, 100.6, reserve)


# --------------------------------------------------------------------------- routes


@pytest.fixture()
def client(Session, monkeypatch):
    monkeypatch.setattr(settings, "google_weather_api_key", "test-key")
    app = create_app()

    def _db():
        db = Session()
        try:
            yield db
        finally:
            db.close()

    fake = FakeClient()
    live = gw.GoogleWeatherLive(lambda: fake, ttl_s=1800, now_local=lambda: NOON)
    app.dependency_overrides[get_db] = _db
    app.dependency_overrides[gw.get_google_live] = lambda: live
    c = TestClient(app)
    tok = c.post("/api/auth/login", json={"username": "admin", "password": "admin123"}).json()["access_token"]
    c.headers["Authorization"] = f"Bearer {tok}"
    c.fake = fake  # type: ignore[attr-defined]
    with Session() as db:
        gw.sync_history(db, FakeClient(), workers=1)
    return c


def test_routes_db_and_live(client, monkeypatch):
    r = client.get(f"/api/growatt/plants/1/google-weather?day={DAY}")
    assert r.status_code == 200 and len(r.json()["hours"]) == 12 and r.json()["meta"]["source"] == "db"

    r1 = client.get("/api/growatt/live/plants/1/google-weather").json()
    r2 = client.get("/api/growatt/live/plants/2/google-weather").json()  # same cell -> cached
    assert r1["source"] == "live" and r1["data"]["modelled"] and r1["data"]["cloud_cover_pct"] == 80
    assert r2["data"]["plant_id"] == 2 and client.fake.current_calls == 1  # type: ignore[attr-defined]

    assert client.get("/api/growatt/live/plants/4/google-weather").status_code == 503  # no coordinates
    assert client.get("/api/growatt/live/plants/999/google-weather").status_code == 404
    monkeypatch.setattr(settings, "google_weather_api_key", "")
    assert client.get("/api/growatt/live/plants/3/google-weather").status_code == 503


def test_engineer_sees_only_assigned_plants(client):
    tok = client.post("/api/auth/login", json={"username": "engineer", "password": "engineer123"}).json()["access_token"]
    r = client.get("/api/growatt/plants/1/google-weather", headers={"Authorization": f"Bearer {tok}"})
    assert r.status_code == 404


def test_is_raining():
    assert gw.is_raining(0.5, "CLOUDY") is True
    assert gw.is_raining(0.0, "LIGHT_RAIN_SHOWERS") is True
    assert gw.is_raining(0.0, "CHANCE_OF_SHOWERS") is False
    assert gw.is_raining(None, None) is None


def test_job_stores_and_republishes_yesterday(Session, monkeypatch, tmp_path):
    from app.services import daily_summary, jobs

    yesterday = jobs._today() - timedelta(days=1)
    monkeypatch.setattr(settings, "google_weather_api_key", "k")
    monkeypatch.setattr(gw, "make_client", lambda: FakeClient(rain_by_day={yesterday: 4.0}))
    published = []
    monkeypatch.setattr(jobs, "_publish", lambda db, day: (published.append(day) or ("ok", {"written": 1, "unchanged": 0, "over_budget": []})))
    with Session() as db:
        status, d = jobs.job_google_weather(db)
    assert status == "ok" and d["hours_stored"] == 24 and published == [yesterday]

    monkeypatch.setattr(settings, "google_weather_api_key", "")
    with Session() as db:
        assert jobs.job_google_weather(db) == ("ok", {"skipped": "GOOGLE_WEATHER_API_KEY not set"})


def test_sync_history_stops_after_google_quota_429(Session):
    class QuotaClient(FakeClient):
        def history_hours(self, lat, lon, hours=24):
            self.calls += 1
            raise GoogleWeatherError("history/hours:lookup: HTTP 429 Quota exceeded")

    with Session() as db:
        c = QuotaClient()
        with pytest.raises(RuntimeError):
            gw.sync_history(db, c, workers=1)
        assert c.calls == 1  # the second cell is not tried


def test_monthly_budget_rolls_over_and_reserves_history(Session, monkeypatch):
    monkeypatch.setattr(settings, "google_weather_monthly_budget", 3000)
    day = date(2026, 11, 1)  # 30 days left -> 100 a day
    with Session() as db:
        assert gw.allowance(db, day) == 100
        # live keeps one call per cell (2 here) for the history job until it ran today
        assert gw.remaining(db, gw.API_CURRENT, day) == 98
        gw.record_calls(db, gw.API_HISTORY, 2, day)
        assert gw.remaining(db, gw.API_CURRENT, day) == 98
        gw.record_calls(db, gw.API_CURRENT, 98, day)
        assert gw.remaining(db, gw.API_CURRENT, day) == 0
        # a quiet next day: nothing used on day 2, so day 3 gets more
        assert gw.allowance(db, date(2026, 11, 2)) == (3000 - 100) // 29
        assert gw.allowance(db, date(2026, 11, 3)) == (3000 - 100) // 28
        # a new month starts from the full budget again
        assert gw.allowance(db, date(2026, 12, 1)) == 3000 // 31
        assert gw.billing_day(datetime(2026, 11, 13, 7, 0, tzinfo=gw.timezone.utc)) == date(2026, 11, 12)


def test_live_not_called_outside_daytime():
    fake = FakeClient()
    clock = [datetime(2026, 11, 11, 20, 0)]
    live = gw.GoogleWeatherLive(lambda: fake, ttl_s=1800, clock=lambda: 0.0, now_local=lambda: clock[0])
    with pytest.raises(gw.GoogleWeatherUnavailable, match="06:00"):
        live.current("k", 13.75, 100.5, lambda: True)
    assert fake.current_calls == 0

    clock[0] = datetime(2026, 11, 11, 17, 50)  # inside: fetched and cached
    live.current("k", 13.75, 100.5, lambda: True)
    live._cache["k"] = (-5000.0, *live._cache["k"][1:])  # expire it
    clock[0] = datetime(2026, 11, 11, 18, 30)  # after 18:00: last value, stale, back at 06:00
    env = live.current("k", 13.75, 100.5, lambda: True)
    assert env["stale"] and fake.current_calls == 1 and env["refresh_in_s"] == 11.5 * 3600


def test_client_errors_never_contain_the_api_key():
    """Errors reach logs, sync_runs.detail and the live API response, so the ?key= must never leak."""
    import requests

    from solar_core.google_weather import GoogleWeatherClient

    key = "AIza-secret-key-123"

    class Resp:
        status_code = 400
        reason = "Bad Request"

        def json(self):
            return {"error": {"message": f"API key not valid: https://weather.googleapis.com/v1/x?key={key}"}}

    class Sess:
        def __init__(self, mode):
            self.mode = mode

        def get(self, url, params=None, timeout=None):
            if self.mode == "net":
                raise requests.ConnectionError(f"Max retries exceeded with url: {url}?key={params['key']}")
            return Resp()

    for mode in ("net", "http"):
        with pytest.raises(GoogleWeatherError) as ei:
            GoogleWeatherClient(api_key=key, session=Sess(mode)).current(13.7, 100.5)
        assert key not in str(ei.value)
        assert ei.value.__cause__ is None
        assert ei.value.__context__ is None or ei.value.__suppress_context__


def test_history_lookback_covers_todays_window_only():
    assert gw.history_lookback_hours(datetime(2026, 11, 12, 18, 15)) == 13  # 06:00–17:00 (+ margin)
    assert gw.history_lookback_hours(datetime(2026, 11, 12, 19, 30)) == 14
    assert gw.history_lookback_hours(datetime(2026, 11, 13, 0, 11)) == 19  # before 06:00: yesterday's window
    assert gw.history_lookback_hours(datetime(2026, 11, 12, 6, 0)) == 1


def test_sync_history_asks_for_lookback_and_respects_daily_hour_quota(Session, monkeypatch):
    asked: list[int] = []

    class Spy(FakeClient):
        def history_hours(self, lat, lon, hours=24):
            asked.append(hours)
            return super().history_hours(lat, lon, hours)

    evening = datetime(2026, 11, 12, 18, 15)
    monkeypatch.setattr(settings, "google_weather_history_hours_per_day", 30)  # room for 2 x 13 h, not 3
    with Session() as db:
        status, d = gw.sync_history(db, Spy(), workers=1, now_local=evening)
        assert asked == [13, 13] and status == "ok" and d["lookback_hours"] == 13
        assert d["hours_returned"] == 48 and gw.history_hours_left(db) == 0  # Fake returns 24 h each
        status, d = gw.sync_history(db, Spy(), workers=1, now_local=evening)
        assert status == "partial" and d["calls"] == 0 and d["skipped_budget"] == 2


def test_sync_history_retries_missed_cells_first_and_does_not_count_429(Session):
    class QuotaAfterFirst(FakeClient):
        def history_hours(self, lat, lon, hours=24):
            if self.calls:
                self.calls += 1
                raise GoogleWeatherError("history/hours:lookup: HTTP 429 Quota exceeded")
            return super().history_hours(lat, lon, hours)

    with Session() as db:
        status, d = gw.sync_history(db, QuotaAfterFirst(), workers=1)
        assert status == "partial" and d["calls"] == 1 and d["google_quota_exceeded"]
        assert gw.calls_today(db, gw.API_HISTORY) == 1  # the refused call is not counted
        done = db.scalars(select(GoogleWeatherHourly.cell_key).distinct()).all()
        cells = list(gw.fleet_cells(db))
        missed = next(c for c in cells if c not in done)
        assert [k for k, _ in gw._oldest_first(db, gw.fleet_cells(db))][0] == missed
