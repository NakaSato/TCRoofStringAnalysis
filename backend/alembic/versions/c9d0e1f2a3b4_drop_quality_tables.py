"""drop the subcontractor QA/QC and power quality tables

The Quality & Power Quality feature (endpoints, UI page, report sections) was removed.

Revision ID: c9d0e1f2a3b4
Revises: b8c9d0e1f2a3
Create Date: 2026-11-13 12:00:00

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "c9d0e1f2a3b4"
down_revision: Union[str, None] = "b8c9d0e1f2a3"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute("DROP TABLE IF EXISTS pq_tests")
    op.execute("DROP TABLE IF EXISTS subcontractor_audits")


def downgrade() -> None:
    op.create_table(
        "subcontractor_audits",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("plant_id", sa.Integer(), nullable=False),
        sa.Column("contractor_id", sa.String(length=64), nullable=False),
        sa.Column("subcontractor_name", sa.String(length=255), nullable=False),
        sa.Column("scope_of_work", sa.Text(), nullable=False),
        sa.Column("active_work_orders", sa.Integer(), nullable=False),
        sa.Column("workmanship_score_pct", sa.Float(), nullable=False),
        sa.Column("engineering_std_compliance_pct", sa.Float(), nullable=False),
        sa.Column("safety_she_compliance_pct", sa.Float(), nullable=False),
        sa.Column("on_time_sla_pct", sa.Float(), nullable=False),
        sa.Column("open_ncrs", sa.Integer(), nullable=False),
        sa.Column("torque_seal_verified", sa.String(length=128), nullable=False),
        sa.Column("calibrated_tools_cert", sa.String(length=255), nullable=False),
        sa.Column("overall_rating", sa.String(length=64), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["plant_id"], ["plants.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(op.f("ix_subcontractor_audits_plant_id"), "subcontractor_audits", ["plant_id"], unique=False)
    op.create_table(
        "pq_tests",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("plant_id", sa.Integer(), nullable=False),
        sa.Column("voltage_thd_pct", sa.Float(), nullable=False),
        sa.Column("current_thd_pct", sa.Float(), nullable=False),
        sa.Column("power_factor", sa.Float(), nullable=False),
        sa.Column("voltage_unbalance_pct", sa.Float(), nullable=False),
        sa.Column("flicker_plt", sa.Float(), nullable=False),
        sa.Column("grid_frequency_hz", sa.Float(), nullable=False),
        sa.Column("dc_injection_pct", sa.Float(), nullable=False),
        sa.Column("min_riso_mohm", sa.Float(), nullable=False),
        sa.Column("pq_results_json", sa.JSON(), nullable=False),
        sa.Column("commissioning_results_json", sa.JSON(), nullable=False),
        sa.Column("overall_compliant", sa.Boolean(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["plant_id"], ["plants.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(op.f("ix_pq_tests_plant_id"), "pq_tests", ["plant_id"], unique=False)
