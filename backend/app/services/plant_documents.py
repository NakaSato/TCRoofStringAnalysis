"""Per-plant document links (docs/plans/plant-asbuilt-links.md): the newest as-built drawing PDF
and the site photo folder on Google Drive. Links only; SQL only (never Firestore).

`matched` rows come from the Drive name matcher (`backend/scripts/drive_asbuilt_match.py`), `manual`
rows from an admin. An import never overwrites a `manual` row.
"""

from __future__ import annotations

import re
from typing import Any, Dict, Iterable, List, Optional, Set

from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from app.db.models import GrowattPlant, PlantDocument, User
from app.services.growatt_common import GrowattNotFound

KINDS = ("asbuilt", "site_photos")
_DRIVE_ID = re.compile(r"/(?:file/d|drive/folders)/([A-Za-z0-9_-]{10,})")


class DocumentError(ValueError):
    """Bad input (422)."""


def _who(user: Optional[User]) -> Optional[str]:
    return None if user is None else (user.username or user.email)


def out(d: PlantDocument) -> Dict[str, Any]:
    return {
        "kind": d.kind,
        "url": d.url,
        "title": d.title,
        "revision": d.revision,
        "source": d.source,
        "match_score": d.match_score,
        "updated_by": d.updated_by,
        "updated_at": d.updated_at.isoformat() if d.updated_at else None,
    }


def for_plant(db: Session, plant_id: int) -> Dict[str, Dict[str, Any]]:
    """{kind: link} of one plant (kinds without a link are left out)."""
    rows = db.scalars(select(PlantDocument).where(PlantDocument.plant_id == plant_id))
    return {d.kind: out(d) for d in rows}


def list_all(db: Session, allowed: Optional[Set[int]]) -> List[Dict[str, Any]]:
    """One row per visible plant with its links (null where none), for the Settings table."""
    q = select(GrowattPlant.plant_id, GrowattPlant.name, GrowattPlant.phase).order_by(GrowattPlant.phase, GrowattPlant.name)
    if allowed is not None:
        q = q.where(GrowattPlant.plant_id.in_(allowed or {-1}))
    plants = list(db.execute(q))
    docs: Dict[int, Dict[str, Dict[str, Any]]] = {}
    dq = select(PlantDocument)
    if allowed is not None:
        dq = dq.where(PlantDocument.plant_id.in_(allowed or {-1}))
    for d in db.scalars(dq):
        docs.setdefault(d.plant_id, {})[d.kind] = out(d)
    return [
        {"plant_id": pid, "name": name, "phase": phase, **{k: docs.get(pid, {}).get(k) for k in KINDS}}
        for pid, name, phase in plants
    ]


def _check(kind: str, url: str) -> str:
    if kind not in KINDS:
        raise DocumentError(f"kind must be one of {', '.join(KINDS)}")
    url = (url or "").strip()
    if not re.match(r"^https://", url, re.I) or len(url) > 1000:
        raise DocumentError("url must be an https link (at most 1000 characters)")
    return url


def put(db: Session, user: User, plant_id: int, kind: str, url: str, title: Optional[str] = None) -> Dict[str, Any]:
    """An admin's link (source `manual`): replaces whatever the plant had for that kind."""
    url = _check(kind, url)
    if db.get(GrowattPlant, plant_id) is None:
        raise GrowattNotFound(f"Plant {plant_id} not found")
    d = db.scalar(select(PlantDocument).where(PlantDocument.plant_id == plant_id, PlantDocument.kind == kind))
    if d is None:
        d = PlantDocument(plant_id=plant_id, kind=kind)
        db.add(d)
    m = _DRIVE_ID.search(url)
    d.url = url
    d.drive_id = m.group(1) if m else None
    d.title = (title or "").strip()[:300] or None
    d.revision = None
    d.source = "manual"
    d.match_score = None
    d.updated_by = _who(user)
    db.commit()
    return out(d)


def remove(db: Session, plant_id: int, kind: str) -> bool:
    if kind not in KINDS:
        raise DocumentError(f"kind must be one of {', '.join(KINDS)}")
    n = db.execute(delete(PlantDocument).where(PlantDocument.plant_id == plant_id, PlantDocument.kind == kind)).rowcount
    db.commit()
    return bool(n)


def import_rows(db: Session, rows: Iterable[Dict[str, Any]], apply: bool, who: Optional[str]) -> Dict[str, Any]:
    """Matched links from the Drive matcher: upsert as `matched`, never over a `manual` row.

    Each row: plant_id, kind, url, drive_id?, title?, revision?, match_score?. Unknown plants and
    bad rows are reported, not written. `apply=False` only counts (dry run)."""
    known = set(db.scalars(select(GrowattPlant.plant_id)))
    existing = {(d.plant_id, d.kind): d for d in db.scalars(select(PlantDocument))}
    counts = {"created": 0, "updated": 0, "unchanged": 0, "kept_manual": 0}
    errors: List[str] = []
    seen: Set[tuple] = set()
    for i, r in enumerate(rows, 1):
        try:
            pid = int(r["plant_id"])
            kind = str(r["kind"])
            url = _check(kind, str(r.get("url") or ""))
        except (KeyError, TypeError, ValueError) as exc:
            errors.append(f"row {i}: {exc}")
            continue
        if pid not in known:
            errors.append(f"row {i}: plant {pid} not in the registry")
            continue
        if (pid, kind) in seen:
            errors.append(f"row {i}: plant {pid} {kind} given twice")
            continue
        seen.add((pid, kind))
        d = existing.get((pid, kind))
        if d is not None and d.source == "manual":
            counts["kept_manual"] += 1
            continue
        fields = {
            "url": url,
            "drive_id": (str(r.get("drive_id") or "") or None),
            "title": (str(r.get("title") or "")[:300] or None),
            "revision": (str(r.get("revision") or "")[:16] or None),
            "match_score": float(r["match_score"]) if r.get("match_score") not in (None, "") else None,
        }
        if d is not None and all(getattr(d, k) == v for k, v in fields.items()):
            counts["unchanged"] += 1
            continue
        counts["updated" if d is not None else "created"] += 1
        if not apply:
            continue
        if d is None:
            d = PlantDocument(plant_id=pid, kind=kind)
            db.add(d)
        for k, v in fields.items():
            setattr(d, k, v)
        d.source = "matched"
        d.updated_by = who
    if apply:
        db.commit()
    return {"applied": apply, **counts, "errors": errors}


def delete_plant_rows(db: Session, plant_ids: Iterable[int]) -> None:
    """The blocked-plant cleanup (no commit)."""
    ids = list(plant_ids)
    if ids:
        db.execute(delete(PlantDocument).where(PlantDocument.plant_id.in_(ids)))
