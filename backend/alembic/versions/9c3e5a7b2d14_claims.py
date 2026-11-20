"""claims: warranty / insurance claims for plant equipment (docs/plans/claims.md)

`claims`, `claim_events` (timeline), `claim_evidence` (checklist ticks) and `claim_links`
(issues, I-V sweeps, site log events). SQL only, kept indefinitely. `ensure_schema` creates the
tables at startup too, so each one is skipped when present.

Revision ID: 9c3e5a7b2d14
Revises: 8b2d4f6a1c93
Create Date: 2026-11-20 10:00:00

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "9c3e5a7b2d14"
down_revision: Union[str, None] = "8b2d4f6a1c93"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    have = set(sa.inspect(op.get_bind()).get_table_names())
    if "claims" not in have:
        op.create_table(
            "claims",
            sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
            sa.Column("number", sa.String(16), nullable=False, unique=True),
            sa.Column("claim_type", sa.String(24), nullable=False),
            sa.Column("status", sa.String(16), nullable=False),
            sa.Column("cause", sa.String(24), nullable=False),
            sa.Column("plant_id", sa.Integer(), nullable=False),
            sa.Column("device_sn", sa.String(64), nullable=True),
            sa.Column("string_nos", sa.JSON(), nullable=False),
            sa.Column("module_serials", sa.JSON(), nullable=False),
            sa.Column("device_label", sa.String(120), nullable=True),
            sa.Column("counterparty", sa.String(120), nullable=False),
            sa.Column("counterparty_ref", sa.String(120), nullable=True),
            sa.Column("description", sa.Text(), nullable=True),
            sa.Column("incident_day", sa.Date(), nullable=True),
            sa.Column("discovered_day", sa.Date(), nullable=True),
            sa.Column("submitted_day", sa.Date(), nullable=True),
            sa.Column("closed_day", sa.Date(), nullable=True),
            sa.Column("next_action_day", sa.Date(), nullable=True),
            sa.Column("old_sn", sa.String(64), nullable=True),
            sa.Column("new_sn", sa.String(64), nullable=True),
            sa.Column("warranty_end_day", sa.Date(), nullable=True),
            sa.Column("created_by", sa.String(64), nullable=True),
            sa.Column("updated_by", sa.String(64), nullable=True),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
            sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        )
        op.create_index("ix_claims_plant_status", "claims", ["plant_id", "status"])
        op.create_index("ix_claims_device_sn", "claims", ["device_sn"])
    if "claim_events" not in have:
        op.create_table(
            "claim_events",
            sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
            sa.Column("claim_id", sa.Integer(), sa.ForeignKey("claims.id", ondelete="CASCADE"), nullable=False),
            sa.Column("kind", sa.String(16), nullable=False),
            sa.Column("at", sa.DateTime(timezone=True), nullable=False),
            sa.Column("day", sa.Date(), nullable=True),
            sa.Column("by", sa.String(64), nullable=True),
            sa.Column("from_status", sa.String(16), nullable=True),
            sa.Column("to_status", sa.String(16), nullable=True),
            sa.Column("direction", sa.String(4), nullable=True),
            sa.Column("summary", sa.Text(), nullable=False),
            sa.Column("carrier", sa.String(64), nullable=True),
            sa.Column("tracking_no", sa.String(64), nullable=True),
            sa.Column("sn", sa.String(64), nullable=True),
            sa.Column("detail", sa.JSON(), nullable=True),
        )
        op.create_index("ix_claim_events_claim_id", "claim_events", ["claim_id"])
    if "claim_evidence" not in have:
        op.create_table(
            "claim_evidence",
            sa.Column("claim_id", sa.Integer(), sa.ForeignKey("claims.id", ondelete="CASCADE"), primary_key=True),
            sa.Column("key", sa.String(32), primary_key=True),
            sa.Column("done", sa.Boolean(), nullable=False),
            sa.Column("url", sa.String(1000), nullable=True),
            sa.Column("note", sa.Text(), nullable=True),
            sa.Column("by", sa.String(64), nullable=True),
            sa.Column("at", sa.DateTime(timezone=True), nullable=True),
        )
    if "claim_links" not in have:
        op.create_table(
            "claim_links",
            sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
            sa.Column("claim_id", sa.Integer(), sa.ForeignKey("claims.id", ondelete="CASCADE"), nullable=False),
            sa.Column("kind", sa.String(16), nullable=False),
            sa.Column("ref_id", sa.Integer(), nullable=False),
            sa.Column("created_by", sa.String(64), nullable=True),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
            sa.UniqueConstraint("claim_id", "kind", "ref_id", name="ux_claim_links_ref"),
        )
        op.create_index("ix_claim_links_claim_id", "claim_links", ["claim_id"])


def downgrade() -> None:
    op.drop_table("claim_links")
    op.drop_table("claim_evidence")
    op.drop_table("claim_events")
    op.drop_table("claims")
