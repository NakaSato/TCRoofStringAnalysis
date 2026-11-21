"""PWA daily meter report: the Cewe meter reading of each site per day (docs/plans/pwa-meter-daily.md).

Phases 1-2 of the PWA rooftop project send a daily report (Excel, one sheet per day) with each
site's meter kWh, inverter kWh, weather and a note. `pwa_meter_sites` is the site list, linked to
the Growatt plant it is; `pwa_meter_days` holds one row per site and day, imported from the clean
CSV (`python -m app.services.pwa_meter import`). SQL only, kept indefinitely, never Firestore.

These are source-dated daily records (the report's own day), not realtime values. A reading the
report did not give is null, never 0. `contract_kwh` and `pvsyst_kwh` are expected energy from the
contract and the PVsyst P50 simulation: modelled, not measured.
"""

from __future__ import annotations

from datetime import date, datetime
from typing import Optional

from sqlalchemy import Boolean, Date, DateTime, Float, ForeignKey, Index, Integer, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.db.session import Base
from app.db.models.base import _utcnow


class PwaMeterSite(Base):
    """A site of the daily report. `site_id` = P1-<contract no.> or P2-<report company id>.
    `growatt_plant_id` has no FK: the report site stays readable if the plant leaves the registry.
    `kwp` is the contract / PVsyst capacity (the basis for expected energy); `growatt_kwp` is the
    registry's, and `kwp_mismatch` marks a difference over 1 %."""

    __tablename__ = "pwa_meter_sites"

    site_id: Mapped[str] = mapped_column(String(16), primary_key=True)
    phase: Mapped[int] = mapped_column(Integer, nullable=False)
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    region: Mapped[Optional[str]] = mapped_column(String(32))
    kwp: Mapped[float] = mapped_column(Float, nullable=False)
    contract_seq: Mapped[Optional[int]] = mapped_column(Integer)
    pvsyst_seq: Mapped[Optional[int]] = mapped_column(Integer)
    growatt_plant_id: Mapped[Optional[int]] = mapped_column(Integer, index=True)
    growatt_name: Mapped[Optional[str]] = mapped_column(String(200))
    growatt_kwp: Mapped[Optional[float]] = mapped_column(Float)
    kwp_mismatch: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow, onupdate=_utcnow, nullable=False)


class PwaMeterDay(Base):
    """One site-day. `status`: ok / outage (meter and inverter both < 1 kWh) / loss_inv (inverter
    data missing) / loss_meter (meter reading missing); see the criteria file for the rules."""

    __tablename__ = "pwa_meter_days"
    __table_args__ = (
        UniqueConstraint("site_id", "day", name="uq_pwa_meter_days_site_day"),
        Index("ix_pwa_meter_days_day", "day"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    site_id: Mapped[str] = mapped_column(String(16), ForeignKey("pwa_meter_sites.site_id", ondelete="CASCADE"), nullable=False)
    day: Mapped[date] = mapped_column(Date, nullable=False)
    meter_kwh: Mapped[Optional[float]] = mapped_column(Float)
    inverter_kwh: Mapped[Optional[float]] = mapped_column(Float)
    contract_kwh: Mapped[Optional[float]] = mapped_column(Float)
    pvsyst_kwh: Mapped[Optional[float]] = mapped_column(Float)
    status: Mapped[str] = mapped_column(String(12), nullable=False)
    curtailment_note: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    weather: Mapped[Optional[str]] = mapped_column(String(12))
    note: Mapped[Optional[str]] = mapped_column(Text)
    imported_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow, nullable=False)
