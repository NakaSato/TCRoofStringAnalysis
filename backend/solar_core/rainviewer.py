"""RainViewer Weather Maps API client (https://www.rainviewer.com/api/weather-maps-api.html).

Pure HTTP + parsing, no FastAPI or SQLAlchemy. Used only as the fallback rain radar on the Plant
Map when Longdo is not configured or has nothing to serve. No key, no point values: only the list
of radar snapshots (past ~2 h, 10 min apart) and their XYZ tiles, which the browser loads itself.

`weather-maps.json` answers `{host, radar: {past: [{time, path}]}}`; each snapshot has its own
`path` (a hash, not the time), so the tile URL is given per snapshot. Tiles exist up to zoom 7.
RainViewer asks for the credit "Weather data by RainViewer" with a link, and the free API is meant
for personal, educational and small community use, without an SLA.
"""

from __future__ import annotations

from typing import Any, Dict, Optional

import requests

DEFAULT_URL = "https://api.rainviewer.com/public/weather-maps.json"
TILE_MIN_ZOOM, TILE_MAX_ZOOM = 0, 7
TILE_SIZE = 256
COLOR_SCHEME = 2  # "Universal Blue", the scheme the free API serves
OPTIONS = "1_0"  # smoothed, no separate snow colours
ATTRIBUTION = '<a href="https://www.rainviewer.com/" target="_blank" rel="noreferrer">Weather data by RainViewer</a>'


class RainViewerError(RuntimeError):
    """The API refused or failed, or answered something that is not the snapshot list."""


def _int(v: Any) -> Optional[int]:
    try:
        return None if v is None or v == "" or isinstance(v, bool) else int(v)
    except (TypeError, ValueError):
        return None


def parse_maps(body: Any) -> Dict[str, Any]:
    """`{frames: [Unix time, oldest first], tiles: {str(time): XYZ tile URL}}` of the past radar
    snapshots; a snapshot without a time or a path is left out."""
    if not isinstance(body, dict):
        raise RainViewerError("RainViewer answered no snapshot list")
    host = str(body.get("host") or "").rstrip("/")
    if not host.startswith("https://"):
        raise RainViewerError("RainViewer answered no tile host")
    past = (body.get("radar") or {}).get("past") if isinstance(body.get("radar"), dict) else None
    tiles: Dict[int, str] = {}
    for f in past or []:
        if not isinstance(f, dict):
            continue
        t, path = _int(f.get("time")), f.get("path")
        if t and isinstance(path, str) and path.startswith("/"):
            tiles[t] = f"{host}{path}/{TILE_SIZE}/{{z}}/{{x}}/{{y}}/{COLOR_SCHEME}/{OPTIONS}.png"
    frames = sorted(tiles)
    return {"frames": frames, "tiles": {str(t): tiles[t] for t in frames}}


class RainViewerClient:
    def __init__(self, url: str = DEFAULT_URL, timeout: float = 6.0, session: Optional[requests.Session] = None):
        self.url = url
        self.timeout = timeout
        self.session = session or requests.Session()

    def maps(self) -> Dict[str, Any]:
        try:
            r = self.session.get(self.url, timeout=self.timeout)
        except requests.RequestException as exc:
            raise RainViewerError(f"RainViewer not reachable: {type(exc).__name__}") from exc
        if r.status_code != 200:
            raise RainViewerError(f"RainViewer answered HTTP {r.status_code}")
        try:
            body = r.json()
        except ValueError as exc:
            raise RainViewerError("RainViewer answered no JSON") from exc
        return parse_maps(body)
