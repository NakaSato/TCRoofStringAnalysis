"""Golden fixtures for the Rust port of `backend/solar_core/growatt/` (crate tcroof-clients).

Feeds the Python parsers and the Python `GrowattClient` (through a scripted fake HTTP session,
never the network) realistic Growatt payloads plus edge cases, and writes what Python answers
as JSON next to this file. `rust/crates/clients/tests/growatt_parity.rs` asserts the Rust port
answers the same.

Run from the repo root:

    PYTHONPATH=backend uv run python rust/crates/clients/tests/fixtures/growatt_gen.py
"""

from __future__ import annotations

import json
import math
from datetime import date, datetime
from pathlib import Path
from typing import Any, Dict, List

import requests

from solar_core.growatt import client as C
from solar_core.growatt import parsers as P

OUT = Path(__file__).resolve().parent


# --------------------------------------------------------------------------- encoding


def enc(o: Any) -> Any:
    """Python result → JSON: datetimes ISO (no offset: Growatt times are naive plant-local),
    tuples → lists, non-finite floats → {"__float": "inf" | "-inf" | "nan"}."""
    if isinstance(o, datetime):
        return o.isoformat()
    if isinstance(o, date):
        return o.isoformat()
    if isinstance(o, float) and not math.isfinite(o):
        return {"__float": "nan" if math.isnan(o) else ("inf" if o > 0 else "-inf")}
    if isinstance(o, dict):
        return {str(k): enc(v) for k, v in o.items()}
    if isinstance(o, (list, tuple)):
        return [enc(v) for v in o]
    return o


def run(fn, *args, **kw) -> Dict[str, Any]:
    try:
        return {"ok": enc(fn(*args, **kw))}
    except Exception as exc:  # noqa: BLE001 - the fixture records whatever Python raises
        out: Dict[str, Any] = {"error": type(exc).__name__, "message": str(exc)}
        if isinstance(exc, C.GrowattAPIError):
            out["error_code"] = exc.error_code
        return out


def write(name: str, data: Any) -> int:
    path = OUT / name
    path.write_text(json.dumps(data, ensure_ascii=False, indent=1, allow_nan=False) + "\n", encoding="utf-8")
    n = sum(len(v) for v in data.values()) if isinstance(data, dict) else len(data)
    print(f"{path.name}: {n} cases")
    return n


# --------------------------------------------------------------------------- realistic records


def max_record(ts: str, strings: int = 20, ppv: Any = 61234.5, **over: Any) -> Dict[str, Any]:
    """A `max_data` record shaped like the real ones (trimmed: the real one has ~278 fields)."""
    r: Dict[str, Any] = {
        "serialNum": "EPHNEYN00Q",
        "time": ts,
        "calendar": {"time": 1794717078792, "timezone": {"ID": "Asia/Shanghai"}},
        "status": 1,
        "statusText": "Normal",
        "pac": 59870.2,
        "ppv": ppv,
        "eacToday": 312.4,
        "eacTotal": 412345.6,
        "temperature": 48.3,
        "temperature2": 55.1,
        "temperature3": 51.0,
        "temperature5": 47.9,
        "fac": 50.01,
        "vacr": 231.2, "vacs": "230.8", "vact": 229.9,
        "vacRs": 400.1, "vacSt": 399.7, "vacTr": "",
        "iacr": 86.4, "iacs": 86.1, "iact": None,
        "pf": 0.999, "reactPower": -120.0,
        "faultType": 0, "faultCode1": 0, "faultCode2": 0, "faultValue": 0,
        "warnCode": 0, "warnCode1": 0, "warningValue1": 0, "warningValue2": 0, "warningValue3": 0,
        "pidFaultCode": 0, "StrBreak": 0, "pvIso": 65530,
        "afciStatus": 0, "afciPv1": 0, "afciPv2": 0, "gfci": 12.0,
        "rDci": 31.0, "sDci": 29.0, "tDci": 30.0,
        "timeTotal": 25378280.0,
        "debug1": "1，4，5",
        "isAgain": False,
    }
    for n in range(1, 9):
        r[f"vpv{n}"] = 735.3 - n
        r[f"ipv{n}"] = 14.12 + n / 100
        r[f"ppv{n}"] = round((735.3 - n) * (14.12 + n / 100), 1)
        r[f"epv{n}Today"] = 38.2 + n
        r[f"epv{n}Total"] = 51234.5 + n
    for n in range(9, 17):
        r[f"vpv{n}"] = 0
        r[f"ipv{n}"] = 0
        r[f"ppv{n}"] = 0
        r[f"epv{n}Today"] = 0
        r[f"epv{n}Total"] = 0
    for n in range(1, 33):
        on = n <= strings
        r[f"vString{n}"] = 735.3 - (n + 1) // 2 if on else 0
        r[f"currentString{n}"] = (7.06 + n / 1000) if on else 0
    r.update(over)
    return r


def env_record(ts: Any, **over: Any) -> Dict[str, Any]:
    r = {
        "timeText": ts,
        "calendar": {"time": 1794717078792},
        "radiant": "640.5", "envTemp": "31.2", "panelTemp": "47.8", "envHumidity": "0",
        "windSpeed": "1.2", "windAngle": "90", "rainfall": "0", "pressure": "0", "etodayRadiation": "0",
        "datalogSn": "DYDCE9302Z", "address": 32,
    }
    r.update(over)
    return r


def meter_record(ts: Any, **over: Any) -> Dict[str, Any]:
    r = {
        "timeText": ts,
        "activePower": 259611, "activePowerL1": 67749, "activePowerL2": "86500.5", "activePowerL3": 105361,
        "reactivePower": -1200.5, "powerFactor": 0.98, "frequency": "50.0",
        "posiActivePower": 2659930, "positiveActiveTodayEnergy": 1234.5,
        "reverActivePower": 0, "reverseActiveTodayEnergy": "",
        "activeEnergy": 2659930, "lost": False,
    }
    r.update(over)
    return r


