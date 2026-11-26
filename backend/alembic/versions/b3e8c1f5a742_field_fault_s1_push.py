"""field faults: when a fault became S1 and when that was pushed (docs/plans/defects.md §9)

`field_faults.s1_at` / `s1_pushed_at`. `ensure_schema` adds them at startup too, so a column
already present is skipped.

Revision ID: b3e8c1f5a742
Revises: a1d4f7c2e905
Create Date: 2026-11-27 02:00:00

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "b3e8c1f5a742"
down_revision: Union[str, None] = "a1d4f7c2e905"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

_COLUMNS = [
    ("field_faults", sa.Column("s1_at", sa.DateTime(timezone=True), nullable=True)),
    ("field_faults", sa.Column("s1_pushed_at", sa.DateTime(timezone=True), nullable=True)),
]


def upgrade() -> None:
    insp = sa.inspect(op.get_bind())
    for table, col in _COLUMNS:
        if col.name not in {c["name"] for c in insp.get_columns(table)}:
            op.add_column(table, col)


def downgrade() -> None:
    for table, col in reversed(_COLUMNS):
        op.drop_column(table, col.name)
