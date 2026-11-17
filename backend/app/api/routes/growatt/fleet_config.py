"""Settings stored in SQL: the fleet module, a plant's string layout and the tariff."""

from __future__ import annotations

from typing import Any, Dict, List

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from app.auth import get_current_user, require_admin, require_plant_read, require_plant_write
from app.db.models import User
from app.db.session import get_db
from app.schemas.api_schemas import FleetModule, GrowattStringLayoutEntry, Tariff
from app.services import fleet_settings
from app.services import growatt_overview as ov
from app.api.routes.growatt._common import audit

router = APIRouter()


@router.get("/fleet-module")
def get_fleet_module(
    db: Session = Depends(get_db),
    _user: User = Depends(get_current_user),
) -> Dict[str, Any]:
    """PV module used across the fleet (global). `source = "default"` until someone saves it."""
    return fleet_settings.get_fleet_module(db)


@router.put("/fleet-module")
def put_fleet_module(
    payload: FleetModule,
    db: Session = Depends(get_db),
    user: User = Depends(require_admin),
) -> Dict[str, Any]:
    """Save the fleet module (admin only: it applies to every plant) to SQL, then publish `config/fleet_module` to the summary sink.

    A failed publish does not undo the save: the next publish job retries it.
    """
    from app.services import daily_summary  # firebase_admin is imported lazily by the sink

    saved = fleet_settings.put_fleet_module(db, payload.model_dump(), user.username or user.email)
    audit.info("%s saved the fleet module", user.username or user.email)
    return {**saved, "published": _publish_safely(db, lambda: daily_summary.publish_config(db))}


@router.get("/plants/{plant_id}/string-layout")
def get_growatt_string_layout(
    plant_id: int,
    db: Session = Depends(get_db),
    _user: User = Depends(require_plant_read),
) -> Dict[str, Any]:
    """As-built module count per string input (null = not entered), plus inputs seen in the last week."""
    try:
        return ov.get_string_layout(db, plant_id)
    except ov.GrowattNotFound as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@router.put("/plants/{plant_id}/string-layout")
def put_growatt_string_layout(
    plant_id: int,
    entries: List[GrowattStringLayoutEntry],
    db: Session = Depends(get_db),
    _user: User = Depends(require_plant_write),
) -> Dict[str, Any]:
    """Replace the plant's module-count registry; strings left out are cleared."""
    try:
        saved = ov.put_string_layout(db, plant_id, [e.model_dump() for e in entries])
    except ov.GrowattNotFound as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    from app.services import daily_summary

    return {**saved, "published": _publish_safely(db, lambda: daily_summary.publish_plant_inverters(db, plant_id))}


def _publish_safely(db: Session, fn: Any) -> Dict[str, Any]:
    """Mirror a just-saved registry change to the summary sink. A failure does not undo the
    save (the next publish job retries); it is reported instead."""
    try:
        rep = fn()
        return {"sink": rep.sink, "written": rep.written, "deferred": bool(rep.over_budget)}
    except Exception as exc:  # noqa: BLE001 — sink errors (credentials, network) are reported, not raised
        db.rollback()
        return {"sink": None, "written": 0, "error": str(exc)}


@router.get("/tariff")
def get_tariff(db: Session = Depends(get_db), _user: User = Depends(get_current_user)) -> Dict[str, Any]:
    """Electricity tariff (TOU + Ft, per-plant PPA rates). `source = "default"` until an admin saves it."""
    from app.services import tariff

    return tariff.get_tariff(db)


@router.put("/tariff")
def put_tariff(payload: Tariff, db: Session = Depends(get_db), user: User = Depends(require_admin)) -> Dict[str, Any]:
    """Save the tariff (admin), then publish `config/tariff`. Lost-energy baht use it from the
    next `rules_*` run; a changed on-peak window applies to past days after `rules_backfill`."""
    from app.services import daily_summary, tariff

    who = user.username or user.email
    old = tariff.get_tariff(db)
    saved = tariff.put_tariff(db, payload.model_dump(), who)
    for k in tariff.DEFAULT_TARIFF:
        if old.get(k) != saved.get(k):
            audit.info("%s changed tariff %s: %s -> %s", who, k, old.get(k), saved.get(k))
    return {**saved, "published": _publish_safely(db, lambda: daily_summary.publish_config(db))}
