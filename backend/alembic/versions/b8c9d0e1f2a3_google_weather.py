"""Google Maps Weather: hourly history per grid cell + external API call counts

`google_weather_hourly` holds the modelled hourly weather the `google_weather` job stores for
each plant grid cell; `external_api_call_counts` caps billable calls per plant-local day.
`app.db.session.ensure_schema` creates the same tables at startup, so this skips existing ones.

Revision ID: b8c9d0e1f2a3
Revises: b3c4d5e6f7a8
Create Date: 2026-11-12 23:30:00

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "b8c9d0e1f2a3"
down_revision: Union[str, None] = "b3c4d5e6f7a8"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

_FLOATS = (
    "temp_c", "feels_like_c", "dew_point_c", "humidity_pct", "cloud_cover_pct", "uv_index", "precip_mm",
    "precip_prob_pct", "thunder_prob_pct", "wind_speed_ms", "wind_gust_ms", "wind_dir_deg", "pressure_hpa",
    "visibility_km",
)


def upgrade() -> None:
    tables = set(sa.inspect(op.get_bind()).get_table_names())
    if "google_weather_hourly" not in tables:
        op.create_table(
            "google_weather_hourly",
            sa.Column("cell_key", sa.String(32), primary_key=True),
            sa.Column("hour", sa.DateTime(), primary_key=True),
            sa.Column("condition", sa.String(48), nullable=True),
            sa.Column("is_daytime", sa.Boolean(), nullable=True),
            *(sa.Column(c, sa.Float(), nullable=True) for c in _FLOATS),
            sa.Column("fetched_at", sa.DateTime(timezone=True), nullable=False),
        )
        op.create_index("ix_google_weather_hour", "google_weather_hourly", ["hour"])
    if "external_api_call_counts" not in tables:
        op.create_table(
            "external_api_call_counts",
            sa.Column("api", sa.String(32), primary_key=True),
            sa.Column("day", sa.String(10), primary_key=True),
            sa.Column("calls", sa.Integer(), nullable=False),
        )


def downgrade() -> None:
    op.drop_table("external_api_call_counts")
    op.drop_index("ix_google_weather_hour", table_name="google_weather_hourly")
    op.drop_table("google_weather_hourly")
