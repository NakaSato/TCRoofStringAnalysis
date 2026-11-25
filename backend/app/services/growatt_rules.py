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
from typing import Any, Dict, List, Optional, Sequence

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db.models import (
    AppSetting,
    GrowattAlarm,
    GrowattInverterDaily,
    GrowattPlant,
    GrowattPlantDaily,
    GrowattStringDaily,
)
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
    # R4 bypass diode: string voltage more than 1.2 % below peer voltage for >= 2 days (per-string voltage sensing only)
    "r4_v_drop_pct": 1.2,
    "r4_days": 2,
    # R5 slow drift: median ratio over a window
    "r5_window_days": 30,
    "r5_min_days": 10,
    "r5_ratio": 0.95,
    # R6 PID / rapid string degradation: R_i falling more than 1 % per month
    "r6_window_days": 30,
    "r6_min_days": 10,
    "r6_drop_pct_per_month": 1.0,
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
    # R10 plant EPI control-chart anomaly (mu - 3*sigma for 1 day, or mu - 2*sigma for 3 days)
    "r10_window_days": 30,
    "r10_min_days": 7,
    "r10_two_sigma_days": 3,
    # R11 inverter Ya - Yf conversion/BOS loss drift
    "r11_window_days": 14,
    "r11_min_days": 5,
    "r11_days": 2,
    "r11_gap_increase_h": 0.15,
    # R16 weather-sensor health: stale readings, above clear sky, or far below the neighbours' sensors
    # on a day Google (modelled) calls clear. A failing day greys out PR / PR' / EPI and R10 skips it.
    "r16_stale_slots": 12,  # daylight 5-min slots in runs of >= 3 identical non-zero readings
    "r16_high_slots": 6,  # slots above clear-sky GHI × 1.5 (growatt_daily.SENSOR_CLEAR_SKY_FACTOR)
    "r16_neighbour_ratio": 0.7,  # midday irradiance below this share of the neighbours' median
    "r16_clear_cloud_pct": 20.0,  # neighbour check only when Google's midday cloud cover is at most this
    # Soiling (services/soiling.py, plan §6): good days = EPI with the sensor passing R16, clearness
    # >= soil_min_clearness, inverters down <= 3 %. Cleaning step = median EPI of up to soil_step_days
    # good days before vs after a cleaning (within soil_window_days, >= soil_min_days on each side).
    "soil_min_clearness": 0.6,
    "soil_window_days": 14,
    "soil_step_days": 5,
    "soil_min_days": 3,
    "soil_rain_mm": 10.0,  # daytime rain (Google, modelled) that counts as washing the array
    # R13 incomplete recovery after a heavy rain: suggest a manual cleaning
    "r13_before_days": 7,
    "r13_judge_days": 3,
    "r13_min_days": 2,
    "r13_max_age_days": 30,
    "r13_recovery_pct": 50.0,
    "r13_min_deficit": 0.03,  # EPI points below the clean reference before the rain, else nothing to recover
    # R12 soiling wallet: THB lost to dirt since the array was last clean (plant-wide cleaning or heavy
    # rain), from a soiling rate measured on cleaning steps; suggest a cleaning once it reaches the
    # plant's cleaning cost, outside the monsoon. Rate = the plant's own median, else the fleet's
    # median when at least r12_fleet_min_plants plants have one.
    "r12_rate_lookback_days": 365,
    "r12_fleet_min_plants": 3,
    "r12_max_soiling_pct": 20.0,  # the linear model is capped here (no dirt keeps growing forever)
    "r12_monsoon": ["05-15", "10-15"],  # MM-DD, inclusive: no suggestion in this window
    # R17 data gap
    "r17_pct": 5.0,
    # THB/day above which R2 is P1 (else P2) and R7 is P2 (else P3). Not confirmed yet (plan §9 Q4).
    "p1_thb_per_day": 300.0,
    # per rule: enabled = evaluated at all; shadow = issues recorded but shown to admins only
    "rules": {},
}

ALARM_EVENT_GAP = timedelta(minutes=15)  # Growatt re-reports an open alarm every ~5 min