# --------------------------------------------------------------------------- scalars


ODD_TIMES = [
    "2026-11-13 11:55:00", "2026-1-5 7:3:9", "2026-01- 5  07:00:00", "2026-01-05\t07:00:00",
    "2026-01-05 07:00:00 ", " 2026-01-05 07:00:00", "2026-01-01 00:00:60", "2026-02-29 10:00:00",
    "2024-02-29 10:00:00", "2026-11-13T11:55:00", "2026-11-13 11:55", "2026-11-13 11:55:00.123",
    "0000-01-01 00:00:00", "26-11-13 11:55:00", "2026-13-01 00:00:00", "2026-12-31 23:59:59",
    "2026-11-13 24:00:00", "2026-11-13  1:05:07", "2026-11-13 1:5:7", "2026-11-13 11:75:00",
    "2026-11-13 11:5:00", "2026-11-13 11:55:7", "2026-11-13 11:55:75", "2026-011-13 11:55:00",
    "2026-11-3 11:55:00", "2026-11-03 11:55:00\n", "2026-11-13　11:55:00", "bad", "", "None",
    "2026-11-13  11:55:00", "2026-11-13\x1c11:55:00", "2026-11-30 23:59:59", "2026-04-31 10:00:00",
]

ISO_DATES = [
    "2026W431", "2026W43", "2026-W43", "2026-1105", "202611-05", "2026-11-5", "2026-11-05 ", "2026-02-30",
    "2026-11-05xyz", "+2026-11-0", "\uff12\uff10\uff12\uff16-11-05", "2026-W53-1", "2020-W53-7", "2026-W43-8",
    "0000-01-01", "2026-W431", "2026W43-1", "20261105", "2026-11", "202611", "2026-W4", "2026W4", "2026-W43-",
    "2026-W00-1", "2026-111-05", "2025-W53-1", "2026W537", "2026-13-01", "2026-00-10", "2026-12-00", "2024-02-29",
    "None", "", "2026-11-13T00:00:00", "1-01-01", "0001-01-01", "9999-12-31", "2026w43", "2026-w43-1", "2026-W43-0",
]

SCALARS: List[Any] = [
    None, "", " ", 0, 0.0, -0.0, 1, -7, 12.5, 1e20, 1e-5, 1.5e-7, 1e16, 1e15, 123456789.125,
    True, False, "12.5", " 12.5 ", "\t3\n", "1_000", "1__0", "_1", "1_", "1_0.5", "1e3", "1E+03",
    "1.", ".5", ".", "e5", "+4", "-4.25", "inf", "-Infinity", "nan", "NaN", "+nan", "infinity",
    "infx", "0x10", "1,5", "abc", "65530", "3.0", "-0", "12a", " 12 ", "​12",
    [], [1, "a"], {}, {"a": None, "b": True}, "Thai ไทย", " x ", "　y　", "a\x1fb",
    9007199254740993, -9223372036854775808, 2.5, 3.5, -2.5, 0.1, 1e300, 5e-324,
]

ROUNDS = [0.125, 0.375, 2.675, 1.005, 0.5, 1.5, 2.5, -0.05, -0.04, 1234.5678, 7.0605, 7.0615,
          0.0005, 0.0015, 1e-7, 123456789.123456, 5110.049999, 3850.05, 735.3 * 14.13, -1.25, 99.995]


def scalars() -> Dict[str, Any]:
    cases: Dict[str, List[Any]] = {"f": [], "text": [], "nonzero_int": [], "env_time": [], "record_time": [],
                                   "round": [], "round_h": [], "snippet": [], "error_text": []}
    for v in SCALARS:
        cases["f"].append({"in": v, "out": run(P._f, v)})
        cases["text"].append({"in": v, "out": run(P._text, v)})
        cases["nonzero_int"].append({"in": v, "out": run(P._nonzero_int, v)})
        cases["env_time"].append({"in": v, "out": run(P._env_time, {"timeText": v})})
        cases["record_time"].append({"in": v, "out": run(P._record_time, {"time": v})})
        cases["snippet"].append({"in": v, "out": run(C._snippet, v)})
    for v in ODD_TIMES:
        cases["env_time"].append({"in": v, "out": run(P._env_time, {"timeText": v})})
        cases["record_time"].append({"in": v, "out": run(P._record_time, {"time": v})})
    cases["env_time"].append({"in": "__missing__", "out": run(P._env_time, {})})
    # `plant_energy_days` parses dates with `date.fromisoformat(str(v)[:10])`, `plant_power_day`
    # times with "%Y-%m-%d %H:%M"
    cases["fromisoformat"] = []
    for v in ISO_DATES:
        cases["fromisoformat"].append({"in": v, "out": run(lambda x: date.fromisoformat(x[:10]), v)})
    cases["strptime_hm"] = []
    for v in ODD_TIMES + ["2026-11-14 08:05", "2026-11-14 7:5", "2026-11-14 24:00", "2026-11-14  8:05", "2026-11-14 08:05 "]:
        cases["strptime_hm"].append({"in": v, "out": run(datetime.strptime, v, "%Y-%m-%d %H:%M")})
    for v in ROUNDS:
        for n in (1, 2, 3):
            cases["round"].append({"in": v, "n": n, "out": round(v, n)})
    for v in [None, 0.0, 25378280.0, 1799.0, 1980.0, 5400.0, 3600 * 0.25, -1980.0, 1e-9, 17999.999]:
        cases["round_h"].append({"in": v, "out": run(P._round_h, v)})
    long = "x" * 400
    for v in [long, "a  b\n\tc", "ไทย " * 100, {"k": long}, ["a", 1, None, True, 1.5, {"n": "it's"}],
              {"q": 'say "hi"', "both": "it's \"x\"", "ctl": "a\x01b\x7f\u0085", "uni": " ​ é😀"}]:
        cases["snippet"].append({"in": v, "out": run(C._snippet, v)})
    bodies = [
        {"error_code": 10012, "error_msg": "error_frequently_access"},
        {"error_code": 10012, "error_msg": "", "msg": "too fast"},
        {"error_code": 10001, "error_msg": "", "data": {"x": 1}},
        {"error_code": 10001},
        {"error_code": 10002, "error_msg": "   ", "message": " padded \n"},
        {"error_code": 10003, "error_msg": 5, "error_message": "em"},
        {"error_code": 1, "error": "", "result_msg": "rm"},
        {"error_code": 1, "zeta": 1, "alpha": [1, 2.5, None], "mid": {"b": False, "a": "x"}},
        {"error_code": 1, "data": None, "error_msg": None},
        {},
        {"error_code": 2, "long": "y" * 500},
    ]
    for b in bodies:
        cases["error_text"].append({"in": b, "out": run(C.growatt_error_text, b)})
    return cases


