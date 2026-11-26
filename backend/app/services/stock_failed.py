"""Spares register, phase 2: failed units (docs/plans/spares-failed-units.md §5.3–5.5).

A failed unit is a device taken off site, bound to one pre-printed red tag (`red_tags`, reserved →
bound, never reused). It records what failed, where it came from (plant, site register device or
inverter serial), where it is now and the claim it belongs to. Its status changes only through
movements written here, each a `StockMovement` row with `failed_unit_id` set:

- `failed_in` (anyone, `create`): off site → a van (`tagged`) or a store / bin (`in_store`). When
  the serial is one of our spare units installed on site, that unit goes `failed` and is linked.
- `transfer` (anyone): between vans, stores and bins while `tagged` / `in_store`.
- `ship_out` (store keeper): → a supplier location, `sent`; a linked claim gets a shipment event
  (out) in the same transaction, so the two never disagree.
- `supplier_return` (store keeper): back from the supplier, `repaired` (the same serial becomes a
  spare in stock again) or `replaced` (a new spare unit with the supplier's serial; a linked old
  spare is scrapped). A linked claim gets a shipment event (in).
- `scrap` (store keeper): `scrapped`, with a linked spare.

Ledger rows that name a spare unit (`unit_id`) carry unit states in `from_state` / `to_state`;
rows of the failed unit alone carry its statuses. Nothing is edited or deleted, and phase 1's
`correct` refuses these rows.

Plant scoping: a failed unit of a plant the user may not see is left out of lists and answers 404;
one without a plant is visible to everyone signed in. No money anywhere.
"""

from __future__ import annotations

import uuid
from datetime import date, datetime
from typing import Any, Dict, Iterable, List, Optional, Set, Tuple
from zoneinfo import ZoneInfo

from sqlalchemy import func, or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.auth import allowed_plant_ids, can_manage_stock
from app.config import settings
from app.db.models import Claim, FailedUnit, GrowattPlant, Part, RedTag, SiteDevice, SiteRegister, SpareUnit, StockLocation, StockMovement, User
from app.db.models.stock import FAILED_OPEN, INPUT_METHODS
from app.services import claims as claims_svc
from app.services import stock as stock_svc
from app.services.growatt_common import GrowattNotFound
from app.services.scan import _SITE_DEVICE_LABEL, parse_app_code
from app.services.scan_labels import parse_red_tag, red_tag_code
from app.services.stock import (
    MAX_LIST,
    STOCK_KINDS,
    StockConflict,
    StockError,
    StockForbidden,
    StockNotFound,
    _by,
    _outs,
    _plant_names,
    _text,
    _visible,
    serial_key,
)

PLANT_TZ = ZoneInfo("Asia/Bangkok")
MOVE_KINDS = ("transfer", "ship_out", "supplier_return", "scrap")
OUTCOMES = ("repaired", "replaced")


def _today() -> date:
    return datetime.now(PLANT_TZ).date()


def _conflict(msg: str) -> StockConflict:
    return StockConflict([{"row": None, "error": msg}])


def _need_keeper(user: User, what: str) -> None:
    if not can_manage_stock(user):
        raise StockForbidden(f"{what} needs an admin or store keeper")


# ------------------------------------------------------------------------------------- lookups


def _red_tag(db: Session, raw: Any) -> RedTag:
    s = _text(raw, "Red tag", 512, required=True) or ""
    app = parse_app_code(s)
    if app is not None and app[0] != "rt":
        raise StockError(f"{s} is not a red tag")
    code = app[1] if app is not None else s
    n = parse_red_tag(code)
    if n is None:
        raise StockError(f"No red tag {code}")
    tag = db.scalars(select(RedTag).where(RedTag.number == n)).first()
    if tag is None:
        raise StockError(f"No red tag {red_tag_code(n)}")
    return tag


