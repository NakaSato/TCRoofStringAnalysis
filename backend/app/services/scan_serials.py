"""Serial shape warnings per device type (docs/plans/barcode-scanning.md §6.3).

A serial typed or scanned into a form is compared with the serials already registered for the same
category (and model, when that model has enough of them): its length range, its characters (digits
only, or letters and digits) and a letter prefix nearly all of them share (CEWE meters `WP…`).
The expectation is learned from the registry, never assumed, and the answer is a warning only:
models vary, so nothing is refused. A value that looks like an IMEI or a SIM ICCID (Luhn check
digit) is flagged too, since a router label carries both next to its SN.

Only the learned shape goes back (length range, character class, a short letter prefix), never
another device's serial, so the check needs no plant scoping. DB only, nothing stored; each
category's serials are read once per `_TTL_S`.
"""

from __future__ import annotations

import re
import threading
import time
from collections import Counter
from typing import Any, Dict, List, Optional, Tuple

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db.models import GrowattInverter, Instrument, Part, SiteDevice, SpareUnit

MIN_SAMPLES = 5  # fewer known serials than this: no expectation, no warning
PREFIX_SHARE = 0.95  # a letter prefix counts when at least this share of the known serials has it
MAX_PREFIX = 4
_TTL_S = 600

_lock = threading.Lock()
_cache: Dict[str, Tuple[float, List[Tuple[str, str]]]] = {}

_ALNUM = re.compile(r"^[A-Z0-9]+$")
_DIGITS = re.compile(r"^[0-9]+$")


def luhn_ok(digits: str) -> bool:
    if not digits.isdigit():
        return False
    total = 0
    for i, ch in enumerate(reversed(digits)):
        d = int(ch)
        if i % 2 == 1:
            d *= 2
            if d > 9:
                d -= 9
        total += d
    return total % 10 == 0


def looks_like_imei(v: str) -> bool:
    return len(v) == 15 and luhn_ok(v)


def looks_like_iccid(v: str) -> bool:
    return len(v) in (19, 20) and v.startswith("89") and luhn_ok(v)


def _norm(v: Optional[str]) -> Optional[str]:
    s = (v or "").strip().upper()
    return s or None


def _join_model(*parts: Optional[str]) -> str:
    return " ".join(p.strip() for p in parts if p and p.strip())


def _read(db: Session, category: str) -> List[Tuple[str, str]]:
    """(serial, model) of every registered serial in `category`, both upper case."""
    out: List[Tuple[str, str]] = []

    def add(serial: Optional[str], model: Optional[str]) -> None:
        s = _norm(serial)
        if s is not None:
            out.append((s, (model or "").strip().upper()))

    if category.startswith("tool:"):
        for sn, make, model in db.execute(select(Instrument.serial_no, Instrument.make, Instrument.model).where(Instrument.category == category[5:])):
            add(sn, _join_model(make, model))
        return out
    if category.endswith(":sim"):
        for sim, bm in db.execute(select(SiteDevice.sim, SiteDevice.brand_model).where(SiteDevice.kind == category[:-4])):
            add(sim, bm)
        return out
    if category == "inverter":
        for sn, dm, m in db.execute(select(GrowattInverter.device_sn, GrowattInverter.device_model, GrowattInverter.model)):
            add(sn, dm or m)
    if category == "datalogger":
        for sn, dm in db.execute(select(GrowattInverter.datalogger_sn, GrowattInverter.datalogger_model).distinct()):
            add(sn, dm)
    for sn, bm in db.execute(select(SiteDevice.serial, SiteDevice.brand_model).where(SiteDevice.kind == category)):
        add(sn, bm)
    for sn, make, model in db.execute(
        select(SpareUnit.serial, Part.make, Part.model).join(Part, Part.id == SpareUnit.part_id).where(Part.category == category, SpareUnit.state != "void")
    ):
        add(sn, _join_model(make, model))
    return list(dict.fromkeys(out))  # a datalogger in both the Growatt and the site register counts once


def _known(db: Session, category: str) -> List[Tuple[str, str]]:
    now = time.monotonic()
    with _lock:
        hit = _cache.get(category)
        if hit is not None and now - hit[0] < _TTL_S:
            return hit[1]
    rows = _read(db, category)
    with _lock:
        _cache[category] = (now, rows)
    return rows


def clear_cache() -> None:
    with _lock:
        _cache.clear()


def learn(serials: List[str]) -> Optional[Dict[str, Any]]:
    """The shape the known serials share, or None below MIN_SAMPLES."""
    if len(serials) < MIN_SAMPLES:
        return None
    lens = [len(s) for s in serials]
    charset: Optional[str] = None
    if all(_DIGITS.match(s) for s in serials):
        charset = "digits"
    elif all(_ALNUM.match(s) for s in serials):
        charset = "alnum"
    prefix: Optional[str] = None
    for n in range(MAX_PREFIX, 1, -1):
        common, count = Counter(s[:n] for s in serials if len(s) >= n).most_common(1)[0] if any(len(s) >= n for s in serials) else ("", 0)
        if count >= PREFIX_SHARE * len(serials) and common.isalpha():
            prefix = common
            break
    return {"count": len(serials), "min_len": min(lens), "max_len": max(lens), "charset": charset, "prefix": prefix}


def check(db: Session, category: str, model: Optional[str], serial: str) -> Dict[str, Any]:
    """Warnings for `serial` as a `category` (+ `model`) serial. `basis` says what it was compared
    with: the model's serials when it has MIN_SAMPLES, else the category's; null = too few known."""
    value = _norm(serial) or ""
    rows = _known(db, category.strip().lower())
    m = (model or "").strip().upper()
    scope = "category"
    serials = [s for s, _ in rows]
    if m:
        same = [s for s, mm in rows if mm == m]
        if len(same) >= MIN_SAMPLES:
            serials, scope = same, "model"
    shape = learn(serials)
    warnings: List[Dict[str, Any]] = []
    if not value:
        return {"serial": value, "warnings": warnings, "expected": shape, "basis": scope if shape else None}
    is_sim = category.endswith(":sim")
    if not is_sim and looks_like_iccid(value):
        warnings.append({"code": "iccid"})
    elif not is_sim and looks_like_imei(value) and not (shape and shape["min_len"] <= 15 <= shape["max_len"] and shape["charset"] == "digits"):
        warnings.append({"code": "imei"})
    if shape is not None:
        if not shape["min_len"] <= len(value) <= shape["max_len"]:
            warnings.append({"code": "length", "min": shape["min_len"], "max": shape["max_len"], "got": len(value)})
        if shape["charset"] == "digits" and not _DIGITS.match(value):
            warnings.append({"code": "digits"})
        elif shape["charset"] == "alnum" and not _ALNUM.match(value):
            warnings.append({"code": "alnum"})
        if shape["prefix"] and not value.startswith(shape["prefix"]):
            warnings.append({"code": "prefix", "prefix": shape["prefix"]})
    return {"serial": value, "warnings": warnings, "expected": shape, "basis": scope if shape else None}
