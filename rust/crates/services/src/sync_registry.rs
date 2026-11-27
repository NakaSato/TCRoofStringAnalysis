//! The fleet registry of the worker's `fleet` job: plants, inverters, weather sensors, energy
//! meters and their static details, ported from backend/app/services/growatt_sync/registry.py
//! (plus the discovery halves of `growatt_sync/env.py` `sync_env_sensors` and
//! `growatt_sync/meters.py` `sync_meters`, which `sync_fleet` calls, and `growatt_sync/common.py`
//! `_retry`). Static registry fields only: current power, status, `lost` and upload times are
//! realtime and never stored (root CLAUDE.md rule 1).
//!
//! Python updates rows through the ORM, whose `onupdate=_utcnow` also stamps `synced_at` on every
//! changed row; the UPDATEs here set `synced_at` to the same "now" explicitly. Each write is its
//! own short transaction, as Python commits after each row / chunk.

use std::collections::{BTreeMap, BTreeSet};
use std::time::Duration;

use chrono::{DateTime, Duration as Span, Utc};
use serde_json::Value;
use sqlx::PgPool;
use tcroof_clients::growatt::{py, GrowattClient, GrowattError, MaxInfo};

const LOG: &str = "growatt_sync";

/// Python `growatt_sync.common.RATE_LIMIT_CODE`
pub const RATE_LIMIT_CODE: i64 = 10012;
/// Python `INFO_REFRESH_HOURS`: settings (power limit, on/off) can change: re-read each daily run
pub const INFO_REFRESH_HOURS: i64 = 20;
/// Python `INFO_MAX_RATE_LIMITED`
pub const INFO_MAX_RATE_LIMITED: u32 = 3;
/// Python `DETAILS_REFRESH_DAYS`: plant/details are static, rarely edited in Growatt
pub const DETAILS_REFRESH_DAYS: i64 = 7;
/// Python `PARAM_REFRESH_DAYS`: queryDeviceInfoParam: the model does not change
pub const PARAM_REFRESH_DAYS: i64 = 30;
/// Python `REGISTRY_MAX_RATE_LIMITED`
pub const REGISTRY_MAX_RATE_LIMITED: u32 = 3;
/// Python `CREATE_DATE_CHUNK`: serials per `device/all/create_date` call
pub const CREATE_DATE_CHUNK: usize = 50;
/// Python `sync_fleet(pause_s=0.5)`
pub const FLEET_PAUSE_S: f64 = 0.5;
/// Python's fleet bounding box (Thailand) `_LAT_RANGE` / `_LON_RANGE`
pub const LAT_RANGE: (f64, f64) = (5.0, 21.0);
pub const LON_RANGE: (f64, f64) = (97.0, 106.0);

