"""AI Assistant usage metering (`ai_usage`): monthly spend for the budget cap, questions per user
per day for the limit, and cost from the configured per-model prices. Token counts only."""

from __future__ import annotations

from datetime import datetime, time as dtime, timedelta, timezone
from typing import Any, Dict, List, Optional
from zoneinfo import ZoneInfo

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.config import settings
from app.db.models import AiUsage, User

BKK = ZoneInfo("Asia/Bangkok")


def now_bkk() -> datetime:
    return datetime.now(BKK)


def _month_start_utc(now: datetime) -> datetime:
    local = now.astimezone(BKK)
    return datetime.combine(local.date().replace(day=1), dtime.min, BKK).astimezone(timezone.utc)


def _day_start_utc(now: datetime) -> datetime:
    local = now.astimezone(BKK)
    return datetime.combine(local.date(), dtime.min, BKK).astimezone(timezone.utc)


def month_spend_usd(db: Session, now: Optional[datetime] = None) -> float:
    now = now or now_bkk()
    return float(db.scalar(select(func.coalesce(func.sum(AiUsage.cost_usd), 0.0)).where(AiUsage.ts >= _month_start_utc(now))) or 0.0)


def user_questions_today(db: Session, user_id: int, now: Optional[datetime] = None) -> int:
    now = now or now_bkk()
    return int(
        db.scalar(select(func.count()).select_from(AiUsage).where(AiUsage.user_id == user_id, AiUsage.ts >= _day_start_utc(now)))
        or 0
    )


def cost_usd(input_tokens: int, cached_tokens: int, output_tokens: int) -> float:
    """Cost of one turn. `input_tokens` includes the cached ones (Qwen's `cached_tokens` are part
    of the prompt count), which are billed at the cached price instead."""
    fresh = max(0, input_tokens - cached_tokens)
    return (
        fresh * settings.ai_price_in_per_m
        + cached_tokens * settings.ai_price_cached_per_m
        + output_tokens * settings.ai_price_out_per_m
    ) / 1_000_000


def record(db: Session, **fields: Any) -> None:
    db.add(AiUsage(**fields))
    db.commit()


def summary(db: Session, now: Optional[datetime] = None) -> Dict[str, Any]:
    """Admin view: this month's spend vs. budget, and questions / cost per user."""
    now = now or now_bkk()
    since = _month_start_utc(now)
    rows = db.execute(
        select(
            AiUsage.user_id,
            User.username,
            func.count(),
            func.sum(AiUsage.cost_usd),
            func.sum(AiUsage.input_tokens),
            func.sum(AiUsage.output_tokens),
            func.sum(func.coalesce(AiUsage.cached_tokens, 0)),
        )
        .outerjoin(User, User.id == AiUsage.user_id)
        .where(AiUsage.ts >= since)
        .group_by(AiUsage.user_id, User.username)
        .order_by(func.sum(AiUsage.cost_usd).desc())
    ).all()
    status_rows = db.execute(select(AiUsage.status, func.count()).where(AiUsage.ts >= since).group_by(AiUsage.status)).all()
    users: List[Dict[str, Any]] = [
        {
            "user_id": uid,
            "username": name,
            "questions": int(n),
            "cost_usd": round(float(c or 0), 4),
            "input_tokens": int(i or 0),
            "output_tokens": int(o or 0),
            "cached_tokens": int(k or 0),
        }
        for uid, name, n, c, i, o, k in rows
    ]
    spent = sum(u["cost_usd"] for u in users)
    return {
        "month": now.astimezone(BKK).strftime("%Y-%m"),
        "model": settings.ai_model,
        "budget_usd": settings.ai_monthly_budget_usd,
        "user_daily_questions": settings.ai_user_daily_questions,
        "enabled_roles": [r.strip() for r in settings.ai_enabled_roles.split(",") if r.strip()],
        "resets_on": first_of_next_month(now),
        "spent_usd": round(spent, 4),
        "questions": sum(u["questions"] for u in users),
        "by_status": {s: int(n) for s, n in status_rows},
        "users": users,
    }


def first_of_next_month(now: Optional[datetime] = None) -> str:
    local = (now or now_bkk()).astimezone(BKK).date().replace(day=28) + timedelta(days=4)
    return local.replace(day=1).isoformat()
