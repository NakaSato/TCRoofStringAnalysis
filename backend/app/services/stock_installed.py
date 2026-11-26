"""Inventory linked to the installed equipment (docs/plans/inventory-installed-base.md).

Read from the registries, nothing copied or synced: Growatt inverters and their dataloggers
(`growatt_inverters`), the O&M site register's devices (`site_devices`) and the Growatt grid-point
meters (`growatt_meters`, no serial).

- `installed` (L-1): one row per installed device, scoped by `allowed_plant_ids` (a site register
  station without a plant: admin only, as the register); inverters marked not installed are left
  out (`inverter_installed()`). A Growatt datalogger is listed only when no site register
  datalogger of the same plant has its serial (case-insensitive).
- `models` (L-4): installed vs spares in stock vs failed per (category, model key) and phase. A
  model not recorded is its own row; catalogue parts that match no installed model get a row too.
- `from_models` (L-2): proposed catalogue parts for the models in use (store keeper); `apply`
  creates the reviewed ones with the catalogue's own validation, all or nothing.
- `registry_where` (L-3): where the registry has each serial (exact, case-insensitive).

Values the registry does not have are null, never guessed. DB only, nothing stored but `apply`.
"""

from __future__ import annotations

import logging
import re
from collections import Counter, defaultdict
from typing import Any, Dict, Iterable, List, Optional, Set, Tuple
from urllib.parse import quote

from sqlalchemy import func, or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.auth import allowed_plant_ids
from app.db.models import FailedUnit, GrowattInverter, GrowattMeter, GrowattPlant, Part, SiteDevice, SiteRegister, SpareUnit, User, inverter_installed
from app.db.models.stock import FAILED_OPEN, PART_CATEGORIES
from app.services.scan import _SITE_DEVICE_LABEL
from app.services.scan import _visible as _plant_visible  # admin sees a station without a plant
from app.services.stock import MAX_BATCH, StockConflict, StockError, _by, _need_keeper, _part_fields, part_out, serial_key
from app.services.stock import _visible as _spare_visible  # a unit / failed unit without a plant: everyone

audit = logging.getLogger("app.audit")

# list order of the categories (contract: InstalledDevice.category)
INSTALLED_CATEGORIES = ("inverter", "datalogger", "weather_station", "revenue_meter", "router", "pqm", "shinemaster", "grid_meter")
_CAT_ORDER = {c: i for i, c in enumerate(INSTALLED_CATEGORIES + tuple(c for c in PART_CATEGORIES if c not in INSTALLED_CATEGORIES))}
# a proposal's make for these categories (Growatt equipment); others: the first word of a multi-word model
GROWATT_MAKE = ("inverter", "datalogger", "shinemaster", "weather_station")
MAX_SERIALS = 200
MAX_SERIAL_LEN = 64
MAX_INSTALLED_LIMIT = 5000
CODE_MAX = 40


def model_key(model: Optional[str]) -> Optional[str]:
    """Upper case, spaces collapsed; None for an empty model."""
    if model is None:
        return None
    k = " ".join(str(model).split()).upper()
    return k or None


def _natural(s: Optional[str]) -> Tuple[Any, ...]:
    return tuple(int(p) if p.isdigit() else p.lower() for p in re.split(r"(\d+)", s or ""))


def _site_label(d: SiteDevice) -> str:
    label = _SITE_DEVICE_LABEL.get(d.kind, d.kind)
    return f"{label} {d.seq}" if d.seq and d.seq > 1 else label


def _category(kind: str) -> str:
    return kind if kind in PART_CATEGORIES else "other"


def _row(**kw: Any) -> Dict[str, Any]:
    out: Dict[str, Any] = {
        "key": "", "source": "", "category": "", "label": "", "serial": None, "model": None,
        "plant_id": None, "plant_name": None, "site_code": None, "phase": None,
        "ip": None, "network": None, "sim": None, "status": None,
        "site_device_id": None, "inverter_sn": None, "path": "", "spare_unit_id": None, "spare_part_id": None, "failed_open": False,
    }
    out.update(kw)
    return out


