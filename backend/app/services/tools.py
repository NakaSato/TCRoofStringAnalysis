"""Measuring Tools: instruments, check-outs and calibration / document due dates
(docs/plans/measuring-tools.md).

The service owns what the page, a future push and the AI Assistant must agree on: each instrument's
due items and their state (overdue / due soon / ok / none), the summary counts, the check-out
warnings, and the status changes a check-out or return makes. Every spec, date, interval and cost
is as entered; a next due date is computed only from an interval someone entered, and a missing
date is `none`, never `ok`. SQL only (never Firestore), kept indefinitely.

Access (applied by the routes): everyone views, checks out (engineers only to themselves and to
their assigned plants) and returns what they hold; admins add, edit, retire, delete and record
calibrations / documents. A check-out to a plant an engineer may not see shows no plant.
"""

from __future__ import annotations

import calendar
from datetime import date, datetime, timedelta
from typing import Any, Dict, Iterable, List, Optional, Set
from zoneinfo import ZoneInfo

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.db.models import GrowattPlant, Instrument, InstrumentCheckout, InstrumentDueRecord, User
from app.services.growatt_common import GrowattNotFound

PLANT_TZ = ZoneInfo("Asia/Bangkok")
UTC = ZoneInfo("UTC")

DUE_SOON_DAYS = 30

CATEGORIES = (
    "drone",
    "thermal_camera",
    "iv_tracer",
    "insulation_tester",
    "clamp_meter",
    "multimeter",
    "irradiance_meter",
    "earth_tester",
    "power_analyser",
    "other",
)
STATUSES = ("available", "checked_out", "at_calibration", "repair", "retired")
DUE_KINDS = ("calibration", "caat", "nbtc", "insurance", "pilot_licence", "other")
CONDITIONS = ("ok", "damaged", "lost")

# what runs out per category (same as the page's format.ts); a kind recorded outside this list
# (e.g. a pilot licence) is listed too, once it has a record
CATEGORY_DUE: Dict[str, tuple[str, ...]] = {"drone": ("caat", "nbtc", "insurance")}
DEFAULT_DUE = ("calibration",)

# status after a return, by condition
RETURN_STATUS = {"ok": "available", "damaged": "repair", "lost": "retired"}

WARN_CALIBRATION = "calibration_overdue"
WARN_DRONE_DOCS = "drone_documents_expired"

# overdue first; `none` (no date) ranks above ok, so an instrument with nothing entered is never ok
_RANK = {"overdue": 0, "due_soon": 1, "none": 2, "ok": 3}

FIELDS = (
    "asset_tag",
    "name",
    "category",
    "make",
    "model",
    "serial_no",
    "specs",
    "calibration_interval_months",
    "purchase_day",
    "cost_thb",
    "note",
)


class ToolConflict(Exception):
    """The request clashes with the instrument's state (not available, still out, asset tag used,
    checked out before, warning not acknowledged): 409."""


class ToolForbidden(Exception):
    """The user may not do this (check out to someone else, return what another holds): 403."""


def _today() -> date:
    return datetime.now(PLANT_TZ).date()


def _local(ts: Optional[datetime]) -> Optional[str]:
    """A stored UTC time as plant-local "YYYY-MM-DD HH:MM:SS" (the page slices it)."""
    if ts is None:
        return None
    if ts.tzinfo is None:  # SQLite drops the zone
        ts = ts.replace(tzinfo=UTC)
    return ts.astimezone(PLANT_TZ).strftime("%Y-%m-%d %H:%M:%S")


def _day(d: Optional[date]) -> Optional[str]:
    return d.isoformat() if d else None


def _clean(s: Optional[str]) -> Optional[str]:
    if s is None:
        return None
    s = s.strip()
    return s or None


def add_months(day: date, months: int) -> date:
    """Same day `months` later, clamped to the month's last day (31 Jan + 1 = 28/29 Feb)."""
    m = day.month - 1 + months
    y, m = day.year + m // 12, m % 12 + 1
    return date(y, m, min(day.day, calendar.monthrange(y, m)[1]))


