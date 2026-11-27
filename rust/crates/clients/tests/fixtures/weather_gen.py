"""Parity fixtures for the Rust port of the weather clients (crate tcroof-clients).

Run from the repo root:

    PYTHONPATH=backend uv run python rust/crates/clients/tests/fixtures/weather_gen.py

It runs the Python parsers of backend/solar_core/{google_weather,longdo_weather,rainviewer}.py
(the behavioural oracle) over realistic payloads (shapes from backend/tests and the API docs),
edge cases and deterministic random mutations of them, and writes weather.json next to this
script. rust/crates/clients/tests/weather_parity.rs asserts the same results.

Each case is {"name", "in", "out"} or, where Python raises, {"name", "in", "raises": "<Exc>"}
(the Rust parser treats the malformed part as missing; the test only checks it does not panic).
Datetimes are written as Python isoformat(); non-finite floats as "nan" / "inf" / "-inf".
"""

from __future__ import annotations

import copy
import json
import math
import random
from datetime import date, datetime, timedelta
from pathlib import Path

from solar_core import google_weather as gw
from solar_core import longdo_weather as lw
from solar_core import rainviewer as rv

HERE = Path(__file__).resolve().parent


def enc(x):
    """A Python result as JSON: datetimes as isoformat, non-finite floats as strings."""
    if isinstance(x, datetime):
        return x.isoformat()
    if isinstance(x, float):
        if math.isnan(x):
            return "nan"
        if math.isinf(x):
            return "inf" if x > 0 else "-inf"
        return x
    if isinstance(x, dict):
        return {str(k): enc(v) for k, v in x.items()}
    if isinstance(x, (list, tuple)):
        return [enc(v) for v in x]
    return x


def run(fn, name, arg):
    try:
        return {"name": name, "in": arg, "out": enc(fn(copy.deepcopy(arg)))}
    except Exception as exc:  # noqa: BLE001 - record what Python raises
        return {"name": name, "in": arg, "raises": type(exc).__name__, "msg": str(exc)}


# Value pool for leaf mutations (integers stay within i64: Python's int has no limit, Rust's i64 has). No "nan" / "inf" strings here: a NaN in a parsed record would
# not survive JSON on either side; those are covered by the scalar fixtures.
POOL = [None, "", "12.5", 12, 0, -3.7, True, False, "abc", [], {}, [1], {"a": 1}, " 7 ", "1_000", "3.0", 2.675, 1e15, "๑๒", "x" * 3]


def mutate(rng, obj, n):
    """`n` random leaf replacements / deletions in a deep copy of `obj`."""
    obj = copy.deepcopy(obj)
    for _ in range(n):
        paths = []

        def walk(o, path):
            if isinstance(o, dict):
                for k, v in o.items():
                    paths.append(path + [k])
                    walk(v, path + [k])
            elif isinstance(o, list):
                for i, v in enumerate(o):
                    paths.append(path + [i])
                    walk(v, path + [i])

        walk(obj, [])
        if not paths:
            break
        p = rng.choice(paths)
        parent = obj
        for k in p[:-1]:
            parent = parent[k]
        if isinstance(parent, dict) and rng.random() < 0.3:
            del parent[p[-1]]
        else:
            parent[p[-1]] = copy.deepcopy(rng.choice(POOL))
    return obj


# ------------------------------------------------------------------------------- scalars

SCALARS = [None, "", 0, 1, -1, 12, 12.0, 12.5, -3.7, 2.675, 1e20, 1.5e-7, 1740449400, 1740449400.0, 3.999, -3.999,
           True, False, "12", " 12 ", "+12", "-12", "12.5", " 12.5\n", "1e3", "1E-3", ".5", "5.", "1.e5", "1_000",
           "1__000", "_1", "1_", "1_0.5", "abc", "12abc", "0x10", "nan", "NaN", "-nan", "inf", "-Infinity", "infinity",
           "infinit", "++1", "1e", "e5", "１２", "๑๒.๕", "٣", "\u00a012\u2003", "007", "0", "-0", "-0.0", [], [1], {}, {"a": 1}]


