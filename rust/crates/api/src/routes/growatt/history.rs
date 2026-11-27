//! One inverter's / one string's stored history (DB only, never calls Growatt), ported from
//! backend/app/api/routes/growatt/plants.py: `/growatt/plants/{plant_id}/inverters/{device_sn}/
//! timeseries`, `…/raw`, `…/daily` and `/growatt/plants/{plant_id}/strings/{device_sn}/{string_no}`.
//!
//! Order of answers as FastAPI: 401 → 404 (plant not assigned, `PlantRead`) → 422 (path / query
//! validation, then the route's own checks) → 404 (plant / inverter not found). Every route resolves
//! a `PlantInverter` (the inverter must belong to the plant) before reading any readings.

use std::collections::HashMap;

use axum::extract::{Path, RawQuery, State};
use axum::routing::get;
use axum::{Json, Router};
use chrono::{NaiveDate, NaiveTime};
use serde_json::Value;
use tcroof_services::common::ServiceError;
use tcroof_services::inverter_history::{self as ih, PlantInverter, MAX_TREND_DAYS};
use tcroof_services::strings::{self, StringDetailQuery};

use crate::error::ApiError;
use crate::extract::{parse_int, PlantRead};
use crate::AppState;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/plants/{plant_id}/inverters/{device_sn}/timeseries", get(inverter_timeseries))
        .route("/plants/{plant_id}/inverters/{device_sn}/raw", get(inverter_raw))
        .route("/plants/{plant_id}/inverters/{device_sn}/daily", get(inverter_daily))
        .route("/plants/{plant_id}/strings/{device_sn}/{string_no}", get(string_detail))
}

/// Python: `GrowattNotFound` → 404, `ValueError` → 422 (with the message), anything else → 500.
fn svc(e: ServiceError) -> ApiError {
    match e {
        ServiceError::NotFound(m) => ApiError::NotFound(m),
        ServiceError::Invalid(m) => ApiError::Unprocessable(m),
        ServiceError::Db(e) => ApiError::Db(e),
    }
}

fn unprocessable(field: &str, msg: impl std::fmt::Display) -> ApiError {
    ApiError::Unprocessable(format!("{field}: {msg}"))
}

/// The query string as Starlette reads it; a scalar parameter takes the last value.
fn query_param(raw: &Option<String>, key: &str) -> Option<String> {
    form_urlencoded::parse(raw.as_deref().unwrap_or("").as_bytes())
        .into_owned()
        .filter(|(k, _)| k == key)
        .last()
        .map(|(_, v)| v)
}

/// pydantic `date` from a query string (`YYYY-MM-DD`; Python `DAY_QUERY`).
fn date_param(raw: &Option<String>, key: &str) -> Result<Option<NaiveDate>, ApiError> {
    query_param(raw, key)
        .map(|s| {
            let ok = s.len() == 10 && s.as_bytes()[4] == b'-' && s.as_bytes()[7] == b'-';
            NaiveDate::parse_from_str(&s, "%Y-%m-%d")
                .ok()
                .filter(|_| ok)
                .ok_or_else(|| unprocessable(key, "Input should be a valid date or datetime"))
        })
        .transpose()
}

/// pydantic `time` from a query string: `HH:MM[:SS[.ffffff]]`.
fn time_param(raw: &Option<String>, key: &str) -> Result<Option<NaiveTime>, ApiError> {
    query_param(raw, key)
        .map(|s| {
            let ok = s.len() >= 5 && s.as_bytes()[2] == b':' && s[..2].bytes().all(|b| b.is_ascii_digit());
            ["%H:%M", "%H:%M:%S", "%H:%M:%S%.f"]
                .iter()
                .find_map(|f| NaiveTime::parse_from_str(&s, f).ok())
                .filter(|_| ok)
                .ok_or_else(|| unprocessable(key, "Input should be in a valid time format"))
        })
        .transpose()
}

