//! Port of `backend/app/services/growatt_sync/inverters.py`: inverter and string history
//! (`max_data` records), today's batch / fallback reads, the newest record between runs
//! (`maxs_data`), and the whole records kept as reported (`HISTORY_STORE_RAW`).
//!
//! Known Python behaviour kept for parity: `parse_max_records` stores a missing `ppv`, MPPT value
//! or string V / I as 0 (solar_core/growatt/parsers.py; the master plan lists it as a Python
//! bug: a missing measurement should be NULL). Rust writes what Python writes until Python is
//! fixed, so the two stay comparable.

use std::collections::{BTreeMap, HashMap, HashSet};

use chrono::{NaiveDate, NaiveDateTime, Timelike};
use serde_json::{json, Map, Value};
use sqlx::{PgConnection, PgPool};
use tcroof_clients::growatt::{parse_max_raw, parse_max_records, GrowattClient, InverterRow, Record, StringRow};

use super::{
    date_chunks, failed_entry, inverters_query, midnight, retry, upsert, SyncError, SyncInverter, SyncOptions,
    SyncResult, B, BATCH,
};
use crate::common::INACTIVE_MAX_A;

/// Python `inverters.STANDBY_DAY_START_H` / `_END_H`: outside these plant-local hours a status-0
/// record without AC power or a code is night standby (not stored)
pub const STANDBY_DAY_START_H: u32 = 5;
pub const STANDBY_DAY_END_H: u32 = 19;
/// Python `inverters.BATCH_MAX_ERRORS`: refused batch calls in a row end batching for the run
pub const BATCH_MAX_ERRORS: usize = 2;
/// Python `inverters.LATEST_CHUNK` (`GrowattClient.MAXS_PAGE`): serials per `maxs_data` call
pub const LATEST_CHUNK: usize = tcroof_clients::growatt::MAXS_PAGE;
/// Python `inverters._RAW_BATCH`: raw rows per statement (about 4 kB each)
pub const RAW_BATCH: usize = 200;
/// Python `growatt_daily.WIRED_LOOKBACK_DAYS`
pub const WIRED_LOOKBACK_DAYS: i64 = 30;
/// Python `growatt_daily.WIRED_MIN_KWH`
pub const WIRED_MIN_KWH: f64 = 0.05;
/// `parse_max_records` defaults (32 strings, 16 MPPTs)
const MAX_STRINGS: u32 = 32;
const MAX_MPPTS: u32 = 16;
/// Python's default `overlap` of the incremental reads (30 min)
pub fn default_overlap() -> chrono::Duration {
    chrono::Duration::minutes(30)
}

// --------------------------------------------------------------------------- row helpers

/// `status` as the Integer column stores it (psycopg sends the value; Postgres casts).
fn status_int(v: &Value) -> Option<i32> {
    match v {
        Value::Bool(b) => Some(i32::from(*b)),
        Value::Number(n) => n.as_i64().map(|i| i as i32).or_else(|| n.as_f64().map(|f| f.round_ties_even() as i32)),
        Value::String(s) => s.trim().parse().ok(),
        _ => None,
    }
}

/// Python `r.get("status") in (0, "0")`
fn status_is_zero(v: &Value) -> bool {
    match v {
        Value::Bool(b) => !*b,
        Value::Number(n) => n.as_f64() == Some(0.0),
        Value::String(s) => s == "0",
        _ => false,
    }
}

/// Python `inverters._night_standby`
fn night_standby(r: &InverterRow) -> bool {
    let h = r.timestamp.hour();
    !(STANDBY_DAY_START_H..STANDBY_DAY_END_H).contains(&h)
        && status_is_zero(&r.status)
        && r.pac_w.unwrap_or(0.0) == 0.0
        && r.fault_code.unwrap_or(0) == 0
        && r.warn_code.unwrap_or(0) == 0
}

