"""Decision rules Phase 1: daily string / inverter tables and rules R1–R18 (docs/plans/decision-rules.md)."""

from __future__ import annotations

import math
from datetime import date, datetime, timedelta
from typing import Callable, Dict, Optional

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import sessionmaker

from app.db.models import (
    GrowattAlarm,
    GrowattInverter,
    GrowattInverterDaily,
    GrowattInverterReading,
    GrowattPlant,
    GrowattStringDaily,
    GrowattStringReading,
)
from app.db.seed import ensure_seeded
from app.db.session import Base, build_engine, get_db
from app.main import create_app
from app.services import growatt_daily, growatt_rules, jobs
from app.worker import default_schedule

DAY = date(2026, 11, 10)
PLANT = 1
A, B = "INV_A", "INV_B"
V = 600.0
PEAK_A = 9.0


@pytest.fixture()
def factory(tmp_path):
    engine = build_engine(f"sqlite:///{tmp_path / 'rules.db'}")
    Base.metadata.create_all(bind=engine)
    f = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)
    with f() as db:
        db.add(GrowattPlant(plant_id=PLANT, name="Rules Plant", latitude=13.75, longitude=100.5, peak_power_kwp=100.0))
        for sn in (A, B):
            db.add(GrowattInverter(device_sn=sn, plant_id=PLANT, nominal_power_w=50000.0))
        db.commit()
    return f


Current = Callable[[str, int, datetime, float], Optional[float]]  # (sn, string, ts, healthy A) -> A or None


def _healthy(_sn: str, _s: int, _ts: datetime, i: float) -> float:
    return i


def _seed_day(
    db,
    day: date = DAY,
    current: Current = _healthy,
    status: Callable[[str, datetime], int] = lambda sn, ts: 1,
    skip: Callable[[str, datetime], bool] = lambda sn, ts: False,
    peak: float = PEAK_A,
) -> None:
    """06:00–18:00 every 5 min, 4 strings per inverter, a sine-shaped day."""
    eac: Dict[str, float] = {A: 0.0, B: 0.0}
    t = datetime.combine(day, datetime.min.time()) + timedelta(hours=6)
    end = t + timedelta(hours=12)
    while t <= end:
        f = max(0.0, math.sin(math.pi * (t.hour + t.minute / 60 - 6) / 12))
        for sn in (A, B):
            st = status(sn, t)
            currents = {s: (current(sn, s, t, peak * f) if st == 1 else 0.0) for s in range(1, 5)}
            pac = sum(V * (i or 0) for i in currents.values()) * 0.97
            eac[sn] += pac * 5 / 60 / 1000
            if skip(sn, t):
                continue
            db.add(GrowattInverterReading(device_sn=sn, timestamp=t, status=st, pac_w=pac, eac_today_kwh=round(eac[sn], 3)))
            for s, i in currents.items():
                if i is None:
                    continue
                db.add(GrowattStringReading(device_sn=sn, timestamp=t, string_no=s, mppt_no=(s + 1) // 2,
                                            voltage_v=V, current_a=i, power_w=V * i))
        t += timedelta(minutes=5)
    db.commit()


def _compute(db, day: date = DAY):
    growatt_daily.compute_day(db, day)
    strings = {(r.device_sn, r.string_no): r for r in db.scalars(select(GrowattStringDaily).where(GrowattStringDaily.day == day))}
    invs = {r.device_sn: r for r in db.scalars(select(GrowattInverterDaily).where(GrowattInverterDaily.day == day))}
    return strings, invs


def _rules(db, day: date = DAY):
    return {(f["rule"], f["device_sn"], f["string_no"]): f for f in growatt_rules.evaluate(db, day)}


def _between(ts: datetime, h0: float, h1: float) -> bool:
    h = ts.hour + ts.minute / 60
    return h0 <= h < h1


# --------------------------------------------------------------------------- strings


