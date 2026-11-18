"""RainViewer: fallback rain radar tiles for the Plant Map when Longdo has none to give.

Used by `/growatt/live/rain-radar` when `LONGDO_API_KEY` is empty or Longdo's snapshot list cannot
be read and there is no earlier one to serve. Tiles only: RainViewer gives no rain value over a
point, so the plant / fleet rain (Longdo) stays as it is and the UI hides it without Longdo.

Memory only (mirrored in Redis when configured), never stored. The snapshot list is cached
`RAINVIEWER_TTL_S`; a failed call serves the last list as stale and waits `cooldown_s`.
No key, no counted budget (RainViewer publishes no rate limit; it asks to cache, which this does).
"""

from __future__ import annotations

import threading
import time
from datetime import datetime, timezone
from functools import lru_cache
from typing import Any, Callable, Dict, Optional

from app.config import settings
from app.services.live_store import RedisLink, TieredDict, cache_map, cooldown_map, redis_link
from solar_core.rainviewer import (
    ATTRIBUTION,
    TILE_MAX_ZOOM,
    TILE_MIN_ZOOM,
    RainViewerClient,
    RainViewerError,
)

SOURCE = "RainViewer weather radar"
KEY = "maps"


class RainViewerUnavailable(RuntimeError):
    def __init__(self, message: str, retry_s: float = 60.0):
        super().__init__(message)
        self.retry_s = retry_s


def enabled() -> bool:
    return bool(settings.rainviewer_enabled)


class RainViewerLive:
    def __init__(
        self,
        client_factory: Callable[[], RainViewerClient],
        cooldown_s: float = 60.0,
        clock: Callable[[], float] = time.monotonic,
        redis: Optional[RedisLink] = None,
    ):
        self._factory = client_factory
        self._client: Optional[RainViewerClient] = None
        self.cooldown_s = cooldown_s
        self._clock = clock
        self._cache: TieredDict = cache_map("rainviewer", redis, ttl_index=3)
        self._cooldown_until: TieredDict = cooldown_map("rainviewer-cooldown", redis, clock)
        self._lock = threading.Lock()

    def client(self) -> RainViewerClient:
        if self._client is None:
            self._client = self._factory()
        return self._client

    @staticmethod
    def _env(wall: str, data: Any, stale: bool, error: Optional[str], refresh: float) -> Dict[str, Any]:
        return {"source": "live", "fetched_at": wall, "stale": stale, "error": error, "refresh_in_s": max(15, round(refresh)), "data": data}

    def maps(self, ttl_s: float) -> Dict[str, Any]:
        """Envelope whose `data` is `{frames, tiles}`. Raises RainViewerUnavailable."""
        with self._lock:
            now = self._clock()
            hit = self._cache.get(KEY)
            if hit and now - hit[0] < ttl_s:
                return self._env(hit[1], hit[2], False, None, ttl_s - (now - hit[0]))
            wait = self._cooldown_until.get(KEY, 0.0) - now
            if wait > 0:
                error = "RainViewer cooldown after an error"
            else:
                try:
                    data = self.client().maps()
                except RainViewerError as exc:
                    error, wait = str(exc), self.cooldown_s
                    self._cooldown_until[KEY] = now + wait
                else:
                    wall = datetime.now(timezone.utc).isoformat()
                    self._cache[KEY] = (now, wall, data, ttl_s)
                    self._cooldown_until.pop(KEY, None)
                    return self._env(wall, data, False, None, ttl_s)
            if hit:
                return self._env(hit[1], hit[2], True, error, wait)
            raise RainViewerUnavailable(error, wait)


def make_client() -> RainViewerClient:
    return RainViewerClient(settings.rainviewer_url, timeout=settings.rainviewer_timeout_s)


@lru_cache(maxsize=1)
def get_rainviewer_live() -> RainViewerLive:
    link = redis_link(settings.redis_url)
    return RainViewerLive(make_client, clock=time.time if link else time.monotonic, redis=link)


def radar(live: RainViewerLive, fallback_reason: Optional[str] = None) -> Dict[str, Any]:
    """Same shape as `longdo_weather.radar`, plus `frame_tiles` (each snapshot has its own tile
    path), `point_rain: false` (no rain value over a plant) and why Longdo is not used."""
    env = live.maps(settings.rainviewer_ttl_s)
    maps = env["data"] or {}
    frames = list(maps.get("frames") or [])
    tiles: Dict[str, str] = dict(maps.get("tiles") or {})
    env["data"] = {
        "provider": SOURCE,
        "radar": True,
        "frames": frames,
        # the newest snapshot's tiles; a client that ignores `frame_tiles` still shows rain
        "tile_url": tiles.get(str(frames[-1]), "") if frames else "",
        "frame_tiles": tiles,
        "min_zoom": TILE_MIN_ZOOM,
        "max_zoom": TILE_MAX_ZOOM,
        "attribution": ATTRIBUTION,
        "legend": [],  # RainViewer's colours are not Longdo's 0–5 classes: no legend rather than a made-up one
        "point_rain": False,
        "fallback_reason": fallback_reason,
    }
    return env
