"""scan field hints (barcode scanning, plan step 4)

`scan_field_hints`: which field of a multi-field label is the serial, per device category + model.
`ensure_schema` creates the table at startup too, so it is skipped when present.

Revision ID: 9c4e2a7b1d83
Revises: 4b8e1d6c3a57
Create Date: 2026-11-26 10:30:00

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "9c4e2a7b1d83"
down_revision: Union[str, None] = "4b8e1d6c3a57"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    have = set(sa.inspect(op.get_bind()).get_table_names())
    if "scan_field_hints" not in have:
        op.create_table(
            "scan_field_hints",
            sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
            sa.Column("category", sa.String(40), nullable=False),
            sa.Column("model", sa.String(120), nullable=False),
            sa.Column("model_key", sa.String(120), nullable=False),
            sa.Column("field_key", sa.String(40), nullable=True),
            sa.Column("field_index", sa.Integer(), nullable=False),
            sa.Column("field_count", sa.Integer(), nullable=False),
            sa.Column("created_by", sa.Integer(), sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True),
            sa.Column("updated_by", sa.Integer(), sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
            sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
            sa.UniqueConstraint("category", "model_key", name="uq_scan_field_hints_category_model"),
        )


def downgrade() -> None:
    op.drop_table("scan_field_hints")
