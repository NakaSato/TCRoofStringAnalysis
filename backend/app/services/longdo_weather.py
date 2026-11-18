"""Longdo rain radar for the Plant Map: radar snapshots and rain over one plant, now and +15 / +30 min.

Memory only (mirrored in Redis when configured), never SQL / Firestore. Same envelope as the
Growatt live service: `source`, `fetched_at`, `stale`, `error`, `refresh_in_s`, `data`. A failed
call serves the last value as stale and waits `cooldown_s` before the next try.

Radar-derived, not measured: every answer says `radar: true`. The plant's own weather sensor
stays the only measured weather.
"""

from __future__ import annotations

import threading
import time
from collections import deque
from datetime import date, timedelta
from datetime import datetime, timezone
from functools import lru_cache
from concurrent.futures import ThreadPoolExecutor
from typing import Any, Callable, Dict, Hashable, List, Optional, Set, Tuple

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.config import settings
from app.db.models import GrowattPlant
from app.services import google_weather as gw
from app.services.live_store import RedisLink, TieredDict, cache_map, cooldown_map, redis_link
from solar_core.longdo_weather import (
    ATTRIBUTION,
    TILE_MAX_ZOOM,
    TILE_MIN_ZOOM,
    LongdoWeatherClient,
    LongdoWeatherError,
)

SOURCE = "Longdo Map weather radar"
LEGEND_TTL_S = 86400.0  # static
SWEEP_WORKERS = 8
API = "longdo"  # external_api_call_counts: keyed JSON calls the backend makes (not the browser's tiles)
REGION_DEG = 1.0  # fleet rain: one `area` call per 1° square that holds a plant ...
REGION_RADIUS_KM = 80.0  # ... over the circle that covers it (half diagonal ≈ 78 km)


class LongdoUnavailable(RuntimeError):
    """Not configured, or the call failed and there is no earlier value to serve."""


def enabled() -> bool:
    return bool(settings.longdo_api_key)


# --------------------------------------------------------------------------- call budget


def _today() -> date:
    return datetime.now(gw.PLANT_TZ).date()


def used(db: Session, start: date, end: date) -> int:
    return gw._calls(db, start, end, API)


