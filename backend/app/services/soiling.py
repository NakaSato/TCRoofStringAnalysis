"""Soiling: cleaning steps and R13 incomplete rain recovery (docs/plans/decision-rules.md §6).

Both read only stored data: the plant daily EPI (`growatt_plant_daily`, measured ÷ **modelled**),
the Site log's cleaning dates (`site_events`) and Google Weather's daytime rain (`google_weather_hourly`,
**modelled**, 06:00–18:00 only, so night rain is not seen).

**Good day**: an EPI from at least `epi_fit.MIN_FILTERED_SLOTS` filtered slots, the weather sensor
passing R16, clearness (POA insolation ÷ Haurwitz clear-sky) of at least `soil_min_clearness` and the
inverters not producing for at most `epi_fit.MAX_DOWN_SHARE` of their daylight minutes. Only good
days are compared, so a cloudy day or a down inverter is not taken for dirt.

**Cleaning step**: median EPI of the last `soil_step_days` good days before a cleaning (within
`soil_window_days`, after the previous cleaning) against the first ones after it (before the next
cleaning). `step_pct` = after ÷ before − 1. A heavy rain (≥ `soil_rain_mm`) in between washes the
array too, so such a step is flagged `rain_between`. The soiling rate (estimated) = step ÷ days since
the last reset (the previous cleaning or heavy rain), only when the rain record covers every day
in between.

**R13** (judged per plant and day `day`): the newest heavy rain day R since the last cleaning,
at most `r13_max_age_days` ago. Clean reference C = the median EPI after the last cleaning (its
step's after-days), else 1.0 for a plant with a fitted EPI factor (its best clear days, `epi_fit`),
else no verdict. B = good days in the `r13_before_days` before R (after the last cleaning and any
earlier heavy rain), A = the newest `r13_judge_days` good days after R. Recovery = (A − B) ÷ (C − B),
judged only when C − B ≥ `r13_min_deficit` (there was dirt to wash off). Fires when recovery is below
`r13_recovery_pct` and A is still `r13_min_deficit` below C: suggest a manual cleaning.
Lost kWh (estimated) = the day's energy × (C − A) ÷ A.

**R12 soiling wallet** (judged per plant and day): the THB lost to dirt since the array was last
clean, the report's Σ SL_t · E_t · p. The reset is the newest plant-wide cleaning (one inverter
only does not reset the plant) or heavy rain up to that day. Soiling rate r (%/day, estimated) = the
median of the plant's own measured rates of the last `r12_rate_lookback_days`, else the fleet's
median rate when at least `r12_fleet_min_plants` plants have one, else no wallet. Each day n after
the reset loses SL = min(r × n, `r12_max_soiling_pct`) of the clean energy, so lost kWh = measured
energy × SL ÷ (1 − SL), priced with the tariff (unknown on-peak split = off-peak, never inflated).
A day without stored energy adds nothing (counted in `days_without_energy`). The rain record must
cover every day between the reset and the judged day (the judged day's own rain may still be
missing), else a missed heavy rain could have reset it and there is no verdict. The cleaning cost C
is the plant's entered `om_plant_settings.cleaning_cost_thb`, else the median cost entered on its
plant-wide cleanings; none = the wallet is shown without a verdict. Fires when the wallet ≥ C and
the day is outside the monsoon window (`r12_monsoon`). The report's rain-forecast gate is not built
(no forecast is fetched). Optimal interval T* = √(2C ÷ (r × V)), V = the mean clean-energy value per
day since the reset (all **estimated**).
"""

from __future__ import annotations

import statistics
from collections import defaultdict
from datetime import date, datetime, timedelta
from functools import lru_cache
from typing import Any, Dict, List, Optional, Sequence, Set, Tuple

from sqlalchemy import func, select
from sqlalchemy.orm import Session

import math

from app.db.models import (
    GoogleWeatherHourly,
    OmPlantSettings,
    GrowattInverterDaily,
    GrowattPlant,
    GrowattPlantDaily,
    GrowattPlantEpiFit,
    SiteEvent,
    not_installed_sns,
)
from app.services import epi_fit, google_weather

