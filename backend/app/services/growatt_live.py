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
import time
from datetime import date, datetime, timedelta, timezone
from functools import lru_cache
from typing import Any, Callable, Dict, Hashable, List, Optional, Sequence, Tuple, Union
from zoneinfo import ZoneInfo

from app.config import settings
from solar_core.growatt import GrowattAPIError, GrowattClient, newest_max_records, parse_max_records
from solar_core.sun import sun_times

RATE_LIMIT_CODE = 10012
MIN_REFRESH_S = 15  # floor for refresh_in_s, so an expired key never invites a tight loop
PLANT_TZ = ZoneInfo("Asia/Bangkok")  # max_data `time` is naive plant-local

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
    ):
        """`client_factory(phase)` builds the client for one account; `phases` lists the accounts."""
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
        # key -> (monotonic_ts, wall_ts, data, ttl_s)
        self._cache: Dict[Hashable, Tuple[float, datetime, Any, float]] = {}
        self._key_locks: Dict[Hashable, threading.Lock] = {}
        self._lock = threading.Lock()
        self._cooldown_until: Dict[Hashable, float] = {}

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
        for phase in self.phases:
            key = ("plants", phase)
            try:
                r = self._get(key, lambda c, phase=phase: fn(c, phase), ttl, phase)
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

        for sn in device_sns:
            key = ("latest", sn, day)
            try:
                r = self._get(key, lambda c, sn=sn: _latest_row(c, sn, day), ttl, ph, gap_s=self.device_gap_s)
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


def _latest_row(client: GrowattClient, sn: str, day: date) -> Optional[Dict[str, Any]]:
    recs = newest_max_records(client, sn, day, n=2)
    if not recs:
        return None
    inv_rows, str_rows = parse_max_records(sn, recs[:1])
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
        "strings": [
            {k: r[k] for k in ("string_no", "mppt_no", "voltage_v", "current_a", "power_w")} for r in str_rows
        ],
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
    return GrowattLiveService(
        client_factory=lambda phase: GrowattClient(token=accounts[phase], base_url=settings.growatt_base_url),
        ttl_s=settings.growatt_live_ttl_s,
        latest_ttl_s=settings.growatt_live_latest_ttl_s,
        night_ttl_s=settings.growatt_live_night_ttl_s,
        device_gap_s=settings.growatt_live_device_gap_s,
        phases=tuple(accounts),
    )
