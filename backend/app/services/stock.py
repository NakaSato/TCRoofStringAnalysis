"""Spares register, phase 1 (docs/plans/spares-failed-units.md §4, §5.1–5.2, §5.6).

- Parts catalogue and stock locations: read by everyone signed in, changed by an admin or a store
  keeper (`auth.can_manage_stock`, D-1).
- Serialised spare units only (D-2): one `SpareUnit` per serial and part, in exactly one place.
- Movements: `apply_batch` validates every row against the current state (and the rows before it
  in the same batch) and applies all or nothing; a failing batch raises `StockConflict` with the
  failing rows (409). `receive` needs a store keeper; `transfer`, `issue`, `return` are field
  moves anyone may make. `correct` (store keeper) reverses a unit's latest movement with a
  `correction` row; nothing is ever edited or deleted. Movements of failed units (phase 2,
  `services/stock_failed.py`) are not corrected here.
- Stock on hand is counted from the units `in_stock` at each location, never stored.
- Counts (phase 5, `services/stock_count.py`) write `count_adjust` rows; a unit a count did not
  find is `missing` (no location): `receive` refuses its serial (count it in instead), and
  transfer / issue refuse it (not in stock). `correct` reverses a `count_adjust` row like any move.
- Plant scoping: a unit installed on a plant the user may not see, and movements naming such a
  plant, are left out; an issue / return to such a plant answers as an unknown plant.
"""

from __future__ import annotations

import re
import uuid
from collections import Counter, defaultdict
from datetime import date, datetime, timezone
from typing import Any, Dict, Iterable, List, Optional, Set, Tuple, Union
from zoneinfo import ZoneInfo

from sqlalchemy import func, or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.auth import allowed_plant_ids, can_manage_stock
from app.db.models import FailedUnit, GrowattPlant, Part, RedTag, SpareUnit, StockCount, StockLocation, StockMovement, User
from app.db.models.stock import FAILED_OPEN, INPUT_METHODS, LOCATION_KINDS, PART_CATEGORIES
from app.services.scan import clean

CODE = re.compile(r"^[A-Z0-9][A-Z0-9._/-]{0,39}$")
MAX_BATCH = 500
MAX_LIST = 1000
STOCK_KINDS = ("store", "bin", "van")  # where a spare can sit; the supplier comes with RMA (phase 2)


class StockError(ValueError):
    """Bad input (422)."""


class StockForbidden(PermissionError):
    """Needs an admin or store keeper (403)."""


class StockNotFound(LookupError):
    """404."""


class StockConflict(Exception):
    """A batch or correction that does not fit the current state (409): `errors` = [{row, error}]."""

    def __init__(self, errors: List[Dict[str, Any]], extra: Optional[Dict[str, Any]] = None):
        super().__init__("; ".join(f"row {e['row']}: {e['error']}" if e.get("row") is not None else e["error"] for e in errors))
        self.errors = errors
        self.extra = extra or {}  # more keys for the 409 detail, e.g. `code` (stock_replace)


def iso_utc(dt: Optional[datetime]) -> Optional[str]:
    """A stored time as ISO 8601 with its UTC offset. SQLite gives naive datetimes back (the values are
    UTC); without the offset a browser reads them as local time (7 h off in Bangkok)."""
    if dt is None:
        return None
    return (dt if dt.tzinfo is not None else dt.replace(tzinfo=timezone.utc)).isoformat()


def serial_key(serial: str) -> str:
    return clean(serial).upper()


def _by(user: User) -> str:
    return user.username or user.email


def _need_keeper(user: User) -> None:
    if not can_manage_stock(user):
        raise StockForbidden("Admin or store keeper required.")


def _code(raw: Any, what: str) -> str:
    code = clean(str(raw or "")).upper()
    if not CODE.match(code):
        raise StockError(f"{what}: 1–40 letters, digits or . _ / - (got {raw!r})")
    return code


def _text(raw: Any, what: str, max_len: int, required: bool = False) -> Optional[str]:
    s = clean(str(raw)) if raw is not None else ""
    if not s:
        if required:
            raise StockError(f"{what} is required")
        return None
    if len(s) > max_len:
        raise StockError(f"{what}: at most {max_len} characters")
    return s


# ---------------------------------------------------------------------------------------- parts


