//! Stored weather and curtailment (DB only), ported from backend/app/api/routes/growatt/plants.py:
//! `GET /growatt/plants/{plant_id}/weather` (weather sensor day), `GET /growatt/plants/{plant_id}/google-weather`
//! (stored Google hours, **modelled**) and `GET /growatt/curtailment` (fleet curtailment from the
//! stored daily rows, **estimated**). Nothing here calls Growatt or Google.

use axum::extract::{RawQuery, State};
use axum::routing::get;
use axum::{Json, Router};
use chrono::{Duration, NaiveDate, NaiveTime, Utc};
use serde_json::Value;
use tcroof_services::common::{get_plant, ServiceError};
use tcroof_services::curtailment;
use tcroof_services::google_weather_stored::{self as gw, GoogleWeatherConfig};
use tcroof_services::weather::{self as wx, WeatherError};

use crate::error::ApiError;
use crate::extract::{PlantRead, PlantScope, Scoped};
use crate::AppState;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/plants/{plant_id}/weather", get(get_growatt_plant_weather))
        .route("/plants/{plant_id}/google-weather", get(get_growatt_plant_google_weather))
        .route("/curtailment", get(fleet_curtailment))
}

/// Python `CURTAILMENT_MAX_DAYS`
const CURTAILMENT_MAX_DAYS: i64 = 92;

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

fn unprocessable(field: &str, msg: impl std::fmt::Display) -> ApiError {
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
        .ok_or_else(|| unprocessable(key, "Input should be a valid date or datetime, invalid date separator"))
}

/// pydantic v2 `Optional[time]` from a query string: `HH:MM[:SS[.ffffff]]`.
fn time_param(pairs: &[(String, String)], key: &str) -> Result<Option<NaiveTime>, ApiError> {
    let Some(s) = last(pairs, key) else { return Ok(None) };
    let bad = || unprocessable(key, "Input should be in a valid time format");
    let (hms, frac) = match s.split_once('.') {
        Some((a, f)) => (a, Some(f)),
        None => (s, None),
    };
    let parts: Vec<&str> = hms.split(':').collect();
    if !(2..=3).contains(&parts.len()) || parts.iter().any(|p| p.len() != 2 || !p.bytes().all(|b| b.is_ascii_digit())) {
        return Err(bad());
    }
    let n = |i: usize| parts.get(i).map_or(Ok(0), |p| p.parse::<u32>()).map_err(|_| bad());
    let micro = match frac {
        None => 0,
        Some(f) if parts.len() == 3 && !f.is_empty() && f.bytes().all(|b| b.is_ascii_digit()) => {
            f.chars().chain(std::iter::repeat('0')).take(6).collect::<String>().parse().map_err(|_| bad())?
        }
        Some(_) => return Err(bad()),
    };
    NaiveTime::from_hms_micro_opt(n(0)?, n(1)?, n(2)?, micro).map(Some).ok_or_else(bad)
}

/// `sensor` with Python's `pattern=r"^[A-Za-z0-9_-]+:\d+$"`: (datalogger SN, address text).
fn sensor_param(pairs: &[(String, String)]) -> Result<Option<(String, String)>, ApiError> {
    let Some(s) = last(pairs, "sensor") else { return Ok(None) };
    let bad = || unprocessable("sensor", "String should match pattern '^[A-Za-z0-9_-]+:\\d+$'");
    let (sn, addr) = s.split_once(':').ok_or_else(bad)?;
    let sn_ok = !sn.is_empty() && sn.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-');
    let addr_ok = !addr.is_empty() && addr.bytes().all(|b| b.is_ascii_digit());
    if !(sn_ok && addr_ok) {
        return Err(bad());
    }
    Ok(Some((sn.to_owned(), addr.to_owned())))
}

fn gw_config(st: &AppState) -> GoogleWeatherConfig {
    let s = &st.settings;
    GoogleWeatherConfig {
        configured: !s.google_weather_api_key.is_empty(),
        cell_deg: s.google_weather_cell_deg,
        day_start_h: s.google_weather_day_start_h,
        day_end_h: s.google_weather_day_end_h,
    }
}

// --------------------------------------------------------------------------- routes

