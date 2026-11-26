"""O&M Dashboard: one period view of loss, work and plants in baht (docs/plans/om-center-dashboard.md).

Read only, SQL only, over what the rules and the team already stored: `growatt_issues` (each day
an issue fired: estimated kWh and THB), `growatt_inverter_daily` (energy, minutes per state),
`growatt_plant_daily` (EPI, PR'), `site_events` (cost entered) and `om_tasks` (planned work).

Rules overlap: a weak string also lowers its inverter's yield (R7) and the plant's EPI (R10), and
two string rules can price the same string-day. `attribute` counts each lost kWh once:

- a string-day: the largest of its string rules (they price the same missing energy);
- an inverter-day: down time (R8), its strings, conversion loss (R11), not-recovered data gaps
  (R17), and of R7 only what the strings and R11 do not explain;
- a plant-day: of soiling (the larger of R12, the wallet's modelled daily loss, and R13, the dirt the
  rain left) what the inverter and string rules do not explain,
  then of R10 only what nothing above explains.

Every kWh and THB here is an **estimate**; costs are **entered** by the team (null when not).

Work and response (Phase 2: `work`, `response`, `claims_waiting`): this week's Calendar tasks, how
fast the team answered the issues first seen in the window (days from the day an issue was first
seen to the plant-local day a person acknowledged / closed it, per tier against the targets) and
the claims still open. Counts and days only, no money.
"""

from __future__ import annotations

import statistics
from collections import defaultdict
from datetime import date, timedelta
from typing import Any, Dict, Iterable, List, Optional, Set, Tuple

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.db.models import (
    Claim,
    ClaimLink,
    GrowattInverterDaily,
    GrowattIssue,
    GrowattPlant,
    GrowattPlantDaily,
    OmPlan,
    OmPlanPlant,
    OmTask,
    SiteEvent,
    not_installed_sns,
)
from app.services import claims as claims_svc
from app.services import growatt_issues, growatt_rules, jobs, tariff

MAX_SPAN_DAYS = 366
TOP_ISSUES = 50
OPEN_TASKS = ("planned", "in_progress")
TASK_STATUSES = ("planned", "in_progress", "done", "skipped", "cancelled")
# response targets in days from the day an issue was first seen (research report: P1 same day, P2 ≤ 2 days)
RESPONSE_TARGET_DAYS: Dict[str, int] = {"P1": 0, "P2": 2}
TIER_ORDER = ("P1", "P2", "P3", "Info")
# closed by a person (auto = the rule went quiet; not_installed = an admin marked the inverter)
TEAM_CLOSED = ("resolved", "dismissed")

# (key, label, rules); the order of the stacked bars
FAMILIES: Tuple[Tuple[str, str, Tuple[str, ...]], ...] = (
    ("down", "Inverter down", ("R8",)),
    ("strings", "Strings", tuple(sorted(growatt_issues.STRING_RULES))),
    ("conversion", "Inverter conversion loss", ("R11",)),
    ("underyield", "Inverter under-yield, not explained above", ("R7",)),
    ("soiling", "Soiling (wallet, or rain did not wash it off)", ("R12", "R13")),
    ("plant", "Plant shortfall, not explained above", ("R10",)),
    ("data_gap", "Data gap, energy not recovered", ("R17",)),
)

# one priced day of one issue: (plant_id, device_sn, string_no, rule, kwh, thb)
Entry = Tuple[int, Optional[str], Optional[int], str, Optional[float], Optional[float]]
Loss = Dict[str, List[float]]  # family -> [kwh, thb]


