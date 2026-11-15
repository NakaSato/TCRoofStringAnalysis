"""Site events: work done on a Growatt plant (docs/plans/decision-rules.md §6).

Cleanings, repairs, module or inverter replacements, IR flights and curtailment, entered by an
engineer or admin with the plant-local date of the work, an optional inverter / string, the cost
paid (THB, null when not entered) and a note. An event can answer a decision-rule issue
(`issue_id`) and resolve it in the same step.

These are records of work, not measurements: SQL only (never Firestore), kept indefinitely.
Phase 4 measures the cleaning steps and the soiling rate from the cleaning dates.
"""

from __future__ import annotations

from datetime import date, datetime, timedelta
from typing import Any, Dict, List, Optional, Set
from zoneinfo import ZoneInfo

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db.models import GrowattInverter, GrowattIssue, GrowattPlant, SiteEvent
from app.services import growatt_issues
from app.services.growatt_common import GrowattNotFound

PLANT_TZ = ZoneInfo("Asia/Bangkok")

EVENT_TYPES = (
    "cleaning",
    "repair",
    "module_replaced",
    "inverter_replaced",
    "ir_flight",
    "curtailment",
    "other",
)
EVENT_LABELS = {
    "cleaning": "Cleaning",
    "repair": "Repair",
    "module_replaced": "Module replaced",
    "inverter_replaced": "Inverter replaced",
    "ir_flight": "IR flight",
    "curtailment": "Curtailment",
    "other": "Other",
}
MAX_SPAN_DAYS = 366


def _today() -> date:
    return datetime.now(PLANT_TZ).date()


def _plant(db: Session, plant_id: int) -> GrowattPlant:
    p = db.get(GrowattPlant, plant_id)
    if p is None:
        raise GrowattNotFound(f"Plant {plant_id} not found")
    return p


def _check(
    db: Session,
    plant_id: int,
    event_type: str,
    day: date,
    end_day: Optional[date],
    device_sn: Optional[str],
    string_no: Optional[int],
    cost_thb: Optional[float],
) -> None:
    if event_type not in EVENT_TYPES:
        raise ValueError(f"event_type must be one of {', '.join(EVENT_TYPES)}")
    if day > _today():
        raise ValueError("The date is in the future: record work once it is done")
    if end_day is not None:
        if end_day < day:
            raise ValueError("end_day is before day")
        if end_day > _today():
            raise ValueError("end_day is in the future")
        if (end_day - day).days > MAX_SPAN_DAYS:
            raise ValueError(f"An event spans at most {MAX_SPAN_DAYS} days")
    if string_no is not None and not device_sn:
        raise ValueError("A string needs its inverter (device_sn)")
    if device_sn:
        inv = db.scalar(
            select(GrowattInverter.device_sn).where(GrowattInverter.plant_id == plant_id, GrowattInverter.device_sn == device_sn)
        )
        if inv is None:
            raise ValueError(f"Inverter {device_sn} does not belong to plant {plant_id}")
    if cost_thb is not None and cost_thb < 0:
        raise ValueError("cost_thb is negative")


def _issue(db: Session, plant_id: int, issue_id: int, allow_shadow: bool) -> GrowattIssue:
    i = db.get(GrowattIssue, issue_id)
    if i is None or i.plant_id != plant_id or (i.shadow and not allow_shadow):
        raise ValueError(f"Issue {issue_id} is not an issue of plant {plant_id}")
    return i


def _resolve_issue(db: Session, i: GrowattIssue, ev: SiteEvent, username: str) -> None:
    if i.status not in growatt_issues.ACTIVE:
        return  # already closed: the link is kept, nothing to resolve
    label = EVENT_LABELS.get(ev.event_type, ev.event_type)
    note = f"{label} on {ev.day.isoformat()} (site event #{ev.id})"
    if ev.note:
        note = f"{note}: {ev.note}"
    if i.note:
        note = f"{i.note}\n{note}"
    growatt_issues.apply_action(db, i, "resolve", username, note[:2000], "confirmed")


