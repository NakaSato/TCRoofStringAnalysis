"""The Issues queue: decision-rule findings stored as issues (docs/plans/decision-rules.md §4.2).

`sync(db, day, findings)` turns one day's findings (`growatt_rules.evaluate`) into issues:

- One active issue (status open / acknowledged) per (plant, inverter, string, rule). A finding
  with no active issue opens one; a finding with one updates it. Each day it fired is kept in
  `daily` ({day: {kwh, thb}}, estimated), so re-running a day replaces that day's figures and
  never counts it twice.
- A day re-run without the finding takes that day out of `daily` again (today's partial run
  can fire on data that the full day no longer supports). An issue left with no day, untouched
  by anyone, is deleted.
- `close=True` (past days only, never today's partial day): an active issue whose rule had a
  verdict and did not fire on the last 2 days is closed (`resolved`, `close_reason = auto`).
- An issue an engineer resolved or dismissed is not reopened by findings of that day or
  earlier; a later finding opens a new issue.

Baht and kWh are estimates; `shadow` issues are for Rule review (admins) only.
"""

from __future__ import annotations

import statistics
from collections import defaultdict
from datetime import date, datetime, timedelta, timezone
from typing import Any, Dict, Iterable, List, Optional, Sequence, Set, Tuple

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db.models import (
    GrowattInverter,
    GrowattInverterDaily,
    GrowattIssue,
    GrowattPlant,
    GrowattPlantDaily,
    GrowattStringDaily,
)
from app.services import growatt_rules

ACTIVE = ("open", "acknowledged")
CLOSED = ("resolved", "dismissed")
STRING_RULES = {"R1", "R2", "R4", "R5", "R6"}
INVERTER_PARENT_RULES = ("R8", "R7")  # string issues nest under these inverter issues
AUTO_CLOSE_CLEAN_DAYS = 2
LOCAL = timezone(timedelta(hours=7))

Key = Tuple[int, Optional[str], Optional[int], str]


def _key(plant_id: int, sn: Optional[str], sno: Optional[int], rule: str) -> Key:
    return (int(plant_id), sn, None if sno is None else int(sno), rule)


def _ikey(i: GrowattIssue) -> Key:
    return _key(i.plant_id, i.device_sn, i.string_no, i.rule)


def _local_day(ts: Optional[datetime]) -> Optional[date]:
    if ts is None:
        return None
    if ts.tzinfo is None:
        ts = ts.replace(tzinfo=timezone.utc)
    return ts.astimezone(LOCAL).date()


def _refresh_totals(i: GrowattIssue) -> None:
    daily: Dict[str, Dict[str, Any]] = dict(i.daily or {})
    days = sorted(daily)
    i.days_seen = len(days)
    if not days:
        return
    i.opened_day = min(i.opened_day, date.fromisoformat(days[0])) if i.opened_day else date.fromisoformat(days[0])
    i.last_seen_day = date.fromisoformat(days[-1])
    last3 = [daily[d] for d in days[-3:]]
    kwh = [x["kwh"] for x in last3 if x.get("kwh") is not None]
    thb = [x["thb"] for x in last3 if x.get("thb") is not None]
    i.lost_kwh_est = round(statistics.mean(kwh), 2) if kwh else None
    i.thb_per_day_est = round(statistics.mean(thb), 0) if thb else None
    all_kwh = [x["kwh"] for x in daily.values() if x.get("kwh") is not None]
    all_thb = [x["thb"] for x in daily.values() if x.get("thb") is not None]
    i.lost_kwh_total_est = round(sum(all_kwh), 2) if all_kwh else None
    i.thb_total_est = round(sum(all_thb), 0) if all_thb else None


def _untouched(i: GrowattIssue) -> bool:
    return i.status == "open" and not i.ack_by and not i.note and not i.feedback


