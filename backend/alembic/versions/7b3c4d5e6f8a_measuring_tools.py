"""measuring tools: instruments, check-outs, calibration / document records
(docs/plans/measuring-tools.md)

`instruments`, `instrument_due_records` and `instrument_checkouts`. SQL only, kept indefinitely.
`ensure_schema` creates the tables at startup too, so each one is skipped when present.

Revision ID: 7b3c4d5e6f8a
Revises: 6f2a3b4c5d7e
Create Date: 2026-11-21 12:00:00

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "7b3c4d5e6f8a"
down_revision: Union[str, None] = "6f2a3b4c5d7e"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    have = set(sa.inspect(op.get_bind()).get_table_names())
    if "instruments" not in have:
        op.create_table(
            "instruments",
            sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
            sa.Column("asset_tag", sa.String(32), nullable=False, unique=True),
            sa.Column("name", sa.String(120), nullable=False),
            sa.Column("category", sa.String(24), nullable=False),
            sa.Column("make", sa.String(64), nullable=True),
            sa.Column("model", sa.String(64), nullable=True),
            sa.Column("serial_no", sa.String(64), nullable=True),
            sa.Column("status", sa.String(16), nullable=False),
            sa.Column("specs", sa.JSON(), nullable=False),
            sa.Column("calibration_interval_months", sa.Integer(), nullable=True),
            sa.Column("purchase_day", sa.Date(), nullable=True),
            sa.Column("cost_thb", sa.Float(), nullable=True),
            sa.Column("note", sa.Text(), nullable=True),
            sa.Column("created_by", sa.String(64), nullable=True),
            sa.Column("updated_by", sa.String(64), nullable=True),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
            sa.Column("updated_at", sa.DateTime(timezone=True), nullable=True),
        )
        op.create_index("ix_instruments_category", "instruments", ["category"])
    if "instrument_due_records" not in have:
        op.create_table(
            "instrument_due_records",
            sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
            sa.Column("instrument_id", sa.Integer(), sa.ForeignKey("instruments.id", ondelete="CASCADE"), nullable=False),
            sa.Column("kind", sa.String(16), nullable=False),
            sa.Column("day", sa.Date(), nullable=False),
            sa.Column("next_due", sa.Date(), nullable=True),
            sa.Column("number", sa.String(64), nullable=True),
            sa.Column("issuer", sa.String(120), nullable=True),
            sa.Column("cost_thb", sa.Float(), nullable=True),
            sa.Column("url", sa.String(1000), nullable=True),
            sa.Column("note", sa.Text(), nullable=True),
            sa.Column("created_by", sa.String(64), nullable=True),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        )
        op.create_index("ix_instrument_due_records_instrument_kind", "instrument_due_records", ["instrument_id", "kind"])
    if "instrument_checkouts" not in have:
        op.create_table(
            "instrument_checkouts",
            sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
            sa.Column("instrument_id", sa.Integer(), sa.ForeignKey("instruments.id", ondelete="CASCADE"), nullable=False),
            sa.Column("holder_user_id", sa.Integer(), sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True),
            sa.Column("holder_name", sa.String(255), nullable=True),
            sa.Column("plant_id", sa.Integer(), nullable=True),
            sa.Column("out_at", sa.DateTime(timezone=True), nullable=False),
            sa.Column("due_back", sa.Date(), nullable=False),
            sa.Column("returned_at", sa.DateTime(timezone=True), nullable=True),
            sa.Column("condition", sa.String(8), nullable=True),
            sa.Column("note", sa.Text(), nullable=True),
            sa.Column("return_note", sa.Text(), nullable=True),
            sa.Column("ack_warnings", sa.JSON(), nullable=False),
            sa.Column("created_by", sa.String(64), nullable=True),
            sa.Column("returned_by", sa.String(64), nullable=True),
        )
        op.create_index("ix_instrument_checkouts_instrument_open", "instrument_checkouts", ["instrument_id", "returned_at"])


def downgrade() -> None:
    op.drop_table("instrument_checkouts")
    op.drop_table("instrument_due_records")
    op.drop_table("instruments")
