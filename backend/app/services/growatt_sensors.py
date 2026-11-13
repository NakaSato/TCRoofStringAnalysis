"""Fleet list of Growatt weather sensors from the registry and stored history (DB only).

Online state (`lost`, last upload) is realtime and never stored, so this list carries only what
SQL knows: identity, the newest stored reading, which probes report, and today's coverage. A
sensor's live status is `unknown` here; the live sweep (`/growatt/live/sensors/status`) sets it.

Health flags are checks, not measurements, each with a reason text, and none is raised without
stored data to support it:

- `probe_missing` (DB): a probe that reported in the last 7 days reads 0 all of today's daylight.
- `irradiance_zero_daylight` (DB): irradiance 0 for >= 1 h between 10:00 and 15:00 while the
  plant's inverters produced power.
- `stale_history` (live overlay): the sensor is online but stored history is > 2 h behind its
  last upload (a sync problem, not a sensor fault).
"""

from __future__ import annotations

from datetime import date, datetime, time, timedelta
from typing import Any, Callable, Dict, List, Optional, Set, Tuple

from sqlalchemy import and_, select
from sqlalchemy.orm import Session

from app.config import settings
from app.db.models import GrowattEnvReading, GrowattEnvSensor, GrowattInverter, GrowattInverterReading, GrowattPlant, SyncRun
from app.services import growatt_weather as wx
from app.services.jobs import PLANT_TZ, _aware

E = GrowattEnvReading
S = GrowattEnvSensor

# Daylight window over which coverage is counted (plant-local, end exclusive)
COVERAGE_START_H, COVERAGE_END_H = 6, 18
SLOT_MIN = 5
MEASURED_LOOKBACK = timedelta(days=7)
# jobs whose finished runs mean "today's env history fetched up to the run's start"; `backfill`
# re-reads only the two previous days, so it says nothing about today
ENV_SYNC_JOBS = ("history",)

# Health flags (plant-local hours, end exclusive)
# Probes that never read exactly 0 by day in Thailand when working. Wind is left out: a calm
# morning reads 0 m/s (and direction 0 = north), so an all-zero day proves nothing.
PROBE_FIELDS = ("irradiance_wm2", "module_temp_c", "ambient_temp_c", "humidity_pct")
PROBE_MIDDAY_H = (9, 15)  # all-zero only counts with readings over this part of the day ...
PROBE_MIN_SLOTS = 24  # ... in at least this many 5-min slots (2 h)
ZERO_IRR_H = (10, 15)
ZERO_IRR_MIN_SLOTS = 12  # 1 h of 5-min slots
STALE_HISTORY = timedelta(hours=2)
FIELD_LABEL = {
    "irradiance_wm2": "Irradiance",
    "module_temp_c": "Module temperature",
    "ambient_temp_c": "Ambient temperature",
    "humidity_pct": "Humidity",
}


def _key(dl: str, addr: int) -> str:
    return f"{dl}:{addr}"


def _fmt(ts: Optional[datetime]) -> Optional[str]:
    return ts.strftime("%Y-%m-%d %H:%M:%S") if ts else None


def _slot(ts: datetime) -> datetime:
    return ts.replace(minute=ts.minute - ts.minute % SLOT_MIN, second=0, microsecond=0)


def last_env_sync(db: Session) -> Optional[datetime]:
    """Start (UTC) of the newest finished `history` run: today's env history is in SQL up to then."""
    ts = db.scalar(
        select(SyncRun.started_at)
        .where(SyncRun.job.in_(ENV_SYNC_JOBS), SyncRun.status.in_(("ok", "partial")))
        .order_by(SyncRun.started_at.desc())
        .limit(1)
    )
    return _aware(ts)


