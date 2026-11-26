"""Field faults: the defect register (docs/plans/defects.md).

One physical or service problem on one plant, recorded by a person, from the moment it is found
to the day the plant works again: what failed, how bad, the decision, who owns it and the records
that answer it (issue, claim, replacement, Site log, Calendar task). Every date, serial and
position is as entered or read from the register; nothing is estimated here. SQL only (never
Firestore), kept indefinitely: a wrong fault is `cancelled`, never deleted.

`plant_id` has no FK, like `claims`: a fault stays readable after its plant leaves the registry.
"""

from __future__ import annotations

from datetime import date, datetime
from typing import Any, Optional

from sqlalchemy import Date, DateTime, ForeignKey, Index, Integer, JSON, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.db.session import Base
from app.db.models.base import _utcnow


class FieldFault(Base):
    """One fault. `no` = DF-YYYY-NNNN (Bangkok year), numbered per year. The device is at most one
    of `inverter_sn` / `site_device_id` / the Growatt meter (`meter_datalogger_sn` + `meter_address`)
    / `stock_unit_id`, or none (BOS, structure: `position.location`). `status` follows the workflow
    in `services/faults.py`; restore time, age and `waiting_on` are computed, never stored."""

    __tablename__ = "field_faults"
    __table_args__ = (
        Index("ix_field_faults_plant_status", "plant_id", "status"),
        Index("ix_field_faults_kind_status", "kind", "status"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    no: Mapped[str] = mapped_column(String(16), unique=True, nullable=False)
    plant_id: Mapped[int] = mapped_column(Integer, nullable=False)
    kind: Mapped[str] = mapped_column(String(20), nullable=False)
    sub_kind: Mapped[Optional[str]] = mapped_column(String(12))  # service: vpn | sim | config | other
    inverter_sn: Mapped[Optional[str]] = mapped_column(String(64), index=True)
    site_device_id: Mapped[Optional[int]] = mapped_column(Integer, index=True)
    meter_datalogger_sn: Mapped[Optional[str]] = mapped_column(String(64))
    meter_address: Mapped[Optional[int]] = mapped_column(Integer)
    stock_unit_id: Mapped[Optional[int]] = mapped_column(Integer)
    # {mppt, string_no, module_no, location}: only the keys entered
    position: Mapped[Optional[dict[str, Any]]] = mapped_column(JSON)
    serial: Mapped[Optional[str]] = mapped_column(String(64))
    serial_key: Mapped[Optional[str]] = mapped_column(String(64), index=True)  # trimmed, upper case
    serial_input: Mapped[Optional[str]] = mapped_column(String(10))  # hid | camera | photo | manual | register
    serial_raw: Mapped[Optional[str]] = mapped_column(String(512))
    symptom: Mapped[str] = mapped_column(Text, nullable=False)
    how_found: Mapped[str] = mapped_column(String(16), nullable=False)
    found_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    found_by: Mapped[Optional[str]] = mapped_column(String(64))
    severity: Mapped[str] = mapped_column(String(2), nullable=False)
    cause: Mapped[Optional[str]] = mapped_column(String(24))
    status: Mapped[str] = mapped_column(String(12), nullable=False, default="open")
    waiting_reason: Mapped[Optional[str]] = mapped_column(String(12))
    decision: Mapped[Optional[str]] = mapped_column(String(16))
    decision_reason: Mapped[Optional[str]] = mapped_column(Text)
    owner_user_id: Mapped[Optional[int]] = mapped_column(Integer)
    next_action_day: Mapped[Optional[date]] = mapped_column(Date)
    restored_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))
    closed_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))
    closed_by: Mapped[Optional[str]] = mapped_column(String(64))
    close_note: Mapped[Optional[str]] = mapped_column(Text)
    evidence_urls: Mapped[list[str]] = mapped_column(JSON, nullable=False, default=list)
    reference: Mapped[Optional[str]] = mapped_column(String(120))  # carrier ticket no., config version
    created_by: Mapped[Optional[str]] = mapped_column(String(64))
    updated_by: Mapped[Optional[str]] = mapped_column(String(64))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow, onupdate=_utcnow, nullable=False)


class FieldFaultEvent(Base):
    """Timeline entry: created, status (from → to), decision, severity, edit (`text` names the
    fields), note, link or unlink (`text` = the link's kind and reference)."""

    __tablename__ = "field_fault_events"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    fault_id: Mapped[int] = mapped_column(Integer, ForeignKey("field_faults.id", ondelete="CASCADE"), index=True, nullable=False)
    at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow, nullable=False)
    by: Mapped[Optional[str]] = mapped_column(String(64))
    kind: Mapped[str] = mapped_column(String(10), nullable=False)
    from_value: Mapped[Optional[str]] = mapped_column(String(24))
    to_value: Mapped[Optional[str]] = mapped_column(String(24))
    text: Mapped[str] = mapped_column(Text, nullable=False, default="")


class FieldFaultLink(Base):
    """A record that belongs with the fault: by id (issue, claim, failed unit, Site log event,
    Calendar task, KB document) or by key (an alarm: device + code + time; a device check: code;
    a stock movement batch: its batch id)."""

    __tablename__ = "field_fault_links"
    __table_args__ = (Index("ix_field_fault_links_ref", "kind", "ref_id"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    fault_id: Mapped[int] = mapped_column(Integer, ForeignKey("field_faults.id", ondelete="CASCADE"), index=True, nullable=False)
    kind: Mapped[str] = mapped_column(String(16), nullable=False)
    ref_id: Mapped[Optional[int]] = mapped_column(Integer)
    ref_key: Mapped[Optional[str]] = mapped_column(String(200))
    created_by: Mapped[Optional[str]] = mapped_column(String(64))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow, nullable=False)
