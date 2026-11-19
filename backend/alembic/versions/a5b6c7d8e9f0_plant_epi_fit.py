"""EPI system factor fitted per plant

New table `growatt_plant_epi_fit` and `growatt_plant_daily.system_factor` (the factor behind
each stored EPI). `app.db.session.ensure_schema` creates the same at startup, so each step is
skipped when present.

Revision ID: a5b6c7d8e9f0
Revises: f4a5b6c7d8e9
Create Date: 2026-11-18 23:30:00

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "a5b6c7d8e9f0"
down_revision: Union[str, None] = "f4a5b6c7d8e9"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    insp = sa.inspect(op.get_bind())
    tables = set(insp.get_table_names())
    if "growatt_plant_daily" in tables and "system_factor" not in {c["name"] for c in insp.get_columns("growatt_plant_daily")}:
        op.add_column("growatt_plant_daily", sa.Column("system_factor", sa.Float(), nullable=True))
    if "growatt_plant_epi_fit" not in tables:
        op.create_table(
            "growatt_plant_epi_fit",
            sa.Column("plant_id", sa.Integer(), primary_key=True, autoincrement=False),
            sa.Column("status", sa.String(16), nullable=False),
            sa.Column("factor", sa.Float(), nullable=True),
            sa.Column("spread_pct", sa.Float(), nullable=True),
            sa.Column("days_used", sa.Integer(), nullable=False, server_default="0"),
            sa.Column("candidate_days", sa.Integer(), nullable=False, server_default="0"),
            sa.Column("start_day", sa.Date(), nullable=True),
            sa.Column("end_day", sa.Date(), nullable=True),
            sa.Column("min_clearness", sa.Float(), nullable=True),
            sa.Column("reason", sa.String(255), nullable=True),
            sa.Column("fitted_at", sa.DateTime(timezone=True), nullable=False),
        )


def downgrade() -> None:
    op.drop_table("growatt_plant_epi_fit")
    op.drop_column("growatt_plant_daily", "system_factor")