def test_healthy_day_has_verdicts_and_no_findings(factory):
    with factory() as db:
        _seed_day(db)
        strings, invs = _compute(db)
        assert len(strings) == 8
        s = strings[(A, 1)]
        assert s.gated_slots >= growatt_daily.MIN_GATED_SLOTS
        assert s.ratio_median == pytest.approx(1.0)
        assert s.low_min == 0 and s.open_min == 0 and s.lost_kwh_est == 0
        assert s.energy_kwh and s.energy_kwh > 0
        inv = invs[A]
        assert inv.producing_min > 0 and inv.fault_min == 0 and inv.no_data_min == 0
        assert inv.kwp == pytest.approx(50.0)  # plant kWp shared by rated AC power
        assert inv.plant_kwp_share_pct == pytest.approx(50.0)
        assert inv.yf_vs_median_pct == pytest.approx(0.0)
        assert _rules(db) == {}


def test_low_light_day_gives_no_verdict(factory):
    with factory() as db:
        _seed_day(db, peak=2.5)  # median never reaches the 3 A gate
        strings, _ = _compute(db)
        s = strings[(A, 1)]
        assert s.gated_slots == 0
        assert s.ratio_median is None and s.low_min is None


def test_open_string_is_r2(factory):
    with factory() as db:
        _seed_day(db, current=lambda sn, s, ts, i: 0.0 if (sn, s) == (A, 3) and _between(ts, 10, 11) else i)
        strings, _ = _compute(db)
        assert strings[(A, 3)].open_min == 60
        assert strings[(A, 3)].lost_kwh_est and strings[(A, 3)].lost_kwh_est > 0
        assert strings[(A, 1)].open_min == 0
        found = _rules(db)
        assert ("R2", A, 3) in found and found[("R2", A, 3)]["tier"] == "P2"
        assert ("R1", A, 3) not in found  # not reported twice


def test_inverter_wide_drop_is_not_open_strings(factory):
    # derating / MPPT sweep: most strings at ~0 A together for an hour
    with factory() as db:
        _seed_day(db, current=lambda sn, s, ts, i: 0.1 if sn == A and s != 4 and _between(ts, 11, 12) else i)
        strings, _ = _compute(db)
        assert all(strings[(A, s)].open_min == 0 for s in range(1, 5))
        assert not any(k[0] == "R2" for k in _rules(db))


def test_passing_cloud_is_not_a_weak_string(factory):
    # one string 50 % low for 10 min, and every string halved together for 30 min
    def cur(sn, s, ts, i):
        if (sn, s) == (A, 2) and _between(ts, 9, 9 + 10 / 60):
            return i * 0.5
        if _between(ts, 13, 13.5):
            return i * 0.5
        return i

    with factory() as db:
        _seed_day(db, current=cur)
        strings, _ = _compute(db)
        assert strings[(A, 2)].low_min == 10
        assert strings[(A, 1)].low_min == 0  # a uniform drop keeps the ratio at 1
        assert _rules(db) == {}


def test_weak_string_needs_two_of_three_days(factory):
    weak = lambda sn, s, ts, i: i * 0.7 if (sn, s) == (B, 4) else i  # noqa: E731
    with factory() as db:
        _seed_day(db, DAY, current=weak)
        _compute(db, DAY)
        assert ("R1", B, 4) not in _rules(db, DAY)  # one day only
        _seed_day(db, DAY + timedelta(days=1), current=weak)
        _compute(db, DAY + timedelta(days=1))
        found = _rules(db, DAY + timedelta(days=1))
        assert found[("R1", B, 4)]["tier"] == "P2"
        assert found[("R1", B, 4)]["evidence"]["days_hit"] == 2


# --------------------------------------------------------------------------- inverters


def test_fault_hour_is_downtime_with_lost_energy_from_peers(factory):
    with factory() as db:
        _seed_day(db, status=lambda sn, ts: 3 if sn == B and _between(ts, 11, 12) else 1)
        _, invs = _compute(db)
        b = invs[B]
        assert b.fault_min == 60
        # peer A's specific yield over that hour × B's 50 kWp ≈ A's energy in the hour
        assert b.lost_fault_kwh_est == pytest.approx(4 * V * PEAK_A * 0.97 / 1000 * 0.95, rel=0.1)
        assert b.yf_vs_median_pct is not None and b.yf_vs_median_pct < -3
        found = _rules(db)
        assert found[("R8", B, None)]["tier"] == "P1"  # 50 % of the plant > 30 %
        assert found[("R8", B, None)]["lost_kwh_est"] == pytest.approx(b.lost_fault_kwh_est, abs=0.01)


