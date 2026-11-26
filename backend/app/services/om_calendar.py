"""Calendar Team: planned O&M tasks per plant (docs/plans/calendar-team.md, Phase 1).

A task is planned work on one plant over `start_day` … `end_day` (plant-local, may be in the
future) with a type, assignees (users), an optional team / crew, and a status. Marking it done
writes a Site log event (`site_events.create_event`) with the task's type, so the Site log and
"last cleaning" pick it up. Every change goes to `om_task_history`.

Access follows the rest of the app: admins see every task; engineers see full tasks only on their
assigned plants. So an engineer's weekly lanes stay honest, a task on another plant assigned to a
user they can see (themselves, or someone sharing one of their plants) comes back as a masked
"Busy" block: dates and those assignees only, no plant, title or id.

Records of plans, not measurements: SQL only (never Firestore), kept indefinitely.
"""

from __future__ import annotations

from datetime import date, datetime, timezone
from typing import Any, Dict, Iterable, List, Optional, Set

from sqlalchemy import delete, false, or_, select, update
from sqlalchemy.orm import Session

from app.db.models import (
    GrowattInverter,
    GrowattIssue,
    GrowattPlant,
    OmTask,
    OmTaskAssignee,
    OmTaskHistory,
    OmTeam,
    OmTeamMember,
    User,
    UserPlantAssignment,
)
from app.services import site_events
from app.services.growatt_common import GrowattNotFound

TASK_TYPES = (
    "cleaning",
    "repair",
    "module_replaced",
    "inverter_replaced",
    "ir_flight",
    "pm_inspection",
    "inverter_service",
    "site_visit",
    "other",
)
STATUSES = ("planned", "in_progress", "done", "skipped", "cancelled")
ACTIVE = ("planned", "in_progress")
MAX_TASK_DAYS = 62
MAX_RANGE_DAYS = 100


class TaskConflict(Exception):
    """The task is in a state that does not allow this (e.g. already done)."""


class TaskForbidden(Exception):
    """The user may see the task but not do this to it."""


def _today() -> date:
    return site_events._today()


def _label(task_type: str) -> str:
    return site_events.EVENT_LABELS.get(task_type, task_type)


def _who(user: User) -> str:
    return user.username or user.email


# --------------------------------------------------------------------------- who can see / be assigned


def visible_user_ids(db: Session, user: User) -> Optional[Set[int]]:
    """Users whose lanes the user may see: None = everyone (admin); an engineer sees themselves
    and anyone assigned to at least one of their plants."""
    if user.role == "admin":
        return None
    mine = select(UserPlantAssignment.plant_id).where(UserPlantAssignment.user_id == user.id)
    ids = set(db.scalars(select(UserPlantAssignment.user_id).where(UserPlantAssignment.plant_id.in_(mine))))
    ids.add(user.id)
    return ids


def assignable_user_ids(db: Session, plant_id: int) -> Set[int]:
    """Active users who may work on the plant: every admin, and the engineers assigned to it."""
    admins = select(User.id).where(User.role == "admin", User.is_active.is_(True))
    assigned = (
        select(User.id)
        .join(UserPlantAssignment, UserPlantAssignment.user_id == User.id)
        .where(UserPlantAssignment.plant_id == plant_id, User.is_active.is_(True))
    )
    return set(db.scalars(admins)) | set(db.scalars(assigned))


def _user_row(u: User) -> Dict[str, Any]:
    return {"id": u.id, "username": u.username, "full_name": u.full_name, "role": u.role}


def list_assignees(db: Session, user: User, plant_id: Optional[int]) -> Dict[str, Any]:
    """Users the caller may assign (with `plant_id`) or see lanes for (without), and the active teams."""
    if plant_id is not None:
        ids = assignable_user_ids(db, plant_id)
        visible = visible_user_ids(db, user)
        if visible is not None:
            ids &= visible | set(db.scalars(select(User.id).where(User.role == "admin")))
    else:
        visible = visible_user_ids(db, user)
        q = select(User.id).where(User.is_active.is_(True))
        ids = set(db.scalars(q)) if visible is None else visible
    users = list(db.scalars(select(User).where(User.id.in_(ids), User.is_active.is_(True)))) if ids else []
    users.sort(key=lambda u: (u.full_name or u.username or "").lower())
    return {"users": [_user_row(u) for u in users], "teams": list_teams(db, include_inactive=False)}