def _collect(db: Session, allowed: Optional[Set[int]], serials: Optional[Set[str]] = None) -> List[Dict[str, Any]]:
    """Every installed device the user may see (unsorted). `serials` (upper-case keys): only the
    devices with one of these serials (grid meters, having none, are then left out)."""
    plants: Dict[int, Tuple[str, Optional[int]]] = {pid: (name, phase) for pid, name, phase in db.execute(select(GrowattPlant.plant_id, GrowattPlant.name, GrowattPlant.phase))}
    regs = {r.site_code: r for r in db.scalars(select(SiteRegister))}
    site_of_plant = {r.plant_id: r.site_code for r in regs.values() if r.plant_id is not None}

    def plant_fields(pid: Optional[int]) -> Dict[str, Any]:
        name, phase = plants.get(pid, (None, None)) if pid is not None else (None, None)
        return {"plant_id": pid, "plant_name": name, "phase": phase}

    rows: List[Dict[str, Any]] = []
    vals = list(serials) if serials is not None else None
    want: Set[str] = serials or set()

    # 1. site register devices
    sq = select(SiteDevice)
    if vals is not None:
        sq = sq.where(func.upper(SiteDevice.serial).in_(vals))
    register_loggers: Set[Tuple[int, str]] = set()  # (plant_id, serial key) of the register's dataloggers
    for d in db.scalars(sq):
        reg = regs.get(d.site_code)
        if reg is None or not _plant_visible(allowed, reg.plant_id):
            continue
        if d.kind == "datalogger" and d.serial and reg.plant_id is not None:
            register_loggers.add((reg.plant_id, serial_key(d.serial)))
        rows.append(_row(
            key=f"sd:{d.id}", source="site_device", category=_category(d.kind), label=_site_label(d),
            serial=d.serial, model=d.brand_model, site_code=d.site_code, **plant_fields(reg.plant_id),
            ip=d.ip, network=d.network, sim=d.sim, status=d.status, site_device_id=d.id,
            path=f"/plant/{reg.plant_id}/documents" if reg.plant_id is not None else "/settings?tab=register",
        ))
    # (with `serials`, a register datalogger that hides a Growatt one has the same serial, so it is here)

    # 2. installed inverters and their dataloggers
    iq = select(GrowattInverter).where(inverter_installed())
    if vals is not None:
        iq = iq.where(or_(func.upper(GrowattInverter.device_sn).in_(vals), func.upper(GrowattInverter.datalogger_sn).in_(vals)))
    loggers: Dict[Tuple[str, int], Optional[str]] = {}
    for inv in db.scalars(iq.order_by(GrowattInverter.device_sn)):
        if not _plant_visible(allowed, inv.plant_id):
            continue
        if inv.datalogger_sn:
            k = (inv.datalogger_sn, inv.plant_id)
            if loggers.get(k) is None:
                loggers[k] = inv.datalogger_model
        if vals is not None and serial_key(inv.device_sn) not in want:
            continue
        rows.append(_row(
            key=f"inv:{inv.device_sn}", source="inverter", category="inverter", label=inv.alias or inv.device_sn,
            serial=inv.device_sn, model=inv.device_model or inv.model, site_code=site_of_plant.get(inv.plant_id),
            **plant_fields(inv.plant_id), inverter_sn=inv.device_sn,
            path=f"/plant/{inv.plant_id}/inverters?q={quote(inv.device_sn)}",
        ))
    for (sn, pid), dmodel in loggers.items():
        if (pid, serial_key(sn)) in register_loggers:
            continue  # the site register lists it
        if vals is not None and serial_key(sn) not in want:
            continue
        rows.append(_row(
            key=f"dl:{sn}:{pid}", source="datalogger", category="datalogger", label=_SITE_DEVICE_LABEL["datalogger"],
            serial=sn, model=dmodel, site_code=site_of_plant.get(pid), **plant_fields(pid),
            path=f"/devices?tab=dataloggers&dq={quote(sn)}",
        ))

    # 3. Growatt grid-point meters (no serial)
    if vals is None:
        for m in db.scalars(select(GrowattMeter).order_by(GrowattMeter.datalogger_sn, GrowattMeter.address)):
            if not _plant_visible(allowed, m.plant_id):
                continue
            rows.append(_row(
                key=f"gm:{m.datalogger_sn}:{m.address}", source="grid_meter", category="grid_meter", label=f"Grid meter · addr {m.address}",
                model=m.device_name, site_code=site_of_plant.get(m.plant_id), **plant_fields(m.plant_id),
                path=f"/devices?tab=meters&mq={quote(m.datalogger_sn)}",
            ))
    return rows