def _on_hand(db: Session) -> Dict[int, Dict[Optional[int], int]]:
    """{part_id: {location_id: units in stock}}."""
    out: Dict[int, Dict[Optional[int], int]] = defaultdict(dict)
    for pid, lid, n in db.execute(
        select(SpareUnit.part_id, SpareUnit.location_id, func.count()).where(SpareUnit.state == "in_stock").group_by(SpareUnit.part_id, SpareUnit.location_id)
    ):
        out[pid][lid] = int(n)
    return out


def part_out(p: Part, on_hand: Optional[Dict[Optional[int], int]] = None) -> Dict[str, Any]:
    by_loc = on_hand or {}
    total = sum(by_loc.values())
    return {
        "id": p.id,
        "code": p.code,
        "name": p.name,
        "category": p.category,
        "make": p.make,
        "model": p.model,
        "serialised": p.serialised,
        "unit": p.unit,
        "min_qty": p.min_qty,
        "active": p.active,
        "note": p.note,
        "on_hand": total,
        "on_hand_by_location": [{"location_id": k, "qty": v} for k, v in sorted(by_loc.items(), key=lambda kv: kv[0] or 0)],
        "below_min": p.min_qty is not None and p.active and total < p.min_qty,
    }


def list_parts(db: Session, include_inactive: bool = False) -> List[Dict[str, Any]]:
    q = select(Part).order_by(Part.category, Part.code)
    if not include_inactive:
        q = q.where(Part.active.is_(True))
    hand = _on_hand(db)
    return [part_out(p, hand.get(p.id)) for p in db.scalars(q)]


def _part_fields(data: Dict[str, Any], partial: bool) -> Dict[str, Any]:
    out: Dict[str, Any] = {}
    if not partial or "code" in data:
        out["code"] = _code(data.get("code"), "Part code")
    if not partial or "name" in data:
        out["name"] = _text(data.get("name"), "Name", 120, required=True)
    if not partial or "category" in data:
        if data.get("category") not in PART_CATEGORIES:
            raise StockError(f"Category: one of {', '.join(PART_CATEGORIES)}")
        out["category"] = data["category"]
    for k, n in (("make", 64), ("model", 64)):
        if k in data:
            out[k] = _text(data.get(k), k.capitalize(), n)
    if "note" in data:
        out["note"] = _text(data.get("note"), "Note", 2000)
    if "min_qty" in data:
        v = data.get("min_qty")
        if v is not None and (not isinstance(v, int) or isinstance(v, bool) or v < 0 or v > 100000):
            raise StockError("Minimum: a whole number from 0, or empty")
        out["min_qty"] = v
    if "active" in data:
        out["active"] = bool(data["active"])
    if data.get("serialised") is False:
        raise StockError("Counted parts (no serial) come in a later phase; v1 stocks serialised units only")
    return out


def create_part(db: Session, user: User, data: Dict[str, Any]) -> Dict[str, Any]:
    _need_keeper(user)
    f = _part_fields(data, partial=False)
    if db.scalar(select(Part.id).where(Part.code == f["code"])) is not None:
        raise StockConflict([{"row": None, "error": f"Part code {f['code']} is already in the catalogue"}])
    p = Part(**f, serialised=True, unit="pc", created_by=_by(user))
    db.add(p)
    db.commit()
    return part_out(p)


def update_part(db: Session, user: User, part_id: int, data: Dict[str, Any]) -> Dict[str, Any]:
    _need_keeper(user)
    p = db.get(Part, part_id)
    if p is None:
        raise StockNotFound(f"Part {part_id} not found")
    f = _part_fields(data, partial=True)
    if "code" in f and f["code"] != p.code and db.scalar(select(Part.id).where(Part.code == f["code"])) is not None:
        raise StockConflict([{"row": None, "error": f"Part code {f['code']} is already in the catalogue"}])
    for k, v in f.items():
        setattr(p, k, v)
    db.commit()
    return part_out(p, _on_hand(db).get(p.id))


# ------------------------------------------------------------------------------------ locations


