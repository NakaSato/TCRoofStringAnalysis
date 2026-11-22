"""pvsyst_phases + pvsyst_stations: PVsyst design data of the PWA stations (phases 1-4)

Imported from the TFRS 16 model workbook's PVsyst sheets (`python -m app.services.pvsyst import`),
modelled design figures, SQL only. `ensure_schema` creates both at startup too, so each table is
skipped when present.

Revision ID: 9e5f6a7b8c0d
Revises: 8d4e5f6a7b9c
Create Date: 2026-11-22 12:00:00

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "9e5f6a7b8c0d"
down_revision: Union[str, None] = "8d4e5f6a7b9c"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    tables = set(sa.inspect(op.get_bind()).get_table_names())
    if "pvsyst_phases" not in tables:
        op.create_table(
            "pvsyst_phases",
            sa.Column("phase", sa.Integer(), primary_key=True, autoincrement=False),
            sa.Column("stations_model", sa.Integer()),
            sa.Column("reports", sa.Integer()),
            sa.Column("kwp_pvsyst", sa.Float()),
            sa.Column("kwp_model", sa.Float()),
            sa.Column("mwh_year", sa.Float()),
            sa.Column("specific_yield", sa.Float()),
            sa.Column("pr_weighted", sa.Float()),
            sa.Column("contract_specific_yield", sa.Float()),
            sa.Column("contract_over_pvsyst", sa.Float()),
            sa.Column("contract_kwh_y1", sa.Float()),
            sa.Column("source", sa.String(200)),
            sa.Column("imported_at", sa.DateTime(timezone=True), nullable=False),
        )
    if "pvsyst_stations" not in tables:
        op.create_table(
            "pvsyst_stations",
            sa.Column("phase", sa.Integer(), primary_key=True, autoincrement=False),
            sa.Column("seq", sa.Integer(), primary_key=True, autoincrement=False),
            sa.Column("project", sa.String(32)),
            sa.Column("name", sa.String(300), nullable=False),
            sa.Column("branch", sa.String(200)),
            sa.Column("lat", sa.Float()),
            sa.Column("lon", sa.Float()),
            sa.Column("tilt_azimuth", sa.String(200)),
            sa.Column("orientations", sa.JSON()),
            sa.Column("tilt_deg", sa.Float()),
            sa.Column("azimuth_deg", sa.Float()),
            sa.Column("modules", sa.Integer()),
            sa.Column("wp_per_module", sa.Float()),
            sa.Column("kwp", sa.Float()),
            sa.Column("kwac", sa.Float()),
            sa.Column("kwp_model", sa.Float()),
            sa.Column("pr", sa.Float()),
            sa.Column("mwh_month", sa.JSON(), nullable=False),
            sa.Column("mwh_year", sa.Float()),
            sa.Column("mwh_year_report", sa.Float()),
            sa.Column("specific_yield", sa.Float()),
            sa.Column("report_code", sa.String(16)),
            sa.Column("contract_kwh_y1", sa.Float()),
            sa.Column("contract_basis", sa.String(16)),
            sa.Column("note", sa.Text()),
            sa.Column("source", sa.String(200)),
            sa.Column("imported_at", sa.DateTime(timezone=True), nullable=False),
        )
        op.create_index("ix_pvsyst_stations_report_code", "pvsyst_stations", ["report_code"])


def downgrade() -> None:
    op.drop_index("ix_pvsyst_stations_report_code", table_name="pvsyst_stations")
    op.drop_table("pvsyst_stations")
    op.drop_table("pvsyst_phases")
