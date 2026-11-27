//! Persisted data only (`/growatt/plants*`), ported from backend/app/api/routes/growatt/plants.py:
//! the plant list, a plant's inverters, the single-plant overview and its power curve; and the
//! worker job routes of backend/app/api/routes/growatt/sync.py (`/growatt/sync/*`, admin only).
//! No Growatt calls happen here; responses carry `meta.source = "db"` where Python's do.

use axum::extract::{Path, RawQuery, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use chrono::{NaiveDate, NaiveTime};
use serde_json::{json, Value};
use tcroof_services::common::ServiceError;
use tcroof_services::{overview, sync_status};

use crate::error::ApiError;
use crate::extract::{parse_int, AdminUser, PlantRead, Scoped};
use crate::pyfmt::repr_str;
use crate::AppState;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/plants", get(list_growatt_plants))
        .route("/plants/{plant_id}/inverters", get(list_growatt_inverters))
        .route("/plants/{plant_id}/overview", get(get_growatt_plant_overview))
        .route("/plants/{plant_id}/power", get(get_growatt_plant_power))
        // POST /sync/status is the job "status" for Starlette (`/sync/{job}` matches): 404 unknown job
        .route("/sync/status", get(sync_status_route).post(trigger_sync))
        .route("/sync/{job}", post(trigger_sync))
}

// --------------------------------------------------------------------------- query parameters

/// The query string as Starlette reads it: `+` is a space, repeated keys kept in order.
fn query_pairs(raw: Option<&str>) -> Vec<(String, String)> {
    form_urlencoded::parse(raw.unwrap_or("").as_bytes()).into_owned().collect()
}

/// A scalar query parameter: the last value wins (Starlette `QueryParams.get`).
fn last<'a>(pairs: &'a [(String, String)], key: &str) -> Option<&'a str> {
    pairs.iter().rev().find(|(k, _)| k == key).map(|(_, v)| v.as_str())
}

fn unprocessable(field: &str, msg: impl std::fmt::Display) -> ApiError {
    ApiError::Unprocessable(format!("{field}: {msg}"))
}

/// pydantic v2 lax `bool` from a query string.
fn bool_param(pairs: &[(String, String)], key: &str, default: bool) -> Result<bool, ApiError> {
    match last(pairs, key) {
        None => Ok(default),
        Some(s) => match s.trim().to_ascii_lowercase().as_str() {
            "1" | "on" | "t" | "true" | "y" | "yes" => Ok(true),
            "0" | "off" | "f" | "false" | "n" | "no" => Ok(false),
            _ => Err(unprocessable(key, "Input should be a valid boolean, unable to interpret input")),
        },
    }
}

/// pydantic v2 `int` with `ge` / `le` bounds from a query string.
fn int_param(pairs: &[(String, String)], key: &str, default: i64, ge: i64, le: i64) -> Result<i64, ApiError> {
    let Some(s) = last(pairs, key) else { return Ok(default) };
    let v = parse_int(s).ok_or_else(|| unprocessable(key, "Input should be a valid integer, unable to parse string as an integer"))?;
    if v < ge {
        return Err(unprocessable(key, format!("Input should be greater than or equal to {ge}")));
    }
    if v > le {
        return Err(unprocessable(key, format!("Input should be less than or equal to {le}")));
    }
    Ok(v)
}

/// pydantic v2 `date` from a query string: `YYYY-MM-DD`.
fn parse_date(s: &str) -> Option<NaiveDate> {
    let b = s.as_bytes();
    if b.len() != 10 || b[4] != b'-' || b[7] != b'-' {
        return None;
    }
    NaiveDate::parse_from_str(s, "%Y-%m-%d").ok()
}

fn date_param(pairs: &[(String, String)], key: &str) -> Result<Option<NaiveDate>, ApiError> {
    last(pairs, key)
        .map(|s| parse_date(s).ok_or_else(|| unprocessable(key, "Input should be a valid date or datetime, invalid character in year")))
        .transpose()
}

