"""Claims: warranty and insurance claims for plant equipment (docs/plans/claims.md).

What failed at which plant, who the claim is with, the evidence gathered and where it stands.
Every date, serial, reference and warranty term is as entered; nothing is looked up, assumed or
priced. SQL only (never Firestore), kept indefinitely.

The service owns what the page must not decide on its own: claim numbers (CL-YYYY-NNN per year),
the evidence checklist per type, the allowed status changes (`ClaimConflict` → 409 otherwise),
`waiting_on`, `followup_overdue` and the summary counts. Plant scoping and the admin-only actions
(status changes, delete) are applied by the routes.
"""

from __future__ import annotations

from datetime import date, datetime
from typing import Any, Dict, Iterable, List, Optional, Set, Tuple
from zoneinfo import ZoneInfo

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.db.models.stock import INPUT_METHODS
from app.db.models import (
    Claim,
    ClaimEvent,
    ClaimEvidence,
    ClaimLink,
    GrowattInverter,
    GrowattIssue,
    GrowattIvSweep,
    GrowattPlant,
    SiteEvent,
)
from app.services.growatt_common import GrowattNotFound

PLANT_TZ = ZoneInfo("Asia/Bangkok")

CLAIM_TYPES = ("inverter_warranty", "module_warranty", "equipment_warranty", "insurance", "workmanship")
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
)
STATUSES = (
    "draft",
    "submitted",
    "under_review",
    "info_requested",
    "approved",
    "rejected",
    "fulfilled",
    "closed",
    "withdrawn",
)
# allowed next statuses; anything else is a ClaimConflict (409). Same table as the page's format.ts.
TRANSITIONS: Dict[str, Tuple[str, ...]] = {
    "draft": ("submitted", "withdrawn"),
    "submitted": ("under_review", "info_requested", "approved", "rejected", "withdrawn"),
    "under_review": ("info_requested", "approved", "rejected", "withdrawn"),
    "info_requested": ("under_review", "withdrawn"),
    "approved": ("fulfilled", "withdrawn"),
    "rejected": ("under_review", "closed"),
    "fulfilled": ("closed",),
    "closed": ("under_review",),
    "withdrawn": ("draft",),
}
# whose move it is
WAITING: Dict[str, Optional[str]] = {
    "draft": "us",
    "submitted": "them",
    "under_review": "them",
    "info_requested": "us",
    "approved": "them",
    "rejected": "us",
    "fulfilled": "us",
    "closed": None,
    "withdrawn": None,
}
CLOSED = frozenset({"closed", "withdrawn"})

# evidence checklist per type: (key, label, required). `police_report` becomes required for theft.
EVIDENCE: Dict[str, Tuple[Tuple[str, str, bool], ...]] = {
    "inverter_warranty": (
        ("alarm_log", "Alarm / fault log extract", True),
        ("photos", "Photos of the display and nameplate", True),
        ("site_log", "Site log entry of the failure", False),
        ("case_no", "Manufacturer case number", True),
    ),
    "module_warranty": (
        ("iv_sweep", "I-V sweep at STC (module test candidate)", True),
        ("second_source", "Second source: IR flight or time-series issue", True),
        ("plr", "PLR analysis (≥ 2 years of data)", False),
        ("serials", "Module serial numbers", True),
        ("photos", "Photos", True),
    ),
    "equipment_warranty": (
        ("device_sn", "Device serial number", True),
        ("fault", "Fault description", True),
        ("photos", "Photos", True),
    ),
    "insurance": (
        ("incident_report", "Incident report", True),
        ("photos", "Photos of the damage", True),
        ("weather", "Weather on the day (radar / Google Weather)", False),
        ("quotation", "Repair quotation", True),
        ("police_report", "Police report (theft)", False),
    ),
    "workmanship": (
        ("defect", "Defect description", True),
        ("photos", "Photos", True),
        ("contract", "Contract / warranty reference", True),
    ),
}
LINK_KINDS = ("issue", "iv_sweep", "site_log")
EVENT_KINDS = ("note", "message", "shipment")

# fields a create / patch may set
FIELDS = (
    "claim_type",
    "cause",
    "plant_id",
    "device_sn",
    "string_nos",
    "module_serials",
    "device_label",
    "counterparty",
    "counterparty_ref",
    "description",
    "incident_day",
    "discovered_day",
    "warranty_end_day",
)
REQUIRED_FIELDS = ("claim_type", "cause", "plant_id", "counterparty")
MAX_MODULE_SERIALS = 200


