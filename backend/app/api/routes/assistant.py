"""AI Assistant routes (docs/plans/ai-assistant.md): a streamed chat over read-only DB tools.

Every check that can refuse the request (assistant off, role, budget, daily limit, malformed
thread) runs before streaming starts, so it answers with a proper HTTP status. The stream
itself is `text/event-stream` (excluded from GZip by Starlette).
"""

from __future__ import annotations

import json
from typing import Any, Dict, Iterator

from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.responses import StreamingResponse
from sqlalchemy.orm import Session, sessionmaker

from app.auth import allowed_plant_ids, get_current_user, require_admin
from app.config import settings
from app.db.models import GrowattPlant, User
from app.db.session import get_db, get_session_factory
from app.services.assistant import client as ai_client, usage
from app.services.assistant.loop import ChatRequest, run_chat, trim_history
from app.services.assistant.tools import ToolContext

router = APIRouter(prefix="/assistant", tags=["AI Assistant"])


def _role_allowed(user: User) -> bool:
    roles = {r.strip() for r in settings.ai_enabled_roles.split(",") if r.strip()}
    return user.role in roles


@router.get("/status")
def assistant_status(user: User = Depends(get_current_user)) -> Dict[str, Any]:
    """Whether the assistant is available to this user (the UI hides its button otherwise)."""
    return {"enabled": ai_client.enabled() and _role_allowed(user), "model": settings.ai_model}


@router.get("/usage")
def assistant_usage(db: Session = Depends(get_db), _admin: User = Depends(require_admin)) -> Dict[str, Any]:
    """This month's spend against the budget and questions per user (admin)."""
    return usage.summary(db)


def _sse(ev: Dict[str, Any]) -> str:
    return f"event: {ev['event']}\ndata: {json.dumps(ev['data'], ensure_ascii=False)}\n\n"


@router.post("/chat")
def assistant_chat(
    body: ChatRequest,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
    session_factory: sessionmaker = Depends(get_session_factory),
) -> StreamingResponse:
    """Answer the last user message of `body.messages` (the thread the browser keeps), streamed
    as server-sent events: `text`, `tool`, `error`, then `done` with the full answer."""
    if not ai_client.enabled():
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "The AI assistant is not configured.")
    if not _role_allowed(user):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "The AI assistant is not enabled for your role.")
    if body.messages[-1].role != "user":
        raise HTTPException(422, "The last message must be the user's question.")

    now = usage.now_bkk()
    if usage.month_spend_usd(db, now) >= settings.ai_monthly_budget_usd:
        raise HTTPException(
            status.HTTP_429_TOO_MANY_REQUESTS,
            f"The assistant's monthly budget is used up. It resets on {usage.first_of_next_month(now)}.",
        )
    if user.role != "admin" and usage.user_questions_today(db, user.id, now) >= settings.ai_user_daily_questions:
        raise HTTPException(
            status.HTTP_429_TOO_MANY_REQUESTS,
            f"Daily limit of {settings.ai_user_daily_questions} questions reached. It resets at midnight.",
        )

    allowed = allowed_plant_ids(db, user)
    lines = [f"today: {now.date().isoformat()} {now.strftime('%H:%M')} (Asia/Bangkok)"]
    ctx = body.context
    if ctx is not None:
        if ctx.page:
            lines.append(f"page: {ctx.page}")
        if ctx.plant_id is not None and (allowed is None or ctx.plant_id in allowed):
            name = db.get(GrowattPlant, ctx.plant_id)
            if name is not None:
                lines.append(f'plant on screen: {ctx.plant_id} "{name.name}"')
        if ctx.day is not None:
            lines.append(f"day selected on screen: {ctx.day.isoformat()}")
    context_text = "<context>\n" + "\n".join(lines) + "\n</context>"

    tctx = ToolContext(session_factory=session_factory, allowed=allowed, today=now.date())
    history = trim_history(body.messages)
    user_id = user.id

    def stream() -> Iterator[str]:
        for ev in run_chat(history, context_text, tctx, user_id):
            yield _sse(ev)

    return StreamingResponse(
        stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )
