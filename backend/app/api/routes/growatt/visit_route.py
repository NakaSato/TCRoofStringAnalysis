"""Site visit route (`/growatt/routes`, docs/plans/site-visit-route.md §5): phase 1 = `/solve`.

Drive times from Geoapify (hosted, OpenStreetMap), else straight-line estimates; nothing is
stored. Stops and a plant start follow plant access (404 outside the user's plants).
"""

from __future__ import annotations

from typing import Any, Dict

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from app.auth import get_current_user
from app.config import settings
from app.db.models import User
from app.db.session import get_db
from app.schemas.api_schemas import RouteSolveRequest, RouteSolveResponse
from app.services import visit_route as vr
from app.services.growatt_common import GrowattNotFound
from solar_core.visit_route import TooManyStops

router = APIRouter(prefix="/routes")


@router.post("/solve", response_model=RouteSolveResponse)
def solve_route(
    body: RouteSolveRequest,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
    geo: vr.GeoapifyRouter = Depends(vr.get_router),
) -> Dict[str, Any]:
    """Best visit order of the stops with ETA / ETD, legs, the route line and Google Maps links.
    Rate limited per user (`ROUTE_SOLVE_PER_MIN`)."""
    try:
        vr.solve_limiter.hit(user.id, settings.route_solve_per_min)
    except vr.RateLimited as exc:
        raise HTTPException(429, str(exc), headers={"Retry-After": str(int(exc.retry_after_s + 0.999))}) from exc
    try:
        return vr.solve_route(db, user, body, geo)
    except GrowattNotFound as exc:
        raise HTTPException(404, str(exc)) from exc
    except vr.NoLocation as exc:
        raise HTTPException(422, {"message": str(exc), "plants": exc.plants}) from exc
    except TooManyStops as exc:
        raise HTTPException(422, str(exc)) from exc
