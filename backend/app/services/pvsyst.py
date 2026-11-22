"""PVsyst design data of the PWA rooftop stations (phases 1-4), from the TFRS 16 model workbook.

Sheets read (columns found by their header text, never by position):
- `PVsyst_สรุป` section ก: per phase the stations, kWp, MWh/yr, specific yield, weighted PR, the
  first-year contract specific yield and contract ÷ PVsyst, as the sheet states them.
- `PVsyst_ระยะ1` .. `PVsyst_ระยะ4` section ก: one row per station's PVsyst simulation report: E_Grid
  per calendar month (MWh, P50, unlimited load), kWp, kWac, PR, Tilt/Azimuth text, location; section
  ค: the station's first-year contract kWh (phase 1 from the contract sheet, phases 2-4 the model's
  estimate).
- `ประมาณการ_kWh_ระยะ2` (optional): `ลำดับ PVsyst` → `รหัสในรายงานประจำวัน`, the phase 2 daily report
  site id, so a phase 2 station is joined to `pwa_meter_sites` by that id.

Every figure is **modelled** (PVsyst design), never measured; DC/AC ratio and monthly kWh/kWp are
derived from them. A value the sheet does not give stays null.

The import replaces both tables as a whole in one transaction (idempotent, all or nothing):
    PYTHONPATH=backend uv run python -m app.services.pvsyst import --model billing/<model>.xlsx

`vs_meter` (D1) puts each visible PWA report site's metered kWh per calendar month beside its
station's PVsyst E_Grid on the same days (the month's E_Grid ÷ days in the month per day with a
reading, × site kWp ÷ PVsyst kWp, the rule of the criteria file's `expected_energy.pvsyst`). Sites
join on an id, never on a name: phase 2 `site_id` = the station's `report_code`, phase 1 the site's
`pvsyst_seq`; a site with no station is left out and counted.
"""

from __future__ import annotations

import argparse
import calendar
import io
import json
import re
from collections import defaultdict
from datetime import date
from pathlib import Path
from typing import Any, Dict, List, Optional, Set, Tuple, Union

from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from app.db.models import PvsystPhase, PvsystStation, PwaMeterDay, PwaMeterSite

MONTHS_TH = ("ม.ค.", "ก.พ.", "มี.ค.", "เม.ย.", "พ.ค.", "มิ.ย.", "ก.ค.", "ส.ค.", "ก.ย.", "ต.ค.", "พ.ย.", "ธ.ค.")
SUMMARY_SHEET = "PVsyst_สรุป"
PHASE_SHEET = "PVsyst_ระยะ{}"
CODES_SHEET = "ประมาณการ_kWh_ระยะ2"
PHASES = (1, 2, 3, 4)

LABELS = {
    "modelled": "PVsyst design figures (simulation reports, P50, unlimited load), not measured",
    "derived": "dc_ac_ratio = kWp ÷ kWac and kwh_kwp_month = E_Grid ÷ kWp are derived from the design figures",
    "contract": "contract figures are modelled: phase 1 from the contract sheet, phases 2-4 the model's estimate",
    "contract_over_pvsyst": "phase contract_over_pvsyst is the sheet's kWh ÷ kWh; contract_over_pvsyst_per_kwp and the stations' ratio compare kWh/kWp (contract on the model's kWp, PVsyst on the report's)",
    "meter": "meter_kwh is the PWA daily report's meter reading (measured); pvsyst_kwh is modelled",
}

SUMMARY_COLS = {
    "phase": "ระยะ",
    "stations_model": "สถานีในแบบจำลอง",
    "reports": "รายงาน PVsyst",
    "kwp_pvsyst": "kWp PVsyst",
    "kwp_model": "kWp แบบจำลอง",
    "mwh_year": "MWh/ปี PVsyst",
    "specific_yield": "kWh/kWp/ปี PVsyst",
    "pr_weighted": "PR (ถ่วงน้ำหนัก)",
    "contract_specific_yield": "kWh/kWp/ปี สัญญาปีแรก",
    "contract_over_pvsyst": "สัญญา ÷ PVsyst",
    "contract_kwh_y1": "หน่วยไฟสัญญาปีแรก (kWh)",
}
STATION_REQUIRED = {"seq": "ลำดับ", "name": "สถานที่", "tilt_azimuth": "Tilt/Azimuth", "kwp": "kWp", "kwac": "kWac", "pr": "PR",
                    "mwh_year": "รวม MWh/ปี", "specific_yield": "kWh/kWp/ปี"}