# --------------------------------------------------------------------------- parsers


def parsers() -> Dict[str, Any]:
    cases: Dict[str, List[Any]] = {k: [] for k in (
        "parse_env_records", "parse_meter_records", "parse_max_info", "parse_max_grid",
        "parse_max_diagnostics", "parse_max_mppt_energy", "parse_max_raw", "parse_max_records")}

    def add(name: str, args: Dict[str, Any], fn, *call, **kw):
        cases[name].append({"args": args, "out": run(fn, *call, **kw)})

    env_sets = [
        [env_record("2026-11-13 11:55:00"), env_record("2026-11-13 11:50:00", radiant=600, envTemp=None, panelTemp="")],
        [env_record("2026-11-13 11:55:00"), env_record("bad"), {"timeText": "2026-11-13 11:55:00", "radiant": "1"},
         env_record("2026-11-13 11:45:00", windSpeed="abc", windAngle=True)],
        [{"radiant": 5}, {"timeText": None}],
        [],
        [env_record("2026-11-13 11:55:00"), "notadict"],
        [env_record("2026-11-13 11:55:00", radiant="1_000", envHumidity=" 64 ", envTemp="nan")],
    ]
    for recs in env_sets:
        add("parse_env_records", {"datalogger_sn": "DYDCE9302Z", "address": 32, "records": recs},
            P.parse_env_records, "DYDCE9302Z", 32, recs)
    meter_sets = [
        [meter_record("2026-11-15 20:05:01"), meter_record("2026-11-15 20:00:00", activePower=-5000.5)],
        [meter_record("2026-11-15 20:05:01"), {"timeText": "bad", "activePower": 5},
         {"timeText": "2026-11-15 20:05:01", "activePower": 7}],
        [{"timeText": "2026-11-11 10:05:01", "activePower": 100}, {"timeText": "2026-11-11 10:00:03"}],
        [],
    ]
    for recs in meter_sets:
        add("parse_meter_records", {"datalogger_sn": "DL1", "address": 36, "records": recs},
            P.parse_meter_records, "DL1", 36, recs)

    infos = [
        {"serialNum": "A", "alias": "INVERTER 3", "fwVersion": "TI1.0", "innerVersion": "TIAA25220401",
         "normalPower": 80000, "onOff": 0, "activeRate": 0, "reactiveRate": 0, "pf": 0.0, "exportLimit": 0},
        {"alias": " INV 1 ", "normalPower": "50000", "fwVersion": "", "innerVersion": None, "activeRate": 100,
         "reactiveRate": "0", "pf": 1, "pfModel": "2.7", "exportLimit": 1, "exportLimitPowerRate": "80.5", "onOff": "1"},
        {"alias": "   ", "normalPower": 0, "activeRate": 10, "pf": 0},
        {"alias": 12, "normalPower": "abc", "activeRate": 0, "pf": 0.95, "onOff": True, "pfModel": -1.5},
        {"alias": 1.0, "fwVersion": True, "innerVersion": [1, "a"], "normalPower": -5, "activeRate": "", "pf": ""},
        {},
        {"activeRate": "inf", "pf": 1, "onOff": "inf"},
        {"activeRate": "nan", "pf": 0},
        {"alias": {"b": 1}, "activeRate": 50, "pf": 1.0, "pfModel": "x"},
    ]
    for m in infos:
        add("parse_max_info", {"m": m}, P.parse_max_info, m)

    full = max_record("2026-11-13 11:55:00")
    recs_grid = [full, {}, {"vacr": "abc", "pf": True, "fac": " 50 "}]
    for r in recs_grid:
        add("parse_max_grid", {"r": r}, P.parse_max_grid, r)
    diags = [
        full,
        {},
        max_record("2026-11-13 11:55:00", faultType=117, faultCode1="203", warnCode1=2.9, warningValue2=-3.7,
                   pvIso=1200, StrBreak=5, afciPv2="1", timeTotal=1980, gfci="", rDci=None),
        {"pvIso": 65531}, {"pvIso": "65529.9"}, {"pvIso": "nan"}, {"faultType": "inf"}, {"faultType": "nan"},
        {"timeTotal": "abc", "faultType": True, "warnCode1": "x"},
    ]
    for r in diags:
        add("parse_max_diagnostics", {"r": r}, P.parse_max_diagnostics, r)
    mppt = [full, {}, {"epv1Today": 0, "epv1Total": 5, "epv2Today": "1.5", "epv3Today": "", "epv3Total": None,
                       "epv16Today": 2, "epv17Today": 3, "epv4Today": "nan"}]
    for r in mppt:
        add("parse_max_mppt_energy", {"r": r, "max_mppts": 16}, P.parse_max_mppt_energy, r)
    add("parse_max_mppt_energy", {"r": full, "max_mppts": 4}, P.parse_max_mppt_energy, full, 4)

    raws = [
        [{"time": "2026-11-13 00:03:45", "serialNum": "SN1", "calendar": {"x": 1}, "status": 0,
          "temperature2": 23.2, "pvIso": 143, "debug1": "1，4，5", "isAgain": False}, {"status": 1}],
        [full, max_record("2026-11-13 11:55:00", pac=1.0)],
        [{"time": "", "a": 1}, {"time": None}, {"time": 0}],
        [{"time": "bad"}],
        [{"time": 20261113}],
        [],
    ]
    for recs in raws:
        add("parse_max_raw", {"device_sn": "SN1", "records": recs}, P.parse_max_raw, "SN1", recs)

    day = {"time": "2026-11-11 12:00:00", "ppv": 9000, "pac": 8800, "status": 1,
           "vString1": 730, "currentString1": 7.0, "vString2": 730, "currentString2": 0,
           "vString3": 700, "currentString3": 5.5, "vpv1": 730, "ipv1": 7.0, "ppv1": 5110}
    night = {"time": "2026-11-11 23:00:00", "ppv": 0, "pac": 0, "status": 0,
             "vString1": 60, "currentString1": 0, "vString2": 60, "vString3": 60}
    record_sets: List[Any] = [
        ([day, night], {}),
        ([max_record(f"2026-11-13 11:{m:02}:00") for m in (55, 50, 45)], {}),
        ([max_record("2026-11-13 11:55:00", strings=18, ppv="61000.5", status="1", faultType=117, warnCode=3.0,
                     warnCode1=9),
          max_record("2026-11-13 11:50:00", ppv=None, pac="", status=None, faultType="", warnCode="abc")], {}),
        ([max_record("2026-11-13 11:55:00"), max_record("2026-11-13 11:55:00", ppv=0, pac=7)], {}),
        ([max_record("2026-11-13 11:55:00", ppv=5), {"time": "", "vString25": 5}, {"vString26": 1}], {}),
        ([max_record("2026-11-13 11:55:00", vString3="abc", currentString3=" 7.123456 ", vpv2=None, ipv2="",
                     ppv2="nan", vpv9=0.004, ipv9=0, ppv9=0)], {}),
        ([max_record("2026-11-13 11:55:00", ppv="nan")], {}),
        ([max_record("2026-11-13 11:55:00", ppv=-3.0)], {}),
        ([max_record("2026-11-13 11:55:00")], {"max_strings": 4, "max_mppts": 2}),
        ([{"time": "2026-11-13 11:55:00", "ppv": 10, "vString40": 600, "currentString40": 1}], {"max_strings": 40}),
        ([max_record("2026-11-13 11:55:00"), {"time": "bad"}], {}),
        ([max_record("2026-11-13 11:55:00"), {"time": 5}], {}),
        ([max_record("2026-11-13 11:55:00"), 7], {}),
        ([], {}),
        ([max_record("2026-11-13 11:55:00", faultType="inf")], {}),
        ([max_record("2026-11-13 11:55:00", faultType="nan", warnCode=True)], {}),
    ]
    for recs, kw in record_sets:
        add("parse_max_records", {"device_sn": "EPHNEYN00Q", "records": recs, **kw},
            P.parse_max_records, "EPHNEYN00Q", recs, **kw)
    return cases


