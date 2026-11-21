"""One analysis table from the cleaned PWA daily report workbooks: only the columns used for
calculation and decisions, each value read with the import's own rules.

    PYTHONPATH=backend uv run python backend/scripts/build_pwa_meter_analysis.py \
        "billing/clean/Phase 1 (clean).xlsx" "billing/clean/Phase 2 (clean).xlsx" --out billing/clean

Rows: one per site and report day from the contract start (criteria `report_import.skip_before`).
Readings follow `pwa_meter.import_report`: phase 2 from the system pull (Cewe / Growatt), phase 1 from
the typed table (the pull where a table cell is blank); rows matched to `pwa_meter_sites` by comp_id,
meter number, then name; on a loss_inv / loss_meter day the reading under 1 kWh is empty, never 0.
Weather is folded to clear / cloudy / rain by the criteria keywords. Extra columns the database does
not hold: the proposal estimate (หน่วยประมาณการจากเล่มข้อเสนอ = the proposal's annual kWh ÷ 365,
modelled; 0 = not entered → empty) and the Growatt pull's own status / API error message.
`contract_kwh` is the app's modelled contract figure stored for that day (`pwa_meter_days`).

Out: `pwa_meter_analysis.xlsx` (days with ratio formulas, sites, columns, issues) and `pwa_meter_analysis.csv`.
"""

from __future__ import annotations

import argparse
import re
from datetime import date
from pathlib import Path
from typing import Any, Dict, List, Optional

import openpyxl
import pandas as pd
from openpyxl.styles import Font, PatternFill
from openpyxl.utils import get_column_letter
from sqlalchemy import select

from app.db.models import PwaMeterDay, PwaMeterSite
from app.db.session import SessionLocal
from app.services.pwa_meter import _Matcher, _readings, criteria, weather_of
from app.services.pwa_meter_report import parse_workbook

ESTIMATE = "หน่วยประมาณการ"


def _hdr(v: Any) -> str:
    return re.sub(r"\s+", " ", str(v or "")).strip()


def _num(v: Any) -> Optional[float]:
    if isinstance(v, bool) or v is None:
        return None
    if isinstance(v, (int, float)):
        return float(v)
    try:
        return float(str(v).replace(",", "").strip())
    except ValueError:
        return None  # '#NUM!', 'ไม่ขึ้น', ''


def extras(path: Path) -> Dict[tuple, dict]:
    """(sheet, row) → proposal estimate and the Growatt pull's status / msg, found by header per sheet."""
    out: Dict[tuple, dict] = {}
    wb = openpyxl.load_workbook(path, read_only=True, data_only=True)
    for ws in wb.worksheets:
        rows = list(ws.iter_rows(values_only=True))
        if len(rows) < 3:
            continue
        h = [_hdr(v) for v in rows[1]]
        est = next((j for j, v in enumerate(h) if v.startswith(ESTIMATE)), None)
        st = h.index("status") if "status" in h else None
        msg = h.index("msg") if "msg" in h else None
        for i, r in enumerate(rows[2:], start=3):
            g = lambda j: r[j] if j is not None and j < len(r) else None  # noqa: E731
            out[(ws.title, i)] = {"est": _num(g(est)), "pull_status": g(st), "pull_msg": g(msg)}
    return out