STATION_OPTIONAL = {"project": "โปรเจกต์", "branch": "กปภ.สาขา", "lat": "Lat", "lon": "Long", "modules": "แผง (แผ่น)", "mwh_year_report": "ตามรายงาน"}
# the columns right of `รวมรายเดือน − รายงาน`: in the model the data sit one column right of their
# header (a blank column AC), so their offset is found from the Wp/แผ่น values, never assumed
TRAILING = {"wp_per_module": "Wp/แผ่น", "kwp_model": "kWp ในแบบจำลอง", "note": "หมายเหตุการอ่านค่า"}

_PART = re.compile(r"^\s*(\d+(?:\.\d+)?)\s*/\s*(-?\d+(?:\.\d+)?)\s*°")


class PvsystImportError(ValueError):
    """The workbook is not the model this reader knows; the message says what is missing."""


def _num(v: Any) -> Optional[float]:
    return float(v) if isinstance(v, (int, float)) and not isinstance(v, bool) else None


def _txt(v: Any) -> Optional[str]:
    if v is None:
        return None
    s = str(v).strip() if not isinstance(v, float) or not v.is_integer() else str(int(v))
    return s or None


def _norm(v: Any) -> Any:
    return v.strip() if isinstance(v, str) else v


def parse_orientations(text: Optional[str]) -> Optional[List[List[float]]]:
    """'15/-10° Tilt/Azimuth 15/170 °' → [[15, -10], [15, 170]]; None when any part does not read as
    tilt/azimuth (an OCR slip such as '710°' is never guessed) or a value is out of range."""
    if not text:
        return None
    out: List[List[float]] = []
    for part in text.split("Tilt/Azimuth"):
        m = _PART.match(part)
        if not m:
            return None
        tilt, az = float(m.group(1)), float(m.group(2))
        if not (0 <= tilt <= 90 and -180 <= az <= 180):
            return None
        out.append([tilt, az])
    return out or None


def _find_row(rows: List[Tuple[Any, ...]], words: List[str], sheet: str, start: int = 0) -> int:
    for i in range(start, len(rows)):
        cells = {_norm(c) for c in rows[i]}
        if all(w in cells for w in words):
            return i
    raise PvsystImportError(f"sheet {sheet}: no header row with {', '.join(words)}")


def _index(hdr: List[Any], cols: Dict[str, str], sheet: str, required: bool = True) -> Dict[str, int]:
    out: Dict[str, int] = {}
    for key, word in cols.items():
        if word in hdr:
            out[key] = hdr.index(word)
        elif required:
            raise PvsystImportError(f"sheet {sheet}: header lacks {word!r}")
    return out


def _read_summary(rows: List[Tuple[Any, ...]], source: str) -> List[Dict[str, Any]]:
    h = _find_row(rows, ["ระยะ", "PR (ถ่วงน้ำหนัก)"], SUMMARY_SHEET)
    hdr = [_norm(c) for c in rows[h]]
    ix = _index(hdr, SUMMARY_COLS, SUMMARY_SHEET)
    out = []
    for r in rows[h + 1:]:
        label = _norm(r[ix["phase"]]) if ix["phase"] < len(r) else None
        if not isinstance(label, str):
            break
        m = re.fullmatch(r"ระยะ\s*(\d)", label)
        phase = int(m.group(1)) if m else (0 if label == "รวม" else None)
        if phase is None:
            break
        row: Dict[str, Any] = {"phase": phase, "source": source}
        for key, j in ix.items():
            if key != "phase":
                v = _num(r[j]) if j < len(r) else None
                row[key] = int(v) if v is not None and key in ("stations_model", "reports") else v
        out.append(row)
    if not any(p["phase"] in PHASES for p in out):
        raise PvsystImportError(f"sheet {SUMMARY_SHEET}: no 'ระยะ N' rows under the header")
    return out


