"""Worker parity: points the Python worker's fixed external endpoints at the harness stubs.

Loaded by Python at start-up (run.sh puts this folder on PYTHONPATH for the Python worker only)
and active only with PARITY_PY_SHIM=1. backend/ is not changed; these are module attributes the
Python code reads at call time:

- every HTTPS request goes to a dead proxy (HTTPS_PROXY=http://127.0.0.1:9): nothing real can be
  reached even if a URL below were missed (the stubs are plain HTTP on 127.0.0.1, NO_PROXY);
- `daily_summary.DATA_DIR` = PARITY_DATA_DIR: the JSON publish sink writes into the run's
  temporary folder, not the repo's data/;
- `pwa_sheet.API` = PWA_SHEET_API_URL (the Sheets stub; Python's URL is fixed);
- `pwa_report.firestore_day_docs` reads FIRESTORE_EMULATOR_HOST over the REST API (the stub)
  instead of the Admin SDK (which would speak gRPC). Same answer shape: the fleet doc under
  `_day`, then (plant_id, doc) in document id order.

A failure here stops the worker (an import error), so a half-patched worker never runs.
"""

import os

if os.environ.get("PARITY_PY_SHIM") == "1":
    import json
    import pathlib
    import urllib.request
    from urllib.parse import urlencode

    os.environ["HTTPS_PROXY"] = os.environ["https_proxy"] = "http://127.0.0.1:9"
    os.environ["NO_PROXY"] = os.environ["no_proxy"] = "127.0.0.1,localhost"

    from app.services import daily_summary, pwa_report, pwa_sheet

    daily_summary.DATA_DIR = pathlib.Path(os.environ["PARITY_DATA_DIR"])
    if os.environ.get("PWA_SHEET_API_URL"):
        pwa_sheet.API = os.environ["PWA_SHEET_API_URL"].rstrip("/")

    def _decode(v):
        if "integerValue" in v:
            return int(v["integerValue"])
        if "doubleValue" in v:
            return float(v["doubleValue"])
        for k in ("booleanValue", "stringValue", "timestampValue"):
            if k in v:
                return v[k]
        if "mapValue" in v:
            return {k: _decode(x) for k, x in (v["mapValue"].get("fields") or {}).items()}
        if "arrayValue" in v:
            return [_decode(x) for x in v["arrayValue"].get("values") or []]
        return None

    def _get(url):
        req = urllib.request.Request(url, headers={"Authorization": "Bearer owner"})
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        try:
            with opener.open(req, timeout=30) as r:
                return json.load(r)
        except urllib.error.HTTPError as e:
            if e.code == 404:
                return None
            raise

    def _stub_day_docs(day):
        host = os.environ.get("FIRESTORE_EMULATOR_HOST")
        if not host:
            raise RuntimeError("worker parity: FIRESTORE_EMULATOR_HOST not set")
        project = os.environ.get("FIREBASE_PROJECT_ID") or "parity-stub"
        root = f"http://{host}/v1/projects/{project}/databases/(default)/documents/daily/{day.isoformat()}"
        head = _get(root + "?" + urlencode({"mask.fieldPaths": "checks_ready"}))
        out = [(pwa_report.DAY_KEY, {k: _decode(v) for k, v in (head.get("fields") or {}).items()} if head else {})]
        q = urlencode([("mask.fieldPaths", f) for f in pwa_report.DAY_FIELDS])
        body = _get(f"{root}/plants?{q}") or {}
        for d in body.get("documents") or []:
            out.append((d["name"].rsplit("/", 1)[-1], {k: _decode(v) for k, v in (d.get("fields") or {}).items()}))
        return out

    pwa_report.firestore_day_docs = _stub_day_docs
