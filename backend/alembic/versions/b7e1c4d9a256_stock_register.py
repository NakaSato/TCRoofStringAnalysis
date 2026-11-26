"""stock register phase 1 (docs/plans/spares-failed-units.md)

`users.store_keeper`; `stock_parts`, `stock_locations`, `stock_units`, `stock_movements`.
`ensure_schema` creates the tables and adds the column at startup too, so each step is skipped
when present.

Revision ID: b7e1c4d9a256
Revises: a3d5f8c2e914
Create Date: 2026-11-26 12:30:00

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "b7e1c4d9a256"
down_revision: Union[str, None] = "a3d5f8c2e914"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    insp = sa.inspect(op.get_bind())
    have = set(insp.get_table_names())
    if "store_keeper" not in {c["name"] for c in insp.get_columns("users")}:
        op.add_column("users", sa.Column("store_keeper", sa.Boolean(), nullable=False, server_default=sa.false()))
    ts = lambda name: sa.Column(name, sa.DateTime(timezone=True), nullable=False)  # noqa: E731
    if "stock_parts" not in have:
        op.create_table(
            "stock_parts",
            sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
            sa.Column("code", sa.String(40), nullable=False, unique=True),
            sa.Column("name", sa.String(120), nullable=False),
            sa.Column("category", sa.String(24), nullable=False, index=True),
            sa.Column("make", sa.String(64)),
            sa.Column("model", sa.String(64)),
            sa.Column("serialised", sa.Boolean(), nullable=False),
            sa.Column("unit", sa.String(8), nullable=False),
            sa.Column("min_qty", sa.Integer()),
            sa.Column("active", sa.Boolean(), nullable=False),
            sa.Column("note", sa.Text()),
            sa.Column("created_by", sa.String(64)),
            ts("created_at"),
            ts("updated_at"),
        )
    if "stock_locations" not in have:
        op.create_table(
            "stock_locations",
            sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
            sa.Column("code", sa.String(32), nullable=False, unique=True),
            sa.Column("name", sa.String(120), nullable=False),
            sa.Column("kind", sa.String(16), nullable=False),
            sa.Column("parent_id", sa.Integer(), sa.ForeignKey("stock_locations.id", ondelete="SET NULL")),
            sa.Column("holder_user_id", sa.Integer(), sa.ForeignKey("users.id", ondelete="SET NULL")),
            sa.Column("active", sa.Boolean(), nullable=False),
            sa.Column("note", sa.Text()),
            ts("created_at"),
            ts("updated_at"),
        )
    if "stock_units" not in have:
        op.create_table(
            "stock_units",
            sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
            sa.Column("part_id", sa.Integer(), sa.ForeignKey("stock_parts.id"), nullable=False, index=True),
            sa.Column("serial", sa.String(64), nullable=False),
            sa.Column("serial_key", sa.String(64), nullable=False, index=True),
            sa.Column("state", sa.String(16), nullable=False),
            sa.Column("location_id", sa.Integer(), sa.ForeignKey("stock_locations.id"), index=True),
            sa.Column("plant_id", sa.Integer(), index=True),
            sa.Column("received_day", sa.Date()),
            sa.Column("note", sa.Text()),
            ts("created_at"),
            ts("updated_at"),
            sa.UniqueConstraint("part_id", "serial_key", name="uq_stock_units_part_serial"),
        )
    if "stock_movements" not in have:
        op.create_table(
            "stock_movements",
            sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
            sa.Column("batch_id", sa.String(36), nullable=False, index=True),
            sa.Column("kind", sa.String(16), nullable=False),
            sa.Column("part_id", sa.Integer(), sa.ForeignKey("stock_parts.id"), nullable=False, index=True),
            sa.Column("unit_id", sa.Integer(), sa.ForeignKey("stock_units.id"), index=True),
            sa.Column("serial", sa.String(64)),
            sa.Column("qty", sa.Integer(), nullable=False),
            sa.Column("from_location_id", sa.Integer(), sa.ForeignKey("stock_locations.id")),
            sa.Column("to_location_id", sa.Integer(), sa.ForeignKey("stock_locations.id")),
            sa.Column("plant_id", sa.Integer(), index=True),
            sa.Column("from_state", sa.String(16)),
            sa.Column("to_state", sa.String(16)),
            sa.Column("corrects_id", sa.Integer(), sa.ForeignKey("stock_movements.id"), unique=True),
            sa.Column("claim_id", sa.Integer()),
            sa.Column("failed_unit_id", sa.Integer()),
            sa.Column("by", sa.String(64)),
            sa.Column("at", sa.DateTime(timezone=True), nullable=False, index=True),
            sa.Column("day", sa.Date(), nullable=False),
            sa.Column("note", sa.Text()),
            sa.Column("input_method", sa.String(8)),
            sa.Column("raw_scan", sa.String(512)),
        )


def downgrade() -> None:
    for t in ("stock_movements", "stock_units", "stock_locations", "stock_parts"):
        op.drop_table(t)
    op.drop_column("users", "store_keeper")
