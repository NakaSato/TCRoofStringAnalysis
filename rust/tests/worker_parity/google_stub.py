"""Stub Google OAuth token endpoint, Sheets API v4 and Firestore REST reads for the worker parity
(`pwa_sheet`): both workers get a service-account key file whose `token_uri` points here,
`PWA_SHEET_API_URL` = http://127.0.0.1:PORT/sheets/v4/spreadsheets and
`FIRESTORE_EMULATOR_HOST` = 127.0.0.1:PORT. Nothing real is ever called.

    python3 -I rust/tests/worker_parity/google_stub.py PORT

- POST /token: a new access token per request (`stub-1`, `stub-2`, …). Each token is a session
  with its own fresh copy of the spreadsheets below, so the Python run and the Rust run (one token
  each) start from the same sheets and their results can be compared.
- Sheets: GET /{id} (tab properties), GET /{id}/values/{range}, POST /{id}:batchUpdate
  (duplicateSheet), POST /{id}/values/{range}:clear, POST /{id}/values:batchUpdate. Values come
  back as the API gives them: trailing empty cells and rows left out.
  Spreadsheets: `pwa-create` (no tab for today: it is copied from the newest DD.MM tab),
  `pwa-existing` (today's tab exists, some check cells already filled), `pwa-notemplate` (no DD.MM
  tab at all). Any other id: 404.
- Firestore: GET /v1/projects/{p}/databases/(default)/documents/daily/{day} (fleet doc with
  `checks_ready`) and …/daily/{day}/plants (the plant docs below), any day.
- GET /_state: every session's sheets, in token order; POST /_reset forgets them.

Stdlib only; answers depend only on the request and the session.
"""

from __future__ import annotations

import copy
import json
import re
import sys
import threading
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, unquote, urlparse

LOCK = threading.Lock()
SESSIONS: dict = {}  # token -> {sheet id: [tab, ...]}
ORDER: list = []

HEAD1 = ["No", "Plant", "Datalogger SN", "weather Status", "Yield (kWh)",
         "09:00", "", "", "", "", "", "13:00", "", "", "", "", "", "17:00", "", "", "", "", "", "Firmware"]
HEAD2 = ["", "", "", "", "", "Status", "kW", "INV online", "ค่าแสง", "สภาพอากาศ", "DATA LOG",
         "Status", "kW", "INV online", "ค่าแสง", "สภาพอากาศ", "DATA LOG", "Status", "kW", "INV online", "ค่าแสง", "สภาพอากาศ", "DATA LOG"]


def plant_rows():
    """Rows 3+ of a day tab: name (B), datalogger SN (C), old values in the check columns and
    the Firmware column (X)."""
    old = ["Normal", 12, "Normal", 5, "1/1", 600, "มีเมฆมาก", "—"]
    rows = [
        [1, "PWA Alpha", "PWADL01", *old[:3]] + [""] * 18 + ["IN1"],      # an inverter version: blanked
        [2, "PWA Bravo", "PWADL02", "Abnormal", 3.5] + [""] * 18 + ["—"],
        [3, "PWA Charlie", "PWADL03", "", "", "Normal"] + [""] * 17 + ["v9-hand"],  # typed by hand: kept
        [4, "PWA Delta", "OLDSN01"],                                       # matched by its name
        [5, "PWA Echo", "PWADL05"],
        [6, "Somewhere else", "NOPE999"],                                  # unmatched
        [7, "", ""],
        [8, "PWA Foxtrot", "PWADL06", "", "", 44.4],
    ]
    return rows


def today_tab() -> str:
    return (datetime.now(timezone.utc) + timedelta(hours=7)).strftime("%d.%m")


