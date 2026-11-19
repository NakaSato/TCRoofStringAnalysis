"""om calendar (Calendar Team, Phase 1)

`om_teams`, `om_team_members`, `om_tasks`, `om_task_assignees`, `om_task_history`: planned O&M
work per plant with crews, assignees and a change history (docs/plans/calendar-team.md). A done
task writes a `site_events` row. `ensure_schema` creates the tables at startup too, so each one
is skipped when present.

Revision ID: a6b7c8d9e0f1
Revises: a5b6c7d8e9f0
Create Date: 2026-11-19 12:00:00

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "a6b7c8d9e0f1"
down_revision: Union[str, None] = "a5b6c7d8e9f0"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    have = set(sa.inspect(op.get_bind()).get_table_names())
    if "om_teams" not in have:
        op.create_table(
            "om_teams",
            sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
            sa.Column("name", sa.String(80), nullable=False, unique=True),
            sa.Column("color", sa.String(16), nullable=True),
            sa.Column("active", sa.Boolean(), nullable=False, server_default=sa.true()),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        )
    if "om_team_members" not in have:
        op.create_table(
            "om_team_members",
            sa.Column("team_id", sa.Integer(), sa.ForeignKey("om_teams.id", ondelete="CASCADE"), primary_key=True),
            sa.Column("user_id", sa.Integer(), sa.ForeignKey("users.id", ondelete="CASCADE"), primary_key=True),
        )
        op.create_index("ix_om_team_members_user_id", "om_team_members", ["user_id"])
    if "om_tasks" not in have:
        op.create_table(
            "om_tasks",
            sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
            sa.Column("plant_id", sa.Integer(), nullable=False),
            sa.Column("task_type", sa.String(24), nullable=False),
            sa.Column("title", sa.String(160), nullable=True),
            sa.Column("start_day", sa.Date(), nullable=False),
            sa.Column("end_day", sa.Date(), nullable=False),
            sa.Column("scheduled_day", sa.Date(), nullable=True),
            sa.Column("device_sn", sa.String(64), nullable=True),
            sa.Column("string_no", sa.Integer(), nullable=True),
            sa.Column("status", sa.String(16), nullable=False),
            sa.Column("team_id", sa.Integer(), sa.ForeignKey("om_teams.id", ondelete="SET NULL"), nullable=True),
            sa.Column("plan_id", sa.Integer(), nullable=True),
            sa.Column("issue_id", sa.Integer(), nullable=True),
            sa.Column("est_cost_thb", sa.Float(), nullable=True),
            sa.Column("note", sa.Text(), nullable=True),
            sa.Column("site_event_id", sa.Integer(), sa.ForeignKey("site_events.id", ondelete="SET NULL"), nullable=True),
            sa.Column("done_at", sa.DateTime(timezone=True), nullable=True),
            sa.Column("done_by", sa.String(64), nullable=True),
            sa.Column("created_by", sa.String(64), nullable=True),
            sa.Column("updated_by", sa.String(64), nullable=True),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
            sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        )
        op.create_index("ix_om_tasks_days", "om_tasks", ["start_day", "end_day"])
        op.create_index("ix_om_tasks_plant_start", "om_tasks", ["plant_id", "start_day"])
        op.create_index("ix_om_tasks_team_id", "om_tasks", ["team_id"])
        op.create_index("ux_om_tasks_plan_occurrence", "om_tasks", ["plan_id", "plant_id", "scheduled_day"], unique=True)
    if "om_task_assignees" not in have:
        op.create_table(
            "om_task_assignees",
            sa.Column("task_id", sa.Integer(), sa.ForeignKey("om_tasks.id", ondelete="CASCADE"), primary_key=True),
            sa.Column("user_id", sa.Integer(), sa.ForeignKey("users.id", ondelete="CASCADE"), primary_key=True),
        )
        op.create_index("ix_om_task_assignees_user_id", "om_task_assignees", ["user_id"])
    if "om_task_history" not in have:
        op.create_table(
            "om_task_history",
            sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
            sa.Column("task_id", sa.Integer(), sa.ForeignKey("om_tasks.id", ondelete="CASCADE"), nullable=False),
            sa.Column("at", sa.DateTime(timezone=True), nullable=False),
            sa.Column("by", sa.String(64), nullable=True),
            sa.Column("change", sa.JSON(), nullable=False),
            sa.Column("comment", sa.Text(), nullable=True),
        )
        op.create_index("ix_om_task_history_task_id", "om_task_history", ["task_id"])


def downgrade() -> None:
    op.drop_table("om_task_history")
    op.drop_table("om_task_assignees")
    op.drop_table("om_tasks")
    op.drop_table("om_team_members")
    op.drop_table("om_teams")
