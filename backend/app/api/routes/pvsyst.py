"""PVsyst design data of the PWA stations (DB only, read-only; services/pvsyst.py).

Data comes in with the CLI `python -m app.services.pvsyst import --model …`. Every figure is modelled
(PVsyst design). Scoped like the PWA meter routes: an engineer sees the stations joined to a report
site of an assigned plant and no phase summaries (they cover stations the engineer may not see).
"""

from __future__ import annotations

from datetime import date
from typing import Any, Dict, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from app.auth import allowed_plant_ids, get_current_user
from app.db.models import User
from app.db.session import get_db
from app.services import pvsyst as svc

router = APIRouter(prefix="/pvsyst", tags=["PVsyst design"])


@router.get("/design")
def design(db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> Dict[str, Any]:
    """Phase summaries (admins; `phases: []` for engineers) and the visible stations."""
    return svc.design(db, allowed_plant_ids(db, user))


@router.get("/vs-meter")
def vs_meter(
    start: Optional[date] = Query(None),
    end: Optional[date] = Query(None),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> Dict[str, Any]:
    """Per visible report site and month: metered kWh vs the station's PVsyst E_Grid on the same days."""
    if start and end and end < start:
        raise HTTPException(status_code=422, detail="end is before start")
    return svc.vs_meter(db, allowed_plant_ids(db, user), start, end)