GoodDays = Dict[date, float]  # day -> EPI of a good day
Rain = Dict[date, Optional[float]]  # day -> daytime rain mm (None = hours missing, rain unknown)


@lru_cache(maxsize=65536)
def _clear_sky(day: date, lat: float, lon: float) -> float:
    return epi_fit.clear_sky_kwh_m2(day, lat, lon)


def _median(vals: Sequence[float]) -> Optional[float]:
    return statistics.median(vals) if vals else None


def _r(v: Optional[float], nd: int = 3) -> Optional[float]:
    return None if v is None else round(v, nd)


def local_today() -> date:
    from app.services.growatt_issues import LOCAL

    return datetime.now(LOCAL).date()


# --------------------------------------------------------------------------- inputs


def good_days(
    db: Session, plant_ids: Sequence[int], start: date, end: date, cfg: Dict[str, Any]
) -> Tuple[Dict[int, GoodDays], Dict[int, Dict[date, GrowattPlantDaily]], Set[int]]:
    """({plant: {day: epi}} of good days, {plant: {day: row}} of every row, plants with any EPI)."""
    from app.services.growatt_rules import sensor_verdict

    ids = list(plant_ids)
    good: Dict[int, GoodDays] = defaultdict(dict)
    rows: Dict[int, Dict[date, GrowattPlantDaily]] = defaultdict(dict)
    with_epi: Set[int] = set()
    if not ids:
        return good, rows, with_epi
    loc = {
        int(pid): (lat, lon)
        for pid, lat, lon in db.execute(
            select(GrowattPlant.plant_id, GrowattPlant.latitude, GrowattPlant.longitude).where(GrowattPlant.plant_id.in_(ids))
        )
    }
    ID = GrowattInverterDaily
    down: Dict[Tuple[int, date], float] = {}
    for pid, d, m, dl in db.execute(
        select(ID.plant_id, ID.day, func.sum(ID.fault_min + ID.off_min + ID.standby_min + ID.no_data_min), func.sum(ID.daylight_min))
        .where(ID.plant_id.in_(ids), ID.day >= start, ID.day <= end, ID.device_sn.not_in(not_installed_sns()))
        .group_by(ID.plant_id, ID.day)
    ):
        down[(int(pid), d)] = float(m or 0) / float(dl) if dl else 1.0
    min_clear = float(cfg["soil_min_clearness"])
    PD = GrowattPlantDaily
    for r in db.scalars(select(PD).where(PD.plant_id.in_(ids), PD.day >= start, PD.day <= end)):
        rows[r.plant_id][r.day] = r
        if r.epi is None:
            continue
        with_epi.add(r.plant_id)
        if r.yr_h is None or (r.filtered_slots or 0) < epi_fit.MIN_FILTERED_SLOTS:
            continue
        v = sensor_verdict(r, cfg)
        if v is not None and not v["ok"]:
            continue
        if down.get((r.plant_id, r.day), 0.0) > epi_fit.MAX_DOWN_SHARE:
            continue
        lat, lon = loc.get(r.plant_id, (None, None))
        if lat is None or lon is None:
            continue
        cs = _clear_sky(r.day, round(float(lat), 2), round(float(lon), 2))
        if cs > 0 and float(r.yr_h) / cs >= min_clear:
            good[r.plant_id][r.day] = float(r.epi)
    return good, rows, with_epi


