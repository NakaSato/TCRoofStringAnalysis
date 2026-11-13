"""Google Maps Weather API per plant: modelled weather that complements the plant's own sensor.

Google's values come from a weather model for the plant's coordinates, not from the plant, so
every response says `modelled: true` and the UI labels them that way. The Growatt weather
sensor stays the only source of irradiance and IEC PR. Google adds what the sensors don't
measure: cloud cover, rain, condition, UV, dew point, pressure and visibility.

Cost model (10,000 free calls/month, then $0.15 per 1,000):
- Plants whose coordinates round to the same `GOOGLE_WEATHER_CELL_DEG` grid point share one
  lookup (`cell_of`): 234 plants -> ~227 cells at 0.01°.
- `google_weather` worker job (daily 18:15): one `history/hours` call per cell stores the
  previous 24 hours in `google_weather_hourly` (≈ 227 calls/day). Google only returns finished
  hours, so 18:15 is the earliest run that holds the 17:00 hour; consecutive runs cover
  yesterday 18:00 → today 17:00 without gaps. The job then re-publishes yesterday's Firestore
  daily docs so their 18:00–23:00 hours land; `publish_today` (19:30) carries today's slots.
- Firestore daily plant docs carry `google_weather.slots` = the rain status at 09:00, 13:00 and
  17:00 (`SLOT_HOURS`, the PWA report's check times), for linking "ฝนตก" (raining) to the
  plant's production; `weather.slots` holds the sensor's measured irradiance at the same times.
- Daytime only (`GOOGLE_WEATHER_DAY_START_H`–`_END_H`, 06:00–18:00): only those hours are
  stored and read, so day totals / days since rain count daytime rain only. Google bills per
  call, not per hour, so this saves storage and night-time live calls, not history calls.
- Current conditions: only for a plant someone is looking at, inside the daytime window, cached
  `GOOGLE_WEATHER_LIVE_TTL_S` (30 min) per cell in memory, never stored.
- Budget = the whole free tier: `GOOGLE_WEATHER_MONTHLY_BUDGET` (10,000) calls per calendar
  month. Every call is counted per billing day (US/Pacific, when Google's month and daily
  quotas reset) in `external_api_call_counts`. Today's allowance is what is left of the month
  spread over the days left (`allowance`), so calls a quiet day doesn't use roll over. Until the
  history job has run today, live calls leave one call per cell for it.
"""

from __future__ import annotations

import logging
import math
import threading
import time
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime, timedelta, timezone
from functools import lru_cache
from typing import Any, Callable, Dict, Hashable, List, Optional, Sequence, Tuple, cast
from zoneinfo import ZoneInfo

from sqlalchemy import CursorResult, delete, func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.config import settings
from app.db.models import ExternalApiCallCount, GoogleWeatherHourly, GrowattPlant
from app.services.growatt_weather import CHECK_HOURS
from solar_core.google_weather import GoogleWeatherClient, GoogleWeatherError

log = logging.getLogger("google_weather")

H = GoogleWeatherHourly
API_HISTORY = "google_weather_history"
API_CURRENT = "google_weather_current"
APIS = (API_HISTORY, API_CURRENT)
# Hours returned by `history/hours`, counted per billing day like calls (not part of APIS: Google's
# per-day quota "History Hours Usage per day" meters hours, the monthly free tier meters calls).
API_HISTORY_HOURS = "google_weather_history_hours"
STORED = (
    "condition",
    "is_daytime",
    "temp_c",
    "feels_like_c",
    "dew_point_c",
    "humidity_pct",
    "cloud_cover_pct",
    "uv_index",
    "precip_mm",
    "precip_prob_pct",
    "thunder_prob_pct",
    "wind_speed_ms",
    "wind_gust_ms",
    "wind_dir_deg",
    "pressure_hpa",
    "visibility_km",
)
RAIN_DAY_MM = 1.0  # a day with at least this much rain counts as a rain day (soiling wash)
RAIN_HOUR_MM = 0.1
RAIN_LOOKBACK_DAYS = 60


def window() -> Tuple[int, int]:
    """Daytime hours kept and fetched: [start, end) plant-local (default 06:00–18:00)."""
    return settings.google_weather_day_start_h, settings.google_weather_day_end_h


