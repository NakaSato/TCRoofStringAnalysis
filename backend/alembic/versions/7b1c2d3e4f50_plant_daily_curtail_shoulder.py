"""growatt_plant_daily: curtailment error estimate and shoulder-hour free ratios

`curtailed_err_kwh` = the typical error of the day's curtailed kWh from its calibration;
`shoulder_ratios` = the day's free ratios at 08 h / 15 h ({"8": [ratio, slots], …}), which
calibrate plants that never run free at midday (services/growatt_curtailment.py). Also added at
startup by `app.db.session.ensure_schema` (`_ADDED_COLUMNS`), so each is skipped when present.

Revision ID: 7b1c2d3e4f50
Revises: 69580c904e8f
Create Date: 2026-11-25 21:00:00

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "7b1c2d3e4f50"
down_revision: Union[str, None] = "69580c904e8f"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

_COLS = [
    ("curtailed_err_kwh", sa.Float()),
    ("shoulder_ratios", sa.JSON()),
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
