"""Parse the PWA daily meter reports (Excel) as the sites send them (docs/plans/pwa-meter-daily.md §2.3).

Two layouts are in use, both carrying the same per-site table:
- phase 1: one day per workbook, sheet `สรุปหน่วยรายวัน`, title "…ประจำวันที่ 11 พฤศจิกายน 2569";
- phase 2: one sheet per day in one growing workbook, the table from column Y, a `comp_id` per row on
  the left (= `P2-<comp_id>`), and the day only in the sheet name (`711`, `7.11`, `18.11`, …).
  The phase 1 workbook now comes in this layout too, with its own `comp_id` (not a site id): the
  matcher uses `comp_id` only on a sheet where it names phase 2 sites (`pwa_meter._Matcher.p2_sheet`).

The table is found by its header text (`หน่วยจากมิเตอร์`), never by sheet name or column position,
so a renamed or shifted sheet still reads. A sheet without that header (charts, the problem list) is
skipped. Values are read as reported: a blank or "-" reading is null, never 0. This module only
parses; matching to sites and storing is `pwa_meter.import_report`.
"""

from __future__ import annotations

import io
import re
from dataclasses import dataclass, field
from datetime import date
from typing import Any, List, Optional, Tuple

HEADER = "หน่วยจากมิเตอร์"
COLUMNS = {
    "seq": "ลำดับ",
    "name": "สถานที่",
    "meter": "หน่วยจากมิเตอร์",
    "inverter": "หน่วยจากอินเวอร์เตอร์",
    "weather": "สภาพอากาศ",
    "note": "หมายเหตุ",
}
THAI_MONTHS = {
    "มกราคม": 1, "กุมภาพันธ์": 2, "มีนาคม": 3, "เมษายน": 4, "พฤษภาคม": 5, "มิถุนายน": 6,
    "กรกฎาคม": 7, "สิงหาคม": 8, "กันยายน": 9, "ตุลาคม": 10, "พฤศจิกายน": 11, "ธันวาคม": 12,
    "ม.ค.": 1, "ก.พ.": 2, "มี.ค.": 3, "เม.ย.": 4, "พ.ค.": 5, "มิ.ย.": 6,
    "ก.ค.": 7, "ส.ค.": 8, "ก.ย.": 9, "ต.ค.": 10, "พ.ย.": 11, "ธ.ค.": 12,
}
# phase 2 sheets also carry the system pull on the left of the same header row: per site the Cewe
# meter total, the Growatt inverter total and the weather. They are preferred over the typed table:
# the table repeats an old inverter figure on days the inverter was not reporting (P2-1073, 11-12 Jan
# 2026: table 1118.4 kWh twice, Growatt 0 with "ระบบสื่อสารมีปัญหา"), and the days CSV was built from them.
SYSTEM_COLUMNS = {"meter": "Cewe", "inverter": "Growatt", "weather": "Weather"}
TITLE_RE = re.compile(r"ประจำวันที่\s*(\d{1,2})\s*(\S+?)\s*(\d{4})")
METER_RE = re.compile(r"\b([A-Z]{2}\d{5,8})\b")


@dataclass
class ReportRow:
    row_no: int  # 1-based Excel row
    seq: Optional[int]
    name: str
    comp_id: Optional[int]
    meter_no: Optional[str]
    meter_kwh: Optional[float]
    inverter_kwh: Optional[float]
    weather: Optional[str]
    note: Optional[str]


@dataclass
class ReportSheet:
    file: str
    sheet: str
    day: Optional[date]
    day_source: Optional[str]  # "title" | "sheet name" | None
    rows: List[ReportRow] = field(default_factory=list)
    errors: List[str] = field(default_factory=list)

    @property
    def key(self) -> str:
        return f"{self.file}::{self.sheet}"


def _clean(v: Any) -> str:
    return re.sub(r"\s+", " ", str(v)).strip() if v is not None else ""


