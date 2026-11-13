"""System → Logs (admin only): the API's and worker's log records from SQL `app_logs`."""

from __future__ import annotations

from datetime import datetime
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from app.db.session import get_db
from app.services import system_logs

router = APIRouter(prefix="/system", tags=["System"])


@router.get("/logs")
def list_logs(
    level: str = Query("INFO", description="Minimum level: DEBUG | INFO | WARNING | ERROR | CRITICAL"),
    source: Optional[List[str]] = Query(None, description="api | worker | cli (repeatable)"),
    logger: Optional[str] = Query(None, description="Logger name prefix, e.g. app.services.growatt_sync"),
    job: Optional[str] = Query(None),
    run_id: Optional[int] = Query(None, description="One job run (sync_runs.id); no time window by default"),
    q: Optional[str] = Query(None, max_length=200, description="Case-insensitive text in the message"),
    since: Optional[datetime] = Query(None, description="ISO-8601; without a zone = Bangkok time. Default 24 h ago"),
    until: Optional[datetime] = Query(None),
    before_id: Optional[int] = Query(None, description="Page back: rows with id < before_id"),
    after_id: Optional[int] = Query(None, description="Polling: rows with id > after_id"),
    limit: int = Query(200, ge=1, le=1000),
    db: Session = Depends(get_db),
) -> Dict[str, Any]:
    """Stored log records, newest first, already redacted (no tokens, keys or passwords)."""
    try:
        return system_logs.list_logs(
            db, level=level, sources=source, logger=logger, job=job, run_id=run_id, q=q,
            since=since, until=until, before_id=before_id, after_id=after_id, limit=limit,
        )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@router.get("/logs/summary")
def logs_summary(
    since: Optional[datetime] = Query(None, description="Default 24 h ago; without a zone = Bangkok time"),
    db: Session = Depends(get_db),
) -> Dict[str, Any]:
    """Counts per level and source in the window, plus the newest ERROR+ record."""
    return system_logs.summary(db, since)