# --------------------------------------------------------------------------- validation


def _check(
    db: Session,
    plant_id: int,
    task_type: str,
    start_day: date,
    end_day: date,
    device_sn: Optional[str],
    string_no: Optional[int],
    est_cost_thb: Optional[float],
) -> None:
    if task_type not in TASK_TYPES:
        raise ValueError(f"task_type must be one of {', '.join(TASK_TYPES)}")
    if end_day < start_day:
        raise ValueError("end_day is before start_day")
    if (end_day - start_day).days >= MAX_TASK_DAYS:
        raise ValueError(f"A task spans at most {MAX_TASK_DAYS} days")
    if string_no is not None and not device_sn:
        raise ValueError("A string needs its inverter (device_sn)")
    if device_sn:
        inv = db.scalar(
            select(GrowattInverter.device_sn).where(GrowattInverter.plant_id == plant_id, GrowattInverter.device_sn == device_sn)
        )
        if inv is None:
            raise ValueError(f"Inverter {device_sn} does not belong to plant {plant_id}")
    if est_cost_thb is not None and est_cost_thb < 0:
        raise ValueError("est_cost_thb is negative")


def _check_team(db: Session, team_id: Optional[int], current: Optional[int] = None) -> None:
    if team_id is None or team_id == current:
        return
    t = db.get(OmTeam, team_id)
    if t is None or not t.active:
        raise ValueError(f"Team {team_id} not found")


def _check_assignees(
    db: Session, user: User, plant_id: int, ids: Iterable[int], keep: Iterable[int] = ()
) -> List[int]:
    """Assignees must be active admins or engineers assigned to the plant; an engineer may pick only
    users they can see (themselves, colleagues on their plants, admins). `keep` (already on the
    task) stay allowed, so a task can still be saved after someone lost the plant."""
    want = sorted(set(int(i) for i in ids))
    if not want:
        return []
    ok = assignable_user_ids(db, plant_id) | set(keep)
    visible = visible_user_ids(db, user)
    bad = [i for i in want if i not in ok]
    if visible is not None:
        admins = set(db.scalars(select(User.id).where(User.role == "admin")))
        bad += [i for i in want if i in ok and i not in visible and i not in admins and i not in set(keep)]
    if bad:
        raise ValueError(f"User(s) {', '.join(map(str, sorted(set(bad))))} can't be assigned to plant {plant_id}")
    return want


def _check_issue(db: Session, plant_id: int, issue_id: Optional[int], allow_shadow: bool) -> None:
    if issue_id is None:
        return
    i = db.get(GrowattIssue, issue_id)
    if i is None or i.plant_id != plant_id or (i.shadow and not allow_shadow):
        raise ValueError(f"Issue {issue_id} is not an issue of plant {plant_id}")


def _clean(s: Optional[str]) -> Optional[str]:
    return (s or "").strip() or None


# --------------------------------------------------------------------------- reading


def _jsonable(v: Any) -> Any:
    if isinstance(v, (date, datetime)):
        return v.isoformat()
    if isinstance(v, (list, tuple, set)):
        return sorted(v)
    return v


