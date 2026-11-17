"""I-V curve sweeps of a plant (DB only)."""

from __future__ import annotations

from typing import Any, Dict, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from app.auth import require_plant_read, require_plant_write
from app.db.models import User
from app.db.session import get_db
from app.schemas.api_schemas import IvSweepCreate, IvSweepPatch
from app.services import growatt_overview as ov
from app.api.routes.growatt._common import audit

router = APIRouter()


# --------------------------------------------------------------------------- I-V curve sweeps


@router.get("/plants/{plant_id}/iv-sweeps")
def list_plant_iv_sweeps(
    plant_id: int,
    sn: Optional[str] = Query(None, max_length=64),
    string_no: Optional[int] = Query(None, ge=1, le=64),
    limit: int = Query(50, ge=1, le=200),
    db: Session = Depends(get_db),
    _user: User = Depends(require_plant_read),
) -> Dict[str, Any]:
    """Stored I–V curve sweeps for a plant (optionally narrowed to one inverter/string),
    including IEC 60891 Procedure 1 STC translation, extracted parameters, fault signature,
    and two-source warranty status."""
    from app.services import growatt_iv

    try:
        sweeps = growatt_iv.list_iv_sweeps(db, plant_id, device_sn=sn, string_no=string_no, limit=limit)
    except ov.GrowattNotFound as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    return {"plant_id": plant_id, "sweeps": sweeps, "meta": {"source": "db"}}


@router.get("/plants/{plant_id}/iv-sweeps/site-coefficients")
def get_plant_iv_site_coefficients(
    plant_id: int,
    sn: str = Query(..., min_length=1, max_length=64),
    string_no: int = Query(..., ge=1, le=64),
    db: Session = Depends(get_db),
    _user: User = Depends(require_plant_read),
) -> Dict[str, Any]:
    """Voc at STC, β, Procedure 2 B1, Rs and κ fitted from one string's stored handheld sweeps, plus
    IEC 60891 Procedure 3 between its lowest- and highest-irradiance sweeps. Computed on read,
    nothing is stored or applied; a value the sweeps cannot determine is null with a reason."""
    from app.services import growatt_iv

    try:
        return growatt_iv.site_coefficients(db, plant_id, sn, string_no)
    except ov.GrowattNotFound as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@router.post("/plants/{plant_id}/iv-sweeps", status_code=201)
def create_plant_iv_sweep(
    plant_id: int,
    payload: IvSweepCreate,
    db: Session = Depends(get_db),
    user: User = Depends(require_plant_write),
) -> Dict[str, Any]:
    """Upload and analyze a measured I–V curve sweep (string or module level).
    Requires irradiance_wm2 (G), module_temp_c (T), and swept_at timestamp with every curve."""
    from app.services import growatt_iv

    who = user.username or user.email
    try:
        out = growatt_iv.create_iv_sweep(db, plant_id, payload.model_dump(), who)
    except ov.GrowattNotFound as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    audit.info("%s uploaded I-V sweep #%s for plant %s (%s)", who, out["id"], plant_id, out["signature"])
    return out


@router.patch("/plants/{plant_id}/iv-sweeps/{sweep_id}")
def patch_plant_iv_sweep(
    plant_id: int,
    sweep_id: int,
    payload: IvSweepPatch,
    db: Session = Depends(get_db),
    user: User = Depends(require_plant_write),
) -> Dict[str, Any]:
    """Update IR confirmation (`ir_confirmed`) or notes on an I–V sweep and recompute two-source
    warranty agreement."""
    from app.services import growatt_iv

    who = user.username or user.email
    try:
        out = growatt_iv.patch_iv_sweep(
            db, plant_id, sweep_id, ir_confirmed=payload.ir_confirmed, note=payload.note
        )
    except ov.GrowattNotFound as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    audit.info("%s updated I-V sweep #%s for plant %s", who, sweep_id, plant_id)
    return out