def _check_url(url: Optional[str]) -> Optional[str]:
    """Certificate links are shown as links: only http(s) URLs or the app's own paths."""
    url = _clean(url)
    if url is None:
        return None
    low = url.lower()
    if not (low.startswith("https://") or low.startswith("http://") or (url.startswith("/") and not url.startswith("//"))):
        raise ValueError("The link must be an http(s) URL or a path in this app (starting with /)")
    return url


def _who_name(u: User) -> str:
    return u.full_name or u.username or u.email


# --------------------------------------------------------------------------- due items


def state_of(next_due: Optional[date], today: date, soon_days: int = DUE_SOON_DAYS) -> str:
    if next_due is None:
        return "none"
    if next_due < today:
        return "overdue"
    return "due_soon" if next_due <= today + timedelta(days=soon_days) else "ok"


def due_items(category: str, records: Iterable[InstrumentDueRecord], today: date) -> List[Dict[str, Any]]:
    """One item per kind that runs out for the category (plus any other kind recorded): the newest
    record's next due date and its state."""
    latest: Dict[str, InstrumentDueRecord] = {}
    for r in records:
        cur = latest.get(r.kind)
        if cur is None or (r.day, r.id) > (cur.day, cur.id):
            latest[r.kind] = r
    kinds = list(CATEGORY_DUE.get(category, DEFAULT_DUE))
    kinds += [k for k in DUE_KINDS if k in latest and k not in kinds]
    out = []
    for kind in kinds:
        r = latest.get(kind)
        nd = r.next_due if r else None
        out.append(
            {
                "kind": kind,
                "last_day": _day(r.day) if r else None,
                "next_due": _day(nd),
                "state": state_of(nd, today),
                "number": r.number if r else None,
                "issuer": r.issuer if r else None,
            }
        )
    return out


def worst_state(items: List[Dict[str, Any]]) -> str:
    """The worst item's state; nothing to track = `none` (never ok without a date)."""
    if not items:
        return "none"
    return min((i["state"] for i in items), key=lambda s: _RANK[s])


def checkout_warnings(category: str, items: List[Dict[str, Any]]) -> List[str]:
    """Warnings a check-out must acknowledge (same rule as the page's `checkoutWarnings`)."""
    out = []
    if any(i["kind"] == "calibration" and i["state"] == "overdue" for i in items):
        out.append(WARN_CALIBRATION)
    if category == "drone" and any(i["state"] == "overdue" for i in items):
        out.append(WARN_DRONE_DOCS)
    return out


# --------------------------------------------------------------------------- reading


class _View:
    """What serializing a batch of instruments needs, read in a few queries."""

    def __init__(self, db: Session, instruments: List[Instrument], plant_ids: Optional[Set[int]]):
        ids = [i.id for i in instruments]
        self.plant_ids = plant_ids
        self.records: Dict[int, List[InstrumentDueRecord]] = {i: [] for i in ids}
        self.open: Dict[int, InstrumentCheckout] = {}
        self.counts: Dict[int, int] = {}
        if ids:
            for r in db.scalars(select(InstrumentDueRecord).where(InstrumentDueRecord.instrument_id.in_(ids))):
                self.records[r.instrument_id].append(r)
            for c in db.scalars(
                select(InstrumentCheckout).where(InstrumentCheckout.instrument_id.in_(ids), InstrumentCheckout.returned_at.is_(None))
            ):
                self.open[c.instrument_id] = c
            rows = db.execute(
                select(InstrumentCheckout.instrument_id, func.count())
                .where(InstrumentCheckout.instrument_id.in_(ids))
                .group_by(InstrumentCheckout.instrument_id)
            )
            self.counts = {iid: int(n) for iid, n in rows}
        pids = {c.plant_id for c in self.open.values() if c.plant_id is not None}
        self.plant_names = _plant_names(db, pids)


def _plant_names(db: Session, ids: Set[int]) -> Dict[int, str]:
    if not ids:
        return {}
    return {p.plant_id: p.name for p in db.scalars(select(GrowattPlant).where(GrowattPlant.plant_id.in_(ids)))}


