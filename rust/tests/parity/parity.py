"""Golden-Diff parity check: the same requests to the Python API and the Rust API, compared.

    uv run python rust/tests/parity/parity.py [--python URL] [--rust URL] [--cases FILE]

Defaults: Python http://127.0.0.1:8000, Rust http://127.0.0.1:8001, cases.json next to this file.
Both APIs must start from the same database snapshot (each on its own copy, so a case that writes
changes both the same way) and use the same JWT_SECRET_KEY (rust/tests/parity/run.sh starts
everything that way). Logs in as each user in the cases file on each backend, sends every case to
both, in order, and reports per case: status equal, JSON keys equal, values equal (floats within
1e-6, the case's `ignore` paths skipped; `*` in a path matches any one key or index). A case's
`save` ({"name": "dotted.path"}) keeps a value of each backend's own answer; `${name}` in a later
case's path or body is replaced by that backend's value. Exits 1 on any difference.

Python is the oracle (rust/CLAUDE.md): a difference is a Rust bug until it is understood.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import hmac
import json
import math
import os
import sys
import time
from pathlib import Path
from typing import Any, Dict, List, Optional

import httpx

FLOAT_TOL = 1e-6


def _join(path: str, key: Any) -> str:
    return f"{path}.{key}" if path else str(key)


def key_diffs(a: Any, b: Any, path: str = "") -> List[str]:
    """Paths whose keys (or list lengths, or JSON kinds) differ."""
    out: List[str] = []
    if isinstance(a, dict) and isinstance(b, dict):
        for k in sorted(set(a) | set(b)):
            if k not in a:
                out.append(f"{_join(path, k)}: only in rust")
            elif k not in b:
                out.append(f"{_join(path, k)}: only in python")
            else:
                out.extend(key_diffs(a[k], b[k], _join(path, k)))
    elif isinstance(a, list) and isinstance(b, list):
        if len(a) != len(b):
            out.append(f"{path or '<root>'}: list length {len(a)} (python) vs {len(b)} (rust)")
        for i, (x, y) in enumerate(zip(a, b)):
            out.extend(key_diffs(x, y, _join(path, i)))
    elif isinstance(a, (dict, list)) or isinstance(b, (dict, list)):
        out.append(f"{path or '<root>'}: {type(a).__name__} (python) vs {type(b).__name__} (rust)")
    return out


def _num(v: Any) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool)


def ignored(path: str, ignore: set) -> bool:
    """`path` equals an ignore pattern, `*` matching any one segment."""
    segs = path.split(".")
    for pat in ignore:
        ps = pat.split(".")
        if len(ps) == len(segs) and all(p == "*" or p == s for p, s in zip(ps, segs)):
            return True
    return False


def value_diffs(a: Any, b: Any, ignore: set, path: str = "") -> List[str]:
    """Paths whose values differ (keys present on one side only are key_diffs' job)."""
    if path and ignored(path, ignore):
        return []
    if isinstance(a, dict) and isinstance(b, dict):
        out: List[str] = []
        for k in sorted(set(a) & set(b)):
            out.extend(value_diffs(a[k], b[k], ignore, _join(path, k)))
        return out
    if isinstance(a, list) and isinstance(b, list):
        out = []
        for i, (x, y) in enumerate(zip(a, b)):
            out.extend(value_diffs(x, y, ignore, _join(path, i)))
        return out
    if _num(a) and _num(b):
        if isinstance(a, int) and isinstance(b, int):
            same = a == b
        else:
            same = math.isclose(float(a), float(b), rel_tol=0.0, abs_tol=FLOAT_TOL)
        return [] if same else [f"{path or '<root>'}: {a!r} (python) vs {b!r} (rust)"]
    if a != b or type(a) is not type(b):
        return [f"{path or '<root>'}: {a!r} (python) vs {b!r} (rust)"]
    return []


def _body(res: httpx.Response) -> Any:
    if not res.content:
        return None
    try:
        return res.json()
    except ValueError:
        return {"<non-json>": res.text[:200]}


def login_all(client: httpx.Client, base: str, users: Dict[str, Dict[str, str]]) -> Dict[str, str]:
    tokens = {}
    for name, creds in users.items():
        res = client.post(f"{base}/api/auth/login", json=creds)
        if res.status_code != 200:
            raise SystemExit(f"login as {name} on {base} failed: {res.status_code} {res.text[:200]}")
        tokens[name] = res.json()["access_token"]
    return tokens


def _b64(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode()


def expired_copy(token: str) -> str:
    """The token's claims with `exp` an hour ago, re-signed (HS256) with JWT_SECRET_KEY, the key
    both backends share (run.sh exports it)."""
    secret = os.environ.get("JWT_SECRET_KEY", "")
    if not secret:
        raise SystemExit('a case uses {"expired": ...}: set JWT_SECRET_KEY to the key both backends use')
    payload = token.split(".")[1]
    claims = json.loads(base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4)))
    claims["exp"] = int(time.time()) - 3600
    head = _b64(json.dumps({"alg": "HS256", "typ": "JWT"}, separators=(",", ":")).encode())
    body = _b64(json.dumps(claims, separators=(",", ":")).encode())
    sig = hmac.new(secret.encode(), f"{head}.{body}".encode(), hashlib.sha256).digest()
    return f"{head}.{body}.{_b64(sig)}"


