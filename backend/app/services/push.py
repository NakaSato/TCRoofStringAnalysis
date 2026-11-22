"""Alarm push notifications over Firebase Cloud Messaging (web push).

The worker's `alarms` job calls `notify_new_alarms` after each sync: alarm events that are new
in the stored alarm log (`growatt_alarms`, Growatt's own start times: history, not realtime
values) go to the devices of the users who may see the plant (admins: every plant, engineers:
their assigned plants). Nothing is measured, modelled or stored here beyond bookkeeping:
`push_tokens` (who gets pushes where) and `alarm_push_marks` (what was already pushed).

- Push is off until the Firebase web app config is set (`web_config`); the UI hides its button.
- Only the worker sends (it has FIREBASE_CREDENTIALS_FILE). The API registers tokens and, for
  "Send test", flags them and queues the `push_test` job.
- Messages are data-only: the app's own service worker (`firebase-messaging-sw.js`) shows them.
- Tokens are never logged. A token FCM reports as gone is deleted.
"""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from typing import Any, Callable, Dict, List, Optional, Set, Tuple
from zoneinfo import ZoneInfo

from sqlalchemy import delete, func, select
from sqlalchemy.orm import Session

from app.config import settings
from app.db.models import (
    AlarmPushMark,
    GrowattAlarm,
    GrowattAlarmSync,
    GrowattInverter,
    GrowattPlant,
    PushToken,
    User,
    UserPlantAssignment,
    inverter_installed,
)

log = logging.getLogger(__name__)

PLANT_TZ = ZoneInfo("Asia/Bangkok")
GONE = "gone"  # sender result: FCM no longer knows the token
TTL_S = 3600  # a device offline longer than this does not get the push late
BATCH = 500  # FCM `send_each` limit
MAX_DEVICES_PER_USER = 10
TEST_MAX_AGE = timedelta(minutes=10)  # a test asked for longer ago (worker was down) is dropped
# Growatt re-reports a present alarm every ~5 min: records this close are one event
# (growatt_alarms.ONGOING_GAP, frontend EVENT_GAP_MIN)
EVENT_GAP = timedelta(minutes=10)
BODY_LINES = 3
LEVELS = ("fault", "warning", "info")


@dataclass(frozen=True)
class Msg:
    token: str
    data: Dict[str, str]


# one result per message: None = accepted, GONE = token no longer registered, else an error name
Sender = Callable[[List[Msg]], List[Optional[str]]]


class PushError(ValueError):
    """Invalid request (push not configured, no device registered)."""


# ---- configuration -----------------------------------------------------------------------------


def web_config() -> Optional[Dict[str, str]]:
    """The Firebase web app config the browser needs to get an FCM token (public values), or
    None while any part is missing = push off."""
    cfg = {
        "apiKey": settings.firebase_web_api_key,
        "appId": settings.firebase_web_app_id,
        "messagingSenderId": settings.firebase_messaging_sender_id,
        "projectId": settings.firebase_project_id,
    }
    if not all(cfg.values()) or not settings.firebase_vapid_key:
        return None
    return cfg


def levels() -> List[str]:
    """Alarm levels that are pushed (`PUSH_ALARM_LEVELS`), in severity order."""
    chosen = {p.strip().lower() for p in settings.push_alarm_levels.split(",")}
    return [lvl for lvl in LEVELS if lvl in chosen]


def level_of(fault_type: Optional[str]) -> str:
    """Growatt's `fault_type` label → level (same rule as the UI's `alarmLevel`)."""
    s = (fault_type or "").lower()
    if re.search(r"fault|error|fail", s):
        return "fault"
    return "warning" if "warn" in s else "info"


def status(db: Session, user: User) -> Dict[str, Any]:
    cfg = web_config()
    return {
        "enabled": cfg is not None,
        "config": cfg,
        "vapid_key": settings.firebase_vapid_key if cfg else None,
        "levels": levels(),
        "devices": _device_count(db, user.id),
    }


def _utc(now: Optional[datetime]) -> datetime:
    """Bookkeeping times are stored as UTC (SQLite drops the zone, so nothing else is safe)."""
    return (now or datetime.now(timezone.utc)).astimezone(timezone.utc)


# ---- tokens ------------------------------------------------------------------------------------


def _device_count(db: Session, user_id: int) -> int:
    return int(db.scalar(select(func.count()).select_from(PushToken).where(PushToken.user_id == user_id)) or 0)


