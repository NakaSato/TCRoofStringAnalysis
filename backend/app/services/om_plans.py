"""Calendar Team, Phase 2 (docs/plans/calendar-team.md): recurring plans, the monthly "due" view,
per-plant planning figures and cleaning rounds. Task basics (validation, serialising, history,
access) are in `om_calendar`; the date maths is pure, in `solar_core/om_planning.py`.

**Occurrences.** Saving a plan, and the worker's nightly `om_plans` job, keep its `planned` tasks
from today to `HORIZON_DAYS` ahead: missing occurrences are created, stale ones deleted. A task
counts as generated-and-untouched while it is `planned` and still on its `scheduled_day`; anything
moved, started or finished is never changed or deleted, and since generation is keyed on
(plan, plant, scheduled_day) a moved task is never generated again on its old day. Saving a plan
also brings its untouched future tasks in line with it (type, title, length, team, assignees).

Nothing here is a measurement: crew-days and cost are what an admin entered (null = not entered,
never assumed), and "days since cleaning" counts from the Site log.
"""

from __future__ import annotations

from datetime import date, timedelta
from typing import Any, Dict, Iterable, List, Optional, Set, Tuple

from sqlalchemy import delete, false, func, select, update
from sqlalchemy.orm import Session

from app.db.models import (
    GrowattPlant,
    OmPlan,
    OmPlanAssignee,
    OmPlanPlant,
    OmPlantSettings,
    OmTask,
    OmTeam,
    SiteEvent,
    SiteRegister,
    User,
)
from app.services import om_calendar as cal
from app.services import tariff
from app.services.growatt_common import GrowattNotFound
from solar_core import om_planning

HORIZON_DAYS = 90
MAX_PLAN_PLANTS = 300
ROUND_MAX_PLANTS = 300
ROUND_HORIZON_DAYS = 120
LAST_TYPES = ("cleaning", "pm_inspection", "inverter_service", "ir_flight")

# UI presets (docs §4): the defaults a new plan starts from
PRESETS: List[Dict[str, Any]] = [
    {"key": "cleaning_dry", "name": "Cleaning every 2 months (dry season)", "task_type": "cleaning",
     "every_n": 2, "unit": "month", "season_from_month": 11, "season_to_month": 4, "duration_days": 1},
    {"key": "inverter_quarterly", "name": "Inverter service quarterly", "task_type": "inverter_service",
     "every_n": 3, "unit": "month", "season_from_month": None, "season_to_month": None, "duration_days": 1},
    {"key": "ir_yearly", "name": "IR flight yearly", "task_type": "ir_flight",
     "every_n": 12, "unit": "month", "season_from_month": None, "season_to_month": None, "duration_days": 1},
]


def holidays(db: Session) -> Set[date]:
    """Public holidays from the tariff setting (the same list prices off-peak days)."""
    out: Set[date] = set()
    for s in tariff.get_tariff(db).get("holidays") or []:
        try:
            out.add(date.fromisoformat(str(s)))
        except ValueError:
            continue
    return out


# --------------------------------------------------------------------------- plans: reading