def _round_kwh() -> int:
    """kWh decimals kept from the report (criteria `report_import.round_kwh`)."""
    from app.services.pwa_meter import criteria

    return int(criteria()["report_import"]["round_kwh"])


def _number(v: Any, where: str, errors: List[str]) -> Optional[float]:
    if v is None:
        return None
    if isinstance(v, bool):
        errors.append(f"{where}: {v!r} is not a number")
        return None
    if isinstance(v, (int, float)):
        x = float(v)
    else:
        s = _clean(v).replace(",", "")
        if s in ("", "-", "–", "—", "N/A", "n/a"):
            return None
        try:
            x = float(s)
        except ValueError:
            errors.append(f"{where}: {v!r} is not a number")
            return None
    if x != x:  # NaN
        return None
    if x < 0:
        errors.append(f"{where}: {x} is negative")
        return None
    return round(x, _round_kwh())


def title_day(text: str) -> Optional[date]:
    """`…ประจำวันที่ 11 พฤศจิกายน 2569` → 2026-11-11 (a year above 2400 is Buddhist Era)."""
    m = TITLE_RE.search(text)
    if not m:
        return None
    month = THAI_MONTHS.get(m.group(2))
    if not month:
        return None
    y = int(m.group(3))
    y = y - 543 if y > 2400 else y
    try:
        return date(y, month, int(m.group(1)))
    except ValueError:
        return None


def sheet_day_months(name: str) -> List[Tuple[int, int]]:
    """Every (day, month) a sheet name can mean. The phase 2 workbook writes `18.11`, `7.11`, `711`
    (7 Nov), `1011` (10 Nov), `017` (1 Jul) and `19` (1 Sep): digits only are read both as d + mm and dd + m, and
    the caller keeps the reading that continues the sheet sequence."""
    m = re.match(r"^\s*(\d{1,2})[./-]+(\d{1,2})\s*$", name)  # `17..11` too
    if m:
        cands = [(int(m.group(1)), int(m.group(2)))]
    elif re.match(r"^\s*\d{2,4}\s*$", name):
        t = name.strip()
        cands = [(int(t[:k]), int(t[k:])) for k in (1, 2) if len(t) - k in (1, 2)]
    else:
        cands = []
    return [(d, mo) for d, mo in cands if 1 <= mo <= 12 and 1 <= d <= 31]


def _find_header(rows: List[Tuple[Any, ...]]) -> Optional[Tuple[int, dict, Optional[int]]]:
    for i, r in enumerate(rows):
        cells = [_clean(c) for c in r]
        if HEADER in cells:
            cols = {k: cells.index(v) for k, v in COLUMNS.items() if v in cells}
            # phase 2: `comp_id` on the left of the same header row (the first one)
            comp = cells.index("comp_id") if "comp_id" in cells else None
            for k, v in SYSTEM_COLUMNS.items():
                if v in cells and cells.index(v) < cols.get("seq", cols["meter"]):
                    cols[f"sys_{k}"] = cells.index(v)
            return i, cols, comp
    return None


