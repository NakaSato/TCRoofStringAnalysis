"""PWA daily meter report: import, site-days and the engineering / finance summaries
(docs/plans/pwa-meter-daily.md).

DB only. The input is the clean CSV pair made from the phases 1-2 daily reports
(`pwa_meter_sites.csv`, `pwa_meter_days.csv`); `import_csv` upserts them, so a re-import of a
longer report only adds and corrects rows. Every threshold and formula comes from
`pwa_meter_criteria.json` next to this module (the same file the team reads), never from
constants in the code.

Scope: an engineer sees the report sites whose `growatt_plant_id` is assigned to them; a site with
no Growatt plant is admin only. Fleet figures that judge a site against its peers (PI_free, the
curtailment and under-performance losses) are computed over every site of the phase, then only
the visible sites are returned.

Losses, the meter gap and the THB values are **estimated**; `contract_kwh` / `pvsyst_kwh` are
**modelled**. Missing readings stay null.

CLI (repo root):
    PYTHONPATH=backend uv run python -m app.services.pwa_meter import --sites S.csv --days D.csv
    PYTHONPATH=backend uv run python -m app.services.pwa_meter summary --start 2026-01-01
"""

from __future__ import annotations

import argparse
import csv
import json
import math
from datetime import date, timedelta
from functools import lru_cache
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Set

import pandas as pd
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db.models import GrowattPlantEnergyDay, PwaMeterDay, PwaMeterSite
from app.services.growatt_common import GrowattNotFound

CRITERIA_FILE = Path(__file__).with_name("pwa_meter_criteria.json")
STATUSES = ("ok", "outage", "loss_inv", "loss_meter")
WEATHERS = ("clear", "cloudy", "rain")
SITE_COLUMNS = ("site_id", "phase", "name", "region", "kwp", "contract_seq", "pvsyst_seq", "growatt_plant_id", "growatt_name", "growatt_kwp", "kwp_mismatch")
DAY_COLUMNS = ("day", "site_id", "meter_kwh", "inverter_kwh", "contract_kwh", "pvsyst_kwh", "status", "curtailment_note", "weather", "note")


class PwaImportError(ValueError):
    """The CSV can't be imported as it is; the message names the row and field."""


@lru_cache(maxsize=1)
def criteria() -> Dict[str, Any]:
    return json.loads(CRITERIA_FILE.read_text(encoding="utf-8"))


def classify(meter_kwh: Optional[float], inverter_kwh: Optional[float]) -> str:
    """Day status from the two readings (criteria `day_status`); a missing reading counts as 0."""
    zero = criteria()["day_status"]["zero_kwh"]
    m = meter_kwh or 0.0
    i = inverter_kwh or 0.0
    if m < zero and i < zero:
        return "outage"
    if i < zero:
        return "loss_inv"
    if m < zero:
        return "loss_meter"
    return "ok"


# ---------- import ----------

def _num(v: Any, row: str, field: str, required: bool = False) -> Optional[float]:
    if v is None or (isinstance(v, str) and v.strip() == "") or (isinstance(v, float) and math.isnan(v)):
        if required:
            raise PwaImportError(f"{row}: {field} is required")
        return None
    try:
        x = float(v)
    except (TypeError, ValueError) as exc:
        raise PwaImportError(f"{row}: {field} = {v!r} is not a number") from exc
    if math.isnan(x) or x < 0:
        raise PwaImportError(f"{row}: {field} = {v!r} must be a number ≥ 0")
    return x


def _int(v: Any, row: str, field: str) -> Optional[int]:
    x = _num(v, row, field)
    return None if x is None else int(x)


def _bool(v: Any) -> bool:
    return str(v).strip().lower() in ("1", "true", "yes", "y")


def _text(v: Any) -> Optional[str]:
    if v is None or (isinstance(v, float) and math.isnan(v)):
        return None
    s = str(v).strip()
    return s or None


