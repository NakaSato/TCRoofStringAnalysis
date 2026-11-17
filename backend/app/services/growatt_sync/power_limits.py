"""Each inverter's active power limit, read from the inverter (`power_limits` job)."""

from __future__ import annotations

import time
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, Optional

from sqlalchemy.orm import Session

from app.db.models import GrowattInverter
from solar_core.growatt import GrowattAPIError, GrowattClient
from app.services.growatt_sync.common import RATE_LIMIT_CODE, _inverters_query, log

POWER_LIMIT_REFRESH_HOURS = 20  # one read per inverter per day (the job runs daily)


POWER_LIMIT_PAUSE_S = 2.0  # between calls: a full account at this pace hit no 10012 (15 Nov 2026)


def sync_power_limits(
    db: Session,
    client: GrowattClient,
    phase: Optional[int] = None,
    include_untagged: bool = False,
    now: Optional[datetime] = None,
    pause_s: float = POWER_LIMIT_PAUSE_S,
    max_rate_limited: int = 3,
) -> Dict[str, Any]:
    """Read each inverter's active power limit (`readPower`) and store it as `power_limit_pct`.

    Inverters never read / read longest ago first, skipping ones read within
    POWER_LIMIT_REFRESH_HOURS. The read goes through the datalogger to the inverter, so it runs
    in daylight; refusals (offline inverter, a datalogger that doesn't pass it on: about 1 in 5)
    leave the stored value and its `power_limit_read_at` as they were, never write a default.
    `max_rate_limited` 10012s in a row end the sweep (the run is `partial`).
    """
    now = (now or datetime.now(timezone.utc)).astimezone(timezone.utc)
    cutoff = now - timedelta(hours=POWER_LIMIT_REFRESH_HOURS)
    q = _inverters_query(phase, include_untagged).order_by(None).order_by(
        GrowattInverter.power_limit_read_at.is_not(None), GrowattInverter.power_limit_read_at, GrowattInverter.device_sn
    )
    out: Dict[str, Any] = {"power_limits_read": 0, "power_limited": 0, "power_limit_unreadable": 0, "failed": []}
    errors: Dict[str, int] = {}
    in_a_row = 0
    asked = 0
    for inv in list(db.scalars(q)):
        last = inv.power_limit_read_at
        if last is not None and (last if last.tzinfo else last.replace(tzinfo=timezone.utc)) > cutoff:
            continue
        if asked:
            time.sleep(pause_s)
        asked += 1
        try:
            pct = client.read_power(inv.device_sn)
        except GrowattAPIError as exc:
            if exc.error_code == RATE_LIMIT_CODE:
                in_a_row += 1
                if in_a_row >= max_rate_limited:
                    log.warning("readPower rate limited %d times in a row; the rest wait for the next run", in_a_row)
                    out["failed"].append(f"phase {phase}: readPower rate limited")
                    break
                continue
            in_a_row = 0
            out["power_limit_unreadable"] += 1
            key = str(exc.error_code)
            errors[key] = errors.get(key, 0) + 1
            log.debug("inverter %s readPower refused: %s", inv.device_sn, exc)
            continue
        except Exception as exc:  # network etc.: skip this inverter
            in_a_row = 0
            out["power_limit_unreadable"] += 1
            errors["error"] = errors.get("error", 0) + 1
            log.warning("inverter %s readPower failed: %s", inv.device_sn, exc)
            continue
        in_a_row = 0
        # a change of a known limit is worth a line; the first read of each inverter is not
        if inv.power_limit_pct is not None and inv.power_limit_pct != pct:
            log.info("inverter %s power limit %s -> %s %%", inv.device_sn, inv.power_limit_pct, pct)
        inv.power_limit_pct = pct
        inv.power_limit_read_at = now
        db.commit()
        out["power_limits_read"] += 1
        if pct < 100:
            out["power_limited"] += 1
    out["power_limit_errors"] = errors
    log.info(
        "phase %s readPower: %d read (%d below 100 %%), %d refused %s",
        phase, out["power_limits_read"], out["power_limited"], out["power_limit_unreadable"], errors,
    )
    return out
