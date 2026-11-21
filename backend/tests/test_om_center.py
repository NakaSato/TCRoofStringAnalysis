"""O&M Dashboard: loss counted once across overlapping rules, period sums, scoping, entered costs."""

from __future__ import annotations

from datetime import date

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import sessionmaker

from app.db.models import (
    GrowattInverter,
    GrowattInverterDaily,
    GrowattIssue,
    GrowattPlant,
    OmTask,
    PwaMeterSite,
    SiteEvent,
    User,
    UserPlantAssignment,
)
from app.db.seed import ensure_seeded
from app.db.session import Base, build_engine, get_db
from app.main import create_app
from app.services import jobs, om_center, tariff

TODAY = date(2026, 11, 20)
P1, P2 = 9201, 9202  # P1: the engineer's plant
SN = "INV_M1"


def _issue(plant, rule, daily, *, sn=SN, sno=None, status="open", shadow=False, close_reason=None, per_day=None, safety=False):
    days = sorted(daily)
    return GrowattIssue(
        plant_id=plant, device_sn=sn, string_no=sno, rule=rule, tier="P2", safety=safety, status=status, shadow=shadow,
        close_reason=close_reason, opened_day=date.fromisoformat(days[0]), last_seen_day=date.fromisoformat(days[-1]),
        days_seen=len(days), daily={d: {"kwh": k, "thb": t} for d, (k, t) in daily.items()},
        lost_kwh_est=per_day[0] if per_day else None, thb_per_day_est=per_day[1] if per_day else None,
    )


@pytest.fixture()
def api(tmp_path, monkeypatch):
    monkeypatch.setattr(jobs, "_today", lambda: TODAY)
    engine = build_engine(f"sqlite:///{tmp_path / 'center.db'}")
    Base.metadata.create_all(bind=engine)
    f = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)
    with f() as db:
        ensure_seeded(db)
        db.add_all([GrowattPlant(plant_id=P1, name="Alpha", peak_power_kwp=100.0), GrowattPlant(plant_id=P2, name="Beta")])
        db.add(GrowattInverter(device_sn=SN, plant_id=P1, alias="Inverter M1"))
        eng = db.scalars(select(User).where(User.username == "engineer")).one()
        db.add(UserPlantAssignment(user_id=eng.id, plant_id=P1))
        db.add_all([
            # 18 Nov on one inverter: two rules price string 3 (the larger counts), R8, and R7 = 30 kWh
            # of which strings (10) and R11 (5) explain 15
            _issue(P1, "R1", {"2026-11-18": (10.0, 40.0), "2026-11-19": (8.0, 32.0)}, sno=3, per_day=(9.0, 36.0)),
            _issue(P1, "R5", {"2026-11-18": (6.0, 24.0)}, sno=3, per_day=(6.0, 24.0)),
            _issue(P1, "R8", {"2026-11-18": (20.0, 80.0)}, status="resolved", close_reason="auto"),
            _issue(P1, "R11", {"2026-11-18": (5.0, 20.0)}, status="resolved", close_reason="auto"),
            _issue(P1, "R7", {"2026-11-18": (30.0, 120.0)}, status="resolved", close_reason="auto"),
            # plant shortfall 60 kWh: 50 already explained
            _issue(P1, "R10", {"2026-11-18": (60.0, 240.0)}, sn=None, status="resolved", close_reason="auto"),
            _issue(P1, "R3", {"2026-11-19": (None, None)}, safety=True),  # no kWh: counted as an issue, adds no loss
            _issue(P1, "R8", {"2026-11-17": (99.0, 396.0)}, sn="INV_X", status="dismissed", close_reason="dismissed"),
            _issue(P1, "R8", {"2026-10-30": (50.0, 200.0)}, sn="INV_OLD", status="resolved", close_reason="auto"),  # before the window
            _issue(P1, "R2", {"2026-11-19": (70.0, 280.0)}, sno=9, shadow=True, per_day=(70.0, 280.0)),
            _issue(P2, "R8", {"2026-11-19": (40.0, 160.0)}, sn="INV_B", per_day=(40.0, 160.0)),
        ])
        db.add_all([
            GrowattInverterDaily(device_sn=SN, day=date(2026, 11, 18), plant_id=P1, daylight_min=600, producing_min=480,
                                 fault_min=60, off_min=0, standby_min=0, limited_min=10, no_data_min=100, energy_kwh=400.0),
            GrowattInverterDaily(device_sn=SN, day=date(2026, 11, 19), plant_id=P1, daylight_min=600, producing_min=600, energy_kwh=540.0),
            GrowattInverterDaily(device_sn="INV_B", day=date(2026, 11, 19), plant_id=P2, daylight_min=600, producing_min=0, fault_min=600),
        ])
        db.add_all([
            SiteEvent(plant_id=P1, event_type="cleaning", day=date(2026, 11, 10), cost_thb=3000.0),
            SiteEvent(plant_id=P1, event_type="repair", day=date(2026, 11, 12)),
            SiteEvent(plant_id=P1, event_type="repair", day=date(2026, 10, 2), cost_thb=999.0),
            OmTask(plant_id=P1, task_type="repair", start_day=date(2026, 11, 25), end_day=date(2026, 11, 25), status="planned", est_cost_thb=1500.0),
            OmTask(plant_id=P1, task_type="cleaning", start_day=date(2026, 12, 5), end_day=date(2026, 12, 5), status="planned"),
            OmTask(plant_id=P1, task_type="repair", start_day=date(2026, 11, 21), end_day=date(2026, 11, 21), status="done", est_cost_thb=700.0),
        ])
        db.commit()
    app = create_app()

    def override():
        with f() as db:
            yield db

    app.dependency_overrides[get_db] = override
    client = TestClient(app)

    def hdr(user, pw):
        return {"Authorization": f"Bearer {client.post('/auth/login', json={'username': user, 'password': pw}).json()['access_token']}"}

    return f, client, hdr("admin", "admin123"), hdr("engineer", "engineer123")