def gen_scalars():
    out = {}
    out["g_num"] = [{"in": v, "out": enc(gw._num(v))} for v in SCALARS]
    out["l_int"] = [{"in": v, "out": lw._int(v)} for v in SCALARS]
    out["l_float"] = [{"in": v, "out": enc(lw._float(v))} for v in SCALARS]
    rng = random.Random(7)
    vals = [0.125, 0.375, 2.675, 2.5, 0.05, -0.25, 1.005, 10.000000000000002, 35.99999999999999, 0.0, -0.04,
            1e16, 123456.789, 5e-324] + [rng.uniform(-200, 200) for _ in range(150)] + [rng.uniform(-1, 1) * 10 ** rng.randint(-6, 8) for _ in range(100)]
    out["round"] = [{"x": x, "d": d, "out": round(x, d)} for x in vals for d in (1, 2)]
    reprs = [0.0, -0.0, 1.0, 100.0, 13.7, 100.5018, 10.0, 0.0001, 0.00001, 1e-5, 1.5e-7, 1e15, 1e16, 1.2345e16, 123456789012345.6,
             -2.5, 5e-324, 1.7976931348623157e308, 0.1, 1 / 3] + [rng.uniform(-180, 180) for _ in range(100)] + \
            [rng.uniform(1, 10) * 10 ** rng.randint(-10, 20) for _ in range(100)]
    out["repr"] = [{"x": x, "out": repr(x)} for x in reprs]
    lats = [13.7, 100.5, 0.015625, 0.000005, 13.756331, 100.501765, -0.000004, 1 / 64, 0.123455, 99.999995] + [rng.uniform(-90, 180) for _ in range(150)]
    out["fmt5"] = [{"x": x, "out": f"{x:.5f}"} for x in lats]
    ts = ["2026-11-12T05:00:00.123456789Z", "2026-11-12T05:00:00Z", "2026-11-12T05:00:00.5Z", "2026-11-11T17:00:00Z",
          "2025-01-28T22:04:12.025273178Z", "2026-11-12T05:00:00", "2026-11-12", "2026-11-12T05:00", "2026-11-12 05:00:00",
          "2026-11-12T05:00:00+07:00", "2026-11-12T05:00:00.123+07:00", "20261112T050000", "2026-11-12T05",
          "2026-11-12T24:00:00Z", "2026-13-01T00:00:00Z", "2026-02-30T00:00:00Z", "2026-11-12x05:00:00", "2026-11-12T05:00:00,5Z",
          "2026-11-12T05:00:00.Z", "2026-11-12T0500", "2026-11-12T05:00:00-0730", "2026-11-12T05:00:00+25:00",
          " 2026-11-12", "2026-11-12T05:00:00.123456z", "2026-11-12T05:00:00 ", "", "garbage", "ZZZ", "2026-11-12T05:00:00ZZ",
          "0000-01-01T00:00:00Z", "9999-12-31T23:59:59.999999999Z", "2026-11-12T05:00:00.000000Z", "2026-11-12T05:00:00.000001Z",
          "2026-11-12T05:61:00Z", "2026-11-12T5:00:00Z", 12, None, True, ["2026-11-12T05:00:00Z"]]
    out["utc"] = [{"in": t, "out": enc(gw._utc(t))} for t in ts]
    dds = [{"year": 2026, "month": 11, "day": 11, "hours": 10, "utcOffset": "25200s"},
           {"year": 2026, "month": 11, "day": 11}, {"year": 2026, "month": 11, "day": 11, "hours": 23, "minutes": 59},
           {"year": "2026", "month": "11", "day": "11", "hours": "7"}, {"year": 2026.9, "month": 11.2, "day": 11, "hours": 10.99},
           {"year": True, "month": True, "day": True}, {"year": 2026, "month": 2, "day": 29}, {"year": 2024, "month": 2, "day": 29},
           {"year": 2026, "month": 13, "day": 1}, {"year": 2026, "month": 11, "day": 11, "hours": 24},
           {"year": 2026, "month": 11, "day": 11, "hours": None}, {"year": 2026, "month": 11}, {"month": 11, "day": 11},
           {"year": 0, "month": 1, "day": 1}, {"year": 10000, "month": 1, "day": 1}, {"year": -1, "month": 1, "day": 1},
           {"year": "", "month": 1, "day": 1}, {"year": "20.5", "month": 1, "day": 1}, {"year": [], "month": 1, "day": 1},
           {"year": 2026, "month": 11, "day": 11, "hours": -1}, {"year": 2026, "month": 11, "day": 11, "minutes": 60},
           None, "2026-11-11", [], {}]
    out["local_naive"] = [{"in": d, "out": enc(gw._local_naive(d))} for d in dds]
    return out