def _plan_rows(
    db: Session, plans: List[OmPlan], allowed: Optional[Set[int]], visible: Optional[Set[int]] = None
) -> List[Dict[str, Any]]:
    """`allowed` = the caller's plants and `visible` = the users whose work they may see (None = all:
    admin); an engineer gets only those plants, those plants' upcoming tasks and those assignees."""
    if not plans:
        return []
    ids = [p.id for p in plans]
    plants: Dict[int, List[int]] = {}
    for pid, plant in db.execute(select(OmPlanPlant.plan_id, OmPlanPlant.plant_id).where(OmPlanPlant.plan_id.in_(ids))):
        if allowed is None or plant in allowed:
            plants.setdefault(pid, []).append(plant)
    names = dict(db.execute(select(GrowattPlant.plant_id, GrowattPlant.name)).all())
    users: Dict[int, List[Dict[str, Any]]] = {}
    for pid, u in db.execute(
        select(OmPlanAssignee.plan_id, User).join(User, User.id == OmPlanAssignee.user_id).where(OmPlanAssignee.plan_id.in_(ids))
    ):
        if visible is None or u.id in visible:
            users.setdefault(pid, []).append(cal._user_row(u))
    team_ids = {p.default_team_id for p in plans if p.default_team_id is not None}
    teams = {t.id: t for t in db.scalars(select(OmTeam).where(OmTeam.id.in_(team_ids)))} if team_ids else {}
    today = cal._today()
    uq = select(OmTask.plan_id, func.count()).where(OmTask.plan_id.in_(ids), OmTask.status == "planned", OmTask.start_day >= today)
    if allowed is not None:
        uq = uq.where(OmTask.plant_id.in_(allowed) if allowed else false())
    upcoming = dict(db.execute(uq.group_by(OmTask.plan_id)).all())
    hol = holidays(db)
    out = []
    for p in plans:
        team = teams.get(p.default_team_id) if p.default_team_id is not None else None
        pl = sorted(plants.get(p.id, []))
        nxt = om_planning.occurrences(
            p.starts_on, p.every_n, p.unit, today, today + timedelta(days=400),
            season_from=p.season_from_month, season_to=p.season_to_month, weekday=p.weekday, ends_on=p.ends_on, holidays=hol,
        )[:3] if p.active else []
        out.append({
            "id": p.id,
            "name": p.name,
            "task_type": p.task_type,
            "label": cal._label(p.task_type),
            "every_n": p.every_n,
            "unit": p.unit,
            "season_from_month": p.season_from_month,
            "season_to_month": p.season_to_month,
            "weekday": p.weekday,
            "duration_days": p.duration_days,
            "team": {"id": team.id, "name": team.name, "color": team.color} if team else None,
            "assignees": sorted(users.get(p.id, []), key=lambda a: (a["full_name"] or a["username"] or "").lower()),
            "plant_ids": pl,
            "plants": [{"plant_id": i, "name": names.get(i)} for i in pl],
            "starts_on": p.starts_on.isoformat(),
            "ends_on": p.ends_on.isoformat() if p.ends_on else None,
            "active": p.active,
            "note": p.note,
            "next_days": [d.isoformat() for d in nxt],
            "upcoming_tasks": int(upcoming.get(p.id, 0)),
            "created_by": p.created_by,
            "updated_by": p.updated_by,
        })
    return out


def list_plans(db: Session, allowed: Optional[Set[int]], visible: Optional[Set[int]] = None) -> Dict[str, Any]:
    """Admins: every plan. Engineers: plans covering at least one of their plants (only those shown)."""
    q = select(OmPlan).order_by(OmPlan.active.desc(), OmPlan.name)
    if allowed is not None:
        q = q.where(OmPlan.id.in_(select(OmPlanPlant.plan_id).where(OmPlanPlant.plant_id.in_(allowed or {-1}))))
    return {"plans": _plan_rows(db, list(db.scalars(q)), allowed, visible), "presets": PRESETS, "horizon_days": HORIZON_DAYS}


def get_plan(db: Session, plan_id: int) -> OmPlan:
    p = db.get(OmPlan, plan_id)
    if p is None:
        raise GrowattNotFound(f"Plan {plan_id} not found")
    return p


def plan_out(db: Session, p: OmPlan) -> Dict[str, Any]:
    return _plan_rows(db, [p], None)[0]


# --------------------------------------------------------------------------- plans: writing


_PLAN_FIELDS = ("name", "task_type", "every_n", "unit", "season_from_month", "season_to_month", "weekday",
                "duration_days", "default_team_id", "starts_on", "ends_on", "active", "note")