def coverage_until(day: date, now_local: datetime, synced_utc: Optional[datetime]) -> Optional[datetime]:
    """End (plant-local, exclusive) of the slots of `day` that can be judged: inside the daylight
    window, already over, and already fetched by a sync run. None = nothing to judge yet."""
    start = datetime.combine(day, time(COVERAGE_START_H))
    end = datetime.combine(day, time(COVERAGE_END_H))
    cap = min(end, now_local)
    if synced_utc is None:
        return None
    cap = min(cap, synced_utc.astimezone(PLANT_TZ).replace(tzinfo=None))
    cap = _slot(cap)  # the slot in progress at `cap` is not complete
    return cap if cap > start else None


def sensor_status(last_reading_at: Optional[datetime]) -> str:
    """Status from stored data alone: `not_synced` without any stored reading, else `unknown`
    (online / late / offline need the live sweep)."""
    return "not_synced" if last_reading_at is None else "unknown"


def live_status(
    lost: Optional[bool],
    last_update: Optional[str],
    now_local: datetime,
    late_min: float,
    offline_min: float,
) -> str:
    """Status from Growatt's live `env_list` entry: `offline` when Growatt says lost or the last
    upload is older than `offline_min`, `late` past `late_min`, else `online`. No usable upload
    time and not lost = `unknown` (never guessed)."""
    if lost:
        return "offline"
    try:
        at = datetime.strptime(last_update or "", "%Y-%m-%d %H:%M:%S")
    except ValueError:
        return "unknown"
    age_min = (now_local - at).total_seconds() / 60.0
    return "online" if age_min <= late_min else "late" if age_min <= offline_min else "offline"


def _hm(ts: datetime) -> str:
    return ts.strftime("%H:%M")


def _span(minutes: int) -> str:
    return f"{minutes} min" if minutes < 60 else f"{minutes // 60} h {minutes % 60:02d} min"


def probe_flags(
    values: Dict[str, Dict[datetime, List[float]]],
    measured: Optional[List[str]],
    day_label: str = "today",
) -> List[Dict[str, Any]]:
    """`probe_missing` per probe that reported in the last 7 days (`measured`) but read 0 in every
    stored reading of today's daylight. `values[field][slot]` = today's non-null readings in that
    5-min slot. Needs readings in >= `PROBE_MIN_SLOTS` midday slots; fewer = no judgement."""
    out: List[Dict[str, Any]] = []
    lo, hi = PROBE_MIDDAY_H
    for f in PROBE_FIELDS:
        if not measured or f not in measured:
            continue  # not fitted (or unknown): 0 is expected, not a fault
        slots = values.get(f, {})
        midday = [t for t in slots if lo <= t.hour < hi]
        if len(midday) < PROBE_MIN_SLOTS or any(v != 0 for vs in slots.values() for v in vs):
            continue
        first, last = min(slots), max(slots)
        out.append(
            {
                "code": "probe_missing",
                "field": f,
                "reason": (
                    f"{FIELD_LABEL[f]} read 0 in all {len(slots)} stored slots {day_label} "
                    f"({_hm(first)}–{_hm(last + timedelta(minutes=SLOT_MIN))}) but reported in the last 7 days: "
                    "probe fault or disconnected"
                ),
            }
        )
    return out


def irradiance_zero_flag(
    irr: Dict[datetime, List[float]],
    measured: Optional[List[str]],
    producing: Set[datetime],
) -> Optional[Dict[str, Any]]:
    """`irradiance_zero_daylight` when, between 10:00 and 15:00, irradiance read 0 in >= 1 h of
    5-min slots in which the plant's inverters produced power (stored readings, pac > 0)."""
    if not measured or "irradiance_wm2" not in measured:
        return None
    lo, hi = ZERO_IRR_H
    zero = sorted(t for t, vs in irr.items() if lo <= t.hour < hi and vs and all(v == 0 for v in vs) and t in producing)
    if len(zero) < ZERO_IRR_MIN_SLOTS:
        return None
    return {
        "code": "irradiance_zero_daylight",
        "field": "irradiance_wm2",
        "reason": (
            f"Irradiance read 0 W/m² for {_span(len(zero) * SLOT_MIN)} between {lo:02d}:00 and {hi:02d}:00 "
            f"({_hm(zero[0])}–{_hm(zero[-1] + timedelta(minutes=SLOT_MIN))}) while the plant's inverters produced power: "
            "shaded, dirty or faulty irradiance probe"
        ),
    }


