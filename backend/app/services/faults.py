"""Field faults: the defect register (docs/plans/defects.md, build step 1).

A person records a fault on one plant: what failed (kind, device or position, serial as read from
the register or as entered / scanned), how bad (S1–S4), how it was found, and then the decision,
the owner, the next action date and the records that answer it. Nothing is estimated here: loss
belongs to a linked issue (shown as that issue shows it), and restore time is computed only from
the fault's own timestamps.

The service owns: numbering (DF-YYYY-NNNN per Bangkok year), the allowed status changes
(`FaultConflict` → 409 otherwise), the one-active-fault-per-device rule (409 unless
`allow_duplicate`), link validation (same plant; shadow issues admin only), `waiting_on`,
`followup_overdue`, `restore_hours` and the summary counts. Routes apply the plant scope
(`allowed_plant_ids`: other plants answer 404) and log to `app.audit`.
"""

from __future__ import annotations

import re
from datetime import date, datetime, timedelta, timezone
from typing import Any, Dict, Iterable, List, Optional, Set, Tuple
from zoneinfo import ZoneInfo

from sqlalchemy import or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.db.models import (
    Claim,
    FailedUnit,
    FieldFault,
    FieldFaultEvent,
    FieldFaultLink,
    GrowattInverter,
    GrowattIssue,
    GrowattMeter,
    GrowattPlant,
    KbDocument,
    OmTask,
    SiteDevice,
    SiteEvent,
    SiteRegister,
    SpareUnit,
    StockMovement,
    User,
    UserPlantAssignment,
)
from app.db.models.stock import INPUT_METHODS
from app.services.growatt_common import GrowattNotFound

PLANT_TZ = ZoneInfo("Asia/Bangkok")

KINDS = (
    "inverter",
    "pv_module",
    "optimizer",
    "rsd",
    "datalogger",
    "router_4g",
    "revenue_meter",
    "grid_meter",
    "weather_station",
    "pqm",
    "shinemaster",
    "dc_bos",
    "ac_bos",
    "structure",
    "service",
    "other",
)
SERVICE_SUB_KINDS = ("vpn", "sim", "config", "other")
SEVERITIES = ("S1", "S2", "S3", "S4")
HOW_FOUND = ("alarm", "issue", "device_check", "site_visit", "client_report", "ir_flight", "iv_sweep", "other")
CAUSES = (
    "lightning",
    "storm_wind",
    "flood",
    "fire",
    "theft",
    "animal",
    "manufacturing_defect",
    "degradation",
    "installation",
    "unknown",
    "other",
    "config",
    "carrier",
)
DECISIONS = ("repair_on_site", "replace", "claim", "remote_fix", "monitor", "no_action")
WAITING_REASONS = ("part", "claim", "supplier", "access", "carrier", "other")
STATUSES = ("open", "diagnosed", "waiting", "scheduled", "monitor", "restored", "no_action", "closed", "cancelled")
# still needs work: one per device + kind + position (the duplicate rule), counted as Open
ACTIVE = ("open", "diagnosed", "waiting", "scheduled", "monitor")
DONE = ("no_action", "closed", "cancelled")
# allowed next statuses; anything else is a FaultConflict (409). Same table as the page's format.ts.
TRANSITIONS: Dict[str, Tuple[str, ...]] = {
    "open": ("diagnosed", "waiting", "scheduled", "monitor", "restored", "no_action", "cancelled"),
    "diagnosed": ("waiting", "scheduled", "monitor", "restored", "no_action", "cancelled"),
    "waiting": ("diagnosed", "scheduled", "monitor", "restored", "cancelled"),
    "scheduled": ("diagnosed", "waiting", "restored", "cancelled"),
    "monitor": ("diagnosed", "waiting", "scheduled", "restored", "closed", "cancelled"),
    "restored": ("closed", "open"),
    "no_action": ("closed", "open"),
    "closed": ("open",),  # reopened by anyone with the plant
    "cancelled": ("open",),
}
# whose move it is (plan §5); `waiting` depends on its reason, `monitor` / done = nobody's
_WAITING_THEM = ("claim", "supplier", "carrier")
LINK_KINDS = ("issue", "alarm", "device_check", "claim", "failed_unit", "stock_batch", "site_event", "om_task", "kb")
_KEY_LINKS = ("alarm", "device_check", "stock_batch")  # linked by text key, the rest by id

MAX_TEXT = 4000
MAX_URLS = 20
_URL = re.compile(r"^https?://\S{3,}$", re.IGNORECASE)


class FaultConflict(Exception):
    """A clash with stored data (status change not allowed, an active fault on the device): 409."""

    def __init__(self, message: str, extra: Optional[Dict[str, Any]] = None):
        super().__init__(message)
        self.extra = extra or {}


# --------------------------------------------------------------------------- helpers


def _today() -> date:
    return datetime.now(PLANT_TZ).date()


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _aware(ts: Optional[datetime]) -> Optional[datetime]:
    """Stored times are UTC; SQLite gives them back naive."""
    if ts is None:
        return None
    return ts if ts.tzinfo is not None else ts.replace(tzinfo=timezone.utc)


def _local(ts: Optional[datetime]) -> Optional[str]:
    """A stored UTC time as plant-local ISO with its offset."""
    a = _aware(ts)
    return a.astimezone(PLANT_TZ).isoformat() if a else None


def _when(v: Any, field: str) -> datetime:
    """A time from the request: ISO with an offset, or naive = plant-local. Never in the future."""
    if isinstance(v, datetime):
        ts = v
    else:
        try:
            ts = datetime.fromisoformat(str(v).strip().replace("Z", "+00:00"))
        except ValueError:
            raise ValueError(f"{field} is not a date and time") from None
    if ts.tzinfo is None:
        ts = ts.replace(tzinfo=PLANT_TZ)
    ts = ts.astimezone(timezone.utc)
    if ts > _now():
        raise ValueError(f"{field} is in the future")
    return ts


def serial_key(serial: Optional[str]) -> Optional[str]:
    s = (serial or "").strip()
    return s.upper() if s else None


def _text(v: Any, field: str, limit: int = MAX_TEXT, *, required: bool = False) -> Optional[str]:
    s = (str(v) if v is not None else "").strip()
    if not s:
        if required:
            raise ValueError(f"{field} is required")
        return None
    if len(s) > limit:
        raise ValueError(f"{field} is longer than {limit} characters")
    return s


