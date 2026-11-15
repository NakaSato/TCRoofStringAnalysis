"""fault / warning code on inverter readings

`max_data` records carry the inverter's own `faultType` / `warnCode` at the record time. Kept
so a PWA check slot can name the fault of an inverter in fault status at its reading time, even
when the alarm log has not been read since. NULL = no code, or a record stored before this.

`app.db.session.ensure_schema` adds the same columns at startup, so this migration skips the
ones already there.

Revision ID: d9e0f1a2b3c4
Revises: c8d9e0f1a2b3
Create Date: 2026-11-15 22:30:00

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "d9e0f1a2b3c4"
down_revision: Union[str, None] = "c8d9e0f1a2b3"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

TABLE = "growatt_inverter_readings"
COLUMNS = ("fault_code", "warn_code")


def upgrade() -> None:
    have = {c["name"] for c in sa.inspect(op.get_bind()).get_columns(TABLE)}
    for name in COLUMNS:
        if name not in have:
            op.add_column(TABLE, sa.Column(name, sa.Integer(), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table(TABLE) as batch:
        for name in COLUMNS:
            batch.drop_column(name)
