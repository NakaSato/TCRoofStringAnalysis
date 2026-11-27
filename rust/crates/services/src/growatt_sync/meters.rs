//! Port of `backend/app/services/growatt_sync/meters.py`: energy meters, registration and
//! `meter_data` history (values as reported: `activePower` signed grid power, + import / − export).

use chrono::{DateTime, NaiveDate, NaiveDateTime, Utc};
use serde_json::{json, Map, Value};
use sqlx::PgPool;
use tcroof_clients::growatt::{parse_meter_records, py, GrowattClient};

use super::env::type3_dataloggers;
use super::{
    date_chunks, failed_entry, int_of_str, midnight, phase_join, retry, text_value, upsert, SyncOptions, SyncResult, B,
    BATCH, MAX_RATE_LIMITED,
};

/// One registered energy meter (`growatt_meters`).
#[derive(Debug, Clone, sqlx::FromRow)]
pub struct Meter {
    pub datalogger_sn: String,
    pub address: i32,
    pub plant_id: i32,
    pub history_synced_until: Option<NaiveDateTime>,
}

/// Python `meters.sync_meters`: register the plant's energy meters (type-3 devices named "meter";
/// `meter_list` gives each bus address). A bus address named twice keeps its first entry.
pub async fn sync_meters(
    pool: &PgPool,
    client: &GrowattClient,
    opts: &SyncOptions,
    plant_id: i64,
    now: DateTime<Utc>,
) -> SyncResult<usize> {
    let mut keys: Vec<(String, i64)> = Vec::new();
    let mut rows: Vec<Vec<B>> = Vec::new();
    let mut names: Vec<Option<String>> = Vec::new();
    for dl in type3_dataloggers(client, plant_id, "meter").await? {
        let label = format!("{dl} meter_list");
        for m in retry(opts, &label, 3, || client.list_meters(&dl, true)).await? {
            let m = m.as_object().cloned().unwrap_or_default();
            let Some(addr) = int_of_str(py::get(&m, "address")) else { continue };
            if let Some(i) = keys.iter().position(|k| *k == (dl.clone(), addr)) {
                tracing::warn!(
                    "plant {plant_id}: meter_list names {dl} address {addr} twice ({:?} / {}); keeping the first",
                    names[i],
                    py::str_of(py::get(&m, "device_name"))
                );
                continue;
            }
            let dtype = py::get(&m, "device_type");
            let device_type = match dtype {
                Value::Null => None,
                Value::String(s) if s.is_empty() => None,
                other => Some(py::str_of(other)),
            };
            keys.push((dl.clone(), addr));
            names.push(text_value(py::get(&m, "device_name")));
            rows.push(vec![
                B::Text(Some(dl.clone())),
                B::I32(Some(addr as i32)),
                B::I32(Some(plant_id as i32)),
                B::Text(text_value(py::get(&m, "device_name"))),
                B::Text(device_type),
                B::Tz(Some(now)),
            ]);
        }
    }
    let n = rows.len();
    let mut conn = pool.acquire().await?;
    upsert(
        &mut conn,
        "growatt_meters",
        &["datalogger_sn", "address", "plant_id", "device_name", "device_type", "synced_at"],
        &["datalogger_sn", "address"],
        rows,
        BATCH,
    )
    .await?;
    Ok(n)
}

/// Python `meters._meters_query`
async fn meters(pool: &PgPool, phase: Option<i32>, include_untagged: bool) -> SyncResult<Vec<Meter>> {
    let sql = format!(
        "SELECT growatt_meters.datalogger_sn, growatt_meters.address, growatt_meters.plant_id, \
         growatt_meters.history_synced_until FROM growatt_meters{} \
         ORDER BY growatt_meters.plant_id, growatt_meters.datalogger_sn, growatt_meters.address",
        phase_join("growatt_meters", phase, include_untagged)
    );
    let mut q = sqlx::query_as::<_, Meter>(&sql);
    if let Some(p) = phase {
        q = q.bind(p);
    }
    Ok(q.fetch_all(pool).await?)
}

