//! Port of `backend/solar_core/growatt/` (Growatt OpenAPI v1): the client, one method per
//! endpoint ([`client`], `client.py`), and the record parsers ([`parsers`], `parsers.py`). Every
//! public name of the Python package is re-exported here, as `solar_core.growatt` does.
//!
//! Growatt times are naive plant-local (Bangkok) wall-clock times and stay
//! [`chrono::NaiveDateTime`]. Realtime answers (`plant_data`, `maxs_latest`, `*_last_*`, …) are for
//! memory only; nothing here stores anything.

pub mod client;
pub mod parsers;
pub mod py;

pub use client::{
    growatt_error_text, merge_inverters, newest_max_records, parse_device_info_param,
    parse_plant_details, snippet, DeviceInfoParam, GrowattApiError, GrowattClient,
    GrowattClientOptions, GrowattError, InverterEntry, PlantDetails, DEFAULT_BASE_URL,
    DEFAULT_CACHE_TTL_S, DEFAULT_TIMEOUT_S, DEVICE_TYPE_NAMES, ERROR_SNIPPET_MAX,
    INVERTER_STATUS_NAMES, INVERTER_TYPES, MAXS_PAGE, OFFLINE_LABEL, POOL_MAXSIZE,
    RATE_LIMITED_CODE,
};
pub use parsers::{
    env_time, f, nonzero_int, parse_env_records, parse_max_diagnostics, parse_max_grid,
    parse_max_info, parse_max_mppt_energy, parse_max_raw, parse_max_records, parse_meter_records,
    record_time, round_h, text, EnvRow, InverterRow, MaxDiagnostics, MaxGrid, MaxInfo, MeterRow,
    MpptEnergy, MpptPoint, RawRow, Record, StringRow, ENV_FIELDS, MAX_GRID_FIELDS, METER_FIELDS,
    PV_ISO_NO_READING, RAW_SKIP_FIELDS,
};