def fixtures() -> dict:
    tpl = [HEAD1, HEAD2, *plant_rows()]
    existing = copy.deepcopy(tpl)
    for r in existing[2:]:  # today's tab, the 09 block partly filled by someone else
        while len(r) < 24:
            r.append("")
    existing[2][5] = "Abnormal"   # PWA Alpha 09 Status: kept
    existing[2][10] = "typed"     # PWA Alpha 09 DATA LOG: kept
    existing[3][6] = 0            # PWA Bravo 09 kW = 0: a value, kept
    for r in existing[2:]:
        while r and r[-1] == "":
            r.pop()
    return {
        "pwa-create": [
            {"sheetId": 0, "title": "README", "index": 0, "rows": [["PWA report"]]},
            {"sheetId": 11, "title": "26.11", "index": 1, "rows": copy.deepcopy(tpl)},
            {"sheetId": 12, "title": "27.11", "index": 2, "rows": copy.deepcopy(tpl)},
        ],
        "pwa-existing": [
            {"sheetId": 0, "title": "README", "index": 0, "rows": [["PWA report"]]},
            {"sheetId": 12, "title": "27.11", "index": 1, "rows": copy.deepcopy(tpl)},
            {"sheetId": 13, "title": today_tab(), "index": 2, "rows": existing},
        ],
        "pwa-notemplate": [{"sheetId": 0, "title": "README", "index": 0, "rows": [["PWA report"]]}],
    }


# --------------------------------------------------------------------------- Firestore fixture

FLEET_DOC = {"checks_ready": ["09", "13"]}
SLOT = {"at": "08:50", "inverters": 2, "offline": [], "fault": [], "alarms": [], "errors": [], "issues": []}
PLANT_DOCS = {
    # check slots in the doc (the publish's own): 09 from Firestore, 13 too
    "9721": {
        "yield_kwh": 321.456,
        "weather": {"has_sensor": True},
        "checks": {
            "09": {**SLOT, "kw": 45.27, "irradiance_wm2": 612.5,
                   "google": {"raining": False, "condition": "PARTLY_CLOUDY", "cloud_cover_pct": 40, "source": "current"},
                   "issues": [{"inv": "INV2", "state": "Alarm", "items": [{"code": "1"}]}]},
            "13": {**SLOT, "at": "12:50", "kw": 0.0, "irradiance_wm2": None, "offline": ["INV1"],
                   "issues": [{"inv": "INV1", "state": "Offline", "last": "12:20", "items": []},
                              {"inv": "INV2", "state": "Fault", "items": [{"code": 117, "message": "Relay check fail", "since": "12:01", "count": 3}]}]},
        },
    },
    # an older doc: hourly curve and the weather / Google slots
    "9723": {
        "hourly_kw": [0, 0, 0, 0, 0, 0, 1.2, 8.5, 20.25, 31.75, 40, 44, 46, 45.5, 40, 30, 18, 6.25, 0],
        "yield_kwh": 250,
        "weather": {"has_sensor": True, "slots": {"09": {"irradiance_wm2": 700}, "13": None}},
        "google_weather": {"slots": {"09": {"raining": True, "condition": "LIGHT_RAIN"}, "13": None}},
    },
    # every inverter offline at 09
    "9725": {
        "yield_kwh": None,
        "weather": {"has_sensor": False},
        "checks": {"09": {**SLOT, "kw": None, "irradiance_wm2": None, "offline": ["INV1"], "inverters": 1,
                          "issues": [{"inv": "INV1", "state": "Offline", "last": None, "items": []}]}},
    },
}


def fs_value(v):
    if v is None:
        return {"nullValue": None}
    if isinstance(v, bool):
        return {"booleanValue": v}
    if isinstance(v, int):
        return {"integerValue": str(v)}
    if isinstance(v, float):
        return {"doubleValue": v}
    if isinstance(v, str):
        return {"stringValue": v}
    if isinstance(v, list):
        return {"arrayValue": {"values": [fs_value(x) for x in v]} if v else {}}
    return {"mapValue": {"fields": {k: fs_value(x) for k, x in v.items()}}}