/// Python `inverters._kept`: night standby records left out, with their string rows.
fn kept(inv_rows: Vec<InverterRow>, str_rows: Vec<StringRow>) -> (Vec<InverterRow>, Vec<StringRow>) {
    let dropped: HashSet<(String, NaiveDateTime)> =
        inv_rows.iter().filter(|r| night_standby(r)).map(|r| (r.device_sn.clone(), r.timestamp)).collect();
    if dropped.is_empty() {
        return (inv_rows, str_rows);
    }
    (
        inv_rows.into_iter().filter(|r| !dropped.contains(&(r.device_sn.clone(), r.timestamp))).collect(),
        str_rows.into_iter().filter(|r| !dropped.contains(&(r.device_sn.clone(), r.timestamp))).collect(),
    )
}

/// The `growatt_inverter_readings` upsert (`_upsert(db, GrowattInverterReading, inv_rows)`);
/// `mppt_json` in the compact `[[n, v, i, p], …]` form (`CompactMppt`, `_compact_json`).
async fn upsert_inverter_rows(conn: &mut PgConnection, rows: &[InverterRow]) -> SyncResult<()> {
    const COLS: [&str; 12] = [
        "device_sn", "timestamp", "status", "pac_w", "ppv_w", "eac_today_kwh", "eac_total_kwh", "temperature_c",
        "fac_hz", "mppt_json", "fault_code", "warn_code",
    ];
    let binds = rows
        .iter()
        .map(|r| {
            let mppt: Vec<Value> = r.mppt_json.iter().map(|m| json!([m.mppt, m.v, m.i, m.p])).collect();
            vec![
                B::Text(Some(r.device_sn.clone())),
                B::Ts(Some(r.timestamp)),
                B::I32(status_int(&r.status)),
                B::F64(r.pac_w),
                B::F64(Some(r.ppv_w)),
                B::F64(r.eac_today_kwh),
                B::F64(r.eac_total_kwh),
                B::F64(r.temperature_c),
                B::F64(r.fac_hz),
                B::Json(Value::Array(mppt).to_string()),
                B::I32(r.fault_code.map(|c| c as i32)),
                B::I32(r.warn_code.map(|c| c as i32)),
            ]
        })
        .collect();
    upsert(conn, "growatt_inverter_readings", &COLS, &["device_sn", "timestamp"], binds, BATCH).await
}

/// Python `inverters.store_string_rows`: per-string rows into `growatt_string_records`, one row
/// per inverter record (`strings` = `[[string_no, mppt_no, voltage_v, current_a], …]`, by
/// string number). Strings already stored for a record and not in `rows` are kept. Returns the
/// number of string rows written.
pub async fn store_string_rows(conn: &mut PgConnection, rows: &[StringRow]) -> SyncResult<usize> {
    if rows.is_empty() {
        return Ok(0);
    }
    // (sn, ts) -> string_no -> entry, in first-seen order of the records
    let mut order: Vec<(String, NaiveDateTime)> = Vec::new();
    let mut by: HashMap<(String, NaiveDateTime), BTreeMap<i64, Value>> = HashMap::new();
    for r in rows {
        let k = (r.device_sn.clone(), r.timestamp);
        let e = by.entry(k.clone()).or_insert_with(|| {
            order.push(k);
            BTreeMap::new()
        });
        let n = i64::from(r.string_no);
        e.insert(n, json!([n, r.mppt_no, r.voltage_v, r.current_a]));
    }
    let mut per_sn: Vec<(String, Vec<NaiveDateTime>)> = Vec::new();
    for (sn, ts) in &order {
        match per_sn.iter_mut().find(|(s, _)| s == sn) {
            Some((_, v)) => v.push(*ts),
            None => per_sn.push((sn.clone(), vec![*ts])),
        }
    }
    for (sn, times) in &per_sn {
        for part in times.chunks(500) {
            let old: Vec<(NaiveDateTime, String)> = sqlx::query_as(
                "SELECT timestamp, strings::text FROM growatt_string_records WHERE device_sn = $1 AND timestamp = ANY($2)",
            )
            .bind(sn)
            .bind(part)
            .fetch_all(&mut *conn)
            .await?;
            for (ts, strings) in old {
                let Some(new) = by.get_mut(&(sn.clone(), ts)) else { continue };
                let parsed: Value = serde_json::from_str(&strings).unwrap_or(Value::Null);
                for o in parsed.as_array().cloned().unwrap_or_default() {
                    let Some(n) = o.get(0).and_then(|x| x.as_i64().or_else(|| x.as_f64().map(|f| f as i64))) else { continue };
                    new.entry(n).or_insert(o);
                }
            }
        }
    }
    let binds = order
        .iter()
        .map(|k| {
            let strings: Vec<Value> = by[k].values().cloned().collect();
            vec![B::Text(Some(k.0.clone())), B::Ts(Some(k.1)), B::Json(Value::Array(strings).to_string())]
        })
        .collect();
    upsert(conn, "growatt_string_records", &["device_sn", "timestamp", "strings"], &["device_sn", "timestamp"], binds, BATCH)
        .await?;
    Ok(rows.len())
}

