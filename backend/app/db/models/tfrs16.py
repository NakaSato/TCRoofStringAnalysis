"""TFRS 16 lease accounting of the PWA solar contract, from the TFRS 16 model workbook.

Everything here is **modelled**: the lease-liability schedule, right-of-use asset, depreciation,
interest, minimum fees, the seasonal revenue profile and the remeasurement are the model's
accounting figures (phases 3-4 also rest on an assumed start date), never measured. The rollout
list of phases 3-4 is the workbook's status list as it was attached. Imported only by the CLI
(`python -m app.services.tfrs16 import --model …`, services/tfrs16.py), which replaces every row
at once. SQL only, never Firestore.
"""

from __future__ import annotations

from datetime import date, datetime
from typing import Any, Optional

from sqlalchemy import JSON, Boolean, Date, DateTime, Float, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.db.session import Base
from app.db.models.base import _utcnow


class Tfrs16Import(Base):
    """The one import (`id` = 1): source file, when, the project budget the contract states, the
    revenue case the monthly profile uses, and the warnings of the consistency checks."""

    __tablename__ = "tfrs16_imports"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    source: Mapped[str] = mapped_column(String(200), nullable=False)
    project_budget_thb: Mapped[Optional[float]] = mapped_column(Float)
    revenue_case: Mapped[Optional[str]] = mapped_column(String(120))
    revenue_price_thb_kwh: Mapped[Optional[float]] = mapped_column(Float)
    rollout_note: Mapped[Optional[str]] = mapped_column(Text)
    warnings: Mapped[Any] = mapped_column(JSON, nullable=False, default=list)
    imported_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow, nullable=False)


class Tfrs16Phase(Base):
    """A project phase (ระยะ 1-4) as the model's project summary gives it. `estimated` = the
    phase sheet is marked ประมาณการ (phases 3-4: start date assumed)."""

    __tablename__ = "tfrs16_phases"

    phase: Mapped[int] = mapped_column(Integer, primary_key=True)
    estimated: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    stations: Mapped[Optional[int]] = mapped_column(Integer)
    kwp: Mapped[Optional[float]] = mapped_column(Float)
    start_day: Mapped[Optional[date]] = mapped_column(Date)
    end_day: Mapped[Optional[date]] = mapped_column(Date)
    discount_rate: Mapped[Optional[float]] = mapped_column(Float)
    min_fee_thb: Mapped[Optional[float]] = mapped_column(Float)  # 20-year minimum energy-management fee, ex VAT
    kwh_20y: Mapped[Optional[float]] = mapped_column(Float)
    rou_initial_thb: Mapped[Optional[float]] = mapped_column(Float)
    deferred_interest_thb: Mapped[Optional[float]] = mapped_column(Float)


class Tfrs16Period(Base):
    """One month of a phase's lease-liability schedule. `payment_thb` is positive (the sheet writes
    it negative); `fiscal_year` is the Thai fiscal year in B.E. (1 Oct - 30 Sep, FY2569 = 2569)."""

    __tablename__ = "tfrs16_schedule"

    phase: Mapped[int] = mapped_column(Integer, primary_key=True)
    period: Mapped[int] = mapped_column(Integer, primary_key=True)
    month: Mapped[date] = mapped_column(Date, nullable=False)
    fiscal_year: Mapped[int] = mapped_column(Integer, nullable=False, index=True)
    contract_year: Mapped[Optional[int]] = mapped_column(Integer)
    min_fee_thb: Mapped[Optional[float]] = mapped_column(Float)
    kwh: Mapped[Optional[float]] = mapped_column(Float)
    opening_thb: Mapped[Optional[float]] = mapped_column(Float)
    interest_thb: Mapped[Optional[float]] = mapped_column(Float)
    payment_thb: Mapped[Optional[float]] = mapped_column(Float)
    closing_thb: Mapped[Optional[float]] = mapped_column(Float)
    depreciation_thb: Mapped[Optional[float]] = mapped_column(Float)
    rou_net_thb: Mapped[Optional[float]] = mapped_column(Float)


class Tfrs16Remeasurement(Base):
    """A lease-liability remeasurement at a fiscal year end (sheets ประเมินใหม่*): the book liability,
    the liability measured again at the revised production share, and the difference booked to
    account `account` (6279030) when `decision` says to adjust."""

    __tablename__ = "tfrs16_remeasurements"

    phase: Mapped[int] = mapped_column(Integer, primary_key=True)
    assessed_on: Mapped[Optional[date]] = mapped_column(Date)
    book_liability_thb: Mapped[Optional[float]] = mapped_column(Float)
    remaining_fee_thb: Mapped[Optional[float]] = mapped_column(Float)
    old_deferred_interest_thb: Mapped[Optional[float]] = mapped_column(Float)
    production_share: Mapped[Optional[float]] = mapped_column(Float)
    revised_fee_thb: Mapped[Optional[float]] = mapped_column(Float)
    new_liability_thb: Mapped[Optional[float]] = mapped_column(Float)
    new_deferred_interest_thb: Mapped[Optional[float]] = mapped_column(Float)
    difference_thb: Mapped[Optional[float]] = mapped_column(Float)
    difference_share: Mapped[Optional[float]] = mapped_column(Float)
    threshold_share: Mapped[Optional[float]] = mapped_column(Float)
    decision: Mapped[Optional[str]] = mapped_column(String(200))
    account: Mapped[Optional[str]] = mapped_column(String(16))
    sheet: Mapped[str] = mapped_column(String(64), nullable=False)


class Tfrs16RevenueMonth(Base):
    """Modelled revenue of a phase in one calendar month of its first contract year (the sheet
    รายได้รายเดือน, revenue case in `tfrs16_imports`). `fy_order` = 1 for October … 12 for September."""

    __tablename__ = "tfrs16_revenue_months"

    phase: Mapped[int] = mapped_column(Integer, primary_key=True)
    month: Mapped[int] = mapped_column(Integer, primary_key=True)
    fy_order: Mapped[int] = mapped_column(Integer, nullable=False)
    revenue_thb: Mapped[Optional[float]] = mapped_column(Float)


class Tfrs16RolloutStation(Base):
    """A phase 3-4 station on the workbook's installation / interconnection list (ระยะ3-4_สถานี): the
    interconnection status and payment as the list words them, `first_sync` as given (null = none)."""

    __tablename__ = "tfrs16_rollout_stations"

    phase: Mapped[int] = mapped_column(Integer, primary_key=True)
    seq: Mapped[int] = mapped_column(Integer, primary_key=True)  # the list's ลำดับ, which restarts per phase
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    kwp: Mapped[Optional[float]] = mapped_column(Float)
    interconnect_status: Mapped[Optional[str]] = mapped_column(String(120))
    fee_thb: Mapped[Optional[float]] = mapped_column(Float)
    fee_paid: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    interconnected: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    first_sync: Mapped[Optional[date]] = mapped_column(Date)
