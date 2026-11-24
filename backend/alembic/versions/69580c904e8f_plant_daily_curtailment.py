"""growatt_plant_daily: curtailment of the day (estimated) and free-running evidence

Per plant and day the curtailed kWh (estimated, split by cause), the model scale used
(calibration from the 14 days before) and the day's free ratio (median AC ÷ model where the
plant was surely not held back). `app.db.session.ensure_schema` adds the same columns at
startup (`_ADDED_COLUMNS`), so each is skipped when present.

Revision ID: 69580c904e8f
Revises: 8ae6e015489b
Create Date: 2026-11-24 09:00:00

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "69580c904e8f"
down_revision: Union[str, None] = "8ae6e015489b"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

_COLS = [
    ("curtailed_kwh", sa.Float()),
    ("curtailed_slots", sa.Integer()),
    ("curtail_judged_slots", sa.Integer()),
    ("curtailed_export_kwh", sa.Float()),
    ("curtailed_limit_kwh", sa.Float()),
    ("curtail_ratio", sa.Float()),
    ("curtail_ratio_slots", sa.Integer()),
    ("curtail_ratio_source", sa.String(length=8)),
    ("free_ratio", sa.Float()),
    ("free_slots", sa.Integer()),
]


def _have() -> set:
    return {c["name"] for c in sa.inspect(op.get_bind()).get_columns("growatt_plant_daily")}


def upgrade() -> None:
    have = _have()
    with op.batch_alter_table("growatt_plant_daily") as batch:
        for name, typ in _COLS:
            if name not in have:
                batch.add_column(sa.Column(name, typ, nullable=True))


def downgrade() -> None:
    have = _have()
    with op.batch_alter_table("growatt_plant_daily") as batch:
        for name, _ in _COLS:
            if name in have:
                batch.drop_column(name)