# ------------------------------------------------------------------------- Google Weather

def g_hour_item(h, rain=0.0, cloud=50, day=date(2026, 11, 11)):
    """The shape of backend/tests/test_google_weather.py::_hour_item."""
    start = datetime.combine(day, datetime.min.time()) + timedelta(hours=h) - timedelta(hours=7)
    return {
        "interval": {"startTime": start.strftime("%Y-%m-%dT%H:%M:%SZ"), "endTime": (start + timedelta(hours=1)).strftime("%Y-%m-%dT%H:%M:%SZ")},
        "displayDateTime": {"year": day.year, "month": day.month, "day": day.day, "hours": h, "utcOffset": "25200s"},
        "isDaytime": 6 <= h < 18,
        "weatherCondition": {"type": "RAIN" if rain else "CLOUDY", "description": {"text": "x", "languageCode": "en"},
                             "iconBaseUri": "https://maps.gstatic.com/weather/v1/cloudy"},
        "temperature": {"degrees": 25 + h / 4, "unit": "CELSIUS"},
        "feelsLikeTemperature": {"degrees": 27.3, "unit": "CELSIUS"},
        "dewPoint": {"degrees": 21.4, "unit": "CELSIUS"},
        "relativeHumidity": 70,
        "cloudCover": cloud,
        "uvIndex": 5 if 10 <= h <= 14 else 0,
        "precipitation": {"qpf": {"quantity": rain, "unit": "MILLIMETERS"}, "probability": {"percent": 40, "type": "RAIN"}},
        "thunderstormProbability": 10,
        "airPressure": {"meanSeaLevelMillibars": 1009.42},
        "wind": {"speed": {"value": 36, "unit": "KILOMETERS_PER_HOUR"}, "gust": {"value": 18, "unit": "KILOMETERS_PER_HOUR"},
                 "direction": {"degrees": 90, "cardinal": "EAST"}},
        "visibility": {"distance": 16, "unit": "KILOMETERS"},
    }


G_CURRENT = {
    "currentTime": "2026-11-12T05:04:12.025273178Z",
    "timeZone": {"id": "Asia/Bangkok"},
    "isDaytime": True,
    "weatherCondition": {"iconBaseUri": "https://maps.gstatic.com/weather/v1/mostly_sunny",
                         "description": {"text": "Mostly sunny", "languageCode": "en"}, "type": "MOSTLY_CLEAR"},
    "temperature": {"degrees": 31.7, "unit": "CELSIUS"},
    "feelsLikeTemperature": {"degrees": 36.2, "unit": "CELSIUS"},
    "dewPoint": {"degrees": 22.1, "unit": "CELSIUS"},
    "heatIndex": {"degrees": 36.2, "unit": "CELSIUS"},
    "windChill": {"degrees": 31.7, "unit": "CELSIUS"},
    "relativeHumidity": 57,
    "uvIndex": 8,
    "precipitation": {"probability": {"percent": 5, "type": "RAIN"}, "qpf": {"quantity": 0, "unit": "MILLIMETERS"}},
    "thunderstormProbability": 0,
    "airPressure": {"meanSeaLevelMillibars": 1010.85},
    "wind": {"direction": {"degrees": 335, "cardinal": "NORTH_NORTHWEST"}, "speed": {"value": 8, "unit": "KILOMETERS_PER_HOUR"},
             "gust": {"value": 19, "unit": "KILOMETERS_PER_HOUR"}},
    "visibility": {"distance": 16, "unit": "KILOMETERS"},
    "cloudCover": 30,
    "currentConditionsHistory": {"temperatureChange": {"degrees": 1.2, "unit": "CELSIUS"},
                                 "maxTemperature": {"degrees": 33.4, "unit": "CELSIUS"},
                                 "minTemperature": {"degrees": 23.9, "unit": "CELSIUS"},
                                 "qpf": {"quantity": 3.3165, "unit": "MILLIMETERS"}},
}

