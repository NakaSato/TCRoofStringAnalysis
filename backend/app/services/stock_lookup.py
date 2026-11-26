"""What a scan on the Inventory batch page is (docs/plans/spares-failed-units.md §5.1, §6;
barcode-scanning.md §7.3): a stock location, one spare unit, a part, or a serial.

DB only, nothing stored, not rate limited (a desk scanner fires one scan after another; the
`/scan/resolve` limit is for single scans). Order: an app code (`loc:` / `sp:`, also as `/s/…`
path or URL; any other app kind = unknown), else a location code, else a part code (both exact,
case-insensitive), else a serial (label prefix removed, `scan.normalise`): the spare units of any
part with that serial, not void. Scoped like `/stock/units`: a unit installed on a plant the user
may not see is not listed (never a 404).
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.auth import allowed_plant_ids
from app.db.models import Part, SpareUnit, StockLocation, User
from app.services import stock
from app.services.scan import MAX_CODE_LEN, clean, normalise, parse_app_code


def _answer(code: str, kind: str, location: Optional[Dict[str, Any]] = None, part: Optional[Dict[str, Any]] = None, units: Optional[List[Dict[str, Any]]] = None) -> Dict[str, Any]:
    return {"code": code, "kind": kind, "location": location, "part": part, "units": units or []}


def _location(db: Session, code: str) -> Optional[Dict[str, Any]]:
    loc = db.scalars(select(StockLocation).where(func.upper(StockLocation.code) == code.upper())).first()
    return stock.location_out(loc, stock._people(db), stock._counts(db), stock._last_counts(db)) if loc is not None else None


def _part(db: Session, code: str) -> Optional[Dict[str, Any]]:
    p = db.scalars(select(Part).where(func.upper(Part.code) == code.upper())).first()
    return stock.part_out(p, stock._on_hand(db).get(p.id)) if p is not None else None


def _units(db: Session, user: User, where: Any) -> List[Dict[str, Any]]:
    allowed = allowed_plant_ids(db, user)
    stmt = select(SpareUnit, Part).join(Part, Part.id == SpareUnit.part_id).where(where, SpareUnit.state != "void").order_by(Part.code, SpareUnit.id)
    rows = [(u, p) for u, p in db.execute(stmt.limit(stock.MAX_LIST)) if stock._visible(allowed, u.plant_id)]
    if not rows:
        return []
    locs = {loc.id: loc for loc in db.scalars(select(StockLocation))}
    names = stock._plant_names(db, (u.plant_id for u, _ in rows))
    return [stock.unit_out(u, p, locs, names) for u, p in rows]


def lookup(db: Session, user: User, raw: str) -> Dict[str, Any]:
    if len(raw) > MAX_CODE_LEN:
        raise ValueError(f"Code longer than {MAX_CODE_LEN} characters")
    s = clean(raw)
    if not s:
        return _answer("", "unknown")
    app = parse_app_code(s)
    if app is not None:
        kind, code = app
        if kind == "loc":
            loc = _location(db, code)
            return _answer(code.upper(), "location", location=loc) if loc else _answer(code.upper(), "unknown")
        if kind == "sp":
            if code.isdigit():
                units = _units(db, user, SpareUnit.id == int(code))
                return _answer(code, "unit", units=units) if units else _answer(code, "unknown")
            part = _part(db, code)
            return _answer(code.upper(), "part", part=part) if part else _answer(code.upper(), "unknown")
        return _answer(code.upper(), "unknown")
    loc = _location(db, s)
    if loc is not None:
        return _answer(s.upper(), "location", location=loc)
    value, _part_number = normalise(s)
    for candidate in dict.fromkeys((s.upper(), value)):  # `P/N:ABC` names part ABC
        part = _part(db, candidate)
        if part is not None:
            return _answer(candidate, "part", part=part)
    return _answer(value, "serial", units=_units(db, user, SpareUnit.serial_key == value))
