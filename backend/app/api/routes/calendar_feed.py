"""Calendar Team: the read-only ICS feed calendar apps subscribe to (services/om_ics.py).

    GET /ics/calendar/{token}.ics

No login: calendar apps send none, so the secret in the URL is the key. An unknown or revoked
token, or an inactive user, gets 404. The request log records only the route template, never
the token.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from sqlalchemy.orm import Session

from app.db.session import get_db
from app.services import om_ics

router = APIRouter(prefix="/ics", tags=["Calendar feed"])


def _origin(request: Request) -> str:
    """The address the user reached: Firebase Hosting forwards its own host to Cloud Run."""
    host = (request.headers.get("x-forwarded-host") or request.headers.get("host") or request.url.netloc).split(",")[0].strip()
    proto = (request.headers.get("x-forwarded-proto") or request.url.scheme).split(",")[0].strip()
    return f"{proto}://{host}"


@router.get("/calendar/{token}.ics", response_class=Response)
def calendar_feed(token: str, request: Request, db: Session = Depends(get_db)) -> Response:
    user = om_ics.user_for(db, token)
    if user is None:
        raise HTTPException(status_code=404, detail="Not found")
    body = om_ics.build(db, user, _origin(request))
    return Response(
        content=body,
        media_type="text/calendar; charset=utf-8",
        headers={"Cache-Control": "private, max-age=300", "Content-Disposition": 'inline; filename="tcroof-om.ics"'},
    )
