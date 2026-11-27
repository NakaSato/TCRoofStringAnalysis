//! Weather sensors, the Active Alarm log and the Devices page (DB only, never calls Growatt):
//! `GET /growatt/sensors` and `GET /growatt/alarms` from backend/app/api/routes/growatt/plants.py
//! (`fleet_sensors`, `fleet_alarms`), and every route of backend/app/api/routes/growatt/devices.py
//! (`/devices/inverters`, `/devices/meters`, `/devices/dataloggers`, `/devices/checks`).

use std::collections::HashSet;

use axum::extract::{RawQuery, State};
use axum::routing::get;
use axum::{Json, Router};
use chrono::{NaiveDate, Utc};
use serde_json::Value;
use tcroof_services::common::ServiceError;
use tcroof_services::{alarms, device_checks, devices, sensors};

use crate::config::parse_bool;
use crate::error::ApiError;
use crate::extract::{parse_int, PlantScope, Scoped};
use crate::AppState;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/sensors", get(fleet_sensors))
        .route("/alarms", get(fleet_alarms))
        .route("/devices/inverters", get(device_inverters))
        .route("/devices/meters", get(device_meters))
        .route("/devices/dataloggers", get(device_dataloggers))
        .route("/devices/checks", get(device_checks_route))
}

fn svc(e: ServiceError) -> ApiError {
    match e {
        ServiceError::NotFound(m) => ApiError::NotFound(m),
        ServiceError::Invalid(m) => ApiError::Unprocessable(m),
        ServiceError::Db(e) => ApiError::Db(e),
    }
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

fn unprocessable(field: &str, msg: &str) -> ApiError {
    ApiError::Unprocessable(format!("{field}: {msg}"))
}

/// pydantic v2 `Optional[date]` from a query string: `YYYY-MM-DD`.
fn date_param(pairs: &[(String, String)], key: &str) -> Result<Option<NaiveDate>, ApiError> {
    let Some(s) = last(pairs, key) else { return Ok(None) };
    let b = s.as_bytes();
    let ok = b.len() == 10 && b[4] == b'-' && b[7] == b'-';
    ok.then(|| NaiveDate::parse_from_str(s, "%Y-%m-%d").ok())
        .flatten()
        .map(Some)
        .ok_or_else(|| unprocessable(key, "Input should be a valid date or datetime"))
}

fn int_param(pairs: &[(String, String)], key: &str) -> Result<Option<i64>, ApiError> {
    last(pairs, key)
        .map(|s| parse_int(s).ok_or_else(|| unprocessable(key, "Input should be a valid integer, unable to parse string as an integer")))
        .transpose()
}

fn bool_param(pairs: &[(String, String)], key: &str, default: bool) -> Result<bool, ApiError> {
    match last(pairs, key) {
        None => Ok(default),
        Some(s) => parse_bool(s).ok_or_else(|| unprocessable(key, "Input should be a valid boolean, unable to interpret input")),
    }
}

/// Python `allowed_plant_ids` as the services take it (None = every plant)
fn allowed(scope: &PlantScope) -> Option<&HashSet<i64>> {
    match scope {
        PlantScope::All => None,
        PlantScope::Assigned(ids) => Some(ids),
    }
}

/// Python `routes/growatt/_common.sensor_scope`: the user's visible plants, narrowed to
/// `plant_id` when given (an invisible plant gives the empty set, so nothing is revealed).
fn sensor_scope(scope: &PlantScope, plant_id: Option<i64>) -> Option<HashSet<i64>> {
    match plant_id {
        None => allowed(scope).cloned(),
        Some(p) if scope.allows(p) => Some([p].into_iter().collect()),
        Some(_) => Some(HashSet::new()),
    }
}

// --------------------------------------------------------------------------- handlers

/// GET /growatt/sensors: Python `routes/growatt/plants.fleet_sensors` →
/// `growatt_sensors.list_sensors(db, sensor_scope(db, user, plant_id), day=day)`.
async fn fleet_sensors(State(st): State<AppState>, s: Scoped, RawQuery(raw): RawQuery) -> Result<Json<Value>, ApiError> {
    let p = query_pairs(raw.as_deref());
    let plant_id = int_param(&p, "plant_id")?;
    let day = date_param(&p, "day")?;
    let scope = sensor_scope(&s.scope, plant_id);
    let out = sensors::list_sensors(&st.pool, scope.as_ref(), sensors::now_local(), day, st.settings.sensor_alarm_coverage_pct)
        .await
        .map_err(svc)?;
    Ok(Json(out))
}

/// GET /growatt/alarms: Python `routes/growatt/plants.fleet_alarms` (`growatt_alarms.alarm_day`
/// plus `meta.last_run_at` / `next_run_at`, the latter only for today).
async fn fleet_alarms(State(st): State<AppState>, s: Scoped, RawQuery(raw): RawQuery) -> Result<Json<Value>, ApiError> {
    let p = query_pairs(raw.as_deref());
    let day = date_param(&p, "day")?;
    let now = Utc::now();
    let today = now.with_timezone(&alarms::plant_tz()).date_naive();
    let d = day.unwrap_or(today);
    let mut out = alarms::alarm_day(&st.pool, d, allowed(&s.scope)).await.map_err(svc)?;
    let last_run = alarms::last_started(&st.pool, "alarms").await.map_err(svc)?;
    let cfg = &st.settings;
    let hour = |h: i64| u32::try_from(h.max(0)).unwrap_or(u32::MAX);
    let nxt = (d == today).then(|| {
        alarms::next_run_at(now, last_run, cfg.worker_alarms_tick_min, hour(cfg.worker_alarms_start_h), hour(cfg.worker_alarms_end_h))
    });
    let iso = |t: chrono::DateTime<Utc>| Value::String(crate::pyfmt::isoformat(t));
    out["meta"]["last_run_at"] = last_run.map_or(Value::Null, iso);
    out["meta"]["next_run_at"] = nxt.map_or(Value::Null, iso);
    Ok(Json(out))
}

/// GET /growatt/devices/inverters: Python `routes/growatt/devices.device_inverters`
async fn device_inverters(State(st): State<AppState>, s: Scoped, RawQuery(raw): RawQuery) -> Result<Json<Value>, ApiError> {
    let p = query_pairs(raw.as_deref());
    let include = bool_param(&p, "include_not_installed", false)?;
    Ok(Json(devices::list_inverters(&st.pool, allowed(&s.scope), include, Utc::now()).await.map_err(svc)?))
}

/// GET /growatt/devices/meters: Python `routes/growatt/devices.device_meters`
async fn device_meters(State(st): State<AppState>, s: Scoped) -> Result<Json<Value>, ApiError> {
    Ok(Json(devices::list_meters(&st.pool, allowed(&s.scope), Utc::now()).await.map_err(svc)?))
}

/// GET /growatt/devices/dataloggers: Python `routes/growatt/devices.device_dataloggers`
async fn device_dataloggers(State(st): State<AppState>, s: Scoped) -> Result<Json<Value>, ApiError> {
    Ok(Json(devices::list_dataloggers(&st.pool, allowed(&s.scope), Utc::now()).await.map_err(svc)?))
}

/// GET /growatt/devices/checks: Python `routes/growatt/devices.device_checks` → `device_checks.build`
async fn device_checks_route(State(st): State<AppState>, s: Scoped) -> Result<Json<Value>, ApiError> {
    let cfg = &st.settings;
    let out = device_checks::build(&st.pool, allowed(&s.scope), Utc::now(), cfg.meter_history_enabled, cfg.sensor_alarm_coverage_pct)
        .await
        .map_err(svc)?;
    Ok(Json(out))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sensor_scope_like_python() {
        let eng = PlantScope::Assigned([5, 7].into_iter().collect());
        assert_eq!(sensor_scope(&PlantScope::All, None), None);
        assert_eq!(sensor_scope(&PlantScope::All, Some(9)), Some([9].into_iter().collect()));
        assert_eq!(sensor_scope(&eng, Some(7)), Some([7].into_iter().collect()));
        assert_eq!(sensor_scope(&eng, Some(9)), Some(HashSet::new()));
        assert_eq!(sensor_scope(&eng, None), Some([5, 7].into_iter().collect()));
    }
}
