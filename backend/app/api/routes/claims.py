"""Claims: warranty and insurance claims for plant equipment (DB only, docs/plans/claims.md).

Scoped like the Growatt routes: an engineer sees and works on claims of assigned plants only (a
claim on another plant answers 404). Engineers create, edit, add evidence, links and timeline
entries; status changes and deleting a draft are admin only.
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from app.auth import allowed_plant_ids, require_admin, require_write_access
from app.db.models import User
from app.db.session import get_db
from app.schemas.api_schemas import ClaimCreate, ClaimEventCreate, ClaimEvidenceSet, ClaimLinkBody, ClaimPatch, ClaimStatusChange
from app.services import claims as svc
from app.services.growatt_common import GrowattNotFound
from app.api.routes.growatt._common import audit

router = APIRouter(prefix="/claims", tags=["Claims"])

_STATUS_LIST = "^[a-z_]+(,[a-z_]+)*$"


def _who(user: User) -> str:
    return user.username or user.email


def _claim(db: Session, user: User, claim_id: int):
    try:
        return svc.get_claim(db, claim_id, allowed_plant_ids(db, user))
    except GrowattNotFound as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


def _ensure_plant(db: Session, user: User, plant_id: int) -> None:
    allowed = allowed_plant_ids(db, user)
    if allowed is not None and plant_id not in allowed:
        raise HTTPException(status_code=404, detail=f"Plant {plant_id} not found")


def _errors(exc: Exception) -> HTTPException:
    if isinstance(exc, GrowattNotFound):
        return HTTPException(status_code=404, detail=str(exc))
    if isinstance(exc, svc.ClaimConflict):
        return HTTPException(status_code=409, detail=str(exc))
    return HTTPException(status_code=422, detail=str(exc))


_HANDLED = (GrowattNotFound, svc.ClaimConflict, ValueError)


@router.get("")
def list_claims(
    status: Optional[str] = Query(None, pattern=_STATUS_LIST, description="One status or a comma-separated list"),
    type: Optional[str] = Query(None, pattern="^(" + "|".join(svc.CLAIM_TYPES) + ")$"),
    plant_id: Optional[int] = Query(None),
    db: Session = Depends(get_db),
    user: User = Depends(require_write_access),
) -> Dict[str, Any]:
    """Claims of every plant the user may see, newest first, with the summary counts."""
    allowed = allowed_plant_ids(db, user)
    if plant_id is not None and allowed is not None and plant_id not in allowed:
        raise HTTPException(status_code=404, detail=f"Plant {plant_id} not found")
    return svc.list_claims(db, allowed, status=status.split(",") if status else None, claim_type=type, plant_id=plant_id)


@router.get("/{claim_id}")
def get_claim(claim_id: int, db: Session = Depends(get_db), user: User = Depends(require_write_access)) -> Dict[str, Any]:
    """One claim with its timeline, evidence checklist and linked records."""
    c = _claim(db, user, claim_id)
    return svc.detail(db, c, allow_shadow=user.role == "admin")


@router.post("", status_code=201)
def create_claim(payload: ClaimCreate, db: Session = Depends(get_db), user: User = Depends(require_write_access)) -> Dict[str, Any]:
    """A new claim (draft) on a plant the user may work on."""
    _ensure_plant(db, user, payload.plant_id)
    fields = payload.changes()
    links: List[Dict[str, Any]] = fields.pop("links", [])
    try:
        c = svc.create_claim(db, fields, links, _who(user), allow_shadow=user.role == "admin")
    except _HANDLED as exc:
        raise _errors(exc) from exc
    audit.info("%s opened claim %s (%s) for plant %s", _who(user), c.number, c.claim_type, c.plant_id)
    return svc.one(db, c)


@router.patch("/{claim_id}")
def patch_claim(
    claim_id: int, payload: ClaimPatch, db: Session = Depends(get_db), user: User = Depends(require_write_access)
) -> Dict[str, Any]:
    """Change the fields sent. Closed / withdrawn claims: admins only (409)."""
    c = _claim(db, user, claim_id)
    changes = payload.changes()
    if changes.get("plant_id") is not None:
        _ensure_plant(db, user, changes["plant_id"])
    try:
        changed = svc.update_claim(db, c, changes, _who(user), admin=user.role == "admin")
    except _HANDLED as exc:
        raise _errors(exc) from exc
    if changed:
        audit.info("%s changed claim %s (%s)", _who(user), c.number, ", ".join(changed))
    return svc.one(db, c)


@router.delete("/{claim_id}", status_code=204)
def delete_claim(claim_id: int, db: Session = Depends(get_db), user: User = Depends(require_admin)) -> None:
    """Delete a draft (admin). A claim that went out is withdrawn instead (409)."""
    c = _claim(db, user, claim_id)
    number = c.number
    try:
        svc.delete_claim(db, c)
    except _HANDLED as exc:
        raise _errors(exc) from exc
    audit.info("%s deleted claim %s", _who(user), number)


@router.post("/{claim_id}/status")
def set_claim_status(
    claim_id: int, payload: ClaimStatusChange, db: Session = Depends(get_db), user: User = Depends(require_admin)
) -> Dict[str, Any]:
    """Move the claim along the workflow (admin); 409 for a change the workflow does not allow."""
    c = _claim(db, user, claim_id)
    frm = c.status
    kw: Dict[str, Any] = {"new_sn": payload.new_sn, "new_sn_input": payload.new_sn_input.model_dump() if payload.new_sn_input else None}
    if "next_action_day" in payload.model_fields_set:
        kw["next_action_day"] = payload.next_action_day
    try:
        svc.set_status(db, c, payload.status, payload.note, _who(user), **kw)
    except _HANDLED as exc:
        raise _errors(exc) from exc
    audit.info("%s moved claim %s from %s to %s", _who(user), c.number, frm, c.status)
    return svc.one(db, c)


@router.post("/{claim_id}/events", status_code=201)
def add_claim_event(
    claim_id: int, payload: ClaimEventCreate, db: Session = Depends(get_db), user: User = Depends(require_write_access)
) -> Dict[str, Any]:
    """Add a note, a message (sent / received) or a shipment (out / in) to the timeline."""
    c = _claim(db, user, claim_id)
    try:
        e = svc.add_event(db, c, payload.model_dump(), _who(user), admin=user.role == "admin")
    except _HANDLED as exc:
        raise _errors(exc) from exc
    return svc.serialize_event(e)


@router.put("/{claim_id}/evidence/{key}")
def set_claim_evidence(
    claim_id: int,
    key: str,
    payload: ClaimEvidenceSet,
    db: Session = Depends(get_db),
    user: User = Depends(require_write_access),
) -> Dict[str, Any]:
    """Tick or untick an evidence item, with an optional link and note."""
    c = _claim(db, user, claim_id)
    try:
        return svc.set_evidence(db, c, key, payload.model_dump(exclude_unset=True), _who(user), admin=user.role == "admin")
    except _HANDLED as exc:
        raise _errors(exc) from exc


@router.post("/{claim_id}/links", status_code=201)
def add_claim_link(
    claim_id: int, payload: ClaimLinkBody, db: Session = Depends(get_db), user: User = Depends(require_write_access)
) -> Dict[str, Any]:
    """Link an issue, I-V sweep or site log event of the claim's plant."""
    c = _claim(db, user, claim_id)
    admin = user.role == "admin"
    try:
        link = svc.add_link(db, c, payload.kind, payload.ref_id, _who(user), allow_shadow=admin)
    except _HANDLED as exc:
        raise _errors(exc) from exc
    return svc.serialize_links(db, [link], admin)[0]


@router.delete("/{claim_id}/links/{link_id}", status_code=204)
def delete_claim_link(
    claim_id: int, link_id: int, db: Session = Depends(get_db), user: User = Depends(require_write_access)
) -> None:
    c = _claim(db, user, claim_id)
    try:
        svc.delete_link(db, c, link_id, _who(user), allow_shadow=user.role == "admin")
    except _HANDLED as exc:
        raise _errors(exc) from exc
