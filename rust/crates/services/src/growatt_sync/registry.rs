//! Port of `backend/app/services/growatt_sync/registry.py`: the fleet registry (plants,
//! inverters, weather sensors, meters and their static details; the `fleet` job) and the removal
//! of blocked plants. Realtime fields of the lists (current power, status, lost) are never stored.

use chrono::{DateTime, NaiveDateTime, Utc};
use serde_json::Value;
use sqlx::PgPool;
use tcroof_clients::growatt::{py, GrowattClient, GrowattError, MaxInfo};

use super::{env::sync_env_sensors, fnum, meters::sync_meters, phase_text, retry, text_value, upsert, SyncOptions};
use super::{SyncError, SyncResult, B, BATCH, RATE_LIMIT_CODE};

/// Python `registry._LAT_RANGE` / `_LON_RANGE`: the fleet's bounding box (Thailand)
pub const LAT_RANGE: (f64, f64) = (5.0, 21.0);
pub const LON_RANGE: (f64, f64) = (97.0, 106.0);
/// Python `INFO_REFRESH_HOURS`: settings can change, re-read on each daily fleet run
pub const INFO_REFRESH_HOURS: i64 = 20;
/// Python `INFO_MAX_RATE_LIMITED`
pub const INFO_MAX_RATE_LIMITED: usize = 3;
/// Python `DETAILS_REFRESH_DAYS` (`plant/details`)
pub const DETAILS_REFRESH_DAYS: i64 = 7;
/// Python `PARAM_REFRESH_DAYS` (`queryDeviceInfoParam`)
pub const PARAM_REFRESH_DAYS: i64 = 30;
/// Python `REGISTRY_MAX_RATE_LIMITED`
pub const REGISTRY_MAX_RATE_LIMITED: usize = 3;
/// Python `CREATE_DATE_CHUNK`: serials per `device/all/create_date` call
pub const CREATE_DATE_CHUNK: usize = 50;

/// Python `registry.normalize_coords`: (lat, lon) as floats, swapped back when Growatt reported
/// them reversed; a pair that fits the fleet area neither way round is dropped (None, None).
pub fn normalize_coords(lat: &Value, lon: &Value) -> (Option<f64>, Option<f64>) {
    let (Some(la), Some(lo)) = (fnum(lat), fnum(lon)) else { return (None, None) };
    let fits = |a: f64, b: f64| LAT_RANGE.0 <= a && a <= LAT_RANGE.1 && LON_RANGE.0 <= b && b <= LON_RANGE.1;
    if fits(la, lo) {
        (Some(la), Some(lo))
    } else if fits(lo, la) {
        (Some(lo), Some(la))
    } else {
        (None, None)
    }
}

/// Python `registry.remove_blocked_plants`: take the blocked plants (`GROWATT_BLOCKED_PLANT_IDS`)
/// out of the registry, with their issues, cleaning-suggestion marks, Calendar tasks, plan links
/// and settings, document links and site-register stations (the plant row cascades to inverters,
/// sensors, meters, readings and the alarm log). Returns the ids removed. One transaction.
pub async fn remove_blocked_plants(pool: &PgPool, plant_ids: &[i64]) -> SyncResult<Vec<i64>> {
    let mut ids: Vec<i32> = plant_ids.iter().filter_map(|&p| i32::try_from(p).ok()).collect();
    ids.sort_unstable();
    ids.dedup();
    if ids.is_empty() {
        return Ok(Vec::new());
    }
    let found: Vec<i32> = sqlx::query_scalar("SELECT plant_id FROM growatt_plants WHERE plant_id = ANY($1) ORDER BY plant_id")
        .bind(&ids)
        .fetch_all(pool)
        .await?;
    if !found.is_empty() {
        let mut tx = pool.begin().await?;
        for sql in [
            "DELETE FROM growatt_issues WHERE plant_id = ANY($1)",
            // om_suggestions.delete_plant_rows (before their tasks)
            "DELETE FROM om_cleaning_suggestion_marks WHERE plant_id = ANY($1)",
            "DELETE FROM om_tasks WHERE plant_id = ANY($1)",
            // om_plans.delete_plant_rows
            "DELETE FROM om_plan_plants WHERE plant_id = ANY($1)",
            "DELETE FROM om_plant_settings WHERE plant_id = ANY($1)",
            // plant_documents.delete_plant_rows
            "DELETE FROM plant_documents WHERE plant_id = ANY($1)",
            // site_register.delete_plant_rows
            "DELETE FROM site_devices WHERE site_code IN (SELECT site_code FROM site_register WHERE plant_id = ANY($1))",
            "DELETE FROM site_register WHERE plant_id = ANY($1)",
            "DELETE FROM growatt_plants WHERE plant_id = ANY($1)",
        ] {
            sqlx::query(sql).bind(&found).execute(&mut *tx).await?;
        }
        tx.commit().await?;
        tracing::info!("blocked plants removed from the registry: {found:?}");
    }
    Ok(found.into_iter().map(i64::from).collect())
}

