"""O&M site register (docs/plans/om-asset-network.md): the team's workbook → JSON → SQL.

`convert_workbook` reads `OM-Asset & Network.xlsx` into a plain JSON document (one entry per station with its
devices); `import_register` matches each station to its Growatt plant and, with `apply`, replaces
`site_register` / `site_devices` with it (all or nothing). Values are kept as written; an empty cell is null and
nothing is filled in. Network details (IPs, SIMs) and PEA account numbers stay in SQL and the API: never
Firestore, never the logs (only counts are logged).

CLI (repo root):
    PYTHONPATH=backend uv run python -m app.services.site_register convert "data/OM-Asset & Network.xlsx" -o data/site_register.json
    PYTHONPATH=backend uv run python -m app.services.site_register import data/site_register.json [--apply]
"""

from __future__ import annotations

import argparse
import io
import json
import logging
import pathlib
import re
from collections import Counter, defaultdict
from datetime import date, datetime, timezone
from typing import Any, Dict, Iterable, List, Optional, Set, Tuple, Union

from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from app.db.models import (
    GrowattEnvSensor,
    GrowattInverter,
    GrowattMeter,
    GrowattPlant,
    PwaMeterSite,
    SiteDevice,
    SiteRegister,
)

log = logging.getLogger(__name__)

FORMAT = "site_register/1"
CODE_RE = re.compile(r"^P(\d)-(\d{3})$")

# sheet → device kind
DEVICE_SHEETS: Dict[str, str] = {
    "อุปกรณ์ - Data logger": "datalogger",
    "อุปกรณ์ - Weather station": "weather_station",
    "อุปกรณ์ - Revenue meter": "revenue_meter",
    "อุปกรณ์ - Router 4G": "router",
    "อุปกรณ์ - PQM": "pqm",
    "อุปกรณ์ - ShineMaster": "shinemaster",
}
KINDS = tuple(DEVICE_SHEETS.values())
STATION_SHEET = "ข้อมูลสถานี"
COD_SHEET = "_นำเข้า COD"

# header (as written) → (field, type); types: s = text, f = number, i = integer, d = date
STATION_COLS = {
    "สถานี": ("name", "s"),
    "ระยะ": ("project_phase", "i"),
    "kWp": ("kwp", "f"),
    "เลขมิเตอร์ กฟภ.": ("pea_meter_no", "s"),
    "จังหวัด": ("province", "s"),
    "SN Data logger": ("logger_sn", "s"),
    "จำนวน Revenue meter": ("revenue_meter_count", "i"),
    "วันตัดรอบบิล": ("billing_cut_days", "s"),
    "COD จริง": ("cod_actual", "d"),
    "อุปกรณ์ที่ยังไม่มี SN": ("missing_sn_count", "i"),
}
COD_COLS = {
    "สาขา กปภ.": ("pwa_branch", "s"),
    "เขต กปภ.": ("pwa_zone", "s"),
    "เขต กฟภ.": ("pea_zone", "s"),
    "Inverter รวม (kW)": ("inverter_ac_kw", "f"),
    "กันย้อน": ("export_limit", "s"),
    "บัญชีผู้ใช้ไฟ": ("pea_account_no", "s"),
    "สถานะขนานไฟ (กฟภ.)": ("pea_connection_status", "s"),
    "วิศวกรดูแล": ("engineers_text", "s"),
    "ช่าง O&M": ("technicians_text", "s"),
    "ผรม. (เคลม DLP)": ("dlp_contractor", "s"),
    "เริ่มสัญญา PEA (งวด 1)": ("pea_contract_start", "d"),
    "COD Baseline": ("cod_baseline", "d"),
    "COD จริง": ("cod_actual", "d"),
}
DEVICE_COLS = {
    "ลำดับ": ("seq", "i"),
    "ยี่ห้อ / รุ่น": ("brand_model", "s"),
    "Serial Number": ("serial", "s"),
    "Firmware": ("firmware", "s"),
    "Address": ("address", "s"),
    "IP": ("ip", "s"),
    "IP (Teltonika)": ("ip", "s"),
    "Network": ("network", "s"),
    "SIM (AIS)": ("sim", "s"),
    "CT ตั้งค่า": ("ct_setting", "s"),
    "CT หน้างาน": ("ct_site", "s"),
    "วันตัดรอบบิล": ("billing_cut_days", "s"),
    "วันเริ่มขายไฟ": ("sales_start", "d"),
    "Clear data COD": ("cod_clear_note", "s"),
    "สถานะเชื่อมต่อ": ("link_status", "s"),
    "สถานะ": ("status", "s"),
    "วันเริ่มประกัน (COD)": ("warranty_start", "d"),
    "วันหมดประกัน": ("warranty_end", "d"),
    "หมายเหตุ": ("note", "s"),
}
SITE_FIELDS = (
    "name", "project_phase", "province", "kwp", "inverter_ac_kw", "export_limit", "pea_meter_no", "pea_account_no",
    "pea_connection_status", "pwa_branch", "pwa_zone", "pea_zone", "billing_cut_days", "revenue_meter_count",
    "pea_contract_start", "cod_baseline", "cod_actual", "dlp_contractor", "engineers_text", "technicians_text",
    "missing_sn_count",
)
DATE_FIELDS = {"pea_contract_start", "cod_baseline", "cod_actual", "sales_start", "warranty_start", "warranty_end"}
DEVICE_FIELDS = tuple(sorted({f for f, _ in DEVICE_COLS.values()} - {"seq"}))
# string lengths of the columns (a longer value is refused, not cut)
_MAX_LEN = {
    "name": 200, "province": 64, "export_limit": 8, "pea_meter_no": 32, "pea_account_no": 32,
    "pea_connection_status": 64, "pwa_branch": 120, "pwa_zone": 32, "pea_zone": 32, "billing_cut_days": 16,
    "dlp_contractor": 8, "engineers_text": 200, "technicians_text": 200, "brand_model": 120, "serial": 64,
    "firmware": 32, "ip": 45, "network": 43, "sim": 16, "address": 8, "ct_setting": 16, "ct_site": 16,
    "cod_clear_note": 200, "link_status": 64, "status": 32,
}
KWP_TOLERANCE = 0.01