def fs_doc(name: str, d: dict) -> dict:
    return {"name": name, "fields": {k: fs_value(v) for k, v in d.items()},
            "createTime": "2026-11-28T01:00:00Z", "updateTime": "2026-11-28T01:00:00Z"}


# --------------------------------------------------------------------------- A1 ranges

def col_no(s: str) -> int:
    n = 0
    for ch in s:
        n = n * 26 + ord(ch) - 64
    return n


def parse_range(rng: str):
    """'Title'!C3:W9 -> (title, (r0, c0, r1, c1)) 0-based inclusive; no cells part = whole tab."""
    m = re.fullmatch(r"'((?:[^']|'')*)'(?:!([A-Z]+)(\d+)(?::([A-Z]+)(\d+))?)?", rng)
    if not m:
        raise ValueError(rng)
    title = m.group(1).replace("''", "'")
    if not m.group(2):
        return title, None
    c0, r0 = col_no(m.group(2)) - 1, int(m.group(3)) - 1
    c1, r1 = (col_no(m.group(4)) - 1, int(m.group(5)) - 1) if m.group(4) else (c0, r0)
    return title, (r0, c0, r1, c1)


def trimmed(rows):
    out = []
    for r in rows:
        r = list(r)
        while r and r[-1] in ("", None):
            r.pop()
        out.append(r)
    while out and not out[-1]:
        out.pop()
    return out