def import_rows(db: Session, sites: Iterable[Dict[str, Any]], days: Iterable[Dict[str, Any]]) -> Dict[str, int]:
    """Upsert sites, then site-days keyed on (site_id, day). Everything or nothing: one bad row
    rolls the whole import back."""
    out = {"sites_added": 0, "sites_updated": 0, "days_added": 0, "days_updated": 0}
    known = {s.site_id: s for s in db.scalars(select(PwaMeterSite))}
    try:
        for n, r in enumerate(sites, start=2):
            row = f"sites row {n}"
            sid = _text(r.get("site_id"))
            if not sid:
                raise PwaImportError(f"{row}: site_id is required")
            phase = _int(r.get("phase"), row, "phase")
            if phase is None:
                raise PwaImportError(f"{row}: phase is required")
            name = _text(r.get("name"))
            if not name:
                raise PwaImportError(f"{row}: name is required")
            vals = dict(
                phase=phase, name=name, region=_text(r.get("region")), kwp=_num(r.get("kwp"), row, "kwp", required=True),
                contract_seq=_int(r.get("contract_seq"), row, "contract_seq"), pvsyst_seq=_int(r.get("pvsyst_seq"), row, "pvsyst_seq"),
                growatt_plant_id=_int(r.get("growatt_plant_id"), row, "growatt_plant_id"), growatt_name=_text(r.get("growatt_name")),
                growatt_kwp=_num(r.get("growatt_kwp"), row, "growatt_kwp"), kwp_mismatch=_bool(r.get("kwp_mismatch")),
            )
            site = known.get(sid)
            if site is None:
                site = PwaMeterSite(site_id=sid, **vals)
                db.add(site)
                known[sid] = site
                out["sites_added"] += 1
            else:
                for k, v in vals.items():
                    setattr(site, k, v)
                out["sites_updated"] += 1
        db.flush()
        rows = list(days)
        ids = {str(r.get("site_id") or "").strip() for r in rows}
        existing = {(d.site_id, d.day): d for d in db.scalars(select(PwaMeterDay).where(PwaMeterDay.site_id.in_(ids)))} if ids else {}
        seen = set()
        for n, r in enumerate(rows, start=2):
            row = f"days row {n}"
            sid = _text(r.get("site_id"))
            if sid not in known:
                raise PwaImportError(f"{row}: site_id {sid!r} is not in the sites file or the database")
            try:
                day = date.fromisoformat(str(r.get("day")).strip())
            except ValueError as exc:
                raise PwaImportError(f"{row}: day {r.get('day')!r} is not YYYY-MM-DD") from exc
            if (sid, day) in seen:
                raise PwaImportError(f"{row}: {sid} {day} appears twice")
            seen.add((sid, day))
            meter = _num(r.get("meter_kwh"), row, "meter_kwh")
            inv = _num(r.get("inverter_kwh"), row, "inverter_kwh")
            status = _text(r.get("status")) or classify(meter, inv)
            if status not in STATUSES:
                raise PwaImportError(f"{row}: status {status!r} is not one of {', '.join(STATUSES)}")
            if status != classify(meter, inv):
                raise PwaImportError(f"{row}: status {status} does not match meter {meter} / inverter {inv} (expected {classify(meter, inv)})")
            weather = _text(r.get("weather"))
            if weather is not None and weather not in WEATHERS:
                raise PwaImportError(f"{row}: weather {weather!r} is not one of {', '.join(WEATHERS)}")
            vals = dict(meter_kwh=meter, inverter_kwh=inv, contract_kwh=_num(r.get("contract_kwh"), row, "contract_kwh"),
                        pvsyst_kwh=_num(r.get("pvsyst_kwh"), row, "pvsyst_kwh"), status=status,
                        curtailment_note=_bool(r.get("curtailment_note")), weather=weather, note=_text(r.get("note")))
            cur = existing.get((sid, day))
            if cur is None:
                db.add(PwaMeterDay(site_id=sid, day=day, **vals))
                out["days_added"] += 1
            else:
                for k, v in vals.items():
                    setattr(cur, k, v)
                out["days_updated"] += 1
        db.commit()
    except Exception:
        db.rollback()
        raise
    return out


def _read_csv(path: Path) -> List[Dict[str, Any]]:
    with open(path, encoding="utf-8-sig", newline="") as fh:
        return list(csv.DictReader(fh))


