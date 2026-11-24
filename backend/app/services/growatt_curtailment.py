"""Solar curtailment per 5-minute slot: **estimated**, never measured.

The energy the array could have given in a slot (`available_kw`, **modelled**) comes from the
plant's weather sensor, as EPI does (services/growatt_overview.py, growatt_daily.py):

    available_kw = kWp × POA / 1000 × (1 + γ (T_mod − 25 °C)) × system factor

with the plant's fitted EPI system factor (services/epi_fit.py), capped at the plant's rated AC
(an inverter at its nameplate is clipping, not curtailment).

A slot counts as curtailed only when the AC is held below that **and** the plant shows why:

- `export_limit`: the grid meter reads about 0 kW in both directions (|grid| ≤ the export band),
  i.e. the inverters follow the site load: a zero-export controller holding PV back. PWA sites run
  this way; their meters have never shown an export.
- `power_limit`: the AC sits at ≥ 98 % of the inverters' active power limit (setting, Σ nameplate ×
  limit %, only when one inverter is below 100 %), the decision rules' "limited".

and the gap (available − AC) is at least `MIN_GAP_FRAC` of the available power and `MIN_GAP_KW`.
A flagged slot also needs a flagged neighbour (runs of ≥ 2 slots), so one passing cloud edge or
a sensor spike does not read as curtailment. `curtailed_kw` = available − AC in those slots, 0 in a
slot judged not curtailed, null where it cannot be judged (no sensor reading, a stale or
low-irradiance slot, no module temperature, a sum over fewer inverters than the plant has, or no
inverter record). Nothing is assumed: without a sensor or kWp every value is null.

**Calibration** (Nov 2026). The model alone reads high: with the default factor 0.985, plants
running freely at midday gave a median 86 % of it (53 never-curtailed plants, 21–23 Nov 2026;
P2_20: 55–65 %), and on a zero-export plant the EPI fit cannot fix that, since curtailment pulls
its EPI down too. So each plant's model is scaled by how the plant really runs when nothing holds
it back: a **free** slot is a judged slot between `FREE_HOURS` with POA ≥ `FREE_MIN_POA_WM2`, the
plant importing more than `FREE_IMPORT_FRAC` of the model (the load is well above the PV, so a
zero-export controller lets it run), not at the power limit and not clipped at rated AC.
`free_ratio` = median AC ÷ model of a day's free slots (stored per day, `growatt_plant_daily`);
a day's `calibration` = the slot-weighted mean of the plant's daily free ratios over the
`CALIBRATION_DAYS` before it (never the day itself), used when they hold ≥ `CALIBRATION_MIN_SLOTS`
free slots (`source: plant`). A plant with fewer (a zero-export plant held back all midday rarely
runs free then; no meter) takes the fleet's slot-weighted ratio over the same days, from at least
`FLEET_MIN_PLANTS` plants (`source: fleet`); without either the plain model stays (`not_checked`).
`available_kw` is then model × ratio (still **modelled**).
"""
from __future__ import annotations

import statistics
from datetime import date, datetime, timedelta
from typing import Any, Dict, Iterable, List, Optional, Sequence, Set

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.db.models import GrowattInverter, inverter_installed

SLOT_H = 5 / 60
MIN_POA_WM2 = 200.0  # below, the model's error is larger than most curtailment (EPI's filter)
MAX_POA_WM2 = 1200.0
MIN_GAP_FRAC = 0.15  # the EPI model scatters a few % around 1 on good days; stay well clear of it
MIN_GAP_KW = 1.0
EXPORT_BAND_KW = 3.0  # |grid| at or under max(this, EXPORT_BAND_FRAC × kWp) = the meter holds ~0
EXPORT_BAND_FRAC = 0.03
LIMIT_FRACTION = 0.98  # as growatt_daily.CLIP_FRACTION
FREE_HOURS = (9, 15)  # plant-local [start, end) hours: the sun angles curtailment happens at
FREE_MIN_POA_WM2 = 400.0
FREE_IMPORT_FRAC = 0.30  # import above this share of the model = surely not held back (controller lag included)
CALIBRATION_DAYS = 14
CALIBRATION_MIN_SLOTS = 12  # one hour of free running over the window
FLEET_MIN_PLANTS = 10
_TS = "%Y-%m-%d %H:%M:%S"


def plant_limit_kw(invs: Sequence[GrowattInverter]) -> Optional[float]:
    """Σ nameplate × active power limit (setting) in kW; None unless every inverter has a nameplate
    and at least one is limited below 100 %."""
    if not invs or any(not i.nominal_power_w for i in invs):
        return None
    pcts = [i.active_limit_pct for i in invs]
    if not any(p is not None and p < 100 for p in pcts):
        return None
    return sum(float(i.nominal_power_w) * min(p if p is not None else 100.0, 100.0) / 100.0 for i, p in zip(invs, pcts)) / 1000.0


