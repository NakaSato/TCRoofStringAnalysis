//! The `google_weather` history job: port of backend/app/services/google_weather.py
//! `history_lookback_hours`, `history_hours_left`, `month_usage`, `fleet_cells` (with
//! coordinates), `_store_hours`, `_oldest_first`, `sync_history` and `run_history_job`.
//!
//! One `history/hours` call per plant grid cell stores today's daytime hours (modelled by Google,
//! never measured) in `google_weather_hourly`, within today's call budget and Google's per-day
//! history-hour quota (both counted per US/Pacific billing day in `external_api_call_counts`).
//! The first HTTP 429 stops the run's remaining calls; refused calls are not counted.

use std::collections::{BTreeMap, HashMap};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use chrono::{Duration, NaiveDate, NaiveDateTime, Utc};
use serde_json::{json, Map, Value};
use sqlx::PgPool;
use tcroof_clients::google_weather::{GoogleWeatherClient, GoogleWeatherError, HistoryHour, DEFAULT_TIMEOUT_S};

use crate::google_weather_live::{allowance, billing_day, calls, calls_today, month, record_calls, remaining, API_HISTORY};
use crate::google_weather_stored::{cell_of, GoogleWeatherConfig};

/// Python `API_HISTORY_HOURS`: hours returned by `history/hours`, counted per billing day
pub const API_HISTORY_HOURS: &str = "google_weather_history_hours";
/// Python `FETCH_WORKERS`
pub const FETCH_WORKERS: usize = 8;
/// Python `GoogleWeatherClient.history_hours` default `max_pages`
const MAX_PAGES: u32 = 2;

/// The settings the job reads (Python `settings.google_weather_*`).
#[derive(Debug, Clone)]
pub struct HistoryConfig {
    /// `GOOGLE_WEATHER_API_KEY` (empty = the job is skipped)
    pub api_key: String,
    /// `GOOGLE_WEATHER_BASE_URL`
    pub base_url: String,
    /// `GOOGLE_WEATHER_MONTHLY_BUDGET` (30000)
    pub monthly_budget: i64,
    /// `GOOGLE_WEATHER_HISTORY_HOURS_PER_DAY` (4000)
    pub history_hours_per_day: i64,
    /// cell size and the daytime window
    pub cells: GoogleWeatherConfig,
}