/// Python `registry.sync_fleet`: upsert the plants and inverters of one Growatt account (tagging
/// each plant with `phase`; None keeps the stored tag), register their weather sensors and
/// meters, then the detail sweeps (inverter info / settings, plant details, inverter model,
/// creation date, missing dataloggers). Returns that account's installed inverters' serials
/// (plant, serial order). A failed plant or inverter list fails the run; a failed sweep does not.
pub async fn sync_fleet(
    pool: &PgPool,
    client: &GrowattClient,
    opts: &SyncOptions,
    pause_s: f64,
    phase: Option<i32>,
) -> SyncResult<Vec<String>> {
    let now = Utc::now();
    let label = format!("phase {} plant/list", phase_text(phase));
    let plants = retry(opts, &label, 3, || client.list_plants(true)).await?;
    let mut pids: Vec<i64> = Vec::new();
    let mut rows = Vec::new();
    for p in &plants {
        let pid = py::int(py::get(p, "plant_id"))?;
        pids.push(pid);
        let name = py::get(p, "name");
        let name = if py::truthy(name) { text_value(name) } else { Some(py::str_of(py::get(p, "plant_id"))) };
        let (lat, lon) = normalize_coords(py::get(p, "latitude"), py::get(p, "longitude"));
        let mut row = vec![
            B::I32(Some(pid as i32)),
            B::Text(name),
            B::Text(text_value(py::get(p, "city"))),
            B::Text(text_value(py::get(p, "country"))),
            B::F64(lat),
            B::F64(lon),
            // current power / total energy / status are realtime: served live, never stored
            B::F64(fnum(py::get(p, "peak_power"))),
            B::Text(text_value(py::get(p, "create_date"))),
            B::Tz(Some(now)),
        ];
        if let Some(ph) = phase {
            row.push(B::I32(Some(ph)));
        }
        rows.push(row);
    }
    let mut cols = vec![
        "plant_id", "name", "city", "country", "latitude", "longitude", "peak_power_kwp", "create_date", "synced_at",
    ];
    if phase.is_some() {
        cols.push("phase");
    }
    let mut conn = pool.acquire().await?;
    upsert(&mut conn, "growatt_plants", &cols, &["plant_id"], rows, BATCH).await?;
    drop(conn);
    tracing::info!("phase {} plants: {}", phase_text(phase), plants.len());

    for &pid in &pids {
        let label = format!("plant {pid} device/list");
        let invs = retry(opts, &label, 3, || client.list_inverters(pid, true)).await?;
        let rows = invs
            .iter()
            .map(|inv| {
                vec![
                    B::Text(Some(inv.device_sn.clone())),
                    B::I32(Some(pid as i32)),
                    B::Text(text_value(&inv.datalogger_sn)),
                    B::Text(text_value(&inv.model)),
                    B::Text(Some(inv.device_types.join(","))),
                    // status / lost / last_update_time are realtime: served live, never stored
                    B::Tz(Some(now)),
                ]
            })
            .collect();
        let mut conn = pool.acquire().await?;
        upsert(
            &mut conn,
            "growatt_inverters",
            &["device_sn", "plant_id", "datalogger_sn", "model", "device_types", "synced_at"],
            &["device_sn"],
            rows,
            BATCH,
        )
        .await?;
        drop(conn);
        tracing::info!("plant {pid}: {} inverters", invs.len());
        match sync_env_sensors(pool, client, opts, pid, now).await {
            Ok(n) if n > 0 => tracing::info!("plant {pid}: {n} weather sensors"),
            Ok(_) => {}
            Err(e) => tracing::error!("plant {pid} weather-sensor discovery failed: {e}"),
        }
        match sync_meters(pool, client, opts, pid, now).await {
            Ok(n) if n > 0 => tracing::debug!("plant {pid}: {n} meters"),
            Ok(_) => {}
            Err(e) => tracing::error!("plant {pid} meter discovery failed: {e}"),
        }
        opts.sleep(pause_s).await;
    }
    let ids: Vec<i32> = pids.iter().map(|&p| p as i32).collect();
    match sync_inverter_info(pool, client, opts, &ids, now, pause_s).await {
        Ok(n) => tracing::info!("phase {}: inverter info/settings read for {n} inverters", phase_text(phase)),
        Err(e) => tracing::error!("phase {} inverter info sweep failed: {e}", phase_text(phase)),
    }
    for (label, res) in [
        ("plant details", sync_plant_details(pool, client, opts, &ids, now, pause_s).await),
        ("inverter model", sync_device_params(pool, client, opts, &ids, now, pause_s).await),
        ("inverter creation date", sync_create_dates(pool, client, opts, &ids, pause_s).await),
        ("inverter datalogger", sync_missing_dataloggers(pool, client, opts, &ids, now, pause_s).await),
    ] {
        match res {
            Ok(n) => tracing::info!("phase {}: {label} read for {n}", phase_text(phase)),
            Err(e) => tracing::error!("phase {} {label} sweep failed: {e}", phase_text(phase)),
        }
    }
    Ok(sqlx::query_scalar(
        "SELECT device_sn FROM growatt_inverters WHERE plant_id = ANY($1) AND not_installed_at IS NULL \
         ORDER BY plant_id, device_sn",
    )
    .bind(&ids)
    .fetch_all(pool)
    .await?)
}