RULE_NAMES = {
    "R1": "Weak string",
    "R2": "Open string",
    "R3": "Insulation / ground fault",
    "R4": "Bypass diode (voltage drop)",
    "R5": "Slow string drift",
    "R6": "PID / rapid string degradation",
    "R7": "Inverter underperforming",
    "R8": "Inverter down",
    "R9": "Grid trips",
    "R10": "Plant EPI anomaly",
    "R11": "Inverter Ya − Yf loss drift",
    "R12": "Soiling wallet: cleaning pays off",
    "R13": "Incomplete recovery after rain",
    "R16": "Weather sensor suspect",
    "R17": "Data gap",
    "R18": "Power limiting",
}

TIER_ORDER = {"P1": 0, "P2": 1, "P3": 2, "P4": 3, "Info": 4}

# every rule starts in shadow mode (plan §4.4); overrides (thresholds, enabled / shadow) live in app_settings `decision_rules`, edited in the DB (the Rule review page and its API were removed 2026-11-21)
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


SENSOR_FLAG_TEXT = {
    "stale": "irradiance frozen at one value",
    "above_clear_sky": "irradiance above the clear-sky value",
    "below_neighbours": "irradiance far below nearby plants' sensors on a clear day",
}


def sensor_verdict(row: Optional[GrowattPlantDaily], cfg: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """R16 verdict on one plant-day's stored sensor evidence: {ok, flags, evidence}; None when the
    day has no irradiance to judge. `ok` false = PR, PR' and EPI of that day are not trustworthy."""
    if row is None or row.sensor_stale_slots is None:
        return None
    flags: List[str] = []
    if row.sensor_stale_slots >= int(cfg["r16_stale_slots"]):
        flags.append("stale")
    if row.sensor_high_slots is not None and row.sensor_high_slots >= int(cfg["r16_high_slots"]):
        flags.append("above_clear_sky")
    neighbour_judged = (
        row.sensor_neighbour_ratio is not None
        and row.cloud_midday_pct is not None
        and row.cloud_midday_pct <= float(cfg["r16_clear_cloud_pct"])
    )
    if neighbour_judged and float(row.sensor_neighbour_ratio or 0) < float(cfg["r16_neighbour_ratio"]):
        flags.append("below_neighbours")
    return {
        "ok": not flags,
        "flags": flags,
        "reasons": [SENSOR_FLAG_TEXT[f] for f in flags],
        "evidence": {
            "stale_slots": row.sensor_stale_slots,
            "high_slots": row.sensor_high_slots,
            "midday_wm2": row.sensor_midday_wm2,
            "neighbour_ratio": row.sensor_neighbour_ratio,
            "neighbours": row.sensor_neighbours,
            "cloud_midday_pct": row.cloud_midday_pct,
            "neighbour_judged": neighbour_judged,
        },
    }


def sensor_failed(row: Optional[GrowattPlantDaily], cfg: Dict[str, Any]) -> bool:
    v = sensor_verdict(row, cfg)
    return v is not None and not v["ok"]


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
    look = max(
        int(cfg["r5_window_days"]),
        int(cfg["r6_window_days"]),
        int(cfg["r1_days"]),
        int(cfg["r4_days"]),
        int(cfg["r7_days"]),
        int(cfg["r9_window_days"]),
        int(cfg["r10_window_days"]) + int(cfg["r10_two_sigma_days"]),
        int(cfg["r11_window_days"]) + int(cfg["r11_days"]),
    )
    since = day - timedelta(days=look - 1)
    out: List[Dict[str, Any]] = []
    from app.services.inverter_install import not_installed_sns

    # inverters marked not installed: their older daily rows raise nothing
    gone = not_installed_sns(db, plant_ids)

    SD = GrowattStringDaily
    q = select(SD).where(SD.day >= since, SD.day <= day)
    if plant_ids is not None:
        q = q.where(SD.plant_id.in_(list(plant_ids)))
    strings: Dict[tuple, Dict[date, GrowattStringDaily]] = defaultdict(dict)
    for r in db.scalars(q):
        if r.device_sn not in gone:
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

        # R4 bypass diode: string voltage > r4_v_drop_pct (1.2 %) below peer voltage for >= r4_days
        # Enforces the voltage limit rule: only evaluates when voltage_sensing == "per_string".
        r4_thresh = 1.0 - float(cfg["r4_v_drop_pct"]) / 100.0
        r4_series = [days.get(day - timedelta(days=k)) for k in range(int(cfg["r4_days"]))]
        if (
            "R4" in on
            and today is not None
            and today.voltage_sensing == "per_string"
            and all(
                x is not None
                and x.voltage_sensing == "per_string"
                and x.v_ratio_median is not None
                and x.v_ratio_median < r4_thresh
                for x in r4_series
            )
        ):
            v_drop_pct = round((1.0 - float(today.v_ratio_median or 1.0)) * 100.0, 2)
            out.append(
                _finding(
                    "R4",
                    "P2",
                    pid,
                    day,
                    sn,
                    sno,
                    today.lost_kwh_est,
                    thb,
                    v_ratio_median=today.v_ratio_median,
                    v_drop_pct=v_drop_pct,
                    days=int(cfg["r4_days"]),
                    voltage_sensing=today.voltage_sensing,
                )
            )

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

        # R6 PID / rapid string degradation: R_i falling more than r6_drop_pct_per_month (%/30 days)
        r6_since = day - timedelta(days=int(cfg["r6_window_days"]) - 1)
        r6_pts = sorted(
            ((d - r6_since).days, float(r.ratio_median))
            for d, r in days.items()
            if d >= r6_since and r.ratio_median is not None
        )
        r6_fired = False
        if "R6" in on and today and len(r6_pts) >= int(cfg["r6_min_days"]):
            xs = [p[0] for p in r6_pts]
            ys = [p[1] for p in r6_pts]
            x_mean = statistics.mean(xs)
            y_mean = statistics.mean(ys)
            s_xx = sum((x - x_mean) ** 2 for x in xs)
            if s_xx > 0:
                slope_per_day = sum((x - x_mean) * (y - y_mean) for x, y in zip(xs, ys)) / s_xx
                drop_pct_per_month = -slope_per_day * 30.0 * 100.0
                if drop_pct_per_month > float(cfg["r6_drop_pct_per_month"]):
                    r6_fired = True
                    out.append(
                        _finding(
                            "R6",
                            "P2",
                            pid,
                            day,
                            sn,
                            sno,
                            today.lost_kwh_est,
                            thb,
                            drop_pct_per_month=round(drop_pct_per_month, 2),
                            ratio_median=today.ratio_median,
                            days=len(r6_pts),
                        )
                    )
        if r6_fired:
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
    inv_look = max(int(cfg["r7_days"]), int(cfg["r11_window_days"]) + int(cfg["r11_days"]))
    q2 = select(ID).where(ID.day >= day - timedelta(days=inv_look - 1), ID.day <= day)
    if plant_ids is not None:
        q2 = q2.where(ID.plant_id.in_(list(plant_ids)))
    invs: Dict[tuple, Dict[date, GrowattInverterDaily]] = defaultdict(dict)
    for r in db.scalars(q2):
        if r.device_sn not in gone:
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

        # R11 Inverter Ya - Yf conversion / BOS loss drift
        if "R11" in on:
            r11_days = int(cfg["r11_days"])
            r11_win = int(cfg["r11_window_days"])
            recent_r11 = [days.get(day - timedelta(days=k)) for k in range(r11_days)]
            base_r11 = [
                days.get(day - timedelta(days=k))
                for k in range(r11_days, r11_days + r11_win)
            ]
            base_vals = [float(x.ya_minus_yf) for x in base_r11 if x is not None and x.ya_minus_yf is not None]
            if (
                len(base_vals) >= int(cfg["r11_min_days"])
                and all(x is not None and x.ya_minus_yf is not None for x in recent_r11)
            ):
                base_med = statistics.median(base_vals)
                thresh_gap = base_med + float(cfg["r11_gap_increase_h"])
                if all(float(x.ya_minus_yf or 0.0) >= thresh_gap for x in recent_r11 if x is not None):
                    gap_delta = float(r.ya_minus_yf or 0.0) - base_med
                    kwh_loss = gap_delta * float(r.kwp) if r.kwp and gap_delta > 0 else None
                    thb_loss = _thb(pr, pid, kwh_loss, None)
                    out.append(
                        _finding(
                            "R11",
                            "P3",
                            pid,
                            day,
                            sn,
                            None,
                            kwh_loss,
                            thb_loss,
                            ya_minus_yf=r.ya_minus_yf,
                            baseline_ya_minus_yf=round(base_med, 3),
                            gap_increase_h=round(gap_delta, 3),
                            days=r11_days,
                        )
                    )

    # R10 Plant EPI control-chart anomaly (mu - 3*sigma for 1 day, or mu - 2*sigma for 3 days)
    if "R10" in on:
        PD = GrowattPlantDaily
        r10_win = int(cfg["r10_window_days"])
        r10_2s_days = int(cfg["r10_two_sigma_days"])
        q_pd = select(PD).where(PD.day >= day - timedelta(days=r10_win + r10_2s_days), PD.day <= day)
        if plant_ids is not None:
            q_pd = q_pd.where(PD.plant_id.in_(list(plant_ids)))
        p_days: Dict[int, Dict[date, GrowattPlantDaily]] = defaultdict(dict)
        for pr_row in db.scalars(q_pd):
            p_days[pr_row.plant_id][pr_row.day] = pr_row
        for pid, p_map in p_days.items():
            p_today = p_map.get(day)
            if p_today is None or p_today.epi is None or sensor_failed(p_today, cfg):
                continue  # a failing sensor (R16) makes EPI meaningless that day
            # Baseline excludes the trailing 2-sigma persistence window so a multi-day dip doesn't corrupt mu/sigma
            base_epis = [
                float(r_ep.epi)
                for d in (day - timedelta(days=k) for k in range(r10_2s_days, r10_2s_days + r10_win))
                if (r_ep := p_map.get(d)) is not None and r_ep.epi is not None and not sensor_failed(r_ep, cfg)
            ]
            if len(base_epis) < int(cfg["r10_min_days"]):
                # Fall back to prior days before `day` if history is shorter than r10_2s_days + r10_min_days
                base_epis = [
                    float(r_ep.epi)
                    for d in (day - timedelta(days=k) for k in range(1, r10_win + 1))
                    if (r_ep := p_map.get(d)) is not None and r_ep.epi is not None and not sensor_failed(r_ep, cfg)
                ]
            if len(base_epis) < int(cfg["r10_min_days"]):
                continue
            mu = statistics.mean(base_epis)
            sigma = max(0.015, statistics.stdev(base_epis) if len(base_epis) >= 2 else 0.02)
            thresh_3s = mu - 3.0 * sigma
            thresh_2s = mu - 2.0 * sigma
            recent_2s = [p_map.get(day - timedelta(days=k)) for k in range(r10_2s_days)]
            hit_3s = float(p_today.epi) < thresh_3s
            hit_2s = all(
                x is not None and x.epi is not None and not sensor_failed(x, cfg) and float(x.epi) < thresh_2s
                for x in recent_2s
            )
            if hit_3s or hit_2s:
                tier = "P2" if hit_3s else "P3"
                rule_mode = "3sigma_1d" if hit_3s else f"2sigma_{r10_2s_days}d"
                shortfall_frac = max(0.0, (mu - float(p_today.epi)) / mu) if mu > 0 else 0.0
                kwh_loss = (
                    float(p_today.energy_kwh) * shortfall_frac / max(0.2, float(p_today.epi))
                    if p_today.energy_kwh is not None and shortfall_frac > 0
                    else None
                )
                thb_loss = _thb(pr, pid, kwh_loss, None)
                out.append(
                    _finding(
                        "R10",
                        tier,
                        pid,
                        day,
                        None,
                        None,
                        kwh_loss,
                        thb_loss,
                        epi=round(float(p_today.epi), 3),
                        epi_mu=round(mu, 3),
                        epi_sigma=round(sigma, 3),
                        trigger=rule_mode,
                        pr_temp_corrected_pct=p_today.pr_temp_corrected_pct,
                    )
                )

    # R13 incomplete recovery after a heavy rain (services/soiling.py)
    if "R13" in on:
        from app.services import soiling

        out.extend(soiling.r13_findings(db, day, plant_ids, cfg, pr))

    # R12 soiling wallet (services/soiling.py)
    if "R12" in on:
        from app.services import soiling

        out.extend(soiling.r12_findings(db, day, plant_ids, cfg, pr))

    # R16 weather-sensor health (no energy is lost; the plant's PR / EPI are blind that day)
    if "R16" in on:
        PD = GrowattPlantDaily
        q16 = select(PD).where(PD.day == day)
        if plant_ids is not None:
            q16 = q16.where(PD.plant_id.in_(list(plant_ids)))
        for row in db.scalars(q16):
            v = sensor_verdict(row, cfg)
            if v is not None and not v["ok"]:
                out.append(_finding("R16", "P3", row.plant_id, day, None, None, None, None,
                                    flags=v["flags"], **v["evidence"]))

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