/// What a registry step can fail with: a Growatt call (Python `GrowattAPIError`, or the
/// `TypeError` / `ValueError` of an unexpected reply), or the database.
#[derive(Debug, thiserror::Error)]
pub enum SyncError {
    #[error("{0}")]
    Growatt(#[from] GrowattError),
    #[error(transparent)]
    Db(#[from] sqlx::Error),
    /// a Python exception raised by this code itself (`TypeError`, `ValueError`, …): "Class: msg"
    #[error("{0}")]
    Py(String),
}

impl SyncError {
    /// The Python exception class name, for `"{class}: {message}"` in a run's detail / error.
    pub fn kind(&self) -> String {
        match self {
            SyncError::Growatt(GrowattError::Api(_)) => "GrowattAPIError".into(),
            SyncError::Growatt(GrowattError::InvalidArgument(_)) => "ValueError".into(),
            SyncError::Growatt(GrowattError::Unexpected(e)) => class_of(&e.0).0.into(),
            SyncError::Py(m) => class_of(m).0.into(),
            SyncError::Db(_) => "DatabaseError".into(),
        }
    }

    /// The message without the class name.
    pub fn message(&self) -> String {
        match self {
            SyncError::Growatt(GrowattError::Unexpected(e)) => class_of(&e.0).1.into(),
            SyncError::Py(m) => class_of(m).1.into(),
            other => other.to_string(),
        }
    }
}

/// "TypeError: msg" → ("TypeError", "msg"); a text without a class is an `Exception`.
fn class_of(s: &str) -> (&str, &str) {
    match s.split_once(": ") {
        Some((c, m)) if !c.is_empty() && c.chars().all(|ch| ch.is_ascii_alphanumeric() || ch == '_') => (c, m),
        _ => ("Exception", s),
    }
}

impl From<py::PyError> for SyncError {
    fn from(e: py::PyError) -> Self {
        SyncError::Py(e.0)
    }
}

pub type Result<T> = std::result::Result<T, SyncError>;

async fn sleep_s(s: f64) {
    if s > 0.0 {
        tokio::time::sleep(Duration::from_secs_f64(s)).await;
    }
}

/// `except GrowattAPIError` (not the client's own `ValueError` / unexpected-reply errors)
fn is_api(e: &GrowattError) -> bool {
    matches!(e, GrowattError::Api(_))
}

/// Python `growatt_sync.common._retry`: call `f()`, retrying Growatt errors (`retries` = 3);
/// 10012 (per-endpoint rate limit) waits minutes (60 s, 120 s, 120 s), others 5 s, 10 s, 15 s.
pub async fn retry<T, F, Fut>(f: F, label: &str, retries: u32) -> std::result::Result<T, GrowattError>
where
    F: Fn() -> Fut,
    Fut: std::future::Future<Output = std::result::Result<T, GrowattError>>,
{
    let mut attempt = 0u32;
    loop {
        match f().await {
            Ok(v) => return Ok(v),
            Err(e) if is_api(&e) => {
                if attempt >= retries {
                    return Err(e);
                }
                let wait = if e.is_rate_limited() { (60 * (attempt + 1)).min(120) } else { 5 * (attempt + 1) };
                tracing::warn!(target: LOG, "{label}: {e} — retry in {wait}s");
                tokio::time::sleep(Duration::from_secs(u64::from(wait))).await;
                attempt += 1;
            }
            Err(e) => return Err(e),
        }
    }
}

/// Python `growatt_sync.common._fnum`: `float(v)`, `None` when Python's `float()` refuses it.
fn fnum(v: &Value) -> Option<f64> {
    py::float(v)
}

/// Python `normalize_coords`: (lat, lon) as floats, swapped back when Growatt reported them
/// reversed; a pair that fits the fleet area neither way round is dropped (`None`, `None`).
pub fn normalize_coords(lat: &Value, lon: &Value) -> (Option<f64>, Option<f64>) {
    let (Some(la), Some(lo)) = (fnum(lat), fnum(lon)) else {
        return (None, None);
    };
    let fits = |a: f64, b: f64| LAT_RANGE.0 <= a && a <= LAT_RANGE.1 && LON_RANGE.0 <= b && b <= LON_RANGE.1;
    if fits(la, lo) {
        (Some(la), Some(lo))
    } else if fits(lo, la) {
        (Some(lo), Some(la))
    } else {
        (None, None)
    }
}

/// A Growatt value stored in a text column as Python passes it: `None` stays NULL, a string is
/// itself, anything else its `str()` (Python hands the object to the driver).
fn text_col(v: &Value) -> Option<String> {
    match v {
        Value::Null => None,
        Value::String(s) => Some(s.clone()),
        other => Some(py::str_of(other)),
    }
}

/// Python `repr(list_of_ints)`
fn int_list(ids: &[i64]) -> String {
    format!("[{}]", ids.iter().map(i64::to_string).collect::<Vec<_>>().join(", "))
}

// --------------------------------------------------------------------------- blocked plants

/// Python `remove_blocked_plants`: take the blocked plants (`GROWATT_BLOCKED_PLANT_IDS`) out of
/// the registry; the ids removed. Deleting the plant row cascades to its inverters, sensors,
/// meters, their readings and the alarm log; its issues, cleaning-suggestion marks, planned tasks
/// (assignees + history cascade), plan links and planning figures, documents and O&M register
/// stations + devices go too (`om_suggestions` / `om_plans` / `plant_documents` / `site_register`
/// `.delete_plant_rows`). One transaction, as Python's single commit.
pub async fn remove_blocked_plants(pool: &PgPool, plant_ids: &[i64]) -> Result<Vec<i64>> {
    let ids: Vec<i32> = plant_ids
        .iter()
        .copied()
        .collect::<BTreeSet<i64>>()
        .into_iter()
        .filter_map(|i| i32::try_from(i).ok())
        .collect();
    if ids.is_empty() {
        return Ok(Vec::new());
    }
    let found: Vec<i32> = sqlx::query_scalar("SELECT plant_id FROM growatt_plants WHERE plant_id = ANY($1) ORDER BY plant_id")
        .bind(&ids)
        .fetch_all(pool)
        .await?;
    if found.is_empty() {
        return Ok(Vec::new());
    }
    let mut tx = pool.begin().await?;
    for sql in [
        "DELETE FROM growatt_issues WHERE plant_id = ANY($1)",
        "DELETE FROM om_cleaning_suggestion_marks WHERE plant_id = ANY($1)",
        "DELETE FROM om_tasks WHERE plant_id = ANY($1)",
        "DELETE FROM om_plan_plants WHERE plant_id = ANY($1)",
        "DELETE FROM om_plant_settings WHERE plant_id = ANY($1)",
        "DELETE FROM plant_documents WHERE plant_id = ANY($1)",
        "DELETE FROM site_devices WHERE site_code IN (SELECT site_code FROM site_register WHERE plant_id = ANY($1))",
        "DELETE FROM site_register WHERE plant_id = ANY($1)",
        "DELETE FROM growatt_plants WHERE plant_id = ANY($1)",
    ] {
        sqlx::query(sql).bind(&found).execute(&mut *tx).await?;
    }
    tx.commit().await?;
    let found: Vec<i64> = found.into_iter().map(i64::from).collect();
    tracing::info!(target: LOG, "blocked plants removed from the registry: {}", int_list(&found));
    Ok(found)
}

// --------------------------------------------------------------------------- the fleet

/// Python `sync_fleet`: upsert the plants and inverters of one Growatt account, register each
/// plant's weather sensors and meters, then the sweeps (inverter info / settings, plant details,
/// inverter model, creation date, missing datalogger). `phase` tags each listed plant with the
/// account's project phase (`None` keeps the stored tag). Returns how many installed inverters
/// that account's plants have (Python returns the rows; the job counts them).
pub async fn sync_fleet(pool: &PgPool, client: &GrowattClient, pause_s: f64, phase: Option<i32>) -> Result<usize> {
    let now = Utc::now();
    let ph = phase.map_or_else(|| "None".to_owned(), |p| p.to_string());
    let plants = retry(|| client.list_plants(true), &format!("phase {ph} plant/list"), 3).await?;

    // rows first (a bad plant id fails the account before anything is written, as in Python)
    let mut pids: Vec<i32> = Vec::new();
    let (mut names, mut cities, mut countries, mut lats, mut lons, mut peaks, mut creates) =
        (Vec::new(), Vec::new(), Vec::new(), Vec::new(), Vec::new(), Vec::new(), Vec::new());
    for p in &plants {
        let pid = plant_id_of(py::get(p, "plant_id"))?;
        let name = py::get(p, "name");
        names.push(if py::truthy(name) { py::str_of(name) } else { pid.to_string() });
        cities.push(text_col(py::get(p, "city")));
        countries.push(text_col(py::get(p, "country")));
        let (la, lo) = normalize_coords(py::get(p, "latitude"), py::get(p, "longitude"));
        lats.push(la);
        lons.push(lo);
        peaks.push(fnum(py::get(p, "peak_power")));
        creates.push(text_col(py::get(p, "create_date")));
        pids.push(pid);
    }
    if !pids.is_empty() {
        let stamps = vec![now; pids.len()];
        let cols = "plant_id, name, city, country, latitude, longitude, peak_power_kwp, create_date, synced_at";
        let set = "name = EXCLUDED.name, city = EXCLUDED.city, country = EXCLUDED.country, latitude = EXCLUDED.latitude, \
                   longitude = EXCLUDED.longitude, peak_power_kwp = EXCLUDED.peak_power_kwp, create_date = EXCLUDED.create_date, \
                   synced_at = EXCLUDED.synced_at";
        let unnest = "$1::int4[], $2::text[], $3::text[], $4::text[], $5::float8[], $6::float8[], $7::float8[], $8::text[], $9::timestamptz[]";
        let sql = match phase {
            Some(_) => format!(
                "INSERT INTO growatt_plants ({cols}, phase) SELECT * FROM UNNEST({unnest}, $10::int4[]) \
                 ON CONFLICT (plant_id) DO UPDATE SET {set}, phase = EXCLUDED.phase"
            ),
            None => format!("INSERT INTO growatt_plants ({cols}) SELECT * FROM UNNEST({unnest}) ON CONFLICT (plant_id) DO UPDATE SET {set}"),
        };
        let mut q = sqlx::query(&sql)
            .bind(&pids)
            .bind(&names)
            .bind(&cities)
            .bind(&countries)
            .bind(&lats)
            .bind(&lons)
            .bind(&peaks)
            .bind(&creates)
            .bind(&stamps);
        if let Some(p) = phase {
            q = q.bind(vec![p; pids.len()]);
        }
        q.execute(pool).await?;
    }
    tracing::info!(target: LOG, "phase {ph} plants: {}", plants.len());

    for &pid in &pids {
        let invs = retry(|| client.list_inverters(i64::from(pid), true), &format!("plant {pid} device/list"), 3).await?;
        if !invs.is_empty() {
            let sns: Vec<String> = invs.iter().map(|i| i.device_sn.clone()).collect();
            let dls: Vec<Option<String>> = invs.iter().map(|i| text_col(&i.datalogger_sn)).collect();
            let models: Vec<Option<String>> = invs.iter().map(|i| text_col(&i.model)).collect();
            let types: Vec<String> = invs.iter().map(|i| i.device_types.join(",")).collect();
            sqlx::query(
                "INSERT INTO growatt_inverters (device_sn, plant_id, datalogger_sn, model, device_types, synced_at) \
                 SELECT * FROM UNNEST($1::text[], $2::int4[], $3::text[], $4::text[], $5::text[], $6::timestamptz[]) \
                 ON CONFLICT (device_sn) DO UPDATE SET plant_id = EXCLUDED.plant_id, datalogger_sn = EXCLUDED.datalogger_sn, \
                 model = EXCLUDED.model, device_types = EXCLUDED.device_types, synced_at = EXCLUDED.synced_at",
            )
            .bind(&sns)
            .bind(vec![pid; sns.len()])
            .bind(&dls)
            .bind(&models)
            .bind(&types)
            .bind(vec![now; sns.len()])
            .execute(pool)
            .await?;
        }
        tracing::info!(target: LOG, "plant {pid}: {} inverters", invs.len());
        match sync_env_sensors(pool, client, pid, now).await {
            Ok(n) if n > 0 => tracing::info!(target: LOG, "plant {pid}: {n} weather sensors"),
            Ok(_) => {}
            // weather discovery must not break the inverter registry
            Err(e) => tracing::error!(target: LOG, "plant {pid} weather-sensor discovery failed: {}", e.message()),
        }
        match sync_meters(pool, client, pid, now).await {
            Ok(n) if n > 0 => tracing::debug!(target: LOG, "plant {pid}: {n} meters"),
            Ok(_) => {}
            Err(e) => tracing::error!(target: LOG, "plant {pid} meter discovery failed: {}", e.message()),
        }
        sleep_s(pause_s).await;
    }

    match sync_inverter_info(pool, client, &pids, now, pause_s).await {
        Ok(n) => tracing::info!(target: LOG, "phase {ph}: inverter info/settings read for {n} inverters"),
        Err(e) => tracing::error!(target: LOG, "phase {ph} inverter info sweep failed: {}", e.message()),
    }
    for label in ["plant details", "inverter model", "inverter creation date", "inverter datalogger"] {
        let r = match label {
            "plant details" => sync_plant_details(pool, client, &pids, now, pause_s).await,
            "inverter model" => sync_device_params(pool, client, &pids, now, pause_s).await,
            "inverter creation date" => sync_create_dates(pool, client, &pids, pause_s).await,
            _ => sync_missing_dataloggers(pool, client, &pids, now, pause_s).await,
        };
        match r {
            Ok(n) => tracing::info!(target: LOG, "phase {ph}: {label} read for {n}"),
            Err(e) => tracing::error!(target: LOG, "phase {ph} {label} sweep failed: {}", e.message()),
        }
    }
    let n: i64 = sqlx::query_scalar("SELECT count(*) FROM growatt_inverters WHERE plant_id = ANY($1) AND not_installed_at IS NULL")
        .bind(&pids)
        .fetch_one(pool)
        .await?;
    Ok(usize::try_from(n).unwrap_or(0))
}

/// `int(p["plant_id"])` for an `Integer` column.
fn plant_id_of(v: &Value) -> Result<i32> {
    let id = py::int(v)?;
    i32::try_from(id).map_err(|_| SyncError::Py(format!("DataError: plant_id {id} out of range for type integer")))
}

/// The type-3 devices of a plant's (cached) `device/list` whose `device_sn` is `kind` ("env",
/// "meter"): their dataloggers, sorted, once each.
async fn dataloggers_with(client: &GrowattClient, plant_id: i32, kind: &str) -> Result<Vec<String>> {
    let mut out = BTreeSet::new();
    for d in client.list_devices(i64::from(plant_id), false).await? {
        let d = py::as_dict(&d)?;
        // d.get("type") == 3 (3, 3.0; not True)
        let is3 = matches!(py::get(d, "type"), Value::Number(n) if n.as_f64() == Some(3.0));
        let sn = py::get(d, "device_sn");
        let sn = if py::truthy(sn) { py::str_of(sn) } else { String::new() };
        let dl = py::get(d, "datalogger_sn");
        if is3 && sn.to_lowercase() == kind && py::truthy(dl) {
            out.insert(py::str_of(dl));
        }
    }
    Ok(out.into_iter().collect())
}

/// `int(str(v))`, `None` for Python's `ValueError`.
fn address_of(v: &Value) -> Option<i32> {
    py::int(&Value::String(py::str_of(v))).ok().and_then(|a| i32::try_from(a).ok())
}

/// Python `growatt_sync.env.sync_env_sensors`: register the plant's weather sensors (type-3
/// devices named "env"; `env_list` on that datalogger gives each sensor's bus address). How many
/// were found. `lost` / `lastUpdateTime` are realtime: never stored.
pub async fn sync_env_sensors(pool: &PgPool, client: &GrowattClient, plant_id: i32, now: DateTime<Utc>) -> Result<usize> {
    let (mut dls, mut addrs, mut names) = (Vec::new(), Vec::new(), Vec::new());
    for dl in dataloggers_with(client, plant_id, "env").await? {
        for e in retry(|| client.list_env_sensors(&dl, true), &format!("{dl} env_list"), 3).await? {
            let e = py::as_dict(&e)?;
            let Some(addr) = address_of(py::get(e, "address")) else { continue };
            dls.push(dl.clone());
            addrs.push(addr);
            names.push(text_col(py::get(e, "device_name")));
        }
    }
    if !dls.is_empty() {
        sqlx::query(
            "INSERT INTO growatt_env_sensors (datalogger_sn, address, plant_id, device_name, synced_at) \
             SELECT * FROM UNNEST($1::text[], $2::int4[], $3::int4[], $4::text[], $5::timestamptz[]) \
             ON CONFLICT (datalogger_sn, address) DO UPDATE SET plant_id = EXCLUDED.plant_id, \
             device_name = EXCLUDED.device_name, synced_at = EXCLUDED.synced_at",
        )
        .bind(&dls)
        .bind(&addrs)
        .bind(vec![plant_id; dls.len()])
        .bind(&names)
        .bind(vec![now; dls.len()])
        .execute(pool)
        .await?;
    }
    Ok(dls.len())
}

/// Python `growatt_sync.meters.sync_meters`: register the plant's energy meters (type-3 devices
/// named "meter"; `meter_list` on the datalogger gives each one's bus address). An address listed
/// twice keeps its first entry. How many were found.
pub async fn sync_meters(pool: &PgPool, client: &GrowattClient, plant_id: i32, now: DateTime<Utc>) -> Result<usize> {
    // insertion order kept, keyed by (datalogger, address)
    let mut keys: Vec<(String, i32)> = Vec::new();
    let mut rows: BTreeMap<(String, i32), (Option<String>, Option<String>)> = BTreeMap::new();
    for dl in dataloggers_with(client, plant_id, "meter").await? {
        for m in retry(|| client.list_meters(&dl, true), &format!("{dl} meter_list"), 3).await? {
            let m = py::as_dict(&m)?;
            let Some(addr) = address_of(py::get(m, "address")) else { continue };
            let name = text_col(py::get(m, "device_name"));
            let key = (dl.clone(), addr);
            if let Some((kept, _)) = rows.get(&key) {
                let s = |v: &Option<String>| v.clone().unwrap_or_else(|| "None".into());
                tracing::warn!(
                    target: LOG,
                    "plant {plant_id}: meter_list names {dl} address {addr} twice ({} / {}); keeping {}",
                    s(kept), s(&name), s(kept)
                );
                continue;
            }
            let t = py::get(m, "device_type");
            let dtype = (!(t.is_null() || t.as_str() == Some(""))).then(|| py::str_of(t));
            rows.insert(key.clone(), (name, dtype));
            keys.push(key);
        }
    }
    if !keys.is_empty() {
        let dls: Vec<String> = keys.iter().map(|k| k.0.clone()).collect();
        let addrs: Vec<i32> = keys.iter().map(|k| k.1).collect();
        let names: Vec<Option<String>> = keys.iter().map(|k| rows[k].0.clone()).collect();
        let types: Vec<Option<String>> = keys.iter().map(|k| rows[k].1.clone()).collect();
        sqlx::query(
            "INSERT INTO growatt_meters (datalogger_sn, address, plant_id, device_name, device_type, synced_at) \
             SELECT * FROM UNNEST($1::text[], $2::int4[], $3::int4[], $4::text[], $5::text[], $6::timestamptz[]) \
             ON CONFLICT (datalogger_sn, address) DO UPDATE SET plant_id = EXCLUDED.plant_id, \
             device_name = EXCLUDED.device_name, device_type = EXCLUDED.device_type, synced_at = EXCLUDED.synced_at",
        )
        .bind(&dls)
        .bind(&addrs)
        .bind(vec![plant_id; dls.len()])
        .bind(&names)
        .bind(&types)
        .bind(vec![now; dls.len()])
        .execute(pool)
        .await?;
    }
    Ok(keys.len())
}

// --------------------------------------------------------------------------- the sweeps

/// Python `_due`: never read, or read at / before the cutoff.
fn due(last: Option<DateTime<Utc>>, cutoff: DateTime<Utc>) -> bool {
    last.is_none_or(|l| l <= cutoff)
}

fn all_none(i: &MaxInfo) -> bool {
    i.alias.is_none()
        && i.nominal_power_w.is_none()
        && i.fw_version.is_none()
        && i.inner_version.is_none()
        && i.active_rate_pct.is_none()
        && i.reactive_rate_pct.is_none()
        && i.pf_setting.is_none()
        && i.pf_model.is_none()
        && i.export_limit.is_none()
        && i.export_limit_rate_pct.is_none()
        && i.on_off.is_none()
}

/// Python `_sync_inverter_info`: name, rating, firmware and settings of the plants' installed
/// inverters never read or read more than INFO_REFRESH_HOURS ago, oldest first. At the first
/// 10012 of `max_data_info` the sweep goes on with `new-api/queryDeviceInfo` (same fields);
/// INFO_MAX_RATE_LIMITED 10012s in a row from that one end the sweep; any other failure skips
/// the inverter. Every field is written, `None` included. How many were read.
pub async fn sync_inverter_info(pool: &PgPool, client: &GrowattClient, plant_ids: &[i32], now: DateTime<Utc>, pause_s: f64) -> Result<usize> {
    let cutoff = now - Span::hours(INFO_REFRESH_HOURS);
    let rows: Vec<(String, Option<DateTime<Utc>>)> = sqlx::query_as(
        "SELECT device_sn, info_synced_at FROM growatt_inverters WHERE plant_id = ANY($1) AND not_installed_at IS NULL \
         ORDER BY info_synced_at IS NOT NULL, info_synced_at, device_sn",
    )
    .bind(plant_ids)
    .fetch_all(pool)
    .await?;
    let mut done = 0usize;
    let mut fallback = false;
    let mut in_a_row = 0u32;
    for (sn, last) in rows {
        if last.is_some_and(|l| l > cutoff) {
            continue;
        }
        // Python `read(sn)`: max_data_info until it answers 10012, then queryDeviceInfo
        let mut res = None;
        if !fallback {
            match client.max_info(&sn).await {
                Err(e) if e.is_rate_limited() => {
                    fallback = true;
                    tracing::info!(target: LOG, "max_data_info rate limited after {done} inverters; continuing with queryDeviceInfo");
                }
                other => res = Some(other),
            }
        }
        let res = match res {
            Some(r) => r,
            None => client.device_info(&sn).await,
        };
        let info = match res {
            Ok(i) => i,
            Err(e) if is_api(&e) && e.is_rate_limited() => {
                in_a_row += 1;
                if in_a_row >= INFO_MAX_RATE_LIMITED {
                    tracing::warn!(target: LOG, "inverter info rate limited after {done} inverters; the rest wait for the next run");
                    break;
                }
                sleep_s(pause_s).await;
                continue;
            }
            Err(e) => {
                in_a_row = 0;
                tracing::warn!(target: LOG, "inverter {sn} info failed: {}", SyncError::from(e).message());
                continue;
            }
        };
        in_a_row = 0;
        if all_none(&info) {
            // answered without data: try again next run
            tracing::warn!(target: LOG, "inverter {sn} info returned no data");
            continue;
        }
        sqlx::query(
            "UPDATE growatt_inverters SET alias = $2, nominal_power_w = $3, fw_version = $4, inner_version = $5, \
             active_rate_pct = $6, reactive_rate_pct = $7, pf_setting = $8, pf_model = $9, export_limit = $10, \
             export_limit_rate_pct = $11, on_off = $12, info_synced_at = $13, synced_at = $14 WHERE device_sn = $1",
        )
        .bind(&sn)
        .bind(&info.alias)
        .bind(info.nominal_power_w)
        .bind(&info.fw_version)
        .bind(&info.inner_version)
        .bind(info.active_rate_pct)
        .bind(info.reactive_rate_pct)
        .bind(info.pf_setting)
        .bind(info.pf_model.and_then(|v| i32::try_from(v).ok()))
        .bind(info.export_limit.and_then(|v| i32::try_from(v).ok()))
        .bind(info.export_limit_rate_pct)
        .bind(info.on_off.and_then(|v| i32::try_from(v).ok()))
        .bind(now)
        .bind(Utc::now())
        .execute(pool)
        .await?;
        done += 1;
        sleep_s(pause_s).await;
    }
    Ok(done)
}

/// The bookkeeping of Python `_registry_sweep`: a pause between reads, REGISTRY_MAX_RATE_LIMITED
/// 10012s in a row end the sweep, other Growatt refusals skip the row (logged at DEBUG), any other
/// failure skips it with a warning.
struct Sweep<'a> {
    label: &'a str,
    pause_s: f64,
    asked: u32,
    in_a_row: u32,
    done: usize,
}

enum Next<T> {
    Write(T),
    Skip,
    Stop,
}

impl<'a> Sweep<'a> {
    fn new(label: &'a str, pause_s: f64) -> Self {
        Sweep { label, pause_s, asked: 0, in_a_row: 0, done: 0 }
    }