def _serialize_all(db: Session, rows: List[OmTask], allow_shadow: bool) -> List[Dict[str, Any]]:
    if not rows:
        return []
    today = _today()
    tids = [t.id for t in rows]
    pids = {t.plant_id for t in rows}
    sns = {t.device_sn for t in rows if t.device_sn}
    team_ids = {t.team_id for t in rows if t.team_id is not None}
    iids = {t.issue_id for t in rows if t.issue_id is not None}
    plants = dict(db.execute(select(GrowattPlant.plant_id, GrowattPlant.name).where(GrowattPlant.plant_id.in_(pids))).all())
    inverters: Dict[str, str] = {}
    if sns:
        for sn, alias in db.execute(select(GrowattInverter.device_sn, GrowattInverter.alias).where(GrowattInverter.device_sn.in_(sns))):
            inverters[sn] = alias or sn
    teams = {t.id: t for t in db.scalars(select(OmTeam).where(OmTeam.id.in_(team_ids)))} if team_ids else {}
    issues: Dict[int, GrowattIssue] = {}
    hidden: Set[int] = set()  # shadow issues: engineers see neither their id nor their details
    if iids:
        for i in db.scalars(select(GrowattIssue).where(GrowattIssue.id.in_(iids))):
            if allow_shadow or not i.shadow:
                issues[i.id] = i
            else:
                hidden.add(i.id)
    assignees: Dict[int, List[Dict[str, Any]]] = {}
    for tid, u in db.execute(
        select(OmTaskAssignee.task_id, User).join(User, User.id == OmTaskAssignee.user_id).where(OmTaskAssignee.task_id.in_(tids))
    ):
        assignees.setdefault(tid, []).append(_user_row(u))
    out = []
    for t in rows:
        i = issues.get(t.issue_id) if t.issue_id is not None else None
        team = teams.get(t.team_id) if t.team_id is not None else None
        out.append({
            "id": t.id,
            "busy": False,
            "plant_id": t.plant_id,
            "plant_name": plants.get(t.plant_id),
            "task_type": t.task_type,
            "label": _label(t.task_type),
            "title": t.title,
            "start_day": t.start_day.isoformat(),
            "end_day": t.end_day.isoformat(),
            "scheduled_day": t.scheduled_day.isoformat() if t.scheduled_day else None,
            "device_sn": t.device_sn,
            "inverter_name": inverters.get(t.device_sn or ""),
            "string_no": t.string_no,
            "status": t.status,
            "overdue": t.status in ACTIVE and t.end_day < today,
            "team": {"id": team.id, "name": team.name, "color": team.color} if team else None,
            "assignees": sorted(assignees.get(t.id, []), key=lambda a: (a["full_name"] or a["username"] or "").lower()),
            "issue_id": None if t.issue_id in hidden else t.issue_id,
            "issue": (
                {"id": i.id, "rule": i.rule, "status": i.status, "string_no": i.string_no, "device_sn": i.device_sn}
                if i is not None
                else None
            ),
            "est_cost_thb": t.est_cost_thb,
            "note": t.note,
            "site_event_id": t.site_event_id,
            "plan_id": t.plan_id,
            "done_at": t.done_at.isoformat() if t.done_at else None,
            "done_by": t.done_by,
            "created_by": t.created_by,
            "updated_by": t.updated_by,
            "created_at": t.created_at.isoformat() if t.created_at else None,
            "updated_at": t.updated_at.isoformat() if t.updated_at else None,
        })
    return out


def _shadow_ids(db: Session, ids: Set[int]) -> Set[int]:
    if not ids:
        return set()
    return set(db.scalars(select(GrowattIssue.id).where(GrowattIssue.id.in_(ids), GrowattIssue.shadow.is_(True))))


def _is_shadow(db: Session, issue_id: Optional[int]) -> bool:
    return issue_id is not None and bool(_shadow_ids(db, {issue_id}))


def one(db: Session, t: OmTask, allow_shadow: bool, history: bool = False) -> Dict[str, Any]:
    out = _serialize_all(db, [t], allow_shadow)[0]
    if history:
        rows = list(db.scalars(select(OmTaskHistory).where(OmTaskHistory.task_id == t.id).order_by(OmTaskHistory.id.desc())))
        hidden: Set[int] = set()
        if not allow_shadow:
            linked = {v for h in rows for v in ((h.change or {}).get("issue_id") or []) if isinstance(v, int)}
            hidden = _shadow_ids(db, linked)
        out["history"] = []
        for h in rows:
            change = dict(h.change or {})
            if hidden and any(v in hidden for v in change.get("issue_id") or []):
                change.pop("issue_id")  # a link to a shadow issue: not shown to engineers
                if not change and not h.comment:
                    continue
            out["history"].append({"at": h.at.isoformat() if h.at else None, "by": h.by, "change": change, "comment": h.comment})
    return out