def stale_history_flag(
    status: str, last_update: Optional[str], synced_until: Optional[datetime]
) -> Optional[Dict[str, Any]]:
    """`stale_history` when the sensor is online but its stored history ends more than 2 h
    before its last upload to Growatt. Nothing stored yet = no flag (status says `not_synced`)."""
    if status != "online" or synced_until is None:
        return None
    try:
        at = datetime.strptime(last_update or "", "%Y-%m-%d %H:%M:%S")
    except ValueError:
        return None
    behind = at - synced_until
    if behind <= STALE_HISTORY:
        return None
    return {
        "code": "stale_history",
        "reason": (
            f"Online (last upload {at:%H:%M}) but stored readings end at {synced_until:%Y-%m-%d %H:%M}, "
            f"{_span(int(behind.total_seconds() // 60))} behind: history sync problem, not a sensor fault"
        ),
    }


def producing_slots(db: Session, plant_ids: List[int], day: date) -> Dict[int, Set[datetime]]:
    """5-min slots of `day` (10:00–15:00) in which any of each plant's inverters stored pac > 0."""
    if not plant_ids:
        return {}
    lo, hi = ZERO_IRR_H
    R = GrowattInverterReading
    q = (
        select(GrowattInverter.plant_id, R.timestamp)
        .join(GrowattInverter, GrowattInverter.device_sn == R.device_sn)
        .where(
            GrowattInverter.plant_id.in_(plant_ids),
            R.timestamp >= datetime.combine(day, time(lo)),
            R.timestamp < datetime.combine(day, time(hi)),
            R.pac_w > 0,
        )
    )
    out: Dict[int, Set[datetime]] = {}
    for pid, ts in db.execute(q):
        out.setdefault(pid, set()).add(_slot(ts))
    return out


VisibleSensor = Tuple[str, int, Optional[int], Optional[datetime]]


def visible_sensors(db: Session, allowed: Optional[Set[int]]) -> List[VisibleSensor]:
    """(datalogger_sn, address, plant phase, history_synced_until) of every registered sensor the
    user may see."""
    q = select(S.datalogger_sn, S.address, GrowattPlant.phase, S.history_synced_until).join(
        GrowattPlant, GrowattPlant.plant_id == S.plant_id
    )
    if allowed is not None:
        q = q.where(S.plant_id.in_(list(allowed) or [-1]))
    return [(dl, addr, ph, su) for dl, addr, ph, su in db.execute(q.order_by(S.datalogger_sn, S.address))]


def live_row(
    dl: str,
    addr: int,
    entry: Optional[Dict[str, Any]],
    now_local: datetime,
    late_min: float,
    offline_min: float,
    synced_until: Optional[datetime] = None,
) -> Dict[str, Any]:
    """One sensor's live state from its datalogger's cached `env_list` entry (None = not checked).
    `flags` holds the checks that need the live state (`stale_history`, from `synced_until`)."""
    hit = next((e for e in entry["sensors"] if e["address"] == addr), None) if entry else None
    status = live_status(hit["lost"], hit["last_update_time"], now_local, late_min, offline_min) if hit else "unknown"
    stale = stale_history_flag(status, hit["last_update_time"], synced_until) if hit else None
    return {
        "key": _key(dl, addr),
        "status": status,
        "lost": hit["lost"] if hit else None,
        "last_update_time": hit["last_update_time"] if hit else None,  # plant-local
        "checked_at": entry["fetched_at"] if entry else None,
        "stale": entry["stale"] if entry else None,
        "listed": hit is not None if entry else None,  # False = env_list no longer lists it
        "flags": [stale] if stale else [],
    }


