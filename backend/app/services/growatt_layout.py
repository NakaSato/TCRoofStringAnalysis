"""String layout (modules x Wp per string input) and which inputs are wired, from stored history.

Split out of `growatt_overview`, which re-exports these names. Timestamps are plant-local
(Thai) time; values that cannot be computed from stored data are `None`.
"""

from __future__ import annotations

import time as _time
from datetime import datetime, timedelta
from typing import Any, Dict, Iterable, Optional, Sequence, Set, Tuple

from sqlalchemy import delete, func, select
from sqlalchemy.orm import Session

from app.services.fleet_settings import get_fleet_module
from app.db.models import (
    GrowattInverter,
    GrowattStringLayout,
)
from app.services.growatt_common import INACTIVE_MAX_A, S, _get_plant


# --------------------------------------------------------------------------- string layout

# (device_sn, string_no) -> (modules, module_wp or None)
Layout = Dict[Tuple[str, int], Tuple[int, Optional[float]]]

LAYOUT_SEEN_LOOKBACK = timedelta(days=7)


def load_layout(db: Session, sns: Sequence[str], fleet_wp: bool = True) -> Layout:
    """Registry rows for `sns`. A string without its own `module_wp` gets the fleet module's
    rating (global setting) unless `fleet_wp` is False (raw rows, for the editor)."""
    if not sns:
        return {}
    default_wp = get_fleet_module(db).get("wp") if fleet_wp else None
    return {
        (r.device_sn, int(r.string_no)): (int(r.modules), r.module_wp if r.module_wp is not None else default_wp)
        for r in db.scalars(select(GrowattStringLayout).where(GrowattStringLayout.device_sn.in_(list(sns))))
    }


def load_layout_orientations(
    db: Session, sns: Sequence[str]
) -> Dict[Tuple[str, int], Tuple[Optional[float], Optional[float]]]:
    """Orientation and tilt `(azimuth_deg, tilt_deg)` per string input for `sns`."""
    if not sns:
        return {}
    return {
        (r.device_sn, int(r.string_no)): (r.azimuth_deg, r.tilt_deg)
        for r in db.scalars(select(GrowattStringLayout).where(GrowattStringLayout.device_sn.in_(list(sns))))
    }


WIRED_LOOKBACK = timedelta(days=30)
WIRED_CACHE_S = 6 * 3600
_wired_cache: Dict[Tuple[str, ...], Tuple[float, Dict[str, Set[int]]]] = {}


def newest_string_ts(db: Session, sns: Sequence[str], string_no: Optional[int] = None) -> Optional[datetime]:
    """Newest stored string record of these inverters (optionally one input), or None.

    One lookup per inverter in primary-key order (device_sn, timestamp, …), so each is a short
    backward index read. `max(timestamp) WHERE device_sn IN (…)` lets Postgres walk the
    timestamp index instead, which for an inverter without recent string rows reads most of the
    (GB-sized) table: minutes per call on the production VM."""
    best: Optional[datetime] = None
    for sn in dict.fromkeys(sns):
        q = select(S.timestamp).where(S.device_sn == sn)
        if string_no is not None:
            q = q.where(S.string_no == string_no)
        ts = db.scalar(q.order_by(S.device_sn.desc(), S.timestamp.desc()).limit(1))
        if ts is not None and (best is None or ts > best):
            best = ts
    return best


def wired_inputs(db: Session, sns: Sequence[str]) -> Dict[str, Set[int]]:
    """String inputs known to be connected, per inverter: String Layout rows plus inputs that
    carried current in the last `WIRED_LOOKBACK`. Wiring changes rarely, so the answer is kept
    in memory for `WIRED_CACHE_S` (the history scan is the expensive part). An inverter with
    neither is absent (wiring unknown)."""
    key = tuple(sorted(sns))
    hit = _wired_cache.get(key)
    if hit and _time.monotonic() - hit[0] < WIRED_CACHE_S:
        return hit[1]
    out: Dict[str, Set[int]] = {}
    for sn, sno in load_layout(db, sns, fleet_wp=False):
        out.setdefault(sn, set()).add(sno)
    latest = newest_string_ts(db, sns)
    if latest is not None:
        for sn, sno in db.execute(
            select(S.device_sn, S.string_no)
            .where(S.device_sn.in_(list(sns)), S.timestamp >= latest - WIRED_LOOKBACK, S.current_a > INACTIVE_MAX_A)
            .group_by(S.device_sn, S.string_no)
        ):
            out.setdefault(sn, set()).add(int(sno))
    _wired_cache[key] = (_time.monotonic(), out)
    return out