def set_cell(rows, r, c, v):
    while len(rows) <= r:
        rows.append([])
    row = rows[r]
    while len(row) <= c:
        row.append("")
    row[c] = v


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

    def _body(self):
        n = int(self.headers.get("Content-Length") or 0)
        return self.rfile.read(n) if n else b""

    def _session(self):
        auth = self.headers.get("Authorization", "")
        tok = auth.removeprefix("Bearer ").strip()
        with LOCK:
            return SESSIONS.get(tok)

    def do_GET(self):  # noqa: N802
        u = urlparse(self.path)
        q = parse_qs(u.query)
        if u.path == "/ping":
            return self._send({"ok": True})
        if u.path == "/_state":
            with LOCK:
                return self._send([{"token": t, "sheets": SESSIONS[t]} for t in ORDER])
        if u.path.startswith("/v1/projects/"):
            return self._firestore(u.path, q)
        if u.path.startswith("/sheets/v4/spreadsheets/"):
            return self._sheets("GET", u.path.removeprefix("/sheets/v4/spreadsheets/"), q, None)
        return self._send({"error": {"code": 404, "message": "Not Found"}}, 404)

    def do_POST(self):  # noqa: N802
        u = urlparse(self.path)
        body = self._body()
        if u.path == "/token":
            form = parse_qs(body.decode())
            if form.get("grant_type") != ["urn:ietf:params:oauth:grant-type:jwt-bearer"] or not form.get("assertion"):
                return self._send({"error": "invalid_grant", "error_description": "bad request"}, 400)
            with LOCK:
                tok = f"stub-{len(ORDER) + 1}"
                SESSIONS[tok] = fixtures()
                ORDER.append(tok)
            return self._send({"access_token": tok, "expires_in": 3599, "token_type": "Bearer"})
        if u.path == "/_reset":
            with LOCK:
                SESSIONS.clear()
                ORDER.clear()
            return self._send({"ok": True})
        if u.path.startswith("/sheets/v4/spreadsheets/"):
            return self._sheets("POST", u.path.removeprefix("/sheets/v4/spreadsheets/"), parse_qs(u.query), json.loads(body or b"{}"))
        return self._send({"error": {"code": 404, "message": "Not Found"}}, 404)

    def do_PUT(self):  # noqa: N802
        return self._send({"error": {"code": 400, "message": "the stub has no PUT"}}, 400)

    # ----------------------------------------------------------------------- Firestore
    def _firestore(self, path: str, q) -> None:
        m = re.fullmatch(r"/v1/projects/[^/]+/databases/\(default\)/documents/daily/(\d{4}-\d{2}-\d{2})(/plants)?", unquote(path))
        if not m:
            return self._send({"error": {"code": 404, "message": "Not Found"}}, 404)
        base = path.split("/documents/")[0] + "/documents/daily/" + m.group(1)
        if not m.group(2):
            return self._send(fs_doc(base, FLEET_DOC))
        docs = [fs_doc(f"{base}/plants/{pid}", d) for pid, d in sorted(PLANT_DOCS.items())]
        return self._send({"documents": docs})

    # ----------------------------------------------------------------------- Sheets
    def _sheets(self, method: str, rest: str, q, body) -> None:
        sess = self._session()
        if sess is None:
            return self._send({"error": {"code": 401, "message": "Request had invalid authentication credentials."}}, 401)
        sid, _, tail = rest.partition("/")
        action = ""
        if ":" in sid:
            sid, action = sid.split(":", 1)
        tabs = sess.get(sid)
        if tabs is None:
            return self._send({"error": {"code": 404, "message": "Requested entity was not found."}}, 404)
        with LOCK:
            if method == "GET" and not tail and not action:
                return self._send({"sheets": [{"properties": {k: t[k] for k in ("sheetId", "title", "index")}} for t in tabs]})
            if method == "POST" and action == "batchUpdate":
                for req in body.get("requests", []):
                    d = req["duplicateSheet"]
                    src = next(t for t in tabs if t["sheetId"] == d["sourceSheetId"])
                    new = {"sheetId": max(t["sheetId"] for t in tabs) + 100, "title": d["newSheetName"], "index": d["insertSheetIndex"],
                           "rows": copy.deepcopy(src["rows"])}
                    for t in tabs:
                        if t["index"] >= new["index"]:
                            t["index"] += 1
                    tabs.append(new)
                    tabs.sort(key=lambda t: t["index"])
                return self._send({"spreadsheetId": sid, "replies": [{}]})
            if tail.startswith("values"):
                sub = tail.removeprefix("values")
                if method == "POST" and sub == ":batchUpdate":
                    if body.get("valueInputOption") != "RAW":
                        return self._send({"error": {"code": 400, "message": "valueInputOption"}}, 400)
                    for d in body.get("data", []):
                        title, cells = parse_range(d["range"])
                        tab = next(t for t in tabs if t["title"] == title)
                        r0, c0, _, _ = cells
                        for i, row in enumerate(d["values"]):
                            for j, v in enumerate(row):
                                set_cell(tab["rows"], r0 + i, c0 + j, v)
                    return self._send({"spreadsheetId": sid, "totalUpdatedCells": len(body.get("data", []))})
                rng = unquote(sub.removeprefix("/"))
                clear = rng.endswith(":clear")
                if clear:
                    rng = rng.removesuffix(":clear")
                title, cells = parse_range(rng)
                tab = next((t for t in tabs if t["title"] == title), None)
                if tab is None:
                    return self._send({"error": {"code": 400, "message": f"Unable to parse range: {rng}"}}, 400)
                if method == "GET":
                    if q.get("valueRenderOption") != ["UNFORMATTED_VALUE"]:
                        return self._send({"error": {"code": 400, "message": "valueRenderOption"}}, 400)
                    return self._send({"range": rng, "majorDimension": "ROWS", "values": trimmed(tab["rows"])})
                if clear:
                    r0, c0, r1, c1 = cells
                    for r in range(r0, min(r1 + 1, len(tab["rows"]))):
                        row = tab["rows"][r]
                        for c in range(c0, min(c1 + 1, len(row))):
                            row[c] = ""
                    tab["rows"] = trimmed(tab["rows"])
                    return self._send({"spreadsheetId": sid, "clearedRange": rng})
        return self._send({"error": {"code": 400, "message": f"the stub has no {method} {rest}"}}, 400)


def main() -> None:
    ThreadingHTTPServer(("127.0.0.1", int(sys.argv[1])), Handler).serve_forever()


if __name__ == "__main__":
    main()
