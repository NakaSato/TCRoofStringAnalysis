"""Daily string and inverter statistics for the decision rules (docs/plans/decision-rules.md §3).

Computed from stored 5-min history only (never Growatt, never live values) into
`growatt_string_daily` and `growatt_inverter_daily`, which `retention` keeps indefinitely, so
the rules in `growatt_rules.py` can look back further than the 90 days of raw readings.

Every figure is either measured (minutes, ratios, energy) or labelled estimated (`lost_*_est`,
from the plant's other inverters / the inverter's other strings). Too little data = null, never
a typical-looking default.

    PYTHONPATH=backend uv run python -m app.services.growatt_daily --day 2026-11-12
    PYTHONPATH=backend uv run python -m app.services.growatt_daily --backfill   # every stored day
"""

from __future__ import annotations

import argparse
import logging
import math
import statistics
from collections import defaultdict
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta
from typing import Any, Dict, Iterable, List, Optional, Sequence, Set, Tuple

from sqlalchemy import delete, func, select
from sqlalchemy.orm import Session

from app.db.models import (
    GoogleWeatherHourly,
    GrowattAlarm,
    GrowattEnvReading,
    GrowattEnvSensor,
    GrowattInverter,
    GrowattInverterDaily,
    GrowattPlant,
    GrowattPlantDaily,
    GrowattStringDaily,
)
from app.services import epi_fit
from app.services.growatt_common import INACTIVE_MAX_A, R, S, _bucket, _day_bounds, _integrate_kwh, capacity_check
from app.services.growatt_layout import load_layout, load_layout_orientations
from app.services.tariff import Pricer, pricer as load_pricer
from solar_core.sun import clear_sky_ghi, sun_times

log = logging.getLogger(__name__)

SLOT_MIN = 5
SLOT_H = SLOT_MIN / 60.0
UTC_OFFSET_H = 7.0  # plant-local time (Asia/Bangkok, no DST)
# daylight window = sunrise + 30 min … sunset − 30 min: inverters asleep at dawn / dusk are not gaps
DAYLIGHT_MARGIN = timedelta(minutes=30)

# string gate (report §2; the live check's 3 A median gate)
GATE_MEDIAN_A = 3.0
GATE_IRRADIANCE_WM2 = 400.0
MAX_IRR_VARIABILITY = 0.15  # max 15 % step change |G_t - G_{t-1}| / G_t for low irradiance variability gate
CLIP_FRACTION = 0.98  # AC power at or above 98 % of the (limited) nameplate = clipped slot
MIN_PEERS = 3  # wired strings reporting in the slot
# The median includes every wired string: with ≥ 3 peers one open string cannot pull it down, while
# leaving 0 A strings out would keep it high when most strings drop together (inverter event).
MIN_GATED_SLOTS = 12  # 1 h of gated data, else no verdict
LOW_RATIO = 0.80
SEVERE_RATIO = 0.60
OPEN_A = 0.3
OPEN_MEDIAN_A = 2.0  # an open string counts only while its peers carry at least this
LOST_MEDIAN_A = 1.0  # deficit (lost kWh) is counted from this median up, not only in gated slots
WIRED_LOOKBACK_DAYS = 30
WIRED_MIN_KWH = 0.05  # a string with a daily row at least this big in the lookback is wired

ERROR_FAULT_TYPES = ("error", "fault")

# R16 sensor-health evidence (judged by growatt_rules.sensor_verdict)
# Plane-of-array sensors read about 1.0–1.05 × the Haurwitz clear-sky GHI at midday and up to ~1.3
# in cloud-edge bursts (95th percentile, fleet 12–15 Nov 2026); morning / evening ratios run higher
# still (tilt, low-sun model error). So: 1.5 ×, and only while clear sky is at least 400 W/m².
SENSOR_CLEAR_SKY_FACTOR = 1.5
SENSOR_CLEAR_SKY_MIN_WM2 = 400.0
SENSOR_STALE_MIN_WM2 = 200.0  # stale runs count in daylight = clear sky at least this
SENSOR_MIDDAY = (10, 14)  # plant-local hours [start, end) of the midday comparison window
SENSOR_MIDDAY_MIN_SLOTS = 24  # 2 h of readings in the window, else no midday value
CLOUD_MIN_HOURS = 3  # Google hours in the window needed for a cloud-cover value
NEIGHBOUR_KM = 50.0
NEIGHBOUR_MIN = 3  # other plants with a midday value within NEIGHBOUR_KM


# --------------------------------------------------------------------------- loading


@dataclass
class InvSlot:
    status: Optional[int] = None
    pac: List[float] = field(default_factory=list)

    @property
    def pac_w(self) -> float:
        return statistics.mean(self.pac) if self.pac else 0.0


def _daylight(
    plant: GrowattPlant, day: date, inv_slots: Dict[str, Dict[datetime, InvSlot]], until: Optional[datetime] = None
) -> List[datetime]:
    """5-min slots of the day's daylight window, ending at `until` (the fleet's newest stored
    record: later slots of today are not fetched yet, not missing). Without coordinates: first to
    last slot in which any inverter of the plant produced (nothing to judge before or after that)."""
    start = end = None
    if plant.latitude is not None and plant.longitude is not None:
        st = sun_times(day, float(plant.latitude), float(plant.longitude), UTC_OFFSET_H)
        if st:
            start, end = st[0] + DAYLIGHT_MARGIN, st[1] - DAYLIGHT_MARGIN
    if start is None or end is None:
        producing = [ts for slots in inv_slots.values() for ts, s in slots.items() if s.pac_w > 0]
        if not producing:
            return []
        start, end = min(producing), max(producing) + timedelta(minutes=SLOT_MIN)
    if until is not None:
        end = min(end, until)
    first = _bucket(start)
    if first < start:
        first += timedelta(minutes=SLOT_MIN)
    out = []
    t = first
    while t + timedelta(minutes=SLOT_MIN) <= end:
        out.append(t)
        t += timedelta(minutes=SLOT_MIN)
    return out


