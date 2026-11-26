"""Barcode / QR scans (docs/plans/barcode-scanning.md §9): what a scanned or typed code opens.

Resolve is DB only, nothing stored. Scoped: a device on a plant the user may not see is never matched, and an
app code naming one answers 404 (ids are not revealed). Rate limited per user (`SCAN_RESOLVE_PER_MIN`).
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.auth import get_current_user, require_admin
from app.config import settings
from app.db.models import User
from app.db.session import get_db
from app.services import scan as svc
from app.services import scan_hints as hints
from app.services.growatt_common import GrowattNotFound
from app.services.visit_route import RateLimited

router = APIRouter(prefix="/scan", tags=["Scanning"])


@router.get("/resolve")
def resolve_code(
    code: str = Query(..., max_length=svc.MAX_CODE_LEN),
    suggest: bool = Query(False, description="typed code: list O/0, I/1 variants that match when nothing does"),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> Dict[str, Any]:
    try:
        svc.limiter.hit(user.id, settings.scan_resolve_per_min)
    except RateLimited as exc:
        raise HTTPException(429, "Too many scans; try again in a minute.", headers={"Retry-After": str(int(exc.retry_after_s + 0.999))}) from exc
    try:
        return svc.resolve(db, user, code, suggest=suggest)
    except GrowattNotFound as exc:
        raise HTTPException(404, str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc


# ---------------------------------------------------------------- label field hints (§6.3)


class FieldHintIn(BaseModel):
    category: str = Field(..., max_length=40)
    model: str = Field(..., max_length=120)
    field_key: Optional[str] = Field(None, max_length=40)
    field_index: int
    field_count: int


@router.get("/field-hints")
def list_field_hints(
    category: Optional[str] = Query(None, max_length=40),
    model: Optional[str] = Query(None, max_length=120),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> List[Dict[str, Any]]:
    return hints.list_hints(db, category, model)


@router.put("/field-hints")
def put_field_hint(body: FieldHintIn, db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> Dict[str, Any]:
    """Remember which field is the serial. The first hint for a category + model: anyone; a change: admin."""
    try:
        return hints.put_hint(db, user, body.category, body.model, body.field_key, body.field_index, body.field_count)
    except hints.HintForbidden as exc:
        raise HTTPException(403, str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc


@router.delete("/field-hints/{hint_id}", status_code=204)
def delete_field_hint(hint_id: int, db: Session = Depends(get_db), user: User = Depends(require_admin)) -> None:
    if not hints.delete_hint(db, hint_id):
        raise HTTPException(404, "No such field hint")
