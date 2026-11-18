"""PWA report check slots: the one definition of what check "09" / "13" / "17" shows.

A check is a snapshot taken CHECK_OFFSET_MIN (10) minutes before its hour: check "09" is the
plant at 08:50, so it can be published at 08:50 and be in the Monitoring PWA Report sheet by
09:00. From stored, source-timestamped history only (never realtime values):

- inverters: each inverter's latest reading in [slot − 15 min, slot] (08:35–08:50). None there
  = `offline`; Growatt status 3 = `fault`. `kw` = the sum of those readings' `pac_w`
  (instantaneous AC power), null when no inverter reported.
- Every alarm field takes only the alarm-log records of the check's look-back: hh:00 −
  PWA_FAULT_LOOKBACK_MIN (60) to the slot time, 08:00–08:50 (`_active` with `since`). A record
  last reported before 08:00 is in none of them.
- `alarms`: "<INV> <message>" for the alarm-log entries of the look-back.
- `errors`: the plant's Fault Error log of the look-back: every such entry with Growatt
  `fault_type` "Error" (not "Warning"), once per inverter + message ("(×3)" when it recurred).
  Growatt's placeholder "undown error" is shown as "Error <code>", the code as reported.
- `issues`: the sheet's DATA LOG, one entry per inverter with something wrong at the check, in
  INV order: {"inv": "INV3", "state": "Offline" | "Fault" | "Alarm", "items": [{"code",
  "message", "since", "count"}]}. Fault = status 3 at its reading; Alarm = not in fault, but an
  alarm in the check's fault look-back. `items` are the inverter's alarm-log entries of the
  look-back only: hh:00 − PWA_FAULT_LOOKBACK_MIN (60: 08:00) to the slot time (`_active`). A
  fault that cleared a few minutes before the snapshot is reported, one last reported before
  08:00 is not, each with its code and its name in Growatt's own wording ("undown error" is
  the name Growatt gives a code it has no text for; it is shown as reported, never replaced). `since` ("08:39") = the first time in the look-back the log reported the same
  alarm (same kind, code and text; an alarm still open from earlier keeps its start time) and
  `count` = how many times it reported it in the look-back.
  When the log has none, the reading's own `fault_code` / `warn_code` (max_data `faultType` /
  `warnCode`; a `warn_code` in PWA_IGNORE_WARN_CODES (1) is not reported),
  `warnCode`), with the log's text for that code when it has one that day (no `since` /
  `count`). No source = no items ("INV3 Fault"); nothing is made up. An Offline entry has
  `last`: the time ("07:40") of the inverter's latest stored reading that day before the
  check's window, None when it has none that day.
- sensor: each of the plant's weather sensors' latest irradiance reading in the same window,
  averaged over the sensors (`irradiance_wm2`, `sensor_at`).
- `google`: Google Maps Weather (modelled), the sheet's สภาพอากาศ. A slot of today frozen at its
  publish takes Google's current conditions at the slot time (`google_weather.slot_current`,
  `source: "current"`); otherwise the stored hour that contains the slot time (08:00 for 08:50,
  `source: "hourly"`), when stored (Google's hours are fetched at 18:15).
  A slot frozen with no Google weather (the call failed, quota, call budget) takes the stored
  hour at a later publish, once it is stored: the only field of a frozen slot filled afterwards.

Ready and frozen: a slot of today is built only once its time has passed and a `history` run
that started at or after the pre-check pull (slot − PWA_HISTORY_LEAD_MIN) has finished; a past
day's slot is always buildable. The first build is stored in `pwa_check_slots` and every later
build (later publishes the same day, 19:30, yesterday's 06:00 / 18:15 re-publishes, the
worker's sheet fill) reuses it, so a slot the sheet has shown never changes.

Inverters named as replaced in Growatt ("INV 1 old") are left out (daily_checks.is_replaced).
"""

from __future__ import annotations

from datetime import date, datetime, time, timedelta, timezone
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple
from zoneinfo import ZoneInfo

