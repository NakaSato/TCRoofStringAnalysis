"""Live string operating points on the modelled string curve (`/growatt/live/plants/{id}/strings/operating`).

Memory only, like every `/growatt/live/*` answer: built from the same cached live records as
`/live/plants/{id}/latest` (per-inverter cache, so the String page polling both costs no extra
Growatt calls) and the plant's weather-sensor records (`/live/plants/{id}/weather`'s cache).
Nothing is written.

Per string: the newest record's V / I (measured), the ratio to the inverter's other strings in the
same record (`r_i`, from the live string check), and, where the string's module count is entered
on String Layout and a sensor gives irradiance and module temperature, the modelled curve at those
conditions (`solar_core.iv_operating`, the fleet module's datasheet) with `r_imp` / `r_v` and the
gates the point fails. Thresholds: `string_live_criteria.json` next to this module.
"""

from __future__ import annotations

import json
import statistics
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db.models import GrowattInverter, inverter_installed
from app.services import growatt_overview as ov
from app.services import growatt_weather as wx
from app.services import live_string_check
from app.services.fleet_settings import get_fleet_module
from app.services.growatt_live import GrowattLiveService, LiveUnavailable
from solar_core.iv_analysis import ModuleStcSpec
from solar_core.iv_operating import judge_point, string_curve_at

CRITERIA_FILE = Path(__file__).with_name("string_live_criteria.json")
TS_FMT = "%Y-%m-%d %H:%M:%S"
# a string's own module rating this far from the fleet module's = another module: no datasheet
MODULE_WP_TOLERANCE = 0.01


def criteria() -> Dict[str, Any]:
    return json.loads(CRITERIA_FILE.read_text(encoding="utf-8"))


def _ts(s: Optional[str]) -> Optional[datetime]:
    try:
        return datetime.strptime(str(s), TS_FMT) if s else None
    except ValueError:
        return None


def _weather(rows: List[Dict[str, Any]]) -> Tuple[Optional[Dict[str, Any]], Optional[str]]:
    """Mean of the fresh sensors that read both irradiance and module temperature (several
    sensors on one plant are averaged, as in the stored day); the reason when there is none."""
    fresh = [r for r in rows if not r.get("stale")]
    use = [r for r in fresh if r.get("irradiance_wm2") is not None and r.get("module_temp_c") is not None]
    if not use:
        if not fresh:
            return None, "weather sensor not answering (no fresh record)"
        if any(r.get("irradiance_wm2") is not None for r in fresh):
            return None, "the sensor gives no module temperature: no modelled curve"
        return None, "the sensor gives no irradiance: no modelled curve"
    times = [t for t in (_ts(r.get("timestamp")) for r in use) if t]
    amb = [r["ambient_temp_c"] for r in use if r.get("ambient_temp_c") is not None]
    return {
        "irradiance_wm2": round(statistics.mean(float(r["irradiance_wm2"]) for r in use), 1),
        "module_temp_c": round(statistics.mean(float(r["module_temp_c"]) for r in use), 1),
        "ambient_temp_c": round(statistics.mean(amb), 1) if amb else None,
        "timestamp": max(times).strftime(TS_FMT) if times else None,
        "sensors": len(use),
    }, None


