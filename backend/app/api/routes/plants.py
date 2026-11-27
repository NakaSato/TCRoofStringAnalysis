"""Plant configuration and StringSpec management endpoints."""

from __future__ import annotations

from typing import List
from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from app.auth import require_write_access
from app.db.models import Dataset, Plant, StringSpecModel, User
from app.db.session import get_db
from app.schemas.api_schemas import PlantCreateUpdate, PlantOut, StringSpecSchema

router = APIRouter(prefix="/plants", tags=["Plants & String Specs"])


@router.get("", response_model=List[PlantOut])
def list_plants(db: Session = Depends(get_db)) -> List[PlantOut]:
    plants = db.scalars(select(Plant).order_by(Plant.id.asc())).all()
    return [PlantOut.model_validate(p) for p in plants]


@router.post("", response_model=PlantOut, status_code=status.HTTP_201_CREATED)
def create_plant(
    payload: PlantCreateUpdate,
    db: Session = Depends(get_db),
    _user: User = Depends(require_write_access),
) -> PlantOut:
    plant = Plant(**payload.model_dump())
    db.add(plant)
    db.commit()
    db.refresh(plant)
    return PlantOut.model_validate(plant)


@router.get("/{plant_id}", response_model=PlantOut)
def get_plant(plant_id: int, db: Session = Depends(get_db)) -> PlantOut:
    plant = db.get(Plant, plant_id)
    if plant is None:
        raise HTTPException(status_code=404, detail=f"Plant {plant_id} not found")
    return PlantOut.model_validate(plant)


@router.put("/{plant_id}", response_model=PlantOut)
def update_plant(
    plant_id: int,
    payload: PlantCreateUpdate,
    db: Session = Depends(get_db),
    _user: User = Depends(require_write_access),
) -> PlantOut:
    plant = db.get(Plant, plant_id)
    if plant is None:
        raise HTTPException(status_code=404, detail=f"Plant {plant_id} not found")

    old = (plant.modules_per_string, plant.module_wp, plant.vmp_stc, plant.imp_stc)
    for field_name, val in payload.model_dump().items():
        setattr(plant, field_name, val)

    # The plant-level values are defaults. Strings still on the old default follow the new one;
    # strings set individually (e.g. 16 modules on an 18-module plant) keep their own value.
    for spec in plant.string_specs:
        if spec.modules_per_string == old[0]:
            spec.modules_per_string = int(payload.modules_per_string)
        if spec.module_wp == old[1]:
            spec.module_wp = float(payload.module_wp)
        if spec.vmp_stc == old[2]:
            spec.vmp_stc = float(payload.vmp_stc)
            spec.voc_stc = round(float(payload.vmp_stc) * 1.188, 2)
        if spec.imp_stc == old[3]:
            spec.imp_stc = float(payload.imp_stc)
            spec.isc_stc = round(float(payload.imp_stc) * 1.065, 2)

    db.commit()
    db.refresh(plant)

    # Re-run analysis on the latest dataset if one exists so KPIs reflect new settings
    latest_ds = db.scalar(
        select(Dataset)
        .where(Dataset.plant_id == plant.id)
        .order_by(Dataset.id.desc())
        .limit(1)
    )
    if latest_ds is not None:
        # Imported here: solar_service loads pandas / numpy, which the API start doesn't need
        from app.services.solar_service import execute_and_store_analysis

        execute_and_store_analysis(
            db=db,
            plant=plant,
            dataset=latest_ds,
            target_pr_pct=plant.target_pr_pct,
            tariff_thb_per_kwh=plant.tariff_thb_per_kwh,
            sync_cm_orders=True,
        )

    return PlantOut.model_validate(plant)


@router.get("/{plant_id}/strings", response_model=List[StringSpecSchema])
def get_plant_strings(plant_id: int, db: Session = Depends(get_db)) -> List[StringSpecSchema]:
    plant = db.get(Plant, plant_id)
    if plant is None:
        raise HTTPException(status_code=404, detail=f"Plant {plant_id} not found")
    return [StringSpecSchema.model_validate(s) for s in plant.string_specs]


@router.put("/{plant_id}/strings", response_model=List[StringSpecSchema])
def update_plant_strings(
    plant_id: int,
    specs: List[StringSpecSchema],
    db: Session = Depends(get_db),
    _user: User = Depends(require_write_access),
) -> List[StringSpecSchema]:
    plant = db.get(Plant, plant_id)
    if plant is None:
        raise HTTPException(status_code=404, detail=f"Plant {plant_id} not found")

    db.execute(delete(StringSpecModel).where(StringSpecModel.plant_id == plant_id))
    created: List[StringSpecModel] = []
    for item in specs:
        row = StringSpecModel(
            plant_id=plant_id,
            string_id=item.string_id,
            inverter_id=item.inverter_id,
            mppt_id=item.mppt_id,
            modules_per_string=item.modules_per_string,
            module_wp=item.module_wp,
            voc_stc=item.voc_stc,
            vmp_stc=item.vmp_stc,
            isc_stc=item.isc_stc,
            imp_stc=item.imp_stc,
            temp_coeff_pmax=item.temp_coeff_pmax,
            temp_coeff_voc=item.temp_coeff_voc,
            temp_coeff_isc=item.temp_coeff_isc,
        )
        db.add(row)
        created.append(row)

    db.commit()
    db.refresh(plant)
    return [StringSpecSchema.model_validate(s) for s in plant.string_specs]