from sqlalchemy import and_, func, or_, select
from sqlalchemy.orm import Session

from app.config import settings
from app.db.models import (
    GoogleWeatherHourly,
    GrowattAlarm,
    GrowattAlarmSync,
    GrowattEnvReading,
    GrowattEnvSensor,
    GrowattInverter,
    GrowattInverterReading,
    GrowattPlant,
    PwaCheckSlot,
    SyncRun,
)

PLANT_TZ = ZoneInfo("Asia/Bangkok")
CHECK_HOURS = (9, 13, 17)
WINDOW = timedelta(minutes=15)  # a slot takes the latest reading in [slot − WINDOW, slot]
FAULT_STATUS = 3  # Growatt MAX inverter status: 0 waiting, 1 normal, 3 fault
# Growatt's name for a code it has no text for (one name, many codes)
SKIP_ALARMS = {"undown error"}
READY_HISTORY = ("ok", "partial")  # a `history` run in these states counts for readiness
PULL_SLACK = timedelta(minutes=1)  # the worker starts a scheduled job within its 60 s tick
# Growatt re-reports an alarm that is still present every ~5 min, each record with end = start:
# one reported within this of the reference time is still active (growatt_alarms.ONGOING_GAP)
ONGOING_GAP = timedelta(minutes=10)


def hh(hour: int) -> str:
    return f"{hour:02d}"


def offset() -> timedelta:
    return timedelta(minutes=settings.check_offset_min)


def slot_time(day: date, hour: int) -> datetime:
    """Naive plant-local snapshot time of check `hour` on `day` (08:50 for 9)."""
    return datetime.combine(day, time(hour)) - offset()


def clock(hour: int, minus: timedelta = timedelta(0)) -> time:
    """Wall-clock time of check `hour`'s slot (minus `minus`), for the worker schedule."""
    return (datetime.combine(date(2000, 1, 1), time(hour)) - offset() - minus).time()


def publish_clock(hour: int) -> time:
    return clock(hour)


def history_clock(hour: int) -> time:
    return clock(hour, timedelta(minutes=settings.pwa_history_lead_min))


# --------------------------------------------------------------------------- readiness


def history_covers(db: Session, day: date, hour: int) -> bool:
    """A `history` run that started at the pre-check pull or later has finished (ok / partial)."""
    since_local = slot_time(day, hour) - timedelta(minutes=settings.pwa_history_lead_min) - PULL_SLACK
    since = since_local.replace(tzinfo=PLANT_TZ).astimezone(timezone.utc)
    return (
        db.scalar(
            select(SyncRun.id)
            .where(
                SyncRun.job == "history",
                SyncRun.status.in_(READY_HISTORY),
                SyncRun.finished_at.is_not(None),
                SyncRun.started_at >= since,
            )
            .limit(1)
        )
        is not None
    )


def slot_ready(db: Session, day: date, hour: int, now_local: datetime) -> bool:
    """Whether check `hour` of `day` may be built now (`now_local`: naive plant-local)."""
    if now_local < slot_time(day, hour):
        return False
    if day < now_local.date():
        return True
    return history_covers(db, day, hour)


def ready_hours(db: Session, day: date, now_local: datetime) -> List[int]:
    return [h for h in CHECK_HOURS if slot_ready(db, day, h, now_local)]


def now_local() -> datetime:
    return datetime.now(PLANT_TZ).replace(tzinfo=None)


# --------------------------------------------------------------------------- one slot


def is_replaced(inv: GrowattInverter) -> bool:
    from app.services.daily_checks import is_replaced as _replaced

    return _replaced(inv)


def _labels(db: Session, plant_id: int) -> Dict[str, str]:
    from app.services.daily_checks import inverter_label

    invs = [i for i in db.scalars(select(GrowattInverter).where(GrowattInverter.plant_id == plant_id)) if not is_replaced(i)]
    return {i.device_sn: inverter_label(i, sole=len(invs) == 1) for i in invs}


