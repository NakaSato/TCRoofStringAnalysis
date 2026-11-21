"""pwa_meter_expected + pwa_meter_sites.meter_no: monthly expected energy and report meter numbers

`pwa_meter_expected` holds each site's modelled contract and PVsyst kWh per day for a calendar
month (from the TFRS 16 / PVsyst model); the daily report import fills contract / PVsyst from it.
`pwa_meter_sites.meter_no` is the Cewe meter number the report prints under a site. SQL only.
`ensure_schema` creates both at startup too, so each step is skipped when present.

Revision ID: 6f2a3b4c5d7e
Revises: 5e1f2a3b4c6d
Create Date: 2026-11-21 12:00:00

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "6f2a3b4c5d7e"
down_revision: Union[str, None] = "5e1f2a3b4c6d"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    insp = sa.inspect(op.get_bind())
    if "meter_no" not in {c["name"] for c in insp.get_columns("pwa_meter_sites")}:
        op.add_column("pwa_meter_sites", sa.Column("meter_no", sa.String(16), nullable=True))
        op.create_index("ix_pwa_meter_sites_meter_no", "pwa_meter_sites", ["meter_no"])
    if "pwa_meter_expected" not in insp.get_table_names():
        op.create_table(
            "pwa_meter_expected",
            sa.Column("site_id", sa.String(16), sa.ForeignKey("pwa_meter_sites.site_id", ondelete="CASCADE"), primary_key=True),
            sa.Column("month", sa.Date(), primary_key=True),
            sa.Column("contract_kwh_day", sa.Float(), nullable=True),
            sa.Column("pvsyst_kwh_day", sa.Float(), nullable=True),
            sa.Column("basis", sa.String(64), nullable=True),
            sa.Column("source", sa.String(200), nullable=True),
            sa.Column("imported_at", sa.DateTime(timezone=True), nullable=False),
        )


def downgrade() -> None:
    op.drop_table("pwa_meter_expected")
    op.drop_index("ix_pwa_meter_sites_meter_no", table_name="pwa_meter_sites")
    op.drop_column("pwa_meter_sites", "meter_no")
