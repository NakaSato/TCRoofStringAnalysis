"""TFRS 16 lease accounting of the PWA solar contract, read from the TFRS 16 model workbook
(`billing/Solar-TFRS16-Model-*.xlsx`) and served read-only to the Energy & Billing page (admins).

Every figure is the **model's** (accounting, not measured): the lease-liability schedule of each
phase, the right-of-use asset, interest and depreciation, the 20-year minimum fee, the seasonal
revenue profile of contract year 1 and the remeasurements at a fiscal year end. Phases 3-4 are
estimates on an assumed start date (their sheets say ประมาณการ). The phase 3-4 rollout list is the
station status list the workbook carries.

Sheets read (columns found by their header text, never by letter):
- `ระยะ1` … `ระยะ4` (required): the schedule (งวด, เดือน, ปีงบ, หนี้สินต้นงวด, ดอกเบี้ย, ชำระ,
  หนี้สินปลายงวด, ค่าเสื่อมราคา, สินทรัพย์สิทธิการใช้สุทธิ …); each row must satisfy
  closing = opening + interest + payment (payment negative) or the import is refused.
- `รวมทั้งโครงการ` (required): section ก = per-phase parameters; section ข = per fiscal year totals,
  used only to check the schedule.
- `วงเงินโครงการ`, `รายได้ขั้นต่ำ_สถานี`: the stated project budget and minimum fee (checks).
- `ประเมินใหม่*`: remeasurement stage 1 + the account of stage 2; the phase is the one whose
  schedule closes the assessed month at the sheet's book liability (no match = sheet skipped).
- `รายได้รายเดือน` section ค: modelled revenue per phase and month of contract year 1.
- `ระยะ3-4_สถานี`: the phase 3-4 stations, interconnection status, fee payment, First Sync.
An optional sheet that is missing leaves its part empty (warning). A check that fails is a warning.
The import replaces every TFRS 16 row in one transaction: all or nothing.

CLI: `PYTHONPATH=backend uv run python -m app.services.tfrs16 import --model <xlsx>`.
"""

from __future__ import annotations

import argparse
import io
import json
import re
from collections import defaultdict
from dataclasses import dataclass, field
from datetime import date, datetime
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence, Tuple, Union

from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from app.db.models import (
    Tfrs16Import,
    Tfrs16Period,
    Tfrs16Phase,
    Tfrs16Remeasurement,
    Tfrs16RevenueMonth,
    Tfrs16RolloutStation,
)

MONTHS_TH = ("ม.ค.", "ก.พ.", "มี.ค.", "เม.ย.", "พ.ค.", "มิ.ย.", "ก.ค.", "ส.ค.", "ก.ย.", "ต.ค.", "พ.ย.", "ธ.ค.")
PAID = "ชำระเงินแล้ว"
CONNECTED = "เชื่อมต่อเรียบร้อยแล้ว"
TOL_THB = 1.0  # rounding tolerance of the checks, baht

LABELS = {
    "schedule": "accounting (model)",
    "rou": "accounting (model)",
    "expense": "accounting (model)",
    "minimum_fee": "contract minimum fee (model)",
    "remeasurement": "accounting (model)",
    "revenue": "modelled",
    "rollout": "status list as attached to the workbook",
    "estimated_phases": "phases marked estimated rest on an assumed start date",
}

