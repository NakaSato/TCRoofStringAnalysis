"""published_docs: daily-summary publish state + per-day write counts

Revision ID: b7c1d2e3f4a5
Revises: e3a92316f61f
Create Date: 2026-11-12 11:00:00

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "b7c1d2e3f4a5"
down_revision: Union[str, None] = "e3a92316f61f"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "published_docs",
        sa.Column("sink", sa.String(length=32), nullable=False),
        sa.Column("path", sa.String(length=255), nullable=False),
        sa.Column("content_hash", sa.String(length=64), nullable=False),
        sa.Column("size_bytes", sa.Integer(), nullable=False),
        sa.Column("written_at", sa.DateTime(timezone=True), nullable=False),
        sa.PrimaryKeyConstraint("sink", "path"),
    )
    op.create_table(
        "publish_write_counts",
        sa.Column("sink", sa.String(length=32), nullable=False),
        sa.Column("quota_day", sa.String(length=10), nullable=False),
        sa.Column("writes", sa.Integer(), nullable=False),
        sa.PrimaryKeyConstraint("sink", "quota_day"),
    )


def downgrade() -> None:
    op.drop_table("publish_write_counts")
    op.drop_table("published_docs")
