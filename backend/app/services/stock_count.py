"""Stock count (stock take) of one location: spares phase 5 (docs/plans/spares-failed-units.md
§5.7, §8 step 5; D-1 a store keeper confirms, D-5 the first full count is how starting stock gets in).

`preview` (anyone signed in) compares the scans with the units `in_stock` at the location and says,
per scan, what a confirm would do; nothing is written. `confirm` (admin or store keeper) runs the
preview again and, when no row needs a decision and the location's stock is still what the
preview showed (`expected_ids`), writes in one transaction one batch of `count_adjust` movements
and a `StockCount` row:

- matched: in stock here, no movement;
- moved_here: in stock elsewhere → moved here (in_stock → in_stock, from its old location);
- found_again: `missing` → in stock here;
- new: a serial not in the register, with a part → a new unit in stock here (a voided unit of the
  same part + serial is reused, its row then says from `void`);
- missing: in stock here but not scanned → state `missing`, no location.

Rows that block a confirm: `needs_part` (a new serial without a part), `ambiguous` (several units
share the serial and no part picks one), `blocked` (installed / failed / at the supplier /
scrapped, or not countable; a new serial held under another part or by an open failed unit). `duplicate` and `not_a_unit` rows are ignored. Each scan resolves
the way the batch page does (`stock_lookup.lookup`): units installed on a plant the user may not
see are treated as not found. Nothing is estimated: the count only records what was scanned.
"""

from __future__ import annotations

import uuid
from typing import Any, Dict, List, Optional, Set, Tuple

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.auth import allowed_plant_ids, can_manage_stock
from app.db.models import Part, SpareUnit, StockCount, StockLocation, StockMovement, User
from app.db.models.stock import INPUT_METHODS
from app.services import stock, stock_lookup
from app.services.stock import STOCK_KINDS, StockConflict, StockError, StockForbidden, StockNotFound, iso_utc, serial_key
from app.services.stock_failed import _today

MAX_SCANS = 1000
MAX_COUNTS_LIST = 200
RESULTS = ("matched", "moved_here", "found_again", "new", "needs_part", "ambiguous", "blocked", "duplicate", "not_a_unit")
BLOCKING = ("needs_part", "ambiguous", "blocked")

_BLOCKED_WHY = {
    "installed": "is installed{where}: return it first",
    "failed": "is a failed unit: move it as a failed unit",
    "at_supplier": "is at the supplier",
    "scrapped": "is scrapped",
}


def _location(db: Session, location_id: Any) -> StockLocation:
    loc = db.get(StockLocation, location_id) if isinstance(location_id, int) else None
    if loc is None:
        raise StockNotFound(f"Location {location_id} not found")
    if not loc.active or loc.kind not in STOCK_KINDS:
        raise StockError(f"{loc.code}: count an active store, bin or van")
    return loc


def _scans(scans: Any) -> List[Dict[str, Any]]:
    if not isinstance(scans, list):
        raise StockError("scans: a list")
    if len(scans) > MAX_SCANS:
        raise StockError(f"At most {MAX_SCANS} scans in one count")
    out: List[Dict[str, Any]] = []
    for i, s in enumerate(scans):
        if not isinstance(s, dict):
            raise StockError(f"scan {i}: an object")
        raw = s.get("raw")
        if not isinstance(raw, str) or len(raw) > 512:
            raise StockError(f"scan {i}: raw is text of at most 512 characters")
        method = s.get("input_method")
        if method is not None and method not in INPUT_METHODS:
            raise StockError(f"scan {i}: input_method one of {', '.join(INPUT_METHODS)}")
        for k in ("unit_id", "part_id"):
            v = s.get(k)
            if v is not None and (not isinstance(v, int) or isinstance(v, bool)):
                raise StockError(f"scan {i}: {k} a whole number")
        out.append({"raw": raw, "unit_id": s.get("unit_id"), "part_id": s.get("part_id"), "input_method": method})
    return out


