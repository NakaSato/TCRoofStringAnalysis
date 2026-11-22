"""TFRS 16 lease accounting of the PWA contract (DB only, read-only, admin only: finance data).

Data comes in only through the CLI `python -m app.services.tfrs16 import --model …`. Every figure is
the model's accounting, not measured (`labels`). Before an import the routes answer `imported: false`
with empty lists, never made-up values.
"""

from __future__ import annotations

from typing import Any, Dict

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.db.session import get_db
from app.services import tfrs16 as svc

router = APIRouter(prefix="/tfrs16", tags=["TFRS 16 lease model"])


@router.get("/summary")
def get_summary(db: Session = Depends(get_db)) -> Dict[str, Any]:
    """Phase parameters and minimum fees, remeasurements, revenue profile of contract year 1, rollout funnel."""
    return svc.summary(db)


@router.get("/schedule")
def get_schedule(db: Session = Depends(get_db)) -> Dict[str, Any]:
    """Each phase's monthly lease-liability schedule, all-phase month totals and fiscal-year totals."""
    return svc.schedule(db)


@router.get("/rollout")
def get_rollout(db: Session = Depends(get_db)) -> Dict[str, Any]:
    """The phase 3-4 station list (interconnection status, fee paid, First Sync)."""
    return svc.rollout(db)