def test_short_standby_is_not_r8(factory):
    with factory() as db:
        _seed_day(db, status=lambda sn, ts: 0 if sn == B and _between(ts, 12, 12 + 10 / 60) else 1)
        _, invs = _compute(db)
        assert invs[B].standby_min == 10
        assert ("R8", B, None) not in _rules(db)


def test_data_gap_recovered_by_eac_today_is_not_lost(factory):
    with factory() as db:
        _seed_day(db, skip=lambda sn, ts: sn == B and _between(ts, 10, 11))
        _, invs = _compute(db)
        b = invs[B]
        assert b.no_data_min == 60
        assert b.lost_no_data_kwh_est == pytest.approx(0.0, abs=0.5)
        assert b.fault_min == 0
        found = _rules(db)
        assert found[("R17", B, None)]["tier"] == "P4"  # 60 of ~630 daylight min > 5 %
        assert ("R8", B, None) not in found


def test_limited_inverter_is_not_a_fault(factory):
    with factory() as db:
        inv = db.get(GrowattInverter, A)
        inv.active_rate_pct = 30.0  # 15 kW cap; the sine day peaks at ~21 kW
        db.commit()
        _seed_day(db)
        strings, invs = _compute(db)
        assert invs[A].limited_min > 0 and invs[A].fault_min == 0
        assert strings[(A, 1)].gated_slots < strings[(B, 1)].gated_slots  # limited slots are not gated
        found = _rules(db)
        assert found[("R18", A, None)]["tier"] == "Info"
        assert ("R8", A, None) not in found


def test_today_is_judged_only_up_to_each_inverters_newest_record(factory):
    with factory() as db:
        # A synced until 15:00, B only until 12:00: the rest of the day is not fetched yet
        _seed_day(db, skip=lambda sn, ts: ts.hour >= (15 if sn == A else 12))
        r = growatt_daily.compute_day(db, DAY)
        assert r["until"].startswith("2026-11-10T14:55")
        invs = {x.device_sn: x for x in db.scalars(select(GrowattInverterDaily))}
        assert invs[A].no_data_min == 0 and invs[B].no_data_min == 0
        assert invs[B].daylight_min < invs[A].daylight_min


def test_recompute_replaces_rows(factory):
    with factory() as db:
        _seed_day(db)
        _compute(db)
        _compute(db)
        assert len(list(db.scalars(select(GrowattStringDaily)))) == 8
        assert len(list(db.scalars(select(GrowattInverterDaily)))) == 2


# --------------------------------------------------------------------------- alarms, settings


def test_alarm_rules_r3_and_r9(factory):
    with factory() as db:
        base = datetime.combine(DAY, datetime.min.time())
        db.add(GrowattAlarm(device_sn=A, plant_id=PLANT, day=DAY, start_time=base + timedelta(hours=7),
                            alarm_code="203", alarm_message="PV Isolation Low", fault_type="Error"))
        for k in range(3):  # three grid trips this week, each re-reported twice 5 min apart
            d = DAY - timedelta(days=k)
            for m in (0, 5):
                t = datetime.combine(d, datetime.min.time()) + timedelta(hours=9, minutes=m)
                db.add(GrowattAlarm(device_sn=B, plant_id=PLANT, day=d, start_time=t, end_time=t + timedelta(minutes=1),
                                    alarm_code="302", alarm_message="No AC Connection", fault_type="Error"))
        db.commit()
        findings = growatt_rules.evaluate(db, DAY)
        assert findings[0]["rule"] == "R3" and findings[0]["safety"] and findings[0]["tier"] == "P1"
        r9 = next(f for f in findings if f["rule"] == "R9")
        assert r9["device_sn"] == B and r9["evidence"]["events"] == 3


def test_rule_settings_override_from_app_settings(factory):
    from app.db.models import AppSetting

    with factory() as db:
        db.add(AppSetting(key=growatt_rules.SETTING_KEY, value={"r2_open_min": 120, "unknown": 1}))
        db.commit()
        cfg = growatt_rules.rule_settings(db)
        assert cfg["r2_open_min"] == 120 and "unknown" not in cfg
        _seed_day(db, current=lambda sn, s, ts, i: 0.0 if (sn, s) == (A, 3) and _between(ts, 10, 11) else i)
        _compute(db)
        assert ("R2", A, 3) not in _rules(db)  # 60 min < 120


