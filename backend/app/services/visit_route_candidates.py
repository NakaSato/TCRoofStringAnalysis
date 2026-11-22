"""Site visit route, phase 2: stop candidates for a day (docs/plans/site-visit-route.md §2, §5).

`GET /growatt/routes/candidates?day=&team_id=&user_id=`: the plants worth visiting on `day`, each
with its reasons. DB only (no Growatt / Google / Geoapify calls) and scoped to the plants the user
may see. Only plants with at least one reason are listed; the UI picks other plants from the fleet.

Every reason comes from the service that owns it, so this module never re-derives their rules:

- `task`: Calendar tasks (`om_calendar.list_tasks`, with its engineer masking) that cover `day`
  and are planned / in progress, plus those still open whose end day is before `day`. `team_id` /
  `user_id` narrow these the way the Calendar's own filters do, and apply to tasks only.
- `issue`: active live issues in `growatt_issues.sort_key` order (`growatt_issues.list_issues`,
  `shadow=False` for everyone). `Info` tier findings are informational and left out.
- `alarm`: open (no `end_time`) fault-level alarms of the stored log (`growatt_alarms.alarm_day`,
  level by `push.level_of`, the Active Alarm page's rule), of `day`, or of today for a future day.
- `claim`: open claims (`claims.list_claims`) whose `next_action_day` is on or before `day`.
- `cleaning_due` / `pm_due`: plants `om_plans.due` counts overdue work for (open tasks past their end
  day, as of today: the Calendar's `overdue`), with an open cleaning / PM task the Calendar flags
  overdue. `due` has no interval-based "cleaning due" rule, so nothing else is flagged.

THB per day is the issues' own estimate. `default_service_min` is a default time on site the UI
lets the user edit per stop; crew days are used only as entered (never assumed).
"""

from __future__ import annotations

from datetime import date, timedelta
from typing import Any, Dict, Iterable, List, Optional, Sequence, Set, Tuple

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db.models import GrowattInverter, GrowattPlant, OmTeam, User
from app.services import claims as claims_svc
from app.services import growatt_alarms, growatt_issues, om_plans, push
from app.services import om_calendar as cal
from app.services.growatt_common import GrowattNotFound
from app.services.visit_route import usable_location

KINDS = ("task", "issue", "alarm", "claim", "cleaning_due", "pm_due")
WORKDAY_MIN = 480  # one crew day on site
MAX_SERVICE_MIN = 600
PM_SERVICE_MIN = 60  # PM / inspection
TASK_SERVICE_MIN = 45  # any other task type
DEFAULT_SERVICE_MIN = 45  # no task, or a cleaning without crew days entered
CLEANING = "cleaning"
PM_TYPES = ("pm_inspection",)
SKIPPED_TIERS = ("Info",)
LABELS = {"thb_per_day": "estimated", "default_service_min": "default time on site; edit per stop"}
_BASIS_PREF = {"cleaning_crew_days": 2, "task_type": 1, "default": 0}  # a tie keeps the more specific basis


# --------------------------------------------------------------------------- pure parts


def service_time(reasons: Sequence[Dict[str, Any]], crew_days: Optional[float]) -> Tuple[float, str]:
    """(default minutes on site, basis): the longest that applies.

    Cleaning (a cleaning task or `cleaning_due`): entered crew days × `WORKDAY_MIN`, capped at
    `MAX_SERVICE_MIN` (basis `cleaning_crew_days`); without crew days `DEFAULT_SERVICE_MIN` (basis
    `default`). PM / inspection `PM_SERVICE_MIN`, any other task `TASK_SERVICE_MIN` (basis `task_type`).
    Nothing task-like: `DEFAULT_SERVICE_MIN` (`default`)."""
    options: List[Tuple[float, str]] = [(float(DEFAULT_SERVICE_MIN), "default")]
    for r in reasons:
        kind, tt = r["kind"], r.get("task_type")
        if kind == "cleaning_due" or (kind == "task" and tt == CLEANING):
            if crew_days is not None and crew_days > 0:
                options.append((float(min(crew_days * WORKDAY_MIN, MAX_SERVICE_MIN)), "cleaning_crew_days"))
        elif kind == "pm_due" or (kind == "task" and tt in PM_TYPES):
            options.append((float(PM_SERVICE_MIN), "task_type"))
        elif kind == "task":
            options.append((float(TASK_SERVICE_MIN), "task_type"))
    return max(options, key=lambda o: (o[0], _BASIS_PREF[o[1]]))


