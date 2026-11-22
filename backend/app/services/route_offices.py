"""Visit Route offices (docs/plans/site-visit-route.md §4 / §5): saved start points.

Static config in SQL (`route_offices`), not plant-scoped: every signed-in user lists them, only
admins write. At most one office is the default, and one always is while any exist: the first
office created becomes it, making another the default clears the old one, and deleting the
default promotes the oldest remaining office (lowest id).
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional

from sqlalchemy import select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.db.models import RouteOffice, User
from app.services.visit_route import usable_location


class OfficeNotFound(LookupError):
    pass


class OfficeConflict(ValueError):
    """Another office already has this name (case-insensitive)."""


class OfficeInvalid(ValueError):
    pass


def name_key(name: str) -> str:
    return name.strip().casefold()


def office_out(o: RouteOffice) -> Dict[str, Any]:
    return {
        "id": o.id, "name": o.name, "address": o.address, "lat": o.lat, "lon": o.lon,
        "is_default": bool(o.is_default), "created_by": o.created_by,
        "created_at": o.created_at, "updated_at": o.updated_at,
    }


def list_offices(db: Session) -> List[Dict[str, Any]]:
    rows = db.scalars(select(RouteOffice).order_by(RouteOffice.is_default.desc(), RouteOffice.name_key, RouteOffice.id))
    return [office_out(o) for o in rows]


def get_office(db: Session, office_id: int) -> RouteOffice:
    o = db.get(RouteOffice, office_id)
    if o is None:
        raise OfficeNotFound(f"Office {office_id} not found")
    return o


def _check_name(db: Session, name: str, exclude_id: Optional[int] = None) -> str:
    key = name_key(name)
    q = select(RouteOffice.id).where(RouteOffice.name_key == key)
    if exclude_id is not None:
        q = q.where(RouteOffice.id != exclude_id)
    if db.scalar(q) is not None:
        raise OfficeConflict(f"An office named {name.strip()!r} already exists")
    return key


def _check_location(lat: float, lon: float) -> None:
    if not usable_location(lat, lon):
        raise OfficeInvalid("lat / lon is not a usable location (out of range, or 0,0)")


def _clear_default(db: Session, keep_id: Optional[int] = None) -> None:
    q = update(RouteOffice).where(RouteOffice.is_default.is_(True))
    if keep_id is not None:
        q = q.where(RouteOffice.id != keep_id)
    db.execute(q.values(is_default=False))


def _commit(db: Session, name: str) -> None:
    try:
        db.commit()
    except IntegrityError as exc:  # a concurrent write took the name
        db.rollback()
        raise OfficeConflict(f"An office named {name!r} already exists") from exc


def create_office(db: Session, user: User, body: Any) -> Dict[str, Any]:
    name = body.name.strip()
    key = _check_name(db, name)
    _check_location(body.lat, body.lon)
    first = db.scalar(select(RouteOffice.id).limit(1)) is None
    default = bool(body.is_default) or first
    if default:
        _clear_default(db)
    o = RouteOffice(name=name, name_key=key, address=body.address, lat=float(body.lat), lon=float(body.lon),
                    is_default=default, created_by=user.id)
    db.add(o)
    _commit(db, name)
    db.refresh(o)
    return office_out(o)


def update_office(db: Session, office_id: int, body: Any) -> Dict[str, Any]:
    o = get_office(db, office_id)
    sent = body.model_fields_set
    if "name" in sent and body.name is not None:
        name = body.name.strip()
        o.name_key = _check_name(db, name, exclude_id=o.id)
        o.name = name
    if "address" in sent:
        o.address = body.address
    lat = body.lat if "lat" in sent and body.lat is not None else o.lat
    lon = body.lon if "lon" in sent and body.lon is not None else o.lon
    _check_location(lat, lon)
    o.lat, o.lon = float(lat), float(lon)
    if "is_default" in sent and body.is_default is not None:
        if body.is_default:
            _clear_default(db, keep_id=o.id)
            o.is_default = True
        elif o.is_default:
            raise OfficeInvalid("This is the default office: make another office the default instead")
    _commit(db, o.name)
    db.refresh(o)
    return office_out(o)


def delete_office(db: Session, office_id: int) -> Dict[str, Any]:
    o = get_office(db, office_id)
    was_default = bool(o.is_default)
    db.delete(o)
    db.flush()
    new_default: Optional[int] = None
    if was_default:
        nxt = db.scalars(select(RouteOffice).order_by(RouteOffice.created_at, RouteOffice.id).limit(1)).first()
        if nxt is not None:
            nxt.is_default = True
            new_default = nxt.id
    else:
        new_default = db.scalar(select(RouteOffice.id).where(RouteOffice.is_default.is_(True)))
    db.commit()
    return {"id": office_id, "deleted": True, "default_office_id": new_default}