def rain_days(db: Session, plant_ids: Sequence[int], start: date, end: date) -> Dict[int, Rain]:
    """{plant: {day: daytime rain mm}} from Google Weather (modelled). A day with fewer than
    `google_weather.min_day_hours()` stored hours is None (rain unknown); a day not stored is absent."""
    cells: Dict[str, List[int]] = defaultdict(list)
    for p in db.scalars(select(GrowattPlant).where(GrowattPlant.plant_id.in_(list(plant_ids)))):
        c = google_weather.plant_cell(p)
        if c is not None:
            cells[c[0]].append(p.plant_id)
    out: Dict[int, Rain] = {pid: {} for ids in cells.values() for pid in ids}
    if not cells:
        return out
    H = GoogleWeatherHourly
    hours: Dict[Tuple[str, date], List[Optional[float]]] = defaultdict(list)
    for key, hour, mm in db.execute(
        select(H.cell_key, H.hour, H.precip_mm).where(
            H.cell_key.in_(list(cells)),
            H.hour >= datetime.combine(start, datetime.min.time()),
            H.hour < datetime.combine(end + timedelta(days=1), datetime.min.time()),
        )
    ):
        if google_weather.in_window(hour.hour):
            hours[(key, hour.date())].append(mm)
    need = google_weather.min_day_hours()
    for (key, d), vals in hours.items():
        mm: Optional[float] = round(sum(float(v) for v in vals if v is not None), 1) if len(vals) >= need else None
        for pid in cells[key]:
            out[pid][d] = mm
    return out


def cleanings(db: Session, plant_ids: Sequence[int], until: Optional[date] = None) -> Dict[int, List[SiteEvent]]:
    """{plant: cleaning events oldest first}."""
    q = select(SiteEvent).where(SiteEvent.event_type == "cleaning", SiteEvent.plant_id.in_(list(plant_ids)))
    if until is not None:
        q = q.where(SiteEvent.day <= until)
    out: Dict[int, List[SiteEvent]] = defaultdict(list)
    for e in db.scalars(q.order_by(SiteEvent.day, SiteEvent.id)):
        out[e.plant_id].append(e)
    return out


def fitted_plants(db: Session, plant_ids: Sequence[int]) -> Set[int]:
    F = GrowattPlantEpiFit
    return {
        int(pid)
        for (pid,) in db.execute(
            select(F.plant_id).where(F.plant_id.in_(list(plant_ids)), F.status == "fitted", F.factor.is_not(None))
        )
    }


def _end(e: SiteEvent) -> date:
    return e.end_day or e.day


def _heavy(rain: Rain, mm: float) -> List[date]:
    return sorted(d for d, v in rain.items() if v is not None and v >= mm)


# --------------------------------------------------------------------------- cleaning step


def _step(
    e: SiteEvent, prev: Optional[SiteEvent], nxt: Optional[SiteEvent], good: GoodDays, rain: Rain,
    has_epi: bool, today: date, cfg: Dict[str, Any],
) -> Dict[str, Any]:
    win, n, need = int(cfg["soil_window_days"]), int(cfg["soil_step_days"]), int(cfg["soil_min_days"])
    rain_mm = float(cfg["soil_rain_mm"])
    lo = e.day - timedelta(days=win)
    if prev is not None:
        lo = max(lo, _end(prev) + timedelta(days=1))
    hi = _end(e) + timedelta(days=win)
    if nxt is not None:
        hi = min(hi, nxt.day - timedelta(days=1))
    before = sorted(d for d in good if lo <= d < e.day)[-n:]
    after = sorted(d for d in good if _end(e) < d <= hi)[:n]
    b = _median([good[d] for d in before])
    a = _median([good[d] for d in after])
    out: Dict[str, Any] = {
        "event_id": e.id,
        "day": e.day.isoformat(),
        "end_day": e.end_day.isoformat() if e.end_day else None,
        "scope": "inverter" if e.device_sn else "plant",
        "device_sn": e.device_sn,
        "cost_thb": e.cost_thb,
        "before_days": [d.isoformat() for d in before],
        "after_days": [d.isoformat() for d in after],
        "epi_before": _r(b),
        "epi_after": _r(a),
        "step_pct": None,
        "recovered_epi": None,
        "rain_between": [],
        "soiling_rate_pct_per_day": None,
        "rate_reason": None,
    }
    if not has_epi:
        return {**out, "status": "no_epi", "reason": "no EPI stored for this plant (no weather sensor, or days not computed)"}
    if len(before) < need or len(after) < need:
        waiting = len(before) >= need and today <= hi and (nxt is None)
        return {
            **out,
            "status": "waiting" if waiting else "too_few_days",
            "reason": f"{len(before)} good days before, {len(after)} after; {need} needed on each side",
        }
    assert a is not None and b is not None
    span_lo, span_hi = before[0], after[-1]
    out["rain_between"] = [
        {"day": d.isoformat(), "rain_mm": rain[d]} for d in _heavy(rain, rain_mm) if span_lo <= d <= span_hi
    ]
    step = (a / b - 1) * 100 if b > 0 else None
    out.update(status="measured", reason=None, step_pct=_r(step, 2), recovered_epi=_r(a - b))
    # soiling rate: the step spread over the days since the array was last clean
    resets = [_end(prev)] if prev is not None else []
    resets += [d for d in _heavy(rain, rain_mm) if d < e.day]
    if step is None or step <= 0:
        out["rate_reason"] = "no gain measured"
    elif not resets:
        out["rate_reason"] = "no earlier cleaning or heavy rain known"
    else:
        reset = max(resets)
        gap = [reset + timedelta(days=k) for k in range(1, (e.day - reset).days)]
        if any(rain.get(d) is None for d in gap):
            out["rate_reason"] = f"rain record incomplete since {reset.isoformat()}"
        else:
            days = (e.day - reset).days
            out.update(soiling_rate_pct_per_day=_r(step / days, 3), rate_since=reset.isoformat(), rate_days=days)
    return out


