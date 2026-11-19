"""Calendar Team: planned O&M tasks and crews (DB only, docs/plans/calendar-team.md)."""

from __future__ import annotations

from datetime import date
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from app.auth import allowed_plant_ids, get_current_user, require_admin, require_plant_read, require_plant_write
from app.db.models import User
from app.db.session import get_db
from app.schemas.api_schemas import OmTaskCreate, OmTaskDone, OmTaskPatch, OmTeamBody, OmTeamPatch
from app.services import om_calendar as cal
from app.services.growatt_common import GrowattNotFound
from app.api.routes.growatt._common import audit

router = APIRouter()

TASK_TYPE_PATTERN = (
    "^(cleaning|repair|module_replaced|inverter_replaced|ir_flight|pm_inspection|inverter_service|site_visit|other)$"
)
STATUS_PATTERN = "^(planned|in_progress|done|skipped|cancelled)$"


def _errors(exc: Exception) -> HTTPException:
    if isinstance(exc, GrowattNotFound):
        return HTTPException(status_code=404, detail=str(exc))
    if isinstance(exc, cal.TaskConflict):
        return HTTPException(status_code=409, detail=str(exc))
    if isinstance(exc, cal.TaskForbidden):
        return HTTPException(status_code=403, detail=str(exc))
    return HTTPException(status_code=422, detail=str(exc))


_HANDLED = (GrowattNotFound, cal.TaskConflict, cal.TaskForbidden, ValueError)


# --------------------------------------------------------------------------- tasks