/// Python `inverters._wired_only`: drop the string rows of inputs that are not wired (wired = a
/// String Layout row, a daily row of at least `WIRED_MIN_KWH` in the last `WIRED_LOOKBACK_DAYS`,
/// or current above `INACTIVE_MAX_A` today, stored or in `rows`). A row with any current is kept.
async fn wired_only(conn: &mut PgConnection, rows: Vec<StringRow>) -> SyncResult<Vec<StringRow>> {
    if rows.is_empty() {
        return Ok(rows);
    }
    let mut newest: Vec<(String, NaiveDateTime)> = Vec::new();
    let mut known: HashMap<String, HashSet<i64>> = HashMap::new();
    for r in &rows {
        match newest.iter_mut().find(|(s, _)| *s == r.device_sn) {
            Some((_, t)) if r.timestamp > *t => *t = r.timestamp,
            Some(_) => {}
            None => newest.push((r.device_sn.clone(), r.timestamp)),
        }
        if r.current_a > INACTIVE_MAX_A {
            known.entry(r.device_sn.clone()).or_default().insert(i64::from(r.string_no));
        }
    }
    for (sn, ts) in &newest {
        let day = ts.date();
        let day0 = midnight(day);
        let mut k: HashSet<i64> = known.remove(sn).unwrap_or_default();
        let layout: Vec<i32> = sqlx::query_scalar("SELECT string_no FROM growatt_string_layouts WHERE device_sn = $1")
            .bind(sn)
            .fetch_all(&mut *conn)
            .await?;
        k.extend(layout.into_iter().map(i64::from));
        let daily: Vec<i32> = sqlx::query_scalar(
            "SELECT DISTINCT string_no FROM growatt_string_daily WHERE device_sn = $1 AND day >= $2 AND day < $3 \
             AND energy_kwh >= $4",
        )
        .bind(sn)
        .bind(day - chrono::Duration::days(WIRED_LOOKBACK_DAYS))
        .bind(day)
        .bind(WIRED_MIN_KWH)
        .fetch_all(&mut *conn)
        .await?;
        k.extend(daily.into_iter().map(i64::from));
        let today: Vec<i32> = sqlx::query_scalar(
            "SELECT DISTINCT string_no FROM growatt_string_readings WHERE device_sn = $1 AND timestamp >= $2 AND current_a > $3",
        )
        .bind(sn)
        .bind(day0)
        .bind(INACTIVE_MAX_A)
        .fetch_all(&mut *conn)
        .await?;
        k.extend(today.into_iter().map(i64::from));
        known.insert(sn.clone(), k);
    }
    Ok(rows
        .into_iter()
        .filter(|r| r.current_a > 0.0 || known.get(&r.device_sn).is_some_and(|k| k.contains(&i64::from(r.string_no))))
        .collect())
}