def in_window(hour: int) -> bool:
    start, end = window()
    return start <= hour < end


def min_day_hours() -> int:
    """A stored day with fewer daytime hours is incomplete (not a default day, rain unknown)."""
    start, end = window()
    return max(1, end - start - 2)

def history_lookback_hours(now_local: Optional[datetime] = None) -> int:
    """Hours of history one call asks for: back to the start of the latest daytime window that has
    begun (today's, or yesterday's before it opens), rounded up, at most 24. At 18:15 that is 13
    (06:00–17:00), about half of a 24 h request, so Google's per-day hour quota covers every cell."""
    now = now_local or datetime.now(PLANT_TZ).replace(tzinfo=None)
    start, _ = window()
    opened = now.replace(hour=start, minute=0, second=0, microsecond=0)
    if now < opened:
        opened -= timedelta(days=1)
    return max(1, min(24, math.ceil((now - opened).total_seconds() / 3600)))


FETCH_WORKERS = 8
SLOT_HOURS = CHECK_HOURS  # rain status published per day (plant-local hour that starts then)
RAIN_WORDS = ("RAIN", "SHOWER", "THUNDER", "DRIZZLE")
SOURCE = "Google Maps Platform Weather API"


class GoogleWeatherUnavailable(RuntimeError):
    """No key, budget used up, or Google failed with nothing cached to fall back on."""


PLANT_TZ = ZoneInfo("Asia/Bangkok")
BILLING_TZ = ZoneInfo("America/Los_Angeles")  # Google Maps Platform months / daily quotas reset here


def billing_day(now: Optional[datetime] = None) -> date:
    return (now or datetime.now(timezone.utc)).astimezone(BILLING_TZ).date()


# --------------------------------------------------------------------------- grid cells


def cell_of(lat: float, lon: float, deg: Optional[float] = None) -> Tuple[str, float, float]:
    """(key, lat, lon) of the grid point a plant's coordinates round to."""
    step = deg or settings.google_weather_cell_deg
    digits = max(0, len(f"{step:.6f}".rstrip("0").split(".")[1]))
    clat, clon = round(round(lat / step) * step, digits), round(round(lon / step) * step, digits)
    return f"{clat:.{digits}f},{clon:.{digits}f}", clat, clon


def plant_cell(plant: GrowattPlant) -> Optional[Tuple[str, float, float]]:
    if plant.latitude is None or plant.longitude is None:
        return None
    return cell_of(float(plant.latitude), float(plant.longitude))


def fleet_cells(db: Session) -> Dict[str, Tuple[float, float]]:
    """Every cell that holds at least one plant with coordinates, sorted by key."""
    cells: Dict[str, Tuple[float, float]] = {}
    for p in db.scalars(select(GrowattPlant).order_by(GrowattPlant.plant_id)):
        if c := plant_cell(p):
            cells.setdefault(c[0], (c[1], c[2]))
    return dict(sorted(cells.items()))


# --------------------------------------------------------------------------- call budget


def _calls(db: Session, start: date, end: date, api: Optional[str] = None) -> int:
    """Calls counted on billing days [start, end) (ISO day strings compare in date order)."""
    C = ExternalApiCallCount
    q = select(func.coalesce(func.sum(C.calls), 0)).where(C.day >= start.isoformat(), C.day < end.isoformat())
    q = q.where(C.api == api) if api else q.where(C.api.in_(APIS))
    return int(db.scalar(q) or 0)


def calls_today(db: Session, api: Optional[str] = None, day: Optional[date] = None) -> int:
    d = day or billing_day()
    return _calls(db, d, d + timedelta(days=1), api)


def _month(day: date) -> Tuple[date, date]:
    first = day.replace(day=1)
    return first, (first + timedelta(days=32)).replace(day=1)


