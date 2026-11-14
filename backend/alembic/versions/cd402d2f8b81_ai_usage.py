"""AI Assistant: ai_usage

Token use and cost per assistant turn (no prompt or answer text). `app.db.session.ensure_schema`
creates the same table at startup, so this skips it if present.

Revision ID: cd402d2f8b81
Revises: f2a3b4c5d6e7
Create Date: 2026-11-15 12:00:00

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "cd402d2f8b81"
down_revision: Union[str, None] = "f2a3b4c5d6e7"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    if "ai_usage" in set(sa.inspect(op.get_bind()).get_table_names()):
        return
    op.create_table(
        "ai_usage",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("ts", sa.DateTime(timezone=True), nullable=False),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("model", sa.String(64), nullable=False),
        sa.Column("rounds", sa.SmallInteger(), nullable=False),
        sa.Column("tools", sa.JSON(), nullable=True),
        sa.Column("input_tokens", sa.Integer(), nullable=False),
        sa.Column("cached_tokens", sa.Integer(), nullable=False),
        sa.Column("output_tokens", sa.Integer(), nullable=False),
        sa.Column("cost_usd", sa.Float(), nullable=False),
        sa.Column("status", sa.String(16), nullable=False),
        sa.Column("duration_ms", sa.Integer(), nullable=True),
    )
    op.create_index("ix_ai_usage_ts", "ai_usage", ["ts"])
    op.create_index("ix_ai_usage_user_ts", "ai_usage", ["user_id", "ts"])


def downgrade() -> None:
    op.drop_table("ai_usage")