def get_string_layout(db: Session, plant_id: int) -> Dict[str, Any]:
    """Module count per string input of a plant: registry rows plus inputs seen in the last week.

    `modules` is null where nobody has entered it yet; nothing is guessed.
    """
    plant = _get_plant(db, plant_id)
    invs = list(
        db.scalars(select(GrowattInverter).where(GrowattInverter.plant_id == plant_id).order_by(GrowattInverter.device_sn))
    )
    sns = [inv.device_sn for inv in invs]
    layout = load_layout(db, sns, fleet_wp=False)
    orientations = load_layout_orientations(db, sns)
    seen: Dict[Tuple[str, int], int] = {}
    latest = newest_string_ts(db, sns)
    if latest is not None:
        for sn, sno, mppt in db.execute(
            select(S.device_sn, S.string_no, func.max(S.mppt_no))
            .where(S.device_sn.in_(sns), S.timestamp >= latest - LAYOUT_SEEN_LOOKBACK, S.current_a > INACTIVE_MAX_A)
            .group_by(S.device_sn, S.string_no)
        ):
            seen[(sn, int(sno))] = int(mppt)
    out = []
    for inv in invs:
        nos = sorted({n for s, n in seen if s == inv.device_sn} | {n for s, n in layout if s == inv.device_sn})
        out.append(
            {
                "device_sn": inv.device_sn,
                "model": inv.model or "",
                "strings": [
                    {
                        "string_no": n,
                        "mppt_no": seen.get((inv.device_sn, n), (n + 1) // 2),
                        "modules": layout[(inv.device_sn, n)][0] if (inv.device_sn, n) in layout else None,
                        "module_wp": layout[(inv.device_sn, n)][1] if (inv.device_sn, n) in layout else None,
                        "azimuth_deg": orientations[(inv.device_sn, n)][0] if (inv.device_sn, n) in orientations else None,
                        "tilt_deg": orientations[(inv.device_sn, n)][1] if (inv.device_sn, n) in orientations else None,
                        "active": (inv.device_sn, n) in seen,
                    }
                    for n in nos
                ],
            }
        )
    return {
        "plant_id": plant.plant_id,
        "plant_name": plant.name,
        # used for strings whose module_wp is null
        "fleet_module_wp": get_fleet_module(db).get("wp"),
        "inverters": out,
    }


def put_string_layout(db: Session, plant_id: int, entries: Iterable[Dict[str, Any]]) -> Dict[str, Any]:
    """Replace the plant's module-count registry with `entries` (strings left out are cleared)."""
    _get_plant(db, plant_id)
    sns = set(db.scalars(select(GrowattInverter.device_sn).where(GrowattInverter.plant_id == plant_id)))
    rows: Dict[Tuple[str, int], GrowattStringLayout] = {}
    for e in entries:
        sn = str(e["device_sn"])
        if sn not in sns:
            raise ValueError(f"Inverter {sn} does not belong to plant {plant_id}")
        key = (sn, int(e["string_no"]))
        if key in rows:
            raise ValueError(f"Duplicate entry for {sn} string {key[1]}")
        rows[key] = GrowattStringLayout(
            device_sn=sn,
            string_no=key[1],
            modules=int(e["modules"]),
            module_wp=e.get("module_wp"),
            azimuth_deg=e.get("azimuth_deg"),
            tilt_deg=e.get("tilt_deg"),
        )
    if sns:
        db.execute(delete(GrowattStringLayout).where(GrowattStringLayout.device_sn.in_(sns)))
    db.add_all(rows.values())
    db.commit()
    return get_string_layout(db, plant_id)