def import_csv(db: Session, sites_path: Path, days_path: Path) -> Dict[str, int]:
    sites, days = _read_csv(sites_path), _read_csv(days_path)
    for label, rows, cols in (("sites", sites, SITE_COLUMNS[:5]), ("days", days, ("day", "site_id", "meter_kwh", "inverter_kwh"))):
        missing = [c for c in cols if rows and c not in rows[0]]
        if missing:
            raise PwaImportError(f"{label} file is missing column(s): {', '.join(missing)}")
    return import_rows(db, sites, days)


# ---------- reads ----------

def _visible_sites(db: Session, allowed: Optional[Set[int]]) -> List[PwaMeterSite]:
    sites = list(db.scalars(select(PwaMeterSite).order_by(PwaMeterSite.phase, PwaMeterSite.site_id)))
    if allowed is None:
        return sites
    return [s for s in sites if s.growatt_plant_id is not None and s.growatt_plant_id in allowed]


def _site_out(s: PwaMeterSite) -> Dict[str, Any]:
    return {c: getattr(s, c) for c in SITE_COLUMNS}


def list_sites(db: Session, allowed: Optional[Set[int]]) -> List[Dict[str, Any]]:
    return [_site_out(s) for s in _visible_sites(db, allowed)]


def site_days(db: Session, allowed: Optional[Set[int]], site_id: str, start: Optional[date] = None, end: Optional[date] = None) -> Dict[str, Any]:
    site = next((s for s in _visible_sites(db, allowed) if s.site_id == site_id), None)
    if site is None:
        raise GrowattNotFound(f"Site {site_id} not found")
    q = select(PwaMeterDay).where(PwaMeterDay.site_id == site_id)
    if start:
        q = q.where(PwaMeterDay.day >= start)
    if end:
        q = q.where(PwaMeterDay.day <= end)
    rows = db.scalars(q.order_by(PwaMeterDay.day)).all()
    return {"site": _site_out(site), "days": [
        {"day": r.day.isoformat(), "meter_kwh": r.meter_kwh, "inverter_kwh": r.inverter_kwh, "contract_kwh": r.contract_kwh,
         "pvsyst_kwh": r.pvsyst_kwh, "status": r.status, "curtailment_note": r.curtailment_note, "weather": r.weather, "note": r.note,
         "yield_kwh_kwp": None if r.meter_kwh is None else round(r.meter_kwh / site.kwp, 3)} for r in rows]}


def _frame(db: Session, start: Optional[date], end: Optional[date]) -> pd.DataFrame:
    q = select(PwaMeterDay.site_id, PwaMeterDay.day, PwaMeterDay.meter_kwh, PwaMeterDay.inverter_kwh, PwaMeterDay.contract_kwh,
               PwaMeterDay.pvsyst_kwh, PwaMeterDay.status, PwaMeterDay.curtailment_note, PwaMeterDay.note)
    if start:
        q = q.where(PwaMeterDay.day >= start)
    if end:
        q = q.where(PwaMeterDay.day <= end)
    df = pd.DataFrame(db.execute(q).all(), columns=["site_id", "day", "meter", "inv", "con", "pv", "status", "curt", "note"])
    sites = pd.DataFrame([(s.site_id, s.phase, s.name, s.region, s.kwp, s.growatt_plant_id) for s in db.scalars(select(PwaMeterSite))],
                         columns=["site_id", "phase", "name", "region", "kwp", "growatt_plant_id"])
    if df.empty:
        return df.assign(phase=pd.Series(dtype=int), name="", region="", kwp=0.0, growatt_plant_id=None)
    df = df.merge(sites, on="site_id", how="left")
    for c in ("meter", "inv", "con", "pv"):
        df[c] = pd.to_numeric(df[c], errors="coerce")
    df["curt"] = df.curt.astype(bool)
    df["day"] = pd.to_datetime(df.day)
    return df


def _f(v: Any, nd: int = 1) -> Optional[float]:
    if v is None:
        return None
    try:
        x = float(v)
    except (TypeError, ValueError):
        return None
    return None if math.isnan(x) or math.isinf(x) else round(x, nd)


def _div(a: float, b: float) -> Optional[float]:
    return a / b if b else None


def _pi_free(df: pd.DataFrame, curtailed: Set[str]) -> Dict[int, Optional[float]]:
    ok = df[(df.status == "ok") & ~df.site_id.isin(curtailed)]
    return {int(ph): _div(g.meter.sum(), g.pv.sum()) for ph, g in ok.groupby("phase")}


