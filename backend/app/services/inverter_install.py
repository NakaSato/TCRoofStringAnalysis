"""Inverters listed in Growatt but not installed on site.

Growatt's `device/list` can name an inverter that was never installed on the roof (registered
in the portal ahead of time, or for another plant). Such an inverter never reports, so it would
read "offline" everywhere and pull down plant counts, availability and the decision rules. An
admin marks it (`growatt_inverters.not_installed_at`); `inverter_installed()` then leaves it out
of every job (no Growatt calls), live call, count and analysis. Its stored rows are kept, and
clearing the mark brings it back on the next runs. The `fleet` job never touches the mark.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Dict, Optional

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db.models import GrowattInverter, GrowattIssue
from app.services.growatt_common import GrowattNotFound, inverter_out

ACTIVE_ISSUES = ("open", "acknowledged")
CLOSE_REASON = "not_installed"
NOTE_MAX = 255


def set_installed(
    db: Session, plant_id: int, device_sn: str, installed: bool, username: str, note: Optional[str] = None
) -> Dict[str, Any]:
    """Mark (installed false) or clear (installed true) the plant's inverter. Marking dismisses
    the inverter's and its strings' active issues (`close_reason = not_installed`); clearing
    reopens nothing. Returns the inverter (`inverter_out`) and `issues_closed`. Commits."""
    inv = db.scalar(
        select(GrowattInverter).where(GrowattInverter.plant_id == plant_id, GrowattInverter.device_sn == device_sn)
    )
    if inv is None:
        raise GrowattNotFound(f"Inverter {device_sn} not found on plant {plant_id}")
    text = (note or "").strip() or None
    if text is not None and len(text) > NOTE_MAX:
        raise ValueError(f"The note is longer than {NOTE_MAX} characters")
    closed = 0
    if installed:
        inv.not_installed_at = inv.not_installed_by = inv.not_installed_note = None
    else:
        now = datetime.now(timezone.utc)
        if inv.not_installed_at is None:
            inv.not_installed_at, inv.not_installed_by = now, username
        inv.not_installed_note = text
        for issue in db.scalars(
            select(GrowattIssue).where(
                GrowattIssue.plant_id == plant_id,
                GrowattIssue.device_sn == device_sn,
                GrowattIssue.status.in_(ACTIVE_ISSUES),
            )
        ):
            issue.status = "dismissed"
            issue.close_reason = CLOSE_REASON
            issue.closed_at, issue.closed_by = now, username
            closed += 1
    db.commit()
    return {"inverter": inverter_out(inv), "issues_closed": closed}


def not_installed_sns(db: Session, plant_ids: Optional[Any] = None) -> set[str]:
    """Serials of the inverters marked not installed (of `plant_ids`, or the whole fleet)."""
    q = select(GrowattInverter.device_sn).where(GrowattInverter.not_installed_at.is_not(None))
    if plant_ids is not None:
        q = q.where(GrowattInverter.plant_id.in_(list(plant_ids)))
    return set(db.scalars(q))
