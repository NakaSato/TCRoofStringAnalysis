"""System → Logs: read and prune `app_logs` (records written by `app.logging_db`).

Times: stored UTC; `since` / `until` given without a zone are Bangkok time. All filters are
SQLAlchemy expressions (SQLite and Postgres)."""

from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional, Sequence

from sqlalchemy import delete, func, select
from sqlalchemy.orm import Session

from app.config import settings
from app.db.models import AppLog
from app.services.jobs import PLANT_TZ, _aware

L = AppLog
LEVELS = ("DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL")
SOURCES = ("api", "worker", "cli")
DEFAULT_WINDOW = timedelta(hours=24)
Q_MAX = 200
PRUNE_BATCH = 5_000


def level_no(level: str) -> int:
    """`INFO` → 20; unknown names raise ValueError."""
    name = level.strip().upper()
    if name not in LEVELS:
        raise ValueError(f"Unknown level {level!r}; choose one of {', '.join(LEVELS)}")
    return logging.getLevelNamesMapping()[name]


def to_utc(ts: Optional[datetime]) -> Optional[datetime]:
    """Aware → UTC; naive = Bangkok (plant-local) time."""
    if ts is None:
        return None
    return (ts if ts.tzinfo else ts.replace(tzinfo=PLANT_TZ)).astimezone(timezone.utc)


def _iso(ts: Optional[datetime]) -> Optional[str]:
    t = _aware(ts)
    return t.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ") if t else None


def row_out(r: AppLog) -> Dict[str, Any]:
    return {
        "id": r.id,
        "ts": _iso(r.ts),
        "level": r.level,
        "source": r.source,
        "host": r.host,
        "logger": r.logger,
        "message": r.message,
        "exc_text": r.exc_text,
        "run_id": r.run_id,
        "job": r.job,
        "request_id": r.request_id,
        "extra": r.extra_json,
    }


def list_logs(
    db: Session,
    *,
    level: str = "INFO",
    sources: Optional[Sequence[str]] = None,
    logger: Optional[str] = None,
    job: Optional[str] = None,
    run_id: Optional[int] = None,
    q: Optional[str] = None,
    since: Optional[datetime] = None,
    until: Optional[datetime] = None,
    before_id: Optional[int] = None,
    after_id: Optional[int] = None,
    limit: int = 200,
    now: Optional[datetime] = None,
) -> Dict[str, Any]:
    """Newest first. `before_id` pages back; `after_id` returns only rows newer than it (polling).
    Without `since` the window is the last 24 h, unless a `run_id` is given (a whole run)."""
    now = now or datetime.now(timezone.utc)
    stmt = select(L).where(L.level_no >= level_no(level))
    if sources:
        bad = sorted(set(sources) - set(SOURCES))
        if bad:
            raise ValueError(f"Unknown source {bad[0]!r}; choose one of {', '.join(SOURCES)}")
        stmt = stmt.where(L.source.in_(list(sources)))
    if logger:
        stmt = stmt.where(L.logger.startswith(logger, autoescape=True))
    if job:
        stmt = stmt.where(L.job == job)
    if run_id is not None:
        stmt = stmt.where(L.run_id == run_id)
    if q:
        stmt = stmt.where(func.lower(L.message).contains(q[:Q_MAX].lower(), autoescape=True))
    since_utc = to_utc(since) or (None if run_id is not None else now - DEFAULT_WINDOW)
    if since_utc is not None:
        stmt = stmt.where(L.ts >= since_utc)
    if until is not None:
        stmt = stmt.where(L.ts < to_utc(until))
    if before_id is not None:
        stmt = stmt.where(L.id < before_id)
    if after_id is not None:
        stmt = stmt.where(L.id > after_id)
    limit = max(1, min(int(limit), 1000))
    rows = list(db.scalars(stmt.order_by(L.id.desc()).limit(limit)))
    return {
        "items": [row_out(r) for r in rows],
        # a full page may have older rows; a short one is the end of the window
        "next_before_id": rows[-1].id if len(rows) == limit else None,
        "meta": {
            "source": "db",
            "since": _iso(since_utc),
            "retention_days": settings.log_retention_days,
            "enabled": settings.log_db_enabled,
            "level": settings.log_db_level.upper(),
        },
    }


def summary(db: Session, since: Optional[datetime] = None, now: Optional[datetime] = None) -> Dict[str, Any]:
    """Counts per level and per source since `since` (default 24 h ago), plus the newest ERROR+."""
    now = now or datetime.now(timezone.utc)
    since_utc = to_utc(since) or now - DEFAULT_WINDOW
    by_level = {lvl: 0 for lvl in LEVELS}
    for lvl, n in db.execute(select(L.level, func.count()).where(L.ts >= since_utc).group_by(L.level)):
        by_level[lvl] = by_level.get(lvl, 0) + n
    by_source = {src: 0 for src in SOURCES}
    for src, n in db.execute(select(L.source, func.count()).where(L.ts >= since_utc).group_by(L.source)):
        by_source[src] = by_source.get(src, 0) + n
    last = db.scalars(
        select(L).where(L.ts >= since_utc, L.level_no >= logging.ERROR).order_by(L.id.desc()).limit(1)
    ).first()
    return {
        "since": _iso(since_utc),
        "total": sum(by_level.values()),
        "by_level": by_level,
        "by_source": by_source,
        "last_error": row_out(last) if last else None,
        "newest_id": db.scalar(select(func.max(L.id))),
        "enabled": settings.log_db_enabled,
    }


def prune_logs(db: Session, now: datetime, retention_days: int, max_rows: int) -> int:
    """Delete rows older than `retention_days`, then the oldest beyond `max_rows`. Batched by id
    so one statement never holds a huge lock. Returns rows deleted."""
    deleted = 0
    cutoff = now - timedelta(days=retention_days)
    while True:
        ids: List[int] = list(db.scalars(select(L.id).where(L.ts < cutoff).order_by(L.id).limit(PRUNE_BATCH)))
        if not ids:
            break
        db.execute(delete(L).where(L.id.in_(ids)))
        db.commit()
        deleted += len(ids)
    total = db.scalar(select(func.count()).select_from(L)) or 0
    if total > max_rows:
        # ids grow with time: everything below the (max_rows)-th newest id goes
        floor = db.scalar(select(L.id).order_by(L.id.desc()).offset(max_rows - 1).limit(1)) if max_rows > 0 else None
        while True:
            q = select(L.id).order_by(L.id).limit(PRUNE_BATCH)
            if floor is not None:
                q = q.where(L.id < floor)
            ids = list(db.scalars(q))
            if not ids:
                break
            db.execute(delete(L).where(L.id.in_(ids)))
            db.commit()
            deleted += len(ids)
    return deleted