def _location(db: Session, lid: Any, kinds: Tuple[str, ...], what: str) -> StockLocation:
    loc = db.get(StockLocation, lid) if isinstance(lid, int) and not isinstance(lid, bool) else None
    if loc is None or not loc.active:
        raise StockError(f"{what}: an active location")
    if loc.kind not in kinds:
        raise StockError(f"{what}: a {' / '.join(kinds)} location")
    return loc


def _part(db: Session, pid: Any) -> Optional[Part]:
    if pid is None:
        return None
    p = db.get(Part, pid) if isinstance(pid, int) and not isinstance(pid, bool) else None
    if p is None:
        raise StockError("Part: choose one from the catalogue")
    return p


def _admin(user: User) -> bool:
    return user.role == "admin"


def _claim(db: Session, cid: Any, allowed: Optional[Set[int]], plant_id: Optional[int], user: User, current: Optional[int] = None) -> Optional[Claim]:
    """A claim to link: visible, of the failed unit's plant and, for anyone but an admin, still open
    (a closed / withdrawn claim is read only for engineers). `current` = the claim already linked,
    which stays linked as it is."""
    if cid is None:
        return None
    if not isinstance(cid, int) or isinstance(cid, bool):
        raise StockError("Claim: one of your claims")
    try:
        c = claims_svc.get_claim(db, cid, allowed)
    except GrowattNotFound as exc:
        raise StockError("Claim: one of your claims") from exc
    if c.plant_id != plant_id:
        raise StockError(f"Claim {c.number} is of another plant than the failed unit")
    if c.status in claims_svc.CLOSED and not _admin(user) and c.id != current:
        raise _conflict(f"Claim {c.number} is {c.status}: only an admin can link it")
    return c


def _visible_unit(fu: FailedUnit, allowed: Optional[Set[int]]) -> bool:
    return _visible(allowed, fu.plant_id)


def _get(db: Session, user: User, fid: int) -> Tuple[FailedUnit, Optional[Set[int]]]:
    allowed = allowed_plant_ids(db, user)
    fu = db.get(FailedUnit, fid)
    if fu is None or not _visible_unit(fu, allowed):
        raise StockNotFound(f"Failed unit {fid} not found")
    return fu, allowed


def _open_with_serial(db: Session, key: str, part_id: Optional[int], exclude: Optional[int] = None) -> Optional[FailedUnit]:
    q = select(FailedUnit).where(FailedUnit.serial_key == key, FailedUnit.status.in_(FAILED_OPEN))
    if part_id is not None:
        q = q.where(or_(FailedUnit.part_id.is_(None), FailedUnit.part_id == part_id))
    if exclude is not None:
        q = q.where(FailedUnit.id != exclude)
    return db.scalars(q).first()


# ---------------------------------------------------------------------------------------- out


def _site_device_labels(db: Session, ids: Iterable[Optional[int]]) -> Dict[int, str]:
    want = {i for i in ids if i is not None}
    if not want:
        return {}
    out: Dict[int, str] = {}
    for d in db.scalars(select(SiteDevice).where(SiteDevice.id.in_(want))):
        label = _SITE_DEVICE_LABEL.get(d.kind, d.kind)
        if d.seq and d.seq > 1:
            label = f"{label} {d.seq}"
        out[d.id] = f"{label} · {d.site_code}"
    return out


