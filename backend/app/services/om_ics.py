"""Calendar Team: a read-only ICS feed per user (docs/plans/calendar-team.md, Phase 3).

A user turns the feed on and gets a secret URL (`/api/ics/calendar/{token}.ics`) to subscribe to
from Google Calendar, Outlook or Apple Calendar. No login is sent by those apps, so the secret in
the URL is the only key: only its SHA-256 is stored (`om_ics_feeds`), the link is shown once, and
a new link or turning the feed off makes the old one stop working at once.

The feed holds the user's own work: tasks they are assigned to, directly or through a team they
are a member of, on plants they may see now (checked on every read, so a removed plant drops out),
from `PAST_DAYS` ago to `AHEAD_DAYS` ahead, not cancelled. All-day events in plant-local days.
Plans only; nothing is written to the calendar apps beyond what they read.
"""

from __future__ import annotations

import hashlib
import secrets
from datetime import date, datetime, timedelta, timezone
from typing import Any, Dict, List, Optional

from sqlalchemy import or_, select
from sqlalchemy.orm import Session

from app.db.models import OmIcsFeed, OmTask, OmTaskAssignee, OmTeamMember, User, UserPlantAssignment
from app.services import om_calendar as cal

PAST_DAYS = 30
AHEAD_DAYS = 180
PRODID = "-//TC Roof Solar//Calendar Team//EN"
CAL_NAME = "TC Roof O&M"
TOUCH_EVERY = timedelta(hours=1)  # last_used_at is written at most this often


def _hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def _utc(dt: Optional[datetime]) -> Optional[datetime]:
    """SQLite drops tzinfo: the stored value is UTC."""
    if dt is None:
        return None
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def status(db: Session, user: User) -> Dict[str, Any]:
    row = db.get(OmIcsFeed, user.id)
    created, used = (_utc(row.created_at), _utc(row.last_used_at)) if row else (None, None)
    return {
        "enabled": row is not None,
        "created_at": created.isoformat() if created else None,
        "last_used_at": used.isoformat() if used else None,
        "past_days": PAST_DAYS,
        "ahead_days": AHEAD_DAYS,
    }


def new_link(db: Session, user: User) -> str:
    """Create or replace the user's feed secret; returns the token (shown once)."""
    token = secrets.token_urlsafe(24)
    row = db.get(OmIcsFeed, user.id)
    now = datetime.now(timezone.utc)
    if row is None:
        db.add(OmIcsFeed(user_id=user.id, token_hash=_hash(token), created_at=now))
    else:
        row.token_hash, row.created_at, row.last_used_at = _hash(token), now, None
    db.commit()
    return token


def turn_off(db: Session, user: User) -> None:
    row = db.get(OmIcsFeed, user.id)
    if row is not None:
        db.delete(row)
        db.commit()


def user_for(db: Session, token: str) -> Optional[User]:
    """The active user whose feed this token opens, or None."""
    if not token or len(token) > 128:
        return None
    row = db.scalar(select(OmIcsFeed).where(OmIcsFeed.token_hash == _hash(token)))
    if row is None:
        return None
    user = db.get(User, row.user_id)
    if user is None or not user.is_active:
        return None
    now = datetime.now(timezone.utc)
    last = row.last_used_at
    if last is None or now - _utc(last) >= TOUCH_EVERY:  # type: ignore[operator]
        row.last_used_at = now
        db.commit()
    return user


def _my_tasks(db: Session, user: User, since: date, until: date) -> List[OmTask]:
    mine = select(OmTaskAssignee.task_id).where(OmTaskAssignee.user_id == user.id)
    teams = select(OmTeamMember.team_id).where(OmTeamMember.user_id == user.id)
    q = select(OmTask).where(
        OmTask.start_day <= until,
        OmTask.end_day >= since,
        OmTask.status != "cancelled",
        or_(OmTask.id.in_(mine), OmTask.team_id.in_(teams)),
    )
    if user.role != "admin":
        q = q.where(OmTask.plant_id.in_(select(UserPlantAssignment.plant_id).where(UserPlantAssignment.user_id == user.id)))
    return list(db.scalars(q.order_by(OmTask.start_day, OmTask.id)))


