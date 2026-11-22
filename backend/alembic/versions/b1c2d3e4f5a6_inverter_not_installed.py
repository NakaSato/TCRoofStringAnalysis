"""growatt_inverters.not_installed_*: inverters listed in Growatt but not installed on site

An admin marks such an inverter (`PUT /growatt/plants/{id}/inverters/{sn}/installed`); it is then
left out of every job, live call, count and analysis. Its stored rows stay. `ensure_schema` adds
the columns at startup too, so each is skipped when present.

Revision ID: b1c2d3e4f5a6
Revises: a0b1c2d3e4f5
Create Date: 2026-11-22 18:00:00

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "b1c2d3e4f5a6"
down_revision: Union[str, None] = "a0b1c2d3e4f5"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

_COLUMNS = [
    sa.Column("not_installed_at", sa.DateTime(timezone=True), nullable=True),
    sa.Column("not_installed_by", sa.String(length=64), nullable=True),
    sa.Column("not_installed_note", sa.String(length=255), nullable=True),
]


def upgrade() -> None:
    have = {c["name"] for c in sa.inspect(op.get_bind()).get_columns("growatt_inverters")}
    for col in _COLUMNS:
        if col.name not in have:
            op.add_column("growatt_inverters", col)


def downgrade() -> None:
    for col in reversed(_COLUMNS):
        op.drop_column("growatt_inverters", col.name)