class RegisterError(ValueError):
    """The file can't be read as a site register (422)."""


# --------------------------------------------------------------------------- workbook → JSON


def _text(v: Any) -> Optional[str]:
    if v is None:
        return None
    if isinstance(v, float) and v.is_integer():
        v = int(v)
    s = str(v).strip()
    return s or None


def _num(v: Any) -> Optional[float]:
    if v is None or (isinstance(v, str) and not v.strip()):
        return None
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def _date(v: Any) -> Optional[str]:
    if isinstance(v, datetime):
        return v.date().isoformat()
    if isinstance(v, date):
        return v.isoformat()
    s = _text(v)
    if s is None:
        return None
    for fmt in ("%Y-%m-%d", "%d/%m/%Y"):
        try:
            return datetime.strptime(s, fmt).date().isoformat()
        except ValueError:
            pass
    return None


def _cell(v: Any, typ: str, where: str, warnings: List[str]) -> Any:
    if typ == "s":
        return _text(v)
    if typ == "d":
        out = _date(v)
        if out is None and _text(v) is not None:
            warnings.append(f"{where}: not a date ({_text(v)!r}), left empty")
        return out
    n = _num(v)
    if n is None and _text(v) is not None:
        warnings.append(f"{where}: not a number ({_text(v)!r}), left empty")
    if n is not None and typ == "i":
        return int(n) if float(n).is_integer() else None
    return n


def _rows(ws: Any, sheet: str) -> Tuple[Dict[str, int], List[Tuple[int, tuple]]]:
    """Header map and the station rows (first cell a site code) of one sheet."""
    header: Optional[Dict[str, int]] = None
    rows: List[Tuple[int, tuple]] = []
    for n, row in enumerate(ws.iter_rows(values_only=True), start=1):
        if header is None:
            if n > 10:
                break
            if row and any(_text(c) == "รหัส" for c in row):
                header = {}
                for i, c in enumerate(row):
                    t = _text(c)
                    if t and t not in header:
                        header[t] = i
            continue
        code = _text(row[header["รหัส"]]) if row and header["รหัส"] < len(row) else None
        if code and CODE_RE.match(code):
            rows.append((n, row))
    if header is None:
        raise RegisterError(f"sheet {sheet!r}: no header row with 'รหัส'")
    return header, rows


def _pick(row: tuple, header: Dict[str, int], cols: Dict[str, Tuple[str, str]], where: str, warnings: List[str]) -> Dict[str, Any]:
    out: Dict[str, Any] = {}
    for col, (field, typ) in cols.items():
        i = header.get(col)
        if i is None or i >= len(row):
            continue
        v = _cell(row[i], typ, f"{where} {col}", warnings)
        if v is not None or field not in out:
            out[field] = v
    return out