def _mark_spares(db: Session, allowed: Optional[Set[int]], rows: List[Dict[str, Any]]) -> None:
    """`spare_unit_id` / `spare_part_id` (a visible spare unit installed with the serial, any part, and
    its part: the Stock tab opens a unit only with its part) and `failed_open`."""
    keys = {serial_key(r["serial"]) for r in rows if r["serial"]}
    if not keys:
        return
    spare: Dict[str, Tuple[int, int]] = {}
    for uid, part_id, key, pid in db.execute(
        select(SpareUnit.id, SpareUnit.part_id, SpareUnit.serial_key, SpareUnit.plant_id).where(SpareUnit.state == "installed").order_by(SpareUnit.id)
    ):
        if key in keys and key not in spare and _spare_visible(allowed, pid):
            spare[key] = (uid, part_id)
    failed: Set[str] = set()
    for key, pid in db.execute(select(FailedUnit.serial_key, FailedUnit.plant_id).where(FailedUnit.status.in_(FAILED_OPEN), FailedUnit.serial_key.is_not(None))):
        if key in keys and _spare_visible(allowed, pid):
            failed.add(key)
    for r in rows:
        if r["serial"]:
            k = serial_key(r["serial"])
            uid, part_id = spare.get(k, (None, None))
            r["spare_unit_id"] = uid
            r["spare_part_id"] = part_id
            r["failed_open"] = k in failed


def _sort_key(r: Dict[str, Any]) -> Tuple[Any, ...]:
    name = r["plant_name"]
    return (name is None, (name or "").lower(), r["site_code"] or "", _CAT_ORDER.get(r["category"], 99), _natural(r["label"]), r["key"])


# ------------------------------------------------------------------------------------ L-1 list


def installed(
    db: Session,
    user: User,
    category: Optional[str] = None,
    plant_id: Optional[int] = None,
    phase: Optional[int] = None,
    q: Optional[str] = None,
    limit: int = 500,
    offset: int = 0,
) -> Dict[str, Any]:
    """`{items, total, counts, meta}`. `counts` per category over every filter but `category` (the
    chips), `total` over all of them; both before limit / offset."""
    allowed = allowed_plant_ids(db, user)
    rows = _collect(db, allowed)
    if plant_id is not None:
        rows = [r for r in rows if r["plant_id"] == plant_id]
    if phase is not None:
        rows = [r for r in rows if r["phase"] == phase]
    needle = (q or "").strip().lower()
    if needle:
        rows = [r for r in rows if any(needle in str(r[f]).lower() for f in ("serial", "label", "model", "plant_name", "site_code", "ip", "sim") if r[f] is not None)]
    counts = Counter(r["category"] for r in rows)
    if category:
        rows = [r for r in rows if r["category"] == category]
    rows.sort(key=_sort_key)
    limit = min(max(limit, 1), MAX_INSTALLED_LIMIT)
    offset = max(offset, 0)
    page = rows[offset : offset + limit]
    _mark_spares(db, allowed, page)
    return {
        "items": page,
        "total": len(rows),
        "counts": {c: counts[c] for c in sorted(counts, key=lambda c: _CAT_ORDER.get(c, 99))},
        "meta": {"source": "db"},
    }


# ---------------------------------------------------------------------------------- L-4 models


def _part_keys(p: Part) -> List[str]:
    keys: List[str] = []
    k = model_key(p.model)
    if k:
        keys.append(k)
        if p.make:
            km = model_key(f"{p.make} {p.model}")
            if km and km not in keys:
                keys.append(km)
    return keys


def _installed_models(rows: Iterable[Dict[str, Any]]) -> Dict[Tuple[str, Optional[str]], Dict[str, Any]]:
    """{(category, model key): {model (most common spelling), installed, by_phase}}."""
    groups: Dict[Tuple[str, Optional[str]], Dict[str, Any]] = {}
    for r in rows:
        k = (r["category"], model_key(r["model"]))
        g = groups.setdefault(k, {"spellings": Counter(), "installed": 0, "by_phase": Counter()})
        g["installed"] += 1
        g["by_phase"][str(r["phase"]) if r["phase"] is not None else "none"] += 1
        if k[1] is not None:
            g["spellings"][" ".join(str(r["model"]).split())] += 1
    for g in groups.values():
        g["model"] = g["spellings"].most_common(1)[0][0] if g["spellings"] else None
    return groups


def _match_parts(parts: Iterable[Part], keys: Set[Tuple[str, Optional[str]]]) -> Dict[int, Tuple[str, Optional[str]]]:
    """{part id: the installed (category, model key) it matches}; its own model first, then make + model."""
    out: Dict[int, Tuple[str, Optional[str]]] = {}
    for p in parts:
        for k in _part_keys(p):
            if (p.category, k) in keys:
                out[p.id] = (p.category, k)
                break
    return out