def register_token(db: Session, user: User, token: str, label: Optional[str], now: Optional[datetime] = None) -> int:
    """Store this browser's token for `user` (moving it from another user) and return the user's
    device count. The user's oldest devices beyond `MAX_DEVICES_PER_USER` are dropped."""
    if web_config() is None:
        raise PushError("Push notifications are not configured.")
    now = _utc(now)
    row = db.scalar(select(PushToken).where(PushToken.token == token))
    if row is None:
        db.add(PushToken(user_id=user.id, token=token, label=label, created_at=now, last_seen_at=now))
    else:
        row.user_id, row.label, row.last_seen_at = user.id, label, now
    db.flush()
    extra = list(
        db.scalars(
            select(PushToken.id)
            .where(PushToken.user_id == user.id)
            .order_by(PushToken.last_seen_at.desc(), PushToken.id.desc())
            .offset(MAX_DEVICES_PER_USER)
        )
    )
    if extra:
        db.execute(delete(PushToken).where(PushToken.id.in_(extra)))
    db.commit()
    return _device_count(db, user.id)


def remove_token(db: Session, user: User, token: str) -> int:
    """Forget this browser's token (only the user's own) and return the user's device count."""
    db.execute(delete(PushToken).where(PushToken.token == token, PushToken.user_id == user.id))
    db.commit()
    return _device_count(db, user.id)


def request_test(db: Session, user: User, now: Optional[datetime] = None) -> int:
    """Flag the user's devices for a test notification (sent by the worker); returns how many."""
    if web_config() is None:
        raise PushError("Push notifications are not configured.")
    rows = list(db.scalars(select(PushToken).where(PushToken.user_id == user.id)))
    if not rows:
        raise PushError("No device has notifications turned on for this account.")
    now = _utc(now)
    for r in rows:
        r.test_requested_at = now
    db.commit()
    return len(rows)


# ---- sending -----------------------------------------------------------------------------------


def firebase_sender() -> Sender:
    """FCM through the Admin SDK as the service account (worker only)."""
    import firebase_admin
    from firebase_admin import credentials, messaging

    try:
        app = firebase_admin.get_app("push")
    except ValueError:
        opts = {"projectId": settings.firebase_project_id} if settings.firebase_project_id else None
        app = firebase_admin.initialize_app(credentials.Certificate(settings.firebase_credentials_file), opts, name="push")
    webpush = messaging.WebpushConfig(headers={"Urgency": "high", "TTL": str(TTL_S)})

    def send(msgs: List[Msg]) -> List[Optional[str]]:
        out: List[Optional[str]] = []
        for i in range(0, len(msgs), BATCH):
            batch = [messaging.Message(token=m.token, data=m.data, webpush=webpush) for m in msgs[i : i + BATCH]]
            for r in messaging.send_each(batch, app=app).responses:
                if r.success:
                    out.append(None)
                elif isinstance(r.exception, (messaging.UnregisteredError, messaging.SenderIdMismatchError)):
                    out.append(GONE)
                else:
                    out.append(type(r.exception).__name__)
        return out

    return send


def _sender(sender: Optional[Sender]) -> Optional[Sender]:
    if sender is not None:
        return sender
    return firebase_sender() if settings.firebase_credentials_file else None


def _send(db: Session, sender: Sender, msgs: List[Msg]) -> Dict[str, int]:
    """Send, delete the tokens FCM no longer knows, and count the outcomes."""
    return _send_each(db, sender, msgs)[0]


def _send_each(db: Session, sender: Sender, msgs: List[Msg]) -> Tuple[Dict[str, int], List[Optional[str]]]:
    """As `_send`, plus each message's result (None = accepted, GONE, else an error name)."""
    results = sender(msgs)
    gone = {m.token for m, r in zip(msgs, results) if r == GONE}
    if gone:
        db.execute(delete(PushToken).where(PushToken.token.in_(gone)))
        db.commit()
    failed = [r for r in results if r not in (None, GONE)]
    if failed:
        log.warning("push: %d of %d messages failed (%s)", len(failed), len(msgs), ", ".join(sorted(set(failed))))
    return {"sent": sum(1 for r in results if r is None), "failed": len(failed), "removed": len(gone)}, results


# ---- new alarm events --------------------------------------------------------------------------


@dataclass
class Event:
    plant_id: int
    device_sn: str
    code: str  # "" = Growatt gave no code
    message: Optional[str]
    fault_type: Optional[str]
    start: datetime  # plant-local, as Growatt reports it
    last: datetime
    reports: int


