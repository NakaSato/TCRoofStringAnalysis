//! Port of `backend/app/services/growatt_sync/` (package `common`, `registry`, `inverters`,
//! `env`, `meters`, `power_limits`): Growatt OpenAPI history and registry → SQL. Started by the
//! worker (Phase 4); `retention` is ported with the worker's `retention` job, not here.
//!
//! Every function takes the pool and one account's [`GrowattClient`] and returns the same detail
//! object (`serde_json::Value`, same keys) as the Python function, so a job can put it in
//! `sync_runs.detail` unchanged. Python's tuples in `failed` lists are JSON arrays here, as
//! `jobs._jsonable` writes them.
//!
//! SQL effects are Python's: the same rows, the same `INSERT .. ON CONFLICT` on each table's
//! primary key (`common._upsert`: update every column the row carries, `DO NOTHING` when it
//! carries none), one transaction per item where Python commits per item (a failed item rolls
//! back only its own writes), the same `history_synced_until` / `synced_at` bookkeeping. Reading
//! tables hold naive plant-local times from Growatt's own records (never a poll time); the
//! bookkeeping columns are UTC (`TIMESTAMPTZ`).
//!
//! Pauses between calls (`time.sleep` in Python) go through [`SyncOptions::sleep`], so tests run
//! without them, as Python's tests patch `growatt_sync.time.sleep`.

pub mod env;
pub mod inverters;
pub mod meters;
pub mod power_limits;
pub mod registry;

use std::future::Future;
use std::time::Duration;

use chrono::{NaiveDate, NaiveDateTime};
use serde_json::{json, Value};
use sqlx::{PgPool, Postgres, QueryBuilder};
use tcroof_clients::growatt::{py, GrowattError};

pub use env::{sync_env_all, sync_env_history, sync_env_incremental, sync_env_sensors, EnvSensor};
pub use inverters::{
    store_string_rows, sync_all_history, sync_incremental, sync_inverter_history, sync_latest_records, LATEST_CHUNK,
};
pub use meters::{sync_meter_all, sync_meter_history, sync_meter_incremental, sync_meters, Meter};
pub use power_limits::{sync_power_limits, POWER_LIMIT_PAUSE_S, POWER_LIMIT_REFRESH_HOURS};
pub use registry::{normalize_coords, remove_blocked_plants, sync_fleet};

/// Python `common.RATE_LIMIT_CODE`: Growatt's per-endpoint rate limit ("error_frequently_access")
pub const RATE_LIMIT_CODE: i64 = 10012;
/// Python `common.MAX_RATE_LIMITED`: consecutive 10012 answers that end a sensor / meter sweep
pub const MAX_RATE_LIMITED: usize = 3;
/// Python `common._BATCH`: rows per INSERT statement
pub const BATCH: usize = 2000;

// --------------------------------------------------------------------------- options

/// What Python reads from `settings` (and its tests patch) for these functions.
#[derive(Debug, Clone)]
pub struct SyncOptions {
    /// false = no pauses between calls or before retries (Python's tests patch `time.sleep`)
    pub sleep: bool,
    /// `HISTORY_STORE_RAW` (default false): keep whole `max_data` records in `growatt_inverter_raw`
    pub history_store_raw: bool,
    /// `METER_HISTORY_ENABLED` (default true): `history` / `backfill` also sync `meter_data`
    pub meter_history_enabled: bool,
}

impl Default for SyncOptions {
    fn default() -> Self {
        SyncOptions { sleep: true, history_store_raw: false, meter_history_enabled: true }
    }
}

impl SyncOptions {
    /// The same environment variables and defaults as backend/app/config.py (pydantic bools:
    /// `1/true/yes/on/t/y` and `0/false/no/off/f/n`, case-insensitive; an empty value = default).
    pub fn from_env() -> SyncOptions {
        let d = SyncOptions::default();
        let flag = |k: &str, default: bool| {
            std::env::var(k)
                .ok()
                .filter(|v| !v.trim().is_empty())
                .and_then(|v| match v.trim().to_ascii_lowercase().as_str() {
                    "1" | "on" | "t" | "true" | "y" | "yes" => Some(true),
                    "0" | "off" | "f" | "false" | "n" | "no" => Some(false),
                    _ => None,
                })
                .unwrap_or(default)
        };
        SyncOptions {
            sleep: true,
            history_store_raw: flag("HISTORY_STORE_RAW", d.history_store_raw),
            meter_history_enabled: flag("METER_HISTORY_ENABLED", d.meter_history_enabled),
        }
    }

    /// Python `time.sleep(seconds)`.
    pub async fn sleep(&self, seconds: f64) {
        if self.sleep && seconds > 0.0 {
            tokio::time::sleep(Duration::from_secs_f64(seconds)).await;
        }
    }
}

