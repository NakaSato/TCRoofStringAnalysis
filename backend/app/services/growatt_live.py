"""Realtime Growatt data, held in process memory only.

Nothing here touches SQL or Firestore: realtime values (current power, status, lost flag)
are superseded every few minutes, so persisting them would only burn write quota. The
persisted history comes from `growatt_sync` (5-minute `max_data` records) instead.

Every call returns an envelope::

    {"source": "live", "fetched_at": iso8601, "stale": bool, "error": str | None,
     "refresh_in_s": int, "data": ...}

`stale=True` means Growatt failed (offline / rate-limited) and the last good value is served.
`refresh_in_s` is how long until asking again can return anything new (cache expiry or the
end of a cooldown), so clients poll when data can change instead of on a fixed timer. It is
relative, not a timestamp, so client clock skew does not matter.

Each project phase is its own Growatt account and token. Plant-level calls use the token of the
plant's phase; `plants()` asks every account and merges the lists (tagged with `phase`).
"""

from __future__ import annotations

import threading
from concurrent.futures import ThreadPoolExecutor
import time
from datetime import date, datetime, timedelta, timezone
from functools import lru_cache
from typing import Any, Callable, Dict, Hashable, List, Optional, Sequence, Tuple, Union
from zoneinfo import ZoneInfo

from app.config import settings
from app.services.live_store import RedisLink, TieredDict, cache_map, cooldown_map, redis_link
from solar_core.growatt import (
    ENV_FIELDS,
    GrowattAPIError,
    GrowattClient,
    newest_max_records,
    parse_env_records,
    parse_max_diagnostics,
    parse_max_grid,
    parse_max_mppt_energy,
    parse_max_records,
)
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


