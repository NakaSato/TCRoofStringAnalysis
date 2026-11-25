"""Calendar Team, Phase 4 (docs/plans/calendar-team.md §10): data-driven cleaning suggestions.

A plant gets a **suggested** cleaning (an estimate, never a planned task) when its R12 soiling
wallet (`services/soiling.py`, decision-rules.md §6.3: the THB lost to dirt since the last
plant-wide cleaning or heavy rain) has reached its cleaning cost outside the monsoon window
(`r12_monsoon`). The wallet is read exactly as R12 judges it (`soiling.wallets`), on the plant's
newest stored daily row; nothing here recomputes the soiling maths and nothing is stored except an
admin's answer.

Every visible plant gets a row with a `status` saying why it is or is not suggested:
`no_data` (no stored plant day in the last `STALE_DAYS`), R12's own `no_rate` / `no_reset` /
`rain_unknown`, `no_cost` (no cleaning cost entered), `monsoon`, `below_cost`, `accepted` /
`dismissed` (an admin answered this wallet), `planned` (an open cleaning task exists) or
`suggested`.

**Shadow mode.** R12 starts in shadow mode like every rule. While it is shadow, admins see the
suggestions (flagged `shadow: true`) and engineers get none (`hidden: "r12_shadow"`), as with the
wallet on the plant's Cleaning effect card. A disabled R12 gives nobody suggestions.

**Accept / dismiss** (admins): accept creates a normal `cleaning` task through
`om_calendar.create_task` and records a mark keyed on (plant, wallet reset day); dismiss records
the mark only. Either hides the suggestion until the wallet resets (the next plant-wide cleaning in
the Site log, e.g. the accepted task marked done, or a heavy rain).
"""

from __future__ import annotations

import math
from collections import defaultdict
from datetime import date, timedelta
from typing import Any, Dict, List, Optional, Set

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.db.models import GrowattPlant, GrowattPlantDaily, OmCleaningSuggestionMark, OmPlantSettings, OmTask, User
from app.services import growatt_rules, soiling
from app.services import om_calendar as cal
from app.services.growatt_common import GrowattNotFound
from app.services.tariff import pricer as load_pricer
from solar_core import om_planning

STALE_DAYS = 7  # a newest stored plant day older than this = no_data (the wallet would be out of date)
WORKDAYS = (0, 1, 2, 3, 4)

REASONS = {
    "no_data": "no stored plant day in the last 7 days",
    "no_cost": "no cleaning cost entered (Calendar → Due, or cost on a cleaning in the Site log)",
    "monsoon": "monsoon window: rain is expected to clean the array",
    "below_cost": "soiling loss since the last reset is still below the cleaning cost",
    "accepted": "suggestion accepted: a cleaning task was planned",
    "dismissed": "suggestion dismissed until the next cleaning or heavy rain",
    "planned": "a cleaning task is already planned",
    "suggested": "soiling loss since the last reset has reached the cleaning cost (estimate)",
}

WALLET_KEYS = (
    "day", "wallet_thb", "wallet_kwh", "cost_thb", "cost_basis", "reset_day", "reset_by", "days_since_reset",
    "rate_pct_per_day", "rate_basis", "soiling_pct", "optimal_interval_days", "days_without_energy", "crossed_day",
)


def _today() -> date:
    return cal._today()


def _status(w: Optional[Dict[str, Any]]) -> str:
    if w is None:
        return "no_data"
    if w["status"] != "ok":
        return str(w["status"])
    if w["cost_thb"] is None:
        return "no_cost"
    if w["monsoon"]:
        return "monsoon"
    if not w["fires"]:
        return "below_cost"
    return "suggested"