def _verdicts(
    db: Session, days: Sequence[date], plant_ids: Optional[Set[int]]
) -> Tuple[Set[tuple], Set[tuple], Set[tuple], Set[tuple], Set[tuple]]:
    """Which entities had enough data on each day for a rule to judge them:
    (string keys with a gated verdict, inverter keys with records, inverter keys with a yield comparison,
    plant keys with an EPI verdict on a day its sensor passed R16, plant keys with an R16 verdict)."""
    cfg = growatt_rules.rule_settings(db)
    cfg_gap = float(cfg["r7_max_gap_pct"])
    SD, ID, PD = GrowattStringDaily, GrowattInverterDaily, GrowattPlantDaily
    q = select(SD.plant_id, SD.device_sn, SD.string_no, SD.day).where(SD.day.in_(list(days)), SD.ratio_median.is_not(None))
    q2 = select(ID).where(ID.day.in_(list(days)))
    q3 = select(PD).where(PD.day.in_(list(days)))
    if plant_ids is not None:
        q = q.where(SD.plant_id.in_(plant_ids))
        q2 = q2.where(ID.plant_id.in_(plant_ids))
        q3 = q3.where(PD.plant_id.in_(plant_ids))
    strings = {(int(p), sn, int(no), d) for p, sn, no, d in db.execute(q)}
    inv: Set[tuple] = set()
    yf: Set[tuple] = set()
    for r in db.scalars(q2):
        if r.daylight_min and r.no_data_min < r.daylight_min:
            inv.add((r.plant_id, r.device_sn, r.day))
            gap = (r.fault_min + r.off_min + r.standby_min + r.no_data_min) / r.daylight_min * 100
            if r.yf_vs_median_pct is not None and gap <= cfg_gap:
                yf.add((r.plant_id, r.device_sn, r.day))
    plants_epi: Set[tuple] = set()
    plants_sensor: Set[tuple] = set()
    for r in db.scalars(q3):
        v = growatt_rules.sensor_verdict(r, cfg)
        if v is not None:
            plants_sensor.add((r.plant_id, r.day))
        if r.epi is not None and (v is None or v["ok"]):
            plants_epi.add((r.plant_id, r.day))
    return strings, inv, yf, plants_epi, plants_sensor


def _had_verdict(i: GrowattIssue, d: date, v: Tuple[Set[tuple], Set[tuple], Set[tuple], Set[tuple], Set[tuple]]) -> bool:
    strings, inv, yf, plants_epi, plants_sensor = v
    if i.rule in STRING_RULES:
        return (i.plant_id, i.device_sn, i.string_no, d) in strings
    if i.rule == "R7":
        return (i.plant_id, i.device_sn, d) in yf
    if i.rule in ("R8", "R11", "R17", "R18"):
        return (i.plant_id, i.device_sn, d) in inv
    if i.rule == "R10":
        return (i.plant_id, d) in plants_epi
    if i.rule == "R16":
        return (i.plant_id, d) in plants_sensor
    return True  # R3 / R9: the alarm log is the data


