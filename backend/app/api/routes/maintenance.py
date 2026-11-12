"""Preventive Maintenance (PM) and Corrective Maintenance (CM) CRUD endpoints."""

from __future__ import annotations

from typing import List
from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.auth import require_write_access
from app.db.models import AnalysisRun, CMWorkOrder, PMTask, User
from app.db.session import get_db
from app.schemas.api_schemas import CMWorkOrderIn, CMWorkOrderOut, PMTaskIn, PMTaskOut
from app.services.solar_service import (
    reconstruct_analysis_results,
    regenerate_cm_work_orders,
)

router = APIRouter(tags=["4. PM & CM Maintenance"])


@router.get("/pm-tasks", response_model=List[PMTaskOut])
def list_pm_tasks(plant_id: int = Query(default=1), db: Session = Depends(get_db)) -> List[PMTaskOut]:
    rows = db.scalars(select(PMTask).where(PMTask.plant_id == plant_id).order_by(PMTask.id.asc())).all()
    return [PMTaskOut.model_validate(r) for r in rows]


@router.post("/pm-tasks", response_model=PMTaskOut, status_code=status.HTTP_201_CREATED)
def create_pm_task(
    payload: PMTaskIn,
    db: Session = Depends(get_db),
    _user: User = Depends(require_write_access),
) -> PMTaskOut:
    task = PMTask(**payload.model_dump())
    db.add(task)
    db.commit()
    db.refresh(task)
    return PMTaskOut.model_validate(task)


@router.put("/pm-tasks/{task_id}", response_model=PMTaskOut)
def update_pm_task(
    task_id: int,
    payload: PMTaskIn,
    db: Session = Depends(get_db),
    _user: User = Depends(require_write_access),
) -> PMTaskOut:
    task = db.get(PMTask, task_id)
    if task is None:
        raise HTTPException(status_code=404, detail=f"PM Task {task_id} not found")
    for k, v in payload.model_dump().items():
        setattr(task, k, v)
    db.commit()
    db.refresh(task)
    return PMTaskOut.model_validate(task)


@router.delete("/pm-tasks/{task_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_pm_task(
    task_id: int,
    db: Session = Depends(get_db),
    _user: User = Depends(require_write_access),
) -> None:
    task = db.get(PMTask, task_id)
    if task is None:
        raise HTTPException(status_code=404, detail=f"PM Task {task_id} not found")
    db.delete(task)
    db.commit()


@router.get("/cm-work-orders", response_model=List[CMWorkOrderOut])
def list_cm_work_orders(
    plant_id: int = Query(default=1), db: Session = Depends(get_db)
) -> List[CMWorkOrderOut]:
    rows = db.scalars(
        select(CMWorkOrder).where(CMWorkOrder.plant_id == plant_id).order_by(CMWorkOrder.id.asc())
    ).all()
    return [CMWorkOrderOut.model_validate(r) for r in rows]


@router.post("/cm-work-orders", response_model=CMWorkOrderOut, status_code=status.HTTP_201_CREATED)
def create_cm_work_order(
    payload: CMWorkOrderIn,
    db: Session = Depends(get_db),
    _user: User = Depends(require_write_access),
) -> CMWorkOrderOut:
    wo = CMWorkOrder(**payload.model_dump())
    db.add(wo)
    db.commit()
    db.refresh(wo)
    return CMWorkOrderOut.model_validate(wo)


@router.put("/cm-work-orders/{wo_id}", response_model=CMWorkOrderOut)
def update_cm_work_order(
    wo_id: int,
    payload: CMWorkOrderIn,
    db: Session = Depends(get_db),
    _user: User = Depends(require_write_access),
) -> CMWorkOrderOut:
    wo = db.get(CMWorkOrder, wo_id)
    if wo is None:
        raise HTTPException(status_code=404, detail=f"CM Work Order {wo_id} not found")
    for k, v in payload.model_dump().items():
        setattr(wo, k, v)
    db.commit()
    db.refresh(wo)
    return CMWorkOrderOut.model_validate(wo)


@router.delete("/cm-work-orders/{wo_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_cm_work_order(
    wo_id: int,
    db: Session = Depends(get_db),
    _user: User = Depends(require_write_access),
) -> None:
    wo = db.get(CMWorkOrder, wo_id)
    if wo is None:
        raise HTTPException(status_code=404, detail=f"CM Work Order {wo_id} not found")
    db.delete(wo)
    db.commit()


@router.post("/analysis/{run_id}/cm-work-orders/generate", response_model=List[CMWorkOrderOut])
def generate_cm_orders_for_run(
    run_id: int,
    db: Session = Depends(get_db),
    _user: User = Depends(require_write_access),
) -> List[CMWorkOrderOut]:
    run = db.get(AnalysisRun, run_id)
    if run is None:
        raise HTTPException(status_code=404, detail=f"Analysis run {run_id} not found")
    results, _ = reconstruct_analysis_results(db, run)
    created = regenerate_cm_work_orders(db, run.plant_id, run.id, results)
    db.commit()
    for item in created:
        db.refresh(item)
    return [CMWorkOrderOut.model_validate(item) for item in created]