/// Python `meters.sync_meter_history`: fetch and upsert one meter's history (one transaction).
#[allow(clippy::too_many_arguments)]
pub async fn sync_meter_history(
    pool: &PgPool,
    client: &GrowattClient,
    opts: &SyncOptions,
    meter: &Meter,
    start: NaiveDate,
    end: NaiveDate,
    retries: usize,
    stop_before: Option<NaiveDateTime>,
) -> SyncResult<usize> {
    let (dl, addr) = (meter.datalogger_sn.as_str(), i64::from(meter.address));
    let mut tx = pool.begin().await?;
    let mut n = 0;
    for (a, b) in date_chunks(start, end, 7) {
        let label = format!("meter {dl}/{addr} {a}..{b}");
        let records = retry(opts, &label, retries, || client.meter_history(dl, addr, a, b, stop_before)).await?;
        let mut rows = parse_meter_records(dl, addr, &records)?;
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
                    B::F64(r.active_power_w),
                    B::F64(r.active_power_l1_w),
                    B::F64(r.active_power_l2_w),
                    B::F64(r.active_power_l3_w),
                    B::F64(r.reactive_power_var),
                    B::F64(r.power_factor),
                    B::F64(r.frequency_hz),
                    B::F64(r.import_counter_kwh),
                    B::F64(r.forward_today_kwh),
                    B::F64(r.rever_active_power_raw),
                    B::F64(r.reverse_today_kwh),
                ]
            })
            .collect();
        upsert(
            &mut tx,
            "growatt_meter_readings",
            &[
                "datalogger_sn", "address", "timestamp", "active_power_w", "active_power_l1_w", "active_power_l2_w",
                "active_power_l3_w", "reactive_power_var", "power_factor", "frequency_hz", "import_counter_kwh",
                "forward_today_kwh", "rever_active_power_raw", "reverse_today_kwh",
            ],
            &["datalogger_sn", "address", "timestamp"],
            binds,
            BATCH,
        )
        .await?;
    }
    sqlx::query(
        // the ORM writes only a changed value, and then also `synced_at` (`onupdate=_utcnow`)
        "UPDATE growatt_meters s SET history_synced_until = m.ts, synced_at = now() FROM (SELECT max(timestamp) AS ts \
         FROM growatt_meter_readings WHERE datalogger_sn = $1 AND address = $2) m \
         WHERE s.datalogger_sn = $1 AND s.address = $2 AND s.history_synced_until IS DISTINCT FROM m.ts",
    )
    .bind(dl)
    .bind(meter.address)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(n)
}

/// Python `meters._sync_meter_list`: `{meters, meter_rows, meter_failed}`; [`MAX_RATE_LIMITED`]
/// 10012s in a row end the sweep, so meters never starve the account's inverter history.
async fn sync_meter_list(
    pool: &PgPool,
    client: &GrowattClient,
    opts: &SyncOptions,
    list: &[Meter],
    window: impl Fn(&Meter) -> (NaiveDate, NaiveDate, Option<NaiveDateTime>),
    pause_s: f64,
) -> Value {
    let mut rows = 0usize;
    let mut failed: Vec<Value> = Vec::new();
    let mut limited = 0usize;
    for (idx, m) in list.iter().enumerate() {
        let (start, end, stop_before) = window(m);
        match sync_meter_history(pool, client, opts, m, start, end, 3, stop_before).await {
            Ok(n) => {
                rows += n;
                limited = 0;
            }
            Err(e) => {
                failed.push(failed_entry(format!("{}/{}", m.datalogger_sn, m.address), e.to_string()));
                tracing::error!("meter {}/{} sync failed: {e}", m.datalogger_sn, m.address);
                if e.is_rate_limited() {
                    limited += 1;
                    if limited >= MAX_RATE_LIMITED {
                        let left = list.len() - idx - 1;
                        failed.push(failed_entry("rate limited", format!("{left} meters left for the next run")));
                        tracing::warn!("meter_data rate limited; {left} meters wait for the next run");
                        break;
                    }
                }
            }
        }
        opts.sleep(pause_s).await;
    }
    let mut out = Map::new();
    out.insert("meters".into(), json!(list.len()));
    out.insert("meter_rows".into(), json!(rows));
    out.insert("meter_failed".into(), Value::Array(failed));
    Value::Object(out)
}

/// Python `meters.sync_meter_all`: every meter (of one phase) over a fixed range; `{}` when
/// `METER_HISTORY_ENABLED` is off.
#[allow(clippy::too_many_arguments)]
pub async fn sync_meter_all(
    pool: &PgPool,
    client: &GrowattClient,
    opts: &SyncOptions,
    start: NaiveDate,
    end: NaiveDate,
    pause_s: f64,
    phase: Option<i32>,
    include_untagged: bool,
) -> SyncResult<Value> {
    if !opts.meter_history_enabled {
        return Ok(json!({}));
    }
    let list = meters(pool, phase, include_untagged).await?;
    Ok(sync_meter_list(pool, client, opts, &list, |_| (start, end, None), pause_s).await)
}

/// Python `meters.sync_meter_incremental`: records new since each meter's
/// `history_synced_until` (same rules as the sensors); `{}` when `METER_HISTORY_ENABLED` is off.
#[allow(clippy::too_many_arguments)]
pub async fn sync_meter_incremental(
    pool: &PgPool,
    client: &GrowattClient,
    opts: &SyncOptions,
    today: NaiveDate,
    overlap: chrono::Duration,
    max_back_days: i64,
    pause_s: f64,
    phase: Option<i32>,
    include_untagged: bool,
) -> SyncResult<Value> {
    if !opts.meter_history_enabled {
        return Ok(json!({}));
    }
    let floor = midnight(today - chrono::Duration::days(max_back_days));
    let window = |m: &Meter| {
        let since = m
            .history_synced_until
            .map(|h| h - overlap)
            .unwrap_or_else(|| midnight(today - chrono::Duration::days(1)))
            .max(floor);
        (since.date(), today, Some(since))
    };
    let mut list = meters(pool, phase, include_untagged).await?;
    list.sort_by_key(|m| (m.history_synced_until.is_some(), m.history_synced_until));
    Ok(sync_meter_list(pool, client, opts, &list, window, pause_s).await)
}
