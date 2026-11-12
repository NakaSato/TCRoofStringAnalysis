"""drop realtime columns from the Growatt registry

Plant current power / lifetime energy / status and inverter status / lost / last upload
time are realtime values. They are served from `/growatt/live/*` (memory only) and must
not be stored in SQL.

Revision ID: d8e9f0a1b2c3
Revises: c4d5e6f7a8b9
Create Date: 2026-11-12 13:00:00

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "d8e9f0a1b2c3"
down_revision: Union[str, None] = "c4d5e6f7a8b9"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    with op.batch_alter_table("growatt_plants") as batch:
        batch.drop_column("current_power_w")
        batch.drop_column("total_energy_kwh")
        batch.drop_column("status")
    with op.batch_alter_table("growatt_inverters") as batch:
        batch.drop_column("status")
        batch.drop_column("lost")
        batch.drop_column("last_update_time")


def downgrade() -> None:
    with op.batch_alter_table("growatt_inverters") as batch:
        batch.add_column(sa.Column("last_update_time", sa.DateTime(), nullable=True))
        batch.add_column(sa.Column("lost", sa.Boolean(), nullable=False, server_default=sa.false()))
        batch.add_column(sa.Column("status", sa.Integer(), nullable=True))
    with op.batch_alter_table("growatt_plants") as batch:
        batch.add_column(sa.Column("status", sa.Integer(), nullable=True))
        batch.add_column(sa.Column("total_energy_kwh", sa.Float(), nullable=True))
        batch.add_column(sa.Column("current_power_w", sa.Float(), nullable=True))