/// pydantic v2 `time` from a query string: `HH:MM[:SS[.ffffff]]`, an optional `Z` / `±HH[:MM]`
/// zone (kept out: only the wall time is used, as Python compares naive slot times).
fn parse_time(s: &str) -> Option<NaiveTime> {
    let mut t = s.strip_suffix(['Z', 'z']).unwrap_or(s);
    if let Some(i) = t.rfind(['+', '-']) {
        let z: String = t[i + 1..].chars().filter(|c| *c != ':').collect();
        if !(z.len() == 2 || z.len() == 4) || !z.bytes().all(|b| b.is_ascii_digit()) {
            return None;
        }
        t = &t[..i];
    }
    let (hms, frac) = match t.split_once('.') {
        Some((a, f)) => (a, Some(f)),
        None => (t, None),
    };
    let parts: Vec<&str> = hms.split(':').collect();
    if !(2..=3).contains(&parts.len()) || parts.iter().any(|p| p.len() != 2 || !p.bytes().all(|b| b.is_ascii_digit())) {
        return None;
    }
    let h: u32 = parts[0].parse().ok()?;
    let m: u32 = parts[1].parse().ok()?;
    let sec: u32 = if parts.len() == 3 { parts[2].parse().ok()? } else { 0 };
    let micro = match frac {
        None => 0,
        Some(f) if parts.len() == 3 && !f.is_empty() && f.bytes().all(|b| b.is_ascii_digit()) => {
            f.chars().chain(std::iter::repeat('0')).take(6).collect::<String>().parse().ok()?
        }
        Some(_) => return None,
    };
    NaiveTime::from_hms_micro_opt(h, m, sec, micro)
}

fn time_param(pairs: &[(String, String)], key: &str) -> Result<Option<NaiveTime>, ApiError> {
    last(pairs, key).map(|s| parse_time(s).ok_or_else(|| unprocessable(key, "Input should be in a valid time format"))).transpose()
}

/// A service error the way the Python routes translate it: `GrowattNotFound` → 404, `ValueError` → 422.
fn service_err(e: ServiceError) -> ApiError {
    match e {
        ServiceError::NotFound(m) => ApiError::NotFound(m),
        ServiceError::Invalid(m) => ApiError::Unprocessable(m),
        ServiceError::Db(e) => ApiError::Db(e),
    }
}

// --------------------------------------------------------------------------- plants (DB only)

/// GET /growatt/plants: Python `plants.list_growatt_plants` → `growatt_overview.list_plants_summary_shared`,
/// narrowed to the user's plants (`allowed_plant_ids`).
async fn list_growatt_plants(State(st): State<AppState>, scoped: Scoped) -> Result<Json<Value>, ApiError> {
    let ids = match &scoped.scope {
        crate::extract::PlantScope::All => None,
        crate::extract::PlantScope::Assigned(ids) => Some(ids),
    };
    let rows = overview::list_plants_summary_shared(&st.pool, ids).await.map_err(service_err)?;
    Ok(Json(Value::Array(rows)))
}

/// GET /growatt/plants/{plant_id}/inverters: Python `plants.list_growatt_inverters` →
/// `growatt_overview.list_inverters` (`?include_not_installed=` default false).
async fn list_growatt_inverters(
    State(st): State<AppState>,
    pr: PlantRead,
    RawQuery(raw): RawQuery,
) -> Result<Json<Value>, ApiError> {
    let p = query_pairs(raw.as_deref());
    let include = bool_param(&p, "include_not_installed", false)?;
    let rows = overview::list_inverters(&st.pool, pr.plant_id, include).await.map_err(service_err)?;
    Ok(Json(Value::Array(rows)))
}

