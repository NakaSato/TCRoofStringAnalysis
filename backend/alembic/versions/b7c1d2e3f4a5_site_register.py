"""O&M site register: site_register, site_devices

Station data and on-site communication devices imported from the O&M workbook
(docs/plans/om-asset-network.md). `app.db.session.ensure_schema` creates the same tables at
startup, so this skips the ones present.

Revision ID: b7c1d2e3f4a5
Revises: a385f9d720b6
Create Date: 2026-11-22 23:00:00

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "b7c1d2e3f4a5"
down_revision: Union[str, None] = "a385f9d720b6"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    tables = set(sa.inspect(op.get_bind()).get_table_names())
    if "site_register" not in tables:
        op.create_table(
            "site_register",
            sa.Column("site_code", sa.String(16), primary_key=True),
            sa.Column("plant_id", sa.Integer(), nullable=True),
            sa.Column("match_rule", sa.String(24)),
            sa.Column("name", sa.String(200), nullable=False),
            sa.Column("project_phase", sa.Integer()),
            sa.Column("province", sa.String(64)),
            sa.Column("kwp", sa.Float()),
            sa.Column("inverter_ac_kw", sa.Float()),
            sa.Column("export_limit", sa.String(8)),
            sa.Column("pea_meter_no", sa.String(32)),
            sa.Column("pea_account_no", sa.String(32)),
            sa.Column("pea_connection_status", sa.String(64)),
            sa.Column("pwa_branch", sa.String(120)),
            sa.Column("pwa_zone", sa.String(32)),
            sa.Column("pea_zone", sa.String(32)),
            sa.Column("billing_cut_days", sa.String(16)),
            sa.Column("revenue_meter_count", sa.Integer()),
            sa.Column("pea_contract_start", sa.Date()),
            sa.Column("cod_baseline", sa.Date()),
            sa.Column("cod_actual", sa.Date()),
            sa.Column("dlp_contractor", sa.String(8)),
            sa.Column("engineers_text", sa.String(200)),
            sa.Column("technicians_text", sa.String(200)),
            sa.Column("missing_sn_count", sa.Integer()),
            sa.Column("imported_by", sa.String(64)),
            sa.Column("imported_at", sa.DateTime(timezone=True), nullable=False),
        )
        op.create_index("ix_site_register_plant_id", "site_register", ["plant_id"], unique=True)
    if "site_devices" not in tables:
        op.create_table(
            "site_devices",
            sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
            sa.Column("site_code", sa.String(16), sa.ForeignKey("site_register.site_code", ondelete="CASCADE"), nullable=False),
            sa.Column("kind", sa.String(16), nullable=False),
            sa.Column("seq", sa.Integer(), nullable=False),
            sa.Column("brand_model", sa.String(120)),
            sa.Column("serial", sa.String(64)),
            sa.Column("firmware", sa.String(32)),
            sa.Column("ip", sa.String(45)),
            sa.Column("network", sa.String(43)),
            sa.Column("sim", sa.String(16)),
            sa.Column("address", sa.String(8)),
            sa.Column("ct_setting", sa.String(16)),
            sa.Column("ct_site", sa.String(16)),
            sa.Column("billing_cut_days", sa.String(16)),
            sa.Column("sales_start", sa.Date()),
            sa.Column("cod_clear_note", sa.String(200)),
            sa.Column("link_status", sa.String(64)),
            sa.Column("status", sa.String(32)),
            sa.Column("warranty_start", sa.Date()),
            sa.Column("warranty_end", sa.Date()),
            sa.Column("note", sa.Text()),
            sa.UniqueConstraint("site_code", "kind", "seq", name="uq_site_devices_site_kind_seq"),
        )
        op.create_index("ix_site_devices_site_code", "site_devices", ["site_code"])
        op.create_index("ix_site_devices_serial", "site_devices", ["serial"])


def downgrade() -> None:
    op.drop_table("site_devices")
    op.drop_table("site_register")
