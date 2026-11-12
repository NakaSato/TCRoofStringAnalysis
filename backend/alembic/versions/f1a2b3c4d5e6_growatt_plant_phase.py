"""project phase on the Growatt plant registry

Each project phase (1-4) is a separate Growatt account with its own OpenAPI token. The fleet
sync tags every plant with the phase whose account lists it; live calls and history sync use
that phase's token. NULL = not yet tagged (served by the first configured account).

`app.db.session.ensure_schema` adds the same column at startup, so this migration skips the
column when it is already there.

Revision ID: f1a2b3c4d5e6
Revises: d8e9f0a1b2c3
Create Date: 2026-11-12 18:00:00

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "f1a2b3c4d5e6"
down_revision: Union[str, None] = "d8e9f0a1b2c3"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    insp = sa.inspect(op.get_bind())
    if "phase" not in {c["name"] for c in insp.get_columns("growatt_plants")}:
        with op.batch_alter_table("growatt_plants") as batch:
            batch.add_column(sa.Column("phase", sa.Integer(), nullable=True))
    if "ix_growatt_plants_phase" not in {i["name"] for i in insp.get_indexes("growatt_plants")}:
        op.create_index("ix_growatt_plants_phase", "growatt_plants", ["phase"])


def downgrade() -> None:
    op.drop_index("ix_growatt_plants_phase", table_name="growatt_plants")
    with op.batch_alter_table("growatt_plants") as batch:
        batch.drop_column("phase")
