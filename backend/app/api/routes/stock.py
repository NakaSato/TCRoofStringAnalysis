"""Spares register (`/stock`, docs/plans/spares-failed-units.md), phases 1–5: parts catalogue, stock
locations, serialised units, the movement ledger, failed units, replacements on site and stock
counts (preview anyone, confirm admin or store keeper). Everyone signed in reads and
makes field moves (transfer, issue, return; a failed unit in and between vans / stores); an admin
or store keeper receives, corrects, edits the catalogue and locations, and sends failed units to /
back from a supplier or scraps them. Installs and failed units on plants a user may not see are
left out (404 for one)."""

from __future__ import annotations

from datetime import date
from typing import Any, Dict, List, Literal, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.auth import get_current_user
from app.db.models import User
from app.db.session import get_db
from app.services import stock as svc
from app.services import stock_count as count_svc
from app.services import stock_failed as failed_svc
from app.services import stock_installed as installed_svc
from app.services import stock_lookup as lookup_svc
from app.services import stock_replace as replace_svc

router = APIRouter(prefix="/stock", tags=["Spares"])


def _call(fn, *args, **kwargs):
    try:
        return fn(*args, **kwargs)
    except svc.StockForbidden as exc:
        raise HTTPException(403, str(exc)) from exc
    except svc.StockNotFound as exc:
        raise HTTPException(404, str(exc)) from exc
    except svc.StockConflict as exc:
        raise HTTPException(409, {"message": str(exc), "errors": exc.errors, **exc.extra}) from exc
    except svc.StockError as exc:
        raise HTTPException(422, str(exc)) from exc


class PartIn(BaseModel):
    code: Optional[str] = Field(None, max_length=40)
    name: Optional[str] = Field(None, max_length=120)
    category: Optional[str] = Field(None, max_length=24)
    make: Optional[str] = Field(None, max_length=64)
    model: Optional[str] = Field(None, max_length=64)
    min_qty: Optional[int] = None
    active: Optional[bool] = None
    serialised: Optional[bool] = None
    note: Optional[str] = Field(None, max_length=2000)


class LocationIn(BaseModel):
    code: Optional[str] = Field(None, max_length=32)
    name: Optional[str] = Field(None, max_length=120)
    kind: Optional[str] = Field(None, max_length=16)
    parent_id: Optional[int] = None
    holder_user_id: Optional[int] = None
    active: Optional[bool] = None
    note: Optional[str] = Field(None, max_length=2000)


class MovementRow(BaseModel):
    kind: Literal["receive", "transfer", "issue", "return"]
    part_id: Optional[int] = None
    unit_id: Optional[int] = None
    serial: Optional[str] = Field(None, max_length=64)
    to_location_id: Optional[int] = None
    plant_id: Optional[int] = None
    note: Optional[str] = Field(None, max_length=2000)
    input_method: Optional[str] = Field(None, max_length=8)
    raw_scan: Optional[str] = Field(None, max_length=512)


class MovementBatch(BaseModel):
    rows: List[MovementRow] = Field(..., min_length=1, max_length=svc.MAX_BATCH)
    day: Optional[date] = None
    note: Optional[str] = Field(None, max_length=2000)


class CorrectionIn(BaseModel):
    note: str = Field(..., min_length=1, max_length=2000)