def _esc(s: str) -> str:
    return s.replace("\\", "\\\\").replace(";", "\\;").replace(",", "\\,").replace("\r\n", "\\n").replace("\n", "\\n")


def _fold(line: str) -> List[str]:
    """RFC 5545 §3.1: lines of at most 75 octets, continued with a leading space."""
    out: List[str] = []
    raw = line.encode()
    while len(raw) > (75 if not out else 74):  # a continuation line is 74 octets + its leading space
        cut = 75 if not out else 74
        while cut > 0 and (raw[cut] & 0xC0) == 0x80:  # don't split a UTF-8 character
            cut -= 1
        out.append(raw[:cut].decode())
        raw = raw[cut:]
    out.append(raw.decode())
    return [out[0]] + [" " + p for p in out[1:]]


def _stamp(dt: Optional[datetime]) -> str:
    dt = _utc(dt) or datetime.now(timezone.utc)
    return dt.astimezone(timezone.utc).strftime("%Y%m%dT%H%M%SZ")


STATUS_TEXT = {"planned": "Planned", "in_progress": "In progress", "done": "Done", "skipped": "Skipped"}


def build(db: Session, user: User, base_url: str, today: Optional[date] = None) -> str:
    today = today or cal._today()
    tasks = _my_tasks(db, user, today - timedelta(days=PAST_DAYS), today + timedelta(days=AHEAD_DAYS))
    rows = {r["id"]: r for r in cal._serialize_all(db, tasks, allow_shadow=user.role == "admin")} if tasks else {}
    lines = [
        "BEGIN:VCALENDAR",
        "VERSION:2.0",
        f"PRODID:{PRODID}",
        "CALSCALE:GREGORIAN",
        "METHOD:PUBLISH",
        f"X-WR-CALNAME:{CAL_NAME}",
        "X-WR-TIMEZONE:Asia/Bangkok",
        "REFRESH-INTERVAL;VALUE=DURATION:PT1H",
        "X-PUBLISHED-TTL:PT1H",
    ]
    for t in tasks:
        r = rows[t.id]
        plant = r["plant_name"] or f"Plant {t.plant_id}"
        summary = f"{r['label']} · {plant}" + (f": {t.title}" if t.title else "")
        if t.status in ("done", "skipped"):
            summary = f"[{STATUS_TEXT[t.status]}] {summary}"
        desc = [f"Status: {STATUS_TEXT.get(t.status, t.status)}" + (" (overdue)" if r["overdue"] else "")]
        if r["inverter_name"]:
            desc.append(f"Inverter: {r['inverter_name']}" + (f", string {t.string_no}" if t.string_no else ""))
        if r["team"]:
            desc.append(f"Team: {r['team']['name']}")
        if r["assignees"]:
            desc.append("Assigned: " + ", ".join(a["full_name"] or a["username"] for a in r["assignees"]))
        if t.note:
            desc.append(t.note)
        url = f"{base_url}/calendar?view=list&d={t.start_day.isoformat()}&plant={t.plant_id}"
        desc.append(url)
        lines += [
            "BEGIN:VEVENT",
            f"UID:om-task-{t.id}@tcroof",
            f"DTSTAMP:{_stamp(t.updated_at)}",
            f"LAST-MODIFIED:{_stamp(t.updated_at)}",
            f"DTSTART;VALUE=DATE:{t.start_day:%Y%m%d}",
            f"DTEND;VALUE=DATE:{t.end_day + timedelta(days=1):%Y%m%d}",
            f"SUMMARY:{_esc(summary)}",
            f"DESCRIPTION:{_esc(chr(10).join(desc))}",
            f"URL:{url}",
            "TRANSP:TRANSPARENT",
            f"STATUS:{'CONFIRMED' if t.status != 'skipped' else 'CANCELLED'}",
            "END:VEVENT",
        ]
    lines.append("END:VCALENDAR")
    return "\r\n".join(part for line in lines for part in _fold(line)) + "\r\n"