def bucket(reasons: Sequence[Dict[str, Any]]) -> int:
    """1 = a task on the day; 2 = a P1 issue or an open fault alarm; 3 = P2; 4 = a claim due;
    5 = overdue cleaning / PM; 6 = the rest."""
    kinds = {r["kind"] for r in reasons}
    tiers = {r.get("priority") for r in reasons if r["kind"] == "issue"}
    if any(r["kind"] == "task" and r.get("on_day") for r in reasons):
        return 1
    if "P1" in tiers or "alarm" in kinds:
        return 2
    if "P2" in tiers:
        return 3
    if "claim" in kinds:
        return 4
    if kinds & {"cleaning_due", "pm_due"}:
        return 5
    return 6


def thb_sum(reasons: Sequence[Dict[str, Any]]) -> float:
    return sum(r["thb_per_day"] for r in reasons if r.get("thb_per_day") is not None)


def rank(candidates: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Sorted most worth visiting first, each with `rank` (1 = first): by `bucket`, then summed
    THB/day (descending), then name, then plant id."""
    out = sorted(
        candidates,
        key=lambda c: (bucket(c["reasons"]), -thb_sum(c["reasons"]), (c.get("name") or "").casefold(), c["plant_id"]),
    )
    for n, c in enumerate(out, 1):
        c["rank"] = n
    return out


# --------------------------------------------------------------------------- reading the services


def _reason(kind: str, label: str, **kw: Any) -> Dict[str, Any]:
    return {
        "kind": kind,
        "label": label,
        "detail": kw.get("detail"),
        "priority": kw.get("priority"),
        "thb_per_day": kw.get("thb_per_day"),
        "task_id": kw.get("task_id"),
        "issue_id": kw.get("issue_id"),
        "claim_id": kw.get("claim_id"),
        "task_type": kw.get("task_type"),
        "since": kw.get("since"),
        **({"on_day": kw["on_day"]} if "on_day" in kw else {}),
    }


def _windows(since: date, until: date) -> Iterable[Tuple[date, date]]:
    step = timedelta(days=cal.MAX_RANGE_DAYS)
    s = since
    while s <= until:
        e = min(s + step, until)
        yield s, e
        s = e + timedelta(days=1)


def _open_tasks(
    db: Session,
    user: User,
    allowed: Optional[Set[int]],
    since: date,
    until: date,
    *,
    user_id: Optional[int] = None,
    team_id: Optional[int] = None,
    task_type: Optional[str] = None,
) -> List[Dict[str, Any]]:
    """Planned / in-progress tasks overlapping `since` … `until`, as the Calendar lists them for this
    user (`list_tasks`, in windows of its range limit; a status filter, so no Busy blocks)."""
    if until < since:
        return []
    seen: Dict[int, Dict[str, Any]] = {}
    for status in cal.ACTIVE:
        for s, e in _windows(since, until):
            out = cal.list_tasks(db, user, allowed, s, e, status=status, user_id=user_id, team_id=team_id, task_type=task_type)
            for t in out["tasks"]:
                if t["id"] is not None and not t.get("busy"):
                    seen[t["id"]] = t
    return sorted(seen.values(), key=lambda t: (t["start_day"], t["end_day"], t["id"]))


def _task_detail(t: Dict[str, Any], dated: bool) -> Optional[str]:
    parts = [t.get("title")]
    if dated or t["start_day"] != t["end_day"]:
        parts.append(t["start_day"] if t["start_day"] == t["end_day"] else f"{t['start_day']} → {t['end_day']}")
    if t.get("team"):
        parts.append(t["team"]["name"])
    parts = [p for p in parts if p]
    return " · ".join(parts) or None


def _task_reasons(tasks: List[Dict[str, Any]], day: date) -> List[Tuple[int, Dict[str, Any]]]:
    out = []
    iso = day.isoformat()
    for t in tasks:
        on_day = t["start_day"] <= iso <= t["end_day"]
        state = ("in progress" if t["status"] == "in_progress" else "planned") if on_day else "overdue"
        out.append((t["plant_id"], _reason(
            "task", f"{t['label']} ({state})",
            detail=_task_detail(t, dated=not on_day),
            task_id=t["id"], issue_id=t.get("issue_id"), task_type=t["task_type"], since=t["start_day"], on_day=on_day,
        )))
    return out


def _issue_reasons(db: Session, allowed: Optional[Set[int]]) -> List[Tuple[int, Dict[str, Any]]]:
    items = growatt_issues.list_issues(db, allowed, status="active", shadow=False, limit=100_000)["issues"]
    out = []
    for d in items:  # already in sort_key order
        if d["tier"] in SKIPPED_TIERS or d["shadow"]:
            continue
        where = [d.get("inverter_name") or d.get("device_sn")]
        if d.get("string_no") is not None:
            where.append(f"string {d['string_no']}")
        out.append((d["plant_id"], _reason(
            "issue", f"{d['tier']} {d['rule']} {d['name']}",
            detail=" · ".join(w for w in where if w) or None,
            priority=d["tier"], thb_per_day=d["thb_per_day_est"], issue_id=d["id"], since=d["opened_day"],
        )))
    return out


def _alarm_reasons(db: Session, allowed: Optional[Set[int]], day: date) -> List[Tuple[int, Dict[str, Any]]]:
    log = growatt_alarms.alarm_day(db, day, allowed)
    events: Dict[Tuple[int, str, str], Dict[str, Any]] = {}
    for a in log["alarms"]:
        if a.get("end_time") or push.level_of(a.get("fault_type")) != "fault":
            continue
        k = (a["plant_id"], a["device_sn"], str(a.get("alarm_code") or a.get("alarm_message") or ""))
        e = events.get(k)
        if e is None or (a.get("start_time") or "") < (e.get("start_time") or ""):
            events[k] = a
    sns = {k[1] for k in events}
    names = dict(db.execute(select(GrowattInverter.device_sn, GrowattInverter.alias).where(GrowattInverter.device_sn.in_(sns))).all()) if sns else {}
    out = []
    for (pid, sn, _), a in sorted(events.items(), key=lambda kv: (kv[0][0], kv[1].get("start_time") or "", kv[0][1])):
        code = a.get("alarm_code")
        what = " ".join(str(x) for x in (code, a.get("alarm_message")) if x not in (None, ""))
        start = a.get("start_time")
        out.append((pid, _reason(
            "alarm", "Open fault alarm",
            detail=" · ".join(x for x in (names.get(sn) or sn, what) if x) or None,
            since=start[:10] if start else None,
        )))
    return out


def _claim_reasons(db: Session, allowed: Optional[Set[int]], day: date) -> List[Tuple[int, Dict[str, Any]]]:
    open_statuses = [s for s in claims_svc.STATUSES if s not in claims_svc.CLOSED]
    out = []
    for c in claims_svc.list_claims(db, allowed, status=open_statuses)["claims"]:
        nxt = c.get("next_action_day")
        if c["status"] in claims_svc.CLOSED or not nxt or nxt > day.isoformat():
            continue
        waiting = c.get("waiting_on")
        parts = [c["type"].replace("_", " "), c.get("counterparty"), f"waiting on {waiting}" if waiting else None]
        out.append((c["plant_id"], _reason(
            "claim", f"Claim {c['number']} next action",
            detail=" · ".join(p for p in parts if p) or None, claim_id=c["id"], since=nxt,
        )))
    return out


def _due_reasons(
    db: Session, user: User, allowed: Optional[Set[int]], rows: List[Dict[str, Any]]
) -> List[Tuple[int, Dict[str, Any]]]:
    """Overdue cleaning / PM: plants `om_plans.due` (`rows`) counts overdue work for, with an open
    task of that type the Calendar flags overdue (the earliest one)."""
    today = cal._today()
    flagged = {r["plant_id"]: r for r in rows if r["overdue"]}
    out: List[Tuple[int, Dict[str, Any]]] = []
    for kind, types in (("cleaning_due", (CLEANING,)), ("pm_due", PM_TYPES)):
        starts = [date.fromisoformat(r["next"][t]) for r in flagged.values() for t in types if t in r["next"]]
        if not starts:
            continue
        first: Dict[int, Dict[str, Any]] = {}
        for t in types:
            for task in _open_tasks(db, user, allowed, min(starts), today - timedelta(days=1), task_type=t):
                if task["overdue"] and task["plant_id"] in flagged and task["plant_id"] not in first:
                    first[task["plant_id"]] = task  # the earliest overdue one
        for pid, task in first.items():
            r = flagged[pid]
            last = r["last"].get(types[0])
            if types[0] == CLEANING:
                n = r["days_since_cleaning"]
                done = f"last cleaning {last} ({n} days ago)" if last else "no cleaning recorded"
            else:
                done = f"last PM {last}" if last else "no PM recorded"
            out.append((pid, _reason(
                kind, f"{task['label']} overdue",
                detail=f"due by {task['end_day']}, not done · {done}",
                task_id=task["id"], task_type=task["task_type"], since=task["end_day"],
            )))
    return out


def _check_filters(db: Session, user: User, team_id: Optional[int], user_id: Optional[int]) -> None:
    if team_id is not None and db.get(OmTeam, team_id) is None:
        raise GrowattNotFound(f"Team {team_id} not found")
    if user_id is not None:
        u = db.get(User, user_id)
        visible = cal.visible_user_ids(db, user)
        # an engineer may name colleagues they can see in the Calendar and admins; anyone else is
        # "not found", so user ids are not revealed
        if u is None or (visible is not None and user_id not in visible and u.role != "admin"):
            raise GrowattNotFound(f"User {user_id} not found")


def candidates(
    db: Session,
    user: User,
    allowed: Optional[Set[int]],
    day: Optional[date] = None,
    *,
    team_id: Optional[int] = None,
    user_id: Optional[int] = None,
) -> Dict[str, Any]:
    """The plants worth visiting on `day` (default today, Bangkok), ranked, with their reasons."""
    _check_filters(db, user, team_id, user_id)
    today = cal._today()
    day = day or today

    due_rows = om_plans.due(db, allowed, day)["plants"]
    crew = {r["plant_id"]: r["settings"].get("cleaning_crew_days") for r in due_rows}
    covering = _open_tasks(db, user, allowed, day, day, user_id=user_id, team_id=team_id)
    # open tasks that ended before `day`: from the earliest open task's start (`due.next`) on
    starts = [date.fromisoformat(d) for r in due_rows for d in r["next"].values()]
    overdue: List[Dict[str, Any]] = []
    if starts and min(starts) < day:
        overdue = [
            t for t in _open_tasks(db, user, allowed, min(starts), day - timedelta(days=1), user_id=user_id, team_id=team_id)
            if t["end_day"] < day.isoformat()
        ]
    found: List[Tuple[int, Dict[str, Any]]] = []
    found += _task_reasons(covering + overdue, day)
    found += _issue_reasons(db, allowed)
    found += _alarm_reasons(db, allowed, min(day, today))
    found += _claim_reasons(db, allowed, day)
    found += _due_reasons(db, user, allowed, due_rows)

    by_plant: Dict[int, List[Dict[str, Any]]] = {}
    for pid, r in found:
        if allowed is None or pid in allowed:
            by_plant.setdefault(pid, []).append(r)
    plants = {
        p.plant_id: p for p in db.scalars(select(GrowattPlant).where(GrowattPlant.plant_id.in_(list(by_plant) or [-1])))
    }
    cands = []
    for pid, reasons in by_plant.items():
        p = plants.get(pid)
        if p is None:  # a reason on a plant no longer in the registry
            continue
        located = usable_location(p.latitude, p.longitude)
        minutes, basis = service_time(reasons, crew.get(pid))
        cands.append({
            "plant_id": pid,
            "name": p.name,
            "city": p.city,
            "lat": p.latitude if located else None,
            "lon": p.longitude if located else None,
            "has_location": located,
            "reasons": reasons,
            "default_service_min": minutes,
            "service_basis": basis,
            "rank": 0,
        })
    ranked = rank(cands)
    for c in ranked:
        for r in c["reasons"]:
            r.pop("on_day", None)
    counts = {k: sum(1 for c in ranked if any(r["kind"] == k for r in c["reasons"])) for k in KINDS}
    return {
        "day": day.isoformat(),
        "team_id": team_id,
        "user_id": user_id,
        "candidates": ranked,
        "counts": counts,
        "labels": dict(LABELS),
    }
