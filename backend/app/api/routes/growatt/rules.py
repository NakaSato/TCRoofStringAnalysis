"""Decision rules, the Issues queue and the daily rule / KPI rows (DB only)."""

from __future__ import annotations

from datetime import date, timedelta
from typing import Any, Dict, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.auth import allowed_plant_ids, get_current_user, require_admin, require_plant_read, require_write_access
from app.db.models import User
from app.db.session import get_db
from app.schemas.api_schemas import IssueAction
from app.services import epi_fit, growatt_rules, jobs
from app.api.routes.growatt._common import DAY_QUERY, audit

router = APIRouter()


# --------------------------------------------------------------------------- decision rules


@router.get("/rules/findings")
def rule_findings(
    day: Optional[date] = Query(None, description="plant-local day (default today)"),
    plant_id: Optional[int] = Query(None),
    db: Session = Depends(get_db),
    _user: User = Depends(require_admin),
) -> Dict[str, Any]:
    """Decision-rule findings for a day, from the stored daily tables (Phase 1: admin only,
    evaluated on request, not stored; docs/plans/decision-rules.md). Lost kWh is estimated."""

    d = day or jobs._today()
    findings = growatt_rules.evaluate(db, d, [plant_id] if plant_id is not None else None)
    return {
        "day": d.isoformat(),
        "summary": growatt_rules.summarize(findings),
        "findings": findings,
        "settings": growatt_rules.rule_settings(db),
        "meta": {"source": "db", "estimated": ["lost_kwh_est", "thb_est"], "stored": False},
    }


@router.get("/rules")
def get_rules(
    since_days: int = Query(90, ge=1, le=730, description="Rule review covers issues opened in the last N days"),
    db: Session = Depends(get_db),
    _user: User = Depends(require_admin),
) -> Dict[str, Any]:
    """Rule settings (thresholds, enabled, shadow) and Rule review: per rule, how many issues it
    opened, how they ended (auto-closed / resolved / dismissed, confirmed vs false alarm) and the
    estimated baht they found. Admin only."""
    from app.services import growatt_issues, growatt_rules

    since = jobs._today() - timedelta(days=since_days)
    return {
        "settings": growatt_rules.rule_settings(db),
        "defaults": {**growatt_rules.DEFAULT_RULES, "rules": {r: dict(growatt_rules.DEFAULT_RULE_STATE) for r in growatt_rules.RULE_NAMES}},
        "names": growatt_rules.RULE_NAMES,
        "review": growatt_issues.review(db, since),
        "since": since.isoformat(),
        "meta": {"source": "db", "estimated": ["thb_total_est"]},
    }


@router.put("/rules")
def put_rules(
    payload: Dict[str, Any],
    db: Session = Depends(get_db),
    user: User = Depends(require_admin),
) -> Dict[str, Any]:
    """Change rule settings (any subset of the keys of `GET /growatt/rules` `settings`). Each
    changed value is logged to System → Logs with its old and new value. Applies from the next
    `rules_*` run. Admin only."""

    try:
        old, new = growatt_rules.put_rule_settings(db, payload, user.username or user.email)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    who = user.username or user.email
    for k in new:
        if k == "rules":
            for r, st in new["rules"].items():
                if st != old["rules"].get(r):
                    audit.info("%s changed rule %s: %s -> %s", who, r, old["rules"].get(r), st)
        elif new[k] != old.get(k):
            audit.info("%s changed rule setting %s: %s -> %s", who, k, old.get(k), new[k])
    return {"settings": new}


