"""Constants, result types and the cache behind every live feature."""

from __future__ import annotations

import threading
from concurrent.futures import ThreadPoolExecutor
import time
from datetime import date, datetime, timedelta, timezone
from functools import lru_cache
from typing import Any, Callable, Dict, Hashable, List, Optional, Sequence, Tuple, Union
from zoneinfo import ZoneInfo

from app.services.live_store import RedisLink, TieredDict, cache_map, cooldown_map
from solar_core.growatt import GrowattAPIError, GrowattClient
from solar_core.sun import sun_times

RATE_LIMIT_CODE = 10012


MIN_REFRESH_S = 15  # floor for refresh_in_s, so an expired key never invites a tight loop


PLANT_TZ = ZoneInfo("Asia/Bangkok")  # max_data `time` is naive plant-local


GROWATT_SERVER_TZ = ZoneInfo("Asia/Shanghai")  # env_list `lastUpdateTime` is China time, not plant-local


PAST_DAY_ALARM_TTL_S = 6 * 3600.0  # a closed day's alarm log no longer changes


ALARM_WORKERS = 8  # parallel alarm_data calls for one request (one call per inverter-day)


LIVE_WORKERS = 8  # parallel max_data calls for one plant's latest records (one call per inverter)


SENSOR_DAY_TTL_S = 300.0  # today's env_data records of one sensor (sensor page chart): a new record every 5 min


SWEEP_REFRESH_S = 15.0  # sensor sweep not complete yet: ask again this soon for the next batch


# Per-inverter expiry follows the upload rhythm (see `_latest_ttl`).
DEFAULT_INTERVAL_S = 300.0  # when the interval can't be measured (one record so far)


MIN_INTERVAL_S, MAX_INTERVAL_S = 30.0, 900.0  # measured gaps outside this are outages, not the rhythm


UPLOAD_GRACE_S = 60.0  # a record reaches the Growatt cloud a little after its timestamp


LATE_RETRY_S = 60.0  # next record overdue: check again soon (raised to `device_gap_s` when set)


Ttl = Union[float, Callable[[Any], float]]  # fixed seconds, or computed from the fetched data


# Night mode: outside [first sunrise - margin, last sunset + margin] of the plants concerned,
# nothing changes (power 0, inverters off / PID recovery), so caches last longer.
PLANT_UTC_OFFSET_H = 7.0


DAYLIGHT_MARGIN_S = 1800.0


FALLBACK_COORDS: Tuple[Tuple[float, float], ...] = ((13.7563, 100.5018),)  # Bangkok, when no plant has coordinates


Coords = Sequence[Tuple[float, float]]


@lru_cache(maxsize=256)
def _daylight(day: date, coords: Tuple[Tuple[float, float], ...]) -> Optional[Tuple[datetime, datetime]]:
    """(dawn, dusk) covering every plant in `coords`, margins included; None = no night that day."""
    times = [t for lat, lon in coords if (t := sun_times(day, lat, lon, PLANT_UTC_OFFSET_H))]
    if len(times) < len(coords):
        return None  # a plant without sunrise/sunset: never treat as night
    margin = timedelta(seconds=DAYLIGHT_MARGIN_S)
    return min(r for r, _ in times) - margin, max(s for _, s in times) + margin


class LiveUnavailable(RuntimeError):
    """Growatt failed and there is no cached value to fall back on."""


class _Result:
    __slots__ = ("wall", "data", "stale", "error", "refresh_in")

    def __init__(
        self, wall: datetime, data: Any, stale: bool, error: Optional[str] = None, refresh_in: float = 0.0
    ):
        self.wall, self.data, self.stale, self.error = wall, data, stale, error
        self.refresh_in = refresh_in


class _Sweep:
    """Outcome of one `GrowattLiveService._sweep`: `hits` = {id: (fetched wall time, data, fresh)}."""

    __slots__ = ("hits", "errors", "stats", "stale", "refresh", "wall")

    def __init__(self, hits, errors, stats, stale, refresh, wall):
        self.hits: Dict[str, Tuple[datetime, Any, bool]] = hits
        self.errors: Dict[str, str] = errors
        self.stats: Dict[str, int] = stats
        self.stale: bool = stale
        self.refresh: float = refresh
        self.wall: datetime = wall

    @property
    def error(self) -> Optional[str]:
        return "; ".join(f"{k}: {e}" for k, e in self.errors.items()) or None


