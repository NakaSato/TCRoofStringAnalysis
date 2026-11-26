"""Read-only tools the AI Assistant may call (docs/plans/ai-assistant.md §4.3).

Each tool wraps a DB-only service the UI already uses, applies the caller's plant scope
(`allowed` None = admin = every plant) and returns a **compact summary** for the model: rounded
values, units in the key names, capped row counts, `null` kept as `null`. Numbers the model
would otherwise compute (specific yield, rankings) are computed here, because the model gets
arithmetic and sorting wrong (§5.1). Nothing here calls Growatt, writes, or logs a value.
"""

from __future__ import annotations

import json
import logging
import time
from dataclasses import dataclass, field
from datetime import date, timedelta
from typing import Any, Callable, Dict, List, Literal, Optional, Set, Tuple

from pydantic import BaseModel, ConfigDict, Field, ValidationError
from sqlalchemy import func, select
from sqlalchemy.orm import Session, sessionmaker

from app.config import settings
from app.db.models import GrowattInverter, GrowattPlant
from app.services import google_weather as gw, growatt_alarms, growatt_overview as ov, growatt_sensors
from app.services import growatt_weather as wx
from app.services.growatt_inverter_history import build_inverter_daily, build_inverter_timeseries
from app.services.growatt_common import GrowattNotFound, R, _day_bounds, _round

log = logging.getLogger(__name__)

RESULT_MAX_CHARS = 24_000  # ~8k tokens: bigger results are trimmed (lists cut) before sending


@dataclass
class ToolContext:
    """What a tool may see: the caller's plant scope and a session factory (one session per call)."""

    session_factory: sessionmaker
    allowed: Optional[Set[int]]  # None = admin = every plant
    today: date  # plant-local (Bangkok) today
    calls: List[str] = field(default_factory=list)  # tool names in call order, for ai_usage

    def visible(self, plant_id: int) -> bool:
        return self.allowed is None or plant_id in self.allowed


class ToolError(Exception):
    """A tool failure the model should see (as an `is_error` tool result), not a server error."""


# ---------------------------------------------------------------------------------------------
# Input schemas. Validated here, never trusted from the provider.


class _In(BaseModel):
    model_config = ConfigDict(extra="forbid")


class ListPlantsIn(_In):
    query: Optional[str] = Field(None, max_length=100)
    phase: Optional[int] = Field(None, ge=1, le=4)
    limit: int = Field(30, ge=1, le=50)


class PlantOverviewIn(_In):
    plant_id: int
    day: Optional[date] = None


class AlarmsIn(_In):
    day: Optional[date] = None
    plant_id: Optional[int] = None


class FleetRankingIn(_In):
    day: Optional[date] = None
    metric: Literal["specific_yield", "yield"] = "specific_yield"
    order: Literal["lowest", "highest"] = "lowest"
    limit: int = Field(10, ge=1, le=20)


_SN = Field(min_length=1, max_length=64, description="Inverter serial (device_sn) or its alias, e.g. INVERTER 7")


class InverterDailyIn(_In):
    plant_id: int
    device_sn: str = _SN
    days: int = Field(14, ge=1, le=30)
    end_day: Optional[date] = None


class InverterDayProfileIn(_In):
    plant_id: int
    device_sn: str = _SN
    day: Optional[date] = None


class StringDetailIn(_In):
    plant_id: int
    device_sn: str = _SN
    string_no: int = Field(ge=1, le=64)
    day: Optional[date] = None
    end_day: Optional[date] = Field(None, description="Last day of a range starting at day (at most 31 days)")


class WeatherSensorsIn(_In):
    day: Optional[date] = None
    plant_id: Optional[int] = None


class PlantWeatherIn(_In):
    plant_id: int
    day: Optional[date] = None


class OmDashboardIn(_In):
    start: Optional[date] = Field(None, description="First day (default: the 1st of end's month)")
    end: Optional[date] = Field(None, description="Last day (default: today); at most 366 days after start")
    plant_id: Optional[int] = Field(None, description="Limit it to one plant")
    limit: int = Field(10, ge=1, le=20, description="Rows in top_issues and plants_most_lost")


# ---------------------------------------------------------------------------------------------
# Helpers


def _check_day(day: Optional[date], ctx: ToolContext) -> Optional[date]:
    if day is None:
        return None
    if day > ctx.today:
        raise ToolError(f"day {day} is in the future (today is {ctx.today})")
    if day < ctx.today - timedelta(days=settings.history_retention_days):
        raise ToolError(f"day {day} is older than the {settings.history_retention_days} days of stored history")
    return day


def _check_plant(plant_id: int, ctx: ToolContext) -> None:
    if not ctx.visible(plant_id):
        # same answer as for a plant that does not exist: ids outside the scope are not revealed
        raise ToolError(f"plant {plant_id} not found")


def _r(v: Any, nd: int = 1) -> Any:
    return _round(v, nd) if isinstance(v, float) else v


def _pick(d: Dict[str, Any], keys: List[str], nd: int = 1) -> Dict[str, Any]:
    return {k: _r(d.get(k), nd) for k in keys if k in d}


def _resolve_sn(db: Session, plant_id: int, ref: str) -> str:
    """The plant's inverter by serial or alias (the model often has only "INVERTER 7")."""
    rows = db.execute(select(GrowattInverter.device_sn, GrowattInverter.alias).where(GrowattInverter.plant_id == plant_id)).all()
    want = ref.strip().lower()
    for sn, alias in rows:
        if sn.lower() == want:
            return sn
    hits = [sn for sn, alias in rows if alias and alias.strip().lower() == want]
    if len(hits) == 1:
        return hits[0]
    known = ", ".join(f"{sn} ({alias})" if alias else sn for sn, alias in rows[:40])
    raise ToolError(f"inverter {ref!r} not found on plant {plant_id}; its inverters: {known or 'none'}")


