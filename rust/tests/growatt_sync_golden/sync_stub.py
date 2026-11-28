"""Stub Growatt OpenAPI for the Growatt sync golden comparison (run.sh): the Python sync functions
(backend/app/services/growatt_sync, growatt_energy, growatt_alarms) and their Rust ports
(rust/crates/services/src/growatt_sync, growatt_energy_sync, alarm_sync) both call it, never the
real Growatt cloud.

    python3 -I rust/tests/growatt_sync_golden/sync_stub.py PORT YYYY-MM-DD   # today, plant-local

Two accounts, told apart by the `token` header (tok-p1 = phase 1, tok-p2 = phase 2). Answers are
deterministic: record times are fixed clock times of the given day (and the days before it), and
refusals (10012 and other codes) are fixed per serial / plant / datalogger, never by call count,
so both runs get the same answers. Plant ids 9100-9299 only (seed.sql). Stdlib only.
"""

from __future__ import annotations

import json
import sys
from datetime import date, datetime, timedelta
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

TODAY: date = date.today()

LIMITED = {"error_code": 10012, "error_msg": "error_frequently_access"}
NEW_LIMITED = {"code": 10012, "message": "error_frequently_access"}


def ok(data):
    return {"error_code": 0, "error_msg": "", "data": data}


def new_ok(data):
    return {"code": 0, "message": "", "data": data}


def refused(code: int, msg: str):
    return {"error_code": code, "error_msg": msg}


def fmt(t: datetime) -> str:
    return t.strftime("%Y-%m-%d %H:%M:%S")


def days_in(start: str, end: str):
    """The days of [start, end] that are on or before TODAY and at most 3 days back."""
    a, b = date.fromisoformat(start), date.fromisoformat(end)
    d = max(a, TODAY - timedelta(days=3))
    while d <= min(b, TODAY):
        yield d
        d += timedelta(days=1)


def max_rec(sn: str, t: datetime, status=1, pac=20000.0, fault=0, ppv=True) -> dict:
    rec = {
        "serialNum": sn, "time": fmt(t), "status": status, "pac": pac, "eacToday": round(t.hour * 1.5, 1),
        "eacTotal": 1000.0 + t.hour, "temperature": "41.5", "fac": 50.01,
        "vpv1": 600.0, "ipv1": 16.1, "ppv1": 9660.0, "vpv2": 0, "ipv2": 0, "ppv2": 0,
        "vString1": 600.0, "currentString1": 8.0, "vString2": 600.0, "currentString2": 8.1,
        "vString3": 600.0, "currentString3": 0.0, "vString4": 610.0, "currentString4": 0.0,
        "faultType": fault, "warnCode": 0, "calendar": {"time": 1}, "epv1Today": 12.5,
    }
    if ppv:
        rec["ppv"] = 0.0 if status == 0 else 21000.0
    if status == 0:
        rec.update(pac=0.0, currentString1=0.0, currentString2=0.0)
    return rec


def max_records(sn: str, start: str, end: str) -> list:
    out = []
    for d in days_in(start, end):
        day0 = datetime.combine(d, datetime.min.time())
        out += [max_rec(sn, day0 + timedelta(hours=4, minutes=30), status=0), max_rec(sn, day0 + timedelta(hours=4, minutes=35), status=0)]
        for k in range(15):  # 05:00 .. 12:00 every 30 min
            t = day0 + timedelta(hours=5, minutes=30 * k)
            out.append(max_rec(sn, t, ppv=not (t.hour == 10 and t.minute == 30)))
        if d < TODAY:  # a fault at night is kept
            out.append(max_rec(sn, day0 + timedelta(hours=23), status=3, pac=0.0, fault=117))
    return sorted(out, key=lambda r: r["time"], reverse=True)


def env_rec(t: datetime, i: int) -> dict:
    return {"timeText": fmt(t), "radiant": 500.5 + i, "envTemp": "31.2", "panelTemp": 45.0 + i / 10,
            "envHumidity": 0, "windSpeed": "1.5", "windAngle": 270, "rain": 0, "calendar": {"x": 1}}


def env_records(start: str, end: str) -> list:
    out = []
    for d in days_in(start, end):
        day0 = datetime.combine(d, datetime.min.time())
        out += [env_rec(day0 + timedelta(hours=6, minutes=30 * k), k) for k in range(13)]
    return sorted(out, key=lambda r: r["timeText"], reverse=True)


