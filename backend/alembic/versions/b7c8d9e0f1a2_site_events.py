"""site events

`site_events`: work done on a Growatt plant (cleaning, repair, module or inverter replaced, IR
flight, curtailment) with its plant-local dates, optional inverter / string, cost in THB and the
decision-rule issue it answered (docs/plans/decision-rules.md §6). `ensure_schema` creates the
table at startup too, so this migration skips it when present.

Revision ID: b7c8d9e0f1a2
Revises: a3b4c5d6e7f8
Create Date: 2026-11-15 20:00:00

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "b7c8d9e0f1a2"
down_revision: Union[str, None] = "a3b4c5d6e7f8"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    if sa.inspect(op.get_bind()).has_table("site_events"):
        return
    op.create_table(
        "site_events",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("plant_id", sa.Integer(), nullable=False),
        sa.Column("event_type", sa.String(24), nullable=False),
        sa.Column("day", sa.Date(), nullable=False),
        sa.Column("end_day", sa.Date(), nullable=True),
        sa.Column("device_sn", sa.String(64), nullable=True),
        sa.Column("string_no", sa.Integer(), nullable=True),
        sa.Column("cost_thb", sa.Float(), nullable=True),
        sa.Column("issue_id", sa.Integer(), nullable=True),
        sa.Column("note", sa.Text(), nullable=True),
        sa.Column("created_by", sa.String(64), nullable=True),
        sa.Column("updated_by", sa.String(64), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index("ix_site_events_plant_day", "site_events", ["plant_id", "day"])
    op.create_index("ix_site_events_issue_id", "site_events", ["issue_id"])


def downgrade() -> None:
    op.drop_index("ix_site_events_issue_id", table_name="site_events")
    op.drop_index("ix_site_events_plant_day", table_name="site_events")
    op.drop_table("site_events")
