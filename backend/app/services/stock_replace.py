"""Spares register, phase 3: a device replaced on site (docs/plans/spares-failed-units.md §5.3, D-4).

One request, one transaction (all or nothing), one `batch_id` on every ledger row:

1. The old unit's serial, as read from its label, is checked against the target's register serial
   (site register device `serial`, or the inverter's `device_sn`). A register serial that differs
   answers 409 `code: register_mismatch` unless `confirm_register_update`; then the label wins.
2. A red tag is bound to a failed unit (`stock_failed._create`: plant, device / inverter, the old
   serial, the fault) with a `failed_in` to a van / store / bin.
3. The spare (`new_unit_id`, `in_stock`) is installed at the plant: an `issue` movement. That row
   also carries `failed_unit_id`, so it shows in the failed unit's trail and phase 1's `correct`
   refuses it (a replacement is not undone one half at a time).
4. D-4: a site register device's serial becomes the spare's serial at once (who and when: the
   ledger rows, plus an `app.audit` line as the register editor writes). An inverter's registry
   row is not changed: Growatt's next `fleet` run brings the new SN, and an admin marks the old
   one "not installed" as today.

Anyone signed in who sees the plant may do it (a field move). No money.
"""

from __future__ import annotations

import logging
import uuid
from typing import Any, Dict, List, Optional, Set, Tuple

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.auth import allowed_plant_ids
from app.db.models import GrowattInverter, GrowattPlant, Part, SiteDevice, SiteRegister, SpareUnit, StockLocation, StockMovement, User, inverter_installed
from app.db.models.stock import INPUT_METHODS, PART_CATEGORIES
from app.services import stock_failed
from app.services.scan import _SITE_DEVICE_LABEL
from app.services.stock_installed import _part_keys, model_key
from app.services.stock import StockConflict, StockError, StockNotFound, _by, _people, _plant_names, _text, _visible, serial_key, unit_out

audit = logging.getLogger("app.audit")


def _category(kind: str) -> str:
    return kind if kind in PART_CATEGORIES else "other"


def _device_label(d: SiteDevice) -> str:
    label = _SITE_DEVICE_LABEL.get(d.kind, d.kind)
    if d.seq and d.seq > 1:
        label = f"{label} {d.seq}"
    return f"{label} · {d.site_code}"


def _site_target(d: SiteDevice) -> Dict[str, Any]:
    return {
        "kind": "site_device",
        "site_device_id": d.id,
        "inverter_sn": None,
        "label": _device_label(d),
        "category": _category(d.kind),
        "serial": d.serial,
        "model": d.brand_model,
    }


def _inverter_target(inv: GrowattInverter) -> Dict[str, Any]:
    return {
        "kind": "inverter",
        "site_device_id": None,
        "inverter_sn": inv.device_sn,
        "label": inv.alias or inv.device_sn,
        "category": "inverter",
        "serial": inv.device_sn,
        "model": inv.device_model or inv.model,
    }


def _plant(db: Session, user: User, plant_id: Any) -> Tuple[GrowattPlant, Optional[Set[int]]]:
    allowed = allowed_plant_ids(db, user)
    p = db.get(GrowattPlant, plant_id) if isinstance(plant_id, int) and not isinstance(plant_id, bool) else None
    if p is None or not _visible(allowed, p.plant_id):
        raise StockNotFound(f"Plant {plant_id} not found")
    return p, allowed


def targets(db: Session, user: User, plant_id: int) -> Dict[str, Any]:
    """What a crew could replace on the plant: its station's site register devices and its installed inverters."""
    p, _ = _plant(db, user, plant_id)
    codes = list(db.scalars(select(SiteRegister.site_code).where(SiteRegister.plant_id == plant_id)))
    devices: List[Dict[str, Any]] = []
    if codes:
        q = select(SiteDevice).where(SiteDevice.site_code.in_(codes)).order_by(SiteDevice.site_code, SiteDevice.kind, SiteDevice.seq)
        devices += [_site_target(d) for d in db.scalars(q)]
    invs = db.scalars(select(GrowattInverter).where(GrowattInverter.plant_id == plant_id, inverter_installed()))
    devices += sorted((_inverter_target(i) for i in invs), key=lambda t: (t["label"], t["inverter_sn"]))
    return {"plant_id": p.plant_id, "plant_name": p.name, "devices": devices}


