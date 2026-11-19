"""Calendar Team reminders over the alarm push channel (docs/plans/calendar-team.md §9, Phase 3).

- `om_reminders` (worker, 18:00): "Tomorrow: …" to each person with planned work starting
  tomorrow: one notification per person (one task, or a count with the first few).
- `om_weekly` (worker, Monday 07:30): "This week: N tasks" per person, with their overdue count.

A person's work = tasks they are assigned to, directly or through a team they are a member of, on
plants they may see (admin: every plant; engineer: their assigned plants). Only users with a
device registered for push get anything; push is off while it is not configured (`push.web_config`).
`om_push_marks` keeps one row per person, kind and day so a re-run never pushes twice. Plans, not
measurements: nothing is computed beyond counting the stored tasks.
"""

from __future__ import annotations

import logging
from datetime import date, datetime, timedelta
from typing import Any, Dict, List, Optional, Set, Tuple

from sqlalchemy import delete, func, select
from sqlalchemy.orm import Session

from app.db.models import (
    GrowattPlant,
    OmPushMark,
    OmTask,
    OmTaskAssignee,
    OmTeamMember,
    PushToken,
    User,
    UserPlantAssignment,
)
from app.services import om_calendar as cal
from app.services import push

log = logging.getLogger(__name__)

BODY_LINES = 3
KEEP_MARKS_DAYS = 14


def _people(db: Session, tasks: List[OmTask]) -> Dict[int, List[OmTask]]:
    """user id → the tasks of `tasks` that are theirs (direct or team) on plants they may see;
    only active users with a push device."""
    if not tasks:
        return {}
    tids = [t.id for t in tasks]
    team_ids = {t.team_id for t in tasks if t.team_id is not None}
    direct: Dict[int, Set[int]] = {}
    for tid, uid in db.execute(select(OmTaskAssignee.task_id, OmTaskAssignee.user_id).where(OmTaskAssignee.task_id.in_(tids))):
        direct.setdefault(tid, set()).add(uid)
    members: Dict[int, Set[int]] = {}
    if team_ids:
        for team_id, uid in db.execute(select(OmTeamMember.team_id, OmTeamMember.user_id).where(OmTeamMember.team_id.in_(team_ids))):
            members.setdefault(team_id, set()).add(uid)
    want: Dict[int, Set[int]] = {}
    for t in tasks:
        uids = set(direct.get(t.id, set()))
        if t.team_id is not None:
            uids |= members.get(t.team_id, set())
        for uid in uids:
            want.setdefault(uid, set()).add(t.id)
    if not want:
        return {}
    with_device = set(db.scalars(select(PushToken.user_id).where(PushToken.user_id.in_(want)).distinct()))
    users = {
        u.id: u
        for u in db.scalars(select(User).where(User.id.in_(with_device), User.is_active.is_(True)))
    } if with_device else {}
    engineers = [uid for uid, u in users.items() if u.role != "admin"]
    assigned: Dict[int, Set[int]] = {uid: set() for uid in engineers}
    if engineers:
        for uid, pid in db.execute(
            select(UserPlantAssignment.user_id, UserPlantAssignment.plant_id).where(UserPlantAssignment.user_id.in_(engineers))
        ):
            assigned[uid].add(pid)
    by_id = {t.id: t for t in tasks}
    out: Dict[int, List[OmTask]] = {}
    for uid, u in users.items():
        mine = [by_id[tid] for tid in want[uid] if u.role == "admin" or by_id[tid].plant_id in assigned[uid]]
        if mine:
            out[uid] = sorted(mine, key=lambda t: (t.start_day, t.end_day, t.id))
    return out


def _plant_names(db: Session, tasks: List[OmTask]) -> Dict[int, str]:
    pids = {t.plant_id for t in tasks}
    if not pids:
        return {}
    return dict(db.execute(select(GrowattPlant.plant_id, GrowattPlant.name).where(GrowattPlant.plant_id.in_(pids))).all())


def _what(t: OmTask, names: Dict[int, str]) -> str:
    return f"{cal._label(t.task_type)} · {names.get(t.plant_id) or f'Plant {t.plant_id}'}"


def _lines(items: List[str]) -> str:
    out = items[:BODY_LINES]
    if len(items) > BODY_LINES:
        out.append(f"+{len(items) - BODY_LINES} more")
    return "\n".join(out)


def _tomorrow_message(tasks: List[OmTask], names: Dict[int, str], day: date) -> Dict[str, str]:
    url = f"/calendar?view=list&d={day.isoformat()}&user=me"
    if len(tasks) == 1:
        t = tasks[0]
        parts = [t.title] if t.title else []
        days = (t.end_day - t.start_day).days + 1
        if days > 1:
            parts.append(f"{days} days, until {t.end_day:%a %d %b}")
        return {"title": f"Tomorrow: {_what(t, names)}", "body": "\n".join(parts), "url": url, "tag": "om-tomorrow"}
    return {
        "title": f"Tomorrow: {len(tasks)} tasks",
        "body": _lines([_what(t, names) for t in tasks]),
        "url": url,
        "tag": "om-tomorrow",
    }