def _busy_blocks(
    db: Session,
    allowed: Set[int],
    visible: Set[int],
    since: date,
    until: date,
    user_id: Optional[int],
) -> List[Dict[str, Any]]:
    """Tasks on plants outside `allowed` that are a visible user's work (assigned directly or via a
    team they are in): dates and those users only."""
    want = visible if user_id is None else visible & {user_id}
    if not want:
        return []
    # a person's work: assigned directly or through a team they are in (as `list_tasks(user_id=)`)
    teams_of: Dict[int, Set[int]] = {}
    for team_id, uid in db.execute(select(OmTeamMember.team_id, OmTeamMember.user_id).where(OmTeamMember.user_id.in_(want))):
        teams_of.setdefault(team_id, set()).add(uid)
    q = select(OmTask.id, OmTask.start_day, OmTask.end_day, OmTask.team_id).where(
        OmTask.start_day <= until,
        OmTask.end_day >= since,
        OmTask.status.in_(("planned", "in_progress", "done")),
        or_(
            OmTask.id.in_(select(OmTaskAssignee.task_id).where(OmTaskAssignee.user_id.in_(want))),
            OmTask.team_id.in_(teams_of) if teams_of else false(),
        ),
    )
    if allowed:
        q = q.where(OmTask.plant_id.not_in(allowed))
    blocks: Dict[int, Dict[str, Any]] = {}
    for tid, s, e, team_id in db.execute(q):
        blocks[tid] = {"start_day": s, "end_day": e, "uids": set(teams_of.get(team_id, set()) if team_id is not None else ())}
    if not blocks:
        return []
    for tid, uid in db.execute(
        select(OmTaskAssignee.task_id, OmTaskAssignee.user_id).where(
            OmTaskAssignee.task_id.in_(blocks), OmTaskAssignee.user_id.in_(want)
        )
    ):
        blocks[tid]["uids"].add(uid)
    uids = set().union(*(b["uids"] for b in blocks.values()))
    users = {u.id: u for u in db.scalars(select(User).where(User.id.in_(uids)))}
    out = []
    for b in sorted(blocks.values(), key=lambda b: (b["start_day"], b["end_day"])):
        out.append({
            "id": None,
            "busy": True,
            "plant_id": None,
            "plant_name": None,
            "title": "Busy",
            "label": "Busy",
            "start_day": b["start_day"].isoformat(),
            "end_day": b["end_day"].isoformat(),
            "assignees": [_user_row(users[u]) for u in sorted(b["uids"]) if u in users],
        })
    return out


def list_tasks(
    db: Session,
    user: User,
    allowed: Optional[Set[int]],
    since: date,
    until: date,
    *,
    plant_id: Optional[int] = None,
    task_type: Optional[str] = None,
    status: Optional[str] = None,
    user_id: Optional[int] = None,
    team_id: Optional[int] = None,
    overdue: bool = False,
) -> Dict[str, Any]:
    """Tasks overlapping `since` … `until` that the user may see, plus masked Busy blocks for an
    engineer (only when not narrowed to one plant or team)."""
    if until < since:
        raise ValueError("to is before from")
    if (until - since).days > MAX_RANGE_DAYS:
        raise ValueError(f"A range spans at most {MAX_RANGE_DAYS} days")
    T = OmTask
    q = select(T).where(T.start_day <= until, T.end_day >= since)
    if allowed is not None:
        q = q.where(T.plant_id.in_(allowed) if allowed else false())
    if plant_id is not None:
        q = q.where(T.plant_id == plant_id)
    if task_type:
        q = q.where(T.task_type == task_type)
    if status:
        q = q.where(T.status == status)
    if team_id is not None:
        q = q.where(T.team_id == team_id)
    if user_id is not None:  # the person's work: assigned directly or through a team they are in
        q = q.where(
            or_(
                T.id.in_(select(OmTaskAssignee.task_id).where(OmTaskAssignee.user_id == user_id)),
                T.team_id.in_(select(OmTeamMember.team_id).where(OmTeamMember.user_id == user_id)),
            )
        )
    if overdue:
        q = q.where(T.status.in_(ACTIVE), T.end_day < _today())
    rows = list(db.scalars(q.order_by(T.start_day, T.end_day, T.id)))
    tasks = _serialize_all(db, rows, allow_shadow=allowed is None)
    busy: List[Dict[str, Any]] = []
    if allowed is not None and plant_id is None and team_id is None and not (status or task_type or overdue):
        visible = visible_user_ids(db, user) or set()
        busy = _busy_blocks(db, allowed, visible, since, until, user_id)
    by_status: Dict[str, int] = {}
    for t in tasks:
        by_status[t["status"]] = by_status.get(t["status"], 0) + 1
    return {
        "from": since.isoformat(),
        "to": until.isoformat(),
        "today": _today().isoformat(),
        "total": len(tasks),
        "summary": {"by_status": by_status, "overdue": sum(1 for t in tasks if t["overdue"])},
        "tasks": tasks,
        "busy": busy,
        "types": [{"value": t, "label": _label(t)} for t in TASK_TYPES],
    }