# --------------------------------------------------------------------------- client (scripted fake HTTP)


class _Resp:
    def __init__(self, spec: Dict[str, Any]):
        self.spec = spec

    def raise_for_status(self):
        status = self.spec.get("status", 200)
        if status >= 400:
            raise requests.HTTPError(f"{status} Server Error")

    def json(self):
        if "raw" in self.spec:
            try:
                return json.loads(self.spec["raw"])
            except json.JSONDecodeError as exc:
                # what requests itself raises (a RequestException *and* a ValueError)
                raise requests.exceptions.JSONDecodeError(exc.msg, exc.doc, exc.pos) from None
        return self.spec["body"]


class _Session:
    """Stands in for `requests.Session`: records every call, answers from a script."""

    def __init__(self, base: str, replies: List[Dict[str, Any]]):
        self.base = base
        self.replies = list(replies)
        self.seen: List[Dict[str, Any]] = []
        self.headers: Dict[str, str] = {}

    def _pairs(self, d):
        return None if d is None else [[k, str(v)] for k, v in d.items()]

    def _answer(self, method, url, params, data):
        assert url.startswith(self.base), url
        self.seen.append({"method": method, "path": url[len(self.base):], "query": self._pairs(params) or [],
                          "form": self._pairs(data)})
        if not self.replies:
            raise AssertionError(f"no scripted reply left for {url}")
        return _Resp(self.replies.pop(0))

    def get(self, url, params=None, timeout=None):
        assert timeout == 30
        return self._answer("GET", url, params, None)

    def post(self, url, data=None, params=None, timeout=None):
        assert timeout == 30
        return self._answer("POST", url, params, data)


def _d(s):
    return date.fromisoformat(s)


def _dt(s):
    return None if s is None else datetime.fromisoformat(s)


# method → how to turn the JSON args into Python ones
ARG_TYPES = {
    "plant_energy_days": (None, _d, _d),
    "plant_power_day": (None, _d),
    "inverter_day_energy": (None, _d),
    "max_history_batch": (None, _d),
    "max_history_day": (None, _d),
    "max_alarms": (None, _d),
    "newest_max_records": (None, _d),
}
KW_TYPES = {"stop_before": _dt}
RANGE_ARGS = {"max_history": (None, _d, _d), "env_history": (None, None, _d, _d), "meter_history": (None, None, _d, _d)}


def _call(client, call):
    name, args, kw = call["method"], list(call.get("args", [])), dict(call.get("kwargs", {}))
    types = ARG_TYPES.get(name) or RANGE_ARGS.get(name) or ()
    args = [t(a) if t else a for t, a in zip(list(types) + [None] * len(args), args)]
    kw = {k: KW_TYPES.get(k, lambda x: x)(v) for k, v in kw.items()}
    if name == "newest_max_records":
        return run(C.newest_max_records, client, *args, **kw)
    return run(getattr(client, name), *args, **kw)