def summary(db: Session, allowed: Optional[Set[int]], start: Optional[date] = None, end: Optional[date] = None, phase: Optional[int] = None) -> Dict[str, Any]:
    """Per-site and per-phase KPIs and estimated losses over [start, end] (criteria-driven)."""
    c = criteria()
    price = c["tariff"]["book_price_thb_per_kwh"]
    cur_min = c["curtailment"]["site_curtailed_min_note_days"]
    under_ratio = c["performance"]["under_performance_ratio"]
    flags = c["issue_flags"]
    df = _frame(db, start, end)
    visible = {s.site_id for s in _visible_sites(db, allowed)}
    if df.empty:
        return {"window": {"start": start and start.isoformat(), "end": end and end.isoformat()}, "phases": [], "sites": [], "labels": _labels()}
    last = df.day.max()
    curt_days = df.groupby("site_id").curt.sum()
    curtailed = set(curt_days[curt_days > cur_min].index)
    pif = _pi_free(df, curtailed)
    rows = []
    for sid, g in df.groupby("site_id"):
        ph = int(g.phase.iloc[0])
        ok = g[g.status == "ok"]
        act, con, pv = g.meter.sum(), g.con.sum(), g.pv.sum()
        pi_pv = _div(ok.meter.sum(), ok.pv.sum())
        p = pif.get(ph)
        is_cur = sid in curtailed
        cur_kwh = max(0.0, (p - pi_pv) * ok.pv.sum()) if (is_cur and p and pi_pv is not None) else 0.0
        out_kwh = g[g.status == "outage"].pv.sum() * p if p else 0.0
        under_kwh = max(0.0, (p * under_ratio - pi_pv) * ok.pv.sum()) if (not is_cur and p and pi_pv is not None) else 0.0
        n = len(g)
        outage = int((g.status == "outage").sum())
        gaps = int(g.status.isin(["loss_inv", "loss_meter"]).sum())
        recent = int(((g.status == "outage") & (g.day > last - timedelta(days=flags["recent_outage_window_days"]))).sum())
        issues = []
        if cur_kwh >= flags["curtailment_kwh_min"]:
            issues.append("หรี่กำลัง")
        if under_kwh >= flags["under_performance_kwh_min"]:
            issues.append("ผลิตต่ำกว่าคาด")
        if outage >= flags["outage_days_min"]:
            issues.append("ระบบล่ม")
        if gaps >= flags["data_gap_days_min"]:
            issues.append("ข้อมูลขาด")
        owners = sorted({flags["owner"][i] for i in issues if i in flags["owner"]}, key=lambda o: o != "PM")
        if recent:
            issues.append(f"ล่มช่วง {flags['recent_outage_window_days']} วันล่าสุด")
            if "O&M" not in owners:
                owners.append("O&M")
        loss = cur_kwh + out_kwh + under_kwh
        rows.append({
            "site_id": sid, "phase": ph, "name": g.name.iloc[0], "region": g.region.iloc[0], "kwp": _f(g.kwp.iloc[0], 2),
            "growatt_plant_id": None if pd.isna(g.growatt_plant_id.iloc[0]) else int(g.growatt_plant_id.iloc[0]),
            "days": n, "meter_mwh": _f(act / 1000, 2), "contract_mwh": _f(con / 1000, 2), "pvsyst_mwh": _f(pv / 1000, 2),
            "vs_contract_pct": _f(100 * _div(act, con), 1) if con else None, "vs_pvsyst_pct": _f(100 * pi_pv, 1) if pi_pv is not None else None,
            "yield_kwh_kwp": _f(act / g.kwp.iloc[0], 0), "availability_pct": _f(100 * (1 - outage / n), 2), "data_availability_pct": _f(100 * (1 - gaps / n), 2),
            "outage_days": outage, "data_gap_days": gaps, "outage_recent_days": recent, "curtailment_note_days": int(curt_days.get(sid, 0)), "curtailed": is_cur,
            "curtailment_loss_mwh": _f(cur_kwh / 1000, 2), "outage_loss_mwh": _f(out_kwh / 1000, 2), "under_loss_mwh": _f(under_kwh / 1000, 2),
            "loss_thb": _f(loss * price, 0), "issues": issues, "owner": " + ".join(owners) or None,
        })
    rows.sort(key=lambda r: -(r["loss_thb"] or 0))
    for i, r in enumerate(rows, start=1):
        r["rank"] = i
    phases = []
    for ph, g in df.groupby("phase"):
        n = len(g)
        ph_rows = [r for r in rows if r["phase"] == int(ph)]
        phases.append({
            "phase": int(ph), "sites": int(g.site_id.nunique()), "kwp": _f(g.drop_duplicates("site_id").kwp.sum(), 2),
            "first_day": g.day.min().date().isoformat(), "last_day": g.day.max().date().isoformat(),
            "meter_mwh": _f(g.meter.sum() / 1000, 1), "contract_mwh": _f(g.con.sum() / 1000, 1), "pvsyst_mwh": _f(g.pv.sum() / 1000, 1),
            "vs_contract_pct": _f(100 * _div(g.meter.sum(), g.con.sum()), 1) if g.con.sum() else None,
            "pi_free_pct": _f(100 * pif[int(ph)], 1) if pif.get(int(ph)) else None,
            "availability_pct": _f(100 * (1 - (g.status == "outage").sum() / n), 2),
            "data_availability_pct": _f(100 * (1 - g.status.isin(["loss_inv", "loss_meter"]).sum() / n), 2),
            "curtailed_sites": len([s for s in curtailed if s in set(g.site_id)]),
            "curtailment_loss_mwh": _f(sum(r["curtailment_loss_mwh"] or 0 for r in ph_rows), 1),
            "outage_loss_mwh": _f(sum(r["outage_loss_mwh"] or 0 for r in ph_rows), 1),
            "under_loss_mwh": _f(sum(r["under_loss_mwh"] or 0 for r in ph_rows), 1),
            "fee_thb": _f(g.meter.sum() * price, 0),
        })
    if phase is not None:
        phases = [p for p in phases if p["phase"] == phase]
        rows = [r for r in rows if r["phase"] == phase]
    if allowed is not None:
        phases = []  # fleet totals stay with admins: they include plants an engineer may not see
    return {"window": {"start": df.day.min().date().isoformat(), "end": last.date().isoformat()},
            "phases": phases, "sites": [r for r in rows if r["site_id"] in visible], "labels": _labels()}


