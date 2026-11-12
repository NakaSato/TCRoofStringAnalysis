"""user_plant_assignments: plants an admin assigned to an engineer; viewer role -> engineer

Revision ID: d4e5f6a7b8c9
Revises: c3d4e5f6a7b8
Create Date: 2026-11-12 18:00:00

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "d4e5f6a7b8c9"
down_revision: Union[str, None] = "c3d4e5f6a7b8"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Two roles only: the former read-only `viewer` becomes an engineer with no plants assigned.
    op.execute("UPDATE users SET role = 'engineer' WHERE role NOT IN ('admin', 'engineer')")
    if "user_plant_assignments" in sa.inspect(op.get_bind()).get_table_names():
        return  # already created by ensure_schema at startup
    op.create_table(
        "user_plant_assignments",
        sa.Column("user_id", sa.Integer(), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("plant_id", sa.Integer(), nullable=False),
        sa.Column("assigned_by", sa.String(length=64), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.PrimaryKeyConstraint("user_id", "plant_id"),
    )
    op.create_index("ix_user_plant_assignments_plant_id", "user_plant_assignments", ["plant_id"])


def downgrade() -> None:
    op.drop_index("ix_user_plant_assignments_plant_id", table_name="user_plant_assignments")
    op.drop_table("user_plant_assignments")
