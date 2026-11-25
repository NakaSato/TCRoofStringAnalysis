"""O&M Dashboard: loss counted once across overlapping rules, period sums, scoping, entered costs."""

from __future__ import annotations

from datetime import date, datetime, timezone

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import sessionmaker

from app.db.models import (
    Claim,
    ClaimLink,
    GrowattInverter,
    GrowattInverterDaily,
    GrowattIssue,
    GrowattPlant,
    OmPlan,
    OmPlanPlant,
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


def test_spend_by_month_entered_only_and_scoped(api):
    _, client, admin, eng = api
    body = client.get("/growatt/center?start=2026-10-01&end=2026-11-20", headers=admin).json()
    rows = {(r["plant_id"], r["month"], r["event_type"]): r for r in body["spend_by_month"]}
    assert rows[(P1, "2026-10", "repair")] == {"plant_id": P1, "month": "2026-10", "event_type": "repair", "spend_thb": 999, "events": 1, "events_priced": 1}
    assert rows[(P1, "2026-11", "cleaning")]["spend_thb"] == 3000
    # an event without a cost is counted, never priced as 0
    assert rows[(P1, "2026-11", "repair")]["spend_thb"] is None and rows[(P1, "2026-11", "repair")]["events"] == 1
    assert [r["month"] for r in body["spend_by_month"]] == sorted(r["month"] for r in body["spend_by_month"])
    mine = client.get("/growatt/center?start=2026-10-01&end=2026-11-20", headers=eng).json()
    assert {r["plant_id"] for r in mine["spend_by_month"]} == {P1}


# ---------------------------------------------------------------- Phase 2: work, response, claims


def _p1(plant, opened, *, status="open", ack_at=None, closed_at=None, close_reason=None, shadow=False, tier="P1"):
    return GrowattIssue(
        plant_id=plant, device_sn=SN, rule="R8", tier=tier, status=status, shadow=shadow, opened_day=opened, last_seen_day=opened,
        days_seen=1, daily={opened.isoformat(): {"kwh": None, "thb": None}}, ack_at=ack_at, closed_at=closed_at, close_reason=close_reason,
    )


def _utc(s):
    return datetime.fromisoformat(s).replace(tzinfo=timezone.utc)


def test_response_medians_targets_and_edges(api):
    f, client, admin, eng = api
    with f() as db:
        db.add_all([
            # acknowledged the same local day, resolved 2 days later
            _p1(P1, date(2026, 11, 10), status="resolved", ack_at=_utc("2026-11-10T03:00:00"), closed_at=_utc("2026-11-12T03:00:00"), close_reason="resolved"),
            # 18:00 UTC is 01:00 the next day in Bangkok: 1 day
            _p1(P1, date(2026, 11, 10), status="acknowledged", ack_at=_utc("2026-11-10T18:00:00")),
            # window start: dismissed the same day without an acknowledgement
            _p1(P1, date(2026, 11, 1), status="dismissed", closed_at=_utc("2026-11-01T05:00:00"), close_reason="dismissed"),
            # window end: nobody has acted yet
            _p1(P1, date(2026, 11, 20)),
            _p1(P1, date(2026, 10, 31), status="acknowledged", ack_at=_utc("2026-10-31T03:00:00")),  # before the window
            _p1(P1, date(2026, 11, 5), shadow=True),
            _p1(P2, date(2026, 11, 5)),  # not the engineer's plant
        ])
        db.commit()

    def tiers(body):
        return {t["tier"]: t for t in body["response"]["tiers"]}

    mine = tiers(client.get("/growatt/center", headers=eng).json())
    p1 = mine["P1"]
    assert (p1["target_days"], p1["opened"], p1["acknowledged"], p1["ack_median_days"]) == (0, 4, 2, 0.5)
    assert (p1["closed_by_team"], p1["close_median_days"], p1["responded"], p1["first_response_median_days"]) == (2, 1.0, 3, 0.0)
    assert (p1["within_target"], p1["waiting"], p1["waiting_oldest_days"]) == (2, 1, 0)
    # the fixture's P2 issues: auto-closed ones are not a response; the dismissed one has no closed_at, so no day
    p2 = mine["P2"]
    assert (p2["target_days"], p2["opened"], p2["auto_closed"], p2["acknowledged"], p2["closed_by_team"]) == (2, 8, 4, 0, 0)
    assert p2["ack_median_days"] is None and p2["first_response_median_days"] is None and p2["within_target"] == 0
    assert (p2["waiting"], p2["waiting_oldest_days"]) == (3, 2)

    fleet = tiers(client.get("/growatt/center", headers=admin).json())
    assert fleet["P1"]["opened"] == 5 and fleet["P1"]["waiting"] == 2
    assert tiers(client.get("/growatt/center?include_shadow=true", headers=admin).json())["P1"]["opened"] == 6
    # an engineer cannot ask for shadow issues
    assert tiers(client.get("/growatt/center?include_shadow=true", headers=eng).json())["P1"]["opened"] == 4
    # the start edge moves: the 1 Nov issue drops out
    later = tiers(client.get("/growatt/center?start=2026-11-02&end=2026-11-20", headers=eng).json())["P1"]
    assert later["opened"] == 3 and later["closed_by_team"] == 1 and later["close_median_days"] == 2.0
    # nothing opened in a window = no tiers, not zeros
    assert client.get("/growatt/center?start=2026-09-01&end=2026-09-30", headers=eng).json()["response"]["tiers"] == []


def test_work_this_week_and_plans(api):
    f, client, admin, eng = api
    with f() as db:
        plan = OmPlan(name="Monthly clean", task_type="cleaning", every_n=1, unit="month", starts_on=date(2026, 1, 1))
        db.add(plan)
        db.flush()
        db.add(OmPlanPlant(plan_id=plan.id, plant_id=P1))
        db.add_all([
            OmTask(plant_id=P1, task_type="cleaning", start_day=date(2026, 11, 17), end_day=date(2026, 11, 17), status="planned", plan_id=plan.id, scheduled_day=date(2026, 11, 17)),
            OmTask(plant_id=P1, task_type="repair", start_day=date(2026, 11, 10), end_day=date(2026, 11, 11), status="in_progress"),
            OmTask(plant_id=P1, task_type="repair", start_day=date(2026, 11, 18), end_day=date(2026, 11, 18), status="cancelled"),
            # spans into the week from the Sunday before: counted
            OmTask(plant_id=P1, task_type="site_visit", start_day=date(2026, 11, 15), end_day=date(2026, 11, 16), status="done"),
            OmTask(plant_id=P2, task_type="repair", start_day=date(2026, 11, 22), end_day=date(2026, 11, 22), status="planned"),
            OmTask(plant_id=P2, task_type="repair", start_day=date(2026, 11, 23), end_day=date(2026, 11, 23), status="planned"),  # next week
        ])
        db.commit()
    w = client.get("/growatt/center", headers=eng).json()["work"]
    # TODAY is Friday 20 Nov: the week is Mon 16 … Sun 22; the fixture's done task on 21 Nov is in it
    assert w["week"] == {"start": "2026-11-16", "end": "2026-11-22"}
    assert w["tasks"]["by_status"] == {"planned": 1, "in_progress": 0, "done": 2, "skipped": 0, "cancelled": 1}
    assert (w["tasks"]["total"], w["tasks"]["open"], w["tasks"]["overdue"]) == (3, 1, 1)
    assert w["from_plans"] == {"total": 1, "done": 0, "open": 1, "overdue": 1}
    assert (w["active_plans"], w["overdue_all"], w["overdue_oldest_days"]) == (1, 2, 9)
    fleet = client.get("/growatt/center", headers=admin).json()["work"]
    assert fleet["tasks"]["total"] == 4 and fleet["tasks"]["overdue"] == 1
    # the week follows today, not the period
    assert client.get("/growatt/center?start=2026-10-01&end=2026-10-31", headers=eng).json()["work"]["week"]["start"] == "2026-11-16"


def test_claims_waiting_and_linked_claim_on_issue_rows(api):
    f, client, admin, eng = api
    with f() as db:
        r1 = db.scalars(select(GrowattIssue).where(GrowattIssue.plant_id == P1, GrowattIssue.rule == "R1")).one()
        c1 = Claim(number="CL-2026-001", claim_type="inverter_warranty", status="submitted", cause="unknown", plant_id=P1, counterparty="Growatt",
                   submitted_day=date(2026, 11, 1), next_action_day=date(2026, 11, 19))
        c2 = Claim(number="CL-2026-002", claim_type="insurance", status="draft", cause="storm_wind", plant_id=P1, counterparty="Insurer",
                   created_at=_utc("2026-11-15T00:00:00"))
        c3 = Claim(number="CL-2026-003", claim_type="insurance", status="closed", cause="fire", plant_id=P1, counterparty="Insurer")
        c4 = Claim(number="CL-2026-004", claim_type="module_warranty", status="info_requested", cause="degradation", plant_id=P2, counterparty="Maker",
                   submitted_day=date(2026, 9, 1))
        db.add_all([c1, c2, c3, c4])
        db.flush()
        db.add(ClaimLink(claim_id=c1.id, kind="issue", ref_id=r1.id))
        db.add(ClaimLink(claim_id=c3.id, kind="issue", ref_id=r1.id))
        db.commit()
    body = client.get("/growatt/center", headers=eng).json()
    cl = body["claims"]
    assert (cl["open"], cl["by_status"], cl["waiting_us"], cl["waiting_them"], cl["followup_overdue"]) == (2, {"draft": 1, "submitted": 1}, 1, 1, 1)
    assert cl["oldest"]["number"] == "CL-2026-001" and cl["oldest"]["age_days"] == 19
    assert "thb" not in str(cl).lower()
    r1_row = next(i for i in body["issues"]["top"] if i["rule"] == "R1")
    assert [(c["number"], c["open"]) for c in r1_row["claims"]] == [("CL-2026-003", False), ("CL-2026-001", True)]
    assert all(i["claims"] == [] for i in body["issues"]["top"] if i["rule"] != "R1")
    assert body["plants"][0]["open_claims"] == 2

    fleet = client.get("/growatt/center", headers=admin).json()["claims"]
    assert fleet["open"] == 3 and fleet["oldest"]["number"] == "CL-2026-004" and fleet["oldest"]["age_days"] == 80