def _choice(v: Any, options: Iterable[str], field: str, *, required: bool = False) -> Optional[str]:
    if v in (None, ""):
        if required:
            raise ValueError(f"{field} is required")
        return None
    if v not in options:
        raise ValueError(f"{field} must be one of {', '.join(options)}")
    return str(v)


def _urls(v: Any) -> List[str]:
    if v is None:
        return []
    if not isinstance(v, list):
        raise ValueError("evidence_urls must be a list")
    out: List[str] = []
    for u in v:
        s = str(u or "").strip()
        if not s:
            continue
        if len(s) > 1000 or not _URL.match(s):
            raise ValueError(f"Not a link: {s[:60]}")
        if s not in out:
            out.append(s)
    if len(out) > MAX_URLS:
        raise ValueError(f"At most {MAX_URLS} evidence links")
    return out


def _position(v: Any) -> Optional[Dict[str, Any]]:
    if v in (None, {}):
        return None
    if not isinstance(v, dict):
        raise ValueError("position must be an object")
    out: Dict[str, Any] = {}
    for k in ("mppt", "string_no", "module_no"):
        x = v.get(k)
        if x in (None, ""):
            continue
        try:
            n = int(x)
        except (TypeError, ValueError):
            raise ValueError(f"position.{k} is not a number") from None
        if not 1 <= n <= 999:
            raise ValueError(f"position.{k} must be 1–999")
        out[k] = n
    loc = _text(v.get("location"), "position.location", 200)
    if loc:
        out["location"] = loc
    unknown = set(v) - {"mppt", "string_no", "module_no", "location"}
    if unknown:
        raise ValueError(f"Unknown position field {sorted(unknown)[0]}")
    return out or None


def _plant_names(db: Session, ids: Set[int]) -> Dict[int, str]:
    if not ids:
        return {}
    return {pid: name for pid, name in db.execute(select(GrowattPlant.plant_id, GrowattPlant.name).where(GrowattPlant.plant_id.in_(ids)))}


def may_work_on(db: Session, user: User, plant_id: int) -> bool:
    if user.role == "admin":
        return True
    return db.scalar(select(UserPlantAssignment.plant_id).where(UserPlantAssignment.user_id == user.id, UserPlantAssignment.plant_id == plant_id)) is not None


# --------------------------------------------------------------------------- device


_DEVICE_FIELDS = ("inverter_sn", "site_device_id", "meter", "stock_unit_id")


def _device(db: Session, plant_id: int, body: Dict[str, Any]) -> Dict[str, Any]:
    """The picked device, checked to be the plant's, with the serial the register holds
    (`register_serial`; None when the register has none or no device was picked)."""
    picked = [k for k in _DEVICE_FIELDS if body.get(k) not in (None, "")]
    if len(picked) > 1:
        raise ValueError("Pick at most one device (inverter, site device, meter or spare unit)")
    out: Dict[str, Any] = {"inverter_sn": None, "site_device_id": None, "meter_datalogger_sn": None, "meter_address": None, "stock_unit_id": None}
    reg: Optional[str] = None
    if not picked:
        return {**out, "register_serial": None}
    k = picked[0]
    if k == "inverter_sn":
        sn = str(body["inverter_sn"]).strip()
        inv = db.scalars(select(GrowattInverter).where(GrowattInverter.device_sn == sn)).first()
        if inv is None or inv.plant_id != plant_id:
            raise ValueError(f"Inverter {sn} is not an inverter of plant {plant_id}")
        out["inverter_sn"], reg = inv.device_sn, inv.device_sn
    elif k == "site_device_id":
        row = db.execute(
            select(SiteDevice, SiteRegister.plant_id).join(SiteRegister, SiteRegister.site_code == SiteDevice.site_code).where(SiteDevice.id == int(body["site_device_id"]))
        ).first()
        if row is None or row[1] != plant_id:
            raise ValueError(f"Site device {body['site_device_id']} is not a device of plant {plant_id}")
        out["site_device_id"], reg = row[0].id, row[0].serial
    elif k == "meter":
        m = body["meter"]
        if not isinstance(m, dict) or not m.get("datalogger_sn") or m.get("address") in (None, ""):
            raise ValueError("meter needs datalogger_sn and address")
        gm = db.get(GrowattMeter, (str(m["datalogger_sn"]).strip(), int(m["address"])))
        if gm is None or gm.plant_id != plant_id:
            raise ValueError(f"Meter {m['datalogger_sn']}:{m['address']} is not a meter of plant {plant_id}")
        out["meter_datalogger_sn"], out["meter_address"] = gm.datalogger_sn, gm.address
    else:
        u = db.get(SpareUnit, int(body["stock_unit_id"]))
        if u is None or u.state != "installed" or u.plant_id != plant_id:
            raise ValueError(f"Spare unit {body['stock_unit_id']} is not installed on plant {plant_id}")
        out["stock_unit_id"], reg = u.id, u.serial
    return {**out, "register_serial": reg}


def _device_label(db: Session, f: FieldFault) -> Optional[str]:
    if f.inverter_sn:
        alias = db.scalar(select(GrowattInverter.alias).where(GrowattInverter.device_sn == f.inverter_sn))
        return f"{alias} · {f.inverter_sn}" if alias and alias != f.inverter_sn else f.inverter_sn
    if f.site_device_id is not None:
        from app.services.scan import _SITE_DEVICE_LABEL

        d = db.get(SiteDevice, f.site_device_id)
        if d is None:
            return None
        label = _SITE_DEVICE_LABEL.get(d.kind, d.kind)
        return f"{label} {d.seq}" if d.seq and d.seq > 1 else label
    if f.meter_datalogger_sn:
        return f"Meter {f.meter_datalogger_sn}:{f.meter_address}"
    if f.stock_unit_id is not None:
        u = db.get(SpareUnit, f.stock_unit_id)
        return f"Spare unit {u.serial}" if u is not None else None
    return None


# --------------------------------------------------------------------------- reading