def _check_plan(db: Session, v: Dict[str, Any], current_team: Optional[int] = None) -> None:
    """`current_team`: the plan's saved team, accepted even when it has since been made inactive."""
    if v["task_type"] not in cal.TASK_TYPES:
        raise ValueError(f"task_type must be one of {', '.join(cal.TASK_TYPES)}")
    if v["unit"] not in ("week", "month"):
        raise ValueError("unit must be week or month")
    top = 104 if v["unit"] == "week" else 36
    if not 1 <= int(v["every_n"]) <= top:
        raise ValueError(f"every_n must be 1 … {top} for unit {v['unit']}")
    a, b = v.get("season_from_month"), v.get("season_to_month")
    if (a is None) != (b is None):
        raise ValueError("Give both season months, or neither")
    if a is not None and b is not None and not (1 <= a <= 12 and 1 <= b <= 12):
        raise ValueError("Season months are 1 … 12")
    if v.get("weekday") is not None and not 0 <= v["weekday"] <= 6:
        raise ValueError("weekday is 0 (Monday) … 6 (Sunday)")
    if not 1 <= int(v["duration_days"]) <= 31:
        raise ValueError("duration_days must be 1 … 31")
    if v.get("ends_on") is not None and v["ends_on"] < v["starts_on"]:
        raise ValueError("ends_on is before starts_on")
    if v.get("default_team_id") is not None:
        cal._check_team(db, v["default_team_id"], current_team)
    if not (v.get("name") or "").strip():
        raise ValueError("A plan needs a name")


def _check_plants(db: Session, ids: Iterable[int]) -> List[int]:
    want = sorted(set(int(i) for i in ids))
    if not want:
        raise ValueError("A plan needs at least one plant")
    if len(want) > MAX_PLAN_PLANTS:
        raise ValueError(f"A plan covers at most {MAX_PLAN_PLANTS} plants")
    found = set(db.scalars(select(GrowattPlant.plant_id).where(GrowattPlant.plant_id.in_(want))))
    missing = [i for i in want if i not in found]
    if missing:
        raise ValueError(f"Plant(s) {', '.join(map(str, missing))} not found")
    return want


def _check_users(db: Session, ids: Iterable[int]) -> List[int]:
    want = sorted(set(int(i) for i in ids))
    if not want:
        return []
    found = set(db.scalars(select(User.id).where(User.id.in_(want), User.is_active.is_(True))))
    missing = [i for i in want if i not in found]
    if missing:
        raise ValueError(f"User(s) {', '.join(map(str, missing))} not found")
    return want


def _set_links(db: Session, p: OmPlan, plant_ids: Optional[List[int]], user_ids: Optional[List[int]]) -> None:
    if plant_ids is not None:
        db.execute(delete(OmPlanPlant).where(OmPlanPlant.plan_id == p.id))
        db.add_all([OmPlanPlant(plan_id=p.id, plant_id=i) for i in plant_ids])
    if user_ids is not None:
        db.execute(delete(OmPlanAssignee).where(OmPlanAssignee.plan_id == p.id))
        db.add_all([OmPlanAssignee(plan_id=p.id, user_id=i) for i in user_ids])
    db.flush()


def create_plan(db: Session, user: User, payload: Dict[str, Any]) -> Tuple[OmPlan, Dict[str, int]]:
    v = {k: payload.get(k) for k in _PLAN_FIELDS}
    v["active"] = True if v["active"] is None else bool(v["active"])
    v["duration_days"] = v["duration_days"] or 1
    _check_plan(db, v)
    plants = _check_plants(db, payload.get("plant_ids") or [])
    users = _check_users(db, payload.get("assignee_ids") or [])
    who = cal._who(user)
    p = OmPlan(**{**v, "name": str(v["name"]).strip(), "note": cal._clean(v["note"])}, created_by=who, updated_by=who)
    db.add(p)
    db.flush()
    _set_links(db, p, plants, users)
    result = sync_plan(db, p, who, resync=True)
    db.commit()
    return p, result


