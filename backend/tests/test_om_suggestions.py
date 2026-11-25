"""Calendar Team Phase 4: data-driven cleaning suggestions from the R12 soiling wallet
(services/om_suggestions.py, docs/plans/calendar-team.md §10)."""

from __future__ import annotations

from datetime import date, datetime, timedelta

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import sessionmaker

from app.db.models import (
    AppSetting,
    GoogleWeatherHourly,
    GrowattPlant,
    GrowattPlantDaily,
    OmCleaningSuggestionMark,
    OmTask,
    SiteEvent,
    User,
    UserPlantAssignment,
)
from app.db.seed import ensure_seeded
from app.db.session import Base, build_engine, get_db
from app.main import create_app
from app.services import epi_fit, google_weather, growatt_rules, site_events
from app.services.growatt_sync.registry import remove_blocked_plants

LAT, LON = 13.75, 100.5
CLEAN = date(2026, 11, 1)
TODAY = CLEAN + timedelta(days=25)  # 26 Nov 2026, a Thursday
A, B, C = 7101, 7102, 7103  # A: wallet over its Site-log cost · B: same soiling, no cost · C: no stored days


def _soiled(db, pid: int, cost):
    prev = CLEAN - timedelta(days=21)
    db.add(SiteEvent(plant_id=pid, event_type="cleaning", day=prev))
    db.add(SiteEvent(plant_id=pid, event_type="cleaning", day=CLEAN, cost_thb=cost))
    for k in range(10):
        d = CLEAN - timedelta(days=10 - k)
        db.add(GrowattPlantDaily(plant_id=pid, day=d, epi=0.90, yr_h=0.9 * epi_fit.clear_sky_kwh_m2(d, LAT, LON), energy_kwh=500.0, filtered_slots=60))
    for k in range(1, 26):
        d = CLEAN + timedelta(days=k)
        db.add(GrowattPlantDaily(plant_id=pid, day=d, epi=0.99, yr_h=0.9 * epi_fit.clear_sky_kwh_m2(d, LAT, LON), energy_kwh=3000.0, filtered_slots=60))


def _rain(db):
    key = google_weather.cell_of(LAT, LON)[0]
    for k in range(50):
        d = CLEAN - timedelta(days=21) + timedelta(days=k)
        for h in range(6, 18):
            db.add(GoogleWeatherHourly(cell_key=key, hour=datetime(d.year, d.month, d.day, h), precip_mm=0.0))


def _rules(db, **cfg):
    db.merge(AppSetting(key=growatt_rules.SETTING_KEY, value=cfg))
    db.commit()


@pytest.fixture()
def api(tmp_path, monkeypatch):
    monkeypatch.setattr(site_events, "_today", lambda: TODAY)
    engine = build_engine(f"sqlite:///{tmp_path / 'suggest.db'}")
    Base.metadata.create_all(bind=engine)
    f = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)
    with f() as db:
        ensure_seeded(db)
        for pid in (A, B, C):
            db.add(GrowattPlant(plant_id=pid, name=f"Plant {pid}", latitude=LAT, longitude=LON, peak_power_kwp=100.0))
        _soiled(db, A, 4000)
        _soiled(db, B, None)
        _rain(db)
        eng = db.scalars(select(User).where(User.username == "engineer")).one()
        db.add(UserPlantAssignment(user_id=eng.id, plant_id=A))
        db.commit()
    app = create_app()

    def override():
        with f() as db:
            yield db

    app.dependency_overrides[get_db] = override
    client = TestClient(app)

    def hdr(u, p):
        return {"Authorization": "Bearer " + client.post("/auth/login", json={"username": u, "password": p}).json()["access_token"]}

    return f, client, hdr("admin", "admin123"), hdr("engineer", "engineer123")


def _by_plant(body):
    return {r["plant_id"]: r for r in body["plants"]}


def test_suggestion_with_reasons_for_the_others(api):
    f, client, admin, eng = api
    body = client.get("/growatt/calendar/suggestions", headers=admin).json()
    assert body["shadow"] is True and body["hidden"] is None and body["labels"]["wallet_thb"] == "estimated"
    rows = _by_plant(body)
    a = rows[A]
    assert a["status"] == "suggested" and a["suggested"] is True
    assert a["wallet_thb"] >= a["cost_thb"] == 4000 and a["cost_basis"] == "site_log"
    assert a["reset_day"] == CLEAN.isoformat() and a["rate_basis"] == "plant"
    assert CLEAN < date.fromisoformat(a["crossed_day"]) <= TODAY
    assert a["suggested_day"] == TODAY.isoformat()  # a Thursday, no holiday
    assert [s["plant_id"] for s in body["suggestions"]] == [A]
    # same soiling, no cost entered: a wallet but no suggestion
    assert rows[B]["status"] == "no_cost" and rows[B]["wallet_thb"] and rows[B]["suggested"] is False
    assert "cost" in rows[B]["reason"] and rows[B]["crossed_day"] is None
    # nothing stored: no wallet, no suggestion, said why
    assert rows[C]["status"] == "no_data" and rows[C]["wallet_thb"] is None and rows[C]["reason"]
    assert body["summary"] == {"suggested": 1, "no_cost": 1, "no_data": 1}


