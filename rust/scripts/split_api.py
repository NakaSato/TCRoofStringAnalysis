"""Local split API: one port the frontend's dev proxy talks to (8000), routing each request to the
Rust API when Rust serves that path and to the Python API otherwise. This is the page-level check
of the Rust port (docs/plans/rust-port-master-plan.md, Phase 3 exit gate): every page keeps
working, and the ported routes are answered by Rust. Nothing in frontend/ or backend/ changes.

    PYTHONPATH=backend uv run uvicorn app.main:app --port 8010      # Python API, moved off 8000
    (cd rust && cargo run -p tcroof-api)                            # Rust API on :8001
    python3 rust/scripts/split_api.py                               # :8000 → Rust or Python
    cd frontend && bun run dev                                      # UI on :5173, /api → :8000 as always

Both APIs must use the same Postgres database (DATABASE_URL) and the same JWT_SECRET_KEY, so a
login on one is valid on the other.

The Rust paths are read from the Rust router source at start (`.route("…")` in
rust/crates/api/src/routes/, `/growatt` for routes/growatt/), so the split follows the port as it
grows. A path matches only as a whole (`{param}` = one segment), at `/api/…` or `/…`: a Python
route under a ported prefix (e.g. `/growatt/plants/{id}/rules/daily`) still goes to Python.
Every answer carries `X-Served-By: rust | python`, and each request is logged with its side.

Options: --port 8000 --python http://127.0.0.1:8010 --rust http://127.0.0.1:8001
         --all-python (route nothing to Rust, e.g. to compare a page). Stdlib only.
"""

from __future__ import annotations

import argparse
import http.client
import re
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import List, Pattern, Tuple
from urllib.parse import urlsplit

ROUTES_DIR = Path(__file__).resolve().parents[1] / "crates" / "api" / "src" / "routes"
ROUTE_RE = re.compile(r'\.route\(\s*"([^"]+)"')
# hop-by-hop headers (RFC 9110 §7.6.1) are not forwarded
HOP = {"connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade"}


def rust_paths() -> List[str]:
    """Every path the Rust API routes, with its nest prefix (`routes/mod.rs` nests growatt/ at /growatt)."""
    paths = set()
    for f in sorted(ROUTES_DIR.rglob("*.rs")):
        prefix = "/growatt" if "growatt" in f.relative_to(ROUTES_DIR).parts[:-1] else ""
        for p in ROUTE_RE.findall(f.read_text(encoding="utf-8")):
            paths.add(prefix + p)
    return sorted(paths)


def compile_paths(paths: List[str]) -> List[Pattern[str]]:
    out = []
    for p in paths:
        body = re.sub(r"\\\{[^/]+?\\\}", "[^/]+", re.escape(p))
        out.append(re.compile(rf"^(?:/api)?{body}/?$"))
    return out


class Split(BaseHTTPRequestHandler):
    rust: Tuple[str, int] = ("127.0.0.1", 8001)
    python: Tuple[str, int] = ("127.0.0.1", 8010)
    patterns: List[Pattern[str]] = []

    def log_message(self, format, *args):  # noqa: A002  (one line per request, from _forward)
        pass

    def _side(self) -> str:
        path = urlsplit(self.path).path
        return "rust" if any(p.match(path) for p in self.patterns) else "python"

    def _forward(self) -> None:
        side = self._side()
        host, port = self.rust if side == "rust" else self.python
        n = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(n) if n else None
        headers = {k: v for k, v in self.headers.items() if k.lower() not in HOP and k.lower() != "host"}
        headers["Host"] = f"{host}:{port}"
        t0 = time.monotonic()
        conn = http.client.HTTPConnection(host, port, timeout=300)
        try:
            conn.request(self.command, self.path, body=body, headers=headers)
            resp = conn.getresponse()
        except OSError as exc:
            msg = f"split_api: {side} API at {host}:{port} is not reachable ({exc})".encode()
            self.send_response(502)
            self.send_header("Content-Type", "text/plain; charset=utf-8")
            self.send_header("Content-Length", str(len(msg)))
            self.send_header("X-Served-By", side)
            self.end_headers()
            self.wfile.write(msg)
            print(f"{self.command} {self.path} → {side} 502 (unreachable)", flush=True)
            return
        self.send_response(resp.status, resp.reason)
        for k, v in resp.getheaders():
            if k.lower() not in HOP:
                self.send_header(k, v)
        self.send_header("X-Served-By", side)
        # no Content-Length (e.g. the assistant's SSE stream): close-delimited, streamed as it comes
        if resp.getheader("Content-Length") is None:
            self.send_header("Connection", "close")
            self.close_connection = True
        self.end_headers()
        try:
            while chunk := resp.read1(65536):
                self.wfile.write(chunk)
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            pass
        finally:
            conn.close()
        print(f"{self.command} {self.path} → {side} {resp.status} ({(time.monotonic() - t0) * 1000:.0f} ms)", flush=True)

    do_GET = do_POST = do_PUT = do_PATCH = do_DELETE = do_HEAD = do_OPTIONS = _forward


def main() -> int:
    ap = argparse.ArgumentParser(description=(__doc__ or "").split("\n\n")[0])
    ap.add_argument("--port", type=int, default=8000)
    ap.add_argument("--python", default="http://127.0.0.1:8010")
    ap.add_argument("--rust", default="http://127.0.0.1:8001")
    ap.add_argument("--all-python", action="store_true", help="send everything to Python")
    args = ap.parse_args()

    def hp(url: str) -> Tuple[str, int]:
        u = urlsplit(url)
        return u.hostname or "127.0.0.1", u.port or 80

    paths = [] if args.all_python else rust_paths()
    Split.rust, Split.python, Split.patterns = hp(args.rust), hp(args.python), compile_paths(paths)
    print(f"split_api on :{args.port}: {len(paths)} Rust paths → {args.rust}, the rest → {args.python}", flush=True)
    ThreadingHTTPServer(("127.0.0.1", args.port), Split).serve_forever()
    return 0


if __name__ == "__main__":
    sys.exit(main())