SCHED_COLS = {
    "period": "งวด",
    "month": "เดือน",
    "fiscal_year": "ปีงบ",
    "contract_year": "ปีสัญญา",
    "min_fee_thb": "ค่าจัดการพลังงานขั้นต่ำ",
    "kwh": "หน่วยประมาณการ (kWh)",
    "opening_thb": "หนี้สินต้นงวด",
    "interest_thb": "ดอกเบี้ย",
    "payment_thb": "ชำระ",
    "closing_thb": "หนี้สินปลายงวด",
    "depreciation_thb": "ค่าเสื่อมราคา",
    "rou_net_thb": "สินทรัพย์สิทธิการใช้สุทธิ",
}
PHASE_ROWS = {
    "stations": "จำนวนสถานี (แห่ง)",
    "kwp": "กำลังติดตั้ง (kWp)",
    "start_day": "วันเริ่มสัญญา",
    "end_day": "วันสิ้นสุดสัญญา",
    "discount_rate": "อัตราคิดลด",
    "min_fee_thb": "ค่าจัดการพลังงาน 20 ปี",
    "kwh_20y": "หน่วยไฟประมาณการ 20 ปี (kWh)",
    "rou_initial_thb": "สินทรัพย์สิทธิการใช้เริ่มแรก",
    "deferred_interest_thb": "ดอกเบี้ยจ่ายรอตัดบัญชีเริ่มแรก",
}
# remeasurement stage 1: field -> label prefixes (first that matches wins)
REMEASURE_ROWS: Dict[str, Tuple[str, ...]] = {
    "assessed_on": ("วันที่ประเมิน",),
    "book_liability_thb": ("หนี้สินตามบัญชี",),
    "remaining_fee_thb": ("ค่าจัดการพลังงานขั้นต่ำคงเหลือ",),
    "old_deferred_interest_thb": ("ดอกเบี้ยรอตัดบัญชีชุดเดิม",),
    "revised_fee_thb": ("ค่าจัดการพลังงานคงเหลือหลังทบทวน",),
    "new_liability_thb": ("หนี้สินที่วัดใหม่",),
    "new_deferred_interest_thb": ("ดอกเบี้ยรอตัดบัญชีชุดใหม่",),
    "difference_share": ("ส่วนต่างเป็น %",),
    "difference_thb": ("ส่วนต่าง (",),
    "threshold_share": ("เกณฑ์ที่ต้องปรับ",),
    "decision": ("ผลการพิจารณา",),
    "share_used": ("% ที่ใช้วัดหนี้สินใหม่",),
    "share_expected": ("% ที่คาดว่าจะผลิตได้ในงวดที่เหลือ",),
}
ACCOUNT = "6279030"


class ModelError(ValueError):
    """The workbook is not the TFRS 16 model this reader knows; the message says what is missing."""


@dataclass
class Model:
    source: str
    phases: Dict[int, Dict[str, Any]] = field(default_factory=dict)
    periods: Dict[int, List[Dict[str, Any]]] = field(default_factory=dict)
    remeasurements: Dict[int, Dict[str, Any]] = field(default_factory=dict)
    revenue: Dict[int, List[Optional[float]]] = field(default_factory=dict)  # phase -> 12 calendar months
    revenue_fy_order: List[int] = field(default_factory=list)  # calendar months in the sheet's order
    revenue_case: Optional[str] = None
    revenue_price: Optional[float] = None
    stations: List[Dict[str, Any]] = field(default_factory=list)
    rollout_note: Optional[str] = None
    project_budget_thb: Optional[float] = None
    warnings: List[str] = field(default_factory=list)


# ---------------------------------------------------------------- reading helpers


def _num(v: Any) -> Optional[float]:
    return float(v) if isinstance(v, (int, float)) and not isinstance(v, bool) else None


def _int(v: Any) -> Optional[int]:
    n = _num(v)
    return int(n) if n is not None and n == int(n) else None


def _txt(v: Any) -> Optional[str]:
    return re.sub(r"\s+", " ", v).strip() if isinstance(v, str) and v.strip() else None


def _day(v: Any) -> Optional[date]:
    if isinstance(v, datetime):
        return v.date()
    return v if isinstance(v, date) else None


def _rows(ws) -> List[Tuple[Any, ...]]:
    return [tuple(r) for r in ws.iter_rows(values_only=True)]


def _find_header(rows: Sequence[Tuple[Any, ...]], words: Sequence[str], sheet: str, start: int = 0) -> Tuple[int, Dict[str, int]]:
    """The first row (from `start`) holding every word as a whole cell; returns its index and word -> column."""
    for i in range(start, len(rows)):
        cells = [_txt(c) for c in rows[i]]
        if all(w in cells for w in words):
            return i, {w: cells.index(w) for w in words}
    raise ModelError(f"sheet {sheet}: no header row with {', '.join(words)}")


def _cell(r: Tuple[Any, ...], j: int) -> Any:
    return r[j] if j < len(r) else None


def _close(a: Optional[float], b: Optional[float], tol: float = TOL_THB) -> bool:
    return a is not None and b is not None and abs(a - b) <= max(tol, 1e-6 * abs(b))


def _title(rows: Sequence[Tuple[Any, ...]]) -> str:
    for r in rows[:3]:
        for c in r:
            if _txt(c):
                return _txt(c) or ""
    return ""


# ---------------------------------------------------------------- sheets


