"""Root Cause Analysis (RCA) 5-Why & Fishbone register CRUD endpoints."""

from __future__ import annotations

from datetime import date
from typing import List
from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.auth import require_write_access
from app.db.models import RCARecord, User
from app.db.session import get_db
from app.schemas.api_schemas import RCARecordIn, RCARecordOut

router = APIRouter(prefix="/rca", tags=["4. Root Cause Analysis (RCA)"])


@router.get("", response_model=List[RCARecordOut])
def list_rca_records(
    plant_id: int = Query(default=1), db: Session = Depends(get_db)
) -> List[RCARecordOut]:
    rows = db.scalars(
        select(RCARecord).where(RCARecord.plant_id == plant_id).order_by(RCARecord.id.asc())
    ).all()
    return [RCARecordOut.model_validate(r) for r in rows]


@router.post("", response_model=RCARecordOut, status_code=status.HTTP_201_CREATED)
def create_rca_record(
    payload: RCARecordIn,
    db: Session = Depends(get_db),
    _user: User = Depends(require_write_access),
) -> RCARecordOut:
    count = db.scalar(
        select(func.count()).select_from(RCARecord).where(RCARecord.plant_id == payload.plant_id)
    ) or 0
    rca_id = payload.rca_id or f"RCA-2026-{(count + 1):02d}"
    inc_date = payload.incident_date or date.today().isoformat()
    data = payload.model_dump()
    data["rca_id"] = rca_id
    data["incident_date"] = inc_date

    rec = RCARecord(**data)
    db.add(rec)
    db.commit()
    db.refresh(rec)
    return RCARecordOut.model_validate(rec)


@router.put("/{record_id}", response_model=RCARecordOut)
def update_rca_record(
    record_id: int,
    payload: RCARecordIn,
    db: Session = Depends(get_db),
    _user: User = Depends(require_write_access),
) -> RCARecordOut:
    rec = db.get(RCARecord, record_id)
    if rec is None:
        raise HTTPException(status_code=404, detail=f"RCA Record {record_id} not found")
    data = payload.model_dump()
    if not data.get("rca_id"):
        data["rca_id"] = rec.rca_id
    if not data.get("incident_date"):
        data["incident_date"] = rec.incident_date
    for k, v in data.items():
        setattr(rec, k, v)
    db.commit()
    db.refresh(rec)
    return RCARecordOut.model_validate(rec)


@router.delete("/{record_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_rca_record(
    record_id: int,
    db: Session = Depends(get_db),
    _user: User = Depends(require_write_access),
) -> None:
    rec = db.get(RCARecord, record_id)
    if rec is None:
        raise HTTPException(status_code=404, detail=f"RCA Record {record_id} not found")
    db.delete(rec)
    db.commit()