# --------------------------------------------------------------------------- jobs and API


def test_jobs_registered_and_scheduled():
    assert {"rules_today", "rules_yesterday", "rules_backfill"} <= set(jobs.JOBS)
    names = [s.job for s in default_schedule()]
    assert "rules_yesterday" in names and "rules_today" in names
    assert "rules_backfill" not in names
    assert names.index("rules_yesterday") > names.index("alarms_yesterday")


def test_rules_job_and_backfill(factory, monkeypatch):
    monkeypatch.setattr(jobs, "_today", lambda: DAY + timedelta(days=1))
    with factory() as db:
        _seed_day(db)
        status, detail = jobs.job_rules_yesterday(db)
        assert status == "ok" and detail["inverters"] == 2 and detail["rules"]["findings"] == 0
        status, detail = jobs.job_rules_backfill(db)
        assert status == "ok" and detail["days"] == 1 and detail["start"] == DAY.isoformat()


def test_findings_endpoint_is_admin_only(tmp_path):
    engine = build_engine(f"sqlite:///{tmp_path / 'api.db'}")
    Base.metadata.create_all(bind=engine)
    f = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)
    with f() as db:
        ensure_seeded(db)
    app = create_app()

    def override():
        with f() as db:
            yield db

    app.dependency_overrides[get_db] = override
    client = TestClient(app)

    def token(user, pw):
        return client.post("/auth/login", json={"username": user, "password": pw}).json()["access_token"]

    eng = client.get("/growatt/rules/findings", headers={"Authorization": f"Bearer {token('engineer', 'engineer123')}"})
    assert eng.status_code == 403
    res = client.get("/growatt/rules/findings?day=2026-11-10", headers={"Authorization": f"Bearer {token('admin', 'admin123')}"})
    assert res.status_code == 200
    body = res.json()
    assert body["day"] == "2026-11-10" and body["findings"] == [] and body["meta"]["stored"] is False


# --------------------------------------------------------------------------- Phase 2: tariff, issues


from app.services import growatt_issues, tariff  # noqa: E402


def _finding(rule="R2", sn=A, sno=3, day=DAY, kwh=2.0, thb=10.0, tier="P2", shadow=True, plant=PLANT):
    return {"rule": rule, "tier": tier, "plant_id": plant, "device_sn": sn, "string_no": sno, "day": day.isoformat(),
            "lost_kwh_est": kwh, "thb_est": thb, "evidence": {"open_min": 60}, "safety": False, "shadow": shadow}


def test_tariff_prices_on_and_off_peak():
    pr = tariff.Pricer({**tariff.DEFAULT_TARIFF, "plant_rates": {"7": {"thb_per_kwh": 3.5, "basis": "PPA"}}})
    tue = datetime(2026, 11, 10, 10, 0)
    assert pr.is_on_peak(tue) and not pr.is_on_peak(tue.replace(hour=8))
    assert not pr.is_on_peak(datetime(2026, 11, 14, 10, 0))  # Saturday
    assert not pr.is_on_peak(datetime(2026, 12, 10, 10, 0))  # holiday in the default list
    on, off, ft = (tariff.DEFAULT_TARIFF[k] for k in ("on_peak_thb", "off_peak_thb", "ft_thb"))
    assert pr.thb(PLANT, 10.0, 4.0) == pytest.approx(4 * (on + ft) + 6 * (off + ft))
    assert pr.thb(PLANT, 10.0, None) == pytest.approx(10 * (off + ft))  # unknown split: the lower rate
    assert pr.thb(7, 10.0, 4.0) == pytest.approx(35.0)  # flat plant rate
    assert pr.thb(PLANT, None, None) is None
    assert pr.energy_weighted_rate(PLANT, [(tue.replace(hour=8), 1.0), (tue, 1.0)]) == pytest.approx((on + off) / 2 + ft)