class ClaimConflict(Exception):
    """The request clashes with the claim's state (status change not allowed, closed claim,
    not a draft, already linked): 409."""


def _today() -> date:
    return datetime.now(PLANT_TZ).date()


def _local(ts: Optional[datetime]) -> Optional[str]:
    """A stored UTC time as plant-local ISO (the page slices the date from it)."""
    if ts is None:
        return None
    if ts.tzinfo is None:  # SQLite drops the zone
        ts = ts.replace(tzinfo=ZoneInfo("UTC"))
    return ts.astimezone(PLANT_TZ).isoformat(timespec="seconds")


def _clean(s: Optional[str]) -> Optional[str]:
    if s is None:
        return None
    s = s.strip()
    return s or None


def _plant(db: Session, plant_id: int) -> GrowattPlant:
    p = db.get(GrowattPlant, plant_id)
    if p is None:
        raise GrowattNotFound(f"Plant {plant_id} not found")
    return p


# --------------------------------------------------------------------------- validation


def _serial_input(v: Any) -> Optional[Dict[str, Any]]:
    """`{method, raw}` as stored in `serial_inputs` (validated by the route's schema), or None."""
    if not isinstance(v, dict) or v.get("method") not in INPUT_METHODS:
        return None
    raw = v.get("raw")
    return {"method": v["method"], "raw": raw[:512] if isinstance(raw, str) and raw else None}


def _with_input(c: Claim, field: str, inp: Optional[Dict[str, Any]]) -> None:
    """Set (or, with None, forget) how `field` was entered; a new dict so the JSON change is saved."""
    cur = dict(c.serial_inputs or {})
    if inp is None:
        cur.pop(field, None)
    else:
        cur[field] = inp
    c.serial_inputs = cur or None


def _normalize(db: Session, fields: Dict[str, Any], current: Optional[Claim]) -> Dict[str, Any]:
    """Clean and check the fields sent (all of them on create, the changed ones on patch) against
    the claim they will produce. Raises ValueError (422)."""
    out = dict(fields)
    for k in ("device_sn", "device_label", "counterparty", "counterparty_ref", "description"):
        if k in out:
            out[k] = _clean(out[k])
    if "string_nos" in out:
        out["string_nos"] = sorted(set(out["string_nos"] or []))
    if "module_serials" in out:
        seen: List[str] = []
        for s in out["module_serials"] or []:
            s = (s or "").strip()
            if s and s not in seen:
                seen.append(s)
        if len(seen) > MAX_MODULE_SERIALS:
            raise ValueError(f"At most {MAX_MODULE_SERIALS} module serials")
        out["module_serials"] = seen

    def val(k: str) -> Any:
        return out[k] if k in out else (getattr(current, k) if current is not None else None)

    if val("claim_type") not in CLAIM_TYPES:
        raise ValueError(f"type must be one of {', '.join(CLAIM_TYPES)}")
    if val("cause") not in CAUSES:
        raise ValueError(f"cause must be one of {', '.join(CAUSES)}")
    if not val("counterparty"):
        raise ValueError("Say who the claim is with (counterparty)")
    plant_id = val("plant_id")
    _plant(db, plant_id)
    sn = val("device_sn")
    if val("claim_type") == "inverter_warranty" and not sn:
        raise ValueError("An inverter warranty claim needs the inverter (device_sn)")
    if val("string_nos") and not sn:
        raise ValueError("Strings need their inverter (device_sn)")
    if sn and ("device_sn" in out or "plant_id" in out):
        found = db.scalar(
            select(GrowattInverter.device_sn).where(GrowattInverter.plant_id == plant_id, GrowattInverter.device_sn == sn)
        )
        if found is None:
            raise ValueError(f"Inverter {sn} does not belong to plant {plant_id}")
    today = _today()
    incident, discovered = val("incident_day"), val("discovered_day")
    for k, d in (("incident_day", incident), ("discovered_day", discovered)):
        if d is not None and d > today:
            raise ValueError(f"{k} is in the future")
    if incident is not None and discovered is not None and discovered < incident:
        raise ValueError("discovered_day is before incident_day")
    return out