def inverters(db: Session, plant_id: int) -> List[GrowattInverter]:
    return list(db.scalars(select(GrowattInverter).where(GrowattInverter.plant_id == plant_id, inverter_installed())))


def annotate(
    rows: List[Dict[str, Any]],
    *,
    kwp: Optional[float],
    rated_ac_kw: Optional[float],
    limit_kw: Optional[float],
    gamma_pct: float,
    factor: float,
    inverter_count: int,
    stale: Iterable[str] = (),
    tmod_fallback: Optional[Dict[str, Optional[float]]] = None,
    calibration: Optional[Dict[str, Dict[str, Any]]] = None,
) -> Dict[str, Any]:
    """Adds `available_kw` (modelled), `curtailed_kw` (estimated) and `curtailed_by`
    (`export_limit` / `power_limit` / None) to each curve row in place, and returns the period's
    summary {kwh, slots, judged_slots, by: {cause: kwh}, reason}. `rows` need `pac_kw`,
    `inverters`, `irradiance_wm2`, `module_temp_c` (optional) and, for `export_limit`,
    `grid_import_kw` / `grid_export_kw`. `tmod_fallback` = {day: the day's measured module
    temperature}, used where a slot has none. `calibration` = {day: `calibration()`}: the model is
    scaled by that day's ratio where it has one. `kwh` is null when no slot could be judged.
    `free_ratio` / `free_slots` are measured against the plain model (stored per day)."""
    stale_set: Set[str] = set(stale)
    fallback = tmod_fallback or {}
    band = max(EXPORT_BAND_KW, EXPORT_BAND_FRAC * kwp) if kwp else EXPORT_BAND_KW
    flagged: Dict[str, str] = {}
    judged = 0
    cal = calibration or {}
    free: List[float] = []
    for r in rows:
        r["available_kw"] = None
        r["curtailed_kw"] = None
        r["curtailed_by"] = None
        if not kwp:
            continue
        g, pac = r.get("irradiance_wm2"), r.get("pac_kw")
        ts = r["timestamp"]
        if g is None or pac is None or ts in stale_set:
            continue
        t_mod = r.get("module_temp_c")
        if t_mod is None:
            t_mod = fallback.get(ts[:10])
        if t_mod is None:
            continue
        model = kwp * (float(g) / 1000.0) * max(0.5, 1.0 + (gamma_pct / 100.0) * (float(t_mod) - 25.0)) * factor
        ratio = (cal.get(ts[:10]) or {}).get("ratio")
        avail = model * ratio if ratio else model
        if rated_ac_kw:
            avail = min(avail, rated_ac_kw)
        r["available_kw"] = round(avail, 2)
        if not (MIN_POA_WM2 <= g <= MAX_POA_WM2) or (inverter_count and (r.get("inverters") or 0) < inverter_count):
            continue
        judged += 1
        r["curtailed_kw"] = 0.0
        imp = r.get("grid_import_kw")
        if (
            FREE_HOURS[0] <= int(ts[11:13]) < FREE_HOURS[1]
            and g >= FREE_MIN_POA_WM2
            and imp is not None
            and model > 0
            and imp > max(band, FREE_IMPORT_FRAC * model)
            and not (limit_kw and pac >= LIMIT_FRACTION * limit_kw)
            and not (rated_ac_kw and (model >= rated_ac_kw or pac >= LIMIT_FRACTION * rated_ac_kw))
        ):
            free.append(float(pac) / model)
        gap = avail - float(pac)
        if gap < max(MIN_GAP_KW, MIN_GAP_FRAC * avail):
            continue
        if limit_kw and pac >= LIMIT_FRACTION * limit_kw:
            flagged[ts] = "power_limit"
            continue
        imp, exp = r.get("grid_import_kw"), r.get("grid_export_kw")
        if imp is not None and exp is not None and imp <= band and exp <= band:
            flagged[ts] = "export_limit"
    step = timedelta(minutes=5)

    def near(ts: str) -> bool:
        t = datetime.strptime(ts, _TS)
        return (t - step).strftime(_TS) in flagged or (t + step).strftime(_TS) in flagged

    kwh = 0.0
    slots = 0
    by: Dict[str, float] = {}
    for r in rows:
        cause = flagged.get(r["timestamp"])
        if cause is None or not near(r["timestamp"]):
            continue
        kw = round(r["available_kw"] - float(r["pac_kw"]), 2)
        r["curtailed_kw"] = kw
        r["curtailed_by"] = cause
        kwh += kw * SLOT_H
        slots += 1
        by[cause] = by.get(cause, 0.0) + kw * SLOT_H
    reason = None
    if not judged:
        reason = "no_capacity" if not kwp else "no_sensor_slots"
    days = sorted({r["timestamp"][:10] for r in rows if r.get("available_kw") is not None})
    used = [cal[d] for d in days if (cal.get(d) or {}).get("ratio")]
    return {
        "kwh": round(kwh, 1) if judged else None,
        "slots": slots,
        "judged_slots": judged,
        "by": {k: round(v, 1) for k, v in by.items()},
        "reason": reason,
        "estimated": True,
        "factor": factor,
        "limit_kw": round(limit_kw, 1) if limit_kw else None,
        # the model's scale of the period's last modelled day: `plant` (its own free slots),
        # `fleet` (the fleet's ratio) or `not_checked` (plain model); `ratio` = mean over the days
        "calibration": {
            "status": (cal.get(days[-1]) or {}).get("source") or "not_checked" if days else "not_checked",
            "ratio": round(statistics.mean(c["ratio"] for c in used), 3) if used else None,
            "slots": (cal.get(days[-1]) or {}).get("slots", 0) if days else 0,
            "days": CALIBRATION_DAYS,
        },
        "free_ratio": round(statistics.median(free), 3) if free else None,
        "free_slots": len(free),
    }