def _rows(db: Session, plant_ids: List[int], today: date) -> Dict[int, Dict[str, Any]]:
    """{plant: row} for the given plants (all of them), with the wallet and the status."""
    if not plant_ids:
        return {}
    cfg = growatt_rules.rule_settings(db)
    PD = GrowattPlantDaily
    newest = dict(
        db.execute(
            select(PD.plant_id, func.max(PD.day))
            .where(PD.plant_id.in_(plant_ids), PD.day <= today, PD.day > today - timedelta(days=STALE_DAYS))
            .group_by(PD.plant_id)
        ).all()
    )
    by_day: Dict[date, List[int]] = defaultdict(list)
    for pid, d in newest.items():
        by_day[d].append(int(pid))
    pr = load_pricer(db)
    found: Dict[int, Dict[str, Any]] = {}
    for d, ids in by_day.items():
        found.update(soiling.wallets(db, d, ids, cfg, pr, crossing=True))

    open_task: Dict[int, OmTask] = {}
    for t in db.scalars(
        select(OmTask).where(OmTask.plant_id.in_(plant_ids), OmTask.task_type == "cleaning", OmTask.status.in_(cal.ACTIVE))
        .order_by(OmTask.start_day, OmTask.id)
    ):
        open_task.setdefault(t.plant_id, t)
    marks = {
        (m.plant_id, m.reset_day): m
        for m in db.scalars(select(OmCleaningSuggestionMark).where(OmCleaningSuggestionMark.plant_id.in_(plant_ids)))
    }
    crew = dict(
        db.execute(
            select(OmPlantSettings.plant_id, OmPlantSettings.cleaning_crew_days).where(OmPlantSettings.plant_id.in_(plant_ids))
        ).all()
    )
    hol = _holidays(db)
    suggest_on = om_planning.next_working_day(today, WORKDAYS, hol) or today

    out: Dict[int, Dict[str, Any]] = {}
    for pid in plant_ids:
        w = found.get(pid)
        status = _status(w)
        mark = None
        if status == "suggested" and w is not None:
            mark = marks.get((pid, date.fromisoformat(w["reset_day"])))
            if mark is not None:
                status = mark.action
            elif pid in open_task:
                status = "planned"
        t = open_task.get(pid)
        out[pid] = {
            "plant_id": pid,
            "status": status,
            "suggested": status == "suggested",
            "reason": (w or {}).get("reason") if status in ("no_rate", "no_reset", "rain_unknown") else REASONS.get(status),
            **{k: (w or {}).get(k) for k in WALLET_KEYS},
            "monsoon": (w or {}).get("monsoon"),
            "suggested_day": suggest_on.isoformat() if status == "suggested" else None,
            "cleaning_crew_days": crew.get(pid),
            "open_task": {"id": t.id, "start_day": t.start_day.isoformat(), "status": t.status} if t else None,
            "mark": {
                "action": mark.action, "task_id": mark.task_id, "by": mark.by,
                "at": mark.at.isoformat() if mark.at else None,
            } if mark else None,
        }
    return out


def _holidays(db: Session) -> Set[date]:
    from app.services.om_plans import holidays

    return holidays(db)


def _names(db: Session, allowed: Optional[Set[int]]) -> Dict[int, str]:
    q = select(GrowattPlant.plant_id, GrowattPlant.name)
    if allowed is not None:
        q = q.where(GrowattPlant.plant_id.in_(allowed or {-1}))
    return {int(p): n for p, n in db.execute(q)}


def suggestions(db: Session, user: User, allowed: Optional[Set[int]]) -> Dict[str, Any]:
    """Cleaning suggestions for every plant the user may see (see the module doc)."""
    today = _today()
    cfg = growatt_rules.rule_settings(db)
    state = cfg["rules"]["R12"]
    admin = user.role == "admin"
    out: Dict[str, Any] = {
        "today": today.isoformat(),
        "rule": state,
        "shadow": bool(state["shadow"]),
        "monsoon_window": list(cfg.get("r12_monsoon") or []),
        "in_monsoon": soiling.in_monsoon(today, cfg),
        "hidden": None,
        "suggestions": [],
        "plants": [],
        "summary": {},
        "labels": {
            "wallet_thb": "estimated", "wallet_kwh": "estimated", "rate_pct_per_day": "estimated",
            "soiling_pct": "estimated", "crossed_day": "estimated", "optimal_interval_days": "estimated",
            "cost_thb": "entered",
        },
        "meta": {"source": "db"},
    }
    if not state["enabled"]:
        return {**out, "hidden": "r12_disabled"}
    if state["shadow"] and not admin:
        return {**out, "hidden": "r12_shadow"}
    names = _names(db, allowed)
    rows = _rows(db, sorted(names), today)
    plants = sorted(
        ({**r, "plant_name": names.get(pid)} for pid, r in rows.items()),
        key=lambda r: (not r["suggested"], -(r["wallet_thb"] or 0), r["plant_name"] or ""),
    )
    summary: Dict[str, int] = defaultdict(int)
    for r in plants:
        summary[r["status"]] += 1
    return {**out, "plants": plants, "suggestions": [r for r in plants if r["suggested"]], "summary": dict(summary)}