def plant_cleaning_steps(
    good: GoodDays, events: Sequence[SiteEvent], rain: Rain, has_epi: bool, today: date, cfg: Dict[str, Any]
) -> List[Dict[str, Any]]:
    evs = list(events)
    return [
        _step(e, evs[i - 1] if i else None, evs[i + 1] if i + 1 < len(evs) else None, good, rain, has_epi, today, cfg)
        for i, e in enumerate(evs)
    ]


def _clean_ref(
    steps: Sequence[Dict[str, Any]], last: Optional[SiteEvent], fitted: bool, need: int
) -> Tuple[Optional[float], Optional[str], Optional[str]]:
    """(C, basis, cleaning day) for R13: the last cleaning's after-days once `need` of them exist,
    else 1.0 for a plant whose EPI factor is fitted, else unknown."""
    if last is not None:
        for s in steps:
            if s["event_id"] == last.id and s["epi_after"] is not None and len(s["after_days"]) >= need:
                return float(s["epi_after"]), "cleaning", s["day"]
    if fitted:
        return 1.0, "epi_fit", None
    return None, None, None


# --------------------------------------------------------------------------- R13


def r13_judge(
    day: date, good: GoodDays, events: Sequence[SiteEvent], steps: Sequence[Dict[str, Any]],
    rain: Rain, fitted: bool, cfg: Dict[str, Any],
) -> Optional[Dict[str, Any]]:
    """The R13 verdict of one plant on `day`: None = not judged, else {fires, ...evidence}."""
    rain_mm = float(cfg["soil_rain_mm"])
    past = [e for e in events if _end(e) < day]
    if any(e.day <= day <= _end(e) for e in events):
        return None  # cleaned that day
    last = past[-1] if past else None
    floor = _end(last) if last else date.min
    heavy = [d for d in _heavy(rain, rain_mm) if floor < d < day and (day - d).days <= int(cfg["r13_max_age_days"])]
    if not heavy:
        return None
    rd = heavy[-1]
    c, basis, clean_day = _clean_ref(steps, last, fitted, int(cfg["r13_min_days"]))
    if c is None:
        return None
    earlier = [d for d in _heavy(rain, rain_mm) if floor < d < rd]
    lo = max(rd - timedelta(days=int(cfg["r13_before_days"])), (earlier[-1] if earlier else floor) + timedelta(days=1))
    before = sorted(d for d in good if lo <= d < rd)
    after = sorted(d for d in good if rd < d <= day)[-int(cfg["r13_judge_days"]):]
    need = int(cfg["r13_min_days"])
    if len(before) < need or len(after) < need:
        return None
    b = statistics.median(good[d] for d in before)
    a = statistics.median(good[d] for d in after)
    deficit = c - b
    if deficit < float(cfg["r13_min_deficit"]):
        return None  # nothing to wash off: no verdict
    recovery = (a - b) / deficit
    fires = recovery < float(cfg["r13_recovery_pct"]) / 100 and c - a >= float(cfg["r13_min_deficit"])
    return {
        "fires": fires,
        "rain_day": rd.isoformat(),
        "rain_mm": rain.get(rd),
        "epi_before": round(b, 3),
        "epi_after": round(a, 3),
        "epi_clean": round(c, 3),
        "clean_basis": basis,
        "clean_day": clean_day,
        "recovery_pct": round(recovery * 100, 1),
        "before_days": len(before),
        "after_days": len(after),
    }