def location_out(
    loc: StockLocation, holders: Dict[int, str], counts: Dict[int, int], last_counts: Optional[Dict[int, StockCount]] = None
) -> Dict[str, Any]:
    last = (last_counts or {}).get(loc.id)
    return {
        "id": loc.id,
        "code": loc.code,
        "name": loc.name,
        "kind": loc.kind,
        "parent_id": loc.parent_id,
        "holder_user_id": loc.holder_user_id,
        "holder_name": holders.get(loc.holder_user_id) if loc.holder_user_id else None,
        "active": loc.active,
        "note": loc.note,
        "units": counts.get(loc.id, 0),
        "last_count_at": iso_utc(last.at) if last is not None else None,
        "last_count_by": last.by if last is not None else None,
    }


def _last_counts(db: Session) -> Dict[int, StockCount]:
    """{location_id: its newest confirmed count} (phase 5; computed, never stored on the location)."""
    newest = select(func.max(StockCount.id)).group_by(StockCount.location_id)
    return {c.location_id: c for c in db.scalars(select(StockCount).where(StockCount.id.in_(newest)))}


def _people(db: Session) -> Dict[int, str]:
    return {u.id: u.full_name or u.username or u.email for u in db.scalars(select(User))}


def _counts(db: Session) -> Dict[int, int]:
    return {
        lid: int(n)
        for lid, n in db.execute(select(SpareUnit.location_id, func.count()).where(SpareUnit.state == "in_stock").group_by(SpareUnit.location_id))
        if lid is not None
    }


def list_locations(db: Session, include_inactive: bool = False) -> List[Dict[str, Any]]:
    q = select(StockLocation).order_by(StockLocation.kind, StockLocation.code)
    if not include_inactive:
        q = q.where(StockLocation.active.is_(True))
    holders, counts, last = _people(db), _counts(db), _last_counts(db)
    return [location_out(loc, holders, counts, last) for loc in db.scalars(q)]


def list_people(db: Session) -> List[Dict[str, Any]]:
    """Active users, for a van's holder (names only)."""
    return [{"id": u.id, "name": u.full_name or u.username or u.email} for u in db.scalars(select(User).where(User.is_active.is_(True)).order_by(User.full_name))]


def _location_fields(db: Session, data: Dict[str, Any], partial: bool, current: Optional[StockLocation]) -> Dict[str, Any]:
    out: Dict[str, Any] = {}
    if not partial or "code" in data:
        out["code"] = _code(data.get("code"), "Location code")
    if not partial or "name" in data:
        out["name"] = _text(data.get("name"), "Name", 120, required=True)
    if not partial or "kind" in data:
        if data.get("kind") not in LOCATION_KINDS:
            raise StockError(f"Kind: one of {', '.join(LOCATION_KINDS)}")
        out["kind"] = data["kind"]
    kind = out.get("kind", current.kind if current else None)
    if "parent_id" in data or not partial:
        pid = data.get("parent_id")
        if pid is not None:
            parent = db.get(StockLocation, pid)
            if parent is None or parent.kind != "store" or (current is not None and parent.id == current.id):
                raise StockError("A bin's parent must be a store")
        out["parent_id"] = pid
    if kind == "bin" and out.get("parent_id", current.parent_id if current else None) is None:
        raise StockError("A bin belongs to a store: choose it")
    if kind != "bin":
        out["parent_id"] = None
    if "holder_user_id" in data or not partial:
        hid = data.get("holder_user_id")
        if hid is not None:
            if kind != "van":
                raise StockError("Only a van has a holder")
            h = db.get(User, hid)
            if h is None or not h.is_active:
                raise StockError("Holder: an active user")
        out["holder_user_id"] = hid
    if kind != "van":
        out["holder_user_id"] = None
    if "note" in data:
        out["note"] = _text(data.get("note"), "Note", 2000)
    if "active" in data:
        out["active"] = bool(data["active"])
    return out


def create_location(db: Session, user: User, data: Dict[str, Any]) -> Dict[str, Any]:
    _need_keeper(user)
    f = _location_fields(db, data, partial=False, current=None)
    if db.scalar(select(StockLocation.id).where(StockLocation.code == f["code"])) is not None:
        raise StockConflict([{"row": None, "error": f"Location code {f['code']} is already used"}])
    loc = StockLocation(**f)
    db.add(loc)
    db.commit()
    return location_out(loc, _people(db), {})