def _read_phase(rows: List[Tuple[Any, ...]], phase: int, source: str, warnings: List[str]) -> List[Dict[str, Any]]:
    sheet = PHASE_SHEET.format(phase)
    h = _find_row(rows, ["ลำดับ", "Tilt/Azimuth"], sheet)
    hdr = [_norm(c) for c in rows[h]]
    ix = _index(hdr, STATION_REQUIRED, sheet)
    opt = _index(hdr, STATION_OPTIONAL, sheet, required=False)
    if MONTHS_TH[0] not in hdr:
        raise PvsystImportError(f"sheet {sheet}: header lacks {MONTHS_TH[0]!r}")
    jan = hdr.index(MONTHS_TH[0])
    if [hdr[jan + k] if jan + k < len(hdr) else None for k in range(12)] != list(MONTHS_TH):
        raise PvsystImportError(f"sheet {sheet}: the 12 month columns are not ม.ค. … ธ.ค. in order")

    block: List[Tuple[Any, ...]] = []
    total: Optional[Tuple[Any, ...]] = None
    for r in rows[h + 1:]:
        seq = _num(r[ix["seq"]]) if ix["seq"] < len(r) else None
        if seq is None:
            if any(isinstance(c, str) and c.strip().startswith("รวม") for c in r):
                total = r
            break
        block.append(r)
    if not block:
        raise PvsystImportError(f"sheet {sheet}: no station rows under the header")

    # trailing columns: offset 0 or 1 from their header, whichever puts a Wp value (300-800) in most rows
    trail: Dict[str, int] = {}
    tix = _index(hdr, TRAILING, sheet, required=False)
    if "wp_per_module" in tix:
        def hits(k: int) -> int:
            j = tix["wp_per_module"] + k
            return sum(1 for r in block if j < len(r) and (v := _num(r[j])) is not None and 300 <= v <= 800)
        best = max((0, 1), key=hits)
        if hits(best) >= 0.8 * len(block):
            trail = {k: j + best for k, j in tix.items()}
        else:
            warnings.append(f"{sheet}: Wp/แผ่น, kWp ในแบบจำลอง and the reading notes left out (their column could not be placed)")

    def cell(r: Tuple[Any, ...], j: Optional[int]) -> Any:
        return r[j] if j is not None and j < len(r) else None

    out = []
    for r in block:
        months = [_num(cell(r, jan + k)) for k in range(12)]
        text = _txt(cell(r, ix["tilt_azimuth"]))
        ori = parse_orientations(text)
        modules = _num(cell(r, opt.get("modules")))
        out.append({
            "phase": phase,
            "seq": int(_num(r[ix["seq"]])),  # type: ignore[arg-type]
            "project": _txt(cell(r, opt.get("project"))),
            "name": _txt(cell(r, ix["name"])) or f"{phase}-{int(_num(r[ix['seq']]))}",  # type: ignore[arg-type]
            "branch": _txt(cell(r, opt.get("branch"))),
            "lat": _num(cell(r, opt.get("lat"))),
            "lon": _num(cell(r, opt.get("lon"))),
            "tilt_azimuth": text,
            "orientations": ori,
            "tilt_deg": ori[0][0] if ori and len(ori) == 1 else None,
            "azimuth_deg": ori[0][1] if ori and len(ori) == 1 else None,
            "modules": int(modules) if modules is not None else None,
            "wp_per_module": _num(cell(r, trail.get("wp_per_module"))),
            "kwp": _num(cell(r, ix["kwp"])),
            "kwac": _num(cell(r, ix["kwac"])),
            "kwp_model": _num(cell(r, trail.get("kwp_model"))),
            "pr": _num(cell(r, ix["pr"])),
            "mwh_month": months,
            "mwh_year": _num(cell(r, ix["mwh_year"])),
            "mwh_year_report": _num(cell(r, opt.get("mwh_year_report"))),
            "specific_yield": _num(cell(r, ix["specific_yield"])),
            "note": _txt(cell(r, trail.get("note"))) if trail.get("note") is not None and isinstance(cell(r, trail.get("note")), str) else None,
            "report_code": None,
            "contract_kwh_y1": None,
            "contract_basis": None,
            "source": source,
        })
    if len({s["seq"] for s in out}) != len(out):
        raise PvsystImportError(f"sheet {sheet}: a ลำดับ appears twice")
    if total is not None:
        tkwp = _num(cell(total, ix["kwp"]))
        skwp = sum(s["kwp"] or 0.0 for s in out)
        if tkwp is not None and abs(tkwp - skwp) > 0.5:
            warnings.append(f"{sheet}: the stations' kWp add up to {skwp:.2f}, the รวม row says {tkwp:.2f}")

    # section ค: first-year contract kWh per station, in the stations' order; each row must name the
    # same station with the same kWp, else the section is not used
    try:
        c = _find_row(rows, ["สถานที่", "kWp", "หน่วยไฟ PVsyst"], sheet, h + 1)
    except PvsystImportError:
        warnings.append(f"{sheet}: no per-station contract section (สถานที่ / kWp / หน่วยไฟ PVsyst); contract kWh left null")
        return out
    chdr = [_norm(x) for x in rows[c]]
    cj = next((j for j, x in enumerate(chdr) if isinstance(x, str) and x.startswith("หน่วยไฟตามสัญญา")), None)
    if cj is None:
        warnings.append(f"{sheet}: the contract section has no หน่วยไฟตามสัญญา column; contract kWh left null")
        return out
    basis = "contract" if "ปีแรก" in chdr[cj] else "estimated" if "ประมาณ" in chdr[cj] else None
    nj, kj = chdr.index("สถานที่"), chdr.index("kWp")
    crow = rows[c + 1: c + 1 + len(out)]
    ok = len(crow) == len(out) and all(
        _txt(cell(r, nj)) == s["name"] and _num(cell(r, kj)) is not None and s["kwp"] is not None and abs(_num(cell(r, kj)) - s["kwp"]) < 0.01  # type: ignore[operator]
        for r, s in zip(crow, out)
    )
    if not ok:
        warnings.append(f"{sheet}: the contract section's rows do not line up with the stations (name / kWp); contract kWh left null")
        return out
    for r, s in zip(crow, out):
        s["contract_kwh_y1"] = _num(cell(r, cj))
        s["contract_basis"] = basis if s["contract_kwh_y1"] is not None else None
    return out


