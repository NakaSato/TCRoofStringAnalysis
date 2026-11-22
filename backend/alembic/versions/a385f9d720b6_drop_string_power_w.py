"""drop growatt_string_readings.power_w

String power is V × I, so it is derived by the model (a hybrid property) instead of stored.
`ensure_schema` drops the column at startup too (`session._DROPPED_COLUMNS`), so it is
skipped when gone. On Postgres the drop only changes the catalog; the space comes back as
retention deletes the old rows.

Revision ID: a385f9d720b6
Revises: 32c7aefd7f24
Create Date: 2026-11-22 21:00:00

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "a385f9d720b6"
down_revision: Union[str, None] = "32c7aefd7f24"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def _has_column() -> bool:
    insp = sa.inspect(op.get_bind())
    return "power_w" in {c["name"] for c in insp.get_columns("growatt_string_readings")}


def upgrade() -> None:
    if _has_column():
        with op.batch_alter_table("growatt_string_readings") as batch:
            batch.drop_column("power_w")


def downgrade() -> None:
    if not _has_column():
        with op.batch_alter_table("growatt_string_readings") as batch:
            batch.add_column(sa.Column("power_w", sa.Float(), nullable=False, server_default="0"))
        op.execute("UPDATE growatt_string_readings SET power_w = ROUND(CAST(voltage_v * current_a AS NUMERIC), 1)")
