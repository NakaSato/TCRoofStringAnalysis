"""Measuring Tools: the O&M team's measuring instruments (docs/plans/measuring-tools.md).

Drones, thermal cameras, clamp meters, I-V tracers, …: who holds each one, where it went, and when
its calibration or documents (drone CAAT / NBTC registration, insurance) run out. Every spec, date,
interval and cost is as entered: nothing is looked up or assumed. SQL only (never Firestore), kept
indefinitely.

`plant_id` on a check-out has no FK, like `site_events`: the history stays readable after a plant
leaves the registry.
"""

from __future__ import annotations

from datetime import date, datetime
from typing import Any, Optional

from sqlalchemy import Date, DateTime, Float, ForeignKey, Index, Integer, JSON, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.db.session import Base
from app.db.models.base import _utcnow


class Instrument(Base):
    """One instrument. `status` is available / checked_out / at_calibration / repair / retired;
    `checked_out` is set only by a check-out. `specs` holds the per-category fields (values number,
    text or null). The due states are computed from `instrument_due_records`, never stored."""

    __tablename__ = "instruments"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    asset_tag: Mapped[str] = mapped_column(String(32), unique=True, nullable=False)
    name: Mapped[str] = mapped_column(String(120), nullable=False)
    category: Mapped[str] = mapped_column(String(24), nullable=False, index=True)
    make: Mapped[Optional[str]] = mapped_column(String(64))
    model: Mapped[Optional[str]] = mapped_column(String(64))
    serial_no: Mapped[Optional[str]] = mapped_column(String(64))
    status: Mapped[str] = mapped_column(String(16), nullable=False, default="available")
    specs: Mapped[dict[str, Any]] = mapped_column(JSON, nullable=False, default=dict)
    calibration_interval_months: Mapped[Optional[int]] = mapped_column(Integer)
    purchase_day: Mapped[Optional[date]] = mapped_column(Date)
    cost_thb: Mapped[Optional[float]] = mapped_column(Float)
    note: Mapped[Optional[str]] = mapped_column(Text)
    created_by: Mapped[Optional[str]] = mapped_column(String(64))
    updated_by: Mapped[Optional[str]] = mapped_column(String(64))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow, nullable=False)
    updated_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))


class InstrumentDueRecord(Base):
    """A recorded calibration or document renewal: done on `day`, valid until `next_due` (null =
    no date entered). The newest record per kind gives the instrument's due item."""

    __tablename__ = "instrument_due_records"
    __table_args__ = (Index("ix_instrument_due_records_instrument_kind", "instrument_id", "kind"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    instrument_id: Mapped[int] = mapped_column(Integer, ForeignKey("instruments.id", ondelete="CASCADE"), nullable=False)
    kind: Mapped[str] = mapped_column(String(16), nullable=False)
    day: Mapped[date] = mapped_column(Date, nullable=False)
    next_due: Mapped[Optional[date]] = mapped_column(Date)
    number: Mapped[Optional[str]] = mapped_column(String(64))
    issuer: Mapped[Optional[str]] = mapped_column(String(120))
    cost_thb: Mapped[Optional[float]] = mapped_column(Float)
    url: Mapped[Optional[str]] = mapped_column(String(1000))
    note: Mapped[Optional[str]] = mapped_column(Text)
    created_by: Mapped[Optional[str]] = mapped_column(String(64))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow, nullable=False)


class InstrumentCheckout(Base):
    """One check-out: who has it, which plant it went to (optional), when it is due back, and on
    return its condition. `returned_at` null = still out (at most one open per instrument)."""

    __tablename__ = "instrument_checkouts"
    __table_args__ = (Index("ix_instrument_checkouts_instrument_open", "instrument_id", "returned_at"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    instrument_id: Mapped[int] = mapped_column(Integer, ForeignKey("instruments.id", ondelete="CASCADE"), nullable=False)
    holder_user_id: Mapped[Optional[int]] = mapped_column(Integer, ForeignKey("users.id", ondelete="SET NULL"))
    holder_name: Mapped[Optional[str]] = mapped_column(String(255))
    plant_id: Mapped[Optional[int]] = mapped_column(Integer)
    out_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow, nullable=False)
    due_back: Mapped[date] = mapped_column(Date, nullable=False)
    returned_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))
    condition: Mapped[Optional[str]] = mapped_column(String(8))
    note: Mapped[Optional[str]] = mapped_column(Text)
    return_note: Mapped[Optional[str]] = mapped_column(Text)
    ack_warnings: Mapped[list[str]] = mapped_column(JSON, nullable=False, default=list)
    # how the instrument was identified at check-out: its asset tag scanned (hid / camera / photo) or
    # typed (manual); null = picked in the app. `raw_scan` = the code as read
    input_method: Mapped[Optional[str]] = mapped_column(String(8))
    raw_scan: Mapped[Optional[str]] = mapped_column(String(512))
    created_by: Mapped[Optional[str]] = mapped_column(String(64))
    returned_by: Mapped[Optional[str]] = mapped_column(String(64))