def _plan(db: Session, user: User, loc: StockLocation, scans: List[Dict[str, Any]]) -> Dict[str, Any]:
    """Every scan's result plus the units this location holds now (ORM objects kept for confirm)."""
    parts = {p.id: p for p in db.scalars(select(Part))}
    locs = {x.id: x for x in db.scalars(select(StockLocation))}
    expected = list(db.scalars(select(SpareUnit).where(SpareUnit.location_id == loc.id, SpareUnit.state == "in_stock").order_by(SpareUnit.id)))
    allowed = allowed_plant_ids(db, user)
    seen: Set[Tuple[Any, ...]] = set()
    new_parts: Dict[str, int] = {}  # serial key counted in as new in this count -> its part (one serial, one place)
    found_ids: Set[int] = set()
    rows: List[Dict[str, Any]] = []

    for i, s in enumerate(scans):
        row: Dict[str, Any] = {"index": i, "raw": s["raw"], "input_method": s["input_method"], "serial": None, "result": "not_a_unit",
                               "unit": None, "part_id": s["part_id"], "message": None, "_unit": None, "_part": None}
        rows.append(row)
        unit: Optional[SpareUnit] = None
        if s["unit_id"] is not None:
            unit = db.get(SpareUnit, s["unit_id"])
            if unit is None or unit.state == "void" or not stock._visible(allowed, unit.plant_id):
                row["message"] = f"Unit {s['unit_id']} is not in the register"
                continue
        else:
            try:
                ans = stock_lookup.lookup(db, user, s["raw"])
            except ValueError as exc:
                row["message"] = str(exc)
                continue
            kind, units = ans["kind"], ans["units"]
            if kind == "unit":
                unit = db.get(SpareUnit, units[0]["id"])
            elif kind == "serial":
                value = ans["code"]
                row["serial"] = value or None
                if not value:
                    row["message"] = "Empty scan"
                    continue
                if len(units) == 1:
                    unit = db.get(SpareUnit, units[0]["id"])
                elif len(units) > 1:
                    pick = [u for u in units if u["part_id"] == s["part_id"]] if s["part_id"] is not None else []
                    if len(pick) == 1:
                        unit = db.get(SpareUnit, pick[0]["id"])
                    else:
                        key = ("serial", serial_key(value))
                        if key in seen:
                            row.update(result="duplicate", message="Scanned twice in this count")
                            continue
                        seen.add(key)
                        row.update(result="ambiguous", message=f"{len(units)} units share serial {value}: choose the part ({', '.join(u['part_code'] for u in units)})")
                        continue
                else:  # not in the register (or only on a plant the user may not see)
                    _new_serial(db, row, value, s["part_id"], parts, seen, allowed, new_parts)
                    continue
            else:
                row["message"] = {"location": "A location label, not a unit", "part": "A part label, not a unit"}.get(kind, "Not a unit of the register")
                continue
        if unit is None:
            row["message"] = "Not a unit of the register"
            continue
        part = parts[unit.part_id]
        row.update(serial=unit.serial, part_id=unit.part_id, _unit=unit, _part=part)
        if ("unit", unit.id) in seen:
            row.update(result="duplicate", message="Scanned twice in this count")
            continue
        seen.add(("unit", unit.id))
        if unit.state == "in_stock" and unit.location_id == loc.id:
            row["result"] = "matched"
            found_ids.add(unit.id)
        elif unit.state == "in_stock":
            other = locs.get(unit.location_id) if unit.location_id else None
            row.update(result="moved_here", message=f"Register has it at {other.code if other else '—'}: it will be moved to {loc.code}")
        elif unit.state == "missing":
            row.update(result="found_again", message=f"Missing since the count of {stock._missing_since(db, unit.id) or '—'}: back in stock at {loc.code}")
        else:
            why = _BLOCKED_WHY.get(unit.state, "cannot be counted in ({state})")
            where = ""
            if unit.state == "installed" and unit.plant_id is not None:
                where = f" at {stock._plant_names(db, [unit.plant_id]).get(unit.plant_id) or f'plant {unit.plant_id}'}"
            row.update(result="blocked", message=f"{part.code} {unit.serial} " + why.format(where=where, state=unit.state))

    missing = [u for u in expected if u.id not in found_ids]
    return {"rows": rows, "expected": expected, "missing": missing, "parts": parts, "locs": locs}