def get_task(db: Session, plant_id: int, task_id: int) -> OmTask:
    t = db.get(OmTask, task_id)
    if t is None or t.plant_id != plant_id:
        raise GrowattNotFound(f"Task {task_id} not found")
    return t


# --------------------------------------------------------------------------- writing


def _set_assignees(db: Session, t: OmTask, ids: List[int]) -> None:
    db.execute(delete(OmTaskAssignee).where(OmTaskAssignee.task_id == t.id))
    for uid in ids:
        db.add(OmTaskAssignee(task_id=t.id, user_id=uid))


def _assignee_ids(db: Session, t: OmTask) -> List[int]:
    return sorted(db.scalars(select(OmTaskAssignee.user_id).where(OmTaskAssignee.task_id == t.id)))


def _history(db: Session, t: OmTask, who: str, change: Dict[str, Any], comment: Optional[str] = None) -> None:
    db.add(OmTaskHistory(task_id=t.id, by=who, change=change, comment=_clean(comment)))


def create_task(db: Session, user: User, plant_id: int, payload: Dict[str, Any]) -> OmTask:
    if db.get(GrowattPlant, plant_id) is None:
        raise GrowattNotFound(f"Plant {plant_id} not found")
    who = _who(user)
    start = payload["start_day"]
    end = payload.get("end_day") or start
    device_sn = payload.get("device_sn") or None
    string_no = payload.get("string_no")
    _check(db, plant_id, payload["task_type"], start, end, device_sn, string_no, payload.get("est_cost_thb"))
    _check_team(db, payload.get("team_id"))
    ids = _check_assignees(db, user, plant_id, payload.get("assignee_ids") or [])
    _check_issue(db, plant_id, payload.get("issue_id"), allow_shadow=user.role == "admin")
    from app.services import faults

    fault = faults.check_attach(db, user, payload.get("fault_id"), plant_id)
    t = OmTask(
        plant_id=plant_id,
        task_type=payload["task_type"],
        title=_clean(payload.get("title")),
        start_day=start,
        end_day=end,
        device_sn=device_sn,
        string_no=string_no,
        status="planned",
        team_id=payload.get("team_id"),
        issue_id=payload.get("issue_id"),
        est_cost_thb=payload.get("est_cost_thb"),
        note=_clean(payload.get("note")),
        created_by=who,
        updated_by=who,
    )
    db.add(t)
    db.flush()
    _set_assignees(db, t, ids)
    _history(db, t, who, {"created": {"start_day": start.isoformat(), "end_day": end.isoformat(), "task_type": t.task_type}})
    if fault is not None:  # the visit planned for a field fault: linked, the fault scheduled on its day
        faults.attach(db, fault, who, "om_task", ref_id=t.id, to_status="scheduled", next_action_day=start)
    db.commit()
    return t


_FIELDS = ("task_type", "title", "start_day", "end_day", "device_sn", "string_no", "status", "team_id", "issue_id", "est_cost_thb", "note")


