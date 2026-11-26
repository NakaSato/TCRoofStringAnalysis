"""red tags (barcode scanning, plan step 5)

`red_tags`: pre-printed red tag numbers RT-0001…, reserved in batches by an admin.
`ensure_schema` creates the table at startup too, so it is skipped when present.

Revision ID: a3d5f8c2e914
Revises: 9c4e2a7b1d83
Create Date: 2026-11-26 11:45:00

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "a3d5f8c2e914"
down_revision: Union[str, None] = "9c4e2a7b1d83"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    have = set(sa.inspect(op.get_bind()).get_table_names())
    if "red_tags" not in have:
        op.create_table(
            "red_tags",
            sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
            sa.Column("number", sa.Integer(), nullable=False, unique=True),
            sa.Column("code", sa.String(16), nullable=False, unique=True),
            sa.Column("batch", sa.Integer(), nullable=False),
            sa.Column("status", sa.String(16), nullable=False),
            sa.Column("reserved_by", sa.Integer(), sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True),
            sa.Column("reserved_at", sa.DateTime(timezone=True), nullable=False),
        )
        op.create_index("ix_red_tags_batch", "red_tags", ["batch"])


def downgrade() -> None:
    op.drop_index("ix_red_tags_batch", table_name="red_tags")
    op.drop_table("red_tags")
