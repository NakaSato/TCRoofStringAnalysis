"""growatt_inverter_raw: the whole max_data record of each inverter reading

Every field Growatt reports (about 255), kept as JSON under Growatt's own names next to the
computed columns of `growatt_inverter_readings`. `app.db.session.ensure_schema` creates the same
table at startup, so this skips it when present.

Revision ID: a4b5c6d7e8f9
Revises: f3a4b5c6d7e8
Create Date: 2026-11-16 18:00:00

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "a4b5c6d7e8f9"
down_revision: Union[str, None] = "f3a4b5c6d7e8"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

TABLE = "growatt_inverter_raw"


def upgrade() -> None:
    if TABLE in set(sa.inspect(op.get_bind()).get_table_names()):
        return
    op.create_table(
        TABLE,
        sa.Column("device_sn", sa.String(64), sa.ForeignKey("growatt_inverters.device_sn", ondelete="CASCADE"), primary_key=True),
        sa.Column("timestamp", sa.DateTime(), primary_key=True),
        sa.Column("data", sa.JSON(), nullable=False),
    )
    op.create_index("ix_growatt_inv_raw_ts", TABLE, ["timestamp"])


def downgrade() -> None:
    op.drop_index("ix_growatt_inv_raw_ts", table_name=TABLE)
    op.drop_table(TABLE)