def sync(
    db: Session,
    day: date,
    findings: Sequence[Dict[str, Any]],
    plant_ids: Optional[Iterable[int]] = None,
    close: bool = True,
) -> Dict[str, int]:
    """Apply one day's findings to the issues table (see the module doc). Commits."""
    scope = None if plant_ids is None else {int(p) for p in plant_ids}
    out = {"opened": 0, "updated": 0, "closed": 0, "withdrawn": 0}
    dkey = day.isoformat()

    q = select(GrowattIssue).where(GrowattIssue.status.in_(ACTIVE))
    if scope is not None:
        q = q.where(GrowattIssue.plant_id.in_(scope))
    active: Dict[Key, GrowattIssue] = {_ikey(i): i for i in db.scalars(q)}

    # engineer-closed on / after this day: not reopened by findings of this day
    since = datetime.combine(day, datetime.min.time(), tzinfo=LOCAL).astimezone(timezone.utc)
    q = select(GrowattIssue).where(
        GrowattIssue.close_reason.in_(CLOSED), GrowattIssue.closed_at.is_not(None), GrowattIssue.closed_at >= since
    )
    if scope is not None:
        q = q.where(GrowattIssue.plant_id.in_(scope))
    snoozed = {_ikey(i) for i in db.scalars(q) if (_local_day(i.closed_at) or day) >= day}

    fired: Set[Key] = set()
    for f in findings:
        k = _key(f["plant_id"], f["device_sn"], f["string_no"], f["rule"])
        if scope is not None and k[0] not in scope:
            continue
        fired.add(k)
        i = active.get(k)
        if i is None:
            if k in snoozed:
                continue
            i = GrowattIssue(
                plant_id=k[0], device_sn=k[1], string_no=k[2], rule=k[3], tier=f["tier"], safety=bool(f.get("safety")),
                opened_day=day, last_seen_day=day, days_seen=0, status="open", shadow=bool(f.get("shadow", True)),
                daily={},
            )
            db.add(i)
            active[k] = i
            out["opened"] += 1
        else:
            out["updated"] += 1
        latest = i.last_seen_day is None or day >= i.last_seen_day
        i.daily = {**(i.daily or {}), dkey: {"kwh": f.get("lost_kwh_est"), "thb": f.get("thb_est")}}
        if latest:
            i.tier = f["tier"]
            i.safety = bool(f.get("safety"))
            i.evidence = {**(f.get("evidence") or {}), "day": dkey}
        _refresh_totals(i)

    # this day re-run without the finding: take the day out again
    for k, i in list(active.items()):
        if k in fired or dkey not in (i.daily or {}):
            continue
        daily = dict(i.daily or {})
        daily.pop(dkey, None)
        i.daily = daily
        if not daily and _untouched(i):
            db.delete(i)
            del active[k]
            out["withdrawn"] += 1
            continue
        _refresh_totals(i)

    if close:
        clean_days = [day - timedelta(days=n) for n in range(AUTO_CLOSE_CLEAN_DAYS)]
        v = _verdicts(db, clean_days, scope)
        now = datetime.now(timezone.utc)
        for k, i in active.items():
            if k in fired or i.last_seen_day > clean_days[-1] - timedelta(days=1):
                continue
            if all(_had_verdict(i, d, v) for d in clean_days):
                i.status = "resolved"
                i.close_reason = "auto"
                i.closed_at = now
                i.closed_by = None
                out["closed"] += 1

    db.flush()
    _link_parents(db, scope)
    db.commit()
    return out


def _link_parents(db: Session, scope: Optional[Set[int]]) -> None:
    q = select(GrowattIssue).where(GrowattIssue.status.in_(ACTIVE))
    if scope is not None:
        q = q.where(GrowattIssue.plant_id.in_(scope))
    rows = list(db.scalars(q))
    parents: Dict[Tuple[int, str], int] = {}
    for i in rows:
        if i.string_no is None and i.device_sn and i.rule in INVERTER_PARENT_RULES:
            k = (i.plant_id, i.device_sn)
            if k not in parents or i.rule == INVERTER_PARENT_RULES[0]:
                parents[k] = i.id
    for i in rows:
        if i.string_no is not None:
            pid = parents.get((i.plant_id, i.device_sn or ""))
            if i.parent_id != pid:
                i.parent_id = pid


# --------------------------------------------------------------------------- reading


