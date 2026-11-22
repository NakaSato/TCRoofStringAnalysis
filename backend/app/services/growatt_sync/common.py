"""Shared by the sync modules: upsert, retry, and the inverter query."""

from __future__ import annotations

import logging
import time
from datetime import date, timedelta
from typing import Any, Callable, Dict, Iterable, Optional, Sequence, TypeVar

from sqlalchemy import or_, select
from sqlalchemy.orm import Session

from app.db.models import GrowattInverter, GrowattPlant, inverter_installed
from solar_core.growatt import GrowattAPIError

RATE_LIMIT_CODE = 10012


log = logging.getLogger("growatt_sync")


_BATCH = 2000


def _upsert(db: Session, model, rows: Sequence[Dict[str, Any]], update_cols: Optional[Iterable[str]] = None) -> None:
    """Dialect-aware INSERT .. ON CONFLICT on the model's primary key (SQLite / PostgreSQL)."""
    if not rows:
        return
    dialect = db.get_bind().dialect.name
    if dialect == "postgresql":
        from sqlalchemy.dialects.postgresql import insert
    else:
        from sqlalchemy.dialects.sqlite import insert
    pk = [c.name for c in model.__table__.primary_key.columns]
    for i in range(0, len(rows), _BATCH):
        stmt = insert(model).values(list(rows[i : i + _BATCH]))
        cols = list(update_cols) if update_cols is not None else [c for c in rows[0] if c not in pk]
        if cols:
            stmt = stmt.on_conflict_do_update(index_elements=pk, set_={c: stmt.excluded[c] for c in cols})
        else:
            stmt = stmt.on_conflict_do_nothing(index_elements=pk)
        db.execute(stmt)


def _fnum(v: Any) -> Optional[float]:
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


T = TypeVar("T")


def _retry(fn: Callable[[], T], label: str, retries: int = 3) -> T:
    """Call `fn()`, retrying Growatt errors; 10012 (per-endpoint rate limit) waits minutes."""
    attempt = 0
    while True:
        try:
            return fn()
        except GrowattAPIError as exc:
            if attempt >= retries:
                raise
            # 10012's window is minutes, so short retries just fail again
            wait = min(60 * (attempt + 1), 120) if exc.error_code == RATE_LIMIT_CODE else 5 * (attempt + 1)
            log.warning("%s: %s — retry in %ss", label, exc, wait)
            time.sleep(wait)
            attempt += 1


# Consecutive 10012 answers that end a sweep with `max_rate_limited` (the `env_history` job): the
# rest wait for the next run, which starts with the sensors stored longest ago.
MAX_RATE_LIMITED = 3


def _inverters_query(phase: Optional[int], include_untagged: bool):
    """Installed inverters ordered by plant; restricted to one phase's plants when `phase` is given.

    `include_untagged` also takes plants with no phase yet (they default to the first account).
    Inverters marked not installed are never synced (no Growatt calls for them).
    """
    q = select(GrowattInverter).where(inverter_installed()).order_by(GrowattInverter.plant_id, GrowattInverter.device_sn)
    if phase is None:
        return q
    cond = GrowattPlant.phase == phase
    if include_untagged:
        cond = or_(cond, GrowattPlant.phase.is_(None))
    return q.join(GrowattPlant, GrowattPlant.plant_id == GrowattInverter.plant_id).where(cond)


def _date_chunks(start: date, end: date, days: int = 7) -> Iterable[tuple[date, date]]:
    cur = start
    while cur <= end:
        stop = min(cur + timedelta(days=days - 1), end)
        yield cur, stop
        cur = stop + timedelta(days=1)