def update_location(db: Session, user: User, location_id: int, data: Dict[str, Any]) -> Dict[str, Any]:
    _need_keeper(user)
    loc = db.get(StockLocation, location_id)
    if loc is None:
        raise StockNotFound(f"Location {location_id} not found")
    f = _location_fields(db, data, partial=True, current=loc)
    if "code" in f and f["code"] != loc.code and db.scalar(select(StockLocation.id).where(StockLocation.code == f["code"])) is not None:
        raise StockConflict([{"row": None, "error": f"Location code {f['code']} is already used"}])
    counts = _counts(db)
    from app.services.stock_failed import open_failed_at  # imports this module

    failed = open_failed_at(db, loc.id)
    if f.get("active") is False and (counts.get(loc.id) or failed):
        held = " and ".join(x for x in (f"{counts[loc.id]} units" if counts.get(loc.id) else "", f"{failed} failed units" if failed else "") if x)
        raise StockConflict([{"row": None, "error": f"{loc.code} still holds {held}: move them first"}])
    if "kind" in f and f["kind"] != loc.kind and counts.get(loc.id) and f["kind"] not in STOCK_KINDS:
        raise StockConflict([{"row": None, "error": f"{loc.code} still holds units: it must stay a store, bin or van"}])
    if "kind" in f and f["kind"] != loc.kind and failed:
        raise StockConflict([{"row": None, "error": f"{loc.code} still holds {failed} failed units: move them before changing its kind"}])
    for k, v in f.items():
        setattr(loc, k, v)
    db.commit()
    return location_out(loc, _people(db), counts, _last_counts(db))


# ----------------------------------------------------------------------------------------- units


PLANT_TZ = ZoneInfo("Asia/Bangkok")


def _today() -> date:
    """The plant-local (Bangkok) day: a move at 06:30 belongs to today, not to UTC's yesterday."""
    return datetime.now(PLANT_TZ).date()


def _visible(allowed: Optional[Set[int]], plant_id: Optional[int]) -> bool:
    return plant_id is None or allowed is None or plant_id in allowed


def _unit_scope(allowed: Optional[Set[int]]):
    """SQL condition for the units a user may see: unplaced ones and those on their plants."""
    if allowed is None:
        return None
    return or_(SpareUnit.plant_id.is_(None), SpareUnit.plant_id.in_(allowed or {-1}))


# a serial is in one place (plan §3): a spare unit of any part in one of these states, or an open failed unit
HOLDING_STATES = ("in_stock", "installed", "failed", "at_supplier", "missing")


def serial_holders(
    db: Session, key: str, *, exclude_unit_id: Optional[int] = None, exclude_failed_id: Optional[int] = None
) -> List[Union[SpareUnit, FailedUnit]]:
    """Everything that already holds serial `key`: spare units of any part in a live state, then open
    failed units. Callers decide what to say about a holder on a plant the user may not see."""
    q = select(SpareUnit).where(SpareUnit.serial_key == key, SpareUnit.state.in_(HOLDING_STATES)).order_by(SpareUnit.id)
    if exclude_unit_id is not None:
        q = q.where(SpareUnit.id != exclude_unit_id)
    f = select(FailedUnit).where(FailedUnit.serial_key == key, FailedUnit.status.in_(FAILED_OPEN)).order_by(FailedUnit.id)
    if exclude_failed_id is not None:
        f = f.where(FailedUnit.id != exclude_failed_id)
    return [*db.scalars(q), *db.scalars(f)]


def serial_holder(
    db: Session, key: str, *, exclude_unit_id: Optional[int] = None, exclude_failed_id: Optional[int] = None
) -> Optional[Union[SpareUnit, FailedUnit]]:
    """The first of `serial_holders`, or None when the serial is free."""
    found = serial_holders(db, key, exclude_unit_id=exclude_unit_id, exclude_failed_id=exclude_failed_id)
    return found[0] if found else None


def holder_text(db: Session, holder: Union[SpareUnit, FailedUnit], allowed: Optional[Set[int]]) -> str:
    """What holds a serial, for a refusal: `is an open failed unit (RT-0001)` / `is already in the
    register as P-INV (in stock)`. A holder on a plant the user may not see is `another plant`, never
    its id or red tag."""
    hidden = not _visible(allowed, holder.plant_id)
    if isinstance(holder, FailedUnit):
        if hidden:
            return "is an open failed unit on another plant"
        tag = db.get(RedTag, holder.red_tag_id)
        return f"is an open failed unit ({tag.code if tag else holder.id})"
    part = db.get(Part, holder.part_id)
    state = holder.state.replace("_", " ")
    return f"is already in the register as {part.code if part else holder.part_id} ({state}{', another plant' if hidden else ''})"


