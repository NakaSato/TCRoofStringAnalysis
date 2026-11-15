"""when an inverter was added to Growatt

`device/all/create_date` gives each device's creation time on Growatt (naive, as reported). The
`fleet` job reads it once per inverter. NULL = not read yet.

`app.db.session.ensure_schema` adds the same column at startup, so this migration skips it when
it is already there.

Revision ID: e0f1a2b3c4d5
Revises: d9e0f1a2b3c4
Create Date: 2026-11-15 23:30:00

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "e0f1a2b3c4d5"
down_revision: Union[str, None] = "d9e0f1a2b3c4"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

TABLE = "growatt_inverters"
COLUMN = "growatt_created_at"


def upgrade() -> None:
    have = {c["name"] for c in sa.inspect(op.get_bind()).get_columns(TABLE)}
    if COLUMN not in have:
        op.add_column(TABLE, sa.Column(COLUMN, sa.DateTime(), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table(TABLE) as batch:
        batch.drop_column(COLUMN)