def _waiting_on(f: FieldFault) -> Optional[str]:
    if f.status in ("open", "diagnosed", "scheduled"):
        return "us"
    if f.status == "waiting":
        if f.waiting_reason in _WAITING_THEM:
            return "them"
        return "us" if f.waiting_reason in ("part", "access") else None
    return None


def restore_hours(f: FieldFault) -> Optional[float]:
    a, b = _aware(f.found_at), _aware(f.restored_at)
    if a is None or b is None:
        return None
    return round((b - a).total_seconds() / 3600, 1)


def serialize(f: FieldFault, plant_name: Optional[str], owner: Optional[Dict[str, Any]], device_label: Optional[str], today: date) -> Dict[str, Any]:
    active = f.status in ACTIVE
    found = _aware(f.found_at)
    return {
        "id": f.id,
        "no": f.no,
        "plant_id": f.plant_id,
        "plant_name": plant_name,
        "kind": f.kind,
        "sub_kind": f.sub_kind,
        "inverter_sn": f.inverter_sn,
        "site_device_id": f.site_device_id,
        "meter": {"datalogger_sn": f.meter_datalogger_sn, "address": f.meter_address} if f.meter_datalogger_sn else None,
        "stock_unit_id": f.stock_unit_id,
        "device_label": device_label,
        "position": dict(f.position) if f.position else None,
        "serial": f.serial,
        "serial_input": f.serial_input,
        "serial_raw": f.serial_raw,
        "symptom": f.symptom,
        "how_found": f.how_found,
        "found_at": _local(f.found_at),
        "found_by": f.found_by,
        "severity": f.severity,
        "cause": f.cause,
        "status": f.status,
        "active": active,
        "waiting_reason": f.waiting_reason,
        "waiting_on": _waiting_on(f),
        "decision": f.decision,
        "decision_reason": f.decision_reason,
        "owner": owner,
        "next_action_day": f.next_action_day.isoformat() if f.next_action_day else None,
        # past the date the person entered; no date = nothing flagged (no assumed response time)
        "followup_overdue": bool(active and f.next_action_day is not None and f.next_action_day < today),
        "age_days": (today - found.astimezone(PLANT_TZ).date()).days if found else None,
        "restored_at": _local(f.restored_at),
        "restore_hours": restore_hours(f),
        "closed_at": _local(f.closed_at),
        "closed_by": f.closed_by,
        "close_note": f.close_note,
        "evidence_urls": list(f.evidence_urls or []),
        "reference": f.reference,
        "created_by": f.created_by,
        "updated_by": f.updated_by,
        "created_at": _local(f.created_at),
        "updated_at": _local(f.updated_at),
    }


def _owners(db: Session, ids: Set[int]) -> Dict[int, Dict[str, Any]]:
    if not ids:
        return {}
    return {u.id: {"id": u.id, "username": u.username, "full_name": u.full_name} for u in db.scalars(select(User).where(User.id.in_(ids)))}


def _link_counts(db: Session, ids: List[int], hidden_issue_ids: Set[int]) -> Dict[int, Dict[str, int]]:
    out: Dict[int, Dict[str, int]] = {}
    if not ids:
        return out
    for fid, kind, ref_id in db.execute(select(FieldFaultLink.fault_id, FieldFaultLink.kind, FieldFaultLink.ref_id).where(FieldFaultLink.fault_id.in_(ids))):
        if kind == "issue" and ref_id in hidden_issue_ids:
            continue
        c = out.setdefault(fid, {})
        c[kind] = c.get(kind, 0) + 1
    return out


def _shadow_issue_ids(db: Session, issue_ids: Set[int]) -> Set[int]:
    if not issue_ids:
        return set()
    return set(db.scalars(select(GrowattIssue.id).where(GrowattIssue.id.in_(issue_ids), GrowattIssue.shadow.is_(True))))


def _rows_out(db: Session, rows: List[FieldFault], allow_shadow: bool) -> List[Dict[str, Any]]:
    names = _plant_names(db, {f.plant_id for f in rows})
    owners = _owners(db, {f.owner_user_id for f in rows if f.owner_user_id is not None})
    ids = [f.id for f in rows]
    hidden: Set[int] = set()
    if not allow_shadow and ids:
        refs = db.scalars(select(FieldFaultLink.ref_id).where(FieldFaultLink.fault_id.in_(ids), FieldFaultLink.kind == "issue"))
        hidden = _shadow_issue_ids(db, {r for r in refs if r is not None})
    counts = _link_counts(db, ids, hidden)
    today = _today()
    out = []
    for f in rows:
        d = serialize(f, names.get(f.plant_id), owners.get(f.owner_user_id) if f.owner_user_id else None, _device_label(db, f), today)
        d["links"] = counts.get(f.id, {})
        out.append(d)
    return out


TABS: Dict[str, Tuple[str, ...]] = {"open": ACTIVE, "restored": ("restored",), "closed": DONE, "all": STATUSES}


def list_faults(
    db: Session,
    plant_ids: Optional[Set[int]],
    *,
    allow_shadow: bool,
    tab: str = "open",
    status: Optional[List[str]] = None,
    kind: Optional[str] = None,
    severity: Optional[str] = None,
    plant_id: Optional[int] = None,
    waiting: Optional[str] = None,
    overdue: bool = False,
    q: Optional[str] = None,
    limit: int = 50,
    offset: int = 0,
) -> Dict[str, Any]:
    """Faults the user may see, newest found first. `summary` counts every visible fault (of
    `plant_id` when given), not only the filtered ones, so each count can set the filter."""
    base = select(FieldFault)
    if plant_ids is not None:
        base = base.where(FieldFault.plant_id.in_(plant_ids or {-1}))
    if plant_id is not None:
        base = base.where(FieldFault.plant_id == plant_id)
    every = list(db.scalars(base))
    today = _today()
    active = [f for f in every if f.status in ACTIVE]
    summary = {
        "open": len(active),
        "s1_open": sum(1 for f in active if f.severity == "S1"),
        "waiting_us": sum(1 for f in active if _waiting_on(f) == "us"),
        "waiting_them": sum(1 for f in active if _waiting_on(f) == "them"),
        "followup_overdue": sum(1 for f in active if f.next_action_day is not None and f.next_action_day < today),
        "restored": sum(1 for f in every if f.status == "restored"),
    }
    statuses = [s for s in (status or []) if s] or list(TABS.get(tab, ACTIVE))
    rows = [f for f in every if f.status in statuses]
    if kind:
        rows = [f for f in rows if f.kind == kind]
    if severity:
        rows = [f for f in rows if f.severity == severity]
    if waiting in ("us", "them"):
        rows = [f for f in rows if _waiting_on(f) == waiting]
    if overdue:
        rows = [f for f in rows if f.status in ACTIVE and f.next_action_day is not None and f.next_action_day < today]
    words = [w for w in (q or "").lower().split() if w]
    if words:
        names = _plant_names(db, {f.plant_id for f in rows})

        def hay(f: FieldFault) -> str:
            pos = f.position or {}
            return " ".join(
                str(x or "")
                for x in (f.no, names.get(f.plant_id), f.plant_id, f.serial, f.inverter_sn, f.symptom, f.reference, f.kind, pos.get("location"))
            ).lower()

        rows = [f for f in rows if all(w in hay(f) for w in words)]
    rows.sort(key=lambda f: (_aware(f.found_at) or _now(), f.id), reverse=True)
    limit = max(1, min(int(limit), 500))
    offset = max(0, int(offset))
    return {
        "faults": _rows_out(db, rows[offset : offset + limit], allow_shadow),
        "total": len(rows),
        "summary": summary,
        "meta": {"source": "db", "today": today.isoformat()},
    }