def unit_out(u: SpareUnit, part: Part, locs: Dict[int, StockLocation], names: Dict[int, str]) -> Dict[str, Any]:
    loc = locs.get(u.location_id) if u.location_id else None
    return {
        "id": u.id,
        "part_id": u.part_id,
        "part_code": part.code,
        "part_name": part.name,
        "serial": u.serial,
        "state": u.state,
        "location_id": u.location_id,
        "location_code": loc.code if loc else None,
        "plant_id": u.plant_id,
        "plant_name": names.get(u.plant_id) if u.plant_id else None,
        "received_day": u.received_day.isoformat() if u.received_day else None,
        "note": u.note,
    }


def _plant_names(db: Session, ids: Iterable[Optional[int]]) -> Dict[int, str]:
    want = {i for i in ids if i is not None}
    if not want:
        return {}
    return dict(db.execute(select(GrowattPlant.plant_id, GrowattPlant.name).where(GrowattPlant.plant_id.in_(want))).all())


def list_units(
    db: Session,
    user: User,
    part_id: Optional[int] = None,
    location_id: Optional[int] = None,
    state: Optional[str] = None,
    q: Optional[str] = None,
) -> List[Dict[str, Any]]:
    allowed = allowed_plant_ids(db, user)
    stmt = select(SpareUnit, Part).join(Part, Part.id == SpareUnit.part_id).order_by(Part.code, SpareUnit.serial_key)
    if part_id is not None:
        stmt = stmt.where(SpareUnit.part_id == part_id)
    if location_id is not None:
        stmt = stmt.where(SpareUnit.location_id == location_id)
    stmt = stmt.where(SpareUnit.state == state) if state else stmt.where(SpareUnit.state != "void")
    if q:
        stmt = stmt.where(SpareUnit.serial_key.contains(serial_key(q)))
    scope = _unit_scope(allowed)
    if scope is not None:  # before the limit, so an engineer's units are not cut off by other plants'
        stmt = stmt.where(scope)
    rows = [(u, p) for u, p in db.execute(stmt.limit(MAX_LIST))]
    locs = {loc.id: loc for loc in db.scalars(select(StockLocation))}
    names = _plant_names(db, (u.plant_id for u, _ in rows))
    return [unit_out(u, p, locs, names) for u, p in rows]


# ------------------------------------------------------------------------------------- movements


def movement_out(m: StockMovement, parts: Dict[int, Part], locs: Dict[int, StockLocation], names: Dict[int, str]) -> Dict[str, Any]:
    part = parts.get(m.part_id) if m.part_id is not None else None
    code = lambda lid: locs[lid].code if lid in locs else None  # noqa: E731
    return {
        "id": m.id,
        "batch_id": m.batch_id,
        "kind": m.kind,
        "part_id": m.part_id,
        "part_code": part.code if part else None,
        "part_name": part.name if part else None,
        "unit_id": m.unit_id,
        "serial": m.serial,
        "qty": m.qty,
        "from_location_id": m.from_location_id,
        "from_location_code": code(m.from_location_id),
        "to_location_id": m.to_location_id,
        "to_location_code": code(m.to_location_id),
        "plant_id": m.plant_id,
        "plant_name": names.get(m.plant_id) if m.plant_id else None,
        "from_state": m.from_state,
        "to_state": m.to_state,
        "corrects_id": m.corrects_id,
        "failed_unit_id": m.failed_unit_id,
        "by": m.by,
        "at": iso_utc(m.at),
        "day": m.day.isoformat(),
        "note": m.note,
        "input_method": m.input_method,
        "raw_scan": m.raw_scan,
    }


def _outs(db: Session, rows: List[StockMovement]) -> List[Dict[str, Any]]:
    parts = {p.id: p for p in db.scalars(select(Part).where(Part.id.in_({m.part_id for m in rows if m.part_id is not None} or {-1})))}
    locs = {loc.id: loc for loc in db.scalars(select(StockLocation))}
    names = _plant_names(db, (m.plant_id for m in rows))
    return [movement_out(m, parts, locs, names) for m in rows]


