"""EPI system factor fitted per plant (docs/plans/decision-rules.md §5, §5.1).

The plant daily model is P0 × G/1000 × [1 + γ(T_mod − 25)] × system factor, and
EPI = measured ÷ modelled. With one assumed factor (0.985) for every plant, the fleet's clear-day
EPI sits around 0.74 and each plant's own losses (inverter, wiring, soiling, a sensor that reads a
little high or low) shift it, so EPI could not be read across plants. Here each plant's factor is
the median of measured ÷ modelled-without-factor over its `FIT_DAYS` clearest good days in the last
`WINDOW_DAYS`, so a fitted plant's EPI is about 1.0 on a day like its best days.

Good day: an EPI from at least `MIN_FILTERED_SLOTS` filtered slots, the weather sensor passing R16,
clearness (measured POA insolation ÷ modelled Haurwitz clear-sky insolation) of at least
`MIN_CLEARNESS`, and the plant's inverters not producing (fault, off, standby, no data) for at most
`MAX_DOWN_SHARE` of their daylight minutes.

A fit is used only when it is believable: a factor outside `FACTOR_RANGE` points to a wrong kWp, a
misplaced sensor or a plant that is mostly down, and a spread above `MAX_SPREAD_PCT` to days that
don't agree. Those plants are `rejected` and keep the default, so the odd EPI stays visible. A
chronic fault present on every good day (say one dead string) is folded into the factor: the string
rules (R1/R2/R8) catch that, not EPI.

A plant is fitted once (`rules_yesterday` fits plants without a fit); `epi_refit` fits every plant
again, e.g. after a sensor or inverter was replaced. A new factor rescales the plant's stored EPI and
modelled energy, so its history stays on one scale (R10 compares against it).
"""

from __future__ import annotations

import logging
import statistics
from collections import defaultdict
from datetime import date, datetime, timedelta, timezone
from typing import Any, Dict, List, Optional, Sequence, Tuple

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.db.models import GrowattInverterDaily, GrowattPlant, GrowattPlantDaily, GrowattPlantEpiFit, not_installed_sns
from solar_core.sun import clear_sky_ghi

log = logging.getLogger(__name__)

DEFAULT_SYSTEM_FACTOR = 0.985
FIT_DAYS = 10
WINDOW_DAYS = 60
MIN_CLEARNESS = 0.7
MIN_FILTERED_SLOTS = 36  # 3 h of 5-min slots inside the POA / clipping / curtailment filters
MAX_DOWN_SHARE = 0.03  # of the inverters' summed daylight minutes
FACTOR_RANGE = (0.5, 1.2)
MAX_SPREAD_PCT = 8.0


def clear_sky_kwh_m2(day: date, lat: float, lon: float) -> float:
    """Haurwitz clear-sky GHI integrated over the day (kWh/m², modelled)."""
    return sum(clear_sky_ghi(day, lat, lon, m + 2.5) for m in range(0, 1440, 5)) * 5 / 60 / 1000


def active_factors(db: Session, plant_ids: Optional[Sequence[int]] = None) -> Dict[int, float]:
    """{plant_id: fitted factor} of plants with a `fitted` row; any other plant uses the default."""
    q = select(GrowattPlantEpiFit.plant_id, GrowattPlantEpiFit.factor).where(
        GrowattPlantEpiFit.status == "fitted", GrowattPlantEpiFit.factor.is_not(None)
    )
    if plant_ids is not None:
        q = q.where(GrowattPlantEpiFit.plant_id.in_(list(plant_ids)))
    return {int(pid): float(f) for pid, f in db.execute(q) if f is not None}


def active_factor(db: Session, plant_id: int) -> float:
    return active_factors(db, [plant_id]).get(plant_id, DEFAULT_SYSTEM_FACTOR)


def factor_info(db: Session, plant_id: int) -> Dict[str, Any]:
    """The factor in use and how it came about (for the UI)."""
    row = db.get(GrowattPlantEpiFit, plant_id)
    fitted = row is not None and row.status == "fitted" and row.factor is not None
    return {
        "factor": float(row.factor) if fitted and row is not None and row.factor is not None else DEFAULT_SYSTEM_FACTOR,
        "basis": "fitted" if fitted else "default",
        "status": row.status if row is not None else None,
        "fit_factor": row.factor if row is not None else None,
        "days_used": row.days_used if row is not None else 0,
        "candidate_days": row.candidate_days if row is not None else 0,
        "start_day": row.start_day.isoformat() if row is not None and row.start_day else None,
        "end_day": row.end_day.isoformat() if row is not None and row.end_day else None,
        "spread_pct": row.spread_pct if row is not None else None,
        "reason": row.reason if row is not None else None,
        "fitted_at": row.fitted_at.isoformat() if row is not None and row.fitted_at else None,
        "modelled": True,
    }


def _raw(row: GrowattPlantDaily) -> Optional[float]:
    """Measured ÷ modelled without the system factor."""
    if row.epi is None:
        return None
    return float(row.epi) * float(row.system_factor or DEFAULT_SYSTEM_FACTOR)