def _mean(xs: List[float]) -> Optional[float]:
    return sum(xs) / len(xs) if xs else None


def _latest_day(db: Session) -> Optional[date]:
    ts = db.scalar(select(func.max(R.timestamp)))  # ix_growatt_inv_ts
    return ts.date() if ts else None


# ---------------------------------------------------------------------------------------------
# Tools


def list_plants(args: ListPlantsIn, ctx: ToolContext, db: Session) -> Dict[str, Any]:
    rows = ov.list_plants_summary_shared(db, plant_ids=ctx.allowed)
    if args.phase is not None:
        rows = [p for p in rows if p.get("phase") == args.phase]
    if args.query:
        q = args.query.strip().lower()
        rows = [p for p in rows if q in f"{p.get('name') or ''} {p.get('city') or ''} {p['plant_id']}".lower()]
    out = [
        {
            "plant_id": p["plant_id"],
            "name": p.get("name"),
            "phase": p.get("phase"),
            "city": p.get("city"),
            "capacity_kwp": _r(p.get("peak_power_kwp")),
            "inverters": p.get("inverter_count"),
            "latest_stored_day": p.get("energy_date"),
            "yield_kwh_latest_stored_day": _r(p.get("today_energy_kwh")),
        }
        for p in rows[: args.limit]
    ]
    return {"matches": len(rows), "returned": len(out), "plants": out}


_KPI_KEYS = [
    "capacity_kwp", "yield_today_kwh", "specific_yield_kwh_per_kwp", "iec_pr_pct", "plant_pr_pct",
    "target_pr_pct", "insolation_kwh_m2", "peak_irradiance_wm2", "peak_power_kw", "avg_module_temp_c",
    "avg_ambient_temp_c", "max_temp_c", "inverter_count", "string_count", "healthy_strings",
    "warning_strings", "critical_strings", "inactive_strings", "avg_health_score",
]
# not capacity_kwp / specific_yield: per inverter they are the plant kWp split equally (modelled),
# which misleads when inverters have different string counts; yield per connected string is used
_INV_KEYS = [
    "device_sn", "alias", "nominal_power_kw", "yield_today_kwh", "pr_pct", "peak_ac_kw", "peak_dc_kw",
    "max_temp_c",
]
_STRING_KEYS = [
    "string_id", "device_sn", "string_no", "mppt_no", "status", "diagnosis", "actual_energy_kwh",
    "expected_energy_kwh", "energy_loss_kwh", "pr_pct", "v_avg", "i_avg", "current_mismatch_pct",
    "voltage_mismatch_pct", "availability_pct", "peer_basis",
]


def plant_overview(args: PlantOverviewIn, ctx: ToolContext, db: Session) -> Dict[str, Any]:
    _check_plant(args.plant_id, ctx)
    day = _check_day(args.day, ctx)
    try:
        o = ov.build_plant_overview(db, args.plant_id, day)
    except GrowattNotFound:
        raise ToolError(f"plant {args.plant_id} not found") from None
    kpis = o.get("kpis") or {}
    weather = o.get("weather") or {}
    strings = o.get("strings") or []
    problem = [s for s in strings if s.get("status") not in (None, "Healthy", "healthy")]
    problem.sort(key=lambda s: -(s.get("energy_loss_kwh") or 0))
    kpi_out = _pick(kpis, _KPI_KEYS)
    inactive_by_sn: Dict[Any, int] = {}
    for x in o.get("inactive_strings") or []:
        inactive_by_sn[x.get("device_sn")] = inactive_by_sn.get(x.get("device_sn"), 0) + 1
    # the overview's day energy key reads "today" even for a past day
    kpi_out["yield_kwh"] = kpi_out.pop("yield_today_kwh", None)
    kpi_out["unused_inputs"] = kpi_out.pop("inactive_strings", None)
    return {
        "day": (o.get("meta") or {}).get("day"),
        "data_until": (o.get("meta") or {}).get("data_until"),
        "plant": _pick(o.get("plant") or {}, ["plant_id", "name", "city", "peak_power_kwp", "create_date"]),
        "kpis": kpi_out,
        "iec_pr_note": (weather.get("iec_pr") or {}).get("reason"),
        "has_weather_sensor": weather.get("has_sensor"),
        "inverters": [
            {
                **{k: v for k, v in _pick(i, _INV_KEYS).items() if k != "yield_today_kwh"},
                "yield_kwh": _r(i.get("yield_today_kwh")),
                # counted here so the model doesn't: strings that carried current that day, and inputs
                # with no current that day nor in the 7 days before (usually nothing wired)
                "strings_connected": i.get("string_count"),
                "unused_inputs": inactive_by_sn.get(i.get("device_sn"), 0),
                "yield_per_string_kwh": _r(i["yield_today_kwh"] / i["string_count"], 1)
                if i.get("yield_today_kwh") is not None and i.get("string_count")
                else None,
                # reached its rated AC power: midday output was likely capped by the inverter
                "clipping_likely": (i["peak_ac_kw"] >= 0.98 * i["nominal_power_kw"])
                if i.get("peak_ac_kw") is not None and i.get("nominal_power_kw")
                else None,
            }
            for i in (o.get("inverters") or [])
        ],
        "strings_with_problems": [_pick(s, _STRING_KEYS) for s in problem[:15]],
        "strings_with_problems_total": len(problem),
        # "Not Active" inputs: no current that day and none in the 7 days before, so almost always an
        # input with no string connected, not a fault. A string that stopped producing is Critical
        # in strings_with_problems instead.
        "unused_inputs_note": "Inputs with no current that day nor in the previous 7 days: usually nothing is wired "
        "to them (not a fault). A string that stopped producing is listed as Critical in strings_with_problems.",
        "unused_inputs": [
            _pick(s, ["device_sn", "string_no", "reason"]) for s in (o.get("inactive_strings") or [])[:20]
        ],
        "anomalies": [
            _pick(a, ["string_id", "device_sn", "severity", "category", "description", "energy_loss_kwh", "recommended_action"])
            for a in (o.get("anomalies") or [])[:10]
        ],
        "loss_waterfall": [_pick(w, ["stage", "kwh", "type"]) for w in (o.get("loss_waterfall") or [])],
    }


