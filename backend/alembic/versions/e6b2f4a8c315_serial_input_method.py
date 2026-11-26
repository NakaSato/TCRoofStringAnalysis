"""how serials were entered on claims and instrument check-outs (docs/plans/barcode-scanning.md §9)

`claims.serial_inputs` (JSON: per serial field the input method and raw scan) and
`instrument_checkouts.input_method` / `raw_scan`. `ensure_schema` adds them at startup too, so a
column already present is skipped.

Revision ID: e6b2f4a8c315
Revises: d5a9e3b7c124
Create Date: 2026-11-26 17:30:00

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "e6b2f4a8c315"
down_revision: Union[str, None] = "d5a9e3b7c124"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

_COLUMNS = [
    ("claims", sa.Column("serial_inputs", sa.JSON(), nullable=True)),
    ("instrument_checkouts", sa.Column("input_method", sa.String(8), nullable=True)),
    ("instrument_checkouts", sa.Column("raw_scan", sa.String(512), nullable=True)),
]


def upgrade() -> None:
    insp = sa.inspect(op.get_bind())
    for table, col in _COLUMNS:
        if col.name not in {c["name"] for c in insp.get_columns(table)}:
            op.add_column(table, col)


def downgrade() -> None:
    for table, col in reversed(_COLUMNS):
        op.drop_column(table, col.name)