def find_sensor(db: Session, dl: str, addr: int, allowed: Optional[Set[int]]) -> Optional[Tuple[GrowattEnvSensor, Optional[int]]]:
    """The registered sensor and its plant's phase, or None when unknown or its plant is not visible."""
    row = db.execute(
        select(S, GrowattPlant.phase)
        .join(GrowattPlant, GrowattPlant.plant_id == S.plant_id)
        .where(S.datalogger_sn == dl, S.address == addr)
    ).first()
    if row is None or (allowed is not None and row[0].plant_id not in allowed):
        return None
    return row[0], row[1]


def measured_for(db: Session, s: GrowattEnvSensor, now_local: datetime) -> Optional[List[str]]:
    """Probes the sensor reported in the last 7 days; None = no stored reading then (unknown)."""
    return wx.measured_by_sensor(db, now_local - MEASURED_LOOKBACK, [s.plant_id]).get((s.datalogger_sn, s.address))


def overlay_live_status(
    env: Dict[str, Any],
    sensors: List[VisibleSensor],
    now_local: datetime,
    late_min: float,
    offline_min: float,
) -> Dict[str, Any]:
    """Per-sensor live status from a `sensor_status` envelope. Status is judged now, so a
    cached `env_list` entry still turns late / offline as its upload ages. A datalogger not
    checked yet, or a sensor its `env_list` does not list, is `unknown`."""
    dls = env["data"]["dataloggers"]
    rows = [live_row(dl, addr, dls.get(dl), now_local, late_min, offline_min, su) for dl, addr, _ph, su in sensors]
    data = env["data"]
    return {
        **env,
        "data": {
            "sensors": rows,
            "errors": data["errors"],
            "sweep": data["sweep"],
            "thresholds": {"late_min": late_min, "offline_min": offline_min},
        },
    }