def alarms(args: AlarmsIn, ctx: ToolContext, db: Session) -> Dict[str, Any]:
    day = _check_day(args.day, ctx) or ctx.today
    scope = ctx.allowed
    if args.plant_id is not None:
        _check_plant(args.plant_id, ctx)
        scope = {args.plant_id}
    a = growatt_alarms.alarm_day(db, day, scope)
    rows = a.get("alarms") or []
    plants = a.get("plants") or []
    open_rows = [r for r in rows if not r.get("end_time")]

    by_code: Dict[Tuple[Any, Any, Any], Dict[str, Any]] = {}
    for r in rows:
        k = (r.get("alarm_code"), r.get("alarm_message"), r.get("fault_type"))
        e = by_code.setdefault(k, {"alarm_code": k[0], "message": k[1], "type": k[2], "count": 0, "open": 0, "plants": set()})
        e["count"] += 1
        e["open"] += 0 if r.get("end_time") else 1
        e["plants"].add(r.get("plant_name"))
    codes = sorted(by_code.values(), key=lambda e: (-e["open"], -e["count"]))
    for e in codes:
        e["plants"] = sorted(p for p in e["plants"] if p)[:10]

    per_plant: Dict[int, Dict[str, Any]] = {}
    for r in rows:
        e = per_plant.setdefault(r["plant_id"], {"plant_id": r["plant_id"], "name": r.get("plant_name"), "alarms": 0, "open": 0})
        e["alarms"] += 1
        e["open"] += 0 if r.get("end_time") else 1

    not_read = [p for p in plants if (p.get("synced_inverters") or 0) < (p.get("inverters") or 0)]
    return {
        "day": a.get("day"),
        "total_alarms": len(rows),
        "open_alarms": len(open_rows),
        "plants_in_scope": len(plants),
        "by_code": codes[:20],
        "plants_with_alarms": sorted(per_plant.values(), key=lambda e: (-e["open"], -e["alarms"]))[:25],
        "open_alarm_list": [
            _pick(r, ["plant_id", "plant_name", "device_sn", "alarm_code", "alarm_message", "fault_type", "start_time"])
            for r in open_rows[:30]
        ],
        # inverters whose log for the day is not read yet: "no alarms" there is unknown, not zero
        "log_not_read_yet": {
            "plants": len(not_read),
            "inverters": sum((p.get("inverters") or 0) - (p.get("synced_inverters") or 0) for p in not_read),
        },
        "log_read_at_utc": (a.get("meta") or {}).get("synced_at"),
    }


def _plant_day_yields(db: Session, day: date, plant_ids: Optional[Set[int]]) -> Dict[int, float]:
    """kWh per plant on `day`: each inverter's last `eac_today` that day, summed (same rule as the
    plant list and overview; MAX() would catch yesterday's total carried past midnight)."""
    start, end = _day_bounds(day)
    inv = GrowattInverter
    newest = (
        select(R.eac_today_kwh)
        .where(R.device_sn == inv.device_sn, R.eac_today_kwh.is_not(None), R.timestamp >= start, R.timestamp < end)
        .order_by(R.device_sn.desc(), R.timestamp.desc())
        .limit(1)
        .correlate(inv)
        .scalar_subquery()
    )
    q = select(inv.plant_id, newest)
    if plant_ids is not None:
        q = q.where(inv.plant_id.in_(plant_ids or {-1}))
    out: Dict[int, float] = {}
    for pid, v in db.execute(q):
        if v is not None:
            out[int(pid)] = out.get(int(pid), 0.0) + float(v)
    return out