def update_task(db: Session, user: User, t: OmTask, changes: Dict[str, Any], comment: Optional[str] = None) -> OmTask:
    """Change the fields present in `changes` (null clears an optional field). A done task keeps
    everything but its note: its record is the Site log event."""
    who = _who(user)
    if user.role != "admin" and "issue_id" in changes and changes["issue_id"] is None and _is_shadow(db, t.issue_id):
        changes = {k: v for k, v in changes.items() if k != "issue_id"}  # they never saw the link: keep it
    if t.status == "done" and set(changes) - {"note"}:
        raise TaskConflict("This task is done: only its note can change (edit the Site log event instead)")
    if changes.get("status") == "done":
        raise ValueError("Use the done action to finish a task")
    get = lambda k: changes[k] if k in changes else getattr(t, k)  # noqa: E731
    start = get("start_day")
    end = get("end_day")
    if end is None:
        end = start
    if "start_day" in changes and "end_day" not in changes:
        end = start + (t.end_day - t.start_day)  # moving keeps the length
    device_sn = get("device_sn") or None
    string_no = get("string_no")
    if "device_sn" in changes and not device_sn and "string_no" not in changes:
        string_no = None
    _check(db, t.plant_id, get("task_type"), start, end, device_sn, string_no, get("est_cost_thb"))
    if "team_id" in changes:
        _check_team(db, changes["team_id"], current=t.team_id)
    if "issue_id" in changes and changes["issue_id"] != t.issue_id:
        _check_issue(db, t.plant_id, changes["issue_id"], allow_shadow=user.role == "admin")

    new = {
        "task_type": get("task_type"),
        "title": _clean(get("title")),
        "start_day": start,
        "end_day": end,
        "device_sn": device_sn,
        "string_no": string_no,
        "status": get("status"),
        "team_id": get("team_id"),
        "issue_id": get("issue_id"),
        "est_cost_thb": get("est_cost_thb"),
        "note": _clean(get("note")),
    }
    diff: Dict[str, Any] = {}
    for k in _FIELDS:
        old = getattr(t, k)
        if old != new[k]:
            diff[k] = [_jsonable(old), _jsonable(new[k])]
            setattr(t, k, new[k])
    if "assignee_ids" in changes:
        old_ids = _assignee_ids(db, t)
        ids = _check_assignees(db, user, t.plant_id, changes["assignee_ids"] or [], keep=old_ids)
        if ids != old_ids:
            _set_assignees(db, t, ids)
            diff["assignee_ids"] = [old_ids, ids]
    if diff or _clean(comment):
        t.updated_by = who
        _history(db, t, who, diff, comment)
    db.commit()
    return t


def mark_done(db: Session, user: User, t: OmTask, body: Dict[str, Any]) -> OmTask:
    """Finish the task: write its Site log event (same type, real dates ≤ today) and link it."""
    if t.status not in ACTIVE:
        raise TaskConflict(f"This task is {t.status.replace('_', ' ')}: only a planned or started task can be marked done")
    today = _today()
    day = body.get("day") or min(t.start_day, today)
    end_day = body.get("end_day") or min(t.end_day, today)
    if end_day < day:
        end_day = day
    note = body.get("note") if body.get("note") is not None else t.note
    if t.title:
        note = f"{t.title}: {note}" if _clean(note) else t.title
    who = _who(user)
    issue_id = t.issue_id
    if user.role != "admin" and _is_shadow(db, issue_id):
        issue_id = None  # an engineer finishes the work; the shadow issue stays the admin's to close
    ev = site_events.create_event(
        db,
        t.plant_id,
        {
            "event_type": t.task_type,
            "day": day,
            "end_day": end_day,
            "device_sn": t.device_sn,
            "string_no": t.string_no,
            "cost_thb": body.get("cost_thb"),
            "issue_id": issue_id,
            "close_issue": bool(body.get("close_issue")) and issue_id is not None,
            "note": note,
        },
        who,
        allow_shadow=user.role == "admin",
    )
    old = t.status
    t.status = "done"
    t.site_event_id = ev.id
    t.done_at = datetime.now(timezone.utc)
    t.done_by = who
    t.updated_by = who
    _history(db, t, who, {"status": [old, "done"], "site_event_id": [None, ev.id]})
    db.commit()
    return t


