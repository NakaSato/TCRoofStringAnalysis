"""growatt_string_removed: string inputs removed from the String Layout editor

Layout only: a marked input is left out of `GET /growatt/plants/{id}/string-layout` even when it
carried current; its readings and every analysis are unchanged. `ensure_schema` creates it at
startup too, so it is skipped when present.

Revision ID: a0b1c2d3e4f5
Revises: 9e5f6a7b8c0d
Create Date: 2026-11-22 15:00:00

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "a0b1c2d3e4f5"
down_revision: Union[str, None] = "9e5f6a7b8c0d"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    if "growatt_string_removed" in sa.inspect(op.get_bind()).get_table_names():
        return  # already created by ensure_schema at startup
    op.create_table(
        "growatt_string_removed",
        sa.Column("device_sn", sa.String(length=64), nullable=False),
        sa.Column("string_no", sa.Integer(), autoincrement=False, nullable=False),
        sa.Column("removed_at", sa.DateTime(timezone=True), nullable=False),
        sa.PrimaryKeyConstraint("device_sn", "string_no"),
    )


def downgrade() -> None:
    op.drop_table("growatt_string_removed")
