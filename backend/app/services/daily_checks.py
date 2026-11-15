"""Inverter state at the daily O&M checks of the PWA report (09 / 13 / 17).

The checks are snapshots taken CHECK_OFFSET_MIN before the hour (08:50 / 12:50 / 16:50); what a
slot holds is defined in one place, `services/check_slots.py`. This module keeps the inverter
naming helpers and `build_checks`, a thin wrapper over that definition.

Inverters named as replaced in Growatt ("INV 1 old", "GKLNF3901P(old)") are left out: they stay
listed under the plant but never report again, so they would read "offline" every day.
"""

from __future__ import annotations

import re
from datetime import date
from typing import Any, Dict, Optional, Tuple

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db.models import GrowattInverter, GrowattPlant

REPLACED = re.compile(r"\bold\b", re.IGNORECASE)


def is_replaced(inv: GrowattInverter) -> bool:
    return bool(inv.alias and REPLACED.search(inv.alias))


def inverter_label(inv: GrowattInverter) -> str:
    """"INV3" from Growatt aliases such as "INVERTER 3", "inverter 3", "Inverter no.3", "Inverter03"."""
    m = re.search(r"(\d+)\s*$", inv.alias or "")
    if m:
        return f"INV{int(m.group(1))}"
    return inv.alias or inv.device_sn


def _sort_key(label: str) -> Tuple[int, str]:
    m = re.fullmatch(r"INV(\d+)", label)
    return (int(m.group(1)), "") if m else (10**6, label)


def build_checks(db: Session, plant_id: int, day: date) -> Optional[Dict[str, Dict[str, Any]]]:
    """Every check slot of `day` built from stored history now (not frozen, not readiness-gated);
    None without inverters. See check_slots.compute_slots for the fields."""
    from app.services.check_slots import CHECK_HOURS, compute_slots

    plant = db.get(GrowattPlant, plant_id)
    invs = [i for i in db.scalars(select(GrowattInverter).where(GrowattInverter.plant_id == plant_id)) if not is_replaced(i)]
    if plant is None or not invs:
        return None
    return compute_slots(db, plant, day, CHECK_HOURS)
