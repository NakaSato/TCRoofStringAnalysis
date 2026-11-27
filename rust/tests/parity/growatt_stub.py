"""Stub Growatt OpenAPI for the parity run: both APIs (Python and Rust) point `GROWATT_BASE_URL`
at it, so the live routes (`/growatt/live/*`) can be compared without the real Growatt cloud.

    python3 rust/tests/parity/growatt_stub.py PORT      # serves http://127.0.0.1:PORT/v1/

Answers are deterministic: record times are relative to the stub's start (plant-local, UTC+7), and
the refusals (error 10012) are fixed per plant / serial, never by call count, so each backend
(each with its own memory cache) gets the same answers. Plant ids 7000-7999 only (seed.d/70_live.sql).
Stdlib only; nothing is stored.
"""

from __future__ import annotations

import json
import sys
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

T0 = (datetime.now(timezone.utc) + timedelta(hours=7)).replace(tzinfo=None, microsecond=0)

REFUSE_PLANT_DATA = {"7003"}
REFUSE_MAX_DATA = {"INV7005A", "INV7005B"}  # A falls back to max_last_data, B has nothing
REFUSE_LAST = {"INV7005B"}
REFUSE_ALARMS = {"INV7001B"}


def fmt(t: datetime) -> str:
    return t.strftime("%Y-%m-%d %H:%M:%S")


def ok(data):
    return {"error_code": 0, "error_msg": "", "data": data}


LIMITED = {"error_code": 10012, "error_msg": "error_frequently_access"}
REFUSE_DATALOGGERS = {"DL71R"}


def env_record(t: datetime, addr: int, i: int = 0) -> dict:
    """One weather-sensor record; humidity and wind read 0 (probes not fitted), address 3 has no
    module temperature."""
    return {
        "timeText": fmt(t), "radiant": 650.5 - 10 * i, "envTemp": "31.2", "panelTemp": 0 if addr == 3 else 48.0 + i / 10,
        "envHumidity": 0, "windSpeed": 0, "windAngle": 0, "rain": 0, "address": addr,
    }


def max_record(sn: str, mins: int, open4: bool) -> dict:
    return {
        "serialNum": sn, "time": fmt(T0 - timedelta(minutes=mins)), "status": 1, "pac": 20000.0, "ppv": 21000.0,
        "eacToday": 50.5, "eacTotal": 1000.0, "temperature": 41.0, "fac": 50.01,
        "vpv1": 600.0, "ipv1": 16.0, "ppv1": 9600.0, "vpv2": 610.0, "ipv2": 16.2, "ppv2": 9882.0,
        "vString1": 600.0, "currentString1": 8.0, "vString2": 600.0, "currentString2": 8.1,
        "vString3": 610.0, "currentString3": 6.0, "vString4": 610.0, "currentString4": 0.0 if open4 else 8.2,
        "faultType": 0, "warnCode": 0, "pvIso": 65535, "epv1Today": 25.0, "epv1Total": 500.0,
        "vacr": 230.0, "vacs": "231.5", "iacr": 29.0, "pf": 1.0, "timeTotal": 3600000, "StrBreak": 0,
        "temperature2": 45.5, "warningValue1": 0, "afciPv1": "",
    }