def _read_codes(rows: List[Tuple[Any, ...]]) -> Dict[int, str]:
    h = _find_row(rows, ["ลำดับ PVsyst", "รหัสในรายงานประจำวัน"], CODES_SHEET)
    hdr = [_norm(c) for c in rows[h]]
    js, jc = hdr.index("ลำดับ PVsyst"), hdr.index("รหัสในรายงานประจำวัน")
    out: Dict[int, str] = {}
    for r in rows[h + 1:]:
        seq = _num(r[js]) if js < len(r) else None
        code = _txt(r[jc]) if jc < len(r) else None
        if seq is not None and code:
            out[int(seq)] = code
    return out


def read_workbook(src: Union[str, Path, bytes], source: Optional[str] = None) -> Dict[str, Any]:
    """Phases and stations as the workbook states them, plus warnings for what it does not give."""
    import openpyxl

    data = io.BytesIO(src) if isinstance(src, bytes) else src
    wb = openpyxl.load_workbook(data, read_only=True, data_only=True)
    source = source or (Path(src).name if not isinstance(src, bytes) else "model.xlsx")
    missing = [n for n in [SUMMARY_SHEET, *(PHASE_SHEET.format(p) for p in PHASES)] if n not in wb.sheetnames]
    if missing:
        raise PvsystImportError(f"the workbook has no sheet {', '.join(missing)}")
    rows = lambda n: [tuple(r) for r in wb[n].iter_rows(values_only=True)]  # noqa: E731
    warnings: List[str] = []
    phases = _read_summary(rows(SUMMARY_SHEET), source)
    stations: List[Dict[str, Any]] = []
    for p in PHASES:
        stations += _read_phase(rows(PHASE_SHEET.format(p)), p, source, warnings)
    if CODES_SHEET in wb.sheetnames:
        codes = _read_codes(rows(CODES_SHEET))
        for s in stations:
            if s["phase"] == 2:
                s["report_code"] = codes.get(s["seq"])
        lost = [s["seq"] for s in stations if s["phase"] == 2 and s["report_code"] is None]
        if lost:
            warnings.append(f"{CODES_SHEET}: no report code for phase 2 station(s) {lost}")
    else:
        warnings.append(f"no sheet {CODES_SHEET}: phase 2 stations have no report code (D1 matches phase 2 by pvsyst_seq only)")
    for s in stations:
        if s["orientations"] is None and s["tilt_azimuth"]:
            warnings.append(f"{PHASE_SHEET.format(s['phase'])} #{s['seq']}: Tilt/Azimuth {s['tilt_azimuth']!r} not read")
    wb.close()
    return {"source": source, "phases": phases, "stations": stations, "warnings": warnings}


