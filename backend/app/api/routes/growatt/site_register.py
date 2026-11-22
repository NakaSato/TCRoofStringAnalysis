"""O&M site register (docs/plans/om-asset-network.md): station data and on-site devices per plant.

DB only. A plant's register follows plant access (admin, or the engineer assigned the plant); the fleet list
filters by `allowed_plant_ids`; the import is admin only; a plant's devices are edited by whoever may write
the plant (admin, or the assigned engineer). Network details stay out of the logs (counts only).
"""

from __future__ import annotations

import json
from typing import Any, Dict, List

from fastapi import APIRouter, Depends, File, HTTPException, Query, Response, UploadFile
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.auth import allowed_plant_ids, get_current_user, require_admin, require_plant_read, require_plant_write
from app.db.models import User
from app.db.session import get_db
from app.services import site_register as svc
from app.api.routes.growatt._common import audit

router = APIRouter()

MAX_UPLOAD_BYTES = 10 * 2**20


@router.get("/site-register")
def list_site_register(db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> Dict[str, Any]:
    """Every station the user may see (engineers: their plants' stations), with device counts."""
    return {"sites": svc.list_all(db, allowed_plant_ids(db, user)), "kinds": list(svc.KINDS), "meta": {"source": "db"}}


@router.get("/site-register/provinces")
def site_register_provinces(db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> Dict[str, Any]:
    """{plant_id: province} from the register (the plant directory's province filter)."""
    return {"provinces": {str(k): v for k, v in svc.provinces(db, allowed_plant_ids(db, user)).items()}}


@router.get("/site-register/export")
def export_site_register(db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> Response:
    """The register as .xlsx in the O&M workbook's layout (engineers: their plants' stations); imports again."""
    data = svc.export_workbook(db, allowed_plant_ids(db, user))
    audit.info("site register exported by %s", user.username or user.email)
    return Response(
        content=data,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": "attachment; filename=\"OM-Asset-Network-export.xlsx\""},
    )


@router.get("/plants/{plant_id}/site-register")
def get_plant_site_register(plant_id: int, db: Session = Depends(get_db), _: User = Depends(require_plant_read)) -> Dict[str, Any]:
    """The plant's station, devices and checks; `register` null when the plant has no station."""
    return {"plant_id": plant_id, "register": svc.for_plant(db, plant_id), "meta": {"source": "db"}}


class DevicesIn(BaseModel):
    devices: List[Dict[str, Any]]


@router.put("/plants/{plant_id}/site-register/devices")
def put_plant_site_devices(
    plant_id: int, body: DevicesIn, db: Session = Depends(get_db), user: User = Depends(require_plant_write)
) -> Dict[str, Any]:
    """Replace the station's devices with the edited list (admin, or the engineer assigned the plant); 404 when
    the plant has no station. A later workbook import replaces the devices again."""
    try:
        reg = svc.replace_devices(db, plant_id, body.devices)
    except svc.RegisterError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    if reg is None:
        raise HTTPException(status_code=404, detail="This plant has no station in the site register")
    audit.info("site register devices of %s edited by %s: %d devices", reg["site"]["site_code"], user.username or user.email, len(reg["devices"]))
    return {"plant_id": plant_id, "register": reg, "meta": {"source": "db"}}


@router.post("/site-register/import")
async def import_site_register(
    file: UploadFile = File(..., description="the register workbook (.xlsx) or its JSON conversion (.json)"),
    apply: bool = Query(False),
    db: Session = Depends(get_db),
    user: User = Depends(require_admin),
) -> Dict[str, Any]:
    """Preview (default) or, with `apply=true`, replace the register with the file (all or nothing)."""
    name = file.filename or "register"
    data = await file.read(MAX_UPLOAD_BYTES + 1)
    if len(data) > MAX_UPLOAD_BYTES:
        raise HTTPException(status_code=413, detail=f"file over {MAX_UPLOAD_BYTES // 2**20} MB")
    try:
        if name.lower().endswith(".json"):
            try:
                doc = json.loads(data.decode("utf-8"))
            except (UnicodeDecodeError, json.JSONDecodeError) as exc:
                raise svc.RegisterError(f"not valid JSON: {exc}") from exc
        elif name.lower().endswith((".xlsx", ".xlsm")):
            doc = svc.convert_workbook(data, source_name=name)
        else:
            raise svc.RegisterError("only .xlsx or .json")
        out = svc.import_register(db, doc, apply=apply, who=user.username or user.email)
    except svc.RegisterError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    if out["applied"]:
        audit.info(
            "site register imported by %s: %d stations, %d devices, %d matched, %d removed",
            user.username or user.email, out["sites"], out["devices"], out["matched"], len(out["removed"]),
        )
        # mirror station code / phase / province / COD to Firestore plants/{id} (only changed docs are written)
        from app.api.routes.growatt.fleet_config import _publish_safely
        from app.services import daily_summary

        out["published"] = _publish_safely(db, lambda: daily_summary.publish_plants(db))
    return out
