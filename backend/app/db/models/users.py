"""Users, their plant assignments and their push-notification devices."""

from __future__ import annotations

from datetime import date, datetime
from typing import Optional

from sqlalchemy import Boolean, Date, DateTime, ForeignKey, Index, Integer, String
from sqlalchemy.orm import Mapped, mapped_column

from app.db.session import Base
from app.db.models.base import _utcnow


class User(Base):
    """User account for authentication and role-based access control."""

    __tablename__ = "users"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    # Login name, stored lowercase. Nullable only for rows created before usernames existed;
    # `ensure_seeded` fills those in from the email's local part.
    username: Mapped[Optional[str]] = mapped_column(String(64), unique=True, index=True)
    email: Mapped[str] = mapped_column(String(255), unique=True, index=True, nullable=False)
    full_name: Mapped[str] = mapped_column(String(255), nullable=False, default="O&M Lead Engineer")
    hashed_password: Mapped[str] = mapped_column(String(255), nullable=False)
    role: Mapped[str] = mapped_column(String(50), nullable=False, default="engineer")  # admin | engineer
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow, nullable=False)


class UserPlantAssignment(Base):
    """Growatt plants an admin assigned to an engineer.

    Admins see every plant and have no rows here. Engineers see and work on only the
    plants listed for them. No FK on plant_id: an assignment survives a plant briefly
    missing from the registry, and a plant that never comes back is simply not listed.
    """

    __tablename__ = "user_plant_assignments"

    user_id: Mapped[int] = mapped_column(Integer, ForeignKey("users.id", ondelete="CASCADE"), primary_key=True)
    plant_id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=False, index=True)
    assigned_by: Mapped[Optional[str]] = mapped_column(String(64))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow, nullable=False)


class PushToken(Base):
    """A browser / installed app a user turned alarm notifications on for (FCM registration token).

    Bookkeeping only. The token is an address, not a credential for this app, but it is never
    logged or returned by the API. A token belongs to one user: the same browser signing in as
    someone else and turning notifications on moves it. FCM reporting a token as gone deletes it.
    """

    __tablename__ = "push_tokens"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    user_id: Mapped[int] = mapped_column(Integer, ForeignKey("users.id", ondelete="CASCADE"), index=True, nullable=False)
    token: Mapped[str] = mapped_column(String(512), unique=True, nullable=False)
    label: Mapped[Optional[str]] = mapped_column(String(120))  # the browser's own description, for the user
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow, nullable=False)
    last_seen_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow, nullable=False)
    # set by POST /push/test; the worker sends the test and clears it
    test_requested_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))


class AlarmPushMark(Base):
    """The last alarm event of an inverter + code + day a notification went out for, so an alarm
    Growatt re-reports every few minutes is pushed once. `event_start` is plant-local (naive, as
    in `growatt_alarms`), `pushed_at` UTC. Pruned by `retention`."""

    __tablename__ = "alarm_push_marks"
    __table_args__ = (Index("ix_alarm_push_marks_day", "day"),)

    device_sn: Mapped[str] = mapped_column(String(64), primary_key=True)
    alarm_code: Mapped[str] = mapped_column(String(32), primary_key=True)  # "" = Growatt gave no code
    day: Mapped[date] = mapped_column(Date, primary_key=True)
    event_start: Mapped[datetime] = mapped_column(DateTime, nullable=False)
    pushed_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
