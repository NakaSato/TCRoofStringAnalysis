"""JWT authentication and PBKDF2 password hashing utilities."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
import hashlib
import hmac
import secrets
from typing import Optional, Set

from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
import jwt
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.config import settings
from app.db.models import User, UserPlantAssignment
from app.db.session import get_db

security_scheme = HTTPBearer(auto_error=False)


def hash_password(password: str) -> str:
    """Hash a plaintext password using PBKDF2-HMAC-SHA256."""
    salt = secrets.token_hex(16)
    dk = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt.encode("utf-8"), 120_000)
    return f"pbkdf2_sha256$120000${salt}${dk.hex()}"


def verify_password(plain_password: str, hashed_password: str) -> bool:
    """Verify a plaintext password against a stored PBKDF2 hash."""
    try:
        algo, iterations_str, salt, stored_hex = hashed_password.split("$", 3)
        if algo != "pbkdf2_sha256":
            return False
        dk = hashlib.pbkdf2_hmac(
            "sha256",
            plain_password.encode("utf-8"),
            salt.encode("utf-8"),
            int(iterations_str),
        )
        return hmac.compare_digest(dk.hex(), stored_hex)
    except Exception:
        return False


def create_access_token(user: User, expires_delta: Optional[timedelta] = None) -> str:
    """Create a signed JWT token for a user."""
    expire = datetime.now(timezone.utc) + (
        expires_delta or timedelta(minutes=settings.jwt_expire_minutes)
    )
    payload = {
        "sub": str(user.id),
        "email": user.email,
        "role": user.role,
        "full_name": user.full_name,
        "exp": expire,
    }
    return jwt.encode(payload, settings.jwt_secret_key, algorithm=settings.jwt_algorithm)


def decode_access_token(token: str) -> dict:
    """Decode and validate a JWT token."""
    try:
        return jwt.decode(token, settings.jwt_secret_key, algorithms=[settings.jwt_algorithm])
    except jwt.PyJWTError as exc:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail=f"Invalid or expired authentication token: {exc}",
            headers={"WWW-Authenticate": "Bearer"},
        ) from exc


def get_current_user(
    credentials: Optional[HTTPAuthorizationCredentials] = Depends(security_scheme),
    db: Session = Depends(get_db),
) -> User:
    """Require a valid JWT bearer token and return the active User."""
    if credentials is None or not credentials.credentials:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Authentication required",
            headers={"WWW-Authenticate": "Bearer"},
        )
    payload = decode_access_token(credentials.credentials)
    user_id = int(payload.get("sub", 0))
    user = db.get(User, user_id)
    if user is None or not user.is_active:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="User account not found or inactive",
        )
    return user


def get_optional_user(
    credentials: Optional[HTTPAuthorizationCredentials] = Depends(security_scheme),
    db: Session = Depends(get_db),
) -> Optional[User]:
    """Return the authenticated User if a valid token is provided, or None."""
    if credentials is None or not credentials.credentials:
        return None
    try:
        payload = decode_access_token(credentials.credentials)
        user_id = int(payload.get("sub", 0))
        return db.get(User, user_id)
    except HTTPException:
        return None


def require_write_access(user: User = Depends(get_current_user)) -> User:
    """Require an authenticated user with 'admin' or 'engineer' role."""
    if user.role not in ("admin", "engineer"):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Insufficient permissions: 'admin' or 'engineer' role required for write operations.",
        )
    return user


def require_admin(user: User = Depends(get_current_user)) -> User:
    """Require an admin: fleet-wide settings, jobs, user management and the legacy O&M modules."""
    if user.role != "admin":
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Admin role required.")
    return user


def can_manage_stock(user: User) -> bool:
    """Spares: receive, confirm counts, edit the catalogue and locations (admin or store keeper)."""
    return user.role == "admin" or bool(user.store_keeper)


def require_store_keeper(user: User = Depends(get_current_user)) -> User:
    if not can_manage_stock(user):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Admin or store keeper required.")
    return user


def allowed_plant_ids(db: Session, user: User) -> Optional[Set[int]]:
    """Growatt plants the user may see: None = every plant (admin), else the assigned set."""
    if user.role == "admin":
        return None
    return set(db.scalars(select(UserPlantAssignment.plant_id).where(UserPlantAssignment.user_id == user.id)))


def ensure_plant_access(db: Session, user: User, plant_id: int) -> None:
    """404 (not 403) for a plant outside the user's assignments, so plant ids are not revealed."""
    allowed = allowed_plant_ids(db, user)
    if allowed is not None and plant_id not in allowed:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=f"Plant {plant_id} not found")


def require_plant_read(
    plant_id: int,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> User:
    """Route dependency for `/…/plants/{plant_id}/…` reads: admin, or the plant is assigned."""
    ensure_plant_access(db, user, plant_id)
    return user


def require_plant_write(
    plant_id: int,
    user: User = Depends(require_write_access),
    db: Session = Depends(get_db),
) -> User:
    """Route dependency for plant writes: admin, or an engineer the plant is assigned to."""
    ensure_plant_access(db, user, plant_id)
    return user