def list_movements(
    db: Session,
    user: User,
    kind: Optional[str] = None,
    part_id: Optional[int] = None,
    location_id: Optional[int] = None,
    plant_id: Optional[int] = None,
    serial: Optional[str] = None,
    unit_id: Optional[int] = None,
    limit: int = 200,
    offset: int = 0,
) -> Dict[str, Any]:
    allowed = allowed_plant_ids(db, user)
    q = select(StockMovement)
    if allowed is not None:
        q = q.where(or_(StockMovement.plant_id.is_(None), StockMovement.plant_id.in_(allowed or {-1})))
    if kind:
        q = q.where(StockMovement.kind == kind)
    if part_id is not None:
        q = q.where(StockMovement.part_id == part_id)
    if location_id is not None:
        q = q.where(or_(StockMovement.from_location_id == location_id, StockMovement.to_location_id == location_id))
    if plant_id is not None:
        q = q.where(StockMovement.plant_id == plant_id)
    if unit_id is not None:
        q = q.where(StockMovement.unit_id == unit_id)
    if serial:
        q = q.where(func.upper(StockMovement.serial).contains(serial_key(serial)))
    total = int(db.scalar(select(func.count()).select_from(q.subquery())) or 0)
    rows = list(db.scalars(q.order_by(StockMovement.id.desc()).limit(min(max(limit, 1), MAX_LIST)).offset(max(offset, 0))))
    return {"total": total, "movements": _outs(db, rows)}


# what each field move needs and does: (allowed unit state before, state after, needs plant, needs to-location)
_FIELD_MOVES: Dict[str, Tuple[str, str, bool, bool]] = {
    "transfer": ("in_stock", "in_stock", False, True),
    "issue": ("in_stock", "installed", True, False),
    "return": ("installed", "in_stock", True, True),
}