def has_inverters(db: Session, plant_id: int) -> bool:
    """The plant has at least one inverter that is not marked as replaced."""
    return bool(_labels(db, plant_id))


def _sort_key(label: str) -> Tuple[int, str]:
    from app.services.daily_checks import _sort_key as key

    return key(label)


def _latest(rows: Iterable[Tuple[Any, ...]], times: Dict[int, datetime]) -> Dict[Tuple[int, Any], Tuple[Any, ...]]:
    """{(hour, key): row} with the latest row per key inside each slot's window. Rows are
    (key, timestamp, ...)."""
    out: Dict[Tuple[int, Any], Tuple[Any, ...]] = {}
    for row in rows:
        ts = row[1]
        for h, t in times.items():
            if t - WINDOW <= ts <= t:
                best = out.get((h, row[0]))
                if best is None or ts > best[1]:
                    out[(h, row[0])] = row
    return out


def _windows(col: Any, times: Dict[int, datetime]) -> Any:
    return or_(*[and_(col >= t - WINDOW, col <= t) for t in times.values()])


def fault_since(day: date, hour: int) -> datetime:
    """Start of check `hour`'s fault look-back: hh:00 − PWA_FAULT_LOOKBACK_MIN (08:00 for 9),
    never after the slot time."""
    since = datetime.combine(day, time(hour)) - timedelta(minutes=settings.pwa_fault_lookback_min)
    return min(since, slot_time(day, hour))


def _active(a: GrowattAlarm, t: datetime, read_at: Optional[datetime], since: Optional[datetime] = None) -> bool:
    """With `since`: the alarm-log record falls in [`since`, `t`], and only there. It started by
    `t` and has no end or ends at `since` or later; a record with end = start (one report of an
    alarm Growatt repeats while it lasts) counts only when reported at `since` or later.

    Without `since`: the alarm is active at `t`. It has no end or ends after `t`; a report with
    end = start is active when made within ONGOING_GAP of `t` (of the inverter's last alarm-log
    read `read_at`, when that was before `t`: the log cannot show a later report)."""
    if a.start_time is None or a.start_time > t:
        return False
    if a.end_time is None:
        return True
    if since is not None:
        return (a.end_time if a.end_time > a.start_time else a.start_time) >= min(since, t)
    if a.end_time > a.start_time:
        return a.end_time >= t
    ref = min(t, read_at) if read_at is not None else t
    return a.start_time >= ref - ONGOING_GAP


def _item(a: GrowattAlarm) -> Optional[Dict[str, Optional[str]]]:
    """{code, message} of an alarm-log entry: its code and its name exactly as Growatt words it
    ("undown error" is Growatt's own name for a code it has no text for); None when it has neither."""
    code = (a.alarm_code or "").strip() or None
    msg = (a.alarm_message or "").strip() or None  # the alarm's name, the placeholder included
    return {"code": code, "message": msg} if code or msg else None


def _is_error(a: GrowattAlarm) -> bool:
    return (a.fault_type or "").strip().lower() == "error"


def _last_seen(db: Session, sns: Sequence[str], day: date, before: datetime) -> Dict[str, datetime]:
    """{device_sn: its latest stored reading of `day` earlier than `before`}."""
    if not sns:
        return {}
    return dict(
        db.execute(
            select(GrowattInverterReading.device_sn, func.max(GrowattInverterReading.timestamp))
            .where(
                GrowattInverterReading.device_sn.in_(sns),
                GrowattInverterReading.timestamp >= datetime.combine(day, time.min),
                GrowattInverterReading.timestamp < before,
            )
            .group_by(GrowattInverterReading.device_sn)
        ).all()
    )


def _hourly_google(g: GoogleWeatherHourly) -> Dict[str, Any]:
    """A slot's `google` from the stored hour that contains the slot time."""
    from app.services import google_weather

    return {
        "source": "hourly",
        "hour": g.hour.strftime("%H:%M"),
        "modelled": True,
        "condition": g.condition,
        "raining": google_weather.is_raining(g.precip_mm, g.condition),
        "precip_mm": g.precip_mm,
        "cloud_cover_pct": g.cloud_cover_pct,
    }