/// Python `get_growatt_inverter_timeseries`: stored 5-minute AC/DC power and temperature of one
/// inverter for one day, plus a modelled clear-sky reference (`expected_kw`).
async fn inverter_timeseries(
    State(st): State<AppState>,
    p: PlantRead,
    Path(path): Path<HashMap<String, String>>,
    RawQuery(q): RawQuery,
) -> Result<Json<Value>, ApiError> {
    let day = date_param(&q, "day")?;
    let inv = PlantInverter::resolve(&st.pool, p.plant_id, &path["device_sn"]).await.map_err(svc)?;
    Ok(Json(ih::build_inverter_timeseries(&st.pool, &inv, day).await.map_err(svc)?))
}

/// Python `get_growatt_inverter_raw`: every field of one inverter's stored `max_data` records for
/// one day, exactly as Growatt reported them. Kept `HISTORY_RAW_RETENTION_DAYS`; older days are empty.
async fn inverter_raw(
    State(st): State<AppState>,
    p: PlantRead,
    Path(path): Path<HashMap<String, String>>,
    RawQuery(q): RawQuery,
) -> Result<Json<Value>, ApiError> {
    let day = date_param(&q, "day")?;
    let inv = PlantInverter::resolve(&st.pool, p.plant_id, &path["device_sn"]).await.map_err(svc)?;
    Ok(Json(ih::build_inverter_raw(&st.pool, &inv, day).await.map_err(svc)?))
}

/// Python `get_growatt_inverter_daily`: stored daily yield / peak AC / max temperature of one
/// inverter for `days` days (1..=90, default 30) ending at `day`, with the plant's average yield.
async fn inverter_daily(
    State(st): State<AppState>,
    p: PlantRead,
    Path(path): Path<HashMap<String, String>>,
    RawQuery(q): RawQuery,
) -> Result<Json<Value>, ApiError> {
    let day = date_param(&q, "day")?;
    let days = match query_param(&q, "days") {
        None => 30,
        Some(s) => {
            let n = parse_int(&s).ok_or_else(|| unprocessable("days", "Input should be a valid integer, unable to parse string as an integer"))?;
            if n < 1 {
                return Err(unprocessable("days", "Input should be greater than or equal to 1"));
            }
            if n > MAX_TREND_DAYS {
                return Err(unprocessable("days", format!("Input should be less than or equal to {MAX_TREND_DAYS}")));
            }
            n
        }
    };
    let inv = PlantInverter::resolve(&st.pool, p.plant_id, &path["device_sn"]).await.map_err(svc)?;
    Ok(Json(ih::build_inverter_daily(&st.pool, &inv, day, days).await.map_err(svc)?))
}

/// Python `get_growatt_string_detail`: stored telemetry for one string on one day (or
/// `day`..`end_day`), plus modelled I-V / P-V curves and per-day energy (`daily`); `start` / `end`
/// narrow everything to a time-of-day window. Unlike Python, the inverter must belong to the plant
/// (Python reads any serial's strings under any plant the user may see: a cross-plant IDOR).
async fn string_detail(
    State(st): State<AppState>,
    p: PlantRead,
    Path(path): Path<HashMap<String, String>>,
    RawQuery(q): RawQuery,
) -> Result<Json<Value>, ApiError> {
    let raw_no = &path["string_no"];
    let string_no = parse_int(raw_no)
        .ok_or_else(|| unprocessable("string_no", "Input should be a valid integer, unable to parse string as an integer"))?;
    let string_no = i32::try_from(string_no).map_err(|_| unprocessable("string_no", "Input should be a valid integer"))?;
    let day = date_param(&q, "day")?;
    let start_time = time_param(&q, "start")?;
    let end_time = time_param(&q, "end")?;
    let end_day = date_param(&q, "end_day")?;
    if let (Some(s), Some(e)) = (start_time, end_time) {
        if s > e {
            return Err(ApiError::Unprocessable("start must not be after end".into()));
        }
    }
    if let Some(e) = end_day {
        if day.is_none_or(|d| e < d) {
            return Err(ApiError::Unprocessable("end_day needs day and must not be before it".into()));
        }
    }
    let inv = PlantInverter::resolve(&st.pool, p.plant_id, &path["device_sn"]).await.map_err(svc)?;
    let query = StringDetailQuery { day, start_time, end_time, end_day };
    Ok(Json(strings::build_string_detail(&st.pool, &inv, string_no, &query).await.map_err(svc)?))
}