def apply_batch(db: Session, user: User, rows: List[Dict[str, Any]], day: Optional[date] = None, note: Optional[str] = None) -> Dict[str, Any]:
    """Validate every row, then write them all in one transaction (or none: StockConflict)."""
    if not rows:
        raise StockError("No rows")
    if len(rows) > MAX_BATCH:
        raise StockError(f"At most {MAX_BATCH} rows in one batch")
    day = day or _today()
    batch_note = _text(note, "Note", 2000)
    allowed = allowed_plant_ids(db, user)
    keeper = can_manage_stock(user)
    locs = {loc.id: loc for loc in db.scalars(select(StockLocation))}
    parts = {p.id: p for p in db.scalars(select(Part))}
    known_plants = set(db.scalars(select(GrowattPlant.plant_id)))
    errors: List[Dict[str, Any]] = []
    plan: List[Dict[str, Any]] = []
    seen_units: Set[Tuple[int, str]] = set()
    seen_received: Set[str] = set()  # serial keys received in this batch, any part

    def stock_loc(lid: Any, what: str) -> StockLocation:
        loc = locs.get(lid) if isinstance(lid, int) else None
        if loc is None or not loc.active:
            raise StockError(f"{what}: an active location")
        if loc.kind not in STOCK_KINDS:
            raise StockError(f"{what}: a store, bin or van (sending to a supplier comes with failed units)")
        return loc

    for i, r in enumerate(rows):
        try:
            kind = r.get("kind")
            method = r.get("input_method")
            if method is not None and method not in INPUT_METHODS:
                raise StockError(f"input_method: one of {', '.join(INPUT_METHODS)}")
            raw = r.get("raw_scan")
            if raw is not None and len(str(raw)) > 512:
                raise StockError("raw_scan: at most 512 characters")
            pid = r.get("part_id")
            part = parts.get(pid) if isinstance(pid, int) else None
            serial = _text(r.get("serial"), "Serial", 64)
            unit: Optional[SpareUnit] = None
            if isinstance(r.get("unit_id"), int):
                unit = db.get(SpareUnit, r["unit_id"])
                if unit is None or not _visible(allowed, unit.plant_id):
                    raise StockError(f"Unit {r['unit_id']} not found")
                part = parts[unit.part_id]
                serial = unit.serial
            if part is None:
                raise StockError("Part: choose one from the catalogue")
            if not serial:
                raise StockError("Serial is required")
            key = (part.id, serial_key(serial))
            if key in seen_units:
                raise StockError(f"{part.code} {serial} is twice in this batch")
            seen_units.add(key)
            if unit is None:
                unit = db.scalars(select(SpareUnit).where(SpareUnit.part_id == part.id, SpareUnit.serial_key == key[1])).first()
            row_note = _text(r.get("note"), "Note", 2000) or batch_note

            if kind == "receive":
                if not keeper:
                    raise StockForbidden("Receiving into stock needs an admin or store keeper")
                if not part.active:
                    raise StockError(f"{part.code} is not active in the catalogue")
                if unit is not None and unit.state == "missing":
                    raise StockError(f"{part.code} {unit.serial} is missing since the count of {_missing_since(db, unit.id) or '—'}; count it in instead")
                if unit is not None and unit.state != "void":
                    where = locs[unit.location_id].code if unit.location_id in locs else (("another plant" if not _visible(allowed, unit.plant_id) else f"plant {unit.plant_id}") if unit.plant_id else "—")
                    raise StockError(f"{part.code} {unit.serial} is already in the register ({unit.state}, {where})")
                # one serial, one place: not under another part, nor an open failed unit (plan §3)
                if key[1] in seen_received:
                    raise StockError(f"{serial} is twice in this batch")
                seen_received.add(key[1])
                holder = serial_holder(db, key[1], exclude_unit_id=unit.id if unit is not None else None)
                if holder is not None:
                    raise StockError(f"{part.code} {serial} {holder_text(db, holder, allowed)}")
                to = stock_loc(r.get("to_location_id"), "To")
                plan.append({"kind": kind, "part": part, "unit": unit, "serial": serial, "to": to, "plant": None, "from": None,
                             "from_state": unit.state if unit else None, "to_state": "in_stock", "note": row_note, "method": method, "raw": raw})
            elif kind in _FIELD_MOVES:
                need_state, new_state, needs_plant, needs_to = _FIELD_MOVES[kind]
                if unit is None or unit.state == "void":
                    raise StockError(f"{part.code} {serial} is not in the register")
                if not _visible(allowed, unit.plant_id):
                    raise StockError(f"{part.code} {serial} is not in the register")
                if unit.state != need_state:
                    raise StockError(f"{part.code} {unit.serial} is {unit.state.replace('_', ' ')}, not {need_state.replace('_', ' ')}")
                plant_id = r.get("plant_id") if needs_plant else None
                if needs_plant:
                    if kind == "return":
                        plant_id = unit.plant_id if plant_id is None else plant_id
                        if plant_id != unit.plant_id:
                            if not _visible(allowed, unit.plant_id):  # never name a plant the user may not see
                                raise StockError(f"{part.code} {serial} is not in the register")
                            raise StockError(f"{unit.serial} is installed at plant {unit.plant_id}, not {plant_id}")
                    if not isinstance(plant_id, int) or plant_id not in known_plants or not _visible(allowed, plant_id):
                        raise StockError("Plant: one of your plants")
                to = stock_loc(r.get("to_location_id"), "To") if needs_to else None
                frm = locs.get(unit.location_id) if unit.location_id else None
                if kind == "transfer" and to is not None and frm is not None and to.id == frm.id:
                    raise StockError(f"{unit.serial} is already at {to.code}")
                plan.append({"kind": kind, "part": part, "unit": unit, "serial": unit.serial, "to": to, "from": frm, "plant": plant_id,
                             "from_state": unit.state, "to_state": new_state, "note": row_note, "method": method, "raw": raw})
            else:
                raise StockError("Kind: receive, transfer, issue or return")
        except StockForbidden:
            raise
        except StockError as exc:
            errors.append({"row": i, "error": str(exc)})
    if errors:
        raise StockConflict(errors)

    batch_id = str(uuid.uuid4())
    by = _by(user)
    written: List[StockMovement] = []
    try:
        for step in plan:
            unit = step["unit"]
            if unit is None:
                unit = SpareUnit(part_id=step["part"].id, serial=step["serial"], serial_key=serial_key(step["serial"]), state="in_stock", received_day=day)
                db.add(unit)
                db.flush()
            elif step["kind"] == "receive":  # a voided unit received again
                unit.received_day = day
            unit.state = step["to_state"]
            unit.location_id = step["to"].id if step["to"] is not None else None
            unit.plant_id = step["plant"] if step["to_state"] == "installed" else None
            m = StockMovement(
                batch_id=batch_id,
                kind=step["kind"],
                part_id=step["part"].id,
                unit_id=unit.id,
                serial=unit.serial,
                qty=1,
                from_location_id=step["from"].id if step["from"] is not None else None,
                to_location_id=step["to"].id if step["to"] is not None else None,
                plant_id=step["plant"],
                from_state=step["from_state"],
                to_state=step["to_state"],
                by=by,
                day=day,
                note=step["note"],
                input_method=step["method"],
                raw_scan=str(step["raw"])[:512] if step["raw"] is not None else None,
            )
            db.add(m)
            written.append(m)
        db.commit()
    except IntegrityError as exc:  # another batch took the same serial a moment ago
        db.rollback()
        raise StockConflict([{"row": None, "error": "Another change got there first; reload and try again"}]) from exc
    return {"batch_id": batch_id, "movements": _outs(db, written)}