def calibration(db: Session, plant_id: int, days: Sequence[date]) -> Dict[str, Dict[str, Any]]:
    """{day: {ratio, slots, source}} per day in `days`, from the stored daily free ratios of the
    CALIBRATION_DAYS before that day (slot-weighted): the plant's own (`plant`, ≥
    CALIBRATION_MIN_SLOTS free slots), else the fleet's (`fleet`, ≥ FLEET_MIN_PLANTS plants;
    `slots` = the plant's own), else `ratio` null (`source` null)."""
    from app.db.models import GrowattPlantDaily as PD

    if not days:
        return {}
    lo, hi = min(days) - timedelta(days=CALIBRATION_DAYS), max(days)
    stored = [
        (int(p), d, float(r), int(n))
        for p, d, r, n in db.execute(
            select(PD.plant_id, PD.day, PD.free_ratio, PD.free_slots).where(
                PD.day >= lo, PD.day < hi, PD.free_ratio.is_not(None), PD.free_slots > 0
            )
        )
    ]
    out: Dict[str, Dict[str, Any]] = {}
    for day in days:
        win = [(p, r, n) for p, d, r, n in stored if day - timedelta(days=CALIBRATION_DAYS) <= d < day]
        own = [(r, n) for p, r, n in win if p == plant_id]
        n_own = sum(n for _, n in own)
        if n_own >= CALIBRATION_MIN_SLOTS:
            out[day.isoformat()] = {"ratio": round(sum(r * n for r, n in own) / n_own, 3), "slots": n_own, "source": "plant"}
            continue
        n_all = sum(n for _, _, n in win)
        if len({p for p, _, _ in win}) >= FLEET_MIN_PLANTS and n_all:
            out[day.isoformat()] = {"ratio": round(sum(r * n for _, r, n in win) / n_all, 3), "slots": n_own, "source": "fleet"}
            continue
        out[day.isoformat()] = {"ratio": None, "slots": n_own, "source": None}
    return out