def test_lost_energy_is_split_into_on_peak(factory):
    with factory() as db:  # DAY is a Tuesday: 10–11 on-peak, 07–08 off-peak
        _seed_day(db, current=lambda sn, s, ts, i: 0.0 if ((sn, s) == (A, 3) and _between(ts, 10, 11)) or
                  ((sn, s) == (A, 4) and _between(ts, 7, 8)) else i)
        strings, _ = _compute(db)
        on3, all3 = strings[(A, 3)].lost_on_peak_kwh_est, strings[(A, 3)].lost_kwh_est
        assert all3 and on3 == pytest.approx(all3)
        assert strings[(A, 4)].lost_kwh_est and strings[(A, 4)].lost_on_peak_kwh_est == 0
        f = _rules(db)[("R2", A, 3)]
        assert f["thb_est"] is not None and f["thb_est"] > 0 and f["shadow"] is True


def test_open_string_above_thb_line_is_p1_and_disabled_rules_do_not_fire(factory):
    with factory() as db:
        _seed_day(db, current=lambda sn, s, ts, i: 0.0 if (sn, s) == (A, 3) and _between(ts, 10, 11) else i)
        _compute(db)
        assert _rules(db)[("R2", A, 3)]["tier"] == "P2"
        from app.db.models import AppSetting  # overrides live in app_settings (edited in the DB; no API)

        db.add(AppSetting(key=growatt_rules.SETTING_KEY, value={"p1_thb_per_day": 1}))
        db.commit()
        assert _rules(db)[("R2", A, 3)]["tier"] == "P1"
        db.get(AppSetting, growatt_rules.SETTING_KEY).value = {"p1_thb_per_day": 1, "rules": {"R2": {"enabled": False}}}
        db.commit()
        assert ("R2", A, 3) not in _rules(db)


def test_issue_opens_updates_and_closes_itself(factory):
    with factory() as db:
        _seed_day(db, current=lambda sn, s, ts, i: 0.0 if (sn, s) == (A, 3) and _between(ts, 10, 11) else i)
        _compute(db)
        f = growatt_rules.evaluate(db, DAY)
        assert growatt_issues.sync(db, DAY, f)["opened"] == 1
        again = growatt_issues.sync(db, DAY, f)  # rules_today re-runs the same day
        assert again["opened"] == 0 and again["updated"] == 1
        i = db.scalars(select(growatt_issues.GrowattIssue)).one()
        assert i.rule == "R2" and i.shadow and i.status == "open" and i.days_seen == 1
        assert i.thb_total_est == i.thb_per_day_est and i.lost_kwh_total_est == pytest.approx(f[0]["lost_kwh_est"], abs=0.01)
        for n in (1, 2):  # two healthy days with a verdict
            d = DAY + timedelta(days=n)
            _seed_day(db, day=d)
            _compute(db, d)
            r = growatt_issues.sync(db, d, growatt_rules.evaluate(db, d))
        assert r["closed"] == 1
        db.refresh(i)
        assert i.status == "resolved" and i.close_reason == "auto" and i.feedback is None


def test_issue_needs_verdicts_to_close_and_partial_day_is_withdrawn(factory):
    with factory() as db:
        growatt_issues.sync(db, DAY, [_finding()])
        # the next two days have no data (no verdict): the issue stays open
        r = growatt_issues.sync(db, DAY + timedelta(days=2), [])
        assert r["closed"] == 0
        # today's partial run fired, the next run of the same day did not: the day is withdrawn
        d = DAY + timedelta(days=5)
        growatt_issues.sync(db, d, [_finding(sno=4, day=d)], close=False)
        r = growatt_issues.sync(db, d, [], close=False)
        assert r["withdrawn"] == 1
        assert [i.string_no for i in db.scalars(select(growatt_issues.GrowattIssue))] == [3]


def test_engineer_closed_issue_is_not_reopened_the_same_day(factory):
    with factory() as db:
        growatt_issues.sync(db, DAY, [_finding()])
        i = db.scalars(select(growatt_issues.GrowattIssue)).one()
        growatt_issues.apply_action(db, i, "dismiss", "engineer", note="string cut on purpose")
        assert i.status == "dismissed" and i.feedback == "false_alarm" and i.closed_by == "engineer"
        assert growatt_issues.sync(db, DAY, [_finding()])["opened"] == 0
        later = DAY + timedelta(days=30)  # dismissed long before: a new finding opens a new issue
        i.closed_at = datetime(2026, 11, 10, 3, 0, tzinfo=growatt_issues.timezone.utc)
        db.commit()
        assert growatt_issues.sync(db, later, [_finding(day=later)])["opened"] == 1
        with pytest.raises(ValueError):
            growatt_issues.apply_action(db, i, "reopen", "admin")  # another one is open now


