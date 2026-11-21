"""Monthly expected energy of the PWA report sites from the TFRS 16 / PVsyst model workbook
(docs/plans/pwa-meter-daily.md §3.8). Both figures are **modelled**, never measured.

The workbook (`Solar-TFRS16-Model-PVsyst-ระยะ1-4.xlsx`) gives, per station:
- `PVsyst_ระยะ1` / `PVsyst_ระยะ2`: PVsyst P50 E_Grid per calendar month (MWh), the station's PVsyst
  kWp, keyed by `ลำดับ` (= `pwa_meter_sites.pvsyst_seq`).
- `ประมาณการ_kWh`: phase 1's contract estimate per station per month (kWh), keyed by `ลำดับ`
  (= `contract_seq`), for the months the sheet covers.
- `PVsyst_ระยะ2` also states phase 2's first-year contract specific yield (kWh/kWp/yr).

Rules (criteria file `expected_energy`; checked on 21 Nov 2026 against all 1,440 site-months of the
imported report, every one within 0.006 kWh/day):
- PVsyst kWh/day = the month's MWh × 1000 × (site kWp ÷ PVsyst kWp) ÷ days in the month. The kWp
  ratio is 1 except where the contract kWp differs from the PVsyst run's.
- Phase 1 contract kWh/day = the sheet's month ÷ days; a month the sheet does not cover = the same
  calendar month of the latest covered year × `contract_degradation_per_year` per year in between.
- Phase 2 contract kWh/day = kWp × the first-year specific yield × the month's share of phase 2's
  fleet PVsyst year ÷ days, × `contract_degradation_per_year` per full contract year since
  `phase2_contract_start`.
A figure the workbook does not give stays null; nothing is made up to fill it.
"""

from __future__ import annotations

import calendar
import io
from dataclasses import dataclass, field
from datetime import date, datetime
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Tuple, Union

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db.models import PwaMeterExpected, PwaMeterSite

MONTHS_TH = ("ม.ค.", "ก.พ.", "มี.ค.", "เม.ย.", "พ.ค.", "มิ.ย.", "ก.ค.", "ส.ค.", "ก.ย.", "ต.ค.", "พ.ย.", "ธ.ค.")
SPEC2_LABEL = "ผลผลิตจำเพาะตามสัญญา ระยะ 2 ปีแรก"


class ModelError(ValueError):
    """The workbook is not the model this reader knows; the message says what is missing."""


@dataclass
class Model:
    source: str
    pvsyst: Dict[Tuple[int, int], Tuple[Optional[float], List[Optional[float]]]] = field(default_factory=dict)  # (phase, seq) -> (kWp, MWh × 12)
    p1_contract: Dict[int, Dict[date, float]] = field(default_factory=dict)  # seq -> {month: kWh}
    spec2: Optional[float] = None  # phase 2 first-year contract kWh/kWp/yr


def _num(v: Any) -> Optional[float]:
    return float(v) if isinstance(v, (int, float)) and not isinstance(v, bool) else None


def _rows(ws) -> List[Tuple[Any, ...]]:
    return [tuple(r) for r in ws.iter_rows(values_only=True)]


def _header(rows: List[Tuple[Any, ...]], word: str, sheet: str) -> int:
    for i, r in enumerate(rows):
        if any(isinstance(c, str) and c.strip() == word for c in r):
            return i
    raise ModelError(f"sheet {sheet}: no header row with {word!r}")


