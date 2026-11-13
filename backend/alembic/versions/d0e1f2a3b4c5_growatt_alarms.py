"""Growatt alarm log in SQL: growatt_alarms + growatt_alarm_syncs

The worker's `alarms` / `alarms_yesterday` jobs store `device/max/alarm_data` per inverter-day so
the Active Alarm page reads the whole fleet from the DB. `app.db.session.ensure_schema` creates
the same tables at startup, so this skips existing ones.

Revision ID: d0e1f2a3b4c5
Revises: c9d0e1f2a3b4
Create Date: 2026-11-13 10:00:00

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "d0e1f2a3b4c5"
down_revision: Union[str, None] = "c9d0e1f2a3b4"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    tables = set(sa.inspect(op.get_bind()).get_table_names())
    if "growatt_alarms" not in tables:
        op.create_table(
            "growatt_alarms",
            sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
            sa.Column("device_sn", sa.String(64), nullable=False),
            sa.Column(
                "plant_id", sa.Integer(), sa.ForeignKey("growatt_plants.plant_id", ondelete="CASCADE"), nullable=False
            ),
            sa.Column("day", sa.Date(), nullable=False),
            sa.Column("start_time", sa.DateTime(), nullable=True),
            sa.Column("end_time", sa.DateTime(), nullable=True),
            sa.Column("alarm_code", sa.String(32), nullable=True),
            sa.Column("alarm_message", sa.String(255), nullable=True),
            sa.Column("fault_type", sa.String(32), nullable=True),
            sa.Column("status", sa.Integer(), nullable=True),
        )
        op.create_index("ix_growatt_alarms_day_plant", "growatt_alarms", ["day", "plant_id"])
        op.create_index("ix_growatt_alarms_sn_day", "growatt_alarms", ["device_sn", "day"])
    if "growatt_alarm_syncs" not in tables:
        op.create_table(
            "growatt_alarm_syncs",
            sa.Column("device_sn", sa.String(64), primary_key=True),
            sa.Column("day", sa.Date(), primary_key=True),
            sa.Column(
                "plant_id", sa.Integer(), sa.ForeignKey("growatt_plants.plant_id", ondelete="CASCADE"), nullable=False
            ),
            sa.Column("synced_at", sa.DateTime(timezone=True), nullable=False),
            sa.Column("alarm_count", sa.Integer(), nullable=False),
        )
        op.create_index("ix_growatt_alarm_syncs_day", "growatt_alarm_syncs", ["day"])


def downgrade() -> None:
    op.drop_index("ix_growatt_alarm_syncs_day", table_name="growatt_alarm_syncs")
    op.drop_table("growatt_alarm_syncs")
    op.drop_index("ix_growatt_alarms_sn_day", table_name="growatt_alarms")
    op.drop_index("ix_growatt_alarms_day_plant", table_name="growatt_alarms")
    op.drop_table("growatt_alarms")