def serialize(i: GrowattIssue, plants: Dict[int, str], inverters: Dict[str, str]) -> Dict[str, Any]:
    return {
        "id": i.id,
        "plant_id": i.plant_id,
        "plant_name": plants.get(i.plant_id),
        "device_sn": i.device_sn,
        "inverter_name": inverters.get(i.device_sn or ""),
        "string_no": i.string_no,
        "rule": i.rule,
        "name": growatt_rules.RULE_NAMES.get(i.rule, i.rule),
        "tier": i.tier,
        "safety": i.safety,
        "parent_id": i.parent_id,
        "opened_day": i.opened_day.isoformat(),
        "last_seen_day": i.last_seen_day.isoformat(),
        "days_seen": i.days_seen,
        "lost_kwh_est": i.lost_kwh_est,
        "thb_per_day_est": i.thb_per_day_est,
        "lost_kwh_total_est": i.lost_kwh_total_est,
        "thb_total_est": i.thb_total_est,
        "evidence": i.evidence or {},
        "daily": i.daily or {},
        "status": i.status,
        "ack_by": i.ack_by,
        "ack_at": i.ack_at.isoformat() if i.ack_at else None,
        "note": i.note,
        "feedback": i.feedback,
        "shadow": i.shadow,
        "closed_at": i.closed_at.isoformat() if i.closed_at else None,
        "closed_by": i.closed_by,
        "close_reason": i.close_reason,
    }


def _names(db: Session, rows: Sequence[GrowattIssue]) -> Tuple[Dict[int, str], Dict[str, str]]:
    pids = {i.plant_id for i in rows}
    sns = {i.device_sn for i in rows if i.device_sn}
    plants = dict(db.execute(select(GrowattPlant.plant_id, GrowattPlant.name).where(GrowattPlant.plant_id.in_(pids))).all()) if pids else {}
    inverters: Dict[str, str] = {}
    if sns:
        for sn, alias in db.execute(select(GrowattInverter.device_sn, GrowattInverter.alias).where(GrowattInverter.device_sn.in_(sns))):
            inverters[sn] = alias or sn
    return plants, inverters


STATUS_FILTERS = {
    "active": ACTIVE,
    "open": ("open",),
    "acknowledged": ("acknowledged",),
    "resolved": ("resolved",),
    "dismissed": ("dismissed",),
    "closed": CLOSED,
    "all": ACTIVE + CLOSED,
}


def sort_key(d: Dict[str, Any]) -> tuple:
    return (
        not d["safety"],
        growatt_rules.TIER_ORDER.get(d["tier"], 9),
        -(d["thb_per_day_est"] or 0),
        -(d["lost_kwh_est"] or 0),
        d["id"],
    )


def list_issues(
    db: Session,
    plant_ids: Optional[Set[int]],
    *,
    plant_id: Optional[int] = None,
    status: str = "active",
    tier: Optional[str] = None,
    rule: Optional[str] = None,
    shadow: Optional[bool] = False,
    limit: int = 1000,
) -> Dict[str, Any]:
    """Issues the user may see, safety first, then tier and THB/day; plus counts of the active ones."""
    G = GrowattIssue
    q = select(G).where(G.status.in_(STATUS_FILTERS.get(status, ACTIVE)))
    if plant_ids is not None:
        q = q.where(G.plant_id.in_(plant_ids))
    if plant_id is not None:
        q = q.where(G.plant_id == plant_id)
    if shadow is not None:
        q = q.where(G.shadow.is_(shadow))
    if rule:
        q = q.where(G.rule == rule)
    rows = list(db.scalars(q))
    plants, inverters = _names(db, rows)
    items = sorted((serialize(i, plants, inverters) for i in rows), key=sort_key)
    summary = summarize(items)
    if tier:
        items = [d for d in items if d["tier"] == tier]
    return {"summary": summary, "total": len(items), "issues": items[:limit]}


def summarize(items: Sequence[Dict[str, Any]]) -> Dict[str, Any]:
    by_tier: Dict[str, int] = defaultdict(int)
    by_rule: Dict[str, int] = defaultdict(int)
    thb = 0.0
    priced = 0
    for d in items:
        if d["status"] not in ACTIVE:
            continue
        by_tier[d["tier"]] += 1
        by_rule[d["rule"]] += 1
        if d["thb_per_day_est"] is not None:
            thb += d["thb_per_day_est"]
            priced += 1
    return {
        "active": sum(by_tier.values()),
        "safety": sum(1 for d in items if d["status"] in ACTIVE and d["safety"]),
        "by_tier": dict(by_tier),
        "by_rule": dict(by_rule),
        "thb_per_day_est": round(thb, 0) if priced else None,
    }