G_CURRENT_IMPERIAL = {
    **G_CURRENT,
    "temperature": {"degrees": 89.1, "unit": "FAHRENHEIT"},
    "feelsLikeTemperature": {"degrees": 97.2, "unit": "FAHRENHEIT"},
    "dewPoint": {"degrees": 71.8, "unit": "FAHRENHEIT"},
    "precipitation": {"probability": {"percent": 70, "type": "HEAVY_RAIN"}, "qpf": {"quantity": 0.13, "unit": "INCHES"}},
    "wind": {"direction": {"degrees": 180}, "speed": {"value": 5, "unit": "MILES_PER_HOUR"}, "gust": {"value": 12.3, "unit": "MILES_PER_HOUR"}},
    "visibility": {"distance": 10, "unit": "MILES"},
    "currentConditionsHistory": {"maxTemperature": {"degrees": 92.1, "unit": "FAHRENHEIT"},
                                 "minTemperature": {"degrees": 75, "unit": "FAHRENHEIT"}, "qpf": {"quantity": 0.1, "unit": "INCHES"}},
}


def gen_google():
    rng = random.Random(20261127)
    cur = []
    for name, d in [("realistic", G_CURRENT), ("imperial", G_CURRENT_IMPERIAL),
                    ("test_fahrenheit_inches", {"temperature": {"degrees": 86, "unit": "FAHRENHEIT"},
                                                "currentConditionsHistory": {"qpf": {"quantity": 0.1, "unit": "INCHES"}}}),
                    ("test_fake_current", {"temperature": {"degrees": 30, "unit": "CELSIUS"}, "cloudCover": 80, "currentTime": "2026-11-12T05:00:00.123456789Z"}),
                    ("empty", {}),
                    ("unit_missing_defaults", {"wind": {"speed": {"value": 36}, "gust": {"value": 10, "unit": ""}}, "precipitation": {"qpf": {"quantity": 1.234}},
                                               "visibility": {"distance": 9.96}}),
                    ("unit_unknown", {"wind": {"speed": {"value": 36, "unit": "KNOTS"}}, "visibility": {"distance": 9, "unit": "FEET"},
                                      "temperature": {"degrees": 300, "unit": "KELVIN"}}),
                    ("unit_number", {"wind": {"speed": {"value": 36, "unit": 5}}}),
                    ("unit_list_raises", {"wind": {"speed": {"value": 36, "unit": ["KILOMETERS_PER_HOUR"]}}}),
                    ("strings_as_numbers", {"relativeHumidity": "57", "cloudCover": " 30 ", "uvIndex": "1_0", "temperature": {"degrees": "31.75"}}),
                    ("bool_numbers", {"relativeHumidity": True, "cloudCover": False, "temperature": {"degrees": True}}),
                    ("nulls", {k: None for k in G_CURRENT}),
                    ("falsy_containers", {"weatherCondition": {}, "precipitation": [], "wind": 0, "airPressure": "", "timeZone": None}),
                    ("wind_string_raises", {"wind": "x"}),
                    ("condition_number_divergent", {"weatherCondition": {"type": 3, "description": {"text": 5}}, "isDaytime": 1, "timeZone": {"id": 7}}),
                    ("time_offset_replaced", {"currentTime": "2026-11-12T12:00:00+07:00"}),
                    ("time_no_frac", {"currentTime": "2026-11-12T05:00:00Z"}),
                    ("time_bad", {"currentTime": "yesterday"}),
                    ("rounding", {"temperature": {"degrees": 0.25}, "precipitation": {"qpf": {"quantity": 2.675}}, "wind": {"speed": {"value": 0.18}},
                                  "visibility": {"distance": 0.05, "unit": "MILES"}})]:
        cur.append(run(gw.parse_current, name, d))
    for i in range(300):
        cur.append(run(gw.parse_current, f"mut{i}", mutate(rng, rng.choice([G_CURRENT, G_CURRENT_IMPERIAL]), rng.randint(1, 6))))

    hours = []
    for h in range(24):
        hours.append(run(gw.parse_history_hour, f"hour{h}", g_hour_item(h, rain=1.5 if 12 <= h < 16 else 0.0)))
    base = g_hour_item(10, rain=1.5)
    edge = [
        ("no_display_uses_offset", {**base, "displayDateTime": {"utcOffset": "25200s"}}),
        ("offset_int", {**base, "displayDateTime": {"utcOffset": 25200}}),
        ("offset_float", {**base, "displayDateTime": {"utcOffset": "19800.5s"}}),
        ("offset_negative", {**base, "displayDateTime": {"utcOffset": "-36000s"}}),
        ("offset_ss", {**base, "displayDateTime": {"utcOffset": "3600ss"}}),
        ("offset_null", {**base, "displayDateTime": {"utcOffset": None}}),
        ("offset_bool", {**base, "displayDateTime": {"utcOffset": True}}),
        ("offset_garbage", {**base, "displayDateTime": {"utcOffset": "+07:00"}}),
        ("offset_nan_raises", {**base, "displayDateTime": {"utcOffset": "nans"}}),
        ("no_display", {k: v for k, v in base.items() if k != "displayDateTime"}),
        ("no_interval_no_display", {k: v for k, v in base.items() if k not in ("displayDateTime", "interval")}),
        ("display_only", {"displayDateTime": {"year": 2026, "month": 11, "day": 11, "hours": 10, "minutes": 30}}),
        ("display_string_raises", {**{k: v for k, v in base.items() if k != "displayDateTime"}, "displayDateTime": "2026-11-11"}),
        ("bad_display_with_offset", {**base, "displayDateTime": {"year": 2026, "month": 13, "day": 1, "utcOffset": "25200s"}}),
        ("start_frac", {**base, "interval": {"startTime": "2026-11-11T03:00:00.999999999Z"}, "displayDateTime": {"utcOffset": "1800s"}}),
        ("interval_string_raises", {**base, "interval": "x"}),
        ("empty", {}),
    ]
    for name, d in edge:
        hours.append(run(gw.parse_history_hour, name, d))
    for i in range(300):
        hours.append(run(gw.parse_history_hour, f"mut{i}", mutate(rng, g_hour_item(rng.randrange(24), rain=rng.choice([0, 0.4, 2.675])), rng.randint(1, 6))))
    return {"parse_current": cur, "parse_history_hour": hours}


