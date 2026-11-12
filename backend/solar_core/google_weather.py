"""Google Maps Platform Weather API client (https://developers.google.com/maps/documentation/weather).

Pure HTTP + parsing, no FastAPI or SQLAlchemy. Every response is flattened into one dict of SI
values (°C, %, mm, m/s, hPa, km); a field Google leaves out is None, never a default.

The values are modelled (Google's weather model for the coordinates), not measured at the
plant. The plant's own weather sensor stays the source for irradiance and IEC PR.

Endpoints used:
- `currentConditions:lookup`  current conditions + the past 24 h's rain / min / max temperature
- `history/hours:lookup`      the past 24 hours, hourly (one page of 24 rows per call)
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional

import requests

DEFAULT_BASE_URL = "https://weather.googleapis.com/v1/"

# Flat fields of one parsed record (current conditions or one history hour).
FIELDS = (
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

_SPEED_TO_MS = {"KILOMETERS_PER_HOUR": 1 / 3.6, "MILES_PER_HOUR": 0.44704}
_LENGTH_TO_MM = {"MILLIMETERS": 1.0, "INCHES": 25.4}
_DIST_TO_KM = {"KILOMETERS": 1.0, "MILES": 1.609344}


class GoogleWeatherError(RuntimeError):
    """The Weather API refused or failed. The message never contains the API key."""


def _num(v: Any) -> Optional[float]:
    try:
        return None if v is None or v == "" else float(v)
    except (TypeError, ValueError):
        return None


def _round(v: Optional[float], digits: int) -> Optional[float]:
    return None if v is None else round(v, digits)


def _temp_c(t: Any) -> Optional[float]:
    if not isinstance(t, dict):
        return None
    deg = _num(t.get("degrees"))
    if deg is None:
        return None
    return _round((deg - 32.0) * 5.0 / 9.0 if t.get("unit") == "FAHRENHEIT" else deg, 1)


def _scaled(d: Any, value_key: str, table: Dict[str, float], default_unit: str, digits: int) -> Optional[float]:
    if not isinstance(d, dict):
        return None
    v = _num(d.get(value_key))
    factor = table.get(d.get("unit") or default_unit)
    return None if v is None or factor is None else _round(v * factor, digits)


def _local_naive(dd: Any) -> Optional[datetime]:
    """`displayDateTime` (location-local wall clock) as a naive datetime."""
    if not isinstance(dd, dict):
        return None
    try:
        return datetime(int(dd["year"]), int(dd["month"]), int(dd["day"]), int(dd.get("hours", 0)), int(dd.get("minutes", 0)))
    except (KeyError, TypeError, ValueError):
        return None


def _utc(ts: Any) -> Optional[datetime]:
    if not isinstance(ts, str) or not ts:
        return None
    s = ts.rstrip("Z")
    if "." in s:  # nanoseconds: keep microseconds for fromisoformat
        head, frac = s.split(".", 1)
        s = f"{head}.{frac[:6]}"
    try:
        return datetime.fromisoformat(s).replace(tzinfo=timezone.utc)
    except ValueError:
        return None


def parse_conditions(d: Dict[str, Any]) -> Dict[str, Any]:
    """Flatten one current-conditions response or one `historyHours` item."""
    cond = d.get("weatherCondition") or {}
    precip = d.get("precipitation") or {}
    wind = d.get("wind") or {}
    return {
        "condition": cond.get("type"),
        "condition_text": (cond.get("description") or {}).get("text"),
        "icon_uri": cond.get("iconBaseUri"),
        "is_daytime": d.get("isDaytime"),
        "temp_c": _temp_c(d.get("temperature")),
        "feels_like_c": _temp_c(d.get("feelsLikeTemperature")),
        "dew_point_c": _temp_c(d.get("dewPoint")),
        "humidity_pct": _num(d.get("relativeHumidity")),
        "cloud_cover_pct": _num(d.get("cloudCover")),
        "uv_index": _num(d.get("uvIndex")),
        "precip_mm": _scaled(precip.get("qpf"), "quantity", _LENGTH_TO_MM, "MILLIMETERS", 2),
        "precip_prob_pct": _num((precip.get("probability") or {}).get("percent")),
        "precip_type": (precip.get("probability") or {}).get("type"),
        "thunder_prob_pct": _num(d.get("thunderstormProbability")),
        "wind_speed_ms": _scaled(wind.get("speed"), "value", _SPEED_TO_MS, "KILOMETERS_PER_HOUR", 1),
        "wind_gust_ms": _scaled(wind.get("gust"), "value", _SPEED_TO_MS, "KILOMETERS_PER_HOUR", 1),
        "wind_dir_deg": _num((wind.get("direction") or {}).get("degrees")),
        "pressure_hpa": _num((d.get("airPressure") or {}).get("meanSeaLevelMillibars")),
        "visibility_km": _scaled(d.get("visibility"), "distance", _DIST_TO_KM, "KILOMETERS", 1),
    }


def parse_current(d: Dict[str, Any]) -> Dict[str, Any]:
    """Current conditions plus the past-24-h summary Google returns with them."""
    hist = d.get("currentConditionsHistory") or {}
    return {
        **parse_conditions(d),
        "time_utc": (t.isoformat() if (t := _utc(d.get("currentTime"))) else None),
        "time_zone": (d.get("timeZone") or {}).get("id"),
        "past24h_precip_mm": _scaled(hist.get("qpf"), "quantity", _LENGTH_TO_MM, "MILLIMETERS", 2),
        "past24h_max_temp_c": _temp_c(hist.get("maxTemperature")),
        "past24h_min_temp_c": _temp_c(hist.get("minTemperature")),
    }


def parse_history_hour(h: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """One `historyHours` item; `hour_local` is the location-local start of the hour (naive)."""
    interval = h.get("interval") or {}
    start = _utc(interval.get("startTime"))
    local = _local_naive(h.get("displayDateTime"))
    if local is None and start is not None:
        off = _num(str((h.get("displayDateTime") or {}).get("utcOffset", "")).rstrip("s"))
        local = (start + timedelta(seconds=off)).replace(tzinfo=None) if off is not None else None
    if local is None:
        return None
    return {"hour_local": local.replace(minute=0, second=0, microsecond=0), "hour_utc": start, **parse_conditions(h)}


class GoogleWeatherClient:
    """Thin client; one HTTP call per method call (plus one per extra history page)."""

    def __init__(
        self,
        api_key: str,
        base_url: str = DEFAULT_BASE_URL,
        timeout: float = 20.0,
        session: Optional[requests.Session] = None,
    ):
        if not api_key:
            raise GoogleWeatherError("GOOGLE_WEATHER_API_KEY is not set")
        self._key = api_key
        self._base = base_url.rstrip("/") + "/"
        self._timeout = timeout
        self._http = session or requests.Session()
        self.calls = 0  # HTTP requests made (each one is billable)

    def _get(self, path: str, params: Dict[str, Any]) -> Dict[str, Any]:
        self.calls += 1
        try:
            r = self._http.get(self._base + path, params={**params, "key": self._key}, timeout=self._timeout)
        except requests.RequestException as exc:
            raise GoogleWeatherError(f"{path}: {type(exc).__name__}") from None
        try:
            body = r.json()
        except ValueError:
            body = {}
        if r.status_code != 200:
            err = body.get("error") if isinstance(body, dict) else None
            msg = (err or {}).get("message") or r.reason or "error"
            raise GoogleWeatherError(f"{path}: HTTP {r.status_code} {msg}".replace(self._key, "***"))
        return body if isinstance(body, dict) else {}

    @staticmethod
    def _loc(lat: float, lon: float) -> Dict[str, Any]:
        return {"location.latitude": f"{lat:.5f}", "location.longitude": f"{lon:.5f}", "unitsSystem": "METRIC"}

    def current(self, lat: float, lon: float) -> Dict[str, Any]:
        return parse_current(self._get("currentConditions:lookup", self._loc(lat, lon)))

    def history_hours(self, lat: float, lon: float, hours: int = 24, max_pages: int = 2) -> List[Dict[str, Any]]:
        """The past `hours` hours (≤ 24), oldest first."""
        params: Dict[str, Any] = {**self._loc(lat, lon), "hours": hours, "pageSize": hours}
        rows: List[Dict[str, Any]] = []
        for _ in range(max_pages):
            body = self._get("history/hours:lookup", params)
            rows.extend(r for h in body.get("historyHours") or [] if (r := parse_history_hour(h)))
            token = body.get("nextPageToken")
            if not token:
                break
            params = {**params, "pageToken": token}
        rows.sort(key=lambda r: r["hour_local"])
        return rows
