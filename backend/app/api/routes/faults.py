"""Field faults: the defect register (DB only, docs/plans/defects.md).

Scoped like the Growatt routes: an engineer sees and works on faults of assigned plants only (a
fault on another plant answers 404, ids are not revealed). Admins see everything. Everyone who may
see the plant creates, edits, moves, decides, links, notes and reopens; nothing is deleted (a wrong
fault is cancelled). Every write is logged to `app.audit`.
"""

from __future__ import annotations

from typing import Any, Dict, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Response
from sqlalchemy.orm import Session

from app.auth import allowed_plant_ids, require_write_access
from app.db.models import User
from app.db.session import get_db
from app.schemas.api_schemas import FaultCreate, FaultDecision, FaultLinkBody, FaultNote, FaultPatch, FaultStatusChange
from app.services import faults as svc
from app.services.growatt_common import GrowattNotFound
from app.api.routes.growatt._common import audit

router = APIRouter(prefix="/faults", tags=["Field faults"])

_STATUS_LIST = "^[a-z_]+(,[a-z_]+)*$"


def _who(user: User) -> str:
    return user.username or user.email


def _admin(user: User) -> bool:
    return user.role == "admin"


def _errors(exc: Exception) -> HTTPException:
    if isinstance(exc, GrowattNotFound):
        return HTTPException(status_code=404, detail=str(exc))
    if isinstance(exc, svc.FaultConflict):
        extra = exc.extra
        return HTTPException(status_code=409, detail={"message": str(exc), **extra} if extra else str(exc))
    return HTTPException(status_code=422, detail=str(exc))


_HANDLED = (GrowattNotFound, svc.FaultConflict, ValueError)


def _fault(db: Session, user: User, fault_id: int):
    try:
        return svc.get_fault(db, fault_id, allowed_plant_ids(db, user))
    except GrowattNotFound as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@router.get("")
def list_faults(
    tab: str = Query("open", pattern="^(open|restored|closed|all)$"),
    status: Optional[str] = Query(None, pattern=_STATUS_LIST, description="One status or a comma-separated list (overrides tab)"),
    kind: Optional[str] = Query(None, pattern="^(" + "|".join(svc.KINDS) + ")$"),
    severity: Optional[str] = Query(None, pattern="^S[1-4]$"),
    plant_id: Optional[int] = Query(None),
    waiting: Optional[str] = Query(None, pattern="^(us|them)$"),
    overdue: bool = Query(False, description="follow-up date past"),
    q: Optional[str] = Query(None, max_length=200),
    limit: int = Query(50, ge=1, le=500),
    offset: int = Query(0, ge=0),
    db: Session = Depends(get_db),
    user: User = Depends(require_write_access),
) -> Dict[str, Any]:
    """Faults of every plant the user may see, newest found first, with the summary counts."""
    allowed = allowed_plant_ids(db, user)
    if plant_id is not None and allowed is not None and plant_id not in allowed:
        raise HTTPException(status_code=404, detail=f"Plant {plant_id} not found")
    return svc.list_faults(
        db,
        allowed,
        allow_shadow=_admin(user),
        tab=tab,
        status=status.split(",") if status else None,
        kind=kind,
        severity=severity,
        plant_id=plant_id,
        waiting=waiting,
        overdue=overdue,
        q=q,
        limit=limit,
        offset=offset,
    )


@router.get("/open-on-device")
def open_on_device(
    inverter_sn: Optional[str] = Query(None, max_length=64),
    site_device_id: Optional[int] = Query(None),
    serial: Optional[str] = Query(None, max_length=64),
    db: Session = Depends(get_db),
    user: User = Depends(require_write_access),
) -> Dict[str, Any]:
    """Active faults on a device, for the create dialogs' duplicate check."""
    try:
        rows = svc.open_on_device(db, allowed_plant_ids(db, user), inverter_sn=inverter_sn, site_device_id=site_device_id, serial=serial, allow_shadow=_admin(user))
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return {"faults": rows}


@router.get("/{fault_id}")
def get_fault(fault_id: int, db: Session = Depends(get_db), user: User = Depends(require_write_access)) -> Dict[str, Any]:
    """One fault with its links (labels resolved) and timeline."""
    return svc.detail(db, _fault(db, user, fault_id), allow_shadow=_admin(user))