def _latest_events(rows: List[GrowattAlarm]) -> List[Event]:
    """The newest event of each inverter + code: its records ≤ `EVENT_GAP` apart, from rows
    ordered by inverter, code and start time."""
    latest: Dict[Tuple[str, str], Event] = {}
    for a in rows:
        if a.start_time is None:
            continue
        key = (a.device_sn, a.alarm_code or "")
        ev = latest.get(key)
        if ev is not None and a.start_time - ev.last <= EVENT_GAP:
            ev.last, ev.reports = a.start_time, ev.reports + 1
            ev.message, ev.fault_type = a.alarm_message or ev.message, a.fault_type or ev.fault_type
        else:
            latest[key] = Event(a.plant_id, a.device_sn, key[1], a.alarm_message, a.fault_type, a.start_time, a.start_time, 1)
    return list(latest.values())


def _fresh_events(db: Session, day: date, sns: List[str], now: datetime) -> List[Event]:
    """Events of the inverters just read that nobody was told about: of a pushed level, still
    reported within `push_alarm_max_age_min`, newer than the inverter + code's last push, and
    that push at least `push_alarm_repeat_min` ago."""
    if not sns:
        return []
    wanted = set(levels())
    rows = list(
        db.scalars(
            select(GrowattAlarm)
            .where(GrowattAlarm.day == day, GrowattAlarm.device_sn.in_(sns))
            .order_by(GrowattAlarm.device_sn, GrowattAlarm.alarm_code, GrowattAlarm.start_time)
        )
    )
    marks = {
        (m.device_sn, m.alarm_code): m
        for m in db.scalars(select(AlarmPushMark).where(AlarmPushMark.day == day, AlarmPushMark.device_sn.in_(sns)))
    }
    now_local = now.astimezone(PLANT_TZ).replace(tzinfo=None)
    oldest = now_local - timedelta(minutes=settings.push_alarm_max_age_min)
    repeat = timedelta(minutes=settings.push_alarm_repeat_min)
    fresh = []
    for ev in _latest_events(rows):
        if level_of(ev.fault_type) not in wanted or ev.last < oldest:
            continue
        mark = marks.get((ev.device_sn, ev.code))
        if mark is not None:
            pushed_at = mark.pushed_at if mark.pushed_at.tzinfo else mark.pushed_at.replace(tzinfo=timezone.utc)
            if ev.start <= mark.event_start or now - pushed_at < repeat:
                continue
        fresh.append(ev)
    return fresh


def _mark(db: Session, day: date, events: List[Event], now: datetime) -> None:
    for ev in events:
        mark = db.get(AlarmPushMark, (ev.device_sn, ev.code, day))
        if mark is None:
            db.add(AlarmPushMark(device_sn=ev.device_sn, alarm_code=ev.code, day=day, event_start=ev.start, pushed_at=now))
        else:
            mark.event_start, mark.pushed_at = ev.start, now
    db.commit()


def _recipients(db: Session) -> List[Tuple[Optional[Set[int]], List[str]]]:
    """Per active user with a device: (plants they may see, None = all; their tokens)."""
    tokens: Dict[int, List[str]] = {}
    roles: Dict[int, str] = {}
    for token, uid, role in db.execute(
        select(PushToken.token, User.id, User.role).join(User, User.id == PushToken.user_id).where(User.is_active.is_(True))
    ):
        tokens.setdefault(uid, []).append(token)
        roles[uid] = role
    engineers = [uid for uid, role in roles.items() if role != "admin"]
    assigned: Dict[int, Set[int]] = {uid: set() for uid in engineers}
    if engineers:
        for uid, pid in db.execute(
            select(UserPlantAssignment.user_id, UserPlantAssignment.plant_id).where(UserPlantAssignment.user_id.in_(engineers))
        ):
            assigned[uid].add(pid)
    return [(None if roles[uid] == "admin" else assigned[uid], toks) for uid, toks in tokens.items()]


def _plant_messages(db: Session, events: List[Event]) -> Dict[int, Tuple[str, Dict[str, str]]]:
    """plant_id → (plant name, notification) for the plants with fresh events."""
    from app.services.daily_checks import inverter_label

    by_plant: Dict[int, List[Event]] = {}
    for ev in events:
        by_plant.setdefault(ev.plant_id, []).append(ev)
    names = dict(db.execute(select(GrowattPlant.plant_id, GrowattPlant.name).where(GrowattPlant.plant_id.in_(by_plant))).all())
    inverters: Dict[int, List[GrowattInverter]] = {}
    # installed only, so a plant's sole real inverter still reads "INV1" next to a marked one
    for inv in db.scalars(select(GrowattInverter).where(GrowattInverter.plant_id.in_(by_plant), inverter_installed())):
        inverters.setdefault(inv.plant_id, []).append(inv)

    out: Dict[int, Tuple[str, Dict[str, str]]] = {}
    for pid, evs in by_plant.items():
        invs = inverters.get(pid, [])
        label = {i.device_sn: inverter_label(i, sole=len(invs) == 1) for i in invs}
        evs.sort(key=lambda e: (level_of(e.fault_type) != "fault", e.start, e.device_sn))
        lines = [
            " ".join(
                p
                for p in (
                    label.get(e.device_sn, e.device_sn),
                    f"{e.fault_type or 'Alarm'}:",
                    e.code,
                    e.message or "",
                    f"({e.start:%H:%M})",
                )
                if p
            )
            for e in evs[:BODY_LINES]
        ]
        if len(evs) > BODY_LINES:
            lines.append(f"+{len(evs) - BODY_LINES} more")
        name = names.get(pid) or f"Plant {pid}"
        out[pid] = (
            name,
            {"title": f"Alarm · {name}", "body": "\n".join(lines), "url": f"/alarms?plant={pid}", "tag": f"plant-{pid}"},
        )
    return out