# ------------------------------------------------------------------------------- Longdo

L_FRAMES = {"radar": {"past": [{"time": 1763434800}, {"time": 1763434200}, {"time": 1763435400}, {"time": 1763434800}]}}
L_LOCATION = {"lat": 13.7, "lon": 100.5, "unix_time": 1763435400, "rain": {"level": "moderate", "description": "ฝนปานกลาง", "intensity": 3}}
L_FORECAST = {"lead_minutes": [15, 30], "forecast": [
    {"unix_time": 1763436300, "available": True, "rain": {"intensity": 1, "level": "light", "description": "ฝนเล็กน้อย"}},
    {"unix_time": 1763437200, "available": True, "rain": {"intensity": 0, "level": "none", "description": "ไม่มีฝน"}}]}
L_AREA = {"lat": 13.7, "lon": 100.5, "radius_km": 10.0, "stats": {"rain_coverage_pct": 20.014, "max_intensity": 4, "mean_intensity": 1.3}}
L_FORECAST_AREA = {"lead_minutes": [15, 30], "forecast": [
    {"unix_time": 1763436300, "available": True, "stats": {"rain_coverage_pct": 12.55, "max_intensity": 3}},
    {"unix_time": 1763437200, "available": False, "stats": None}]}
L_LEGEND = {"levels": [{"intensity": 5, "label": "ฝนหนักมาก", "hex": "#ff0000"}, {"intensity": 0, "label": "ไม่มีฝน", "hex": "#ffffff"},
                       {"intensity": 2, "label": "ฝนปานกลาง", "hex": "#40adfa"}, {"intensity": 1, "label": "ฝนเล็กน้อย", "hex": "#a0d8ff"},
                       {"intensity": 3, "label": "ฝนหนัก", "hex": "#ffd000"}, {"intensity": 4, "label": "ฝนหนักมาก", "hex": "#ff8000"}]}