/// Python `inverters._store_raw`: the whole `max_data` records (`growatt_inverter_raw`) when
/// `HISTORY_STORE_RAW` is on; `since` = only records from that time on. The caller commits.
/// (Key order of `data` is alphabetical here, Python keeps Growatt's; the same JSON object.)
async fn store_raw(
    conn: &mut PgConnection,
    opts: &SyncOptions,
    device_sn: &str,
    records: &[Value],
    since: Option<NaiveDateTime>,
) -> SyncResult<usize> {
    if !opts.history_store_raw {
        return Ok(0);
    }
    let mut rows = parse_max_raw(device_sn, records)?;
    if let Some(s) = since {
        rows.retain(|r| r.timestamp >= s);
    }
    let n = rows.len();
    let binds = rows
        .into_iter()
        .map(|r| vec![B::Text(Some(r.device_sn)), B::Ts(Some(r.timestamp)), B::Json(Value::Object(r.data).to_string())])
        .collect();
    upsert(conn, "growatt_inverter_raw", &["device_sn", "timestamp", "data"], &["device_sn", "timestamp"], binds, RAW_BATCH)
        .await?;
    Ok(n)
}

/// `parse_max_records(device_sn, records)` with Python's defaults.
fn parse(device_sn: &str, records: &[Value]) -> SyncResult<(Vec<InverterRow>, Vec<StringRow>)> {
    Ok(parse_max_records(device_sn, records, MAX_STRINGS, MAX_MPPTS)?)
}

// --------------------------------------------------------------------------- history

/// Python `inverters.sync_inverter_history`: fetch and upsert MAX history for one inverter (one
/// transaction; a failure writes nothing). Returns (inverter rows, string rows). With
/// `stop_before` only records from that time on are written. `history_synced_until` becomes the
/// newest record read, stored or not (night standby is not read again on every run).
#[allow(clippy::too_many_arguments)]
pub async fn sync_inverter_history(
    pool: &PgPool,
    client: &GrowattClient,
    opts: &SyncOptions,
    inverter: &SyncInverter,
    start: NaiveDate,
    end: NaiveDate,
    retries: usize,
    stop_before: Option<NaiveDateTime>,
) -> SyncResult<(usize, usize)> {
    let sn = inverter.device_sn.as_str();
    let mut tx = pool.begin().await?;
    let (mut n_inv, mut n_str) = (0usize, 0usize);
    let mut seen: Option<NaiveDateTime> = None;
    for (a, b) in date_chunks(start, end, 7) {
        let label = format!("{sn} {a}..{b}");
        let records = retry(opts, &label, retries, || client.max_history(sn, a, b, stop_before)).await?;
        let (mut inv_rows, mut str_rows) = parse(sn, &records)?;
        if let Some(newest) = inv_rows.iter().map(|r| r.timestamp).max() {
            seen = Some(seen.map_or(newest, |s| s.max(newest)));
        }
        if let Some(sb) = stop_before {
            inv_rows.retain(|r| r.timestamp >= sb);
            str_rows.retain(|r| r.timestamp >= sb);
        }
        let str_rows = wired_only(&mut tx, str_rows).await?;
        let (inv_rows, str_rows) = kept(inv_rows, str_rows);
        upsert_inverter_rows(&mut tx, &inv_rows).await?;
        store_string_rows(&mut tx, &str_rows).await?;
        store_raw(&mut tx, opts, sn, &records, stop_before).await?;
        n_inv += inv_rows.len();
        n_str += str_rows.len();
    }
    // primary-key order, so Postgres does not walk ix_growatt_inv_ts for an idle inverter
    let latest: Option<NaiveDateTime> = sqlx::query_scalar(
        "SELECT timestamp FROM growatt_inverter_readings WHERE device_sn = $1 ORDER BY device_sn DESC, timestamp DESC LIMIT 1",
    )
    .bind(sn)
    .fetch_optional(&mut *tx)
    .await?;
    let mark = [latest, seen, inverter.history_synced_until].into_iter().flatten().max();
    sqlx::query("UPDATE growatt_inverters SET history_synced_until = $1, synced_at = now() WHERE device_sn = $2 \
         AND history_synced_until IS DISTINCT FROM $1")
        .bind(mark)
        .bind(sn)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok((n_inv, n_str))
}

fn add(totals: &mut Map<String, Value>, key: &str, n: usize) {
    let cur = totals.get(key).and_then(Value::as_u64).unwrap_or(0);
    totals.insert(key.into(), json!(cur + n as u64));
}