def test_engineers_get_nothing_while_r12_is_shadow_then_only_their_plants(api):
    f, client, admin, eng = api
    body = client.get("/growatt/calendar/suggestions", headers=eng).json()
    assert body["hidden"] == "r12_shadow" and body["plants"] == [] and body["suggestions"] == []
    with f() as db:
        _rules(db, rules={"R12": {"shadow": False}})
    body = client.get("/growatt/calendar/suggestions", headers=eng).json()
    assert body["hidden"] is None and [r["plant_id"] for r in body["plants"]] == [A]
    assert body["suggestions"][0]["plant_id"] == A
    # engineers never accept or dismiss
    assert client.post(f"/growatt/plants/{A}/cleaning-suggestion/accept", headers=eng, json={}).status_code == 403
    assert client.post(f"/growatt/plants/{A}/cleaning-suggestion/dismiss", headers=eng).status_code == 403
    # a disabled rule suggests nothing to anyone
    with f() as db:
        _rules(db, rules={"R12": {"enabled": False}})
    assert client.get("/growatt/calendar/suggestions", headers=admin).json()["hidden"] == "r12_disabled"


def test_monsoon_window_suggests_nothing(api):
    f, client, admin, eng = api
    with f() as db:
        _rules(db, r12_monsoon=["11-01", "11-30"])
    body = client.get("/growatt/calendar/suggestions", headers=admin).json()
    a = _by_plant(body)[A]
    assert body["in_monsoon"] is True and a["status"] == "monsoon" and a["monsoon"] is True
    assert a["wallet_thb"] >= 4000 and body["suggestions"] == []


def test_accept_creates_the_task_and_hides_the_suggestion(api):
    f, client, admin, eng = api
    res = client.post(f"/growatt/plants/{A}/cleaning-suggestion/accept", headers=admin, json={"start_day": "2026-11-30", "note": "crew B"})
    assert res.status_code == 201, res.text
    out = res.json()
    task = out["task"]
    assert task["task_type"] == "cleaning" and task["status"] == "planned" and task["start_day"] == "2026-11-30"
    assert task["est_cost_thb"] == 4000 and task["note"].startswith("crew B") and "estimate" in task["note"]
    assert out["suggestion"]["status"] == "accepted" and out["suggestion"]["mark"]["task_id"] == task["id"]
    body = client.get("/growatt/calendar/suggestions", headers=admin).json()
    assert body["suggestions"] == [] and _by_plant(body)[A]["status"] == "accepted"
    # a second accept has nothing to accept
    assert client.post(f"/growatt/plants/{A}/cleaning-suggestion/accept", headers=admin, json={}).status_code == 409
    assert client.post(f"/growatt/plants/{B}/cleaning-suggestion/accept", headers=admin, json={}).status_code == 409
    assert client.post("/growatt/plants/999/cleaning-suggestion/accept", headers=admin, json={}).status_code == 404
    # the task shows on the calendar like any other
    tasks = client.get("/growatt/calendar/tasks?from=2026-11-01&to=2026-12-31", headers=admin).json()["tasks"]
    assert [t["id"] for t in tasks] == [task["id"]]
    with f() as db:
        assert db.get(OmCleaningSuggestionMark, (A, CLEAN)).action == "accepted"
        remove_blocked_plants(db, [A])
        assert db.scalars(select(OmCleaningSuggestionMark)).all() == [] and db.scalars(select(OmTask)).all() == []


def test_dismiss_and_an_open_cleaning_task_hide_it(api):
    f, client, admin, eng = api
    res = client.post(f"/growatt/plants/{A}/cleaning-suggestion/dismiss", headers=admin)
    assert res.status_code == 200 and res.json()["status"] == "dismissed"
    assert client.get("/growatt/calendar/suggestions", headers=admin).json()["suggestions"] == []
    with f() as db:
        db.delete(db.get(OmCleaningSuggestionMark, (A, CLEAN)))
        db.add(OmTask(plant_id=A, task_type="cleaning", start_day=TODAY + timedelta(days=3), end_day=TODAY + timedelta(days=3), status="planned"))
        db.commit()
    a = _by_plant(client.get("/growatt/calendar/suggestions", headers=admin).json())[A]
    assert a["status"] == "planned" and a["open_task"]["start_day"] == (TODAY + timedelta(days=3)).isoformat()