    async fn before(&mut self) {
        if self.asked > 0 {
            sleep_s(self.pause_s).await;
        }
        self.asked += 1;
    }

    fn after<T>(&mut self, r: std::result::Result<T, GrowattError>) -> Next<T> {
        match r {
            Ok(v) => {
                self.in_a_row = 0;
                Next::Write(v)
            }
            Err(e) if is_api(&e) && e.is_rate_limited() => {
                self.in_a_row += 1;
                if self.in_a_row >= REGISTRY_MAX_RATE_LIMITED {
                    tracing::warn!(target: LOG, "{} rate limited after {} reads; the rest wait for the next run", self.label, self.done);
                    Next::Stop
                } else {
                    Next::Skip
                }
            }
            Err(e) if is_api(&e) => {
                self.in_a_row = 0;
                tracing::debug!(target: LOG, "{} failed: {e}", self.label);
                Next::Skip
            }
            Err(e) => {
                self.in_a_row = 0;
                tracing::warn!(target: LOG, "{} failed: {}", self.label, SyncError::from(e).message());
                Next::Skip
            }
        }
    }
}

/// Python `_sync_plant_details`: `plant/details` (time zone, address, Growatt's inverter /
/// datalogger counts) for the plants never read or read more than DETAILS_REFRESH_DAYS ago,
/// oldest first. A blank answer never erases a value read before.
pub async fn sync_plant_details(pool: &PgPool, client: &GrowattClient, plant_ids: &[i32], now: DateTime<Utc>, pause_s: f64) -> Result<usize> {
    let cutoff = now - Span::days(DETAILS_REFRESH_DAYS);
    let rows: Vec<(i32, Option<DateTime<Utc>>)> = sqlx::query_as(
        "SELECT plant_id, details_synced_at FROM growatt_plants WHERE plant_id = ANY($1) \
         ORDER BY details_synced_at IS NOT NULL, details_synced_at, plant_id",
    )
    .bind(plant_ids)
    .fetch_all(pool)
    .await?;
    let mut sw = Sweep::new("plant/details", pause_s);
    for (pid, _) in rows.into_iter().filter(|(_, l)| due(*l, cutoff)) {
        sw.before().await;
        let d = match sw.after(client.plant_details(i64::from(pid)).await) {
            Next::Write(d) => d,
            Next::Skip => continue,
            Next::Stop => break,
        };
        sqlx::query(
            "UPDATE growatt_plants SET timezone = COALESCE($2, timezone), address = COALESCE($3, address), \
             growatt_inverter_count = COALESCE($4, growatt_inverter_count), \
             growatt_datalogger_count = COALESCE($5, growatt_datalogger_count), details_synced_at = $6, synced_at = $7 \
             WHERE plant_id = $1",
        )
        .bind(pid)
        .bind(&d.timezone)
        .bind(&d.address)
        .bind(d.growatt_inverter_count.and_then(|v| i32::try_from(v).ok()))
        .bind(d.growatt_datalogger_count.and_then(|v| i32::try_from(v).ok()))
        .bind(now)
        .bind(Utc::now())
        .execute(pool)
        .await?;
        sw.done += 1;
    }
    Ok(sw.done)
}

/// Python `_sync_device_params`: `queryDeviceInfoParam` (model text, datalogger model, rated
/// power) for the installed inverters never read or read more than PARAM_REFRESH_DAYS ago,
/// oldest first.
pub async fn sync_device_params(pool: &PgPool, client: &GrowattClient, plant_ids: &[i32], now: DateTime<Utc>, pause_s: f64) -> Result<usize> {
    let cutoff = now - Span::days(PARAM_REFRESH_DAYS);
    let rows: Vec<(String, Option<DateTime<Utc>>)> = sqlx::query_as(
        "SELECT device_sn, param_synced_at FROM growatt_inverters WHERE plant_id = ANY($1) AND not_installed_at IS NULL \
         ORDER BY param_synced_at IS NOT NULL, param_synced_at, device_sn",
    )
    .bind(plant_ids)
    .fetch_all(pool)
    .await?;
    let mut sw = Sweep::new("queryDeviceInfoParam", pause_s);
    for (sn, _) in rows.into_iter().filter(|(_, l)| due(*l, cutoff)) {
        sw.before().await;
        let d = match sw.after(client.device_info_param(&sn).await) {
            Next::Write(d) => d,
            Next::Skip => continue,
            Next::Stop => break,
        };
        sqlx::query(
            "UPDATE growatt_inverters SET device_model = COALESCE($2, device_model), \
             datalogger_model = COALESCE($3, datalogger_model), rated_power_w = COALESCE($4, rated_power_w), \
             param_synced_at = $5, synced_at = $6 WHERE device_sn = $1",
        )
        .bind(&sn)
        .bind(&d.device_model)
        .bind(&d.datalogger_model)
        .bind(d.rated_power_w)
        .bind(now)
        .bind(Utc::now())
        .execute(pool)
        .await?;
        sw.done += 1;
    }
    Ok(sw.done)
}

/// Python `_sync_create_dates`: `device/all/create_date` (when Growatt registered the device) for
/// the installed inverters that have none yet, CREATE_DATE_CHUNK serials per call; the ones still
/// missing then from the account's device list (`new-api/queryDeviceList`). Read once (the date
/// never changes); REGISTRY_MAX_RATE_LIMITED 10012s in a row end the sweep.
pub async fn sync_create_dates(pool: &PgPool, client: &GrowattClient, plant_ids: &[i32], pause_s: f64) -> Result<usize> {
    let sns: Vec<String> = sqlx::query_scalar(
        "SELECT device_sn FROM growatt_inverters WHERE plant_id = ANY($1) AND not_installed_at IS NULL \
         AND growatt_created_at IS NULL ORDER BY device_sn",
    )
    .bind(plant_ids)
    .fetch_all(pool)
    .await?;
    let mut found: BTreeSet<String> = BTreeSet::new();
    let mut done = 0usize;
    let mut in_a_row = 0u32;
    let set = "UPDATE growatt_inverters SET growatt_created_at = $2, synced_at = $3 WHERE device_sn = $1";
    for (i, chunk) in sns.chunks(CREATE_DATE_CHUNK).enumerate() {
        if i > 0 {
            sleep_s(pause_s).await;
        }
        let created = match client.devices_create_time(chunk, 10).await {
            Ok(c) => c,
            Err(e) if is_api(&e) && e.is_rate_limited() => {
                in_a_row += 1;
                if in_a_row >= REGISTRY_MAX_RATE_LIMITED {
                    tracing::warn!(target: LOG, "device/all/create_date rate limited after {done} inverters; the rest wait for the next run");
                    break;
                }
                continue;
            }
            Err(e) if is_api(&e) => {
                in_a_row = 0;
                tracing::warn!(target: LOG, "device/all/create_date failed: {e}");
                continue;
            }
            Err(e) => return Err(e.into()),
        };
        in_a_row = 0;
        for sn in chunk {
            if let Some(at) = created.get(sn) {
                sqlx::query(set).bind(sn).bind(at).bind(Utc::now()).execute(pool).await?;
                found.insert(sn.clone());
                done += 1;
            }
        }
    }
    let missing: Vec<&String> = sns.iter().filter(|s| !found.contains(*s)).collect();
    if !missing.is_empty() {
        // the account's own device list carries the same date
        let listed = match client.account_create_times(20).await {
            Ok(l) => l,
            Err(e) => {
                tracing::warn!(target: LOG, "queryDeviceList failed: {}", SyncError::from(e).message());
                BTreeMap::new()
            }
        };
        for sn in missing {
            if let Some(at) = listed.get(sn) {
                sqlx::query(set).bind(sn).bind(at).bind(Utc::now()).execute(pool).await?;
                done += 1;
            }
        }
    }
    Ok(done)
}

/// Python `_sync_missing_dataloggers`: `device/sn_datalog` for the installed inverters
/// `device/list` named no datalogger for (usually none). A blank answer leaves it blank; the row's
/// `synced_at` is stamped either way.
pub async fn sync_missing_dataloggers(pool: &PgPool, client: &GrowattClient, plant_ids: &[i32], now: DateTime<Utc>, pause_s: f64) -> Result<usize> {
    let sns: Vec<String> = sqlx::query_scalar(
        "SELECT device_sn FROM growatt_inverters WHERE plant_id = ANY($1) AND not_installed_at IS NULL \
         AND (datalogger_sn IS NULL OR datalogger_sn = '') ORDER BY device_sn",
    )
    .bind(plant_ids)
    .fetch_all(pool)
    .await?;
    let mut sw = Sweep::new("device/sn_datalog", pause_s);
    for sn in sns {
        sw.before().await;
        let dl = match sw.after(client.device_datalogger(&sn).await) {
            Next::Write(d) => d,
            Next::Skip => continue,
            Next::Stop => break,
        };
        sqlx::query("UPDATE growatt_inverters SET datalogger_sn = COALESCE($2, datalogger_sn), synced_at = $3 WHERE device_sn = $1")
            .bind(&sn)
            .bind(&dl)
            .bind(now)
            .execute(pool)
            .await?;
        sw.done += 1;
    }
    Ok(sw.done)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn coords_swap_back_or_drop() {
        assert_eq!(normalize_coords(&json!("13.7"), &json!(100.5)), (Some(13.7), Some(100.5)));
        assert_eq!(normalize_coords(&json!(100.5), &json!(13.7)), (Some(13.7), Some(100.5)));
        assert_eq!(normalize_coords(&json!(50), &json!(50)), (None, None));
        assert_eq!(normalize_coords(&json!(""), &json!(100.5)), (None, None));
        assert_eq!(normalize_coords(&Value::Null, &json!(100.5)), (None, None));
    }

    #[test]
    fn addresses_parse_like_int_of_str() {
        assert_eq!(address_of(&json!("1")), Some(1));
        assert_eq!(address_of(&json!(" 2 ")), Some(2));
        assert_eq!(address_of(&json!(3)), Some(3));
        assert_eq!(address_of(&json!(3.0)), None);
        assert_eq!(address_of(&json!("x")), None);
        assert_eq!(address_of(&Value::Null), None);
        assert_eq!(address_of(&json!(true)), None);
    }

    #[test]
    fn error_classes() {
        assert_eq!(class_of("TypeError: bad"), ("TypeError", "bad"));
        assert_eq!(class_of("no class here"), ("Exception", "no class here"));
        assert_eq!(int_list(&[3009, 3010]), "[3009, 3010]");
    }
}
