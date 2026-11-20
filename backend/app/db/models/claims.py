"""Claims: warranty and insurance claims for plant equipment (docs/plans/claims.md).

A claim says what failed at which Growatt plant, who the claim is with (manufacturer, insurer,
EPC), the evidence gathered and where it stands. Every date, serial and reference is as entered:
nothing is looked up or assumed, and no amounts are kept. SQL only (never Firestore), kept
indefinitely.

`plant_id` has no FK, like `site_events`: a claim stays readable after its plant leaves the
registry (it is a business record, not plant data).
"""

from __future__ import annotations

from datetime import date, datetime
from typing import Any, Optional

from sqlalchemy import Boolean, Date, DateTime, ForeignKey, Index, Integer, JSON, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.db.session import Base
from app.db.models.base import _utcnow


class Claim(Base):
    """One claim. `number` = CL-YYYY-NNN, numbered per year. `status` follows the workflow in
    `services/claims.py`; `waiting_on` and `followup_overdue` are computed, never stored."""

    __tablename__ = "claims"
    __table_args__ = (Index("ix_claims_plant_status", "plant_id", "status"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    number: Mapped[str] = mapped_column(String(16), unique=True, nullable=False)
    claim_type: Mapped[str] = mapped_column(String(24), nullable=False)
    status: Mapped[str] = mapped_column(String(16), nullable=False, default="draft")
    cause: Mapped[str] = mapped_column(String(24), nullable=False)
    plant_id: Mapped[int] = mapped_column(Integer, nullable=False)
    device_sn: Mapped[Optional[str]] = mapped_column(String(64), index=True)
    string_nos: Mapped[list[int]] = mapped_column(JSON, nullable=False, default=list)
    module_serials: Mapped[list[str]] = mapped_column(JSON, nullable=False, default=list)
    device_label: Mapped[Optional[str]] = mapped_column(String(120))
    counterparty: Mapped[str] = mapped_column(String(120), nullable=False)
    counterparty_ref: Mapped[Optional[str]] = mapped_column(String(120))
    description: Mapped[Optional[str]] = mapped_column(Text)
    incident_day: Mapped[Optional[date]] = mapped_column(Date)
    discovered_day: Mapped[Optional[date]] = mapped_column(Date)
    submitted_day: Mapped[Optional[date]] = mapped_column(Date)
    closed_day: Mapped[Optional[date]] = mapped_column(Date)
    next_action_day: Mapped[Optional[date]] = mapped_column(Date)
    old_sn: Mapped[Optional[str]] = mapped_column(String(64))
    new_sn: Mapped[Optional[str]] = mapped_column(String(64))
    warranty_end_day: Mapped[Optional[date]] = mapped_column(Date)
    created_by: Mapped[Optional[str]] = mapped_column(String(64))
    updated_by: Mapped[Optional[str]] = mapped_column(String(64))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow, onupdate=_utcnow, nullable=False)


class ClaimEvent(Base):
    """Timeline entry: created, status (from → to), note, message (sent / received), shipment
    (out = to them, in = to us, with carrier / tracking / SN) or edit (`summary` names the fields)."""

    __tablename__ = "claim_events"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    claim_id: Mapped[int] = mapped_column(Integer, ForeignKey("claims.id", ondelete="CASCADE"), index=True, nullable=False)
    kind: Mapped[str] = mapped_column(String(16), nullable=False)
    at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow, nullable=False)
    day: Mapped[Optional[date]] = mapped_column(Date)
    by: Mapped[Optional[str]] = mapped_column(String(64))
    from_status: Mapped[Optional[str]] = mapped_column(String(16))
    to_status: Mapped[Optional[str]] = mapped_column(String(16))
    direction: Mapped[Optional[str]] = mapped_column(String(4))
    summary: Mapped[str] = mapped_column(Text, nullable=False, default="")
    carrier: Mapped[Optional[str]] = mapped_column(String(64))
    tracking_no: Mapped[Optional[str]] = mapped_column(String(64))
    sn: Mapped[Optional[str]] = mapped_column(String(64))
    detail: Mapped[Optional[dict[str, Any]]] = mapped_column(JSON)


class ClaimEvidence(Base):
    """A ticked (or unticked) checklist item. The item list per type lives in `services/claims.py`;
    a row exists only once someone set the item."""

    __tablename__ = "claim_evidence"

    claim_id: Mapped[int] = mapped_column(Integer, ForeignKey("claims.id", ondelete="CASCADE"), primary_key=True)
    key: Mapped[str] = mapped_column(String(32), primary_key=True)
    done: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    url: Mapped[Optional[str]] = mapped_column(String(1000))
    note: Mapped[Optional[str]] = mapped_column(Text)
    by: Mapped[Optional[str]] = mapped_column(String(64))
    at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))


class ClaimLink(Base):
    """A record of the same plant the claim points to: a decision-rule issue, an I-V sweep or a
    site log event."""

    __tablename__ = "claim_links"
    __table_args__ = (UniqueConstraint("claim_id", "kind", "ref_id", name="ux_claim_links_ref"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    claim_id: Mapped[int] = mapped_column(Integer, ForeignKey("claims.id", ondelete="CASCADE"), index=True, nullable=False)
    kind: Mapped[str] = mapped_column(String(16), nullable=False)
    ref_id: Mapped[int] = mapped_column(Integer, nullable=False)
    created_by: Mapped[Optional[str]] = mapped_column(String(64))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow, nullable=False)