def _outs_failed(db: Session, rows: List[FailedUnit]) -> List[Dict[str, Any]]:
    if not rows:
        return []
    tags = dict(db.execute(select(RedTag.id, RedTag.code).where(RedTag.id.in_({r.red_tag_id for r in rows}))).all())
    parts = {p.id: p for p in db.scalars(select(Part).where(Part.id.in_({r.part_id for r in rows if r.part_id is not None} or {-1})))}
    locs = dict(db.execute(select(StockLocation.id, StockLocation.code)).all())
    claims = dict(db.execute(select(Claim.id, Claim.number).where(Claim.id.in_({r.claim_id for r in rows if r.claim_id is not None} or {-1}))).all())
    names = _plant_names(db, (r.plant_id for r in rows))
    devices = _site_device_labels(db, (r.site_device_id for r in rows))
    today = _today()
    limit = settings.stock_failed_unsent_days
    out = []
    for r in rows:
        part = parts.get(r.part_id) if r.part_id is not None else None
        age = (today - r.removed_day).days
        out.append(
            {
                "id": r.id,
                "red_tag": tags.get(r.red_tag_id),
                "part_id": r.part_id,
                "part_code": part.code if part else None,
                "part_name": part.name if part else None,
                "serial": r.serial,
                "plant_id": r.plant_id,
                "plant_name": names.get(r.plant_id) if r.plant_id is not None else None,
                "site_device_id": r.site_device_id,
                "site_device_label": devices.get(r.site_device_id) if r.site_device_id is not None else None,
                "inverter_sn": r.inverter_sn,
                "removed_day": r.removed_day.isoformat(),
                "fault": r.fault,
                "status": r.status,
                "location_id": r.location_id,
                "location_code": locs.get(r.location_id) if r.location_id is not None else None,
                "claim_id": r.claim_id,
                "claim_number": claims.get(r.claim_id) if r.claim_id is not None else None,
                "age_days": age,
                "unsent_overdue": r.status in ("tagged", "in_store") and age > limit,
                "created_by": r.created_by,
            }
        )
    return out


def failed_out(db: Session, fu: FailedUnit) -> Dict[str, Any]:
    return _outs_failed(db, [fu])[0]


def _with_trail(db: Session, fu: FailedUnit) -> Dict[str, Any]:
    rows = list(db.scalars(select(StockMovement).where(StockMovement.failed_unit_id == fu.id).order_by(StockMovement.id.desc())))
    return {**failed_out(db, fu), "trail": _outs(db, rows)}


# ------------------------------------------------------------------------------------- reading


def list_failed(
    db: Session,
    user: User,
    status: Optional[str] = None,
    plant_id: Optional[int] = None,
    q: Optional[str] = None,
    open_only: bool = False,
) -> List[Dict[str, Any]]:
    allowed = allowed_plant_ids(db, user)
    stmt = select(FailedUnit).join(RedTag, RedTag.id == FailedUnit.red_tag_id)
    if allowed is not None:
        stmt = stmt.where(or_(FailedUnit.plant_id.is_(None), FailedUnit.plant_id.in_(allowed or {-1})))
    if status:
        stmt = stmt.where(FailedUnit.status == status)
    if open_only:
        stmt = stmt.where(FailedUnit.status.in_(FAILED_OPEN))
    if plant_id is not None:
        stmt = stmt.where(FailedUnit.plant_id == plant_id)
    if q and q.strip():
        key = serial_key(q)
        stmt = stmt.where(or_(FailedUnit.serial_key.contains(key), func.upper(RedTag.code).contains(key)))
    rows = list(db.scalars(stmt.order_by(FailedUnit.id.desc()).limit(MAX_LIST)))
    return _outs_failed(db, rows)


def get_failed(db: Session, user: User, fid: int) -> Dict[str, Any]:
    fu, _ = _get(db, user, fid)
    return _with_trail(db, fu)


def open_failed_at(db: Session, location_id: int) -> int:
    """Open failed units (tagged, in store, sent) at a location: it cannot be switched off or change kind."""
    return int(db.scalar(select(func.count()).select_from(FailedUnit).where(FailedUnit.location_id == location_id, FailedUnit.status.in_(FAILED_OPEN))) or 0)


def failed_counts(db: Session, allowed: Optional[Set[int]] = None) -> Dict[str, int]:
    """`failed_open` (tagged / in store / sent) and `failed_unsent_overdue` (tagged / in store,
    removed more than STOCK_FAILED_UNSENT_DAYS ago), over the plants `allowed` (None = all)."""
    q = select(FailedUnit.status, FailedUnit.removed_day).where(FailedUnit.status.in_(FAILED_OPEN))
    if allowed is not None:
        q = q.where(or_(FailedUnit.plant_id.is_(None), FailedUnit.plant_id.in_(allowed or {-1})))
    today, limit = _today(), settings.stock_failed_unsent_days
    rows = db.execute(q).all()
    return {
        "failed_open": len(rows),
        "failed_unsent_overdue": sum(1 for st, day in rows if st in ("tagged", "in_store") and (today - day).days > limit),
    }