def test_string_issue_nests_under_its_inverter_issue(factory):
    with factory() as db:
        growatt_issues.sync(db, DAY, [_finding(), _finding(rule="R8", sno=None, tier="P1")])
        rows = {i.rule: i for i in db.scalars(select(growatt_issues.GrowattIssue))}
        assert rows["R2"].parent_id == rows["R8"].id and rows["R8"].parent_id is None


def test_rules_job_opens_issues(factory, monkeypatch):
    monkeypatch.setattr(jobs, "_today", lambda: DAY + timedelta(days=1))
    with factory() as db:
        _seed_day(db, current=lambda sn, s, ts, i: 0.0 if (sn, s) == (A, 3) and _between(ts, 10, 11) else i)
        status, detail = jobs.job_rules_yesterday(db)
        assert status == "ok" and detail["issues"]["opened"] == 1
        status, detail = jobs.job_rules_backfill(db)
        assert status == "ok" and detail["issues"]["opened"] == 0  # same issue, updated


def _api(tmp_path):
    from app.db.models import User, UserPlantAssignment

    engine = build_engine(f"sqlite:///{tmp_path / 'issues.db'}")
    Base.metadata.create_all(bind=engine)
    f = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)
    with f() as db:
        ensure_seeded(db)
        for pid in (9001, 9002):
            db.add(GrowattPlant(plant_id=pid, name=f"Plant {pid}"))
        eng = db.scalars(select(User).where(User.username == "engineer")).one()
        db.add(UserPlantAssignment(user_id=eng.id, plant_id=9001))
        db.commit()
    app = create_app()

    def override():
        with f() as db:
            yield db

    app.dependency_overrides[get_db] = override
    client = TestClient(app)

    def hdr(user, pw):
        tok = client.post("/auth/login", json={"username": user, "password": pw}).json()["access_token"]
        return {"Authorization": f"Bearer {tok}"}

    return f, client, hdr("admin", "admin123"), hdr("engineer", "engineer123")


def test_issues_api_scoping_shadow_and_actions(tmp_path):
    f, client, admin, eng = _api(tmp_path)
    with f() as db:
        growatt_issues.sync(db, DAY, [
            _finding(plant=9001, shadow=False, thb=50.0),
            _finding(plant=9001, sno=4, thb=5.0),  # shadow
            _finding(plant=9002, shadow=False),
        ])
    body = client.get("/growatt/issues", headers=eng).json()
    assert [(d["plant_id"], d["string_no"]) for d in body["issues"]] == [(9001, 3)]
    assert body["summary"]["active"] == 1 and body["summary"]["thb_per_day_est"] == 50
    assert client.get("/growatt/issues?shadow=true", headers=eng).json()["total"] == 1  # forced live
    assert client.get("/growatt/issues?plant_id=9002", headers=eng).status_code == 404
    assert client.get("/growatt/issues", headers=admin).json()["total"] == 2
    assert client.get("/growatt/issues?shadow=true", headers=admin).json()["total"] == 1
    assert client.get("/growatt/issues?include_shadow=true", headers=admin).json()["total"] == 3

    ids = {(d["plant_id"], d["string_no"], d["shadow"]): d["id"] for d in client.get("/growatt/issues?include_shadow=true", headers=admin).json()["issues"]}
    mine, shadow, other = ids[(9001, 3, False)], ids[(9001, 4, True)], ids[(9002, 3, False)]
    r = client.patch(f"/growatt/issues/{mine}", json={"action": "acknowledge", "note": "crew Monday"}, headers=eng)
    assert r.status_code == 200 and r.json()["status"] == "acknowledged" and r.json()["ack_by"] == "engineer"
    assert client.patch(f"/growatt/issues/{other}", json={"action": "acknowledge"}, headers=eng).status_code == 404
    assert client.patch(f"/growatt/issues/{shadow}", json={"action": "acknowledge"}, headers=eng).status_code == 404
    r = client.patch(f"/growatt/issues/{mine}", json={"action": "resolve", "feedback": "confirmed"}, headers=eng)
    assert r.json()["status"] == "resolved" and r.json()["feedback"] == "confirmed"
    assert client.patch(f"/growatt/issues/{mine}", json={"action": "resolve"}, headers=eng).status_code == 409
    assert client.get("/growatt/issues?status=closed", headers=eng).json()["total"] == 1