def serialize_checkout(c: InstrumentCheckout, today: date, plant_names: Dict[int, str], plant_ids: Optional[Set[int]]) -> Dict[str, Any]:
    # a plant the user may not see is not revealed (its id or name)
    visible = c.plant_id is not None and (plant_ids is None or c.plant_id in plant_ids)
    return {
        "id": c.id,
        "instrument_id": c.instrument_id,
        "holder": {"id": c.holder_user_id, "name": c.holder_name or "—"} if c.holder_user_id is not None or c.holder_name else None,
        "plant_id": c.plant_id if visible else None,
        "plant_name": plant_names.get(c.plant_id) if visible and c.plant_id is not None else None,
        "out_at": _local(c.out_at),
        "due_back": _day(c.due_back),
        "overdue": c.returned_at is None and c.due_back < today,
        "returned_at": _local(c.returned_at),
        "condition": c.condition,
        "note": c.note,
        "return_note": c.return_note,
        "ack_warnings": list(c.ack_warnings or []),
        "input_method": c.input_method,
        "raw_scan": c.raw_scan,
        "created_by": c.created_by,
    }


def serialize(i: Instrument, v: _View, today: date) -> Dict[str, Any]:
    items = due_items(i.category, v.records.get(i.id, []), today)
    dated = sorted(x["next_due"] for x in items if x["next_due"])
    open_c = v.open.get(i.id)
    oc = serialize_checkout(open_c, today, v.plant_names, v.plant_ids) if open_c else None
    return {
        "id": i.id,
        "asset_tag": i.asset_tag,
        "name": i.name,
        "category": i.category,
        "make": i.make,
        "model": i.model,
        "serial_no": i.serial_no,
        "status": i.status,
        "holder": oc["holder"] if oc else None,
        "open_checkout": oc,
        "specs": dict(i.specs or {}),
        "due": items,
        "next_due": dated[0] if dated else None,
        "due_state": worst_state(items),
        "calibration_interval_months": i.calibration_interval_months,
        "purchase_day": _day(i.purchase_day),
        "cost_thb": i.cost_thb,
        "note": i.note,
        "checkout_count": v.counts.get(i.id, 0),
        "created_by": i.created_by,
        "updated_by": i.updated_by,
        "created_at": _local(i.created_at),
        "updated_at": _local(i.updated_at),
    }


def one_checkout(db: Session, c: InstrumentCheckout, plant_ids: Optional[Set[int]]) -> Dict[str, Any]:
    names = _plant_names(db, {c.plant_id} if c.plant_id is not None else set())
    return serialize_checkout(c, _today(), names, plant_ids)


def one(db: Session, i: Instrument, plant_ids: Optional[Set[int]]) -> Dict[str, Any]:
    return serialize(i, _View(db, [i], plant_ids), _today())


def summary(rows: List[Dict[str, Any]]) -> Dict[str, int]:
    active = [r for r in rows if r["status"] != "retired"]
    return {
        "total": len(active),
        "available": sum(r["status"] == "available" for r in active),
        "checked_out": sum(r["status"] == "checked_out" for r in active),
        "overdue_back": sum(bool(r["open_checkout"] and r["open_checkout"]["overdue"]) for r in active),
        "due_soon": sum(any(d["state"] == "due_soon" for d in r["due"]) for r in active),
        "overdue": sum(any(d["state"] == "overdue" for d in r["due"]) for r in active),
    }


def list_instruments(db: Session, plant_ids: Optional[Set[int]], include_retired: bool = False) -> Dict[str, Any]:
    """Every instrument (retired ones only on request), the summary over those not retired."""
    today = _today()
    all_rows = list(db.scalars(select(Instrument).order_by(Instrument.asset_tag)))
    v = _View(db, all_rows, plant_ids)
    out = [serialize(i, v, today) for i in all_rows]
    return {
        "instruments": out if include_retired else [r for r in out if r["status"] != "retired"],
        "summary": summary(out),
        "categories": list(CATEGORIES),
        "meta": {"source": "db", "due_soon_days": DUE_SOON_DAYS, "today": today.isoformat()},
    }


def get_instrument(db: Session, instrument_id: int) -> Instrument:
    i = db.get(Instrument, instrument_id)
    if i is None:
        raise GrowattNotFound(f"Instrument {instrument_id} not found")
    return i


def serialize_record(r: InstrumentDueRecord) -> Dict[str, Any]:
    return {
        "id": r.id,
        "kind": r.kind,
        "day": _day(r.day),
        "next_due": _day(r.next_due),
        "number": r.number,
        "issuer": r.issuer,
        "cost_thb": r.cost_thb,
        "url": r.url,
        "note": r.note,
        "created_by": r.created_by,
        "created_at": _local(r.created_at),
    }