def build(files: List[Path]) -> tuple:
    rules = criteria()["report_import"]
    skip_before = {int(k): date.fromisoformat(v) for k, v in rules["skip_before"].items()}
    curt_kw = criteria()["curtailment"]["note_keyword"]
    db = SessionLocal()
    sites = list(db.scalars(select(PwaMeterSite)))
    stored = {(d.site_id, d.day): d for d in db.scalars(select(PwaMeterDay))}
    matcher = _Matcher(sites)
    rows: List[dict] = []
    issues: List[dict] = []
    for path in files:
        ex = extras(path)
        for sh in parse_workbook(path.read_bytes(), path.name, date.today()):
            if sh.day is None:
                issues.append({"file": path.name, "sheet": sh.sheet, "site_id": None, "issue": "sheet has no date: skipped"})
                continue
            p2 = matcher.p2_sheet(sh.rows)
            for r in sh.rows:
                source = "pull" if r.table is not None else "table"
                if not p2 and r.table is not None:
                    meter, inv, weather, _ = r.table
                    r.meter_kwh = r.meter_kwh if meter is None else meter
                    r.inverter_kwh = r.inverter_kwh if inv is None else inv
                    r.weather = weather or r.weather
                    source = "table"
                site, how = matcher.match(r, p2)
                if site is None and sh.day < min(skip_before.values()):
                    continue  # pre-contract sheet: not in the table, so not an issue
                if site is None:
                    issues.append({"file": path.name, "sheet": sh.sheet, "site_id": None, "issue": f"row {r.row_no} {r.name!r}: {how}"})
                    continue
                if sh.day < skip_before.get(site.phase, date.min):
                    continue
                meter, inv, status = _readings(r.meter_kwh, r.inverter_kwh)
                e = ex.get((sh.sheet, r.row_no), {})
                est = e.get("est")
                if est is not None and est <= 0:
                    issues.append({"file": path.name, "sheet": sh.sheet, "site_id": site.site_id, "issue": f"proposal estimate {est} → empty"})
                    est = None
                ps = e.get("pull_status")
                sd = stored.get((site.site_id, sh.day))
                rows.append({
                    "day": sh.day, "phase": site.phase, "site_id": site.site_id, "site_name": site.name, "region": site.region,
                    "growatt_plant_id": site.growatt_plant_id, "kwp": site.kwp,
                    "meter_kwh": meter, "inverter_kwh": inv, "reading_source": source, "status": status,
                    "proposal_kwh": round(est, 2) if est is not None else None,
                    "contract_kwh": round(sd.contract_kwh, 2) if sd and sd.contract_kwh is not None else None,
                    "weather": weather_of(r.weather), "curtailment_note": bool(r.note and curt_kw in r.note), "note": r.note,
                    "growatt_pull_ok": None if ps is None else str(ps).strip().lower() == "true",
                    "growatt_api_error": (str(e["pull_msg"]).strip() or None) if e.get("pull_msg") else None,
                    "_sheet": f"{path.name}::{sh.sheet}", "_row": r.row_no,
                    "_db_meter": sd.meter_kwh if sd else None, "_db_inv": sd.inverter_kwh if sd else None, "_in_db": sd is not None,
                })
    db.close()
    return pd.DataFrame(rows), pd.DataFrame(issues, columns=["file", "sheet", "site_id", "issue"]), sites


COLUMNS = [
    ("day", "Report day", "sheet name / title"),
    ("phase", "Project phase 1–2", "pwa_meter_sites"),
    ("site_id", "App site id (P1-xx, P2-<comp_id>)", "matched as the import does"),
    ("site_name", "Site name", "pwa_meter_sites"),
    ("region", "กปภ. เขต", "pwa_meter_sites"),
    ("growatt_plant_id", "Growatt plant id: join key to the Growatt data", "pwa_meter_sites"),
    ("kwp", "Installed kWp", "pwa_meter_sites"),
    ("meter_kwh", "Cewe meter kWh of the day: billed energy (measured)", "P1 typed table หน่วยจากมิเตอร์, P2 system pull Cewe"),
    ("inverter_kwh", "Inverter kWh of the day (measured, Growatt)", "P1 typed table หน่วยจากอินเวอร์เตอร์, P2 system pull Growatt"),
    ("reading_source", "Where the two readings came from: table / pull", "import rule"),
    ("status", "ok / outage (both < 1 kWh) / loss_inv / loss_meter (that reading < 1 kWh → empty)", "criteria day_status"),
    ("proposal_kwh", "MODELLED: proposal estimate per day = annual kWh ÷ 365 (หน่วยประมาณการจากเล่มข้อเสนอ)", "typed table"),
    ("contract_kwh", "MODELLED: app contract kWh/day (TFRS 16 model month shape, 0.993 per contract year)", "pwa_meter_days"),
    ("weather", "clear / cloudy / rain (สภาพอากาศ, typos folded)", "criteria weather_keywords"),
    ("curtailment_note", "หมายเหตุ says the system was throttled to PWA's load", "criteria curtailment.note_keyword"),
    ("note", "หมายเหตุ as written", "typed table"),
    ("growatt_pull_ok", "The system pull's status (False = Growatt not read that day)", "pull column status"),
    ("growatt_api_error", "Growatt API error of the pull (10012 = rate limit, …)", "pull column msg"),
    ("yield_kwh_per_kwp", "DERIVED: meter_kwh ÷ kwp", "formula"),
    ("inv_vs_meter_pct", "DERIVED: (inverter − meter) ÷ meter × 100, only on ok days", "formula"),
    ("meter_vs_proposal_pct", "DERIVED: meter ÷ proposal × 100 (modelled base)", "formula"),
    ("meter_vs_contract_pct", "DERIVED: meter ÷ contract × 100 (modelled base)", "formula"),
]


