//! The deletes of the worker's `retention` job (backend/app/services/jobs.py `job_retention`), each
//! ported from the Python function named on it: readings, whole records, Google hours, alarm logs,
//! frozen PWA check slots, Growatt's plant curve, push marks, app logs and finished job runs older
//! than their retention. DB only; every delete is its own short transaction, as in Python.
//!
//! Reading tables hold naive plant-local times; `app_logs.ts` and `sync_runs.started_at` are UTC.

use chrono::{DateTime, Duration, NaiveDate, NaiveDateTime, Utc};
use serde_json::{json, Map, Value};
use sqlx::PgPool;

/// A failure of a prune: Python raises `ValueError` for a bad retention, else a database error.
#[derive(Debug, thiserror::Error)]
pub enum RetentionError {
    /// Python `ValueError` (the message as Python words it)
    #[error("{0}")]
    Value(String),
    #[error(transparent)]
    Db(#[from] sqlx::Error),
}

impl RetentionError {
    /// The Python exception class name, for the run's `error` text (`"ValueError: …"`).
    pub fn kind(&self) -> &'static str {
        match self {
            RetentionError::Value(_) => "ValueError",
            RetentionError::Db(_) => "DatabaseError",
        }
    }
}

pub type Result<T> = std::result::Result<T, RetentionError>;

/// Python `system_logs.PRUNE_BATCH`
pub const PRUNE_BATCH: i64 = 5_000;
/// Python `om_reminders.KEEP_MARKS_DAYS`
pub const KEEP_MARKS_DAYS: i64 = 14;

fn midnight(day: NaiveDate) -> NaiveDateTime {
    day.and_hms_opt(0, 0, 0).expect("midnight exists")
}

/// Python `datetime.isoformat()` of a naive whole-second time (`2026-08-29T00:00:00`)
fn iso(t: NaiveDateTime) -> String {
    t.format("%Y-%m-%dT%H:%M:%S").to_string()
}

async fn delete_count(pool: &PgPool, sql: &str, binds: Binds<'_>) -> Result<i64> {
    let mut q = sqlx::query(sql);
    q = match binds {
        Binds::Ts(a) => q.bind(a),
        Binds::TsRange(a, b) => q.bind(a).bind(b),
        Binds::Day(d) => q.bind(d),
        Binds::SnTs(sn, t) => q.bind(sn).bind(t),
        Binds::Utc(t) => q.bind(t),
    };
    Ok(q.execute(pool).await?.rows_affected() as i64)
}

enum Binds<'a> {
    Ts(NaiveDateTime),
    TsRange(NaiveDateTime, NaiveDateTime),
    Day(NaiveDate),
    SnTs(&'a str, NaiveDateTime),
    Utc(DateTime<Utc>),
}

/// Python `growatt_sync.retention.prune_raw`: whole-record copies (`growatt_inverter_raw`) older
/// than `keep_days` before `today`, one day per transaction, oldest first. Rows deleted.
pub async fn prune_raw(pool: &PgPool, today: NaiveDate, keep_days: i64) -> Result<i64> {
    if keep_days < 1 {
        return Err(RetentionError::Value("keep_days must be >= 1".into()));
    }
    let cutoff = midnight(today - Duration::days(keep_days));
    let oldest: Option<NaiveDateTime> = sqlx::query_scalar("SELECT min(timestamp) FROM growatt_inverter_raw").fetch_one(pool).await?;
    let Some(oldest) = oldest else { return Ok(0) };
    let mut n = 0;
    let mut day = midnight(oldest.date());
    while day < cutoff {
        let end = (day + Duration::days(1)).min(cutoff);
        n += delete_count(
            pool,
            "DELETE FROM growatt_inverter_raw WHERE timestamp >= $1 AND timestamp < $2",
            Binds::TsRange(day, end),
        )
        .await?;
        day = end;
    }
    Ok(n)
}

