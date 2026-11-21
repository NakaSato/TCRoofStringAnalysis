"""PWA daily meter report (DB only, docs/plans/pwa-meter-daily.md).

Data comes in through the CLI (`python -m app.services.pwa_meter import` / `report` / `expected`)
or the admin-only `POST /import` of the daily report workbooks (preview, then all or nothing).
Scoped like the Growatt routes: an engineer sees the report sites of assigned Growatt plants
(another site answers 404) and no fleet totals.
"""

from __future__ import annotations

import json
import logging
from datetime import date, datetime
from typing import Any, Dict, List, Optional
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, UploadFile
from sqlalchemy.orm import Session

from app.auth import allowed_plant_ids, get_current_user, require_admin
from app.db.models import User
from app.db.session import get_db
from app.services import pwa_meter as svc
from app.services.growatt_common import GrowattNotFound

router = APIRouter(prefix="/pwa/meter", tags=["PWA daily meter report"])
audit = logging.getLogger("app.audit")
PLANT_TZ = ZoneInfo("Asia/Bangkok")


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


@router.get("/daily")
def daily(
    start: Optional[date] = Query(None),
    end: Optional[date] = Query(None),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> Dict[str, Any]:
    """Per report day: phase energy, contract and specific yield (admins), and each visible site's yield and status."""
    _window(start, end)
    return svc.daily(db, allowed_plant_ids(db, user), start, end)


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


@router.get("/vs-growatt")
def vs_growatt(
    start: Optional[date] = Query(None),
    end: Optional[date] = Query(None),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> Dict[str, Any]:
    """Cewe meter vs Growatt's own day energy (`plant/energy`) per visible site and per day: both measured."""
    _window(start, end)
    return svc.meter_vs_growatt(db, allowed_plant_ids(db, user), start, end)


@router.get("/billing")
def billing(
    start: Optional[date] = Query(None),
    end: Optional[date] = Query(None),
    phase: Optional[int] = Query(None, ge=1, le=4),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> Dict[str, Any]:
    """Billed meter energy per site and calendar month (book price), the contract's energy (modelled)
    and the shortfall split into outage / under-performance / meter gap (recoverable) and curtailment."""
    _window(start, end)
    return svc.billing(db, allowed_plant_ids(db, user), start, end, phase)


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


@router.post("/import")
async def import_report(
    files: List[UploadFile] = File(..., description="daily report workbooks (.xlsx)"),
    commit: bool = Form(False),
    days: str = Form("{}", description='JSON {"file::sheet": "YYYY-MM-DD" | "skip"}'),
    db: Session = Depends(get_db),
    user: User = Depends(require_admin),
) -> Dict[str, Any]:
    """Daily report import (admin): a preview of what the workbooks hold and what would change;
    with `commit=true` and no problem left, the days are stored (all or nothing)."""
    try:
        overrides = json.loads(days or "{}")
        if not isinstance(overrides, dict):
            raise ValueError
    except ValueError as exc:
        raise HTTPException(status_code=422, detail="days must be a JSON object") from exc
    payload, total = [], 0
    for f in files:
        name = f.filename or "report.xlsx"
        if not name.lower().endswith((".xlsx", ".xlsm")):
            raise HTTPException(status_code=422, detail=f"{name}: only .xlsx workbooks")
        data = await f.read()
        total += len(data)
        if total > svc.REPORT_MAX_BYTES:
            raise HTTPException(status_code=413, detail=f"files over {svc.REPORT_MAX_BYTES // 2**20} MB in one import")
        payload.append((name, data))
    today = datetime.now(PLANT_TZ).date()
    out = svc.import_report(db, payload, today, {str(k): (None if v is None else str(v)) for k, v in overrides.items()}, commit=commit)
    if out["committed"]:
        t = out["totals"]
        audit.info("PWA meter report imported by %s: %d new, %d changed days (%s .. %s), %d file(s)",
                   user.username, t["new"], t["changed"], out["days"]["first"], out["days"]["last"], len(payload))
    return out