def _fill_google(db: Session, plant: GrowattPlant, day: date, rows: Sequence[PwaCheckSlot]) -> None:
    """Frozen slots that got no Google weather at their publish (call failed, quota, budget) take
    the stored hour once Google's hours are in (18:15). Only the missing `google` is filled; every
    other value of the slot stays as frozen."""
    from app.services import google_weather

    missing = [r for r in rows if not (r.slot_json or {}).get("google")]
    cell = google_weather.plant_cell(plant)
    if not missing or cell is None:
        return
    at = {r.hour: slot_time(day, r.hour).replace(minute=0, second=0, microsecond=0) for r in missing}
    stored = {
        g.hour: g
        for g in db.scalars(
            select(GoogleWeatherHourly).where(GoogleWeatherHourly.cell_key == cell[0], GoogleWeatherHourly.hour.in_(set(at.values())))
        )
    }
    changed = False
    for r in missing:
        g = stored.get(at[r.hour])
        if g is not None:
            r.slot_json = {**r.slot_json, "google": _hourly_google(g)}
            changed = True
    if changed:
        db.commit()


def compute_slots(
    db: Session, plant: GrowattPlant, day: date, hours: Sequence[int], live_google: bool = False
) -> Dict[str, Dict[str, Any]]:
    """Check slots `hours` of one plant, built from stored history (nothing frozen, nothing read
    from `pwa_check_slots`). `live_google`: take Google's current conditions for a check whose
    slot time just passed (the freezing publish only; it calls Google once per cell)."""
    if not hours:
        return {}
    times = {h: slot_time(day, h) for h in hours}
    label = _labels(db, plant.plant_id)
    sns = list(label)

    inv_rows = (
        list(
            db.execute(
                select(GrowattInverterReading.device_sn, GrowattInverterReading.timestamp, GrowattInverterReading.status, GrowattInverterReading.pac_w,
                       GrowattInverterReading.fault_code, GrowattInverterReading.warn_code)
                .where(GrowattInverterReading.device_sn.in_(sns), _windows(GrowattInverterReading.timestamp, times))
            )
        )
        if sns
        else []
    )
    inv = _latest(inv_rows, times)

    alarms = list(
        db.scalars(
            select(GrowattAlarm).where(GrowattAlarm.plant_id == plant.plant_id, GrowattAlarm.day == day, GrowattAlarm.start_time.is_not(None))
        )
    )

    # when each inverter's alarm log of the day was last read (naive plant-local)
    alarm_read = {
        sn: (at if at.tzinfo else at.replace(tzinfo=timezone.utc)).astimezone(PLANT_TZ).replace(tzinfo=None)
        for sn, at in db.execute(
            select(GrowattAlarmSync.device_sn, GrowattAlarmSync.synced_at).where(
                GrowattAlarmSync.plant_id == plant.plant_id, GrowattAlarmSync.day == day
            )
        )
    }

    sensors = [(s.datalogger_sn, s.address) for s in db.scalars(select(GrowattEnvSensor).where(GrowattEnvSensor.plant_id == plant.plant_id))]
    env_rows: List[Tuple[Any, ...]] = []
    for dl, addr in sensors:
        env_rows += [
            ((r[0], r[1]), r[2], r[3], r[4])
            for r in db.execute(
                select(GrowattEnvReading.datalogger_sn, GrowattEnvReading.address, GrowattEnvReading.timestamp,
                       GrowattEnvReading.irradiance_wm2, GrowattEnvReading.module_temp_c)
                .where(
                    GrowattEnvReading.datalogger_sn == dl,
                    GrowattEnvReading.address == addr,
                    GrowattEnvReading.irradiance_wm2.is_not(None),
                    _windows(GrowattEnvReading.timestamp, times),
                )
            )
        ]
    env = _latest(env_rows, times)

    from app.services import google_weather

    cell = google_weather.plant_cell(plant)
    google_rows: Dict[datetime, GoogleWeatherHourly] = {}
    if cell is not None:
        want = {t.replace(minute=0, second=0, microsecond=0) for t in times.values()}
        for r in db.scalars(select(GoogleWeatherHourly).where(GoogleWeatherHourly.cell_key == cell[0], GoogleWeatherHourly.hour.in_(want))):
            google_rows[r.hour] = r

    out: Dict[str, Dict[str, Any]] = {}
    for h, t in times.items():
        hits = {sn: inv[(h, sn)] for sn in sns if (h, sn) in inv}
        offline = sorted({label[sn] for sn in sns if sn not in hits}, key=_sort_key)
        fault = sorted({label[sn] for sn, r in hits.items() if r[2] == FAULT_STATUS}, key=_sort_key)
        pac = [r[3] for r in hits.values() if r[3] is not None]
        open_now: List[str] = []
        errors: Dict[str, int] = {}
        since = fault_since(day, h)
        # every alarm field of the slot takes only the alarm-log records of the look-back (since … t)
        in_window = [a for a in alarms if _active(a, t, alarm_read.get(a.device_sn), since)]
        for a in sorted(in_window, key=lambda a: (_sort_key(label.get(a.device_sn) or a.device_sn), a.start_time or t)):
            if _is_error(a):
                err = (a.alarm_message or "").strip()
                if not err or err.lower() in SKIP_ALARMS:
                    err = f"Error {a.alarm_code}" if a.alarm_code else ""
                if err:
                    key = f"{label.get(a.device_sn) or a.device_sn} {err}"
                    errors[key] = errors.get(key, 0) + 1
            msg = (a.alarm_message or a.alarm_code or "").strip()
            if not msg:
                continue
            if msg.lower() in SKIP_ALARMS and a.alarm_code:  # a name shared by many codes: say which
                msg = f"{a.alarm_code} {msg}"
            text = f"{label.get(a.device_sn) or a.device_sn} {msg}"
            if text not in open_now:
                open_now.append(text)

        # DATA LOG: what is wrong with each inverter at the check
        issues: List[Dict[str, Any]] = []
        last_seen = _last_seen(db, [sn for sn in sns if sn not in hits], day, t - WINDOW)
        for sn in sorted(sns, key=lambda sn: _sort_key(label[sn])):
            r = hits.get(sn)
            if r is None:
                seen = last_seen.get(sn)
                issues.append({"inv": label[sn], "state": "Offline", "items": [], "last": seen.strftime("%H:%M") if seen else None})
                continue
            mine = sorted((a for a in alarms if a.device_sn == sn), key=lambda a: a.start_time or t)
            # the alarm-log records of the check's look-back only (hh:00 − 60 min … slot time)
            present = [a for a in mine if a in in_window]
            # every report of the same alarm (kind, code, text) in that look-back
            reports: Dict[Tuple[bool, Optional[str], Optional[str]], List[datetime]] = {}
            for a in present:
                it = _item(a)
                if it and a.start_time is not None:
                    reports.setdefault((_is_error(a), it["code"], it["message"]), []).append(a.start_time)
            items: List[Dict[str, Any]] = []
            seen_keys = set()
            # errors before warnings, each in start order
            for a in sorted(present, key=lambda a: not _is_error(a)):
                it = _item(a)
                if not it:
                    continue
                key = (_is_error(a), it["code"], it["message"])
                if key not in seen_keys:
                    seen_keys.add(key)
                    times_ = reports[key]
                    items.append({**it, "since": min(times_).strftime("%H:%M"), "count": len(times_)})
            if not items:  # the alarm log has nothing active: the reading's own codes
                # Growatt numbers faults and warnings separately (203 = "PV Isolation Low" as an
                # Error, "PV Circuit short" as a Warning): the log's text only for the same kind
                for code, is_error in ((r[4], True), (r[5], False)):
                    if code and not (not is_error and int(code) in settings.pwa_ignored_warn_codes()):
                        text = next(
                            (
                                i["message"]
                                for a in mine
                                if ((a.fault_type or "").strip().lower() == "error") == is_error
                                for i in [_item(a)]
                                if i and i["code"] == str(code) and i["message"]
                            ),
                            None,
                        )
                        items.append({"code": str(code), "message": text})
            if r[2] == FAULT_STATUS:
                issues.append({"inv": label[sn], "state": "Fault", "items": items})
            elif items:
                issues.append({"inv": label[sn], "state": "Alarm", "items": items})

        sens = [env[(h, s)] for s in sensors if (h, s) in env]
        irr = [float(r[2]) for r in sens]
        mod = [float(r[3]) for r in sens if r[3] is not None]

        cur = google_weather.slot_current(db, day, h, t).get(cell[0]) if live_google and cell is not None else None
        g = google_rows.get(t.replace(minute=0, second=0, microsecond=0))
        google = None
        if cur is not None:
            at_utc = cur.get("time_utc")
            google = {
                "source": "current",
                "at": datetime.fromisoformat(at_utc).astimezone(PLANT_TZ).strftime("%H:%M") if at_utc else None,
                "modelled": True,
                "condition": cur.get("condition"),
                "raining": google_weather.is_raining(cur.get("precip_mm"), cur.get("condition")),
                "precip_mm": cur.get("precip_mm"),
                "cloud_cover_pct": cur.get("cloud_cover_pct"),
            }
        elif g is not None:
            google = _hourly_google(g)

        out[hh(h)] = {
            "at": t.strftime("%H:%M"),
            "inverters": len(sns),
            "offline": offline,
            "fault": fault,
            "alarms": open_now,
            "errors": [k if n == 1 else f"{k} (×{n})" for k, n in errors.items()],
            "issues": issues,
            "kw": round(sum(pac) / 1000.0, 2) if pac else None,
            "reading_at": max(r[1] for r in hits.values()).strftime("%H:%M") if hits else None,
            "irradiance_wm2": round(sum(irr) / len(irr), 1) if irr else None,
            "module_temp_c": round(sum(mod) / len(mod), 1) if mod else None,
            "sensor_at": max(r[1] for r in sens).strftime("%H:%M") if sens else None,
            "google": google,
        }
    return out