def _read_schedule(rows: Sequence[Tuple[Any, ...]], sheet: str) -> List[Dict[str, Any]]:
    h, cols = _find_header(rows, list(SCHED_COLS.values()), sheet)
    out: List[Dict[str, Any]] = []
    for r in rows[h + 1:]:
        period = _int(_cell(r, cols["งวด"]))
        if period is None:
            break
        rec: Dict[str, Any] = {"period": period}
        month = _day(_cell(r, cols["เดือน"]))
        fy = re.search(r"(\d{4})", str(_cell(r, cols["ปีงบ"]) or ""))
        if month is None or fy is None:
            raise ModelError(f"sheet {sheet}: period {period} has no month or fiscal year")
        rec["month"] = month.replace(day=1)
        rec["fiscal_year"] = int(fy.group(1))
        rec["contract_year"] = _int(_cell(r, cols["ปีสัญญา"]))
        for k in ("min_fee_thb", "kwh", "opening_thb", "interest_thb", "payment_thb", "closing_thb", "depreciation_thb", "rou_net_thb"):
            rec[k] = _num(_cell(r, cols[SCHED_COLS[k]]))
        pay = rec["payment_thb"]
        if pay is not None:
            rec["payment_thb"] = -pay  # the sheet writes a payment as negative
        o, i_, c = rec["opening_thb"], rec["interest_thb"], rec["closing_thb"]
        if None in (o, i_, c, pay) or not _close(o + i_ + pay, c):
            raise ModelError(f"sheet {sheet}: period {period}: opening + interest + payment ≠ closing (columns misread?)")
        if out and period != out[-1]["period"] + 1:
            raise ModelError(f"sheet {sheet}: period {period} does not follow {out[-1]['period']}")
        out.append(rec)
    if not out:
        raise ModelError(f"sheet {sheet}: no schedule rows under the header")
    return out


def _read_project(rows: Sequence[Tuple[Any, ...]], phases: Sequence[int]) -> Tuple[Dict[int, Dict[str, Any]], Dict[int, Dict[str, float]]]:
    sheet = "รวมทั้งโครงการ"
    names = [f"ระยะที่ {p}" for p in phases]
    h, cols = _find_header(rows, ["รายการ", *names], sheet)
    c_lab = cols["รายการ"]
    par: Dict[int, Dict[str, Any]] = {p: {} for p in phases}
    end = len(rows)
    for i in range(h + 1, len(rows)):
        lab = _txt(_cell(rows[i], c_lab))
        if lab and lab.startswith("ข."):
            end = i
            break
        for key, want in PHASE_ROWS.items():
            if lab == want:
                for p, n in zip(phases, names):
                    v = _cell(rows[i], cols[n])
                    par[p][key] = _day(v) if key.endswith("_day") else _num(v)
    for p in phases:
        missing = [PHASE_ROWS[k] for k in PHASE_ROWS if par[p].get(k) is None]
        if missing:
            raise ModelError(f"sheet {sheet}: phase {p} lacks {', '.join(missing)}")
        par[p]["stations"] = int(par[p]["stations"])
    fy_tot: Dict[int, Dict[str, float]] = {}
    try:
        h2, c2 = _find_header(rows, ["ปีงบประมาณ", "ดอกเบี้ยจ่ายรวม", "ค่าเสื่อมราคารวม"], sheet, end)
        for r in rows[h2 + 1:]:
            fy = _int(_cell(r, c2["ปีงบประมาณ"]))
            if fy is None:
                break
            fy_tot[fy] = {"interest": _num(_cell(r, c2["ดอกเบี้ยจ่ายรวม"])) or 0.0, "depreciation": _num(_cell(r, c2["ค่าเสื่อมราคารวม"])) or 0.0}
    except ModelError:
        pass
    return par, fy_tot


def _label_value(rows: Sequence[Tuple[Any, ...]], label: str) -> Optional[float]:
    for r in rows:
        for j, c in enumerate(r):
            if _txt(c) == label:
                return next((n for x in r[j + 1:] if (n := _num(x)) is not None), None)
    return None


