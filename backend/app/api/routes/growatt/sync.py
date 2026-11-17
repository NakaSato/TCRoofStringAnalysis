"""Worker jobs: status, and queueing a run for the worker."""

from __future__ import annotations

from typing import Any, Dict

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.auth import require_admin
from app.db.models import SyncRun, User
from app.db.session import get_db
from app.services import jobs
from app.api.routes.growatt._common import audit

router = APIRouter()


# --------------------------------------------------------------------------- background jobs


@router.get("/sync/status")
def sync_status(
    limit: int = Query(20, ge=1, le=200),
    db: Session = Depends(get_db),
    _user: User = Depends(require_admin),
) -> Dict[str, Any]:
    """Latest run per job plus the most recent runs (worker, API and CLI)."""
    latest: Dict[str, Any] = {}
    for job in jobs.JOBS:
        run = db.scalars(select(SyncRun).where(SyncRun.job == job).order_by(SyncRun.started_at.desc()).limit(1)).first()
        latest[job] = jobs.run_out(run) if run else None
    recent = db.scalars(select(SyncRun).order_by(SyncRun.started_at.desc()).limit(limit))
    return {"jobs": latest, "recent": [jobs.run_out(r) for r in recent]}


@router.post("/sync/{job}", status_code=202)
def trigger_sync(
    job: str,
    db: Session = Depends(get_db),
    user: User = Depends(require_admin),
) -> Dict[str, Any]:
    """Queue a job for the worker (history | backfill | fleet | publish_today | publish_yesterday | retention).

    The API never runs jobs itself (Cloud Run would cut its CPU after the response); the worker
    starts queued runs within a minute. Poll `/growatt/sync/status` for the outcome.
    """
    if job not in jobs.JOBS:
        raise HTTPException(status_code=404, detail=f"Unknown job {job!r}; choose one of {sorted(jobs.JOBS)}")
    try:
        run_id = jobs.enqueue(db, job, "api")
    except jobs.JobBusy as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    audit.info("%s queued job %s (run %s)", user.username or user.email, job, run_id)
    return {"run_id": run_id, "job": job, "status": "queued"}
