"""Subcontractor Supervision, QA/QC Engineering Checklist, Commissioning & Power Quality endpoints."""

from __future__ import annotations

from typing import Any, Dict, List
from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.auth import require_write_access
from app.db.models import PQTestRecord, SubcontractorAudit, User
from app.db.session import get_db
from app.schemas.api_schemas import (
    PQTestEvaluateRequest,
    PQTestOut,
    SubcontractorAuditIn,
    SubcontractorAuditOut,
)
from app.services.solar_service import df_to_records
from solar_core.om_management import (
    evaluate_commissioning_and_power_quality,
    get_qaqc_engineering_checklist,
)

router = APIRouter(tags=["5. Subcontractors, Commissioning & Power Quality"])


@router.get("/subcontractor-audits", response_model=List[SubcontractorAuditOut])
def list_subcontractor_audits(
    plant_id: int = Query(default=1), db: Session = Depends(get_db)
) -> List[SubcontractorAuditOut]:
    rows = db.scalars(
        select(SubcontractorAudit)
        .where(SubcontractorAudit.plant_id == plant_id)
        .order_by(SubcontractorAudit.id.asc())
    ).all()
    return [SubcontractorAuditOut.model_validate(r) for r in rows]


@router.post(
    "/subcontractor-audits",
    response_model=SubcontractorAuditOut,
    status_code=status.HTTP_201_CREATED,
)
def create_subcontractor_audit(
    payload: SubcontractorAuditIn,
    db: Session = Depends(get_db),
    _user: User = Depends(require_write_access),
) -> SubcontractorAuditOut:
    audit = SubcontractorAudit(**payload.model_dump())
    db.add(audit)
    db.commit()
    db.refresh(audit)
    return SubcontractorAuditOut.model_validate(audit)


@router.put("/subcontractor-audits/{audit_id}", response_model=SubcontractorAuditOut)
def update_subcontractor_audit(
    audit_id: int,
    payload: SubcontractorAuditIn,
    db: Session = Depends(get_db),
    _user: User = Depends(require_write_access),
) -> SubcontractorAuditOut:
    audit = db.get(SubcontractorAudit, audit_id)
    if audit is None:
        raise HTTPException(status_code=404, detail=f"Subcontractor Audit {audit_id} not found")
    for k, v in payload.model_dump().items():
        setattr(audit, k, v)
    db.commit()
    db.refresh(audit)
    return SubcontractorAuditOut.model_validate(audit)


@router.delete("/subcontractor-audits/{audit_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_subcontractor_audit(
    audit_id: int,
    db: Session = Depends(get_db),
    _user: User = Depends(require_write_access),
) -> None:
    audit = db.get(SubcontractorAudit, audit_id)
    if audit is None:
        raise HTTPException(status_code=404, detail=f"Subcontractor Audit {audit_id} not found")
    db.delete(audit)
    db.commit()


@router.get("/qaqc-checklist")
def get_qaqc_checklist() -> List[Dict[str, Any]]:
    return df_to_records(get_qaqc_engineering_checklist())


@router.get("/pq-tests/latest", response_model=PQTestOut)
def get_latest_pq_test(
    plant_id: int = Query(default=1), db: Session = Depends(get_db)
) -> PQTestOut:
    rec = db.scalar(
        select(PQTestRecord)
        .where(PQTestRecord.plant_id == plant_id)
        .order_by(PQTestRecord.id.desc())
        .limit(1)
    )
    if rec is None:
        pq_df, comm_df = evaluate_commissioning_and_power_quality()
        rec = PQTestRecord(
            plant_id=plant_id,
            pq_results_json=df_to_records(pq_df),
            commissioning_results_json=df_to_records(comm_df),
            overall_compliant=bool((pq_df["Compliant"] == "Pass").all()),
        )
        db.add(rec)
        db.commit()
        db.refresh(rec)
    return PQTestOut.model_validate(rec)


@router.post("/pq-tests/evaluate", response_model=PQTestOut)
def evaluate_pq_test(
    payload: PQTestEvaluateRequest,
    db: Session = Depends(get_db),
) -> PQTestOut:
    pq_df, comm_df = evaluate_commissioning_and_power_quality(
        voltage_thd_pct=payload.voltage_thd_pct,
        current_thd_pct=payload.current_thd_pct,
        power_factor=payload.power_factor,
        voltage_unbalance_pct=payload.voltage_unbalance_pct,
        flicker_plt=payload.flicker_plt,
        grid_frequency_hz=payload.grid_frequency_hz,
        dc_injection_pct=payload.dc_injection_pct,
        min_riso_mohm=payload.min_riso_mohm,
    )
    overall_ok = bool((pq_df["Compliant"] == "Pass").all() and payload.min_riso_mohm >= 1.0)
    rec = PQTestRecord(
        plant_id=payload.plant_id,
        voltage_thd_pct=payload.voltage_thd_pct,
        current_thd_pct=payload.current_thd_pct,
        power_factor=payload.power_factor,
        voltage_unbalance_pct=payload.voltage_unbalance_pct,
        flicker_plt=payload.flicker_plt,
        grid_frequency_hz=payload.grid_frequency_hz,
        dc_injection_pct=payload.dc_injection_pct,
        min_riso_mohm=payload.min_riso_mohm,
        pq_results_json=df_to_records(pq_df),
        commissioning_results_json=df_to_records(comm_df),
        overall_compliant=overall_ok,
    )
    db.add(rec)
    db.commit()
    db.refresh(rec)
    return PQTestOut.model_validate(rec)