fn push_failed(totals: &mut Map<String, Value>, entry: Value) {
    if let Some(Value::Array(a)) = totals.get_mut("failed") {
        a.push(entry);
    }
}

/// Python `inverters.sync_all_history`: MAX history of every inverter (of one phase, or the
/// given serials) over a fixed date range. `{inverters, inverter_rows, string_rows, failed}`.
#[allow(clippy::too_many_arguments)]
pub async fn sync_all_history(
    pool: &PgPool,
    client: &GrowattClient,
    opts: &SyncOptions,
    start: NaiveDate,
    end: NaiveDate,
    device_sns: Option<&[String]>,
    pause_s: f64,
    phase: Option<i32>,
    include_untagged: bool,
) -> SyncResult<Value> {
    let mut inverters = inverters_query(pool, phase, include_untagged, None).await?;
    if let Some(sns) = device_sns.filter(|s| !s.is_empty()) {
        inverters.retain(|i| sns.contains(&i.device_sn));
    }
    let mut totals = Map::new();
    totals.insert("inverters".into(), json!(inverters.len()));
    totals.insert("inverter_rows".into(), json!(0));
    totals.insert("string_rows".into(), json!(0));
    totals.insert("failed".into(), json!([]));
    let total = inverters.len();
    for (idx, inv) in inverters.iter().enumerate() {
        match sync_inverter_history(pool, client, opts, inv, start, end, 3, None).await {
            Ok((a, b)) => {
                add(&mut totals, "inverter_rows", a);
                add(&mut totals, "string_rows", b);
                tracing::debug!("[{}/{total}] {} (plant {}): {a} records, {b} string rows", idx + 1, inv.device_sn, inv.plant_id);
            }
            Err(e) => {
                tracing::error!("[{}/{total}] {} failed: {e}", idx + 1, inv.device_sn);
                push_failed(&mut totals, failed_entry(inv.device_sn.clone(), e.to_string()));
            }
        }
        opts.sleep(pause_s).await;
    }
    Ok(Value::Object(totals))
}

/// Python `inverters.sync_incremental`: only what is new for each inverter since its
/// `history_synced_until` (re-reading `overlap`; never-synced ones from yesterday, long-offline
/// ones at most `max_back_days` back). `batch_size` > 0 first reads the inverters that already
/// hold a record of today `batch_size` per call; an inverter whose `max_data` read fails is tried
/// once through `queryHistoricalData` (`day_fallback`) before it counts as failed.
#[allow(clippy::too_many_arguments)]
pub async fn sync_incremental(
    pool: &PgPool,
    client: &GrowattClient,
    opts: &SyncOptions,
    today: NaiveDate,
    overlap: chrono::Duration,
    max_back_days: i64,
    pause_s: f64,
    phase: Option<i32>,
    include_untagged: bool,
    batch_size: usize,
) -> SyncResult<Value> {
    let floor = midnight(today - chrono::Duration::days(max_back_days));
    let mut inverters = inverters_query(pool, phase, include_untagged, None).await?;
    let mut totals = Map::new();
    totals.insert("inverters".into(), json!(inverters.len()));
    totals.insert("inverter_rows".into(), json!(0));
    totals.insert("string_rows".into(), json!(0));
    totals.insert("failed".into(), json!([]));
    totals.insert("day_fallback".into(), json!(0));
    if batch_size > 0 {
        let done = sync_today_batched(pool, client, opts, &inverters, today, overlap, batch_size, pause_s, &mut totals).await?;
        inverters.retain(|i| !done.contains(&i.device_sn));
    }
    for inv in &inverters {
        let since = inv
            .history_synced_until
            .map(|h| h - overlap)
            .unwrap_or_else(|| midnight(today - chrono::Duration::days(1)))
            .max(floor);
        match sync_inverter_history(pool, client, opts, inv, since.date(), today, 3, Some(since)).await {
            Ok((a, b)) => {
                add(&mut totals, "inverter_rows", a);
                add(&mut totals, "string_rows", b);
            }
            Err(e) => match sync_today_single(pool, client, opts, inv, today, overlap).await {
                None => {
                    tracing::error!("{} incremental sync failed: {e}", inv.device_sn);
                    push_failed(&mut totals, failed_entry(inv.device_sn.clone(), e.to_string()));
                }
                Some((a, b)) => {
                    add(&mut totals, "inverter_rows", a);
                    add(&mut totals, "string_rows", b);
                    add(&mut totals, "day_fallback", 1);
                    tracing::warn!("{} max_data failed ({e}): today read through queryHistoricalData", inv.device_sn);
                }
            },
        }
        opts.sleep(pause_s).await;
    }
    Ok(Value::Object(totals))
}

