"""PVsyst design data of the PWA rooftop stations, phases 1-4 (services/pvsyst.py).

Imported from the TFRS 16 model workbook's sheets `PVsyst_สรุป` and `PVsyst_ระยะ1` .. `PVsyst_ระยะ4`
(`python -m app.services.pvsyst import --model …`), which hold what each station's PVsyst simulation
report states: E_Grid per calendar month (P50, unlimited load), kWp / kWac, PR, orientation. These are
**design (modelled) figures**, never measurements. SQL only, replaced as a whole on each import,
never Firestore.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any, Optional

from sqlalchemy import JSON, DateTime, Float, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.db.session import Base
from app.db.models.base import _utcnow


class PvsystPhase(Base):
    """One row of `PVsyst_สรุป` section ก (per phase; `phase` 0 = the sheet's whole-project row), as the
    sheet states it. `pr_weighted` and `contract_over_pvsyst` are the sheet's own figures (first-year
    contract kWh ÷ PVsyst kWh of the phase)."""

    __tablename__ = "pvsyst_phases"

    phase: Mapped[int] = mapped_column(Integer, primary_key=True)
    stations_model: Mapped[Optional[int]] = mapped_column(Integer)
    reports: Mapped[Optional[int]] = mapped_column(Integer)
    kwp_pvsyst: Mapped[Optional[float]] = mapped_column(Float)
    kwp_model: Mapped[Optional[float]] = mapped_column(Float)
    mwh_year: Mapped[Optional[float]] = mapped_column(Float)
    specific_yield: Mapped[Optional[float]] = mapped_column(Float)  # kWh/kWp/yr, PVsyst
    pr_weighted: Mapped[Optional[float]] = mapped_column(Float)  # 0-1
    contract_specific_yield: Mapped[Optional[float]] = mapped_column(Float)  # kWh/kWp/yr, first contract year
    contract_over_pvsyst: Mapped[Optional[float]] = mapped_column(Float)
    contract_kwh_y1: Mapped[Optional[float]] = mapped_column(Float)
    source: Mapped[Optional[str]] = mapped_column(String(200))
    imported_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow, nullable=False)


class PvsystStation(Base):
    """One station row of `PVsyst_ระยะN` (key = phase + `ลำดับ`). `mwh_month` = 12 E_Grid values (MWh,
    Jan..Dec; null where the sheet has none). `orientations` = [[tilt, azimuth], …] parsed from the
    report's Tilt/Azimuth text (PVsyst convention: azimuth 0 = south, −90 = east, 90 = west), null when
    any part of the text does not read as tilt/azimuth; `tilt_deg` / `azimuth_deg` only for a station
    with a single orientation. `report_code` = the daily report's site id (phase 2, from sheet
    `ประมาณการ_kWh_ระยะ2` column `รหัสในรายงานประจำวัน`). `contract_kwh_y1` = section ค's first-year
    contract kWh: from the contract sheet (`contract_basis` = contract, phase 1) or the model's estimate
    (`estimated`, phases 2-4: the phase's contract ÷ PVsyst × the station's PVsyst)."""

    __tablename__ = "pvsyst_stations"

    phase: Mapped[int] = mapped_column(Integer, primary_key=True)
    seq: Mapped[int] = mapped_column(Integer, primary_key=True)
    project: Mapped[Optional[str]] = mapped_column(String(32))
    name: Mapped[str] = mapped_column(String(300), nullable=False)
    branch: Mapped[Optional[str]] = mapped_column(String(200))
    lat: Mapped[Optional[float]] = mapped_column(Float)
    lon: Mapped[Optional[float]] = mapped_column(Float)
    tilt_azimuth: Mapped[Optional[str]] = mapped_column(String(200))
    orientations: Mapped[Optional[Any]] = mapped_column(JSON)
    tilt_deg: Mapped[Optional[float]] = mapped_column(Float)
    azimuth_deg: Mapped[Optional[float]] = mapped_column(Float)
    modules: Mapped[Optional[int]] = mapped_column(Integer)
    wp_per_module: Mapped[Optional[float]] = mapped_column(Float)
    kwp: Mapped[Optional[float]] = mapped_column(Float)
    kwac: Mapped[Optional[float]] = mapped_column(Float)
    kwp_model: Mapped[Optional[float]] = mapped_column(Float)
    pr: Mapped[Optional[float]] = mapped_column(Float)  # 0-1
    mwh_month: Mapped[Any] = mapped_column(JSON, nullable=False)
    mwh_year: Mapped[Optional[float]] = mapped_column(Float)
    mwh_year_report: Mapped[Optional[float]] = mapped_column(Float)
    specific_yield: Mapped[Optional[float]] = mapped_column(Float)  # kWh/kWp/yr
    report_code: Mapped[Optional[str]] = mapped_column(String(16), index=True)
    contract_kwh_y1: Mapped[Optional[float]] = mapped_column(Float)
    contract_basis: Mapped[Optional[str]] = mapped_column(String(16))
    note: Mapped[Optional[str]] = mapped_column(Text)
    source: Mapped[Optional[str]] = mapped_column(String(200))
    imported_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow, nullable=False)