def gen_longdo():
    rng = random.Random(42)
    out = {}
    frames = [("realistic", L_FRAMES), ("test_parsing", {"radar": {"past": [{"time": 20}, {"time": 10}, {"time": None}, "x"]}}),
              ("empty", {}), ("null", None), ("list", []), ("radar_null", {"radar": None}), ("past_dict", {"radar": {"past": {"a": 1}}}),
              ("past_string", {"radar": {"past": "abc"}}), ("past_number_raises", {"radar": {"past": 5}}),
              ("radar_string_raises", {"radar": "x"}), ("zero_and_strings", {"radar": {"past": [{"time": 0}, {"time": "30"}, {"time": "3.5"}, {"time": 4.9}, {"time": True}, {"time": -5}]}})]
    out["parse_frames"] = [run(lw.parse_frames, n, b) for n, b in frames] + \
        [run(lw.parse_frames, f"mut{i}", mutate(rng, L_FRAMES, rng.randint(1, 4))) for i in range(100)]
    rains = [("realistic", L_LOCATION["rain"]), ("zero", {"intensity": 0}), ("no_intensity", {"description": "x"}), ("nine", {"intensity": 9}),
             ("null", None), ("level_only", {"intensity": 2, "level": "light"}), ("empty_desc", {"intensity": 2, "description": "", "level": "lv"}),
             ("number_desc", {"intensity": 2, "description": 5}), ("float_desc", {"intensity": 2, "description": 2.5}), ("bool_desc", {"intensity": 2, "description": True}),
             ("str_intensity", {"intensity": "4"}), ("float_intensity", {"intensity": 4.7}), ("bool_intensity", {"intensity": True}),
             ("negative", {"intensity": -1}), ("string", "x"), ("list", [1])]
    out["parse_rain"] = [run(lw.parse_rain, n, b) for n, b in rains]
    for i in range(100):
        m = mutate(rng, {"rain": L_LOCATION["rain"]}, rng.randint(1, 3))
        out["parse_rain"].append(run(lw.parse_rain, f"mut{i}", m.get("rain")))
    fc = [("realistic", L_FORECAST),
          ("test_parsing", {"lead_minutes": [15, 30], "forecast": [{"unix_time": 100, "available": True, "rain": {"intensity": 1, "description": "a"}},
                                                                    {"unix_time": 200, "available": False, "rain": {"intensity": 4}}]}),
          ("leads_short", {"lead_minutes": [15], "forecast": [{"unix_time": 1}, {"unix_time": 2}, "x", {"unix_time": 3}]}),
          ("non_dict_item_keeps_index", {"lead_minutes": [15, 30, 45], "forecast": ["x", {"unix_time": 2, "rain": {"intensity": 2}}]}),
          ("leads_string", {"lead_minutes": "1530", "forecast": [{"unix_time": 1}, {"unix_time": 2}]}),
          ("leads_dict_raises", {"lead_minutes": {"a": 1}, "forecast": [{"unix_time": 1}]}),
          ("leads_number_raises", {"lead_minutes": 15, "forecast": [{"unix_time": 1}]}),
          ("available_falsy", {"forecast": [{"available": None, "rain": {"intensity": 1}}, {"available": 0, "rain": {"intensity": 1}},
                                            {"available": "", "rain": {"intensity": 1}}, {"available": "no", "rain": {"intensity": 1}}]}),
          ("forecast_dict", {"forecast": {"a": {"unix_time": 1}}}), ("forecast_number_raises", {"forecast": 3}), ("empty", {}), ("null", None), ("list", [])]
    out["parse_forecast"] = [run(lw.parse_forecast, n, b) for n, b in fc] + \
        [run(lw.parse_forecast, f"mut{i}", mutate(rng, L_FORECAST, rng.randint(1, 5))) for i in range(150)]
    st = [("realistic", L_AREA["stats"]), ("test_zero", {"rain_coverage_pct": 0.0, "max_intensity": 0}), ("empty", {}), ("null", None),
          ("cover_only", {"rain_coverage_pct": 5}), ("top_out_of_range", {"max_intensity": 9}), ("cover_and_bad_top", {"rain_coverage_pct": "12.25", "max_intensity": 7}),
          ("cover_bool", {"rain_coverage_pct": True, "max_intensity": 1}), ("round_tie", {"rain_coverage_pct": 0.25}), ("round_tie2", {"rain_coverage_pct": 12.35}),
          ("string", "x")]
    out["parse_area_stats"] = [run(lw.parse_area_stats, n, b) for n, b in st]
    for i in range(100):
        m = mutate(rng, {"stats": L_AREA["stats"]}, rng.randint(1, 3))
        out["parse_area_stats"].append(run(lw.parse_area_stats, f"mut{i}", m.get("stats")))
    fa = [("realistic", L_FORECAST_AREA),
          ("test_area_parsing", {"lead_minutes": [15, 30], "forecast": [{"unix_time": 1, "available": True, "stats": {"rain_coverage_pct": 5}},
                                                                         {"unix_time": 2, "available": False, "stats": {"rain_coverage_pct": 9}}]}),
          ("empty", {}), ("null", None)]
    out["parse_forecast_area"] = [run(lw.parse_forecast_area, n, b) for n, b in fa] + \
        [run(lw.parse_forecast_area, f"mut{i}", mutate(rng, L_FORECAST_AREA, rng.randint(1, 5))) for i in range(150)]
    lg = [("realistic", L_LEGEND), ("test_parsing", {"levels": [{"intensity": 2, "label": "Light", "hex": "#40adfa"}, {"intensity": 1}]}),
          ("stable_sort", {"levels": [{"intensity": 1, "label": "b", "hex": "#2"}, {"intensity": 1, "label": "a", "hex": "#1"}, {"intensity": 0, "hex": "#0"}]}),
          ("label_falsy", {"levels": [{"intensity": 1, "label": 0, "hex": "#1"}, {"intensity": 2, "label": None, "hex": "#2"}, {"intensity": 3, "label": 7, "hex": "#3"}]}),
          ("intensity_out_of_range_kept", {"levels": [{"intensity": 99, "hex": "#9"}, {"intensity": "-2", "hex": "#8"}]}),
          ("hex_not_string", {"levels": [{"intensity": 1, "hex": 255}]}), ("levels_dict", {"levels": {"a": 1}}),
          ("levels_number_raises", {"levels": 4}), ("empty", {}), ("null", None), ("list", [])]
    out["parse_legend"] = [run(lw.parse_legend, n, b) for n, b in lg] + \
        [run(lw.parse_legend, f"mut{i}", mutate(rng, L_LEGEND, rng.randint(1, 5))) for i in range(150)]
    return out


