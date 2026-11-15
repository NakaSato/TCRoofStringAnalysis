"""Decision rules R1–R18 (Phase 1 subset) over the daily tables (docs/plans/decision-rules.md §3.3).

Reads `growatt_string_daily`, `growatt_inverter_daily` and the stored alarm log only. Each finding
says which rule fired, on what, with the evidence numbers behind it. Phase 1 does not store them:
`/growatt/rules/findings` (admin only) evaluates on request, and the `rules_*` jobs record counts
in their run detail. Phase 2 turns findings into stored issues with baht values and shadow mode.

Thresholds are the report's defaults; an admin can override any of them through the
`app_settings` key `decision_rules` (a JSON object with the same keys as `DEFAULT_RULES`;
`rules` holds each rule's `enabled` and `shadow` flags). Baht figures price the estimated lost
kWh with the tariff (`services/tariff.py`) and are estimates too.
"""

from __future__ import annotations

import statistics
from collections import defaultdict
from datetime import date, datetime, timedelta
from typing import Any, Dict, List, Optional, Sequence, Tuple

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db.models import AppSetting, GrowattAlarm, GrowattInverterDaily, GrowattPlant, GrowattStringDaily
from app.services.tariff import Pricer, pricer as load_pricer

SETTING_KEY = "decision_rules"

DEFAULT_RULES: Dict[str, Any] = {
    # R1 weak string: low minutes on enough of the last days
    "r1_low_min": 120,
    "r1_days": 3,
    "r1_days_hit": 2,
    # R2 open string
    "r2_open_min": 15,
    # R3 insulation / ground / arc fault: alarm message keywords (Growatt codes to be confirmed, plan §9)
    "r3_keywords": ["isolation", "insulation", "gfci", "residual current", "ground", "earth", "afci", "arc"],
    # R5 slow drift: median ratio over a window
    "r5_window_days": 30,
    "r5_min_days": 10,
    "r5_ratio": 0.95,
    # R7 inverter underperforming vs the plant's other inverters
    "r7_pct": -3.0,
    "r7_days": 2,
    "r7_max_gap_pct": 5.0,  # days with more downtime / no data than this are not judged
    # R8 inverter down (fault + off + standby minutes): at least this long, so a 5-min wake-up
    # lag is not an issue; P1 when the inverter carries more than the share of the plant
    "r8_min_down_min": 15,
    "r8_p1_share_pct": 30.0,
    # R9 grid trips
    "r9_keywords": ["no ac connection", "grid", "ac v outrange", "ac f outrange", "ac voltage", "ac frequency"],
    "r9_events": 3,
    "r9_window_days": 7,
    # R17 data gap
    "r17_pct": 5.0,
    # THB/day above which R2 is P1 (else P2) and R7 is P2 (else P3). Not confirmed yet (plan §9 Q4).
    "p1_thb_per_day": 300.0,
    # per rule: enabled = evaluated at all; shadow = issues recorded but shown only in Rule review
    "rules": {},
}

ALARM_EVENT_GAP = timedelta(minutes=15)  # Growatt re-reports an open alarm every ~5 min

RULE_NAMES = {
    "R1": "Weak string",
    "R2": "Open string",
    "R3": "Insulation / ground fault",
    "R5": "Slow string drift",
    "R7": "Inverter underperforming",
    "R8": "Inverter down",
    "R9": "Grid trips",
    "R17": "Data gap",
    "R18": "Power limiting",
}

TIER_ORDER = {"P1": 0, "P2": 1, "P3": 2, "P4": 3, "Info": 4}

# every rule starts in shadow mode (plan §4.4) until Rule review shows it is right often enough
DEFAULT_RULE_STATE = {"enabled": True, "shadow": True}


def rule_settings(db: Session) -> Dict[str, Any]:
    row = db.get(AppSetting, SETTING_KEY)
    out = dict(DEFAULT_RULES)
    saved = row.value if row and isinstance(row.value, dict) else {}
    out.update({k: v for k, v in saved.items() if k in DEFAULT_RULES and k != "rules"})
    raw = saved.get("rules")
    states: Dict[str, Any] = raw if isinstance(raw, dict) else {}
    out["rules"] = {
        r: {**DEFAULT_RULE_STATE, **{k: bool(v) for k, v in (states.get(r) or {}).items() if k in DEFAULT_RULE_STATE}}
        for r in RULE_NAMES
    }
    return out