def build(db: Session, live: GrowattLiveService, plant_id: int) -> Dict[str, Any]:
    """The live envelope (`source`, `fetched_at`, `stale`, `refresh_in_s`, `data`). Raises
    `LiveUnavailable` when no inverter record can be had (the route answers 503)."""
    invs = list(db.scalars(select(GrowattInverter).where(GrowattInverter.plant_id == plant_id, inverter_installed()).order_by(GrowattInverter.device_sn)))
    if not invs:
        raise LookupError(f"Plant {plant_id} has no inverters")
    sns = [i.device_sn for i in invs]
    phase, coords = ov.plant_phase(db, plant_id), ov.plant_coords(db, plant_id)
    now = live._now_local()  # plant-local, the clock the live cache judges records by
    env = live.plant_latest(plant_id, sns, now.date(), phase=phase, coords=coords)
    records = env["data"]["inverters"]

    # weather: the same per-sensor cache as /live/plants/{id}/weather
    weather: Optional[Dict[str, Any]] = None
    weather_reason: Optional[str]
    refresh = [env["refresh_in_s"]]
    measured = wx.measured_fields(db, plant_id, now - timedelta(days=7))
    if not measured:
        weather_reason = "no weather sensor on this plant: peer ratios only"
    else:
        try:
            wenv = live.plant_weather(plant_id, [(dl, a, f) for (dl, a), f in measured.items()], phase=phase, coords=coords)
            weather, weather_reason = _weather(wenv["data"]["sensors"])
            refresh.append(wenv["refresh_in_s"])
        except LiveUnavailable as exc:
            weather_reason = f"weather sensor unavailable: {exc}"

    cfg = criteria()
    gates_cfg = cfg["gates"]
    fleet = get_fleet_module(db)
    spec = ModuleStcSpec.from_dict(fleet)
    layout = ov.load_layout(db, sns, fleet_wp=False)
    check = live_string_check.check_plant(records, ov.load_layout(db, sns), ov.wired_inputs(db, sns))["inverters"]
    inv_by_sn = {i.device_sn: i for i in invs}
    g = weather["irradiance_wm2"] if weather else None
    t_mod = weather["module_temp_c"] if weather else None
    w_ts = _ts(weather["timestamp"]) if weather else None

    curves: Dict[int, Optional[Dict[str, Any]]] = {}
    strings: List[Dict[str, Any]] = []
    inverters: List[Dict[str, Any]] = []
    for rec in records:
        sn = rec["device_sn"]
        inv = inv_by_sn.get(sn)
        ts = _ts(rec.get("timestamp"))
        age = (now - ts).total_seconds() if ts else None
        rated, limit = (inv.nominal_power_w, inv.active_limit_pct) if inv else (None, None)
        cap = rated * (limit if limit is not None else 100.0) / 100.0 if rated else None
        limited = bool(cap and rec.get("pac_w") is not None and rec["pac_w"] >= gates_cfg["clip_pct_of_rated"] / 100.0 * cap)
        inverters.append(
            {
                "device_sn": sn,
                "alias": inv.alias if inv else None,
                "timestamp": rec.get("timestamp"),
                "age_s": round(age) if age is not None else None,
                "status": rec.get("status"),
                "pac_w": rec.get("pac_w"),
                "limited": limited,
                "stale": bool(rec.get("stale")),
            }
        )
        verdicts = (check.get(sn) or {}).get("strings") or {}
        for s in rec.get("strings") or []:
            no = int(s["string_no"])
            entry = layout.get((sn, no))
            modules, own_wp = (entry if entry else (None, None))
            model_reason: Optional[str] = None
            curve = None
            if modules is None:
                model_reason = "module count not entered (String Layout)"
            elif own_wp is not None and abs(own_wp - spec.wp) > MODULE_WP_TOLERANCE * spec.wp:
                model_reason = f"its module ({own_wp:g} Wp) is not the fleet module: no datasheet to model it"
            elif weather is None:
                model_reason = weather_reason
            else:
                if modules not in curves:
                    curves[modules] = string_curve_at(spec, modules, g, t_mod)  # type: ignore[arg-type]
                curve = curves[modules]
                if curve is None:
                    model_reason = "no light to model (irradiance 0)"
            gap = abs((ts - w_ts).total_seconds()) if ts and w_ts else None
            j = judge_point(
                s.get("voltage_v"),
                s.get("current_a"),
                curve,
                g,
                gates_cfg,
                inverter_status=rec.get("status"),
                limited=limited,
                record_age_s=age,
                weather_gap_s=gap,
            )
            v = verdicts.get(no) or verdicts.get(str(no)) or {}
            dev = v.get("current_dev_pct")
            strings.append(
                {
                    "device_sn": sn,
                    "string_no": no,
                    "mppt_no": s.get("mppt_no"),
                    "modules": modules,
                    "voltage_v": s.get("voltage_v"),
                    "current_a": s.get("current_a"),
                    "power_w": s.get("power_w"),
                    "timestamp": rec.get("timestamp"),
                    "r_i": round(1.0 + dev / 100.0, 3) if dev is not None else None,
                    **j,
                    "model_reason": model_reason,
                    "live_status": v.get("status"),
                    "live_reason": v.get("reason"),
                }
            )

    return {
        **env,
        "refresh_in_s": min(refresh),
        "data": {
            "plant_id": plant_id,
            "modelled": True,
            "weather": weather,
            "weather_reason": weather_reason if weather is None else None,
            "module": {k: fleet.get(k) for k in ("manufacturer", "model", "wp", "source")},
            "criteria": {"version": cfg["version"], "status": cfg["status"], **gates_cfg},
            "curves": [c for c in curves.values() if c is not None],
            "inverters": inverters,
            "strings": strings,
            "errors": env["data"].get("errors") or {},
        },
    }
