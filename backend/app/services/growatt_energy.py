"""Growatt's own daily energy and plant power curve → SQL (docs/plans/growatt-new-endpoints.md).

- `plant/energy`: daily kWh per plant, the last ENERGY_LOOKBACK_DAYS finished days every run
  (re-reads late uploads; one call per plant).
- `plant/power`: the plant's 5-minute AC curve for each finished day not stored yet.
- `device/inverter/day_energy`: each inverter's kWh for each finished day not stored yet.

Only days before today (plant-local) are written: today's figures are realtime (rule 1). These
are Growatt's numbers, kept next to (never instead of) what is integrated from stored records.
Rate limits of these endpoints are unknown: `max_rate_limited` 10012s in a row end an account's
sweep (the run is `partial`); the next run fills the missing days first.
"""

from __future__ import annotations

import logging
import time
from datetime import date, datetime, timedelta, timezone
from typing import Any, Callable, Dict, List, Optional, Sequence, Set, Tuple

from sqlalchemy import delete, func, or_, select
from sqlalchemy.orm import Session

from app.db.models import (
    GrowattInverter,
    GrowattInverterEnergyDay,
    GrowattPlant,
    GrowattPlantEnergyDay,
    GrowattPlantPower,
)
from solar_core.growatt import GrowattAPIError, GrowattClient

log = logging.getLogger("growatt_energy")

RATE_LIMIT_CODE = 10012
ENERGY_LOOKBACK_DAYS = 7  # plant/energy re-read window (finished days)
CURVE_DAYS = 2  # plant/power and day_energy: fill up to this many missing finished days per run
ENERGY_PAUSE_S = 1.0  # between calls of one account
MAX_RATE_LIMITED = 3
PLANT_ENERGY_CHUNK_DAYS = 31  # plant/energy days per call


class _RateLimited(Exception):
    pass


class _Caller:
    """Paced calls for one account; counts errors by Growatt code and ends the sweep after
    `max_rate_limited` 10012s in a row."""

    def __init__(self, pause_s: float, max_rate_limited: int):
        self.pause_s = pause_s
        self.max_rate_limited = max_rate_limited
        self.asked = 0
        self.in_a_row = 0
        self.errors: Dict[str, int] = {}

    def __call__(self, label: str, fn: Callable[[], Any]) -> Tuple[bool, Any]:
        """(ok, value). Raises _RateLimited when the account should stop."""
        if self.asked:
            time.sleep(self.pause_s)
        self.asked += 1
        try:
            value = fn()
        except GrowattAPIError as exc:
            key = str(exc.error_code) if exc.error_code is not None else "error"
            self.errors[key] = self.errors.get(key, 0) + 1
            if exc.error_code == RATE_LIMIT_CODE:
                self.in_a_row += 1
                if self.in_a_row >= self.max_rate_limited:
                    raise _RateLimited(label) from exc
            else:
                self.in_a_row = 0
            log.debug("%s failed: %s", label, exc)
            return False, None
        except Exception as exc:  # network etc.: skip this one
            self.in_a_row = 0
            self.errors["error"] = self.errors.get("error", 0) + 1
            log.warning("%s failed: %s", label, exc)
            return False, None
        self.in_a_row = 0
        return True, value


def _upsert(db: Session, model, rows: Sequence[Dict[str, Any]]) -> None:
    from app.services.growatt_sync import _upsert as upsert

    upsert(db, model, rows)


def _plants_query(phase: Optional[int], include_untagged: bool):
    q = select(GrowattPlant.plant_id).order_by(GrowattPlant.plant_id)
    if phase is None:
        return q
    cond = GrowattPlant.phase == phase
    if include_untagged:
        cond = or_(cond, GrowattPlant.phase.is_(None))
    return q.where(cond)


def _finished_days(today: date, n: int) -> List[date]:
    """The `n` days before `today`, oldest first."""
    return [today - timedelta(days=k) for k in range(n, 0, -1)]


