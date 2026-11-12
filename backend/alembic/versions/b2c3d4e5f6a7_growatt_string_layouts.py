"""growatt_string_layouts: as-built module count per Growatt string input

Revision ID: b2c3d4e5f6a7
Revises: a7b8c9d0e1f2
Create Date: 2026-11-12 15:00:00

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "b2c3d4e5f6a7"
down_revision: Union[str, None] = "a7b8c9d0e1f2"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    if "growatt_string_layouts" in sa.inspect(op.get_bind()).get_table_names():
        return  # already created by ensure_schema at startup
    op.create_table(
        "growatt_string_layouts",
        sa.Column("device_sn", sa.String(length=64), nullable=False),
        sa.Column("string_no", sa.Integer(), autoincrement=False, nullable=False),
        sa.Column("modules", sa.Integer(), nullable=False),
        sa.Column("module_wp", sa.Float(), nullable=True),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.PrimaryKeyConstraint("device_sn", "string_no"),
    )


def downgrade() -> None:
    op.drop_table("growatt_string_layouts")
