"""Stub Longdo weather radar, RainViewer and Google Maps Weather for the parity run: both APIs
(Python and Rust) point `LONGDO_BASE_URL`, `RAINVIEWER_URL` and `GOOGLE_WEATHER_BASE_URL` at it,
so the live weather / rain routes (`/growatt/live/rain*`, `/growatt/live/plants/{id}/google-weather`)
can be compared without the real services.

    python3 rust/tests/parity/weather_stub.py PORT
      http://127.0.0.1:PORT/longdo/                      Longdo (key `parity-stub-key`; any other key: HTTP 403)
      http://127.0.0.1:PORT/rainviewer/weather-maps.json RainViewer
      http://127.0.0.1:PORT/google/v1/                   Google Maps Weather current conditions

Answers are deterministic and depend only on the request (the coordinate), never on the call count,
so each backend (each with its own memory cache) gets the same answers. Stdlib only; nothing is
stored.
"""

from __future__ import annotations

import json
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

GOOD_KEY = "parity-stub-key"
# snapshot times: fixed, 15 min apart (Longdo) and 10 min apart (RainViewer)
T0 = 1764200700
LONGDO_FRAMES = [T0 + 900 * i for i in range(4)]
RV_FRAMES = [T0 + 600 * i for i in range(3)]


def rain_class(lat: float) -> int:
    """Rain by latitude: wet in the north (>= 18°) and the south (< 8°), dry in between."""
    if lat >= 18:
        return 2
    if lat < 8:
        return 1
    return 0