def _check_url(url: Optional[str]) -> Optional[str]:
    """Evidence links are shown as links: only http(s) URLs or the app's own paths."""
    url = _clean(url)
    if url is None:
        return None
    low = url.lower()
    if not (low.startswith("https://") or low.startswith("http://") or (url.startswith("/") and not url.startswith("//"))):
        raise ValueError("The link must be an http(s) URL or a path in this app (starting with /)")
    return url


# --------------------------------------------------------------------------- reading


def _required(c: Claim, key: str, required: bool) -> bool:
    return required or (key == "police_report" and c.cause == "theft")


def _evidence_rows(db: Session, ids: Iterable[int]) -> Dict[int, Dict[str, ClaimEvidence]]:
    out: Dict[int, Dict[str, ClaimEvidence]] = {}
    ids = list(ids)
    if ids:
        for e in db.scalars(select(ClaimEvidence).where(ClaimEvidence.claim_id.in_(ids))):
            out.setdefault(e.claim_id, {})[e.key] = e
    return out


def evidence_list(c: Claim, stored: Dict[str, ClaimEvidence]) -> List[Dict[str, Any]]:
    """The type's checklist with what people set. Items of another type (after a type change)
    stay stored but are not shown."""
    out = []
    for key, label, required in EVIDENCE[c.claim_type]:
        e = stored.get(key)
        out.append(
            {
                "key": key,
                "label": label,
                "required": _required(c, key, required),
                "done": bool(e and e.done),
                "url": e.url if e else None,
                "note": e.note if e else None,
                "by": e.by if e else None,
                "at": _local(e.at) if e else None,
            }
        )
    return out


def serialize(c: Claim, plant_name: Optional[str], evidence: List[Dict[str, Any]], today: date) -> Dict[str, Any]:
    open_ = c.status not in CLOSED
    req = [e for e in evidence if e["required"]]
    return {
        "id": c.id,
        "number": c.number,
        "type": c.claim_type,
        "status": c.status,
        "cause": c.cause,
        "plant_id": c.plant_id,
        "plant_name": plant_name,
        "device_sn": c.device_sn,
        "string_nos": list(c.string_nos or []),
        "module_serials": list(c.module_serials or []),
        "device_label": c.device_label,
        "counterparty": c.counterparty,
        "counterparty_ref": c.counterparty_ref,
        "description": c.description,
        "incident_day": c.incident_day.isoformat() if c.incident_day else None,
        "discovered_day": c.discovered_day.isoformat() if c.discovered_day else None,
        "submitted_day": c.submitted_day.isoformat() if c.submitted_day else None,
        "closed_day": c.closed_day.isoformat() if c.closed_day else None,
        "next_action_day": c.next_action_day.isoformat() if c.next_action_day else None,
        "followup_overdue": bool(open_ and c.next_action_day is not None and c.next_action_day < today),
        "waiting_on": WAITING.get(c.status),
        "old_sn": c.old_sn,
        "new_sn": c.new_sn,
        # how device_sn / new_sn were entered ({field: {method, raw}}; a field missing = not recorded)
        "serial_inputs": dict(c.serial_inputs or {}),
        "warranty_end_day": c.warranty_end_day.isoformat() if c.warranty_end_day else None,
        "evidence_done": sum(1 for e in req if e["done"]),
        "evidence_required": len(req),
        "created_by": c.created_by,
        "updated_by": c.updated_by,
        "created_at": _local(c.created_at),
        "updated_at": _local(c.updated_at),
    }


def _plant_names(db: Session, ids: Set[int]) -> Dict[int, str]:
    if not ids:
        return {}
    return dict(db.execute(select(GrowattPlant.plant_id, GrowattPlant.name).where(GrowattPlant.plant_id.in_(ids))).all())  # type: ignore[arg-type]


def one(db: Session, c: Claim) -> Dict[str, Any]:
    names = _plant_names(db, {c.plant_id})
    ev = evidence_list(c, _evidence_rows(db, [c.id]).get(c.id, {}))
    return serialize(c, names.get(c.plant_id), ev, _today())