def auth_header(auth: Any, own: Dict[str, str], other: Dict[str, str]) -> Optional[str]:
    if auth is None:
        return None
    if isinstance(auth, dict):
        if "expired" in auth:
            return f"Bearer {expired_copy(own[auth['expired']])}"
        return auth["raw"]
    user, _, which = str(auth).partition("@")
    tokens = other if which == "other" else own
    return f"Bearer {tokens[user]}"


def dig(body: Any, path: str) -> Any:
    for seg in path.split("."):
        body = body[int(seg)] if isinstance(body, list) else body[seg]
    return body


def subst(v: Any, vars: Dict[str, Any]) -> Any:
    """`${name}` → the saved value: the whole string becomes the value itself, else its text."""
    if isinstance(v, str):
        for name, val in vars.items():
            token = "${" + name + "}"
            if v == token:
                return val
            v = v.replace(token, str(val))
        return v
    if isinstance(v, list):
        return [subst(x, vars) for x in v]
    if isinstance(v, dict):
        return {k: subst(x, vars) for k, x in v.items()}
    return v


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--python", default="http://127.0.0.1:8000")
    ap.add_argument("--rust", default="http://127.0.0.1:8001")
    ap.add_argument("--cases", default=str(Path(__file__).with_name("cases.json")))
    args = ap.parse_args()

    spec = json.loads(Path(args.cases).read_text(encoding="utf-8"))
    bases = {"python": args.python.rstrip("/"), "rust": args.rust.rstrip("/")}
    failed = 0
    saved: Dict[str, Dict[str, Any]] = {"python": {}, "rust": {}}
    with httpx.Client(timeout=30.0) as client:
        tokens = {side: login_all(client, base, spec["users"]) for side, base in bases.items()}
        for case in spec["cases"]:
            got = {}
            for side, base in bases.items():
                other = tokens["rust" if side == "python" else "python"]
                headers = {}
                auth = auth_header(case.get("auth"), tokens[side], other)
                if auth is not None:
                    headers["Authorization"] = auth
                path = subst(case["path"], saved[side])
                kw: Dict[str, Any] = {}
                if "raw_body" in case:
                    kw["content"] = case["raw_body"].encode()
                    if case.get("content_type"):
                        headers["Content-Type"] = case["content_type"]
                elif "body" in case:
                    kw["json"] = subst(case["body"], saved[side])
                res = client.request(case.get("method", "GET"), base + path, headers=headers, **kw)
                got[side] = res
                for name, where in case.get("save", {}).items():
                    try:
                        saved[side][name] = dig(_body(res), where)
                    except (KeyError, IndexError, TypeError, ValueError):
                        raise SystemExit(f"case {case['name']!r}: {side} answer has no {where!r}: {res.text[:200]}")
            py, rs = got["python"], got["rust"]
            pb, rb = _body(py), _body(rs)
            problems: List[str] = []
            if py.status_code != rs.status_code:
                problems.append(f"status {py.status_code} (python) vs {rs.status_code} (rust)")
            if not case.get("keys_ignored"):
                problems.extend(f"keys  {d}" for d in key_diffs(pb, rb))
                problems.extend(f"value {d}" for d in value_diffs(pb, rb, set(case.get("ignore", []))))
            for h in case.get("headers", []):
                if py.headers.get(h) != rs.headers.get(h):
                    problems.append(f"header {h}: {py.headers.get(h)!r} (python) vs {rs.headers.get(h)!r} (rust)")
            label = f"{case.get('method', 'GET'):4} {case['path']}  [{case['name']}]"
            if problems:
                failed += 1
                print(f"DIFF {label}  status {py.status_code}/{rs.status_code}")
                for p in problems:
                    print(f"       {p}")
            else:
                checked = "status" if case.get("keys_ignored") else "status, keys, values"
                print(f"ok   {label}  {py.status_code}  ({checked})")
    total = len(spec["cases"])
    print(f"\nparity: {total - failed}/{total} cases equal, {failed} with differences")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
