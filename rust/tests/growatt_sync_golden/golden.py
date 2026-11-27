"""Growatt sync golden comparison, the Python side (run.sh drives it).

    golden.py run <scenario> <db_url> <stub_url> <today>   # Python sync functions → step results (JSON lines)
    golden.py dump <db_url> <since_iso>                     # the sync tables as JSON (stdout)
    golden.py compare <py_dir> <rs_dir> <scenario>          # results + dumps of both sides, exit 1 on a difference

`run` calls the functions of backend/app/services/growatt_sync, growatt_energy and growatt_alarms
named in scenarios.json against the stub (sync_stub.py) with every pause patched out, as the
Python tests patch `time.sleep`. The Rust side is `cargo run -p tcroof-services --example
growatt_sync_golden` with the same arguments. `dump` writes every row of the tables the sync
functions touch; bookkeeping times (TIMESTAMPTZ) written during the run are masked as "<now>",
the serial id of `growatt_alarms` is left out.
"""

from __future__ import annotations

import json
import os
import sys
from datetime import date, datetime, timedelta
from pathlib import Path

HERE = Path(__file__).resolve().parent
TABLES = {
    "growatt_plants": "plant_id",
    "growatt_inverters": "device_sn",
    "growatt_inverter_readings": "device_sn, timestamp",
    "growatt_string_records": "device_sn, timestamp",
    "growatt_inverter_raw": "device_sn, timestamp",
    "growatt_env_sensors": "datalogger_sn, address",
    "growatt_env_readings": "datalogger_sn, address, timestamp",
    "growatt_meters": "datalogger_sn, address",
    "growatt_meter_readings": "datalogger_sn, address, timestamp",
    "growatt_alarms": "device_sn, day, start_time, alarm_code",
    "growatt_alarm_syncs": "device_sn, day",
    "growatt_plant_energy_days": "plant_id, day",
    "growatt_inverter_energy_days": "device_sn, day",
    "growatt_plant_power": "plant_id, timestamp",
    "growatt_issues": "plant_id, rule",
    "om_plant_settings": "plant_id",
    "plant_documents": "plant_id, kind",
}
# json columns whose exact text is compared too (Python writes them compact, `session._compact_json`)
TEXT_JSON = {"growatt_inverter_readings": ["mppt_json"], "growatt_string_records": ["strings"]}
DROP = {"growatt_alarms": {"id"}, "growatt_issues": {"id", "created_at", "updated_at"}, "plant_documents": {"id"}}


def day_of(v, today: date):
    if v is None:
        return None
    s = str(v)
    if s == "D":
        return today
    if s.startswith("D-"):
        return today - timedelta(days=int(s[2:]))
    return date.fromisoformat(s)


def run(scenario: str, db_url: str, stub: str, today_s: str) -> None:
    # nothing may reach production: blank every credential before app.config is imported
    for k in ("GROWATT_API_TOKEN", "GROWATT_TOKEN_PHASE1", "GROWATT_TOKEN_PHASE2", "GROWATT_TOKEN_PHASE3", "GROWATT_TOKEN_PHASE4",
              "GOOGLE_WEATHER_API_KEY", "LONGDO_API_KEY", "FIREBASE_CREDENTIALS_FILE", "FIREBASE_PROJECT_ID", "REDIS_URL",
              "PWA_SHEET_ID", "FIREBASE_WEB_API_KEY", "FIREBASE_VAPID_KEY", "AI_API_KEY", "GEOAPIFY_API_KEY"):
        os.environ[k] = ""
    os.environ.update(DATABASE_URL=db_url, PUBLISH_SINK="json", LOG_DB_ENABLED="false", APP_ENV="dev")
    import time

    time.sleep = lambda _s: None  # the pauses and retry waits (tests patch them the same way)

    from sqlalchemy import select
    from sqlalchemy.orm import sessionmaker

    from app.config import settings
    from app.db.models import GrowattInverter
    from app.db.session import build_engine
    from app.services import growatt_alarms, growatt_energy, growatt_sync as gs
    from solar_core.growatt import GrowattClient

    today = date.fromisoformat(today_s)
    steps = json.loads((HERE / "scenarios.json").read_text())["scenarios"][scenario]
    engine = build_engine(db_url)
    Session = sessionmaker(bind=engine, future=True)
    clients = {n: GrowattClient(f"tok-p{n}", base_url=stub) for n in (1, 2)}
    for i, step in enumerate(steps):
        a = step.get("args", {})
        settings.history_store_raw = bool(step.get("store_raw", False))
        settings.meter_history_enabled = bool(step.get("meter_history", True))
        c = clients.get(step.get("account", 1))
        ph, ut = a.get("phase"), bool(a.get("include_untagged", False))
        fn = step["fn"]
        with Session() as db:
            try:
                if fn == "remove_blocked_plants":
                    out = gs.remove_blocked_plants(db, a["plant_ids"])
                elif fn == "sync_fleet":
                    out = [inv.device_sn for inv in gs.sync_fleet(db, c, pause_s=0, phase=ph)]
                elif fn == "sync_incremental":
                    out = gs.sync_incremental(db, c, today, pause_s=0, phase=ph, include_untagged=ut, batch_size=a.get("batch_size", 0))
                elif fn == "sync_env_incremental":
                    out = gs.sync_env_incremental(db, c, today, pause_s=0, phase=ph, include_untagged=ut,
                                                  retries=a.get("retries", 3), max_rate_limited=a.get("max_rate_limited"))
                elif fn == "sync_meter_incremental":
                    out = gs.sync_meter_incremental(db, c, today, pause_s=0, phase=ph, include_untagged=ut)
                elif fn == "sync_all_history":
                    out = gs.sync_all_history(db, c, day_of(a["start"], today), day_of(a["end"], today), device_sns=a.get("device_sns"),
                                              pause_s=0, phase=ph, include_untagged=ut)
                elif fn == "sync_env_all":
                    out = gs.sync_env_all(db, c, day_of(a["start"], today), day_of(a["end"], today), pause_s=0, phase=ph, include_untagged=ut)
                elif fn == "sync_meter_all":
                    out = gs.sync_meter_all(db, c, day_of(a["start"], today), day_of(a["end"], today), pause_s=0, phase=ph, include_untagged=ut)
                elif fn == "sync_latest_records":
                    out = gs.sync_latest_records(db, c, today, phase=ph, include_untagged=ut, first_chunk=a.get("first_chunk", 0), pause_s=0)
                elif fn == "sync_power_limits":
                    out = gs.sync_power_limits(db, c, phase=ph, include_untagged=ut, pause_s=0)
                elif fn == "sync_growatt_energy":
                    out = growatt_energy.sync_growatt_energy(db, c, today, phase=ph, include_untagged=ut, pause_s=0)
                elif fn == "backfill_plant_energy":
                    out = growatt_energy.backfill_plant_energy(db, c, today, days=a["days"], phase=ph, include_untagged=ut, pause_s=0)
                elif fn == "sync_alarms":
                    t = a.get("tiers")
                    tiers = None
                    if t:
                        tiers = growatt_alarms.Tiers(hot=timedelta(minutes=t[0]), warm=timedelta(minutes=t[1]), cold=timedelta(minutes=t[2]),
                                                     tick=timedelta(minutes=t[3]) if t[3] is not None else None)
                    invs = list(db.scalars(gs._inverters_query(ph, ut)))
                    out = growatt_alarms.sync_alarms(db, c, day_of(a["day"], today), invs, pause_s=0, tiers=tiers)
                else:
                    raise SystemExit(f"golden.py: unknown fn {fn}")
                res = {"result": out}
            except Exception as exc:  # noqa: BLE001 - recorded and compared
                db.rollback()
                res = {"error": f"{type(exc).__name__}: {exc}"}
        print(json.dumps({"step": i, "fn": fn, **res}, default=str, sort_keys=True))
    engine.dispose()