def _new_serial(
    db: Session,
    row: Dict[str, Any],
    value: str,
    part_id: Optional[int],
    parts: Dict[int, Part],
    seen: Set[Tuple[Any, ...]],
    allowed: Optional[Set[int]],
    new_parts: Dict[str, int],
) -> None:
    key = serial_key(value)
    if len(value) > 64:
        row["message"] = "Longer than a serial (64 characters)"
        return
    if part_id is None:
        if ("serial", key) in seen:
            row.update(result="duplicate", message="Scanned twice in this count")
            return
        seen.add(("serial", key))
        row.update(result="needs_part", message=f"{value} is not in the register: choose its part to count it in")
        return
    part = parts.get(part_id)
    if ("new", part_id, key) in seen:
        row.update(result="duplicate", message="Scanned twice in this count")
        return
    seen.add(("new", part_id, key))
    if part is None:
        row.update(result="needs_part", message=f"Part {part_id} not found: choose one from the catalogue")
        return
    row["_part"] = part
    if not part.active:
        row.update(result="blocked", message=f"{part.code} is not active in the catalogue")
        return
    first = new_parts.get(key)
    if first is not None and first != part.id:  # the same new serial under another part earlier in this count
        other = parts.get(first)
        row.update(result="blocked", message=f"{part.code} {value} is already scanned in this count as {other.code if other else first}")
        return
    held = db.scalars(select(SpareUnit).where(SpareUnit.part_id == part.id, SpareUnit.serial_key == key)).first()
    if held is not None and held.state != "void":  # a unit on a plant the user may not see
        row.update(result="blocked", message=f"{part.code} {value} cannot be counted in here")
        return
    # one serial, one place (plan §3): not under another part, nor an open failed unit
    holder = stock.serial_holder(db, key, exclude_unit_id=held.id if held is not None else None)
    if holder is not None:
        if not stock._visible(allowed, holder.plant_id):  # hidden: counted as not found, as above
            row.update(result="blocked", message=f"{part.code} {value} cannot be counted in here")
        else:
            row.update(result="blocked", message=f"{part.code} {value} {stock.holder_text(db, holder, allowed)}")
        return
    new_parts[key] = part.id
    row["_unit"] = held  # a voided unit of this part + serial is reused
    row.update(result="new", message=f"New: {part.code} {value} counted into stock")


def _out(db: Session, loc: StockLocation, plan: Dict[str, Any]) -> Dict[str, Any]:
    parts, locs = plan["parts"], plan["locs"]
    units = [r["_unit"] for r in plan["rows"] if r["_unit"] is not None and r["result"] != "new"] + plan["expected"]
    names = stock._plant_names(db, (u.plant_id for u in units))
    uo = lambda u: stock.unit_out(u, parts[u.part_id], locs, names)  # noqa: E731
    rows = [
        {k: v for k, v in r.items() if not k.startswith("_")} | {"unit": uo(r["_unit"]) if r["_unit"] is not None and r["result"] != "new" else None}
        for r in plan["rows"]
    ]
    counts = {"scanned": len(rows), **{k: 0 for k in ("matched", "moved_here", "found_again", "new", "missing", "needs_part", "ambiguous", "blocked", "duplicate", "not_a_unit")}}
    for r in rows:
        counts[str(r["result"])] += 1
    counts["missing"] = len(plan["missing"])
    return {
        "location": stock.location_out(loc, stock._people(db), stock._counts(db), stock._last_counts(db)),
        "expected": [uo(u) for u in plan["expected"]],
        "rows": rows,
        "missing": [uo(u) for u in plan["missing"]],
        "counts": counts,
        "expected_ids": sorted(u.id for u in plan["expected"]),
    }


def preview(db: Session, user: User, location_id: Any, scans: Any) -> Dict[str, Any]:
    loc = _location(db, location_id)
    return _out(db, loc, _plan(db, user, loc, _scans(scans)))


def count_out(c: StockCount, locs: Dict[int, StockLocation]) -> Dict[str, Any]:
    loc = locs.get(c.location_id)
    return {
        "id": c.id,
        "location_id": c.location_id,
        "location_code": loc.code if loc else None,
        "by": c.by,
        "at": iso_utc(c.at),
        "day": c.day.isoformat(),
        "scanned": c.scanned,
        "matched": c.matched,
        "missing": c.missing,
        "moved_here": c.moved_here,
        "new_units": c.new_units,
        "found_again": c.found_again,
        "note": c.note,
        "batch_id": c.batch_id,
    }