def _lookback(cfg: Dict[str, Any]) -> int:
    return int(cfg["r13_max_age_days"]) + int(cfg["r13_before_days"]) + 2 * int(cfg["soil_window_days"]) + 2


def r13_verdicts(
    db: Session, day: date, plant_ids: Optional[Sequence[int]], cfg: Dict[str, Any]
) -> Dict[int, Dict[str, Any]]:
    """{plant: R13 verdict on `day`} of the plants that could be judged (fired or not)."""
    PD = GrowattPlantDaily
    q = select(PD.plant_id).where(PD.day == day, PD.epi.is_not(None))
    if plant_ids is not None:
        q = q.where(PD.plant_id.in_(list(plant_ids)))
    ids = sorted({int(p) for (p,) in db.execute(q)})
    if not ids:
        return {}
    start = day - timedelta(days=_lookback(cfg))
    good, _, with_epi = good_days(db, ids, start, day, cfg)
    rain = rain_days(db, ids, start, day)
    evs = cleanings(db, ids, until=day)
    fitted = fitted_plants(db, ids)
    out: Dict[int, Dict[str, Any]] = {}
    for pid in ids:
        events = evs.get(pid, [])
        steps = plant_cleaning_steps(good.get(pid, {}), events, rain.get(pid, {}), pid in with_epi, day, cfg)
        v = r13_judge(day, good.get(pid, {}), events, steps, rain.get(pid, {}), pid in fitted, cfg)
        if v is not None:
            out[pid] = v
    return out


def r13_findings(
    db: Session, day: date, plant_ids: Optional[Sequence[int]], cfg: Dict[str, Any], pricer: Any
) -> List[Dict[str, Any]]:
    from app.services.growatt_rules import _finding, _thb

    out: List[Dict[str, Any]] = []
    verdicts = r13_verdicts(db, day, plant_ids, cfg)
    if not verdicts:
        return out
    energy = dict(
        db.execute(
            select(GrowattPlantDaily.plant_id, GrowattPlantDaily.energy_kwh).where(
                GrowattPlantDaily.day == day, GrowattPlantDaily.plant_id.in_(list(verdicts))
            )
        ).all()
    )
    for pid, v in verdicts.items():
        if not v["fires"]:
            continue
        e = energy.get(pid)
        a, c = v["epi_after"], v["epi_clean"]
        kwh = float(e) * (c - a) / a if e is not None and a > 0 and c > a else None
        ev = {k: x for k, x in v.items() if k != "fires"}
        out.append(_finding("R13", "P3", pid, day, None, None, kwh, _thb(pricer, pid, kwh, None), **ev))
    return out


# --------------------------------------------------------------------------- API