/// `last` older than `cutoff`, or never (Python `_due`)
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

/// Python `registry._sync_inverter_info`: name, rating, firmware and settings of the plants'
/// inverters never read or read more than [`INFO_REFRESH_HOURS`] ago, oldest first. At the first
/// 10012 of `max_data_info` the sweep goes on with `queryDeviceInfo`; [`INFO_MAX_RATE_LIMITED`]
/// 10012s in a row end it. An answer without data is not stamped. Every field read is written,
/// a blank one as NULL (as Python's `setattr` of each key).
async fn sync_inverter_info(
    pool: &PgPool,
    client: &GrowattClient,
    opts: &SyncOptions,
    plant_ids: &[i32],
    now: DateTime<Utc>,
    pause_s: f64,
) -> SyncResult<usize> {
    let cutoff = now - chrono::Duration::hours(INFO_REFRESH_HOURS);
    let invs: Vec<(String, Option<DateTime<Utc>>)> = sqlx::query_as(
        "SELECT device_sn, info_synced_at FROM growatt_inverters WHERE plant_id = ANY($1) AND not_installed_at IS NULL \
         ORDER BY (info_synced_at IS NOT NULL), info_synced_at, device_sn",
    )
    .bind(plant_ids)
    .fetch_all(pool)
    .await?;
    let (mut done, mut in_a_row) = (0usize, 0usize);
    let mut fallback = false;
    for (sn, last) in invs {
        if last.is_some_and(|l| l > cutoff) {
            continue;
        }
        let res = if fallback {
            client.device_info(&sn).await
        } else {
            match client.max_info(&sn).await {
                Err(e) if e.is_rate_limited() => {
                    fallback = true;
                    tracing::info!("max_data_info rate limited after {done} inverters; continuing with queryDeviceInfo");
                    client.device_info(&sn).await
                }
                other => other,
            }
        };
        let info = match res {
            Ok(i) => i,
            Err(GrowattError::Api(a)) if a.code() == Some(RATE_LIMIT_CODE) => {
                in_a_row += 1;
                if in_a_row >= INFO_MAX_RATE_LIMITED {
                    tracing::warn!("inverter info rate limited after {done} inverters; the rest wait for the next run");
                    break;
                }
                opts.sleep(pause_s).await;
                continue;
            }
            Err(e) => {
                in_a_row = 0;
                tracing::warn!("inverter {sn} info failed: {e}");
                continue;
            }
        };
        in_a_row = 0;
        if all_none(&info) {
            tracing::warn!("inverter {sn} info returned no data");
            continue;
        }
        sqlx::query(
            "UPDATE growatt_inverters SET alias = $1, nominal_power_w = $2, fw_version = $3, inner_version = $4, \
             active_rate_pct = $5, reactive_rate_pct = $6, pf_setting = $7, pf_model = $8, export_limit = $9, \
             export_limit_rate_pct = $10, on_off = $11, info_synced_at = $12, synced_at = now() WHERE device_sn = $13",
        )
        .bind(&info.alias)
        .bind(info.nominal_power_w)
        .bind(&info.fw_version)
        .bind(&info.inner_version)
        .bind(info.active_rate_pct)
        .bind(info.reactive_rate_pct)
        .bind(info.pf_setting)
        .bind(info.pf_model.map(|v| v as i32))
        .bind(info.export_limit.map(|v| v as i32))
        .bind(info.export_limit_rate_pct)
        .bind(info.on_off.map(|v| v as i32))
        .bind(now)
        .bind(&sn)
        .execute(pool)
        .await?;
        done += 1;
        opts.sleep(pause_s).await;
    }
    Ok(done)
}