// --------------------------------------------------------------------------- errors

/// What a sync step can fail with; its text is Python's `str(exc)` where Python's is known
/// (Growatt refusals carry Growatt's own message).
#[derive(Debug, thiserror::Error)]
pub enum SyncError {
    #[error("{}", growatt_text(.0))]
    Growatt(GrowattError),
    #[error("{0}")]
    Db(#[from] sqlx::Error),
    /// a reply the Python parsers raise on (`TypeError` / `ValueError`)
    #[error("{0}")]
    Parse(String),
}

impl From<GrowattError> for SyncError {
    fn from(e: GrowattError) -> Self {
        SyncError::Growatt(e)
    }
}

impl From<py::PyError> for SyncError {
    fn from(e: py::PyError) -> Self {
        SyncError::Parse(e.0)
    }
}

/// `str(exc)` of a client error: Growatt's message, or the Python exception text the client
/// would have raised.
pub fn growatt_text(e: &GrowattError) -> String {
    match e {
        GrowattError::Api(a) => a.message.clone(),
        GrowattError::InvalidArgument(m) => m.clone(),
        GrowattError::Unexpected(p) => p.0.clone(),
    }
}

impl SyncError {
    /// Python `isinstance(exc, GrowattAPIError) and exc.error_code == RATE_LIMIT_CODE`
    pub fn is_rate_limited(&self) -> bool {
        matches!(self, SyncError::Growatt(g) if g.is_rate_limited())
    }

    /// Python `str(exc)`: the message without the exception name that `Parse` carries
    /// (`AttributeError: 'str' object …` → `'str' object …`).
    pub fn py_str(&self) -> String {
        match self {
            SyncError::Parse(m) => strip_exc_name(m).to_owned(),
            e => e.to_string(),
        }
    }
}

/// `"XxxError: msg"` → `"msg"` (Python's `str(exc)` of a `type(exc).__name__: str(exc)` text).
pub fn strip_exc_name(m: &str) -> &str {
    match m.split_once(": ") {
        Some((name, rest)) if name.ends_with("Error") && name.chars().all(|c| c.is_ascii_alphanumeric()) => rest,
        _ => m,
    }
}

/// A Python dict of counts keyed by text, in insertion order: `d[k] = d.get(k, 0) + 1`, and
/// `repr(d)` for log lines (`{'18': 3, '5': 1}`). Serializes as a JSON object.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct PyCounts(pub Vec<(String, u64)>);

impl PyCounts {
    pub fn bump(&mut self, key: String) {
        match self.0.iter_mut().find(|(k, _)| *k == key) {
            Some((_, n)) => *n += 1,
            None => self.0.push((key, 1)),
        }
    }

    /// Python `repr(dict)` (`str()` of a dict is its repr)
    pub fn repr(&self) -> String {
        let items: Vec<String> = self.0.iter().map(|(k, n)| format!("{}: {n}", py::repr_str(k))).collect();
        format!("{{{}}}", items.join(", "))
    }
}

impl serde::Serialize for PyCounts {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        use serde::ser::SerializeMap;
        let mut m = s.serialize_map(Some(self.0.len()))?;
        for (k, n) in &self.0 {
            m.serialize_entry(k, n)?;
        }
        m.end()
    }
}

/// Python `str(x)` of an optional float (`None`, `100.0`)
pub fn py_opt_float(v: Option<f64>) -> String {
    v.map_or_else(|| "None".to_owned(), py::repr_float)
}

#[cfg(test)]
mod py_text_tests {
    use super::*;

    #[test]
    fn counts_keep_insertion_order_and_repr_like_python() {
        let mut c = PyCounts::default();
        for k in ["18", "5", "18", "0", "18"] {
            c.bump(k.into());
        }
        assert_eq!(c.repr(), "{'18': 3, '5': 1, '0': 1}");
        assert_eq!(PyCounts::default().repr(), "{}");
    }

    #[test]
    fn str_of_exception_drops_the_name() {
        assert_eq!(strip_exc_name("AttributeError: 'str' object has no attribute 'get'"), "'str' object has no attribute 'get'");
        assert_eq!(strip_exc_name("plant 4: no rows"), "plant 4: no rows");
        assert_eq!(py_opt_float(Some(100.0)), "100.0");
        assert_eq!(py_opt_float(None), "None");
    }
}

pub type SyncResult<T> = std::result::Result<T, SyncError>;

// --------------------------------------------------------------------------- Python helpers