# ---------------------------------------------------------------- worker `fleet` / `power_limits`
# (rust/tests/worker_parity/seed.d/30_fleet_power_limits.sql). The fleet world (plants 3001-3009)
# is the account whose token starts "fleet-"; readPower and an empty device/list answer any token.
FLEET_PLANTS = [
    {"plant_id": 3001, "name": "Fleet A", "city": "Bangkok", "country": "Thailand", "latitude": "13.75",
     "longitude": "100.5", "peak_power": "100.5", "create_date": "2024-01-02", "current_power": "5"},
    {"plant_id": "3002", "name": "", "latitude": 100.6, "longitude": 13.8, "peak_power": ""},  # swapped coords
    {"plant_id": 3003.0, "name": "Fleet C", "latitude": "x", "longitude": "100", "peak_power": True},
    {"plant_id": 3009, "name": "Blocked"},  # GROWATT_BLOCKED_PLANT_IDS: the client drops it
]
FLEET_DEVICES = {
    "3001": [
        {"type": 1, "device_sn": "INVF3001A", "datalogger_sn": "DLF3001", "model": "MAX 80KTL3 LV", "status": 1},
        {"type": 4, "device_sn": "INVF3001A", "datalogger_sn": "DLF3001", "model": "MAX 80KTL3 LV", "status": 1},
        {"type": 1, "device_sn": "INVF3001B", "datalogger_sn": "DLF3001", "model": "", "status": 0, "lost": True},
        {"type": 3, "device_sn": "env", "datalogger_sn": "DLF3001"},
        {"type": 3.0, "device_sn": "Meter", "datalogger_sn": "DLF3001M"},
        {"type": 3, "device_sn": "env", "datalogger_sn": ""},
    ],
    "3002": [
        {"type": 1, "device_sn": "INVF3002A", "datalogger_sn": "", "model": "MAX"},
        {"type": 1, "device_sn": "INVF3002N", "datalogger_sn": "DLF3002"},
    ],
    "3003": [
        {"type": 4, "device_sn": "INVF3003A", "datalogger_sn": "DLF3003", "model": None},
        {"type": 3, "device_sn": "ENV", "datalogger_sn": "DLF3003"},
    ],
}
READ_POWER = {"INVF3001A": 80.5, "INVF3001B": "100", "INVF3003A": ""}


