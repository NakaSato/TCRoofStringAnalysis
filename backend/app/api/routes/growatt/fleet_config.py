"""Settings stored in SQL: the fleet module, a plant's string layout and the tariff."""

from __future__ import annotations

from datetime import date
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from app.auth import allowed_plant_ids, get_current_user, require_admin, require_plant_read, require_plant_write
from app.db.models import User
from app.db.session import get_db
from app.schemas.api_schemas import FleetModule, GrowattStringLayoutEntry, InverterInstalled, Tariff
from app.services import fleet_settings
from app.services import growatt_overview as ov
from app.api.routes.growatt._common import DAY_QUERY, audit

router = APIRouter()


@router.get("/fleet-module")
def get_fleet_module(
    db: Session = Depends(get_db),
    _user: User = Depends(get_current_user),
) -> Dict[str, Any]:
    """PV module used across the fleet (global). `source = "default"` until someone saves it."""
    return fleet_settings.get_fleet_module(db)


@router.put("/fleet-module")
def put_fleet_module(
    payload: FleetModule,
    db: Session = Depends(get_db),
    user: User = Depends(require_admin),
) -> Dict[str, Any]:
    """Save the fleet module (admin only: it applies to every plant) to SQL, then publish `config/fleet_module` to the summary sink.

    A failed publish does not undo the save: the next publish job retries it.
    """
    from app.services import daily_summary  # firebase_admin is imported lazily by the sink

    saved = fleet_settings.put_fleet_module(db, payload.model_dump(), user.username or user.email)
    audit.info("%s saved the fleet module", user.username or user.email)
    return {**saved, "published": _publish_safely(db, lambda: daily_summary.publish_config(db))}


@router.get("/plants/{plant_id}/string-layout")
def get_growatt_string_layout(
    plant_id: int,
    db: Session = Depends(get_db),
    _user: User = Depends(require_plant_read),
) -> Dict[str, Any]:
    """As-built module count per string input (null = not entered), plus inputs seen in the last week.

    Inputs with a removed mark are left out of `strings` and listed in `removed_strings`."""
    try:
        return ov.get_string_layout(db, plant_id)
    except ov.GrowattNotFound as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@router.put("/plants/{plant_id}/string-layout")
def put_growatt_string_layout(
    plant_id: int,
    entries: List[GrowattStringLayoutEntry],
    db: Session = Depends(get_db),
    _user: User = Depends(require_plant_write),
) -> Dict[str, Any]:
    """Replace the plant's module-count registry and removed marks; strings left out are cleared.

    An entry with `removed: true` (no `modules` needed) hides that input from the String Layout
    editor even when it carried current; layout only, its readings and every analysis are
    unchanged. A mark not sent again is cleared. One input twice (in either set) = 422."""
    try:
        saved = ov.put_string_layout(db, plant_id, [e.model_dump() for e in entries])
    except ov.GrowattNotFound as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    from app.services import daily_summary

    return {**saved, "published": _publish_safely(db, lambda: daily_summary.publish_plant_inverters(db, plant_id))}


@router.put("/plants/{plant_id}/inverters/{device_sn}/installed")
def put_inverter_installed(
    plant_id: int,
    device_sn: str,
    payload: InverterInstalled,
    db: Session = Depends(get_db),
    user: User = Depends(require_admin),
) -> Dict[str, Any]:
    """Mark an inverter Growatt lists as not installed on site (`installed: false`, optional note),
    or clear the mark (admin only). A marked inverter is left out of every job, live call, count
    and analysis, and its active issues are dismissed; its stored rows are kept."""
    from app.services import daily_summary, inverter_install

    who = user.username or user.email
    try:
        out = inverter_install.set_installed(db, plant_id, device_sn, payload.installed, who, payload.note)
    except ov.GrowattNotFound as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    audit.info(
        "%s marked inverter %s of plant %s %s (issues closed: %d)",
        who, device_sn, plant_id, "installed" if payload.installed else "not installed", out["issues_closed"],
    )
    return {**out, "published": _publish_safely(db, lambda: daily_summary.publish_plant_inverters(db, plant_id))}