def update_plan(db: Session, user: User, p: OmPlan, changes: Dict[str, Any]) -> Tuple[OmPlan, Dict[str, int]]:
    v = {k: changes[k] if k in changes else getattr(p, k) for k in _PLAN_FIELDS}
    for k in ("name", "task_type", "every_n", "unit", "duration_days", "starts_on", "active"):
        if v[k] is None:
            v[k] = getattr(p, k)
    _check_plan(db, v, current_team=p.default_team_id)
    plants = _check_plants(db, changes["plant_ids"]) if changes.get("plant_ids") is not None else None
    users = _check_users(db, changes["assignee_ids"]) if changes.get("assignee_ids") is not None else None
    for k in _PLAN_FIELDS:
        setattr(p, k, v[k])
    p.name = p.name.strip()
    p.note = cal._clean(p.note)
    p.updated_by = cal._who(user)
    _set_links(db, p, plants, users)
    result = sync_plan(db, p, p.updated_by, resync=True)
    db.commit()
    return p, result


def delete_plan(db: Session, p: OmPlan) -> Dict[str, int]:
    """The plan's untouched future tasks go; every other task it made stays as a one-off."""
    today = cal._today()
    gone = getattr(db.execute(
        delete(OmTask).where(
            OmTask.plan_id == p.id, OmTask.status == "planned", OmTask.start_day == OmTask.scheduled_day, OmTask.start_day >= today
        )
    ), "rowcount", 0)
    kept = getattr(db.execute(update(OmTask).where(OmTask.plan_id == p.id).values(plan_id=None)), "rowcount", 0)
    db.delete(p)
    db.commit()
    return {"deleted": int(gone or 0), "kept": int(kept or 0)}


# --------------------------------------------------------------------------- occurrences


def _untouched(t: OmTask, today: date) -> bool:
    return t.status == "planned" and t.scheduled_day is not None and t.start_day == t.scheduled_day and t.start_day >= today


def sync_plan(db: Session, p: OmPlan, who: Optional[str], *, resync: bool = False, hol: Optional[Set[date]] = None) -> Dict[str, int]:
    """Bring the plan's tasks from today to HORIZON_DAYS ahead in line with it (no commit).
    Returns counts: created / deleted / updated."""
    today = cal._today()
    hol = holidays(db) if hol is None else hol
    plants = list(db.scalars(select(OmPlanPlant.plant_id).where(OmPlanPlant.plan_id == p.id)))
    days = (
        om_planning.occurrences(
            p.starts_on, p.every_n, p.unit, today, today + timedelta(days=HORIZON_DAYS),
            season_from=p.season_from_month, season_to=p.season_to_month, weekday=p.weekday, ends_on=p.ends_on, holidays=hol,
        )
        if p.active
        else []
    )
    want = {(pl, d) for pl in plants for d in days}
    tasks = list(db.scalars(select(OmTask).where(OmTask.plan_id == p.id)))
    have = {(t.plant_id, t.scheduled_day) for t in tasks}
    users = list(db.scalars(select(OmPlanAssignee.user_id).where(OmPlanAssignee.plan_id == p.id)))
    costs = _costs(db, plants) if p.task_type == "cleaning" else {}
    who = who or "plan"
    created = deleted = updated = 0
    assignable: Dict[int, Set[int]] = {}

    def people(plant_id: int) -> List[int]:
        if plant_id not in assignable:
            assignable[plant_id] = cal.assignable_user_ids(db, plant_id)
        return sorted(u for u in users if u in assignable[plant_id])

    for t in tasks:
        if not _untouched(t, today):
            continue
        if (t.plant_id, t.scheduled_day) not in want:
            db.delete(t)
            deleted += 1
            continue
        if resync:
            end = t.start_day + timedelta(days=p.duration_days - 1)
            diff: Dict[str, Any] = {}
            for k, new in (("task_type", p.task_type), ("title", p.name), ("end_day", end), ("team_id", p.default_team_id)):
                if getattr(t, k) != new:
                    diff[k] = [cal._jsonable(getattr(t, k)), cal._jsonable(new)]
                    setattr(t, k, new)
            ids, old = people(t.plant_id), cal._assignee_ids(db, t)
            if ids != old:
                cal._set_assignees(db, t, ids)
                diff["assignee_ids"] = [old, ids]
            if diff:
                t.updated_by = who
                cal._history(db, t, who, diff, f"Plan '{p.name}' changed")
                updated += 1
    for plant_id, d in sorted(want - have):
        t = OmTask(
            plant_id=plant_id,
            task_type=p.task_type,
            title=p.name,
            start_day=d,
            end_day=d + timedelta(days=p.duration_days - 1),
            scheduled_day=d,
            status="planned",
            team_id=p.default_team_id,
            plan_id=p.id,
            est_cost_thb=costs.get(plant_id),
            created_by=who,
            updated_by=who,
        )
        db.add(t)
        db.flush()
        cal._set_assignees(db, t, people(plant_id))
        cal._history(db, t, who, {"created": {"start_day": d.isoformat(), "end_day": t.end_day.isoformat(), "task_type": t.task_type, "plan_id": p.id}})
        created += 1
    db.flush()
    return {"created": created, "deleted": deleted, "updated": updated}