/// Python `growatt_sync.retention.prune_history`: inverter / weather / meter readings older than
/// `keep_days` before `today` (one day per transaction, oldest first) and per-string records older
/// than `string_keep_days` (at most `keep_days`; one inverter per transaction). The totals dict.
pub async fn prune_history(pool: &PgPool, today: NaiveDate, keep_days: i64, string_keep_days: Option<i64>) -> Result<Map<String, Value>> {
    if keep_days < 1 {
        return Err(RetentionError::Value("keep_days must be >= 1".into()));
    }
    let cutoff = midnight(today - Duration::days(keep_days));
    let str_days = string_keep_days.map_or(keep_days, |s| s.min(keep_days));
    if str_days < 1 {
        return Err(RetentionError::Value("string_keep_days must be >= 1".into()));
    }
    let str_cutoff = midnight(today - Duration::days(str_days));
    let mut starts: Vec<NaiveDateTime> = Vec::new();
    for t in ["growatt_inverter_readings", "growatt_env_readings", "growatt_meter_readings"] {
        let m: Option<NaiveDateTime> = sqlx::query_scalar(&format!("SELECT min(timestamp) FROM {t}")).fetch_one(pool).await?;
        starts.extend(m);
    }
    let (mut inv, mut strings, mut env, mut meter, mut days) = (0i64, 0i64, 0i64, 0i64, 0i64);
    // string records: one inverter per transaction, through the primary key (device_sn, timestamp)
    let sns: Vec<String> = sqlx::query_scalar("SELECT device_sn FROM growatt_inverters").fetch_all(pool).await?;
    for sn in &sns {
        strings += delete_count(
            pool,
            "DELETE FROM growatt_string_records WHERE device_sn = $1 AND timestamp < $2",
            Binds::SnTs(sn, str_cutoff),
        )
        .await?;
    }
    if let Some(first) = starts.iter().min() {
        let mut day = midnight(first.date());
        while day < cutoff {
            let end = (day + Duration::days(1)).min(cutoff);
            // one transaction per day, as Python's one commit per day
            let mut tx = pool.begin().await?;
            for (table, n) in [("growatt_inverter_readings", &mut inv), ("growatt_env_readings", &mut env), ("growatt_meter_readings", &mut meter)] {
                *n += sqlx::query(&format!("DELETE FROM {table} WHERE timestamp >= $1 AND timestamp < $2"))
                    .bind(day)
                    .bind(end)
                    .execute(&mut *tx)
                    .await?
                    .rows_affected() as i64;
            }
            tx.commit().await?;
            days += 1;
            day = end;
        }
    }
    tracing::info!(
        target: "growatt_sync",
        "retention: deleted {inv} inverter / {env} weather / {meter} meter rows before {}, {strings} string records before {}",
        cutoff.format("%Y-%m-%d %H:%M:%S"),
        str_cutoff.format("%Y-%m-%d %H:%M:%S"),
    );
    let mut out = Map::new();
    out.insert("cutoff".into(), json!(iso(cutoff)));
    out.insert("string_cutoff".into(), json!(iso(str_cutoff)));
    out.insert("inverter_rows".into(), json!(inv));
    out.insert("string_records".into(), json!(strings));
    out.insert("env_rows".into(), json!(env));
    out.insert("meter_rows".into(), json!(meter));
    out.insert("days".into(), json!(days));
    Ok(out)
}

/// Python `google_weather.prune`: stored Google hours older than `keep_days` before `today`.
pub async fn prune_google_weather(pool: &PgPool, today: NaiveDate, keep_days: i64) -> Result<i64> {
    let cutoff = midnight(today - Duration::days(keep_days));
    delete_count(pool, "DELETE FROM google_weather_hourly WHERE hour < $1", Binds::Ts(cutoff)).await
}

/// Python `growatt_alarms.prune_alarms`: alarm rows and sync stamps older than `keep_days`
/// before `today` (one transaction). Returns the alarm rows deleted.
pub async fn prune_alarms(pool: &PgPool, today: NaiveDate, keep_days: i64) -> Result<i64> {
    let cutoff = today - Duration::days(keep_days);
    let mut tx = pool.begin().await?;
    let n = sqlx::query("DELETE FROM growatt_alarms WHERE day < $1").bind(cutoff).execute(&mut *tx).await?.rows_affected() as i64;
    sqlx::query("DELETE FROM growatt_alarm_syncs WHERE day < $1").bind(cutoff).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(n)
}

