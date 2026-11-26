"""Spares and failed units (docs/plans/spares-failed-units.md), phases 1–5: parts catalogue, stock
locations, serialised spare units, the movement ledger, failed units (red tag bound) and stock
counts.

Stock on hand is never stored: it is the spare units `in_stock` at a location, and every change of
a unit's place or state is a `StockMovement` row (append-only; a mistake is undone by a
`correction` movement that names the one it reverses). v1 stocks serialised units only (D-2), so
`qty` is 1; the column stays for counted consumables later. No money anywhere.

Unit states: `in_stock` (at a store / bin / van), `installed` (at a plant), `failed`,
`at_supplier`, `scrapped`, `void` (a corrected receive) and `missing` (phase 5: the register had it
at a location a confirmed count did not find it in; no location until it is counted in again).
Movement kinds add `count_adjust` (phase 5): one row per unit a confirmed count changed (moved to
the counted location, found again, new, or missing), all of one count in one batch.
"""

from __future__ import annotations

from datetime import date, datetime
from typing import Optional

from sqlalchemy import Boolean, Date, DateTime, ForeignKey, Integer, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.db.session import Base
from app.db.models.base import _utcnow

PART_CATEGORIES = ("inverter", "datalogger", "weather_station", "revenue_meter", "router", "pqm", "shinemaster", "grid_meter", "module", "other")
LOCATION_KINDS = ("store", "bin", "van", "supplier")
UNIT_STATES = ("in_stock", "installed", "failed", "at_supplier", "scrapped", "void", "missing")
MOVEMENT_KINDS = ("receive", "transfer", "issue", "return", "correction", "failed_in", "ship_out", "supplier_return", "scrap", "count_adjust")
FAILED_STATUSES = ("tagged", "in_store", "sent", "repaired", "replaced", "scrapped")
FAILED_OPEN = ("tagged", "in_store", "sent")
INPUT_METHODS = ("hid", "camera", "photo", "manual")


class Part(Base):
    __tablename__ = "stock_parts"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    code: Mapped[str] = mapped_column(String(40), unique=True, nullable=False)
    name: Mapped[str] = mapped_column(String(120), nullable=False)
    category: Mapped[str] = mapped_column(String(24), nullable=False, index=True)
    make: Mapped[Optional[str]] = mapped_column(String(64))
    model: Mapped[Optional[str]] = mapped_column(String(64))
    serialised: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    unit: Mapped[str] = mapped_column(String(8), nullable=False, default="pc")
    min_qty: Mapped[Optional[int]] = mapped_column(Integer)
    active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    note: Mapped[Optional[str]] = mapped_column(Text)
    created_by: Mapped[Optional[str]] = mapped_column(String(64))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow, onupdate=_utcnow, nullable=False)


class StockLocation(Base):
    __tablename__ = "stock_locations"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    code: Mapped[str] = mapped_column(String(32), unique=True, nullable=False)
    name: Mapped[str] = mapped_column(String(120), nullable=False)
    kind: Mapped[str] = mapped_column(String(16), nullable=False)
    parent_id: Mapped[Optional[int]] = mapped_column(Integer, ForeignKey("stock_locations.id", ondelete="SET NULL"))
    holder_user_id: Mapped[Optional[int]] = mapped_column(Integer, ForeignKey("users.id", ondelete="SET NULL"))
    active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    note: Mapped[Optional[str]] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow, onupdate=_utcnow, nullable=False)