# ---------------------------------------------------------------------------- RainViewer

RV_BODY = {"host": "https://tilecache.rainviewer.com",
           "radar": {"past": [{"time": 1740449400, "path": "/v2/radar/bbb"}, {"time": 1740448800, "path": "/v2/radar/aaa"}, {"time": 5}]}}
RV_REAL = {"version": "2.0", "generated": 1740450000, "host": "https://tilecache.rainviewer.com/",
           "radar": {"past": [{"time": 1740443400 + 600 * i, "path": f"/v2/radar/{1740443400 + 600 * i:x}"} for i in range(13)],
                     "nowcast": []},
           "satellite": {"infrared": []}}


def gen_rainviewer():
    rng = random.Random(9)
    cases = [("test_body", RV_BODY), ("realistic", RV_REAL), ("insecure", {"host": "http://insecure", "radar": {"past": []}}), ("list", []),
             ("null", None), ("no_host", {"radar": {"past": []}}), ("host_number", {"host": 5}), ("no_radar", {"host": "https://h"}),
             ("radar_list", {"host": "https://h", "radar": [1]}), ("past_dict", {"host": "https://h", "radar": {"past": {"a": 1}}}),
             ("past_number_raises", {"host": "https://h", "radar": {"past": 5}}),
             ("duplicates_last_wins", {"host": "https://h///", "radar": {"past": [{"time": 20, "path": "/a"}, {"time": 10, "path": "/b"}, {"time": "20", "path": "/c"}]}}),
             ("bad_paths", {"host": "https://h", "radar": {"past": [{"time": 1, "path": "a"}, {"time": 2, "path": 5}, {"time": 0, "path": "/z"}, {"time": True, "path": "/t"}, {"time": 9, "path": "/"}]}}),
             ("numeric_key_order", {"host": "https://h", "radar": {"past": [{"time": 100, "path": "/a"}, {"time": 9, "path": "/b"}, {"time": 1000, "path": "/c"}]}})]
    out = [run(rv.parse_maps, n, b) for n, b in cases]
    out += [run(rv.parse_maps, f"mut{i}", mutate(rng, RV_REAL, rng.randint(1, 5))) for i in range(150)]
    return {"parse_maps": out}


def main():
    data = {**gen_scalars(), **gen_google(), **gen_longdo(), **gen_rainviewer()}
    path = HERE / "weather.json"
    path.write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":"), allow_nan=False) + "\n")
    for k, v in data.items():
        raises = sum(1 for c in v if isinstance(c, dict) and "raises" in c)
        print(f"{k}: {len(v)} cases" + (f" ({raises} raise in Python)" if raises else ""))


if __name__ == "__main__":
    main()