def fleet_route(path: str, p: dict, token: str):
    """The fleet / power_limits answers, or None for the routes above."""
    def new(data):
        return {"code": 0, "message": "", "data": data}

    if path == "new-api/readPower":
        sn = p.get("deviceSn", "")
        if sn.startswith("INVF3004"):
            return {"code": 10012, "message": "error_frequently_access"}
        if sn == "INVF3002A":
            return {"code": 5, "message": "DEVICE_OFFLINE"}
        if sn in READ_POWER:
            return new(READ_POWER[sn])
        return {"code": 18, "message": "READ_DEVICE_PARAM_FAIL"}
    fleet = token.startswith("fleet-")
    if path == "device/list":
        devs = FLEET_DEVICES.get(p.get("plant_id", ""), []) if fleet else []
        return ok({"count": len(devs), "devices": devs})
    if not fleet:
        return None
    if path == "plant/list":
        return ok({"count": len(FLEET_PLANTS), "plants": FLEET_PLANTS})
    if path == "device/env/env_list" and p.get("datalog_sn") == "DLF3003":
        return {"error_code": 10001, "error_msg": "no such datalogger"}  # _retry: 5 + 10 + 15 s, then the plant's error line
    if path == "device/ammeter/meter_list":
        meters = [
            {"address": "1", "device_name": "CHNT_THREE", "device_type": 71},
            {"address": 1, "device_name": "CHNT_ONE", "device_type": 70},
            {"address": "2", "device_name": None, "device_type": ""},
            {"address": "x"},
        ]
        return ok({"count": len(meters), "meters": meters})
    if path == "device/max/max_data_info":
        sn = p.get("device_sn", "")
        if sn == "INVF3001B":
            return ok({"max": {"alias": " INVERTER 2 ", "normalPower": 80000, "fwVersion": "TL1.0", "innerVersion": "",
                               "activeRate": 100, "reactiveRate": 0, "pf": 1, "pfModel": 0, "onOff": 1}})
        return LIMITED  # the sweep goes on with queryDeviceInfo
    if path == "new-api/queryDeviceInfo":
        if p.get("deviceSn") == "INVF3002A":
            return new({"max": [{"alias": "INV 3002A", "normalPower": "50000", "activeRate": 0, "pf": 0, "onOff": "0"}]})
        return new({"max": []})  # answered without data
    if path == "plant/details":
        if p.get("plant_id") == "3002":
            return ok({"timezone": "GMT+7", "address1": "1 Road", "address2": "",
                       "maxs": [{"max_num": 2}], "dataloggers": [{"datalogger_num": "1"}]})
        if p.get("plant_id") == "3003":
            return ok({"timezone": "", "maxs": []})
        return {"error_code": 10001, "error_msg": "no details"}
    if path == "new-api/queryDeviceInfoParam":
        sn = p.get("deviceSn", "")
        if sn == "INVF3002A":
            return {"code": 10012, "message": "error_frequently_access"}
        if sn == "INVF3001B":
            return new({"deviceModel": "MAX 80KTL3 LV", "dataloggerModel": "ShineMaster", "norminalPower": 80000})
        if sn == "INVF3001A":
            return new({"deviceModel": "MAX 80KTL3 LV X", "dataloggerModel": ""})
        return new({"deviceModel": "", "norminalPower": 0})
    if path == "device/all/create_date":
        return ok({"INVF3001B": {"createTime": "2024-03-01 10:00:00"}, "INVF3002A": {"createTime": "bad"}})
    if path == "new-api/queryDeviceList":
        return new({"data": [{"deviceSn": "INVF3003A", "createDate": "2024-05-06 07:08:09.0"},
                             {"deviceSn": "INVF3003B", "createDate": ""}], "pages": 1})
    if path == "device/sn_datalog":
        return ok({"datalogSN": "DLF3002"} if p.get("device_sn") == "INVF3002A" else {"datalogSN": ""})
    return None


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

    def _route(self) -> None:
        path = urlparse(self.path).path.removeprefix("/v1/")
        p = self._params()
        fleet = fleet_route(path, p, self.headers.get("token", ""))
        if fleet is not None:
            return self._send(fleet)
        if path == "plant/list":
            return self._send(ok({"count": 3, "plants": [
                {"plant_id": 7001, "name": "Live A", "current_power": "12.5", "total_energy": "1000", "peak_power": 100, "status": 1},
                {"plant_id": 7002, "name": "Live B", "current_power": "", "total_energy": None, "peak_power": "50.5", "status": 4},
                {"plant_id": "7003", "name": "Live C", "current_power": 0, "total_energy": "x", "peak_power": 0, "status": 0},
            ]}))
        if path == "plant/data":
            pid = p.get("plant_id", "")
            if pid in REFUSE_PLANT_DATA:
                return self._send(LIMITED)
            upd = T0 - (timedelta(days=1) if pid == "7002" else timedelta(minutes=3))
            return self._send(ok({"today_energy": "123.4", "current_power": 5.0, "last_update_time": fmt(upd)}))
        if path == "device/datalogger/list":
            return self._send(ok({"count": 3, "dataloggers": [
                {"sn": "DL2", "model": "ShineMaster", "lost": "false", "last_update_time": {"time": 1763002800000}},
                {"sn": " DL1 ", "model": "", "lost": True, "last_update_time": None},
                {"sn": "", "model": "x"},
            ]}))
        if path == "device/max/maxs_data":
            out = {}
            for sn in [s for s in p.get("maxs", "").split(",") if s]:
                if sn.endswith("Z"):
                    continue  # not answered: absent
                rec = {**max_record(sn, 2, False), "statusText": "Normal", "lost": "false"}
                if sn == "INV7002A":  # a silent inverter: its newest record is old
                    rec = {**rec, "time": "2026-01-02 10:00:00", "statusText": "", "lost": "1", "status": 3.0}
                out[sn] = {sn: rec, "dataloggerSn": "DL1" if sn != "INV7002A" else ""}
            return self._send(ok(out))
        if path == "device/max/max_data":
            sn = p.get("max_sn", "")
            if sn in REFUSE_MAX_DATA:
                return self._send(LIMITED)
            recs = [max_record(sn, 2 + 5 * i, sn.endswith("B")) for i in range(8)]
            return self._send(ok({"count": len(recs), "datas": recs}))
        if path == "device/max/max_last_data":
            sn = p.get("max_sn", "")
            if sn in REFUSE_LAST:
                return self._send(LIMITED)
            return self._send(ok(max_record(sn, 1, False)))
        if path == "new-api/queryLastData":
            return self._send({"code": 10012, "message": "error_frequently_access"})
        if path == "device/max/alarm_data":
            sn, day = p.get("max_sn", ""), p.get("date", "")
            if sn in REFUSE_ALARMS:
                return self._send(LIMITED)
            return self._send(ok({"count": 2, "alarms": [
                {"start_time": f"{day} 09:00:00", "end_time": f"{day} 09:10:00", "alarm_code": 202,
                 "alarm_message": "PV isolation low", "fault_type": "", "status": 0},
                {"start_time": f"{day} 13:30:00", "end_time": "", "alarm_code": 117, "alarm_message": "",
                 "fault_type": 3, "status": 1},
            ]}))
        # weather sensors and energy meters (seed.d/71_live_sensors.sql): datalogger DL71R refuses
        # everything; address 9 has no record. env_list's lastUpdateTime is China time (UTC+8).
        if path == "device/env/env_list":
            dl = p.get("datalog_sn", "")
            if dl in REFUSE_DATALOGGERS:
                return self._send(LIMITED)
            china = T0 + timedelta(hours=1)
            envs = [
                {"address": "1", "name": "ENV1", "lost": "false", "lastUpdateTime": fmt(china - timedelta(minutes=3))},
                {"address": "2", "name": "ENV2", "lost": "false", "lastUpdateTime": fmt(china - timedelta(minutes=35))},
                {"address": "3", "name": "ENV3", "lost": "true", "lastUpdateTime": fmt(china - timedelta(minutes=10))},
                {"address": "4", "name": "ENV4", "lost": 0, "lastUpdateTime": fmt(china - timedelta(days=40))},
                {"address": "5", "name": "ENV5", "lost": "", "lastUpdateTime": ""},
                {"address": "x", "name": "bad"},
            ]
            if dl == "DL71B":  # this datalogger's sensor 1 is late
                envs[0] = {**envs[0], "lastUpdateTime": fmt(china - timedelta(minutes=30))}
            return self._send(ok({"count": len(envs), "envs": envs}))
        if path == "device/env/env_last_data":
            dl, addr = p.get("datalog_sn", ""), p.get("address", "")
            if dl in REFUSE_DATALOGGERS:
                return self._send(LIMITED)
            if addr == "9":
                return self._send(ok({}))
            return self._send(ok({**env_record(T0 - timedelta(minutes=2), int(addr or 0)), "lost": False, "calendar": {"x": 1}}))
        if path == "device/env/env_data":
            dl, addr = p.get("datalog_sn", ""), p.get("address", "")
            if dl in REFUSE_DATALOGGERS:
                return self._send(LIMITED)
            day0 = T0.replace(hour=0, minute=0, second=0)
            recs = [env_record(T0 - timedelta(minutes=5 * i + 1), int(addr or 0), i) for i in range(12)]
            recs.insert(1, env_record(T0 - timedelta(minutes=3), int(addr or 0), 99))  # same slot as a newer one
            recs = [r for r in recs if r["timeText"] >= fmt(day0)]
            if p.get("page", "1") != "1":
                recs = []
            return self._send(ok({"count": len(recs), "env_data": recs}))
        if path == "device/ammeter/meter_last_data":
            dl, addr = p.get("datalog_sn", ""), p.get("address", "")
            if dl in REFUSE_DATALOGGERS:
                return self._send(LIMITED)
            if addr == "99":
                return self._send(ok({}))
            return self._send(ok({
                "timeText": fmt(T0 - timedelta(minutes=1)), "activePower": "-12345.6" if dl == "DL71B" else 8000.25,
                "activePowerL1": 2600.0, "activePowerL2": "", "activePowerL3": None, "reactivePower": 120.5,
                "powerFactor": 0.99, "frequency": 50.0, "posiActivePower": 1000.5, "positiveActiveTodayEnergy": 12.5,
                "reverActivePower": 0, "reverseActiveTodayEnergy": 3.25, "lost": "0",
            }))
        return self._send({"error_code": 10001, "error_msg": f"stub has no {path}"})


def main() -> None:
    port = int(sys.argv[1])
    ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()


if __name__ == "__main__":
    main()