def list_claims(
    db: Session,
    plant_ids: Optional[Set[int]],
    *,
    status: Optional[Iterable[str]] = None,
    claim_type: Optional[str] = None,
    plant_id: Optional[int] = None,
) -> Dict[str, Any]:
    """Claims the user may see, newest first, with the summary counts over them."""
    q = select(Claim)
    if plant_ids is not None:
        q = q.where(Claim.plant_id.in_(plant_ids))
    if plant_id is not None:
        q = q.where(Claim.plant_id == plant_id)
    statuses = [s for s in (status or []) if s]
    if statuses:
        q = q.where(Claim.status.in_(statuses))
    if claim_type:
        q = q.where(Claim.claim_type == claim_type)
    rows = list(db.scalars(q.order_by(Claim.created_at.desc(), Claim.id.desc())))
    names = _plant_names(db, {c.plant_id for c in rows})
    ev = _evidence_rows(db, [c.id for c in rows])
    today = _today()
    claims = [serialize(c, names.get(c.plant_id), evidence_list(c, ev.get(c.id, {})), today) for c in rows]
    open_ = [c for c in claims if c["status"] not in CLOSED]
    return {
        "claims": claims,
        "summary": {
            "open": len(open_),
            "waiting_us": sum(1 for c in open_ if c["waiting_on"] == "us"),
            "waiting_them": sum(1 for c in open_ if c["waiting_on"] == "them"),
            "followup_overdue": sum(1 for c in open_ if c["followup_overdue"]),
        },
        "meta": {"source": "db", "today": today.isoformat()},
    }


def get_claim(db: Session, claim_id: int, plant_ids: Optional[Set[int]]) -> Claim:
    """The claim, or GrowattNotFound when it does not exist or its plant is not the user's."""
    c = db.get(Claim, claim_id)
    if c is None or (plant_ids is not None and c.plant_id not in plant_ids):
        raise GrowattNotFound(f"Claim {claim_id} not found")
    return c


def serialize_event(e: ClaimEvent) -> Dict[str, Any]:
    return {
        "id": e.id,
        "kind": e.kind,
        "at": _local(e.at),
        "day": e.day.isoformat() if e.day else None,
        "by": e.by,
        "from_status": e.from_status,
        "to_status": e.to_status,
        "direction": e.direction,
        "summary": e.summary,
        "carrier": e.carrier,
        "tracking_no": e.tracking_no,
        "sn": e.sn,
    }


def _link_labels(db: Session, links: List[ClaimLink], allow_shadow: bool) -> Dict[int, Optional[str]]:
    """A short label per link from the record it points to (null when gone or not visible)."""
    from app.services import growatt_rules, site_events

    by_kind: Dict[str, Set[int]] = {}
    for link in links:
        by_kind.setdefault(link.kind, set()).add(link.ref_id)
    labels: Dict[Tuple[str, int], str] = {}
    if by_kind.get("issue"):
        for i in db.scalars(select(GrowattIssue).where(GrowattIssue.id.in_(by_kind["issue"]))):
            if i.shadow and not allow_shadow:
                continue
            where = f"string {i.string_no}" if i.string_no is not None else (i.device_sn or "")
            labels[("issue", i.id)] = " · ".join(x for x in (f"{i.rule} {growatt_rules.RULE_NAMES.get(i.rule, i.rule)}", where) if x)
    if by_kind.get("iv_sweep"):
        for s in db.scalars(select(GrowattIvSweep).where(GrowattIvSweep.id.in_(by_kind["iv_sweep"]))):
            parts = [f"I-V sweep {s.swept_at:%Y-%m-%d %H:%M}", s.device_sn or ""]
            if s.string_no is not None:
                parts.append(f"string {s.string_no}")
            labels[("iv_sweep", s.id)] = " · ".join(p for p in parts if p)
    if by_kind.get("site_log"):
        for ev in db.scalars(select(SiteEvent).where(SiteEvent.id.in_(by_kind["site_log"]))):
            labels[("site_log", ev.id)] = f"{site_events.EVENT_LABELS.get(ev.event_type, ev.event_type)} {ev.day.isoformat()}"
    return {link.id: labels.get((link.kind, link.ref_id)) for link in links}


def _shadow_issue_ids(db: Session, links: List[ClaimLink]) -> Set[int]:
    """Issue ids among the links that are shadow-mode issues (admin only)."""
    ids = {l.ref_id for l in links if l.kind == "issue"}
    if not ids:
        return set()
    return set(db.scalars(select(GrowattIssue.id).where(GrowattIssue.id.in_(ids), GrowattIssue.shadow.is_(True))))