class GrowattLiveService:
    """TTL cache + single-flight + stale fallback in front of the Growatt client.

    Growatt rate-limits per endpoint *and* per device / plant (error 10012 on a repeat call
    within a few minutes), so cooldowns are tracked per cache key: one refused inverter
    never blocks the others. `max_data` answers each inverter about once per 4-4.5 min
    (measured 2026-11-12; refused calls do not restart the wait), so `device_gap_s` keeps
    successful per-inverter calls at least that far apart.
    """

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

    def plants(self, coords: Optional[Coords] = None) -> Dict[str, Any]:
        """Realtime plant list from every account, merged. Each account is cached separately,
        so one failing account serves its last value (or is missing) while the others stay fresh.
        The envelope is `stale` when any account is stale or missing; raises only when all fail.
        `coords` = the fleet's plant locations (night mode)."""
        ttl = lambda _data: self._night(self.ttl_s, coords)

        def fn(client: GrowattClient, phase: int) -> list:
            return [
                {
                    "plant_id": int(p["plant_id"]),
                    "phase": phase,
                    "name": p.get("name"),
                    "current_power_w": _f(p.get("current_power")),
                    "total_energy_kwh": _f(p.get("total_energy")),
                    "peak_power_kwp": _f(p.get("peak_power")),
                    "status": p.get("status"),
                }
                for p in client.list_plants(refresh=True)
            ]

        if not self.phases:
            raise LiveUnavailable("no Growatt token configured")
        data: List[Dict[str, Any]] = []
        errors: Dict[str, str] = {}
        walls: List[datetime] = []
        refresh: List[float] = []
        stale = False
        # one account per thread: a cold cache costs the slowest account, not their sum
        with ThreadPoolExecutor(max_workers=len(self.phases)) as pool:
            futures = [
                (phase, pool.submit(self._get, ("plants", phase), lambda c, phase=phase: fn(c, phase), ttl, phase))
                for phase in self.phases
            ]
        for phase, fut in futures:
            key = ("plants", phase)
            try:
                r = fut.result()
            except LiveUnavailable as exc:
                errors[f"phase {phase}"] = str(exc)
                stale = True
                refresh.append(self._refresh_in(key))
                continue
            refresh.append(r.refresh_in)
            data.extend(r.data)
            walls.append(r.wall)
            stale = stale or r.stale
            if r.error:
                errors[f"phase {phase}"] = r.error
        if not walls:
            raise LiveUnavailable("; ".join(f"{k}: {e}" for k, e in errors.items()))
        error = "; ".join(f"{k}: {e}" for k, e in errors.items()) or None
        # oldest account fetch = how fresh the merged list is at worst
        # ask again as soon as any account can change
        return self._envelope(_Result(min(walls), data, stale=stale, error=error, refresh_in=min(refresh)))

    def inverters(self, plant_id: int, phase: Optional[int] = None, coords: Optional[Coords] = None) -> Dict[str, Any]:
        ph = self.resolve_phase(phase)
        ttl = lambda _data: self._night(self.ttl_s, coords)
        r = self._get(("inverters", ph, plant_id), lambda c: c.list_inverters(plant_id, refresh=True), ttl, ph)
        return self._envelope(r)

    def _latest_ttl(self, row: Optional[Dict[str, Any]]) -> float:
        """Cache one inverter's newest record until its next record should be on Growatt.

        Next record due = record time + measured upload interval + grace. Fetching earlier
        would return the same record; fetching on a fixed timer shows an old record for up to
        a whole TTL after the new one lands. Overdue by less than two intervals (a late
        upload): check every `LATE_RETRY_S`. Silent for longer (offline, evening) or no record
        today: fall back to `latest_ttl_s` instead of polling a quiet device every minute.
        """
        if row is None:
            return self.latest_ttl_s
        try:
            ts = datetime.strptime(row["timestamp"], "%Y-%m-%d %H:%M:%S")
        except (KeyError, TypeError, ValueError):
            return self.latest_ttl_s
        interval = row.get("interval_s")
        if interval is None or not MIN_INTERVAL_S <= interval <= MAX_INTERVAL_S:
            interval = DEFAULT_INTERVAL_S
        left = (ts - self._now_local()).total_seconds() + interval + UPLOAD_GRACE_S
        if left > 0:
            return min(left, interval + UPLOAD_GRACE_S)  # cap: record time ahead of our clock
        if -left < 2 * interval:
            return LATE_RETRY_S
        return self.latest_ttl_s

    def plant_latest(
        self,
        plant_id: int,
        device_sns: Sequence[str],
        day: date,
        phase: Optional[int] = None,
        coords: Optional[Coords] = None,
    ) -> Dict[str, Any]:
        """Newest record per inverter of one plant: power, MPPT and per-string V/I. Not persisted.

        Each inverter is cached separately, until its next record is due (`_latest_ttl`),
        so a refused inverter falls back to its own last value (`stale: true` on that item)
        while the others stay fresh. The envelope is `stale` only when no inverter is fresh.
        """
        ph = self.resolve_phase(phase)
        # never ask before Growatt would answer: >= device_gap_s since the last success
        ttl = lambda row: self._night(max(self.device_gap_s, self._latest_ttl(row)), coords)
        inverters: List[Dict[str, Any]] = []
        errors: Dict[str, str] = {}
        fresh_walls: List[datetime] = []
        all_walls: List[datetime] = []
        refresh: List[float] = []

        def one(sn: str) -> _Result:
            return self._get(("latest", sn, day), lambda c: _latest_row(c, sn, day), ttl, ph, gap_s=self.device_gap_s)

        # Cold cache = one max_data call per inverter: fetch them in parallel (a 17-inverter plant
        # otherwise waits for 17 Growatt round trips in a row). Per-key locks keep it one call per key.
        with ThreadPoolExecutor(max_workers=LIVE_WORKERS) as pool:
            futures = [(sn, pool.submit(one, sn)) for sn in device_sns]

        for sn, fut in futures:
            key = ("latest", sn, day)
            try:
                r = fut.result()
            except LiveUnavailable as exc:
                errors[sn] = str(exc)
                refresh.append(self._refresh_in(key))
                continue
            refresh.append(r.refresh_in)
            all_walls.append(r.wall)
            if r.error:
                errors[sn] = r.error
            if not r.stale:
                fresh_walls.append(r.wall)
            if r.data is not None:  # None = no record today (offline inverter)
                inverters.append({**r.data, "stale": r.stale, "fetched_at": r.wall.isoformat()})

        if not all_walls:
            raise LiveUnavailable("; ".join(f"{sn}: {e}" for sn, e in errors.items()) or "no inverters")
        stale = not fresh_walls
        return self._envelope(
            _Result(
                max(fresh_walls or all_walls),
                {"plant_id": plant_id, "day": day.isoformat(), "inverters": inverters, "errors": errors},
                stale=stale,
                error="; ".join(f"{sn}: {e}" for sn, e in errors.items()) or None,
                refresh_in=min(refresh),  # as soon as any inverter can change
            )
        )

    def plant_weather(
        self,
        plant_id: int,
        sensors: Sequence[Tuple[str, int, Optional[Sequence[str]]]],
        phase: Optional[int] = None,
        coords: Optional[Coords] = None,
    ) -> Dict[str, Any]:
        """Newest weather-sensor record per sensor of one plant (`env_last_data`). Not persisted.

        `sensors` = (datalogger_sn, address, measured fields or None). Fields outside
        `measured` (probes that read only 0 in the stored history) are returned as null.
        Each sensor is cached until its next 5-minute record is due, like `plant_latest`.
        """
        ph = self.resolve_phase(phase)
        ttl = lambda row: self._night(max(self.device_gap_s, self._latest_ttl(row)), coords)
        out: List[Dict[str, Any]] = []
        errors: Dict[str, str] = {}
        fresh_walls: List[datetime] = []
        all_walls: List[datetime] = []
        refresh: List[float] = []
        for dl, addr, measured in sensors:
            key = ("env", dl, addr)
            label = f"{dl}/{addr}"
            try:
                r = self._get(key, self._env_fetch(key, dl, addr), ttl, ph, gap_s=self.device_gap_s)
            except LiveUnavailable as exc:
                errors[label] = str(exc)
                refresh.append(self._refresh_in(key))
                continue
            refresh.append(r.refresh_in)
            all_walls.append(r.wall)
            if r.error:
                errors[label] = r.error
            if not r.stale:
                fresh_walls.append(r.wall)
            if r.data is not None:
                row = dict(r.data)
                if measured is not None:
                    for col in ENV_FIELDS.values():
                        if col not in measured:
                            row[col] = None
                row.pop("raw", None)  # the full record is only for the sensor Info view (`sensor_live`)
                out.append({**row, "stale": r.stale, "fetched_at": r.wall.isoformat()})
        if not all_walls:
            raise LiveUnavailable("; ".join(f"{k}: {e}" for k, e in errors.items()) or "no weather sensors")
        return self._envelope(
            _Result(
                max(fresh_walls or all_walls),
                {"plant_id": plant_id, "sensors": out, "errors": errors},
                stale=not fresh_walls,
                error="; ".join(f"{k}: {e}" for k, e in errors.items()) or None,
                refresh_in=min(refresh),
            )
        )

    def _env_fetch(self, key: Hashable, datalogger_sn: str, address: int) -> Callable[[GrowattClient], Any]:
        """`env_last_data` for one sensor, with `interval_s` measured from the record cached
        before it (memory / Redis only): `env_last_data` returns one record, so the gap between
        two different record times is the sensor's upload rhythm. A refetch of the same record
        keeps the interval already measured; the first record has none (`_latest_ttl` uses
        `DEFAULT_INTERVAL_S`). Gaps outside `MIN_INTERVAL_S`..`MAX_INTERVAL_S` are outages, not
        the rhythm, and are not used."""

        def fetch(client: GrowattClient) -> Optional[Dict[str, Any]]:
            row = _env_row(client, datalogger_sn, address)
            hit = self._cache.get(key)
            prev = hit[2] if hit else None
            if row is not None and isinstance(prev, dict):
                row["interval_s"] = _record_gap(prev, row)
            return row

        return fetch

    def sensor_status(
        self, dataloggers: Sequence[Tuple[str, Optional[int]]], coords: Optional[Coords] = None
    ) -> Dict[str, Any]:
        """Online state (`lost`, `lastUpdateTime`) of the weather sensors on `dataloggers`
        ((datalogger_sn, plant phase)), from `env_list`. Not persisted.

        One call per datalogger, so the fleet (~231) is swept incrementally: each request refreshes
        at most `sensor_sweep` dataloggers whose entry has expired, never fetched / oldest first,
        and serves the rest from memory. While some are not fresh, `refresh_in_s` is
        `SWEEP_REFRESH_S`, so a polling page converges on the whole fleet in a few minutes and
        then refreshes each datalogger about every `sensor_ttl_s`. A datalogger never fetched is
        absent from `data.dataloggers` (status unknown). The cache is shared by every user.
        """
        if not self.phases:
            raise LiveUnavailable("no Growatt token configured")
        ttl = lambda _rows: self._night(self.sensor_ttl_s, coords)
        sw = self._sweep(
            dict(dataloggers),
            lambda dl: ("envlist", dl),
            lambda dl: (lambda c: _env_status_rows(c, dl)),
            ttl,
            self.sensor_sweep,
            self.sensor_ttl_s,
        )
        out = {
            dl: {"fetched_at": wall.isoformat(), "stale": not fresh, "sensors": data}
            for dl, (wall, data, fresh) in sw.hits.items()
        }
        return self._envelope(
            _Result(
                sw.wall,
                {"dataloggers": out, "errors": sw.errors, "sweep": sw.stats},
                stale=sw.stale,
                error=sw.error,
                refresh_in=sw.refresh,
            )
        )

    def plant_today(self, plants: Sequence[Tuple[int, Optional[int]]], coords: Optional[Coords] = None) -> Dict[str, Any]:
        """Today's energy of each plant in `plants` ((plant_id, phase)) from `plant/data`, the
        only plant-level source of it (`plant/list` has none). Not persisted.

        One call per plant, so the fleet is swept like `sensor_status`: at most
        `plant_today_sweep` expired plants per request, oldest first, the rest from memory;
        each plant is reused for `plant_today_ttl_s` (night-stretched). `data.plants[id]`:
        `today_energy_kwh` is null when the plant's last upload is not from today (judged at
        request time, so a value cached before midnight never counts as today's).
        """
        if not self.phases:
            raise LiveUnavailable("no Growatt token configured")
        ttl = lambda _row: self._night(self.plant_today_ttl_s, coords)
        sw = self._sweep(
            {str(pid): ph for pid, ph in plants},
            lambda pid: ("pdata", pid),
            lambda pid: (lambda c: _plant_data_row(c, int(pid))),
            ttl,
            self.plant_today_sweep,
            self.plant_today_ttl_s,
        )
        today = self._now_local().date().isoformat()
        out: Dict[str, Dict[str, Any]] = {}
        for pid, (wall, row, fresh) in sw.hits.items():
            upd = row.get("last_update_time")
            is_today = bool(upd) and upd[:10] == today
            out[pid] = {
                "fetched_at": wall.isoformat(),
                "stale": not fresh,
                "last_update_time": upd,
                "today_energy_kwh": row.get("today_energy_kwh") if is_today else None,
            }
        return self._envelope(
            _Result(
                sw.wall,
                {"day": today, "plants": out, "errors": sw.errors, "sweep": sw.stats},
                stale=sw.stale,
                error=sw.error,
                refresh_in=sw.refresh,
            )
        )

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

    def sensor_live(
        self,
        datalogger_sn: str,
        address: int,
        phase: Optional[int] = None,
        measured: Optional[Sequence[str]] = None,
        coords: Optional[Coords] = None,
    ) -> Dict[str, Any]:
        """One weather sensor for its Info view: online state from its datalogger's `env_list`
        (the same shared cache as the fleet sweep, refreshed here if expired) and its newest
        `env_last_data` record (the same cache as `plant_weather`, so the two never double the
        calls). Not persisted. Fields outside `measured` are null in `reading`; `raw` is the
        record as Growatt reported it. Raises LiveUnavailable only when both parts fail.
        """
        ph = self.resolve_phase(phase)
        errors: Dict[str, str] = {}

        status_env: Optional[Dict[str, Any]] = None
        try:
            status_env = self.sensor_status([(datalogger_sn, phase)], coords=coords)
        except LiveUnavailable as exc:
            errors["status"] = str(exc)
        entry = status_env["data"]["dataloggers"].get(datalogger_sn) if status_env else None
        if status_env and status_env["data"]["errors"]:
            errors["status"] = "; ".join(status_env["data"]["errors"].values())

        key = ("env", datalogger_sn, address)
        ttl = lambda row: self._night(max(self.device_gap_s, self._latest_ttl(row)), coords)
        reading: Optional[Dict[str, Any]] = None
        raw: Optional[Dict[str, Any]] = None
        r: Optional[_Result] = None
        try:
            r = self._get(key, self._env_fetch(key, datalogger_sn, address), ttl, ph, gap_s=self.device_gap_s)
        except LiveUnavailable as exc:
            errors["reading"] = str(exc)
        if r is not None:
            if r.error:
                errors["reading"] = r.error
            if r.data is not None:
                row = dict(r.data)
                raw = row.pop("raw", None)
                if measured is not None:
                    for col in ENV_FIELDS.values():
                        if col not in measured:
                            row[col] = None
                reading = {**row, "stale": r.stale, "fetched_at": r.wall.isoformat()}

        if r is None and entry is None:
            raise LiveUnavailable("; ".join(f"{k}: {e}" for k, e in errors.items()) or "sensor unavailable")
        refresh = [x for x in (r.refresh_in if r else None, status_env["refresh_in_s"] if status_env else None) if x is not None]
        walls = [w for w in (r.wall if r else None,) if w is not None]
        if entry:
            walls.append(datetime.fromisoformat(entry["fetched_at"]))
        return self._envelope(
            _Result(
                min(walls),
                {
                # this datalogger's `env_list` entry ({fetched_at, stale, sensors}); None = not checked
                "datalogger": entry,
                    "reading": reading,
                    "raw": raw,
                    "errors": errors,
                },
                stale=bool((r is not None and r.stale) or (entry is not None and entry["stale"])),
                error="; ".join(f"{k}: {e}" for k, e in errors.items()) or None,
                refresh_in=min(refresh) if refresh else self.sensor_ttl_s,
            )
        )

    def sensor_today(
        self, datalogger_sn: str, address: int, phase: Optional[int] = None, coords: Optional[Coords] = None
    ) -> Dict[str, Any]:
        """Today's 5-minute records of one weather sensor straight from Growatt (`env_data`, today
        only), so the sensor page's chart is complete between the worker's syncs. Memory / Redis
        only, never written to SQL. Cached `SENSOR_DAY_TTL_S` (a new record every 5 min),
        stretched at night.

        `data.series` = [{timestamp (5-min slot, plant-local), <field>: value}], oldest first. As
        in the stored day series, a probe that reads 0 in every record today is not fitted, so it
        is null and missing from `data.measured`.
        """
        ph = self.resolve_phase(phase)
        day = self._now_local().date()
        key = ("envday", datalogger_sn, address, day.isoformat())
        ttl = lambda _rows: self._night(max(self.device_gap_s, SENSOR_DAY_TTL_S), coords)

        def fetch(client: GrowattClient) -> List[Dict[str, Any]]:
            rows = parse_env_records(datalogger_sn, address, client.env_history(datalogger_sn, address, day, day))
            out: Dict[str, Dict[str, Any]] = {}
            for r in sorted(rows, key=lambda r: r["timestamp"]):
                ts: datetime = r["timestamp"]
                if ts.date() != day:
                    continue
                slot = ts.replace(minute=ts.minute - ts.minute % 5, second=0, microsecond=0)
                out[slot.strftime("%Y-%m-%d %H:%M:%S")] = {col: r[col] for col in ENV_FIELDS.values()}  # newest in a slot wins
            return [{"timestamp": t, **v} for t, v in sorted(out.items())]

        r = self._get(key, fetch, ttl, ph, gap_s=self.device_gap_s)
        cols = list(ENV_FIELDS.values())
        measured = [c for c in cols if any((p[c] or 0) != 0 for p in r.data)]
        series = [{"timestamp": p["timestamp"], **{c: (p[c] if c in measured else None) for c in cols}} for p in r.data]
        return self._envelope(
            _Result(
                r.wall,
                {"day": day.isoformat(), "measured": measured, "series": series},
                stale=r.stale,
                error=r.error,
                refresh_in=r.refresh_in,
            )
        )

    def plant_alarms(
        self,
        plant_id: int,
        device_sns: Sequence[str],
        days: Sequence[date],
        phase: Optional[int] = None,
        coords: Optional[Coords] = None,
    ) -> Dict[str, Any]:
        """Growatt alarm / fault log of one plant's inverters over `days` (`device/max/alarm_data`
        answers one inverter-day per call). Newest alarm first.

        Held in memory like every live value (never written to SQL or Firestore). Each
        inverter-day is cached separately: a past day cannot change, so it is kept
        `PAST_DAY_ALARM_TTL_S`; today's log is refreshed every `ttl_s` (stretched at night).
        Calls run in a small thread pool; per-key locks keep them single-flight.
        """
        ph = self.resolve_phase(phase)
        today = self._now_local().date()
        keys = [(sn, d) for d in sorted(set(days)) for sn in device_sns]

        def one(sn: str, d: date) -> _Result:
            ttl: Ttl = PAST_DAY_ALARM_TTL_S if d < today else (lambda _x: self._night(self.ttl_s, coords))
            return self._get(
                ("alarms", sn, d), lambda c: [_alarm_row(sn, a) for a in c.max_alarms(sn, d)], ttl, ph
            )

        results: Dict[Tuple[str, date], Union[_Result, LiveUnavailable]] = {}
        with ThreadPoolExecutor(max_workers=ALARM_WORKERS) as pool:
            futures = {pool.submit(one, sn, d): (sn, d) for sn, d in keys}
            for fut, k in futures.items():
                try:
                    results[k] = fut.result()
                except LiveUnavailable as exc:
                    results[k] = exc

        alarms: List[Dict[str, Any]] = []
        errors: Dict[str, str] = {}
        fresh_walls: List[datetime] = []
        all_walls: List[datetime] = []
        refresh: List[float] = []
        for (sn, d), r in results.items():
            label = f"{sn} {d.isoformat()}"
            if isinstance(r, LiveUnavailable):
                errors[label] = str(r)
                refresh.append(self._refresh_in(("alarms", sn, d)))
                continue
            refresh.append(r.refresh_in)
            all_walls.append(r.wall)
            if r.error:
                errors[label] = r.error
            if not r.stale:
                fresh_walls.append(r.wall)
            alarms.extend(r.data)
        if not all_walls:
            raise LiveUnavailable("; ".join(f"{k}: {e}" for k, e in errors.items()) or "no inverters")
        alarms.sort(key=lambda a: a["start_time"] or "", reverse=True)
        ds = sorted(set(days))
        return self._envelope(
            _Result(
                min(all_walls),
                {
                    "plant_id": plant_id,
                    "from": ds[0].isoformat(),
                    "to": ds[-1].isoformat(),
                    "alarms": alarms,
                    "errors": errors,
                },
                stale=not fresh_walls,
                error="; ".join(f"{k}: {e}" for k, e in errors.items()) or None,
                refresh_in=min(refresh),
            )
        )