def _irradiance(db: Session, plant_id: int, day: date) -> Dict[datetime, float]:
    """Mean irradiance per 5-min slot over the plant's sensors that read irradiance that day
    (an unfitted probe reads 0 all day and is left out). Empty = no sensor reading."""
    lo, hi = _day_bounds(day)
    E = GrowattEnvReading
    rows = db.execute(
        select(E.datalogger_sn, E.address, E.timestamp, E.irradiance_wm2)
        .join(GrowattEnvSensor, (GrowattEnvSensor.datalogger_sn == E.datalogger_sn) & (GrowattEnvSensor.address == E.address))
        .where(GrowattEnvSensor.plant_id == plant_id, E.timestamp >= lo, E.timestamp < hi, E.irradiance_wm2.is_not(None))
    ).all()
    per_sensor: Dict[Tuple[str, int], List[Tuple[datetime, float]]] = defaultdict(list)
    for dl, addr, ts, irr in rows:
        if irr is not None:
            per_sensor[(dl, addr)].append((ts, float(irr)))
    slots: Dict[datetime, List[float]] = defaultdict(list)
    for vals in per_sensor.values():
        if max(v for _, v in vals) <= 0:
            continue
        for ts, v in vals:
            slots[_bucket(ts)].append(v)
    return {ts: statistics.mean(v) for ts, v in slots.items()}


def _error_alarms(db: Session, plant_id: int, day: date) -> Dict[str, List[Tuple[datetime, datetime]]]:
    """Intervals of the day's Error / Fault alarms per inverter (open ones run to the day's end)."""
    lo, hi = _day_bounds(day)
    out: Dict[str, List[Tuple[datetime, datetime]]] = defaultdict(list)
    for sn, start, end, ftype in db.execute(
        select(GrowattAlarm.device_sn, GrowattAlarm.start_time, GrowattAlarm.end_time, GrowattAlarm.fault_type).where(
            GrowattAlarm.plant_id == plant_id, GrowattAlarm.day == day
        )
    ):
        if start is None or (ftype or "").strip().lower() not in ERROR_FAULT_TYPES:
            continue
        out[sn].append((max(start, lo), min(end or hi, hi)))
    return out


def _in_alarm(intervals: Sequence[Tuple[datetime, datetime]], slot: datetime) -> bool:
    slot_end = slot + timedelta(minutes=SLOT_MIN)
    return any(a < slot_end and b > slot for a, b in intervals)


def _limit_w(inv: GrowattInverter) -> Optional[float]:
    """AC power the inverter may deliver: nameplate × active power limit; None if unknown."""
    if not inv.nominal_power_w:
        return None
    limit = inv.active_limit_pct
    rate = limit if limit is not None else 100.0
    return float(inv.nominal_power_w) * min(rate, 100.0) / 100.0


def _limited(inv: GrowattInverter) -> bool:
    limit = inv.active_limit_pct
    return limit is not None and limit < 100


def _clipped(inv: GrowattInverter, pac_w: float) -> bool:
    lim = _limit_w(inv)
    return lim is not None and pac_w >= CLIP_FRACTION * lim


def _wired(
    db: Session, plant_id: int, day: date, sns: Sequence[str], seen_today: Dict[str, Set[int]]
) -> Dict[str, Set[int]]:
    """Wired inputs per inverter: String Layout rows, inputs that carried current today, and inputs
    with energy in a stored daily row of the last 30 days (so a string dead all day still counts)."""
    out: Dict[str, Set[int]] = defaultdict(set)
    for sn, sno in load_layout(db, sns, fleet_wp=False):
        out[sn].add(sno)
    for sn, nos in seen_today.items():
        out[sn] |= nos
    D = GrowattStringDaily
    for sn, sno in db.execute(
        select(D.device_sn, D.string_no)
        .where(
            D.plant_id == plant_id,
            D.day >= day - timedelta(days=WIRED_LOOKBACK_DAYS),
            D.day < day,
            D.energy_kwh >= WIRED_MIN_KWH,
        )
        .group_by(D.device_sn, D.string_no)
    ):
        out[sn].add(int(sno))
    return out


def _inverter_kwp(
    invs: Sequence[GrowattInverter], wired: Dict[str, Set[int]], layout: Dict[Tuple[str, int], Tuple[int, Optional[float]]],
    plant_kwp: Optional[float],
) -> Dict[str, Optional[float]]:
    """DC kWp per inverter: modules × Wp when the layout covers every wired string, else the
    plant's kWp shared by rated AC power (only when every inverter has a rating); else None."""
    out: Dict[str, Optional[float]] = {}
    total_ac = sum(float(i.nominal_power_w or 0) for i in invs)
    all_rated = all(i.nominal_power_w for i in invs)
    for inv in invs:
        strings = wired.get(inv.device_sn) or set()
        entries = [layout.get((inv.device_sn, s)) for s in strings]
        if strings and all(e is not None and e[1] for e in entries):
            out[inv.device_sn] = sum(e[0] * float(e[1]) for e in entries if e and e[1]) / 1000.0
        elif plant_kwp and all_rated and total_ac > 0:
            out[inv.device_sn] = plant_kwp * float(inv.nominal_power_w or 0) / total_ac
        else:
            out[inv.device_sn] = None
    return out


# --------------------------------------------------------------------------- one plant-day


def _median(values: Iterable[float]) -> Optional[float]:
    vals = list(values)
    return statistics.median(vals) if vals else None