def get_fault(db: Session, fault_id: int, plant_ids: Optional[Set[int]]) -> FieldFault:
    """The fault, or GrowattNotFound when it does not exist or its plant is not the user's."""
    f = db.get(FieldFault, fault_id)
    if f is None or (plant_ids is not None and f.plant_id not in plant_ids):
        raise GrowattNotFound(f"Fault {fault_id} not found")
    return f


def by_no(db: Session, no: str, plant_ids: Optional[Set[int]]) -> FieldFault:
    f = db.scalars(select(FieldFault).where(FieldFault.no == no.strip().upper())).first()
    if f is None or (plant_ids is not None and f.plant_id not in plant_ids):
        raise GrowattNotFound(f"No fault {no}")
    return f


def _link_labels(db: Session, links: List[FieldFaultLink]) -> Dict[int, Optional[str]]:
    from app.services import growatt_rules, site_events

    ids: Dict[str, Set[int]] = {}
    for link in links:
        if link.ref_id is not None:
            ids.setdefault(link.kind, set()).add(link.ref_id)
    labels: Dict[Tuple[str, int], str] = {}
    if ids.get("issue"):
        for i in db.scalars(select(GrowattIssue).where(GrowattIssue.id.in_(ids["issue"]))):
            where = f"string {i.string_no}" if i.string_no is not None else (i.device_sn or "")
            labels[("issue", i.id)] = " · ".join(x for x in (f"{i.rule} {growatt_rules.RULE_NAMES.get(i.rule, i.rule)}", where, i.status) if x)
    if ids.get("claim"):
        for c in db.scalars(select(Claim).where(Claim.id.in_(ids["claim"]))):
            labels[("claim", c.id)] = f"{c.number} · {c.status}"
    if ids.get("failed_unit"):
        from app.db.models import RedTag

        for fu, code in db.execute(select(FailedUnit, RedTag.code).join(RedTag, RedTag.id == FailedUnit.red_tag_id).where(FailedUnit.id.in_(ids["failed_unit"]))):
            labels[("failed_unit", fu.id)] = f"{code} · {fu.serial or '—'} · {fu.status.replace('_', ' ')}"
    if ids.get("site_event"):
        for ev in db.scalars(select(SiteEvent).where(SiteEvent.id.in_(ids["site_event"]))):
            labels[("site_event", ev.id)] = f"{site_events.EVENT_LABELS.get(ev.event_type, ev.event_type)} {ev.day.isoformat()}"
    if ids.get("om_task"):
        for t in db.scalars(select(OmTask).where(OmTask.id.in_(ids["om_task"]))):
            labels[("om_task", t.id)] = f"{t.title or t.task_type} · {t.start_day.isoformat()} · {t.status}"
    if ids.get("kb"):
        for d in db.scalars(select(KbDocument).where(KbDocument.id.in_(ids["kb"]))):
            labels[("kb", d.id)] = f"{d.number} · {d.title_en or d.title_th or ''}".rstrip(" ·")
    return {l.id: (labels.get((l.kind, l.ref_id)) if l.ref_id is not None else l.ref_key) for l in links}


def serialize_links(db: Session, links: List[FieldFaultLink], allow_shadow: bool) -> List[Dict[str, Any]]:
    """Links with labels. Without `allow_shadow`, links to shadow issues are left out (not even
    the id); a link to a record that is gone keeps `label: null`."""
    if not allow_shadow:
        hidden = _shadow_issue_ids(db, {l.ref_id for l in links if l.kind == "issue" and l.ref_id is not None})
        links = [l for l in links if not (l.kind == "issue" and l.ref_id in hidden)]
    labels = _link_labels(db, links)
    return [{"id": l.id, "kind": l.kind, "ref_id": l.ref_id, "ref_key": l.ref_key, "label": labels.get(l.id), "created_by": l.created_by, "created_at": _local(l.created_at)} for l in links]


def serialize_event(e: FieldFaultEvent) -> Dict[str, Any]:
    return {"id": e.id, "at": _local(e.at), "by": e.by, "kind": e.kind, "from": e.from_value, "to": e.to_value, "text": e.text}


def detail(db: Session, f: FieldFault, allow_shadow: bool) -> Dict[str, Any]:
    """The fault with its links (labels resolved) and timeline (newest first)."""
    [out] = _rows_out(db, [f], allow_shadow)
    links = list(db.scalars(select(FieldFaultLink).where(FieldFaultLink.fault_id == f.id).order_by(FieldFaultLink.id)))
    out["link_list"] = serialize_links(db, links, allow_shadow)
    events = list(db.scalars(select(FieldFaultEvent).where(FieldFaultEvent.fault_id == f.id).order_by(FieldFaultEvent.at.desc(), FieldFaultEvent.id.desc())))
    if not allow_shadow:  # a link / unlink of a shadow issue is left out of an engineer's timeline, as the link itself
        mentioned = {int(e.text[6:]) for e in events if e.kind in ("link", "unlink") and e.text.startswith("issue ") and e.text[6:].isdigit()}
        hidden = _shadow_issue_ids(db, mentioned)
        events = [e for e in events if not (e.kind in ("link", "unlink") and e.text.startswith("issue ") and e.text[6:].isdigit() and int(e.text[6:]) in hidden)]
    out["events"] = [serialize_event(e) for e in events]
    return out


