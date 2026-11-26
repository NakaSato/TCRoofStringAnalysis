"""Spares register (`/stock`, docs/plans/spares-failed-units.md), phase 1: parts catalogue, stock
locations, serialised units and the movement ledger. Everyone signed in reads and makes field
moves (transfer, issue, return); an admin or store keeper receives, corrects and edits the
catalogue and locations. Installs on plants a user may not see are left out."""

from __future__ import annotations

from datetime import date
from typing import Any, Dict, List, Literal, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.auth import get_current_user
from app.db.models import User
from app.db.session import get_db
from app.services import stock as svc

router = APIRouter(prefix="/stock", tags=["Spares"])


def _call(fn, *args, **kwargs):
    try:
        return fn(*args, **kwargs)
    except svc.StockForbidden as exc:
        raise HTTPException(403, str(exc)) from exc
    except svc.StockNotFound as exc:
        raise HTTPException(404, str(exc)) from exc
    except svc.StockConflict as exc:
        raise HTTPException(409, {"message": str(exc), "errors": exc.errors}) from exc
    except svc.StockError as exc:
        raise HTTPException(422, str(exc)) from exc


class PartIn(BaseModel):
    code: Optional[str] = Field(None, max_length=40)
    name: Optional[str] = Field(None, max_length=120)
    category: Optional[str] = Field(None, max_length=24)
    make: Optional[str] = Field(None, max_length=64)
    model: Optional[str] = Field(None, max_length=64)
    min_qty: Optional[int] = None
    active: Optional[bool] = None
    serialised: Optional[bool] = None
    note: Optional[str] = Field(None, max_length=2000)


class LocationIn(BaseModel):
    code: Optional[str] = Field(None, max_length=32)
    name: Optional[str] = Field(None, max_length=120)
    kind: Optional[str] = Field(None, max_length=16)
    parent_id: Optional[int] = None
    holder_user_id: Optional[int] = None
    active: Optional[bool] = None
    note: Optional[str] = Field(None, max_length=2000)


class MovementRow(BaseModel):
    kind: Literal["receive", "transfer", "issue", "return"]
    part_id: Optional[int] = None
    unit_id: Optional[int] = None
    serial: Optional[str] = Field(None, max_length=64)
    to_location_id: Optional[int] = None
    plant_id: Optional[int] = None
    note: Optional[str] = Field(None, max_length=2000)
    input_method: Optional[str] = Field(None, max_length=8)
    raw_scan: Optional[str] = Field(None, max_length=512)


class MovementBatch(BaseModel):
    rows: List[MovementRow] = Field(..., min_length=1, max_length=svc.MAX_BATCH)
    day: Optional[date] = None
    note: Optional[str] = Field(None, max_length=2000)


class CorrectionIn(BaseModel):
    note: str = Field(..., min_length=1, max_length=2000)


@router.get("/summary")
def get_summary(db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> Dict[str, Any]:
    return svc.summary(db)


@router.get("/parts")
def list_parts(include_inactive: bool = False, db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> List[Dict[str, Any]]:
    return svc.list_parts(db, include_inactive)


@router.post("/parts", status_code=201)
def create_part(body: PartIn, db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> Dict[str, Any]:
    return _call(svc.create_part, db, user, body.model_dump(exclude_unset=True))


@router.patch("/parts/{part_id}")
def update_part(part_id: int, body: PartIn, db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> Dict[str, Any]:
    return _call(svc.update_part, db, user, part_id, body.model_dump(exclude_unset=True))


@router.get("/locations")
def list_locations(include_inactive: bool = False, db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> List[Dict[str, Any]]:
    return svc.list_locations(db, include_inactive)


@router.post("/locations", status_code=201)
def create_location(body: LocationIn, db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> Dict[str, Any]:
    return _call(svc.create_location, db, user, body.model_dump(exclude_unset=True))


@router.patch("/locations/{location_id}")
def update_location(location_id: int, body: LocationIn, db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> Dict[str, Any]:
    return _call(svc.update_location, db, user, location_id, body.model_dump(exclude_unset=True))


@router.get("/people")
def list_people(db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> List[Dict[str, Any]]:
    """Active users' names, for a van's holder."""
    return svc.list_people(db)


@router.get("/units")
def list_units(
    part_id: Optional[int] = None,
    location_id: Optional[int] = None,
    state: Optional[str] = Query(None, max_length=16),
    q: Optional[str] = Query(None, max_length=64),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> List[Dict[str, Any]]:
    return svc.list_units(db, user, part_id, location_id, state, q)


@router.get("/movements")
def list_movements(
    kind: Optional[str] = Query(None, max_length=16),
    part_id: Optional[int] = None,
    location_id: Optional[int] = None,
    plant_id: Optional[int] = None,
    serial: Optional[str] = Query(None, max_length=64),
    unit_id: Optional[int] = None,
    limit: int = Query(200, ge=1, le=svc.MAX_LIST),
    offset: int = Query(0, ge=0),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> Dict[str, Any]:
    return svc.list_movements(db, user, kind, part_id, location_id, plant_id, serial, unit_id, limit, offset)


@router.post("/movements/batch", status_code=201)
def post_batch(body: MovementBatch, db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> Dict[str, Any]:
    """All rows or none: 409 with `errors` [{row, error}] when any row does not fit."""
    return _call(svc.apply_batch, db, user, [r.model_dump() for r in body.rows], body.day, body.note)


@router.post("/movements/{movement_id}/correct", status_code=201)
def correct_movement(movement_id: int, body: CorrectionIn, db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> Dict[str, Any]:
    """Reverse a unit's latest movement (admin or store keeper); the original stays in the ledger."""
    return _call(svc.correct, db, user, movement_id, body.note)