def _publish_safely(db: Session, fn: Any) -> Dict[str, Any]:
    """Mirror a just-saved registry change to the summary sink. A failure does not undo the
    save (the next publish job retries); it is reported instead."""
    try:
        rep = fn()
        return {"sink": rep.sink, "written": rep.written, "deferred": bool(rep.over_budget)}
    except Exception as exc:  # noqa: BLE001 — sink errors (credentials, network) are reported, not raised
        db.rollback()
        return {"sink": None, "written": 0, "error": str(exc)}


@router.get("/tariff")
def get_tariff(db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> Dict[str, Any]:
    """Electricity tariff (TOU + Ft, per-plant PPA rates). `source = "default"` until an admin saves it.
    `pwa_contract` = the PWA contract prices from the meter criteria file (read only, for the
    Settings page; not part of the tariff and not published). Engineers get the plant rates and
    PWA plant ids of their own plants only."""
    from app.services import tariff

    allowed = allowed_plant_ids(db, user)
    t = tariff.get_tariff(db)
    if allowed is not None:
        t["plant_rates"] = {k: v for k, v in (t.get("plant_rates") or {}).items() if int(k) in allowed}
    return {**t, "pwa_contract": _pwa_contract(db, allowed)}


def _pwa_contract(db: Session, allowed: Optional[Any] = None) -> Optional[Dict[str, Any]]:
    from app.services import pwa_meter, tariff

    try:
        c = pwa_meter.criteria()
        ids = sorted(int(k) for k in tariff.pwa_plant_rates(db))
    except Exception:  # noqa: BLE001 — no criteria file / table: the page shows no PWA block
        return None
    if allowed is not None:
        ids = [i for i in ids if i in allowed]
    return {**c.get("tariff", {}), "criteria_version": c.get("version"), "plant_ids": ids}


@router.post("/tariff/pwa-rates")
def post_tariff_pwa_rates(db: Session = Depends(get_db), user: User = Depends(require_admin)) -> Dict[str, Any]:
    """Give every PWA meter-report plant without a flat rate the contract's book price (admin);
    rates already entered are kept. Publishes `config/tariff` when something was added."""
    from app.services import daily_summary, tariff

    who = user.username or user.email
    res = tariff.fill_pwa_plant_rates(db, who, apply=True)
    published = None
    if res["applied"]:
        audit.info("%s set the PWA contract price on %d plants", who, res["added"])
        published = _publish_safely(db, lambda: daily_summary.publish_config(db))
    return {**res, "tariff": {**tariff.get_tariff(db), "pwa_contract": _pwa_contract(db)}, "published": published}


@router.get("/tariff/rates")
def get_tariff_rates(
    day: Optional[date] = DAY_QUERY, db: Session = Depends(get_db), user: User = Depends(get_current_user)
) -> Dict[str, Any]:
    """Each visible plant's THB/kWh for `day` (default today): its flat rate, else the TOU rate
    weighted by the on-peak share of its stored AC power that day. DB only; an estimate."""
    from app.services import jobs, tariff

    d = day or jobs._today()
    rates = tariff.day_rates(db, d, allowed_plant_ids(db, user))
    return {"day": d.isoformat(), "plants": {str(k): v for k, v in rates.items()}, "meta": {"source": "db", "estimated": True}}


@router.put("/tariff")
def put_tariff(payload: Tariff, db: Session = Depends(get_db), user: User = Depends(require_admin)) -> Dict[str, Any]:
    """Save the tariff (admin), then publish `config/tariff`. Lost-energy baht use it from the
    next `rules_*` run; a changed on-peak window applies to past days after `rules_backfill`."""
    from app.services import daily_summary, tariff

    who = user.username or user.email
    old = tariff.get_tariff(db)
    saved = tariff.put_tariff(db, payload.model_dump(), who)
    for k in tariff.DEFAULT_TARIFF:
        if old.get(k) != saved.get(k):
            audit.info("%s changed tariff %s: %s -> %s", who, k, old.get(k), saved.get(k))
    return {**saved, "pwa_contract": _pwa_contract(db), "published": _publish_safely(db, lambda: daily_summary.publish_config(db))}