def meter_records(start: str, end: str) -> list:
    out = []
    for d in days_in(start, end):
        day0 = datetime.combine(d, datetime.min.time())
        for k in range(13):
            t = day0 + timedelta(hours=6, minutes=30 * k)
            out.append({"timeText": fmt(t), "activePower": 8000.25 - 1000 * k, "activePowerL1": "2600.5", "activePowerL2": "",
                        "activePowerL3": None, "reactivePower": 120.5, "powerFactor": 0.99, "frequency": 50.0,
                        "posiActivePower": 1000.5 + k, "positiveActiveTodayEnergy": 12.5, "reverActivePower": 0,
                        "reverseActiveTodayEnergy": 3.25})
    return sorted(out, key=lambda r: r["timeText"], reverse=True)


def page(records: list, p: dict, key: str) -> dict:
    n, per = int(p.get("page", "1")), int(p.get("perpage", "100"))
    return {"count": len(records), key: records[(n - 1) * per : n * per]}


PLANTS = {
    "tok-p1": [
        {"plant_id": 9101, "name": "Gold A", "city": "Bangkok", "country": "Thailand", "latitude": "13.75", "longitude": 100.5,
         "peak_power": 100, "create_date": "2024-01-02", "current_power": "12.5", "status": 1},
        {"plant_id": "9102", "name": "", "city": None, "latitude": 100.6, "longitude": "14.0", "peak_power": "50.5", "status": 4},
    ],
    "tok-p2": [{"plant_id": 9201, "name": "Gold C", "latitude": 99.0, "longitude": 99.0, "peak_power": "x", "status": 1}],
}

DEVICES = {
    "9101": [
        {"device_sn": "INV-A1", "type": 1, "datalogger_sn": "DL-A", "model": "MAX 80KTL3", "status": 1, "lost": False},
        {"device_sn": "INV-A1", "type": 4, "datalogger_sn": "DL-A", "model": "MAX 80KTL3", "status": 1, "lost": False},
        {"device_sn": "INV-A2", "type": 1, "datalogger_sn": "", "model": None, "status": 0, "lost": True},
        {"device_sn": "env", "type": 3, "datalogger_sn": "DL-A"},
        {"device_sn": "meter", "type": 3.0, "datalogger_sn": "DL-A"},
    ],
    "9102": [
        {"device_sn": "INV-B1", "type": 1, "datalogger_sn": "DL-B", "model": "MAX 50KTL3", "status": 1},
        {"device_sn": "ENV", "type": 3, "datalogger_sn": "DL-B"},
        {"device_sn": "meter", "type": 3, "datalogger_sn": "DL-B"},
    ],
    "9201": [{"device_sn": "INV-C1", "type": 1, "datalogger_sn": "DL-C", "model": "MAX 100KTL3", "status": 1}],
}