def _read_remeasure(rows: Sequence[Tuple[Any, ...]], sheet: str) -> Dict[str, Any]:
    start = next((i for i, r in enumerate(rows) if any((_txt(c) or "").startswith("ขั้นที่ 1") for c in r)), None)
    stop = next((i for i, r in enumerate(rows) if any((_txt(c) or "").startswith("ขั้นที่ 2") for c in r)), len(rows))
    if start is None:
        raise ModelError(f"sheet {sheet}: no ขั้นที่ 1 section")
    h, cols = _find_header(rows, ["บาท"], sheet, start)
    c_val = cols["บาท"]
    got: Dict[str, Any] = {}
    for r in rows[h + 1:stop]:
        lab = next((t for c in r if (t := _txt(c)) and not _num(c)), None)
        if lab is None:
            continue
        for key, prefixes in REMEASURE_ROWS.items():
            if key not in got and any(lab.startswith(p) for p in prefixes):
                v = _cell(r, c_val)
                got[key] = _day(v) if key == "assessed_on" else (_txt(v) if key == "decision" else _num(v))
                break
    share = got.pop("share_used", None)
    expected = got.pop("share_expected", None)
    got["production_share"] = share if share is not None else expected
    if got.get("book_liability_thb") is None or got.get("new_liability_thb") is None or got.get("assessed_on") is None:
        raise ModelError(f"sheet {sheet}: stage 1 lacks the assessed date, book liability or remeasured liability")
    got["account"] = ACCOUNT if any(_txt(c) == ACCOUNT for r in rows[stop:] for c in r) else None
    got["sheet"] = sheet
    return got


def _read_revenue(rows: Sequence[Tuple[Any, ...]], m: Model) -> None:
    sheet = "รายได้รายเดือน"
    for i, r in enumerate(rows):
        cells = [_txt(c) for c in r]
        if "กรณีที่เลือก" in cells:
            m.revenue_case = next((t for c in r[cells.index("กรณีที่เลือก") + 1:] if (t := _txt(c))), None)
        if any((t or "").startswith("ราคาสุทธิต่อหน่วยที่ใช้") for t in cells):
            j = next(j for j, t in enumerate(cells) if (t or "").startswith("ราคาสุทธิต่อหน่วยที่ใช้"))
            m.revenue_price = next((n for x in r[j + 1:] if (n := _num(x)) is not None), None)
    start = 0
    while True:
        h, cols = _find_header(rows, ["ระยะ", "รายการ", "รวมปีแรก"], sheet, start)
        hdr = [_txt(c) for c in rows[h]]
        if h + 1 < len(rows) and (_txt(_cell(rows[h + 1], cols["รายการ"])) or "").startswith("ระยะที่"):
            break
        start = h + 1
    mcols = [(j, MONTHS_TH.index(t) + 1) for j, t in enumerate(hdr) if t in MONTHS_TH]
    if len(mcols) != 12:
        raise ModelError(f"sheet {sheet}: the revenue table has {len(mcols)} month columns, not 12")
    m.revenue_fy_order = [mo for _, mo in mcols]
    for r in rows[h + 1:]:
        ph = _int(_cell(r, cols["ระยะ"]))
        lab = _txt(_cell(r, cols["รายการ"])) or ""
        if ph is None or not lab.startswith("ระยะที่"):
            break
        vals: List[Optional[float]] = [None] * 12
        for j, mo in mcols:
            vals[mo - 1] = _num(_cell(r, j))
        total = _num(_cell(r, cols["รวมปีแรก"]))
        if None not in vals and total is not None and not _close(sum(v for v in vals if v is not None), total):
            m.warnings.append(f"{sheet}: phase {ph} months do not add up to รวมปีแรก")
        m.revenue[ph] = vals


def _read_rollout(rows: Sequence[Tuple[Any, ...]], m: Model) -> None:
    sheet = "ระยะ3-4_สถานี"
    words = ["ลำดับ", "ระยะ", "สถานที่ติดตั้ง", "kWp (แผง)", "สถานะขนานไฟ (กฟภ.)", "ค่าธรรมเนียมขนานไฟ", "สถานะชำระ", "First Sync"]
    h, c = _find_header(rows, words, sheet)
    m.rollout_note = next((t for r in rows[:h] for x in r if (t := _txt(x)) and t.startswith("ที่มา")), None)
    seen = set()
    for r in rows[h + 1:]:
        seq, ph = _int(_cell(r, c["ลำดับ"])), _int(_cell(r, c["ระยะ"]))
        if seq is None or ph is None:
            continue
        if (ph, seq) in seen:
            raise ModelError(f"sheet {sheet}: station {seq} of phase {ph} listed twice")
        seen.add((ph, seq))
        status = _txt(_cell(r, c["สถานะขนานไฟ (กฟภ.)"]))
        m.stations.append({
            "phase": ph, "seq": seq, "name": _txt(_cell(r, c["สถานที่ติดตั้ง"])) or f"#{seq}",
            "kwp": _num(_cell(r, c["kWp (แผง)"])), "interconnect_status": status,
            "fee_thb": _num(_cell(r, c["ค่าธรรมเนียมขนานไฟ"])),
            "fee_paid": _txt(_cell(r, c["สถานะชำระ"])) == PAID, "interconnected": status == CONNECTED,
            "first_sync": _day(_cell(r, c["First Sync"])),
        })