def open_on_device(
    db: Session,
    plant_ids: Optional[Set[int]],
    *,
    inverter_sn: Optional[str] = None,
    site_device_id: Optional[int] = None,
    serial: Optional[str] = None,
    allow_shadow: bool = False,
) -> List[Dict[str, Any]]:
    """Active faults on the device (for the create dialogs' "add to this one")."""
    conds = []
    if inverter_sn:
        conds.append(FieldFault.inverter_sn == inverter_sn.strip())
    if site_device_id is not None:
        conds.append(FieldFault.site_device_id == site_device_id)
    if serial and serial_key(serial):
        conds.append(FieldFault.serial_key == serial_key(serial))
    if not conds:
        raise ValueError("Give inverter_sn, site_device_id or serial")
    q = select(FieldFault).where(or_(*conds), FieldFault.status.in_(ACTIVE))
    if plant_ids is not None:
        q = q.where(FieldFault.plant_id.in_(plant_ids or {-1}))
    return _rows_out(db, list(db.scalars(q.order_by(FieldFault.found_at.desc()))), allow_shadow)


# --------------------------------------------------------------------------- writing


def _event(db: Session, f: FieldFault, kind: str, who: str, text: str = "", frm: Optional[str] = None, to: Optional[str] = None) -> None:
    db.add(FieldFaultEvent(fault_id=f.id, kind=kind, by=who, text=text, from_value=frm, to_value=to, at=_now()))
    f.updated_by = who
    f.updated_at = _now()


def _next_no(db: Session, year: int) -> str:
    prefix = f"DF-{year}-"
    top = 0
    for n in db.scalars(select(FieldFault.no).where(FieldFault.no.like(f"{prefix}%"))):
        try:
            top = max(top, int(n[len(prefix) :]))
        except ValueError:
            continue
    return f"{prefix}{top + 1:04d}"


def _check_owner(db: Session, owner_id: Any, plant_id: int) -> Optional[int]:
    if owner_id in (None, ""):
        return None
    u = db.get(User, int(owner_id))
    if u is None or not u.is_active or not may_work_on(db, u, plant_id):
        raise ValueError(f"User {owner_id} cannot own a fault of plant {plant_id}")
    return u.id


def _duplicate(db: Session, plant_id: int, kind: str, dev: Dict[str, Any], key: Optional[str], position: Optional[Dict[str, Any]], exclude: Optional[int] = None) -> Optional[FieldFault]:
    """An active fault of the same kind on the same device and position (a fault with no device
    and no serial is never a duplicate: BOS / structure faults are told apart by people)."""
    if not any(dev.get(k) is not None for k in ("inverter_sn", "site_device_id", "meter_datalogger_sn", "stock_unit_id")) and not key:
        return None
    q = select(FieldFault).where(FieldFault.plant_id == plant_id, FieldFault.kind == kind, FieldFault.status.in_(ACTIVE))
    if exclude is not None:
        q = q.where(FieldFault.id != exclude)
    for f in db.scalars(q):
        same_device = (
            (dev["inverter_sn"] is not None and f.inverter_sn == dev["inverter_sn"])
            or (dev["site_device_id"] is not None and f.site_device_id == dev["site_device_id"])
            or (dev["meter_datalogger_sn"] is not None and (f.meter_datalogger_sn, f.meter_address) == (dev["meter_datalogger_sn"], dev["meter_address"]))
            or (dev["stock_unit_id"] is not None and f.stock_unit_id == dev["stock_unit_id"])
            or (key is not None and f.serial_key == key)
        )
        if same_device and (f.position or None) == (position or None):
            return f
    return None


def create_fault(db: Session, body: Dict[str, Any], who: str, *, allow_shadow: bool) -> FieldFault:
    """A new `open` fault. Links are checked first, so a bad one leaves nothing behind. An active
    fault of the same kind on the same device + position is a FaultConflict (with `fault_id`)
    unless `allow_duplicate`."""
    plant_id = int(body["plant_id"])
    if db.get(GrowattPlant, plant_id) is None:
        raise GrowattNotFound(f"Plant {plant_id} not found")
    kind = _choice(body.get("kind"), KINDS, "kind", required=True)
    assert kind is not None
    sub_kind = _choice(body.get("sub_kind"), SERVICE_SUB_KINDS, "sub_kind", required=kind == "service")
    if kind != "service":
        sub_kind = None
    severity = _choice(body.get("severity"), SEVERITIES, "severity", required=True)
    how_found = _choice(body.get("how_found"), HOW_FOUND, "how_found", required=True)
    cause = _choice(body.get("cause"), CAUSES, "cause")
    symptom = _text(body.get("symptom"), "symptom", required=True)
    found_at = _when(body["found_at"], "found_at") if body.get("found_at") else _now()
    dev = _device(db, plant_id, body)
    position = _position(body.get("position"))
    # the register's serial wins when a device is picked (as read, `register`); else as entered
    typed = _text(body.get("serial"), "serial", 64)
    if dev["register_serial"]:
        serial, method, raw = dev["register_serial"], "register", None
    else:
        serial = typed
        method = _choice(body.get("serial_input"), INPUT_METHODS, "serial_input") if typed else None
        raw = _text(body.get("serial_raw"), "serial_raw", 512) if method else None
    key = serial_key(serial)
    if not body.get("allow_duplicate"):
        dup = _duplicate(db, plant_id, kind, dev, key, position)
        if dup is not None:
            raise FaultConflict(f"{dup.no} is already open on this device", {"fault_id": dup.id, "no": dup.no})
    links = [_check_link(db, plant_id, l, allow_shadow) for l in (body.get("links") or [])]
    data = dict(
        plant_id=plant_id,
        kind=kind,
        sub_kind=sub_kind,
        inverter_sn=dev["inverter_sn"],
        site_device_id=dev["site_device_id"],
        meter_datalogger_sn=dev["meter_datalogger_sn"],
        meter_address=dev["meter_address"],
        stock_unit_id=dev["stock_unit_id"],
        position=position,
        serial=serial,
        serial_key=key,
        serial_input=method,
        serial_raw=raw,
        symptom=symptom,
        how_found=how_found,
        found_at=found_at,
        found_by=_text(body.get("found_by"), "found_by", 64) or who,
        severity=severity,
        s1_at=_now() if severity == "S1" else None,
        cause=cause,
        status="open",
        owner_user_id=_check_owner(db, body.get("owner_user_id"), plant_id),
        next_action_day=body.get("next_action_day"),
        evidence_urls=_urls(body.get("evidence_urls")),
        reference=_text(body.get("reference"), "reference", 120),
        created_by=who,
        updated_by=who,
    )
    f: Optional[FieldFault] = None
    for attempt in range(3):
        f = FieldFault(no=_next_no(db, datetime.now(PLANT_TZ).year), **data)
        db.add(f)
        try:
            db.flush()
            break
        except IntegrityError:  # the number was taken meanwhile
            db.rollback()
            if attempt == 2:
                raise
    assert f is not None
    _event(db, f, "created", who, f"{severity} {kind}", to="open")
    seen: Set[Tuple[str, Any]] = set()
    for kind_, ref_id, ref_key in links:
        if (kind_, ref_id if ref_id is not None else ref_key) in seen:
            continue
        seen.add((kind_, ref_id if ref_id is not None else ref_key))
        db.add(FieldFaultLink(fault_id=f.id, kind=kind_, ref_id=ref_id, ref_key=ref_key, created_by=who))
    db.commit()
    return f