def compute_plant_day(
    db: Session, plant: GrowattPlant, day: date, until: Optional[datetime] = None, pricer: Optional[Pricer] = None
) -> Dict[str, int]:
    """Replace the plant's daily string and inverter rows for `day`. Returns row counts.
    `until`: newest stored record of the fleet; daylight after it is not judged (today).
    `pricer`: the tariff, for splitting lost kWh into on-peak / off-peak hours."""
    pr = pricer or load_pricer(db)
    invs = list(db.scalars(select(GrowattInverter).where(GrowattInverter.plant_id == plant.plant_id)))
    sns = [i.device_sn for i in invs]
    by_sn = {i.device_sn: i for i in invs}
    lo, hi = _day_bounds(day)
    db.execute(delete(GrowattStringDaily).where(GrowattStringDaily.plant_id == plant.plant_id, GrowattStringDaily.day == day))
    db.execute(delete(GrowattInverterDaily).where(GrowattInverterDaily.plant_id == plant.plant_id, GrowattInverterDaily.day == day))
    db.execute(delete(GrowattPlantDaily).where(GrowattPlantDaily.plant_id == plant.plant_id, GrowattPlantDaily.day == day))
    if not sns:
        return {"strings": 0, "inverters": 0}

    # inverter records → 5-min slots; daily yield = the day's last eac_today
    inv_slots: Dict[str, Dict[datetime, InvSlot]] = defaultdict(dict)
    eac_points: Dict[str, List[Tuple[datetime, float]]] = defaultdict(list)
    ppv_points: Dict[str, List[Tuple[datetime, float]]] = defaultdict(list)
    pac_points: Dict[str, List[Tuple[datetime, float]]] = defaultdict(list)
    for sn, ts, status, pac, ppv, eac in db.execute(
        select(R.device_sn, R.timestamp, R.status, R.pac_w, R.ppv_w, R.eac_today_kwh)
        .where(R.device_sn.in_(sns), R.timestamp >= lo, R.timestamp < hi)
        .order_by(R.device_sn, R.timestamp)
    ):
        slot = inv_slots[sn].setdefault(_bucket(ts), InvSlot())
        slot.status = status
        if pac is not None:
            slot.pac.append(float(pac))
            pac_points[sn].append((ts, float(pac)))
        if ppv is not None:
            ppv_points[sn].append((ts, float(ppv)))
        if eac is not None:
            eac_points[sn].append((ts, float(eac)))

    # string records → per inverter and slot: {string_no: (V, I)}; energy integrated per string
    str_slots: Dict[str, Dict[datetime, Dict[int, Tuple[float, float]]]] = defaultdict(lambda: defaultdict(dict))
    str_power: Dict[Tuple[str, int], List[Tuple[datetime, float]]] = defaultdict(list)
    seen_today: Dict[str, Set[int]] = defaultdict(set)
    raw: Dict[Tuple[str, datetime, int], List[Tuple[float, float]]] = defaultdict(list)
    for sn, ts, sno, v, i, p in db.execute(
        select(S.device_sn, S.timestamp, S.string_no, S.voltage_v, S.current_a, S.power_w)
        .where(S.device_sn.in_(sns), S.timestamp >= lo, S.timestamp < hi)
        .order_by(S.device_sn, S.timestamp)
    ):
        raw[(sn, _bucket(ts), int(sno))].append((float(v), float(i)))
        str_power[(sn, int(sno))].append((ts, float(p)))
        if i > INACTIVE_MAX_A:
            seen_today[sn].add(int(sno))
    for (sn, slot, sno), vals in raw.items():
        str_slots[sn][slot][sno] = (statistics.mean(v for v, _ in vals), statistics.mean(i for _, i in vals))

    irr = _irradiance(db, plant.plant_id, day)
    alarms = _error_alarms(db, plant.plant_id, day)
    wired = _wired(db, plant.plant_id, day, sns, seen_today)
    layout = load_layout(db, sns)
    orientations = load_layout_orientations(db, sns)
    plant_kwp, _ = capacity_check(db, plant)
    kwp = _inverter_kwp(invs, wired, layout, plant_kwp)

    n_str = _strings_day(db, plant.plant_id, day, by_sn, inv_slots, str_slots, str_power, wired, layout, orientations, irr, pr)
    n_inv = _inverters_day(db, plant, day, invs, inv_slots, eac_points, ppv_points, pac_points, alarms, kwp, until, pr)
    _plant_day(db, plant, day, invs, inv_slots, eac_points, ppv_points, pac_points, plant_kwp, epi_fit.active_factor(db, plant.plant_id))
    return {"strings": n_str, "inverters": n_inv}


