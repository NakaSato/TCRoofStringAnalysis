"""Safety, Health & Environment (SH&E) dashboard and Permit-to-Work (PTW) CRUD endpoints."""

from __future__ import annotations

from typing import Any, Dict, List
from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.auth import require_write_access
from app.db.models import PTWPermit, User
from app.db.session import get_db
from app.schemas.api_schemas import PTWPermitIn, PTWPermitOut
from app.services.solar_service import df_to_records
from solar_core.om_management import get_she_dashboard_data

router = APIRouter(tags=["6. SH&E Safety Standards & PTW"])


@router.get("/she/dashboard")
def get_she_dashboard(
    plant_id: int = Query(default=1), db: Session = Depends(get_db)
) -> Dict[str, Any]:
    she_kpis, _, she_checklist_df = get_she_dashboard_data()
    ptw_rows = db.scalars(
        select(PTWPermit).where(PTWPermit.plant_id == plant_id).order_by(PTWPermit.id.asc())
    ).all()
    return {
        "kpis": she_kpis,
        "ptw_permits": [PTWPermitOut.model_validate(r).model_dump() for r in ptw_rows],
        "checklist": df_to_records(she_checklist_df),
    }


@router.get("/ptw", response_model=List[PTWPermitOut])
def list_ptw_permits(
    plant_id: int = Query(default=1), db: Session = Depends(get_db)
) -> List[PTWPermitOut]:
    rows = db.scalars(
        select(PTWPermit).where(PTWPermit.plant_id == plant_id).order_by(PTWPermit.id.asc())
    ).all()
    return [PTWPermitOut.model_validate(r) for r in rows]


@router.post("/ptw", response_model=PTWPermitOut, status_code=status.HTTP_201_CREATED)
def create_ptw_permit(
    payload: PTWPermitIn,
    db: Session = Depends(get_db),
    _user: User = Depends(require_write_access),
) -> PTWPermitOut:
    ptw = PTWPermit(**payload.model_dump())
    db.add(ptw)
    db.commit()
    db.refresh(ptw)
    return PTWPermitOut.model_validate(ptw)


@router.put("/ptw/{ptw_id}", response_model=PTWPermitOut)
def update_ptw_permit(
    ptw_id: int,
    payload: PTWPermitIn,
    db: Session = Depends(get_db),
    _user: User = Depends(require_write_access),
) -> PTWPermitOut:
    ptw = db.get(PTWPermit, ptw_id)
    if ptw is None:
        raise HTTPException(status_code=404, detail=f"PTW Permit {ptw_id} not found")
    for k, v in payload.model_dump().items():
        setattr(ptw, k, v)
    db.commit()
    db.refresh(ptw)
    return PTWPermitOut.model_validate(ptw)


@router.delete("/ptw/{ptw_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_ptw_permit(
    ptw_id: int,
    db: Session = Depends(get_db),
    _user: User = Depends(require_write_access),
) -> None:
    ptw = db.get(PTWPermit, ptw_id)
    if ptw is None:
        raise HTTPException(status_code=404, detail=f"PTW Permit {ptw_id} not found")
    db.delete(ptw)
    db.commit()