def ok(data: Any) -> Dict[str, Any]:
    return {"body": {"error_code": 0, "error_msg": "", "data": data}}


def new_ok(data: Any) -> Dict[str, Any]:
    return {"body": {"code": 0, "message": "SUCCESSFUL_OPERATION", "data": data}}


def recs_page(start_min: int, n: int, day: str = "2026-11-13") -> List[Dict[str, Any]]:
    """`n` records newest first, 5 min apart, starting at minute `start_min` after midnight."""
    out = []
    for k in range(n):
        m = start_min - 5 * k
        out.append({"time": f"{day} {m // 60:02}:{m % 60:02}:00", "pac": 1000 + k, "ppv": 1100 + k, "status": 1})
    return out


def env_page(start_min: int, n: int, day: str = "2026-11-13", key: str = "timeText") -> List[Dict[str, Any]]:
    out = []
    for k in range(n):
        m = start_min - 5 * k
        out.append({key: f"{day} {m // 60:02}:{m % 60:02}:00", "radiant": 500 + k})
    return out


def client_cases() -> List[Dict[str, Any]]:
    base = "https://openapi.growatt.com/v1/"
    cases: List[Dict[str, Any]] = []

    def case(name, calls, replies, opts=None):
        opts = dict(opts or {})
        c = C.GrowattClient(token="tok-secret", cache_ttl_s=opts.get("cache_ttl_s", 300),
                            blocked_plant_ids=opts.get("blocked_plant_ids", ()))
        sess = _Session(base, replies)
        c.session = sess  # type: ignore[assignment]
        results = [dict(call, result=_call(c, call)) for call in calls]
        assert not sess.replies, f"{name}: {len(sess.replies)} scripted replies unused"
        cases.append({"name": name, "opts": opts, "replies": replies, "calls": results, "requests": sess.seen})

    m = lambda method, *args, **kw: {"method": method, "args": list(args), "kwargs": kw}  # noqa: E731

    # ---- plant/list: paging, blocked plants, cache, refresh
    plants1 = [{"plant_id": i, "name": f"P{i}", "city": "Bangkok"} for i in range(1, 101)]
    plants2 = [{"plant_id": "101", "name": "P101"}, {"plant_id": " 102 ", "name": "P102"},
               {"plant_id": None, "name": "nil"}, {"plant_id": "12.0", "name": "float text"},
               {"plant_id": 103.9, "name": "float"}, {"plant_id": True, "name": "bool"}, {"name": "no id"}]
    case("list_plants_pages_blocked_cached", [m("list_plants"), m("list_plants"), m("list_plants", refresh=True)],
         [ok({"count": 107, "plants": plants1}), ok({"count": 107, "plants": plants2}),
          ok({"count": "1", "plants": [{"plant_id": 7}]})],
         {"blocked_plant_ids": [5, 101, 102, 103, 1]})
    case("list_plants_cache_ttl_zero", [m("list_plants"), m("list_plants")],
         [ok({"count": 1, "plants": [{"plant_id": 1}]}), ok({"count": 1, "plants": [{"plant_id": 2}]})],
         {"cache_ttl_s": 0})
    case("list_plants_empty_and_null", [m("list_plants", refresh=True), m("list_plants", refresh=True)],
         [ok(None), ok({"count": 5, "plants": []})])
    case("list_plants_count_text_float", [m("list_plants")], [ok({"count": "2.0", "plants": [{"plant_id": 1}]})])
    case("list_plants_non_dict_plant", [m("list_plants")], [ok({"count": 1, "plants": ["x"]})])
    case("list_plants_count_float", [m("list_plants")],
         [ok({"count": 1.9, "plants": [{"plant_id": 1}]})])

    # ---- errors and transport
    case("error_10012", [m("list_plants")], [{"body": {"error_code": 10012, "error_msg": "error_frequently_access"}}])
    case("error_no_message_rest", [m("plant_data", 5)],
         [{"body": {"error_code": 10001, "error_msg": "", "zdata": {"x": 1, "a": [True, None]}, "b": 2.0}}])
    case("error_code_missing", [m("plant_data", 5)], [{"body": {"data": {"a": 1}}}])
    case("error_code_text", [m("plant_data", 5)], [{"body": {"error_code": "0", "data": {"a": 1}}}])
    case("error_code_float_zero_ok", [m("plant_data", 5)], [{"body": {"error_code": 0.0, "data": {"a": 1}}}])
    case("error_code_false_ok", [m("plant_data", 5)], [{"body": {"error_code": False, "data": [1]}}])
    case("error_code_float", [m("plant_data", 5)], [{"body": {"error_code": 10012.0, "msg": "slow"}}])
    case("reply_not_dict", [m("plant_data", 5)], [{"body": [1, "two", {"three": 3}]}])
    case("reply_string", [m("plant_data", 5)], [{"body": "  hello   world  "}])
    case("http_500", [m("plant_data", 5)], [{"status": 500, "body": {"error_code": 0}}])
    case("non_json", [m("plant_data", 5)], [{"raw": "<html>busy</html>"}])
    case("plant_data_falsy", [m("plant_data", 5), m("plant_data", 6), m("plant_data", 6)],
         [ok({}), ok(0), ok({"current_power": 1.5, "today_energy": "12.3", "last_update_time": "2026-11-15 11:30:00"})])

    # ---- device/list + list_inverters
    devices = [
        {"device_sn": "env", "type": 3, "datalogger_sn": "L1"},
        {"device_sn": "meter", "type": 3, "datalogger_sn": "L1"},
        {"device_sn": "INV2", "type": 1, "status": 1, "lost": False, "datalogger_sn": "L1", "model": "MAX 80KTL3 LV",
         "manufacturer": "Growatt", "last_update_time": "2026-11-15 11:30:00"},
        {"device_sn": "INV2", "type": 4, "status": 3, "lost": True, "datalogger_sn": "L2", "model": "other"},
        {"device_sn": "INV1", "type": 4.0, "status": 0, "lost": 0, "datalogger_sn": None, "model": ""},
        {"device_sn": "INV1", "type": True, "status": 1},
        {"device_sn": "INV3", "type": 7, "status": 2, "lost": "false"},
        {"device_sn": "INV4", "type": 5, "status": "1", "lost": None},
        {"device_sn": "INV5", "type": 6, "status": 1.0},
        {"device_sn": "INV6", "type": 1, "status": True},
        {"device_sn": "INV7", "type": 1},
        {"device_sn": 12345, "type": 1, "status": False, "model": 0},
        {"type": 1, "status": 3},
        {"device_sn": "X", "type": "1"},
        {"device_sn": "Y", "type": 2},
        {"device_sn": "Z", "type": None},
    ]
    case("list_inverters_merge", [m("list_inverters", 123), m("list_inverters", 123), m("list_devices", 123)],
         [ok({"count": len(devices), "devices": devices})])
    case("list_devices_pages_refresh", [m("list_devices", 9, refresh=True)],
         [ok({"count": 3, "devices": [{"device_sn": "A", "type": 1}, {"device_sn": "B", "type": 4}]}),
          ok({"count": 3, "devices": [{"device_sn": "C", "type": 1}]})])
    case("list_inverters_non_dict", [m("list_inverters", 9)], [ok({"count": 1, "devices": [5]})])

    # ---- max_data_info / new-api
    case("max_info_wrapped", [m("max_info", "SN1")],
         [ok({"max": {"alias": "INV 1", "normalPower": 50000, "activeRate": 100, "pf": 1, "onOff": 1}})])
    case("max_info_flat_and_empty", [m("max_info", "SN1"), m("max_info", "SN1"), m("max_info", "SN1")],
         [ok({"alias": "FLAT", "normalPower": "80000", "max": "notdict"}), ok(None), ok([1])])
    rec = {"time": "2026-11-15 11:30:12", "pac": 16479, "ppv": 16823.9, "status": 1}
    case("new_api_device_info", [m("device_info", "A"), m("device_info", "B"), m("device_info", "C")],
         [new_ok({"max": [{"serialNum": "A", "alias": "INVERTER 3", "fwVersion": "TI1.0", "innerVersion": "TIAA25220401",
                           "normalPower": 80000, "onOff": 0, "activeRate": 0, "reactiveRate": 0, "pf": 0.0,
                           "exportLimit": 0}]}),
          new_ok({"max": []}), new_ok("x")])
    case("new_api_errors", [m("read_power", "A"), m("read_power", "B"), m("read_power", "C"), m("read_power", "D"),
                            m("read_power", "E"), m("read_power", "F"), m("read_power", "G")],
         [{"body": {"code": 5, "message": "DEVICE_OFFLINE", "data": None}},
          {"body": {"code": 18, "message": "", "error_msg": "READ_DEVICE_PARAM_FAIL"}},
          {"body": {"error_code": 10012, "error_msg": "frequently"}},
          {"body": {"code": None, "error_code": 0, "data": 100}},
          {"body": {"code": 7, "message": {"z": 1, "a": "b"}}},
          {"body": {"code": 9}},
          {"body": [1]}])
    case("read_power_values", [m("read_power", "A"), m("read_power", "B"), m("read_power", "C"), m("read_power", "D")],
         [new_ok(100), new_ok("10.5"), new_ok({"v": 1}), new_ok(None)])
    case("device_last_record", [m("device_last_record", "A"), m("device_last_record", "B"),
                                m("device_last_record", "C"), m("device_last_record", "D")],
         [new_ok({"max": [rec]}), new_ok({"max": [{"time": "", "pac": 1}]}), new_ok({"max": [{}]}), new_ok([rec])])
    case("account_create_times", [m("account_create_times")],
         [new_ok({"pages": 3, "count": 4, "data": [{"deviceSn": "A", "createDate": "2024-12-26 18:53:03"},
                                                   {"deviceSn": "C", "createDate": "2024-12-26 18:53:03.0 extra"}]}),
          new_ok({"pages": "3", "data": [{"deviceSn": "B", "createDate": ""}, "skip", {"createDate": "2025-01-01 00:00:00"}]}),
          new_ok({"pages": 3, "data": [{"deviceSn": 77, "createDate": "2025-02-03 04:05:06"}]})])
    case("account_create_times_stops", [m("account_create_times"), m("account_create_times", max_pages=1),
                                        m("account_create_times", max_pages=0)],
         [new_ok({"pages": None, "data": [{"deviceSn": "A", "createDate": "2024-12-26 18:53:03"}]}),
          new_ok({"pages": 9, "data": [{"deviceSn": "A", "createDate": "2024-12-26 18:53:03"}]})])
    case("account_create_times_empty_rows", [m("account_create_times")],
         [new_ok({"pages": 5, "data": []})])
    case("device_info_param", [m("device_info_param", "S"), m("device_info_param", "T"), m("device_info_param", "U"),
                               m("device_info_param", "V")],
         [new_ok({"deviceModel": "MAX 80KTL3 LV", "dataloggerModel": "ShineMaster", "norminalPower": 80000}),
          new_ok({"deviceModel": "  ", "dataloggerModel": None, "nominalPower": "50000"}),
          new_ok({"norminalPower": None, "nominalPower": 50000}),
          new_ok({"norminalPower": -1, "deviceModel": 5})])

    # ---- energy / curves / details
    case("plant_energy_days", [m("plant_energy_days", 1, "2026-11-13", "2026-11-14"),
                               m("plant_energy_days", 1, "2026-10-01", "2026-11-14"),
                               m("plant_energy_days", 1, "2026-10-15", "2026-11-14")],
         [ok({"energys": [{"date": "2026-11-13", "energy": "1319.9"}, {"date": "2026-11-14", "energy": ""}], "count": 2}),
          ok({"energys": [{"date": "2026-10-15", "energy": 5}, {"date": "bad", "energy": 1},
                          {"date": "20261016", "energy": 6}, {"date": "2026-10-17T00:00:00", "energy": None},
                          {"date": "2026-W43-1", "energy": 7}, {"date": None, "energy": 8}], "count": 7}),
          ok({"energys": [{"date": "2026-10-18", "energy": "abc"}], "count": 7}),
          ok({"energys": [], "count": 7})])
    case("plant_energy_days_iso_variants", [m("plant_energy_days", 1, "2026-10-15", "2026-11-14")],
         [ok({"count": 99, "energys": [{"date": d, "energy": 1} for d in (
             "2026W431", "2026W43", "2026-W43", "2026-1105", "202611-05", "2026-11-5", "2026-11-05 ", "2026-02-30",
             "2026-11-05xyz", "+2026-11-0", "２０２６-11-05", "2026-W53-1", "2020-W53-7", "2026-W43-8", "0000-01-01")]}),
          ok({"count": 99, "energys": []})])
    case("plant_power_day", [m("plant_power_day", 1, "2026-11-14")],
         [ok({"count": 6, "powers": [
             {"time": "2026-11-14 08:05", "power": 96193.6015625}, {"time": "2026-11-14 01:55", "power": 0},
             {"time": "2026-11-14 18:50", "power": None}, {"time": "2026-11-14 07:30", "power": 49547.8984375},
             {"time": "2026-11-14 07:30", "power": 10}, {"time": "2026-11-14 7:5", "power": "5"},
             {"time": "2026-11-14 07:30:00", "power": 1}, {"time": None, "power": 2}]})])
    case("plant_power_day_empty", [m("plant_power_day", 1, "2026-11-14")], [ok(None)])
    case("inverter_day_energy", [m("inverter_day_energy", "SN", "2026-11-14"), m("inverter_day_energy", "SN", "2026-11-13"),
                                 m("inverter_day_energy", "SN", "2026-11-12")],
         [{"body": {"error_code": 0, "data": 189.60000610351562, "device_sn": "EPHNEYN00Q"}}, ok("12.5"), ok(None)])
    case("plant_details", [m("plant_details", 1), m("plant_details", 2), m("plant_details", 3), m("plant_details", 4)],
         [ok({"timezone": "GMT+7", "address1": "214", "address2": "", "maxs": [{"max_num": 3}],
              "dataloggers": [{"datalogger_num": 1}], "installed_dc_capacity": ""}),
          ok({"timezone": " ", "address1": " Moo 4 ", "address2": "Bang Na", "maxs": [{"max_num": "2.7"}, {"max_num": None}, "x", {"max_num": 1}],
              "dataloggers": []}),
          ok(None), ok([1, 2])])

    # ---- maxs_data
    sns = [f"S{i:03}" for i in range(60)]
    page1 = {sn: {"dataloggerSn": "DL", sn: {"time": "2026-11-15 13:31:04", "pac": 1}} for sn in sns[:50]}
    page2 = {sn: {"dataloggerSn": "DL2", sn: {"time": "2026-11-15 13:31:04", "pac": 2, "dataloggerSn": "own"}} for sn in sns[50:]}
    case("maxs_latest_pages", [m("maxs_latest", sns)], [ok(page1), ok(page2)])
    odd = {"A": {"dataloggerSn": "DL", "A": {"time": "t"}}, "B": "notdict", "C": {"C": "notdict"}, "D": {"X": {"time": "t"}},
           "E": {"E": {"pac": 1}}}
    case("maxs_latest_odd", [m("maxs_latest", ["A", "B", "C", "D", "E", "F"]), m("maxs_latest", ["A"]),
                             m("maxs_latest", [])],
         [ok(odd), ok([1]), ok({"A": {"A": {"pac": 1}}})])
    case("maxs_latest_full_pages_until_max", [m("maxs_latest", ["MISSING"], max_pages=2)],
         [ok({f"K{i}": {f"K{i}": {}} for i in range(50)}), ok({f"K{i}": {f"K{i}": {}} for i in range(50)})])

    # ---- max_data history
    case("max_history_pages_count", [m("max_history", "SN", "2026-11-13", "2026-11-13")],
         [ok({"count": 150, "datas": recs_page(1000, 100)}), ok({"count": 150, "datas": recs_page(500, 50)})])
    case("max_history_stop_before", [m("max_history", "SN", "2026-11-12", "2026-11-13", stop_before="2026-11-13 08:00:00")],
         [ok({"count": 300, "datas": recs_page(1000, 100)}), ok({"count": 300, "datas": recs_page(500, 100)})])
    case("max_history_stop_before_bad_time", [m("max_history", "SN", "2026-11-12", "2026-11-13", stop_before="2026-11-13 14:00:00")],
         [ok({"count": 300, "datas": recs_page(1000, 99) + [{"time": "bad"}]}), ok({"count": 300, "datas": []})])
    case("max_history_range", [m("max_history", "SN", "2026-11-01", "2026-11-13"),
                               m("max_history", "SN", "2026-11-07", "2026-11-13")],
         [ok(None)])
    case("max_history_non_dict_last", [m("max_history", "SN", "2026-11-13", "2026-11-13")],
         [ok({"count": 5, "datas": [{"time": "2026-11-13 10:00:00"}, 5]})])
    case("newest_max_records", [m("newest_max_records", "SN", "2026-11-13"), m("newest_max_records", "SN", "2026-11-13", n=3),
                                m("newest_max_records", "SN", "2026-11-13")],
         [ok({"count": 150, "datas": recs_page(1000, 100)}), ok({"count": 150, "datas": recs_page(1000, 2)}), ok(None)])
    case("max_history_batch", [m("max_history_batch", ["A", "B", "C"], "2026-11-15"), m("max_history_batch", ["A"], "2026-11-15")],
         [new_ok({"A": [rec, "x", rec], "B": None, "C": {"x": 1}, "D": []}), new_ok([rec])])
    case("max_history_day", [m("max_history_day", "A", "2026-11-15"), m("max_history_day", "LONG", "2026-11-15"),
                             m("max_history_day", "N", "2026-11-15"), m("max_history_day", "S", "2026-11-15"),
                             m("max_history_day", "T", "2026-11-15")],
         [new_ok({"datas": [rec, 1], "start": 1, "haveNext": False}), new_ok({"datas": [rec], "haveNext": True}),
          new_ok(None), new_ok({"datas": "abc"}), new_ok({"datas": 5})])
    case("max_last_record", [m("max_last_record", "A"), m("max_last_record", "B"), m("max_last_record", "C")],
         [ok(rec), ok({}), ok({"time": None, "pac": 1})])
    case("device_datalogger", [m("device_datalogger", "A"), m("device_datalogger", "B"), m("device_datalogger", "C"),
                               m("device_datalogger", "D")],
         [ok({"datalogSN": "DYDCE9302Z"}), ok({"datalogSN": "  "}), ok("x"), ok({"datalogSN": 123})])
    loggers = [{"sn": "DYDCE9302Z", "model": "ShineMaster", "lost": False,
                "last_update_time": {"time": 1794717078792, "timezoneOffset": -480}}, "x"]
    case("list_dataloggers", [m("list_dataloggers", 9947162), m("list_dataloggers", 9947162)],
         [ok({"count": 2, "dataloggers": loggers}), ok({"count": 2, "dataloggers": [loggers[0]]}),
          ok({"count": 1, "dataloggers": [loggers[0]]})])
    case("devices_create_time", [m("devices_create_time", ["A", "B", "C"])],
         [ok({"A": {"createTime": "2025-01-16 16:05:44", "deviceSn": "A"}, "B": {"createTime": ""}}),
          ok({"A": {"createTime": "2025-01-16 16:05:44"}, "B": {"createTime": ""}})])
    case("devices_create_time_odd", [m("devices_create_time", ["A", "B", "C"]), m("devices_create_time", ["A"], max_pages=1)],
         [ok({"A": "notdict", "B": {"createTime": "2025-01-16 16:05:44.123"}}),
          ok({"A": {"createTime": "2025-01-16 16:05:45"}}),
          ok(None)])

    # ---- env sensors / meters
    case("list_env_sensors", [m("list_env_sensors", "DL1"), m("list_env_sensors", "DL1"), m("list_env_sensors", "DL1", refresh=True)],
         [ok({"count": 1, "envs": [{"address": 32, "name": "ENV", "lost": False, "lastUpdateTime": "2026-11-15 12:00:00"}]}),
          ok({"count": 0, "envs": []})])
    case("env_history_pages", [m("env_history", "DL1", 32, "2026-11-13", "2026-11-13")],
         [ok({"count": 240, "env_data": env_page(1200, 100)}), ok({"count": 240, "env_data": env_page(700, 100)}),
          ok({"count": 240, "env_data": env_page(200, 40)})])
    case("env_history_stop_before", [m("env_history", "DL1", 32, "2026-11-12", "2026-11-13", stop_before="2026-11-13 11:00:00"),
                                     m("env_history", "DL1", 32, "2026-11-01", "2026-11-13")],
         [ok({"count": 250, "env_data": env_page(1200, 100)}), ok({"count": 250, "env_data": env_page(700, 100)})])
    case("list_meters", [m("list_meters", "DL1", refresh=True), m("list_meters", "DL1")],
         [ok({"count": 1, "meters": [{"address": 36, "device_name": "CHNT_THREE", "device_type": 1, "lost": False}]})])
    case("meter_latest_env_latest", [m("meter_latest", "DL1", 36), m("meter_latest", "DL1", 36), m("env_latest", "DL1", 32),
                                     m("env_latest", "DL1", 32)],
         [ok(meter_record("2026-11-15 20:05:01")), ok({"timeText": ""}), ok(env_record("2026-11-15 20:05:01")), ok([1])])
    case("meter_history", [m("meter_history", "DL1", 36, "2026-11-13", "2026-11-13", stop_before="2026-11-13 02:00:00"),
                           m("meter_history", "DL1", 36, "2026-11-01", "2026-11-13")],
         [ok({"count": 245, "meter_data": env_page(1200, 100)}), ok({"count": 245, "meter_data": env_page(700, 100)}),
          ok({"count": 245, "meter_data": env_page(200, 40)})])

    # ---- alarms
    alarm = {"start_time": "2026-11-13 08:00:00", "end_time": "2026-11-13 08:05:00", "alarm_code": 7,
             "alarm_message": "PV iso low", "fault_type": "Warning", "status": 1}
    case("max_alarms_pages", [m("max_alarms", "SN", "2026-11-13", perpage=2)],
         [ok({"count": 5, "alarms": [alarm, alarm]}), ok({"count": 5, "alarms": [alarm, alarm]}),
          ok({"count": 5, "alarms": [alarm]})])
    case("max_alarms_max_pages_and_empty", [m("max_alarms", "SN", "2026-11-13", perpage=1, max_pages=2),
                                            m("max_alarms", "SN", "2026-11-13"), m("max_alarms", "SN", "2026-11-13")],
         [ok({"count": 9, "alarms": [alarm]}), ok({"count": 9, "alarms": [alarm]}), ok(None), ok("x")])
    return cases


def main() -> None:
    total = 0
    total += write("growatt_scalars.json", scalars())
    total += write("growatt_parsers.json", parsers())
    total += write("growatt_client.json", {"cases": client_cases()})
    print(f"total: {total} cases")


if __name__ == "__main__":
    main()