def _labels() -> Dict[str, str]:
    return {"contract_mwh": "modelled", "pvsyst_mwh": "modelled", "curtailment_loss_mwh": "estimated", "outage_loss_mwh": "estimated",
            "under_loss_mwh": "estimated", "loss_thb": "estimated", "lost_mwh": "estimated", "gap_mwh": "estimated", "gap_thb": "estimated"}


def _cause(note: str) -> str:
    oe = criteria()["outage_event"]
    for label, keys in oe["cause_keywords"]:
        if any(k in note for k in keys):
            return label
    return oe["cause_default"]


def outage_events(db: Session, allowed: Optional[Set[int]], start: Optional[date] = None, end: Optional[date] = None) -> List[Dict[str, Any]]:
    """Runs of consecutive outage days per site, with the estimated energy lost and a cause group."""
    price = criteria()["tariff"]["book_price_thb_per_kwh"]
    df = _frame(db, start, end)
    if df.empty:
        return []
    cur_min = criteria()["curtailment"]["site_curtailed_min_note_days"]
    cd = df.groupby("site_id").curt.sum()
    pif = _pi_free(df, set(cd[cd > cur_min].index))
    visible = {s.site_id for s in _visible_sites(db, allowed)}
    out = []
    o = df[df.status == "outage"].sort_values(["site_id", "day"])
    for sid, g in o.groupby("site_id"):
        if sid not in visible:
            continue
        run = (g.day.diff().dt.days != 1).cumsum()
        for _, e in g.groupby(run):
            note = " | ".join(dict.fromkeys(n for n in e.note.fillna("") if n))
            p = pif.get(int(e.phase.iloc[0])) or 0
            lost = e.pv.sum() * p
            out.append({"site_id": sid, "phase": int(e.phase.iloc[0]), "name": e.name.iloc[0], "region": e.region.iloc[0],
                        "start": e.day.min().date().isoformat(), "end": e.day.max().date().isoformat(), "days": len(e),
                        "lost_mwh": _f(lost / 1000, 2), "lost_thb": _f(lost * price, 0), "cause": _cause(note), "note": note or None})
    out.sort(key=lambda r: (-r["days"], r["start"]))
    return out