def fleet(db: Session, start: date, end: date, plant_ids: Optional[Iterable[int]] = None) -> Dict[str, Any]:
    """Curtailment of every plant (`plant_ids` = the user's scope; None = all) over `start`..`end`
    from the stored daily rows (DB only): per plant the curtailed kWh (estimated), the days with
    any, produced kWh, the share of produced + curtailed, cause split and its last day's
    calibration; per day the fleet totals."""
    from app.db.models import GrowattPlant, GrowattPlantDaily as PD

    q = select(PD).where(PD.day >= start, PD.day <= end)
    plants_q = select(GrowattPlant)
    if plant_ids is not None:
        ids = list(plant_ids)
        q = q.where(PD.plant_id.in_(ids))
        plants_q = plants_q.where(GrowattPlant.plant_id.in_(ids))
    plants = {p.plant_id: p for p in db.scalars(plants_q)}
    per: Dict[int, Dict[str, Any]] = {}
    days: Dict[str, Dict[str, Any]] = {}
    for r in db.scalars(q.order_by(PD.day)):
        if r.plant_id not in plants:
            continue
        p = per.setdefault(r.plant_id, {
            "kwh": None, "energy_kwh": None, "days": 0, "judged_days": 0, "curtailed_days": 0,
            "export_limit_kwh": 0.0, "power_limit_kwh": 0.0, "slots": 0, "last": None,
        })
        p["days"] += 1
        if r.energy_kwh is not None:
            p["energy_kwh"] = (p["energy_kwh"] or 0.0) + float(r.energy_kwh)
        d = days.setdefault(r.day.isoformat(), {"day": r.day.isoformat(), "kwh": None, "plants": 0, "energy_kwh": None})
        if r.energy_kwh is not None:
            d["energy_kwh"] = (d["energy_kwh"] or 0.0) + float(r.energy_kwh)
        if r.curtailed_kwh is None:
            continue
        p["judged_days"] += 1
        p["kwh"] = (p["kwh"] or 0.0) + float(r.curtailed_kwh)
        d["kwh"] = (d["kwh"] or 0.0) + float(r.curtailed_kwh)
        p["slots"] += int(r.curtailed_slots or 0)
        p["export_limit_kwh"] += float(r.curtailed_export_kwh or 0.0)
        p["power_limit_kwh"] += float(r.curtailed_limit_kwh or 0.0)
        p["last"] = r
        if r.curtailed_kwh > 0:
            p["curtailed_days"] += 1
            d["plants"] += 1
    rows = []
    for pid, p in per.items():
        pl, last = plants[pid], p["last"]
        kwh, e = p["kwh"], p["energy_kwh"]
        rows.append({
            "plant_id": pid,
            "name": pl.name,
            "phase": pl.phase,
            "capacity_kwp": last.capacity_kwp if last is not None else None,
            "curtailed_kwh": round(kwh, 1) if kwh is not None else None,
            "energy_kwh": round(e, 1) if e is not None else None,
            # share of what the plant could have given (produced + curtailed)
            "curtailed_pct": round(kwh / (e + kwh) * 100.0, 1) if kwh and e is not None and e + kwh > 0 else (0.0 if kwh == 0 else None),
            "days": p["days"],
            "judged_days": p["judged_days"],
            "curtailed_days": p["curtailed_days"],
            "curtailed_slots": p["slots"],
            "by": {"export_limit": round(p["export_limit_kwh"], 1), "power_limit": round(p["power_limit_kwh"], 1)},
            "last_curtailed_day": None,
            "calibration": {
                "ratio": last.curtail_ratio if last is not None else None,
                "slots": last.curtail_ratio_slots if last is not None else None,
                "status": (last.curtail_ratio_source or "not_checked") if last is not None and last.curtail_ratio is not None else "not_checked",
            },
        })
    last_day = {
        pid: d.isoformat()
        for pid, d in db.execute(
            select(PD.plant_id, func.max(PD.day)).where(PD.day >= start, PD.day <= end, PD.curtailed_kwh > 0).group_by(PD.plant_id)
        )
    }
    for r in rows:
        r["last_curtailed_day"] = last_day.get(r["plant_id"])
    rows.sort(key=lambda r: (r["curtailed_kwh"] is None, -(r["curtailed_kwh"] or 0.0)))
    judged = [r for r in rows if r["curtailed_kwh"] is not None]
    return {
        "meta": {"source": "db", "start": start.isoformat(), "end": end.isoformat(), "estimated": True,
                 "calibration_days": CALIBRATION_DAYS, "calibration_min_slots": CALIBRATION_MIN_SLOTS},
        "summary": {
            "plants": len(rows),
            "judged_plants": len(judged),
            "curtailed_plants": sum(1 for r in judged if (r["curtailed_kwh"] or 0) > 0),
            "plant_calibrated": sum(1 for r in judged if r["calibration"]["status"] == "plant"),
            "fleet_calibrated": sum(1 for r in judged if r["calibration"]["status"] == "fleet"),
            "curtailed_kwh": round(sum(r["curtailed_kwh"] or 0.0 for r in judged), 1) if judged else None,
            "energy_kwh": round(sum(r["energy_kwh"] or 0.0 for r in rows), 1) if rows else None,
        },
        "plants": rows,
        "days": [{**d, "kwh": round(d["kwh"], 1) if d["kwh"] is not None else None,
                  "energy_kwh": round(d["energy_kwh"], 1) if d["energy_kwh"] is not None else None} for d in sorted(days.values(), key=lambda x: x["day"])],
    }


def per_day(rows: Sequence[Dict[str, Any]]) -> Dict[str, Optional[float]]:
    """{day: curtailed kWh} from annotated rows; null for a day with no judged slot."""
    out: Dict[str, Optional[float]] = {}
    for r in rows:
        d = r["timestamp"][:10]
        kw = r.get("curtailed_kw")
        if kw is None:
            out.setdefault(d, None)
            continue
        out[d] = (out.get(d) or 0.0) + kw * SLOT_H
    return {d: (None if v is None else round(v, 1)) for d, v in out.items()}
