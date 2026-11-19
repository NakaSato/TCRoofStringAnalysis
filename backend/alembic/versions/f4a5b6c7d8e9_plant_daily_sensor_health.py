"""growatt_plant_daily: R16 sensor-health evidence columns

Stale / above-clear-sky slot counts, midday irradiance, Google's midday cloud cover and the
ratio to neighbouring plants' sensors. `app.db.session.ensure_schema` adds the same columns at
startup, so each is skipped when present.

Revision ID: f4a5b6c7d8e9
Revises: a4b5c6d7e8f9
Create Date: 2026-11-18 22:00:00

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "f4a5b6c7d8e9"
down_revision: Union[str, None] = "a4b5c6d7e8f9"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

TABLE = "growatt_plant_daily"
COLUMNS = [
    ("sensor_stale_slots", sa.Integer()),
    ("sensor_high_slots", sa.Integer()),
    ("sensor_midday_wm2", sa.Float()),
    ("sensor_midday_slots", sa.Integer()),
    ("cloud_midday_pct", sa.Float()),
    ("sensor_neighbour_ratio", sa.Float()),
    ("sensor_neighbours", sa.Integer()),
]


def upgrade() -> None:
    insp = sa.inspect(op.get_bind())
    if TABLE not in set(insp.get_table_names()):
        return
    have = {c["name"] for c in insp.get_columns(TABLE)}
    for name, type_ in COLUMNS:
        if name not in have:
            op.add_column(TABLE, sa.Column(name, type_, nullable=True))


def downgrade() -> None:
    for name, _ in reversed(COLUMNS):
        op.drop_column(TABLE, name)