def meter_check(db: Session, allowed: Optional[Set[int]], start: Optional[date] = None, end: Optional[date] = None) -> List[Dict[str, Any]]:
    """Meter vs inverter per site: normal ratio, abnormal days and the energy the meter may have
    missed (estimated)."""
    c = criteria()
    m = c["meter_vs_inverter"]
    fl = m["flags"]
    price = c["tariff"]["book_price_thb_per_kwh"]
    df = _frame(db, start, end)
    if df.empty:
        return []
    visible = {s.site_id for s in _visible_sites(db, allowed)}
    df = df[df.site_id.isin(visible)].copy()
    meter, inv = df.meter.fillna(0), df.inv.fillna(0)
    df["r"] = (meter / inv).where((meter > 0) & (inv > 0))
    df["med"] = df.groupby("site_id").r.transform("median")
    big = inv > m["production_gate_kwh_per_kwp"] * df.kwp
    df["low"] = big & (df.r < df.med - m["low_day_drop"])
    df["high"] = big & (df.r > m["high_day_ratio"])
    df["inv_miss"] = (meter > 0) & ~(inv > 0)
    df["met_miss"] = (inv > 0) & ~(meter > 0)
    df["gap"] = ((inv * df.med - meter).where(df.low | df.high, 0.0) + (inv * df.med).where(df.met_miss, 0.0)).fillna(0.0)
    out = []
    for sid, g in df.groupby("site_id"):
        med = g.med.iloc[0]
        low, high, im, mm = int(g.low.sum()), int(g.high.sum()), int(g.inv_miss.sum()), int(g.met_miss.sum())
        gap = max(0.0, float(g.gap.sum()))
        flags = []
        if med is not None and not pd.isna(med) and med < fl["ratio_low_median"]:
            flags.append("สัดส่วนต่ำกว่าปกติ")
        if low + mm >= fl["low_or_missing_meter_days"]:
            flags.append("มิเตอร์อ่านต่ำ/ขาด")
        if im >= fl["inverter_missing_days"]:
            flags.append("ข้อมูลอินเวอร์เตอร์ขาด")
        if high >= fl["meter_above_inverter_days"]:
            flags.append("มิเตอร์สูงกว่าอินเวอร์เตอร์")
        out.append({"site_id": sid, "phase": int(g.phase.iloc[0]), "name": g.name.iloc[0], "region": g.region.iloc[0],
                    "median_ratio_pct": _f(100 * med, 2) if not pd.isna(med) else None, "p05_ratio_pct": _f(100 * g.r.quantile(0.05), 2) if g.r.notna().any() else None,
                    "low_days": low, "high_days": high, "inverter_missing_days": im, "meter_missing_days": mm,
                    "gap_mwh": _f(gap / 1000, 2), "gap_thb": _f(gap * price, 0), "flags": flags})
    out.sort(key=lambda r: -(r["gap_thb"] or 0))
    return out


# ---------- one Growatt plant: meter day vs Growatt's own day energy ----------

PLANT_DEFAULT_DAYS = 60
MAX_GROWATT_KWH_PER_KWP_DAY = 10.0  # as growatt_overview: above this a Growatt day figure is a glitch


