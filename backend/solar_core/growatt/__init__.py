"""Growatt OpenAPI v1 client (https://openapi.growatt.com/v1/, header `token`).

Responses are `{"error_code": 0, "error_msg": "", "data": {...}}`; a non-zero
`error_code` is an error even on HTTP 200. Growatt rate-limits per endpoint, so
callers should cache (see `GrowattClient` TTL cache).


Modules: `client` (`GrowattClient`, one method per endpoint) and `parsers` (records → rows).
Every name is re-exported here.
"""

from __future__ import annotations

from solar_core.growatt.client import (  # noqa: F401
    _snippet,
    DEVICE_TYPE_NAMES,
    ERROR_SNIPPET_MAX,
    growatt_error_text,
    GrowattAPIError,
    GrowattClient,
    INVERTER_STATUS_NAMES,
    INVERTER_TYPES,
    newest_max_records,
    OFFLINE_LABEL,
    POOL_MAXSIZE,
)
from solar_core.growatt.parsers import (  # noqa: F401
    _env_time,
    _f,
    _nonzero_int,
    _record_time,
    _round_h,
    _text,
    ENV_FIELDS,
    MAX_GRID_FIELDS,
    METER_FIELDS,
    parse_env_records,
    parse_max_diagnostics,
    parse_max_grid,
    parse_max_info,
    parse_max_mppt_energy,
    parse_max_raw,
    parse_max_records,
    parse_meter_records,
    PV_ISO_NO_READING,
    RAW_SKIP_FIELDS,
)