def _weighted_pr(stations: List[Dict[str, Any]]) -> Optional[float]:
    pts = [(s["pr"], s["kwp"]) for s in stations if s["pr"] is not None and s["kwp"]]
    w = sum(k for _, k in pts)
    return sum(p * k for p, k in pts) / w if w else None


def import_workbook(db: Session, parsed: Dict[str, Any]) -> Dict[str, Any]:
    """Replace both tables with the parsed workbook in one transaction."""
    try:
        db.execute(delete(PvsystStation))
        db.execute(delete(PvsystPhase))
        for p in parsed["phases"]:
            db.add(PvsystPhase(**p))
        for s in parsed["stations"]:
            db.add(PvsystStation(**s))
        db.commit()
    except Exception:
        db.rollback()
        raise
    by_phase: Dict[int, List[Dict[str, Any]]] = defaultdict(list)
    for s in parsed["stations"]:
        by_phase[s["phase"]].append(s)
    checks = []
    for p in parsed["phases"]:
        st = by_phase.get(p["phase"], []) if p["phase"] else parsed["stations"]
        wpr = _weighted_pr(st)
        checks.append({"phase": p["phase"], "stations": len(st), "pr_weighted_sheet": p["pr_weighted"],
                       "pr_kwp_weighted_stations": None if wpr is None else round(wpr, 6),
                       "contract_over_pvsyst_sheet": p["contract_over_pvsyst"]})
    return {"source": parsed["source"], "phases": len(parsed["phases"]), "stations": len(parsed["stations"]),
            "stations_by_phase": {k: len(v) for k, v in sorted(by_phase.items())},
            "orientation_single": sum(1 for s in parsed["stations"] if s["azimuth_deg"] is not None),
            "orientation_several": sum(1 for s in parsed["stations"] if s["orientations"] and len(s["orientations"]) > 1),
            "orientation_unread": sum(1 for s in parsed["stations"] if s["orientations"] is None),
            "checks": checks, "warnings": parsed["warnings"]}


# ---------- read side ----------

def _visible_sites(db: Session, allowed: Optional[Set[int]]) -> List[PwaMeterSite]:
    sites = list(db.scalars(select(PwaMeterSite).order_by(PwaMeterSite.site_id)))
    if allowed is None:
        return sites
    return [s for s in sites if s.growatt_plant_id is not None and s.growatt_plant_id in allowed]


def _match(sites: List[PwaMeterSite], stations: Dict[Tuple[int, int], PvsystStation]) -> Tuple[Dict[str, PvsystStation], List[str]]:
    """site_id → station by id: phase 2 the station's report code (and its pvsyst_seq must agree when
    set), phase 1 the site's pvsyst_seq. Returns the matches and the unmatched site ids."""
    by_code = {st.report_code: st for st in stations.values() if st.report_code}
    out: Dict[str, PvsystStation] = {}
    lost: List[str] = []
    for s in sites:
        st: Optional[PvsystStation] = None
        if s.phase == 2 and by_code:
            st = by_code.get(s.site_id)
            if st is not None and s.pvsyst_seq is not None and st.seq != s.pvsyst_seq:
                st = None
        elif s.pvsyst_seq is not None:
            st = stations.get((s.phase, s.pvsyst_seq))
        if st is None:
            lost.append(s.site_id)
        else:
            out[s.site_id] = st
    return out, lost