# ------------------------------------------------------------------------------------- writing


def _movement(fu: FailedUnit, batch_id: str, kind: str, by: str, day: date, **kw: Any) -> StockMovement:
    return StockMovement(batch_id=batch_id, kind=kind, failed_unit_id=fu.id, qty=1, by=by, day=day, plant_id=fu.plant_id, **kw)


def _method(body: Dict[str, Any]) -> Tuple[Optional[str], Optional[str]]:
    method = body.get("input_method")
    if method is not None and method not in INPUT_METHODS:
        raise StockError(f"input_method: one of {', '.join(INPUT_METHODS)}")
    raw = body.get("raw_scan")
    if raw is not None and len(str(raw)) > 512:
        raise StockError("raw_scan: at most 512 characters")
    return method, (str(raw) if raw is not None else None)


def _commit(db: Session) -> None:
    try:
        db.commit()
    except IntegrityError as exc:  # another change took the same tag / serial a moment ago
        db.rollback()
        raise _conflict("Another change got there first; reload and try again") from exc


def create(db: Session, user: User, body: Dict[str, Any]) -> Dict[str, Any]:
    """Bind a red tag to a failed unit off site (`failed_in`). Anyone signed in (a field move)."""
    fu = _create(db, user, body)
    _commit(db)
    return failed_out(db, fu)