def read_model(src: Union[str, Path, bytes], source: Optional[str] = None) -> Model:
    """Read and check the workbook; raises ModelError when a required part is missing or misread."""
    import openpyxl

    data = io.BytesIO(src) if isinstance(src, bytes) else src
    wb = openpyxl.load_workbook(data, read_only=True, data_only=True)
    m = Model(source=source or (Path(src).name if not isinstance(src, bytes) else "model.xlsx"))
    names = set(wb.sheetnames)
    phases = sorted(int(mt.group(1)) for n in names if (mt := re.fullmatch(r"ระยะ(\d)", n)))
    if not phases:
        raise ModelError("the workbook has no phase sheet ระยะ1 … ระยะ4 (is it the TFRS 16 model?)")
    if "รวมทั้งโครงการ" not in names:
        raise ModelError("the workbook has no sheet รวมทั้งโครงการ")
    for p in phases:
        rows = _rows(wb[f"ระยะ{p}"])
        m.periods[p] = _read_schedule(rows, f"ระยะ{p}")
        m.phases[p] = {"estimated": "ประมาณการ" in _title(rows)}
    par, fy_tot = _read_project(_rows(wb["รวมทั้งโครงการ"]), phases)
    for p in phases:
        m.phases[p].update(par[p])

    # checks of the schedule against the project summary (warnings, never refusals)
    for p in phases:
        per, ph = m.periods[p], m.phases[p]
        sums = {k: sum(r[k] or 0.0 for r in per) for k in ("min_fee_thb", "depreciation_thb", "interest_thb")}
        for k, want in (("min_fee_thb", "min_fee_thb"), ("depreciation_thb", "rou_initial_thb"), ("interest_thb", "deferred_interest_thb")):
            if not _close(sums[k], ph[want], 10.0):
                m.warnings.append(f"ระยะ{p}: Σ {k} {sums[k]:,.2f} ≠ รวมทั้งโครงการ {want} {ph[want]:,.2f}")
        if ph["start_day"] and per[0]["month"] != ph["start_day"].replace(day=1):
            m.warnings.append(f"ระยะ{p}: first period {per[0]['month']} ≠ start {ph['start_day']}")
    if fy_tot:
        agg: Dict[int, Dict[str, float]] = defaultdict(lambda: {"interest": 0.0, "depreciation": 0.0})
        for per in m.periods.values():
            for r in per:
                agg[r["fiscal_year"]]["interest"] += r["interest_thb"] or 0.0
                agg[r["fiscal_year"]]["depreciation"] += r["depreciation_thb"] or 0.0
        for fy, tot in fy_tot.items():
            for k in ("interest", "depreciation"):
                if not _close(agg.get(fy, {}).get(k, 0.0), tot[k], 10.0):
                    m.warnings.append(f"รวมทั้งโครงการ ข: FY{fy} {k} {tot[k]:,.2f} ≠ Σ schedule {agg.get(fy, {}).get(k, 0.0):,.2f}")

    if "วงเงินโครงการ" in names:
        m.project_budget_thb = _label_value(_rows(wb["วงเงินโครงการ"]), "วงเงินโครงการตามเอกสาร (ไม่รวม VAT)")
    fee_sum = sum(m.phases[p]["min_fee_thb"] for p in phases)
    if m.project_budget_thb is not None and not _close(fee_sum, m.project_budget_thb, 10.0):
        m.warnings.append(f"Σ phase minimum fee {fee_sum:,.2f} ≠ project budget {m.project_budget_thb:,.2f}")
    if "รายได้ขั้นต่ำ_สถานี" in names:
        rows = _rows(wb["รายได้ขั้นต่ำ_สถานี"])
        try:
            h, cols = _find_header(rows, [f"ระยะ {p}" for p in phases], "รายได้ขั้นต่ำ_สถานี")
            row = next((r for r in rows[h + 1:] if any(_txt(c) == "ค่าไฟขั้นต่ำ 20 ปี รวมทั้งระยะ" for c in r)), None)
            for p in phases:
                v = _num(_cell(row, cols[f"ระยะ {p}"])) if row else None
                if not _close(v, m.phases[p]["min_fee_thb"], 10.0):
                    m.warnings.append(f"รายได้ขั้นต่ำ_สถานี: phase {p} minimum fee {v} ≠ รวมทั้งโครงการ")
        except ModelError as exc:
            m.warnings.append(str(exc))

    for n in sorted(x for x in names if x.startswith("ประเมินใหม่")):
        rm = _read_remeasure(_rows(wb[n]), n)
        month = rm["assessed_on"].replace(day=1)
        match = [p for p in phases if any(r["month"] == month and _close(r["closing_thb"], rm["book_liability_thb"]) for r in m.periods[p])]
        if len(match) != 1:
            m.warnings.append(f"{n}: book liability matches {len(match)} phase schedules at {month:%Y-%m}; sheet skipped")
            continue
        named = re.search(r"ระยะ(\d)$", n)
        if named and int(named.group(1)) != match[0]:
            m.warnings.append(f"{n}: named phase {named.group(1)} but the liability is phase {match[0]}'s; sheet skipped")
            continue
        if match[0] in m.remeasurements:
            m.warnings.append(f"{n}: phase {match[0]} already read from {m.remeasurements[match[0]]['sheet']}; sheet skipped")
            continue
        d = rm.get("difference_thb")
        if d is not None and not _close(rm["book_liability_thb"] - rm["new_liability_thb"], d):
            m.warnings.append(f"{n}: book − remeasured ≠ the sheet's difference")
        m.remeasurements[match[0]] = rm

    if "รายได้รายเดือน" in names:
        _read_revenue(_rows(wb["รายได้รายเดือน"]), m)
    else:
        m.warnings.append("no sheet รายได้รายเดือน: no revenue profile")
    if "ระยะ3-4_สถานี" in names:
        _read_rollout(_rows(wb["ระยะ3-4_สถานี"]), m)
    else:
        m.warnings.append("no sheet ระยะ3-4_สถานี: no rollout list")
    return m