REFUSE_MAX_DATA = {"INV-A2": LIMITED, "INV-B1": refused(10001, "device_not_exist")}
REFUSE_ENV = {("DL-A", "2"), ("DL-A", "3"), ("DL-B", "1")}
# worker parity (rust/tests/worker_parity/seed.d/20_history.sql, plants 9300-9499, serials H-*):
# no 10012 on a path that retries (the real jobs wait minutes between retries)
REFUSE_MAX_DATA["H-B1"] = refused(10001, "device_not_exist")


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):  # quiet
        pass

    def _send(self, body) -> None:
        raw = json.dumps(body).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def _params(self) -> dict:
        u = urlparse(self.path)
        p = {k: v[-1] for k, v in parse_qs(u.query).items()}
        n = int(self.headers.get("Content-Length") or 0)
        if n:
            p.update({k: v[-1] for k, v in parse_qs(self.rfile.read(n).decode()).items()})
        return p

    def do_GET(self):  # noqa: N802
        self._route()

    def do_POST(self):  # noqa: N802
        self._route()

    def _route(self) -> None:  # noqa: C901 - one branch per endpoint
        path = urlparse(self.path).path.removeprefix("/v1/")
        p = self._params()
        token = self.headers.get("token", "")
        d = TODAY.isoformat()
        sn = p.get("max_sn") or p.get("device_sn") or p.get("deviceSn") or ""
        if path == "ping":
            return self._send(ok({}))
        # ------------------------------------------------------------------ registry
        if path == "plant/list":
            plants = PLANTS.get(token, [])
            return self._send(ok({"count": len(plants), "plants": plants if p.get("page", "1") == "1" else []}))
        if path == "device/list":
            devs = DEVICES.get(p.get("plant_id", ""), [])
            return self._send(ok({"count": len(devs), "devices": devs if p.get("page", "1") == "1" else []}))
        if path == "device/env/env_list":
            dl = p.get("datalog_sn", "")
            if dl == "DL-B":
                return self._send(LIMITED)
            envs = [{"address": "1", "device_name": "ENV1", "lost": False}, {"address": " 2 ", "name": "no device_name"},
                    {"address": "x"}] if dl == "DL-A" else []
            return self._send(ok({"count": len(envs), "envs": envs}))
        if path == "device/ammeter/meter_list":
            dl = p.get("datalog_sn", "")
            meters = {"DL-A": [{"address": 36, "device_name": "CHNT_THREE", "device_type": 71}],
                      "DL-B": [{"address": "40", "device_name": "CHNT_THREE", "device_type": ""},
                               {"address": "40", "device_name": "CHNT_ONE", "device_type": 70}]}.get(dl, [])
            return self._send(ok({"count": len(meters), "meters": meters}))
        if path == "device/max/max_data_info":
            if sn == "INV-A2":
                return self._send(LIMITED)
            if sn == "INV-C1":
                return self._send(refused(10002, "no_permission"))
            return self._send(ok({"max": {"alias": " Inverter 1 ", "normalPower": 80000, "fwVersion": "TL1.0", "innerVersion": "",
                                          "activeRate": 90, "reactiveRate": 0, "pf": 1, "pfModel": 0, "exportLimit": 0,
                                          "exportLimitPowerRate": 0, "onOff": 1}}))
        if path == "new-api/queryDeviceInfo":
            if sn == "INV-B1":  # answered without data
                return self._send(new_ok({"max": [{}]}))
            return self._send(new_ok({"max": [{"alias": "INV2", "normalPower": "50000", "activeRate": 0, "pf": 0, "onOff": 1}]}))
        if path == "plant/details":
            if p.get("plant_id") == "9102":
                return self._send(LIMITED)
            return self._send(ok({"timezone": "GMT+7", "address1": "1 Road", "address2": "", "maxs": [{"max_num": 2}, {"max_num": "1"}],
                                  "dataloggers": [{"datalogger_num": 1}]}))
        if path == "new-api/queryDeviceInfoParam":
            if sn == "INV-A1":
                return self._send(new_ok({"deviceModel": "MAX 80KTL3 LV", "dataloggerModel": "ShineMaster", "norminalPower": 80000}))
            if sn == "INV-U1":
                return self._send(new_ok({"deviceModel": "", "norminalPower": 0}))
            return self._send({"code": 18, "message": "READ_DEVICE_PARAM_FAIL"})
        if path == "device/all/create_date":
            wanted = [s for s in p.get("devices", "").split(",") if s]
            out = {s: {"createTime": "2025-01-02 03:04:05"} for s in wanted if s == "INV-A1"}
            out.update({s: {"createTime": "not a date"} for s in wanted if s == "INV-B1"})
            return self._send(ok(out if p.get("pageNum", "1") == "1" else {}))
        if path == "new-api/queryDeviceList":
            return self._send(new_ok({"data": [{"deviceSn": "INV-A2", "createDate": "2025-02-03 04:05:06.0"},
                                                {"deviceSn": "INV-C1", "createDate": "2025-03-04 05:06:07"}], "pages": 1}))
        if path == "device/sn_datalog":
            return self._send(ok({"datalogSN": "DL-A2"}))
        # ------------------------------------------------------------------ history
        if path == "device/max/max_data":
            if sn in REFUSE_MAX_DATA:
                return self._send(REFUSE_MAX_DATA[sn])
            return self._send(ok(page(max_records(sn, p["start_date"], p["end_date"]), p, "datas")))
        if path == "new-api/queryHistoricalData":
            recs = max_records(sn, d, d)
            if sn == "INV-B1":
                return self._send(new_ok({"haveNext": True, "datas": recs}))
            return self._send(new_ok({"haveNext": False, "datas": recs}))
        if path == "new-api/queryDevicesHistoricalData":
            if sn.startswith("H-"):  # worker parity: H-B1 is not answered, H-U1 not a list
                return self._send(new_ok({**{s: max_records(s, d, d) for s in sn.split(",") if s not in ("H-B1", "H-U1")},
                                          "H-U1": "not a list"}))
            if {"INV-A2", "INV-U1"} & set(sn.split(",")):  # two refusals in a row end batching
                return self._send(NEW_LIMITED)
            return self._send(new_ok({"INV-A1": max_records("INV-A1", d, d), "INV-U1": "not a list"}))
        if path == "device/env/env_data":
            if (p.get("datalog_sn", ""), p.get("address", "")) in REFUSE_ENV:
                return self._send(LIMITED)
            return self._send(ok(page(env_records(p["start_date"], p["end_date"]), p, "env_data")))
        if path == "device/ammeter/meter_data":
            if p.get("datalog_sn") == "DL-B":
                return self._send(LIMITED)
            return self._send(ok(page(meter_records(p["start_date"], p["end_date"]), p, "meter_data")))
        if path == "device/max/maxs_data":
            if token == "tok-p2":
                return self._send(LIMITED)
            out = {}
            for s in [s for s in p.get("maxs", "").split(",") if s]:
                if s == "INV-U1":
                    continue  # not answered
                t = datetime.combine(TODAY - timedelta(days=5), datetime.min.time()) + timedelta(hours=10) if s in ("INV-B1", "H-B1") \
                    else datetime.combine(TODAY, datetime.min.time()) + timedelta(hours=12, minutes=5)
                out[s] = {s: max_rec(s, t), "dataloggerSn": "DL-A"}
            return self._send(ok(out if p.get("pageNum", "1") == "1" else {}))
        if path == "new-api/readPower":
            if sn in ("INV-B1", "INV-Z1"):
                return self._send({"code": 18, "message": "READ_DEVICE_PARAM_FAIL"})
            if sn == "INV-U1":
                return self._send(NEW_LIMITED)
            return self._send(new_ok({"INV-A1": 100, "INV-A2": "80", "INV-C1": 50.5}.get(sn, 100)))
        # ------------------------------------------------------------------ Growatt's own energy
        if path == "plant/energy":
            pid = p.get("plant_id", "")
            if pid == "9201":
                return self._send(LIMITED)
            a, b = date.fromisoformat(p["start_date"]), date.fromisoformat(p["end_date"])
            rows, cur = [], a
            while cur <= b:
                rows.append({"date": cur.isoformat(), "energy": None if (pid == "9102" and cur.day % 3 == 0) else f"{100 + cur.day}.5"})
                cur += timedelta(days=1)
            rows.append({"date": "bad", "energy": 1})
            return self._send(ok({"count": len(rows), "energys": rows if p.get("page", "1") == "1" else []}))
        if path == "plant/power":
            pid, day = p.get("plant_id", ""), p.get("date", "")
            if pid == "9201":
                return self._send(LIMITED)
            nxt = (date.fromisoformat(day) + timedelta(days=1)).isoformat()
            return self._send(ok({"powers": [{"time": f"{day} 10:00", "power": 1000.5}, {"time": f"{day} 10:05", "power": None},
                                             {"time": f"{day} 09:55", "power": "900"}, {"time": f"{nxt} 00:00", "power": 1}]}))
        if path == "device/inverter/day_energy":
            if sn == "INV-A2":
                return self._send(refused(10001, "device_not_exist"))
            if sn == "INV-C1":
                return self._send(LIMITED)
            return self._send(ok(None if sn == "INV-U1" else "350.25"))
        # ------------------------------------------------------------------ alarms
        if path == "device/max/alarm_data":
            day = p.get("date", "")
            if sn in ("INV-B1", "INV-U1", "INV-Z1"):  # three in a row end the sweep
                return self._send(LIMITED)
            if sn == "INV-A2":
                return self._send(ok({"count": 0, "alarms": []}))
            alarms = [
                {"start_time": f"{day} 09:00:00", "end_time": f"{day} 09:10:00", "alarm_code": 202,
                 "alarm_message": "PV isolation low", "fault_type": "", "status": 0},
                {"start_time": f"{day} 13:30:00.0", "end_time": "", "alarm_code": "117", "alarm_message": "x" * 300,
                 "fault_type": 3, "status": "1"},
            ]
            return self._send(ok({"count": len(alarms), "alarms": alarms if p.get("page", "1") == "1" else []}))
        return self._send({"error_code": 10001, "error_msg": f"stub has no {path}"})


def main() -> None:
    global TODAY
    port = int(sys.argv[1])
    TODAY = date.fromisoformat(sys.argv[2])
    ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()


if __name__ == "__main__":
    main()