_EDITABLE = ("symptom", "cause", "severity", "owner_user_id", "next_action_day", "evidence_urls", "reference", "position", "sub_kind", "found_at")


def update_fault(db: Session, f: FieldFault, changes: Dict[str, Any], who: str) -> List[str]:
    """The fields present in `changes` (null clears an optional one). A severity change gets its
    own timeline entry; the rest one `edit` entry naming the fields."""
    vals: Dict[str, Any] = {}
    for k, v in changes.items():
        if k not in _EDITABLE:
            continue
        if k == "symptom":
            vals[k] = _text(v, "symptom", required=True)
        elif k == "cause":
            vals[k] = _choice(v, CAUSES, "cause")
        elif k == "severity":
            vals[k] = _choice(v, SEVERITIES, "severity", required=True)
        elif k == "owner_user_id":
            vals[k] = _check_owner(db, v, f.plant_id)
        elif k == "next_action_day":
            vals[k] = v
        elif k == "evidence_urls":
            vals[k] = _urls(v)
        elif k == "reference":
            vals[k] = _text(v, "reference", 120)
        elif k == "position":
            vals[k] = _position(v)
        elif k == "sub_kind":
            if f.kind != "service":
                continue
            vals[k] = _choice(v, SERVICE_SUB_KINDS, "sub_kind", required=True)
        elif k == "found_at":
            vals[k] = _when(v, "found_at")
    if "found_at" in vals and f.restored_at is not None and vals["found_at"] > _aware(f.restored_at):  # type: ignore[operator]
        raise ValueError("found_at is after the restore time")
    changed = [k for k, v in vals.items() if v != (_aware(getattr(f, k)) if k == "found_at" else getattr(f, k))]
    if not changed:
        return []
    old_sev = f.severity
    for k in changed:
        setattr(f, k, vals[k])
    if "severity" in changed and f.severity == "S1":  # raised to S1: pushed once more (faults_push)
        f.s1_at, f.s1_pushed_at = _now(), None
    if "severity" in changed:
        _event(db, f, "severity", who, frm=old_sev, to=f.severity)
    rest = [k for k in changed if k != "severity"]
    if rest:
        _event(db, f, "edit", who, ", ".join(rest))
    db.commit()
    return changed


def set_status(db: Session, f: FieldFault, body: Dict[str, Any], who: str) -> FieldFault:
    """Move along the workflow (TRANSITIONS). `waiting` needs a reason; `restored` a restore time
    (default now; not in the future, not before `found_at`); `closed` needs a restore, or a note
    from `monitor` / `no_action`. Reopening (→ open) clears the restore and close."""
    to = _choice(body.get("status"), STATUSES, "status", required=True)
    assert to is not None
    note = _text(body.get("note"), "note")
    if to == f.status and to != "waiting":
        raise FaultConflict(f"The fault is already {to.replace('_', ' ')}")
    if to != f.status and to not in TRANSITIONS.get(f.status, ()):
        raise FaultConflict(f"A {f.status.replace('_', ' ')} fault cannot go to {to.replace('_', ' ')}")
    frm = f.status
    if to == "waiting":
        reason = _choice(body.get("waiting_reason"), WAITING_REASONS, "waiting_reason", required=True)
        if frm == "waiting" and reason == f.waiting_reason:
            raise FaultConflict("The fault is already waiting for that")
        f.waiting_reason = reason
    else:
        f.waiting_reason = None
    if to == "restored":
        at = _when(body["restored_at"], "restored_at") if body.get("restored_at") else _now()
        if at < _aware(f.found_at):  # type: ignore[operator]
            raise ValueError("restored_at is before the fault was found")
        f.restored_at = at
    if to == "closed":
        if frm in ("monitor", "no_action"):
            if not note:
                raise ValueError(f"Closing a fault from {frm.replace('_', ' ')} needs a note")
        elif f.restored_at is None:
            raise ValueError("Close a fault once it is restored")
        f.closed_at, f.closed_by, f.close_note = _now(), who, note
    if to == "open":  # reopened: it is not restored any more
        f.restored_at = f.closed_at = None
        f.closed_by = f.close_note = None
    f.status = to
    text = f.waiting_reason or ""
    if note:
        text = f"{text}: {note}" if text else note
    _event(db, f, "status", who, text, frm=frm, to=to)
    db.commit()
    return f


