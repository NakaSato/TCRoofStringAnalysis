"""plant_documents: per-plant links to the as-built drawing PDF and the site photo folder

docs/plans/plant-asbuilt-links.md. Links only (Google Drive); the files stay on Drive.
`ensure_schema` creates the table at startup too, so it is skipped when present.

Revision ID: c2d3e4f5a6b7
Revises: b1c2d3e4f5a6
Create Date: 2026-11-22 21:00:00

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "c2d3e4f5a6b7"
down_revision: Union[str, None] = "b1c2d3e4f5a6"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    if "plant_documents" in sa.inspect(op.get_bind()).get_table_names():
        return
    op.create_table(
        "plant_documents",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("plant_id", sa.Integer(), nullable=False),
        sa.Column("kind", sa.String(length=32), nullable=False),
        sa.Column("drive_id", sa.String(length=128), nullable=True),
        sa.Column("url", sa.String(length=1000), nullable=False),
        sa.Column("title", sa.String(length=300), nullable=True),
        sa.Column("revision", sa.String(length=16), nullable=True),
        sa.Column("source", sa.String(length=16), nullable=False),
        sa.Column("match_score", sa.Float(), nullable=True),
        sa.Column("updated_by", sa.String(length=64), nullable=True),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.UniqueConstraint("plant_id", "kind", name="uq_plant_documents_plant_kind"),
    )
    op.create_index("ix_plant_documents_plant_id", "plant_documents", ["plant_id"])


def downgrade() -> None:
    op.drop_index("ix_plant_documents_plant_id", table_name="plant_documents")
    op.drop_table("plant_documents")