def serialize_links(db: Session, links: List[ClaimLink], allow_shadow: bool) -> List[Dict[str, Any]]:
    """Links with their labels. Without `allow_shadow`, links to shadow issues are left out
    entirely (not even the id shows); a link to a record that is gone keeps `label: null`."""
    if not allow_shadow:
        hidden = _shadow_issue_ids(db, links)
        links = [l for l in links if not (l.kind == "issue" and l.ref_id in hidden)]
    labels = _link_labels(db, links, allow_shadow)
    return [{"id": l.id, "kind": l.kind, "ref_id": l.ref_id, "label": labels.get(l.id)} for l in links]


def detail(db: Session, c: Claim, allow_shadow: bool) -> Dict[str, Any]:
    """The claim with its timeline (newest first), evidence checklist and links."""
    out = one(db, c)
    events = db.scalars(select(ClaimEvent).where(ClaimEvent.claim_id == c.id).order_by(ClaimEvent.at.desc(), ClaimEvent.id.desc()))
    out["events"] = [serialize_event(e) for e in events]
    out["evidence"] = evidence_list(c, _evidence_rows(db, [c.id]).get(c.id, {}))
    links = list(db.scalars(select(ClaimLink).where(ClaimLink.claim_id == c.id).order_by(ClaimLink.id)))
    out["links"] = serialize_links(db, links, allow_shadow)
    return out


# --------------------------------------------------------------------------- writing


def _event(db: Session, c: Claim, kind: str, who: str, summary: str, **kw: Any) -> ClaimEvent:
    e = ClaimEvent(claim_id=c.id, kind=kind, by=who, summary=summary, **kw)
    db.add(e)
    c.updated_by = who
    c.updated_at = datetime.now(ZoneInfo("UTC"))
    return e


def _next_number(db: Session, year: int) -> str:
    prefix = f"CL-{year}-"
    taken = db.scalars(select(Claim.number).where(Claim.number.like(f"{prefix}%")))
    top = 0
    for n in taken:
        try:
            top = max(top, int(n[len(prefix):]))
        except ValueError:
            continue
    return f"{prefix}{top + 1:03d}"


def _check_link(db: Session, plant_id: int, kind: str, ref_id: int, allow_shadow: bool) -> None:
    if kind not in LINK_KINDS:
        raise ValueError(f"kind must be one of {', '.join(LINK_KINDS)}")
    if kind == "issue":
        i = db.get(GrowattIssue, ref_id)
        ok = i is not None and i.plant_id == plant_id and (allow_shadow or not i.shadow)
        what = "issue"
    elif kind == "iv_sweep":
        s = db.get(GrowattIvSweep, ref_id)
        ok = s is not None and s.plant_id == plant_id
        what = "I-V sweep"
    else:
        ev = db.get(SiteEvent, ref_id)
        ok = ev is not None and ev.plant_id == plant_id
        what = "site log event"
    if not ok:
        raise ValueError(f"{ref_id} is not a {what} of plant {plant_id}")


def create_claim(
    db: Session, fields: Dict[str, Any], links: List[Dict[str, Any]], who: str, *, allow_shadow: bool, fault: Any = None
) -> Claim:
    """A new draft. `links` are checked first, so a bad one leaves nothing behind. `fault` (a
    `FieldFault` the route checked with `faults.check_attach`): linked in the same transaction, and
    waiting on the claim when its decision is `claim` (docs/plans/defects.md §6.4)."""
    for k in REQUIRED_FIELDS:
        if fields.get(k) in (None, ""):
            raise ValueError(f"{k} is required")
    sn_input = _serial_input(fields.get("device_sn_input"))
    data = _normalize(db, {k: fields.get(k) for k in FIELDS}, None)
    pairs = []
    for link in links:
        pair = (link["kind"], int(link["ref_id"]))
        _check_link(db, data["plant_id"], *pair, allow_shadow)
        if pair not in pairs:
            pairs.append(pair)
    c: Optional[Claim] = None
    for attempt in range(3):
        c = Claim(
            number=_next_number(db, _today().year),
            status="draft",
            old_sn=data.get("device_sn") if data["claim_type"] == "inverter_warranty" else None,
            created_by=who,
            serial_inputs={"device_sn": sn_input} if sn_input and data.get("device_sn") else None,
            **data,
        )
        db.add(c)
        try:
            db.flush()  # claims.number is unique: two claims opened at once can take the same number
            break
        except IntegrityError:
            db.rollback()
            if attempt == 2:
                raise ClaimConflict("Another claim took the same number: try again") from None
    assert c is not None
    for kind, ref_id in pairs:
        db.add(ClaimLink(claim_id=c.id, kind=kind, ref_id=ref_id, created_by=who))
    _event(db, c, "created", who, "Claim created")
    c.updated_by = None
    if fault is not None:
        from app.services import faults

        if fault.plant_id != c.plant_id:
            raise ValueError(f"Fault {fault.no} is not a fault of plant {c.plant_id}")
        decided = fault.decision == "claim"
        faults.attach(db, fault, who, "claim", ref_id=c.id, to_status="waiting" if decided else None, waiting_reason="claim" if decided else None)
    db.commit()
    return c


