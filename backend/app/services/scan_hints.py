"""Label field hints (docs/plans/barcode-scanning.md §6.3): which field of a multi-field label is
the serial, per device category + model (`scan_field_hints`).

Anyone signed in may record the first hint for a category + model (the person who first scans such
a label picks the field); changing or removing an existing hint is admin only. A hint only
pre-selects a field in the scan dialog; it never blocks or changes a value.
"""

from __future__ import annotations

import re
from typing import Any, Dict, List, Optional

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db.models import ScanFieldHint, User

_CATEGORY = re.compile(r"^[a-z0-9_:.-]{1,40}$")


class HintForbidden(Exception):
    """An engineer tried to change or remove an existing hint."""


def model_key(model: str) -> str:
    return " ".join(model.split()).upper()


def _check(category: str, model: str) -> None:
    if not _CATEGORY.match(category):
        raise ValueError("Category: 1–40 lower-case letters, digits or _ : . -")
    if not model_key(model) or len(model.strip()) > 120:
        raise ValueError("Model: 1–120 characters")


def to_dict(h: ScanFieldHint) -> Dict[str, Any]:
    return {
        "id": h.id,
        "category": h.category,
        "model": h.model,
        "field_key": h.field_key,
        "field_index": h.field_index,
        "field_count": h.field_count,
        "updated_at": h.updated_at.isoformat() if h.updated_at else None,
    }


def list_hints(db: Session, category: Optional[str] = None, model: Optional[str] = None) -> List[Dict[str, Any]]:
    q = select(ScanFieldHint).order_by(ScanFieldHint.category, ScanFieldHint.model_key)
    if category:
        q = q.where(ScanFieldHint.category == category)
    if model:
        q = q.where(ScanFieldHint.model_key == model_key(model))
    return [to_dict(h) for h in db.scalars(q)]


def put_hint(db: Session, user: User, category: str, model: str, field_key: Optional[str], field_index: int, field_count: int) -> Dict[str, Any]:
    """Create the hint, or change it (admin only)."""
    _check(category, model)
    key = (field_key or "").strip()[:40] or None
    if field_count < 2 or field_count > 50 or not 0 <= field_index < field_count:
        raise ValueError("field_index must be within a label of 2–50 fields")
    h = db.scalars(select(ScanFieldHint).where(ScanFieldHint.category == category, ScanFieldHint.model_key == model_key(model))).first()
    if h is None:
        h = ScanFieldHint(category=category, model=" ".join(model.split()), model_key=model_key(model), created_by=user.id)
        db.add(h)
    elif user.role != "admin":
        if (h.field_key, h.field_index, h.field_count) == (key, field_index, field_count):
            return to_dict(h)
        raise HintForbidden("Only an admin can change a remembered field.")
    h.field_key, h.field_index, h.field_count, h.updated_by = key, field_index, field_count, user.id
    db.commit()
    db.refresh(h)
    return to_dict(h)


def delete_hint(db: Session, hint_id: int) -> bool:
    h = db.get(ScanFieldHint, hint_id)
    if h is None:
        return False
    db.delete(h)
    db.commit()
    return True