def convert_workbook(src: Union[str, pathlib.Path, bytes], source_name: Optional[str] = None) -> Dict[str, Any]:
    """The workbook as a JSON-ready dict: {format, source, converted_at, sites: [{site_code, …, devices: […]}], warnings}."""
    import openpyxl

    data = src if isinstance(src, bytes) else pathlib.Path(src).read_bytes()
    try:
        wb = openpyxl.load_workbook(io.BytesIO(data), read_only=True, data_only=True)
    except Exception as exc:  # openpyxl raises several types for a non-xlsx file
        raise RegisterError(f"not an .xlsx workbook: {exc}") from exc
    warnings: List[str] = []
    missing = [s for s in (STATION_SHEET, COD_SHEET, *DEVICE_SHEETS) if s not in wb.sheetnames]
    if STATION_SHEET in missing:
        raise RegisterError(f"sheet {STATION_SHEET!r} is missing")
    warnings += [f"sheet {s!r} is missing" for s in missing]

    header, rows = _rows(wb[STATION_SHEET], STATION_SHEET)
    for col in ("รหัส", "สถานี"):
        if col not in header:
            raise RegisterError(f"sheet {STATION_SHEET!r}: column {col!r} is missing")
    sites: Dict[str, Dict[str, Any]] = {}
    for n, row in rows:
        code = _text(row[header["รหัส"]])
        assert code
        if code in sites:
            raise RegisterError(f"{STATION_SHEET} row {n}: station {code} is listed twice")
        site = {"site_code": code, **{f: None for f in SITE_FIELDS}, "logger_sn": None}
        site.update(_pick(row, header, STATION_COLS, f"{STATION_SHEET} row {n}", warnings))
        site["devices"] = []
        sites[code] = site

    if COD_SHEET in wb.sheetnames:
        h, cod_rows = _rows(wb[COD_SHEET], COD_SHEET)
        for n, row in cod_rows:
            code = _text(row[h["รหัส"]])
            site = sites.get(code or "")
            if site is None:
                warnings.append(f"{COD_SHEET} row {n}: station {code} is not in {STATION_SHEET}, skipped")
                continue
            for field, v in _pick(row, h, COD_COLS, f"{COD_SHEET} row {n}", warnings).items():
                if v is not None and site.get(field) is None:
                    site[field] = v
                elif v is not None and site.get(field) != v:
                    warnings.append(f"{code}: {field} differs between sheets ({site[field]} / {v}); {STATION_SHEET} kept")

    for sheet, kind in DEVICE_SHEETS.items():
        if sheet not in wb.sheetnames:
            continue
        h, dev_rows = _rows(wb[sheet], sheet)
        seen: Set[Tuple[str, int]] = set()
        for n, row in dev_rows:
            code = _text(row[h["รหัส"]])
            site = sites.get(code or "")
            if site is None:
                warnings.append(f"{sheet} row {n}: station {code} is not in {STATION_SHEET}, skipped")
                continue
            dev = {"kind": kind, **{f: None for f in DEVICE_FIELDS}, **_pick(row, h, DEVICE_COLS, f"{sheet} row {n}", warnings)}
            dev["seq"] = dev.get("seq") or 1
            if (site["site_code"], dev["seq"]) in seen:
                raise RegisterError(f"{sheet} row {n}: {code} has device {dev['seq']} twice")
            seen.add((site["site_code"], dev["seq"]))
            site["devices"].append(dev)
    for site in sites.values():
        logger = next((d for d in site["devices"] if d["kind"] == "datalogger"), None)
        if logger and logger.get("serial"):
            if site["logger_sn"] and site["logger_sn"] != logger["serial"]:
                warnings.append(f"{site['site_code']}: logger SN differs between sheets; the Data logger sheet's kept")
            site["logger_sn"] = logger["serial"]
        elif logger is None and site["logger_sn"]:
            # the station sheet's serial is the only record of this logger: keep it as its device row
            site["devices"].insert(0, {"kind": "datalogger", **{f: None for f in DEVICE_FIELDS}, "serial": site["logger_sn"], "seq": 1})
    return {
        "format": FORMAT,
        "source": source_name or (None if isinstance(src, bytes) else pathlib.Path(src).name),
        "converted_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "sites": sorted(sites.values(), key=lambda s: s["site_code"]),
        "warnings": warnings,
    }


# --------------------------------------------------------------------------- JSON → rows


def _check_doc(doc: Any) -> List[Dict[str, Any]]:
    """The `sites` of a converted document, validated (RegisterError lists the first problems)."""
    if not isinstance(doc, dict) or doc.get("format") != FORMAT or not isinstance(doc.get("sites"), list):
        raise RegisterError(f"not a site register document (format {FORMAT!r} with a 'sites' list)")
    problems: List[str] = []
    codes: Set[str] = set()
    for i, s in enumerate(doc["sites"]):
        code = s.get("site_code") if isinstance(s, dict) else None
        if not isinstance(code, str) or not CODE_RE.match(code):
            problems.append(f"sites[{i}]: bad site_code {code!r}")
            continue
        if code in codes:
            problems.append(f"{code}: listed twice")
        codes.add(code)
        if not _text(s.get("name")):
            problems.append(f"{code}: name is empty")
        devs = s.get("devices") or []
        if not isinstance(devs, list):
            problems.append(f"{code}: devices must be a list")
            continue
        keys = Counter((d.get("kind"), d.get("seq") or 1) for d in devs if isinstance(d, dict))
        for d in devs:
            if not isinstance(d, dict) or d.get("kind") not in KINDS:
                problems.append(f"{code}: device of unknown kind {d.get('kind') if isinstance(d, dict) else d!r}")
        problems += [f"{code}: {k} {n} listed twice" for (k, n), c in keys.items() if c > 1]
        for obj in (s, *[d for d in devs if isinstance(d, dict)]):
            for f, n in _MAX_LEN.items():
                v = obj.get(f)
                if v is not None and len(str(v)) > n:
                    problems.append(f"{code}: {f} longer than {n} characters")
            for f in DATE_FIELDS:
                v = obj.get(f)
                if v is not None and _date(v) is None:
                    problems.append(f"{code}: {f} is not a date ({v!r})")
    if problems:
        raise RegisterError("; ".join(problems[:20]) + (f" … ({len(problems)} problems)" if len(problems) > 20 else ""))
    return doc["sites"]


