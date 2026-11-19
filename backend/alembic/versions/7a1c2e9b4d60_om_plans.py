"""om plans (Calendar Team, Phase 2)

`om_plans`, `om_plan_plants`, `om_plan_assignees`: recurring O&M templates that generate tasks
(`om_tasks.plan_id` + `scheduled_day`); `om_plant_settings`: optional per-plant cleaning duration
(crew-days) and cost. `ensure_schema` creates the tables at startup too, so each one is skipped
when present.

Revision ID: 7a1c2e9b4d60
Revises: a6b7c8d9e0f1
Create Date: 2026-11-19 18:00:00

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "7a1c2e9b4d60"
down_revision: Union[str, None] = "a6b7c8d9e0f1"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    have = set(sa.inspect(op.get_bind()).get_table_names())
    if "om_plans" not in have:
        op.create_table(
            "om_plans",
            sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
            sa.Column("name", sa.String(120), nullable=False),
            sa.Column("task_type", sa.String(24), nullable=False),
            sa.Column("every_n", sa.Integer(), nullable=False),
            sa.Column("unit", sa.String(8), nullable=False),
            sa.Column("season_from_month", sa.Integer(), nullable=True),
            sa.Column("season_to_month", sa.Integer(), nullable=True),
            sa.Column("weekday", sa.Integer(), nullable=True),
            sa.Column("duration_days", sa.Integer(), nullable=False, server_default="1"),
            sa.Column("default_team_id", sa.Integer(), sa.ForeignKey("om_teams.id", ondelete="SET NULL"), nullable=True),
            sa.Column("starts_on", sa.Date(), nullable=False),
            sa.Column("ends_on", sa.Date(), nullable=True),
            sa.Column("active", sa.Boolean(), nullable=False, server_default=sa.true()),
            sa.Column("note", sa.Text(), nullable=True),
            sa.Column("created_by", sa.String(64), nullable=True),
            sa.Column("updated_by", sa.String(64), nullable=True),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
            sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        )
    if "om_plan_plants" not in have:
        op.create_table(
            "om_plan_plants",
            sa.Column("plan_id", sa.Integer(), sa.ForeignKey("om_plans.id", ondelete="CASCADE"), primary_key=True),
            sa.Column("plant_id", sa.Integer(), primary_key=True),
        )
        op.create_index("ix_om_plan_plants_plant_id", "om_plan_plants", ["plant_id"])
    if "om_plan_assignees" not in have:
        op.create_table(
            "om_plan_assignees",
            sa.Column("plan_id", sa.Integer(), sa.ForeignKey("om_plans.id", ondelete="CASCADE"), primary_key=True),
            sa.Column("user_id", sa.Integer(), sa.ForeignKey("users.id", ondelete="CASCADE"), primary_key=True),
        )
    if "om_plant_settings" not in have:
        op.create_table(
            "om_plant_settings",
            sa.Column("plant_id", sa.Integer(), primary_key=True, autoincrement=False),
            sa.Column("cleaning_crew_days", sa.Float(), nullable=True),
            sa.Column("cleaning_cost_thb", sa.Float(), nullable=True),
            sa.Column("updated_by", sa.String(64), nullable=True),
            sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        )


def downgrade() -> None:
    op.drop_table("om_plant_settings")
    op.drop_table("om_plan_assignees")
    op.drop_index("ix_om_plan_plants_plant_id", table_name="om_plan_plants")
    op.drop_table("om_plan_plants")
    op.drop_table("om_plans")