def _summary(names: List[str]) -> Dict[str, str]:
    shown = ", ".join(names[:BODY_LINES])
    more = f" +{len(names) - BODY_LINES} more" if len(names) > BODY_LINES else ""
    return {"title": f"New alarms at {len(names)} plants", "body": shown + more, "url": "/alarms", "tag": "fleet"}


def notify_new_alarms(
    db: Session, day: date, since: datetime, sender: Optional[Sender] = None, now: Optional[datetime] = None
) -> Dict[str, Any]:
    """Push the alarm events that are new in the inverter logs read since `since` (UTC, the
    `alarms` run's start). One notification per plant and device; a user with more than
    `push_max_plants_per_user` plants in one run gets one summary instead."""
    devices = int(db.scalar(select(func.count()).select_from(PushToken)) or 0)
    if not devices:
        return {"devices": 0}
    send = _sender(sender)
    if send is None:
        return {"devices": devices, "skipped": "FIREBASE_CREDENTIALS_FILE is not set"}
    now = _utc(now)
    sns = list(
        db.scalars(select(GrowattAlarmSync.device_sn).where(GrowattAlarmSync.day == day, GrowattAlarmSync.synced_at >= since))
    )
    fresh = _fresh_events(db, day, sns, now)
    if not fresh:
        return {"devices": devices, "events": 0}

    plants = _plant_messages(db, fresh)
    msgs: List[Msg] = []
    for allowed, tokens in _recipients(db):
        mine = sorted(pid for pid in plants if allowed is None or pid in allowed)
        if not mine:
            continue
        if len(mine) > settings.push_max_plants_per_user:
            payloads = [_summary(sorted(plants[pid][0] for pid in mine))]
        else:
            payloads = [plants[pid][1] for pid in mine]
        msgs.extend(Msg(token, data) for token in tokens for data in payloads)

    counts = _send(db, send, msgs) if msgs else {"sent": 0, "failed": 0, "removed": 0}
    # after the send: if it raised (FCM unreachable), the next run tries these events again
    _mark(db, day, fresh, now)
    detail = {"devices": devices, "events": len(fresh), "plants": len(plants), **counts}
    log.info("push: %(events)d new alarm events at %(plants)d plants, %(sent)d sent, %(failed)d failed, %(removed)d tokens removed", detail)
    return detail


def send_tests(db: Session, sender: Optional[Sender] = None, now: Optional[datetime] = None) -> Dict[str, Any]:
    """Send the test notifications asked for with POST /push/test and clear the requests."""
    rows = list(
        db.scalars(
            select(PushToken)
            .join(User, User.id == PushToken.user_id)
            .where(PushToken.test_requested_at.is_not(None), User.is_active.is_(True))
        )
    )
    if not rows:
        return {"tests": 0}
    now = _utc(now)
    send = _sender(sender)
    due = []
    for r in rows:
        asked = r.test_requested_at
        assert asked is not None
        if now - (asked if asked.tzinfo else asked.replace(tzinfo=timezone.utc)) <= TEST_MAX_AGE:
            due.append(r.token)
        r.test_requested_at = None
    db.commit()
    if send is None:
        return {"tests": len(due), "skipped": "FIREBASE_CREDENTIALS_FILE is not set"}
    data = {
        "title": "Test notification",
        "body": "Alarm notifications work on this device.",
        "url": "/alarms",
        "tag": "test",
    }
    counts = _send(db, send, [Msg(t, data) for t in due]) if due else {"sent": 0, "failed": 0, "removed": 0}
    return {"tests": len(due), **counts}


def prune(db: Session, today: date) -> int:
    """Delete push marks of past days (a mark only matters on its own day)."""
    n = getattr(db.execute(delete(AlarmPushMark).where(AlarmPushMark.day < today)), "rowcount", 0) or 0
    db.commit()
    return n