def generate_all(db: Session) -> Dict[str, Any]:
    """The nightly `om_plans` job: every plan's next HORIZON_DAYS (inactive ones lose their untouched future tasks)."""
    hol = holidays(db)
    total = {"plans": 0, "created": 0, "deleted": 0, "updated": 0}
    for p in db.scalars(select(OmPlan).order_by(OmPlan.id)):
        r = sync_plan(db, p, "worker", hol=hol)
        total["plans"] += 1
        for k in ("created", "deleted", "updated"):
            total[k] += r[k]
    db.commit()
    return total


# --------------------------------------------------------------------------- per-plant settings


def _costs(db: Session, plant_ids: Iterable[int]) -> Dict[int, float]:
    ids = list(plant_ids)
    if not ids:
        return {}
    rows = db.execute(
        select(OmPlantSettings.plant_id, OmPlantSettings.cleaning_cost_thb).where(OmPlantSettings.plant_id.in_(ids))
    )
    return {pid: c for pid, c in rows if c is not None}


def settings_out(s: Optional[OmPlantSettings]) -> Dict[str, Any]:
    return {
        "cleaning_crew_days": s.cleaning_crew_days if s else None,
        "cleaning_cost_thb": s.cleaning_cost_thb if s else None,
        "updated_by": s.updated_by if s else None,
        "updated_at": s.updated_at.isoformat() if s and s.updated_at else None,
    }


def put_settings(db: Session, user: User, plant_id: int, payload: Dict[str, Any]) -> Dict[str, Any]:
    if db.get(GrowattPlant, plant_id) is None:
        raise GrowattNotFound(f"Plant {plant_id} not found")
    s = db.get(OmPlantSettings, plant_id)
    if s is None:
        s = OmPlantSettings(plant_id=plant_id)
        db.add(s)
    for k in ("cleaning_crew_days", "cleaning_cost_thb"):
        if k in payload:
            setattr(s, k, payload[k])
    s.updated_by = cal._who(user)
    db.commit()
    return {"plant_id": plant_id, **settings_out(s)}


def delete_plant_rows(db: Session, plant_ids: Iterable[int]) -> None:
    """The blocked-plant cleanup: plan links and settings of removed plants (no commit)."""
    ids = list(plant_ids)
    if ids:
        db.execute(delete(OmPlanPlant).where(OmPlanPlant.plant_id.in_(ids)))
        db.execute(delete(OmPlantSettings).where(OmPlantSettings.plant_id.in_(ids)))


# --------------------------------------------------------------------------- due this month