def validate_settings(payload: Dict[str, Any]) -> Dict[str, Any]:
    """Clean a rule-settings change: known keys only, each of its default's type; `rules` =
    {rule: {enabled, shadow}}. Raises ValueError with the offending key."""
    out: Dict[str, Any] = {}
    for k, v in payload.items():
        if k not in DEFAULT_RULES:
            raise ValueError(f"Unknown setting {k!r}")
        d = DEFAULT_RULES[k]
        if k == "rules":
            if not isinstance(v, dict):
                raise ValueError("rules must be an object {rule: {enabled, shadow}}")
            rules: Dict[str, Dict[str, bool]] = {}
            for r, st in v.items():
                if r not in RULE_NAMES or not isinstance(st, dict):
                    raise ValueError(f"Unknown rule {r!r}")
                bad = [x for x in st if x not in DEFAULT_RULE_STATE or not isinstance(st[x], bool)]
                if bad:
                    raise ValueError(f"rules.{r}: only enabled / shadow (true / false)")
                rules[r] = dict(st)
            out[k] = rules
        elif isinstance(d, list):
            if not isinstance(v, list) or not all(isinstance(x, str) and x.strip() for x in v):
                raise ValueError(f"{k} must be a list of words")
            out[k] = [x.strip().lower() for x in v]
        else:
            if isinstance(v, bool) or not isinstance(v, (int, float)):
                raise ValueError(f"{k} must be a number")
            if isinstance(d, int) and float(v) != int(v):
                raise ValueError(f"{k} must be a whole number")
            if k not in ("r7_pct",) and v < 0:
                raise ValueError(f"{k} must not be negative")
            out[k] = int(v) if isinstance(d, int) else float(v)
    return out


def put_rule_settings(db: Session, payload: Dict[str, Any], username: Optional[str]) -> Tuple[Dict[str, Any], Dict[str, Any]]:
    """Merge a change into the saved overrides. Returns (old, new) effective settings."""
    clean = validate_settings(payload)
    old = rule_settings(db)
    row = db.get(AppSetting, SETTING_KEY)
    saved = dict(row.value) if row and isinstance(row.value, dict) else {}
    if "rules" in clean:
        merged = dict(saved.get("rules") or {})
        for r, st in clean.pop("rules").items():
            merged[r] = {**(merged.get(r) or {}), **st}
        saved["rules"] = merged
    saved.update(clean)
    if row is None:
        db.add(AppSetting(key=SETTING_KEY, value=saved, updated_by=username))
    else:
        row.value = saved
        row.updated_by = username
    db.commit()
    return old, rule_settings(db)


def _thb(pr: Pricer, plant_id: int, kwh: Optional[float], on_kwh: Optional[float]) -> Optional[float]:
    v = pr.thb(plant_id, kwh, on_kwh)
    return None if v is None else round(v, 0)


def _finding(rule: str, tier: str, plant_id: int, day: date, device_sn: Optional[str] = None,
             string_no: Optional[int] = None, lost_kwh_est: Optional[float] = None,
             thb_est: Optional[float] = None, **evidence: Any) -> Dict[str, Any]:
    return {
        "rule": rule,
        "name": RULE_NAMES[rule],
        "tier": tier,
        "plant_id": plant_id,
        "device_sn": device_sn,
        "string_no": string_no,
        "day": day.isoformat(),
        "lost_kwh_est": None if lost_kwh_est is None else round(lost_kwh_est, 2),
        "thb_est": thb_est,
        "evidence": evidence,
    }


def _matches(message: Optional[str], keywords: Sequence[str]) -> bool:
    m = (message or "").lower()
    return any(k in m for k in keywords)


def _alarm_events(rows: Sequence[GrowattAlarm]) -> List[GrowattAlarm]:
    """Collapse Growatt's repeated reports of one alarm (same inverter + code, next start within
    ALARM_EVENT_GAP of the previous) into the first report of each event."""
    out: List[GrowattAlarm] = []
    last: Dict[tuple, datetime] = {}
    for a in sorted(rows, key=lambda a: (a.device_sn, a.alarm_code or "", a.start_time or datetime.min)):
        if a.start_time is None:
            continue
        key = (a.device_sn, a.alarm_code)
        prev = last.get(key)
        if prev is None or a.start_time - prev > ALARM_EVENT_GAP:
            out.append(a)
        last[key] = a.end_time or a.start_time
    return out


