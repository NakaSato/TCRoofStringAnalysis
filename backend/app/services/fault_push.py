"""Field fault notifications over the alarm push channel (docs/plans/defects.md §9).

- `faults_push` (worker; queued by the API when a fault is recorded as S1 or raised to it, and
  flushed by every `alarms` run): one notification per S1 fault to the devices of everyone who may
  see its plant (admins and the engineers assigned to it), except the person who raised it.
  `field_faults.s1_pushed_at` keeps it to once; a fault that became S1 more than `S1_MAX_AGE` ago
  is no longer pushed (push switched on later never sends a backlog).
- `om_weekly` (Monday 07:30) also sends each owner the faults they own whose next action date has
  passed (`fault_followups`; `om_push_marks` kind `fault_week`).

Only the worker sends (FIREBASE_CREDENTIALS_FILE), as for alarm pushes. Nothing is computed beyond
counting stored faults.
"""

from __future__ import annotations

import logging
from datetime import date, datetime, timedelta
from typing import Any, Dict, List, Optional, Set, Tuple

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db.models import FieldFault, GrowattPlant, PushToken, User, UserPlantAssignment
from app.services import faults, push

log = logging.getLogger(__name__)

S1_MAX_AGE = timedelta(hours=6)
BODY_LINES = 3


def _kind(f: FieldFault) -> str:
    return f.kind.replace("_", " ")


def _plant_names(db: Session, ids: Set[int]) -> Dict[int, str]:
    if not ids:
        return {}
    return {pid: n for pid, n in db.execute(select(GrowattPlant.plant_id, GrowattPlant.name).where(GrowattPlant.plant_id.in_(ids)))}


def _s1_message(f: FieldFault, plant: Optional[str]) -> Dict[str, str]:
    where = f.serial or (f.position or {}).get("location") or ""
    body = " · ".join(x for x in (f"{f.no} {_kind(f)}", where, f.symptom[:120]) if x)
    return {"title": f"S1 safety fault · {plant or f'plant {f.plant_id}'}", "body": body, "url": f"/faults?fault={f.id}", "tag": f"fault-{f.id}"}


def notify_s1(db: Session, sender: Optional[push.Sender] = None, now: Optional[datetime] = None) -> Dict[str, Any]:
    """Push the S1 faults not pushed yet (see the module docstring), then mark them."""
    now = push._utc(now)
    q = select(FieldFault).where(
        FieldFault.severity == "S1",
        FieldFault.s1_pushed_at.is_(None),
        FieldFault.s1_at.is_not(None),
        FieldFault.status.in_(faults.ACTIVE),
    )
    rows = [f for f in db.scalars(q) if now - faults._aware(f.s1_at) <= S1_MAX_AGE]  # type: ignore[operator]
    if not rows:
        return {"s1_faults": 0}
    send = push._sender(sender)
    if send is None:
        return {"s1_faults": len(rows), "skipped": "FIREBASE_CREDENTIALS_FILE is not set"}
    users: Dict[int, Tuple[str, str]] = {}  # id → (role, login name)
    tokens: Dict[int, List[str]] = {}
    for token, uid, role, name, email in db.execute(
        select(PushToken.token, User.id, User.role, User.username, User.email).join(User, User.id == PushToken.user_id).where(User.is_active.is_(True))
    ):
        tokens.setdefault(uid, []).append(token)
        users[uid] = (role, name or email)
    plant_ids = {f.plant_id for f in rows}
    assigned: Dict[int, Set[int]] = {}
    for uid, pid in db.execute(select(UserPlantAssignment.user_id, UserPlantAssignment.plant_id).where(UserPlantAssignment.plant_id.in_(plant_ids))):
        assigned.setdefault(pid, set()).add(uid)
    names = _plant_names(db, plant_ids)
    msgs: List[push.Msg] = []
    for f in rows:
        raised_by = f.updated_by or f.created_by
        data = _s1_message(f, names.get(f.plant_id))
        for uid, (role, name) in users.items():
            if name == raised_by:
                continue  # they know
            if role == "admin" or uid in assigned.get(f.plant_id, set()):
                msgs.extend(push.Msg(tok, data) for tok in tokens.get(uid, []))
    counts = push._send(db, send, msgs) if msgs else {"sent": 0, "failed": 0, "removed": 0}
    for f in rows:  # after the send: if it raised (FCM unreachable), the next run tries again
        f.s1_pushed_at = now
    db.commit()
    detail = {"s1_faults": len(rows), **counts}
    log.info("fault push: %s", detail)
    return detail


def _followup_message(items: List[FieldFault], names: Dict[int, str]) -> Dict[str, str]:
    n = len(items)
    lines = []
    for f in items[:BODY_LINES]:
        due = f.next_action_day.strftime("%d %b") if f.next_action_day else "—"
        lines.append(f"{f.no} {_kind(f)} · {names.get(f.plant_id) or f.plant_id} · due {due}")
    if n > BODY_LINES:
        lines.append(f"+{n - BODY_LINES} more")
    return {"title": f"{n} fault follow-up{'s' if n != 1 else ''} past due", "body": "\n".join(lines), "url": "/faults?overdue=1", "tag": "fault-week"}


def _scope(db: Session, uid: int) -> Optional[Set[int]]:
    """Plants the owner may see now (None = all); an inactive or gone owner: none."""
    u = db.get(User, uid)
    if u is None or not u.is_active:
        return set()
    if u.role == "admin":
        return None
    return set(db.scalars(select(UserPlantAssignment.plant_id).where(UserPlantAssignment.user_id == uid)))


def fault_followups(db: Session, monday: date, today: date, sender: Optional[push.Sender] = None, now: Optional[datetime] = None) -> Dict[str, Any]:
    """Each owner's active faults whose next action date is before `today`, one notification each
    (once per week: `om_push_marks` kind `fault_week`, day = the Monday)."""
    from app.services import om_reminders

    off = om_reminders._off(db)
    if off is not None:
        return off
    rows = list(
        db.scalars(
            select(FieldFault)
            .where(FieldFault.owner_user_id.is_not(None), FieldFault.next_action_day < today, FieldFault.status.in_(faults.ACTIVE))
            .order_by(FieldFault.next_action_day, FieldFault.id)
        )
    )
    scopes: Dict[int, Optional[Set[int]]] = {}
    by_owner: Dict[int, List[FieldFault]] = {}
    for f in rows:
        uid = int(f.owner_user_id)  # type: ignore[arg-type]
        if uid not in scopes:
            scopes[uid] = _scope(db, uid)
        allowed = scopes[uid]
        if allowed is None or f.plant_id in allowed:  # an owner who lost the plant is not told about it
            by_owner.setdefault(uid, []).append(f)
    names = _plant_names(db, {f.plant_id for f in rows})
    payloads = {uid: (_followup_message(items, names), len(items)) for uid, items in by_owner.items()}
    detail = {"faults": sum(len(v) for v in by_owner.values()), **om_reminders._deliver(db, "fault_week", monday, payloads, sender, push._utc(now))}
    log.info("fault follow-ups: %s", detail)
    return detail