/// A run that could not finish.
#[derive(Debug, thiserror::Error)]
pub enum HistoryError {
    /// Python `RuntimeError("every Google Weather call failed: …")`
    #[error("every Google Weather call failed: {0}")]
    AllFailed(String),
    #[error(transparent)]
    Db(#[from] sqlx::Error),
}

impl From<crate::common::ServiceError> for HistoryError {
    fn from(e: crate::common::ServiceError) -> Self {
        match e {
            crate::common::ServiceError::Db(e) => HistoryError::Db(e),
            other => HistoryError::Db(sqlx::Error::Protocol(other.to_string())),
        }
    }
}

/// Python `history_lookback_hours`: hours back to the start of the latest daytime window that has
/// begun (today's, or yesterday's before it opens), rounded up, 1..=24.
pub fn history_lookback_hours(now: NaiveDateTime, start_h: i64) -> u32 {
    let opened_today = now.date().and_hms_opt(start_h.clamp(0, 23) as u32, 0, 0).expect("valid hour");
    let opened = if now < opened_today { opened_today - Duration::days(1) } else { opened_today };
    let d = now - opened;
    let secs = d.num_seconds() as f64 + f64::from(d.subsec_nanos()) / 1e9;
    (secs / 3600.0).ceil().clamp(1.0, 24.0) as u32
}

/// Python `history_hours_left`: history hours Google's per-day quota still allows today.
pub async fn history_hours_left(pool: &PgPool, per_day: i64, day: NaiveDate) -> Result<i64, HistoryError> {
    Ok((per_day - calls(pool, day, day + Duration::days(1), Some(API_HISTORY_HOURS)).await?).max(0))
}

/// Python `month_usage`
pub async fn month_usage(pool: &PgPool, monthly_budget: i64, day: NaiveDate) -> Result<Value, HistoryError> {
    let (first, next) = month(day);
    Ok(json!({
        "billing_day": day.to_string(),
        "monthly_budget": monthly_budget,
        "used_this_month": calls(pool, first, next, None).await?,
        "allowance_today": allowance(pool, monthly_budget, day).await?,
        "used_today": calls_today(pool, None, day).await?,
    }))
}

/// Python `fleet_cells`: every cell holding a plant with coordinates (the first plant by id sets
/// the cell's point), sorted by key.
pub async fn fleet_cell_points(pool: &PgPool, cell_deg: f64) -> Result<BTreeMap<String, (f64, f64)>, HistoryError> {
    let rows: Vec<(Option<f64>, Option<f64>)> =
        sqlx::query_as("SELECT latitude, longitude FROM growatt_plants ORDER BY plant_id").fetch_all(pool).await?;
    let mut out = BTreeMap::new();
    for (lat, lon) in rows {
        if let (Some(lat), Some(lon)) = (lat, lon) {
            let (k, clat, clon) = cell_of(lat, lon, cell_deg);
            out.entry(k).or_insert((clat, clon));
        }
    }
    Ok(out)
}

/// Python `_oldest_first`: cells with no stored hours first, then the stalest, then by key.
async fn oldest_first(pool: &PgPool, cells: &BTreeMap<String, (f64, f64)>) -> Result<Vec<(String, (f64, f64))>, HistoryError> {
    let latest: HashMap<String, Option<NaiveDateTime>> =
        sqlx::query_as::<_, (String, Option<NaiveDateTime>)>("SELECT cell_key, max(hour) FROM google_weather_hourly GROUP BY cell_key")
            .fetch_all(pool)
            .await?
            .into_iter()
            .collect();
    let mut v: Vec<(String, (f64, f64))> = cells.iter().map(|(k, p)| (k.clone(), *p)).collect();
    v.sort_by(|a, b| {
        let la = latest.get(&a.0).copied().flatten();
        let lb = latest.get(&b.0).copied().flatten();
        (la.is_some(), la.unwrap_or(NaiveDateTime::MIN), &a.0).cmp(&(lb.is_some(), lb.unwrap_or(NaiveDateTime::MIN), &b.0))
    });
    Ok(v)
}

/// Python `_store_hours`: daytime hours only; re-fetched hours replace the stored ones.
async fn store_hours(pool: &PgPool, cfg: &GoogleWeatherConfig, cell_key: &str, rows: &[HistoryHour]) -> Result<usize, HistoryError> {
    use chrono::Timelike;
    let rows: Vec<&HistoryHour> = rows.iter().filter(|r| cfg.in_window(r.hour_local.hour())).collect();
    if rows.is_empty() {
        return Ok(0);
    }
    let lo = rows.iter().map(|r| r.hour_local).min().expect("rows");
    let hi = rows.iter().map(|r| r.hour_local).max().expect("rows");
    let mut tx = pool.begin().await?;
    sqlx::query("DELETE FROM google_weather_hourly WHERE cell_key = $1 AND hour >= $2 AND hour <= $3")
        .bind(cell_key)
        .bind(lo)
        .bind(hi)
        .execute(&mut *tx)
        .await?;
    let now = Utc::now();
    let mut seen = std::collections::HashSet::new();
    for r in rows {
        if !seen.insert(r.hour_local) {
            continue;
        }
        let c = &r.conditions;
        sqlx::query(
            "INSERT INTO google_weather_hourly (cell_key, hour, fetched_at, condition, is_daytime, temp_c, feels_like_c, \
             dew_point_c, humidity_pct, cloud_cover_pct, uv_index, precip_mm, precip_prob_pct, thunder_prob_pct, \
             wind_speed_ms, wind_gust_ms, wind_dir_deg, pressure_hpa, visibility_km) \
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)",
        )
        .bind(cell_key)
        .bind(r.hour_local)
        .bind(now)
        .bind(&c.condition)
        .bind(c.is_daytime)
        .bind(c.temp_c)
        .bind(c.feels_like_c)
        .bind(c.dew_point_c)
        .bind(c.humidity_pct)
        .bind(c.cloud_cover_pct)
        .bind(c.uv_index)
        .bind(c.precip_mm)
        .bind(c.precip_prob_pct)
        .bind(c.thunder_prob_pct)
        .bind(c.wind_speed_ms)
        .bind(c.wind_gust_ms)
        .bind(c.wind_dir_deg)
        .bind(c.pressure_hpa)
        .bind(c.visibility_km)
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;
    Ok(seen.len())
}

const QUOTA_SKIPPED: &str = "skipped: Google daily quota exceeded (HTTP 429)";

/// Python `sync_history`: store today's daytime hours (see [`history_lookback_hours`]) for every
/// cell (default: the fleet's), within today's call budget and Google's per-day history-hour quota.
/// Returns `(status, detail)`: `partial` when a cell failed or was skipped.
pub async fn sync_history(
    pool: &PgPool,
    client: Arc<GoogleWeatherClient>,
    cfg: &HistoryConfig,
    cells: Option<BTreeMap<String, (f64, f64)>>,
    workers: usize,
    now_local: NaiveDateTime,
) -> Result<(String, Value), HistoryError> {
    let cells = match cells {
        Some(c) => c,
        None => fleet_cell_points(pool, cfg.cells.cell_deg).await?,
    };
    let hours = history_lookback_hours(now_local, cfg.cells.day_start_h);
    let day = billing_day();
    let left = remaining(pool, cfg.monthly_budget, cfg.cells.cell_deg, API_HISTORY, day)
        .await?
        .min(history_hours_left(pool, cfg.history_hours_per_day, day).await? / i64::from(hours))
        .max(0) as usize;
    let mut todo = oldest_first(pool, &cells).await?;
    todo.truncate(left);
    let skipped = cells.len() - todo.len();

    // the fetches, at most `workers` at a time; results in `todo` order (Python `pool.map`)
    let quota_hit = Arc::new(AtomicBool::new(false));
    let sem = Arc::new(tokio::sync::Semaphore::new(workers.max(1)));
    let calls_before = client.calls();
    let mut handles = Vec::with_capacity(todo.len());
    for (key, (lat, lon)) in todo.iter().cloned() {
        let (client, quota_hit, sem) = (client.clone(), quota_hit.clone(), sem.clone());
        handles.push(tokio::spawn(async move {
            let _permit = sem.acquire_owned().await.expect("semaphore");
            if quota_hit.load(Ordering::SeqCst) {
                return (key, Err(QUOTA_SKIPPED.to_owned()));
            }
            match client.history_hours(lat, lon, hours, MAX_PAGES).await {
                Ok(rows) => (key, Ok(rows)),
                Err(GoogleWeatherError { message, .. }) => {
                    if message.contains("HTTP 429") {
                        quota_hit.store(true, Ordering::SeqCst);
                    }
                    (key, Err(message))
                }
            }
        }));
    }
    let mut results: Vec<(String, Result<Vec<HistoryHour>, String>)> = Vec::with_capacity(handles.len());
    for h in handles {
        results.push(h.await.unwrap_or_else(|e| (String::new(), Err(format!("fetch task failed: {e}")))));
    }
    let refused = results.iter().filter(|(_, r)| matches!(r, Err(m) if m.contains("HTTP 429") && !m.starts_with("skipped"))).count() as i64;
    let n_calls = client.calls() as i64 - calls_before as i64 - refused; // a call Google refused with 429 is not billed
    record_calls(pool, API_HISTORY, n_calls, billing_day()).await?;

    let (mut stored, mut hours_returned) = (0usize, 0usize);
    let mut failed: Vec<(String, String)> = Vec::new();
    for (key, res) in &results {
        match res {
            Err(m) => failed.push((key.clone(), m.clone())),
            Ok(rows) => {
                hours_returned += rows.len();
                stored += store_hours(pool, &cfg.cells, key, rows).await?;
            }
        }
    }
    record_calls(pool, API_HISTORY_HOURS, hours_returned as i64, billing_day()).await?;
    if let Some((_, first)) = failed.first() {
        tracing::warn!(target: "google_weather", "google weather: {} of {} cells failed, e.g. {}", failed.len(), todo.len(), first);
    }
    if skipped > 0 {
        tracing::warn!(target: "google_weather",
            "google weather: {} of {} cells skipped (call budget / daily history-hour quota)", skipped, cells.len());
    }
    let day = billing_day();
    let errors: Map<String, Value> = failed.iter().take(5).map(|(k, m)| (k.clone(), json!(m))).collect();
    let detail = json!({
        "cells": cells.len(),
        "lookback_hours": hours,
        "fetched": todo.len() - failed.len(),
        "failed": failed.len(),
        "skipped_budget": skipped,
        "hours_stored": stored,
        "hours_returned": hours_returned,
        "history_hours_left_today": history_hours_left(pool, cfg.history_hours_per_day, day).await?,
        "calls": n_calls,
        "calls_today": calls_today(pool, None, day).await?,
        "usage": month_usage(pool, cfg.monthly_budget, day).await?,
        "google_quota_exceeded": quota_hit.load(Ordering::SeqCst),
        "errors": errors,
    });
    if !todo.is_empty() && failed.len() == todo.len() {
        return Err(HistoryError::AllFailed(failed[0].1.clone()));
    }
    let status = if !failed.is_empty() || skipped > 0 { "partial" } else { "ok" };
    Ok((status.to_owned(), detail))
}

/// Python `run_history_job`: skipped without a key.
pub async fn run_history_job(pool: &PgPool, cfg: &HistoryConfig, now_local: NaiveDateTime) -> Result<(String, Value), HistoryError> {
    if cfg.api_key.is_empty() {
        return Ok(("ok".into(), json!({"skipped": "GOOGLE_WEATHER_API_KEY not set"})));
    }
    let client = GoogleWeatherClient::new(&cfg.api_key, &cfg.base_url, DEFAULT_TIMEOUT_S)
        .map_err(|e| HistoryError::AllFailed(e.message))?;
    sync_history(pool, Arc::new(client), cfg, None, FETCH_WORKERS, now_local).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(h: u32, m: u32, s: u32) -> NaiveDateTime {
        NaiveDate::from_ymd_opt(2026, 11, 28).unwrap().and_hms_opt(h, m, s).unwrap()
    }

    #[test]
    fn lookback_reaches_the_latest_window_start() {
        assert_eq!(history_lookback_hours(at(18, 15, 0), 6), 13);
        assert_eq!(history_lookback_hours(at(6, 0, 0), 6), 1); // max(1, 0)
        assert_eq!(history_lookback_hours(at(6, 0, 1), 6), 1);
        assert_eq!(history_lookback_hours(at(7, 0, 1), 6), 2);
        assert_eq!(history_lookback_hours(at(5, 0, 0), 6), 23); // yesterday 06:00
        assert_eq!(history_lookback_hours(at(5, 30, 0), 6), 24);
    }
}
