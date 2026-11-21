"""Measuring Tools: instruments, check-outs, calibration / document due dates (DB only,
docs/plans/measuring-tools.md).

Everyone views the register, checks out (engineers only to themselves and to their assigned
plants) and checks in what they hold. Admins add, edit, retire and delete instruments, check out
to anyone, check in anything and record calibrations / documents.
"""

from __future__ import annotations

from typing import Any, Dict

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from app.auth import allowed_plant_ids, require_admin, require_write_access
from app.db.models import User
from app.db.session import get_db
from app.schemas.api_schemas import (
    InstrumentCheckoutBody,
    InstrumentCreate,
    InstrumentDueBody,
    InstrumentPatch,
    InstrumentReturnBody,
)
from app.services import tools as svc
from app.services.growatt_common import GrowattNotFound
from app.api.routes.growatt._common import audit

router = APIRouter(prefix="/tools", tags=["Measuring Tools"])


def _who(user: User) -> str:
    return user.username or user.email


def _errors(exc: Exception) -> HTTPException:
    if isinstance(exc, GrowattNotFound):
        return HTTPException(status_code=404, detail=str(exc))
    if isinstance(exc, svc.ToolConflict):
        return HTTPException(status_code=409, detail=str(exc))
    if isinstance(exc, svc.ToolForbidden):
        return HTTPException(status_code=403, detail=str(exc))
    return HTTPException(status_code=422, detail=str(exc))


_HANDLED = (GrowattNotFound, svc.ToolConflict, svc.ToolForbidden, ValueError)


def _instrument(db: Session, instrument_id: int):
    try:
        return svc.get_instrument(db, instrument_id)
    except GrowattNotFound as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@router.get("")
def list_instruments(
    include_retired: bool = Query(False),
    db: Session = Depends(get_db),
    user: User = Depends(require_write_access),
) -> Dict[str, Any]:
    """The register with due states and summary counts (judged on today, plant-local)."""
    return svc.list_instruments(db, allowed_plant_ids(db, user), include_retired=include_retired)


@router.get("/{instrument_id}")
def get_instrument(instrument_id: int, db: Session = Depends(get_db), user: User = Depends(require_write_access)) -> Dict[str, Any]:
    """One instrument with its calibration / document records and check-out history."""
    return svc.detail(db, _instrument(db, instrument_id), allowed_plant_ids(db, user))


@router.post("", status_code=201)
def create_instrument(payload: InstrumentCreate, db: Session = Depends(get_db), user: User = Depends(require_admin)) -> Dict[str, Any]:
    fields = payload.model_dump(exclude_unset=True)
    fields.pop("status", None)  # a new instrument is available
    try:
        i = svc.create_instrument(db, fields, _who(user))
    except _HANDLED as exc:
        raise _errors(exc) from exc
    audit.info("%s added instrument %s (%s)", _who(user), i.asset_tag, i.category)
    return svc.one(db, i, None)


@router.patch("/{instrument_id}")
def patch_instrument(
    instrument_id: int, payload: InstrumentPatch, db: Session = Depends(get_db), user: User = Depends(require_admin)
) -> Dict[str, Any]:
    """Change the fields sent, incl. status repair / at_calibration / retired / available."""
    i = _instrument(db, instrument_id)
    try:
        changed = svc.update_instrument(db, i, payload.model_dump(exclude_unset=True), _who(user))
    except _HANDLED as exc:
        raise _errors(exc) from exc
    if changed:
        audit.info("%s changed instrument %s (%s)", _who(user), i.asset_tag, ", ".join(changed))
    return svc.one(db, i, None)


@router.delete("/{instrument_id}", status_code=204)
def delete_instrument(instrument_id: int, db: Session = Depends(get_db), user: User = Depends(require_admin)) -> None:
    """Delete an instrument never checked out; one with history answers 409 (retire it)."""
    i = _instrument(db, instrument_id)
    tag = i.asset_tag
    try:
        svc.delete_instrument(db, i)
    except _HANDLED as exc:
        raise _errors(exc) from exc
    audit.info("%s deleted instrument %s", _who(user), tag)


@router.post("/{instrument_id}/checkout", status_code=201)
def checkout_instrument(
    instrument_id: int, payload: InstrumentCheckoutBody, db: Session = Depends(get_db), user: User = Depends(require_write_access)
) -> Dict[str, Any]:
    """Check out (available only). Warnings that apply (calibration overdue, drone documents
    expired) must be in `ack_warnings`, else 409; they are kept on the check-out."""
    i = _instrument(db, instrument_id)
    plant_ids = allowed_plant_ids(db, user)
    try:
        c = svc.checkout(db, i, payload.model_dump(), user, admin=user.role == "admin", plant_ids=plant_ids)
    except _HANDLED as exc:
        raise _errors(exc) from exc
    audit.info("%s checked out instrument %s to %s", _who(user), i.asset_tag, c.holder_name)
    return svc.one_checkout(db, c, plant_ids)


@router.post("/{instrument_id}/return")
def return_instrument(
    instrument_id: int, payload: InstrumentReturnBody, db: Session = Depends(get_db), user: User = Depends(require_write_access)
) -> Dict[str, Any]:
    """Check in (holder or admin): ok → available, damaged → repair, lost → retired."""
    i = _instrument(db, instrument_id)
    plant_ids = allowed_plant_ids(db, user)
    try:
        c = svc.return_instrument(db, i, payload.model_dump(), user, admin=user.role == "admin")
    except _HANDLED as exc:
        raise _errors(exc) from exc
    audit.info("%s checked in instrument %s (%s)", _who(user), i.asset_tag, c.condition)
    return svc.one_checkout(db, c, plant_ids)


@router.post("/{instrument_id}/due", status_code=201)
def record_instrument_due(
    instrument_id: int, payload: InstrumentDueBody, db: Session = Depends(get_db), user: User = Depends(require_admin)
) -> Dict[str, Any]:
    """Record a calibration or document renewal; answers the instrument with its new due items."""
    i = _instrument(db, instrument_id)
    try:
        r = svc.record_due(db, i, payload.model_dump(), _who(user))
    except _HANDLED as exc:
        raise _errors(exc) from exc
    audit.info("%s recorded %s for instrument %s (next due %s)", _who(user), r.kind, i.asset_tag, r.next_due or "—")
    return svc.one(db, i, None)