def _method(body: Dict[str, Any], prefix: str) -> Tuple[Optional[str], Optional[str]]:
    method = body.get(f"{prefix}_input_method")
    if method is not None and method not in INPUT_METHODS:
        raise StockError(f"{prefix}_input_method: one of {', '.join(INPUT_METHODS)}")
    raw = body.get(f"{prefix}_raw_scan")
    if raw is not None and len(str(raw)) > 512:
        raise StockError(f"{prefix}_raw_scan: at most 512 characters")
    return method, (str(raw) if raw is not None else None)


def _target(db: Session, plant_id: int, body: Dict[str, Any]) -> Tuple[Optional[SiteDevice], Optional[GrowattInverter]]:
    dev_id, sn = body.get("site_device_id"), _text(body.get("inverter_sn"), "Inverter SN", 64)
    if (dev_id is None) == (sn is None):
        raise StockError("Choose exactly one device: site_device_id or inverter_sn")
    if dev_id is not None:
        dev = db.get(SiteDevice, dev_id) if isinstance(dev_id, int) and not isinstance(dev_id, bool) else None
        reg = db.get(SiteRegister, dev.site_code) if dev is not None else None
        if dev is None or reg is None or reg.plant_id != plant_id:
            raise StockError("Device: a site register device of this plant")
        return dev, None
    inv = db.get(GrowattInverter, sn)
    if inv is None:
        inv = db.scalars(select(GrowattInverter).where(func.upper(GrowattInverter.device_sn) == serial_key(sn or ""))).first()
    if inv is None or inv.plant_id != plant_id or not inv.installed:
        raise StockError(f"Inverter {sn} is not an installed inverter of this plant")
    return None, inv


def _old_part_id(db: Session, plant_id: int, old_serial: str, target: Dict[str, Any], new_part: Part) -> Optional[int]:
    """The removed unit's catalogue part, only where it is known (never assumed from the spare going in):
    an installed spare unit of this plant with the old serial → its part (and `stock_failed._create`
    links that unit); else the spare's part when the target's recorded model is that part's model
    (a like-for-like swap); else None. A spare of the same category but another model (RUT240 →
    RUT241) does not say what the old unit was."""
    q = select(SpareUnit).where(SpareUnit.serial_key == serial_key(old_serial), SpareUnit.state == "installed", SpareUnit.plant_id == plant_id)
    found = list(db.scalars(q))
    if len(found) == 1:
        return found[0].part_id
    if found:
        return None
    key = model_key(target.get("model"))
    if new_part.category == target["category"] and key is not None and key in _part_keys(new_part):
        return new_part.id
    return None


def replace(db: Session, user: User, body: Dict[str, Any]) -> Dict[str, Any]:
    """The §5.3 flow in one transaction; see the module docstring."""
    try:
        return _replace(db, user, body)
    except Exception:
        db.rollback()
        raise