/// One read of Python `_registry_sweep`: the Growatt answer, or why there is none.
enum Read<T> {
    Ok(T),
    RateLimited,
    Skip,
}

fn classify<T>(label: &str, r: Result<T, GrowattError>) -> Read<T> {
    match r {
        Ok(v) => Read::Ok(v),
        Err(GrowattError::Api(a)) if a.code() == Some(RATE_LIMIT_CODE) => Read::RateLimited,
        Err(e @ GrowattError::Api(_)) => {
            tracing::debug!("{label} failed: {e}");
            Read::Skip
        }
        Err(e) => {
            tracing::warn!("{label} failed: {e}");
            Read::Skip
        }
    }
}

/// Python `registry._sync_plant_details`: `plant/details` (time zone, address, Growatt's inverter /
/// datalogger counts) for the plants never read or read more than [`DETAILS_REFRESH_DAYS`] ago,
/// oldest first. A blank answer never erases a stored value.
async fn sync_plant_details(
    pool: &PgPool,
    client: &GrowattClient,
    opts: &SyncOptions,
    plant_ids: &[i32],
    now: DateTime<Utc>,
    pause_s: f64,
) -> SyncResult<usize> {
    let cutoff = now - chrono::Duration::days(DETAILS_REFRESH_DAYS);
    let plants: Vec<(i32, Option<DateTime<Utc>>)> = sqlx::query_as(
        "SELECT plant_id, details_synced_at FROM growatt_plants WHERE plant_id = ANY($1) \
         ORDER BY (details_synced_at IS NOT NULL), details_synced_at, plant_id",
    )
    .bind(plant_ids)
    .fetch_all(pool)
    .await?;
    let (mut done, mut in_a_row, mut asked) = (0usize, 0usize, 0usize);
    for (pid, _) in plants.into_iter().filter(|(_, l)| due(*l, cutoff)) {
        if asked > 0 {
            opts.sleep(pause_s).await;
        }
        asked += 1;
        let d = match classify("plant/details", client.plant_details(i64::from(pid)).await) {
            Read::Ok(d) => d,
            Read::RateLimited => {
                in_a_row += 1;
                if in_a_row >= REGISTRY_MAX_RATE_LIMITED {
                    tracing::warn!("plant/details rate limited after {done} reads; the rest wait for the next run");
                    break;
                }
                continue;
            }
            Read::Skip => {
                in_a_row = 0;
                continue;
            }
        };
        in_a_row = 0;
        sqlx::query(
            "UPDATE growatt_plants SET timezone = COALESCE($1, timezone), address = COALESCE($2, address), \
             growatt_inverter_count = COALESCE($3, growatt_inverter_count), \
             growatt_datalogger_count = COALESCE($4, growatt_datalogger_count), details_synced_at = $5, synced_at = now() WHERE plant_id = $6",
        )
        .bind(&d.timezone)
        .bind(&d.address)
        .bind(d.growatt_inverter_count.map(|v| v as i32))
        .bind(d.growatt_datalogger_count.map(|v| v as i32))
        .bind(now)
        .bind(pid)
        .execute(pool)
        .await?;
        done += 1;
    }
    Ok(done)
}