def rain(intensity: int) -> dict:
    return {"intensity": intensity, "description": ["ไม่มีฝน", "ฝนเล็กน้อย", "ฝนปานกลาง"][intensity]}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):  # quiet
        pass

    def _send(self, body, status: int = 200) -> None:
        raw = json.dumps(body, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def do_GET(self):  # noqa: N802
        u = urlparse(self.path)
        p = {k: v[-1] for k, v in parse_qs(u.query).items()}
        path = u.path
        if path == "/ping":
            return self._send({"ok": True})
        if path.startswith("/longdo/"):
            return self._longdo(path.removeprefix("/longdo/"), p)
        if path == "/rainviewer/weather-maps.json":
            return self._send({
                "version": "2.0", "generated": int(time.time()), "host": "https://tilecache.rainviewer.com",
                "radar": {"past": [{"time": t, "path": f"/v2/radar/hash{t}"} for t in RV_FRAMES] + [{"time": 0, "path": "/x"}]},
            })
        if path.startswith("/google/v1/"):
            return self._google(path.removeprefix("/google/v1/"), p)
        return self._send({"detail": "Not Found"}, 404)

    def _longdo(self, path: str, p: dict) -> None:
        if path == "rain/api/v1/legend":  # no key
            return self._send({"levels": [
                {"intensity": 2, "hex": "#3366ff", "label": "ฝนปานกลาง"},
                {"intensity": 0, "hex": "#ffffff", "label": "ไม่มีฝน"},
                {"intensity": 1, "hex": "#99ccff", "label": "ฝนเล็กน้อย"},
                {"intensity": "x", "hex": "#000"},
            ]})
        if p.get("key") != GOOD_KEY:
            return self._send({"detail": "invalid key"}, 403)
        lat = float(p.get("lat", "0"))
        if path == "rain/api/v1/layer/list":
            return self._send({"radar": {"past": [{"time": t} for t in reversed(LONGDO_FRAMES)] + [{"time": 0}]}})
        if path == "rain/api/v1/location":
            return self._send({"rain": rain(rain_class(lat))})
        if path == "rain/api/v1/forecast/location":
            if lat < 8:  # the nowcast fails in the south: "now" is still served
                return self._send({"detail": "nowcast unavailable"}, 503)
            c = rain_class(lat)
            return self._send({"lead_minutes": [15, 30], "forecast": [
                {"unix_time": LONGDO_FRAMES[-1] + 900, "available": True, "rain": rain(c)},
                {"unix_time": LONGDO_FRAMES[-1] + 1800, "available": False},
            ]})
        if path == "rain/api/v1/area":
            c = rain_class(lat)
            return self._send({"stats": {"rain_coverage_pct": 12.345 if c else 0.0, "max_intensity": c}})
        if path == "rain/api/v1/forecast/area":
            c = rain_class(lat)
            return self._send({"lead_minutes": [15, 30], "forecast": [
                {"unix_time": LONGDO_FRAMES[-1] + 900, "stats": {"rain_coverage_pct": 20.0 if c else 0.0, "max_intensity": c}},
                {"unix_time": LONGDO_FRAMES[-1] + 1800, "stats": {"rain_coverage_pct": None}},
            ]})
        return self._send({"detail": f"stub has no {path}"}, 404)

    def _google(self, path: str, p: dict) -> None:
        if p.get("key") != GOOD_KEY:
            return self._send({"error": {"code": 403, "message": "API key not valid"}}, 403)
        if path == "history/hours:lookup":
            return self._google_history(p)
        if path != "currentConditions:lookup":
            return self._send({"error": {"code": 404, "message": f"stub has no {path}"}}, 404)
        lat = float(p.get("location.latitude", "0"))
        wet = rain_class(lat) > 0
        return self._send({
            "currentTime": "2026-11-27T05:00:12.345678901Z",
            "timeZone": {"id": "Asia/Bangkok"},
            "isDaytime": True,
            "weatherCondition": {"iconBaseUri": "https://maps.gstatic.com/weather/v1/rain",
                                 "description": {"text": "Light rain" if wet else "Sunny", "languageCode": "en"},
                                 "type": "LIGHT_RAIN" if wet else "CLEAR"},
            "temperature": {"degrees": 31.4, "unit": "CELSIUS"},
            "feelsLikeTemperature": {"degrees": 89.6, "unit": "FAHRENHEIT"},
            "dewPoint": {"degrees": 22.1, "unit": "CELSIUS"},
            "relativeHumidity": 62,
            "uvIndex": 7,
            "precipitation": {"probability": {"percent": 40 if wet else 5, "type": "RAIN"},
                              "qpf": {"quantity": 1.25 if wet else 0, "unit": "MILLIMETERS"}},
            "thunderstormProbability": 10,
            "airPressure": {"meanSeaLevelMillibars": 1009.7},
            "wind": {"direction": {"degrees": 225, "cardinal": "SOUTHWEST"},
                     "speed": {"value": 11, "unit": "KILOMETERS_PER_HOUR"},
                     "gust": {"value": 25, "unit": "KILOMETERS_PER_HOUR"}},
            "visibility": {"distance": 10, "unit": "KILOMETERS"},
            "cloudCover": 75 if wet else 10,
            "currentConditionsHistory": {"temperatureChange": {"degrees": 1.2, "unit": "CELSIUS"},
                                         "maxTemperature": {"degrees": 33.0, "unit": "CELSIUS"},
                                         "minTemperature": {"degrees": 24.5, "unit": "CELSIUS"},
                                         "qpf": {"quantity": 3.5, "unit": "MILLIMETERS"}},
        })


    def _google_history(self, p: dict) -> None:
        """`history/hours:lookup` for the worker parity (`google_weather` job): `hours` rows of a
        fixed day (2026-11-27 06:00 + i, Bangkok), values by the hour and the latitude, oldest
        last (the client sorts). Latitude 15.x answers HTTP 500, 17.x HTTP 429 (Google's daily
        quota); answers never depend on the call count."""
        lat = float(p.get("location.latitude", "0"))
        if 15 <= lat < 16:
            return self._send({"error": {"code": 500, "message": "Internal error encountered."}}, 500)
        if 17 <= lat < 18:
            return self._send({"error": {"code": 429, "message": "Quota exceeded for History Hours Usage per day."}}, 429)
        n = int(p.get("hours", "24"))
        rows = []
        for i in reversed(range(n)):
            h = 6 + i
            day, hour = 27 + h // 24, h % 24
            wet = (h + int(lat)) % 5 == 0
            rows.append({
                "interval": {"startTime": f"2026-11-{day:02d}T{(hour - 7) % 24:02d}:00:00Z"},
                "displayDateTime": {"year": 2026, "month": 11, "day": day, "hours": hour, "utcOffset": "25200s"},
                "isDaytime": 6 <= hour < 18,
                "weatherCondition": {"type": "RAIN" if wet else ("MOSTLY_CLEAR" if i % 2 else "PARTLY_CLOUDY")},
                "temperature": {"degrees": 24.5 + i * 0.7 + lat / 100, "unit": "CELSIUS"},
                "feelsLikeTemperature": {"degrees": 80 + i, "unit": "FAHRENHEIT"},
                "dewPoint": {"degrees": 21.3, "unit": "CELSIUS"},
                "relativeHumidity": 60 + i,
                "uvIndex": i % 9,
                "precipitation": {"probability": {"percent": 70 if wet else 10, "type": "RAIN"},
                                  "qpf": {"quantity": 1.37 if wet else 0, "unit": "MILLIMETERS"}},
                "thunderstormProbability": 20 if wet else 0,
                "airPressure": {"meanSeaLevelMillibars": 1010.2},
                "wind": {"direction": {"degrees": 45 * (i % 8)}, "speed": {"value": 7 + i, "unit": "KILOMETERS_PER_HOUR"},
                         "gust": {"value": 15 + i, "unit": "KILOMETERS_PER_HOUR"}},
                "visibility": {"distance": 10, "unit": "KILOMETERS"},
                "cloudCover": (13 * i + int(lat)) % 100,
            })
        return self._send({"historyHours": rows})


def main() -> None:
    ThreadingHTTPServer(("127.0.0.1", int(sys.argv[1])), Handler).serve_forever()


if __name__ == "__main__":
    main()