/// GET /growatt/plants/{plant_id}/overview: Python `plants.get_growatt_plant_overview` →
/// `growatt_overview.build_plant_overview` (`?day=`, default the latest day with data).
async fn get_growatt_plant_overview(
    State(st): State<AppState>,
    pr: PlantRead,
    RawQuery(raw): RawQuery,
) -> Result<Json<Value>, ApiError> {
    let p = query_pairs(raw.as_deref());
    let day = date_param(&p, "day")?;
    let out = overview::build_plant_overview(&st.pool, pr.plant_id, day).await.map_err(service_err)?;
    Ok(Json(out))
}

/// GET /growatt/plants/{plant_id}/power: Python `plants.get_growatt_plant_power` →
/// `growatt_overview.build_plant_power` (`day` required; `end_day`, `start`, `end`, `records`).
async fn get_growatt_plant_power(
    State(st): State<AppState>,
    pr: PlantRead,
    RawQuery(raw): RawQuery,
) -> Result<Json<Value>, ApiError> {
    let p = query_pairs(raw.as_deref());
    let day = date_param(&p, "day")?;
    let end_day = date_param(&p, "end_day")?;
    let start = time_param(&p, "start")?;
    let end = time_param(&p, "end")?;
    let records = bool_param(&p, "records", true)?;
    let Some(day) = day else { return Err(unprocessable("day", "Field required")) };
    if let (Some(s), Some(e)) = (start, end) {
        if s > e {
            return Err(ApiError::Unprocessable("start must not be after end".into()));
        }
    }
    if end_day.is_some_and(|e| e < day) {
        return Err(ApiError::Unprocessable("end_day must not be before day".into()));
    }
    let out = overview::build_plant_power(&st.pool, pr.plant_id, day, end_day, start, end, records).await.map_err(service_err)?;
    Ok(Json(out))
}

// --------------------------------------------------------------------------- background jobs

/// GET /growatt/sync/status: Python `sync.sync_status` (admin): latest run per job plus the most
/// recent runs (`?limit=` 1..200, default 20).
async fn sync_status_route(State(st): State<AppState>, AdminUser(_): AdminUser, RawQuery(raw): RawQuery) -> Result<Json<Value>, ApiError> {
    let p = query_pairs(raw.as_deref());
    let limit = int_param(&p, "limit", 20, 1, 200)?;
    Ok(Json(sync_status::status(&st.pool, limit).await.map_err(service_err)?))
}

/// POST /growatt/sync/{job} (202): Python `sync.trigger_sync` (admin): queue a run for the worker
/// (`jobs.enqueue`, trigger `api`); 404 for an unknown job, 409 while one is running or queued.
async fn trigger_sync(
    State(st): State<AppState>,
    AdminUser(user): AdminUser,
    path: Option<Path<String>>,
) -> Result<Response, ApiError> {
    // `/sync/status` has no path parameter: the job is "status"
    let job = path.map(|Path(j)| j).unwrap_or_else(|| "status".into());
    if !sync_status::JOBS.contains(&job.as_str()) {
        let mut names: Vec<&str> = sync_status::JOBS.to_vec();
        names.sort_unstable();
        let listed = names.iter().map(|n| repr_str(n)).collect::<Vec<_>>().join(", ");
        return Err(ApiError::NotFound(format!("Unknown job {}; choose one of [{listed}]", repr_str(&job))));
    }
    match sync_status::enqueue(&st.pool, &job, "api").await.map_err(service_err)? {
        // Python `HTTPException(409, str(JobBusy))`
        sync_status::Enqueue::Busy(msg) => Ok((StatusCode::CONFLICT, Json(json!({"detail": msg}))).into_response()),
        sync_status::Enqueue::Queued(run_id) => {
            let who = user.username.clone().unwrap_or_else(|| user.email.clone());
            let who = if who.is_empty() { user.email.clone() } else { who };
            tracing::info!(target: "app.audit", "{who} queued job {job} (run {run_id})");
            Ok((StatusCode::ACCEPTED, Json(json!({"run_id": run_id, "job": job, "status": "queued"}))).into_response())
        }
    }
}
