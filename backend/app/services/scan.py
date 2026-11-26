"""Barcode / QR scan resolver (docs/plans/barcode-scanning.md §6, §9).

A scanned or typed code is matched against what the app already registers: an app code
(`/s/<kind>/<code>`, the full URL or `kind:code`), then instruments (asset tag, serial), Growatt
inverters, dataloggers and the site register's devices (serial, SIM). Matching is exact on the
normalised value (trimmed, label prefix removed, upper case); there is no fuzzy matching. For a typed
code that matches nothing, `did_you_mean` lists the spellings with O ↔ 0 / I ↔ 1 swapped that do
(exact lookups of a bounded set); the UI offers them and the person chooses, nothing is swapped
on its own.

Plant scoping: a match on a plant the user may not see is left out, so an engineer's answer never
reveals another plant; an app code that names such a device answers not found. Instruments are
visible to everyone (as `/tools`). DB only, nothing is stored: a resolve on its own is not
recorded, the action that follows it is.
"""

from __future__ import annotations

import re
from dataclasses import asdict, dataclass
from typing import Any, Dict, List, Optional, Set, Tuple
from urllib.parse import quote, unquote, urlsplit

from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from app.auth import allowed_plant_ids
from app.db.models import GrowattInverter, GrowattPlant, Instrument, SiteDevice, SiteRegister, User
from app.services.growatt_common import GrowattNotFound
from app.services.visit_route import SlidingWindowLimiter

MAX_CODE_LEN = 512
GS = "\x1d"
# kinds of app label (§6.1); only `tool` and `dev` have records to open so far
APP_KINDS = ("rt", "sp", "loc", "tool", "dev", "df")
RESOLVABLE_KINDS = ("tool", "dev")
_SITE_DEVICE_LABEL = {
    "datalogger": "Data logger",
    "weather_station": "Weather station",
    "revenue_meter": "Revenue meter",
    "router": "4G router",
    "pqm": "PQM",
    "shinemaster": "ShineMaster",
}
# label prefixes in front of a serial (§6.2), longest first; `P/N` marks a part number
_PREFIX = re.compile(r"^(?:SERIAL\s*NO\.?|SERIAL\s*NUMBER|S/N|SN|P/N)\s*[:#.\-]?\s*", re.IGNORECASE)
_APP_PATH = re.compile(r"^/?s/([a-z]+)/(.+)$", re.IGNORECASE)
_APP_SHORT = re.compile(r"^([a-z]+):(\S.*)$", re.IGNORECASE)

limiter = SlidingWindowLimiter()


@dataclass
class Match:
    kind: str  # instrument | inverter | datalogger | site_device
    id: str
    label: str
    field: str  # what matched: asset_tag | serial | sim | device_sn | datalogger_sn
    path: str
    plant_id: Optional[int] = None
    plant_name: Optional[str] = None
    detail: Optional[str] = None


def clean(raw: str) -> str:
    """Control characters out (GS kept: GS1 field separator), spaces trimmed."""
    return "".join(ch for ch in raw if ch == GS or (ord(ch) >= 32 and ord(ch) != 127)).strip()


def normalise(raw: str) -> Tuple[str, bool]:
    """(value for comparison, is_part_number). Upper case, label prefix removed; O/0 and I/1 are
    never swapped."""
    s = clean(raw)
    m = _PREFIX.match(s)
    part = False
    if m and m.end() < len(s):
        part = m.group(0).upper().startswith("P/N")
        s = s[m.end() :].strip()
    return s.upper(), part


def parse_app_code(raw: str) -> Optional[Tuple[str, str]]:
    """(kind, code) of an app label: `https://host/s/tool/MT-01`, `/s/tool/MT-01` or `tool:MT-01`."""
    s = clean(raw)
    if not s:
        return None
    path = s
    if re.match(r"^https?://", s, re.IGNORECASE):
        try:
            path = urlsplit(s).path
        except ValueError:
            return None
    m = _APP_PATH.match(path)
    if not m:
        m = _APP_SHORT.match(s)
    if not m:
        return None
    kind = m.group(1).lower()
    code = unquote(m.group(2)).strip().strip("/")
    if kind not in APP_KINDS or not code:
        return None
    return kind, code


def _plant_names(db: Session, ids: Set[int]) -> Dict[int, str]:
    if not ids:
        return {}
    return dict(db.execute(select(GrowattPlant.plant_id, GrowattPlant.name).where(GrowattPlant.plant_id.in_(ids))).all())


