"""User accounts and plant assignments (admin only).

Two roles:
- `admin`: everything (all plants, fleet settings, jobs, user management, legacy O&M modules).
- `engineer`: only the Growatt plants an admin assigned (`user_plant_assignments`).

Assignments are read from the DB on every request (`app.auth.allowed_plant_ids`), so a change
applies at once, without the engineer signing in again.
"""

from __future__ import annotations

from typing import Any, Dict, Iterable, List, Optional

from sqlalchemy import delete, func, or_, select
from sqlalchemy.orm import Session

from app.auth import hash_password
from app.db.models import GrowattPlant, User, UserPlantAssignment


class UserError(ValueError):
    """Invalid request (duplicate username, last admin, unknown plant)."""


class UserNotFound(LookupError):
    pass


def user_out(db: Session, user: User) -> Dict[str, Any]:
    """`UserOut` fields, with `plant_ids` = None for an admin (every plant)."""
    plant_ids: Optional[List[int]] = None
    if user.role != "admin":
        plant_ids = sorted(
            db.scalars(select(UserPlantAssignment.plant_id).where(UserPlantAssignment.user_id == user.id))
        )
    return {
        "id": user.id,
        "username": user.username,
        "email": user.email,
        "full_name": user.full_name,
        "role": user.role,
        "is_active": user.is_active,
        "store_keeper": bool(user.store_keeper),
        "plant_ids": plant_ids,
    }


def list_users(db: Session) -> List[Dict[str, Any]]:
    return [user_out(db, u) for u in db.scalars(select(User).order_by(User.role, User.username))]


def _get(db: Session, user_id: int) -> User:
    user = db.get(User, user_id)
    if user is None:
        raise UserNotFound(f"User {user_id} not found")
    return user


def _active_admins(db: Session) -> int:
    return int(db.scalar(select(func.count()).select_from(User).where(User.role == "admin", User.is_active.is_(True))) or 0)


def _check_plants(db: Session, plant_ids: Iterable[int]) -> List[int]:
    ids = sorted(set(plant_ids))
    if not ids:
        return ids
    known = set(db.scalars(select(GrowattPlant.plant_id).where(GrowattPlant.plant_id.in_(ids))))
    unknown = [i for i in ids if i not in known]
    if unknown:
        raise UserError(f"Unknown plant id(s): {unknown}")
    return ids


def _replace_assignments(db: Session, user: User, plant_ids: List[int], by: str) -> None:
    db.execute(delete(UserPlantAssignment).where(UserPlantAssignment.user_id == user.id))
    if user.role != "admin":  # admins see every plant; rows would only be misleading
        db.add_all(UserPlantAssignment(user_id=user.id, plant_id=pid, assigned_by=by) for pid in plant_ids)


def create_user(db: Session, data: Dict[str, Any], by: str) -> Dict[str, Any]:
    username = data["username"].strip().lower()
    email = (data.get("email") or "").strip().lower() or f"{username}@users.local"
    clash = db.scalar(select(User).where(or_(User.username == username, User.email == email)))
    if clash is not None:
        raise UserError(f"Username or email already in use: {username!r} / {email!r}")
    plant_ids = _check_plants(db, data.get("plant_ids") or [])
    user = User(
        username=username,
        email=email,
        full_name=data["full_name"].strip(),
        hashed_password=hash_password(data["password"]),
        role=data.get("role") or "engineer",
        is_active=True,
        store_keeper=bool(data.get("store_keeper")),
    )
    db.add(user)
    db.flush()
    _replace_assignments(db, user, plant_ids, by)
    db.commit()
    return user_out(db, user)


def update_user(db: Session, user_id: int, data: Dict[str, Any], acting: User) -> Dict[str, Any]:
    user = _get(db, user_id)
    demotes = data.get("role") not in (None, "admin") and user.role == "admin"
    disables = data.get("is_active") is False and user.is_active
    if (demotes or disables) and user.role == "admin" and user.is_active and _active_admins(db) <= 1:
        raise UserError("Cannot demote or disable the last active admin")
    if disables and user.id == acting.id:
        raise UserError("You cannot disable your own account")
    if data.get("email") is not None:
        email = data["email"].strip().lower()
        if db.scalar(select(User).where(User.email == email, User.id != user.id)) is not None:
            raise UserError(f"Email already in use: {email!r}")
        user.email = email
    if data.get("full_name") is not None:
        user.full_name = data["full_name"].strip()
    if data.get("password"):
        user.hashed_password = hash_password(data["password"])
    if data.get("is_active") is not None:
        user.is_active = bool(data["is_active"])
    if data.get("store_keeper") is not None:
        user.store_keeper = bool(data["store_keeper"])
    if data.get("role") is not None and data["role"] != user.role:
        user.role = data["role"]
        if user.role == "admin":
            db.execute(delete(UserPlantAssignment).where(UserPlantAssignment.user_id == user.id))
    db.commit()
    return user_out(db, user)


def set_user_plants(db: Session, user_id: int, plant_ids: Iterable[int], by: str) -> Dict[str, Any]:
    user = _get(db, user_id)
    if user.role == "admin":
        raise UserError("Admins see every plant; assign plants to engineers only")
    _replace_assignments(db, user, _check_plants(db, plant_ids), by)
    db.commit()
    return user_out(db, user)