def plant_soiling(
    db: Session, plant_id: int, today: date, days: int, cfg: Dict[str, Any], pricer: Any = None
) -> Dict[str, Any]:
    """One plant's cleaning steps (every recorded cleaning), daily EPI / rain for the last `days`,
    the latest R13 verdict and the R12 soiling wallet of the newest stored day. DB only."""
    events = cleanings(db, [plant_id]).get(plant_id, [])
    first = min([e.day for e in events] + [today - timedelta(days=days)])
    start = first - timedelta(days=int(cfg["soil_window_days"]) + _lookback(cfg))
    good, rows, with_epi = good_days(db, [plant_id], start, today, cfg)
    rain = rain_days(db, [plant_id], start, today).get(plant_id, {})
    g = good.get(plant_id, {})
    steps = plant_cleaning_steps(g, events, rain, plant_id in with_epi, today, cfg)
    fitted = plant_id in fitted_plants(db, [plant_id])
    last_row = max((d for d, r in rows.get(plant_id, {}).items() if r.epi is not None), default=None)
    r13 = r13_judge(last_row, g, events, steps, rain, fitted, cfg) if last_row else None
    series = []
    d = today - timedelta(days=days - 1)
    prow = rows.get(plant_id, {})
    while d <= today:
        r = prow.get(d)
        series.append(
            {
                "day": d.isoformat(),
                "epi": _r(float(r.epi)) if r is not None and r.epi is not None else None,
                "good": d in g,
                "rain_mm": rain.get(d),
            }
        )
        d += timedelta(days=1)
    measured = [s for s in steps if s["status"] == "measured"]
    rates = [s["soiling_rate_pct_per_day"] for s in measured if s["soiling_rate_pct_per_day"] is not None]
    return {
        "plant_id": plant_id,
        "has_epi": plant_id in with_epi,
        "epi_fitted": fitted,
        "cleanings": list(reversed(steps)),  # newest first
        "summary": {
            "cleanings": len(steps),
            "measured": len(measured),
            "median_step_pct": _r(_median([s["step_pct"] for s in measured if s["step_pct"] is not None]), 2),
            "median_soiling_rate_pct_per_day": _r(_median(rates), 3),
        },
        "r13": {**r13, "day": last_row.isoformat()} if r13 is not None and last_row else None,
        "r13_day": last_row.isoformat() if last_row else None,
        "wallet": _plant_wallet(db, plant_id, rows.get(plant_id, {}), cfg, pricer),
        "days": series,
        "settings": {
            k: cfg[k]
            for k in cfg
            if (k.startswith("soil_") or k.startswith("r13_") or k.startswith("r12_")) and k != "r12_monsoon"
        },
        "monsoon": list(cfg.get("r12_monsoon") or []),
        "labels": {
            "epi": "measured ÷ modelled",
            "rain_mm": "Google Weather, modelled, daytime 06–18 only",
            "soiling_rate_pct_per_day": "estimated",
            "lost_kwh_est": "estimated",
            "wallet_thb": "estimated",
            "cost_thb": "entered",
        },
    }


def _plant_wallet(
    db: Session, plant_id: int, rows: Dict[date, GrowattPlantDaily], cfg: Dict[str, Any], pricer: Any
) -> Optional[Dict[str, Any]]:
    """The wallet on the plant's newest stored day, None without a daily row."""
    if not rows:
        return None
    if pricer is None:
        from app.services.growatt_rules import load_pricer

        pricer = load_pricer(db)
    return wallets(db, max(rows), [plant_id], cfg, pricer).get(plant_id)


# --------------------------------------------------------------------------- R12 soiling wallet

WALLET_LOOKBACK_DAYS = 120  # rain / energy read back this far for the reset; older = rain unknown


def _md(v: str) -> Tuple[int, int]:
    m, d = str(v).split("-")
    return int(m), int(d)


def in_monsoon(day: date, cfg: Dict[str, Any]) -> bool:
    win = cfg.get("r12_monsoon") or []
    if len(win) != 2:
        return False
    lo, hi, x = _md(win[0]), _md(win[1]), (day.month, day.day)
    return lo <= x <= hi if lo <= hi else (x >= lo or x <= hi)


def _plant_wide(events: Sequence[SiteEvent]) -> List[SiteEvent]:
    return [e for e in events if not e.device_sn]