def update_claim(db: Session, c: Claim, fields: Dict[str, Any], who: str, *, admin: bool) -> List[str]:
    """Change the fields sent. A closed or withdrawn claim is changed by admins only. Returns the
    names of the fields that changed (an `edit` event records old → new)."""
    _check_open(c, admin)
    sn_input = _serial_input(fields.get("device_sn_input"))
    fields = {k: v for k, v in fields.items() if k in FIELDS}
    for k in REQUIRED_FIELDS:
        if k in fields and fields[k] in (None, ""):
            fields.pop(k)  # required on the claim: null means "unchanged"
    data = _normalize(db, fields, c)
    if "plant_id" in data and data["plant_id"] != c.plant_id:
        has_links = db.scalar(select(ClaimLink.id).where(ClaimLink.claim_id == c.id).limit(1))
        if has_links is not None:
            raise ValueError("Remove the linked records before moving the claim to another plant")
    changed: Dict[str, List[Any]] = {}
    for k, v in data.items():
        old = getattr(c, k)
        if old != v:
            changed[k] = [old.isoformat() if isinstance(old, date) else old, v.isoformat() if isinstance(v, date) else v]
            setattr(c, k, v)
    # a new SN keeps the input it came with (none = not recorded); the same SN scanned again records the scan
    input_changed = False
    if "device_sn" in changed:
        _with_input(c, "device_sn", sn_input if c.device_sn else None)
        input_changed = True
    elif sn_input is not None and c.device_sn and (c.serial_inputs or {}).get("device_sn") != sn_input:
        _with_input(c, "device_sn", sn_input)
        input_changed = True
    if not changed:
        if input_changed:
            db.commit()
        return []
    if c.claim_type == "inverter_warranty" and c.old_sn is None:
        c.old_sn = c.device_sn
    names = sorted(changed)
    labels = {"claim_type": "type"}
    _event(db, c, "edit", who, "Edited: " + ", ".join(labels.get(n, n).replace("_", " ") for n in names), detail=changed)
    db.commit()
    return names


_UNSET: Any = object()


def set_status(
    db: Session,
    c: Claim,
    status: str,
    note: str,
    who: str,
    *,
    next_action_day: Optional[date] = _UNSET,
    new_sn: Optional[str] = None,
    new_sn_input: Optional[Dict[str, Any]] = None,
) -> Claim:
    """Move the claim along the workflow (TRANSITIONS); a note is required. Submitting stamps
    `submitted_day` once; closing / withdrawing stamps `closed_day` and clears the next action;
    `new_sn` records the replacement unit of an inverter swap."""
    if status not in STATUSES:
        raise ValueError(f"status must be one of {', '.join(STATUSES)}")
    frm = c.status
    if status not in TRANSITIONS[frm]:
        raise ClaimConflict(f"Cannot go from {frm} to {status}")
    note = (note or "").strip()
    if not note:
        raise ValueError("A note is required")
    new_sn = _clean(new_sn)
    today = _today()
    c.status = status
    if status == "submitted" and c.submitted_day is None:
        c.submitted_day = today
    c.closed_day = today if status in CLOSED else None
    if next_action_day is not _UNSET:
        c.next_action_day = next_action_day
    if status in CLOSED:
        c.next_action_day = None
    if new_sn:
        if new_sn != c.new_sn or new_sn_input is not None:
            _with_input(c, "new_sn", _serial_input(new_sn_input))
        c.new_sn = new_sn
        if c.old_sn is None:
            c.old_sn = c.device_sn
    _event(db, c, "status", who, note[:2000], from_status=frm, to_status=status, sn=new_sn)
    db.commit()
    return c