def _rows(db: Session, stmt: Any) -> Iterable[Tuple[Any, ...]]:
    """The rows of `stmt` as plain tuples (statements built through `scoped` are typed Any)."""
    return db.execute(stmt).tuples()


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
        soiling: Optional[Tuple[float, Optional[float]]] = None
        for _, sn, sno, rule, kwh, thb in rows:
            v = (float(kwh or 0.0), thb)
            if rule in growatt_issues.STRING_RULES and sno is not None:
                if (sn, sno) not in strings or v[0] > strings[(sn, sno)][0]:
                    strings[(sn, sno)] = v
            elif rule == "R10":
                if plant_level is None or v[0] > plant_level[0]:
                    plant_level = v
            elif rule in ("R12", "R13"):
                if soiling is None or v[0] > soiling[0]:
                    soiling = v
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
        for family, level in (("soiling", soiling), ("plant", plant_level)):
            if level is None:
                continue
            kwh, thb = level
            rest = kwh - sum(v[0] for v in loss.values())
            if rest > 0:
                _add(loss, family, rest, None if thb is None else max(0.0, thb - sum(v[1] for v in loss.values())))
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


def _days(ts: Any, opened: date) -> Optional[int]:
    """Whole days from the day an issue was first seen to the plant-local day of `ts` (≥ 0)."""
    d = growatt_issues._local_day(ts)
    return None if d is None else max(0, (d - opened).days)


def response(issues: Iterable[GrowattIssue], start: date, end: date, today: date) -> Dict[str, Any]:
    """How fast the team answered the issues first seen in `start` … `end`, per tier, in days.

    Acknowledged = `ack_at` (set by the acknowledge action). Closed = `closed_at` of an issue a person
    resolved or dismissed; auto-closed ones (`close_reason = auto`, the rule went quiet) are counted
    apart, since their `closed_at` is when the job ran, not a response. First response = the earlier
    of the two (an engineer may resolve without acknowledging). Medians are over the issues that had
    the event; an issue nobody has acted on is counted as waiting, never given a day."""
    tiers: Dict[str, Dict[str, Any]] = {}
    for i in issues:
        if not (start <= i.opened_day <= end) or i.close_reason == "not_installed":
            continue
        t = tiers.setdefault(i.tier, {"ack": [], "closed": [], "first": [], "opened": 0, "auto_closed": 0, "waiting": []})
        t["opened"] += 1
        ack = _days(i.ack_at, i.opened_day) if i.ack_at else None
        closed = _days(i.closed_at, i.opened_day) if i.closed_at and i.close_reason in TEAM_CLOSED else None
        if i.close_reason == "auto":
            t["auto_closed"] += 1
        if ack is not None:
            t["ack"].append(ack)
        if closed is not None:
            t["closed"].append(closed)
        firsts = [x for x in (ack, closed) if x is not None]
        if firsts:
            t["first"].append(min(firsts))
        elif i.status == "open":  # still active and nobody has acted on it
            t["waiting"].append((today - i.opened_day).days)
    out = []
    for tier in sorted(tiers, key=lambda x: (TIER_ORDER.index(x) if x in TIER_ORDER else len(TIER_ORDER), x)):
        t = tiers[tier]
        target = RESPONSE_TARGET_DAYS.get(tier)
        out.append({
            "tier": tier,
            "target_days": target,
            "opened": t["opened"],
            "acknowledged": len(t["ack"]),
            "ack_median_days": _median([float(x) for x in t["ack"]], 1),
            "closed_by_team": len(t["closed"]),
            "close_median_days": _median([float(x) for x in t["closed"]], 1),
            "auto_closed": t["auto_closed"],
            "responded": len(t["first"]),
            "first_response_median_days": _median([float(x) for x in t["first"]], 1),
            "within_target": None if target is None else sum(1 for x in t["first"] if x <= target),
            "waiting": len(t["waiting"]),
            "waiting_oldest_days": max(t["waiting"]) if t["waiting"] else None,
        })
    return {"start": start.isoformat(), "end": end.isoformat(), "tiers": out, "targets": dict(RESPONSE_TARGET_DAYS)}