def _visible(allowed: Optional[Set[int]], plant_id: Optional[int]) -> bool:
    """Admin (None) sees everything, a station without a plant included; an engineer only their plants."""
    if allowed is None:
        return True
    return plant_id is not None and plant_id in allowed


def _instrument_match(i: Instrument, field: str) -> Match:
    detail = " · ".join(x for x in (i.make, i.model) if x) or None
    return Match("instrument", str(i.id), f"{i.asset_tag} · {i.name}", field, f"/tools?tool={i.id}", detail=detail)


def _site_device_match(d: SiteDevice, reg: SiteRegister, field: str) -> Match:
    label = _SITE_DEVICE_LABEL.get(d.kind, d.kind)
    if d.seq and d.seq > 1:
        label = f"{label} {d.seq}"
    path = f"/plant/{reg.plant_id}/documents" if reg.plant_id is not None else "/settings?tab=register"
    return Match(
        "site_device",
        str(d.id),
        f"{label} · {reg.site_code}",
        field,
        path,
        plant_id=reg.plant_id,
        detail=d.brand_model,
    )


def _app_code_matches(db: Session, kind: str, code: str, allowed: Optional[Set[int]]) -> List[Match]:
    if kind == "tool":
        i = db.scalars(select(Instrument).where(func.upper(Instrument.asset_tag) == code.upper())).first()
        if i is None:
            raise GrowattNotFound(f"No instrument with tag {code}")
        return [_instrument_match(i, "asset_tag")]
    if kind == "dev":
        row = None
        if code.isdigit():
            row = db.execute(
                select(SiteDevice, SiteRegister).join(SiteRegister, SiteRegister.site_code == SiteDevice.site_code).where(SiteDevice.id == int(code))
            ).first()
        if row is None or not _visible(allowed, row[1].plant_id):
            raise GrowattNotFound(f"No device {code}")
        return [_site_device_match(row[0], row[1], "id")]
    return []


def _raw_matches_many(db: Session, values: Set[str], allowed: Optional[Set[int]]) -> Dict[str, List[Match]]:
    """Exact matches of each normalised value (upper case), by the value matched."""
    out: Dict[str, List[Match]] = {}
    vals = list(values)

    def add(key: Optional[str], m: Match) -> None:
        if key is not None:
            out.setdefault(key.upper(), []).append(m)

    # 1. instruments: asset tag, then serial (visible to everyone)
    for i in db.scalars(select(Instrument).where(func.upper(Instrument.asset_tag).in_(vals))):
        add(i.asset_tag, _instrument_match(i, "asset_tag"))
    for i in db.scalars(select(Instrument).where(func.upper(Instrument.serial_no).in_(vals))):
        key = (i.serial_no or "").upper()
        if not any(m.kind == "instrument" and m.id == str(i.id) for m in out.get(key, [])):
            add(key, _instrument_match(i, "serial"))
    # 2. inverters by serial (a single-serial lookup: a "not installed" one is still found)
    for inv in db.scalars(select(GrowattInverter).where(func.upper(GrowattInverter.device_sn).in_(vals))):
        if not _visible(allowed, inv.plant_id):
            continue
        label = inv.alias or inv.device_sn
        detail = inv.device_model or inv.model
        if inv.not_installed_at is not None:
            detail = f"{detail} · not installed" if detail else "not installed"
        add(
            inv.device_sn,
            Match("inverter", inv.device_sn, f"{label} · {inv.device_sn}", "device_sn", f"/plant/{inv.plant_id}/inverters?q={quote(inv.device_sn)}", plant_id=inv.plant_id, detail=detail),
        )
    # 3. dataloggers (one row per plant the serial serves)
    seen: Set[Tuple[str, int]] = set()
    for sn, pid, dmodel in db.execute(
        select(GrowattInverter.datalogger_sn, GrowattInverter.plant_id, GrowattInverter.datalogger_model).where(func.upper(GrowattInverter.datalogger_sn).in_(vals))
    ):
        if sn is None or (sn, pid) in seen or not _visible(allowed, pid):
            continue
        seen.add((sn, pid))
        add(sn, Match("datalogger", sn, f"Datalogger · {sn}", "datalogger_sn", f"/devices?tab=dataloggers&dq={quote(sn)}", plant_id=pid, detail=dmodel))
    # 4. site register devices: serial or SIM
    rows = db.execute(
        select(SiteDevice, SiteRegister)
        .join(SiteRegister, SiteRegister.site_code == SiteDevice.site_code)
        .where(or_(func.upper(SiteDevice.serial).in_(vals), func.upper(SiteDevice.sim).in_(vals)))
    ).all()
    for d, reg in rows:
        if not _visible(allowed, reg.plant_id):
            continue
        for field, v in (("serial", d.serial), ("sim", d.sim)):
            if v is not None and v.upper() in values:
                add(v, _site_device_match(d, reg, field))
    return out