def _last_done(db: Session, plant_ids: Optional[Set[int]]) -> Dict[int, Dict[str, date]]:
    q = (
        select(SiteEvent.plant_id, SiteEvent.event_type, func.max(SiteEvent.day), func.max(SiteEvent.end_day))
        .where(SiteEvent.event_type.in_(LAST_TYPES))
        .group_by(SiteEvent.plant_id, SiteEvent.event_type)
    )
    if plant_ids is not None:
        q = q.where(SiteEvent.plant_id.in_(plant_ids or {-1}))
    out: Dict[int, Dict[str, date]] = {}
    for pid, kind, d, e in db.execute(q):
        out.setdefault(pid, {})[kind] = max(x for x in (d, e) if x is not None)
    return out


def _plant_rows():
    """(plant_id, name, province, phase) per plant. The province comes from the O&M site register,
    else Growatt's `city` (often a district or empty; docs/plans/om-asset-network.md)."""
    return select(
        GrowattPlant.plant_id, GrowattPlant.name, func.coalesce(SiteRegister.province, GrowattPlant.city), GrowattPlant.phase
    ).outerjoin(SiteRegister, SiteRegister.plant_id == GrowattPlant.plant_id)


def due(db: Session, allowed: Optional[Set[int]], month: date) -> Dict[str, Any]:
    """Every plant the user may see, for the month's plan: last cleaning / PM per type (Site log),
    days since the last cleaning, the earliest open task per type, the month's tasks, overdue work,
    the plans covering it and its planning figures."""
    today = cal._today()
    first = month.replace(day=1)
    last = om_planning.add_months(first, 1) - timedelta(days=1)
    q = _plant_rows().order_by(GrowattPlant.name)
    if allowed is not None:
        q = q.where(GrowattPlant.plant_id.in_(allowed or {-1}))
    plants = list(db.execute(q))
    ids = {r[0] for r in plants}
    done = _last_done(db, ids)
    settings = {s.plant_id: s for s in db.scalars(select(OmPlantSettings).where(OmPlantSettings.plant_id.in_(ids or {-1})))}
    nxt: Dict[int, Dict[str, date]] = {}
    overdue: Dict[int, int] = {}
    for pid, kind, start, end in db.execute(
        select(OmTask.plant_id, OmTask.task_type, OmTask.start_day, OmTask.end_day).where(
            OmTask.status.in_(cal.ACTIVE), OmTask.plant_id.in_(ids or {-1})
        )
    ):
        if end < today:
            overdue[pid] = overdue.get(pid, 0) + 1
        cur = nxt.setdefault(pid, {})
        if kind not in cur or start < cur[kind]:
            cur[kind] = start
    month_tasks: Dict[int, Dict[str, int]] = {}
    for pid, status in db.execute(
        select(OmTask.plant_id, OmTask.status).where(
            OmTask.plant_id.in_(ids or {-1}), OmTask.start_day <= last, OmTask.end_day >= first
        )
    ):
        m = month_tasks.setdefault(pid, {"total": 0, "done": 0, "open": 0})
        m["total"] += 1
        if status == "done":
            m["done"] += 1
        elif status in cal.ACTIVE:
            m["open"] += 1
    plan_names: Dict[int, List[str]] = {}
    for pid, name in db.execute(
        select(OmPlanPlant.plant_id, OmPlan.name).join(OmPlan, OmPlan.id == OmPlanPlant.plan_id).where(
            OmPlan.active.is_(True), OmPlanPlant.plant_id.in_(ids or {-1})
        )
    ):
        plan_names.setdefault(pid, []).append(name)
    rows = []
    for pid, name, city, phase in plants:
        last_by = done.get(pid, {})
        lc = last_by.get("cleaning")
        n = nxt.get(pid, {})
        rows.append({
            "plant_id": pid,
            "name": name,
            "city": city,
            "phase": phase,
            "last": {k: d.isoformat() for k, d in last_by.items()},
            "days_since_cleaning": (today - lc).days if lc else None,
            "next": {k: d.isoformat() for k, d in n.items()},
            "next_cleaning": n["cleaning"].isoformat() if "cleaning" in n else None,
            "overdue": overdue.get(pid, 0),
            "month": month_tasks.get(pid, {"total": 0, "done": 0, "open": 0}),
            "plans": sorted(plan_names.get(pid, [])),
            "settings": settings_out(settings.get(pid)),
        })
    return {
        "month": first.isoformat()[:7],
        "from": first.isoformat(),
        "to": last.isoformat(),
        "today": today.isoformat(),
        "plants": rows,
        "summary": {
            "plants": len(rows),
            "never_cleaned": sum(1 for r in rows if r["days_since_cleaning"] is None),
            "cleaning_planned": sum(1 for r in rows if r["next_cleaning"] is not None),
            "with_overdue": sum(1 for r in rows if r["overdue"]),
            "month_tasks": sum(r["month"]["total"] for r in rows),
        },
        "meta": {"source": "db"},
    }


