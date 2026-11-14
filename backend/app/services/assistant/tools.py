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
from app.db.models import GrowattInverter
from app.services import growatt_alarms, growatt_overview as ov
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
_INV_KEYS = [
    "device_sn", "alias", "nominal_power_kw", "capacity_kwp", "yield_today_kwh", "specific_yield",
    "pr_pct", "peak_ac_kw", "max_temp_c", "string_count",
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
    # the overview's day energy key reads "today" even for a past day
    kpi_out["yield_kwh"] = kpi_out.pop("yield_today_kwh", None)
    return {
        "day": (o.get("meta") or {}).get("day"),
        "data_until": (o.get("meta") or {}).get("data_until"),
        "plant": _pick(o.get("plant") or {}, ["plant_id", "name", "city", "peak_power_kwp", "create_date"]),
        "kpis": kpi_out,
        "iec_pr_note": (weather.get("iec_pr") or {}).get("reason"),
        "has_weather_sensor": weather.get("has_sensor"),
        "inverters": [
            {**_pick(i, _INV_KEYS), "yield_kwh": _r(i.get("yield_today_kwh"))}
            for i in (o.get("inverters") or [])
        ],
        "strings_with_problems": [_pick(s, _STRING_KEYS) for s in problem[:15]],
        "strings_with_problems_total": len(problem),
        "inactive_strings": [
            _pick(s, ["string_id", "device_sn", "string_no", "status", "reason"]) for s in (o.get("inactive_strings") or [])[:15]
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
    for pid, p in plants.items():
        kwh = yields.get(pid)
        kwp = p.get("peak_power_kwp")
        if kwh is None:
            no_data.append({"plant_id": pid, "name": p.get("name")})
            continue
        sy = kwh / kwp if kwp else None
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
        "Also counts plants with no stored yield that day (never ranked as zero).",
    ),
    "list_plants": (
        ListPlantsIn,
        list_plants,
        "Find plants by name, city or id (Thai or English text, substring match) and/or project phase "
        "1-4. Returns plant_id, name, capacity kWp, inverter count and the yield of the newest stored day. "
        "Use it to turn a plant name into a plant_id.",
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
