"""growatt meters

`growatt_meters` (energy meter on a datalogger, keyed by datalogger SN + bus address, from
`device/ammeter/meter_list`) and `growatt_meter_readings` (its 5-minute `meter_data` records:
grid power at the connection point and the import counter). `ensure_schema` creates both at
startup too, so this migration skips a table that is already present.

Revision ID: c8d9e0f1a2b3
Revises: b7c8d9e0f1a2
Create Date: 2026-11-15 21:00:00

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "c8d9e0f1a2b3"
down_revision: Union[str, None] = "b7c8d9e0f1a2"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

READING_COLUMNS = (
    "active_power_w",
    "active_power_l1_w",
    "active_power_l2_w",
    "active_power_l3_w",
    "reactive_power_var",
    "power_factor",
    "frequency_hz",
    "import_counter_kwh",
    "forward_today_kwh",
    "rever_active_power_raw",
    "reverse_today_kwh",
)


def upgrade() -> None:
    insp = sa.inspect(op.get_bind())
    if not insp.has_table("growatt_meters"):
        op.create_table(
            "growatt_meters",
            sa.Column("datalogger_sn", sa.String(64), primary_key=True),
            sa.Column("address", sa.Integer(), primary_key=True, autoincrement=False),
            sa.Column("plant_id", sa.Integer(), sa.ForeignKey("growatt_plants.plant_id", ondelete="CASCADE"), nullable=False),
            sa.Column("device_name", sa.String(64), nullable=True),
            sa.Column("device_type", sa.String(16), nullable=True),
            sa.Column("history_synced_until", sa.DateTime(), nullable=True),
            sa.Column("synced_at", sa.DateTime(timezone=True), nullable=False),
        )
        op.create_index("ix_growatt_meters_plant_id", "growatt_meters", ["plant_id"])
    if not insp.has_table("growatt_meter_readings"):
        op.create_table(
            "growatt_meter_readings",
            sa.Column("datalogger_sn", sa.String(64), primary_key=True),
            sa.Column("address", sa.Integer(), primary_key=True, autoincrement=False),
            sa.Column("timestamp", sa.DateTime(), primary_key=True),
            *[sa.Column(c, sa.Float(), nullable=True) for c in READING_COLUMNS],
            sa.ForeignKeyConstraint(
                ["datalogger_sn", "address"],
                ["growatt_meters.datalogger_sn", "growatt_meters.address"],
                ondelete="CASCADE",
            ),
        )
        op.create_index("ix_growatt_meter_ts", "growatt_meter_readings", ["timestamp"])


def downgrade() -> None:
    op.drop_index("ix_growatt_meter_ts", table_name="growatt_meter_readings")
    op.drop_table("growatt_meter_readings")
    op.drop_index("ix_growatt_meters_plant_id", table_name="growatt_meters")
    op.drop_table("growatt_meters")
