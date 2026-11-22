"""TFRS 16 lease model: phases, schedule, remeasurements, revenue profile, phase 3-4 rollout list

Tables of services/tfrs16.py (imported from the TFRS 16 model workbook by the CLI). SQL only.
`ensure_schema` creates the tables at startup too, so each one is skipped when present.

Revision ID: 8d4e5f6a7b9c
Revises: 7b3c4d5e6f8a
Create Date: 2026-11-22 12:00:00

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "8d4e5f6a7b9c"
down_revision: Union[str, None] = "7b3c4d5e6f8a"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

TABLES = ("tfrs16_rollout_stations", "tfrs16_revenue_months", "tfrs16_remeasurements", "tfrs16_schedule", "tfrs16_phases", "tfrs16_imports")


def upgrade() -> None:
    have = set(sa.inspect(op.get_bind()).get_table_names())
    if "tfrs16_imports" not in have:
        op.create_table(
            "tfrs16_imports",
            sa.Column("id", sa.Integer(), primary_key=True),
            sa.Column("source", sa.String(200), nullable=False),
            sa.Column("project_budget_thb", sa.Float(), nullable=True),
            sa.Column("revenue_case", sa.String(120), nullable=True),
            sa.Column("revenue_price_thb_kwh", sa.Float(), nullable=True),
            sa.Column("rollout_note", sa.Text(), nullable=True),
            sa.Column("warnings", sa.JSON(), nullable=False),
            sa.Column("imported_at", sa.DateTime(timezone=True), nullable=False),
        )
    if "tfrs16_phases" not in have:
        op.create_table(
            "tfrs16_phases",
            sa.Column("phase", sa.Integer(), primary_key=True),
            sa.Column("estimated", sa.Boolean(), nullable=False),
            sa.Column("stations", sa.Integer(), nullable=True),
            sa.Column("kwp", sa.Float(), nullable=True),
            sa.Column("start_day", sa.Date(), nullable=True),
            sa.Column("end_day", sa.Date(), nullable=True),
            sa.Column("discount_rate", sa.Float(), nullable=True),
            sa.Column("min_fee_thb", sa.Float(), nullable=True),
            sa.Column("kwh_20y", sa.Float(), nullable=True),
            sa.Column("rou_initial_thb", sa.Float(), nullable=True),
            sa.Column("deferred_interest_thb", sa.Float(), nullable=True),
        )
    if "tfrs16_schedule" not in have:
        op.create_table(
            "tfrs16_schedule",
            sa.Column("phase", sa.Integer(), primary_key=True),
            sa.Column("period", sa.Integer(), primary_key=True),
            sa.Column("month", sa.Date(), nullable=False),
            sa.Column("fiscal_year", sa.Integer(), nullable=False),
            sa.Column("contract_year", sa.Integer(), nullable=True),
            sa.Column("min_fee_thb", sa.Float(), nullable=True),
            sa.Column("kwh", sa.Float(), nullable=True),
            sa.Column("opening_thb", sa.Float(), nullable=True),
            sa.Column("interest_thb", sa.Float(), nullable=True),
            sa.Column("payment_thb", sa.Float(), nullable=True),
            sa.Column("closing_thb", sa.Float(), nullable=True),
            sa.Column("depreciation_thb", sa.Float(), nullable=True),
            sa.Column("rou_net_thb", sa.Float(), nullable=True),
        )
        op.create_index("ix_tfrs16_schedule_fiscal_year", "tfrs16_schedule", ["fiscal_year"])
    if "tfrs16_remeasurements" not in have:
        op.create_table(
            "tfrs16_remeasurements",
            sa.Column("phase", sa.Integer(), primary_key=True),
            sa.Column("assessed_on", sa.Date(), nullable=True),
            sa.Column("book_liability_thb", sa.Float(), nullable=True),
            sa.Column("remaining_fee_thb", sa.Float(), nullable=True),
            sa.Column("old_deferred_interest_thb", sa.Float(), nullable=True),
            sa.Column("production_share", sa.Float(), nullable=True),
            sa.Column("revised_fee_thb", sa.Float(), nullable=True),
            sa.Column("new_liability_thb", sa.Float(), nullable=True),
            sa.Column("new_deferred_interest_thb", sa.Float(), nullable=True),
            sa.Column("difference_thb", sa.Float(), nullable=True),
            sa.Column("difference_share", sa.Float(), nullable=True),
            sa.Column("threshold_share", sa.Float(), nullable=True),
            sa.Column("decision", sa.String(200), nullable=True),
            sa.Column("account", sa.String(16), nullable=True),
            sa.Column("sheet", sa.String(64), nullable=False),
        )
    if "tfrs16_revenue_months" not in have:
        op.create_table(
            "tfrs16_revenue_months",
            sa.Column("phase", sa.Integer(), primary_key=True),
            sa.Column("month", sa.Integer(), primary_key=True),
            sa.Column("fy_order", sa.Integer(), nullable=False),
            sa.Column("revenue_thb", sa.Float(), nullable=True),
        )
    if "tfrs16_rollout_stations" not in have:
        op.create_table(
            "tfrs16_rollout_stations",
            sa.Column("phase", sa.Integer(), primary_key=True),
            sa.Column("seq", sa.Integer(), primary_key=True),
            sa.Column("name", sa.String(200), nullable=False),
            sa.Column("kwp", sa.Float(), nullable=True),
            sa.Column("interconnect_status", sa.String(120), nullable=True),
            sa.Column("fee_thb", sa.Float(), nullable=True),
            sa.Column("fee_paid", sa.Boolean(), nullable=False),
            sa.Column("interconnected", sa.Boolean(), nullable=False),
            sa.Column("first_sync", sa.Date(), nullable=True),
        )


def downgrade() -> None:
    have = set(sa.inspect(op.get_bind()).get_table_names())
    for t in TABLES:
        if t in have:
            op.drop_table(t)