def set_decision(db: Session, f: FieldFault, body: Dict[str, Any], who: str) -> FieldFault:
    """What will be done, with the reason. It can change; each change is on the timeline. A done
    fault (closed / cancelled) takes no decision (reopen it first)."""
    if f.status in ("closed", "cancelled"):
        raise FaultConflict(f"The fault is {f.status}: reopen it first")
    decision = _choice(body.get("decision"), DECISIONS, "decision", required=True)
    reason = _text(body.get("reason"), "reason", required=True)
    if decision == "remote_fix" and f.kind != "service":
        raise ValueError("remote_fix is for service faults")
    if decision == f.decision and reason == f.decision_reason:
        return f
    frm = f.decision
    f.decision, f.decision_reason = decision, reason
    _event(db, f, "decision", who, reason or "", frm=frm, to=decision)
    db.commit()
    return f


def add_note(db: Session, f: FieldFault, text: Any, who: str) -> None:
    _event(db, f, "note", who, _text(text, "text", required=True) or "")
    db.commit()


def _check_link(db: Session, plant_id: int, raw: Dict[str, Any], allow_shadow: bool) -> Tuple[str, Optional[int], Optional[str]]:
    kind = _choice(raw.get("kind"), LINK_KINDS, "link kind", required=True)
    assert kind is not None
    if kind in _KEY_LINKS:
        key = _text(raw.get("ref_key"), f"{kind} ref_key", 200, required=True)
        if kind == "stock_batch":
            hit = db.scalars(select(StockMovement).where(StockMovement.batch_id == key)).first()
            if hit is None or (hit.plant_id is not None and hit.plant_id != plant_id):
                raise ValueError(f"{key} is not a stock movement batch of plant {plant_id}")
        return kind, None, key
    if raw.get("ref_id") in (None, ""):
        raise ValueError(f"A {kind} link needs ref_id")
    ref_id = int(raw["ref_id"])
    bad = ValueError(f"{ref_id} is not a {kind.replace('_', ' ')} of plant {plant_id}")
    if kind == "issue":
        i = db.get(GrowattIssue, ref_id)
        if i is None or i.plant_id != plant_id or (i.shadow and not allow_shadow):
            raise bad
    elif kind == "claim":
        c = db.get(Claim, ref_id)
        if c is None or c.plant_id != plant_id:
            raise bad
    elif kind == "failed_unit":
        fu = db.get(FailedUnit, ref_id)
        if fu is None or fu.plant_id != plant_id:
            raise bad
    elif kind == "site_event":
        ev = db.get(SiteEvent, ref_id)
        if ev is None or ev.plant_id != plant_id:
            raise bad
    elif kind == "om_task":
        t = db.get(OmTask, ref_id)
        if t is None or t.plant_id != plant_id:
            raise bad
    elif kind == "kb":
        d = db.get(KbDocument, ref_id)
        if d is None or d.status not in ("released", "superseded"):
            raise ValueError(f"{ref_id} is not a released KB document")
    return kind, ref_id, None


def add_link(db: Session, f: FieldFault, raw: Dict[str, Any], who: str, *, allow_shadow: bool) -> FieldFaultLink:
    kind, ref_id, ref_key = _check_link(db, f.plant_id, raw, allow_shadow)
    q = select(FieldFaultLink).where(FieldFaultLink.fault_id == f.id, FieldFaultLink.kind == kind)
    q = q.where(FieldFaultLink.ref_id == ref_id) if ref_id is not None else q.where(FieldFaultLink.ref_key == ref_key)
    if db.scalars(q).first() is not None:
        raise FaultConflict("Already linked")
    link = FieldFaultLink(fault_id=f.id, kind=kind, ref_id=ref_id, ref_key=ref_key, created_by=who)
    db.add(link)
    _event(db, f, "link", who, f"{kind} {ref_id if ref_id is not None else ref_key}")
    db.commit()
    return link


def delete_link(db: Session, f: FieldFault, link_id: int, who: str, *, allow_shadow: bool) -> None:
    link = db.get(FieldFaultLink, link_id)
    if link is None or link.fault_id != f.id:
        raise GrowattNotFound(f"Link {link_id} not found")
    if link.kind == "issue" and not allow_shadow and link.ref_id in _shadow_issue_ids(db, {link.ref_id} if link.ref_id is not None else set()):
        raise GrowattNotFound(f"Link {link_id} not found")  # engineers never see it
    db.delete(link)
    _event(db, f, "unlink", who, f"{link.kind} {link.ref_id if link.ref_id is not None else link.ref_key}")
    db.commit()



# --------------------------------------------------------------------------- from other records (plan §6.3–6.5)


def check_attach(db: Session, user: User, fault_id: Any, plant_id: int) -> Optional[FieldFault]:
    """The fault a replacement / failed unit / claim / Calendar task is recorded for (`fault_id`,
    None = none), checked before the caller writes anything: visible to the user (GrowattNotFound
    otherwise), of the same plant and not closed / cancelled (ValueError)."""
    if fault_id in (None, ""):
        return None
    from app.auth import allowed_plant_ids

    f = get_fault(db, int(fault_id), allowed_plant_ids(db, user))
    if f.plant_id != plant_id:
        raise ValueError(f"Fault {f.no} is not a fault of plant {plant_id}")
    if f.status in ("closed", "cancelled"):
        raise ValueError(f"Fault {f.no} is {f.status}: reopen it first")
    return f


def attach(
    db: Session,
    f: FieldFault,
    who: str,
    kind: str,
    *,
    ref_id: Optional[int] = None,
    ref_key: Optional[str] = None,
    to_status: Optional[str] = None,
    waiting_reason: Optional[str] = None,
    next_action_day: Optional[date] = None,
) -> None:
    """Link the caller's new record to the fault, in the caller's transaction (no commit), and
    move the fault on when that step is allowed from where it is (`to_status`; otherwise only the
    link is written). `restored` stamps now as the restore time."""
    q = select(FieldFaultLink).where(FieldFaultLink.fault_id == f.id, FieldFaultLink.kind == kind)
    q = q.where(FieldFaultLink.ref_id == ref_id) if ref_id is not None else q.where(FieldFaultLink.ref_key == ref_key)
    if db.scalars(q).first() is None:
        db.add(FieldFaultLink(fault_id=f.id, kind=kind, ref_id=ref_id, ref_key=ref_key, created_by=who))
        _event(db, f, "link", who, f"{kind} {ref_id if ref_id is not None else ref_key}")
    if next_action_day is not None and f.status in ACTIVE:
        f.next_action_day = next_action_day
    if to_status is None or (to_status == f.status and waiting_reason == f.waiting_reason):
        return
    if to_status != f.status and to_status not in TRANSITIONS.get(f.status, ()):
        return
    frm = f.status
    f.status = to_status
    f.waiting_reason = waiting_reason if to_status == "waiting" else None
    if to_status == "restored":
        f.restored_at = _now()
    _event(db, f, "status", who, f"{waiting_reason + ': ' if waiting_reason else ''}from {kind.replace('_', ' ')}", frm=frm, to=to_status)