def _logger_plants(db: Session) -> Dict[str, Set[int]]:
    """Every datalogger serial Growatt reports (inverters, weather sensors, meters) → its plants."""
    out: Dict[str, Set[int]] = defaultdict(set)
    for model in (GrowattInverter, GrowattEnvSensor, GrowattMeter):
        for sn, pid in db.execute(select(model.datalogger_sn, model.plant_id).where(model.datalogger_sn.is_not(None)).distinct()):
            if sn and pid is not None:
                out[str(sn).strip().upper()].add(int(pid))
    return out


def _name_code_re(code: str) -> re.Pattern:
    m = CODE_RE.match(code)
    assert m
    return re.compile(rf"(?<![A-Z0-9])P{m.group(1)}[A-Z]?[_-]0*{int(m.group(2))}(?!\d)", re.I)


def match_sites(db: Session, sites: List[Dict[str, Any]]) -> Dict[str, Dict[str, Any]]:
    """{site_code: {plant_id, rule, growatt_logger_sn}} (docs/plans/om-asset-network.md §4, rules in order).

    1. `logger_sn`: the station's logger serial is a datalogger of exactly one plant;
    2. `logger_sn_prefix`: a datalogger serial that starts with it (a character missing), one plant only among
       the plants no station has claimed yet;
    3. `name_code`: the station code in the Growatt name (`P1_26`, `P2A_39`), one plant only;
    4. `kept`: the plant an earlier import matched.
    A plant goes to one station only: the first rule that names it wins, a later station is left unmatched.
    """
    loggers = _logger_plants(db)
    plants = {pid: name or "" for pid, name in db.execute(select(GrowattPlant.plant_id, GrowattPlant.name))}
    previous = {c: pid for c, pid in db.execute(select(SiteRegister.site_code, SiteRegister.plant_id)) if pid is not None}
    out: Dict[str, Dict[str, Any]] = {s["site_code"]: {"plant_id": None, "rule": None, "growatt_logger_sn": None} for s in sites}
    taken: Dict[int, str] = {}

    def take(code: str, pid: int, rule: str, sn: Optional[str] = None) -> None:
        if pid in taken or pid not in plants:
            return
        taken[pid] = code
        out[code] = {"plant_id": pid, "rule": rule, "growatt_logger_sn": sn}

    by_pid: Dict[int, List[str]] = defaultdict(list)
    for sn, pids in loggers.items():
        for pid in pids:
            by_pid[pid].append(sn)
    for rule in ("logger_sn", "logger_sn_prefix", "name_code", "kept"):
        for s in sites:
            code = s["site_code"]
            if out[code]["plant_id"] is not None:
                continue
            sn = (_text(s.get("logger_sn")) or "").upper()
            if rule == "logger_sn" and sn and len(loggers.get(sn, ())) == 1:
                take(code, next(iter(loggers[sn])), rule, sn)
            elif rule == "logger_sn_prefix" and len(sn) >= 6:
                hits = {k: v for k, v in loggers.items() if k != sn and k.startswith(sn) and len(k) - len(sn) <= 2}
                # only plants no station has claimed yet: a truncated serial is a prefix of several loggers
                pids = (set().union(*hits.values()) if hits else set()) - set(taken)
                if len(pids) == 1:
                    pid = next(iter(pids))
                    take(code, pid, rule, sorted(k for k, v in hits.items() if pid in v)[0])
            elif rule == "name_code":
                pat = _name_code_re(code)
                pids = {pid for pid, name in plants.items() if pat.search(name)}
                if len(pids) == 1:
                    pid = next(iter(pids))
                    take(code, pid, rule, ",".join(sorted(by_pid.get(pid, []))) or None)
            elif rule == "kept" and code in previous:
                take(code, previous[code], rule)
    return out


def _ct_primary(ct: Optional[str]) -> Optional[float]:
    m = re.match(r"\s*(\d+(?:\.\d+)?)", ct or "")
    return float(m.group(1)) if m else None


