"""inverter name, rated power and firmware on the Growatt inverter registry

From `device/max/max_data_info` (`alias`, `normalPower`, `fwVersion`, `innerVersion`), fetched
by the fleet job. `app.db.session.ensure_schema` adds the same columns at startup, so this
migration skips columns that are already there.

Revision ID: a1b2c3d4e5f7
Revises: e5f6a7b8c9d0
Create Date: 2026-11-12 19:00:00

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "a1b2c3d4e5f7"
down_revision: Union[str, None] = "e5f6a7b8c9d0"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

_COLUMNS = [
    sa.Column("alias", sa.String(64), nullable=True),
    sa.Column("nominal_power_w", sa.Float(), nullable=True),
    sa.Column("fw_version", sa.String(32), nullable=True),
    sa.Column("inner_version", sa.String(32), nullable=True),
    sa.Column("info_synced_at", sa.DateTime(timezone=True), nullable=True),
]


def upgrade() -> None:
    have = {c["name"] for c in sa.inspect(op.get_bind()).get_columns("growatt_inverters")}
    with op.batch_alter_table("growatt_inverters") as batch:
        for col in _COLUMNS:
            if col.name not in have:
                batch.add_column(col.copy())


def downgrade() -> None:
    with op.batch_alter_table("growatt_inverters") as batch:
        for col in reversed(_COLUMNS):
            batch.drop_column(col.name)
