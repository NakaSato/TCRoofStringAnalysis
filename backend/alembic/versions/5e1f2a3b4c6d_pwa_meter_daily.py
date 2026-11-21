"""pwa_meter: PWA daily meter report sites and site-days (docs/plans/pwa-meter-daily.md)

`pwa_meter_sites` (report site ↔ Growatt plant) and `pwa_meter_days` (one row per site and day).
SQL only, kept indefinitely. `ensure_schema` creates the tables at startup too, so each one is
skipped when present.

Revision ID: 5e1f2a3b4c6d
Revises: 9c3e5a7b2d14
Create Date: 2026-11-21 02:00:00

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "5e1f2a3b4c6d"
down_revision: Union[str, None] = "9c3e5a7b2d14"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    have = set(sa.inspect(op.get_bind()).get_table_names())
    if "pwa_meter_sites" not in have:
        op.create_table(
            "pwa_meter_sites",
            sa.Column("site_id", sa.String(16), primary_key=True),
            sa.Column("phase", sa.Integer(), nullable=False),
            sa.Column("name", sa.String(200), nullable=False),
            sa.Column("region", sa.String(32), nullable=True),
            sa.Column("kwp", sa.Float(), nullable=False),
            sa.Column("contract_seq", sa.Integer(), nullable=True),
            sa.Column("pvsyst_seq", sa.Integer(), nullable=True),
            sa.Column("growatt_plant_id", sa.Integer(), nullable=True),
            sa.Column("growatt_name", sa.String(200), nullable=True),
            sa.Column("growatt_kwp", sa.Float(), nullable=True),
            sa.Column("kwp_mismatch", sa.Boolean(), nullable=False),
            sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        )
        op.create_index("ix_pwa_meter_sites_growatt_plant_id", "pwa_meter_sites", ["growatt_plant_id"])
    if "pwa_meter_days" not in have:
        op.create_table(
            "pwa_meter_days",
            sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
            sa.Column("site_id", sa.String(16), sa.ForeignKey("pwa_meter_sites.site_id", ondelete="CASCADE"), nullable=False),
            sa.Column("day", sa.Date(), nullable=False),
            sa.Column("meter_kwh", sa.Float(), nullable=True),
            sa.Column("inverter_kwh", sa.Float(), nullable=True),
            sa.Column("contract_kwh", sa.Float(), nullable=True),
            sa.Column("pvsyst_kwh", sa.Float(), nullable=True),
            sa.Column("status", sa.String(12), nullable=False),
            sa.Column("curtailment_note", sa.Boolean(), nullable=False),
            sa.Column("weather", sa.String(12), nullable=True),
            sa.Column("note", sa.Text(), nullable=True),
            sa.Column("imported_at", sa.DateTime(timezone=True), nullable=False),
            sa.UniqueConstraint("site_id", "day", name="uq_pwa_meter_days_site_day"),
        )
        op.create_index("ix_pwa_meter_days_day", "pwa_meter_days", ["day"])


def downgrade() -> None:
    op.drop_table("pwa_meter_days")
    op.drop_table("pwa_meter_sites")