def test_rule_settings_routes_are_gone_and_tariff_routes_work(tmp_path):
    f, client, admin, eng = _api(tmp_path)
    assert client.get("/growatt/rules", headers=admin).status_code in (404, 405)
    assert client.put("/growatt/rules", json={"r2_open_min": 30}, headers=admin).status_code in (404, 405)

    t = client.get("/growatt/tariff", headers=eng).json()
    assert t["source"] == "default" and t["on_peak_thb"] == tariff.DEFAULT_TARIFF["on_peak_thb"]
    new = {**{k: t[k] for k in tariff.DEFAULT_TARIFF}, "ft_thb": 0.2, "plant_rates": {"9001": {"thb_per_kwh": 3.5, "basis": "PPA"}}}
    assert client.put("/growatt/tariff", json=new, headers=eng).status_code == 403
    r = client.put("/growatt/tariff", json=new, headers=admin)
    assert r.status_code == 200 and r.json()["source"] == "saved" and r.json()["ft_thb"] == 0.2
    assert r.json()["plant_rates"]["9001"]["thb_per_kwh"] == 3.5
    assert client.put("/growatt/tariff", json={**new, "holidays": ["not a day"]}, headers=admin).status_code == 422
    with f() as db:
        assert tariff.pricer(db).thb(9001, 2.0, 2.0) == pytest.approx(7.0)


def test_day_rates_weight_tou_by_stored_power_and_scope_by_plant(tmp_path):
    """Fleet revenue prices each plant's yield at its own rate: flat PPA, else TOU weighted by
    the on-peak share of its stored power that day; no power yet = off-peak (never inflated)."""
    from app.db.models import AppSetting

    f, client, admin, eng = _api(tmp_path)
    t = tariff.DEFAULT_TARIFF
    on, off = t["on_peak_thb"] + t["ft_thb"], t["off_peak_thb"] + t["ft_thb"]
    with f() as db:
        db.add(GrowattInverter(device_sn="A1", plant_id=9001))
        db.flush()
        # DAY is a Tuesday: 1 kW 08:00–08:55 (off-peak), 3 kW 09:00–09:55 (on-peak) -> 75 % on-peak
        for m in range(0, 60, 5):
            db.add(GrowattInverterReading(device_sn="A1", timestamp=datetime(2026, 11, 10, 8, m), pac_w=1000.0))
            db.add(GrowattInverterReading(device_sn="A1", timestamp=datetime(2026, 11, 10, 9, m), pac_w=3000.0))
        db.commit()
        r = tariff.day_rates(db, DAY)
        assert r[9001]["on_peak_share"] == 0.75 and r[9001]["basis"] == "tou"
        assert r[9001]["thb_per_kwh"] == pytest.approx(0.75 * on + 0.25 * off, abs=1e-3)
        assert r[9002] == {"thb_per_kwh": round(off, 4), "on_peak_share": None, "basis": "off_peak_unknown_split"}
        # Saturday: everything off-peak
        assert tariff.day_rates(db, date(2026, 11, 14))[9001]["thb_per_kwh"] == pytest.approx(off, abs=1e-3)
        db.add(AppSetting(key="tariff", value={**t, "plant_rates": {"9002": {"thb_per_kwh": 3.5, "basis": "PPA"}}}))
        db.commit()
        assert tariff.day_rates(db, DAY)[9002] == {"thb_per_kwh": 3.5, "on_peak_share": None, "basis": "plant_rate"}

    body = client.get(f"/growatt/tariff/rates?day={DAY.isoformat()}", headers=eng).json()
    assert set(body["plants"]) == {"9001"} and body["meta"]["estimated"] is True
    assert set(client.get(f"/growatt/tariff/rates?day={DAY.isoformat()}", headers=admin).json()["plants"]) == {"9001", "9002"}
