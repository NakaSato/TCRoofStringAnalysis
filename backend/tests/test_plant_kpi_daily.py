"""GET /growatt/plants/{id}/kpi-daily: stored plant-day KPIs over a `days` window up to `day`."""

from __future__ import annotations

from datetime import date, timedelta

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import sessionmaker

from app.db.models import GrowattPlant, GrowattPlantDaily, User, UserPlantAssignment
from app.db.seed import ensure_seeded
from app.db.session import Base, build_engine, get_db
from app.main import create_app
from app.services import jobs

TODAY = date(2026, 11, 20)
P1, P2 = 9301, 9302  # P1: the engineer's plant


def _row(plant: int, day: date, **kw) -> GrowattPlantDaily:
    base = dict(
        capacity_kwp=100.0, energy_kwh=450.0, dc_energy_kwh=470.0, yr_h=5.6,
        ya_kwh_kwp=4.7, yf_kwh_kwp=4.5, ya_minus_yf=0.2, pr_pct=80.4, pr_temp_corrected_pct=86.1,
        epi=0.97, system_factor=0.985, modelled_energy_kwh=400.0, irradiance_weighted_tmod_c=48.0,
        filtered_slots=60, sensor_stale_slots=0, sensor_high_slots=0, sensor_midday_wm2=850.0,
    )
    base.update(kw)
    return GrowattPlantDaily(plant_id=plant, day=day, **base)


@pytest.fixture()
def api(tmp_path, monkeypatch):
    monkeypatch.setattr(jobs, "_today", lambda: TODAY)
    engine = build_engine(f"sqlite:///{tmp_path / 'kpi.db'}")
    Base.metadata.create_all(bind=engine)
    f = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)
    with f() as db:
        ensure_seeded(db)
        db.add_all([GrowattPlant(plant_id=P1, name="Alpha", peak_power_kwp=100.0), GrowattPlant(plant_id=P2, name="Beta")])
        eng = db.scalars(select(User).where(User.username == "engineer")).one()
        db.add(UserPlantAssignment(user_id=eng.id, plant_id=P1))
        db.add_all([
            _row(P1, TODAY),  # today so far
            _row(P1, TODAY - timedelta(days=1), sensor_stale_slots=20),  # R16: stale sensor
            # no sensor: PR, PR', EPI, Yr and the sensor evidence stay null
            _row(P1, TODAY - timedelta(days=2), yr_h=None, pr_pct=None, pr_temp_corrected_pct=None, epi=None,
                 system_factor=None, modelled_energy_kwh=None, irradiance_weighted_tmod_c=None,
                 sensor_stale_slots=None, sensor_high_slots=None, sensor_midday_wm2=None),
            _row(P1, TODAY - timedelta(days=29), pr_pct=70.0),  # first day of the default 30-day window
            _row(P1, TODAY - timedelta(days=30), pr_pct=60.0),  # one day before it
            _row(P1, TODAY - timedelta(days=400), pr_pct=50.0),  # outside even 365 days
            _row(P2, TODAY, pr_pct=99.0),  # another plant
        ])
        db.commit()
    app = create_app()

    def _db():
        db = f()
        try:
            yield db
        finally:
            db.close()

    app.dependency_overrides[get_db] = _db
    c = TestClient(app)

    def login(name: str, pw: str) -> dict:
        tok = c.post("/api/auth/login", json={"username": name, "password": pw}).json()["access_token"]
        return {"Authorization": f"Bearer {tok}"}

    c.admin = login("admin", "admin123")  # type: ignore[attr-defined]
    c.engineer = login("engineer", "engineer123")  # type: ignore[attr-defined]
    return c


def _get(c, plant=P1, headers=None, **params):
    return c.get(f"/api/growatt/plants/{plant}/kpi-daily", params=params, headers=headers or c.admin)


