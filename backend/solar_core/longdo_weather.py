"""Longdo Map Weather Radar API client (https://weather.longdo.com/docs, `/openapi.json`).

Pure HTTP + parsing, no FastAPI or SQLAlchemy. A field Longdo leaves out is None, never a default.

Rain here is what the weather radar mosaic shows over a coordinate (an intensity class 0–5), and
the +15 / +30 min values are a nowcast (pysteps) of that mosaic. Neither is measured at the plant.

Endpoints used (every one but the legend needs `?key=`):
- `rain/api/v1/layer/list`          radar snapshots available (Unix time, oldest first)
- `rain/api/v1/legend?format=json&lang=th`  colour and Thai label of each intensity class (static, no key)
- `rain/api/v1/location`            radar rain class at a coordinate, now
- `rain/api/v1/forecast/location`   the same for +15 / +30 min
- `rain/api/v1/area`                share of a circle with rain and its strongest class, now
- `rain/api/v1/forecast/area`       the same for +15 / +30 min
- `rain/api/v1/layer/{time}/{z}/{x}/{y}.png`  XYZ tiles, zoom 5–13 (loaded by the browser)
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional

import requests

DEFAULT_BASE_URL = "https://weather.longdo.com/"
TILE_MIN_ZOOM, TILE_MAX_ZOOM = 5, 13
ATTRIBUTION = "Rain radar © Longdo Map"


class LongdoWeatherError(RuntimeError):
    """The API refused or failed. The message never contains the API key."""


def _int(v: Any) -> Optional[int]:
    try:
        return None if v is None or v == "" or isinstance(v, bool) else int(v)
    except (TypeError, ValueError):
        return None


def parse_frames(body: Any) -> List[int]:
    """Unix times of the radar snapshots, oldest first."""
    past = ((body or {}).get("radar") or {}).get("past") if isinstance(body, dict) else None
    times = {_int(f.get("time")) for f in past or [] if isinstance(f, dict)}
    return sorted(t for t in times if t)


def parse_rain(rain: Any) -> Optional[Dict[str, Any]]:
    """`{intensity 0–5, description}` as reported; None when Longdo gave no intensity."""
    if not isinstance(rain, dict):
        return None
    intensity = _int(rain.get("intensity"))
    if intensity is None or not 0 <= intensity <= 5:
        return None
    text = rain.get("description") or rain.get("level")
    return {"intensity": intensity, "description": str(text) if text else None}


def parse_forecast(body: Any) -> List[Dict[str, Any]]:
    """One row per lead time: `{lead_min, time (Unix), rain}`; `rain` None = not available."""
    if not isinstance(body, dict):
        return []
    leads = body.get("lead_minutes") or []
    rows = []
    for i, item in enumerate(body.get("forecast") or []):
        if not isinstance(item, dict):
            continue
        rows.append(
            {
                "lead_min": _int(leads[i]) if i < len(leads) else None,
                "time": _int(item.get("unix_time")),
                "rain": parse_rain(item.get("rain")) if item.get("available", True) else None,
            }
        )
    return rows


def _float(v: Any) -> Optional[float]:
    try:
        return None if v is None or v == "" or isinstance(v, bool) else float(v)
    except (TypeError, ValueError):
        return None


def parse_area_stats(stats: Any) -> Optional[Dict[str, Any]]:
    """`{coverage_pct, max_intensity}` of a circle; None when Longdo gave neither."""
    if not isinstance(stats, dict):
        return None
    cover, top = _float(stats.get("rain_coverage_pct")), _int(stats.get("max_intensity"))
    if cover is None and top is None:
        return None
    return {"coverage_pct": None if cover is None else round(cover, 1), "max_intensity": top if top is not None and 0 <= top <= 5 else None}


def parse_forecast_area(body: Any) -> List[Dict[str, Any]]:
    """One row per lead time: `{lead_min, time (Unix), stats}`; `stats` None = not available."""
    if not isinstance(body, dict):
        return []
    leads = body.get("lead_minutes") or []
    rows = []
    for i, item in enumerate(body.get("forecast") or []):
        if not isinstance(item, dict):
            continue
        rows.append(
            {
                "lead_min": _int(leads[i]) if i < len(leads) else None,
                "time": _int(item.get("unix_time")),
                "stats": parse_area_stats(item.get("stats")) if item.get("available", True) else None,
            }
        )
    return rows


def parse_legend(body: Any) -> List[Dict[str, Any]]:
    rows = []
    for lv in (body or {}).get("levels") or [] if isinstance(body, dict) else []:
        if not isinstance(lv, dict):
            continue
        intensity, color = _int(lv.get("intensity")), lv.get("hex")
        if intensity is None or not isinstance(color, str):
            continue
        rows.append({"intensity": intensity, "label": str(lv.get("label") or ""), "color": color})
    return sorted(rows, key=lambda r: r["intensity"])


class LongdoWeatherClient:
    """Thin client; one HTTP call per method call."""

    def __init__(
        self,
        api_key: str,
        base_url: str = DEFAULT_BASE_URL,
        timeout: float = 15.0,
        session: Optional[requests.Session] = None,
    ):
        if not api_key:
            raise LongdoWeatherError("LONGDO_API_KEY is not set")
        self._key = api_key
        self._base = base_url.rstrip("/") + "/"
        self._timeout = timeout
        self._http = session or requests.Session()

    def _get(self, path: str, params: Optional[Dict[str, Any]] = None, key: bool = True) -> Any:
        query = {**(params or {}), **({"key": self._key} if key else {})}
        try:
            r = self._http.get(self._base + path, params=query, timeout=self._timeout)
        except requests.RequestException as exc:
            raise LongdoWeatherError(f"{path}: {type(exc).__name__}") from None
        try:
            body = r.json()
        except ValueError:
            body = None
        if r.status_code != 200:
            detail = body.get("detail") if isinstance(body, dict) else None
            msg = detail if isinstance(detail, str) else r.reason or "error"
            raise LongdoWeatherError(f"{path}: HTTP {r.status_code} {msg}".replace(self._key, "***"))
        if body is None:
            raise LongdoWeatherError(f"{path}: answer is not JSON")
        return body

    def frames(self) -> List[int]:
        return parse_frames(self._get("rain/api/v1/layer/list"))

    def legend(self) -> List[Dict[str, Any]]:
        return parse_legend(self._get("rain/api/v1/legend", {"format": "json", "lang": "th"}, key=False))

    def rain_at(self, lat: float, lon: float) -> Optional[Dict[str, Any]]:
        body = self._get("rain/api/v1/location", {"lat": lat, "lon": lon})
        return parse_rain(body.get("rain") if isinstance(body, dict) else None)

    def forecast_at(self, lat: float, lon: float) -> List[Dict[str, Any]]:
        return parse_forecast(self._get("rain/api/v1/forecast/location", {"lat": lat, "lon": lon}))

    def area_at(self, lat: float, lon: float, radius_km: float) -> Optional[Dict[str, Any]]:
        body = self._get("rain/api/v1/area", {"lat": lat, "lon": lon, "radius_km": radius_km})
        return parse_area_stats(body.get("stats") if isinstance(body, dict) else None)

    def forecast_area_at(self, lat: float, lon: float, radius_km: float) -> List[Dict[str, Any]]:
        return parse_forecast_area(self._get("rain/api/v1/forecast/area", {"lat": lat, "lon": lon, "radius_km": radius_km}))

    def tile_url(self) -> str:
        """Leaflet URL template of one snapshot's tiles; `{time}` is a Unix time from `frames()`.
        It carries the key: Longdo Map keys are browser keys (restrict them by domain)."""
        return f"{self._base}rain/api/v1/layer/{{time}}/{{z}}/{{x}}/{{y}}.png?key={self._key}"