def models(db: Session, user: User) -> Dict[str, Any]:
    allowed = allowed_plant_ids(db, user)
    groups = _installed_models(_collect(db, allowed))
    parts = list(db.scalars(select(Part).order_by(Part.code)))
    matched = _match_parts(parts, {k for k in groups if k[1] is not None})
    rows: Dict[Tuple[str, Optional[str]], Dict[str, Any]] = {}
    for k, g in groups.items():
        rows[k] = {"category": k[0], "model": g["model"], "model_key": k[1], "installed": g["installed"],
                   "installed_by_phase": dict(sorted(g["by_phase"].items())), "in_stock": 0, "failed_open": 0, "at_supplier": 0, "parts": []}
    row_of_part: Dict[int, Tuple[str, Optional[str]]] = {}
    for p in parts:
        k = matched.get(p.id)
        if k is None:  # matches no installed model: its own row, so every spare is counted
            pk = _part_keys(p)
            k = (p.category, pk[0] if pk else None)
            if k not in rows:
                rows[k] = {"category": p.category, "model": " ".join(p.model.split()) if p.model else None, "model_key": k[1], "installed": 0,
                           "installed_by_phase": {}, "in_stock": 0, "failed_open": 0, "at_supplier": 0, "parts": []}
        row_of_part[p.id] = k
        rows[k]["parts"].append({"id": p.id, "code": p.code, "name": p.name, "min_qty": p.min_qty, "active": bool(p.active)})
    for pid, state, upid, n in db.execute(
        select(SpareUnit.part_id, SpareUnit.state, SpareUnit.plant_id, func.count())
        .where(SpareUnit.state.in_(("in_stock", "at_supplier")))
        .group_by(SpareUnit.part_id, SpareUnit.state, SpareUnit.plant_id)
    ):
        k = row_of_part.get(pid)
        if k is not None and _spare_visible(allowed, upid):
            rows[k]["in_stock" if state == "in_stock" else "at_supplier"] += int(n)
    for pid, status, fpid, linked, n in db.execute(
        select(FailedUnit.part_id, FailedUnit.status, FailedUnit.plant_id, FailedUnit.spare_unit_id.is_not(None), func.count())
        .where(FailedUnit.status.in_(FAILED_OPEN), FailedUnit.part_id.is_not(None))
        .group_by(FailedUnit.part_id, FailedUnit.status, FailedUnit.plant_id, FailedUnit.spare_unit_id.is_not(None))
    ):
        k = row_of_part.get(pid) if pid is not None else None
        if k is None or not _spare_visible(allowed, fpid):
            continue
        rows[k]["failed_open"] += int(n)
        if status == "sent" and not linked:  # a linked spare unit sent is counted above, as `at_supplier`
            rows[k]["at_supplier"] += int(n)
    items = sorted(rows.values(), key=lambda r: (_CAT_ORDER.get(r["category"], 99), r["model_key"] is None, -r["installed"], r["model_key"] or ""))
    return {"items": items}


# ---------------------------------------------------------------------------- L-2 from models


def _split_make(category: str, model: str) -> Tuple[Optional[str], str]:
    if category == "grid_meter":
        # Growatt reads the meter, it does not make it: CHNT_THREE is a Chint meter; another model's make is not known
        return ("Chint" if model.upper().startswith("CHNT") else None), model
    if category in GROWATT_MAKE:
        words = model.split()
        # "Growatt Weather Station" → Growatt / Weather Station (make + model still matches the row)
        return "Growatt", " ".join(words[1:]) if len(words) > 1 and words[0].upper() == "GROWATT" else model
    words = model.split()
    if len(words) > 1:
        return words[0], " ".join(words[1:])
    return None, model


def _code_base(category: str, model: str) -> str:
    s = re.sub(r"[^A-Z0-9]+", "-", f"P-{category}-{model}".upper()).strip("-")
    return s[:CODE_MAX].rstrip("-")


def _free_code(base: str, taken: Set[str]) -> str:
    if base not in taken:
        return base
    n = 2
    while True:
        suffix = f"-{n}"
        code = base[: CODE_MAX - len(suffix)].rstrip("-") + suffix
        if code not in taken:
            return code
        n += 1


def _name(make: Optional[str], model: str) -> str:
    """make + model, the make not repeated when the model already starts with it ("Growatt Weather Station")."""
    if not make or model_key(model) == model_key(make) or (model_key(model) or "").startswith((model_key(make) or "") + " "):
        return model
    return f"{make} {model}"[:120]