def _checks(site: Dict[str, Any], devices: List[Dict[str, Any]], growatt: Optional[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """What needs a look (no verdict is made without both values)."""
    out: List[Dict[str, Any]] = []
    if growatt is None:
        out.append({"key": "unmatched", "text": "Not matched to a Growatt plant"})
    else:
        kwp, gk = site.get("kwp"), growatt.get("kwp")
        if kwp and gk and abs(gk - kwp) / kwp > KWP_TOLERANCE:
            out.append({"key": "kwp_differs", "text": f"kWp {kwp:g} here, {gk:g} in Growatt"})
        sn = (_text(site.get("logger_sn")) or "").upper()
        if sn and growatt.get("logger_sns") and sn not in growatt["logger_sns"]:
            out.append({"key": "logger_sn_differs", "text": f"Logger SN {sn} here, {', '.join(growatt['logger_sns'])} in Growatt"})
    meters = [d for d in devices if d["kind"] == "revenue_meter"]
    n = site.get("revenue_meter_count")
    if n is not None and meters and n != len(meters):
        out.append({"key": "meter_count_differs", "text": f"{n} revenue meters in the station sheet, {len(meters)} listed"})
    for d in meters:
        a, b = _text(d.get("ct_setting")), _text(d.get("ct_site"))
        # the primary current only: "250/5", "250" and "250/5A" are the same CT written differently
        pa, pb = _ct_primary(a), _ct_primary(b)
        if pa is not None and pb is not None and pa != pb:
            out.append({"key": "ct_differs", "text": f"Meter {d.get('seq')}: CT set {a}, on site {b}"})
    return out


def _growatt_info(db: Session, plant_ids: Iterable[int]) -> Dict[int, Dict[str, Any]]:
    ids = sorted(set(plant_ids))
    if not ids:
        return {}
    out = {
        pid: {"plant_id": pid, "name": name, "kwp": kwp, "phase": phase, "logger_sns": []}
        for pid, name, kwp, phase in db.execute(
            select(GrowattPlant.plant_id, GrowattPlant.name, GrowattPlant.peak_power_kwp, GrowattPlant.phase).where(
                GrowattPlant.plant_id.in_(ids)
            )
        )
    }
    for sn, pids in _logger_plants(db).items():
        for pid in pids:
            if pid in out:
                out[pid]["logger_sns"].append(sn)
    for g in out.values():
        g["logger_sns"].sort()
    return out


def _sync_devices(db: Session, by_code: Dict[str, List[Dict[str, Any]]]) -> None:
    """Make each station's devices exactly `by_code[site_code]`, matched on (kind, seq): a device that
    stays keeps its id and is updated in place, a new one is added, one no longer listed is deleted."""
    codes = list(by_code)
    if not codes:
        return
    existing = {(d.site_code, d.kind, d.seq): d for d in db.scalars(select(SiteDevice).where(SiteDevice.site_code.in_(codes)))}
    keep = set()
    for code, rows in by_code.items():
        for r in rows:
            key = (code, r["kind"], int(r.get("seq") or 1))
            dev = existing.get(key)
            if dev is None:
                dev = SiteDevice(site_code=code, kind=key[1], seq=key[2])
                db.add(dev)
            for f in DEVICE_FIELDS:
                v = r.get(f)
                setattr(dev, f, date.fromisoformat(_date(v)) if f in DATE_FIELDS and v is not None else v)  # type: ignore[arg-type]
            keep.add(key)
    for key, dev in existing.items():
        if key not in keep:
            db.delete(dev)


def import_register(db: Session, doc: Any, apply: bool = False, who: Optional[str] = None) -> Dict[str, Any]:
    """Preview (default) or apply a converted register. Apply replaces both tables in one transaction.

    Also fills `pwa_meter_sites.meter_no` from revenue meter 1 where the PWA report site of the same code has none.
    """
    sites = _check_doc(doc)
    matches = match_sites(db, sites)
    growatt = _growatt_info(db, [m["plant_id"] for m in matches.values() if m["plant_id"] is not None])
    existing = set(db.scalars(select(SiteRegister.site_code)))
    rows: List[Dict[str, Any]] = []
    for s in sites:
        m = matches[s["site_code"]]
        devs = [d for d in s.get("devices") or []]
        checks = _checks(s, devs, growatt.get(m["plant_id"]) if m["plant_id"] is not None else None)
        rows.append(
            {
                "site_code": s["site_code"],
                "name": s.get("name"),
                "plant_id": m["plant_id"],
                "plant_name": growatt.get(m["plant_id"], {}).get("name") if m["plant_id"] is not None else None,
                "rule": m["rule"],
                "logger_sn": s.get("logger_sn"),
                "growatt_logger_sn": m["growatt_logger_sn"],
                "devices": len(devs),
                "checks": checks,
            }
        )
    codes = {s["site_code"] for s in sites}
    by_rule = Counter(r["rule"] or "unmatched" for r in rows)
    report: Dict[str, Any] = {
        "applied": False,
        "sites": len(sites),
        "devices": sum(r["devices"] for r in rows),
        "matched": sum(1 for r in rows if r["plant_id"] is not None),
        "by_rule": dict(by_rule),
        "new": len(codes - existing),
        "removed": sorted(existing - codes),
        "needs_review": [r for r in rows if r["checks"] or r["rule"] not in ("logger_sn", "kept")],
        "rows": rows,
        "warnings": list(doc.get("warnings") or []),
        "meter_no_filled": 0,
    }
    if not apply:
        return report

    now = datetime.now(timezone.utc)
    # Stations and devices are updated in place, not deleted and re-added: a device that stays keeps its
    # id, which printed `dev:<id>` labels and failed units (`stock_failed_units.site_device_id`) point at.
    current = {r.site_code: r for r in db.scalars(select(SiteRegister))}
    new_codes = {s["site_code"] for s in sites}
    gone = [c for c in current if c not in new_codes]
    if gone:
        db.execute(delete(SiteDevice).where(SiteDevice.site_code.in_(gone)))
        db.execute(delete(SiteRegister).where(SiteRegister.site_code.in_(gone)))
        current = {c: r for c, r in current.items() if c not in gone}
    # plant_id is unique: clear it first so a plant moving between stations is not briefly on two
    for reg in current.values():
        reg.plant_id = None
    db.flush()
    for s in sites:
        m = matches[s["site_code"]]
        reg = current.get(s["site_code"])
        if reg is None:
            reg = SiteRegister(site_code=s["site_code"])
            db.add(reg)
        reg.plant_id, reg.match_rule, reg.imported_by, reg.imported_at = m["plant_id"], m["rule"], who, now
        for f in SITE_FIELDS:
            v = s.get(f)
            setattr(reg, f, date.fromisoformat(_date(v)) if f in DATE_FIELDS and v is not None else v)  # type: ignore[arg-type]
        reg.name = _text(s.get("name")) or s["site_code"]
    db.flush()  # stations before their devices (no ORM relationship orders the inserts)
    _sync_devices(db, {s["site_code"]: list(s.get("devices") or []) for s in sites})
    meter1 = {
        s["site_code"]: _text(d.get("serial"))
        for s in sites
        for d in s.get("devices") or []
        if d["kind"] == "revenue_meter" and int(d.get("seq") or 1) == 1 and _text(d.get("serial"))
    }
    filled = 0
    for pwa in db.scalars(select(PwaMeterSite).where(PwaMeterSite.site_id.in_(list(meter1)), PwaMeterSite.meter_no.is_(None))):
        sn = meter1[pwa.site_id]
        if sn and len(sn) <= 16:
            pwa.meter_no = sn
            filled += 1
    db.commit()
    report.update(applied=True, meter_no_filled=filled)
    log.info(
        "site register imported by %s: %d stations, %d devices, %d matched, %d removed",
        who, report["sites"], report["devices"], report["matched"], len(report["removed"]),
    )
    return report


# --------------------------------------------------------------------------- reads


def _row_out(r: Any, fields: Iterable[str]) -> Dict[str, Any]:
    out: Dict[str, Any] = {}
    for f in fields:
        v = getattr(r, f)
        out[f] = v.isoformat() if isinstance(v, (date, datetime)) else v
    return out


def for_plant(db: Session, plant_id: int) -> Optional[Dict[str, Any]]:
    """The plant's station with its devices (grouped by kind, in order) and checks; None when it has none."""
    reg = db.scalar(select(SiteRegister).where(SiteRegister.plant_id == plant_id))
    if reg is None:
        return None
    devs = list(db.scalars(select(SiteDevice).where(SiteDevice.site_code == reg.site_code).order_by(SiteDevice.kind, SiteDevice.seq)))
    site = _row_out(reg, ("site_code", "plant_id", "match_rule", *SITE_FIELDS, "imported_by", "imported_at"))
    devices = [{"id": d.id, "kind": d.kind, "seq": d.seq, **_row_out(d, DEVICE_FIELDS)} for d in devs]
    devices.sort(key=lambda d: (KINDS.index(d["kind"]) if d["kind"] in KINDS else 99, d["seq"]))
    logger = next((d for d in devices if d["kind"] == "datalogger"), None)
    g = _growatt_info(db, [plant_id]).get(plant_id)
    site["logger_sn"] = logger["serial"] if logger else None
    return {
        "site": site,
        "devices": devices,
        "growatt": g,
        "checks": _checks(site, devices, g),
    }


MAX_DEVICES_PER_SITE = 40


def replace_devices(db: Session, plant_id: int, devices: Any) -> Optional[Dict[str, Any]]:
    """Replace the devices of the plant's station with `devices` (the whole list, as edited in the app; all or
    nothing). Same rules as the import: known kind, (kind, seq) once, values as written (trimmed, empty = null),
    column lengths, ISO / d/m/Y dates. None when the plant has no station. A later workbook import replaces it
    again (export first to keep the edits)."""
    reg = db.scalar(select(SiteRegister).where(SiteRegister.plant_id == plant_id))
    if reg is None:
        return None
    if not isinstance(devices, list):
        raise RegisterError("devices must be a list")
    if len(devices) > MAX_DEVICES_PER_SITE:
        raise RegisterError(f"at most {MAX_DEVICES_PER_SITE} devices per station")
    problems: List[str] = []
    rows: List[Dict[str, Any]] = []
    for i, d in enumerate(devices):
        if not isinstance(d, dict) or d.get("kind") not in KINDS:
            problems.append(f"device {i + 1}: unknown kind {d.get('kind') if isinstance(d, dict) else d!r}")
            continue
        seq = d.get("seq", 1)
        if isinstance(seq, bool) or not isinstance(seq, int) or not 1 <= seq <= 99:
            problems.append(f"device {i + 1}: number must be 1–99")
            continue
        unknown = set(d) - {"kind", "seq", "id", *DEVICE_FIELDS}
        if unknown:
            problems.append(f"device {i + 1}: unknown fields {', '.join(sorted(unknown))}")
        row: Dict[str, Any] = {"kind": d["kind"], "seq": seq}
        for f in DEVICE_FIELDS:
            v = _text(d.get(f))
            if v is not None and f in DATE_FIELDS:
                iso = _date(v)
                if iso is None:
                    problems.append(f"{d['kind']} {seq}: {f} is not a date ({v!r})")
                v = iso
            elif v is not None and f in _MAX_LEN and len(v) > _MAX_LEN[f]:
                problems.append(f"{d['kind']} {seq}: {f} longer than {_MAX_LEN[f]} characters")
            row[f] = v
        rows.append(row)
    keys = Counter((r["kind"], r["seq"]) for r in rows)
    problems += [f"{k} {n} listed twice" for (k, n), c in keys.items() if c > 1]
    if problems:
        raise RegisterError("; ".join(problems[:20]) + (f" … ({len(problems)} problems)" if len(problems) > 20 else ""))

    _sync_devices(db, {reg.site_code: rows})
    db.commit()
    return for_plant(db, plant_id)


def list_all(db: Session, allowed: Optional[Set[int]]) -> List[Dict[str, Any]]:
    """One row per station (engineers: only their plants' stations), with device counts, the Growatt plant's
    name and the same `checks` as the plant view."""
    q = select(SiteRegister).order_by(SiteRegister.site_code)
    if allowed is not None:
        q = q.where(SiteRegister.plant_id.in_(allowed or {-1}))
    regs = list(db.scalars(q))
    codes = [r.site_code for r in regs]
    devs: Dict[str, List[Dict[str, Any]]] = defaultdict(list)
    if codes:
        for d in db.scalars(select(SiteDevice).where(SiteDevice.site_code.in_(codes)).order_by(SiteDevice.site_code, SiteDevice.kind, SiteDevice.seq)):
            devs[d.site_code].append({"kind": d.kind, "seq": d.seq, **_row_out(d, DEVICE_FIELDS)})
    growatt = _growatt_info(db, [r.plant_id for r in regs if r.plant_id is not None])
    out = []
    for r in regs:
        site = _row_out(r, ("site_code", "plant_id", "match_rule", "name", "project_phase", "province", "kwp", "cod_actual", "revenue_meter_count"))
        mine = devs.get(r.site_code, [])
        logger = next((d for d in mine if d["kind"] == "datalogger"), None)
        site["logger_sn"] = logger["serial"] if logger else None
        g = growatt.get(r.plant_id) if r.plant_id is not None else None
        out.append(
            {
                **site,
                "plant_name": g["name"] if g else None,
                "devices": dict(Counter(d["kind"] for d in mine)),
                "checks": _checks(site, mine, g),
            }
        )
    return out


def provinces(db: Session, allowed: Optional[Set[int]]) -> Dict[int, str]:
    """{plant_id: province} of the matched stations the user may see (the plant directory's filter)."""
    q = select(SiteRegister.plant_id, SiteRegister.province).where(SiteRegister.plant_id.is_not(None), SiteRegister.province.is_not(None))
    if allowed is not None:
        q = q.where(SiteRegister.plant_id.in_(allowed or {-1}))
    return {int(pid): prov for pid, prov in db.execute(q) if pid is not None and prov is not None}  # filtered in SQL; narrows the types


# headers of each device sheet, in the workbook's order (after รหัส, สถานี)
DEVICE_SHEET_COLS: Dict[str, List[str]] = {
    "datalogger": ["ยี่ห้อ / รุ่น", "Serial Number", "Firmware", "สถานะ", "วันเริ่มประกัน (COD)", "วันหมดประกัน", "หมายเหตุ"],
    "weather_station": ["ยี่ห้อ / รุ่น", "Serial Number", "Address", "สถานะ", "วันเริ่มประกัน (COD)", "วันหมดประกัน", "หมายเหตุ"],
    "revenue_meter": [
        "ลำดับ", "ยี่ห้อ / รุ่น", "Serial Number", "IP", "CT ตั้งค่า", "CT หน้างาน", "วันตัดรอบบิล", "วันเริ่มขายไฟ",
        "Clear data COD", "สถานะเชื่อมต่อ", "สถานะ", "วันเริ่มประกัน (COD)", "วันหมดประกัน", "หมายเหตุ",
    ],
    "router": ["ยี่ห้อ / รุ่น", "Serial Number", "IP (Teltonika)", "Network", "SIM (AIS)", "สถานะ", "หมายเหตุ"],
    "pqm": ["ยี่ห้อ / รุ่น", "Serial Number", "IP", "สถานะ", "หมายเหตุ"],
    "shinemaster": ["ยี่ห้อ / รุ่น", "Serial Number", "IP", "สถานะ", "หมายเหตุ"],
}


def export_workbook(db: Session, allowed: Optional[Set[int]]) -> bytes:
    """The register as an .xlsx in the workbook's layout (same sheet names and headers), so the O&M team can
    edit it and it imports again. Text stays text (leading zeros of SIMs and meter numbers kept), dates are
    dates, empty = empty cell. Engineers get their plants' stations only. Match info is not written (the
    import matches again)."""
    import openpyxl
    from openpyxl.styles import Font
    from openpyxl.utils import get_column_letter

    q = select(SiteRegister).order_by(SiteRegister.site_code)
    if allowed is not None:
        q = q.where(SiteRegister.plant_id.in_(allowed or {-1}))
    regs = list(db.scalars(q))
    codes = [r.site_code for r in regs]
    devs: Dict[Tuple[str, str], List[SiteDevice]] = defaultdict(list)
    if codes:
        for d in db.scalars(select(SiteDevice).where(SiteDevice.site_code.in_(codes)).order_by(SiteDevice.site_code, SiteDevice.seq)):
            devs[(d.site_code, d.kind)].append(d)
    station_field = {col: f for col, (f, _) in STATION_COLS.items()}
    cod_field = {col: f for col, (f, _) in COD_COLS.items()}
    dev_field = {col: f for col, (f, _) in DEVICE_COLS.items()}

    wb = openpyxl.Workbook()
    bold = Font(bold=True)

    def sheet(title: str, headers: List[str], rows: Iterable[List[Any]], first: bool = False) -> None:
        ws = wb.active if first else wb.create_sheet(title)
        assert ws is not None
        ws.title = title
        ws.append(headers)
        for c in ws[1]:
            c.font = bold
        for row in rows:
            ws.append(row)
        ws.freeze_panes = "C2"
        for i, h in enumerate(headers, start=1):
            ws.column_dimensions[get_column_letter(i)].width = 40 if h == "สถานี" else max(12, min(28, len(h) + 4))
        for row in ws.iter_rows(min_row=2):
            for c in row:
                if isinstance(c.value, str):
                    c.number_format = "@"  # keep "0653480924" as text in Excel

    def logger_sn(code: str) -> Optional[str]:
        d = devs.get((code, "datalogger"))
        return d[0].serial if d else None

    st_headers = ["รหัส", *STATION_COLS]
    sheet(
        STATION_SHEET,
        st_headers,
        ([r.site_code, *[logger_sn(r.site_code) if h == "SN Data logger" else getattr(r, station_field[h]) for h in STATION_COLS]] for r in regs),
        first=True,
    )
    cod_headers = ["รหัส", "สถานี", *[h for h in COD_COLS]]
    sheet(COD_SHEET, cod_headers, ([r.site_code, r.name, *[getattr(r, cod_field[h]) for h in COD_COLS]] for r in regs))
    names = {r.site_code: r.name for r in regs}
    for title, kind in DEVICE_SHEETS.items():
        cols = DEVICE_SHEET_COLS[kind]
        rows = [
            [code, names[code], *[getattr(d, dev_field[h]) for h in cols]]
            for code in codes
            for d in devs.get((code, kind), [])
        ]
        sheet(title, ["รหัส", "สถานี", *cols], rows)
    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()


def delete_plant_rows(db: Session, plant_ids: Iterable[int]) -> None:
    """The blocked-plant cleanup (no commit): the plants' stations and their devices."""
    ids = list(plant_ids)
    if not ids:
        return
    codes = list(db.scalars(select(SiteRegister.site_code).where(SiteRegister.plant_id.in_(ids))))
    if codes:
        db.execute(delete(SiteDevice).where(SiteDevice.site_code.in_(codes)))
        db.execute(delete(SiteRegister).where(SiteRegister.site_code.in_(codes)))


# --------------------------------------------------------------------------- CLI


def _summary(rep: Dict[str, Any]) -> str:
    lines = [
        f"{'APPLIED' if rep['applied'] else 'preview'}: {rep['sites']} stations, {rep['devices']} devices, "
        f"{rep['matched']} matched {rep['by_rule']}, {rep['new']} new, {len(rep['removed'])} removed"
        + (f", PWA meter_no filled {rep['meter_no_filled']}" if rep["applied"] else ""),
    ]
    for r in rep["needs_review"]:
        why = "; ".join(c["text"] for c in r["checks"]) or ""
        lines.append(
            f"  {r['site_code']} → {r['plant_id'] or '—'} [{r['rule'] or 'unmatched'}]"
            + (f" Growatt SN {r['growatt_logger_sn']}" if r["rule"] in ("logger_sn_prefix", "name_code") else "")
            + (f" · {why}" if why else "")
        )
    lines += [f"  warning: {w}" for w in rep["warnings"][:30]]
    return "\n".join(lines)


def main(argv: Optional[List[str]] = None) -> int:
    from app.db.session import SessionLocal, engine, ensure_schema
    from app.logging_db import setup_logging

    ap = argparse.ArgumentParser(prog="python -m app.services.site_register", description=(__doc__ or "").split("\n\n")[0])
    sub = ap.add_subparsers(dest="cmd", required=True)
    c = sub.add_parser("convert", help="workbook → JSON")
    c.add_argument("xlsx")
    c.add_argument("-o", "--out", required=True)
    i = sub.add_parser("import", help="JSON (or the workbook) → SQL; a preview unless --apply")
    i.add_argument("path")
    i.add_argument("--apply", action="store_true")
    args = ap.parse_args(argv)

    if args.cmd == "convert":
        doc = convert_workbook(args.xlsx)
        pathlib.Path(args.out).write_text(json.dumps(doc, ensure_ascii=False, indent=1), encoding="utf-8")
        print(f"{len(doc['sites'])} stations, {sum(len(s['devices']) for s in doc['sites'])} devices → {args.out}")
        for w in doc["warnings"][:30]:
            print("  warning:", w)
        return 0

    setup_logging("cli")
    ensure_schema(engine)
    p = pathlib.Path(args.path)
    doc = convert_workbook(p) if p.suffix.lower() == ".xlsx" else json.loads(p.read_text(encoding="utf-8"))
    with SessionLocal() as db:
        print(_summary(import_register(db, doc, apply=args.apply, who="cli")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