# --------------------------------------------------------------------------- report (plan §9)

REPORT_GROUPS = ("kind", "model", "plant", "phase")
REPORT_MAX_DAYS = 366


def _pctl(xs: List[float], p: float) -> Optional[float]:
    """Nearest-rank percentile; None without values."""
    if not xs:
        return None
    s = sorted(xs)
    k = max(1, -(-len(s) * p // 100))  # ceil(n * p / 100)
    return round(s[int(k) - 1], 1)


def _models(db: Session, rows: List[FieldFault]) -> Dict[int, Optional[str]]:
    """The recorded model of each fault's device (Growatt inverter model, Site Register brand /
    model, spare part make + model); None = not recorded, never guessed."""
    from app.db.models import Part

    sns = {f.inverter_sn for f in rows if f.inverter_sn}
    devs = {f.site_device_id for f in rows if f.site_device_id is not None}
    units = {f.stock_unit_id for f in rows if f.stock_unit_id is not None}
    inv = {sn: m for sn, m in db.execute(select(GrowattInverter.device_sn, GrowattInverter.device_model).where(GrowattInverter.device_sn.in_(sns)))} if sns else {}
    dev = {i: m for i, m in db.execute(select(SiteDevice.id, SiteDevice.brand_model).where(SiteDevice.id.in_(devs)))} if devs else {}
    unit: Dict[int, Optional[str]] = {}
    if units:
        for uid, make, model in db.execute(select(SpareUnit.id, Part.make, Part.model).join(Part, Part.id == SpareUnit.part_id).where(SpareUnit.id.in_(units))):
            unit[uid] = " ".join(x for x in (make, model) if x) or None
    out: Dict[int, Optional[str]] = {}
    for f in rows:
        m = inv.get(f.inverter_sn) if f.inverter_sn else dev.get(f.site_device_id) if f.site_device_id is not None else unit.get(f.stock_unit_id) if f.stock_unit_id is not None else None  # type: ignore[arg-type]
        out[f.id] = (m or "").strip() or None
    return out


def report(db: Session, plant_ids: Optional[Set[int]], *, start: date, end: date, group: str) -> Dict[str, Any]:
    """Faults found in [start, end] (plant-local days), per `group`: how many were found, are still
    active, restored and closed, per severity, and the restore time (found → restored, hours) of the
    closed ones: median and p90 (nearest rank). A group with no closed fault has no restore time."""
    if group not in REPORT_GROUPS:
        raise ValueError(f"group must be one of {', '.join(REPORT_GROUPS)}")
    if end < start:
        raise ValueError("end is before start")
    if (end - start).days + 1 > REPORT_MAX_DAYS:
        raise ValueError(f"At most {REPORT_MAX_DAYS} days")
    lo = datetime(start.year, start.month, start.day, tzinfo=PLANT_TZ).astimezone(timezone.utc)
    hi = datetime(end.year, end.month, end.day, tzinfo=PLANT_TZ).astimezone(timezone.utc) + timedelta(days=1)
    q = select(FieldFault).where(FieldFault.found_at >= lo, FieldFault.found_at < hi, FieldFault.status != "cancelled")
    if plant_ids is not None:
        q = q.where(FieldFault.plant_id.in_(plant_ids or {-1}))
    rows = list(db.scalars(q))
    names = _plant_names(db, {f.plant_id for f in rows})
    phases: Dict[int, Optional[int]] = {}
    if group == "phase" and rows:
        phases = {pid: ph for pid, ph in db.execute(select(GrowattPlant.plant_id, GrowattPlant.phase).where(GrowattPlant.plant_id.in_({f.plant_id for f in rows})))}
    models = _models(db, rows) if group == "model" else {}

    def key(f: FieldFault) -> Tuple[str, Optional[str]]:
        if group == "kind":
            return f.kind, f.kind.replace("_", " ")
        if group == "plant":
            return str(f.plant_id), names.get(f.plant_id)
        if group == "phase":
            ph = phases.get(f.plant_id)
            return (str(ph), f"Phase {ph}") if ph is not None else ("none", None)
        m = models.get(f.id)
        return (f"{f.kind}|{m.upper()}", m) if m else (f"{f.kind}|", None)

    groups: Dict[str, Dict[str, Any]] = {}
    hours: Dict[str, List[float]] = {}
    for f in rows:
        k, label = key(f)
        g = groups.setdefault(k, {"key": k, "label": label, "kind": f.kind if group == "model" else None, "found": 0, "active": 0, "restored": 0, "closed": 0, "by_severity": {s: 0 for s in SEVERITIES}})
        g["found"] += 1
        g["by_severity"][f.severity] += 1
        if f.status in ACTIVE:
            g["active"] += 1
        elif f.status == "restored":
            g["restored"] += 1
        elif f.status == "closed":
            g["closed"] += 1
            h = restore_hours(f)
            if h is not None:
                hours.setdefault(k, []).append(h)
    out = []
    for k, g in groups.items():
        hs = hours.get(k, [])
        out.append({**g, "restore_hours_n": len(hs), "restore_hours_median": _pctl(hs, 50), "restore_hours_p90": _pctl(hs, 90)})
    out.sort(key=lambda g: (-g["found"], g["key"]))
    every = [h for hs in hours.values() for h in hs]
    return {
        "start": start.isoformat(),
        "end": end.isoformat(),
        "group": group,
        "groups": out,
        "total": {"found": len(rows), "closed_with_restore": len(every), "restore_hours_median": _pctl(every, 50), "restore_hours_p90": _pctl(every, 90)},
        "meta": {"source": "db", "restore_basis": "closed faults: restored_at − found_at", "percentile": "nearest rank"},
    }