def proposals(db: Session, user: User) -> Dict[str, Any]:
    _need_keeper(user)
    allowed = allowed_plant_ids(db, user)
    groups = _installed_models(_collect(db, allowed))
    parts = {p.id: p for p in db.scalars(select(Part).order_by(Part.code))}
    matched: Dict[Tuple[str, Optional[str]], Part] = {}
    for pid, k in _match_parts(parts.values(), {k for k in groups if k[1] is not None}).items():
        matched.setdefault(k, parts[pid])
    taken = {p.code for p in parts.values()}
    out: List[Dict[str, Any]] = []
    keys = sorted((k for k in groups if k[1] is not None), key=lambda k: (_CAT_ORDER.get(k[0], 99), -groups[k]["installed"], k[1] or ""))
    for k in keys:
        g = groups[k]
        category, installed_model = k[0], g["model"]
        part = matched.get(k)
        if part is not None:
            out.append({"category": category, "model": part.model or installed_model, "make": part.make, "code": part.code, "name": part.name,
                        "installed": g["installed"], "part_id": part.id, "model_key": k[1]})
            continue
        make, model = _split_make(category, installed_model)
        code = _free_code(_code_base(category, model), taken)
        taken.add(code)
        out.append({"category": category, "model": model[:64], "make": make, "code": code, "name": _name(make, model),
                    "installed": g["installed"], "part_id": None, "model_key": k[1]})
    return {"proposals": out}


def apply(db: Session, user: User, items: List[Dict[str, Any]]) -> Dict[str, Any]:
    """Create the reviewed parts, all or nothing (409 with `errors` [{row, error}])."""
    _need_keeper(user)
    if not items:
        raise StockError("No items")
    if len(items) > MAX_BATCH:
        raise StockError(f"At most {MAX_BATCH} items at once")
    taken = set(db.scalars(select(Part.code)))
    seen: Set[str] = set()
    errors: List[Dict[str, Any]] = []
    plan: List[Dict[str, Any]] = []
    for i, it in enumerate(items):
        try:
            f = _part_fields({k: it.get(k) for k in ("code", "name", "category", "make", "model")}, partial=False)
            if not f.get("model"):
                raise StockError("Model is required")
            if f["code"] in taken:
                raise StockError(f"Part code {f['code']} is already in the catalogue")
            if f["code"] in seen:
                raise StockError(f"Part code {f['code']} is twice in this list")
            seen.add(f["code"])
            plan.append(f)
        except StockError as exc:
            errors.append({"row": i, "error": str(exc)})
    if errors:
        raise StockConflict(errors)
    by = _by(user)
    created = [Part(**f, serialised=True, unit="pc", created_by=by) for f in plan]
    try:
        db.add_all(created)
        db.commit()
    except IntegrityError as exc:  # another keeper took a code a moment ago
        db.rollback()
        raise StockConflict([{"row": None, "error": "Another change got there first; reload and try again"}]) from exc
    audit.info("stock parts from installed models by %s: %s", by, ", ".join(p.code for p in created))
    return {"created": [part_out(p) for p in created]}


# --------------------------------------------------------------------------- L-3 registry-where


def parse_serials(raw: Optional[str]) -> List[str]:
    """Comma-separated serials → distinct keys (trimmed, upper case). StockError over 200 or one over 64."""
    keys: List[str] = []
    for s in (raw or "").split(","):
        k = serial_key(s)
        if not k:
            continue
        if len(k) > MAX_SERIAL_LEN:
            raise StockError(f"A serial is at most {MAX_SERIAL_LEN} characters")
        if k not in keys:
            keys.append(k)
    if len(keys) > MAX_SERIALS:
        raise StockError(f"At most {MAX_SERIALS} serials at once")
    return keys


_HIT_FIELDS = ("source", "category", "label", "plant_id", "plant_name", "site_code", "ip", "network", "sim", "path")


def registry_where(db: Session, user: User, serials: Optional[str]) -> Dict[str, Any]:
    keys = parse_serials(serials)
    if not keys:
        return {"items": {}}
    hits: Dict[str, List[Dict[str, Any]]] = defaultdict(list)
    for r in sorted(_collect(db, allowed_plant_ids(db, user), set(keys)), key=_sort_key):
        hits[serial_key(r["serial"])].append({f: r[f] for f in _HIT_FIELDS})
    return {"items": dict(hits)}
