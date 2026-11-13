"""System → Logs: app_logs

Python log records of the API and the worker, redacted, read by admins on the Logs page.
`app.db.session.ensure_schema` creates the same table at startup, so this skips it if present.

Revision ID: f2a3b4c5d6e7
Revises: e1f2a3b4c5d6
Create Date: 2026-11-13 21:30:00

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "f2a3b4c5d6e7"
down_revision: Union[str, None] = "e1f2a3b4c5d6"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    if "app_logs" in set(sa.inspect(op.get_bind()).get_table_names()):
        return
    op.create_table(
        "app_logs",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("ts", sa.DateTime(timezone=True), nullable=False),
        sa.Column("level", sa.String(8), nullable=False),
        sa.Column("level_no", sa.SmallInteger(), nullable=False),
        sa.Column("source", sa.String(16), nullable=False),
        sa.Column("host", sa.String(64), nullable=True),
        sa.Column("logger", sa.String(128), nullable=False),
        sa.Column("message", sa.Text(), nullable=False),
        sa.Column("exc_text", sa.Text(), nullable=True),
        sa.Column("run_id", sa.Integer(), nullable=True),
        sa.Column("job", sa.String(32), nullable=True),
        sa.Column("request_id", sa.String(32), nullable=True),
        sa.Column("extra_json", sa.JSON(), nullable=True),
    )
    op.create_index("ix_app_logs_ts", "app_logs", ["ts"])
    op.create_index("ix_app_logs_level_ts", "app_logs", ["level_no", "ts"])
    op.create_index("ix_app_logs_run_id", "app_logs", ["run_id"])
    op.create_index("ix_app_logs_source_ts", "app_logs", ["source", "ts"])


def downgrade() -> None:
    op.drop_table("app_logs")