def _check_open(c: Claim, admin: bool) -> None:
    """A closed or withdrawn claim is changed by admins only."""
    if c.status in CLOSED and not admin:
        raise ClaimConflict("The claim is closed: only an admin can change it")


def add_event(db: Session, c: Claim, body: Dict[str, Any], who: str, *, admin: bool) -> ClaimEvent:
    """A note, a message sent / received or a shipment out / in."""
    _check_open(c, admin)
    kind = body.get("kind")
    if kind not in EVENT_KINDS:
        raise ValueError(f"kind must be one of {', '.join(EVENT_KINDS)}")
    summary = (body.get("summary") or "").strip()
    if not summary:
        raise ValueError("Say what happened (summary)")
    day = body.get("day")
    if day is not None and day > _today():
        raise ValueError("The day is in the future")
    direction = body.get("direction")
    if kind == "note":
        day, direction = None, None
    elif direction not in ("out", "in"):
        raise ValueError("direction must be out or in")
    shipment = kind == "shipment"
    e = _event(
        db,
        c,
        kind,
        who,
        summary[:2000],
        day=day,
        direction=direction,
        carrier=_clean(body.get("carrier")) if shipment else None,
        tracking_no=_clean(body.get("tracking_no")) if shipment else None,
        sn=_clean(body.get("sn")) if shipment else None,
    )
    db.commit()
    return e


def set_evidence(db: Session, c: Claim, key: str, body: Dict[str, Any], who: str, *, admin: bool) -> Dict[str, Any]:
    """Tick / untick a checklist item, with an optional link and note (only the ones sent change)."""
    _check_open(c, admin)
    if key not in {k for k, _, _ in EVIDENCE[c.claim_type]}:
        raise GrowattNotFound(f"No evidence item {key} for a {c.claim_type} claim")
    e = db.get(ClaimEvidence, (c.id, key))
    if e is None:
        e = ClaimEvidence(claim_id=c.id, key=key, done=False)
        db.add(e)
    e.done = bool(body.get("done"))
    if "url" in body:
        e.url = _check_url(body["url"])
    if "note" in body:
        e.note = _clean(body["note"])
    now = datetime.now(ZoneInfo("UTC"))
    e.by = who
    e.at = now
    c.updated_by = who
    c.updated_at = now
    db.commit()
    return next(x for x in evidence_list(c, _evidence_rows(db, [c.id]).get(c.id, {})) if x["key"] == key)


def add_link(db: Session, c: Claim, kind: str, ref_id: int, who: str, *, allow_shadow: bool) -> ClaimLink:
    """Admins (`allow_shadow`) may also link shadow issues and change closed claims."""
    _check_open(c, allow_shadow)
    _check_link(db, c.plant_id, kind, ref_id, allow_shadow)
    if db.scalar(select(ClaimLink.id).where(ClaimLink.claim_id == c.id, ClaimLink.kind == kind, ClaimLink.ref_id == ref_id)):
        raise ClaimConflict("Already linked")
    link = ClaimLink(claim_id=c.id, kind=kind, ref_id=ref_id, created_by=who)
    db.add(link)
    c.updated_by = who
    c.updated_at = datetime.now(ZoneInfo("UTC"))
    db.commit()
    return link


def delete_link(db: Session, c: Claim, link_id: int, who: str, *, allow_shadow: bool) -> None:
    """A link to a shadow issue does not exist for a non-admin (404, like in `detail`)."""
    link = db.get(ClaimLink, link_id)
    if link is None or link.claim_id != c.id or (not allow_shadow and _shadow_issue_ids(db, [link])):
        raise GrowattNotFound(f"Link {link_id} not found")
    _check_open(c, allow_shadow)
    db.delete(link)
    c.updated_by = who
    c.updated_at = datetime.now(ZoneInfo("UTC"))
    db.commit()


def delete_claim(db: Session, c: Claim) -> None:
    """Only a draft is deleted; a claim that went out is withdrawn instead, so its record stays."""
    if c.status != "draft":
        raise ClaimConflict("Only a draft can be deleted: withdraw it instead")
    db.delete(c)
    db.commit()
