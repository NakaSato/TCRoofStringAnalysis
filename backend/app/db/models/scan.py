"""Barcode / QR scanning (docs/plans/barcode-scanning.md §6.3): which field of a multi-field label
is the serial, per device category + model.

Static config, not readings. A label with several values and no `SN` key (a router QR with SN,
IMEI and MAC, say) asks the person once; the choice is kept here so the next scan of the same
model pre-selects it. `field_key` is the key printed before the value (`S/N`, `(21)`), matched
case-insensitively; when the label prints no keys, `field_index` of a label with `field_count`
values is used. `model_key` is the model trimmed and upper-cased. Anyone may record the first
hint for a model; changing or removing one is admin only (`api/routes/scan.py`).
"""

from __future__ import annotations

from datetime import datetime
from typing import Optional

from sqlalchemy import DateTime, ForeignKey, Integer, String, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.db.session import Base
from app.db.models.base import _utcnow


class ScanFieldHint(Base):
    __tablename__ = "scan_field_hints"
    __table_args__ = (UniqueConstraint("category", "model_key", name="uq_scan_field_hints_category_model"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    category: Mapped[str] = mapped_column(String(40), nullable=False)
    model: Mapped[str] = mapped_column(String(120), nullable=False)
    model_key: Mapped[str] = mapped_column(String(120), nullable=False)
    field_key: Mapped[Optional[str]] = mapped_column(String(40))
    field_index: Mapped[int] = mapped_column(Integer, nullable=False)
    field_count: Mapped[int] = mapped_column(Integer, nullable=False)
    created_by: Mapped[Optional[int]] = mapped_column(Integer, ForeignKey("users.id", ondelete="SET NULL"))
    updated_by: Mapped[Optional[int]] = mapped_column(Integer, ForeignKey("users.id", ondelete="SET NULL"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow, onupdate=_utcnow, nullable=False)