@router.get("/calendar/tasks")
def list_calendar_tasks(
    from_: date = Query(..., alias="from", description="Plant-local first day"),
    to: date = Query(..., description="Plant-local last day (at most 100 days after from)"),
    plant_id: Optional[int] = Query(None),
    type: Optional[str] = Query(None, pattern=TASK_TYPE_PATTERN),
    status: Optional[str] = Query(None, pattern=STATUS_PATTERN),
    user_id: Optional[int] = Query(None),
    team_id: Optional[int] = Query(None),
    overdue: bool = Query(False),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> Dict[str, Any]:
    """Tasks overlapping the range on every plant the user may see. For an engineer, `busy` holds
    masked blocks (dates + assignees only) for visible users' work on plants they can't see."""
    allowed = allowed_plant_ids(db, user)
    if plant_id is not None and allowed is not None and plant_id not in allowed:
        raise HTTPException(status_code=404, detail=f"Plant {plant_id} not found")
    try:
        out = cal.list_tasks(
            db, user, allowed, from_, to,
            plant_id=plant_id, task_type=type, status=status, user_id=user_id, team_id=team_id, overdue=overdue,
        )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return {**out, "meta": {"source": "db"}}


@router.get("/calendar/assignees")
def list_calendar_assignees(
    plant_id: Optional[int] = Query(None),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> Dict[str, Any]:
    """With `plant_id`: who the caller may assign on that plant. Without: whose lanes they may see. Plus active teams."""
    allowed = allowed_plant_ids(db, user)
    if plant_id is not None and allowed is not None and plant_id not in allowed:
        raise HTTPException(status_code=404, detail=f"Plant {plant_id} not found")
    return cal.list_assignees(db, user, plant_id)


@router.post("/plants/{plant_id}/tasks", status_code=201)
def create_plant_task(
    plant_id: int,
    payload: OmTaskCreate,
    db: Session = Depends(get_db),
    user: User = Depends(require_plant_write),
) -> Dict[str, Any]:
    """Plan a task on the plant (status planned)."""
    try:
        t = cal.create_task(db, user, plant_id, payload.model_dump())
    except _HANDLED as exc:
        raise _errors(exc) from exc
    audit.info("%s planned task #%s (%s %s…%s) for plant %s", cal._who(user), t.id, t.task_type, t.start_day, t.end_day, plant_id)
    return cal.one(db, t, user.role == "admin")


@router.get("/plants/{plant_id}/tasks/{task_id}")
def get_plant_task(
    plant_id: int,
    task_id: int,
    db: Session = Depends(get_db),
    user: User = Depends(require_plant_read),
) -> Dict[str, Any]:
    """One task with its change history (newest first)."""
    try:
        t = cal.get_task(db, plant_id, task_id)
    except GrowattNotFound as exc:
        raise _errors(exc) from exc
    return {**cal.one(db, t, user.role == "admin", history=True), "can_delete": cal.can_delete(user, t)}


@router.patch("/plants/{plant_id}/tasks/{task_id}")
def patch_plant_task(
    plant_id: int,
    task_id: int,
    payload: OmTaskPatch,
    db: Session = Depends(get_db),
    user: User = Depends(require_plant_write),
) -> Dict[str, Any]:
    """Move, reassign, change status (planned / in_progress / skipped / cancelled) or edit a task."""
    changes = payload.changes()
    try:
        t = cal.get_task(db, plant_id, task_id)
        cal.update_task(db, user, t, changes, payload.comment)
    except _HANDLED as exc:
        raise _errors(exc) from exc
    audit.info("%s changed task #%s for plant %s (%s)", cal._who(user), task_id, plant_id, ", ".join(sorted(changes)) or "comment")
    return cal.one(db, t, user.role == "admin")


@router.post("/plants/{plant_id}/tasks/{task_id}/done")
def finish_plant_task(
    plant_id: int,
    task_id: int,
    payload: OmTaskDone,
    db: Session = Depends(get_db),
    user: User = Depends(require_plant_write),
) -> Dict[str, Any]:
    """Mark the task done: writes its Site log event (same type; dates default to the planned
    ones, capped at today) and links it. With `close_issue`, the linked issue is resolved."""
    try:
        t = cal.get_task(db, plant_id, task_id)
        cal.mark_done(db, user, t, payload.model_dump())
    except _HANDLED as exc:
        raise _errors(exc) from exc
    audit.info("%s finished task #%s for plant %s (site event #%s)", cal._who(user), task_id, plant_id, t.site_event_id)
    return cal.one(db, t, user.role == "admin")


@router.delete("/plants/{plant_id}/tasks/{task_id}", status_code=204)
def delete_plant_task(
    plant_id: int,
    task_id: int,
    db: Session = Depends(get_db),
    user: User = Depends(require_plant_write),
) -> None:
    """Delete a task: admins, or the engineer who planned it while it is still planned."""
    try:
        t = cal.get_task(db, plant_id, task_id)
        kind, start = t.task_type, t.start_day
        cal.delete_task(db, user, t)
    except _HANDLED as exc:
        raise _errors(exc) from exc
    audit.info("%s deleted task #%s (%s %s) for plant %s", cal._who(user), task_id, kind, start, plant_id)


# --------------------------------------------------------------------------- teams


@router.get("/calendar/teams")
def list_calendar_teams(
    include_inactive: bool = Query(False),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> List[Dict[str, Any]]:
    """Crews (in-house or contractor). Inactive ones only for admins."""
    return cal.list_teams(db, include_inactive=include_inactive and user.role == "admin")


@router.post("/calendar/teams", status_code=201)
def create_calendar_team(
    payload: OmTeamBody,
    db: Session = Depends(get_db),
    user: User = Depends(require_admin),
) -> Dict[str, Any]:
    try:
        out = cal.create_team(db, payload.model_dump())
    except _HANDLED as exc:
        raise _errors(exc) from exc
    audit.info("%s created team #%s %r", cal._who(user), out["id"], out["name"])
    return out


@router.patch("/calendar/teams/{team_id}")
def patch_calendar_team(
    team_id: int,
    payload: OmTeamPatch,
    db: Session = Depends(get_db),
    user: User = Depends(require_admin),
) -> Dict[str, Any]:
    try:
        out = cal.update_team(db, team_id, payload.model_dump(exclude_unset=True))
    except _HANDLED as exc:
        raise _errors(exc) from exc
    audit.info("%s changed team #%s", cal._who(user), team_id)
    return out


@router.delete("/calendar/teams/{team_id}", status_code=204)
def delete_calendar_team(
    team_id: int,
    db: Session = Depends(get_db),
    user: User = Depends(require_admin),
) -> None:
    try:
        cal.delete_team(db, team_id)
    except _HANDLED as exc:
        raise _errors(exc) from exc
    audit.info("%s deleted team #%s", cal._who(user), team_id)
