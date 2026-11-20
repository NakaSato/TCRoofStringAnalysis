"""om reminders + calendar feed (Calendar Team, Phase 3)

`om_push_marks`: which task reminders (evening before, Monday week summary) each user was already
pushed; `om_ics_feeds`: each user's read-only calendar subscription (SHA-256 of the URL secret).
`ensure_schema` creates the tables at startup too, so each one is skipped when present.

Revision ID: 8b2d4f6a1c93
Revises: 7a1c2e9b4d60
Create Date: 2026-11-19 23:00:00

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "8b2d4f6a1c93"
down_revision: Union[str, None] = "7a1c2e9b4d60"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    have = set(sa.inspect(op.get_bind()).get_table_names())
    if "om_push_marks" not in have:
        op.create_table(
            "om_push_marks",
            sa.Column("user_id", sa.Integer(), sa.ForeignKey("users.id", ondelete="CASCADE"), primary_key=True),
            sa.Column("kind", sa.String(16), primary_key=True),
            sa.Column("day", sa.Date(), primary_key=True),
            sa.Column("tasks", sa.Integer(), nullable=False),
            sa.Column("pushed_at", sa.DateTime(timezone=True), nullable=False),
        )
        op.create_index("ix_om_push_marks_day", "om_push_marks", ["day"])
    if "om_ics_feeds" not in have:
        op.create_table(
            "om_ics_feeds",
            sa.Column("user_id", sa.Integer(), sa.ForeignKey("users.id", ondelete="CASCADE"), primary_key=True, autoincrement=False),
            sa.Column("token_hash", sa.String(64), nullable=False, unique=True),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
            sa.Column("last_used_at", sa.DateTime(timezone=True), nullable=True),
        )


def downgrade() -> None:
    op.drop_table("om_ics_feeds")
    op.drop_table("om_push_marks")
