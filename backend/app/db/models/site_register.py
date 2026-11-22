"""O&M site register: station data and the communication devices on site (docs/plans/om-asset-network.md).

Imported from the O&M team's workbook (`OM-Asset & Network.xlsx`, converted to JSON); a re-import replaces both
tables. Static data entered by people, not measurements: empty cells stay null. `plant_id` has no foreign key
(as for claims and plant documents); the blocked-plant cleanup deletes the rows.
"""

from __future__ import annotations

from datetime import date, datetime
from typing import Optional

from sqlalchemy import Date, DateTime, Float, ForeignKey, Integer, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.db.session import Base
from app.db.models.base import _utcnow


class SiteRegister(Base):
    """One station of the register (`P1-001` …), matched to its Growatt plant."""

    __tablename__ = "site_register"

    site_code: Mapped[str] = mapped_column(String(16), primary_key=True)
    # null = not matched to a Growatt plant
    plant_id: Mapped[Optional[int]] = mapped_column(Integer, unique=True, index=True)
    # logger_sn | logger_sn_prefix | name_code | kept
    match_rule: Mapped[Optional[str]] = mapped_column(String(24))
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    # project phase 1–4 (P4 sites sit in the Growatt phase 3 account)
    project_phase: Mapped[Optional[int]] = mapped_column(Integer)
    province: Mapped[Optional[str]] = mapped_column(String(64))
    kwp: Mapped[Optional[float]] = mapped_column(Float)
    inverter_ac_kw: Mapped[Optional[float]] = mapped_column(Float)
    # HV | MV | LV (กันย้อน)
    export_limit: Mapped[Optional[str]] = mapped_column(String(8))
    pea_meter_no: Mapped[Optional[str]] = mapped_column(String(32))
    pea_account_no: Mapped[Optional[str]] = mapped_column(String(32))
    pea_connection_status: Mapped[Optional[str]] = mapped_column(String(64))
    pwa_branch: Mapped[Optional[str]] = mapped_column(String(120))
    pwa_zone: Mapped[Optional[str]] = mapped_column(String(32))
    pea_zone: Mapped[Optional[str]] = mapped_column(String(32))
    # as written, e.g. "30,31"
    billing_cut_days: Mapped[Optional[str]] = mapped_column(String(16))
    revenue_meter_count: Mapped[Optional[int]] = mapped_column(Integer)
    pea_contract_start: Mapped[Optional[date]] = mapped_column(Date)
    cod_baseline: Mapped[Optional[date]] = mapped_column(Date)
    cod_actual: Mapped[Optional[date]] = mapped_column(Date)
    # S | C | B (ผรม. for DLP claims)
    dlp_contractor: Mapped[Optional[str]] = mapped_column(String(8))
    # nicknames as written; not app users
    engineers_text: Mapped[Optional[str]] = mapped_column(String(200))
    technicians_text: Mapped[Optional[str]] = mapped_column(String(200))
    missing_sn_count: Mapped[Optional[int]] = mapped_column(Integer)
    imported_by: Mapped[Optional[str]] = mapped_column(String(64))
    imported_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow, nullable=False)


class SiteDevice(Base):
    """A device on site: data logger, weather station, revenue meter (1–8), 4G router, PQM, ShineMaster."""

    __tablename__ = "site_devices"
    __table_args__ = (UniqueConstraint("site_code", "kind", "seq", name="uq_site_devices_site_kind_seq"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    site_code: Mapped[str] = mapped_column(
        String(16), ForeignKey("site_register.site_code", ondelete="CASCADE"), index=True, nullable=False
    )
    # datalogger | weather_station | revenue_meter | router | pqm | shinemaster
    kind: Mapped[str] = mapped_column(String(16), nullable=False)
    seq: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    brand_model: Mapped[Optional[str]] = mapped_column(String(120))
    serial: Mapped[Optional[str]] = mapped_column(String(64), index=True)
    firmware: Mapped[Optional[str]] = mapped_column(String(32))
    ip: Mapped[Optional[str]] = mapped_column(String(45))
    network: Mapped[Optional[str]] = mapped_column(String(43))
    sim: Mapped[Optional[str]] = mapped_column(String(16))
    # weather station Modbus address
    address: Mapped[Optional[str]] = mapped_column(String(8))
    ct_setting: Mapped[Optional[str]] = mapped_column(String(16))
    ct_site: Mapped[Optional[str]] = mapped_column(String(16))
    billing_cut_days: Mapped[Optional[str]] = mapped_column(String(16))
    sales_start: Mapped[Optional[date]] = mapped_column(Date)
    cod_clear_note: Mapped[Optional[str]] = mapped_column(String(200))
    link_status: Mapped[Optional[str]] = mapped_column(String(64))
    status: Mapped[Optional[str]] = mapped_column(String(32))
    warranty_start: Mapped[Optional[date]] = mapped_column(Date)
    warranty_end: Mapped[Optional[date]] = mapped_column(Date)
    note: Mapped[Optional[str]] = mapped_column(Text)