def plant_rates(
    db: Session, day: date, cfg: Dict[str, Any], plant_ids: Optional[Sequence[int]] = None
) -> Dict[int, float]:
    """{plant: median measured soiling rate %/day} from the cleaning steps of the last
    `r12_rate_lookback_days` (plants with a cleaning in that window; `None` = the whole fleet)."""
    since = day - timedelta(days=int(cfg["r12_rate_lookback_days"]))
    q = select(SiteEvent.plant_id).where(SiteEvent.event_type == "cleaning", SiteEvent.day >= since, SiteEvent.day <= day)
    if plant_ids is not None:
        q = q.where(SiteEvent.plant_id.in_(list(plant_ids)))
    ids = sorted({int(p) for (p,) in db.execute(q)})
    if not ids:
        return {}
    start = since - timedelta(days=_lookback(cfg))
    good, _, with_epi = good_days(db, ids, start, day, cfg)
    rain = rain_days(db, ids, start, day)
    evs = cleanings(db, ids, until=day)
    out: Dict[int, float] = {}
    for pid in ids:
        steps = plant_cleaning_steps(good.get(pid, {}), evs.get(pid, []), rain.get(pid, {}), pid in with_epi, day, cfg)
        rates = [
            s["soiling_rate_pct_per_day"]
            for s in steps
            if s["soiling_rate_pct_per_day"] is not None and s["scope"] == "plant" and date.fromisoformat(s["day"]) >= since
        ]
        if rates:
            out[pid] = float(statistics.median(rates))
    return out


def fleet_rate(rates: Dict[int, float], cfg: Dict[str, Any]) -> Optional[float]:
    vals = list(rates.values())
    return float(statistics.median(vals)) if len(vals) >= int(cfg["r12_fleet_min_plants"]) else None


def cleaning_costs(db: Session, plant_ids: Sequence[int], events: Dict[int, List[SiteEvent]]) -> Dict[int, Tuple[float, str]]:
    """{plant: (cost THB, basis)}: the entered planning cost, else the median cost entered on its
    plant-wide cleanings. Plants with neither are left out (never assumed)."""
    out: Dict[int, Tuple[float, str]] = {}
    for pid, c in db.execute(
        select(OmPlantSettings.plant_id, OmPlantSettings.cleaning_cost_thb).where(
            OmPlantSettings.plant_id.in_(list(plant_ids)), OmPlantSettings.cleaning_cost_thb.is_not(None)
        )
    ):
        if c is not None:
            out[int(pid)] = (float(c), "plant_setting")
    for pid in plant_ids:
        if pid in out:
            continue
        costs = [float(e.cost_thb) for e in _plant_wide(events.get(pid, [])) if e.cost_thb is not None]
        if costs:
            out[pid] = (float(statistics.median(costs)), "site_log")
    return out


def wallet(
    pid: int, day: date, events: Sequence[SiteEvent], rain: Rain, energy: Dict[date, Optional[float]],
    rate: Optional[Tuple[float, str]], cost: Optional[Tuple[float, str]], pricer: Any, cfg: Dict[str, Any],
) -> Dict[str, Any]:
    """One plant's soiling wallet on `day` (see the module doc). `status` ok = judged."""
    rain_mm = float(cfg["soil_rain_mm"])
    resets: List[Tuple[date, str]] = [(min(_end(e), day), "cleaning") for e in _plant_wide(events) if e.day <= day]
    resets += [(d, "rain") for d in _heavy(rain, rain_mm) if d <= day]
    out: Dict[str, Any] = {
        "day": day.isoformat(),
        "status": None,
        "reason": None,
        "reset_day": None,
        "reset_by": None,
        "days_since_reset": None,
        "rate_pct_per_day": _r(rate[0], 3) if rate else None,
        "rate_basis": rate[1] if rate else None,
        "soiling_pct": None,
        "wallet_thb": None,
        "wallet_kwh": None,
        "day_lost_kwh": None,
        "day_thb": None,
        "days_without_energy": 0,
        "cost_thb": _r(cost[0], 0) if cost else None,
        "cost_basis": cost[1] if cost else None,
        "monsoon": in_monsoon(day, cfg),
        "optimal_interval_days": None,
        "fires": False,
    }
    if rate is None:
        return {**out, "status": "no_rate", "reason": "no soiling rate measured yet (plant or fleet)"}
    if not resets:
        return {**out, "status": "no_reset", "reason": "no plant-wide cleaning recorded and no heavy rain in the stored rain record"}
    reset, by = max(resets)
    out.update(reset_day=reset.isoformat(), reset_by=by, days_since_reset=(day - reset).days)
    gap = [reset + timedelta(days=k) for k in range(1, (day - reset).days)]
    if any(rain.get(d) is None for d in gap):
        return {**out, "status": "rain_unknown", "reason": f"rain record incomplete since {reset.isoformat()}: a heavy rain may have washed the array"}
    r, cap = rate[0], float(cfg["r12_max_soiling_pct"])
    kwh_sum = thb_sum = value = 0.0
    valued = 0
    day_kwh: Optional[float] = None
    day_thb: Optional[float] = None
    missing = 0
    sl = 0.0
    for n in range(1, (day - reset).days + 1):
        d = reset + timedelta(days=n)
        sl = min(r * n, cap) / 100
        e = energy.get(d)
        if e is None:
            missing += 1
            if d == day:
                day_kwh = day_thb = None
            continue
        lost = float(e) * sl / (1 - sl)
        thb = pricer.thb(pid, lost, None) or 0.0
        kwh_sum += lost
        thb_sum += thb
        value += pricer.thb(pid, float(e) + lost, None) or 0.0
        valued += 1
        if d == day:
            day_kwh, day_thb = lost, thb
    out.update(
        status="ok",
        soiling_pct=_r(sl * 100, 2),
        wallet_thb=_r(thb_sum, 0),
        wallet_kwh=_r(kwh_sum, 1),
        day_lost_kwh=_r(day_kwh, 2),
        day_thb=_r(day_thb, 0),
        days_without_energy=missing,
    )
    if cost is not None and r > 0 and valued:
        v = value / valued
        if v > 0:
            out["optimal_interval_days"] = round(math.sqrt(2 * cost[0] / (r / 100 * v)))
    if cost is None:
        out["reason"] = "no cleaning cost entered (Calendar → Due, or cost on a cleaning in the Site log)"
    elif out["monsoon"]:
        out["reason"] = "monsoon window: rain is expected to clean the array"
    out["fires"] = bool(cost is not None and not out["monsoon"] and thb_sum >= cost[0])
    return out


