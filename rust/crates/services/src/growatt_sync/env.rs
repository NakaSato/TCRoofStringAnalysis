//! Port of `backend/app/services/growatt_sync/env.py`: weather sensors, registration and
//! `env_data` history. Readings are stored as reported (an unfitted probe reads 0; readers turn
//! that into null per day). `lost` / `lastUpdateTime` of `env_list` are realtime: never stored.

use chrono::{DateTime, NaiveDate, NaiveDateTime, Utc};
use serde_json::{json, Map, Value};
use sqlx::PgPool;
use tcroof_clients::growatt::{parse_env_records, py, GrowattClient};

use super::{
    date_chunks, failed_entry, int_of_str, midnight, phase_join, retry, text_value, upsert, SyncOptions, SyncResult, B,
    BATCH,
};

/// One registered weather sensor (`growatt_env_sensors`).
#[derive(Debug, Clone, sqlx::FromRow)]
pub struct EnvSensor {
    pub datalogger_sn: String,
    pub address: i32,
    pub plant_id: i32,
    pub history_synced_until: Option<NaiveDateTime>,
}

/// Python `d.get("type") == 3`
pub(crate) fn is_type(v: &Value, t: i64) -> bool {
    match v {
        Value::Number(n) => n.as_f64() == Some(t as f64),
        Value::Bool(b) => i64::from(*b) == t,
        _ => false,
    }
}

/// The dataloggers of a plant's type-3 devices named `name` ("env" / "meter") in `device/list`
/// (served from the client cache the `list_inverters` call filled), sorted.
pub(crate) async fn type3_dataloggers(client: &GrowattClient, plant_id: i64, name: &str) -> SyncResult<Vec<String>> {
    let devices = client.list_devices(plant_id, false).await?;
    let mut out: Vec<String> = devices
        .iter()
        .filter_map(|d| d.as_object())
        .filter(|d| {
            let sn = py::get(d, "device_sn");
            let sn_text = if py::truthy(sn) { py::str_of(sn) } else { String::new() };
            is_type(py::get(d, "type"), 3) && sn_text.to_lowercase() == name && py::truthy(py::get(d, "datalogger_sn"))
        })
        .map(|d| py::str_of(py::get(d, "datalogger_sn")))
        .collect();
    out.sort();
    out.dedup();
    Ok(out)
}

/// Python `env.sync_env_sensors`: register the plant's weather sensors (type-3 devices named
/// "env"; `env_list` on each datalogger gives the bus addresses). Returns how many were found.
pub async fn sync_env_sensors(
    pool: &PgPool,
    client: &GrowattClient,
    opts: &SyncOptions,
    plant_id: i64,
    now: DateTime<Utc>,
) -> SyncResult<usize> {
    let mut rows = Vec::new();
    for dl in type3_dataloggers(client, plant_id, "env").await? {
        let label = format!("{dl} env_list");
        for e in retry(opts, &label, 3, || client.list_env_sensors(&dl, true)).await? {
            let e = e.as_object().cloned().unwrap_or_default();
            let Some(addr) = int_of_str(py::get(&e, "address")) else { continue };
            rows.push(vec![
                B::Text(Some(dl.clone())),
                B::I32(Some(addr as i32)),
                B::I32(Some(plant_id as i32)),
                B::Text(text_value(py::get(&e, "device_name"))),
                B::Tz(Some(now)),
            ]);
        }
    }
    let n = rows.len();
    let mut conn = pool.acquire().await?;
    upsert(
        &mut conn,
        "growatt_env_sensors",
        &["datalogger_sn", "address", "plant_id", "device_name", "synced_at"],
        &["datalogger_sn", "address"],
        rows,
        BATCH,
    )
    .await?;
    Ok(n)
}

/// Python `env._env_sensors_query`
async fn env_sensors(pool: &PgPool, phase: Option<i32>, include_untagged: bool) -> SyncResult<Vec<EnvSensor>> {
    let sql = format!(
        "SELECT growatt_env_sensors.datalogger_sn, growatt_env_sensors.address, growatt_env_sensors.plant_id, \
         growatt_env_sensors.history_synced_until FROM growatt_env_sensors{} \
         ORDER BY growatt_env_sensors.plant_id, growatt_env_sensors.datalogger_sn, growatt_env_sensors.address",
        phase_join("growatt_env_sensors", phase, include_untagged)
    );
    let mut q = sqlx::query_as::<_, EnvSensor>(&sql);
    if let Some(p) = phase {
        q = q.bind(p);
    }
    Ok(q.fetch_all(pool).await?)
}

