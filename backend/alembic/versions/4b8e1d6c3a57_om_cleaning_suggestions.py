"""om cleaning suggestion marks (Calendar Team, Phase 4)

`om_cleaning_suggestion_marks`: an admin's accept / dismiss of a data-driven cleaning suggestion
(R12 soiling wallet), keyed on (plant, wallet reset day) so it stays hidden until the next cleaning
or heavy rain. `ensure_schema` creates the table at startup too, so it is skipped when present.

Revision ID: 4b8e1d6c3a57
Revises: 69580c904e8f
Create Date: 2026-11-25 12:00:00

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "4b8e1d6c3a57"
down_revision: Union[str, None] = "69580c904e8f"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    have = set(sa.inspect(op.get_bind()).get_table_names())
    if "om_cleaning_suggestion_marks" not in have:
        op.create_table(
            "om_cleaning_suggestion_marks",
            sa.Column("plant_id", sa.Integer(), primary_key=True, autoincrement=False),
            sa.Column("reset_day", sa.Date(), primary_key=True),
            sa.Column("action", sa.String(16), nullable=False),
            sa.Column("task_id", sa.Integer(), sa.ForeignKey("om_tasks.id", ondelete="SET NULL"), nullable=True),
            sa.Column("wallet_thb", sa.Float(), nullable=True),
            sa.Column("cost_thb", sa.Float(), nullable=True),
            sa.Column("by", sa.String(64), nullable=True),
            sa.Column("at", sa.DateTime(timezone=True), nullable=False),
        )


def downgrade() -> None:
    op.drop_table("om_cleaning_suggestion_marks")
