"""growatt_string_readings → growatt_string_records + view

Per-string readings move to one row per inverter record (`strings` = JSON
`[[string_no, mppt_no, voltage_v, current_a], ...]`); `growatt_string_readings` becomes a view
that unpacks it, one row per string, so readers are unchanged. The key (serial, time) and its
index were repeated for every string: the table drops to about a seventh (Nov 2026).
`app.db.session.ensure_schema` does the same conversion at startup and is skipped when done.

Revision ID: 8ae6e015489b
Revises: df58170c4f5e
Create Date: 2026-11-24 07:00:00

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "8ae6e015489b"
down_revision: Union[str, None] = "df58170c4f5e"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

_VIEW_SQL = {
    "sqlite": (
        "CREATE VIEW IF NOT EXISTS growatt_string_readings AS SELECT r.device_sn AS device_sn, "
        "r.timestamp AS timestamp, CAST(json_extract(j.value, '$[0]') AS INTEGER) AS string_no, "
        "CAST(json_extract(j.value, '$[1]') AS INTEGER) AS mppt_no, "
        "CAST(json_extract(j.value, '$[2]') AS REAL) AS voltage_v, "
        "CAST(json_extract(j.value, '$[3]') AS REAL) AS current_a "
        "FROM growatt_string_records AS r, json_each(r.strings) AS j"
    ),
    "postgresql": (
        "CREATE OR REPLACE VIEW growatt_string_readings AS SELECT r.device_sn AS device_sn, "
        "r.timestamp AS timestamp, (e ->> 0)::integer AS string_no, (e ->> 1)::integer AS mppt_no, "
        "(e ->> 2)::double precision AS voltage_v, (e ->> 3)::double precision AS current_a "
        "FROM growatt_string_records AS r CROSS JOIN LATERAL json_array_elements(r.strings) AS e"
    ),
}


def _tables() -> set:
    return set(sa.inspect(op.get_bind()).get_table_names())


def upgrade() -> None:
    bind = op.get_bind()
    if "growatt_string_records" not in _tables():
        op.create_table(
            "growatt_string_records",
            sa.Column("device_sn", sa.String(length=64), nullable=False),
            sa.Column("timestamp", sa.DateTime(), nullable=False),
            sa.Column("strings", sa.JSON(), nullable=False),
            sa.ForeignKeyConstraint(["device_sn"], ["growatt_inverters.device_sn"], ondelete="CASCADE"),
            sa.PrimaryKeyConstraint("device_sn", "timestamp"),
        )
    if "growatt_string_readings" in _tables():
        if bind.dialect.name == "postgresql":
            agg = "json_agg(json_build_array(string_no, mppt_no, voltage_v, current_a) ORDER BY string_no)"
            src = "growatt_string_readings"
        else:
            agg = "json_group_array(json_array(string_no, mppt_no, voltage_v, current_a))"
            src = "(SELECT * FROM growatt_string_readings ORDER BY device_sn, timestamp, string_no)"
        op.execute(
            "INSERT INTO growatt_string_records (device_sn, timestamp, strings) "
            f"SELECT device_sn, timestamp, {agg} FROM {src} AS s GROUP BY device_sn, timestamp"
        )
        op.execute("DROP TABLE growatt_string_readings")
    op.execute(_VIEW_SQL[bind.dialect.name])


def downgrade() -> None:
    if "growatt_string_readings" in _tables():
        return
    op.execute("DROP VIEW IF EXISTS growatt_string_readings")
    op.create_table(
        "growatt_string_readings",
        sa.Column("device_sn", sa.String(length=64), nullable=False),
        sa.Column("timestamp", sa.DateTime(), nullable=False),
        sa.Column("string_no", sa.Integer(), autoincrement=False, nullable=False),
        sa.Column("mppt_no", sa.Integer(), nullable=False),
        sa.Column("voltage_v", sa.Float(), nullable=False),
        sa.Column("current_a", sa.Float(), nullable=False),
        sa.ForeignKeyConstraint(["device_sn"], ["growatt_inverters.device_sn"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("device_sn", "timestamp", "string_no"),
    )
    bind = op.get_bind()
    tmp = "CREATE VIEW _str_unpacked AS " + _VIEW_SQL[bind.dialect.name].split(" AS ", 1)[1]
    op.execute(tmp)
    op.execute("INSERT INTO growatt_string_readings SELECT * FROM _str_unpacked")
    op.execute("DROP VIEW _str_unpacked")
    op.drop_table("growatt_string_records")
