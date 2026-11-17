"""Shared by the Growatt route modules."""

from __future__ import annotations

import logging
from typing import Optional, Set

from fastapi import Query
from sqlalchemy.orm import Session

from app.auth import allowed_plant_ids
from app.db.models import User

audit = logging.getLogger("app.audit")

DAY_QUERY = Query(None, description="Plant-local date (YYYY-MM-DD); default = latest day with data")


def sensor_scope(db: Session, user: User, plant_id: Optional[int]) -> Optional[Set[int]]:
    """Plants whose sensors a request covers: the user's visible plants, narrowed to `plant_id`
    when given (an invisible plant gives the empty set, so nothing is revealed)."""
    allowed = allowed_plant_ids(db, user)
    if plant_id is None:
        return allowed
    return {plant_id} if allowed is None or plant_id in allowed else set()
