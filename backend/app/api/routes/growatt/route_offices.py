"""Site visit route: saved offices a route can start from (`/growatt/routes/offices`,
docs/plans/site-visit-route.md §5). SQL only (`route_offices`, static config). Every signed-in
user lists them (they are not plant-scoped); only admins create, edit and delete.
"""

from __future__ import annotations

from typing import Any, Dict

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from app.api.routes.growatt._common import audit
from app.auth import get_current_user, require_admin
from app.db.models import User
from app.db.session import get_db
from app.schemas.api_schemas import RouteOfficeIn, RouteOfficeList, RouteOfficeOut, RouteOfficePatch
from app.services import route_offices as svc

router = APIRouter(prefix="/routes/offices")


def _who(user: User) -> str:
    return user.username or user.email


@router.get("", response_model=RouteOfficeList)
def list_offices(db: Session = Depends(get_db), _: User = Depends(get_current_user)) -> Dict[str, Any]:
    """Every saved office, the default first, then by name."""
    return {"offices": svc.list_offices(db)}


@router.post("", response_model=RouteOfficeOut, status_code=201)
def create_office(body: RouteOfficeIn, db: Session = Depends(get_db), user: User = Depends(require_admin)) -> Dict[str, Any]:
    try:
        out = svc.create_office(db, user, body)
    except svc.OfficeConflict as exc:
        raise HTTPException(409, str(exc)) from exc
    except svc.OfficeInvalid as exc:
        raise HTTPException(422, str(exc)) from exc
    audit.info("%s added route office %s", _who(user), out["id"])
    return out


@router.patch("/{office_id}", response_model=RouteOfficeOut)
def update_office(
    office_id: int, body: RouteOfficePatch, db: Session = Depends(get_db), user: User = Depends(require_admin)
) -> Dict[str, Any]:
    try:
        out = svc.update_office(db, office_id, body)
    except svc.OfficeNotFound as exc:
        raise HTTPException(404, str(exc)) from exc
    except svc.OfficeConflict as exc:
        raise HTTPException(409, str(exc)) from exc
    except svc.OfficeInvalid as exc:
        raise HTTPException(422, str(exc)) from exc
    audit.info("%s changed route office %s (%s)", _who(user), office_id, ", ".join(sorted(body.model_fields_set)))
    return out


@router.delete("/{office_id}")
def delete_office(office_id: int, db: Session = Depends(get_db), user: User = Depends(require_admin)) -> Dict[str, Any]:
    """`default_office_id` = the default after the delete (null = no offices left)."""
    try:
        out = svc.delete_office(db, office_id)
    except svc.OfficeNotFound as exc:
        raise HTTPException(404, str(exc)) from exc
    audit.info("%s deleted route office %s", _who(user), office_id)
    return out