def test_attribute_counts_each_kwh_once():
    loss = om_center.attribute([
        (1, "A", 3, "R1", 10.0, 40.0), (1, "A", 3, "R5", 6.0, 24.0), (1, "A", None, "R8", 20.0, 80.0),
        (1, "A", None, "R11", 5.0, 20.0), (1, "A", None, "R7", 30.0, 120.0), (1, None, None, "R10", 60.0, 240.0),
        (1, "A", None, "R3", None, None),
    ])[1]
    assert {k: tuple(v) for k, v in loss.items()} == {
        "strings": (10.0, 40.0), "down": (20.0, 80.0), "conversion": (5.0, 20.0), "underyield": (15.0, 60.0), "plant": (10.0, 40.0),
    }
    # R7 and R10 smaller than what is already explained add nothing
    assert "underyield" not in om_center.attribute([(1, "A", 1, "R1", 10.0, 40.0), (1, "A", None, "R7", 8.0, 32.0)])[1]
    assert om_center.attribute([(1, "A", None, "R3", None, None)]) == {}


def test_engineer_sees_own_plants_live_issues_only(api):
    _, client, admin, eng = api
    body = client.get("/growatt/center", headers=eng).json()
    assert body["window"] == {"start": "2026-11-01", "end": "2026-11-20", "days": 20, "today": "2026-11-20"}
    assert body["scope"] == "assigned" and body["plant_count"] == 1 and body["shadow_hidden"] is None
    m = body["money"]
    # 18 Nov: 60 kWh / 240 THB counted once; 19 Nov: string 3 again (8 / 32). Dismissed, shadow and October left out
    assert m["lost_kwh_est"] == 68.0 and m["lost_thb_est"] == 272
    assert m["produced_kwh"] == 940.0 and m["loss_share_pct"] == round(68 / 1008 * 100, 2)
    assert m["availability_pct"] == round((1 - 60 / 1100) * 100, 2) and m["limited_min"] == 10
    # losing now: R1 and R5 price the same string, the larger counts
    assert m["losing_now_thb_per_day_est"] == 36 and m["active_issues"] == 3 and m["safety_issues"] == 1
    assert (m["spend_thb"], m["spend_events"], m["spend_events_priced"]) == (3000, 2, 1)
    assert (m["committed_thb"], m["committed_tasks"], m["committed_tasks_priced"]) == (1500, 2, 1)
    totals = {t["family"]: (t["kwh_est"], t["thb_est"]) for t in body["loss_by_cause"]["totals"]}
    assert totals == {"down": (20.0, 80), "strings": (18.0, 72), "conversion": (5.0, 20), "underyield": (15.0, 60), "plant": (10.0, 40)}
    assert [(d["day"], d["family"]) for d in body["loss_by_cause"]["days"]][-1] == ("2026-11-19", "strings")

    top = body["issues"]["top"]
    assert top[0]["rule"] == "R3" and top[0]["safety"] and "daily" not in top[0]
    r1 = next(i for i in top if i["rule"] == "R1")
    assert (r1["next_visit"], r1["days_to_visit"], r1["cost_of_waiting_thb_est"], r1["age_days"]) == ("2026-11-25", 5, 180, 2)
    assert all(not i["shadow"] and i["plant_id"] == P1 for i in top)

    (row,) = body["plants"]
    assert row["plant_id"] == P1 and row["lost_thb_est"] == 272 and row["active_issues"] == 3
    assert row["days_since_cleaning"] == 10 and row["next_visit"] == "2026-11-25" and row["spend_thb"] == 3000
    assert row["epi_median"] is None and row["availability_pct"] == m["availability_pct"]

    # an engineer cannot turn shadow issues on
    assert client.get("/growatt/center?include_shadow=true", headers=eng).json()["money"]["lost_thb_est"] == 272


