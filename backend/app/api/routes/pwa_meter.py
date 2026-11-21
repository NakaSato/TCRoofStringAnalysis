"""PWA daily meter report (DB only, docs/plans/pwa-meter-daily.md).

Read-only: data comes in through the CLI import (`python -m app.services.pwa_meter import`).
Scoped like the Growatt routes: an engineer sees the report sites of assigned Growatt plants
(another site answers 404) and no fleet totals.
"""

from __future__ import annotations

from datetime import date
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from app.auth import allowed_plant_ids, get_current_user
from app.db.models import User
from app.db.session import get_db
from app.services import pwa_meter as svc
from app.services.growatt_common import GrowattNotFound

router = APIRouter(prefix="/pwa/meter", tags=["PWA daily meter report"])


def _window(start: Optional[date], end: Optional[date]) -> None:
    if start and end and end < start:
        raise HTTPException(status_code=422, detail="end is before start")


@router.get("/criteria")
def get_criteria() -> Dict[str, Any]:
    """Every threshold and formula the summaries use (pwa_meter_criteria.json)."""
    return svc.criteria()


@router.get("/sites")
def list_sites(db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> List[Dict[str, Any]]:
    return svc.list_sites(db, allowed_plant_ids(db, user))


@router.get("/sites/{site_id}/days")
def site_days(
    site_id: str,
    start: Optional[date] = Query(None),
    end: Optional[date] = Query(None),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> Dict[str, Any]:
    _window(start, end)
    try:
        return svc.site_days(db, allowed_plant_ids(db, user), site_id, start, end)
    except GrowattNotFound as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@router.get("/summary")
def summary(
    start: Optional[date] = Query(None),
    end: Optional[date] = Query(None),
    phase: Optional[int] = Query(None, ge=1, le=4),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> Dict[str, Any]:
    _window(start, end)
    return svc.summary(db, allowed_plant_ids(db, user), start, end, phase)


@router.get("/outages")
def outages(
    start: Optional[date] = Query(None),
    end: Optional[date] = Query(None),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> List[Dict[str, Any]]:
    _window(start, end)
    return svc.outage_events(db, allowed_plant_ids(db, user), start, end)


@router.get("/meter-check")
def meter_check(
    start: Optional[date] = Query(None),
    end: Optional[date] = Query(None),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> List[Dict[str, Any]]:
    _window(start, end)
    return svc.meter_check(db, allowed_plant_ids(db, user), start, end)


@router.get("/plants/{plant_id}")
def plant_days(
    plant_id: int,
    start: Optional[date] = Query(None),
    end: Optional[date] = Query(None),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> Dict[str, Any]:
    """The plant's report days (default: the last 60) with Growatt's own day energy beside the meter."""
    _window(start, end)
    try:
        return svc.plant_days(db, allowed_plant_ids(db, user), plant_id, start, end)
    except GrowattNotFound as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
