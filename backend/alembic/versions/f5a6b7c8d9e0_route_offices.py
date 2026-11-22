"""route_offices: saved offices a Visit Route can start from

docs/plans/site-visit-route.md §4. Static config kept by admins (name, address, lat / lon, one
default); nothing realtime. `name_key` = the trimmed name case-folded, unique. `ensure_schema`
creates the table at startup too, so it is skipped when present.

Revision ID: f5a6b7c8d9e0
Revises: e4f5a6b7c8d9
Create Date: 2026-11-22 23:50:00

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "f5a6b7c8d9e0"
down_revision: Union[str, None] = "e4f5a6b7c8d9"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    tables = set(sa.inspect(op.get_bind()).get_table_names())
    if "route_offices" not in tables:
        op.create_table(
            "route_offices",
            sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
            sa.Column("name", sa.String(length=80), nullable=False),
            sa.Column("name_key", sa.String(length=80), nullable=False),
            sa.Column("address", sa.String(length=200), nullable=True),
            sa.Column("lat", sa.Float(), nullable=False),
            sa.Column("lon", sa.Float(), nullable=False),
            sa.Column("is_default", sa.Boolean(), nullable=False, server_default=sa.false()),
            sa.Column("created_by", sa.Integer(), sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
            sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
            sa.UniqueConstraint("name_key", name="uq_route_offices_name_key"),
        )


def downgrade() -> None:
    op.drop_table("route_offices")
