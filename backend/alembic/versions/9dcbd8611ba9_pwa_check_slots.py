"""pwa check slots

`pwa_check_slots`: each plant's PWA report check slot (09 / 13 / 17, snapshot at hh:00 −
CHECK_OFFSET_MIN), frozen when first fully built so later publishes never change it.
`ensure_schema` creates the table at startup too, so this migration skips it when present.

Revision ID: 9dcbd8611ba9
Revises: c5d6e7f8a9b0
Create Date: 2026-11-15 16:00:00

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "9dcbd8611ba9"
down_revision: Union[str, None] = "c5d6e7f8a9b0"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    if "pwa_check_slots" in sa.inspect(op.get_bind()).get_table_names():
        return
    op.create_table(
        "pwa_check_slots",
        sa.Column("day", sa.Date(), primary_key=True),
        sa.Column("plant_id", sa.Integer(), primary_key=True, autoincrement=False),
        sa.Column("hour", sa.Integer(), primary_key=True, autoincrement=False),
        sa.Column("slot_json", sa.JSON(), nullable=False),
        sa.Column("built_at", sa.DateTime(timezone=True), nullable=False),
    )


def downgrade() -> None:
    op.drop_table("pwa_check_slots")