def work(db: Session, plant_ids: Set[int], today: date) -> Dict[str, Any]:
    """This week's (Monday … Sunday of today) Calendar tasks on the plants, the overdue backlog and
    the recurring plans' share. Counts only; nothing estimated."""
    week_start = today - timedelta(days=today.weekday())
    week_end = week_start + timedelta(days=6)
    ids = plant_ids or {-1}
    by_status = {s: 0 for s in TASK_STATUSES}
    overdue = 0
    from_plans = {"total": 0, "done": 0, "open": 0, "overdue": 0}
    q = select(OmTask.status, OmTask.end_day, OmTask.plan_id).where(
        OmTask.plant_id.in_(ids), OmTask.start_day <= week_end, OmTask.end_day >= week_start
    )
    for status, e_day, plan_id in _rows(db, q):
        by_status[status] = by_status.get(status, 0) + 1
        late = status in OPEN_TASKS and e_day < today
        overdue += late
        if plan_id is not None and status != "cancelled":
            from_plans["total"] += 1
            from_plans["done"] += status == "done"
            from_plans["open"] += status in OPEN_TASKS
            from_plans["overdue"] += late
    backlog = [
        e for (e,) in _rows(db, select(OmTask.end_day).where(OmTask.plant_id.in_(ids), OmTask.status.in_(OPEN_TASKS), OmTask.end_day < today))
    ]
    plans = db.scalar(
        select(func.count(func.distinct(OmPlan.id)))
        .select_from(OmPlan)
        .join(OmPlanPlant, OmPlanPlant.plan_id == OmPlan.id)
        .where(OmPlan.active.is_(True), OmPlanPlant.plant_id.in_(ids))
    )
    return {
        "week": {"start": week_start.isoformat(), "end": week_end.isoformat()},
        "tasks": {
            "total": sum(v for k, v in by_status.items() if k != "cancelled"),
            "by_status": by_status,
            "open": by_status["planned"] + by_status["in_progress"],
            "overdue": overdue,
        },
        "from_plans": from_plans,
        "active_plans": int(plans or 0),
        "overdue_all": len(backlog),
        "overdue_oldest_days": (today - min(backlog)).days if backlog else None,
    }


def claims_waiting(db: Session, plant_ids: Set[int], today: date) -> Dict[str, Any]:
    """Open claims on the plants: count by status, whose move it is, follow-ups past due and the
    oldest (age from the day submitted, else the day created, as the Claims page counts it). No money."""
    rows = list(db.scalars(select(Claim).where(Claim.plant_id.in_(plant_ids or {-1}), Claim.status.not_in(claims_svc.CLOSED))))
    by_status: Dict[str, int] = defaultdict(int)
    oldest: Optional[Tuple[int, Claim]] = None
    for c in rows:
        by_status[c.status] += 1
        since = c.submitted_day or growatt_issues._local_day(c.created_at) or today
        age = (today - since).days
        if oldest is None or age > oldest[0]:
            oldest = (age, c)
    return {
        "open": len(rows),
        "by_status": {s: by_status[s] for s in claims_svc.STATUSES if by_status.get(s)},
        "waiting_us": sum(1 for c in rows if claims_svc.WAITING.get(c.status) == "us"),
        "waiting_them": sum(1 for c in rows if claims_svc.WAITING.get(c.status) == "them"),
        "followup_overdue": sum(1 for c in rows if c.next_action_day is not None and c.next_action_day < today),
        "oldest": None
        if oldest is None
        else {"id": oldest[1].id, "number": oldest[1].number, "status": oldest[1].status, "plant_id": oldest[1].plant_id, "age_days": oldest[0]},
    }


def issue_claims(db: Session, issue_ids: Iterable[int], plant_ids: Set[int]) -> Dict[int, List[Dict[str, Any]]]:
    """The claims linked to each issue (`claim_links` kind issue), newest first, on the user's plants."""
    ids = list(issue_ids)
    if not ids:
        return {}
    q = (
        select(ClaimLink.ref_id, Claim.id, Claim.number, Claim.status)
        .join(Claim, Claim.id == ClaimLink.claim_id)
        .where(ClaimLink.kind == "issue", ClaimLink.ref_id.in_(ids), Claim.plant_id.in_(plant_ids or {-1}))
        .order_by(Claim.id.desc())
    )
    out: Dict[int, List[Dict[str, Any]]] = defaultdict(list)
    for ref, cid, number, status in _rows(db, q):
        out[int(ref)].append({"id": cid, "number": number, "status": status, "open": status not in claims_svc.CLOSED})
    return out