def detail(db: Session, i: Instrument, plant_ids: Optional[Set[int]]) -> Dict[str, Any]:
    """The instrument with every calibration / document record and every check-out, newest first."""
    today = _today()
    v = _View(db, [i], plant_ids)
    out = serialize(i, v, today)
    records = sorted(v.records.get(i.id, []), key=lambda r: (r.day, r.id), reverse=True)
    checkouts = list(
        db.scalars(
            select(InstrumentCheckout)
            .where(InstrumentCheckout.instrument_id == i.id)
            .order_by(InstrumentCheckout.out_at.desc(), InstrumentCheckout.id.desc())
        )
    )
    names = _plant_names(db, {c.plant_id for c in checkouts if c.plant_id is not None})
    out["due_history"] = [serialize_record(r) for r in records]
    out["checkouts"] = [serialize_checkout(c, today, names, plant_ids) for c in checkouts]
    return out


# --------------------------------------------------------------------------- writing


def _normalize(db: Session, fields: Dict[str, Any], current: Optional[Instrument]) -> Dict[str, Any]:
    out: Dict[str, Any] = {}
    for k, val in fields.items():
        if k not in FIELDS:
            continue
        if isinstance(val, str):
            val = _clean(val)
        out[k] = val
    for k in ("asset_tag", "name", "category"):
        if k in out and out[k] is None:
            if current is None:
                raise ValueError(f"{k} is required")
            out.pop(k)  # required on the instrument: null means "unchanged"
    if out.get("category") is not None and out["category"] not in CATEGORIES:
        raise ValueError(f"Unknown category {out['category']}")
    if "specs" in out:
        specs: Dict[str, Any] = {}
        for key, sv in (out["specs"] or {}).items():
            if isinstance(sv, str):
                sv = _clean(sv)
            specs[str(key).strip()] = sv
        out["specs"] = specs
    if out.get("purchase_day") is not None and out["purchase_day"] > _today():
        raise ValueError("The purchase day can't be in the future")
    tag = out.get("asset_tag")
    if tag is not None:
        q = select(Instrument.id).where(func.lower(Instrument.asset_tag) == tag.lower())
        if current is not None:
            q = q.where(Instrument.id != current.id)
        if db.scalar(q) is not None:
            raise ToolConflict(f"Asset tag {tag} is already used")
    return out


def create_instrument(db: Session, fields: Dict[str, Any], who: str) -> Instrument:
    vals = _normalize(db, fields, None)
    vals.setdefault("specs", {})
    i = Instrument(**vals, status="available", created_by=who)
    db.add(i)
    db.commit()
    db.refresh(i)
    return i


def update_instrument(db: Session, i: Instrument, fields: Dict[str, Any], who: str) -> List[str]:
    """Change the fields sent (and `status`: available / at_calibration / repair / retired, only
    while the instrument is not out). Returns the names of the fields that changed."""
    status = fields.pop("status", None)
    vals = _normalize(db, fields, i)
    if status is not None and status != i.status:
        if status not in STATUSES:
            raise ValueError(f"Unknown status {status}")
        if status == "checked_out":
            raise ValueError("Use check-out to hand an instrument out")
        if i.status == "checked_out":
            raise ToolConflict("It is checked out: check it in first")
        vals["status"] = status
    changed = [k for k, val in vals.items() if getattr(i, k) != val]
    if changed:
        for k in changed:
            setattr(i, k, vals[k])
        i.updated_by = who
        i.updated_at = datetime.now(UTC)
        db.commit()
        db.refresh(i)
    return changed


def delete_instrument(db: Session, i: Instrument) -> None:
    """Only an instrument never checked out (a typo); one with history is retired instead."""
    n = db.scalar(select(func.count()).select_from(InstrumentCheckout).where(InstrumentCheckout.instrument_id == i.id))
    if n:
        raise ToolConflict("It has been checked out before: retire it instead")
    db.delete(i)
    db.commit()


