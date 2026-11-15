"""iv sweep conditions

Optional measurement conditions on `growatt_iv_sweeps`: module temperature change over the minute
before the sweep, sweep duration, cell technology, the irradiance sensor's calibration
uncertainty and its angle off the array plane, and the Pmax of the opposite-direction sweep. `ensure_schema` adds the columns at startup too, so this migration skips those present.

Revision ID: a3b4c5d6e7f8
Revises: 9dcbd8611ba9
Create Date: 2026-11-15 18:00:00

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "a3b4c5d6e7f8"
down_revision: Union[str, None] = "9dcbd8611ba9"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

_COLUMNS = (
    ("temp_change_k_per_min", sa.Float()),
    ("sweep_time_ms", sa.Float()),
    ("cell_technology", sa.String(16)),
    ("irradiance_uncertainty_pct", sa.Float()),
    ("reverse_pmax_w", sa.Float()),
    ("sensor_misalignment_deg", sa.Float()),
)


def upgrade() -> None:
    present = {c["name"] for c in sa.inspect(op.get_bind()).get_columns("growatt_iv_sweeps")}
    for name, type_ in _COLUMNS:
        if name not in present:
            op.add_column("growatt_iv_sweeps", sa.Column(name, type_, nullable=True))


def downgrade() -> None:
    for name, _ in reversed(_COLUMNS):
        op.drop_column("growatt_iv_sweeps", name)