def allowance(db: Session, day: Optional[date] = None) -> int:
    """Calls allowed today: what is left of `LONGDO_MONTHLY_BUDGET`, spread over the days left
    (today included), so unused calls roll over."""
    d = day or _today()
    first, next_month = gw._month(d)
    return max(0, (settings.longdo_monthly_budget - used(db, first, d)) // (next_month - d).days)


def reserve(db: Session, n: int = 1) -> int:
    """Count up to `n` calls now; returns how many today's allowance still had room for."""
    d = _today()
    granted = max(0, min(n, allowance(db, d) - used(db, d, d + timedelta(days=1))))
    gw.record_calls(db, API, granted, d)
    return granted


def usage(db: Session) -> Dict[str, Any]:
    d = _today()
    first, next_month = gw._month(d)
    return {
        "monthly_budget": settings.longdo_monthly_budget,
        "used_this_month": used(db, first, next_month),
        "allowance_today": allowance(db, d),
        "used_today": used(db, d, d + timedelta(days=1)),
    }


def make_client() -> LongdoWeatherClient:
    return LongdoWeatherClient(settings.longdo_api_key, settings.longdo_base_url)


class LongdoLive:
    def __init__(
        self,
        client_factory: Callable[[], LongdoWeatherClient],
        cooldown_s: float = 60.0,
        clock: Callable[[], float] = time.monotonic,
        redis: Optional[RedisLink] = None,
        calls_per_min: int = 30,
    ):
        self.calls_per_min = calls_per_min
        self._recent: deque[float] = deque()  # monotonic times of the calls of the last minute
        self._factory = client_factory
        self._client: Optional[LongdoWeatherClient] = None
        self.cooldown_s = cooldown_s
        self._clock = clock
        # key -> (clock_ts, wall iso, data, ttl_s)
        self._cache: TieredDict = cache_map("longdo", redis, ttl_index=3)
        self._cooldown_until: TieredDict = cooldown_map("longdo-cooldown", redis, clock)
        self._locks: Dict[Hashable, threading.Lock] = {}
        self._lock = threading.Lock()

    def client(self) -> LongdoWeatherClient:
        with self._lock:
            if self._client is None:
                self._client = self._factory()
            return self._client

    def _key_lock(self, key: Hashable) -> threading.Lock:
        with self._lock:
            return self._locks.setdefault(key, threading.Lock())

    @staticmethod
    def _env(wall: str, data: Any, stale: bool, error: Optional[str], refresh: float) -> Dict[str, Any]:
        return {
            "source": "live",
            "fetched_at": wall,
            "stale": stale,
            "error": error,
            "refresh_in_s": max(15, round(refresh)),
            "data": data,
        }

    def take(self, n: int = 1, keep: int = 0) -> int:
        """Up to `n` call slots of this minute's rate limit; returns how many were free.
        `keep` slots are left untouched (the fleet sweep leaves them for the selected plant and
        the snapshot list, so the sweep cannot starve what the user is looking at)."""
        with self._lock:
            now = time.monotonic()
            while self._recent and now - self._recent[0] >= 60.0:
                self._recent.popleft()
            granted = max(0, min(n, self.calls_per_min - keep - len(self._recent)))
            self._recent.extend([now] * granted)
            return granted

    def peek(self, key: str) -> Optional[Tuple[float, str, Any]]:
        """(age_s, fetched_at, data) of a cached key, however old; never calls Longdo."""
        hit = self._cache.get(key)
        return (self._clock() - hit[0], hit[1], hit[2]) if hit else None

    def cached(
        self,
        key: str,
        ttl_s: float,
        fetch: Callable[[LongdoWeatherClient], Any],
        calls: int = 1,
        reserve_calls: Optional[Callable[[int], int]] = None,
    ) -> Dict[str, Any]:
        """`fetch(client)`'s answer, at most once per `ttl_s`. Raises LongdoUnavailable.

        `calls` = keyed HTTP calls `fetch` makes: they must fit this minute's rate limit and,
        with `reserve_calls`, today's budget; else the last value is served as stale.
        `calls=0`: the caller already took its slots (the fleet sweep)."""

        def fresh() -> Optional[Dict[str, Any]]:
            hit = self._cache.get(key)
            if not hit:
                return None
            age = self._clock() - hit[0]
            return self._env(hit[1], hit[2], False, None, ttl_s - age) if age < ttl_s else None

        env = fresh()
        if env:
            return env
        with self._key_lock(key):
            env = fresh()
            if env:
                return env
            now = self._clock()
            wait = self._cooldown_until.get(key, 0.0) - now
            if wait > 0:
                error = "Longdo cooldown after an error"
            elif calls and self.take(calls) < calls:
                error, wait = f"Longdo rate limit ({self.calls_per_min} calls/min) reached, retrying shortly", 20.0
            elif calls and reserve_calls and reserve_calls(calls) < calls:
                error, wait = "Longdo call budget for today used up (monthly limit)", 600.0
            else:
                try:
                    data = fetch(self.client())
                except LongdoWeatherError as exc:
                    error, wait = str(exc), self.cooldown_s
                    self._cooldown_until[key] = now + wait
                else:
                    wall = datetime.now(timezone.utc).isoformat()
                    self._cache[key] = (now, wall, data, ttl_s)
                    self._cooldown_until.pop(key, None)
                    return self._env(wall, data, False, None, ttl_s)
            hit = self._cache.get(key)
            if hit:
                return self._env(hit[1], hit[2], True, error, wait)
            raise LongdoUnavailable(error)


@lru_cache(maxsize=1)
def get_longdo_live() -> LongdoLive:
    link = redis_link(settings.redis_url)
    return LongdoLive(
        make_client, clock=time.time if link else time.monotonic, redis=link, calls_per_min=settings.longdo_calls_per_min
    )


def _require() -> None:
    if not enabled():
        raise LongdoUnavailable("Longdo rain radar is not configured (LONGDO_API_KEY)")


def radar(db: Session, live: LongdoLive) -> Dict[str, Any]:
    """Radar snapshots (Unix times, oldest first), the tile URL template and the legend."""
    _require()
    env = live.cached("frames", settings.longdo_radar_ttl_s, lambda c: c.frames(), reserve_calls=lambda n: reserve(db, n))
    try:
        legend = live.cached("legend", LEGEND_TTL_S, lambda c: c.legend(), calls=0)["data"]  # no key, not counted
    except LongdoUnavailable:
        legend = []  # the map still works; the UI shows no legend rather than made-up colours
    env["data"] = {
        "provider": SOURCE,
        "radar": True,
        "frames": env["data"],
        # carries the key: a Longdo Map key is a browser key, restricted by domain at Longdo
        "tile_url": live.client().tile_url(),
        "min_zoom": TILE_MIN_ZOOM,
        "max_zoom": TILE_MAX_ZOOM,
        "attribution": ATTRIBUTION,
        "legend": legend,
    }
    return env


def plant_rain(db: Session, plant: GrowattPlant, live: LongdoLive) -> Dict[str, Any]:
    """Radar rain class over the plant now, and the +15 / +30 min nowcast. Plants in one
    Google Weather grid cell (~1 km) share a lookup."""
    _require()
    cell = gw.plant_cell(plant)
    if cell is None:
        raise LongdoUnavailable("plant has no coordinates")
    key, lat, lon = cell

    radius = settings.longdo_area_radius_km

    def fetch(c: LongdoWeatherClient) -> Dict[str, Any]:
        now = c.rain_at(lat, lon)
        try:
            forecast, forecast_error = c.forecast_at(lat, lon), None
        except LongdoWeatherError as exc:  # the nowcast is optional: "now" is still served
            forecast, forecast_error = [], str(exc)
        area: Dict[str, Any] = {"radius_km": radius, "now": None, "forecast": [], "error": None}
        try:  # rain nearby is optional too
            area["now"] = c.area_at(lat, lon, radius)
            area["forecast"] = c.forecast_area_at(lat, lon, radius)
        except LongdoWeatherError as exc:
            area["error"] = str(exc)
        return {"now": now, "forecast": forecast, "forecast_error": forecast_error, "area": area}

    env = live.cached(f"rain:{key}", settings.longdo_rain_ttl_s, fetch, calls=4, reserve_calls=lambda n: reserve(db, n))
    env["data"] = {
        "plant_id": plant.plant_id,
        "provider": SOURCE,
        "radar": True,
        "cell": {"key": key, "latitude": lat, "longitude": lon},
        **env["data"],
    }
    return env



# --------------------------------------------------------------------------- fleet rain (swept)

DRY = {"intensity": 0, "description": None}


def _region(lat: float, lon: float) -> Tuple[str, float, float]:
    rlat, rlon = round(lat / REGION_DEG) * REGION_DEG, round(lon / REGION_DEG) * REGION_DEG
    return f"{rlat:.0f},{rlon:.0f}", rlat, rlon


def _wet(stats: Optional[Dict[str, Any]]) -> bool:
    """Rain somewhere in the region's circle; unknown stats count as wet (ask per plant)."""
    if not stats or stats.get("max_intensity") is None:
        return True
    return stats["max_intensity"] > 0 or (stats.get("coverage_pct") or 0) > 0


def fleet_rain(db: Session, live: LongdoLive, allowed: Optional[Set[int]]) -> Dict[str, Any]:
    """Radar rain class now over every plant the user may see (`allowed` None = all).

    Two steps, to stay inside Longdo's 100,000 calls/month and 60/min: one `area` call per 1°
    region holding a plant (47 for the fleet); a region with no rain pixel answers 0 for all its
    plants (`via: "area"`), and only plants in a region with rain get their own `location` call
    per ~1 km cell (`via: "point"`). Swept: each request makes at most
    `LONGDO_RAIN_SWEEP_PER_REQUEST` calls (due regions first, then due cells, oldest first),
    within the rate limit and today's budget, and serves the rest from the cache;
    `refresh_in_s` is 15 while calls are due. A plant not checked yet has `checked: false` and
    `rain: null`, never "no rain".
    """
    _require()
    ttl = float(settings.longdo_fleet_rain_ttl_s)
    plants: List[Tuple[int, Optional[str], Optional[str]]] = []  # (plant_id, region key, cell key)
    regions: Dict[str, Tuple[float, float]] = {}
    cells: Dict[str, Tuple[float, float, str]] = {}  # cell -> (lat, lon, region key)
    for plant in db.scalars(select(GrowattPlant).order_by(GrowattPlant.plant_id)):
        if allowed is not None and plant.plant_id not in allowed:
            continue
        cell = gw.plant_cell(plant)
        if cell is None or (cell[1] == 0 and cell[2] == 0):  # 0,0 is Growatt's "not set"
            plants.append((plant.plant_id, None, None))
            continue
        rk, rlat, rlon = _region(cell[1], cell[2])
        regions[rk] = (rlat, rlon)
        cells[cell[0]] = (cell[1], cell[2], rk)
        plants.append((plant.plant_id, rk, cell[0]))

    def age(key: str) -> float:
        hit = live.peek(key)
        return float("inf") if hit is None else hit[0]

    def due_cells() -> List[str]:
        out = []
        for ck, (_, _, rk) in cells.items():
            hit = live.peek(f"region:{rk}")
            if hit and hit[0] < ttl and _wet(hit[2]) and age(f"now:{ck}") >= ttl:
                out.append(f"now:{ck}")
        return out

    def run(keys: List[str], blocked: List[str]) -> None:
        """Fetch the oldest of `keys` that the rate limit and the budget leave room for."""
        nonlocal slots
        keys = sorted(keys, key=age, reverse=True)[:slots]
        if not keys:
            return
        free = live.take(len(keys), keep=min(settings.longdo_interactive_reserve_per_min, live.calls_per_min - 1))
        if free < len(keys):
            blocked.append(f"Longdo rate limit ({live.calls_per_min} calls/min) reached")
        granted = reserve(db, free) if free else 0
        if granted < free:
            blocked.append("Longdo call budget for today used up (monthly limit)")
        keys = keys[:granted]
        slots -= len(keys)

        def fetch(key: str) -> None:
            kind, _, name = key.partition(":")
            try:
                if kind == "region":
                    lat, lon = regions[name]
                    live.cached(key, ttl, lambda c: c.area_at(lat, lon, REGION_RADIUS_KM), calls=0)
                else:
                    lat, lon, _ = cells[name]
                    live.cached(key, ttl, lambda c: c.rain_at(lat, lon), calls=0)
            except LongdoUnavailable:
                pass  # stays unchecked (or keeps its old value); the cooldown spaces the retries

        if keys:
            with ThreadPoolExecutor(max_workers=min(SWEEP_WORKERS, len(keys))) as pool:
                list(pool.map(fetch, keys))

    slots = max(1, settings.longdo_rain_sweep_per_request)
    blocked: List[str] = []
    run([f"region:{rk}" for rk in regions if age(f"region:{rk}") >= ttl], blocked)
    run(due_cells(), blocked)

    rows, checked, raining, oldest = [], 0, 0, 0.0
    for plant_id, rk, ck in plants:
        region = live.peek(f"region:{rk}") if rk else None
        point = live.peek(f"now:{ck}") if ck else None
        hit, via = None, None
        if region and not _wet(region[2]) and (point is None or region[0] <= point[0]):
            hit, via = (region[0], region[1], DRY), "area"
        elif point:
            hit, via = point, "point"
        rain = hit[2] if hit else None
        if hit:
            checked += 1
            oldest = max(oldest, hit[0])
            raining += 1 if rain and rain["intensity"] > 0 else 0
        rows.append({"plant_id": plant_id, "checked": hit is not None, "rain": rain, "via": via, "fetched_at": hit[1] if hit else None})
    pending = sum(1 for rk in regions if age(f"region:{rk}") >= ttl) + len(due_cells())
    return {
        "source": "live",
        "fetched_at": datetime.now(timezone.utc).isoformat(),
        "stale": bool(blocked),
        "error": "; ".join(dict.fromkeys(blocked)) or None,
        "refresh_in_s": (60 if blocked else 15) if pending else max(15, round(ttl - oldest)),
        "data": {
            "provider": SOURCE,
            "radar": True,
            "plants": rows,
            "located": sum(1 for _, rk, _ in plants if rk),
            "checked": checked,
            "raining": raining,
            "usage": usage(db),
        },
    }