def test_admin_fleet_shadow_and_window(api):
    _, client, admin, _ = api
    body = client.get("/growatt/center", headers=admin).json()
    assert body["scope"] == "fleet" and body["plant_count"] >= 2 and body["shadow_hidden"] == 1
    assert body["money"]["lost_thb_est"] == 272 + 160 and body["money"]["losing_now_thb_per_day_est"] == 36 + 160
    beta = next(p for p in body["plants"] if p["plant_id"] == P2)
    # no energy row with a value: produced is unknown, never 0
    assert beta["energy_kwh"] is None and beta["loss_share_pct"] is None and beta["availability_pct"] == 0.0
    assert beta["days_since_cleaning"] is None and beta["next_visit"] is None and beta["spend_thb"] is None

    shadow = client.get("/growatt/center?include_shadow=true", headers=admin).json()
    assert shadow["money"]["lost_thb_est"] == 272 + 160 + 280 and shadow["shadow_hidden"] is None

    old = client.get("/growatt/center?start=2026-10-01&end=2026-10-31", headers=admin).json()
    assert old["money"]["lost_thb_est"] == 200 and old["money"]["spend_thb"] == 999 and old["money"]["produced_kwh"] is None
    empty = client.get("/growatt/center?start=2026-09-01&end=2026-09-30", headers=admin).json()
    assert empty["money"]["lost_thb_est"] is None and empty["loss_by_cause"]["days"] == []

    assert client.get("/growatt/center?start=2026-11-20&end=2026-11-01", headers=admin).status_code == 422
    assert client.get("/growatt/center?start=2025-01-01&end=2026-11-01", headers=admin).status_code == 422
    assert client.get("/growatt/center").status_code == 401


def test_pwa_plant_rates_fill_keeps_entered_rates(api):
    f, _, _, _ = api
    with f() as db:
        db.add_all([
            PwaMeterSite(site_id="P1-1", phase=1, name="A", kwp=100.0, growatt_plant_id=P1),
            PwaMeterSite(site_id="P1-2", phase=1, name="B", kwp=100.0, growatt_plant_id=P2),
            PwaMeterSite(site_id="P1-3", phase=1, name="C", kwp=100.0),
        ])
        db.commit()
        cur = tariff.get_tariff(db)
        tariff.put_tariff(db, {**{k: cur[k] for k in tariff.DEFAULT_TARIFF}, "plant_rates": {str(P1): {"thb_per_kwh": 3.5, "basis": "PPA"}}}, "admin")
        dry = tariff.fill_pwa_plant_rates(db, "cli")
        assert dry == {"added": 1, "kept": 1, "applied": False, "plants": [P2]}
        assert str(P2) not in tariff.get_tariff(db)["plant_rates"]
        assert tariff.fill_pwa_plant_rates(db, "cli", apply=True)["applied"]
        rates = tariff.get_tariff(db)["plant_rates"]
        assert rates[str(P1)]["thb_per_kwh"] == 3.5 and rates[str(P2)] == {"thb_per_kwh": 2.7647, "basis": "PWA contract"}
        assert tariff.pricer(db).thb(P2, 10.0, 10.0) == pytest.approx(27.647)