def _parse_sheet(file: str, name: str, rows: List[Tuple[Any, ...]]) -> Optional[ReportSheet]:
    found = _find_header(rows)
    if found is None:
        return None
    h, cols, comp = found
    sheet = ReportSheet(file=file, sheet=name, day=None, day_source=None)
    for need in ("name", "meter", "inverter"):
        if need not in cols:
            sheet.errors.append(f"header row {h + 1}: no {COLUMNS[need]!r} column")
    if sheet.errors:
        return sheet
    for r in rows[: h + 1]:
        for c in r:
            if isinstance(c, str) and "ประจำวันที่" in c:
                d = title_day(c)
                if d:
                    sheet.day, sheet.day_source = d, "title"
                    break
        if sheet.day:
            break
    width = max(cols.values()) + 1
    i = h + 1
    while i < len(rows):
        r = tuple(rows[i]) + (None,) * max(0, width - len(rows[i]))
        name_cell = _clean(r[cols["name"]])
        seq = r[cols["seq"]] if "seq" in cols else None
        is_site = bool(name_cell) and name_cell != COLUMNS["name"] and (
            isinstance(seq, (int, float)) or ("seq" not in cols and (r[cols["meter"]] is not None or r[cols["inverter"]] is not None))
        )
        if not is_site:
            i += 1
            continue
        where = f"{name} row {i + 1}"
        errs: List[str] = []
        meter_no = None
        # the meter number sits on the next one or two rows, before the next site row
        for j in range(i + 1, min(i + 4, len(rows))):
            nxt = rows[j]
            if "seq" in cols and cols["seq"] < len(nxt) and isinstance(nxt[cols["seq"]], (int, float)):
                break
            for c in nxt:
                m = METER_RE.search(str(c)) if c is not None else None
                if m:
                    meter_no = m.group(1)
                    break
            if meter_no:
                break
        comp_id = None
        if comp is not None and comp < len(r) and isinstance(r[comp], (int, float)):
            comp_id = int(r[comp])
        # the system pull when this row has one (phase 2), else the table
        src = {k: (cols[f"sys_{k}"] if comp_id is not None and f"sys_{k}" in cols else cols[k]) for k in ("meter", "inverter", "weather") if k in cols}
        sheet.rows.append(ReportRow(
            row_no=i + 1,
            seq=int(seq) if isinstance(seq, (int, float)) else None,
            name=name_cell,
            comp_id=comp_id,
            meter_no=meter_no,
            meter_kwh=_number(r[src["meter"]], f"{where} meter", errs),
            inverter_kwh=_number(r[src["inverter"]], f"{where} inverter", errs),
            weather=(_clean(r[src["weather"]]) or None) if "weather" in src else None,
            note=(_clean(r[cols["note"]]) or None) if "note" in cols else None,
        ))
        sheet.errors.extend(errs)
        i += 1
    return sheet


def parse_workbook(data: bytes, file: str, today: date) -> List[ReportSheet]:
    """Every day sheet of one report workbook, in workbook order. A sheet whose day comes from its
    name gets the reading and year closest to the previous dated sheet, before or after it (31 Dec →
    `0101` = 1 Jan of the next year); the first such sheet takes the latest date not after `today`.
    A sheet out of order (the phase 1 workbook has a second May block after 27 May) so lands on
    its own days and is reported as a repeat, instead of moving every later sheet a year ahead."""
    import openpyxl

    wb = openpyxl.load_workbook(io.BytesIO(data), read_only=True, data_only=True)
    out: List[ReportSheet] = []
    last: Optional[date] = None
    seen: dict = {}
    for ws in wb.worksheets:
        parsed = _parse_sheet(file, ws.title, [tuple(r) for r in ws.iter_rows(values_only=True)])
        if parsed is None:
            continue
        if parsed.day is None:
            guesses = []
            for d, mo in sheet_day_months(ws.title):
                for year in ((last.year - 1, last.year, last.year + 1) if last else (today.year, today.year - 1)):
                    try:
                        guesses.append(date(year, mo, d))
                    except ValueError:
                        pass
            if last:
                pick = min(guesses, key=lambda g: (abs((g - last).days), g < last), default=None)
            else:
                pick = max((g for g in guesses if g <= today), default=None)
            if pick:
                parsed.day, parsed.day_source = pick, "sheet name"
            else:
                parsed.errors.append(f"no date: no 'ประจำวันที่ …' title and the sheet name {ws.title!r} is not a day")
        if parsed.day:
            last = parsed.day
            first = seen.setdefault(parsed.day, ws.title)
            if first != ws.title:
                parsed.errors.append(f"day {parsed.day} is also sheet {first!r}: skip one of them or set its day")
        out.append(parsed)
    return out
