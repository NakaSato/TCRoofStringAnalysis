"""Barcode / QR scans (docs/plans/barcode-scanning.md §9): what a scanned or typed code opens.

DB only, nothing stored. Scoped: a device on a plant the user may not see is never matched, and an
app code naming one answers 404 (ids are not revealed). Rate limited per user (`SCAN_RESOLVE_PER_MIN`).
"""

from __future__ import annotations

from typing import Any, Dict

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from app.auth import get_current_user
from app.config import settings
from app.db.models import User
from app.db.session import get_db
from app.services import scan as svc
from app.services.growatt_common import GrowattNotFound
from app.services.visit_route import RateLimited

router = APIRouter(prefix="/scan", tags=["Scanning"])


@router.get("/resolve")
def resolve_code(
    code: str = Query(..., max_length=svc.MAX_CODE_LEN),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> Dict[str, Any]:
    try:
        svc.limiter.hit(user.id, settings.scan_resolve_per_min)
    except RateLimited as exc:
        raise HTTPException(429, "Too many scans; try again in a minute.", headers={"Retry-After": str(int(exc.retry_after_s + 0.999))}) from exc
    try:
        return svc.resolve(db, user, code)
    except GrowattNotFound as exc:
        raise HTTPException(404, str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
