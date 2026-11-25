"""Site events: work done on a plant (DB only)."""

from __future__ import annotations

from datetime import date
from typing import Any, Dict, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from app.auth import allowed_plant_ids, get_current_user, require_plant_read, require_plant_write
from app.db.models import GrowattPlant, User
from app.db.session import get_db
from app.schemas.api_schemas import SiteEventCreate, SiteEventPatch
from app.services import growatt_overview as ov
from app.api.routes.growatt._common import audit

router = APIRouter()


# --------------------------------------------------------------------------- site events (DB only)

EVENT_TYPE_PATTERN = (
    "^(cleaning|repair|module_replaced|inverter_replaced|ir_flight|pm_inspection|inverter_service|site_visit|curtailment|other)$"
)


@router.get("/events")
def list_site_events(
    plant_id: Optional[int] = Query(None),
    type: Optional[str] = Query(None, pattern=EVENT_TYPE_PATTERN),
    since: Optional[date] = Query(None, description="Plant-local date: events covering this day or later"),
    until: Optional[date] = Query(None, description="Plant-local date: events starting on or before this day"),
    limit: int = Query(500, ge=1, le=5000),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> Dict[str, Any]:
    """Site events (cleanings, repairs, …) of every plant the user may see, newest first."""
    from app.services import site_events

    allowed = allowed_plant_ids(db, user)
    if plant_id is not None and allowed is not None and plant_id not in allowed:
        raise HTTPException(status_code=404, detail=f"Plant {plant_id} not found")
    out = site_events.list_events(
        db, allowed, plant_id=plant_id, event_type=type, since=since, until=until, limit=limit, allow_shadow=allowed is None
    )
    return {**out, "meta": {"source": "db"}}


@router.get("/plants/{plant_id}/events")
def list_plant_site_events(
    plant_id: int,
    type: Optional[str] = Query(None, pattern=EVENT_TYPE_PATTERN),
    sn: Optional[str] = Query(None, max_length=64),
    since: Optional[date] = Query(None),
    until: Optional[date] = Query(None),
    limit: int = Query(500, ge=1, le=5000),
    db: Session = Depends(get_db),
    user: User = Depends(require_plant_read),
) -> Dict[str, Any]:
    """One plant's site events, newest first."""
    from app.services import site_events

    out = site_events.list_events(
        db,
        None,
        plant_id=plant_id,
        event_type=type,
        device_sn=sn,
        since=since,
        until=until,
        limit=limit,
        allow_shadow=user.role == "admin",
    )
    return {"plant_id": plant_id, **out, "meta": {"source": "db"}}


@router.post("/plants/{plant_id}/events", status_code=201)
def create_plant_site_event(
    plant_id: int,
    payload: SiteEventCreate,
    db: Session = Depends(get_db),
    user: User = Depends(require_plant_write),
) -> Dict[str, Any]:
    """Record work done on the plant. With `issue_id` + `close_issue`, the issue is resolved as
    confirmed and its note names the event."""
    from app.services import site_events

    who = user.username or user.email
    admin = user.role == "admin"
    try:
        ev = site_events.create_event(db, plant_id, payload.model_dump(), who, allow_shadow=admin)
    except ov.GrowattNotFound as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    audit.info(
        "%s recorded site event #%s (%s %s) for plant %s%s",
        who, ev.id, ev.event_type, ev.day, plant_id, f", resolved issue {ev.issue_id}" if payload.close_issue else "",
    )
    return site_events.one(db, ev, admin)


@router.patch("/plants/{plant_id}/events/{event_id}")
def patch_plant_site_event(
    plant_id: int,
    event_id: int,
    payload: SiteEventPatch,
    db: Session = Depends(get_db),
    user: User = Depends(require_plant_write),
) -> Dict[str, Any]:
    """Change an event (only the fields sent)."""
    from app.services import site_events

    who = user.username or user.email
    admin = user.role == "admin"
    changes = payload.changes()
    try:
        ev = site_events.get_event(db, plant_id, event_id)
        site_events.update_event(db, ev, changes, who, allow_shadow=admin)
    except ov.GrowattNotFound as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    audit.info("%s changed site event #%s for plant %s (%s)", who, event_id, plant_id, ", ".join(sorted(changes)) or "nothing")
    return site_events.one(db, ev, admin)


@router.delete("/plants/{plant_id}/events/{event_id}", status_code=204)
def delete_plant_site_event(
    plant_id: int,
    event_id: int,
    db: Session = Depends(get_db),
    user: User = Depends(require_plant_write),
) -> None:
    """Delete an event: admins, or the engineer who recorded it."""
    from app.services import site_events

    who = user.username or user.email
    try:
        ev = site_events.get_event(db, plant_id, event_id)
    except ov.GrowattNotFound as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    if user.role != "admin" and ev.created_by != who:
        raise HTTPException(status_code=403, detail="Only an admin or the person who recorded it can delete this event")
    kind, day = ev.event_type, ev.day
    site_events.delete_event(db, ev)
    audit.info("%s deleted site event #%s (%s %s) for plant %s", who, event_id, kind, day, plant_id)


# --------------------------------------------------------------------------- soiling (DB only)


@router.get("/plants/{plant_id}/soiling")
def plant_soiling(
    plant_id: int,
    days: int = Query(60, ge=7, le=366, description="Days of daily EPI / rain to return, ending today"),
    db: Session = Depends(get_db),
    user: User = Depends(require_plant_read),
) -> Dict[str, Any]:
    """Cleaning steps (EPI before / after each recorded cleaning, soiling rate), the plant's
    latest R13 verdict (incomplete recovery after a heavy rain) and its R12 soiling wallet. EPI is
    modelled, rain is Google Weather (modelled, daytime only), steps, rates and the wallet are
    estimates; the cleaning cost is entered."""
    from app.services import growatt_rules, soiling

    if db.get(GrowattPlant, plant_id) is None:
        raise HTTPException(status_code=404, detail=f"Plant {plant_id} not found")
    cfg = growatt_rules.rule_settings(db)
    out = soiling.plant_soiling(db, plant_id, soiling.local_today(), days, cfg)
    r13_state, r12_state = cfg["rules"]["R13"], cfg["rules"]["R12"]
    if r13_state["shadow"] and user.role != "admin":
        out["r13"] = None  # engineers never see shadow findings
    if r12_state["shadow"] and user.role != "admin":
        out["wallet"] = None
    out["r13_rule"] = r13_state
    out["r12_rule"] = r12_state
    return {**out, "meta": {"source": "db"}}