def _week_message(tasks: List[OmTask], overdue: int, names: Dict[int, str], monday: date) -> Dict[str, str]:
    title = f"This week: {len(tasks)} task{'' if len(tasks) == 1 else 's'}"
    if overdue:
        title += f", {overdue} overdue"
    lines = [f"{max(t.start_day, monday):%a %d} · {_what(t, names)}" for t in tasks]
    return {
        "title": title,
        "body": _lines(lines),
        "url": f"/calendar?view=week&d={monday.isoformat()}&user=me",
        "tag": "om-week",
    }


def _deliver(
    db: Session,
    kind: str,
    day: date,
    payloads: Dict[int, Tuple[Dict[str, str], int]],
    sender: Optional[push.Sender],
    now: datetime,
) -> Dict[str, Any]:
    """Send each user's payload to their devices unless already pushed for (`kind`, `day`), then mark."""
    done = set(db.scalars(select(OmPushMark.user_id).where(OmPushMark.kind == kind, OmPushMark.day == day)))
    todo = {uid: p for uid, p in payloads.items() if uid not in done}
    detail: Dict[str, Any] = {"day": day.isoformat(), "people": len(todo), "already": len(payloads) - len(todo)}
    if not todo:
        return {**detail, "sent": 0, "failed": 0, "removed": 0}
    send = push._sender(sender)
    if send is None:
        return {**detail, "skipped": "FIREBASE_CREDENTIALS_FILE is not set"}
    tokens: Dict[int, List[str]] = {}
    for uid, token in db.execute(select(PushToken.user_id, PushToken.token).where(PushToken.user_id.in_(todo))):
        tokens.setdefault(uid, []).append(token)
    msgs = [push.Msg(tok, data) for uid, (data, _) in todo.items() for tok in tokens.get(uid, [])]
    counts = push._send(db, send, msgs) if msgs else {"sent": 0, "failed": 0, "removed": 0}
    # after the send: if it raised (FCM unreachable), the next run tries again
    for uid, (_, n) in todo.items():
        db.add(OmPushMark(user_id=uid, kind=kind, day=day, tasks=n, pushed_at=now))
    db.commit()
    return {**detail, **counts}


def _off(db: Session) -> Optional[Dict[str, Any]]:
    if push.web_config() is None:
        return {"skipped": "push is not configured"}
    if not int(db.scalar(select(func.count()).select_from(PushToken)) or 0):
        return {"devices": 0}
    return None


def notify_tomorrow(
    db: Session, sender: Optional[push.Sender] = None, now: Optional[datetime] = None, today: Optional[date] = None
) -> Dict[str, Any]:
    """Planned tasks starting tomorrow → one notification per person."""
    today = today or cal._today()
    day = today + timedelta(days=1)
    off = _off(db)
    if off is not None:
        return {"day": day.isoformat(), **off}
    tasks = list(db.scalars(select(OmTask).where(OmTask.start_day == day, OmTask.status == "planned")))
    people = _people(db, tasks)
    names = _plant_names(db, tasks)
    payloads = {uid: (_tomorrow_message(ts, names, day), len(ts)) for uid, ts in people.items()}
    detail = {"tasks": len(tasks), **_deliver(db, "tomorrow", day, payloads, sender, push._utc(now))}
    prune(db, today)
    log.info("om reminders: %s", detail)
    return detail


def notify_week(
    db: Session, sender: Optional[push.Sender] = None, now: Optional[datetime] = None, today: Optional[date] = None
) -> Dict[str, Any]:
    """This week's (Monday … Sunday) planned / started tasks and the overdue ones → one summary per person."""
    today = today or cal._today()
    monday = today - timedelta(days=today.weekday())
    sunday = monday + timedelta(days=6)
    off = _off(db)
    if off is not None:
        return {"day": monday.isoformat(), **off}
    week = list(
        db.scalars(
            select(OmTask).where(OmTask.start_day <= sunday, OmTask.end_day >= monday, OmTask.status.in_(cal.ACTIVE))
        )
    )
    late = list(db.scalars(select(OmTask).where(OmTask.end_day < monday, OmTask.status.in_(cal.ACTIVE))))
    in_week = _people(db, week)
    overdue = {uid: len(ts) for uid, ts in _people(db, late).items()}
    names = _plant_names(db, week)
    payloads = {
        uid: (_week_message(in_week.get(uid, []), overdue.get(uid, 0), names, monday), len(in_week.get(uid, [])))
        for uid in set(in_week) | set(overdue)
    }
    detail = {"tasks": len(week), "overdue": len(late), **_deliver(db, "week", monday, payloads, sender, push._utc(now))}
    log.info("om weekly summary: %s", detail)
    return detail


def prune(db: Session, today: date) -> int:
    n = getattr(
        db.execute(delete(OmPushMark).where(OmPushMark.day < today - timedelta(days=KEEP_MARKS_DAYS))), "rowcount", 0
    ) or 0
    db.commit()
    return n
