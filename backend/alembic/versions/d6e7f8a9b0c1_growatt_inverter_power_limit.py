"""growatt inverter power limit from readPower

`growatt_inverters.power_limit_pct` / `power_limit_read_at`: the active power limit read from
the inverter by the daytime `power_limits` job (`new-api/readPower`). `ensure_schema` adds the
same columns at startup, so this migration skips what is already there.

Revision ID: d6e7f8a9b0c1
Revises: b4c5d6e7f8a9
Create Date: 2026-11-15 13:00:00

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "d6e7f8a9b0c1"
down_revision: Union[str, None] = "b4c5d6e7f8a9"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

COLUMNS = [
    ("power_limit_pct", sa.Float()),
    ("power_limit_read_at", sa.DateTime(timezone=True)),
]


def upgrade() -> None:
    have = {c["name"] for c in sa.inspect(op.get_bind()).get_columns("growatt_inverters")}
    with op.batch_alter_table("growatt_inverters") as batch:
        for name, type_ in COLUMNS:
            if name not in have:
                batch.add_column(sa.Column(name, type_, nullable=True))


def downgrade() -> None:
    with op.batch_alter_table("growatt_inverters") as batch:
        for name, _ in reversed(COLUMNS):
            batch.drop_column(name)