def _missing_since(db: Session, unit_id: int) -> Optional[str]:
    """Day of the count that marked a unit missing (its newest `count_adjust` row to `missing`)."""
    d = db.scalar(
        select(StockMovement.day)
        .where(StockMovement.unit_id == unit_id, StockMovement.kind == "count_adjust", StockMovement.to_state == "missing")
        .order_by(StockMovement.id.desc())
        .limit(1)
    )
    return d.isoformat() if d is not None else None


def correct(db: Session, user: User, movement_id: int, note: Optional[str]) -> Dict[str, Any]:
    """Reverse a unit's latest movement (store keeper). The original stays; a `correction` row undoes it."""
    _need_keeper(user)
    m = db.get(StockMovement, movement_id)
    if m is None or not _visible(allowed_plant_ids(db, user), m.plant_id):
        raise StockNotFound(f"Movement {movement_id} not found")
    if m.kind == "correction":
        raise StockConflict([{"row": None, "error": "A correction cannot be corrected; record the move again"}])
    if m.failed_unit_id is not None:
        raise StockConflict([{"row": None, "error": "A failed unit's movement cannot be corrected; record the next move instead"}])
    if db.scalar(select(StockMovement.id).where(StockMovement.corrects_id == m.id)) is not None:
        raise StockConflict([{"row": None, "error": "This movement is already corrected"}])
    latest = db.scalar(select(func.max(StockMovement.id)).where(StockMovement.unit_id == m.unit_id))
    if latest != m.id:
        raise StockConflict([{"row": None, "error": "Only a unit's latest movement can be corrected; correct the later ones first"}])
    why = _text(note, "Reason", 2000, required=True)
    unit = db.get(SpareUnit, m.unit_id) if m.unit_id else None
    if unit is None:
        raise StockConflict([{"row": None, "error": "The movement has no unit"}])
    back_state = m.from_state or "void"  # a receive of a new unit: the unit never was in stock
    back_loc = m.from_location_id
    back_plant = m.plant_id if back_state == "installed" else None
    c = StockMovement(
        batch_id=str(uuid.uuid4()),
        kind="correction",
        part_id=m.part_id,
        unit_id=unit.id,
        serial=unit.serial,
        qty=m.qty,
        from_location_id=m.to_location_id,
        to_location_id=back_loc,
        plant_id=m.plant_id,
        from_state=unit.state,
        to_state=back_state,
        corrects_id=m.id,
        by=_by(user),
        day=_today(),
        note=why,
    )
    unit.state = back_state
    unit.location_id = back_loc if back_state == "in_stock" else None
    unit.plant_id = back_plant
    db.add(c)
    db.commit()
    return _outs(db, [c])[0]


def summary(db: Session, user: Optional[User] = None) -> Dict[str, Any]:
    """Counts for the page header; failed units only of the plants `user` may see."""
    allowed = allowed_plant_ids(db, user) if user is not None else None
    q = select(SpareUnit.state, func.count()).group_by(SpareUnit.state)
    scope = _unit_scope(allowed)
    if scope is not None:  # installed units only on the user's plants
        q = q.where(scope)
    states = Counter(dict(db.execute(q).all()))
    below = sum(1 for p in list_parts(db) if p["below_min"])
    from app.services.stock_failed import failed_counts  # imports this module

    return {"in_stock": int(states.get("in_stock", 0)), "installed": int(states.get("installed", 0)), "missing_units": int(states.get("missing", 0)), "parts_below_min": below, **failed_counts(db, allowed)}
