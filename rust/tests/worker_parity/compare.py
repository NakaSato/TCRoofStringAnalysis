"""Worker parity: compare what one job run did to the Python copy and the Rust copy of the same
seeded database (rust/tests/worker_parity/run.sh runs the job on each side first).

Compared:
- every table the job may write (jobs.json `tables`), row by row in a fixed order;
- `sync_runs`: the seeded rows in full, and the run the job made (job, trigger, status,
  detail_json, error, finished or not; its id is the same on both sides, copies share sequences);
- `app_logs`: the seeded rows in full, and the records the worker logged during the run, in id
  order (level, logger, message, run id, job, host, whether a traceback was stored).

    python compare.py --job retention --py URL --rs URL --spec jobs.json --seed-runs N --seed-logs N

Exit 0 when everything is equal, 1 otherwise.
"""

from __future__ import annotations

import argparse
import datetime as dt
import decimal
import json
import re
import sys
from typing import Any, Dict, List, Tuple

import psycopg

MAX_SHOWN = 8


def norm(v: Any) -> Any:
    if isinstance(v, (dt.datetime, dt.date, dt.time)):
        return v.isoformat()
    if isinstance(v, decimal.Decimal):
        return float(v)
    if isinstance(v, dict):
        return {k: norm(x) for k, x in v.items()}
    if isinstance(v, list):
        return [norm(x) for x in v]
    return v


def rows(conn: psycopg.Connection, sql: str, params: Tuple = ()) -> List[Dict[str, Any]]:
    with conn.cursor() as cur:
        cur.execute(sql, params)
        names = [d.name for d in cur.description or []]
        return [{n: norm(v) for n, v in zip(names, r)} for r in cur.fetchall()]


def drop(d: Dict[str, Any], keys) -> Dict[str, Any]:
    return {k: v for k, v in d.items() if k not in keys}


def drop_path(d: Any, path: str) -> None:
    head, _, rest = path.partition(".")
    if not isinstance(d, dict) or head not in d:
        return
    if rest:
        drop_path(d[head], rest)
    else:
        d.pop(head)


def diff_lists(name: str, a: List[Any], b: List[Any]) -> List[str]:
    out = []
    if len(a) != len(b):
        out.append(f"{name}: {len(a)} rows in Python, {len(b)} in Rust")
    shown = 0
    for i, (x, y) in enumerate(zip(a, b)):
        if x != y:
            out.append(f"{name}[{i}]:\n    python {json.dumps(x, ensure_ascii=False, sort_keys=True)}\n    rust   {json.dumps(y, ensure_ascii=False, sort_keys=True)}")
            shown += 1
            if shown >= MAX_SHOWN:
                break
    for extra, side in ((a[len(b):], "python"), (b[len(a):], "rust")):
        for x in extra[:MAX_SHOWN]:
            out.append(f"{name}: only in {side}: {json.dumps(x, ensure_ascii=False, sort_keys=True)}")
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--job", required=True)
    ap.add_argument("--py", required=True)
    ap.add_argument("--rs", required=True)
    ap.add_argument("--spec", required=True)
    ap.add_argument("--seed-runs", type=int, required=True, help="max(sync_runs.id) of the seeded template")
    ap.add_argument("--seed-logs", type=int, required=True, help="max(app_logs.id) of the seeded template")
    args = ap.parse_args()
    spec = json.load(open(args.spec, encoding="utf-8"))[args.job]
    problems: List[str] = []
    checked = 0
    with psycopg.connect(args.py) as py, psycopg.connect(args.rs) as rs:
        for table, t in spec.get("tables", {}).items():
            order = ", ".join(t["order"])
            sql = f"SELECT * FROM {table} ORDER BY {order}"
            ign = set(t.get("ignore", []))
            a = [drop(r, ign) for r in rows(py, sql)]
            b = [drop(r, ign) for r in rows(rs, sql)]
            d = diff_lists(table, a, b)
            problems += d
            checked += len(a)
            print(f"{'ok  ' if not d else 'DIFF'} {table} ({len(a)} rows)")

        # sync_runs: seeded rows in full, the job's own run(s) by outcome
        seeded = "SELECT * FROM sync_runs WHERE id <= %s ORDER BY id"
        d = diff_lists("sync_runs (seeded)", rows(py, seeded, (args.seed_runs,)), rows(rs, seeded, (args.seed_runs,)))
        new_sql = "SELECT id, job, trigger, status, detail_json, error, finished_at IS NOT NULL AS finished FROM sync_runs WHERE id > %s ORDER BY id"
        new = []
        for conn in (py, rs):
            rr = rows(conn, new_sql, (args.seed_runs,))
            for r in rr:
                for p in spec.get("detail_ignore", []):
                    drop_path(r["detail_json"], p)
            new.append(rr)
        d += diff_lists("sync_runs (this run)", *new)
        problems += d
        print(f"{'ok  ' if not d else 'DIFF'} sync_runs ({len(new[0])} new run(s): {[ (r['job'], r['status']) for r in new[0]]})")

        # app_logs: seeded rows in full; the run's records without their timestamps / tracebacks
        seeded = "SELECT * FROM app_logs WHERE id <= %s ORDER BY id"
        d = diff_lists("app_logs (seeded)", rows(py, seeded, (args.seed_logs,)), rows(rs, seeded, (args.seed_logs,)))
        log_sql = (
            "SELECT level, level_no, source, host, logger, message, run_id, job, request_id, extra_json, "
            "exc_text IS NOT NULL AS has_exc FROM app_logs WHERE id > %s ORDER BY id"
        )
        skip = [re.compile(p) for p in spec.get("log_ignore", [])]
        logs = [[r for r in rows(c, log_sql, (args.seed_logs,)) if not any(p.search(r["message"]) for p in skip)] for c in (py, rs)]
        d += diff_lists("app_logs (this run)", *logs)
        problems += d
        print(f"{'ok  ' if not d else 'DIFF'} app_logs ({len(logs[0])} new record(s))")

    for p in problems:
        print("  " + p)
    print(f"worker parity {args.job}: {'equal' if not problems else f'{len(problems)} difference(s)'}")
    return 0 if not problems else 1


if __name__ == "__main__":
    sys.exit(main())
