"""Decision rules Phase 2: growatt_issues and the on-peak lost-energy columns

The Issues queue (docs/plans/decision-rules.md §4.2) and the on-peak part of the daily tables'
estimated lost energy, which the tariff prices. `app.db.session.ensure_schema` creates the same
at startup, so this skips what already exists.

Revision ID: b4c5d6e7f8a9
Revises: a9b8c7d6e5f4
Create Date: 2026-11-15 22:00:00

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "b4c5d6e7f8a9"
down_revision: Union[str, None] = "a9b8c7d6e5f4"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

ADDED = [
    ("growatt_string_daily", "lost_on_peak_kwh_est"),
    ("growatt_inverter_daily", "lost_down_on_peak_kwh_est"),
    ("growatt_inverter_daily", "lost_no_data_on_peak_kwh_est"),
]


def upgrade() -> None:
    insp = sa.inspect(op.get_bind())
    tables = set(insp.get_table_names())
    for table, column in ADDED:
        if table in tables and column not in {c["name"] for c in insp.get_columns(table)}:
            op.add_column(table, sa.Column(column, sa.Float()))
    if "growatt_issues" not in tables:
        op.create_table(
            "growatt_issues",
            sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
            sa.Column("plant_id", sa.Integer(), nullable=False),
            sa.Column("device_sn", sa.String(64)),
            sa.Column("string_no", sa.Integer()),
            sa.Column("rule", sa.String(8), nullable=False),
            sa.Column("tier", sa.String(8), nullable=False),
            sa.Column("safety", sa.Boolean(), nullable=False),
            sa.Column("parent_id", sa.Integer()),
            sa.Column("opened_day", sa.Date(), nullable=False),
            sa.Column("last_seen_day", sa.Date(), nullable=False),
            sa.Column("days_seen", sa.Integer(), nullable=False),
            *(
                sa.Column(c, sa.Float())
                for c in ("lost_kwh_est", "thb_per_day_est", "lost_kwh_total_est", "thb_total_est")
            ),
            sa.Column("evidence", sa.JSON()),
            sa.Column("daily", sa.JSON()),
            sa.Column("status", sa.String(16), nullable=False),
            sa.Column("ack_by", sa.String(64)),
            sa.Column("ack_at", sa.DateTime(timezone=True)),
            sa.Column("note", sa.Text()),
            sa.Column("feedback", sa.String(16)),
            sa.Column("shadow", sa.Boolean(), nullable=False),
            sa.Column("closed_at", sa.DateTime(timezone=True)),
            sa.Column("closed_by", sa.String(64)),
            sa.Column("close_reason", sa.String(16)),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
            sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        )
        op.create_index("ix_growatt_issues_plant_status", "growatt_issues", ["plant_id", "status"])
        op.create_index("ix_growatt_issues_key", "growatt_issues", ["plant_id", "device_sn", "string_no", "rule"])


def downgrade() -> None:
    op.drop_table("growatt_issues")
    for table, column in ADDED:
        op.drop_column(table, column)