def _alarm_row(sn: str, a: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "device_sn": sn,
        "start_time": a.get("start_time") or None,  # plant-local
        "end_time": a.get("end_time") or None,
        "alarm_code": a.get("alarm_code"),
        "alarm_message": a.get("alarm_message") or None,
        "fault_type": a.get("fault_type") or None,
        "status": a.get("status"),
    }


def _plant_data_row(client: GrowattClient, plant_id: int) -> Dict[str, Any]:
    """The `plant/data` fields the plant directory uses; `last_update_time` is plant-local."""
    d = client.plant_data(plant_id)
    upd = d.get("last_update_time")
    return {
        "today_energy_kwh": _f(d.get("today_energy")),
        "last_update_time": str(upd) if upd else None,
    }


def _env_row(client: GrowattClient, datalogger_sn: str, address: int) -> Optional[Dict[str, Any]]:
    rec = client.env_latest(datalogger_sn, address)
    if rec is None:
        return None
    return {
        "datalogger_sn": datalogger_sn,
        "address": address,
        "timestamp": str(rec.get("timeText")),  # plant-local
        "interval_s": None,  # set by `_env_fetch` from the previously cached record
        **{col: _f(rec.get(key)) for key, col in ENV_FIELDS.items()},
        # the record as reported, for the sensor Info view's "Raw record" (admin only; memory only)
        "raw": {str(k): v for k, v in rec.items() if isinstance(v, (str, int, float, bool)) or v is None},
    }