# --------------------------------------------------------------------------- reading


def serialize(ev: SiteEvent, plants: Dict[int, str], inverters: Dict[str, str], issues: Dict[int, GrowattIssue]) -> Dict[str, Any]:
    i = issues.get(ev.issue_id) if ev.issue_id is not None else None
    return {
        "id": ev.id,
        "plant_id": ev.plant_id,
        "plant_name": plants.get(ev.plant_id),
        "event_type": ev.event_type,
        "label": EVENT_LABELS.get(ev.event_type, ev.event_type),
        "day": ev.day.isoformat(),
        "end_day": ev.end_day.isoformat() if ev.end_day else None,
        "device_sn": ev.device_sn,
        "inverter_name": inverters.get(ev.device_sn or ""),
        "string_no": ev.string_no,
        "cost_thb": ev.cost_thb,
        "issue_id": ev.issue_id,
        "issue": (
            {"id": i.id, "rule": i.rule, "status": i.status, "string_no": i.string_no, "device_sn": i.device_sn}
            if i is not None
            else None
        ),
        "note": ev.note,
        "created_by": ev.created_by,
        "updated_by": ev.updated_by,
        "created_at": ev.created_at.isoformat() if ev.created_at else None,
        "updated_at": ev.updated_at.isoformat() if ev.updated_at else None,
    }


def _serialize_all(db: Session, rows: List[SiteEvent], allow_shadow: bool) -> List[Dict[str, Any]]:
    pids = {e.plant_id for e in rows}
    sns = {e.device_sn for e in rows if e.device_sn}
    iids = {e.issue_id for e in rows if e.issue_id is not None}
    plants = dict(db.execute(select(GrowattPlant.plant_id, GrowattPlant.name).where(GrowattPlant.plant_id.in_(pids))).all()) if pids else {}
    inverters: Dict[str, str] = {}
    if sns:
        for sn, alias in db.execute(select(GrowattInverter.device_sn, GrowattInverter.alias).where(GrowattInverter.device_sn.in_(sns))):
            inverters[sn] = alias or sn
    issues: Dict[int, GrowattIssue] = {}
    if iids:
        for i in db.scalars(select(GrowattIssue).where(GrowattIssue.id.in_(iids))):
            if allow_shadow or not i.shadow:
                issues[i.id] = i
    return [serialize(e, plants, inverters, issues) for e in rows]


def list_events(
    db: Session,
    plant_ids: Optional[Set[int]],
    *,
    plant_id: Optional[int] = None,
    event_type: Optional[str] = None,
    since: Optional[date] = None,
    until: Optional[date] = None,
    device_sn: Optional[str] = None,
    limit: int = 500,
    allow_shadow: bool = False,
) -> Dict[str, Any]:
    """Events the user may see, newest first. `since` / `until` match any day the event covers."""
    E = SiteEvent
    q = select(E)
    if plant_ids is not None:
        q = q.where(E.plant_id.in_(plant_ids))
    if plant_id is not None:
        q = q.where(E.plant_id == plant_id)
    if event_type:
        q = q.where(E.event_type == event_type)
    if device_sn:
        q = q.where(E.device_sn == device_sn)
    if until is not None:
        q = q.where(E.day <= until)
    if since is not None:
        # an event covers day..end_day (end_day null = one day); filter the span in Python
        q = q.where(E.day >= since - timedelta(days=MAX_SPAN_DAYS))
    rows = list(db.scalars(q.order_by(E.day.desc(), E.id.desc())))
    if since is not None:
        rows = [e for e in rows if (e.end_day or e.day) >= since]
    total = len(rows)
    cost = [e.cost_thb for e in rows if e.cost_thb is not None]
    by_type: Dict[str, int] = {}
    for e in rows:
        by_type[e.event_type] = by_type.get(e.event_type, 0) + 1
    return {
        "total": total,
        "summary": {
            "by_type": by_type,
            "cost_thb": round(sum(cost), 2) if cost else None,
            "costed": len(cost),
        },
        "events": _serialize_all(db, rows[:limit], allow_shadow),
        "types": [{"value": t, "label": EVENT_LABELS[t]} for t in EVENT_TYPES],
    }


