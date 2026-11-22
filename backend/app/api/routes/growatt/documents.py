"""Per-plant document links: as-built drawing PDF and site photo folder (docs/plans/plant-asbuilt-links.md).

DB only; the files stay on Google Drive. Reads follow plant access; writes are admin only.
"""

from __future__ import annotations

from typing import Any, Dict

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from app.auth import allowed_plant_ids, get_current_user, require_admin, require_plant_read
from app.db.models import User
from app.db.session import get_db
from app.schemas.api_schemas import PlantDocumentBody, PlantDocumentImport
from app.services import plant_documents as docs
from app.services.growatt_common import GrowattNotFound
from app.api.routes.growatt._common import audit

router = APIRouter()


@router.get("/documents")
def list_plant_documents(db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> Dict[str, Any]:
    """Every visible plant with its document links (null = none), for Settings → Plant documents."""
    return {"plants": docs.list_all(db, allowed_plant_ids(db, user)), "kinds": list(docs.KINDS), "meta": {"source": "db"}}


@router.get("/plants/{plant_id}/documents")
def get_plant_documents(plant_id: int, db: Session = Depends(get_db), _: User = Depends(require_plant_read)) -> Dict[str, Any]:
    return {"plant_id": plant_id, "documents": docs.for_plant(db, plant_id)}


@router.put("/plants/{plant_id}/documents/{kind}")
def put_plant_document(
    plant_id: int, kind: str, payload: PlantDocumentBody, db: Session = Depends(get_db), user: User = Depends(require_admin)
) -> Dict[str, Any]:
    """An admin's link (source `manual`; a later Drive import leaves it alone)."""
    try:
        out = docs.put(db, user, plant_id, kind, payload.url, payload.title)
    except GrowattNotFound as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except docs.DocumentError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    audit.info("%s set the %s link of plant %s", user.username or user.email, kind, plant_id)
    return out


@router.delete("/plants/{plant_id}/documents/{kind}")
def delete_plant_document(
    plant_id: int, kind: str, db: Session = Depends(get_db), user: User = Depends(require_admin)
) -> Dict[str, Any]:
    try:
        removed = docs.remove(db, plant_id, kind)
    except docs.DocumentError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    if not removed:
        raise HTTPException(status_code=404, detail=f"Plant {plant_id} has no {kind} link")
    audit.info("%s removed the %s link of plant %s", user.username or user.email, kind, plant_id)
    return {"plant_id": plant_id, "kind": kind, "removed": True}


@router.post("/documents/import")
def import_plant_documents(
    payload: PlantDocumentImport,
    apply: bool = Query(False, description="false = dry run (counts only)"),
    db: Session = Depends(get_db),
    user: User = Depends(require_admin),
) -> Dict[str, Any]:
    """The Drive matcher's accepted rows (`drive_asbuilt_match.py --post`). `manual` links are kept."""
    out = docs.import_rows(db, [r.model_dump() for r in payload.rows], apply, user.username or user.email)
    if apply:
        audit.info("%s imported plant document links: %s created, %s updated", user.username or user.email, out["created"], out["updated"])
    return out