def _judge(
    rows: List[GrowattPlantDaily], lat: Optional[float], lon: Optional[float], down: Dict[date, float], cfg: Dict[str, Any]
) -> Dict[str, Any]:
    """The fit for one plant's rows (no DB writes)."""
    from app.services.growatt_rules import sensor_verdict

    if lat is None or lon is None:
        return {"status": "too_few_days", "candidate_days": 0, "reason": "plant has no coordinates (clear sky unknown)"}
    cands: List[Tuple[float, float, date]] = []  # (clearness, raw, day)
    for r in rows:
        raw = _raw(r)
        if raw is None or r.yr_h is None or (r.filtered_slots or 0) < MIN_FILTERED_SLOTS:
            continue
        v = sensor_verdict(r, cfg)
        if v is not None and not v["ok"]:
            continue
        if down.get(r.day, 0.0) > MAX_DOWN_SHARE:
            continue
        cs = clear_sky_kwh_m2(r.day, float(lat), float(lon))
        if cs <= 0:
            continue
        clearness = float(r.yr_h) / cs
        if clearness >= MIN_CLEARNESS:
            cands.append((clearness, raw, r.day))
    out: Dict[str, Any] = {"candidate_days": len(cands)}
    if len(cands) < FIT_DAYS:
        return {**out, "status": "too_few_days", "reason": f"{len(cands)} good clear days, {FIT_DAYS} needed"}
    best = sorted(cands, reverse=True)[:FIT_DAYS]
    raws = [x for _, x, _ in best]
    factor = statistics.median(raws)
    spread = statistics.median(abs(x - factor) for x in raws) / factor * 100 if factor > 0 else None
    out.update(
        factor=round(factor, 4),
        spread_pct=round(spread, 2) if spread is not None else None,
        days_used=len(best),
        start_day=min(d for _, _, d in best),
        end_day=max(d for _, _, d in best),
        min_clearness=round(best[-1][0], 3),
    )
    lo, hi = FACTOR_RANGE
    if not lo <= factor <= hi:
        return {**out, "status": "rejected", "reason": f"factor {factor:.3f} outside {lo}–{hi}: check kWp, sensor or downtime"}
    if spread is None or spread > MAX_SPREAD_PCT:
        return {**out, "status": "rejected", "reason": f"clear days disagree (spread {spread:.1f} % > {MAX_SPREAD_PCT} %)"}
    return {**out, "status": "fitted", "reason": None}


def _rescale(db: Session, plant_id: int, factor: float) -> int:
    """Put the plant's stored EPI and modelled energy on `factor`. Returns rows changed."""
    n = 0
    for r in db.scalars(select(GrowattPlantDaily).where(GrowattPlantDaily.plant_id == plant_id)):
        old = float(r.system_factor or DEFAULT_SYSTEM_FACTOR)
        if r.epi is None or abs(old - factor) < 1e-9:
            continue
        r.epi = round(float(r.epi) * old / factor, 4)
        if r.modelled_energy_kwh is not None:
            r.modelled_energy_kwh = round(float(r.modelled_energy_kwh) * factor / old, 3)
        r.system_factor = factor
        n += 1
    return n


def fit(db: Session, end: date, plant_ids: Optional[Sequence[int]] = None, refit: bool = False) -> Dict[str, Any]:
    """Fit plants on the `WINDOW_DAYS` up to `end`. Without `refit`, plants already fitted are left
    alone. Commits once. Returns counts by status plus rows rescaled."""
    from app.services.growatt_rules import rule_settings

    cfg = rule_settings(db)
    start = end - timedelta(days=WINDOW_DAYS - 1)
    q = select(GrowattPlant).order_by(GrowattPlant.plant_id)
    if plant_ids is not None:
        q = q.where(GrowattPlant.plant_id.in_(list(plant_ids)))
    plants = list(db.scalars(q))
    existing = {r.plant_id: r for r in db.scalars(select(GrowattPlantEpiFit))}
    if not refit:
        plants = [p for p in plants if not (p.plant_id in existing and existing[p.plant_id].status == "fitted")]
    ids = [p.plant_id for p in plants]
    if not ids:
        return {"window": [start.isoformat(), end.isoformat()], "plants": 0}

    rows_by: Dict[int, List[GrowattPlantDaily]] = defaultdict(list)
    for r in db.scalars(
        select(GrowattPlantDaily).where(
            GrowattPlantDaily.plant_id.in_(ids), GrowattPlantDaily.day >= start, GrowattPlantDaily.day <= end
        )
    ):
        rows_by[r.plant_id].append(r)
    ID = GrowattInverterDaily
    down_by: Dict[int, Dict[date, float]] = defaultdict(dict)  # share of daylight not producing
    for pid, d, m, dl in db.execute(
        select(ID.plant_id, ID.day, func.sum(ID.fault_min + ID.off_min + ID.standby_min + ID.no_data_min), func.sum(ID.daylight_min))
        .where(ID.plant_id.in_(ids), ID.day >= start, ID.day <= end, ID.device_sn.not_in(not_installed_sns()))
        .group_by(ID.plant_id, ID.day)
    ):
        down_by[pid][d] = float(m or 0) / float(dl) if dl else 1.0

    out: Dict[str, Any] = {"window": [start.isoformat(), end.isoformat()], "plants": len(ids), "rescaled_rows": 0}
    now = datetime.now(timezone.utc)
    for p in plants:
        res = _judge(rows_by.get(p.plant_id, []), p.latitude, p.longitude, down_by.get(p.plant_id, {}), cfg)
        row = existing.get(p.plant_id)
        if row is None:
            row = GrowattPlantEpiFit(plant_id=p.plant_id, status=res["status"])
            db.add(row)
        row.status = res["status"]
        row.factor = res.get("factor")
        row.spread_pct = res.get("spread_pct")
        row.days_used = res.get("days_used", 0)
        row.candidate_days = res.get("candidate_days", 0)
        row.start_day = res.get("start_day")
        row.end_day = res.get("end_day")
        row.min_clearness = res.get("min_clearness")
        row.reason = res.get("reason")
        row.fitted_at = now
        out[res["status"]] = out.get(res["status"], 0) + 1
        # the plant's stored history goes onto the factor now in use
        fitted = row.factor if row.status == "fitted" else None
        use = float(fitted) if fitted is not None else DEFAULT_SYSTEM_FACTOR
        out["rescaled_rows"] += _rescale(db, p.plant_id, use)
    db.commit()
    return out
