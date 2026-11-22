"""Site visit route, phase 2 (`/growatt/routes/candidates`, docs/plans/site-visit-route.md §2, §5).

The plants worth visiting on a day with their reasons (Calendar tasks, issues, open fault alarms,
claims due, overdue cleaning / PM). DB only, scoped to the user's plants; nothing is stored.
"""

from __future__ import annotations

from datetime import date
from typing import Any, Dict, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from app.auth import allowed_plant_ids, get_current_user
from app.db.models import User
from app.db.session import get_db
from app.schemas.api_schemas import RouteCandidatesResponse
from app.services import visit_route_candidates as vrc
from app.services.growatt_common import GrowattNotFound

router = APIRouter(prefix="/routes")


@router.get("/candidates", response_model=RouteCandidatesResponse)
def route_candidates(
    day: Optional[date] = Query(None, description="Plant-local day (default today, Bangkok)"),
    team_id: Optional[int] = Query(None, description="Only this team's Calendar tasks (other reasons are not filtered)"),
    user_id: Optional[int] = Query(None, description="Only this person's Calendar tasks, direct or via a team"),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> Dict[str, Any]:
    """Plants to visit on `day`, ranked, each with its reasons and a default time on site. Only
    plants with a reason are listed. THB/day is estimated. An unknown team or user answers 404."""
    try:
        return vrc.candidates(db, user, allowed_plant_ids(db, user), day, team_id=team_id, user_id=user_id)
    except GrowattNotFound as exc:
        raise HTTPException(404, str(exc)) from exc