def read_model(src: Union[str, Path, bytes], source: Optional[str] = None) -> Model:
    import openpyxl

    data = io.BytesIO(src) if isinstance(src, bytes) else src
    wb = openpyxl.load_workbook(data, read_only=True, data_only=True)
    m = Model(source=source or (Path(src).name if not isinstance(src, bytes) else "model.xlsx"))
    need = ["PVsyst_ระยะ1", "PVsyst_ระยะ2", "ประมาณการ_kWh"]
    missing = [n for n in need if n not in wb.sheetnames]
    if missing:
        raise ModelError(f"the workbook has no sheet {', '.join(missing)} (use the model with the ประมาณการ_kWh sheet)")
    for ph in (1, 2):
        name = f"PVsyst_ระยะ{ph}"
        rows = _rows(wb[name])
        h = _header(rows, "ลำดับ", name)
        hdr = [c.strip() if isinstance(c, str) else c for c in rows[h]]
        try:
            c_seq, c_kwp, c_jan = hdr.index("ลำดับ"), hdr.index("kWp"), hdr.index(MONTHS_TH[0])
        except ValueError as exc:
            raise ModelError(f"sheet {name}: header lacks ลำดับ / kWp / ม.ค.") from exc
        if [hdr[c_jan + k] for k in range(12)] != list(MONTHS_TH):
            raise ModelError(f"sheet {name}: the 12 month columns are not ม.ค. … ธ.ค. in order")
        for r in rows[h + 1:]:
            seq = _num(r[c_seq]) if c_seq < len(r) else None
            if seq is None:
                continue
            m.pvsyst[(ph, int(seq))] = (_num(r[c_kwp]), [_num(r[c_jan + k]) for k in range(12)])
        if ph == 2:
            for r in rows:
                for j, c in enumerate(r):
                    if isinstance(c, str) and c.strip().startswith(SPEC2_LABEL):
                        m.spec2 = next((_num(x) for x in r[j + 1:] if _num(x) is not None), None)
    rows = _rows(wb["ประมาณการ_kWh"])
    h = _header(rows, "ลำดับ", "ประมาณการ_kWh")
    hdr = rows[h]
    c_seq = [c.strip() if isinstance(c, str) else c for c in hdr].index("ลำดับ")
    months = [(j, c.date().replace(day=1)) for j, c in enumerate(hdr) if isinstance(c, datetime)]
    if not months:
        raise ModelError("sheet ประมาณการ_kWh: no month columns in the header row")
    for r in rows[h + 1:]:
        seq = _num(r[c_seq]) if c_seq < len(r) else None
        if seq is None:
            continue
        m.p1_contract[int(seq)] = {mo: v for j, mo in months if j < len(r) and (v := _num(r[j])) is not None}
    if m.spec2 is None:
        raise ModelError(f"sheet PVsyst_ระยะ2: no {SPEC2_LABEL!r} figure")
    return m


def _months(start: date, end: date) -> Iterable[date]:
    y, mo = start.year, start.month
    while (y, mo) <= (end.year, end.month):
        yield date(y, mo, 1)
        y, mo = (y + 1, 1) if mo == 12 else (y, mo + 1)


def _criteria() -> Dict[str, Any]:
    from app.services.pwa_meter import criteria

    return criteria()["expected_energy"]


def expected_rows(model: Model, sites: List[PwaMeterSite], start: date, end: date) -> Tuple[List[Dict[str, Any]], List[str]]:
    """Expected kWh/day per site and month in [start, end] (months), and warnings for what the
    model does not give (left null)."""
    c = _criteria()
    deg = c["contract_degradation_per_year"]
    p2_start = date.fromisoformat(c["phase2_contract_start"])
    season2 = [sum((mw[k] or 0.0) for (ph, _), (_, mw) in model.pvsyst.items() if ph == 2) for k in range(12)]
    year2 = sum(season2)
    spec2 = model.spec2
    out: List[Dict[str, Any]] = []
    warn: List[str] = []
    for s in sites:
        pv = model.pvsyst.get((s.phase, s.pvsyst_seq)) if s.pvsyst_seq is not None else None
        if s.phase in (1, 2) and pv is None:
            warn.append(f"{s.site_id}: no PVsyst row {s.pvsyst_seq} in PVsyst_ระยะ{s.phase}")
        series = model.p1_contract.get(s.contract_seq) if (s.phase == 1 and s.contract_seq is not None) else None
        if s.phase == 1 and series is None:
            warn.append(f"{s.site_id}: no contract row {s.contract_seq} in ประมาณการ_kWh")
        for mo in _months(start, end):
            nd = calendar.monthrange(mo.year, mo.month)[1]
            pv_day = None
            mwh = pv[1][mo.month - 1] if pv else None
            if pv and mwh is not None and pv[0]:
                pv_day = mwh * 1000 * (s.kwp / pv[0]) / nd
            con_day, basis = None, None
            if s.phase == 1 and series:
                if mo in series:
                    con_day, basis = series[mo] / nd, "contract sheet"
                else:
                    back = next((k for k in range(1, 40) if date(mo.year - k, mo.month, 1) in series), None)
                    if back is not None:
                        con_day = series[date(mo.year - back, mo.month, 1)] * deg ** back / nd
                        basis = f"{mo.year - back} × {deg}^{back}"
            elif s.phase == 2 and year2 > 0 and spec2 and mo >= p2_start:
                years = (mo.year - p2_start.year) * 12 + (mo.month - p2_start.month)
                k = years // 12
                con_day = s.kwp * spec2 * season2[mo.month - 1] / year2 / nd * deg ** k
                basis = "kWp × yield × phase-2 season" + (f" × {deg}^{k}" if k else "")
            out.append({"site_id": s.site_id, "month": mo, "contract_kwh_day": None if con_day is None else round(con_day, 2),
                        "pvsyst_kwh_day": None if pv_day is None else round(pv_day, 2), "basis": basis, "source": model.source})
    return out, warn