def allowance(db: Session, day: Optional[date] = None) -> int:
    """Calls allowed today: what is left of the monthly budget, spread evenly over the days left
    (today included). Unused calls roll over to the rest of the month."""
    d = day or billing_day()
    first, next_month = _month(d)
    left_month = settings.google_weather_monthly_budget - _calls(db, first, d)
    return max(0, left_month // (next_month - d).days)


def history_hours_left(db: Session, day: Optional[date] = None) -> int:
    """History hours Google's per-day quota still allows today (our own count of it)."""
    d = day or billing_day()
    return max(0, settings.google_weather_history_hours_per_day - _calls(db, d, d + timedelta(days=1), API_HISTORY_HOURS))


def remaining(db: Session, api: str, day: Optional[date] = None, cells: Optional[int] = None) -> int:
    """Calls `api` may still make today. Live calls keep one call per cell free for the history
    job until it has run today."""
    d = day or billing_day()
    left = allowance(db, d) - calls_today(db, None, d)
    if api == API_CURRENT and calls_today(db, API_HISTORY, d) == 0:
        left -= len(fleet_cells(db)) if cells is None else cells
    return max(0, left)


def month_usage(db: Session, day: Optional[date] = None) -> Dict[str, Any]:
    d = day or billing_day()
    first, next_month = _month(d)
    return {
        "billing_day": d.isoformat(),
        "monthly_budget": settings.google_weather_monthly_budget,
        "used_this_month": _calls(db, first, next_month),
        "allowance_today": allowance(db, d),
        "used_today": calls_today(db, None, d),
    }


def record_calls(db: Session, api: str, n: int, day: Optional[date] = None) -> None:
    if n <= 0:
        return
    ds = (day or billing_day()).isoformat()
    for _ in range(2):  # a concurrent first insert of the day: retry as an update
        row = db.get(ExternalApiCallCount, (api, ds))
        if row is None:
            db.add(ExternalApiCallCount(api=api, day=ds, calls=n))
        else:
            row.calls += n
        try:
            db.commit()
            return
        except IntegrityError:
            db.rollback()
    log.warning("could not record %d %s calls", n, api)


def reserve(db: Session, api: str) -> bool:
    """Count one call now if the budget allows it."""
    if remaining(db, api) <= 0:
        return False
    record_calls(db, api, 1)
    return True


# --------------------------------------------------------------------------- history job


def _store_hours(db: Session, cell_key: str, rows: Sequence[Dict[str, Any]]) -> int:
    """Idempotent: re-fetched hours replace the stored ones."""
    if not rows:
        return 0
    rows = [r for r in rows if in_window(r["hour_local"].hour)]  # daytime only
    if not rows:
        return 0
    hours = sorted({r["hour_local"] for r in rows})
    db.execute(delete(H).where(H.cell_key == cell_key, H.hour >= hours[0], H.hour <= hours[-1]))
    seen = set()
    now = datetime.now(timezone.utc)
    for r in rows:
        if r["hour_local"] in seen:
            continue
        seen.add(r["hour_local"])
        db.add(H(cell_key=cell_key, hour=r["hour_local"], fetched_at=now, **{f: r.get(f) for f in STORED}))
    return len(seen)


def _oldest_first(db: Session, cells: Dict[str, Tuple[float, float]]) -> List[Tuple[str, Tuple[float, float]]]:
    """Cells with no stored hours first, then the stalest: when a run is cut short (budget or a
    429) the next run starts with the cells it missed, instead of always the same last ones."""
    latest: Dict[str, datetime] = {k: h for k, h in db.execute(select(H.cell_key, func.max(H.hour)).group_by(H.cell_key))}
    return sorted(cells.items(), key=lambda kv: (latest.get(kv[0]) is not None, latest.get(kv[0]) or datetime.min, kv[0]))


def sync_history(
    db: Session,
    client: GoogleWeatherClient,
    cells: Optional[Dict[str, Tuple[float, float]]] = None,
    workers: int = FETCH_WORKERS,
    now_local: Optional[datetime] = None,
) -> Tuple[str, Dict[str, Any]]:
    """Store today's daytime hours (see `history_lookback_hours`) for every cell, within today's
    call budget and Google's per-day history-hour quota."""
    cells = fleet_cells(db) if cells is None else cells
    hours = history_lookback_hours(now_local)
    left = min(remaining(db, API_HISTORY), history_hours_left(db) // hours)
    todo = _oldest_first(db, cells)[:left]
    skipped = len(cells) - len(todo)

    quota_hit = threading.Event()  # Google's per-day quota (HTTP 429): stop calling for today

    def fetch(item: Tuple[str, Tuple[float, float]]) -> Tuple[str, Any]:
        key, (lat, lon) = item
        if quota_hit.is_set():
            return key, GoogleWeatherError("skipped: Google daily quota exceeded (HTTP 429)")
        try:
            return key, client.history_hours(lat, lon, hours=hours)
        except GoogleWeatherError as exc:
            if "HTTP 429" in str(exc):
                quota_hit.set()
            return key, exc

    calls_before = client.calls
    with ThreadPoolExecutor(max_workers=max(1, workers), thread_name_prefix="gweather") as pool:
        results = list(pool.map(fetch, todo))
    refused = sum(1 for _, r in results if isinstance(r, GoogleWeatherError) and "HTTP 429" in str(r) and not str(r).startswith("skipped"))
    calls = client.calls - calls_before - refused  # a call Google refused with 429 is not billed
    record_calls(db, API_HISTORY, calls)

    stored, failed, hours_returned = 0, {}, 0
    for key, res in results:
        if isinstance(res, Exception):
            failed[key] = str(res)
            continue
        hours_returned += len(res)
        stored += _store_hours(db, key, res)
    record_calls(db, API_HISTORY_HOURS, hours_returned)
    db.commit()
    if failed:
        log.warning("google weather: %d of %d cells failed, e.g. %s", len(failed), len(todo), next(iter(failed.values())))
    if skipped:
        log.warning("google weather: %d of %d cells skipped (call budget / daily history-hour quota)", skipped, len(cells))
    detail = {
        "cells": len(cells),
        "lookback_hours": hours,
        "fetched": len(todo) - len(failed),
        "failed": len(failed),
        "skipped_budget": skipped,
        "hours_stored": stored,
        "hours_returned": hours_returned,
        "history_hours_left_today": history_hours_left(db),
        "calls": calls,
        "calls_today": calls_today(db),
        "usage": month_usage(db),
        "google_quota_exceeded": quota_hit.is_set(),
        "errors": dict(list(failed.items())[:5]),
    }
    if todo and len(failed) == len(todo):
        raise RuntimeError(f"every Google Weather call failed: {next(iter(failed.values()))}")
    return ("partial" if failed or skipped else "ok"), detail


def make_client() -> GoogleWeatherClient:
    return GoogleWeatherClient(settings.google_weather_api_key, base_url=settings.google_weather_base_url)


def run_history_job(db: Session) -> Tuple[str, Dict[str, Any]]:
    if not settings.google_weather_api_key:
        return "ok", {"skipped": "GOOGLE_WEATHER_API_KEY not set"}
    return sync_history(db, make_client())


def prune(db: Session, today: date, keep_days: int) -> int:
    cutoff = datetime.combine(today - timedelta(days=keep_days), datetime.min.time())
    n = cast(CursorResult, db.execute(delete(H).where(H.hour < cutoff))).rowcount or 0
    db.commit()
    return n


# --------------------------------------------------------------------------- stored day (DB only)


def _row_out(r: GoogleWeatherHourly) -> Dict[str, Any]:
    return {"hour": r.hour.strftime("%Y-%m-%d %H:%M:%S"), **{f: getattr(r, f) for f in STORED}}


def _mean(vals: Sequence[Optional[float]], digits: int) -> Optional[float]:
    v = [float(x) for x in vals if x is not None]
    return round(sum(v) / len(v), digits) if v else None


def _max(vals: Sequence[Optional[float]], digits: int) -> Optional[float]:
    v = [float(x) for x in vals if x is not None]
    return round(max(v), digits) if v else None


def _min(vals: Sequence[Optional[float]], digits: int) -> Optional[float]:
    v = [float(x) for x in vals if x is not None]
    return round(min(v), digits) if v else None


def _rain(vals: Sequence[Optional[float]]) -> Optional[float]:
    v = [float(x) for x in vals if x is not None]
    return round(sum(v), 1) if v else None


def is_raining(precip_mm: Optional[float], condition: Optional[str]) -> Optional[bool]:
    """Rain in that hour: ≥ RAIN_HOUR_MM of rain, or a rain/shower/thunder condition (not a
    mere "chance of"). None when Google gave neither."""
    if precip_mm is None and not condition:
        return None
    if (precip_mm or 0) >= RAIN_HOUR_MM:
        return True
    c = (condition or "").upper()
    return any(w in c for w in RAIN_WORDS) and not c.startswith("CHANCE_OF")


def slots(rows: Sequence[Dict[str, Any]]) -> Dict[str, Optional[Dict[str, Any]]]:
    """Weather at SLOT_HOURS ("09", "13", "17"); None for an hour not stored (yet)."""
    by_hour = {int(r["hour"][11:13]): r for r in rows}
    out: Dict[str, Optional[Dict[str, Any]]] = {}
    for h in SLOT_HOURS:
        r = by_hour.get(h)
        if r is None:
            out[f"{h:02d}"] = None
            continue
        raining = is_raining(r["precip_mm"], r["condition"])
        out[f"{h:02d}"] = {
            "raining": raining,
            "status_th": None if raining is None else ("ฝนตก" if raining else "ไม่มีฝน"),
            "condition": r["condition"],
            "precip_mm": r["precip_mm"],
            "precip_prob_pct": r["precip_prob_pct"],
            "cloud_cover_pct": r["cloud_cover_pct"],
            "temp_c": r["temp_c"],
        }
    return out


def day_kpis(rows: Sequence[Dict[str, Any]]) -> Dict[str, Any]:
    daytime = [r for r in rows if r["is_daytime"]] or [r for r in rows if 6 <= int(r["hour"][11:13]) < 18]
    conds = Counter(r["condition"] for r in daytime if r["condition"])
    return {
        "hours": len(rows),
        "complete": len(rows) >= min_day_hours(),
        "rain_mm": _rain([r["precip_mm"] for r in rows]),
        "rain_hours": sum(1 for r in rows if (r["precip_mm"] or 0) >= RAIN_HOUR_MM) if rows else None,
        "temp_max_c": _max([r["temp_c"] for r in rows], 1),
        "temp_min_c": _min([r["temp_c"] for r in rows], 1),
        "cloud_cover_daytime_pct": _mean([r["cloud_cover_pct"] for r in daytime], 0),
        "uv_max": _max([r["uv_index"] for r in rows], 0),
        "humidity_avg_pct": _mean([r["humidity_pct"] for r in rows], 0),
        "wind_gust_max_ms": _max([r["wind_gust_ms"] for r in rows], 1),
        "thunder_prob_max_pct": _max([r["thunder_prob_pct"] for r in rows], 0),
        "condition": conds.most_common(1)[0][0] if conds else None,
        "rained": (
            any(is_raining(r["precip_mm"], r["condition"]) for r in rows)
            or sum(r["precip_mm"] or 0 for r in rows) >= RAIN_HOUR_MM
            if rows
            else None
        ),
    }


def _day_hours(db: Session, cell_key: str, start: date, end: date) -> Dict[date, List[GoogleWeatherHourly]]:
    """Stored hours of [start, end] (plant-local dates), grouped by date."""
    rows = db.scalars(
        select(H)
        .where(
            H.cell_key == cell_key,
            H.hour >= datetime.combine(start, datetime.min.time()),
            H.hour < datetime.combine(end + timedelta(days=1), datetime.min.time()),
        )
        .order_by(H.hour)
    )
    out: Dict[date, List[GoogleWeatherHourly]] = {}
    for r in rows:
        if not in_window(r.hour.hour):
            continue
        out.setdefault(r.hour.date(), []).append(r)
    return out


def latest_day(db: Session, cell_key: str) -> Optional[date]:
    """Newest stored day with at least `min_day_hours()` daytime hours (else the newest day at all)."""
    last = db.scalar(select(func.max(H.hour)).where(H.cell_key == cell_key))
    if last is None:
        return None
    by_day = _day_hours(db, cell_key, last.date() - timedelta(days=3), last.date())
    full = [d for d, rows in by_day.items() if len(rows) >= min_day_hours()]
    return max(full) if full else last.date()


def days_since_rain(db: Session, cell_key: str, day: date) -> Dict[str, Any]:
    """Days from the last complete day with ≥ RAIN_DAY_MM of rain up to `day` (0 = rained that day).

    Null when a day without complete data lies in between (the gap may have held rain) or no rain
    day is stored within RAIN_LOOKBACK_DAYS.
    """
    by_day = _day_hours(db, cell_key, day - timedelta(days=RAIN_LOOKBACK_DAYS), day)
    d = day
    while d >= day - timedelta(days=RAIN_LOOKBACK_DAYS):
        rows = by_day.get(d, [])
        rain = sum(r.precip_mm or 0 for r in rows)
        if rain >= RAIN_DAY_MM:
            return {"days_since_rain": (day - d).days, "last_rain_day": d.isoformat(), "last_rain_mm": round(rain, 1)}
        if len(rows) < min_day_hours() and d != day:
            break
        d -= timedelta(days=1)
    return {"days_since_rain": None, "last_rain_day": None, "last_rain_mm": None}


def build_day(db: Session, plant: GrowattPlant, day: Optional[date] = None) -> Dict[str, Any]:
    """Stored Google hourly weather for one plant-local day (default: latest complete day)."""
    cell = plant_cell(plant)
    base: Dict[str, Any] = {
        "meta": {"source": "db", "provider": SOURCE, "modelled": True, "day": None, "cell": None},
        "configured": bool(settings.google_weather_api_key),
        "has_location": cell is not None,
        "hours": [],
        "kpis": day_kpis([]),
        "slots": slots([]),
        "rain": {"days_since_rain": None, "last_rain_day": None, "last_rain_mm": None},
    }
    if cell is None:
        return base
    key = cell[0]
    base["meta"]["cell"] = {"key": key, "latitude": cell[1], "longitude": cell[2]}
    day = day or latest_day(db, key)
    if day is None:
        return base
    rows = [_row_out(r) for r in _day_hours(db, key, day, day).get(day, [])]
    base["meta"]["day"] = day.isoformat()
    base["hours"] = rows
    base["kpis"] = day_kpis(rows)
    base["slots"] = slots(rows)
    base["rain"] = days_since_rain(db, key, day)
    return base


def day_summary(db: Session, plant: GrowattPlant, day: date) -> Optional[Dict[str, Any]]:
    """Compact daily fields for the Firestore daily plant doc; None without stored hours."""
    cell = plant_cell(plant)
    if cell is None:
        return None
    rows = [_row_out(r) for r in _day_hours(db, cell[0], day, day).get(day, [])]
    if not rows:
        return None
    k = day_kpis(rows)
    return {
        "modelled": True,
        "hours": k["hours"],
        "rain_mm": k["rain_mm"],
        "cloud_cover_daytime_pct": k["cloud_cover_daytime_pct"],
        "temp_max_c": k["temp_max_c"],
        "temp_min_c": k["temp_min_c"],
        "uv_max": k["uv_max"],
        "condition": k["condition"],
        "rained": k["rained"],
        "days_since_rain": days_since_rain(db, cell[0], day)["days_since_rain"],
        "slots": slots(rows),
    }


# --------------------------------------------------------------------------- live (memory only)


class GoogleWeatherLive:
    """Current conditions per cell, cached in memory only (never SQL / Firestore).

    Same envelope as the Growatt live service: `source`, `fetched_at`, `stale`, `error`,
    `refresh_in_s`, `data`. A failed or over-budget call serves the last value as stale.
    """

    def __init__(
        self,
        client_factory: Callable[[], GoogleWeatherClient],
        ttl_s: float = 1800.0,
        cooldown_s: float = 300.0,
        clock: Callable[[], float] = time.monotonic,
        now_local: Optional[Callable[[], datetime]] = None,
    ):
        self._factory = client_factory
        self._now_local = now_local or (lambda: datetime.now(PLANT_TZ).replace(tzinfo=None))
        self._client: Optional[GoogleWeatherClient] = None
        self.ttl_s, self.cooldown_s = ttl_s, cooldown_s
        self._clock = clock
        self._cache: Dict[Hashable, Tuple[float, datetime, Dict[str, Any]]] = {}
        self._cooldown_until: Dict[Hashable, float] = {}
        self._locks: Dict[Hashable, threading.Lock] = {}
        self._lock = threading.Lock()

    def _client_get(self) -> GoogleWeatherClient:
        with self._lock:
            if self._client is None:
                self._client = self._factory()
            return self._client

    def _key_lock(self, key: Hashable) -> threading.Lock:
        with self._lock:
            return self._locks.setdefault(key, threading.Lock())

    def _env(self, wall: datetime, data: Dict[str, Any], stale: bool, error: Optional[str], refresh: float) -> Dict[str, Any]:
        return {
            "source": "live",
            "fetched_at": wall.isoformat(),
            "stale": stale,
            "error": error,
            "refresh_in_s": max(15, round(refresh)),
            "data": data,
        }

    def _until_window(self) -> float:
        """Seconds until the daytime window opens; 0 while it is open."""
        local = self._now_local()
        start, end = window()
        if start <= local.hour < end:
            return 0.0
        opens = local.replace(hour=start, minute=0, second=0, microsecond=0)
        if local.hour >= end:
            opens += timedelta(days=1)
        return (opens - local).total_seconds()

    def current(self, key: str, lat: float, lon: float, reserve_call: Callable[[], bool]) -> Dict[str, Any]:
        """`reserve_call()` counts the call against the daily budget, False = budget used up.
        Outside the daytime window Google is not called: the last value (stale) or unavailable."""
        hit = self._cache.get(key)
        now = self._clock()
        if hit and now - hit[0] < self.ttl_s:
            return self._env(hit[1], hit[2], False, None, self.ttl_s - (now - hit[0]))
        wait = self._until_window()
        if wait > 0:
            start, end = window()
            msg = f"Google Weather live runs {start:02d}:00–{end:02d}:00 (plant time)"
            if hit:
                return self._env(hit[1], hit[2], True, msg, wait)
            raise GoogleWeatherUnavailable(msg)
        with self._key_lock(key):
            hit = self._cache.get(key)
            now = self._clock()
            if hit and now - hit[0] < self.ttl_s:
                return self._env(hit[1], hit[2], False, None, self.ttl_s - (now - hit[0]))
            cooldown = self._cooldown_until.get(key, 0.0) - now
            if cooldown > 0:
                error = "Google Weather cooldown after an error"
            elif not reserve_call():
                error = "Google Weather call budget for today used up (monthly free tier)"
                self._cooldown_until[key] = now + self.cooldown_s
                cooldown = self.cooldown_s
            else:
                try:
                    data = self._client_get().current(lat, lon)
                except GoogleWeatherError as exc:
                    error = str(exc)
                    self._cooldown_until[key] = now + self.cooldown_s
                    cooldown = self.cooldown_s
                else:
                    wall = datetime.now(timezone.utc)
                    self._cache[key] = (now, wall, data)
                    self._cooldown_until.pop(key, None)
                    return self._env(wall, data, False, None, self.ttl_s)
            if hit:
                return self._env(hit[1], hit[2], True, error, cooldown)
            raise GoogleWeatherUnavailable(error)


@lru_cache(maxsize=1)
def get_google_live() -> GoogleWeatherLive:
    return GoogleWeatherLive(make_client, ttl_s=settings.google_weather_live_ttl_s)


def live_plant(db: Session, plant: GrowattPlant, live: GoogleWeatherLive) -> Dict[str, Any]:
    """Current conditions for one plant's cell. Raises GoogleWeatherUnavailable."""
    if not settings.google_weather_api_key:
        raise GoogleWeatherUnavailable("Google Weather is not configured (GOOGLE_WEATHER_API_KEY)")
    cell = plant_cell(plant)
    if cell is None:
        raise GoogleWeatherUnavailable("plant has no coordinates")
    key, lat, lon = cell
    env = live.current(key, lat, lon, lambda: reserve(db, API_CURRENT))
    env["data"] = {
        "plant_id": plant.plant_id,
        "provider": SOURCE,
        "modelled": True,
        "cell": {"key": key, "latitude": lat, "longitude": lon},
        **env["data"],
    }
    return env