def can_delete(user: User, t: OmTask) -> bool:
    return user.role == "admin" or (t.created_by == _who(user) and t.status == "planned")


def delete_task(db: Session, user: User, t: OmTask) -> None:
    if not can_delete(user, t):
        raise TaskForbidden("Only an admin, or whoever planned it while it is still planned, can delete this task")
    db.delete(t)
    db.commit()


def delete_plant_tasks(db: Session, plant_ids: Iterable[int]) -> None:
    """The blocked-plant cleanup: a removed plant's tasks go (assignees and history cascade)."""
    ids = list(plant_ids)
    if ids:
        db.execute(delete(OmTask).where(OmTask.plant_id.in_(ids)))


# --------------------------------------------------------------------------- teams


def list_teams(db: Session, include_inactive: bool = True) -> List[Dict[str, Any]]:
    q = select(OmTeam)
    if not include_inactive:
        q = q.where(OmTeam.active.is_(True))
    teams = list(db.scalars(q.order_by(OmTeam.name)))
    members: Dict[int, List[Dict[str, Any]]] = {}
    if teams:
        for tid, u in db.execute(
            select(OmTeamMember.team_id, User)
            .join(User, User.id == OmTeamMember.user_id)
            .where(OmTeamMember.team_id.in_([t.id for t in teams]))
        ):
            members.setdefault(tid, []).append(_user_row(u))
    return [
        {"id": t.id, "name": t.name, "color": t.color, "active": t.active, "members": members.get(t.id, [])}
        for t in teams
    ]


def _team_out(db: Session, t: OmTeam) -> Dict[str, Any]:
    return next(x for x in list_teams(db) if x["id"] == t.id)


def _check_members(db: Session, ids: Iterable[int]) -> List[int]:
    want = sorted(set(int(i) for i in ids))
    if not want:
        return []
    found = set(db.scalars(select(User.id).where(User.id.in_(want), User.is_active.is_(True))))
    missing = [i for i in want if i not in found]
    if missing:
        raise ValueError(f"User(s) {', '.join(map(str, missing))} not found")
    return want


def _unique_name(db: Session, name: str, team_id: Optional[int] = None) -> str:
    name = name.strip()
    if not name:
        raise ValueError("A team needs a name")
    other = db.scalar(select(OmTeam.id).where(OmTeam.name == name))
    if other is not None and other != team_id:
        raise ValueError(f"A team named {name!r} already exists")
    return name


def create_team(db: Session, payload: Dict[str, Any]) -> Dict[str, Any]:
    t = OmTeam(name=_unique_name(db, payload["name"]), color=payload.get("color"), active=payload.get("active", True))
    ids = _check_members(db, payload.get("member_ids") or [])
    db.add(t)
    db.flush()
    for uid in ids:
        db.add(OmTeamMember(team_id=t.id, user_id=uid))
    db.commit()
    return _team_out(db, t)


def update_team(db: Session, team_id: int, changes: Dict[str, Any]) -> Dict[str, Any]:
    t = db.get(OmTeam, team_id)
    if t is None:
        raise GrowattNotFound(f"Team {team_id} not found")
    if changes.get("name") is not None:
        t.name = _unique_name(db, changes["name"], team_id)
    if "color" in changes:
        t.color = changes["color"]
    if changes.get("active") is not None:
        t.active = bool(changes["active"])
    if changes.get("member_ids") is not None:
        ids = _check_members(db, changes["member_ids"])
        db.execute(delete(OmTeamMember).where(OmTeamMember.team_id == t.id))
        for uid in ids:
            db.add(OmTeamMember(team_id=t.id, user_id=uid))
    db.commit()
    return _team_out(db, t)


def delete_team(db: Session, team_id: int) -> None:
    """Remove a team; its tasks keep their assignees and lose the team (FK SET NULL)."""
    t = db.get(OmTeam, team_id)
    if t is None:
        raise GrowattNotFound(f"Team {team_id} not found")
    db.execute(update(OmTask).where(OmTask.team_id == team_id).values(team_id=None))
    db.delete(t)
    db.commit()
