"""O&M Dashboard: one period view of loss, work and plants in baht (docs/plans/om-center-dashboard.md).

Read only, SQL only, over what the rules and the team already stored: `growatt_issues` (each day
an issue fired: estimated kWh and THB), `growatt_inverter_daily` (energy, minutes per state),
`growatt_plant_daily` (EPI, PR'), `site_events` (cost entered) and `om_tasks` (planned work).

Rules overlap: a weak string also lowers its inverter's yield (R7) and the plant's EPI (R10), and
two string rules can price the same string-day. `attribute` counts each lost kWh once:

- a string-day: the largest of its string rules (they price the same missing energy);
- an inverter-day: down time (R8), its strings, conversion loss (R11), not-recovered data gaps
  (R17), and of R7 only what the strings and R11 do not explain;
- a plant-day: of R10 only what nothing above explains.

Every kWh and THB here is an **estimate**; costs are **entered** by the team (null when not).
"""

from __future__ import annotations

import statistics
from collections import defaultdict
from datetime import date
from typing import Any, Dict, Iterable, List, Optional, Set, Tuple

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.db.models import (
    GrowattInverterDaily,
    GrowattIssue,
    GrowattPlant,
    GrowattPlantDaily,
    OmTask,
    SiteEvent,
    not_installed_sns,
)
from app.services import growatt_issues, growatt_rules, jobs, tariff

MAX_SPAN_DAYS = 366
TOP_ISSUES = 50
OPEN_TASKS = ("planned", "in_progress")

# (key, label, rules); the order of the stacked bars
FAMILIES: Tuple[Tuple[str, str, Tuple[str, ...]], ...] = (
    ("down", "Inverter down", ("R8",)),
    ("strings", "Strings", tuple(sorted(growatt_issues.STRING_RULES))),
    ("conversion", "Inverter conversion loss", ("R11",)),
    ("underyield", "Inverter under-yield, not explained above", ("R7",)),
    ("plant", "Plant shortfall, not explained above", ("R10",)),
    ("data_gap", "Data gap, energy not recovered", ("R17",)),
)

# one priced day of one issue: (plant_id, device_sn, string_no, rule, kwh, thb)
Entry = Tuple[int, Optional[str], Optional[int], str, Optional[float], Optional[float]]
Loss = Dict[str, List[float]]  # family -> [kwh, thb]


def _add(out: Loss, family: str, kwh: float, thb: Optional[float]) -> None:
    if kwh <= 0:
        return
    cell = out.setdefault(family, [0.0, 0.0])
    cell[0] += kwh
    cell[1] += thb or 0.0


def attribute(entries: Iterable[Entry]) -> Dict[int, Loss]:
    """Loss per plant and family for the entries of **one day**, each lost kWh counted once
    (see the module doc). An entry without kWh adds nothing."""
    by_plant: Dict[int, List[Entry]] = defaultdict(list)
    for e in entries:
        if e[4] is not None:
            by_plant[e[0]].append(e)
    out: Dict[int, Loss] = {}
    for pid, rows in by_plant.items():
        loss: Loss = {}
        strings: Dict[Tuple[Optional[str], int], Tuple[float, Optional[float]]] = {}
        per_inv: Dict[Optional[str], Dict[str, Tuple[float, Optional[float]]]] = defaultdict(dict)
        plant_level: Optional[Tuple[float, Optional[float]]] = None
        for _, sn, sno, rule, kwh, thb in rows:
            v = (float(kwh or 0.0), thb)
            if rule in growatt_issues.STRING_RULES and sno is not None:
                if (sn, sno) not in strings or v[0] > strings[(sn, sno)][0]:
                    strings[(sn, sno)] = v
            elif rule == "R10":
                if plant_level is None or v[0] > plant_level[0]:
                    plant_level = v
            elif rule in ("R7", "R8", "R11", "R17"):
                per_inv[sn][rule] = v
        s_inv: Dict[Optional[str], List[float]] = defaultdict(lambda: [0.0, 0.0])
        for (sn, _), (kwh, thb) in strings.items():
            _add(loss, "strings", kwh, thb)
            s_inv[sn][0] += kwh
            s_inv[sn][1] += thb or 0.0
        for sn, rules in per_inv.items():
            for rule, family in (("R8", "down"), ("R11", "conversion"), ("R17", "data_gap")):
                if rule in rules:
                    _add(loss, family, *rules[rule])
            if "R7" in rules:
                kwh, thb = rules["R7"]
                c_kwh, c_thb = rules.get("R11", (0.0, 0.0))
                rest = kwh - s_inv[sn][0] - c_kwh
                if rest > 0:
                    # the unexplained part keeps R7's own THB/kWh
                    _add(loss, "underyield", rest, None if thb is None else max(0.0, thb - s_inv[sn][1] - (c_thb or 0.0)))
        if plant_level is not None:
            kwh, thb = plant_level
            rest = kwh - sum(v[0] for v in loss.values())
            if rest > 0:
                _add(loss, "plant", rest, None if thb is None else max(0.0, thb - sum(v[1] for v in loss.values())))
        if loss:
            out[pid] = loss
    return out


