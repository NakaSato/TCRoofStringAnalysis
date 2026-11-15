"""Alarm push notifications (`/push/*`): this user's devices. Sending is the worker's job."""

from __future__ import annotations

import logging
from typing import Any, Dict

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from app.auth import get_current_user
from app.db.models import User
from app.db.session import get_db
from app.schemas.api_schemas import PushTokenIn, PushTokenRemove
from app.services import jobs
from app.services import push as svc

router = APIRouter(prefix="/push", tags=["Push notifications"])
audit = logging.getLogger("app.audit")


@router.get("/status")
def push_status(db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> Dict[str, Any]:
    """Whether push is configured (the UI hides its button otherwise), the Firebase web app
    config the browser needs for a token (public values), and this user's device count."""
    return svc.status(db, user)


@router.post("/tokens")
def register_token(
    body: PushTokenIn, db: Session = Depends(get_db), user: User = Depends(get_current_user)
) -> Dict[str, Any]:
    """Turn alarm notifications on for this browser (also called on each visit to keep it fresh)."""
    try:
        return {"devices": svc.register_token(db, user, body.token, body.label)}
    except svc.PushError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc


@router.post("/tokens/remove")
def remove_token(
    body: PushTokenRemove, db: Session = Depends(get_db), user: User = Depends(get_current_user)
) -> Dict[str, Any]:
    """Turn them off for this browser. POST, so the token is in the body, never in a logged URL."""
    return {"devices": svc.remove_token(db, user, body.token)}


@router.post("/test", status_code=202)
def send_test(db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> Dict[str, Any]:
    """Queue a test notification to this user's devices. The worker sends it within a minute
    (the API never sends: it has no Firebase credentials on Cloud Run)."""
    try:
        devices = svc.request_test(db, user)
    except svc.PushError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    try:
        jobs.enqueue(db, "push_test", "api")
    except jobs.JobBusy:
        pass  # a queued run sends it; one already running leaves it for the next `alarms` run
    audit.info("%s asked for a test notification (%d devices)", user.username or user.email, devices)
    return {"queued": True, "devices": devices}