def dump(db_url: str, since_s: str) -> None:
    import psycopg

    since = datetime.fromisoformat(since_s)
    out = {}
    with psycopg.connect(db_url.replace("postgresql+psycopg://", "postgresql://")) as conn:
        for t, order in TABLES.items():
            tz_cols = {r[0] for r in conn.execute(
                "SELECT column_name FROM information_schema.columns WHERE table_name = %s AND data_type = 'timestamp with time zone'", (t,))}
            text_cols = TEXT_JSON.get(t, [])
            extra = "".join(f", {c}::text" for c in text_cols)
            rows = []
            for rec in conn.execute(f"SELECT to_jsonb(x){extra} FROM {t} x ORDER BY {order}"):
                row = {k: v for k, v in rec[0].items() if k not in DROP.get(t, set())}
                for c in tz_cols:
                    v = row.get(c)
                    if isinstance(v, str) and datetime.fromisoformat(v) >= since:
                        row[c] = "<now>"
                for c, txt in zip(text_cols, rec[1:]):
                    row[f"{c}__text"] = txt
                rows.append(row)
            out[t] = rows
    print(json.dumps(out, sort_keys=True, default=str))


def compare(py_dir: str, rs_dir: str, scenario: str) -> int:
    bad = 0
    pr = [json.loads(line) for line in Path(py_dir, f"{scenario}.steps").read_text().splitlines() if line.strip()]
    rr = [json.loads(line) for line in Path(rs_dir, f"{scenario}.steps").read_text().splitlines() if line.strip()]
    for a, b in zip(pr, rr):
        if a != b:
            bad += 1
            print(f"  step {a['step']} {a['fn']}:\n    python {json.dumps(a, sort_keys=True)}\n    rust   {json.dumps(b, sort_keys=True)}")
    if len(pr) != len(rr):
        bad += 1
        print(f"  steps: python {len(pr)}, rust {len(rr)}")
    pd = json.loads(Path(py_dir, f"{scenario}.dump").read_text())
    rd = json.loads(Path(rs_dir, f"{scenario}.dump").read_text())
    for t in TABLES:
        a, b = pd.get(t, []), rd.get(t, [])
        if a == b:
            continue
        bad += 1
        print(f"  table {t}: python {len(a)} rows, rust {len(b)} rows")
        shown = 0
        for i in range(max(len(a), len(b))):
            x = a[i] if i < len(a) else None
            y = b[i] if i < len(b) else None
            if x != y and shown < 4:
                shown += 1
                keys = sorted(set(x or {}) | set(y or {}))
                diff = {k: [(x or {}).get(k), (y or {}).get(k)] for k in keys if (x or {}).get(k) != (y or {}).get(k)}
                print(f"    row {i}: {json.dumps(diff, default=str)[:600]}")
    counts = {t: len(pd.get(t, [])) for t in TABLES if pd.get(t)}
    print(f"  {scenario}: {len(pr)} steps, rows {counts}" if not bad else f"  {scenario}: {bad} difference(s)")
    return bad


if __name__ == "__main__":
    cmd = sys.argv[1]
    if cmd == "run":
        run(*sys.argv[2:6])
    elif cmd == "dump":
        dump(*sys.argv[2:4])
    elif cmd == "compare":
        sys.exit(1 if compare(*sys.argv[2:5]) else 0)
    else:
        raise SystemExit(__doc__)