def _record_gap(prev: Dict[str, Any], row: Dict[str, Any]) -> Optional[float]:
    """Seconds between two consecutive records of one sensor (`interval_s`)."""
    try:
        a = datetime.strptime(str(prev["timestamp"]), "%Y-%m-%d %H:%M:%S")
        b = datetime.strptime(str(row["timestamp"]), "%Y-%m-%d %H:%M:%S")
    except (KeyError, TypeError, ValueError):
        return None
    gap = (b - a).total_seconds()
    if gap < 0:  # an older record than the cached one: Growatt glitch, measure again next time
        return None
    if MIN_INTERVAL_S <= gap <= MAX_INTERVAL_S:
        return gap
    return prev.get("interval_s")  # same record, or an outage gap: keep the rhythm already measured


def _env_status_rows(client: GrowattClient, datalogger_sn: str) -> List[Dict[str, Any]]:
    """`env_list` → [{address, lost, last_update_time}]: realtime, never stored."""
    rows: List[Dict[str, Any]] = []
    for e in client.list_env_sensors(datalogger_sn, refresh=True):
        try:
            addr = int(str(e.get("address")))
        except ValueError:
            continue
        rows.append({"address": addr, "lost": _flag(e.get("lost")), "last_update_time": _local_ts(e.get("lastUpdateTime"))})
    return rows


