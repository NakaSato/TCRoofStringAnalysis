"""Devices page (docs/plans/devices-page.md): fleet device lists and computed device checks.

DB only (`meta.source = "db"`), filtered by `allowed_plant_ids`. Live state comes from the
existing `/growatt/live/*` sweeps; these routes never call Growatt and never write.
"""

from __future__ import annotations

from typing import Any, Dict

from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

from app.auth import allowed_plant_ids, get_current_user
from app.db.models import User
from app.db.session import get_db
from app.services import devices as svc

router = APIRouter()


@router.get("/devices/inverters")
def device_inverters(
    include_not_installed: bool = Query(False),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> Dict[str, Any]:
    """Every inverter the user may see, one row each (not installed ones only with the flag)."""
    return svc.list_inverters(db, allowed_plant_ids(db, user), include_not_installed=include_not_installed)


@router.get("/devices/meters")
def device_meters(db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> Dict[str, Any]:
    """Registered energy meters with stored freshness and today's stored import / export."""
    return svc.list_meters(db, allowed_plant_ids(db, user))


@router.get("/devices/dataloggers")
def device_dataloggers(db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> Dict[str, Any]:
    """Datalogger serials grouped from inverters, weather sensors and meters, with the site register's SN."""
    return svc.list_dataloggers(db, allowed_plant_ids(db, user))


@router.get("/devices/checks")
def device_checks(db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> Dict[str, Any]:
    """Device checks computed on request (never stored), each with its reason."""
    from app.services import device_checks as checks

    return checks.build(db, allowed_plant_ids(db, user), is_admin=user.role == "admin")
