"""username login for users

Users sign in with a username (email still accepted). Existing users get one from their
email's local part (`app.db.seed._backfill_usernames` at startup). `ensure_schema` adds the
same column and index at startup, so this migration skips what is already there.

Revision ID: a7b8c9d0e1f2
Revises: f1a2b3c4d5e6
Create Date: 2026-11-12 16:40:00

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "a7b8c9d0e1f2"
down_revision: Union[str, None] = "f1a2b3c4d5e6"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    insp = sa.inspect(op.get_bind())
    if "username" not in {c["name"] for c in insp.get_columns("users")}:
        with op.batch_alter_table("users") as batch:
            batch.add_column(sa.Column("username", sa.String(length=64), nullable=True))
    if "ix_users_username" not in {i["name"] for i in insp.get_indexes("users")}:
        op.create_index("ix_users_username", "users", ["username"], unique=True)


def downgrade() -> None:
    op.drop_index("ix_users_username", table_name="users")
    with op.batch_alter_table("users") as batch:
        batch.drop_column("username")
