"""stock register phase 5: stock counts (docs/plans/spares-failed-units.md §5.7)

`stock_counts` (one row per confirmed count of a location). `ensure_schema` creates the table at
startup too, so it is skipped when present. The new unit state `missing` and movement kind
`count_adjust` are plain strings (no DB enum): no column changes.

Revision ID: d5a9e3b7c124
Revises: c4f8a2d61e93
Create Date: 2026-11-26 21:00:00

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "d5a9e3b7c124"
down_revision: Union[str, None] = "c4f8a2d61e93"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    insp = sa.inspect(op.get_bind())
    if "stock_counts" in set(insp.get_table_names()):
        return
    op.create_table(
        "stock_counts",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("location_id", sa.Integer(), sa.ForeignKey("stock_locations.id"), nullable=False, index=True),
        sa.Column("batch_id", sa.String(36)),
        sa.Column("by", sa.String(64)),
        sa.Column("at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("day", sa.Date(), nullable=False),
        sa.Column("scanned", sa.Integer(), nullable=False),
        sa.Column("matched", sa.Integer(), nullable=False),
        sa.Column("missing", sa.Integer(), nullable=False),
        sa.Column("moved_here", sa.Integer(), nullable=False),
        sa.Column("new_units", sa.Integer(), nullable=False),
        sa.Column("found_again", sa.Integer(), nullable=False),
        sa.Column("note", sa.Text()),
    )


def downgrade() -> None:
    op.drop_table("stock_counts")