def _station_out(st: PvsystStation, site_ids: List[str]) -> Dict[str, Any]:
    kwp, kwac = st.kwp, st.kwac
    months = list(st.mwh_month or [None] * 12)
    ckwp = st.kwp_model or kwp
    csy = round(st.contract_kwh_y1 / ckwp, 2) if st.contract_kwh_y1 is not None and ckwp else None
    return {
        "phase": st.phase, "seq": st.seq, "name": st.name, "branch": st.branch, "project": st.project,
        "lat": st.lat, "lon": st.lon, "tilt_azimuth": st.tilt_azimuth, "orientations": st.orientations,
        "tilt_deg": st.tilt_deg, "azimuth_deg": st.azimuth_deg, "modules": st.modules, "wp_per_module": st.wp_per_module,
        "kwp": kwp, "kwac": kwac, "kwp_model": st.kwp_model,
        "dc_ac_ratio": round(kwp / kwac, 4) if kwp and kwac else None,
        "pr": st.pr, "mwh_month": months,
        "kwh_kwp_month": [round(v * 1000 / kwp, 2) if v is not None and kwp else None for v in months],
        "mwh_year": st.mwh_year, "mwh_year_report": st.mwh_year_report, "specific_yield": st.specific_yield,
        "contract_kwh_y1": st.contract_kwh_y1, "contract_basis": st.contract_basis,
        # the contract covers the model's kWp (phase 1 #42: 2,114 kWp, its PVsyst report only 424), so
        # both are compared per kWp, never kWh ÷ kWh
        "contract_specific_yield": csy,
        "contract_over_pvsyst": round(csy / st.specific_yield, 4) if csy is not None and st.specific_yield else None,
        "report_code": st.report_code, "note": st.note, "site_ids": site_ids,
    }


def design(db: Session, allowed: Optional[Set[int]]) -> Dict[str, Any]:
    """Phase summaries (admins only: they cover stations an engineer may not see) and the stations
    the user may see: admins every station, engineers those joined to a report site of an assigned
    plant."""
    stations = {(st.phase, st.seq): st for st in db.scalars(select(PvsystStation).order_by(PvsystStation.phase, PvsystStation.seq))}
    matches, _ = _match(_visible_sites(db, allowed), stations)
    sites_of: Dict[Tuple[int, int], List[str]] = defaultdict(list)
    for sid, st in sorted(matches.items()):
        sites_of[(st.phase, st.seq)].append(sid)
    keys = list(stations) if allowed is None else [k for k in stations if k in sites_of]
    phases: List[Dict[str, Any]] = []
    total: Optional[Dict[str, Any]] = None
    source = next(iter(stations.values())).source if stations else None
    if allowed is None:
        for p in db.scalars(select(PvsystPhase).order_by(PvsystPhase.phase)):
            row = {k: getattr(p, k) for k in ("phase", *[c for c in SUMMARY_COLS if c != "phase"])}
            st = [stations[k] for k in keys if k[0] == p.phase] if p.phase else list(stations.values())
            row["station_rows"] = len(st)
            # the sheet's contract ÷ PVsyst is kWh ÷ kWh, which in phase 1 sets the contract on the model's
            # 25,406 kWp against PVsyst reports covering 23,688 kWp; per kWp is the like-for-like ratio
            row["contract_over_pvsyst_per_kwp"] = (
                round(p.contract_specific_yield / p.specific_yield, 4) if p.contract_specific_yield and p.specific_yield else None
            )
            if p.phase:
                phases.append(row)
            else:
                total = row
    imported = max((st.imported_at for st in stations.values()), default=None)
    return {
        "phases": phases,
        "total": total,
        "stations": [_station_out(stations[k], sites_of.get(k, [])) for k in keys],
        "meta": {"source": source, "imported_at": imported.isoformat() if imported else None, "scope": "fleet" if allowed is None else "assigned",
                 "azimuth_convention": "PVsyst: 0 = south, -90 = east, 90 = west, ±180 = north"},
        "labels": LABELS,
    }