def _r(v: Optional[float], nd: int = 0) -> Optional[float]:
    return None if v is None else round(v, nd)


def _median(vals: List[float], nd: int) -> Optional[float]:
    return round(statistics.median(vals), nd) if vals else None


def window(start: Optional[date], end: Optional[date]) -> Tuple[date, date]:
    """Default: the month to date. Raises ValueError on a reversed or too long window."""
    today = jobs._today()
    end = end or today
    start = start or end.replace(day=1)
    if start > end:
        raise ValueError("start must not be after end")
    if (end - start).days + 1 > MAX_SPAN_DAYS:
        raise ValueError(f"the window may span at most {MAX_SPAN_DAYS} days")
    return start, end


def overview(
    db: Session,
    plant_ids: Optional[Set[int]],
    start: date,
    end: date,
    *,
    include_shadow: bool = False,
) -> Dict[str, Any]:
    """The O&M Dashboard for the plants in `plant_ids` (None = every plant) over `start` … `end`.
    `include_shadow` (admins only, decided by the route) adds issues of rules still in shadow mode."""
    today = jobs._today()
    G, ID, PD = GrowattIssue, GrowattInverterDaily, GrowattPlantDaily

    def scoped(q: Any, col: Any) -> Any:
        return q if plant_ids is None else q.where(col.in_(plant_ids))

    plants = {
        int(p.plant_id): p for p in db.scalars(scoped(select(GrowattPlant), GrowattPlant.plant_id).order_by(GrowattPlant.name))
    }

    # ---- issues: the days each one fired inside the window, and the active ones now
    q = scoped(select(G), G.plant_id).where(
        (G.status.in_(growatt_issues.ACTIVE)) | ((G.last_seen_day >= start) & (G.opened_day <= end))
    )
    if not include_shadow:
        q = q.where(G.shadow.is_(False))
    issues = [i for i in db.scalars(q) if i.plant_id in plants]
    active = [i for i in issues if i.status in growatt_issues.ACTIVE]
    shadow_hidden = None
    if plant_ids is None and not include_shadow:
        shadow_hidden = int(
            db.scalar(select(func.count()).select_from(G).where(G.status.in_(growatt_issues.ACTIVE), G.shadow.is_(True))) or 0
        )

    lo, hi = start.isoformat(), end.isoformat()
    by_day: Dict[str, List[Entry]] = defaultdict(list)
    for i in issues:
        if i.close_reason == "dismissed":  # judged not real by an engineer: no loss
            continue
        for d, v in (i.daily or {}).items():
            if lo <= d <= hi:
                by_day[d].append((i.plant_id, i.device_sn, i.string_no, i.rule, v.get("kwh"), v.get("thb")))

    cause_days: List[Dict[str, Any]] = []
    fam_total: Loss = {}
    plant_loss: Dict[int, List[float]] = defaultdict(lambda: [0.0, 0.0])
    for d in sorted(by_day):
        day_fam: Loss = {}
        for pid, loss in attribute(by_day[d]).items():
            for fam, (kwh, thb) in loss.items():
                _add(day_fam, fam, kwh, thb)
                _add(fam_total, fam, kwh, thb)
                plant_loss[pid][0] += kwh
                plant_loss[pid][1] += thb
        for fam, _, _ in FAMILIES:
            if fam in day_fam:
                cause_days.append({"day": d, "family": fam, "kwh_est": _r(day_fam[fam][0], 1), "thb_est": _r(day_fam[fam][1])})

    # losing now: the active issues' THB/day (mean of the last 3 days each fired), counted once
    now_loss = attribute((i.plant_id, i.device_sn, i.string_no, i.rule, i.lost_kwh_est, i.thb_per_day_est) for i in active)
    plant_now: Dict[int, float] = {pid: sum(v[1] for v in loss.values()) for pid, loss in now_loss.items()}
    plant_active: Dict[int, int] = defaultdict(int)
    for i in active:
        plant_active[i.plant_id] += 1

    # ---- measured: energy and minutes per state
    inv: Dict[int, Dict[str, float]] = {}
    cols = [ID.energy_kwh, ID.daylight_min, ID.fault_min, ID.off_min, ID.standby_min, ID.no_data_min, ID.limited_min]
    q = scoped(select(ID.plant_id, func.count(ID.energy_kwh), *[func.sum(c) for c in cols]), ID.plant_id).where(
        ID.day >= start, ID.day <= end, ID.device_sn.not_in(not_installed_sns())
    )
    for row in db.execute(q.group_by(ID.plant_id)):
        inv[int(row[0])] = {
            "energy_rows": int(row[1] or 0), "energy": float(row[2] or 0.0), "daylight": float(row[3] or 0),
            "down": float((row[4] or 0) + (row[5] or 0) + (row[6] or 0)), "no_data": float(row[7] or 0), "limited": float(row[8] or 0),
        }

    def availability(down: float, daylight: float, no_data: float) -> Optional[float]:
        seen = daylight - no_data
        return round((1 - down / seen) * 100, 2) if seen > 0 else None

    # ---- plant KPIs: medians over the days whose sensor was not judged suspect (R16)
    cfg = growatt_rules.rule_settings(db)
    epi: Dict[int, List[float]] = defaultdict(list)
    prc: Dict[int, List[float]] = defaultdict(list)
    for r in db.scalars(scoped(select(PD), PD.plant_id).where(PD.day >= start, PD.day <= end)):
        if growatt_rules.sensor_failed(r, cfg):
            continue
        if r.epi is not None:
            epi[r.plant_id].append(float(r.epi))
        if r.pr_temp_corrected_pct is not None:
            prc[r.plant_id].append(float(r.pr_temp_corrected_pct))

    # ---- work: money spent in the window, last cleaning, next planned visit, committed cost
    spend: Dict[int, List[float]] = defaultdict(lambda: [0.0, 0, 0])  # thb, events, events with a cost
    # the same per plant, calendar month and event type (finance view: billing vs O&M spend); entered only
    spend_month: Dict[Tuple[int, str, str], List[float]] = defaultdict(lambda: [0.0, 0, 0])
    q = scoped(select(SiteEvent.plant_id, SiteEvent.cost_thb, SiteEvent.day, SiteEvent.event_type), SiteEvent.plant_id).where(
        SiteEvent.day >= start, SiteEvent.day <= end
    )
    for pid, cost, day, etype in db.execute(q):
        for s in (spend[int(pid)], spend_month[(int(pid), day.strftime("%Y-%m"), etype or "other")]):
            s[1] += 1
            if cost is not None:
                s[0] += float(cost)
                s[2] += 1
    q = scoped(select(SiteEvent.plant_id, func.max(SiteEvent.day)), SiteEvent.plant_id).where(
        SiteEvent.event_type == "cleaning", SiteEvent.day <= today
    )
    last_clean = {int(p): d for p, d in db.execute(q.group_by(SiteEvent.plant_id))}
    next_visit: Dict[int, date] = {}
    committed = [0.0, 0, 0]
    q = scoped(select(OmTask.plant_id, OmTask.start_day, OmTask.end_day, OmTask.est_cost_thb), OmTask.plant_id).where(
        OmTask.status.in_(OPEN_TASKS)
    )
    for pid, s_day, e_day, cost in db.execute(q):
        committed[1] += 1
        if cost is not None:
            committed[0] += float(cost)
            committed[2] += 1
        if e_day >= today:
            d = max(s_day, today)
            if int(pid) not in next_visit or d < next_visit[int(pid)]:
                next_visit[int(pid)] = d

    # ---- rows
    rows: List[Dict[str, Any]] = []
    for pid, p in plants.items():
        m = inv.get(pid)
        energy = m["energy"] if m and m["energy_rows"] else None
        lost = plant_loss.get(pid)
        s = spend.get(pid)
        nv = next_visit.get(pid)
        lc = last_clean.get(pid)
        rows.append({
            "plant_id": pid,
            "name": p.name,
            "capacity_kwp": p.peak_power_kwp,
            "energy_kwh": _r(energy, 1),
            "lost_kwh_est": _r(lost[0], 1) if lost else None,
            "lost_thb_est": _r(lost[1]) if lost else None,
            "loss_share_pct": round(lost[0] / (energy + lost[0]) * 100, 2) if lost and energy is not None and energy + lost[0] > 0 else None,
            "thb_per_day_est": _r(plant_now.get(pid)) if pid in plant_now else None,
            "active_issues": plant_active.get(pid, 0),
            "epi_median": _median(epi.get(pid, []), 3),
            "pr_temp_corrected_median_pct": _median(prc.get(pid, []), 1),
            "availability_pct": availability(m["down"], m["daylight"], m["no_data"]) if m else None,
            "days_since_cleaning": (today - lc).days if lc else None,
            "next_visit": nv.isoformat() if nv else None,
            "spend_thb": _r(s[0]) if s and s[2] else None,
        })
    rows.sort(key=lambda r: (-(r["lost_thb_est"] or 0), -(r["thb_per_day_est"] or 0), r["name"] or ""))

    names = growatt_issues._names(db, active)
    top = sorted((growatt_issues.serialize(i, *names) for i in active), key=growatt_issues.sort_key)
    summary = growatt_issues.summarize(top)
    top_out: List[Dict[str, Any]] = []
    for d in top[:TOP_ISSUES]:
        nv = next_visit.get(d["plant_id"])
        wait = (nv - today).days if nv else None
        d = {k: v for k, v in d.items() if k not in ("daily", "evidence")}
        d["age_days"] = (today - date.fromisoformat(d["opened_day"])).days
        d["next_visit"] = nv.isoformat() if nv else None
        d["days_to_visit"] = wait
        # what the issue costs until the plant's next planned visit, at today's THB/day
        d["cost_of_waiting_thb_est"] = _r(d["thb_per_day_est"] * wait) if wait is not None and d["thb_per_day_est"] is not None else None
        top_out.append(d)

    tot_energy = sum(m["energy"] for pid, m in inv.items() if pid in plants and m["energy_rows"])
    has_energy = any(m["energy_rows"] for pid, m in inv.items() if pid in plants)
    tot_kwh = sum(v[0] for v in fam_total.values())
    tot_thb = sum(v[1] for v in fam_total.values())
    agg = {k: sum(m[k] for pid, m in inv.items() if pid in plants) for k in ("down", "daylight", "no_data", "limited")}
    sp = [sum(s[k] for s in spend.values()) for k in range(3)]
    cfg_tariff = tariff.get_tariff(db)
    return {
        "window": {"start": lo, "end": hi, "days": (end - start).days + 1, "today": today.isoformat()},
        "scope": "fleet" if plant_ids is None else "assigned",
        "plant_count": len(plants),
        "money": {
            "losing_now_thb_per_day_est": _r(sum(plant_now.values())) if plant_now else None,
            "active_issues": summary["active"],
            "safety_issues": summary["safety"],
            "by_tier": summary["by_tier"],
            "lost_kwh_est": _r(tot_kwh, 1) if fam_total else None,
            "lost_thb_est": _r(tot_thb) if fam_total else None,
            "loss_share_pct": round(tot_kwh / (tot_energy + tot_kwh) * 100, 2) if fam_total and has_energy and tot_energy + tot_kwh > 0 else None,
            "produced_kwh": _r(tot_energy, 1) if has_energy else None,
            "availability_pct": availability(agg["down"], agg["daylight"], agg["no_data"]),
            "limited_min": int(agg["limited"]),
            "spend_thb": _r(sp[0]) if sp[2] else None,
            "spend_events": int(sp[1]),
            "spend_events_priced": int(sp[2]),
            "committed_thb": _r(committed[0]) if committed[2] else None,
            "committed_tasks": int(committed[1]),
            "committed_tasks_priced": int(committed[2]),
        },
        "loss_by_cause": {
            "families": [{"key": k, "label": label, "rules": list(rules)} for k, label, rules in FAMILIES],
            "days": cause_days,
            "totals": [
                {"family": k, "kwh_est": _r(fam_total[k][0], 1), "thb_est": _r(fam_total[k][1])} for k, _, _ in FAMILIES if k in fam_total
            ],
        },
        "issues": {"total": len(top), "top": top_out},
        "plants": rows,
        "spend_by_month": [
            {
                "plant_id": pid, "month": mo, "event_type": et,
                "spend_thb": _r(v[0]) if v[2] else None, "events": int(v[1]), "events_priced": int(v[2]),
            }
            for (pid, mo, et), v in sorted(spend_month.items(), key=lambda kv: (kv[0][1], kv[0][0], kv[0][2]))
            if pid in plants
        ],
        "shadow_hidden": shadow_hidden,
        "include_shadow": include_shadow,
        "meta": {
            "source": "db",
            "estimated": [
                "losing_now_thb_per_day_est", "lost_kwh_est", "lost_thb_est", "loss_share_pct", "thb_per_day_est",
                "kwh_est", "thb_est", "cost_of_waiting_thb_est",
            ],
            "modelled": ["epi_median", "pr_temp_corrected_median_pct"],
            "entered": ["spend_thb", "committed_thb"],
            "tariff_source": cfg_tariff["source"],
            "plant_rates": len(cfg_tariff.get("plant_rates") or {}),
        },
    }
