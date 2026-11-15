"""Decision rules Phase 1: growatt_string_daily and growatt_inverter_daily

Daily string and inverter statistics computed from stored history (docs/plans/decision-rules.md
§3). Kept indefinitely. `app.db.session.ensure_schema` creates the same tables at startup, so
this skips any that already exist.

Revision ID: a9b8c7d6e5f4
Revises: cd402d2f8b81
Create Date: 2026-11-15 18:00:00

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "a9b8c7d6e5f4"
down_revision: Union[str, None] = "cd402d2f8b81"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    tables = set(sa.inspect(op.get_bind()).get_table_names())
    if "growatt_string_daily" not in tables:
        op.create_table(
            "growatt_string_daily",
            sa.Column("device_sn", sa.String(64), primary_key=True),
            sa.Column("string_no", sa.Integer(), primary_key=True, autoincrement=False),
            sa.Column("day", sa.Date(), primary_key=True),
            sa.Column("plant_id", sa.Integer(), nullable=False),
            sa.Column("gated_slots", sa.Integer(), nullable=False),
            sa.Column("ratio_median", sa.Float()),
            sa.Column("low_min", sa.Integer()),
            sa.Column("severe_min", sa.Integer()),
            sa.Column("open_min", sa.Integer(), nullable=False),
            sa.Column("v_ratio_median", sa.Float()),
            sa.Column("energy_kwh", sa.Float()),
            sa.Column("lost_kwh_est", sa.Float()),
            sa.Column("computed_at", sa.DateTime(timezone=True), nullable=False),
        )
        op.create_index("ix_growatt_str_daily_plant_day", "growatt_string_daily", ["plant_id", "day"])
    if "growatt_inverter_daily" not in tables:
        op.create_table(
            "growatt_inverter_daily",
            sa.Column("device_sn", sa.String(64), primary_key=True),
            sa.Column("day", sa.Date(), primary_key=True),
            sa.Column("plant_id", sa.Integer(), nullable=False),
            *(
                sa.Column(c, sa.Integer(), nullable=False)
                for c in ("daylight_min", "producing_min", "fault_min", "off_min", "standby_min", "limited_min", "no_data_min")
            ),
            *(
                sa.Column(c, sa.Float())
                for c in (
                    "energy_kwh", "kwp", "yf_kwh_kwp", "yf_vs_median_pct", "plant_kwp_share_pct",
                    "lost_fault_kwh_est", "lost_off_kwh_est", "lost_standby_kwh_est", "lost_no_data_kwh_est",
                )
            ),
            sa.Column("computed_at", sa.DateTime(timezone=True), nullable=False),
        )
        op.create_index("ix_growatt_inv_daily_plant_day", "growatt_inverter_daily", ["plant_id", "day"])


def downgrade() -> None:
    op.drop_table("growatt_inverter_daily")
    op.drop_table("growatt_string_daily")