def write(df: pd.DataFrame, issues: pd.DataFrame, sites_db, out: Path) -> None:
    keep = [c for c, _, _ in COLUMNS if c in df.columns]
    days = df[keep].sort_values(["day", "phase", "site_id"]).reset_index(drop=True)
    out.mkdir(parents=True, exist_ok=True)
    d2 = days.copy()
    d2["yield_kwh_per_kwp"] = (d2.meter_kwh / d2.kwp).round(3)
    ok = d2.status == "ok"  # both readings ≥ 1 kWh: a 0.3 kWh outage-day meter makes the ratio meaningless
    d2["inv_vs_meter_pct"] = ((d2.inverter_kwh - d2.meter_kwh) / d2.meter_kwh * 100).where(ok).round(2)
    d2["meter_vs_proposal_pct"] = (d2.meter_kwh / d2.proposal_kwh * 100).round(2)
    d2["meter_vs_contract_pct"] = (d2.meter_kwh / d2.contract_kwh * 100).round(2)
    d2.to_csv(out / "pwa_meter_analysis.csv", index=False, encoding="utf-8-sig")

    # sites: one row each, with the proposal year as written (per day × 365) and when it changed
    prop = df.dropna(subset=["proposal_kwh"]).sort_values("day")
    srows = []
    for s in sorted(sites_db, key=lambda s: s.site_id):
        p = prop[prop.site_id == s.site_id]
        ch = p.loc[p.proposal_kwh.ne(p.proposal_kwh.shift()), ["day", "proposal_kwh"]]
        srows.append({"site_id": s.site_id, "phase": s.phase, "site_name": s.name, "region": s.region, "kwp": s.kwp,
                      "growatt_plant_id": s.growatt_plant_id, "meter_no": s.meter_no,
                      "proposal_kwh_year": round(p.proposal_kwh.iloc[-1] * 365) if len(p) else None,
                      "proposal_changes": "; ".join(f"{d:%d.%m.%Y}: {v * 365:,.0f}" for d, v in ch.values) if len(ch) > 1 else None,
                      "report_days": int((df.site_id == s.site_id).sum())})
    sites = pd.DataFrame(srows)
    cols = pd.DataFrame(COLUMNS, columns=["column", "meaning", "source"])

    with pd.ExcelWriter(out / "pwa_meter_analysis.xlsx", engine="openpyxl") as xw:
        days.to_excel(xw, sheet_name="days", index=False)
        sites.to_excel(xw, sheet_name="sites", index=False)
        cols.to_excel(xw, sheet_name="columns", index=False)
        issues.to_excel(xw, sheet_name="issues", index=False)
        ws = xw.sheets["days"]
        c = {name: get_column_letter(i + 1) for i, name in enumerate(keep)}
        base = len(keep)
        derived = [
            ("yield_kwh_per_kwp", lambda r: f'=IF(AND(ISNUMBER({c["meter_kwh"]}{r}),{c["kwp"]}{r}>0),{c["meter_kwh"]}{r}/{c["kwp"]}{r},"")', "0.00"),
            ("inv_vs_meter_pct", lambda r: f'=IF({c["status"]}{r}="ok",({c["inverter_kwh"]}{r}-{c["meter_kwh"]}{r})/{c["meter_kwh"]}{r},"")', "0.0%"),
            ("meter_vs_proposal_pct", lambda r: f'=IF(AND(ISNUMBER({c["meter_kwh"]}{r}),N({c["proposal_kwh"]}{r})>0),{c["meter_kwh"]}{r}/{c["proposal_kwh"]}{r},"")', "0.0%"),
            ("meter_vs_contract_pct", lambda r: f'=IF(AND(ISNUMBER({c["meter_kwh"]}{r}),N({c["contract_kwh"]}{r})>0),{c["meter_kwh"]}{r}/{c["contract_kwh"]}{r},"")', "0.0%"),
        ]
        n = len(days) + 1
        for k, (name, f, fmt) in enumerate(derived, start=1):
            col = base + k
            ws.cell(row=1, column=col, value=name)
            for r in range(2, n + 1):
                cell = ws.cell(row=r, column=col, value=f(r))
                cell.number_format = fmt
        for r in range(2, n + 1):
            ws[f'{c["day"]}{r}'].number_format = "yyyy-mm-dd"
            for k in ("meter_kwh", "inverter_kwh", "proposal_kwh", "contract_kwh"):
                ws[f"{c[k]}{r}"].number_format = "#,##0.00"
        modelled = PatternFill("solid", fgColor="FFF2CC")
        for k in ("proposal_kwh", "contract_kwh"):
            ws[f"{c[k]}1"].fill = modelled
        for name, sheet in xw.sheets.items():
            sheet.freeze_panes = "A2"
            sheet.auto_filter.ref = sheet.dimensions
            for col in sheet.iter_cols(min_row=1, max_row=1):
                h = col[0]
                h.font = Font(name="Arial", size=10, bold=True)
                sample = [len(str(x.value)) for x in sheet[h.column_letter][1:60] if x.value is not None and not str(x.value).startswith("=")]
                sheet.column_dimensions[h.column_letter].width = min(max([len(str(h.value))] + sample) + 2, 60)
        ws_c = xw.sheets["columns"]
        ws_c.cell(row=len(COLUMNS) + 3, column=1, value="Yellow headers on 'days' are modelled, not measured. Empty = no reading or not entered, never 0.")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("files", nargs="+", type=Path)
    ap.add_argument("--out", type=Path, default=Path("billing/clean"))
    a = ap.parse_args()
    df, issues, sites = build(a.files)
    # the same readings as the database (the import of these workbooks changed nothing)
    def same(x, y):
        return (pd.isna(x) and pd.isna(y)) or (not pd.isna(x) and not pd.isna(y) and abs(x - y) < 0.011)
    off = df[[not (same(m, dm) and same(i, di)) for m, dm, i, di in zip(df.meter_kwh, df._db_meter, df.inverter_kwh, df._db_inv)]]
    print(f"rows: {len(df)} ({df.groupby('phase').size().to_dict()}), sites: {df.site_id.nunique()}, days {df.day.min()} … {df.day.max()}")
    print(f"vs database: {int(df._in_db.sum())} rows stored, {len(off)} differ in meter / inverter kWh; issues: {len(issues)}")
    if len(off):
        print(off[["day", "site_id", "meter_kwh", "_db_meter", "inverter_kwh", "_db_inv", "_sheet"]].head(10).to_string())
    write(df, issues, sites, a.out)
    print(f"wrote {a.out / 'pwa_meter_analysis.xlsx'} and .csv")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