def overview(
    db: Session,
    plant_ids: Optional[Set[int]],
    start: date,
    end: date,
    *,
    include_shadow: bool = False,
    count_shadow: Optional[bool] = None,
) -> Dict[str, Any]:
    """The O&M Dashboard for the plants in `plant_ids` (None = every plant) over `start` … `end`.
    `include_shadow` (admins only, decided by the route) adds issues of rules still in shadow mode.
    `count_shadow`: whether the caller may see shadow issues, so `shadow_hidden` counts the active ones of
    `plant_ids` that were left out (None = only when `plant_ids` is None, i.e. the `/growatt/center` admin
    call; the AI Assistant passes it for an admin narrowed to one plant). Never set it for an engineer."""
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
    if (plant_ids is None if count_shadow is None else count_shadow) and not include_shadow:
        shadow_hidden = int(
            db.scalar(
                scoped(select(func.count()).select_from(G), G.plant_id).where(
                    G.status.in_(growatt_issues.ACTIVE), G.shadow.is_(True)
                )
            )
            or 0
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
    for row in _rows(db, q.group_by(ID.plant_id)):
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
    for pid, cost, day, etype in _rows(db, q):
        for s in (spend[int(pid)], spend_month[(int(pid), day.strftime("%Y-%m"), etype or "other")]):
            s[1] += 1
            if cost is not None:
                s[0] += float(cost)
                s[2] += 1
    q = scoped(select(SiteEvent.plant_id, func.max(SiteEvent.day)), SiteEvent.plant_id).where(
        SiteEvent.event_type == "cleaning", SiteEvent.day <= today
    )
    last_clean = {int(p): d for p, d in _rows(db, q.group_by(SiteEvent.plant_id))}
    next_visit: Dict[int, date] = {}
    committed = [0.0, 0, 0]
    q = scoped(select(OmTask.plant_id, OmTask.start_day, OmTask.end_day, OmTask.est_cost_thb), OmTask.plant_id).where(
        OmTask.status.in_(OPEN_TASKS)
    )
    for pid, s_day, e_day, cost in _rows(db, q):
        committed[1] += 1
        if cost is not None:
            committed[0] += float(cost)
            committed[2] += 1
        if e_day >= today:
            d = max(s_day, today)
            if int(pid) not in next_visit or d < next_visit[int(pid)]:
                next_visit[int(pid)] = d

    # ---- open claims per plant
    open_claims: Dict[int, int] = {
        int(p): int(n)
        for p, n in _rows(
            db,
            select(Claim.plant_id, func.count())
            .where(Claim.plant_id.in_(set(plants) or {-1}), Claim.status.not_in(claims_svc.CLOSED))
            .group_by(Claim.plant_id),
        )
    }

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
            "open_claims": open_claims.get(pid, 0),
        })
    rows.sort(key=lambda r: (-(r["lost_thb_est"] or 0), -(r["thb_per_day_est"] or 0), r["name"] or ""))

    names = growatt_issues._names(db, active)
    top = sorted((growatt_issues.serialize(i, *names) for i in active), key=growatt_issues.sort_key)
    summary = growatt_issues.summarize(top)
    top_out: List[Dict[str, Any]] = []
    linked = issue_claims(db, (d["id"] for d in top[:TOP_ISSUES]), set(plants))
    for d in top[:TOP_ISSUES]:
        nv = next_visit.get(d["plant_id"])
        wait = (nv - today).days if nv else None
        d = {k: v for k, v in d.items() if k not in ("daily", "evidence")}
        d["age_days"] = (today - date.fromisoformat(d["opened_day"])).days
        d["next_visit"] = nv.isoformat() if nv else None
        d["days_to_visit"] = wait
        # what the issue costs until the plant's next planned visit, at today's THB/day
        d["cost_of_waiting_thb_est"] = _r(d["thb_per_day_est"] * wait) if wait is not None and d["thb_per_day_est"] is not None else None
        d["claims"] = linked.get(d["id"], [])
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
        "work": work(db, set(plants), today),
        "response": response(issues, start, end, today),
        "claims": claims_waiting(db, set(plants), today),
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