def plant_days(db: Session, allowed: Optional[Set[int]], plant_id: int, start: Optional[date] = None, end: Optional[date] = None) -> Dict[str, Any]:
    """The report days of the site linked to `plant_id`, each with Growatt's own `plant/energy` day
    (`growatt_plant_energy_days`, finished days) beside the meter: a third check on the meter.
    Default window: the last PLANT_DEFAULT_DAYS report days of the site. A Growatt day above
    MAX_GROWATT_KWH_PER_KWP_DAY × kWp is withheld (null, `growatt_implausible`). Ratios only where
    both are > 0. 404 (GrowattNotFound) outside the scope or without a report site."""
    if allowed is not None and plant_id not in allowed:
        raise GrowattNotFound(f"Plant {plant_id} not found")
    site = db.scalars(select(PwaMeterSite).where(PwaMeterSite.growatt_plant_id == plant_id).order_by(PwaMeterSite.site_id)).first()
    if site is None:
        raise GrowattNotFound(f"Plant {plant_id} has no PWA meter report site")
    last = db.scalar(select(PwaMeterDay.day).where(PwaMeterDay.site_id == site.site_id).order_by(PwaMeterDay.day.desc()).limit(1))
    if end is None:
        end = last
    if start is None and end is not None:
        start = end - timedelta(days=PLANT_DEFAULT_DAYS - 1)
    q = select(PwaMeterDay).where(PwaMeterDay.site_id == site.site_id)
    gq = select(GrowattPlantEnergyDay.day, GrowattPlantEnergyDay.energy_kwh).where(GrowattPlantEnergyDay.plant_id == plant_id)
    if start:
        q = q.where(PwaMeterDay.day >= start)
        gq = gq.where(GrowattPlantEnergyDay.day >= start)
    if end:
        q = q.where(PwaMeterDay.day <= end)
        gq = gq.where(GrowattPlantEnergyDay.day <= end)
    growatt = {d: e for d, e in db.execute(gq).all()}
    cap = site.growatt_kwp or site.kwp
    out, ratios, both_meter, both_growatt = [], [], 0.0, 0.0
    for r in db.scalars(q.order_by(PwaMeterDay.day)).all():
        g = growatt.get(r.day)
        implausible = g is not None and cap and g > cap * MAX_GROWATT_KWH_PER_KWP_DAY
        if implausible:
            g = None
        ratio = 100 * r.meter_kwh / g if (r.meter_kwh and g) else None
        if ratio is not None:
            ratios.append(ratio)
            both_meter += r.meter_kwh
            both_growatt += g
        out.append({"day": r.day.isoformat(), "meter_kwh": r.meter_kwh, "inverter_kwh": r.inverter_kwh, "contract_kwh": r.contract_kwh,
                    "pvsyst_kwh": r.pvsyst_kwh, "status": r.status, "weather": r.weather, "note": r.note,
                    "growatt_kwh": _f(g, 1), "growatt_implausible": bool(implausible), "meter_vs_growatt_pct": _f(ratio, 2)})
    med = float(pd.Series(ratios).median()) if ratios else None
    return {"site": _site_out(site), "last_report_day": last and last.isoformat(),
            "window": {"start": start and start.isoformat(), "end": end and end.isoformat()},
            "days": out,
            "summary": {"report_days": len(out), "compared_days": len(ratios),
                        "meter_kwh": _f(sum(d["meter_kwh"] or 0 for d in out), 1) if out else None,
                        "median_meter_vs_growatt_pct": _f(med, 2),
                        "meter_vs_growatt_pct": _f(100 * both_meter / both_growatt, 2) if both_growatt else None},
            "labels": {"contract_kwh": "modelled", "pvsyst_kwh": "modelled"}}


# ---------- CLI ----------

def main(argv: Optional[List[str]] = None) -> int:
    from app.db.session import SessionLocal, ensure_schema, engine

    ap = argparse.ArgumentParser(prog="python -m app.services.pwa_meter", description=__doc__.split("\n\n")[0])
    sub = ap.add_subparsers(dest="cmd", required=True)
    imp = sub.add_parser("import", help="upsert the clean sites + days CSVs")
    imp.add_argument("--sites", required=True, type=Path)
    imp.add_argument("--days", required=True, type=Path)
    sm = sub.add_parser("summary", help="print the phase summary")
    sm.add_argument("--start", type=date.fromisoformat)
    sm.add_argument("--end", type=date.fromisoformat)
    a = ap.parse_args(argv)
    ensure_schema(engine)
    with SessionLocal() as db:
        if a.cmd == "import":
            try:
                print(json.dumps(import_csv(db, a.sites, a.days)))
            except PwaImportError as exc:
                print(f"import refused: {exc}")
                return 1
        else:
            print(json.dumps(summary(db, None, a.start, a.end)["phases"], ensure_ascii=False, indent=1))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