# ---------------------------------------------------------------- import


def import_model(db: Session, m: Model) -> Dict[str, Any]:
    """Replace every TFRS 16 row with the model's, in one transaction."""
    try:
        for t in (Tfrs16Period, Tfrs16Remeasurement, Tfrs16RevenueMonth, Tfrs16RolloutStation, Tfrs16Phase, Tfrs16Import):
            db.execute(delete(t))
        db.add(Tfrs16Import(id=1, source=m.source, project_budget_thb=m.project_budget_thb, revenue_case=m.revenue_case,
                            revenue_price_thb_kwh=m.revenue_price, rollout_note=m.rollout_note, warnings=list(m.warnings)))
        for p, ph in m.phases.items():
            db.add(Tfrs16Phase(phase=p, **ph))
            for r in m.periods[p]:
                db.add(Tfrs16Period(phase=p, **r))
        for p, rm in m.remeasurements.items():
            db.add(Tfrs16Remeasurement(phase=p, **rm))
        fy_pos = {mo: i + 1 for i, mo in enumerate(m.revenue_fy_order)}
        for p, vals in m.revenue.items():
            for mo, v in enumerate(vals, start=1):
                db.add(Tfrs16RevenueMonth(phase=p, month=mo, fy_order=fy_pos.get(mo, mo), revenue_thb=v))
        for s in m.stations:
            db.add(Tfrs16RolloutStation(**s))
        db.commit()
    except Exception:
        db.rollback()
        raise
    return {
        "source": m.source,
        "phases": len(m.phases),
        "periods": sum(len(v) for v in m.periods.values()),
        "remeasurements": sorted(m.remeasurements),
        "revenue_phases": sorted(m.revenue),
        "rollout_stations": len(m.stations),
        "min_fee_total_thb": round(sum(ph["min_fee_thb"] for ph in m.phases.values()), 2),
        "project_budget_thb": m.project_budget_thb,
        "funnel": _funnel([s for s in m.stations])["total"],
        "warnings": m.warnings,
    }


# ---------------------------------------------------------------- read (API)


def _r(v: Optional[float], n: int = 2) -> Optional[float]:
    return None if v is None else round(v, n)


def _meta(db: Session) -> Optional[Tfrs16Import]:
    return db.get(Tfrs16Import, 1)


def _head(imp: Optional[Tfrs16Import]) -> Dict[str, Any]:
    return {
        "imported": imp is not None,
        "source": imp.source if imp else None,
        "imported_at": imp.imported_at.isoformat() if imp else None,
        "labels": LABELS,
    }


