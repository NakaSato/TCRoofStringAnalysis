"""Sync Growatt OpenAPI data into the app database.

Usage (from repo root):
    PYTHONPATH=backend uv run python -m app.services.growatt_sync               # fleet + yesterday..today
    PYTHONPATH=backend uv run python -m app.services.growatt_sync --start 2026-11-05 --end 2026-11-11
    PYTHONPATH=backend uv run python -m app.services.growatt_sync --fleet-only
    PYTHONPATH=backend uv run python -m app.services.growatt_sync --sn GKLLEXC006 --sn GKLLEXC005
    PYTHONPATH=backend uv run python -m app.services.growatt_sync --phase 2     # one account only

Weather sensors (`device/env/*`) are registered by the fleet sync and their history is
synced with the inverters' (skipped when `--sn` limits the run to some inverters).

Each project phase is a separate Growatt account (`GROWATT_TOKEN_PHASE1..4`). The fleet sync
tags every plant with the phase whose token lists it, and history for a plant's inverters is
always pulled with that phase's token.

Re-running is safe: readings are upserted on their primary keys.


One module per area (`registry`, `inverters`, `env`, `meters`, `power_limits`, `retention`, `cli`;
shared helpers in `common`). Every name is re-exported here, so callers import from
`app.services.growatt_sync` as before.
"""

from __future__ import annotations

import time  # noqa: F401  (tests patch `growatt_sync.time.sleep`)

from app.services.growatt_sync.common import (
    _BATCH,
    _date_chunks,
    _fnum,
    _inverters_query,
    _retry,
    _upsert,
    log,
    MAX_RATE_LIMITED,
    RATE_LIMIT_CODE,
    T,
)
from app.services.growatt_sync.registry import (
    _coords_row,
    _due,
    _LAT_RANGE,
    _LON_RANGE,
    _registry_sweep,
    _sync_create_dates,
    _sync_device_params,
    _sync_inverter_info,
    _sync_missing_dataloggers,
    _sync_plant_details,
    CREATE_DATE_CHUNK,
    DETAILS_REFRESH_DAYS,
    INFO_MAX_RATE_LIMITED,
    INFO_REFRESH_HOURS,
    normalize_coords,
    PARAM_REFRESH_DAYS,
    REGISTRY_MAX_RATE_LIMITED,
    sync_fleet,
)
from app.services.growatt_sync.power_limits import (
    POWER_LIMIT_PAUSE_S,
    POWER_LIMIT_REFRESH_HOURS,
    sync_power_limits,
)
from app.services.growatt_sync.env import (
    _env_sensors_query,
    _sync_envs,
    sync_env_all,
    sync_env_history,
    sync_env_incremental,
    sync_env_sensors,
)
from app.services.growatt_sync.meters import (
    _meters_query,
    _sync_meter_list,
    sync_meter_all,
    sync_meter_history,
    sync_meter_incremental,
    sync_meters,
)
from app.services.growatt_sync.inverters import (
    _RAW_BATCH,
    _store_raw,
    _store_today,
    _sync_today_batched,
    _sync_today_single,
    BATCH_MAX_ERRORS,
    LATEST_CHUNK,
    sync_all_history,
    sync_incremental,
    sync_inverter_history,
    sync_latest_records,
)
from app.services.growatt_sync.retention import (
    _rowcount,
    prune_history,
    prune_raw,
)
from app.services.growatt_sync.cli import (
    main,
)
