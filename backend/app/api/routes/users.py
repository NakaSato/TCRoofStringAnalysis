"""User management and plant assignments (`/users`, admin only)."""

from __future__ import annotations

import logging
from typing import List

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from app.auth import require_admin
from app.db.models import User
from app.db.session import get_db
from app.schemas.api_schemas import PlantAssignment, UserCreate, UserOut, UserUpdate
from app.services import users as svc

router = APIRouter(prefix="/users", tags=["Users & Access"], dependencies=[Depends(require_admin)])
audit = logging.getLogger("app.audit")


def _by(user: User) -> str:
    return user.username or user.email


@router.get("", response_model=List[UserOut])
def list_users(db: Session = Depends(get_db)) -> List[dict]:
    return svc.list_users(db)


@router.post("", response_model=UserOut, status_code=status.HTTP_201_CREATED)
def create_user(payload: UserCreate, db: Session = Depends(get_db), admin: User = Depends(require_admin)) -> dict:
    try:
        out = svc.create_user(db, payload.model_dump(), _by(admin))
        audit.info("%s created user %s (%s)", _by(admin), out.get("username") or out.get("email"), out.get("role"))
        return out
    except svc.UserError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@router.patch("/{user_id}", response_model=UserOut)
def update_user(
    user_id: int, payload: UserUpdate, db: Session = Depends(get_db), admin: User = Depends(require_admin)
) -> dict:
    """Change role, name, email, password or active flag. Accounts are disabled, never deleted."""
    try:
        changes = payload.model_dump(exclude_unset=True)
        out = svc.update_user(db, user_id, changes, admin)
        # field names only: a new password never goes into the log
        audit.info("%s changed user %s: %s", _by(admin), user_id, ", ".join(sorted(changes)) or "nothing")
        return out
    except svc.UserNotFound as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except svc.UserError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@router.put("/{user_id}/plants", response_model=UserOut)
def set_user_plants(
    user_id: int, payload: PlantAssignment, db: Session = Depends(get_db), admin: User = Depends(require_admin)
) -> dict:
    """Replace the engineer's assigned Growatt plants (an empty list removes them all)."""
    try:
        out = svc.set_user_plants(db, user_id, payload.plant_ids, _by(admin))
        audit.info("%s set user %s's plants: %d assigned", _by(admin), user_id, len(payload.plant_ids))
        return out
    except svc.UserNotFound as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except svc.UserError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