def _create(db: Session, user: User, body: Dict[str, Any], batch_id: Optional[str] = None) -> FailedUnit:
    """`create` without the commit (flushed only), so a replacement (`stock_replace`) runs it inside
    its own transaction. Every check comes before the first write."""
    allowed = allowed_plant_ids(db, user)
    tag = _red_tag(db, body.get("red_tag"))
    if tag.status == "bound":
        raise _conflict(f"{tag.code} is already on a failed unit")
    if tag.status != "reserved":
        raise _conflict(f"{tag.code} is void")
    fault = _text(body.get("fault"), "Fault", 2000, required=True) or ""
    serial = _text(body.get("serial"), "Serial", 64)
    inverter_sn = _text(body.get("inverter_sn"), "Inverter SN", 64)
    note = _text(body.get("note"), "Note", 2000)
    method, raw = _method(body)
    part = _part(db, body.get("part_id"))
    plant_id = body.get("plant_id")

    site_device_id = body.get("site_device_id")
    if site_device_id is not None:
        dev = db.get(SiteDevice, site_device_id) if isinstance(site_device_id, int) else None
        reg = db.get(SiteRegister, dev.site_code) if dev is not None else None
        if dev is None or reg is None or not _visible(allowed, reg.plant_id) or (allowed is not None and reg.plant_id is None):
            raise StockError("Device: a site register device of one of your plants")
        if plant_id is None:
            plant_id = reg.plant_id
        elif reg.plant_id != plant_id:
            raise StockError(f"Device {_SITE_DEVICE_LABEL.get(dev.kind, dev.kind)} · {dev.site_code} is not on plant {plant_id}")
    if plant_id is not None:
        known = isinstance(plant_id, int) and db.get(GrowattPlant, plant_id) is not None
        if not known or not _visible(allowed, plant_id):
            raise StockError("Plant: one of your plants")

    removed = body.get("removed_day")
    if removed is None:
        removed_day = _today()
    else:
        try:
            removed_day = removed if isinstance(removed, date) else date.fromisoformat(str(removed))
        except ValueError as exc:
            raise StockError("Removed day: a date (YYYY-MM-DD)") from exc
        if removed_day > _today():
            raise StockError("Removed day cannot be in the future")
    to = _location(db, body.get("to_location_id"), STOCK_KINDS, "To")

    key = serial_key(serial) if serial else None
    spare: Optional[SpareUnit] = None
    if key:
        # a serial is in one place (plan §3): an open failed unit or a spare unit of any part holds it
        holders = stock_svc.serial_holders(db, key)
        failed = [h for h in holders if isinstance(h, FailedUnit)]
        spares = [h for h in holders if isinstance(h, SpareUnit)]
        if failed:
            other = failed[0]
            if not _visible(allowed, other.plant_id):
                raise _conflict(f"{serial} is already an open failed unit on another plant")
            held = db.get(RedTag, other.red_tag_id)
            raise _conflict(f"{serial} is already an open failed unit ({held.code if held else other.id})")
        if len(spares) > 1:
            raise _conflict(f"{serial} is held by {len(spares)} spare units in the register: tag it without the serial, or sort the register out first")
        if spares:
            u = spares[0]
            if not _visible(allowed, u.plant_id):
                raise _conflict(f"{serial} is installed on another plant" if u.state == "installed" else f"{serial} is a spare unit on another plant")
            if u.state != "installed":
                raise _conflict(f"{serial} is a spare unit {u.state.replace('_', ' ')} in the register, not on a plant: install it first, or tag it without the serial")
            if plant_id is not None and u.plant_id != plant_id:
                raise StockError(f"{serial} is installed at plant {u.plant_id}, not {plant_id}")
            if part is not None and part.id != u.part_id:
                theirs = db.get(Part, u.part_id)
                raise StockError(f"{serial} is installed as {theirs.code if theirs else u.part_id}, not {part.code}: choose that part, or leave the part empty")
            spare = u
            if part is None:
                part = db.get(Part, spare.part_id)
            if plant_id is None:
                plant_id = spare.plant_id
    # after the plant is known from the spare, so a claim of that plant fits
    claim = _claim(db, body.get("claim_id"), allowed, plant_id, user)

    by = _by(user)
    fu = FailedUnit(
        red_tag_id=tag.id,
        part_id=part.id if part else None,
        serial=serial,
        serial_key=key,
        plant_id=plant_id,
        site_device_id=site_device_id,
        inverter_sn=inverter_sn,
        removed_day=removed_day,
        fault=fault,
        status="tagged" if to.kind == "van" else "in_store",
        location_id=to.id,
        claim_id=claim.id if claim else None,
        spare_unit_id=spare.id if spare else None,
        created_by=by,
    )
    tag.status = "bound"
    db.add(fu)
    db.flush()
    from_state = None
    if spare is not None:
        from_state = spare.state
        spare.state = "failed"
        spare.location_id = None
    db.add(
        _movement(
            fu,
            batch_id or str(uuid.uuid4()),
            "failed_in",
            by,
            _today(),
            part_id=fu.part_id,
            unit_id=spare.id if spare else None,
            serial=serial,
            to_location_id=to.id,
            from_state=from_state,
            to_state="failed",
            claim_id=fu.claim_id,
            note=note,
            input_method=method,
            raw_scan=raw[:512] if raw else None,
        )
    )
    db.flush()
    return fu


def update_failed(db: Session, user: User, fid: int, body: Dict[str, Any]) -> Dict[str, Any]:
    """Fault text, claim link (null unlinks) and part (null allowed). Anyone who can see it."""
    fu, allowed = _get(db, user, fid)
    if "fault" in body:
        fu.fault = _text(body.get("fault"), "Fault", 2000, required=True) or fu.fault
    if "part_id" in body:
        part = _part(db, body.get("part_id"))
        if (part.id if part else None) != fu.part_id:
            if fu.status not in FAILED_OPEN:
                raise _conflict(f"The failed unit is {fu.status.replace('_', ' ')}: its part cannot change")
            if fu.spare_unit_id is not None:
                raise _conflict("The failed unit is a spare unit of the register: its part is that unit's")
        if part is not None and fu.serial_key and fu.status in FAILED_OPEN:
            other = _open_with_serial(db, fu.serial_key, part.id, exclude=fu.id)
            if other is not None:
                held = db.get(RedTag, other.red_tag_id)
                raise _conflict(f"{fu.serial} is already an open failed unit ({held.code if held else other.id})")
        fu.part_id = part.id if part else None
    if "claim_id" in body:
        claim = _claim(db, body.get("claim_id"), allowed, fu.plant_id, user, current=fu.claim_id)
        fu.claim_id = claim.id if claim else None
    _commit(db)
    return failed_out(db, fu)