def _strings_day(
    db: Session,
    plant_id: int,
    day: date,
    by_sn: Dict[str, GrowattInverter],
    inv_slots: Dict[str, Dict[datetime, InvSlot]],
    str_slots: Dict[str, Dict[datetime, Dict[int, Tuple[float, float]]]],
    str_power: Dict[Tuple[str, int], List[Tuple[datetime, float]]],
    wired: Dict[str, Set[int]],
    layout: Dict[Tuple[str, int], Tuple[int, Optional[float]]],
    orientations: Dict[Tuple[str, int], Tuple[Optional[float], Optional[float]]],
    irr: Dict[datetime, float],
    pr: Pricer,
) -> int:
    n = 0
    # Precompute unstable irradiance slots (> MAX_IRR_VARIABILITY step change between adjacent 5-min slots)
    unstable_irr_slots: Set[datetime] = set()
    sorted_irr = sorted(irr.items())
    for idx in range(1, len(sorted_irr)):
        ts_prev, g_prev = sorted_irr[idx - 1]
        ts_curr, g_curr = sorted_irr[idx]
        if (ts_curr - ts_prev) <= timedelta(minutes=SLOT_MIN * 2) and max(g_prev, g_curr) > 0:
            if abs(g_curr - g_prev) / max(g_prev, g_curr) > MAX_IRR_VARIABILITY:
                unstable_irr_slots.add(ts_curr)

    for sn, inv in by_sn.items():
        strings = sorted(wired.get(sn) or ())
        if not strings:
            continue
        per_module = all((sn, s) in layout for s in strings)
        # Peer group key: (modules, azimuth_deg, tilt_deg) when layout exists
        peer_group_key: Dict[int, Tuple[Optional[int], Optional[float], Optional[float]]] = {}
        for s in strings:
            mods = layout[(sn, s)][0] if (sn, s) in layout else None
            az, tilt = orientations.get((sn, s), (None, None))
            peer_group_key[s] = (mods, az, tilt)

        # Determine voltage sensing capability per string:
        # Growatt string `s` sits on MPPT `(s + 1) // 2`. If another wired string shares that MPPT,
        # they report the same MPPT voltage (`shared_mppt`), so bypass-diode voltage rule cannot isolate a string.
        mppt_counts: Dict[int, int] = defaultdict(int)
        for s in strings:
            mppt_counts[(s + 1) // 2] += 1
        v_sensing: Dict[int, str] = {
            s: ("per_string" if mppt_counts[(s + 1) // 2] == 1 else "shared_mppt") for s in strings
        }

        ratios: Dict[int, List[float]] = defaultdict(list)
        v_ratios: Dict[int, List[float]] = defaultdict(list)
        open_slots: Dict[int, int] = defaultdict(int)
        lost_kwh: Dict[int, float] = defaultdict(float)
        lost_on: Dict[int, float] = defaultdict(float)
        gated = 0
        for slot, vals in sorted(str_slots.get(sn, {}).items()):
            rec = inv_slots.get(sn, {}).get(slot)
            if rec is None or rec.status != 1:
                continue
            present = {s: vals[s] for s in strings if s in vals}
            if len(present) < MIN_PEERS:
                continue
            # several strings at ~0 A at once is the inverter (derating, MPPT sweep), not the strings
            n_open = sum(1 for _, i in present.values() if i <= OPEN_A)
            if n_open > max(1, len(present) // 3):
                continue
            med = _median(i for _, i in present.values()) or 0.0
            clipped = _clipped(inv, rec.pac_w)
            on_peak = pr.is_on_peak(slot)

            # Peer median per string (matching orientation, tilt, and module count when >= 2 peers exist in group)
            def peer_med_for(s_target: int) -> float:
                gk = peer_group_key.get(s_target)
                if gk and gk[0] is not None:
                    same_group = [i_val for s_other, (_v_val, i_val) in present.items() if peer_group_key.get(s_other) == gk]
                    if len(same_group) >= 2:
                        return _median(same_group) or med
                return med

            for s, (v, i) in present.items():
                s_med = peer_med_for(s)
                if i <= OPEN_A and s_med >= OPEN_MEDIAN_A:
                    open_slots[s] += 1
                if not clipped and s_med >= LOST_MEDIAN_A and i < LOW_RATIO * s_med:
                    kwh = (s_med - i) * v * SLOT_H / 1000.0
                    lost_kwh[s] += kwh
                    if on_peak:
                        lost_on[s] += kwh
            slot_irr = irr.get(slot)
            if (
                med < GATE_MEDIAN_A
                or clipped
                or (slot_irr is not None and slot_irr < GATE_IRRADIANCE_WM2)
                or slot in unstable_irr_slots
            ):
                continue
            gated += 1
            for s, (_v, i) in present.items():
                s_med = peer_med_for(s)
                if s_med > 0:
                    ratios[s].append(i / s_med)
            if per_module:
                vpm = {s: v / layout[(sn, s)][0] for s, (v, _) in present.items() if layout[(sn, s)][0] > 0}
                for s, x in vpm.items():
                    gk = peer_group_key.get(s)
                    same_grp_Peers = [y for t, y in vpm.items() if t != s and peer_group_key.get(t) == gk]
                    peer = _median(same_grp_Peers if same_grp_Peers else [y for t, y in vpm.items() if t != s])
                    if peer:
                        v_ratios[s].append(x / peer)
            else:
                # When module counts are uniform/unspecified, compare raw string voltage against peers
                v_raw = {s: v for s, (v, _) in present.items() if v > 0}
                for s, x in v_raw.items():
                    peer = _median(y for t, y in v_raw.items() if t != s)
                    if peer:
                        v_ratios[s].append(x / peer)
        for s in strings:
            rs = ratios.get(s, [])
            verdict = len(rs) >= MIN_GATED_SLOTS
            db.add(
                GrowattStringDaily(
                    device_sn=sn,
                    string_no=s,
                    day=day,
                    plant_id=plant_id,
                    gated_slots=len(rs),
                    ratio_median=round(statistics.median(rs), 4) if verdict else None,
                    low_min=sum(1 for r in rs if r < LOW_RATIO) * SLOT_MIN if verdict else None,
                    severe_min=sum(1 for r in rs if r < SEVERE_RATIO) * SLOT_MIN if verdict else None,
                    open_min=open_slots.get(s, 0) * SLOT_MIN,
                    v_ratio_median=round(statistics.median(v_ratios[s]), 4) if verdict and v_ratios.get(s) else None,
                    voltage_sensing=v_sensing.get(s, "shared_mppt"),
                    energy_kwh=round(_integrate_kwh(str_power[(sn, s)]), 3) if str_power.get((sn, s)) else None,
                    lost_kwh_est=round(lost_kwh.get(s, 0.0), 3),
                    lost_on_peak_kwh_est=round(lost_on.get(s, 0.0), 3),
                )
            )
            n += 1
        log.debug("strings %s %s: %d gated slots", sn, day, gated)
    return n


def _inverters_day(
    db: Session,
    plant: GrowattPlant,
    day: date,
    invs: Sequence[GrowattInverter],
    inv_slots: Dict[str, Dict[datetime, InvSlot]],
    eac_points: Dict[str, List[Tuple[datetime, float]]],
    ppv_points: Dict[str, List[Tuple[datetime, float]]],
    pac_points: Dict[str, List[Tuple[datetime, float]]],
    alarms: Dict[str, List[Tuple[datetime, datetime]]],
    kwp: Dict[str, Optional[float]],
    until: Optional[datetime] = None,
    pr: Optional[Pricer] = None,
) -> int:
    pr = pr or Pricer({"on_peak_thb": 0, "off_peak_thb": 0, "on_peak_days": []})
    daylight = _daylight(plant, day, inv_slots, until)
    states: Dict[str, Dict[datetime, str]] = {}
    judged: Dict[str, List[datetime]] = {}
    for inv in invs:
        sn = inv.device_sn
        st: Dict[datetime, str] = {}
        slots = daylight
        if until is not None:
            # today: each inverter only up to its own newest record (accounts sync at different
            # times, so later slots are not fetched yet). A datalogger silent since the morning
            # shows up as a gap in the next rules_yesterday, which judges the full window.
            newest = eac_points[sn][-1][0] if eac_points.get(sn) else None
            slots = [t for t in daylight if newest is not None and t <= newest]
        judged[sn] = slots
        for slot in slots:
            rec = inv_slots.get(sn, {}).get(slot)
            if rec is not None and rec.pac_w > 0:
                st[slot] = "limited" if _limited(inv) and _clipped(inv, rec.pac_w) else "producing"
            elif (rec is not None and rec.status == 3) or _in_alarm(alarms.get(sn, ()), slot):
                st[slot] = "fault"
            elif rec is None:
                st[slot] = "no_data"
            else:
                st[slot] = "idle"  # record without power: judged below against the other inverters
        states[sn] = st

    # kW per kWp of the producing inverters in each slot (the reference for lost energy)
    def peer_spec(slot: datetime, exclude: str) -> Optional[float]:
        p = k = 0.0
        for inv in invs:
            sn = inv.device_sn
            if sn == exclude or states[sn].get(slot) not in ("producing", "limited"):
                continue
            if not kwp.get(sn):
                return None
            p += inv_slots[sn][slot].pac_w
            k += float(kwp[sn] or 0)
        return p / 1000.0 / k if k > 0 else None

    rows: Dict[str, GrowattInverterDaily] = {}
    for inv in invs:
        sn = inv.device_sn
        st = states[sn]
        mins: Dict[str, int] = defaultdict(int)
        lost: Dict[str, Optional[float]] = {}
        lost_on: Dict[str, Optional[float]] = {}  # on-peak part, keyed "down" / "no_data"

        def add_lost(cause: str, kwh: Optional[float], on_kwh: Optional[float] = None) -> None:
            key = "no_data" if cause == "no_data" else "down"
            if kwh is None:
                lost.setdefault(cause, None)
                lost_on.setdefault(key, None)
            else:
                lost[cause] = (lost.get(cause) or 0.0) + kwh
                lost_on[key] = (lost_on.get(key) or 0.0) + (on_kwh or 0.0)

        gap: List[datetime] = []

        def flush_gap() -> None:
            if gap:
                mins["no_data"] += len(gap) * SLOT_MIN
                g = _gap_lost(gap, eac_points.get(sn, []), kwp.get(sn), lambda t: peer_spec(t, sn), pr.is_on_peak)
                add_lost("no_data", *(g if g is not None else (None, None)))
                gap.clear()

        for slot in judged[sn]:
            s = st[slot]
            if s == "no_data":
                gap.append(slot)
                continue
            flush_gap()
            if s == "idle":
                if not any(states[o].get(slot) in ("producing", "limited") for o in states if o != sn):
                    continue  # nobody at the plant produces: dark, not downtime
                s = "off" if inv.on_off == 0 else "standby"
            mins[s] += SLOT_MIN
            if s in ("fault", "off", "standby"):
                spec = peer_spec(slot, sn)
                own = kwp.get(sn)
                kwh = spec * own * SLOT_H if spec is not None and own else None
                add_lost(s, kwh, kwh if kwh is not None and pr.is_on_peak(slot) else 0.0)
        flush_gap()

        pts = eac_points.get(sn, [])
        energy = pts[-1][1] if pts else (_integrate_kwh(pac_points[sn]) if pac_points.get(sn) else None)
        dc_kwh = _integrate_kwh(ppv_points[sn]) if ppv_points.get(sn) else None
        own = kwp.get(sn)
        yf_val = round(energy / own, 3) if energy is not None and own else None
        ya_val = round(dc_kwh / own, 3) if dc_kwh is not None and dc_kwh > 0 and own else None
        ya_minus_yf_val = (
            round((dc_kwh - energy) / own, 3)
            if dc_kwh is not None and energy is not None and own and dc_kwh >= energy
            else None
        )
        rows[sn] = GrowattInverterDaily(
            device_sn=sn,
            day=day,
            plant_id=plant.plant_id,
            daylight_min=len(judged[sn]) * SLOT_MIN,
            producing_min=mins["producing"],
            fault_min=mins["fault"],
            off_min=mins["off"],
            standby_min=mins["standby"],
            limited_min=mins["limited"],
            no_data_min=mins["no_data"],
            energy_kwh=round(energy, 3) if energy is not None else None,
            dc_energy_kwh=round(dc_kwh, 3) if dc_kwh is not None and dc_kwh > 0 else None,
            kwp=round(own, 2) if own else None,
            ya_kwh_kwp=ya_val,
            yf_kwh_kwp=yf_val,
            ya_minus_yf=ya_minus_yf_val,
            lost_fault_kwh_est=_r(lost.get("fault", 0.0)),
            lost_off_kwh_est=_r(lost.get("off", 0.0)),
            lost_standby_kwh_est=_r(lost.get("standby", 0.0)),
            lost_no_data_kwh_est=_r(lost.get("no_data", 0.0)),
            lost_down_on_peak_kwh_est=_r(lost_on.get("down", 0.0)),
            lost_no_data_on_peak_kwh_est=_r(lost_on.get("no_data", 0.0)),
        )
    total_kwp = sum(float(k) for k in kwp.values() if k) if all(kwp.values()) else None
    for sn, row in rows.items():
        others = [r.yf_kwh_kwp for o, r in rows.items() if o != sn and r.yf_kwh_kwp is not None]
        med = _median(others)
        if row.yf_kwh_kwp is not None and med:
            row.yf_vs_median_pct = round((row.yf_kwh_kwp / med - 1) * 100, 2)
        if total_kwp and kwp.get(sn):
            row.plant_kwp_share_pct = round(float(kwp[sn] or 0) / total_kwp * 100, 1)
        db.add(row)
    return len(rows)


def _plant_day(
    db: Session,
    plant: GrowattPlant,
    day: date,
    invs: Sequence[GrowattInverter],
    inv_slots: Dict[str, Dict[datetime, InvSlot]],
    eac_points: Dict[str, List[Tuple[datetime, float]]],
    ppv_points: Dict[str, List[Tuple[datetime, float]]],
    pac_points: Dict[str, List[Tuple[datetime, float]]],
    plant_kwp: Optional[float],
    system_factor: float = epi_fit.DEFAULT_SYSTEM_FACTOR,
) -> None:
    """Populate `GrowattPlantDaily` for `day`, applying POA 200–1200 W/m², stale-value, clipping,
    and curtailment masks before computing PR, PR', and EPI. `system_factor`: the plant's fitted
    model factor (services/epi_fit.py), else the default."""
    from app.services import fleet_settings, growatt_weather

    inv_energies: List[float] = []
    inv_dc_energies: List[float] = []
    for inv in invs:
        sn = inv.device_sn
        pts = eac_points.get(sn, [])
        e_ac = pts[-1][1] if pts else (_integrate_kwh(pac_points[sn]) if pac_points.get(sn) else None)
        if e_ac is not None:
            inv_energies.append(e_ac)
        if ppv_points.get(sn):
            e_dc = _integrate_kwh(ppv_points[sn])
            if e_dc > 0:
                inv_dc_energies.append(e_dc)

    energy_kwh = round(sum(inv_energies), 3) if inv_energies else None
    dc_energy_kwh = round(sum(inv_dc_energies), 3) if inv_dc_energies else None
    yf_kwh_kwp = round(energy_kwh / plant_kwp, 3) if energy_kwh is not None and plant_kwp else None
    ya_kwh_kwp = round(dc_energy_kwh / plant_kwp, 3) if dc_energy_kwh is not None and plant_kwp else None
    ya_minus_yf = (
        round((dc_energy_kwh - energy_kwh) / plant_kwp, 3)
        if dc_energy_kwh is not None and energy_kwh is not None and plant_kwp and dc_energy_kwh >= energy_kwh
        else None
    )

    weather = growatt_weather.build_weather_day(db, plant.plant_id, day, latest_if_none=False)
    wk = weather["kpis"]
    mod = fleet_settings.get_fleet_module(db)
    gamma_pct = float(mod.get("temp_coeff_pmax_pct") or growatt_weather.DEFAULT_GAMMA_PCT_PER_K)

    # Sum AC power per 5-min slot
    plant_pac_by_slot: Dict[datetime, float] = defaultdict(float)
    clipped_slots_set: Set[datetime] = set()
    curtailed_slots_set: Set[datetime] = set()
    for inv in invs:
        sn = inv.device_sn
        for slot, rec in inv_slots.get(sn, {}).items():
            if rec.pac_w > 0:
                plant_pac_by_slot[slot] += rec.pac_w
                if _clipped(inv, rec.pac_w):
                    clipped_slots_set.add(slot)
                if _limited(inv):
                    curtailed_slots_set.add(slot)

    producing_slots = [slot.strftime("%Y-%m-%d %H:%M:%S") for slot, p in sorted(plant_pac_by_slot.items()) if p > 0]
    pr_res = growatt_weather.iec_pr(energy_kwh, plant_kwp, weather, producing_slots, gamma_pct)

    stale_ts = growatt_weather._stale_timestamps(weather["series"], "irradiance_wm2")
    wx_by_slot: Dict[datetime, Dict[str, Any]] = {}
    for p in weather["series"]:
        try:
            wx_by_slot[datetime.strptime(p["timestamp"], "%Y-%m-%d %H:%M:%S")] = p
        except ValueError:
            continue

    valid_slots = 0
    meas_kw_sum = 0.0
    mod_kw_sum = 0.0
    fallback_tmod = wk.get("irradiance_weighted_module_temp_c") or wk.get("avg_module_temp_daylight_c")

    if plant_kwp and weather["has_sensor"]:
        for slot, wx in sorted(wx_by_slot.items()):
            ts_str = wx["timestamp"]
            g = wx.get("irradiance_wm2")
            if g is None or ts_str in stale_ts:
                continue
            if not (growatt_weather.POA_FILTER_MIN_WM2 <= g <= growatt_weather.POA_FILTER_MAX_WM2):
                continue
            if slot in clipped_slots_set or slot in curtailed_slots_set:
                continue
            pac_kw = plant_pac_by_slot.get(slot, 0.0) / 1000.0
            t_mod = wx.get("module_temp_c")
            if t_mod is None:
                t_mod = fallback_tmod  # the day's measured (irradiance-weighted) module temperature
            if t_mod is None:
                continue  # no module temperature measured at all: the slot cannot be modelled
            temp_factor = max(0.5, 1.0 + (gamma_pct / 100.0) * (float(t_mod) - 25.0))
            p_mod_kw = plant_kwp * (float(g) / 1000.0) * temp_factor * system_factor
            if p_mod_kw > 0:
                valid_slots += 1
                meas_kw_sum += pac_kw
                mod_kw_sum += p_mod_kw

    epi = round(meas_kw_sum / mod_kw_sum, 4) if valid_slots >= 6 and mod_kw_sum > 0 else None
    modelled_energy_kwh = round(mod_kw_sum * SLOT_H, 3) if valid_slots >= 6 and mod_kw_sum > 0 else None
    sensor = _sensor_evidence(db, plant, day, wx_by_slot, stale_ts)

    db.add(
        GrowattPlantDaily(
            plant_id=plant.plant_id,
            day=day,
            capacity_kwp=round(plant_kwp, 2) if plant_kwp else None,
            energy_kwh=energy_kwh,
            dc_energy_kwh=dc_energy_kwh,
            modelled_energy_kwh=modelled_energy_kwh,
            yr_h=wk.get("insolation_kwh_m2"),
            ya_kwh_kwp=ya_kwh_kwp,
            yf_kwh_kwp=yf_kwh_kwp,
            ya_minus_yf=ya_minus_yf,
            pr_pct=pr_res.get("pr_pct"),
            pr_temp_corrected_pct=pr_res.get("pr_temp_corrected_pct"),
            epi=epi,
            system_factor=system_factor if epi is not None else None,
            irradiance_weighted_tmod_c=wk.get("irradiance_weighted_module_temp_c"),
            filtered_slots=valid_slots,
            stale_masked_slots=len(stale_ts),
            clipped_masked_slots=len(clipped_slots_set),
            curtailed_masked_slots=len(curtailed_slots_set),
            **sensor,
        )
    )


def _sensor_evidence(
    db: Session, plant: GrowattPlant, day: date, wx_by_slot: Dict[datetime, Dict[str, Any]], stale_ts: Set[str]
) -> Dict[str, Any]:
    """R16 evidence from the plant's irradiance series (the one PR and EPI use). Counts and
    values only; `growatt_rules.sensor_verdict` judges them. All null without irradiance."""
    irr = {t: float(p["irradiance_wm2"]) for t, p in wx_by_slot.items() if p.get("irradiance_wm2") is not None}
    out: Dict[str, Any] = {
        "sensor_stale_slots": None, "sensor_high_slots": None, "sensor_midday_wm2": None,
        "sensor_midday_slots": None, "cloud_midday_pct": None,
    }
    if not irr:
        return out
    lat = float(plant.latitude) if plant.latitude is not None else None
    lon = float(plant.longitude) if plant.longitude is not None else None

    def cs(t: datetime) -> Optional[float]:
        if lat is None or lon is None:
            return None
        return clear_sky_ghi(day, lat, lon, t.hour * 60 + t.minute + SLOT_MIN / 2.0, UTC_OFFSET_H)

    lo_h, hi_h = SENSOR_MIDDAY
    stale = high = 0
    for t, g in irr.items():
        c = cs(t)
        daylight = c >= SENSOR_STALE_MIN_WM2 if c is not None else lo_h - 3 <= t.hour < hi_h + 3
        if daylight and t.strftime("%Y-%m-%d %H:%M:%S") in stale_ts:
            stale += 1
        if c is not None and c >= SENSOR_CLEAR_SKY_MIN_WM2 and g > SENSOR_CLEAR_SKY_FACTOR * c:
            high += 1
    out["sensor_stale_slots"] = stale
    out["sensor_high_slots"] = high if lat is not None and lon is not None else None
    mid = [g for t, g in irr.items() if lo_h <= t.hour < hi_h]
    out["sensor_midday_slots"] = len(mid)
    if len(mid) >= SENSOR_MIDDAY_MIN_SLOTS:
        out["sensor_midday_wm2"] = round(statistics.mean(mid), 1)
    if lat is not None and lon is not None:
        from app.services.google_weather import cell_of

        key = cell_of(lat, lon)[0]
        G = GoogleWeatherHourly
        start = datetime.combine(day, datetime.min.time())
        clouds: List[float] = [
            float(c) for c in db.scalars(
                select(G.cloud_cover_pct).where(
                    G.cell_key == key, G.hour >= start + timedelta(hours=lo_h), G.hour < start + timedelta(hours=hi_h),
                    G.cloud_cover_pct.is_not(None),
                )
            )
            if c is not None
        ]
        if len(clouds) >= CLOUD_MIN_HOURS:
            out["cloud_midday_pct"] = round(statistics.mean(clouds), 1)
    return out


def _km(a: Tuple[float, float], b: Tuple[float, float]) -> float:
    la1, lo1, la2, lo2 = map(math.radians, (a[0], a[1], b[0], b[1]))
    h = math.sin((la2 - la1) / 2) ** 2 + math.cos(la1) * math.cos(la2) * math.sin((lo2 - lo1) / 2) ** 2
    return 2 * 6371.0 * math.asin(math.sqrt(h))


def sensor_neighbours(db: Session, day: date) -> int:
    """Each plant's midday irradiance ÷ the median of the other plants' within NEIGHBOUR_KM
    (R16's stand-in for a satellite reference). Fleet-wide, after every plant's row of the day
    exists; null with fewer than NEIGHBOUR_MIN neighbours. Returns the rows given a ratio."""
    PD = GrowattPlantDaily
    rows = list(db.scalars(select(PD).where(PD.day == day)))
    coords = {
        int(p): (float(la), float(lo))
        for p, la, lo in db.execute(select(GrowattPlant.plant_id, GrowattPlant.latitude, GrowattPlant.longitude))
        if la is not None and lo is not None and not (la == 0 and lo == 0)
    }
    have = [(r, coords[r.plant_id]) for r in rows if r.sensor_midday_wm2 is not None and r.plant_id in coords]
    n = 0
    for r in rows:
        r.sensor_neighbour_ratio = None
        r.sensor_neighbours = None
        here = coords.get(r.plant_id)
        if r.sensor_midday_wm2 is None or here is None:
            continue
        near = [o.sensor_midday_wm2 for o, at in have if o.plant_id != r.plant_id and _km(here, at) <= NEIGHBOUR_KM]
        vals = [float(v) for v in near if v is not None]
        r.sensor_neighbours = len(vals)
        med = statistics.median(vals) if len(vals) >= NEIGHBOUR_MIN else None
        if med and med > 0:
            r.sensor_neighbour_ratio = round(float(r.sensor_midday_wm2) / med, 3)
            n += 1
    db.commit()
    return n


def _r(v: Optional[float]) -> Optional[float]:
    return None if v is None else round(v, 3)


def _gap_lost(
    gap: List[datetime], eac: List[Tuple[datetime, float]], own_kwp: Optional[float], spec_at: Any,
    on_peak: Any = lambda _t: False,
) -> Optional[Tuple[float, float]]:
    """Energy a run of no-data slots lost: what the other inverters' specific yield says it should
    have made, minus what its `eac_today` counter shows arrived across the gap anyway (records
    are often uploaded late, not lost). Returns (lost, on-peak part, split like the expected
    energy), or None when it cannot be judged."""
    if not own_kwp:
        return None
    specs = [spec_at(t) for t in gap]
    if any(s is None for s in specs):
        return None
    expected = sum(float(s) for s in specs) * own_kwp * SLOT_H
    before = [v for ts, v in eac if ts < gap[0]]
    after = [v for ts, v in eac if ts >= gap[-1] + timedelta(minutes=SLOT_MIN)]
    if not after:
        return None  # nothing after the gap that day: unknown
    arrived = after[0] - (before[-1] if before else 0.0)
    lost = max(0.0, expected - max(0.0, arrived))
    on_share = sum(float(s) for t, s in zip(gap, specs) if on_peak(t)) * own_kwp * SLOT_H / expected if expected > 0 else 0.0
    return lost, lost * on_share


# --------------------------------------------------------------------------- fleet


def compute_day(db: Session, day: date, plant_ids: Optional[Sequence[int]] = None) -> Dict[str, Any]:
    """Recompute every plant's daily rows for `day` (one commit per plant)."""
    q = select(GrowattPlant).order_by(GrowattPlant.plant_id)
    if plant_ids is not None:
        q = q.where(GrowattPlant.plant_id.in_(list(plant_ids)))
    lo, hi = _day_bounds(day)
    until = db.scalar(select(func.max(R.timestamp)).where(R.timestamp >= lo, R.timestamp < hi))
    until = until if until is not None and until < hi - timedelta(hours=1) else None
    totals: Dict[str, Any] = {"day": day.isoformat(), "plants": 0, "strings": 0, "inverters": 0, "failed": []}
    if until is not None:
        totals["until"] = until.isoformat()
    pr = load_pricer(db)
    for plant in list(db.scalars(q)):
        try:
            n = compute_plant_day(db, plant, day, until, pr)
            db.commit()
        except Exception as exc:  # one bad plant must not stop the fleet
            db.rollback()
            log.exception("daily stats failed for plant %s %s", plant.plant_id, day)
            totals["failed"].append({"plant_id": plant.plant_id, "error": f"{type(exc).__name__}: {exc}"})
            continue
        totals["plants"] += 1
        totals["strings"] += n["strings"]
        totals["inverters"] += n["inverters"]
    try:
        totals["sensor_neighbours"] = sensor_neighbours(db, day)
    except Exception:  # evidence only: never fail the day's rows over it
        db.rollback()
        log.exception("sensor neighbour ratios failed for %s", day)
    return totals


def stored_days(db: Session) -> Tuple[Optional[date], Optional[date]]:
    """First and last day with stored inverter readings."""
    lo, hi = db.execute(select(func.min(R.timestamp), func.max(R.timestamp))).one()
    return (lo.date() if lo else None, hi.date() if hi else None)


def backfill(db: Session, end: date, start: Optional[date] = None) -> Dict[str, Any]:
    """Daily rows for every day from `start` (default: the oldest stored reading) through `end`,
    oldest first, so each day's wired-string lookback sees the days before it."""
    first, _ = stored_days(db)
    start = start or first
    out: Dict[str, Any] = {"days": 0, "strings": 0, "inverters": 0, "failed": []}
    if start is None:
        return out
    d = start
    while d <= end:
        r = compute_day(db, d)
        out["days"] += 1
        out["strings"] += r["strings"]
        out["inverters"] += r["inverters"]
        out["failed"] += r["failed"]
        log.info("daily stats %s: %d strings, %d inverters", d, r["strings"], r["inverters"])
        d += timedelta(days=1)
    out["start"], out["end"] = start.isoformat(), end.isoformat()
    return out


def main(argv: Optional[List[str]] = None) -> int:
    from app.db.session import SessionLocal, engine, ensure_schema
    from app.logging_db import setup_logging
    from app.services.jobs import _today

    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--day", type=date.fromisoformat, help="one day (default yesterday)")
    p.add_argument("--backfill", action="store_true", help="every stored day through yesterday")
    p.add_argument("--plant", type=int, action="append", help="only this plant (repeatable)")
    a = p.parse_args(argv)
    setup_logging("cli")
    ensure_schema(engine)
    with SessionLocal() as db:
        if a.backfill:
            print(backfill(db, _today() - timedelta(days=1)))
        else:
            print(compute_day(db, a.day or _today() - timedelta(days=1), a.plant))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