/// Python `inverters._store_today`: store today's `records` of `inv` from an endpoint whose answer
/// may be cut short. (inverter rows, string rows), or None when the answer is not proven complete
/// (the inverter's newest stored record is from today and the answer reaches back to it), in which
/// case nothing is written. Only rows inside the overlap window are written. One transaction.
async fn store_today(
    pool: &PgPool,
    opts: &SyncOptions,
    inv: &SyncInverter,
    records: &[Value],
    today: NaiveDate,
    overlap: chrono::Duration,
) -> SyncResult<Option<(usize, usize)>> {
    let Some(stored) = inv.history_synced_until.filter(|s| *s >= midnight(today)) else { return Ok(None) };
    let (inv_rows, str_rows) = parse(&inv.device_sn, records)?;
    let times: Vec<NaiveDateTime> = inv_rows.iter().map(|r| r.timestamp).collect();
    let (Some(&first), Some(&last)) = (times.iter().min(), times.iter().max()) else { return Ok(None) };
    if first > stored {
        return Ok(None);
    }
    let since = stored - overlap;
    let mut tx = pool.begin().await?;
    let inv_rows: Vec<InverterRow> = inv_rows.into_iter().filter(|r| r.timestamp >= since).collect();
    let str_rows = wired_only(&mut tx, str_rows.into_iter().filter(|r| r.timestamp >= since).collect()).await?;
    let (inv_rows, str_rows) = kept(inv_rows, str_rows);
    upsert_inverter_rows(&mut tx, &inv_rows).await?;
    store_string_rows(&mut tx, &str_rows).await?;
    store_raw(&mut tx, opts, &inv.device_sn, records, Some(since)).await?;
    sqlx::query("UPDATE growatt_inverters SET history_synced_until = $1, synced_at = now() WHERE device_sn = $2 \
         AND history_synced_until IS DISTINCT FROM $1")
        .bind(stored.max(last))
        .bind(&inv.device_sn)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(Some((inv_rows.len(), str_rows.len())))
}

fn as_values(records: Vec<Record>) -> Vec<Value> {
    records.into_iter().map(Value::Object).collect()
}

/// Python `inverters._sync_today_single`: today's records of one inverter through
/// `new-api/queryHistoricalData`, for an inverter `max_data` just refused. None = not used
/// (refused too, more pages follow, or not proven complete).
async fn sync_today_single(
    pool: &PgPool,
    client: &GrowattClient,
    opts: &SyncOptions,
    inv: &SyncInverter,
    today: NaiveDate,
    overlap: chrono::Duration,
) -> Option<(usize, usize)> {
    let records = match client.max_history_day(&inv.device_sn, today).await {
        Ok(Some(r)) => as_values(r),
        Ok(None) => return None,
        Err(e) => {
            tracing::debug!("{} queryHistoricalData fallback failed: {e}", inv.device_sn);
            return None;
        }
    };
    match store_today(pool, opts, inv, &records, today, overlap).await {
        Ok(r) => r,
        Err(e) => {
            tracing::debug!("{} queryHistoricalData fallback failed: {e}", inv.device_sn);
            None
        }
    }
}