class LiveCache:
    """The memory cache (mirrored in Redis when configured), per-key cooldowns and the sweep the
    live features share. `GrowattLiveService` adds the features."""

    def __init__(
        self,
        client_factory: Callable[[int], GrowattClient],
        ttl_s: float = 120.0,
        cooldown_s: float = 60.0,
        clock: Callable[[], float] = time.monotonic,
        latest_ttl_s: Optional[float] = None,
        phases: Sequence[int] = (1,),
        now_local: Callable[[], datetime] = lambda: datetime.now(PLANT_TZ).replace(tzinfo=None),
        night_ttl_s: float = 0.0,
        device_gap_s: float = 0.0,
        sensor_ttl_s: float = 300.0,
        sensor_sweep: int = 12,
        plant_today_ttl_s: float = 300.0,
        plant_today_sweep: int = 40,
        snapshot_ttl_s: float = 300.0,
        snapshot_sweep: int = 4,
        redis: Optional[RedisLink] = None,
    ):
        """`client_factory(phase)` builds the client for one account; `phases` lists the accounts.
        `redis`: mirror the cache and cooldowns in Redis (`live_store`); `clock` must then be a
        wall clock."""
        self._client_factory = client_factory
        self._clients: Dict[int, GrowattClient] = {}
        self.phases: Tuple[int, ...] = tuple(sorted(phases))
        self.ttl_s = ttl_s
        # Upper bound for one inverter's cache: used when it has no record today or has been
        # silent for a while. Normally its records set the expiry (`_latest_ttl`).
        self.latest_ttl_s = latest_ttl_s if latest_ttl_s is not None else ttl_s
        self.cooldown_s = cooldown_s
        self._clock = clock
        self._now_local = now_local
        # Max cache life at night (0 = night mode off); always ends at dawn.
        self.night_ttl_s = night_ttl_s
        # Min seconds between successful max_data calls for one inverter (0 = off).
        self.device_gap_s = device_gap_s
        # Weather-sensor online state: one `env_list` per datalogger, reused this long; at most
        # `sensor_sweep` dataloggers are refreshed per `sensor_status` request.
        self.sensor_ttl_s = sensor_ttl_s
        self.sensor_sweep = max(1, sensor_sweep)
        # Today's energy per plant (`plant/data`, one call per plant): reused this long, at most
        # `plant_today_sweep` plants refreshed per `plant_today` request.
        self.plant_today_ttl_s = plant_today_ttl_s
        self.plant_today_sweep = max(1, plant_today_sweep)
        # Fleet inverter snapshot (`maxs_data`): chunks of SNAPSHOT_CHUNK inverters per account,
        # each reused this long, at most `snapshot_sweep` chunks refreshed per request.
        self.snapshot_ttl_s = snapshot_ttl_s
        self.snapshot_sweep = max(1, snapshot_sweep)
        # key -> (clock_ts, wall_ts, data, ttl_s); memory, mirrored in Redis when configured
        self._cache: TieredDict = cache_map("growatt", redis, ttl_index=3)
        self._key_locks: Dict[Hashable, threading.Lock] = {}
        self._lock = threading.Lock()
        self._cooldown_until: TieredDict = cooldown_map("growatt-cooldown", redis, clock)

    def _get_client(self, phase: int) -> GrowattClient:
        with self._lock:
            if phase not in self._clients:
                self._clients[phase] = self._client_factory(phase)
            return self._clients[phase]

    def resolve_phase(self, phase: Optional[int]) -> int:
        """A plant's account; untagged plants (phase None) use the first configured account."""
        if not self.phases:
            raise LiveUnavailable("no Growatt token configured")
        if phase is None:
            return self.phases[0]
        if phase not in self.phases:
            raise LiveUnavailable(f"no Growatt token configured for phase {phase}")
        return phase

    def _key_lock(self, key: Hashable) -> threading.Lock:
        with self._lock:
            return self._key_locks.setdefault(key, threading.Lock())

    @staticmethod
    def _envelope(r: _Result) -> Dict[str, Any]:
        return {
            "source": "live",
            "fetched_at": r.wall.isoformat(),
            "stale": r.stale,
            "error": r.error,
            "refresh_in_s": max(MIN_REFRESH_S, round(r.refresh_in)),
            "data": r.data,
        }

    def _refresh_in(self, key: Hashable) -> float:
        """Seconds until `key` can give something new: end of its cooldown, else its cache expiry."""
        now = self._clock()
        cooldown = self._cooldown_until.get(key, 0.0) - now
        if cooldown > 0:
            return cooldown
        hit = self._cache.get(key)
        return max(0.0, hit[3] - (now - hit[0])) if hit else 0.0

    def _until_daylight(self, coords: Optional[Coords]) -> float:
        """Seconds until the daylight window of `coords` opens; 0 while it is open."""
        key = tuple((float(a), float(b)) for a, b in (coords or FALLBACK_COORDS))
        now = self._now_local()
        today = _daylight(now.date(), key)
        if today is None or today[0] <= now <= today[1]:
            return 0.0
        if now < today[0]:
            return (today[0] - now).total_seconds()
        tomorrow = _daylight(now.date() + timedelta(days=1), key)
        return (tomorrow[0] - now).total_seconds() if tomorrow else 0.0

    def _night(self, ttl_s: float, coords: Optional[Coords]) -> float:
        """At night, stretch `ttl_s` up to `night_ttl_s`, but never past dawn."""
        if self.night_ttl_s <= 0:
            return ttl_s
        wait = self._until_daylight(coords)
        return max(ttl_s, min(self.night_ttl_s, wait)) if wait > 0 else ttl_s

    def _get(
        self, key: Hashable, fn: Callable[[GrowattClient], Any], ttl: Ttl, phase: int, gap_s: float = 0.0
    ) -> _Result:
        """`gap_s`: Growatt refuses this key until `gap_s` after its last success, so a refused
        call waits at least until then."""
        hit = self._cache.get(key)
        if hit and self._clock() - hit[0] < hit[3]:
            return _Result(hit[1], hit[2], stale=False, refresh_in=self._refresh_in(key))

        # One upstream call per key at a time; concurrent callers wait and reuse its result.
        with self._key_lock(key):
            hit = self._cache.get(key)
            now = self._clock()
            if hit and now - hit[0] < hit[3]:
                return _Result(hit[1], hit[2], stale=False, refresh_in=self._refresh_in(key))

            error: str
            if now < self._cooldown_until.get(key, 0.0):
                error = "Growatt rate limit cooldown"
            else:
                try:
                    data = fn(self._get_client(phase))
                except GrowattAPIError as exc:
                    # Back off this key on any error: 10012 needs it, and an offline device or
                    # network failure would otherwise be retried on every request.
                    until = now + self.cooldown_s
                    if hit:
                        until = max(until, hit[0] + gap_s)
                    self._cooldown_until[key] = until
                    error = str(exc)
                else:
                    wall = datetime.now(timezone.utc)
                    ttl_s = ttl(data) if callable(ttl) else ttl
                    self._cache[key] = (now, wall, data, ttl_s)
                    self._cooldown_until.pop(key, None)
                    return _Result(wall, data, stale=False, refresh_in=ttl_s)

            if hit:
                return _Result(hit[1], hit[2], stale=True, error=error, refresh_in=self._refresh_in(key))
            raise LiveUnavailable(error)

    def _sweep(
        self,
        items: Dict[str, Optional[int]],
        key: Callable[[str], Hashable],
        fetch: Callable[[str], Callable[[GrowattClient], Any]],
        ttl: Ttl,
        batch_n: int,
        idle_ttl_s: float,
    ) -> "_Sweep":
        """Refresh at most `batch_n` of `items` ({id: phase}) whose cache entry has expired (never
        fetched / oldest first, skipping those cooling down), then report every cached one. While
        any item is due, `refresh` is `SWEEP_REFRESH_S`, so a polling page converges on all of
        them; afterwards it is the first expiry / cooldown end."""

        def fresh(i: str, now: float) -> bool:
            hit = self._cache.get(key(i))
            return bool(hit) and now - hit[0] < hit[3]

        def due(now: float) -> List[str]:
            return [i for i in items if not fresh(i, now) and now >= self._cooldown_until.get(key(i), 0.0)]

        def age(i: str, now: float) -> float:
            hit = self._cache.get(key(i))
            return now - hit[0] if hit else float("inf")

        now = self._clock()
        batch = sorted(due(now), key=lambda i: (-age(i, now), i))[: max(1, batch_n)]

        def one(i: str) -> _Result:
            return self._get(key(i), fetch(i), ttl, self.resolve_phase(items[i]))

        errors: Dict[str, str] = {}
        with ThreadPoolExecutor(max_workers=LIVE_WORKERS) as pool:
            futures = [(i, pool.submit(one, i)) for i in batch]
        for i, fut in futures:
            try:
                r = fut.result()
            except LiveUnavailable as exc:
                errors[i] = str(exc)
                continue
            if r.error:
                errors[i] = r.error

        now = self._clock()
        hits: Dict[str, Tuple[datetime, Any, bool]] = {}
        n_fresh = 0
        oldest = 0.0
        stale = False
        for i in items:
            hit = self._cache.get(key(i))
            if hit is None:
                continue
            is_fresh = now - hit[0] < hit[3]
            n_fresh += is_fresh
            stale = stale or (not is_fresh and now < self._cooldown_until.get(key(i), 0.0))  # refresh failed
            oldest = max(oldest, now - hit[0])
            hits[i] = (hit[1], hit[2], is_fresh)

        if due(now):
            refresh = SWEEP_REFRESH_S
        else:  # everything fresh or cooling down: next change is the first expiry / cooldown end
            refresh = min((self._refresh_in(key(i)) for i in items), default=idle_ttl_s)
        walls = [h[0] for h in hits.values()]
        return _Sweep(
            hits=hits,
            errors=errors,
            stats={"fresh": n_fresh, "checked": len(hits), "total": len(items), "oldest_age_s": round(oldest)},
            stale=stale,
            refresh=refresh,
            wall=min(walls) if walls else datetime.now(timezone.utc),
        )