/// Python `check_slots.prune`: frozen PWA check slots older than `keep_days` before `today`.
pub async fn prune_check_slots(pool: &PgPool, today: NaiveDate, keep_days: i64) -> Result<i64> {
    delete_count(pool, "DELETE FROM pwa_check_slots WHERE day < $1", Binds::Day(today - Duration::days(keep_days))).await
}

/// Python `growatt_energy.prune_plant_power`: Growatt plant-curve points older than `keep_days`.
pub async fn prune_plant_power(pool: &PgPool, today: NaiveDate, keep_days: i64) -> Result<i64> {
    let cutoff = midnight(today - Duration::days(keep_days));
    delete_count(pool, "DELETE FROM growatt_plant_power WHERE timestamp < $1", Binds::Ts(cutoff)).await
}

/// Python `push.prune`: alarm push marks of past days (a mark only matters on its own day).
pub async fn prune_push_marks(pool: &PgPool, today: NaiveDate) -> Result<i64> {
    delete_count(pool, "DELETE FROM alarm_push_marks WHERE day < $1", Binds::Day(today)).await
}

/// Python `om_reminders.prune`: Calendar Team push marks older than `KEEP_MARKS_DAYS`.
pub async fn prune_om_push_marks(pool: &PgPool, today: NaiveDate) -> Result<i64> {
    delete_count(pool, "DELETE FROM om_push_marks WHERE day < $1", Binds::Day(today - Duration::days(KEEP_MARKS_DAYS))).await
}

async fn delete_ids(pool: &PgPool, ids: &[i32]) -> Result<()> {
    sqlx::query("DELETE FROM app_logs WHERE id = ANY($1)").bind(ids).execute(pool).await?;
    Ok(())
}

/// Python `system_logs.prune_logs`: `app_logs` rows older than `retention_days`, then the oldest
/// beyond `max_rows`, in batches of `PRUNE_BATCH` ids. Rows deleted.
pub async fn prune_logs(pool: &PgPool, now: DateTime<Utc>, retention_days: i64, max_rows: i64) -> Result<i64> {
    let mut deleted = 0i64;
    let cutoff = now - Duration::days(retention_days);
    loop {
        let ids: Vec<i32> = sqlx::query_scalar("SELECT id FROM app_logs WHERE ts < $1 ORDER BY id LIMIT $2")
            .bind(cutoff)
            .bind(PRUNE_BATCH)
            .fetch_all(pool)
            .await?;
        if ids.is_empty() {
            break;
        }
        delete_ids(pool, &ids).await?;
        deleted += ids.len() as i64;
    }
    let total: i64 = sqlx::query_scalar("SELECT count(*) FROM app_logs").fetch_one(pool).await?;
    if total > max_rows {
        // ids grow with time: everything below the (max_rows)-th newest id goes
        let floor: Option<i32> = if max_rows > 0 {
            sqlx::query_scalar("SELECT id FROM app_logs ORDER BY id DESC OFFSET $1 LIMIT 1")
                .bind(max_rows - 1)
                .fetch_optional(pool)
                .await?
        } else {
            None
        };
        loop {
            let ids: Vec<i32> = match floor {
                Some(f) => sqlx::query_scalar("SELECT id FROM app_logs WHERE id < $1 ORDER BY id LIMIT $2").bind(f).bind(PRUNE_BATCH),
                None => sqlx::query_scalar("SELECT id FROM app_logs ORDER BY id LIMIT $1").bind(PRUNE_BATCH),
            }
            .fetch_all(pool)
            .await?;
            if ids.is_empty() {
                break;
            }
            delete_ids(pool, &ids).await?;
            deleted += ids.len() as i64;
        }
    }
    Ok(deleted)
}

/// Python `jobs.prune_runs`: finished job runs started more than `keep_days` ago, keeping each
/// job's newest run (the status page and the job locks read it).
pub async fn prune_runs(pool: &PgPool, now: DateTime<Utc>, keep_days: i64) -> Result<i64> {
    let cutoff = now - Duration::days(keep_days);
    delete_count(
        pool,
        "DELETE FROM sync_runs WHERE started_at < $1 AND status NOT IN ('running', 'queued') \
         AND id NOT IN (SELECT max(id) FROM sync_runs GROUP BY job)",
        Binds::Utc(cutoff),
    )
    .await
}