def fleet_ranking(args: FleetRankingIn, ctx: ToolContext, db: Session) -> Dict[str, Any]:
    day = _check_day(args.day, ctx) or _latest_day(db)
    if day is None:
        raise ToolError("no inverter history stored yet")
    plants = {p["plant_id"]: p for p in ov.list_plants_summary_shared(db, plant_ids=ctx.allowed)}
    yields = _plant_day_yields(db, day, set(plants) if ctx.allowed is not None else None)
    ranked: List[Dict[str, Any]] = []
    no_data: List[Dict[str, Any]] = []
    zero: List[Dict[str, Any]] = []
    for pid, p in plants.items():
        kwh = yields.get(pid)
        kwp = p.get("peak_power_kwp")
        if kwh is None:
            no_data.append({"plant_id": pid, "name": p.get("name")})
            continue
        sy = kwh / kwp if kwp else None
        if kwh <= 0:
            # reported 0 kWh all day: offline, switched off or a stuck counter, not a low performer
            zero.append({"plant_id": pid, "name": p.get("name")})
            continue
        ranked.append({
            "plant_id": pid,
            "name": p.get("name"),
            "phase": p.get("phase"),
            "capacity_kwp": _r(kwp),
            "yield_kwh": _r(kwh),
            "specific_yield_kwh_kwp": _r(sy, 2),
        })
    start, end = _day_bounds(day)
    data_until = db.scalar(select(func.max(R.timestamp)).where(R.timestamp >= start, R.timestamp < end))
    key = "specific_yield_kwh_kwp" if args.metric == "specific_yield" else "yield_kwh"
    usable = [r for r in ranked if r[key] is not None]
    usable.sort(key=lambda r: r[key], reverse=args.order == "highest")
    for i, r in enumerate(usable, 1):
        r["rank"] = i
    vals = [r[key] for r in usable]
    return {
        "day": day.isoformat(),
        # newest stored record that day, fleet-wide: an earlier time means a partial day
        "data_until": data_until.strftime("%Y-%m-%d %H:%M") if data_until else None,
        "metric": key,
        "order": args.order,
        "ranking": usable[: args.limit],
        "plants_ranked": len(usable),
        "fleet_median": _r(sorted(vals)[len(vals) // 2], 2) if vals else None,
        # no stored yield that day: offline, not synced yet, or no data; never ranked as zero
        "plants_without_data": len(no_data),
        "plants_without_data_sample": no_data[:15],
        # reported 0 kWh that day (offline, switched off, stuck counter): not ranked; check alarms
        "plants_zero_yield": len(zero),
        "plants_zero_yield_sample": zero[:15],
    }


# String mismatch rule, same as the String page (frontend stringDetail/analysis.ts): a 5-min slot is
# judged only when the peers carry >= 1 A; thresholds = the live string check's -15 % / -40 %.
MISMATCH_MIN_PEER_A = 1.0
DEV_WARN_PCT = -15.0
DEV_CRIT_PCT = -40.0


def inverter_daily(args: InverterDailyIn, ctx: ToolContext, db: Session) -> Dict[str, Any]:
    _check_plant(args.plant_id, ctx)
    end = _check_day(args.end_day, ctx)
    sn = _resolve_sn(db, args.plant_id, args.device_sn)
    d = build_inverter_daily(db, args.plant_id, sn, end, args.days)
    rows = d.get("daily") or []
    own = [r["yield_kwh"] for r in rows if r.get("yield_kwh") is not None]
    vs = [r["vs_plant_pct"] for r in rows if r.get("vs_plant_pct") is not None]
    return {
        "device_sn": sn,
        "nominal_power_kw": d.get("nominal_power_kw"),
        "from": (d.get("meta") or {}).get("from"),
        "to": (d.get("meta") or {}).get("to"),
        # vs_plant_pct = this inverter's yield / the plant's per-inverter average that day x 100 (measured)
        "daily": [_pick(r, ["day", "yield_kwh", "plant_avg_yield_kwh", "vs_plant_pct", "peak_ac_kw", "max_temp_c", "inverters_reporting"], 2) for r in rows],
        "summary": {
            "days_with_data": len(own),
            "days_without_data": len(rows) - len(own),
            "total_yield_kwh": _r(sum(own), 1) if own else None,
            "mean_vs_plant_pct": _r(_mean(vs), 1),
            "min_vs_plant_pct": _r(min(vs), 1) if vs else None,
        },
    }


def inverter_day_profile(args: InverterDayProfileIn, ctx: ToolContext, db: Session) -> Dict[str, Any]:
    _check_plant(args.plant_id, ctx)
    day = _check_day(args.day, ctx)
    sn = _resolve_sn(db, args.plant_id, args.device_sn)
    t = build_inverter_timeseries(db, args.plant_id, sn, day)
    hours: Dict[int, Dict[str, List[float]]] = {}
    for r in t.get("timeseries") or []:
        h = int(str(r["timestamp"])[11:13])
        e = hours.setdefault(h, {"ac": [], "exp": [], "temp": []})
        if r.get("pac_kw") is not None:
            e["ac"].append(r["pac_kw"])
        if r.get("expected_kw") is not None:
            e["exp"].append(r["expected_kw"])
        if r.get("temp_c") is not None:
            e["temp"].append(r["temp_c"])
    st = t.get("strings") or {}
    nos: List[int] = st.get("string_nos") or []
    stamps: List[str] = st.get("timestamps") or []
    cur: List[List[Optional[float]]] = st.get("current_a") or []
    s_hours: Dict[int, List[float]] = {}
    per_string: Dict[int, List[float]] = {n: [] for n in nos}
    for j, ts in enumerate(stamps):
        col: List[float] = [v for row in cur if j < len(row) and (v := row[j]) is not None]
        if not col or max(col) < MISMATCH_MIN_PEER_A:
            continue  # dawn, dusk, night: too little current to compare strings
        h = int(str(ts)[11:13])
        s_hours.setdefault(h, []).extend(col)
        for n, row in zip(nos, cur):
            v = row[j] if j < len(row) else None
            if v is not None:
                per_string[n].append(v)
    means = {n: _mean(v) for n, v in per_string.items()}
    # no current all day: an unused input (or a string that is open); not part of the string mean
    silent = sorted(n for n, v in per_string.items() if not v or max(v) < 0.3)
    known = [m for n, m in means.items() if m is not None and n not in silent]
    avg_all = _mean(known)
    hourly = []
    for h in sorted(set(hours) | set(s_hours)):
        e = hours.get(h, {"ac": [], "exp": [], "temp": []})
        sc = s_hours.get(h, [])
        hourly.append({
            "hour": f"{h:02d}:00",
            "ac_kw_mean": _r(_mean(e["ac"]), 1),
            "ac_kw_max": _r(max(e["ac"]), 1) if e["ac"] else None,
            "expected_kw_mean_modelled": _r(_mean(e["exp"]), 1),
            "temp_c_max": _r(max(e["temp"]), 1) if e["temp"] else None,
            "string_current_a_min": _r(min(sc), 2) if sc else None,
            "string_current_a_mean": _r(_mean(sc), 2),
            "string_current_a_max": _r(max(sc), 2) if sc else None,
        })
    return {
        "day": (t.get("meta") or {}).get("day"),
        "device_sn": sn,
        "nominal_power_kw": t.get("nominal_power_kw"),
        "capacity_kwp": t.get("capacity_kwp"),
        "capacity_basis": t.get("capacity_basis"),
        "hourly": [h for h in hourly if any(v not in (None, 0.0) for k, v in h.items() if k != "hour")],
        # daylight mean current per string (slots where any string carries >= 1 A), vs. the mean of all strings
        "strings_daylight_mean": [
            {
                "string_no": n,
                "current_a_mean": _r(m, 2),
                "vs_strings_mean_pct": _r((m - avg_all) / avg_all * 100.0, 1) if m is not None and avg_all else None,
            }
            for n, m in sorted(means.items())
            if n not in silent
        ],
        # check plant_overview: unused_inputs there have had no current for 7 days (nothing wired)
        "inputs_without_current": silent,
    }


def string_detail(args: StringDetailIn, ctx: ToolContext, db: Session) -> Dict[str, Any]:
    _check_plant(args.plant_id, ctx)
    day = _check_day(args.day, ctx)
    end_day = _check_day(args.end_day, ctx)
    if end_day is not None and (day is None or end_day < day):
        raise ToolError("end_day needs day and must not be before it")
    sn = _resolve_sn(db, args.plant_id, args.device_sn)
    try:
        d = ov.build_string_detail(db, args.plant_id, sn, args.string_no, day, end_day=end_day)
    except ValueError as exc:
        raise ToolError(str(exc)) from None
    judged = warn = crit = 0
    own_i: List[float] = []
    peer_i: List[float] = []
    own_v: List[float] = []
    peer_v: List[float] = []
    run = best = 0
    run_from: Optional[str] = None
    best_span: Tuple[Optional[str], Optional[str]] = (None, None)
    by_hour: Dict[int, List[float]] = {}
    by_hour_peer: Dict[int, List[float]] = {}
    for r in d.get("timeseries") or []:
        pi = r.get("peer_current_a")
        i = r.get("current_a")
        if pi is None or i is None or pi < MISMATCH_MIN_PEER_A:
            continue
        judged += 1
        dev = (i - pi) / pi * 100.0
        own_i.append(i)
        peer_i.append(pi)
        if r.get("voltage_v") is not None and r.get("peer_voltage_v"):
            own_v.append(r["voltage_v"])
            peer_v.append(r["peer_voltage_v"])
        h = int(str(r["timestamp"])[11:13])
        by_hour.setdefault(h, []).append(i)
        by_hour_peer.setdefault(h, []).append(pi)
        crit += dev <= DEV_CRIT_PCT
        if dev <= DEV_WARN_PCT:
            warn += 1
            if run == 0:
                run_from = str(r["timestamp"])
            run += 1
            if run > best:
                best, best_span = run, (run_from, str(r["timestamp"]))
        else:
            run = 0
    hours = [
        {
            "hour": f"{h:02d}:00",
            "slots": len(by_hour[h]),
            "current_a": _r(_mean(by_hour[h]), 2),
            "peer_current_a": _r(_mean(by_hour_peer[h]), 2),
            "dev_pct": _r((sum(by_hour[h]) - sum(by_hour_peer[h])) / sum(by_hour_peer[h]) * 100.0, 1),
        }
        for h in sorted(by_hour)
    ]
    worst = min(hours, key=lambda x: x["dev_pct"]) if hours else None
    return {
        "meta": d.get("meta"),
        "string_id": d.get("string_id"),
        "plant_name": d.get("plant_name"),
        "mppt_no": d.get("mppt_no"),
        "modules": d.get("modules"),
        "module_wp": d.get("module_wp"),
        # peers = the other strings of the same inverter; pr_pct is peer-relative (modelled), not IEC PR
        "peer_basis": d.get("peer_basis"),
        "summary": _pick(d.get("summary") or {}, ["energy_kwh", "peer_energy_kwh", "pr_pct", "v_avg", "v_max", "v_mpp", "i_avg", "i_max", "i_mpp", "p_max_w"], 2),
        "daily": [_pick(x, ["day", "energy_kwh", "peer_energy_kwh", "pr_pct"], 2) for x in (d.get("daily") or [])][:31],
        "mismatch_measured": {
            "rule": f"5-min slots where the peers carry >= {MISMATCH_MIN_PEER_A:g} A; warn <= {DEV_WARN_PCT:g} %, critical <= {DEV_CRIT_PCT:g} %",
            "judged_slots": judged,
            "slots_at_or_below_warn": warn,
            "slots_at_or_below_critical": crit,
            "mean_current_dev_pct": _r((sum(own_i) - sum(peer_i)) / sum(peer_i) * 100.0, 1) if peer_i else None,
            "mean_voltage_dev_pct": _r((sum(own_v) - sum(peer_v)) / sum(peer_v) * 100.0, 1) if peer_v else None,
            "mean_voltage_v": _r(_mean(own_v), 1),
            "mean_peer_voltage_v": _r(_mean(peer_v), 1),
            "longest_low_run_slots": best,
            "longest_low_run_from": best_span[0],
            "longest_low_run_to": best_span[1],
            "worst_hour": worst,
        },
        "by_hour": hours,
    }


def weather_sensors(args: WeatherSensorsIn, ctx: ToolContext, db: Session) -> Dict[str, Any]:
    day = _check_day(args.day, ctx)
    scope = ctx.allowed
    if args.plant_id is not None:
        _check_plant(args.plant_id, ctx)
        scope = {args.plant_id}
    res = growatt_sensors.list_sensors(db, scope, day=day)
    meta = res.get("meta") or {}
    gap = meta.get("alarm_coverage_pct")
    rows = res.get("sensors") or []

    def badness(s: Dict[str, Any]) -> Tuple[int, float]:
        cov = s.get("coverage_pct")
        return (-len(s.get("flags") or []), cov if cov is not None else -1.0)

    rows = sorted(rows, key=badness)
    low = [s for s in rows if s.get("coverage_pct") is not None and gap is not None and s["coverage_pct"] < gap]
    return {
        "day": meta.get("day"),
        "coverage_window": meta.get("coverage_window"),
        "note": "Stored history only: whether a sensor is online right now is not known here (see the Weather Sensors page).",
        "sensors_total": len(rows),
        "sensors_below_coverage": len(low),
        "coverage_threshold_pct": gap,
        "sensors_with_flags": sum(1 for s in rows if s.get("flags")),
        "sensors": [
            {
                **_pick(s, ["key", "plant_id", "plant_name", "phase", "coverage_pct", "last_reading_at"]),
                "measured": s.get("measured"),
                "last_reading": {k: _r(v, 1) for k, v in (s.get("last") or {}).items()},
                "flags": [_pick(f, ["code", "field", "reason"]) for f in (s.get("flags") or [])],
            }
            for s in rows[:25]
        ],
    }


def plant_weather(args: PlantWeatherIn, ctx: ToolContext, db: Session) -> Dict[str, Any]:
    _check_plant(args.plant_id, ctx)
    day = _check_day(args.day, ctx)
    plant = db.get(GrowattPlant, args.plant_id)
    if plant is None:
        raise ToolError(f"plant {args.plant_id} not found")
    w = wx.build_weather_day(db, args.plant_id, day)
    hourly: Dict[int, List[float]] = {}
    for r in w.get("series") or []:
        if r.get("irradiance_wm2") is not None:
            hourly.setdefault(int(str(r["timestamp"])[11:13]), []).append(r["irradiance_wm2"])
    sensor_day = (w.get("meta") or {}).get("day")
    g = gw.build_day(db, plant, date.fromisoformat(sensor_day) if sensor_day else day)
    return {
        "plant": {"plant_id": plant.plant_id, "name": plant.name},
        "sensor": {
            "has_sensor": w.get("has_sensor"),
            "day": sensor_day,
            "data_until": (w.get("meta") or {}).get("data_until"),
            "kpis_measured": {k: _r(v, 2) for k, v in (w.get("kpis") or {}).items()},
            "irradiance_wm2_hourly_mean": [
                {"hour": f"{h:02d}:00", "wm2": _r(_mean(v), 0)} for h, v in sorted(hourly.items()) if 6 <= h <= 18
            ],
        },
        "google_weather_modelled": {
            "day": (g.get("meta") or {}).get("day"),
            "available": bool(g.get("configured") and g.get("has_location") and g.get("hours")),
            "kpis": g.get("kpis"),
            "slots_09_13_17": g.get("slots"),
            "rain": g.get("rain"),
        },
    }


_ISSUE_KEYS = [
    "plant_id", "plant_name", "inverter_name", "device_sn", "string_no", "rule", "name", "tier", "safety",
    "status", "opened_day", "last_seen_day", "age_days", "days_seen", "lost_kwh_est", "lost_kwh_total_est", "next_visit",
]
_PLANT_KEYS = [
    "plant_id", "name", "capacity_kwp", "energy_kwh", "lost_kwh_est", "loss_share_pct", "active_issues", "epi_median",
    "pr_temp_corrected_median_pct", "availability_pct", "days_since_cleaning", "next_visit", "spend_thb", "open_claims",
]


# om_center marks these modelled (`meta.modelled`); the key says so, as `expected_kw_mean_modelled` does
_PLANT_MODELLED = {"epi_median": "epi_median_modelled", "pr_temp_corrected_median_pct": "pr_temp_corrected_median_pct_modelled"}


def _modelled_keys(row: Dict[str, Any]) -> Dict[str, Any]:
    return {_PLANT_MODELLED.get(k, k): v for k, v in row.items()}


def om_dashboard(args: OmDashboardIn, ctx: ToolContext, db: Session) -> Dict[str, Any]:
    """The Energy & Billing (O&M Dashboard) figures for a period: loss by cause, issues to fix first, plants
    losing the most, this week's work, response times and claims. Live issues only (never shadow rules);
    estimated loss in kWh only, as the page shows it (no estimated baht); spend is entered."""
    from app.services import om_center  # imports the rules / tariff stack; only when the tool runs

    end = args.end or ctx.today
    start = args.start or end.replace(day=1)
    if end > ctx.today:
        raise ToolError(f"end {end.isoformat()} is after today ({ctx.today.isoformat()})")
    if start > end:
        raise ToolError("start must not be after end")
    if (end - start).days + 1 > om_center.MAX_SPAN_DAYS:
        raise ToolError(f"the period may span at most {om_center.MAX_SPAN_DAYS} days")
    scope = ctx.allowed
    if args.plant_id is not None:
        _check_plant(args.plant_id, ctx)
        scope = {args.plant_id}
    # admins (ctx.allowed None) get the shadow count for one plant too; engineers never
    o = om_center.overview(db, scope, start, end, include_shadow=False, count_shadow=ctx.allowed is None)

    m = o["money"]
    families = {f["key"]: f["label"] for f in o["loss_by_cause"]["families"]}
    by_cause = sorted(
        ({"cause": families.get(t["family"], t["family"]), "lost_kwh_est": t["kwh_est"]} for t in o["loss_by_cause"]["totals"]),
        key=lambda r: -(r["lost_kwh_est"] or 0),
    )
    plants = sorted(o["plants"], key=lambda r: (-(r["lost_kwh_est"] or 0), r["name"] or ""))
    losing = [_modelled_keys(_pick(r, _PLANT_KEYS, 2)) for r in plants if r["lost_kwh_est"]][: args.limit]
    top = o["issues"]["top"]
    issues = []
    for d in top[: args.limit]:
        row = _pick(d, _ISSUE_KEYS, 1)
        row["acknowledged"] = d.get("ack_at") is not None
        row["claims_open"] = sum(1 for c in d.get("claims") or [] if c.get("open"))
        issues.append(row)
    return {
        "window": o["window"],
        "scope": "one plant" if args.plant_id is not None else o["scope"],
        "plant_count": o["plant_count"],
        "summary": {
            "produced_kwh": m["produced_kwh"],
            "lost_kwh_est": m["lost_kwh_est"],
            "loss_share_pct": m["loss_share_pct"],
            "availability_pct": m["availability_pct"],
            "power_limited_min": m["limited_min"],
            "active_issues": m["active_issues"],
            "safety_issues": m["safety_issues"],
            "active_by_tier": m["by_tier"],
            "spend_thb_entered": m["spend_thb"],
            "spend_events": m["spend_events"],
            "spend_events_with_cost": m["spend_events_priced"],
            "open_tasks": m["committed_tasks"],
        },
        "loss_by_cause": by_cause,
        "top_issues_total": o["issues"]["total"],
        # admins only (None for engineers): issues of rules still in shadow mode, not in any figure here
        "shadow_issues_left_out": o["shadow_hidden"],
        "top_issues": issues,
        "plants_with_loss": sum(1 for r in plants if r["lost_kwh_est"]),
        "plants_most_lost": losing,
        "work_this_week": o["work"],
        "response": o["response"]["tiers"],
        "response_targets_days": o["response"]["targets"],
        "claims_open": o["claims"],
        "notes": [
            "lost_kwh_est is ESTIMATED by the detection rules, each kWh counted once across overlapping rules",
            "produced_kwh and availability_pct are measured (stored inverter days); null = no stored data, not 0",
            "spend_thb_entered is typed in by the team; null = no cost entered",
            "epi_median_modelled and pr_temp_corrected_median_pct_modelled are MODELLED (measured energy against a "
            "model of what the plant should give), not measured; say so when quoting them",
            "top_issues are the active issues in fix-first order (safety, tier, loss); issues of rules in shadow mode are left out "
            "(shadow_issues_left_out counts them): with none live, no loss estimate means rules not live yet, not no loss",
            "response counts issues first seen in the window; days are whole plant-local days",
        ],
    }


# ---------------------------------------------------------------------------------------------
# Registry

ToolFn = Callable[[Any, ToolContext, Session], Dict[str, Any]]

_TOOLS: Dict[str, Tuple[type[_In], ToolFn, str]] = {
    "alarms": (
        AlarmsIn,
        alarms,
        "Stored Growatt alarm log for one day (default today, Bangkok time): counts by code and by plant, "
        "the open alarms (no end time yet), and how many inverters' logs are not read yet that day "
        "(for those, no alarms means unknown, not zero). Optional plant_id limits it to one plant.",
    ),
    "fleet_ranking": (
        FleetRankingIn,
        fleet_ranking,
        "Rank plants by daily yield (kWh) or specific yield (kWh/kWp) for one stored day (default: the "
        "newest stored day). Values and ranks are computed by the server: quote them, don't recompute. "
        "Plants with no stored yield and plants that reported 0 kWh (offline / not producing) are listed "
        "apart, not ranked; mention them separately.",
    ),
    "inverter_daily": (
        InverterDailyIn,
        inverter_daily,
        "One inverter's stored daily yield over 1-30 days ending at end_day (default: its newest stored day), "
        "with the plant's per-inverter average and vs_plant_pct (measured; 100 = average), peak AC kW and max "
        "temperature. device_sn may be the serial or the alias (e.g. INVERTER 7); get them from plant_overview.",
    ),
    "inverter_day_profile": (
        InverterDayProfileIn,
        inverter_day_profile,
        "One inverter's day by hour (stored, default newest day): mean / max AC kW, expected kW (modelled), "
        "max temperature, string currents min / mean / max, and each string's daylight mean current vs. the "
        "mean of its inverter's strings. Use it for when in the day a loss or clipping happened.",
    ),
    "list_plants": (
        ListPlantsIn,
        list_plants,
        "Find plants by name, city or id (Thai or English text, substring match) and/or project phase "
        "1-4. Returns plant_id, name, capacity kWp, inverter count and the yield of the newest stored day. "
        "Use it to turn a plant name into a plant_id.",
    ),
    "om_dashboard": (
        OmDashboardIn,
        om_dashboard,
        "The O&M dashboard for a period (default: month to date) over the user's plants, or one plant_id: produced "
        "kWh, ESTIMATED lost kWh by cause and its share, availability, the active issues to fix first, the plants "
        "losing the most (with EPI and temperature-corrected PR', both MODELLED), this week's Calendar tasks and "
        "overdue backlog, response times per tier vs targets, and open claims. Use it for 'what are we losing / what "
        "to fix first / is the work keeping up'. No baht estimates.",
    ),
    "plant_overview": (
        PlantOverviewIn,
        plant_overview,
        "Stored-data summary of one plant for one day (default: newest stored day): yield, specific "
        "yield, IEC PR (iec_pr_pct, measured; null when there is no weather sensor or too little "
        "irradiance data, see iec_pr_note), peer-relative plant_pr_pct (modelled), insolation, temperatures, "
        "per-inverter yield, strings with problems and their diagnosis, inactive strings, anomalies, "
        "loss waterfall.",
    ),
    "plant_weather": (
        PlantWeatherIn,
        plant_weather,
        "Weather of one plant for one day: its weather sensor's measured insolation (kWh/m2), peak irradiance, "
        "temperatures, humidity and wind plus hourly mean irradiance; and Google Maps Weather for the plant's "
        "location (MODELLED, not measured): rain, cloud cover, and the 09/13/17 slots. has_sensor false = no sensor.",
    ),
    "string_detail": (
        StringDetailIn,
        string_detail,
        "One string (device_sn + string_no) on one day or a day range (end_day, at most 31 days): energy vs. "
        "its peers (the inverter's other strings; pr_pct is peer-relative, modelled), voltage / current, and a "
        "MEASURED mismatch analysis: current vs. peers per 5-min slot (counts below -15 % / -40 %, longest low "
        "run, worst hour) and mean voltage deviation. Use it to diagnose a string flagged by plant_overview.",
    ),
    "weather_sensors": (
        WeatherSensorsIn,
        weather_sensors,
        "Weather sensors from stored history for one day (default today): daylight data coverage % "
        "(06:00-18:00), health flags with reasons (probe missing, irradiance 0 in daylight, history behind), "
        "the newest stored reading and its time. Worst first. Optional plant_id. No live online status.",
    ),
}


def _schema(model: type[_In]) -> Dict[str, Any]:
    s = model.model_json_schema()
    s.pop("title", None)
    for p in (s.get("properties") or {}).values():
        p.pop("title", None)
    s["additionalProperties"] = False
    return s


def tool_definitions() -> List[Dict[str, Any]]:
    """Tool list for the Messages API: sorted and deterministic, so the prompt prefix caches."""
    return [
        {"name": name, "description": desc, "input_schema": _schema(model)}
        for name, (model, _fn, desc) in sorted(_TOOLS.items())
    ]


def run_tool(name: str, raw_input: Any, ctx: ToolContext) -> Tuple[str, bool]:
    """Run one tool call. Returns (JSON text for the tool_result, is_error). Never raises."""
    ctx.calls.append(name)
    entry = _TOOLS.get(name)
    if entry is None:
        return json.dumps({"error": f"unknown tool {name}"}), True
    model, fn, _desc = entry
    t0 = time.monotonic()
    try:
        args = model.model_validate(raw_input if isinstance(raw_input, dict) else {})
    except ValidationError as exc:
        errs = [f"{'.'.join(str(x) for x in e['loc'])}: {e['msg']}" for e in exc.errors()]
        return json.dumps({"error": "invalid input", "details": errs}, ensure_ascii=False), True
    try:
        with ctx.session_factory() as db:
            result = fn(args, ctx, db)
    except ToolError as exc:
        return json.dumps({"error": str(exc)}, ensure_ascii=False), True
    except GrowattNotFound as exc:
        return json.dumps({"error": str(exc)}, ensure_ascii=False), True
    except Exception:  # noqa: BLE001 - a failing tool must not end the turn
        log.exception("assistant tool %s failed", name)
        return json.dumps({"error": "internal error while reading data"}), True
    text = _dump(result)
    log.info("assistant tool %s ok in %d ms (%d chars)", name, (time.monotonic() - t0) * 1000, len(text))
    return text, False


def _dump(result: Dict[str, Any]) -> str:
    text = json.dumps(result, ensure_ascii=False, separators=(",", ":"), default=str)
    if len(text) <= RESULT_MAX_CHARS:
        return text
    # trim the longest lists until it fits, and say so
    trimmed = dict(result)
    while len(text) > RESULT_MAX_CHARS:
        lists = [(k, v) for k, v in trimmed.items() if isinstance(v, list) and len(v) > 1]
        if not lists:
            break
        k, v = max(lists, key=lambda kv: len(json.dumps(kv[1], ensure_ascii=False, default=str)))
        trimmed[k] = v[: max(1, len(v) // 2)]
        trimmed["truncated"] = True
        text = json.dumps(trimmed, ensure_ascii=False, separators=(",", ":"), default=str)
    return text[:RESULT_MAX_CHARS]