/// Python `common._retry`: call `f`, retrying Growatt errors (`GrowattAPIError` only: anything
/// else is raised at once); 10012 waits minutes (60 s, 120 s, 120 s), other refusals 5, 10, 15 s.
pub async fn retry<T, F, Fut>(opts: &SyncOptions, label: &str, retries: usize, mut f: F) -> SyncResult<T>
where
    F: FnMut() -> Fut,
    Fut: Future<Output = Result<T, GrowattError>>,
{
    let mut attempt = 0usize;
    loop {
        match f().await {
            Ok(v) => return Ok(v),
            Err(e @ GrowattError::Api(_)) => {
                if attempt >= retries {
                    return Err(e.into());
                }
                let wait = if e.is_rate_limited() { (60 * (attempt + 1)).min(120) } else { 5 * (attempt + 1) };
                tracing::warn!(target: "growatt_sync", "{label}: {} — retry in {wait}s", growatt_text(&e));
                opts.sleep(wait as f64).await;
                attempt += 1;
            }
            Err(e) => return Err(e.into()),
        }
    }
}

/// Python `common._date_chunks(start, end, days=7)`
pub fn date_chunks(start: NaiveDate, end: NaiveDate, days: i64) -> Vec<(NaiveDate, NaiveDate)> {
    let mut out = Vec::new();
    let mut cur = start;
    while cur <= end {
        let stop = (cur + chrono::Duration::days(days - 1)).min(end);
        out.push((cur, stop));
        cur = stop + chrono::Duration::days(1);
    }
    out
}

/// `datetime.combine(day, time.min)`
pub fn midnight(day: NaiveDate) -> NaiveDateTime {
    day.and_hms_opt(0, 0, 0).expect("midnight")
}

/// Python `common._fnum`: `float(v)`, None on TypeError / ValueError.
pub fn fnum(v: &Value) -> Option<f64> {
    py::float(v)
}

/// A Python value bound to a VARCHAR column: what Postgres stores for it (psycopg sends `str`
/// as text, `int` / `float` as numbers that the column casts to their text form).
pub fn text_value(v: &Value) -> Option<String> {
    match v {
        Value::Null => None,
        Value::String(s) => Some(s.clone()),
        Value::Bool(b) => Some(if *b { "true" } else { "false" }.into()),
        Value::Number(n) => Some(match n.as_i64() {
            Some(i) => i.to_string(),
            None => {
                let f = n.as_f64().unwrap_or(f64::NAN);
                if f.fract() == 0.0 && f.abs() < 1e15 {
                    format!("{}", f as i64)
                } else {
                    format!("{f}")
                }
            }
        }),
        other => Some(other.to_string()),
    }
}

/// Python `int(str(v))` (`ValueError` → None): the registry's bus addresses.
pub fn int_of_str(v: &Value) -> Option<i64> {
    let s = py::str_of(v);
    let t = py::strip(&s).replace('_', "");
    if t.is_empty() || t.starts_with('_') {
        return None;
    }
    t.parse::<i64>().ok()
}

/// A failure entry, Python's `(label, str(exc))` tuple.
pub fn failed_entry(label: impl Into<String>, text: impl Into<String>) -> Value {
    json!([label.into(), text.into()])
}

/// Python `f"phase {phase}"` (None prints as `None`).
pub fn phase_text(phase: Option<i32>) -> String {
    phase.map_or_else(|| "None".to_owned(), |p| p.to_string())
}

/// One bound value of an upsert row (the column types the sync tables use).
#[derive(Debug, Clone)]
pub(crate) enum B {
    Text(Option<String>),
    I32(Option<i32>),
    F64(Option<f64>),
    Ts(Option<NaiveDateTime>),
    Tz(Option<chrono::DateTime<chrono::Utc>>),
    Date(Option<NaiveDate>),
    /// compact JSON text (`session._compact_json`), cast to the column's `json`
    Json(String),
}