/// Python `registry._sync_device_params`: `queryDeviceInfoParam` (model text, datalogger model,
/// rated power) for the inverters never read or read more than [`PARAM_REFRESH_DAYS`] ago.
async fn sync_device_params(
    pool: &PgPool,
    client: &GrowattClient,
    opts: &SyncOptions,
    plant_ids: &[i32],
    now: DateTime<Utc>,
    pause_s: f64,
) -> SyncResult<usize> {
    let cutoff = now - chrono::Duration::days(PARAM_REFRESH_DAYS);
    let invs: Vec<(String, Option<DateTime<Utc>>)> = sqlx::query_as(
        "SELECT device_sn, param_synced_at FROM growatt_inverters WHERE plant_id = ANY($1) AND not_installed_at IS NULL \
         ORDER BY (param_synced_at IS NOT NULL), param_synced_at, device_sn",
    )
    .bind(plant_ids)
    .fetch_all(pool)
    .await?;
    let (mut done, mut in_a_row, mut asked) = (0usize, 0usize, 0usize);
    for (sn, _) in invs.into_iter().filter(|(_, l)| due(*l, cutoff)) {
        if asked > 0 {
            opts.sleep(pause_s).await;
        }
        asked += 1;
        let p = match classify("queryDeviceInfoParam", client.device_info_param(&sn).await) {
            Read::Ok(p) => p,
            Read::RateLimited => {
                in_a_row += 1;
                if in_a_row >= REGISTRY_MAX_RATE_LIMITED {
                    tracing::warn!("queryDeviceInfoParam rate limited after {done} reads; the rest wait for the next run");
                    break;
                }
                continue;
            }
            Read::Skip => {
                in_a_row = 0;
                continue;
            }
        };
        in_a_row = 0;
        sqlx::query(
            "UPDATE growatt_inverters SET device_model = COALESCE($1, device_model), \
             datalogger_model = COALESCE($2, datalogger_model), rated_power_w = COALESCE($3, rated_power_w), \
             param_synced_at = $4, synced_at = now() WHERE device_sn = $5",
        )
        .bind(&p.device_model)
        .bind(&p.datalogger_model)
        .bind(p.rated_power_w)
        .bind(now)
        .bind(&sn)
        .execute(pool)
        .await?;
        done += 1;
    }
    Ok(done)
}

