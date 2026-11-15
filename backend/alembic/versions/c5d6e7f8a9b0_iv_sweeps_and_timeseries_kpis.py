"""I-V curve sweeps and time-series performance KPIs (PR', EPI, Ya-Yf, peer orientation/tilt)

Adds `growatt_plant_daily` and `growatt_iv_sweeps`, plus orientation/tilt on `growatt_string_layouts`,
`voltage_sensing` on `growatt_string_daily`, and `dc_energy_kwh` / `ya_kwh_kwp` / `ya_minus_yf` on
`growatt_inverter_daily`.

Revision ID: c5d6e7f8a9b0
Revises: e7f8a9b0c1d2
Create Date: 2026-11-15 23:00:00

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "c5d6e7f8a9b0"
down_revision: Union[str, None] = "e7f8a9b0c1d2"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

ADDED = [
    ("growatt_string_layouts", "azimuth_deg", sa.Float()),
    ("growatt_string_layouts", "tilt_deg", sa.Float()),
    ("growatt_string_daily", "voltage_sensing", sa.String(16)),
    ("growatt_inverter_daily", "dc_energy_kwh", sa.Float()),
    ("growatt_inverter_daily", "ya_kwh_kwp", sa.Float()),
    ("growatt_inverter_daily", "ya_minus_yf", sa.Float()),
]


def upgrade() -> None:
    insp = sa.inspect(op.get_bind())
    tables = set(insp.get_table_names())
    for table, column, col_type in ADDED:
        if table in tables and column not in {c["name"] for c in insp.get_columns(table)}:
            op.add_column(table, sa.Column(column, col_type))

    if "growatt_plant_daily" not in tables:
        op.create_table(
            "growatt_plant_daily",
            sa.Column("plant_id", sa.Integer(), primary_key=True, autoincrement=False),
            sa.Column("day", sa.Date(), primary_key=True),
            *(
                sa.Column(c, sa.Float())
                for c in (
                    "capacity_kwp",
                    "energy_kwh",
                    "dc_energy_kwh",
                    "modelled_energy_kwh",
                    "yr_h",
                    "ya_kwh_kwp",
                    "yf_kwh_kwp",
                    "ya_minus_yf",
                    "pr_pct",
                    "pr_temp_corrected_pct",
                    "epi",
                    "irradiance_weighted_tmod_c",
                )
            ),
            *(
                sa.Column(c, sa.Integer(), nullable=False, server_default="0")
                for c in ("filtered_slots", "stale_masked_slots", "clipped_masked_slots", "curtailed_masked_slots")
            ),
            sa.Column("computed_at", sa.DateTime(timezone=True), nullable=False),
        )

    if "growatt_iv_sweeps" not in tables:
        op.create_table(
            "growatt_iv_sweeps",
            sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
            sa.Column("plant_id", sa.Integer(), nullable=False),
            sa.Column("device_sn", sa.String(64)),
            sa.Column("string_no", sa.Integer()),
            sa.Column("module_no", sa.Integer()),
            sa.Column("level", sa.String(16), nullable=False),
            sa.Column("source", sa.String(32), nullable=False),
            sa.Column("swept_at", sa.DateTime(), nullable=False),
            sa.Column("irradiance_wm2", sa.Float(), nullable=False),
            sa.Column("module_temp_c", sa.Float(), nullable=False),
            sa.Column("irradiance_change_pct", sa.Float()),
            sa.Column("reference_cell_tech", sa.String(64)),
            sa.Column("modules", sa.Integer(), nullable=False),
            sa.Column("quality_gate_passed", sa.Boolean(), nullable=False),
            sa.Column("gate_reasons_json", sa.JSON()),
            sa.Column("iec60891_json", sa.JSON()),
            sa.Column("measured_json", sa.JSON()),
            sa.Column("stc_json", sa.JSON()),
            sa.Column("classification_json", sa.JSON()),
            sa.Column("p_max_stc_w", sa.Float(), nullable=False),
            sa.Column("expected_pmax_stc_w", sa.Float(), nullable=False),
            sa.Column("pmax_dev_pct", sa.Float(), nullable=False),
            sa.Column("signature", sa.String(48), nullable=False),
            sa.Column("is_finding", sa.Boolean(), nullable=False),
            sa.Column("ticket_recommended", sa.Boolean(), nullable=False),
            sa.Column("ir_confirmed", sa.Boolean(), nullable=False),
            sa.Column("timeseries_trend_confirmed", sa.Boolean(), nullable=False),
            sa.Column("warranty_claim_ready", sa.Boolean(), nullable=False),
            sa.Column("note", sa.Text()),
            sa.Column("created_by", sa.String(64)),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        )
        op.create_index("ix_growatt_iv_sweeps_plant_sn", "growatt_iv_sweeps", ["plant_id", "device_sn", "string_no"])


def downgrade() -> None:
    op.drop_table("growatt_iv_sweeps")
    op.drop_table("growatt_plant_daily")
    for table, column, _ in ADDED:
        op.drop_column(table, column)
