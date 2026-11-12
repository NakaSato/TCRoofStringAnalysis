"""Realtime Growatt data, held in process memory only.

Nothing here touches SQL or Firestore: realtime values (current power, status, lost flag)
are superseded every few minutes, so persisting them would only burn write quota. The
persisted history comes from `growatt_sync` (5-minute `max_data` records) instead.

Every call returns an envelope::

    {"source": "live", "fetched_at": iso8601, "stale": bool, "error": str | None, "data": ...}

`stale=True` means Growatt failed (offline / rate-limited) and the last good value is served.
"""

from __future__ import annotations

import threading
import time
from datetime import date, datetime, timezone
from functools import lru_cache
from typing import Any, Callable, Dict, Hashable, List, Optional, Sequence, Tuple

from app.config import settings
from solar_core.growatt import GrowattAPIError, GrowattClient, latest_max_record, parse_max_records

RATE_LIMIT_CODE = 10012


class LiveUnavailable(RuntimeError):
    """Growatt failed and there is no cached value to fall back on."""


class _Result:
    __slots__ = ("wall", "data", "stale", "error")

    def __init__(self, wall: datetime, data: Any, stale: bool, error: Optional[str] = None):
        self.wall, self.data, self.stale, self.error = wall, data, stale, error


class GrowattLiveService:
    """TTL cache + single-flight + stale fallback in front of the Growatt client.

    Growatt rate-limits per endpoint *and* per device / plant (error 10012 on a repeat call
    within a few minutes), so cooldowns are tracked per cache key: one refused inverter
    never blocks the others.
    """

    def __init__(
        self,
        client_factory: Callable[[], GrowattClient],
        ttl_s: float = 120.0,
        cooldown_s: float = 60.0,
        clock: Callable[[], float] = time.monotonic,
        latest_ttl_s: Optional[float] = None,
    ):
        self._client_factory = client_factory
        self._client: Optional[GrowattClient] = None
        self.ttl_s = ttl_s
        # max_data records arrive every ~5 min, so polling a device faster gains nothing
        self.latest_ttl_s = latest_ttl_s if latest_ttl_s is not None else ttl_s
        self.cooldown_s = cooldown_s
        self._clock = clock
        # key -> (monotonic_ts, wall_ts, data)
        self._cache: Dict[Hashable, Tuple[float, datetime, Any]] = {}
        self._key_locks: Dict[Hashable, threading.Lock] = {}
        self._lock = threading.Lock()
        self._cooldown_until: Dict[Hashable, float] = {}

    def _get_client(self) -> GrowattClient:
        if self._client is None:
            self._client = self._client_factory()
        return self._client

    def _key_lock(self, key: Hashable) -> threading.Lock:
        with self._lock:
            return self._key_locks.setdefault(key, threading.Lock())

    @staticmethod
    def _envelope(r: _Result) -> Dict[str, Any]:
        return {"source": "live", "fetched_at": r.wall.isoformat(), "stale": r.stale, "error": r.error, "data": r.data}

    def _get(self, key: Hashable, fn: Callable[[GrowattClient], Any], ttl_s: float) -> _Result:
        hit = self._cache.get(key)
        if hit and self._clock() - hit[0] < ttl_s:
            return _Result(hit[1], hit[2], stale=False)

        # One upstream call per key at a time; concurrent callers wait and reuse its result.
        with self._key_lock(key):
            hit = self._cache.get(key)
            now = self._clock()
            if hit and now - hit[0] < ttl_s:
                return _Result(hit[1], hit[2], stale=False)

            error: str
            if now < self._cooldown_until.get(key, 0.0):
                error = "Growatt rate limit cooldown"
            else:
                try:
                    data = fn(self._get_client())
                except GrowattAPIError as exc:
                    # Back off this key on any error: 10012 needs it, and an offline device or
                    # network failure would otherwise be retried on every request.
                    self._cooldown_until[key] = now + self.cooldown_s
                    error = str(exc)
                else:
                    wall = datetime.now(timezone.utc)
                    self._cache[key] = (now, wall, data)
                    self._cooldown_until.pop(key, None)
                    return _Result(wall, data, stale=False)

            if hit:
                return _Result(hit[1], hit[2], stale=True, error=error)
            raise LiveUnavailable(error)

    def _fetch(self, key: Hashable, fn: Callable[[GrowattClient], Any]) -> Dict[str, Any]:
        return self._envelope(self._get(key, fn, self.ttl_s))

    def plants(self) -> Dict[str, Any]:
        def fn(client: GrowattClient) -> list:
            return [
                {
                    "plant_id": int(p["plant_id"]),
                    "name": p.get("name"),
                    "current_power_w": _f(p.get("current_power")),
                    "total_energy_kwh": _f(p.get("total_energy")),
                    "peak_power_kwp": _f(p.get("peak_power")),
                    "status": p.get("status"),
                }
                for p in client.list_plants(refresh=True)
            ]

        return self._fetch(("plants",), fn)

    def inverters(self, plant_id: int) -> Dict[str, Any]:
        return self._fetch(("inverters", plant_id), lambda c: c.list_inverters(plant_id, refresh=True))

    def plant_latest(self, plant_id: int, device_sns: Sequence[str], day: date) -> Dict[str, Any]:
        """Newest record per inverter of one plant: power, MPPT and per-string V/I. Not persisted.

        Each inverter is cached separately (`latest_ttl_s`, default 300 s = one upload period),
        so a refused inverter falls back to its own last value (`stale: true` on that item)
        while the others stay fresh. The envelope is `stale` only when no inverter is fresh.
        """
        inverters: List[Dict[str, Any]] = []
        errors: Dict[str, str] = {}
        fresh_walls: List[datetime] = []
        all_walls: List[datetime] = []

        for sn in device_sns:
            try:
                r = self._get(("latest", sn, day), lambda c, sn=sn: _latest_row(c, sn, day), self.latest_ttl_s)
            except LiveUnavailable as exc:
                errors[sn] = str(exc)
                continue
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
            )
        )


def _latest_row(client: GrowattClient, sn: str, day: date) -> Optional[Dict[str, Any]]:
    rec = latest_max_record(client, sn, day)
    if rec is None:
        return None
    inv_rows, str_rows = parse_max_records(sn, [rec])
    row = inv_rows[0]
    return {
        "device_sn": sn,
        "timestamp": row["timestamp"].strftime("%Y-%m-%d %H:%M:%S"),  # plant-local
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


def _f(v: Any) -> Optional[float]:
    try:
        return None if v is None or v == "" else float(v)
    except (TypeError, ValueError):
        return None


@lru_cache(maxsize=1)
def get_live_service() -> GrowattLiveService:
    return GrowattLiveService(
        client_factory=lambda: GrowattClient(token=settings.growatt_api_token, base_url=settings.growatt_base_url),
        ttl_s=settings.growatt_live_ttl_s,
        latest_ttl_s=settings.growatt_live_latest_ttl_s,
    )
