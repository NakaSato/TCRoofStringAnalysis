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
        return self._send({"error_code": 10001, "error_msg": f"stub has no {path}"})


def main() -> None:
    port = int(sys.argv[1])
    ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()


if __name__ == "__main__":
    main()
