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
"""
from __future__ import annotations

from datetime import datetime, timedelta
from typing import Any, Dict, Iterable, List, Optional, Sequence, Set

from sqlalchemy import select
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
) -> Dict[str, Any]:
    """Adds `available_kw` (modelled), `curtailed_kw` (estimated) and `curtailed_by`
    (`export_limit` / `power_limit` / None) to each curve row in place, and returns the period's
    summary {kwh, slots, judged_slots, by: {cause: kwh}, reason}. `rows` need `pac_kw`,
    `inverters`, `irradiance_wm2`, `module_temp_c` (optional) and, for `export_limit`,
    `grid_import_kw` / `grid_export_kw`. `tmod_fallback` = {day: the day's measured module
    temperature}, used where a slot has none. `kwh` is null when no slot could be judged."""
    stale_set: Set[str] = set(stale)
    fallback = tmod_fallback or {}
    band = max(EXPORT_BAND_KW, EXPORT_BAND_FRAC * kwp) if kwp else EXPORT_BAND_KW
    flagged: Dict[str, str] = {}
    judged = 0
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
        avail = kwp * (float(g) / 1000.0) * max(0.5, 1.0 + (gamma_pct / 100.0) * (float(t_mod) - 25.0)) * factor
        if rated_ac_kw:
            avail = min(avail, rated_ac_kw)
        r["available_kw"] = round(avail, 2)
        if not (MIN_POA_WM2 <= g <= MAX_POA_WM2) or (inverter_count and (r.get("inverters") or 0) < inverter_count):
            continue
        judged += 1
        r["curtailed_kw"] = 0.0
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
    return {
        "kwh": round(kwh, 1) if judged else None,
        "slots": slots,
        "judged_slots": judged,
        "by": {k: round(v, 1) for k, v in by.items()},
        "reason": reason,
        "estimated": True,
        "factor": factor,
        "limit_kw": round(limit_kw, 1) if limit_kw else None,
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
