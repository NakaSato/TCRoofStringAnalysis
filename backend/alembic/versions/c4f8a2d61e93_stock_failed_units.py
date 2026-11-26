"""stock register phase 2: failed units (docs/plans/spares-failed-units.md §5.3–5.5)

`stock_failed_units` (one per red tag); `stock_movements.part_id` nullable (a failed unit may have
no catalogue part). `ensure_schema` creates the table at startup too, so each step is skipped when
present.

Revision ID: c4f8a2d61e93
Revises: b7e1c4d9a256
Create Date: 2026-11-26 18:00:00

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "c4f8a2d61e93"
down_revision: Union[str, None] = "b7e1c4d9a256"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    insp = sa.inspect(op.get_bind())
    if "stock_failed_units" not in set(insp.get_table_names()):
        op.create_table(
            "stock_failed_units",
            sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
            sa.Column("red_tag_id", sa.Integer(), sa.ForeignKey("red_tags.id"), nullable=False, unique=True),
            sa.Column("part_id", sa.Integer(), sa.ForeignKey("stock_parts.id")),
            sa.Column("serial", sa.String(64)),
            sa.Column("serial_key", sa.String(64), index=True),
            sa.Column("plant_id", sa.Integer(), index=True),
            sa.Column("site_device_id", sa.Integer(), sa.ForeignKey("site_devices.id", ondelete="SET NULL")),
            sa.Column("inverter_sn", sa.String(64)),
            sa.Column("removed_day", sa.Date(), nullable=False),
            sa.Column("fault", sa.Text(), nullable=False),
            sa.Column("status", sa.String(16), nullable=False),
            sa.Column("location_id", sa.Integer(), sa.ForeignKey("stock_locations.id")),
            sa.Column("claim_id", sa.Integer(), sa.ForeignKey("claims.id", ondelete="SET NULL")),
            sa.Column("spare_unit_id", sa.Integer(), sa.ForeignKey("stock_units.id")),
            sa.Column("created_by", sa.String(64)),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
            sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        )
    part = next((c for c in insp.get_columns("stock_movements") if c["name"] == "part_id"), None)
    if part is not None and not part.get("nullable", True):
        with op.batch_alter_table("stock_movements") as batch:
            batch.alter_column("part_id", existing_type=sa.Integer(), nullable=True)


def downgrade() -> None:
    op.drop_table("stock_failed_units")
    # part_id stays nullable: movements of failed units without a part may exist
