"""Printable labels (docs/plans/barcode-scanning.md §6.1, §12 step 5): the data of each label; the
browser draws the QR and lays out the A4 sheet.

A label = `{kind, key, code, path, title, lines}`. `path` is the app path the QR holds as a URL on
the host the sheet is printed from (`/s/<kind>/<code>`, which `/scan/resolve` and the `/s/` route
read); `code` is the short `kind:code` printed under it (§13 decision 2). Only identifiers go on a
label, never personal data.

- `tool`: instruments (all but retired, or the ids asked for). Visible to everyone, as `/tools`.
- `dev`: site register devices of one plant / station, or the ids asked for. Scoped like the
  register: a plant the user may not see answers 404 (not revealed); a station without a plant is
  admin only.
- `rt`: one batch of red tags (`RedTag`). Reserving a batch is admin only.
"""

from __future__ import annotations

import re
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Sequence
from urllib.parse import quote

from sqlalchemy import case, func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.auth import allowed_plant_ids
from app.db.models import Instrument, RedTag, SiteDevice, SiteRegister, User
from app.services.growatt_common import GrowattNotFound
from app.services.scan import _SITE_DEVICE_LABEL, _plant_names, _visible

MAX_RESERVE = 500
MAX_IDS = 500
_RT = re.compile(r"^RT-?(\d{1,6})$", re.IGNORECASE)


def red_tag_code(n: int) -> str:
    return f"RT-{n:04d}"


def parse_red_tag(code: str) -> Optional[int]:
    """The number of `RT-0103` / `rt-103` / `RT103`, or None."""
    m = _RT.match(code.strip())
    return int(m.group(1)) if m else None


def _label(kind: str, code: str, title: str, lines: List[Optional[str]], key: Any) -> Dict[str, Any]:
    return {
        "kind": kind,
        "key": str(key),
        "code": f"{kind}:{code}",
        "path": f"/s/{kind}/{quote(code, safe='')}",
        "title": title,
        "lines": [x for x in lines if x],
    }


def tool_labels(db: Session, ids: Optional[Sequence[int]] = None) -> List[Dict[str, Any]]:
    q = select(Instrument).order_by(Instrument.asset_tag)
    q = q.where(Instrument.id.in_(list(ids))) if ids else q.where(Instrument.status != "retired")
    out = []
    for i in db.scalars(q):
        make_model = " ".join(x for x in (i.make, i.model) if x) or None
        out.append(_label("tool", i.asset_tag, i.asset_tag, [i.name, make_model, f"S/N {i.serial_no}" if i.serial_no else None], i.id))
    return out


def device_labels(
    db: Session, user: User, plant_id: Optional[int] = None, site_code: Optional[str] = None, ids: Optional[Sequence[int]] = None
) -> List[Dict[str, Any]]:
    if plant_id is None and not site_code and not ids:
        raise ValueError("Give plant_id, site_code or ids")
    allowed = allowed_plant_ids(db, user)
    if plant_id is not None and not _visible(allowed, plant_id):
        raise GrowattNotFound(f"Plant {plant_id} not found")
    q = select(SiteDevice, SiteRegister).join(SiteRegister, SiteRegister.site_code == SiteDevice.site_code)
    if plant_id is not None:
        q = q.where(SiteRegister.plant_id == plant_id)
    if site_code:
        q = q.where(SiteRegister.site_code == site_code)
    if ids:
        q = q.where(SiteDevice.id.in_(list(ids)))
    rows = [(d, r) for d, r in db.execute(q.order_by(SiteRegister.site_code, SiteDevice.kind, SiteDevice.seq)) if _visible(allowed, r.plant_id)]
    if site_code and not rows and not ids:
        # an unknown station and one the user may not see look the same
        reg = db.get(SiteRegister, site_code)
        if reg is None or not _visible(allowed, reg.plant_id):
            raise GrowattNotFound(f"Station {site_code} not found")
    names = _plant_names(db, {r.plant_id for _, r in rows if r.plant_id is not None})
    out = []
    for d, r in rows:
        what = _SITE_DEVICE_LABEL.get(d.kind, d.kind) + (f" {d.seq}" if d.seq and d.seq > 1 else "")
        place = names.get(r.plant_id) if r.plant_id is not None else None
        out.append(
            _label(
                "dev",
                str(d.id),
                f"{what} · {r.site_code}",
                [d.brand_model, f"S/N {d.serial}" if d.serial else None, place or r.name],
                d.id,
            )
        )
    return out


def red_tag_labels(db: Session, batch: int) -> List[Dict[str, Any]]:
    tags = list(db.scalars(select(RedTag).where(RedTag.batch == batch).order_by(RedTag.number)))
    if not tags:
        raise GrowattNotFound(f"No red tag batch {batch}")
    # the tag's printed captions are in the UI language, drawn by the browser
    return [_label("rt", t.code, t.code, [], t.id) for t in tags]


def reserve_red_tags(db: Session, user: User, count: int) -> Dict[str, Any]:
    """Reserve `count` new numbers after the highest ever issued, as one batch."""
    if not 1 <= count <= MAX_RESERVE:
        raise ValueError(f"Reserve 1–{MAX_RESERVE} red tags at a time")
    for _attempt in range(3):
        top = db.scalar(select(func.max(RedTag.number))) or 0
        batch = (db.scalar(select(func.max(RedTag.batch))) or 0) + 1
        now = datetime.now(timezone.utc)
        db.add_all(
            RedTag(number=n, code=red_tag_code(n), batch=batch, status="reserved", reserved_by=user.id, reserved_at=now)
            for n in range(top + 1, top + count + 1)
        )
        try:
            db.commit()
        except IntegrityError:  # another admin reserved at the same moment: take the next numbers
            db.rollback()
            continue
        return {"batch": batch, "first": red_tag_code(top + 1), "last": red_tag_code(top + count), "count": count}
    raise RuntimeError("Could not reserve red tags; try again")


def red_tag_batches(db: Session) -> List[Dict[str, Any]]:
    rows = db.execute(
        select(
            RedTag.batch,
            func.min(RedTag.number),
            func.max(RedTag.number),
            func.count(),
            func.sum(case((RedTag.status == "bound", 1), else_=0)),
            func.min(RedTag.reserved_at),
            func.min(User.username),
        )
        .outerjoin(User, User.id == RedTag.reserved_by)
        .group_by(RedTag.batch)
        .order_by(RedTag.batch.desc())
    ).all()
    return [
        {
            "batch": b,
            "first": red_tag_code(lo),
            "last": red_tag_code(hi),
            "count": n,
            "bound": int(bound or 0),
            "reserved_at": at.isoformat() if at else None,
            "reserved_by": by,
        }
        for b, lo, hi, n, bound, at, by in rows
    ]


def red_tag_info(db: Session, code: str) -> Optional[Dict[str, Any]]:
    """A red tag by code (`RT-0103`, `rt-103`), or None."""
    n = parse_red_tag(code)
    if n is None:
        return None
    t = db.scalars(select(RedTag).where(RedTag.number == n)).first()
    if t is None:
        return None
    return {"code": t.code, "status": t.status, "batch": t.batch, "reserved_at": t.reserved_at.isoformat() if t.reserved_at else None}
