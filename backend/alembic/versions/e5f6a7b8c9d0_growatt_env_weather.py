"""growatt_env_sensors / growatt_env_readings: weather sensors and their 5-minute history

Revision ID: e5f6a7b8c9d0
Revises: d4e5f6a7b8c9
Create Date: 2026-11-12 23:30:00

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "e5f6a7b8c9d0"
down_revision: Union[str, None] = "d4e5f6a7b8c9"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    tables = sa.inspect(op.get_bind()).get_table_names()
    if "growatt_env_sensors" not in tables:  # else already created by ensure_schema at startup
        op.create_table(
            "growatt_env_sensors",
            sa.Column("datalogger_sn", sa.String(length=64), nullable=False),
            sa.Column("address", sa.Integer(), nullable=False, autoincrement=False),
            sa.Column(
                "plant_id", sa.Integer(), sa.ForeignKey("growatt_plants.plant_id", ondelete="CASCADE"), nullable=False
            ),
            sa.Column("device_name", sa.String(length=64), nullable=True),
            sa.Column("history_synced_until", sa.DateTime(), nullable=True),
            sa.Column("synced_at", sa.DateTime(timezone=True), nullable=False),
            sa.PrimaryKeyConstraint("datalogger_sn", "address"),
        )
        op.create_index("ix_growatt_env_sensors_plant_id", "growatt_env_sensors", ["plant_id"])
    if "growatt_env_readings" not in tables:
        op.create_table(
            "growatt_env_readings",
            sa.Column("datalogger_sn", sa.String(length=64), nullable=False),
            sa.Column("address", sa.Integer(), nullable=False, autoincrement=False),
            sa.Column("timestamp", sa.DateTime(), nullable=False),
            sa.Column("irradiance_wm2", sa.Float(), nullable=True),
            sa.Column("ambient_temp_c", sa.Float(), nullable=True),
            sa.Column("module_temp_c", sa.Float(), nullable=True),
            sa.Column("humidity_pct", sa.Float(), nullable=True),
            sa.Column("wind_speed_ms", sa.Float(), nullable=True),
            sa.Column("wind_dir_deg", sa.Float(), nullable=True),
            sa.PrimaryKeyConstraint("datalogger_sn", "address", "timestamp"),
            sa.ForeignKeyConstraint(
                ["datalogger_sn", "address"],
                ["growatt_env_sensors.datalogger_sn", "growatt_env_sensors.address"],
                ondelete="CASCADE",
            ),
        )
        op.create_index("ix_growatt_env_ts", "growatt_env_readings", ["timestamp"])


def downgrade() -> None:
    op.drop_index("ix_growatt_env_ts", table_name="growatt_env_readings")
    op.drop_table("growatt_env_readings")
    op.drop_index("ix_growatt_env_sensors_plant_id", table_name="growatt_env_sensors")
    op.drop_table("growatt_env_sensors")
