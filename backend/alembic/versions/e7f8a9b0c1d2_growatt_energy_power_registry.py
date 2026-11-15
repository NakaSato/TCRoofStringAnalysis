"""growatt energy days, plant power curve, plant details and device model

Tables `growatt_plant_energy_days` (`plant/energy`), `growatt_inverter_energy_days`
(`device/inverter/day_energy`) and `growatt_plant_power` (`plant/power`), all finished days only;
registry columns from `plant/details` on `growatt_plants` and from `new-api/queryDeviceInfoParam`
on `growatt_inverters` (docs/plans/growatt-new-endpoints.md). `ensure_schema` creates the same at
startup, so this migration skips what is already there.

Revision ID: e7f8a9b0c1d2
Revises: d6e7f8a9b0c1
Create Date: 2026-11-15 15:00:00

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "e7f8a9b0c1d2"
down_revision: Union[str, None] = "d6e7f8a9b0c1"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

COLUMNS = {
    "growatt_plants": [
        ("timezone", sa.String(32)),
        ("address", sa.String(255)),
        ("growatt_inverter_count", sa.Integer()),
        ("growatt_datalogger_count", sa.Integer()),
        ("details_synced_at", sa.DateTime(timezone=True)),
    ],
    "growatt_inverters": [
        ("device_model", sa.String(64)),
        ("datalogger_model", sa.String(64)),
        ("rated_power_w", sa.Float()),
        ("param_synced_at", sa.DateTime(timezone=True)),
    ],
}


def upgrade() -> None:
    insp = sa.inspect(op.get_bind())
    tables = set(insp.get_table_names())
    for table, cols in COLUMNS.items():
        have = {c["name"] for c in insp.get_columns(table)}
        with op.batch_alter_table(table) as batch:
            for name, type_ in cols:
                if name not in have:
                    batch.add_column(sa.Column(name, type_, nullable=True))
    if "growatt_plant_energy_days" not in tables:
        op.create_table(
            "growatt_plant_energy_days",
            sa.Column("plant_id", sa.Integer(), primary_key=True, autoincrement=False),
            sa.Column("day", sa.Date(), primary_key=True),
            sa.Column("energy_kwh", sa.Float(), nullable=True),
            sa.Column("synced_at", sa.DateTime(timezone=True), nullable=False),
        )
    if "growatt_inverter_energy_days" not in tables:
        op.create_table(
            "growatt_inverter_energy_days",
            sa.Column("device_sn", sa.String(64), primary_key=True),
            sa.Column("day", sa.Date(), primary_key=True),
            sa.Column("plant_id", sa.Integer(), nullable=False),
            sa.Column("energy_kwh", sa.Float(), nullable=True),
            sa.Column("synced_at", sa.DateTime(timezone=True), nullable=False),
        )
        op.create_index("ix_growatt_inv_energy_plant_day", "growatt_inverter_energy_days", ["plant_id", "day"])
    if "growatt_plant_power" not in tables:
        op.create_table(
            "growatt_plant_power",
            sa.Column("plant_id", sa.Integer(), primary_key=True, autoincrement=False),
            sa.Column("timestamp", sa.DateTime(), primary_key=True),
            sa.Column("power_w", sa.Float(), nullable=False),
        )


def downgrade() -> None:
    op.drop_table("growatt_plant_power")
    op.drop_index("ix_growatt_inv_energy_plant_day", table_name="growatt_inverter_energy_days")
    op.drop_table("growatt_inverter_energy_days")
    op.drop_table("growatt_plant_energy_days")
    for table, cols in COLUMNS.items():
        with op.batch_alter_table(table) as batch:
            for name, _ in reversed(cols):
                batch.drop_column(name)