class SpareUnit(Base):
    """One serialised unit. `serial_key` = the serial trimmed and upper-cased, unique per part."""

    __tablename__ = "stock_units"
    __table_args__ = (UniqueConstraint("part_id", "serial_key", name="uq_stock_units_part_serial"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    part_id: Mapped[int] = mapped_column(Integer, ForeignKey("stock_parts.id"), nullable=False, index=True)
    serial: Mapped[str] = mapped_column(String(64), nullable=False)
    serial_key: Mapped[str] = mapped_column(String(64), nullable=False, index=True)
    state: Mapped[str] = mapped_column(String(16), nullable=False, default="in_stock")
    location_id: Mapped[Optional[int]] = mapped_column(Integer, ForeignKey("stock_locations.id"), index=True)
    plant_id: Mapped[Optional[int]] = mapped_column(Integer, index=True)
    received_day: Mapped[Optional[date]] = mapped_column(Date)
    note: Mapped[Optional[str]] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow, onupdate=_utcnow, nullable=False)


class StockMovement(Base):
    """One move of one unit (the ledger). Never edited or deleted."""

    __tablename__ = "stock_movements"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    batch_id: Mapped[str] = mapped_column(String(36), nullable=False, index=True)
    kind: Mapped[str] = mapped_column(String(16), nullable=False)
    # null: a failed unit with no catalogue part (phase 2)
    part_id: Mapped[Optional[int]] = mapped_column(Integer, ForeignKey("stock_parts.id"), nullable=True, index=True)
    unit_id: Mapped[Optional[int]] = mapped_column(Integer, ForeignKey("stock_units.id"), index=True)
    serial: Mapped[Optional[str]] = mapped_column(String(64))
    qty: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    from_location_id: Mapped[Optional[int]] = mapped_column(Integer, ForeignKey("stock_locations.id"))
    to_location_id: Mapped[Optional[int]] = mapped_column(Integer, ForeignKey("stock_locations.id"))
    plant_id: Mapped[Optional[int]] = mapped_column(Integer, index=True)
    from_state: Mapped[Optional[str]] = mapped_column(String(16))
    to_state: Mapped[Optional[str]] = mapped_column(String(16))
    corrects_id: Mapped[Optional[int]] = mapped_column(Integer, ForeignKey("stock_movements.id"), unique=True)
    claim_id: Mapped[Optional[int]] = mapped_column(Integer)
    # `stock_failed_units.id`; a plain integer (no foreign key): the column shipped in phase 1
    # before the table existed, and adding the constraint would mean altering it
    failed_unit_id: Mapped[Optional[int]] = mapped_column(Integer)
    by: Mapped[Optional[str]] = mapped_column(String(64))
    at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow, nullable=False, index=True)
    day: Mapped[date] = mapped_column(Date, nullable=False)
    note: Mapped[Optional[str]] = mapped_column(Text)
    input_method: Mapped[Optional[str]] = mapped_column(String(8))
    raw_scan: Mapped[Optional[str]] = mapped_column(String(512))


class FailedUnit(Base):
    """A device taken off site (phase 2, §5.3–5.5), bound to one red tag. `status`: `tagged` (on
    site / in a van), `in_store`, `sent` (at the supplier), then `repaired` / `replaced` /
    `scrapped`. Status and place change only through movements (`services/stock_failed.py`)."""

    __tablename__ = "stock_failed_units"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    red_tag_id: Mapped[int] = mapped_column(Integer, ForeignKey("red_tags.id"), unique=True, nullable=False)
    part_id: Mapped[Optional[int]] = mapped_column(Integer, ForeignKey("stock_parts.id"))
    serial: Mapped[Optional[str]] = mapped_column(String(64))  # null: an unreadable label
    serial_key: Mapped[Optional[str]] = mapped_column(String(64), index=True)
    plant_id: Mapped[Optional[int]] = mapped_column(Integer, index=True)
    site_device_id: Mapped[Optional[int]] = mapped_column(Integer, ForeignKey("site_devices.id", ondelete="SET NULL"))
    inverter_sn: Mapped[Optional[str]] = mapped_column(String(64))
    removed_day: Mapped[date] = mapped_column(Date, nullable=False)
    fault: Mapped[str] = mapped_column(Text, nullable=False)
    status: Mapped[str] = mapped_column(String(16), nullable=False)
    location_id: Mapped[Optional[int]] = mapped_column(Integer, ForeignKey("stock_locations.id"))
    claim_id: Mapped[Optional[int]] = mapped_column(Integer, ForeignKey("claims.id", ondelete="SET NULL"))
    spare_unit_id: Mapped[Optional[int]] = mapped_column(Integer, ForeignKey("stock_units.id"))
    created_by: Mapped[Optional[str]] = mapped_column(String(64))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow, onupdate=_utcnow, nullable=False)


class StockCount(Base):
    """A confirmed stock count of one location (phase 5, §5.7). The numbers are what the confirm
    found; the changes themselves are the `count_adjust` movements of `batch_id` (null when the
    count changed nothing). Never edited."""

    __tablename__ = "stock_counts"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    location_id: Mapped[int] = mapped_column(Integer, ForeignKey("stock_locations.id"), nullable=False, index=True)
    batch_id: Mapped[Optional[str]] = mapped_column(String(36))
    by: Mapped[Optional[str]] = mapped_column(String(64))
    at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow, nullable=False)
    day: Mapped[date] = mapped_column(Date, nullable=False)
    scanned: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    matched: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    missing: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    moved_here: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    new_units: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    found_again: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    note: Mapped[Optional[str]] = mapped_column(Text)
