"""Memory cache for live values, optionally mirrored in Redis (no persistence).

The live services (`growatt_live`, `google_weather` current conditions) keep their cache and
per-key cooldowns in dicts. With `REDIS_URL` set, those dicts are `TieredDict`s: the process
dict stays the first level, and every write also goes to Redis on the `tcroof-db` VM, so a
Cloud Run cold start or a deploy finds the cache and the Growatt rate-limit back-offs already
warm instead of calling Growatt / Google again.

Rules this keeps (root CLAUDE.md "Never store realtime values"):
- Redis runs with **no persistence** (`--save "" --appendonly no`): a Redis restart empties it,
  like a process restart empties the dicts. Nothing reaches SQL, Firestore or disk.
- Every key expires: a cache entry `STALE_KEEP_S` after its own TTL (that hour only serves the
  "last value, marked stale" fallback), a cooldown when it ends.
- Values are JSON (never pickle), so nothing read back from Redis can execute code.
- Redis is optional and never fatal: on any Redis error the store carries on memory-only and
  retries the connection after `RETRY_S`.

With Redis on, the services must use a wall clock (`time.time`): cached timestamps outlive the
process, and `time.monotonic` restarts at zero in every process.
"""

from __future__ import annotations

import json
import logging
import threading
import time
from datetime import date, datetime
from typing import Any, Callable, Dict, Hashable, Optional

log = logging.getLogger(__name__)

STALE_KEEP_S = 3600.0  # a cache entry stays in Redis this long after its TTL (stale fallback)
COOLDOWN_SLACK_S = 5.0
RETRY_S = 30.0  # after a Redis error, memory-only for this long
TIMEOUT_S = 0.3  # Redis is on the private network: anything slower is a fault
NAMESPACE = "tcroof:v1:"

_MISSING = object()


def _pack(obj: Any) -> Any:
    """JSON-ready copy that keeps datetimes, dates and tuples (tagged)."""
    if isinstance(obj, datetime):
        return {"__dt__": obj.isoformat()}
    if isinstance(obj, date):
        return {"__d__": obj.isoformat()}
    if isinstance(obj, tuple):
        return {"__t__": [_pack(v) for v in obj]}
    if isinstance(obj, list):
        return [_pack(v) for v in obj]
    if isinstance(obj, dict):
        if not all(isinstance(k, str) for k in obj):
            raise TypeError("only str dict keys survive JSON")
        return {k: _pack(v) for k, v in obj.items()}
    if obj is None or isinstance(obj, (str, int, float, bool)):
        return obj
    raise TypeError(f"{type(obj).__name__} is not JSON-safe")


def _unpack_hook(d: Dict[str, Any]) -> Any:
    if len(d) == 1:
        if "__dt__" in d:
            return datetime.fromisoformat(d["__dt__"])
        if "__d__" in d:
            return date.fromisoformat(d["__d__"])
        if "__t__" in d:
            return tuple(d["__t__"])
    return d


def dumps(value: Any) -> str:
    return json.dumps(_pack(value), separators=(",", ":"), allow_nan=True)


def loads(text: str) -> Any:
    return json.loads(text, object_hook=_unpack_hook)


class RedisLink:
    """One Redis connection shared by the live services, with a simple circuit breaker."""

    def __init__(self, client: Any, clock: Callable[[], float] = time.monotonic):
        self.client = client
        self._clock = clock
        self._down_until = 0.0
        self._lock = threading.Lock()

    @classmethod
    def from_url(cls, url: str) -> "RedisLink":
        import redis

        return cls(redis.Redis.from_url(url, socket_timeout=TIMEOUT_S, socket_connect_timeout=TIMEOUT_S, decode_responses=True))

    @property
    def up(self) -> bool:
        return self._clock() >= self._down_until

    def call(self, fn: Callable[[Any], Any], default: Any = None) -> Any:
        """`fn(client)`, or `default` while Redis is marked down or when the call fails."""
        if not self.up:
            return default
        try:
            return fn(self.client)
        except Exception as exc:  # noqa: BLE001 - any Redis/network error: degrade to memory
            with self._lock:
                if self.up:  # log once per outage
                    log.warning("Redis unavailable, live cache is memory-only for %.0f s: %s", RETRY_S, type(exc).__name__)
                self._down_until = self._clock() + RETRY_S
            return default


class TieredDict:
    """The dict operations the live services use (`get`, `[]`, `[]=`, `pop`), backed by a process
    dict and, when `link` is set, mirrored in Redis. `expire_s(value)` gives a key's Redis
    lifetime in seconds (<= 0: not mirrored)."""

    def __init__(self, name: str, link: Optional[RedisLink], expire_s: Callable[[Any], float]):
        self._local: Dict[Hashable, Any] = {}
        self._prefix = f"{NAMESPACE}{name}:"
        self._link = link
        self._expire_s = expire_s

    def _rkey(self, key: Hashable) -> str:
        return self._prefix + repr(key)

    def get(self, key: Hashable, default: Any = None) -> Any:
        hit = self._local.get(key, _MISSING)
        if hit is not _MISSING:
            return hit
        if self._link is None:
            return default
        raw = self._link.call(lambda r: r.get(self._rkey(key)))
        if raw is None:
            return default
        try:
            value = loads(raw)
        except (ValueError, TypeError):
            return default
        self._local[key] = value  # first level from now on
        return value

    def __getitem__(self, key: Hashable) -> Any:
        value = self.get(key, _MISSING)
        if value is _MISSING:
            raise KeyError(key)
        return value

    def __setitem__(self, key: Hashable, value: Any) -> None:
        self._local[key] = value
        if self._link is None:
            return
        ttl = self._expire_s(value)
        if ttl <= 0:
            return
        try:
            text = dumps(value)
        except (TypeError, ValueError):
            log.debug("live cache %s not mirrored: value is not JSON-safe", key)
            return
        self._link.call(lambda r: r.set(self._rkey(key), text, ex=max(1, int(ttl))))

    def pop(self, key: Hashable, default: Any = None) -> Any:
        value = self._local.pop(key, default)
        if self._link is not None:
            self._link.call(lambda r: r.delete(self._rkey(key)))
        return value

    def __contains__(self, key: Hashable) -> bool:
        return self.get(key, _MISSING) is not _MISSING


_link: Optional[RedisLink] = None
_link_lock = threading.Lock()


def redis_link(url: Optional[str]) -> Optional[RedisLink]:
    """The process's Redis link for `url` (None when `url` is empty)."""
    global _link
    if not url:
        return None
    with _link_lock:
        if _link is None:
            _link = RedisLink.from_url(url)
        return _link


def cache_map(name: str, link: Optional[RedisLink], ttl_index: Optional[int], fixed_ttl_s: float = 0.0) -> TieredDict:
    """Cache entries are tuples `(stored_at, wall, data, [ttl_s])`. With `ttl_index`, the entry's
    own TTL is at that position; else `fixed_ttl_s` is the TTL. Kept `STALE_KEEP_S` beyond it."""

    def expire(entry: Any) -> float:
        ttl = float(entry[ttl_index]) if ttl_index is not None else fixed_ttl_s
        return ttl + STALE_KEEP_S

    return TieredDict(name, link, expire)


def cooldown_map(name: str, link: Optional[RedisLink], clock: Callable[[], float]) -> TieredDict:
    """Cooldowns are `until` timestamps on `clock` (a wall clock when Redis is on)."""
    return TieredDict(name, link, lambda until: float(until) - clock() + COOLDOWN_SLACK_S)
