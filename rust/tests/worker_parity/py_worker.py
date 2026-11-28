"""Run the Python worker (`python -m app.worker ARGS`) for the worker parity harness, with
firebase_admin's FCM endpoint moved to FCM_BASE_URL (Python has no setting for it; the Rust worker
reads FCM_BASE_URL). Refuses to run when a Firebase key file is set but FCM or the key file's
token server is not on 127.0.0.1, so a parity run can never send a real push.
"""

from __future__ import annotations

import json
import os
import runpy
import sys

LOCAL = "http://127.0.0.1:"


def main() -> None:
    creds = os.environ.get("FIREBASE_CREDENTIALS_FILE", "")
    base = os.environ.get("FCM_BASE_URL", "")
    if creds:
        token_uri = json.load(open(creds, encoding="utf-8")).get("token_uri", "")
        if not base.startswith(LOCAL) or not token_uri.startswith(LOCAL):
            sys.exit(f"py_worker: refusing to run: FCM_BASE_URL {base!r} / token_uri {token_uri!r} are not local stubs")
    if base:
        from firebase_admin import messaging

        messaging._MessagingService.FCM_URL = base.rstrip("/") + "/v1/projects/{0}/messages:send"
    sys.argv = ["app.worker", *sys.argv[1:]]
    runpy.run_module("app.worker", run_name="__main__", alter_sys=True)


if __name__ == "__main__":
    main()