def _flag(v: Any) -> Optional[bool]:
    t = str(v).strip().lower()
    return True if t in ("1", "true") else False if t in ("0", "false") else None


def _local_ts(v: Any) -> Optional[str]:
    """`env_list`'s `lastUpdateTime` → plant-local "YYYY-MM-DD HH:MM:SS"; else None.

    Unlike `timeText`, Growatt gives this one in China time (UTC+8, checked 2026-11-13: one hour
    ahead of the same upload's `timeText` at every sensor sampled), so it is converted to Bangkok.
    """
    try:
        at = datetime.strptime(str(v)[:19], "%Y-%m-%d %H:%M:%S")
    except ValueError:
        return None
    return at.replace(tzinfo=GROWATT_SERVER_TZ).astimezone(PLANT_TZ).strftime("%Y-%m-%d %H:%M:%S")


PREVIOUS_RECORDS = 5  # with the newest: 6 records ≈ 30 min a string fault must last


def _latest_row(client: GrowattClient, sn: str, day: date) -> Optional[Dict[str, Any]]:
    # same single call either way (first page = 100 records); the older ones let the live string
    # check require a fault to persist instead of flagging one passing cloud shadow
    recs = newest_max_records(client, sn, day, n=1 + PREVIOUS_RECORDS)
    if not recs:
        return None
    inv_rows, str_rows = parse_max_records(sn, recs[:1])
    previous = []
    for rec in recs[1:]:
        _, older = parse_max_records(sn, [rec])
        ts = _record_ts(rec)
        previous.append({
            "timestamp": ts.strftime("%Y-%m-%d %H:%M:%S") if ts else None,
            "strings": [{k: r[k] for k in ("string_no", "voltage_v", "current_a")} for r in older],
        })
    row = inv_rows[0]
    prev = _record_ts(recs[1]) if len(recs) > 1 else None
    return {
        "device_sn": sn,
        "timestamp": row["timestamp"].strftime("%Y-%m-%d %H:%M:%S"),  # plant-local
        # gap to the previous record (Growatt timestamps); sets when the next one is due
        "interval_s": (row["timestamp"] - prev).total_seconds() if prev else None,
        "status": row["status"],
        "pac_w": row["pac_w"],
        "ppv_w": row["ppv_w"],
        "eac_today_kwh": row["eac_today_kwh"],
        "temperature_c": row["temperature_c"],
        "fac_hz": row["fac_hz"],
        "mppt": row["mppt_json"],
        "grid": parse_max_grid(recs[0]),
        "diagnostics": parse_max_diagnostics(recs[0]),
        "mppt_energy": parse_max_mppt_energy(recs[0]),
        "strings": [
            {k: r[k] for k in ("string_no", "mppt_no", "voltage_v", "current_a", "power_w")} for r in str_rows
        ],
        # older records, newest first: input to the live string check only (the route drops it)
        "previous_strings": previous,
    }


