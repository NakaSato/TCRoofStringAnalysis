"""Calendar Team: planned O&M work (docs/plans/calendar-team.md).

Planned tasks per Growatt plant (cleaning, PM, repairs, …) with assignees, a team / crew and a
change history. A finished task writes a Site log event (`site_events`); the Site log records
work done, these tables record work planned. SQL only (never Firestore), kept indefinitely.

`plant_id` has no FK, like `site_events` and `user_plant_assignments`: the blocked-plant cleanup
(`remove_blocked_plants`) deletes a plant's tasks explicitly. `plan_id` / `scheduled_day` are for
the recurring plans of Phase 2 (null = a one-off task).
"""

from __future__ import annotations

from datetime import date, datetime
from typing import Any, Optional

from sqlalchemy import Boolean, Date, DateTime, Float, ForeignKey, Index, Integer, JSON, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.db.session import Base
from app.db.models.base import _utcnow


class OmTeam(Base):
    """A crew: in-house engineers, or an external contractor tracked by name (0 members allowed;
    contractors have no login)."""

    __tablename__ = "om_teams"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    name: Mapped[str] = mapped_column(String(80), unique=True, nullable=False)
    color: Mapped[Optional[str]] = mapped_column(String(16))
    active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow, nullable=False)


class OmTeamMember(Base):
    __tablename__ = "om_team_members"

    team_id: Mapped[int] = mapped_column(Integer, ForeignKey("om_teams.id", ondelete="CASCADE"), primary_key=True)
    user_id: Mapped[int] = mapped_column(Integer, ForeignKey("users.id", ondelete="CASCADE"), primary_key=True, index=True)


class OmTask(Base):
    """One planned job on one plant over `start_day` … `end_day` (plant-local, may be in the future).

    Status: planned → in_progress → done, or skipped / cancelled. Moving a task keeps its status
    (the old dates go to the history). Overdue (end_day < today while planned / in progress) is
    computed, never stored. `site_event_id` is the Site log event written when it was done.
    """

    __tablename__ = "om_tasks"
    __table_args__ = (
        Index("ix_om_tasks_days", "start_day", "end_day"),
        Index("ix_om_tasks_plant_start", "plant_id", "start_day"),
        Index("ux_om_tasks_plan_occurrence", "plan_id", "plant_id", "scheduled_day", unique=True),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    plant_id: Mapped[int] = mapped_column(Integer, nullable=False)
    task_type: Mapped[str] = mapped_column(String(24), nullable=False)
    title: Mapped[Optional[str]] = mapped_column(String(160))
    start_day: Mapped[date] = mapped_column(Date, nullable=False)
    end_day: Mapped[date] = mapped_column(Date, nullable=False)
    scheduled_day: Mapped[Optional[date]] = mapped_column(Date)
    device_sn: Mapped[Optional[str]] = mapped_column(String(64))
    string_no: Mapped[Optional[int]] = mapped_column(Integer)
    status: Mapped[str] = mapped_column(String(16), nullable=False, default="planned")
    team_id: Mapped[Optional[int]] = mapped_column(Integer, ForeignKey("om_teams.id", ondelete="SET NULL"), index=True)
    plan_id: Mapped[Optional[int]] = mapped_column(Integer)
    issue_id: Mapped[Optional[int]] = mapped_column(Integer)
    est_cost_thb: Mapped[Optional[float]] = mapped_column(Float)
    note: Mapped[Optional[str]] = mapped_column(Text)
    site_event_id: Mapped[Optional[int]] = mapped_column(Integer, ForeignKey("site_events.id", ondelete="SET NULL"))
    done_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))
    done_by: Mapped[Optional[str]] = mapped_column(String(64))
    created_by: Mapped[Optional[str]] = mapped_column(String(64))
    updated_by: Mapped[Optional[str]] = mapped_column(String(64))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow, onupdate=_utcnow, nullable=False)


class OmTaskAssignee(Base):
    __tablename__ = "om_task_assignees"

    task_id: Mapped[int] = mapped_column(Integer, ForeignKey("om_tasks.id", ondelete="CASCADE"), primary_key=True)
    user_id: Mapped[int] = mapped_column(Integer, ForeignKey("users.id", ondelete="CASCADE"), primary_key=True, index=True)


class OmTaskHistory(Base):
    """Who changed what on a task: `change` maps field → [old, new] (or {"created": …} / {"done": …})."""

    __tablename__ = "om_task_history"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    task_id: Mapped[int] = mapped_column(Integer, ForeignKey("om_tasks.id", ondelete="CASCADE"), index=True, nullable=False)
    at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow, nullable=False)
    by: Mapped[Optional[str]] = mapped_column(String(64))
    change: Mapped[dict[str, Any]] = mapped_column(JSON, nullable=False, default=dict)
    comment: Mapped[Optional[str]] = mapped_column(Text)