def list_counts(db: Session, location_id: Optional[int] = None) -> List[Dict[str, Any]]:
    q = select(StockCount).order_by(StockCount.id.desc()).limit(MAX_COUNTS_LIST)
    if location_id is not None:
        q = q.where(StockCount.location_id == location_id)
    locs = {x.id: x for x in db.scalars(select(StockLocation))}
    return [count_out(c, locs) for c in db.scalars(q)]


def confirm(db: Session, user: User, location_id: Any, scans: Any, expected_ids: Any, note: Optional[str] = None) -> Dict[str, Any]:
    if not can_manage_stock(user):
        raise StockForbidden("Confirming a count needs an admin or store keeper")
    loc = _location(db, location_id)
    user_note = stock._text(note, "Note", 2000)
    plan = _plan(db, user, loc, _scans(scans))
    bad = [{"row": r["index"], "error": r["message"] or r["result"]} for r in plan["rows"] if r["result"] in BLOCKING]
    if bad:
        raise StockConflict(bad)
    if not isinstance(expected_ids, list) or sorted(expected_ids) != sorted(u.id for u in plan["expected"]):
        raise StockConflict([{"row": None, "error": f"The stock at {loc.code} changed since the preview: preview the count again"}], {"code": "stock_changed"})

    day, by, batch_id = _today(), stock._by(user), str(uuid.uuid4())
    movement_note = f"Count at {loc.code}" + (f": {user_note}" if user_note else "")
    written: List[StockMovement] = []
    tally = {"matched": 0, "moved_here": 0, "found_again": 0, "new": 0}

    def move(unit: SpareUnit, part: Part, from_loc: Optional[int], to_loc: Optional[int], from_state: Optional[str], to_state: str, r: Optional[Dict[str, Any]]) -> None:
        m = StockMovement(
            batch_id=batch_id, kind="count_adjust", part_id=part.id, unit_id=unit.id, serial=unit.serial, qty=1,
            from_location_id=from_loc, to_location_id=to_loc, from_state=from_state, to_state=to_state, by=by, day=day, note=movement_note,
            input_method=r["input_method"] if r else None, raw_scan=r["raw"][:512] if r else None,
        )
        db.add(m)
        written.append(m)

    try:
        for r in plan["rows"]:
            res = r["result"]
            if res not in tally:
                continue
            tally[res] += 1
            unit, part = r["_unit"], r["_part"]
            if res == "matched":
                continue
            if res == "new":
                if unit is None:
                    unit = SpareUnit(part_id=part.id, serial=r["serial"], serial_key=serial_key(r["serial"]), state="in_stock", location_id=loc.id, received_day=day)
                    db.add(unit)
                    db.flush()
                    from_state = None
                else:
                    from_state = unit.state  # "void": a corrected receive, counted in again
                unit.received_day = day
                move(unit, part, None, loc.id, from_state, "in_stock", r)
            else:  # moved_here / found_again
                move(unit, part, unit.location_id, loc.id, unit.state, "in_stock", r)
            unit.state, unit.location_id, unit.plant_id = "in_stock", loc.id, None
        for unit in plan["missing"]:
            move(unit, plan["parts"][unit.part_id], loc.id, None, "in_stock", "missing", None)
            unit.state, unit.location_id, unit.plant_id = "missing", None, None
        c = StockCount(
            location_id=loc.id, batch_id=batch_id if written else None, by=by, day=day, scanned=len(plan["rows"]),
            matched=tally["matched"], missing=len(plan["missing"]), moved_here=tally["moved_here"], new_units=tally["new"],
            found_again=tally["found_again"], note=user_note,
        )
        db.add(c)
        db.commit()
    except IntegrityError as exc:  # another change took the same serial a moment ago
        db.rollback()
        raise StockConflict([{"row": None, "error": "Another change got there first; preview the count again"}], {"code": "stock_changed"}) from exc
    return {"count": count_out(c, plan["locs"]), "movements": stock._outs(db, written)}