def test_default_window_is_30_days_to_today_in_order(api):
    r = _get(api)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["plant_id"] == P1
    assert body["start"] == (TODAY - timedelta(days=29)).isoformat()
    assert body["end"] == TODAY.isoformat()
    days = [d["day"] for d in body["days"]]
    # oldest first; the day before the window, the 400-day-old row and the other plant are left out
    assert days == [(TODAY - timedelta(days=n)).isoformat() for n in (29, 2, 1, 0)]
    assert body["days"][0]["pr_pct"] == 70.0
    assert all(d["pr_pct"] != 99.0 for d in body["days"])
    assert body["epi_factor"]["basis"] == "default" and body["epi_factor"]["modelled"] is True
    assert "epi" in body["meta"]["modelled"]


def test_days_and_day_window(api):
    body = _get(api, days=2, day=(TODAY - timedelta(days=1)).isoformat()).json()
    assert body["start"] == (TODAY - timedelta(days=2)).isoformat()
    assert body["end"] == (TODAY - timedelta(days=1)).isoformat()
    assert [d["day"] for d in body["days"]] == [(TODAY - timedelta(days=n)).isoformat() for n in (2, 1)]

    one = _get(api, days=1).json()
    assert [d["day"] for d in one["days"]] == [TODAY.isoformat()]

    wide = _get(api, days=31).json()
    assert wide["days"][0]["day"] == (TODAY - timedelta(days=30)).isoformat()

    full = _get(api, days=365).json()
    assert len(full["days"]) == 5  # the 400-day-old row stays out
    assert _get(api, days=366).status_code == 422
    assert _get(api, days=0).status_code == 422


def test_nulls_stay_null_and_sensor_verdict(api):
    by_day = {d["day"]: d for d in _get(api).json()["days"]}
    nosensor = by_day[(TODAY - timedelta(days=2)).isoformat()]
    for k in ("yr_h", "pr_pct", "pr_temp_corrected_pct", "epi", "system_factor", "modelled_energy_kwh",
              "irradiance_weighted_tmod_c", "sensor_midday_wm2", "sensor_neighbour_ratio", "cloud_midday_pct"):
        assert nosensor[k] is None, k
    assert nosensor["sensor_ok"] is None and nosensor["sensor_flags"] == []  # not judged, not "ok"
    assert nosensor["yf_kwh_kwp"] == 4.5 and nosensor["ya_kwh_kwp"] == 4.7  # yields need no sensor

    stale = by_day[(TODAY - timedelta(days=1)).isoformat()]
    assert stale["sensor_ok"] is False and stale["sensor_flags"] == ["stale"]
    assert stale["pr_pct"] == 80.4  # the value is kept; the verdict says whether to trust it

    today = by_day[TODAY.isoformat()]
    assert today["sensor_ok"] is True and today["sensor_flags"] == []
    expected = {
        "capacity_kwp", "energy_kwh", "dc_energy_kwh", "modelled_energy_kwh", "yr_h", "ya_kwh_kwp", "yf_kwh_kwp",
        "ya_minus_yf", "pr_pct", "pr_temp_corrected_pct", "epi", "system_factor", "irradiance_weighted_tmod_c",
        "filtered_slots", "stale_masked_slots", "clipped_masked_slots", "curtailed_masked_slots",
        "sensor_stale_slots", "sensor_high_slots", "sensor_midday_wm2", "sensor_neighbour_ratio",
        "sensor_neighbours", "cloud_midday_pct", "day", "sensor_ok", "sensor_flags",
    }
    assert set(today) == expected


def test_engineer_sees_only_assigned_plant(api):
    mine = _get(api, P1, api.engineer)
    assert mine.status_code == 200
    assert len(mine.json()["days"]) == 4
    other = _get(api, P2, api.engineer)
    assert other.status_code == 404  # unassigned plant: 404, the id is not revealed
    assert "days" not in other.json()


def test_needs_login(api):
    assert api.get(f"/api/growatt/plants/{P1}/kpi-daily").status_code == 401