# --------------------------------------------------------------------------- cleaning rounds


def round_preview(db: Session, payload: Dict[str, Any]) -> Dict[str, Any]:
    """Proposed cleaning tasks for the chosen plants (nothing saved)."""
    start: date = payload["start_day"]
    if start < cal._today():
        raise ValueError("A round starts today or later")
    ids = sorted(set(int(i) for i in payload.get("plant_ids") or []))
    if not ids:
        raise ValueError("Pick at least one plant")
    if len(ids) > ROUND_MAX_PLANTS:
        raise ValueError(f"A round covers at most {ROUND_MAX_PLANTS} plants")
    crews = int(payload.get("crews") or 1)
    if not 1 <= crews <= 20:
        raise ValueError("crews must be 1 … 20")
    group_by = payload.get("group_by") or "city"
    if group_by not in ("city", "phase", "none"):
        raise ValueError("group_by must be city, phase or none")
    plants = {r[0]: r for r in db.execute(
        _plant_rows().where(GrowattPlant.plant_id.in_(ids))
    )}
    missing = [i for i in ids if i not in plants]
    if missing:
        raise ValueError(f"Plant(s) {', '.join(map(str, missing))} not found")
    today = cal._today()
    last = _last_done(db, set(ids))
    settings = {s.plant_id: s for s in db.scalars(select(OmPlantSettings).where(OmPlantSettings.plant_id.in_(ids)))}
    planned: Dict[int, date] = {}
    for pid, d in db.execute(
        select(OmTask.plant_id, func.min(OmTask.start_day)).where(
            OmTask.plant_id.in_(ids), OmTask.task_type == "cleaning", OmTask.status.in_(cal.ACTIVE)
        ).group_by(OmTask.plant_id)
    ):
        planned[pid] = d
    inputs = []
    for i in ids:
        lc = last.get(i, {}).get("cleaning")
        s = settings.get(i)
        group = None if group_by == "none" else str((plants[i][2] if group_by == "city" else plants[i][3]) or "")
        inputs.append(om_planning.RoundPlant(i, s.cleaning_crew_days if s else None, (today - lc).days if lc else None, group))
    weekdays = om_planning.WORKDAYS + ((5,) if payload.get("include_saturday") else ())
    hol = holidays(db)
    def run(ps: List[om_planning.RoundPlant]) -> om_planning.RoundResult:
        return om_planning.schedule_round(
            ps, start, crews, weekdays=weekdays, holidays=hol, group=group_by != "none", horizon_days=ROUND_HORIZON_DAYS
        )

    res = run(inputs)
    # A plant whose task would span the task limit can't be saved as one task: leave it out of the round
    # (listed in `too_long`) and schedule the rest without it, so a preview always saves as shown.
    too_long = sorted(s.plant_id for s in res.slots if (s.end_day - s.start_day).days >= cal.MAX_TASK_DAYS)
    if too_long:
        res = run([p for p in inputs if p.plant_id not in set(too_long)])
    by_id = {p.plant_id: p for p in inputs}
    items = []
    for s in res.slots:
        p, st = plants[s.plant_id], settings.get(s.plant_id)
        items.append({
            "plant_id": s.plant_id,
            "plant_name": p[1],
            "city": p[2],
            "phase": p[3],
            "start_day": s.start_day.isoformat(),
            "end_day": s.end_day.isoformat(),
            "crew": s.crew,
            "crew_days": s.crew_days,
            "duration_set": s.duration_set,
            "days_since_cleaning": by_id[s.plant_id].days_since,
            "cost_thb": st.cleaning_cost_thb if st else None,
            "already_planned": planned[s.plant_id].isoformat() if s.plant_id in planned else None,
        })
    end = max((s.end_day for s in res.slots), default=None)
    skipped = sorted(d for d in hol if start <= d <= (end or start) and d.weekday() in weekdays)
    costs = [x["cost_thb"] for x in items if x["cost_thb"] is not None]
    return {
        "items": items,
        "unscheduled": [{"plant_id": i, "name": plants[i][1]} for i in res.unscheduled],
        "too_long": [{"plant_id": i, "name": plants[i][1]} for i in too_long],
        "max_task_days": cal.MAX_TASK_DAYS,
        "start_day": start.isoformat(),
        "end_day": end.isoformat() if end else None,
        "crews": crews,
        "weekdays": list(weekdays),
        "holidays_skipped": [d.isoformat() for d in skipped],
        "cost_thb": sum(costs) if costs else None,
        "cost_missing": len(items) - len(costs),
        "duration_missing": sum(1 for x in items if not x["duration_set"]),
    }