/// Python `common._upsert(db, model, rows, update_cols)`: `INSERT .. ON CONFLICT (pk) DO UPDATE
/// SET` every non-key column of the rows (or `update` when given; `DO NOTHING` when that is
/// empty), `batch` rows per statement ([`BATCH`]). A key twice in one statement fails the
/// statement, as in Python (Postgres refuses to update a row twice).
pub(crate) async fn upsert(
    conn: &mut sqlx::PgConnection,
    table: &str,
    cols: &[&str],
    pk: &[&str],
    rows: Vec<Vec<B>>,
    batch: usize,
) -> SyncResult<()> {
    if rows.is_empty() {
        return Ok(());
    }
    let upd: Vec<&str> = cols.iter().copied().filter(|c| !pk.contains(c)).collect();
    let tail = if upd.is_empty() {
        format!(" ON CONFLICT ({}) DO NOTHING", pk.join(", "))
    } else {
        format!(
            " ON CONFLICT ({}) DO UPDATE SET {}",
            pk.join(", "),
            upd.iter().map(|c| format!("{c} = EXCLUDED.{c}")).collect::<Vec<_>>().join(", ")
        )
    };
    for chunk in rows.chunks(batch.max(1)) {
        let mut qb: QueryBuilder<Postgres> = QueryBuilder::new(format!("INSERT INTO {table} ({}) ", cols.join(", ")));
        qb.push_values(chunk.iter(), |mut b, row| {
            for v in row {
                match v.clone() {
                    B::Text(x) => b.push_bind(x),
                    B::I32(x) => b.push_bind(x),
                    B::F64(x) => b.push_bind(x),
                    B::Ts(x) => b.push_bind(x),
                    B::Tz(x) => b.push_bind(x),
                    B::Date(x) => b.push_bind(x),
                    B::Json(x) => b.push_bind(x).push_unseparated("::json"),
                };
            }
        });
        qb.push(&tail);
        qb.build().execute(&mut *conn).await?;
    }
    Ok(())
}

// --------------------------------------------------------------------------- the inverter query

/// The registry fields of one inverter the sync functions read.
#[derive(Debug, Clone, sqlx::FromRow)]
pub struct SyncInverter {
    pub device_sn: String,
    pub plant_id: i32,
    pub datalogger_sn: Option<String>,
    pub history_synced_until: Option<NaiveDateTime>,
    pub power_limit_pct: Option<f64>,
    pub power_limit_read_at: Option<chrono::DateTime<chrono::Utc>>,
}

const SYNC_INVERTER_COLS: &str =
    "i.device_sn, i.plant_id, i.datalogger_sn, i.history_synced_until, i.power_limit_pct, i.power_limit_read_at";

/// Python `common._inverters_query(phase, include_untagged)` with an ORDER BY of its own
/// (`order` replaces Python's `plant_id, device_sn`): installed inverters, restricted to one
/// phase's plants when `phase` is given (`include_untagged` adds plants with no phase yet).
pub async fn inverters_query(
    pool: &PgPool,
    phase: Option<i32>,
    include_untagged: bool,
    order: Option<&str>,
) -> SyncResult<Vec<SyncInverter>> {
    let order = order.unwrap_or("i.plant_id, i.device_sn");
    let sql = match phase {
        None => format!("SELECT {SYNC_INVERTER_COLS} FROM growatt_inverters i WHERE i.not_installed_at IS NULL ORDER BY {order}"),
        Some(_) => format!(
            "SELECT {SYNC_INVERTER_COLS} FROM growatt_inverters i JOIN growatt_plants p ON p.plant_id = i.plant_id \
             WHERE i.not_installed_at IS NULL AND (p.phase = $1{}) ORDER BY {order}",
            if include_untagged { " OR p.phase IS NULL" } else { "" }
        ),
    };
    let mut q = sqlx::query_as::<_, SyncInverter>(&sql);
    if let Some(p) = phase {
        q = q.bind(p);
    }
    Ok(q.fetch_all(pool).await?)
}

/// `(phase = $n OR phase IS NULL)`-style restriction for the sensor / meter / plant queries.
pub(crate) fn phase_join(table: &str, phase: Option<i32>, include_untagged: bool) -> String {
    match phase {
        None => String::new(),
        Some(_) => format!(
            " JOIN growatt_plants p ON p.plant_id = {table}.plant_id WHERE (p.phase = $1{})",
            if include_untagged { " OR p.phase IS NULL" } else { "" }
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chunks_of_seven_days() {
        let d = |s: &str| NaiveDate::parse_from_str(s, "%Y-%m-%d").unwrap();
        assert_eq!(date_chunks(d("2026-11-01"), d("2026-11-01"), 7), vec![(d("2026-11-01"), d("2026-11-01"))]);
        assert_eq!(
            date_chunks(d("2026-11-01"), d("2026-11-10"), 7),
            vec![(d("2026-11-01"), d("2026-11-07")), (d("2026-11-08"), d("2026-11-10"))]
        );
        assert!(date_chunks(d("2026-11-02"), d("2026-11-01"), 7).is_empty());
    }

    #[test]
    fn python_value_forms() {
        assert_eq!(int_of_str(&json!(" 36 ")), Some(36));
        assert_eq!(int_of_str(&json!(36)), Some(36));
        assert_eq!(int_of_str(&json!("x")), None);
        assert_eq!(int_of_str(&json!(1.0)), None); // int("1.0") is a ValueError
        assert_eq!(int_of_str(&Value::Null), None);
        assert_eq!(text_value(&json!(12)), Some("12".into()));
        assert_eq!(text_value(&Value::Null), None);
        assert_eq!(phase_text(None), "None");
    }
}
