"""field faults: the defect register (docs/plans/defects.md)

Tables `field_faults` (one fault per row, DF-YYYY-NNNN), `field_fault_events` (timeline) and
`field_fault_links` (issue, alarm, device check, claim, failed unit, stock batch, Site log, Calendar
task, KB document). `ensure_schema` creates the same at startup, so this migration skips what is
already there.

Revision ID: a1d4f7c2e905
Revises: e6b2f4a8c315
Create Date: 2026-11-27 01:00:00

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "a1d4f7c2e905"
down_revision: Union[str, None] = "e6b2f4a8c315"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    tables = set(sa.inspect(op.get_bind()).get_table_names())
    if "field_faults" not in tables:
        op.create_table(
            "field_faults",
            sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
            sa.Column("no", sa.String(16), nullable=False, unique=True),
            sa.Column("plant_id", sa.Integer(), nullable=False),
            sa.Column("kind", sa.String(20), nullable=False),
            sa.Column("sub_kind", sa.String(12)),
            sa.Column("inverter_sn", sa.String(64)),
            sa.Column("site_device_id", sa.Integer()),
            sa.Column("meter_datalogger_sn", sa.String(64)),
            sa.Column("meter_address", sa.Integer()),
            sa.Column("stock_unit_id", sa.Integer()),
            sa.Column("position", sa.JSON()),
            sa.Column("serial", sa.String(64)),
            sa.Column("serial_key", sa.String(64)),
            sa.Column("serial_input", sa.String(10)),
            sa.Column("serial_raw", sa.String(512)),
            sa.Column("symptom", sa.Text(), nullable=False),
            sa.Column("how_found", sa.String(16), nullable=False),
            sa.Column("found_at", sa.DateTime(timezone=True), nullable=False),
            sa.Column("found_by", sa.String(64)),
            sa.Column("severity", sa.String(2), nullable=False),
            sa.Column("cause", sa.String(24)),
            sa.Column("status", sa.String(12), nullable=False),
            sa.Column("waiting_reason", sa.String(12)),
            sa.Column("decision", sa.String(16)),
            sa.Column("decision_reason", sa.Text()),
            sa.Column("owner_user_id", sa.Integer()),
            sa.Column("next_action_day", sa.Date()),
            sa.Column("restored_at", sa.DateTime(timezone=True)),
            sa.Column("closed_at", sa.DateTime(timezone=True)),
            sa.Column("closed_by", sa.String(64)),
            sa.Column("close_note", sa.Text()),
            sa.Column("evidence_urls", sa.JSON(), nullable=False),
            sa.Column("reference", sa.String(120)),
            sa.Column("created_by", sa.String(64)),
            sa.Column("updated_by", sa.String(64)),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
            sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        )
        op.create_index("ix_field_faults_plant_status", "field_faults", ["plant_id", "status"])
        op.create_index("ix_field_faults_kind_status", "field_faults", ["kind", "status"])
        op.create_index("ix_field_faults_inverter_sn", "field_faults", ["inverter_sn"])
        op.create_index("ix_field_faults_site_device_id", "field_faults", ["site_device_id"])
        op.create_index("ix_field_faults_serial_key", "field_faults", ["serial_key"])
    if "field_fault_events" not in tables:
        op.create_table(
            "field_fault_events",
            sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
            sa.Column("fault_id", sa.Integer(), sa.ForeignKey("field_faults.id", ondelete="CASCADE"), nullable=False),
            sa.Column("at", sa.DateTime(timezone=True), nullable=False),
            sa.Column("by", sa.String(64)),
            sa.Column("kind", sa.String(10), nullable=False),
            sa.Column("from_value", sa.String(24)),
            sa.Column("to_value", sa.String(24)),
            sa.Column("text", sa.Text(), nullable=False),
        )
        op.create_index("ix_field_fault_events_fault_id", "field_fault_events", ["fault_id"])
    if "field_fault_links" not in tables:
        op.create_table(
            "field_fault_links",
            sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
            sa.Column("fault_id", sa.Integer(), sa.ForeignKey("field_faults.id", ondelete="CASCADE"), nullable=False),
            sa.Column("kind", sa.String(16), nullable=False),
            sa.Column("ref_id", sa.Integer()),
            sa.Column("ref_key", sa.String(200)),
            sa.Column("created_by", sa.String(64)),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        )
        op.create_index("ix_field_fault_links_fault_id", "field_fault_links", ["fault_id"])
        op.create_index("ix_field_fault_links_ref", "field_fault_links", ["kind", "ref_id"])


def downgrade() -> None:
    op.drop_table("field_fault_links")
    op.drop_table("field_fault_events")
    op.drop_table("field_faults")