def sync_growatt_energy(
    db: Session,
    client: GrowattClient,
    today: date,
    phase: Optional[int] = None,
    include_untagged: bool = False,
    lookback_days: int = ENERGY_LOOKBACK_DAYS,
    curve_days: int = CURVE_DAYS,
    pause_s: float = ENERGY_PAUSE_S,
    max_rate_limited: int = MAX_RATE_LIMITED,
) -> Dict[str, Any]:
    """One account's plants: `plant/energy` for the last `lookback_days` finished days, then
    `plant/power` and every inverter's `day_energy` for the last `curve_days` finished days not
    stored yet. `today` is plant-local; nothing on or after it is written."""
    now = datetime.now(timezone.utc)
    pids = [int(p) for p in db.scalars(_plants_query(phase, include_untagged))]
    out: Dict[str, Any] = {
        "plants": len(pids),
        "plant_energy_days": 0,
        "plant_power_days": 0,
        "plant_power_points": 0,
        "inverter_energy_days": 0,
        "failed": [],
    }
    if not pids:
        return out
    call = _Caller(pause_s, max_rate_limited)
    days = _finished_days(today, max(1, lookback_days))
    curve = _finished_days(today, max(0, curve_days))
    have_power: Set[Tuple[int, date]] = set()
    have_inv: Set[Tuple[str, date]] = set()
    if curve:
        lo = datetime.combine(curve[0], datetime.min.time())
        hi = datetime.combine(today, datetime.min.time())
        for pid, ts in db.execute(
            select(GrowattPlantPower.plant_id, func.min(GrowattPlantPower.timestamp))
            .where(GrowattPlantPower.plant_id.in_(pids), GrowattPlantPower.timestamp >= lo, GrowattPlantPower.timestamp < hi)
            .group_by(GrowattPlantPower.plant_id, func.date(GrowattPlantPower.timestamp))
        ).all():
            have_power.add((int(pid), ts.date()))
        have_inv = {
            (sn, d)
            for sn, d in db.execute(
                select(GrowattInverterEnergyDay.device_sn, GrowattInverterEnergyDay.day).where(
                    GrowattInverterEnergyDay.plant_id.in_(pids), GrowattInverterEnergyDay.day >= curve[0]
                )
            ).all()
        }
    invs: Dict[int, List[str]] = {}
    for sn, pid in db.execute(
        select(GrowattInverter.device_sn, GrowattInverter.plant_id)
        .where(GrowattInverter.plant_id.in_(pids))
        .order_by(GrowattInverter.plant_id, GrowattInverter.device_sn)
    ).all():
        invs.setdefault(int(pid), []).append(sn)

    try:
        for pid in pids:
            ok, rows = call(f"plant {pid} plant/energy", lambda: client.plant_energy_days(pid, days[0], days[-1]))
            if ok:
                keep = [
                    {"plant_id": pid, "day": d, "energy_kwh": kwh, "synced_at": now}
                    for d, kwh in rows
                    if days[0] <= d < today
                ]
                _upsert(db, GrowattPlantEnergyDay, keep)
                db.commit()
                out["plant_energy_days"] += len(keep)
            for d in curve:
                if (pid, d) not in have_power:
                    ok, pts = call(f"plant {pid} plant/power {d}", lambda: client.plant_power_day(pid, d))
                    if ok and pts:
                        lo = datetime.combine(d, datetime.min.time())
                        rows_p = [
                            {"plant_id": pid, "timestamp": ts, "power_w": w}
                            for ts, w in pts
                            if lo <= ts < lo + timedelta(days=1)
                        ]
                        _upsert(db, GrowattPlantPower, rows_p)
                        db.commit()
                        out["plant_power_days"] += 1
                        out["plant_power_points"] += len(rows_p)
                for sn in invs.get(pid, []):
                    if (sn, d) in have_inv:
                        continue
                    ok, kwh = call(f"inverter {sn} day_energy {d}", lambda: client.inverter_day_energy(sn, d))
                    if ok:
                        _upsert(
                            db,
                            GrowattInverterEnergyDay,
                            [{"device_sn": sn, "day": d, "plant_id": pid, "energy_kwh": kwh, "synced_at": now}],
                        )
                        db.commit()
                        out["inverter_energy_days"] += 1
    except _RateLimited as exc:
        log.warning("phase %s: rate limited %d times in a row at %s; the rest wait for the next run", phase, max_rate_limited, exc)
        out["failed"].append(f"phase {phase}: rate limited at {exc}")
    out["errors"] = call.errors
    out["calls"] = call.asked
    log.info(
        "phase %s Growatt energy: %d plant days, %d curves (%d points), %d inverter days, %d calls, errors %s",
        phase, out["plant_energy_days"], out["plant_power_days"], out["plant_power_points"],
        out["inverter_energy_days"], call.asked, call.errors,
    )
    return out


def backfill_plant_energy(
    db: Session,
    client: GrowattClient,
    today: date,
    days: int = 90,
    phase: Optional[int] = None,
    include_untagged: bool = False,
    pause_s: float = ENERGY_PAUSE_S,
    max_rate_limited: int = MAX_RATE_LIMITED,
) -> Dict[str, Any]:
    """`plant/energy` for the `days` finished days before `today`, PLANT_ENERGY_CHUNK_DAYS per call,
    for plants missing any of them."""
    now = datetime.now(timezone.utc)
    start = today - timedelta(days=days)
    pids = [int(p) for p in db.scalars(_plants_query(phase, include_untagged))]
    stored = dict(
        db.execute(
            select(GrowattPlantEnergyDay.plant_id, func.count())
            .where(GrowattPlantEnergyDay.plant_id.in_(pids), GrowattPlantEnergyDay.day >= start, GrowattPlantEnergyDay.day < today)
            .group_by(GrowattPlantEnergyDay.plant_id)
        ).all()
    ) if pids else {}
    out: Dict[str, Any] = {"plants": len(pids), "plant_energy_days": 0, "failed": []}
    call = _Caller(pause_s, max_rate_limited)
    try:
        for pid in pids:
            if int(stored.get(pid, 0)) >= days:
                continue
            lo = start
            while lo < today:
                hi = min(lo + timedelta(days=PLANT_ENERGY_CHUNK_DAYS - 1), today - timedelta(days=1))
                ok, rows = call(f"plant {pid} plant/energy {lo}..{hi}", lambda: client.plant_energy_days(pid, lo, hi))
                if ok:
                    keep = [{"plant_id": pid, "day": d, "energy_kwh": kwh, "synced_at": now} for d, kwh in rows if lo <= d <= hi]
                    _upsert(db, GrowattPlantEnergyDay, keep)
                    db.commit()
                    out["plant_energy_days"] += len(keep)
                lo = hi + timedelta(days=1)
    except _RateLimited as exc:
        log.warning("phase %s: plant/energy backfill rate limited at %s", phase, exc)
        out["failed"].append(f"phase {phase}: rate limited at {exc}")
    out["errors"] = call.errors
    out["calls"] = call.asked
    log.info("phase %s plant/energy backfill: %d days, %d calls, errors %s", phase, out["plant_energy_days"], call.asked, call.errors)
    return out


def prune_plant_power(db: Session, today: date, keep_days: int) -> int:
    """Delete Growatt plant-curve points older than `keep_days` before `today` (with the raw readings)."""
    cutoff = datetime.combine(today - timedelta(days=keep_days), datetime.min.time())
    res = db.execute(delete(GrowattPlantPower).where(GrowattPlantPower.timestamp < cutoff))
    db.commit()
    return int(getattr(res, "rowcount", 0) or 0)
