"""Alarm push notifications: push_tokens, alarm_push_marks

Devices users turned alarm notifications on for (FCM tokens) and which alarm events were
already pushed. `app.db.session.ensure_schema` creates the same tables at startup, so this
skips the ones present.

Revision ID: f3a4b5c6d7e8
Revises: e0f1a2b3c4d5
Create Date: 2026-11-16 15:00:00

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "f3a4b5c6d7e8"
down_revision: Union[str, None] = "e0f1a2b3c4d5"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    tables = set(sa.inspect(op.get_bind()).get_table_names())
    if "push_tokens" not in tables:
        op.create_table(
            "push_tokens",
            sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
            sa.Column("user_id", sa.Integer(), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
            sa.Column("token", sa.String(512), nullable=False, unique=True),
            sa.Column("label", sa.String(120), nullable=True),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
            sa.Column("last_seen_at", sa.DateTime(timezone=True), nullable=False),
            sa.Column("test_requested_at", sa.DateTime(timezone=True), nullable=True),
        )
        op.create_index("ix_push_tokens_user_id", "push_tokens", ["user_id"])
    if "alarm_push_marks" not in tables:
        op.create_table(
            "alarm_push_marks",
            sa.Column("device_sn", sa.String(64), primary_key=True),
            sa.Column("alarm_code", sa.String(32), primary_key=True),
            sa.Column("day", sa.Date(), primary_key=True),
            sa.Column("event_start", sa.DateTime(), nullable=False),
            sa.Column("pushed_at", sa.DateTime(timezone=True), nullable=False),
        )
        op.create_index("ix_alarm_push_marks_day", "alarm_push_marks", ["day"])


def downgrade() -> None:
    op.drop_table("alarm_push_marks")
    op.drop_table("push_tokens")
