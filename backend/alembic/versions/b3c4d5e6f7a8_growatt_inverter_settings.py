"""inverter settings (power limit, PF, export limit, on/off) on the Growatt inverter registry

From `device/max/max_data_info`, read by the fleet job together with name / rating / firmware.
`app.db.session.ensure_schema` adds the same columns at startup, so existing ones are skipped.

Revision ID: b3c4d5e6f7a8
Revises: a1b2c3d4e5f7
Create Date: 2026-11-13 00:30:00

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "b3c4d5e6f7a8"
down_revision: Union[str, None] = "a1b2c3d4e5f7"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

_COLUMNS = [
    sa.Column("active_rate_pct", sa.Float(), nullable=True),
    sa.Column("reactive_rate_pct", sa.Float(), nullable=True),
    sa.Column("pf_setting", sa.Float(), nullable=True),
    sa.Column("pf_model", sa.Integer(), nullable=True),
    sa.Column("export_limit", sa.Integer(), nullable=True),
    sa.Column("export_limit_rate_pct", sa.Float(), nullable=True),
    sa.Column("on_off", sa.Integer(), nullable=True),
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