@router.get("/issues")
def list_issues(
    plant_id: Optional[int] = Query(None),
    status: str = Query("active", pattern="^(active|open|acknowledged|resolved|dismissed|closed|all)$"),
    tier: Optional[str] = Query(None, pattern="^(P1|P2|P3|P4|Info)$"),
    rule: Optional[str] = Query(None, max_length=8),
    shadow: Optional[bool] = Query(False, description="admin only: true = shadow issues (Rule review); omit for live"),
    include_shadow: bool = Query(False, description="admin only: live and shadow issues together"),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> Dict[str, Any]:
    """The Issues queue: decision-rule issues of the plants the user may see, safety first, then
    tier and estimated THB/day. Engineers never see shadow issues (rules still being calibrated).
    kWh and baht are estimates."""
    from app.services import growatt_issues

    allowed = allowed_plant_ids(db, user)
    if allowed is not None:
        shadow, include_shadow = False, False
        if plant_id is not None and plant_id not in allowed:
            raise HTTPException(status_code=404, detail=f"Plant {plant_id} not found")
    out = growatt_issues.list_issues(
        db, allowed, plant_id=plant_id, status=status, tier=tier, rule=rule, shadow=None if include_shadow else shadow
    )
    return {**out, "meta": {"source": "db", "estimated": ["lost_kwh_est", "thb_per_day_est", "lost_kwh_total_est", "thb_total_est"]}}


@router.get("/center")
def om_center(
    start: Optional[date] = Query(None),
    end: Optional[date] = Query(None),
    include_shadow: bool = Query(False, description="admin only: also count issues of rules still in shadow mode"),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> Dict[str, Any]:
    """O&M Dashboard (docs/plans/om-center-dashboard.md): loss by cause, the issues to fix first and
    one row per plant over `start` … `end` (default: the month to date), for the plants the user
    may see. DB only. Lost kWh and baht are estimates with each kWh counted once; costs are entered."""
    from app.services import om_center

    try:
        s, e = om_center.window(start, end)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    allowed = allowed_plant_ids(db, user)
    return om_center.overview(db, allowed, s, e, include_shadow=include_shadow and allowed is None)


def _issue_for(db: Session, user: User, issue_id: int) -> Any:
    from app.db.models import GrowattIssue

    i = db.get(GrowattIssue, issue_id)
    allowed = allowed_plant_ids(db, user)
    if i is None or (allowed is not None and (i.plant_id not in allowed or i.shadow)):
        raise HTTPException(status_code=404, detail=f"Issue {issue_id} not found")
    return i


@router.get("/issues/{issue_id}")
def get_issue(issue_id: int, db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> Dict[str, Any]:
    from app.services import growatt_issues

    i = _issue_for(db, user, issue_id)
    plants, inverters = growatt_issues._names(db, [i])
    return growatt_issues.serialize(i, plants, inverters)


@router.patch("/issues/{issue_id}")
def patch_issue(
    issue_id: int,
    payload: IssueAction,
    db: Session = Depends(get_db),
    user: User = Depends(require_write_access),
) -> Dict[str, Any]:
    """Acknowledge, resolve or dismiss an issue (with a note and feedback: confirmed / false
    alarm, which Rule review counts), reopen a closed one, or only edit the note. Engineers act
    on their assigned plants' live issues; admins on any."""
    from app.services import growatt_issues

    i = _issue_for(db, user, issue_id)
    who = user.username or user.email
    try:
        growatt_issues.apply_action(db, i, payload.action, who, payload.note, payload.feedback)
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    audit.info("%s %s issue %s (%s %s)", who, payload.action, i.id, i.rule, i.device_sn or i.plant_id)
    plants, inverters = growatt_issues._names(db, [i])
    return growatt_issues.serialize(i, plants, inverters)


@router.get("/plants/{plant_id}/rules/daily")
def plant_rule_daily(
    plant_id: int,
    sn: str = Query(..., max_length=64),
    string_no: Optional[int] = Query(None, ge=1, le=64),
    days: int = Query(30, ge=1, le=365),
    day: Optional[date] = DAY_QUERY,
    db: Session = Depends(get_db),
    _user: User = Depends(require_plant_read),
) -> Dict[str, Any]:
    """The daily rows behind the rules for one inverter (or one of its strings): the last `days`
    days up to `day`. Ratios are vs the inverter's other strings in gated slots (null = no
    verdict that day); lost kWh are estimates."""
    from app.db.models import GrowattInverterDaily as ID, GrowattStringDaily as SD

    end = day or jobs._today()
    start = end - timedelta(days=days - 1)
    if string_no is not None:
        rows = db.scalars(
            select(SD).where(SD.plant_id == plant_id, SD.device_sn == sn, SD.string_no == string_no, SD.day >= start, SD.day <= end).order_by(SD.day)
        )
        cols = [
            "gated_slots", "ratio_median", "low_min", "severe_min", "open_min",
            "v_ratio_median", "voltage_sensing", "energy_kwh", "lost_kwh_est",
        ]
    else:
        rows = db.scalars(select(ID).where(ID.plant_id == plant_id, ID.device_sn == sn, ID.day >= start, ID.day <= end).order_by(ID.day))
        cols = [
            "daylight_min", "producing_min", "fault_min", "off_min", "standby_min", "limited_min", "no_data_min",
            "energy_kwh", "dc_energy_kwh", "kwp", "ya_kwh_kwp", "yf_kwh_kwp", "ya_minus_yf",
            "yf_vs_median_pct", "plant_kwp_share_pct",
            "lost_fault_kwh_est", "lost_off_kwh_est", "lost_standby_kwh_est", "lost_no_data_kwh_est",
        ]
    data = [{"day": r.day.isoformat(), **{c: getattr(r, c) for c in cols}} for r in rows]
    return {"plant_id": plant_id, "device_sn": sn, "string_no": string_no, "start": start.isoformat(), "end": end.isoformat(),
            "days": data, "meta": {"source": "db", "estimated": [c for c in cols if c.endswith("_est")]}}


@router.get("/plants/{plant_id}/kpi-daily")
def plant_kpi_daily(
    plant_id: int,
    days: int = Query(30, ge=1, le=365),
    day: Optional[date] = DAY_QUERY,
    db: Session = Depends(get_db),
    _user: User = Depends(require_plant_read),
) -> Dict[str, Any]:
    """Plant-level daily KPIs (PR, temperature-corrected PR', EPI, Ya, Yf, Ya - Yf, filter counts)
    from `growatt_plant_daily` over the last `days` days up to `day`."""
    from app.db.models import GrowattPlantDaily as PD

    end = day or jobs._today()
    start = end - timedelta(days=days - 1)
    rows = db.scalars(
        select(PD).where(PD.plant_id == plant_id, PD.day >= start, PD.day <= end).order_by(PD.day)
    )
    cols = [
        "capacity_kwp", "energy_kwh", "dc_energy_kwh", "modelled_energy_kwh", "yr_h",
        "ya_kwh_kwp", "yf_kwh_kwp", "ya_minus_yf", "pr_pct", "pr_temp_corrected_pct", "epi", "system_factor",
        "irradiance_weighted_tmod_c", "filtered_slots", "stale_masked_slots",
        "clipped_masked_slots", "curtailed_masked_slots",
        "sensor_stale_slots", "sensor_high_slots", "sensor_midday_wm2", "sensor_neighbour_ratio",
        "sensor_neighbours", "cloud_midday_pct",
    ]
    cfg = growatt_rules.rule_settings(db)
    data = []
    for r in rows:
        v = growatt_rules.sensor_verdict(r, cfg)
        data.append({
            "day": r.day.isoformat(), **{c: getattr(r, c) for c in cols},
            # R16: false = PR, PR' and EPI of the day rest on a suspect sensor; null = not judged
            "sensor_ok": None if v is None else v["ok"], "sensor_flags": [] if v is None else v["flags"],
        })
    return {
        "plant_id": plant_id,
        "start": start.isoformat(),
        "end": end.isoformat(),
        "days": data,
        # the EPI model's system factor now in use (fitted per plant or the default) and its fit
        "epi_factor": epi_fit.factor_info(db, plant_id),
        "meta": {"source": "db", "modelled": ["modelled_energy_kwh", "epi", "system_factor", "cloud_midday_pct"]},
    }