/// Python `plants.get_growatt_plant_weather`: stored weather-sensor data for one day (5-minute
/// series, insolation, peaks; probes reading only 0 all day are null). `start` / `end` narrow the
/// series and KPIs; `sensor=SN:ADDR` picks one sensor (404 if not the plant's).
async fn get_growatt_plant_weather(State(st): State<AppState>, plant: PlantRead, RawQuery(raw): RawQuery) -> Result<Json<Value>, ApiError> {
    let pairs = query_pairs(raw.as_deref());
    let day = date_param(&pairs, "day")?;
    let start = time_param(&pairs, "start")?;
    let end = time_param(&pairs, "end")?;
    let sensor = sensor_param(&pairs)?;
    if let (Some(s), Some(e)) = (start, end) {
        if s > e {
            return Err(ApiError::Unprocessable("start must not be after end".into()));
        }
    }
    get_plant(&st.pool, plant.plant_id).await.map_err(svc)?;
    let not_found = || ApiError::NotFound(format!("Plant {} has no such weather sensor", plant.plant_id));
    let one = match sensor {
        None => None,
        // an address beyond i32 names no registered sensor
        Some((sn, addr)) => Some((sn, addr.parse::<i32>().map_err(|_| not_found())?)),
    };
    match wx::build_weather_day(&st.pool, plant.plant_id, day, true, start, end, one).await {
        Ok(v) => Ok(Json(v)),
        Err(WeatherError::NoSuchSensor(..)) => Err(not_found()),
        Err(WeatherError::Service(e)) => Err(svc(e)),
    }
}

/// Python `plants.get_growatt_plant_google_weather`: stored hourly Google Maps Weather for one day
/// (modelled): cloud cover, rain, temperature, UV, wind; daily totals and days since the last rain
/// day. Written by the `google_weather` job.
async fn get_growatt_plant_google_weather(State(st): State<AppState>, plant: PlantRead, RawQuery(raw): RawQuery) -> Result<Json<Value>, ApiError> {
    let pairs = query_pairs(raw.as_deref());
    let day = date_param(&pairs, "day")?;
    let p = get_plant(&st.pool, plant.plant_id).await.map_err(svc)?;
    Ok(Json(gw::build_day(&st.pool, &gw_config(&st), &p, day).await.map_err(svc)?))
}

/// Python `plants.fleet_curtailment`: curtailment of every plant the user may see over
/// `start`..`end` (≤ 92 days, default the last 7 to today, plant-local) from the stored daily rows
/// (estimated).
async fn fleet_curtailment(State(st): State<AppState>, scoped: Scoped, RawQuery(raw): RawQuery) -> Result<Json<Value>, ApiError> {
    let pairs = query_pairs(raw.as_deref());
    let start = date_param(&pairs, "start")?;
    let end = date_param(&pairs, "end")?;
    // jobs.PLANT_TZ = Asia/Bangkok (UTC+7, no DST)
    let e = end.unwrap_or_else(|| (Utc::now() + Duration::hours(7)).date_naive());
    let s = start.unwrap_or(e - Duration::days(6));
    if s > e {
        return Err(ApiError::Unprocessable("start is after end".into()));
    }
    if (e - s).num_days() + 1 > CURTAILMENT_MAX_DAYS {
        return Err(ApiError::Unprocessable(format!("A period covers at most {CURTAILMENT_MAX_DAYS} days")));
    }
    let ids: Option<Vec<i64>> = match &scoped.scope {
        PlantScope::All => None,
        PlantScope::Assigned(ids) => Some(ids.iter().copied().collect()),
    };
    Ok(Json(curtailment::fleet(&st.pool, s, e, ids.as_deref()).await.map_err(svc)?))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn q(s: &str) -> Vec<(String, String)> {
        query_pairs(Some(s))
    }

    #[test]
    fn params() {
        assert_eq!(date_param(&q("day=2026-11-27"), "day").unwrap(), NaiveDate::from_ymd_opt(2026, 11, 27));
        assert!(date_param(&q("day="), "day").is_err());
        assert!(date_param(&q("day=2026-2-1"), "day").is_err());
        assert_eq!(time_param(&q("start=09:30"), "start").unwrap(), NaiveTime::from_hms_opt(9, 30, 0));
        assert!(time_param(&q("start=9:30"), "start").is_err());
        assert!(time_param(&q("start=25:00"), "start").is_err());
        assert_eq!(sensor_param(&q("sensor=AB_1-2:36")).unwrap(), Some(("AB_1-2".into(), "36".into())));
        assert!(sensor_param(&q("sensor=AB:x")).is_err());
        assert!(sensor_param(&q("sensor=")).is_err());
        assert!(sensor_param(&q("sensor=A.B:1")).is_err());
    }
}