def list_sensors(
    db: Session,
    allowed: Optional[Set[int]],
    now_local: Optional[Callable[[], datetime]] = None,
    day: Optional[date] = None,
) -> Dict[str, Any]:
    """Every registered weather sensor of the plants the user may see (`allowed` None = all).

    `day` (default today, plant-local) is the day coverage and the stored-data flags are judged
    on; for a past day the whole 06:00–18:00 window counts (`coverage_pct`), and probes count as
    measured from the 7 days before that day's end. The newest stored reading is always the
    newest, whatever the day."""
    now = (now_local or (lambda: datetime.now(PLANT_TZ).replace(tzinfo=None)))()
    real_today = now.date()
    today = day or real_today
    is_today = today == real_today
    day_end = min(now, datetime.combine(today + timedelta(days=1), time()))

    q = (
        select(S, GrowattPlant.name, GrowattPlant.phase)
        .join(GrowattPlant, GrowattPlant.plant_id == S.plant_id)
        .order_by(GrowattPlant.name, S.datalogger_sn, S.address)
    )
    plant_filter = None
    if allowed is not None:
        plant_filter = list(allowed) or [-1]
        q = q.where(S.plant_id.in_(plant_filter))
    rows: List[Tuple[GrowattEnvSensor, str, Optional[int]]] = [tuple(r) for r in db.execute(q).all()]  # type: ignore[misc]

    # newest stored reading: `history_synced_until` is the stored max, so an exact key lookup
    last_q = select(E).join(
        S, and_(S.datalogger_sn == E.datalogger_sn, S.address == E.address, S.history_synced_until == E.timestamp)
    )
    if plant_filter is not None:
        last_q = last_q.where(S.plant_id.in_(plant_filter))
    last: Dict[Tuple[str, int], GrowattEnvReading] = {(r.datalogger_sn, r.address): r for r in db.scalars(last_q)}

    measured = wx.measured_by_sensor(db, now - MEASURED_LOOKBACK, plant_filter)
    # flags judge a past day by the probes reporting in the week up to that day, not later
    measured_then = measured if is_today else wx.measured_by_sensor(db, day_end - MEASURED_LOOKBACK, plant_filter, until=day_end)

    synced = last_env_sync(db)
    until = coverage_until(today, now, synced)
    start = datetime.combine(today, time(COVERAGE_START_H))
    expected = int((until - start).total_seconds() // (SLOT_MIN * 60)) if until is not None else 0
    # today's daylight readings: coverage (slots before `until`) and the health flags (all stored)
    seen: Dict[Tuple[str, int], Set[datetime]] = {}
    values: Dict[Tuple[str, int], Dict[str, Dict[datetime, List[float]]]] = {}
    day_q = (
        select(E.datalogger_sn, E.address, E.timestamp, *(getattr(E, f) for f in PROBE_FIELDS))
        .join(S, and_(S.datalogger_sn == E.datalogger_sn, S.address == E.address))
        .where(E.timestamp >= start, E.timestamp < datetime.combine(today, time(COVERAGE_END_H)))
    )
    if plant_filter is not None:
        day_q = day_q.where(S.plant_id.in_(plant_filter))
    for dl, addr, ts, *vals in db.execute(day_q):
        slot = _slot(ts)  # mixed intervals: one count per 5-min slot
        if until is not None and ts < until:
            seen.setdefault((dl, addr), set()).add(slot)
        per = values.setdefault((dl, addr), {})
        for f, v in zip(PROBE_FIELDS, vals):
            if v is not None:
                per.setdefault(f, {}).setdefault(slot, []).append(float(v))

    # zero-irradiance candidates first, so inverter readings are read only for their plants
    zero_irr_plants = sorted(
        {
            s.plant_id
            for s, _n, _p in rows
            if sum(
                1
                for t, vs in values.get((s.datalogger_sn, s.address), {}).get("irradiance_wm2", {}).items()
                if ZERO_IRR_H[0] <= t.hour < ZERO_IRR_H[1] and all(v == 0 for v in vs)
            )
            >= ZERO_IRR_MIN_SLOTS
        }
    )
    producing = producing_slots(db, zero_irr_plants, today)

    sensors: List[Dict[str, Any]] = []
    for s, plant_name, phase in rows:
        k = (s.datalogger_sn, s.address)
        fields = measured.get(k)
        rec = last.get(k)
        last_at = s.history_synced_until
        vals = values.get(k, {})
        cov = round(100.0 * len(seen.get(k, ())) / expected, 1) if expected else None
        then = measured_then.get(k)
        flags = probe_flags(vals, then, "today" if is_today else f"on {today.isoformat()}")
        if not any(fl["field"] == "irradiance_wm2" for fl in flags):  # all-day zero already says it
            zf = irradiance_zero_flag(vals.get("irradiance_wm2", {}), then, producing.get(s.plant_id, set()))
            if zf:
                flags.append(zf)
        sensors.append(
            {
                "key": _key(*k),
                "datalogger_sn": s.datalogger_sn,
                "address": s.address,
                "device_name": s.device_name,
                "plant_id": s.plant_id,
                "plant_name": plant_name,
                "phase": phase,
                "status": sensor_status(last_at),
                "last_reading_at": _fmt(last_at),
                # null = no stored reading in the last 7 days: which probes report is unknown
                "measured": fields,
                # probes that read only 0 for the week were not measured: null, never 0
                "last": (
                    None
                    if rec is None
                    else {f: (getattr(rec, f) if fields is None or f in fields else None) for f in wx.FIELDS}
                ),
                # share of `meta.day`'s judged daylight slots with a stored reading
                "coverage_pct": cov,
                "coverage_today_pct": cov if is_today else None,
                "flags": flags,
            }
        )
    return {
        "meta": {
            "source": "db",
            "day": today.isoformat(),
            "coverage_window": {"start": f"{COVERAGE_START_H:02d}:00", "until": until.strftime("%H:%M") if until else None},
            "synced_at": synced.isoformat() if synced else None,
            "is_today": is_today,
            # Active Alarm, past day: below this stored coverage a sensor counts as a data gap
            "alarm_coverage_pct": settings.sensor_alarm_coverage_pct,
        },
        "sensors": sensors,
    }
