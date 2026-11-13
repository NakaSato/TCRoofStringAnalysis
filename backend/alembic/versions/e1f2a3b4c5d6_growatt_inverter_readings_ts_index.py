"""growatt_inverter_readings: index on timestamp

Revision ID: e1f2a3b4c5d6
Revises: d0e1f2a3b4c5
Create Date: 2026-11-13

The plant list's fleet-wide time filters (newest record, one day's energy) scanned the whole
table without it. `ensure_schema` creates it too (CREATE INDEX IF NOT EXISTS).
"""
from typing import Sequence, Union

from alembic import op

revision: str = "e1f2a3b4c5d6"
down_revision: Union[str, None] = "d0e1f2a3b4c5"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_index("ix_growatt_inv_ts", "growatt_inverter_readings", ["timestamp"], unique=False, if_not_exists=True)


def downgrade() -> None:
    op.drop_index("ix_growatt_inv_ts", table_name="growatt_inverter_readings", if_exists=True)