def _raw_matches(db: Session, value: str, allowed: Optional[Set[int]]) -> List[Match]:
    return _raw_matches_many(db, {value}, allowed).get(value, [])


# O ↔ 0 and I ↔ 1 (§6.2): a typed serial that is not found may be offered as a variant with those
# swapped; the person chooses, the app never swaps on its own
_LOOKALIKE = {"O": "0", "0": "O", "I": "1", "1": "I"}
MAX_LOOKALIKE_POSITIONS = 8  # 2^8 = 256 variants at most
MAX_SUGGESTIONS = 5


def lookalike_variants(value: str) -> List[str]:
    """Every spelling of `value` with O/0 and I/1 swapped (not `value` itself), or [] when it has
    more than MAX_LOOKALIKE_POSITIONS such characters."""
    pos = [i for i, ch in enumerate(value) if ch in _LOOKALIKE]
    if not pos or len(pos) > MAX_LOOKALIKE_POSITIONS:
        return []
    out: List[str] = []
    for mask in range(1, 1 << len(pos)):
        chars = list(value)
        for bit, i in enumerate(pos):
            if mask >> bit & 1:
                chars[i] = _LOOKALIKE[chars[i]]
        out.append("".join(chars))
    return out


def _suggestions(db: Session, value: str, allowed: Optional[Set[int]]) -> List[Dict[str, Any]]:
    variants = lookalike_variants(value)
    if not variants:
        return []
    found = _raw_matches_many(db, set(variants), allowed)
    # fewest swaps first, then in the order generated
    ranked = sorted((v for v in variants if v in found), key=lambda v: (sum(a != b for a, b in zip(v, value)), variants.index(v)))
    return [{"code": v, "matches": [asdict(m) for m in found[v]]} for v in ranked[:MAX_SUGGESTIONS]]


def resolve(db: Session, user: User, raw: str, suggest: bool = False) -> Dict[str, Any]:
    """What a code opens. Raises GrowattNotFound for an app code that names nothing the user may
    see, ValueError for an empty or too long code. `suggest` (a typed code): when nothing matches,
    `did_you_mean` lists the O/0, I/1 variants that do."""
    if len(raw) > MAX_CODE_LEN:
        raise ValueError(f"Code longer than {MAX_CODE_LEN} characters")
    if not clean(raw):
        raise ValueError("Empty code")
    allowed = allowed_plant_ids(db, user)
    app = parse_app_code(raw)
    unsupported: Optional[str] = None
    red_tag: Optional[Dict[str, Any]] = None
    part = False
    if app is not None:
        kind, code = app
        if kind in RESOLVABLE_KINDS:
            matches = _app_code_matches(db, kind, code, allowed)
            value = code.upper()
        elif kind == "rt":
            # a pre-printed red tag: known (blank or bound), but there is no failed-unit register to open yet
            from app.services.scan_labels import red_tag_info

            red_tag = red_tag_info(db, code)
            if red_tag is None:
                raise GrowattNotFound(f"No red tag {code}")
            unsupported, matches, value = kind, [], red_tag["code"]
        else:
            # a label kind whose register is not built yet (red tags, spares, bins, defects)
            unsupported, matches, value = kind, [], code.upper()
    else:
        value, part = normalise(raw)
        matches = _raw_matches(db, value, allowed) if value else []
    did_you_mean = _suggestions(db, value, allowed) if suggest and app is None and value and not matches else []
    names = _plant_names(db, {m.plant_id for m in matches if m.plant_id is not None} | {m["plant_id"] for s in did_you_mean for m in s["matches"] if m["plant_id"] is not None})
    for m in matches:
        if m.plant_id is not None:
            m.plant_name = names.get(m.plant_id)
    for sug in did_you_mean:
        for d in sug["matches"]:
            if d["plant_id"] is not None:
                d["plant_name"] = names.get(d["plant_id"])
    return {
        "code": value,
        "app_code": {"kind": app[0], "code": app[1]} if app else None,
        "unsupported_kind": unsupported,
        # an `rt` app code: the reserved tag (`{code, status, batch, reserved_at}`)
        "red_tag": red_tag,
        # the label said P/N: a part number, not a serial
        "part_number": part,
        "matches": [asdict(m) for m in matches],
        "did_you_mean": did_you_mean,
    }
