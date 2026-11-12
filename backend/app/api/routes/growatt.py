"""Growatt routes, split by data source.

- `/growatt/live/*`   realtime values straight from the Growatt cloud, cached in memory only
                      (`app.services.growatt_live`). Never written to the database.
- `/growatt/plants*`  persisted data only: the registry and max_data history (1–5 min) mirrored by
                      `app.services.growatt_sync`. No Growatt calls happen here.

Timestamps in the reading tables are plant-local (Thai) time. DB responses carry
`meta.source = "db"`; live responses carry `source = "live"`, `fetched_at` and `stale`.
"""

from __future__ import annotations

from datetime import date, datetime
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Query
from sqlalchemy import select
from sqlalchemy.orm import Session, sessionmaker

from app.auth import get_current_user, require_write_access
from app.db.models import SyncRun, User
from app.db.session import SessionLocal, get_db
from app.services import growatt_overview as ov
from app.services import jobs
from app.services.growatt_live import GrowattLiveService, LiveUnavailable, get_live_service

router = APIRouter(prefix="/growatt", tags=["Growatt OpenAPI & Plant Telemetry"])

DAY_QUERY = Query(None, description="Plant-local date (YYYY-MM-DD); default = latest day with data")


# --------------------------------------------------------------------------- live (memory only)


@router.get("/live/plants")
def live_plants(
    live: GrowattLiveService = Depends(get_live_service),
    _user: User = Depends(get_current_user),
) -> Dict[str, Any]:
    """Realtime plant power/status for the whole fleet. Not persisted."""
    try:
        return live.plants()
    except LiveUnavailable as exc:
        raise HTTPException(status_code=503, detail=f"Growatt live data unavailable: {exc}") from exc


@router.get("/live/plants/{plant_id}/inverters")
def live_inverters(
    plant_id: int,
    live: GrowattLiveService = Depends(get_live_service),
    _user: User = Depends(get_current_user),
) -> Dict[str, Any]:
    """Realtime inverter status for one plant. Not persisted."""
    try:
        return live.inverters(plant_id)
    except LiveUnavailable as exc:
        raise HTTPException(status_code=503, detail=f"Growatt live data unavailable: {exc}") from exc


@router.get("/live/plants/{plant_id}/latest")
def live_plant_latest(
    plant_id: int,
    db: Session = Depends(get_db),
    live: GrowattLiveService = Depends(get_live_service),
    _user: User = Depends(get_current_user),
) -> Dict[str, Any]:
    """Newest record per inverter (power, MPPT, per-string V/I) for one plant. Not persisted.

    The DB is read only for the plant's inverter list; nothing is written.
    """
    sns = [inv["device_sn"] for inv in ov.list_inverters(db, plant_id)]
    if not sns:
        raise HTTPException(status_code=404, detail=f"Plant {plant_id} has no inverters")
    try:
        return live.plant_latest(plant_id, sns, datetime.now(jobs.PLANT_TZ).date())
    except LiveUnavailable as exc:
        raise HTTPException(status_code=503, detail=f"Growatt live data unavailable: {exc}") from exc


# --------------------------------------------------------------------------- persisted (DB only)


@router.get("/plants")
def list_growatt_plants(
    db: Session = Depends(get_db),
    _user: User = Depends(get_current_user),
) -> List[Dict[str, Any]]:
    """Plant registry from the DB, with inverter counts and the latest synced day's energy.

    `current_power_w` / `status` are the last values written by the sync job (see `synced_at`);
    use `/growatt/live/plants` for realtime values.
    """
    return ov.list_plants_summary(db)


@router.get("/plants/{plant_id}/inverters")
def list_growatt_inverters(
    plant_id: int,
    db: Session = Depends(get_db),
    _user: User = Depends(get_current_user),
) -> List[Dict[str, Any]]:
    """Inverter registry for a plant from the DB (status = last synced value)."""
    return ov.list_inverters(db, plant_id)


@router.get("/plants/{plant_id}/overview")
def get_growatt_plant_overview(
    plant_id: int,
    day: Optional[date] = DAY_QUERY,
    db: Session = Depends(get_db),
    _user: User = Depends(get_current_user),
) -> Dict[str, Any]:
    """Single-plant overview for one day from persisted max_data history (nulls where not measured)."""
    try:
        return ov.build_plant_overview(db, plant_id, day)
    except ov.GrowattNotFound as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@router.get("/plants/{plant_id}/strings/{device_sn}/{string_no}")
def get_growatt_string_detail(
    plant_id: int,
    device_sn: str,
    string_no: int,
    day: Optional[date] = DAY_QUERY,
    db: Session = Depends(get_db),
    _user: User = Depends(get_current_user),
) -> Dict[str, Any]:
    """Stored telemetry for one string on one day, plus modelled I-V / P-V curves."""
    try:
        return ov.build_string_detail(db, plant_id, device_sn, string_no, day)
    except ov.GrowattNotFound as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


# --------------------------------------------------------------------------- background jobs


def get_session_factory() -> sessionmaker:
    """Session factory for background jobs (overridden in tests)."""
    return SessionLocal


@router.get("/sync/status")
def sync_status(
    limit: int = Query(20, ge=1, le=200),
    db: Session = Depends(get_db),
    _user: User = Depends(get_current_user),
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
    background: BackgroundTasks,
    db: Session = Depends(get_db),
    factory: sessionmaker = Depends(get_session_factory),
    _user: User = Depends(require_write_access),
) -> Dict[str, Any]:
    """Start a job now (history | backfill | fleet | publish_today | publish_yesterday)."""
    if job not in jobs.JOBS:
        raise HTTPException(status_code=404, detail=f"Unknown job {job!r}; choose one of {sorted(jobs.JOBS)}")
    try:
        run_id = jobs.claim(db, job, "api")
    except jobs.JobBusy as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    background.add_task(jobs.execute, factory, run_id)
    return {"run_id": run_id, "job": job, "status": "running"}