def evaluate(
    db: Session, day: date, plant_ids: Optional[Sequence[int]] = None, pricer: Optional[Pricer] = None
) -> List[Dict[str, Any]]:
    """Findings for `day` (plant-local) of the enabled rules, safety first, then by tier and
    estimated baht (lost kWh where there is no price)."""
    cfg = rule_settings(db)
    pr = pricer or load_pricer(db)
    on = {r for r, st in cfg["rules"].items() if st["enabled"]}
    line = float(cfg["p1_thb_per_day"])
    look = max(int(cfg["r5_window_days"]), int(cfg["r1_days"]), int(cfg["r7_days"]), int(cfg["r9_window_days"]))
    since = day - timedelta(days=look - 1)
    out: List[Dict[str, Any]] = []

    SD = GrowattStringDaily
    q = select(SD).where(SD.day >= since, SD.day <= day)
    if plant_ids is not None:
        q = q.where(SD.plant_id.in_(list(plant_ids)))
    strings: Dict[tuple, Dict[date, GrowattStringDaily]] = defaultdict(dict)
    for r in db.scalars(q):
        strings[(r.plant_id, r.device_sn, r.string_no)][r.day] = r

    for (pid, sn, sno), days in strings.items():
        today = days.get(day)
        thb = _thb(pr, pid, today.lost_kwh_est, today.lost_on_peak_kwh_est) if today else None
        # R2 open string (no irradiance gate needed: peers carry ≥ 2 A while it reads ≤ 0.3 A)
        if today and today.open_min >= cfg["r2_open_min"]:
            if "R2" in on:
                tier = "P1" if thb is not None and thb > line else "P2"
                out.append(_finding("R2", tier, pid, day, sn, sno, today.lost_kwh_est, thb, open_min=today.open_min))
            continue  # an open string is also "low": R1 / R5 would only repeat it
        # R1 weak string: persistent, judged only on days with a verdict
        window = [days.get(day - timedelta(days=k)) for k in range(int(cfg["r1_days"]))]
        judged = [r for r in window if r is not None and r.low_min is not None]
        hits = [r for r in judged if (r.low_min or 0) >= cfg["r1_low_min"]]
        if (
            "R1" in on and today and today.low_min is not None and today.low_min >= cfg["r1_low_min"]
            and len(hits) >= cfg["r1_days_hit"]
        ):
            out.append(
                _finding(
                    "R1", "P2", pid, day, sn, sno, today.lost_kwh_est, thb,
                    low_min=today.low_min, severe_min=today.severe_min, ratio_median=today.ratio_median,
                    days_hit=len(hits), days_judged=len(judged),
                )
            )
            continue
        # R5 slow drift
        r5_since = day - timedelta(days=int(cfg["r5_window_days"]) - 1)
        ratios = [r.ratio_median for d, r in days.items() if d >= r5_since and r.ratio_median is not None]
        if "R5" in on and today and len(ratios) >= cfg["r5_min_days"]:
            med = statistics.median(ratios)
            if med < cfg["r5_ratio"]:
                out.append(_finding("R5", "P3", pid, day, sn, sno, today.lost_kwh_est, thb,
                                    ratio_median_window=round(med, 4), days=len(ratios)))

    ID = GrowattInverterDaily
    q2 = select(ID).where(ID.day >= day - timedelta(days=int(cfg["r7_days"]) - 1), ID.day <= day)
    if plant_ids is not None:
        q2 = q2.where(ID.plant_id.in_(list(plant_ids)))
    invs: Dict[tuple, Dict[date, GrowattInverterDaily]] = defaultdict(dict)
    for r in db.scalars(q2):
        invs[(r.plant_id, r.device_sn)][r.day] = r

    def gap_pct(r: GrowattInverterDaily) -> Optional[float]:
        if not r.daylight_min:
            return None
        return (r.fault_min + r.off_min + r.standby_min + r.no_data_min) / r.daylight_min * 100

    for (pid, sn), days in invs.items():
        r = days.get(day)
        if r is None:
            continue
        down = r.fault_min + r.off_min + r.standby_min
        if "R8" in on and down >= cfg["r8_min_down_min"]:
            lost = [x for x in (r.lost_fault_kwh_est, r.lost_off_kwh_est, r.lost_standby_kwh_est) if x is not None]
            kwh = sum(lost) if lost else None
            share = r.plant_kwp_share_pct
            tier = "P1" if share is not None and share > cfg["r8_p1_share_pct"] else "P2"
            out.append(
                _finding("R8", tier, pid, day, sn, None, kwh, _thb(pr, pid, kwh, r.lost_down_on_peak_kwh_est),
                         fault_min=r.fault_min, off_min=r.off_min, standby_min=r.standby_min, kwp_share_pct=share)
            )
        if "R17" in on and r.daylight_min and r.no_data_min / r.daylight_min * 100 > cfg["r17_pct"]:
            out.append(_finding("R17", "P4", pid, day, sn, None, r.lost_no_data_kwh_est,
                                _thb(pr, pid, r.lost_no_data_kwh_est, r.lost_no_data_on_peak_kwh_est),
                                no_data_min=r.no_data_min, daylight_min=r.daylight_min))
        if "R18" in on and r.limited_min > 0:
            out.append(_finding("R18", "Info", pid, day, sn, None, None, None, limited_min=r.limited_min))
        series = [days.get(day - timedelta(days=k)) for k in range(int(cfg["r7_days"]))]
        if "R7" in on and all(
            x is not None and x.yf_vs_median_pct is not None and x.yf_vs_median_pct < cfg["r7_pct"]
            and (gap_pct(x) or 0) <= cfg["r7_max_gap_pct"]
            for x in series
        ):
            # what the inverter would have made at the median specific yield of the others;
            # the time of the shortfall is unknown, so it is priced at off-peak (never inflated)
            pct = r.yf_vs_median_pct or 0.0
            kwh = r.energy_kwh * (1 / (1 + pct / 100) - 1) if r.energy_kwh is not None and pct > -100 else None
            thb = _thb(pr, pid, kwh, None)
            tier = "P2" if thb is not None and thb > line else "P3"
            out.append(_finding("R7", tier, pid, day, sn, None, kwh, thb,
                                yf_vs_median_pct=[x.yf_vs_median_pct for x in series if x is not None]))

    # alarm rules
    A = GrowattAlarm
    q3 = select(A).where(A.day >= day - timedelta(days=int(cfg["r9_window_days"]) - 1), A.day <= day)
    if plant_ids is not None:
        q3 = q3.where(A.plant_id.in_(list(plant_ids)))
    alarms = list(db.scalars(q3))
    by_inv: Dict[tuple, List[GrowattAlarm]] = defaultdict(list)
    for a in _alarm_events(alarms):
        by_inv[(a.plant_id, a.device_sn)].append(a)
    for (pid, sn), events in by_inv.items():
        safety = [a for a in events if a.day == day and _matches(a.alarm_message, cfg["r3_keywords"])]
        if "R3" in on and safety:
            out.append(_finding("R3", "P1", pid, day, sn, None, None, None, safety=True,
                                alarms=sorted({f"{a.alarm_code} {a.alarm_message}" for a in safety})))
        trips = [a for a in events if _matches(a.alarm_message, cfg["r9_keywords"])]
        if "R9" in on and len(trips) >= cfg["r9_events"] and any(a.day == day for a in trips):
            out.append(_finding("R9", "P3", pid, day, sn, None, None, None, events=len(trips),
                                window_days=int(cfg["r9_window_days"])))

    names = dict(db.execute(select(GrowattPlant.plant_id, GrowattPlant.name)).all())
    for f in out:
        f["plant_name"] = names.get(f["plant_id"])
        f["safety"] = bool(f["evidence"].get("safety"))
        f["shadow"] = cfg["rules"][f["rule"]]["shadow"]
    out.sort(key=lambda f: (not f["safety"], TIER_ORDER[f["tier"]], -(f["thb_est"] or 0), -(f["lost_kwh_est"] or 0)))
    return out


def summarize(findings: Sequence[Dict[str, Any]]) -> Dict[str, Any]:
    by_rule: Dict[str, int] = defaultdict(int)
    by_tier: Dict[str, int] = defaultdict(int)
    for f in findings:
        by_rule[f["rule"]] += 1
        by_tier[f["tier"]] += 1
    return {"findings": len(findings), "by_rule": dict(by_rule), "by_tier": dict(by_tier)}