/// Python `env.sync_env_history`: fetch and upsert one sensor's history (one transaction).
/// Returns rows written. With `stop_before` only records from that time on are written.
#[allow(clippy::too_many_arguments)]
pub async fn sync_env_history(
    pool: &PgPool,
    client: &GrowattClient,
    opts: &SyncOptions,
    sensor: &EnvSensor,
    start: NaiveDate,
    end: NaiveDate,
    retries: usize,
    stop_before: Option<NaiveDateTime>,
) -> SyncResult<usize> {
    let (dl, addr) = (sensor.datalogger_sn.as_str(), i64::from(sensor.address));
    let mut tx = pool.begin().await?;
    let mut n = 0;
    for (a, b) in date_chunks(start, end, 7) {
        let label = format!("env {dl}/{addr} {a}..{b}");
        let records = retry(opts, &label, retries, || client.env_history(dl, addr, a, b, stop_before)).await?;
        let mut rows = parse_env_records(dl, addr, &records)?;
        if let Some(sb) = stop_before {
            rows.retain(|r| r.timestamp >= sb);
        }
        n += rows.len();
        let binds = rows
            .into_iter()
            .map(|r| {
                vec![
                    B::Text(Some(r.datalogger_sn)),
                    B::I32(Some(r.address as i32)),
                    B::Ts(Some(r.timestamp)),
                    B::F64(r.irradiance_wm2),
                    B::F64(r.ambient_temp_c),
                    B::F64(r.module_temp_c),
                    B::F64(r.humidity_pct),
                    B::F64(r.wind_speed_ms),
                    B::F64(r.wind_dir_deg),
                ]
            })
            .collect();
        upsert(
            &mut tx,
            "growatt_env_readings",
            &[
                "datalogger_sn", "address", "timestamp", "irradiance_wm2", "ambient_temp_c", "module_temp_c",
                "humidity_pct", "wind_speed_ms", "wind_dir_deg",
            ],
            &["datalogger_sn", "address", "timestamp"],
            binds,
            BATCH,
        )
        .await?;
    }
    sqlx::query(
        // the ORM writes only a changed value, and then also `synced_at` (`onupdate=_utcnow`)
        "UPDATE growatt_env_sensors s SET history_synced_until = m.ts, synced_at = now() FROM (SELECT max(timestamp) AS ts \
         FROM growatt_env_readings WHERE datalogger_sn = $1 AND address = $2) m \
         WHERE s.datalogger_sn = $1 AND s.address = $2 AND s.history_synced_until IS DISTINCT FROM m.ts",
    )
    .bind(dl)
    .bind(sensor.address)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(n)
}

/// Python `env._sync_envs`: `{env_sensors, env_rows, env_failed}`; with `max_rate_limited`,
/// that many 10012s in a row (with no success between) end the sweep.
#[allow(clippy::too_many_arguments)]
async fn sync_envs(
    pool: &PgPool,
    client: &GrowattClient,
    opts: &SyncOptions,
    sensors: &[EnvSensor],
    window: impl Fn(&EnvSensor) -> (NaiveDate, NaiveDate, Option<NaiveDateTime>),
    pause_s: f64,
    retries: usize,
    max_rate_limited: Option<usize>,
) -> Value {
    let mut rows = 0usize;
    let mut failed: Vec<Value> = Vec::new();
    let mut limited = 0usize;
    for (idx, s) in sensors.iter().enumerate() {
        let (start, end, stop_before) = window(s);
        match sync_env_history(pool, client, opts, s, start, end, retries, stop_before).await {
            Ok(n) => {
                rows += n;
                limited = 0;
            }
            Err(e) => {
                failed.push(failed_entry(format!("{}/{}", s.datalogger_sn, s.address), e.to_string()));
                tracing::error!("env {}/{} sync failed: {e}", s.datalogger_sn, s.address);
                if let Some(max) = max_rate_limited.filter(|m| *m > 0) {
                    if e.is_rate_limited() {
                        limited += 1;
                        if limited >= max {
                            let left = sensors.len() - idx - 1;
                            failed.push(failed_entry("rate limited", format!("{left} sensors left for the next run")));
                            tracing::warn!("env_data rate limited; {left} sensors wait for the next run");
                            break;
                        }
                    }
                }
            }
        }
        opts.sleep(pause_s).await;
    }
    let mut m = Map::new();
    m.insert("env_sensors".into(), json!(sensors.len()));
    m.insert("env_rows".into(), json!(rows));
    m.insert("env_failed".into(), Value::Array(failed));
    Value::Object(m)
}

/// Python `env.sync_env_all`: weather history of every sensor (of one phase) over a fixed range.
#[allow(clippy::too_many_arguments)]
pub async fn sync_env_all(
    pool: &PgPool,
    client: &GrowattClient,
    opts: &SyncOptions,
    start: NaiveDate,
    end: NaiveDate,
    pause_s: f64,
    phase: Option<i32>,
    include_untagged: bool,
) -> SyncResult<Value> {
    let sensors = env_sensors(pool, phase, include_untagged).await?;
    Ok(sync_envs(pool, client, opts, &sensors, |_| (start, end, None), pause_s, 3, None).await)
}

/// Python `env.sync_env_incremental`: records new since each sensor's `history_synced_until`
/// (same rules as the inverters). Never-synced / stored-longest-ago first, so a sweep cut short by
/// `max_rate_limited` (with `retries = 0`, the `env_history` job) continues where it lagged most.
#[allow(clippy::too_many_arguments)]
pub async fn sync_env_incremental(
    pool: &PgPool,
    client: &GrowattClient,
    opts: &SyncOptions,
    today: NaiveDate,
    overlap: chrono::Duration,
    max_back_days: i64,
    pause_s: f64,
    phase: Option<i32>,
    include_untagged: bool,
    retries: usize,
    max_rate_limited: Option<usize>,
) -> SyncResult<Value> {
    let floor = midnight(today - chrono::Duration::days(max_back_days));
    let window = |s: &EnvSensor| {
        let since = s
            .history_synced_until
            .map(|h| h - overlap)
            .unwrap_or_else(|| midnight(today - chrono::Duration::days(1)))
            .max(floor);
        (since.date(), today, Some(since))
    };
    let mut sensors = env_sensors(pool, phase, include_untagged).await?;
    sensors.sort_by_key(|s| (s.history_synced_until.is_some(), s.history_synced_until));
    Ok(sync_envs(pool, client, opts, &sensors, window, pause_s, retries, max_rate_limited).await)
}