/// Python `inverters._sync_today_batched`: today's new records of several inverters per call
/// (`new-api/queryDevicesHistoricalData`). Returns the serials fully synced here. Only inverters
/// whose newest stored record is from today take part; [`BATCH_MAX_ERRORS`] refused calls in a row
/// end batching for this run. A client error other than a Growatt refusal is raised, as in Python.
#[allow(clippy::too_many_arguments)]
async fn sync_today_batched(
    pool: &PgPool,
    client: &GrowattClient,
    opts: &SyncOptions,
    inverters: &[SyncInverter],
    today: NaiveDate,
    overlap: chrono::Duration,
    batch_size: usize,
    pause_s: f64,
    totals: &mut Map<String, Value>,
) -> SyncResult<HashSet<String>> {
    let day_start = midnight(today);
    let eligible: Vec<&SyncInverter> =
        inverters.iter().filter(|i| i.history_synced_until.is_some_and(|h| h >= day_start)).collect();
    for k in ["batch_calls", "batch_inverters", "batch_fallback", "batch_errors"] {
        totals.insert(k.into(), json!(0));
    }
    let mut done = HashSet::new();
    let mut in_a_row = 0usize;
    for (ci, chunk) in eligible.chunks(batch_size).enumerate() {
        let i = ci * batch_size;
        if i > 0 {
            opts.sleep(pause_s).await;
        }
        add(totals, "batch_calls", 1);
        let sns: Vec<String> = chunk.iter().map(|inv| inv.device_sn.clone()).collect();
        let mut by_sn = match client.max_history_batch(&sns, today).await {
            Ok(m) => m,
            Err(e @ tcroof_clients::growatt::GrowattError::Api(_)) => {
                add(totals, "batch_errors", 1);
                in_a_row += 1;
                tracing::warn!("batch history failed for {} inverters: {e}", chunk.len());
                if in_a_row >= BATCH_MAX_ERRORS {
                    tracing::warn!("batch history refused {in_a_row} times in a row: the rest of this run uses max_data");
                    add(totals, "batch_fallback", eligible.len() - i);
                    return Ok(done);
                }
                add(totals, "batch_fallback", chunk.len());
                continue;
            }
            Err(e) => return Err(SyncError::from(e)),
        };
        in_a_row = 0;
        for inv in chunk {
            let records = as_values(by_sn.remove(&inv.device_sn).unwrap_or_default());
            let rows = match store_today(pool, opts, inv, &records, today, overlap).await {
                Ok(r) => r,
                Err(e) => {
                    tracing::warn!("{} batch history rows failed: {e}", inv.device_sn);
                    None
                }
            };
            let Some((a, b)) = rows else {
                add(totals, "batch_fallback", 1);
                continue;
            };
            add(totals, "inverter_rows", a);
            add(totals, "string_rows", b);
            add(totals, "batch_inverters", 1);
            done.insert(inv.device_sn.clone());
        }
    }
    Ok(done)
}

// --------------------------------------------------------------------------- newest record

