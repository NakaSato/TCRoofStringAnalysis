"""drop ix_growatt_str_ts

`growatt_string_readings` is read only per inverter (primary key device_sn, timestamp,
string_no), and retention now deletes per inverter, so the timestamp index (about a fifth of
the table's size) only cost disk and every insert. `ensure_schema` drops it at startup too
(`session._DROPPED_INDEXES`), so it is skipped when gone.

Revision ID: 32c7aefd7f24
Revises: f5a6b7c8d9e0
Create Date: 2026-11-22 20:00:00

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "32c7aefd7f24"
down_revision: Union[str, None] = "f5a6b7c8d9e0"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def _has_index() -> bool:
    insp = sa.inspect(op.get_bind())
    return "ix_growatt_str_ts" in {i["name"] for i in insp.get_indexes("growatt_string_readings")}


def upgrade() -> None:
    if _has_index():
        op.drop_index("ix_growatt_str_ts", table_name="growatt_string_readings")


def downgrade() -> None:
    if not _has_index():
        op.create_index("ix_growatt_str_ts", "growatt_string_readings", ["timestamp"], unique=False)
