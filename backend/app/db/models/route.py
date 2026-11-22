"""Site visit route (docs/plans/site-visit-route.md §4): saved offices a route can start from.

Static config an admin keeps (Settings), not realtime data. `name_key` is the trimmed name
case-folded, unique, so "Office" and "office" can't both exist. At most one row is the default
(`services/route_offices.py` keeps it so: the first office is the default, a new default clears
the others, deleting the default promotes the oldest remaining office).
"""

from __future__ import annotations

from datetime import datetime
from typing import Optional

from sqlalchemy import Boolean, DateTime, Float, ForeignKey, Integer, String, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.db.session import Base
from app.db.models.base import _utcnow


class RouteOffice(Base):
    __tablename__ = "route_offices"
    __table_args__ = (UniqueConstraint("name_key", name="uq_route_offices_name_key"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    name: Mapped[str] = mapped_column(String(80), nullable=False)
    name_key: Mapped[str] = mapped_column(String(80), nullable=False)
    address: Mapped[Optional[str]] = mapped_column(String(200))
    lat: Mapped[float] = mapped_column(Float, nullable=False)
    lon: Mapped[float] = mapped_column(Float, nullable=False)
    is_default: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    created_by: Mapped[Optional[int]] = mapped_column(Integer, ForeignKey("users.id", ondelete="SET NULL"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow, onupdate=_utcnow, nullable=False)
