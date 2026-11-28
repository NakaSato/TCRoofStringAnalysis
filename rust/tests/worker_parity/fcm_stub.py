"""Stub FCM HTTP v1 and Google OAuth token server for the worker parity's push jobs, so neither
worker ever reaches Google: the test key file's `token_uri` is this server's /token, and FCM is
sent to FCM_BASE_URL = http://127.0.0.1:PORT/<run> (Python: rust/tests/worker_parity/py_worker.py
patches firebase_admin's FCM_URL; Rust: FCM_BASE_URL).

    python3 fcm_stub.py PORT RECORD_DIR

- POST /token: the JWT-bearer grant; the assertion must be a JWT with iss / aud / scope; answers
  a fixed access token.
- POST /<run>/v1/projects/<project>/messages:send: needs that token; each message is appended to
  RECORD_DIR/<run>.jsonl (project, token, data, webpush). The device token decides the answer:
  contains "-gone" → 404 UNREGISTERED, "-mismatch" → 403 SENDER_ID_MISMATCH, "-bad" → 400
  INVALID_ARGUMENT, else 200.
- GET /ping.

Stdlib only.
"""

from __future__ import annotations

import base64
import json
import os
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

ACCESS_TOKEN = "stub-access-token"
LOCK = threading.Lock()
RECORD_DIR = ""
SEQ = [0]


def fcm_error(status: int, code: str, fcm_code: str | None) -> dict:
    details = [{"@type": "type.googleapis.com/google.firebase.fcm.v1.FcmError", "errorCode": fcm_code}] if fcm_code else []
    return {"error": {"code": status, "message": f"stub {code}", "status": code, "details": details}}


def jwt_claims(assertion: str) -> dict | None:
    parts = assertion.split(".")
    if len(parts) != 3:
        return None
    try:
        pad = parts[1] + "=" * (-len(parts[1]) % 4)
        return json.loads(base64.urlsafe_b64decode(pad))
    except ValueError:
        return None


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):  # quiet
        pass

    def _send(self, status: int, body: dict) -> None:
        raw = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def _body(self) -> bytes:
        n = int(self.headers.get("Content-Length") or 0)
        return self.rfile.read(n) if n else b""

    def do_GET(self):  # noqa: N802
        if urlparse(self.path).path == "/ping":
            return self._send(200, {"ok": True})
        self._send(404, {"error": "not found"})

    def do_POST(self):  # noqa: N802
        path = urlparse(self.path).path
        body = self._body()
        if path == "/token":
            form = {k: v[-1] for k, v in parse_qs(body.decode()).items()}
            claims = jwt_claims(form.get("assertion", ""))
            if form.get("grant_type") != "urn:ietf:params:oauth:grant-type:jwt-bearer" or not claims \
                    or not claims.get("iss") or not claims.get("aud") or not claims.get("scope"):
                return self._send(400, {"error": "invalid_grant", "error_description": "stub: bad assertion"})
            return self._send(200, {"access_token": ACCESS_TOKEN, "expires_in": 3600, "token_type": "Bearer"})
        run, sep, rest = path.lstrip("/").partition("/v1/projects/")
        if not sep or not rest.endswith("/messages:send") or "/" in run or not run:
            return self._send(404, {"error": "not found"})
        if self.headers.get("Authorization") != f"Bearer {ACCESS_TOKEN}":
            return self._send(401, {"error": {"code": 401, "status": "UNAUTHENTICATED", "message": "stub: no token"}})
        project = rest.removesuffix("/messages:send")
        msg = json.loads(body or b"{}").get("message", {})
        token = msg.get("token", "")
        with LOCK:
            with open(os.path.join(RECORD_DIR, f"{run}.jsonl"), "a", encoding="utf-8") as f:
                f.write(json.dumps({"project": project, "token": token, "data": msg.get("data"), "webpush": msg.get("webpush"),
                                    "keys": sorted(msg)}, ensure_ascii=False) + "\n")
            SEQ[0] += 1
            n = SEQ[0]
        if "-gone" in token:
            return self._send(404, fcm_error(404, "NOT_FOUND", "UNREGISTERED"))
        if "-mismatch" in token:
            return self._send(403, fcm_error(403, "PERMISSION_DENIED", "SENDER_ID_MISMATCH"))
        if "-bad" in token:
            return self._send(400, fcm_error(400, "INVALID_ARGUMENT", "INVALID_ARGUMENT"))
        self._send(200, {"name": f"projects/{project}/messages/{n}"})


def main() -> None:
    global RECORD_DIR
    port, RECORD_DIR = int(sys.argv[1]), sys.argv[2]
    os.makedirs(RECORD_DIR, exist_ok=True)
    ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()


if __name__ == "__main__":
    main()