/// Python `inverters.sync_latest_records`: each inverter's newest record of today from `maxs_data`
/// ([`LATEST_CHUNK`] serials per call) into the history tables under the record's own `time`
/// (source-timestamped history, not a poll-time value); `history_synced_until` is left alone, and
/// a record of another day is not written. The first 10012 ends the account's sweep (the chunks not
/// read are listed in `failed`); `first_chunk` rotates the starting chunk.
#[allow(clippy::too_many_arguments)]
pub async fn sync_latest_records(
    pool: &PgPool,
    client: &GrowattClient,
    opts: &SyncOptions,
    today: NaiveDate,
    phase: Option<i32>,
    include_untagged: bool,
    first_chunk: usize,
    pause_s: f64,
) -> SyncResult<Value> {
    let mut sns: Vec<String> =
        inverters_query(pool, phase, include_untagged, None).await?.into_iter().map(|i| i.device_sn).collect();
    sns.sort();
    sns.dedup();
    let chunks: Vec<Vec<String>> = sns.chunks(LATEST_CHUNK).map(<[String]>::to_vec).collect();
    let mut totals = Map::new();
    for (k, v) in [
        ("inverters", json!(sns.len())),
        ("chunks", json!(chunks.len())),
        ("chunks_read", json!(0)),
        ("answered", json!(0)),
        ("not_today", json!(0)),
        ("inverter_rows", json!(0)),
        ("string_rows", json!(0)),
        ("failed", json!([])),
    ] {
        totals.insert(k.into(), v);
    }
    let order: Vec<usize> = (0..chunks.len()).map(|n| (first_chunk + n) % chunks.len()).collect();
    let label = |k: usize| format!("chunk {}/{}", k + 1, chunks.len());
    let day = today.to_string();
    for (n, &k) in order.iter().enumerate() {
        if n > 0 {
            opts.sleep(pause_s).await;
        }
        let res: SyncResult<(usize, usize)> = async {
            let records = client.maxs_latest(&chunks[k], 10).await?;
            let members: HashSet<&String> = chunks[k].iter().collect();
            let mut tx = pool.begin().await?;
            let (mut inv_rows, mut str_rows) = (Vec::new(), Vec::new());
            for (sn, rec) in records {
                if !members.contains(&sn) {
                    continue;
                }
                add(&mut totals, "answered", 1);
                let t = rec.get("time").filter(|v| tcroof_clients::growatt::py::truthy(v));
                let t = t.map(tcroof_clients::growatt::py::str_of).unwrap_or_default();
                if tcroof_clients::growatt::py::head(&t, 10) != day {
                    add(&mut totals, "not_today", 1);
                    continue;
                }
                // `dataloggerSn` is added by the client; it is not a field of the record
                let rec: Map<String, Value> = rec.into_iter().filter(|(f, _)| f != "dataloggerSn").collect();
                let one = [Value::Object(rec)];
                let (a, b) = parse(&sn, &one)?;
                inv_rows.extend(a);
                str_rows.extend(b);
                store_raw(&mut tx, opts, &sn, &one, None).await?;
            }
            let str_rows = wired_only(&mut tx, str_rows).await?;
            let (inv_rows, str_rows) = kept(inv_rows, str_rows);
            upsert_inverter_rows(&mut tx, &inv_rows).await?;
            store_string_rows(&mut tx, &str_rows).await?;
            tx.commit().await?;
            Ok((inv_rows.len(), str_rows.len()))
        }
        .await;
        match res {
            Ok((a, b)) => {
                add(&mut totals, "chunks_read", 1);
                add(&mut totals, "inverter_rows", a);
                add(&mut totals, "string_rows", b);
            }
            Err(e) if e.is_rate_limited() => {
                for &j in &order[n..] {
                    push_failed(&mut totals, failed_entry(label(j), e.to_string()));
                }
                tracing::warn!("maxs_data rate limited at {}: {} chunk(s) left for the next run", label(k), order.len() - n);
                break;
            }
            Err(e) => {
                tracing::error!("maxs_data {} failed: {e}", label(k));
                push_failed(&mut totals, failed_entry(label(k), e.to_string()));
            }
        }
    }
    Ok(Value::Object(totals))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(ts: &str, status: Value, pac: Option<f64>, fault: Option<i64>) -> InverterRow {
        InverterRow {
            device_sn: "A".into(),
            timestamp: NaiveDateTime::parse_from_str(ts, "%Y-%m-%d %H:%M:%S").unwrap(),
            status,
            pac_w: pac,
            ppv_w: 0.0,
            eac_today_kwh: None,
            eac_total_kwh: None,
            temperature_c: None,
            fac_hz: None,
            mppt_json: vec![],
            fault_code: fault,
            warn_code: None,
        }
    }

    #[test]
    fn night_standby_rules() {
        assert!(night_standby(&row("2026-11-01 04:55:00", json!(0), None, None)));
        assert!(night_standby(&row("2026-11-01 19:00:00", json!("0"), Some(0.0), None)));
        assert!(!night_standby(&row("2026-11-01 05:00:00", json!(0), None, None))); // daytime: kept
        assert!(!night_standby(&row("2026-11-01 23:00:00", json!(0), Some(5.0), None))); // AC power at night
        assert!(!night_standby(&row("2026-11-01 23:00:00", json!(0), None, Some(117)))); // a fault
        assert!(!night_standby(&row("2026-11-01 23:00:00", json!(1), None, None)));
        assert_eq!(status_int(&json!(1.0)), Some(1));
        assert_eq!(status_int(&json!("3")), Some(3));
    }
}