def _record_ts(rec: Dict[str, Any]) -> Optional[datetime]:
    try:
        return datetime.strptime(str(rec.get("time")), "%Y-%m-%d %H:%M:%S")
    except ValueError:
        return None


def _f(v: Any) -> Optional[float]:
    try:
        return None if v is None or v == "" else float(v)
    except (TypeError, ValueError):
        return None


@lru_cache(maxsize=1)
def get_live_service() -> GrowattLiveService:
    accounts = settings.growatt_accounts()  # {phase: token}; tokens never leave the backend
    link = redis_link(settings.redis_url)
    return GrowattLiveService(
        # cached timestamps outlive the process in Redis: a wall clock, not monotonic
        clock=time.time if link else time.monotonic,
        redis=link,
        client_factory=lambda phase: GrowattClient(token=accounts[phase], base_url=settings.growatt_base_url),
        ttl_s=settings.growatt_live_ttl_s,
        latest_ttl_s=settings.growatt_live_latest_ttl_s,
        night_ttl_s=settings.growatt_live_night_ttl_s,
        device_gap_s=settings.growatt_live_device_gap_s,
        sensor_ttl_s=settings.sensor_status_ttl_s,
        sensor_sweep=settings.sensor_sweep_per_request,
        plant_today_ttl_s=settings.plant_today_ttl_s,
        plant_today_sweep=settings.plant_today_sweep_per_request,
        phases=tuple(accounts),
    )
