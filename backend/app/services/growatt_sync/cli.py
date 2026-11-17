"""Command line: `python -m app.services.growatt_sync` (see the package docstring)."""

from __future__ import annotations

import argparse
from datetime import date, timedelta
from typing import Optional, Sequence

from app.config import settings
from app.logging_db import setup_logging
from app.db.session import SessionLocal, ensure_schema
from solar_core.growatt import GrowattClient
from app.services.growatt_sync.common import log
from app.services.growatt_sync.env import sync_env_all
from app.services.growatt_sync.inverters import sync_all_history
from app.services.growatt_sync.registry import remove_blocked_plants, sync_fleet

def main(argv: Optional[Sequence[str]] = None) -> None:
    today = date.today()
    ap = argparse.ArgumentParser(description="Sync Growatt plants, inverters and string history into the app DB")
    ap.add_argument("--start", type=date.fromisoformat, default=today - timedelta(days=1))
    ap.add_argument("--end", type=date.fromisoformat, default=today)
    ap.add_argument("--sn", action="append", help="Only these inverter serials (repeatable)")
    ap.add_argument("--fleet-only", action="store_true", help="Only sync plants and inverters")
    ap.add_argument("--skip-fleet", action="store_true", help="Use inverters already in the DB")
    ap.add_argument("--phase", type=int, action="append", help="Only these project phases / accounts (repeatable)")
    args = ap.parse_args(argv)
    setup_logging("cli")

    accounts = settings.growatt_accounts()
    if not accounts:
        raise SystemExit("No Growatt token configured (GROWATT_TOKEN_PHASE1..4 or GROWATT_API_TOKEN)")
    first = min(accounts)
    phases = [p for p in sorted(accounts) if not args.phase or p in args.phase]
    with SessionLocal() as db:
        ensure_schema(db.get_bind())
        remove_blocked_plants(db, settings.blocked_plant_ids())
        for phase in phases:
            client = GrowattClient(
                token=accounts[phase],
                base_url=settings.growatt_base_url,
                timeout=60,
                blocked_plant_ids=settings.blocked_plant_ids(),
            )
            if not args.skip_fleet:
                sync_fleet(db, client, phase=phase)
            if args.fleet_only:
                continue
            totals = sync_all_history(
                db, client, args.start, args.end, device_sns=args.sn, phase=phase, include_untagged=phase == first
            )
            log.info(
                "phase %s done %s..%s: %d inverters, %d inverter records, %d string rows, %d failed",
                phase, args.start, args.end, totals["inverters"], totals["inverter_rows"], totals["string_rows"],
                len(totals["failed"]),
            )
            for sn, err in totals["failed"]:
                log.info("  failed %s: %s", sn, err)
            if args.sn:  # inverter-only run
                continue
            env = sync_env_all(db, client, args.start, args.end, phase=phase, include_untagged=phase == first)
            log.info(
                "phase %s weather: %d sensors, %d records, %d failed",
                phase, env["env_sensors"], env["env_rows"], len(env["env_failed"]),
            )