@router.post("", status_code=201)
def create_fault(payload: FaultCreate, db: Session = Depends(get_db), user: User = Depends(require_write_access)) -> Dict[str, Any]:
    """A new fault on a plant the user may work on. 409 `{message, fault_id, no}` when the device
    already has an active fault of that kind, unless `allow_duplicate`."""
    allowed = allowed_plant_ids(db, user)
    if allowed is not None and payload.plant_id not in allowed:
        raise HTTPException(status_code=404, detail=f"Plant {payload.plant_id} not found")
    body = payload.model_dump()
    try:
        f = svc.create_fault(db, body, _who(user), allow_shadow=_admin(user))
    except _HANDLED as exc:
        raise _errors(exc) from exc
    audit.info("%s recorded fault %s (%s %s) on plant %s", _who(user), f.no, f.severity, f.kind, f.plant_id)
    return svc.detail(db, f, allow_shadow=_admin(user))


@router.patch("/{fault_id}")
def update_fault(fault_id: int, payload: FaultPatch, db: Session = Depends(get_db), user: User = Depends(require_write_access)) -> Dict[str, Any]:
    f = _fault(db, user, fault_id)
    try:
        changed = svc.update_fault(db, f, payload.model_dump(exclude_unset=True), _who(user))
    except _HANDLED as exc:
        raise _errors(exc) from exc
    if changed:
        audit.info("%s edited fault %s (%s)", _who(user), f.no, ", ".join(changed))
    return svc.detail(db, f, allow_shadow=_admin(user))


@router.post("/{fault_id}/status")
def set_status(fault_id: int, payload: FaultStatusChange, db: Session = Depends(get_db), user: User = Depends(require_write_access)) -> Dict[str, Any]:
    f = _fault(db, user, fault_id)
    frm = f.status
    try:
        svc.set_status(db, f, payload.model_dump(), _who(user))
    except _HANDLED as exc:
        raise _errors(exc) from exc
    audit.info("%s moved fault %s %s → %s", _who(user), f.no, frm, f.status)
    return svc.detail(db, f, allow_shadow=_admin(user))


@router.post("/{fault_id}/decision")
def set_decision(fault_id: int, payload: FaultDecision, db: Session = Depends(get_db), user: User = Depends(require_write_access)) -> Dict[str, Any]:
    f = _fault(db, user, fault_id)
    try:
        svc.set_decision(db, f, payload.model_dump(), _who(user))
    except _HANDLED as exc:
        raise _errors(exc) from exc
    audit.info("%s decided %s on fault %s", _who(user), f.decision, f.no)
    return svc.detail(db, f, allow_shadow=_admin(user))


@router.post("/{fault_id}/notes", status_code=201)
def add_note(fault_id: int, payload: FaultNote, db: Session = Depends(get_db), user: User = Depends(require_write_access)) -> Dict[str, Any]:
    f = _fault(db, user, fault_id)
    try:
        svc.add_note(db, f, payload.text, _who(user))
    except _HANDLED as exc:
        raise _errors(exc) from exc
    return svc.detail(db, f, allow_shadow=_admin(user))


@router.post("/{fault_id}/links", status_code=201)
def add_link(fault_id: int, payload: FaultLinkBody, db: Session = Depends(get_db), user: User = Depends(require_write_access)) -> Dict[str, Any]:
    f = _fault(db, user, fault_id)
    try:
        link = svc.add_link(db, f, payload.model_dump(), _who(user), allow_shadow=_admin(user))
    except _HANDLED as exc:
        raise _errors(exc) from exc
    audit.info("%s linked %s to fault %s", _who(user), link.kind, f.no)
    return svc.detail(db, f, allow_shadow=_admin(user))


@router.delete("/{fault_id}/links/{link_id}", status_code=204)
def delete_link(fault_id: int, link_id: int, db: Session = Depends(get_db), user: User = Depends(require_write_access)) -> Response:
    f = _fault(db, user, fault_id)
    try:
        svc.delete_link(db, f, link_id, _who(user), allow_shadow=_admin(user))
    except _HANDLED as exc:
        raise _errors(exc) from exc
    audit.info("%s unlinked link %s from fault %s", _who(user), link_id, f.no)
    return Response(status_code=204)