def _spare_for(
    db: Session, part_id: int, serial: str, keep: Optional[SpareUnit], *, failed_id: Optional[int] = None, allowed: Optional[Set[int]] = None
) -> SpareUnit:
    """A spare unit of `part_id` + `serial` to put in stock: a voided one is reused. The serial held by
    anything else (a spare unit of any part other than `keep`, an open failed unit other than
    `failed_id`, the one coming back) is a conflict: one serial, one place (plan §3)."""
    key = serial_key(serial)
    u = db.scalars(select(SpareUnit).where(SpareUnit.part_id == part_id, SpareUnit.serial_key == key)).first()
    if u is not None and u is not keep and u.state != "void":
        raise _conflict(f"{serial} is already a spare unit of this part ({u.state.replace('_', ' ')})")
    holder = stock_svc.serial_holder(db, key, exclude_unit_id=keep.id if keep is not None else None, exclude_failed_id=failed_id)
    if holder is not None:
        raise _conflict(f"{serial} {stock_svc.holder_text(db, holder, allowed)}")
    if u is None:
        u = SpareUnit(part_id=part_id, serial=serial, serial_key=key, state="void")
        db.add(u)
        db.flush()
    return u


def move_failed(db: Session, user: User, fid: int, body: Dict[str, Any]) -> Dict[str, Any]:
    fu, allowed = _get(db, user, fid)
    kind = body.get("kind")
    if kind not in MOVE_KINDS:
        raise StockError(f"Kind: one of {', '.join(MOVE_KINDS)}")
    note = _text(body.get("note"), "Note", 2000)
    carrier = _text(body.get("carrier"), "Carrier", 64)
    tracking = _text(body.get("tracking_no"), "Tracking number", 64)
    method, raw = _method(body)  # how a replacement's new_serial was entered; a raw scan needs its method
    if method is None:
        raw = None
    by, day, batch = _by(user), _today(), str(uuid.uuid4())
    tag = db.get(RedTag, fu.red_tag_id)
    tag_code = tag.code if tag else str(fu.id)
    claim = db.get(Claim, fu.claim_id) if fu.claim_id is not None else None
    spare = db.get(SpareUnit, fu.spare_unit_id) if fu.spare_unit_id is not None else None
    frm = fu.location_id
    before = fu.status
    rows: List[StockMovement] = []
    if kind in ("ship_out", "supplier_return") and claim is not None and claim.status in claims_svc.CLOSED and not _admin(user):
        # the move writes a shipment event on the claim, and a closed claim is read only for engineers
        raise _conflict(f"{tag_code} is linked to claim {claim.number}, which is {claim.status}: an admin records this move, or unlink the claim first")

    def row(**kw: Any) -> None:
        kw.setdefault("part_id", fu.part_id)
        kw.setdefault("serial", fu.serial)
        kw.setdefault("claim_id", fu.claim_id)
        rows.append(_movement(fu, batch, kind, by, day, note=note, **kw))

    if kind == "transfer":
        if fu.status not in ("tagged", "in_store"):
            raise _conflict(f"{tag_code} is {fu.status.replace('_', ' ')}: only a tagged or in-store unit moves between vans and stores")
        to = _location(db, body.get("to_location_id"), STOCK_KINDS, "To")
        if to.id == fu.location_id:
            raise StockError(f"{tag_code} is already at {to.code}")
        fu.status = "tagged" if to.kind == "van" else "in_store"
        fu.location_id = to.id
        row(from_location_id=frm, to_location_id=to.id, from_state=before, to_state=fu.status)
    elif kind == "ship_out":
        _need_keeper(user, "Sending to a supplier")
        if fu.status not in ("tagged", "in_store"):
            raise _conflict(f"{tag_code} is {fu.status.replace('_', ' ')}: only a tagged or in-store unit can be sent")
        to = _location(db, body.get("to_location_id"), ("supplier",), "To")
        fu.status, fu.location_id = "sent", to.id
        row(from_location_id=frm, to_location_id=to.id, from_state=before, to_state="sent")
        if spare is not None and spare.state == "failed":
            spare.state = "at_supplier"
            row(part_id=spare.part_id, unit_id=spare.id, serial=spare.serial, from_location_id=frm, to_location_id=to.id, from_state="failed", to_state="at_supplier")
        if claim is not None:
            claims_svc._event(db, claim, "shipment", by, f"Failed unit {tag_code} sent", day=day, direction="out", carrier=carrier, tracking_no=tracking, sn=fu.serial)
    elif kind == "supplier_return":
        _need_keeper(user, "Receiving from a supplier")
        if fu.status != "sent":
            raise _conflict(f"{tag_code} is {fu.status.replace('_', ' ')}, not sent to a supplier")
        outcome = body.get("outcome")
        if outcome not in OUTCOMES:
            raise StockError("Outcome: repaired or replaced")
        if fu.part_id is None:
            raise StockError("Set the part first")
        to = _location(db, body.get("to_location_id"), STOCK_KINDS, "To")
        if outcome == "repaired":
            if not fu.serial:
                raise StockError(f"{tag_code} has no serial: a repaired unit comes back under its serial")
            unit = spare if spare is not None and spare.part_id == fu.part_id else _spare_for(db, fu.part_id, fu.serial, None, failed_id=fu.id, allowed=allowed)
            unit_from = unit.state if unit.state != "void" else None
            new_serial = unit.serial
            fu.location_id = to.id
        else:
            new_serial = _text(body.get("new_serial"), "New serial", 64, required=True) or ""
            unit = _spare_for(db, fu.part_id, new_serial, None, failed_id=fu.id, allowed=allowed)
            unit_from = None
            fu.location_id = None  # the supplier kept it: the failed unit is nowhere now
            if spare is not None and spare.state not in ("scrapped", "void"):
                old_state = spare.state
                spare.state, spare.location_id, spare.plant_id = "scrapped", None, None
                rows.append(_movement(fu, batch, "scrap", by, day, note=note, part_id=spare.part_id, unit_id=spare.id, serial=spare.serial,
                                      claim_id=fu.claim_id, from_state=old_state, to_state="scrapped"))
        fu.status = outcome
        unit.state, unit.location_id, unit.plant_id = "in_stock", to.id, None
        unit.received_day = unit.received_day or day
        fu.spare_unit_id = unit.id
        row(from_location_id=frm, to_location_id=to.id, from_state=before, to_state=outcome)
        scan: Dict[str, Any] = {"input_method": method, "raw_scan": raw[:512] if raw else None} if outcome == "replaced" else {}
        row(unit_id=unit.id, serial=unit.serial, from_location_id=frm, to_location_id=to.id, from_state=unit_from, to_state="in_stock", **scan)
        if claim is not None:
            what = "repaired" if outcome == "repaired" else f"replaced by {new_serial}"
            claims_svc._event(db, claim, "shipment", by, f"Failed unit {tag_code} back from the supplier, {what}", day=day, direction="in",
                              carrier=carrier, tracking_no=tracking, sn=new_serial)
    else:  # scrap
        _need_keeper(user, "Scrapping")
        if fu.status not in FAILED_OPEN:
            raise _conflict(f"{tag_code} is {fu.status.replace('_', ' ')}: it cannot be scrapped")
        fu.status, fu.location_id = "scrapped", None
        row(from_location_id=frm, from_state=before, to_state="scrapped")
        if spare is not None and spare.state in ("failed", "at_supplier"):
            old_state = spare.state
            spare.state, spare.location_id, spare.plant_id = "scrapped", None, None
            row(part_id=spare.part_id, unit_id=spare.id, serial=spare.serial, from_state=old_state, to_state="scrapped")
    db.add_all(rows)
    _commit(db)
    return _with_trail(db, fu)