def round_save(db: Session, user: User, payload: Dict[str, Any]) -> Dict[str, Any]:
    """Create the (previewed, possibly edited) round's cleaning tasks in one transaction. Assignees
    who may not work on a plant are left off that plant's task (reported in `dropped`)."""
    items = payload.get("items") or []
    if not items:
        raise ValueError("Nothing to save")
    if len(items) > ROUND_MAX_PLANTS:
        raise ValueError(f"A round covers at most {ROUND_MAX_PLANTS} plants")
    today = cal._today()
    title = cal._clean(payload.get("title")) or "Cleaning round"
    team_id = payload.get("team_id")
    cal._check_team(db, team_id)
    users = _check_users(db, payload.get("assignee_ids") or [])
    ids = {int(x["plant_id"]) for x in items}
    found = set(db.scalars(select(GrowattPlant.plant_id).where(GrowattPlant.plant_id.in_(ids))))
    if ids - found:
        raise ValueError(f"Plant(s) {', '.join(map(str, sorted(ids - found)))} not found")
    costs = _costs(db, ids)
    who = cal._who(user)
    created: List[int] = []
    dropped: Dict[int, List[int]] = {}
    for x in items:
        pid, start = int(x["plant_id"]), x["start_day"]
        end = x.get("end_day") or start
        if start < today:
            raise ValueError(f"Plant {pid}: the round's days are in the past")
        cal._check(db, pid, "cleaning", start, end, None, None, None)
        ok = cal.assignable_user_ids(db, pid)
        mine = [u for u in users if u in ok]
        if len(mine) < len(users):
            dropped[pid] = [u for u in users if u not in ok]
        crew = x.get("crew")
        t = OmTask(
            plant_id=pid,
            task_type="cleaning",
            title=f"{title} · crew {crew}" if crew else title,
            start_day=start,
            end_day=end,
            status="planned",
            team_id=team_id,
            est_cost_thb=costs.get(pid),
            note=cal._clean(payload.get("note")),
            created_by=who,
            updated_by=who,
        )
        db.add(t)
        db.flush()
        cal._set_assignees(db, t, mine)
        cal._history(db, t, who, {"created": {"start_day": start.isoformat(), "end_day": end.isoformat(), "task_type": "cleaning", "round": title}})
        created.append(t.id)
    db.commit()
    return {"created": len(created), "task_ids": created, "dropped_assignees": {str(k): v for k, v in dropped.items()}}