def vs_meter(db: Session, allowed: Optional[Set[int]], start: Optional[date] = None, end: Optional[date] = None) -> Dict[str, Any]:
    """D1: per visible report site and calendar month, the metered kWh of the days with a reading and
    the station's PVsyst E_Grid on those same days (modelled)."""
    sites = _visible_sites(db, allowed)
    stations = {(st.phase, st.seq): st for st in db.scalars(select(PvsystStation))}
    matches, lost = _match(sites, stations) if stations else ({}, [s.site_id for s in sites])
    q = select(PwaMeterDay).where(PwaMeterDay.site_id.in_(list(matches)), PwaMeterDay.meter_kwh.is_not(None))
    if start:
        q = q.where(PwaMeterDay.day >= start)
    if end:
        q = q.where(PwaMeterDay.day <= end)
    acc: Dict[str, Dict[date, Dict[str, Any]]] = defaultdict(dict)
    site_by_id = {s.site_id: s for s in sites}
    for d in db.scalars(q.order_by(PwaMeterDay.day)):
        s, st = site_by_id[d.site_id], matches[d.site_id]
        mo = d.day.replace(day=1)
        m = acc[d.site_id].setdefault(mo, {"month": mo.isoformat()[:7], "days_read": 0, "meter_kwh": 0.0, "pvsyst_kwh": 0.0, "pvsyst_missing_days": 0})
        m["days_read"] += 1
        m["meter_kwh"] += d.meter_kwh
        mwh = (st.mwh_month or [None] * 12)[d.day.month - 1]
        if mwh is None or not st.kwp:
            m["pvsyst_missing_days"] += 1
        else:
            m["pvsyst_kwh"] += mwh * 1000 * (s.kwp / st.kwp) / calendar.monthrange(d.day.year, d.day.month)[1]
    out_sites = []
    for sid, months in acc.items():
        s, st = site_by_id[sid], matches[sid]
        rows = []
        for mo in sorted(months):
            m = months[mo]
            pv = None if m["pvsyst_missing_days"] else round(m["pvsyst_kwh"], 1)
            m["meter_kwh"] = round(m["meter_kwh"], 1)
            m["pvsyst_kwh"] = pv
            m["meter_over_pvsyst"] = round(m["meter_kwh"] / pv, 4) if pv else None
            rows.append(m)
        out_sites.append({"site_id": sid, "name": s.name, "phase": s.phase, "region": s.region, "kwp": s.kwp,
                          "station_seq": st.seq, "station_kwp": st.kwp,
                          "kwp_ratio": round(s.kwp / st.kwp, 4) if st.kwp else None, "months": rows})
    return {
        "sites": sorted(out_sites, key=lambda x: (x["phase"], x["site_id"])),
        "matched": len(matches),
        "unmatched": len(lost),
        "unmatched_sites": lost,
        "sites_without_readings": len([k for k in matches if k not in acc]),
        "start": start.isoformat() if start else None,
        "end": end.isoformat() if end else None,
        "labels": {**LABELS, "pvsyst_kwh": "PVsyst E_Grid of the month ÷ days in the month on each day with a meter reading, × site kWp ÷ PVsyst kWp (modelled)"},
    }


# ---------- CLI ----------

def main(argv: Optional[List[str]] = None) -> int:
    from app.db.session import SessionLocal, engine, ensure_schema

    ap = argparse.ArgumentParser(prog="python -m app.services.pvsyst", description=(__doc__ or "").split("\n\n")[0])
    sub = ap.add_subparsers(dest="cmd", required=True)
    imp = sub.add_parser("import", help="replace the PVsyst design tables with the model workbook's PVsyst sheets")
    imp.add_argument("--model", required=True, type=Path)
    imp.add_argument("--dry-run", action="store_true", help="read and check the workbook, write nothing")
    a = ap.parse_args(argv)
    try:
        parsed = read_workbook(a.model)
    except PvsystImportError as exc:
        print(f"import refused: {exc}")
        return 1
    if a.dry_run:
        print(json.dumps({"phases": len(parsed["phases"]), "stations": len(parsed["stations"]), "warnings": parsed["warnings"]}, ensure_ascii=False, indent=1))
        return 0
    ensure_schema(engine)
    with SessionLocal() as db:
        print(json.dumps(import_workbook(db, parsed), ensure_ascii=False, indent=1))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