# --------------------------------------------------------------------------- frozen slots


def day_slots(
    db: Session,
    plant: GrowattPlant,
    day: date,
    ready: Sequence[int],
    freeze: bool = True,
) -> Dict[str, Dict[str, Any]]:
    """The plant's check slots of `day`: every frozen slot, plus the `ready` hours not frozen
    yet, built now (and frozen when `freeze`). Hours neither frozen nor ready are absent."""
    rows = list(db.scalars(select(PwaCheckSlot).where(PwaCheckSlot.day == day, PwaCheckSlot.plant_id == plant.plant_id)))
    if freeze:
        _fill_google(db, plant, day, rows)
    frozen = {r.hour: r.slot_json for r in rows}
    todo = [h for h in ready if h not in frozen]
    built = compute_slots(db, plant, day, todo, live_google=freeze)
    if freeze and built:
        for h in todo:
            db.add(PwaCheckSlot(day=day, plant_id=plant.plant_id, hour=h, slot_json=built[hh(h)]))
        db.commit()
    out: Dict[str, Dict[str, Any]] = {}
    for h in CHECK_HOURS:
        if h in frozen:
            out[hh(h)] = frozen[h]
        elif hh(h) in built:
            out[hh(h)] = built[hh(h)]
    return out


def prune(db: Session, today: date, keep_days: int) -> int:
    from sqlalchemy import delete

    n = db.execute(delete(PwaCheckSlot).where(PwaCheckSlot.day < today - timedelta(days=keep_days))).rowcount or 0  # type: ignore[attr-defined]
    db.commit()
    return n