def _phase_out(p: Tfrs16Phase) -> Dict[str, Any]:
    return {
        "phase": p.phase, "estimated": p.estimated, "stations": p.stations, "kwp": _r(p.kwp),
        "start_day": p.start_day.isoformat() if p.start_day else None, "end_day": p.end_day.isoformat() if p.end_day else None,
        "discount_rate": p.discount_rate, "min_fee_thb": _r(p.min_fee_thb), "kwh_20y": _r(p.kwh_20y, 0),
        "rou_initial_thb": _r(p.rou_initial_thb), "deferred_interest_thb": _r(p.deferred_interest_thb),
    }


def schedule(db: Session) -> Dict[str, Any]:
    """Every phase's monthly schedule, the all-phase month totals and the fiscal-year totals."""
    out = _head(_meta(db))
    phases = list(db.scalars(select(Tfrs16Phase).order_by(Tfrs16Phase.phase)))
    rows = list(db.scalars(select(Tfrs16Period).order_by(Tfrs16Period.phase, Tfrs16Period.period)))
    by_phase: Dict[int, List[Tfrs16Period]] = defaultdict(list)
    for r in rows:
        by_phase[r.phase].append(r)

    def principal(r: Tfrs16Period) -> Optional[float]:
        return None if r.payment_thb is None or r.interest_thb is None else r.payment_thb - r.interest_thb

    out["phases"] = [
        {**_phase_out(p), "periods": [
            {"period": r.period, "month": r.month.strftime("%Y-%m"), "fiscal_year": r.fiscal_year, "contract_year": r.contract_year,
             "min_fee_thb": _r(r.min_fee_thb), "kwh": _r(r.kwh, 0), "opening_thb": _r(r.opening_thb), "interest_thb": _r(r.interest_thb),
             "payment_thb": _r(r.payment_thb), "principal_thb": _r(principal(r)), "closing_thb": _r(r.closing_thb),
             "depreciation_thb": _r(r.depreciation_thb), "rou_net_thb": _r(r.rou_net_thb)}
            for r in by_phase.get(p.phase, [])]}
        for p in phases
    ]
    month_tot: Dict[date, Dict[str, Any]] = {}
    for r in rows:
        t = month_tot.setdefault(r.month, {"liability_thb": 0.0, "rou_net_thb": 0.0, "phases": []})
        t["liability_thb"] += r.closing_thb or 0.0
        t["rou_net_thb"] += r.rou_net_thb or 0.0
        t["phases"].append(r.phase)
    out["total"] = [{"month": mo.strftime("%Y-%m"), "liability_thb": _r(t["liability_thb"]), "rou_net_thb": _r(t["rou_net_thb"]), "phases": t["phases"]}
                    for mo, t in sorted(month_tot.items())]
    fy: Dict[int, Dict[str, Any]] = {}
    for r in rows:
        t = fy.setdefault(r.fiscal_year, {"interest_thb": 0.0, "principal_thb": 0.0, "depreciation_thb": 0.0, "min_fee_thb": 0.0, "months": defaultdict(int)})
        t["interest_thb"] += r.interest_thb or 0.0
        t["principal_thb"] += principal(r) or 0.0
        t["depreciation_thb"] += r.depreciation_thb or 0.0
        t["min_fee_thb"] += r.min_fee_thb or 0.0
        t["months"][r.phase] += 1
    out["fiscal_years"] = [
        {"fiscal_year": y, **{k: _r(t[k]) for k in ("interest_thb", "principal_thb", "depreciation_thb", "min_fee_thb")},
         "expense_thb": _r(t["interest_thb"] + t["depreciation_thb"]),
         "months_by_phase": {str(p): n for p, n in sorted(t["months"].items())},
         "partial": any(n < 12 for n in t["months"].values())}
        for y, t in sorted(fy.items())
    ]
    return out


def _funnel(stations: List[Any]) -> Dict[str, Any]:
    def g(s: Any, k: str) -> Any:
        return s[k] if isinstance(s, dict) else getattr(s, k)

    def count(xs: List[Any]) -> Dict[str, int]:
        return {"stations": len(xs), "fee_paid": sum(1 for s in xs if g(s, "fee_paid")),
                "interconnected": sum(1 for s in xs if g(s, "interconnected")), "first_sync": sum(1 for s in xs if g(s, "first_sync") is not None)}

    phases = sorted({g(s, "phase") for s in stations})
    return {"total": count(stations), "phases": [{"phase": p, **count([s for s in stations if g(s, "phase") == p])} for p in phases]}


