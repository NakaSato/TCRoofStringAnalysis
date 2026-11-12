"""Authentication endpoints (`/auth/login`, `/auth/me`)."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import or_, select
from sqlalchemy.orm import Session

from app.auth import create_access_token, get_current_user, verify_password
from app.db.models import User
from app.db.session import get_db
from app.schemas.api_schemas import LoginRequest, TokenResponse, UserOut
from app.services.users import user_out

router = APIRouter(prefix="/auth", tags=["Authentication"])


@router.post("/login", response_model=TokenResponse)
def login(payload: LoginRequest, db: Session = Depends(get_db)) -> TokenResponse:
    """Authenticate by username (or email) and password and issue a JWT token."""
    ident = payload.identifier
    if not ident:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_CONTENT, detail="Username is required")
    user = db.scalar(select(User).where(or_(User.username == ident, User.email == ident)))
    # Same message for unknown user, wrong password and disabled account: don't reveal which.
    if user is None or not user.is_active or not verify_password(payload.password, user.hashed_password):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid username or password",
        )
    token = create_access_token(user)
    return TokenResponse(access_token=token, user=UserOut(**user_out(db, user)))


@router.get("/me", response_model=UserOut)
def get_me(current_user: User = Depends(get_current_user), db: Session = Depends(get_db)) -> UserOut:
    """Return the signed-in user's profile, role and assigned plants (null = all, for admins)."""
    return UserOut(**user_out(db, current_user))