def _one(db: Session, plant_id: int) -> Dict[str, Any]:
    p = db.get(GrowattPlant, plant_id)
    if p is None:
        raise GrowattNotFound(f"Plant {plant_id} not found")
    return {**_rows(db, [plant_id], _today())[plant_id], "plant_name": p.name}


def _mark(db: Session, user: User, row: Dict[str, Any], action: str, task_id: Optional[int]) -> OmCleaningSuggestionMark:
    m = OmCleaningSuggestionMark(
        plant_id=row["plant_id"],
        reset_day=date.fromisoformat(row["reset_day"]),
        action=action,
        task_id=task_id,
        wallet_thb=row["wallet_thb"],
        cost_thb=row["cost_thb"],
        by=cal._who(user),
    )
    db.add(m)
    db.commit()
    return m


def _fmt(v: Any) -> str:
    return "—" if v is None else f"{v:,.0f}"


def accept(db: Session, user: User, plant_id: int, body: Dict[str, Any]) -> Dict[str, Any]:
    """Turn the plant's current suggestion into a planned cleaning task (admins)."""
    row = _one(db, plant_id)
    if not row["suggested"]:
        raise cal.TaskConflict(f"No cleaning suggestion for plant {plant_id} now ({row['status']})")
    start: date = body.get("start_day") or date.fromisoformat(row["suggested_day"])
    end: Optional[date] = body.get("end_day")
    if end is None:
        crew = row["cleaning_crew_days"]
        end = start + timedelta(days=max(0, math.ceil(crew) - 1)) if crew else start
    auto = (
        f"Suggested by the soiling wallet (R12, estimate): about ฿{_fmt(row['wallet_thb'])} lost to soiling since "
        f"{row['reset_day']} ({row['reset_by']}), reaching the cleaning cost ฿{_fmt(row['cost_thb'])} "
        f"({row['cost_basis']}) on {row['crossed_day'] or '—'}."
    )
    note = (body.get("note") or "").strip()
    t = cal.create_task(db, user, plant_id, {
        "task_type": "cleaning",
        "title": body.get("title") or "Cleaning (suggested)",
        "start_day": start,
        "end_day": end,
        "team_id": body.get("team_id"),
        "assignee_ids": body.get("assignee_ids") or [],
        "est_cost_thb": row["cost_thb"],
        "note": f"{note}\n\n{auto}" if note else auto,
    })
    _mark(db, user, row, "accepted", t.id)
    return {"task": cal.one(db, t, True), "suggestion": _one(db, plant_id)}


def dismiss(db: Session, user: User, plant_id: int) -> Dict[str, Any]:
    """Hide the plant's current suggestion until its wallet resets (admins)."""
    row = _one(db, plant_id)
    if not row["suggested"]:
        raise cal.TaskConflict(f"No cleaning suggestion for plant {plant_id} now ({row['status']})")
    _mark(db, user, row, "dismissed", None)
    return _one(db, plant_id)


def delete_plant_rows(db: Session, plant_ids: List[int]) -> None:
    """The blocked-plant cleanup (no commit)."""
    from sqlalchemy import delete

    if plant_ids:
        db.execute(delete(OmCleaningSuggestionMark).where(OmCleaningSuggestionMark.plant_id.in_(plant_ids)))