def wallets(
    db: Session, day: date, plant_ids: Optional[Sequence[int]], cfg: Dict[str, Any], pricer: Any
) -> Dict[int, Dict[str, Any]]:
    """{plant: wallet on `day`} of the plants with a stored daily row that day."""
    PD = GrowattPlantDaily
    q = select(PD.plant_id).where(PD.day == day)
    if plant_ids is not None:
        q = q.where(PD.plant_id.in_(list(plant_ids)))
    ids = sorted({int(p) for (p,) in db.execute(q)})
    if not ids:
        return {}
    rates = plant_rates(db, day, cfg)  # the fleet rate needs every plant's
    fleet = fleet_rate(rates, cfg)
    start = day - timedelta(days=WALLET_LOOKBACK_DAYS)
    rain = rain_days(db, ids, start, day)
    evs = cleanings(db, ids, until=day)
    costs = cleaning_costs(db, ids, evs)
    energy: Dict[int, Dict[date, Optional[float]]] = defaultdict(dict)
    for pid, d, e in db.execute(
        select(PD.plant_id, PD.day, PD.energy_kwh).where(PD.plant_id.in_(ids), PD.day > start, PD.day <= day)
    ):
        energy[int(pid)][d] = None if e is None else float(e)
    out: Dict[int, Dict[str, Any]] = {}
    for pid in ids:
        rate = (rates[pid], "plant") if pid in rates else ((fleet, "fleet") if fleet is not None else None)
        out[pid] = wallet(pid, day, evs.get(pid, []), rain.get(pid, {}), energy.get(pid, {}), rate, costs.get(pid), pricer, cfg)
    return out


def r12_findings(
    db: Session, day: date, plant_ids: Optional[Sequence[int]], cfg: Dict[str, Any], pricer: Any
) -> List[Dict[str, Any]]:
    from app.services.growatt_rules import _finding

    out: List[Dict[str, Any]] = []
    for pid, w in wallets(db, day, plant_ids, cfg, pricer).items():
        if not w["fires"]:
            continue
        ev = {k: x for k, x in w.items() if k not in ("fires", "status", "reason", "day", "day_lost_kwh", "day_thb")}
        out.append(_finding("R12", "P3", pid, day, None, None, w["day_lost_kwh"], w["day_thb"], **ev))
    return out
