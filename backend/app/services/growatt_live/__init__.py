"""Realtime Growatt data, held in process memory only.

Nothing here touches SQL or Firestore: realtime values (current power, status, lost flag)
are superseded every few minutes, so persisting them would only burn write quota. The
persisted history comes from `growatt_sync` (5-minute `max_data` records) instead.

Every call returns an envelope::

    {"source": "live", "fetched_at": iso8601, "stale": bool, "error": str | None,
     "refresh_in_s": int, "data": ...}

`stale=True` means Growatt failed (offline / rate-limited) and the last good value is served.
`refresh_in_s` is how long until asking again can return anything new (cache expiry or the
end of a cooldown), so clients poll when data can change instead of on a fixed timer. It is
relative, not a timestamp, so client clock skew does not matter.

Each project phase is its own Growatt account and token. Plant-level calls use the token of the
plant's phase; `plants()` asks every account and merges the lists (tagged with `phase`).


Modules: `core` (constants, result types, the cache and sweep), `rows` (one Growatt answer →
the fields served), `service` (`GrowattLiveService` and `get_live_service`). Every name is
re-exported here.
"""

from __future__ import annotations

from app.services.growatt_live.core import (  # noqa: F401
    _daylight,
    _Result,
    _Sweep,
    ALARM_WORKERS,
    Coords,
    DAYLIGHT_MARGIN_S,
    DEFAULT_INTERVAL_S,
    FALLBACK_COORDS,
    GROWATT_SERVER_TZ,
    LATE_RETRY_S,
    LIVE_WORKERS,
    LiveCache,
    LiveUnavailable,
    MAX_INTERVAL_S,
    MIN_INTERVAL_S,
    MIN_REFRESH_S,
    PAST_DAY_ALARM_TTL_S,
    PLANT_TZ,
    PLANT_UTC_OFFSET_H,
    RATE_LIMIT_CODE,
    SENSOR_DAY_TTL_S,
    SWEEP_REFRESH_S,
    Ttl,
    UPLOAD_GRACE_S,
)
from app.services.growatt_live.rows import (  # noqa: F401
    _alarm_row,
    _datalogger_rows,
    _env_row,
    _env_status_rows,
    _epoch_local,
    _f,
    _flag,
    _latest_row,
    _local_ts,
    _maxs_rows,
    _meter_row,
    _newest_records,
    _plant_data_row,
    _power_tail,
    _record_gap,
    _record_ts,
    POWER_TAIL_RECORDS,
    PREVIOUS_RECORDS,
    SNAPSHOT_CHUNK,
)
from app.services.growatt_live.service import (  # noqa: F401
    get_live_service,
    GrowattLiveService,
)