/// Python `registry._sync_create_dates`: `device/all/create_date` for the inverters without one,
/// [`CREATE_DATE_CHUNK`] serials per call (read once: the date never changes); the ones it leaves
/// without a date are looked up in the account's device list (`queryDeviceList`). Only Growatt
/// refusals are caught per chunk, as in Python; another failure ends the sweep.
async fn sync_create_dates(
    pool: &PgPool,
    client: &GrowattClient,
    opts: &SyncOptions,
    plant_ids: &[i32],
    pause_s: f64,
) -> SyncResult<usize> {
    let sns: Vec<String> = sqlx::query_scalar(
        "SELECT device_sn FROM growatt_inverters WHERE plant_id = ANY($1) AND not_installed_at IS NULL \
         AND growatt_created_at IS NULL ORDER BY device_sn",
    )
    .bind(plant_ids)
    .fetch_all(pool)
    .await?;
    let mut have: std::collections::HashSet<String> = std::collections::HashSet::new();
    let (mut done, mut in_a_row) = (0usize, 0usize);
    let set = |sn: &str, at: NaiveDateTime| {
        sqlx::query("UPDATE growatt_inverters SET growatt_created_at = $1, synced_at = now() WHERE device_sn = $2").bind(at).bind(sn.to_owned())
    };
    for (ci, chunk) in sns.chunks(CREATE_DATE_CHUNK).enumerate() {
        if ci > 0 {
            opts.sleep(pause_s).await;
        }
        let created = match client.devices_create_time(chunk, 10).await {
            Ok(c) => c,
            Err(GrowattError::Api(a)) => {
                if a.code() == Some(RATE_LIMIT_CODE) {
                    in_a_row += 1;
                    if in_a_row >= REGISTRY_MAX_RATE_LIMITED {
                        tracing::warn!(
                            "device/all/create_date rate limited after {done} inverters; the rest wait for the next run"
                        );
                        break;
                    }
                    continue;
                }
                in_a_row = 0;
                tracing::warn!("device/all/create_date failed: {}", a.message);
                continue;
            }
            Err(e) => return Err(SyncError::from(e)),
        };
        in_a_row = 0;
        let mut tx = pool.begin().await?;
        for sn in chunk {
            if let Some(at) = created.get(sn) {
                set(sn, *at).execute(&mut *tx).await?;
                have.insert(sn.clone());
                done += 1;
            }
        }
        tx.commit().await?;
    }
    let missing: Vec<&String> = sns.iter().filter(|s| !have.contains(*s)).collect();
    if !missing.is_empty() {
        // the account's own device list carries the same date (`new-api/queryDeviceList`)
        let listed = client.account_create_times(20).await.unwrap_or_else(|e| {
            tracing::warn!("queryDeviceList failed: {e}");
            Default::default()
        });
        let mut tx = pool.begin().await?;
        for sn in missing {
            if let Some(at) = listed.get(sn) {
                set(sn, *at).execute(&mut *tx).await?;
                done += 1;
            }
        }
        tx.commit().await?;
    }
    Ok(done)
}

/// Python `registry._sync_missing_dataloggers`: `device/sn_datalog` for the inverters `device/list`
/// named no datalogger for (usually none); `synced_at` is stamped on each answer.
async fn sync_missing_dataloggers(
    pool: &PgPool,
    client: &GrowattClient,
    opts: &SyncOptions,
    plant_ids: &[i32],
    now: DateTime<Utc>,
    pause_s: f64,
) -> SyncResult<usize> {
    let sns: Vec<String> = sqlx::query_scalar(
        "SELECT device_sn FROM growatt_inverters WHERE plant_id = ANY($1) AND not_installed_at IS NULL \
         AND (datalogger_sn IS NULL OR datalogger_sn = '') ORDER BY device_sn",
    )
    .bind(plant_ids)
    .fetch_all(pool)
    .await?;
    let (mut done, mut in_a_row, mut asked) = (0usize, 0usize, 0usize);
    for sn in sns {
        if asked > 0 {
            opts.sleep(pause_s).await;
        }
        asked += 1;
        let dl = match classify("device/sn_datalog", client.device_datalogger(&sn).await) {
            Read::Ok(d) => d,
            Read::RateLimited => {
                in_a_row += 1;
                if in_a_row >= REGISTRY_MAX_RATE_LIMITED {
                    tracing::warn!("device/sn_datalog rate limited after {done} reads; the rest wait for the next run");
                    break;
                }
                continue;
            }
            Read::Skip => {
                in_a_row = 0;
                continue;
            }
        };
        in_a_row = 0;
        sqlx::query("UPDATE growatt_inverters SET datalogger_sn = COALESCE($1, datalogger_sn), synced_at = $2 WHERE device_sn = $3")
            .bind(dl)
            .bind(now)
            .bind(&sn)
            .execute(pool)
            .await?;
        done += 1;
    }
    Ok(done)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn coordinates() {
        assert_eq!(normalize_coords(&json!("13.75"), &json!(100.5)), (Some(13.75), Some(100.5)));
        assert_eq!(normalize_coords(&json!(100.5), &json!(13.75)), (Some(13.75), Some(100.5))); // swapped back
        assert_eq!(normalize_coords(&json!(0), &json!(0)), (None, None));
        assert_eq!(normalize_coords(&json!(""), &json!(100.5)), (None, None));
    }
}