def checkout(
    db: Session,
    i: Instrument,
    body: Dict[str, Any],
    user: User,
    *,
    admin: bool,
    plant_ids: Optional[Set[int]],
) -> InstrumentCheckout:
    """Hand the instrument out. Engineers check out only to themselves and to their own plants
    (another plant = 404, like everywhere). Every warning that applies must be acknowledged."""
    if i.status != "available":
        raise ToolConflict(f"Not available ({i.status.replace('_', ' ')})")
    holder = user
    hid = body.get("holder_user_id")
    if hid is not None and hid != user.id:
        if not admin:
            raise ToolForbidden("Engineers can check out only to themselves")
        h = db.get(User, hid)
        if h is None or not h.is_active:
            raise ValueError(f"User {hid} not found")
        holder = h
    pid = body.get("plant_id")
    if pid is not None:
        if (plant_ids is not None and pid not in plant_ids) or db.get(GrowattPlant, pid) is None:
            raise GrowattNotFound(f"Plant {pid} not found")
    today = _today()
    due_back: date = body["due_back"]
    if due_back < today:
        raise ValueError("Due back can't be in the past")
    records = list(db.scalars(select(InstrumentDueRecord).where(InstrumentDueRecord.instrument_id == i.id)))
    warnings = checkout_warnings(i.category, due_items(i.category, records, today))
    acked = set(body.get("ack_warnings") or [])
    missing = [w for w in warnings if w not in acked]
    if missing:
        raise ToolConflict(f"Acknowledge first: {', '.join(missing)}")
    c = InstrumentCheckout(
        instrument_id=i.id,
        holder_user_id=holder.id,
        holder_name=_who_name(holder),
        plant_id=pid,
        due_back=due_back,
        note=_clean(body.get("note")),
        ack_warnings=warnings,
        input_method=body.get("input_method"),
        raw_scan=(body.get("raw_scan") or None) if body.get("input_method") else None,
        created_by=user.username or user.email,
    )
    db.add(c)
    i.status = "checked_out"
    db.commit()
    db.refresh(c)
    return c


def return_instrument(db: Session, i: Instrument, body: Dict[str, Any], user: User, *, admin: bool) -> InstrumentCheckout:
    """Check the instrument back in: ok → available, damaged → repair, lost → retired. Only the
    holder or an admin."""
    c = db.scalar(
        select(InstrumentCheckout).where(InstrumentCheckout.instrument_id == i.id, InstrumentCheckout.returned_at.is_(None))
    )
    if c is None:
        raise ToolConflict("It is not checked out")
    if not admin and c.holder_user_id != user.id:
        raise ToolForbidden("Only the holder or an admin can check it in")
    cond = body["condition"]
    if cond not in CONDITIONS:
        raise ValueError(f"Unknown condition {cond}")
    c.returned_at = datetime.now(UTC)
    c.condition = cond
    c.return_note = _clean(body.get("note"))
    c.returned_by = user.username or user.email
    i.status = RETURN_STATUS[cond]
    db.commit()
    db.refresh(c)
    return c


def record_due(db: Session, i: Instrument, body: Dict[str, Any], who: str) -> InstrumentDueRecord:
    """Record a calibration or document renewal. For a calibration without `next_due`, the next due
    date is `day` + the instrument's entered interval (none entered = no date). A calibration
    brings an instrument back from `at_calibration`."""
    kind = body["kind"]
    if kind not in DUE_KINDS:
        raise ValueError(f"Unknown kind {kind}")
    day: date = body["day"]
    if kind == "calibration" and day > _today():
        raise ValueError("Record a calibration once it is done (the day can't be in the future)")
    next_due: Optional[date] = body.get("next_due")
    if next_due is None and kind == "calibration" and i.calibration_interval_months:
        next_due = add_months(day, i.calibration_interval_months)
    if next_due is not None and next_due <= day:
        raise ValueError("The next due date must be after the day")
    cost = body.get("cost_thb")
    r = InstrumentDueRecord(
        instrument_id=i.id,
        kind=kind,
        day=day,
        next_due=next_due,
        number=_clean(body.get("number")),
        issuer=_clean(body.get("issuer")),
        cost_thb=cost,
        url=_check_url(body.get("url")),
        note=_clean(body.get("note")),
        created_by=who,
    )
    db.add(r)
    if kind == "calibration" and i.status == "at_calibration":
        i.status = "available"
        i.updated_by = who
        i.updated_at = datetime.now(UTC)
    db.commit()
    db.refresh(r)
    return r