def _replace(db: Session, user: User, body: Dict[str, Any]) -> Dict[str, Any]:
    plant, allowed = _plant(db, user, body.get("plant_id"))
    dev, inv = _target(db, plant.plant_id, body)
    target = _site_target(dev) if dev is not None else _inverter_target(inv)  # type: ignore[arg-type]
    old_serial = _text(body.get("old_serial"), "Old serial", 64, required=True) or ""
    _text(body.get("fault"), "Fault", 2000, required=True)
    old_method, old_raw = _method(body, "old")
    new_method, new_raw = _method(body, "new")
    _method(body, "red_tag")  # checked; the ledger keeps one scan per row (the old unit's on `failed_in`)
    user_note = _text(body.get("note"), "Note", 2000)
    fault = stock_failed.fault_for(db, user, body.get("fault_id"), plant.plant_id)  # docs/plans/defects.md §6.3

    # 1. the old unit against the register
    register_serial: Optional[str] = target["serial"]
    if register_serial and serial_key(register_serial) != serial_key(old_serial) and body.get("confirm_register_update") is not True:
        if dev is not None:
            msg = f"Register says {register_serial}, label says {old_serial}: confirm to update the register"
        else:  # the Growatt registry is never changed here: the label serial goes on the failed unit only
            msg = f"Growatt says {register_serial}, label says {old_serial}: confirm to record the label serial on the failed unit"
        raise StockConflict(
            [{"row": None, "error": msg}],
            {"code": "register_mismatch", "register_serial": register_serial, "label_serial": old_serial},
        )

    # 3 (checked first). the spare to install
    uid = body.get("new_unit_id")
    unit = db.get(SpareUnit, uid) if isinstance(uid, int) and not isinstance(uid, bool) else None
    if unit is None or unit.state == "void" or not _visible(allowed, unit.plant_id):
        raise StockError(f"New unit {uid} is not in the register")
    part = db.get(Part, unit.part_id)
    assert part is not None
    if unit.state != "in_stock":
        raise StockConflict([{"row": None, "error": f"{part.code} {unit.serial} is {unit.state.replace('_', ' ')}, not in stock"}])
    if serial_key(unit.serial) == serial_key(old_serial):
        raise StockError(f"The new unit's serial {unit.serial} is the old unit's: scan the spare being installed")
    warnings: List[str] = []
    if part.category != target["category"]:
        warnings.append(f"{part.code} is a {part.category.replace('_', ' ')} part; {target['label']} is a {target['category'].replace('_', ' ')}")
    loc = db.get(StockLocation, unit.location_id) if unit.location_id is not None else None
    if loc is not None and loc.kind == "van" and loc.holder_user_id is not None and loc.holder_user_id != user.id:
        holder = _people(db).get(loc.holder_user_id)
        warnings.append(f"{unit.serial} is from {loc.code}" + (f" ({holder})" if holder else ""))

    batch_id = str(uuid.uuid4())
    note = f"Replacement: {old_serial} → {unit.serial}" + (f" · {user_note}" if user_note else "")

    # 2. red tag → failed unit (`failed_in`); checks the tag, the location and the day before writing
    fu = stock_failed._create(
        db,
        user,
        {
            "red_tag": body.get("red_tag"),
            "fault": body.get("fault"),
            "plant_id": plant.plant_id,
            "site_device_id": dev.id if dev is not None else None,
            "inverter_sn": inv.device_sn if inv is not None else None,
            "serial": old_serial,
            "part_id": _old_part_id(db, plant.plant_id, old_serial, target, part),
            "to_location_id": body.get("failed_to_location_id"),
            "removed_day": body.get("removed_day"),
            "input_method": old_method,
            "raw_scan": old_raw,
            "note": note,
        },
        batch_id=batch_id,
    )

    # 3. install the spare (an `issue`)
    db.add(
        StockMovement(
            batch_id=batch_id,
            kind="issue",
            part_id=part.id,
            unit_id=unit.id,
            serial=unit.serial,
            qty=1,
            from_location_id=unit.location_id,
            to_location_id=None,
            plant_id=plant.plant_id,
            from_state="in_stock",
            to_state="installed",
            failed_unit_id=fu.id,
            by=_by(user),
            day=stock_failed._today(),
            note=note,
            input_method=new_method,
            raw_scan=new_raw[:512] if new_raw else None,
        )
    )
    unit.state, unit.location_id, unit.plant_id = "installed", None, plant.plant_id

    # 4. the register (D-4)
    if dev is not None:
        dev.serial = unit.serial
        register: Dict[str, Any] = {"kind": "site_device", "updated": True, "site_device_id": dev.id, "inverter_sn": None,
                                    "old_serial": register_serial, "new_serial": unit.serial}
    else:
        register = {"kind": "inverter", "updated": False, "site_device_id": None, "inverter_sn": inv.device_sn,  # type: ignore[union-attr]
                    "old_serial": register_serial, "new_serial": unit.serial,
                    "note": f"The Growatt registry is not changed: the next fleet run brings {unit.serial}; "
                            f"an admin marks {register_serial} not installed."}
    if fault is not None:  # the fault it answers: batch + failed unit linked, restored when asked
        from app.services import faults

        faults.attach(db, fault, _by(user), "stock_batch", ref_key=batch_id)
        faults.attach(db, fault, _by(user), "failed_unit", ref_id=fu.id, to_status="restored" if body.get("restore_fault") else None)
    stock_failed._commit(db)
    audit.info("replacement on plant %s by %s: %s, batch %s", plant.plant_id, _by(user), target["label"], batch_id)

    failed = stock_failed.failed_out(db, fu)
    locs = {lo.id: lo for lo in db.scalars(select(StockLocation))}
    return {
        "batch_id": batch_id,
        "failed_unit": failed,
        "installed_unit": unit_out(unit, part, locs, _plant_names(db, [plant.plant_id])),
        "register": register,
        "warnings": warnings,
        "fault": None if fault is None else {"id": fault.id, "no": fault.no, "status": fault.status},
        "claim_prefill": {
            "type": "inverter_warranty" if inv is not None else "equipment_warranty",
            "plant_id": plant.plant_id,
            "device_sn": old_serial,
            "new_sn": unit.serial,
            "device_label": target["label"],
            "failed_unit_id": fu.id,
            "red_tag": failed["red_tag"],
        },
    }