ACTIONS = ("acknowledge", "resolve", "dismiss", "reopen", "note")


def apply_action(
    db: Session, i: GrowattIssue, action: str, username: str, note: Optional[str] = None, feedback: Optional[str] = None
) -> GrowattIssue:
    """acknowledge / resolve / dismiss / reopen an issue, or only change its note or feedback."""
    if action not in ACTIONS:
        raise ValueError(f"Unknown action {action!r}")
    if feedback not in (None, "confirmed", "false_alarm"):
        raise ValueError("feedback must be confirmed or false_alarm")
    now = datetime.now(timezone.utc)
    if action in ("acknowledge", "resolve", "dismiss") and i.status not in ACTIVE:
        raise ValueError(f"Issue is {i.status}")
    if action == "acknowledge":
        i.status = "acknowledged"
        i.ack_by, i.ack_at = username, now
    elif action in ("resolve", "dismiss"):
        i.status = "resolved" if action == "resolve" else "dismissed"
        i.close_reason = i.status
        i.closed_at, i.closed_by = now, username
        i.feedback = feedback or ("confirmed" if action == "resolve" else "false_alarm")
    elif action == "reopen":
        if i.status in ACTIVE:
            raise ValueError("Issue is already open")
        clash = db.scalar(
            select(GrowattIssue.id).where(
                GrowattIssue.status.in_(ACTIVE),
                GrowattIssue.plant_id == i.plant_id,
                GrowattIssue.device_sn == i.device_sn if i.device_sn is not None else GrowattIssue.device_sn.is_(None),
                GrowattIssue.string_no == i.string_no if i.string_no is not None else GrowattIssue.string_no.is_(None),
                GrowattIssue.rule == i.rule,
            )
        )
        if clash:
            raise ValueError(f"Issue #{clash} is already open for this {('string' if i.string_no is not None else 'inverter')} and rule")
        i.status = "open"
        i.close_reason = i.closed_at = i.closed_by = None
        i.feedback = None
    if feedback is not None and action not in ("resolve", "dismiss"):
        i.feedback = feedback
    if note is not None:
        i.note = note.strip() or None
    db.commit()
    return i


def review(db: Session, since: date) -> List[Dict[str, Any]]:
    """Rule review: per rule, the issues opened since `since` (shadow and live), how they ended
    and the estimated baht they found, with the rule's enabled / shadow flags."""
    cfg = growatt_rules.rule_settings(db)
    stats: Dict[str, Dict[str, Any]] = {
        r: {
            "rule": r, "name": n, **cfg["rules"][r],
            "issues": 0, "active": 0, "auto_closed": 0, "resolved": 0, "dismissed": 0,
            "confirmed": 0, "false_alarm": 0, "thb_total_est": 0.0, "plants": set(),
        }
        for r, n in growatt_rules.RULE_NAMES.items()
    }
    for i in db.scalars(select(GrowattIssue).where(GrowattIssue.opened_day >= since)):
        s = stats.get(i.rule)
        if s is None:
            continue
        s["issues"] += 1
        s["plants"].add(i.plant_id)
        if i.status in ACTIVE:
            s["active"] += 1
        elif i.close_reason == "auto":
            s["auto_closed"] += 1
        elif i.close_reason in CLOSED:
            s[i.close_reason] += 1
        if i.feedback in ("confirmed", "false_alarm"):
            s[i.feedback] += 1
        s["thb_total_est"] += i.thb_total_est or 0.0
    out = []
    for s in stats.values():
        judged = s["confirmed"] + s["false_alarm"]
        s["plants"] = len(s["plants"])
        s["thb_total_est"] = round(s["thb_total_est"], 0)
        s["precision_pct"] = round(s["confirmed"] / judged * 100, 1) if judged else None
        out.append(s)
    return out