def get_event(db: Session, plant_id: int, event_id: int) -> SiteEvent:
    ev = db.get(SiteEvent, event_id)
    if ev is None or ev.plant_id != plant_id:
        raise GrowattNotFound(f"Event {event_id} not found")
    return ev


def one(db: Session, ev: SiteEvent, allow_shadow: bool) -> Dict[str, Any]:
    return _serialize_all(db, [ev], allow_shadow)[0]


# --------------------------------------------------------------------------- writing


def create_event(
    db: Session,
    plant_id: int,
    payload: Dict[str, Any],
    username: str,
    *,
    allow_shadow: bool = False,
) -> SiteEvent:
    """Validate and store one event; `close_issue` resolves the linked issue (feedback confirmed)."""
    _plant(db, plant_id)
    day = payload["day"]
    end_day = payload.get("end_day")
    if end_day == day:
        end_day = None
    device_sn = payload.get("device_sn") or None
    string_no = payload.get("string_no")
    cost = payload.get("cost_thb")
    _check(db, plant_id, payload["event_type"], day, end_day, device_sn, string_no, cost)
    issue = None
    if payload.get("issue_id") is not None:
        issue = _issue(db, plant_id, int(payload["issue_id"]), allow_shadow)
    elif payload.get("close_issue"):
        raise ValueError("close_issue needs issue_id")
    note = (payload.get("note") or "").strip() or None
    ev = SiteEvent(
        plant_id=plant_id,
        event_type=payload["event_type"],
        day=day,
        end_day=end_day,
        device_sn=device_sn,
        string_no=string_no,
        cost_thb=cost,
        issue_id=issue.id if issue else None,
        note=note,
        created_by=username,
        updated_by=username,
    )
    db.add(ev)
    db.flush()
    if issue is not None and payload.get("close_issue"):
        _resolve_issue(db, issue, ev, username)  # commits
    db.commit()
    return ev


def update_event(
    db: Session,
    ev: SiteEvent,
    changes: Dict[str, Any],
    username: str,
    *,
    allow_shadow: bool = False,
) -> SiteEvent:
    """Change the fields present in `changes` (null clears an optional field)."""
    get = lambda k: changes[k] if k in changes else getattr(ev, k)  # noqa: E731
    event_type = get("event_type")
    day = get("day")
    end_day = get("end_day")
    if end_day == day:
        end_day = None
    device_sn = get("device_sn") or None
    string_no = get("string_no")
    if "device_sn" in changes and not device_sn and "string_no" not in changes:
        string_no = None  # the inverter was cleared: so is its string
    cost = get("cost_thb")
    _check(db, ev.plant_id, event_type, day, end_day, device_sn, string_no, cost)
    issue = None
    if "issue_id" in changes:
        if changes["issue_id"] is not None:
            issue = _issue(db, ev.plant_id, int(changes["issue_id"]), allow_shadow)
        ev.issue_id = issue.id if issue else None
    elif ev.issue_id is not None and changes.get("close_issue"):
        issue = _issue(db, ev.plant_id, ev.issue_id, allow_shadow)
    if changes.get("close_issue") and issue is None:
        raise ValueError("close_issue needs issue_id")
    ev.event_type, ev.day, ev.end_day = event_type, day, end_day
    ev.device_sn, ev.string_no, ev.cost_thb = device_sn, string_no, cost
    if "note" in changes:
        ev.note = (changes["note"] or "").strip() or None
    ev.updated_by = username
    db.flush()
    if issue is not None and changes.get("close_issue"):
        _resolve_issue(db, issue, ev, username)
    db.commit()
    return ev


def delete_event(db: Session, ev: SiteEvent) -> None:
    """Remove the event. A resolved linked issue stays resolved (its note names the event)."""
    db.delete(ev)
    db.commit()