def import_expected(db: Session, model: Model, start: date, end: date) -> Dict[str, Any]:
    """Upsert the expected months of every report site; returns counts and warnings."""
    sites = list(db.scalars(select(PwaMeterSite).order_by(PwaMeterSite.site_id)))
    rows, warn = expected_rows(model, sites, start, end)
    have = {(e.site_id, e.month): e for e in db.scalars(select(PwaMeterExpected).where(PwaMeterExpected.month >= start.replace(day=1), PwaMeterExpected.month <= end))}
    added = updated = 0
    try:
        for r in rows:
            cur = have.get((r["site_id"], r["month"]))
            if cur is None:
                db.add(PwaMeterExpected(**r))
                added += 1
            else:
                for k in ("contract_kwh_day", "pvsyst_kwh_day", "basis", "source"):
                    setattr(cur, k, r[k])
                updated += 1
        db.commit()
    except Exception:
        db.rollback()
        raise
    return {"months_added": added, "months_updated": updated, "sites": len(sites), "warnings": warn}


def lookup(db: Session, keys: Iterable[Tuple[str, date]]) -> Dict[Tuple[str, date], PwaMeterExpected]:
    """Expected rows for (site_id, month-first-day) keys."""
    keys = set(keys)
    if not keys:
        return {}
    months = {k[1] for k in keys}
    q = select(PwaMeterExpected).where(PwaMeterExpected.month.in_(months), PwaMeterExpected.site_id.in_({k[0] for k in keys}))
    return {(e.site_id, e.month): e for e in db.scalars(q) if (e.site_id, e.month) in keys}


def check_against_days(db: Session) -> Dict[str, Any]:
    """Compare the expected table with the contract / PVsyst stored on imported days (largest
    |difference| in kWh/day): a check that the model and the days agree."""
    from app.db.models import PwaMeterDay

    exp = {(e.site_id, e.month): e for e in db.scalars(select(PwaMeterExpected))}
    worst = {"contract": 0.0, "pvsyst": 0.0}
    n = missing = 0
    for d in db.scalars(select(PwaMeterDay)):
        e = exp.get((d.site_id, d.day.replace(day=1)))
        if e is None:
            missing += 1
            continue
        n += 1
        if d.contract_kwh is not None and e.contract_kwh_day is not None:
            worst["contract"] = max(worst["contract"], abs(d.contract_kwh - e.contract_kwh_day))
        if d.pvsyst_kwh is not None and e.pvsyst_kwh_day is not None:
            worst["pvsyst"] = max(worst["pvsyst"], abs(d.pvsyst_kwh - e.pvsyst_kwh_day))
    return {"days_compared": n, "days_without_expected": missing, "max_diff_kwh_day": {k: round(v, 3) for k, v in worst.items()}}