def summary(db: Session) -> Dict[str, Any]:
    """Phase parameters, minimum fees, remeasurements, revenue profile and the rollout funnel."""
    imp = _meta(db)
    out = _head(imp)
    phases = list(db.scalars(select(Tfrs16Phase).order_by(Tfrs16Phase.phase)))
    out["phases"] = [_phase_out(p) for p in phases]
    fees = [p.min_fee_thb for p in phases]
    out["min_fee_total_thb"] = _r(sum(f for f in fees if f is not None)) if fees and None not in fees else None
    out["project_budget_thb"] = _r(imp.project_budget_thb) if imp else None
    out["warnings"] = list(imp.warnings or []) if imp else []
    out["remeasurements"] = [
        {"phase": r.phase, "assessed_on": r.assessed_on.isoformat() if r.assessed_on else None, "book_liability_thb": _r(r.book_liability_thb),
         "remaining_fee_thb": _r(r.remaining_fee_thb), "old_deferred_interest_thb": _r(r.old_deferred_interest_thb),
         "production_share": r.production_share, "revised_fee_thb": _r(r.revised_fee_thb), "new_liability_thb": _r(r.new_liability_thb),
         "new_deferred_interest_thb": _r(r.new_deferred_interest_thb), "difference_thb": _r(r.difference_thb),
         "difference_share": r.difference_share, "threshold_share": r.threshold_share, "decision": r.decision, "account": r.account, "sheet": r.sheet}
        for r in db.scalars(select(Tfrs16Remeasurement).order_by(Tfrs16Remeasurement.phase))
    ]
    rev = list(db.scalars(select(Tfrs16RevenueMonth).order_by(Tfrs16RevenueMonth.phase, Tfrs16RevenueMonth.fy_order)))
    order = [r.month for r in sorted({r.fy_order: r for r in rev}.values(), key=lambda r: r.fy_order)]
    by_phase: Dict[int, Dict[int, Optional[float]]] = defaultdict(dict)
    for r in rev:
        by_phase[r.phase][r.month] = r.revenue_thb
    out["revenue"] = {
        "case": imp.revenue_case if imp else None,
        "price_thb_kwh": imp.revenue_price_thb_kwh if imp else None,
        "months": order,  # calendar months in contract-year order (Oct … Sep)
        "phases": [{"phase": p, "revenue_thb": [_r(v.get(mo)) for mo in order],
                    "total_thb": _r(sum(x for x in v.values() if x is not None)) if None not in v.values() else None}
                   for p, v in sorted(by_phase.items())],
    }
    stations = list(db.scalars(select(Tfrs16RolloutStation).order_by(Tfrs16RolloutStation.phase, Tfrs16RolloutStation.seq)))
    statuses: Dict[str, int] = defaultdict(int)
    for s in stations:
        statuses[s.interconnect_status or "—"] += 1
    out["rollout"] = {"note": imp.rollout_note if imp else None, **_funnel(stations),
                      "statuses": [{"status": k, "stations": n} for k, n in sorted(statuses.items(), key=lambda kv: -kv[1])]}
    return out


def rollout(db: Session) -> Dict[str, Any]:
    """The phase 3-4 station list as the workbook gives it."""
    out = _head(_meta(db))
    out["stations"] = [
        {"phase": s.phase, "seq": s.seq, "name": s.name, "kwp": _r(s.kwp), "interconnect_status": s.interconnect_status,
         "fee_thb": _r(s.fee_thb), "fee_paid": s.fee_paid, "interconnected": s.interconnected,
         "first_sync": s.first_sync.isoformat() if s.first_sync else None}
        for s in db.scalars(select(Tfrs16RolloutStation).order_by(Tfrs16RolloutStation.phase, Tfrs16RolloutStation.seq))
    ]
    return out


def main(argv: Optional[List[str]] = None) -> int:
    from app.db.session import SessionLocal, engine, ensure_schema

    ap = argparse.ArgumentParser(prog="python -m app.services.tfrs16", description=__doc__.split("\n\n")[0])
    sub = ap.add_subparsers(dest="cmd", required=True)
    imp = sub.add_parser("import", help="replace the TFRS 16 tables with the model workbook's figures")
    imp.add_argument("--model", required=True, type=Path)
    a = ap.parse_args(argv)
    ensure_schema(engine)
    try:
        m = read_model(a.model)
    except ModelError as exc:
        print(f"import refused: {exc}")
        return 1
    with SessionLocal() as db:
        print(json.dumps(import_model(db, m), ensure_ascii=False, indent=1, default=str))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