@router.get("/summary")
def get_summary(db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> Dict[str, Any]:
    return svc.summary(db, user)


@router.get("/parts")
def list_parts(include_inactive: bool = False, db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> List[Dict[str, Any]]:
    return svc.list_parts(db, include_inactive)


@router.post("/parts", status_code=201)
def create_part(body: PartIn, db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> Dict[str, Any]:
    return _call(svc.create_part, db, user, body.model_dump(exclude_unset=True))


@router.patch("/parts/{part_id}")
def update_part(part_id: int, body: PartIn, db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> Dict[str, Any]:
    return _call(svc.update_part, db, user, part_id, body.model_dump(exclude_unset=True))


@router.get("/locations")
def list_locations(include_inactive: bool = False, db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> List[Dict[str, Any]]:
    return svc.list_locations(db, include_inactive)


@router.post("/locations", status_code=201)
def create_location(body: LocationIn, db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> Dict[str, Any]:
    return _call(svc.create_location, db, user, body.model_dump(exclude_unset=True))


@router.patch("/locations/{location_id}")
def update_location(location_id: int, body: LocationIn, db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> Dict[str, Any]:
    return _call(svc.update_location, db, user, location_id, body.model_dump(exclude_unset=True))


@router.get("/people")
def list_people(db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> List[Dict[str, Any]]:
    """Active users' names, for a van's holder."""
    return svc.list_people(db)


@router.get("/units")
def list_units(
    part_id: Optional[int] = None,
    location_id: Optional[int] = None,
    state: Optional[str] = Query(None, max_length=16),
    q: Optional[str] = Query(None, max_length=64),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> List[Dict[str, Any]]:
    return svc.list_units(db, user, part_id, location_id, state, q)


@router.get("/lookup")
def lookup_code(code: str = Query(..., max_length=512), db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> Dict[str, Any]:
    """What a batch-page scan is: `kind` location / unit / part / serial / unknown (DB only, not
    rate limited, never 404; hidden units are not listed)."""
    try:
        return lookup_svc.lookup(db, user, code)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc


@router.get("/movements")
def list_movements(
    kind: Optional[str] = Query(None, max_length=16),
    part_id: Optional[int] = None,
    location_id: Optional[int] = None,
    plant_id: Optional[int] = None,
    serial: Optional[str] = Query(None, max_length=64),
    unit_id: Optional[int] = None,
    limit: int = Query(200, ge=1, le=svc.MAX_LIST),
    offset: int = Query(0, ge=0),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> Dict[str, Any]:
    return svc.list_movements(db, user, kind, part_id, location_id, plant_id, serial, unit_id, limit, offset)


@router.post("/movements/batch", status_code=201)
def post_batch(body: MovementBatch, db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> Dict[str, Any]:
    """All rows or none: 409 with `errors` [{row, error}] when any row does not fit."""
    return _call(svc.apply_batch, db, user, [r.model_dump() for r in body.rows], body.day, body.note)


@router.post("/movements/{movement_id}/correct", status_code=201)
def correct_movement(movement_id: int, body: CorrectionIn, db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> Dict[str, Any]:
    """Reverse a unit's latest movement (admin or store keeper); the original stays in the ledger."""
    return _call(svc.correct, db, user, movement_id, body.note)


# ------------------------------------------------------------------------------- failed units


class FailedUnitIn(BaseModel):
    red_tag: str = Field(..., min_length=1, max_length=512)
    part_id: Optional[int] = None
    serial: Optional[str] = Field(None, max_length=64)
    plant_id: Optional[int] = None
    site_device_id: Optional[int] = None
    inverter_sn: Optional[str] = Field(None, max_length=64)
    removed_day: Optional[date] = None
    fault: str = Field(..., min_length=1, max_length=2000)
    to_location_id: int
    claim_id: Optional[int] = None
    input_method: Optional[Literal["hid", "camera", "photo", "manual"]] = None
    raw_scan: Optional[str] = Field(None, max_length=512)
    note: Optional[str] = Field(None, max_length=2000)


class FailedUnitPatch(BaseModel):
    fault: Optional[str] = Field(None, min_length=1, max_length=2000)
    claim_id: Optional[int] = None
    part_id: Optional[int] = None


class FailedMoveIn(BaseModel):
    kind: Literal["transfer", "ship_out", "supplier_return", "scrap"]
    to_location_id: Optional[int] = None
    outcome: Optional[Literal["repaired", "replaced"]] = None
    new_serial: Optional[str] = Field(None, max_length=64)
    carrier: Optional[str] = Field(None, max_length=64)
    tracking_no: Optional[str] = Field(None, max_length=64)
    note: Optional[str] = Field(None, max_length=2000)


@router.get("/failed-units")
def list_failed_units(
    status: Optional[str] = Query(None, max_length=16),
    plant_id: Optional[int] = None,
    q: Optional[str] = Query(None, max_length=64),
    open: bool = False,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> List[Dict[str, Any]]:
    return failed_svc.list_failed(db, user, status or None, plant_id, q, open)


@router.post("/failed-units", status_code=201)
def create_failed_unit(body: FailedUnitIn, db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> Dict[str, Any]:
    """Bind a red tag to a failed unit (`failed_in`); 409 when the tag is used or the serial is already open."""
    return _call(failed_svc.create, db, user, body.model_dump(exclude_unset=True))


@router.get("/failed-units/{failed_id}")
def get_failed_unit(failed_id: int, db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> Dict[str, Any]:
    return _call(failed_svc.get_failed, db, user, failed_id)


@router.patch("/failed-units/{failed_id}")
def update_failed_unit(failed_id: int, body: FailedUnitPatch, db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> Dict[str, Any]:
    """Fault text, claim link and part; status changes only through `/move`."""
    return _call(failed_svc.update_failed, db, user, failed_id, body.model_dump(exclude_unset=True))


@router.post("/failed-units/{failed_id}/move", status_code=201)
def move_failed_unit(failed_id: int, body: FailedMoveIn, db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> Dict[str, Any]:
    """transfer (anyone) · ship_out / supplier_return / scrap (admin or store keeper)."""
    return _call(failed_svc.move_failed, db, user, failed_id, body.model_dump(exclude_unset=True))


# ------------------------------------------------------------------------------- replacements

Method = Optional[Literal["hid", "camera", "photo", "manual"]]


class ReplacementIn(BaseModel):
    plant_id: int
    site_device_id: Optional[int] = None
    inverter_sn: Optional[str] = Field(None, max_length=64)
    old_serial: str = Field(..., min_length=1, max_length=64)
    old_input_method: Method = None
    old_raw_scan: Optional[str] = Field(None, max_length=512)
    confirm_register_update: bool = False
    red_tag: str = Field(..., min_length=1, max_length=512)
    red_tag_input_method: Method = None
    red_tag_raw_scan: Optional[str] = Field(None, max_length=512)
    fault: str = Field(..., min_length=1, max_length=2000)
    new_unit_id: int
    new_input_method: Method = None
    new_raw_scan: Optional[str] = Field(None, max_length=512)
    failed_to_location_id: int
    removed_day: Optional[date] = None
    note: Optional[str] = Field(None, max_length=2000)


@router.get("/replacements/targets")
def replacement_targets(plant_id: int, db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> Dict[str, Any]:
    """The plant's site register devices and installed inverters a crew could replace (404: unknown / not yours)."""
    return _call(replace_svc.targets, db, user, plant_id)


@router.post("/replacements", status_code=201)
def post_replacement(body: ReplacementIn, db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> Dict[str, Any]:
    """Replace a device on site in one transaction: red tag → failed unit, spare installed, register
    serial updated (site devices). 409 `code: register_mismatch` when the label and the register
    disagree and `confirm_register_update` is not set."""
    return _call(replace_svc.replace, db, user, body.model_dump())


# ------------------------------------------------------------------------------------- counts


class CountScan(BaseModel):
    raw: str = Field(..., max_length=512)
    unit_id: Optional[int] = None
    part_id: Optional[int] = None
    input_method: Method = None


class CountPreviewIn(BaseModel):
    location_id: int
    scans: List[CountScan] = Field(default_factory=list, max_length=count_svc.MAX_SCANS)


class CountConfirmIn(CountPreviewIn):
    expected_ids: List[int] = Field(default_factory=list, max_length=svc.MAX_LIST * 10)
    note: Optional[str] = Field(None, max_length=2000)


@router.get("/counts")
def list_counts(location_id: Optional[int] = None, db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> List[Dict[str, Any]]:
    """Recent confirmed counts, newest first (≤ 200)."""
    return count_svc.list_counts(db, location_id)


@router.post("/counts/preview")
def preview_count(body: CountPreviewIn, db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> Dict[str, Any]:
    """What a confirm of these scans would do at the location (anyone signed in; nothing written)."""
    return _call(count_svc.preview, db, user, body.location_id, [s.model_dump() for s in body.scans])


@router.post("/counts", status_code=201)
def confirm_count(body: CountConfirmIn, db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> Dict[str, Any]:
    """Confirm a count (admin or store keeper): one batch of `count_adjust` movements. 409 with the
    rows that need a decision (needs_part / ambiguous / blocked), or `code: stock_changed` when the
    location's stock is not what the preview showed (`expected_ids`)."""
    return _call(count_svc.confirm, db, user, body.location_id, [s.model_dump() for s in body.scans], body.expected_ids, body.note)


# ------------------------------------------------------- installed equipment (registry links)
# docs/plans/inventory-installed-base.md: read from the Growatt registry and the site register.


class FromModelItem(BaseModel):
    # loose limits: the catalogue's own validation answers per row (409 `errors`)
    category: Optional[str] = Field(None, max_length=200)
    model: Optional[str] = Field(None, max_length=200)
    make: Optional[str] = Field(None, max_length=200)
    code: Optional[str] = Field(None, max_length=200)
    name: Optional[str] = Field(None, max_length=200)


class FromModelsIn(BaseModel):
    apply: bool = False
    items: Optional[List[FromModelItem]] = Field(None, max_length=svc.MAX_BATCH)


@router.get("/installed")
def list_installed(
    category: Optional[str] = Query(None, max_length=24),
    plant_id: Optional[int] = None,
    phase: Optional[int] = None,
    q: Optional[str] = Query(None, max_length=120),
    limit: int = Query(500, ge=1, le=installed_svc.MAX_INSTALLED_LIMIT),
    offset: int = Query(0, ge=0),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> Dict[str, Any]:
    """Every installed device the user may see (inverters, dataloggers, site register devices, grid
    meters); `counts` per category over every filter but `category`, before limit."""
    return installed_svc.installed(db, user, category or None, plant_id, phase, q, limit, offset)


@router.get("/installed/models")
def list_installed_models(db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> Dict[str, Any]:
    """Installed vs in stock vs failed per (category, model) and phase; counts only."""
    return installed_svc.models(db, user)


@router.post("/parts/from-models")
def parts_from_models(body: FromModelsIn, db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> Dict[str, Any]:
    """Admin or store keeper: `apply: false` proposes catalogue parts for the installed models;
    `apply: true` creates `items`, all or nothing (409 `errors` [{row, error}])."""
    if not body.apply:
        return _call(installed_svc.proposals, db, user)
    return _call(installed_svc.apply, db, user, [i.model_dump() for i in body.items or []])


@router.get("/registry-where")
def registry_where(serials: str = Query("", max_length=20000), db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> Dict[str, Any]:
    """Where the registry has each serial (≤ 200, each ≤ 64; 422 otherwise); plants the user may not see are left out."""
    return _call(installed_svc.registry_where, db, user, serials)
