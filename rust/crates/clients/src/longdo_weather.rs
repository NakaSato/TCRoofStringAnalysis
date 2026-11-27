//! Port of `backend/solar_core/longdo_weather.py`: Longdo Map Weather Radar API client
//! (<https://weather.longdo.com/docs>, `/openapi.json`).
//!
//! Pure HTTP + parsing. A field Longdo leaves out is `None`, never a default.
//!
//! Rain here is what the weather radar mosaic shows over a coordinate (an intensity class 0–5),
//! and the +15 / +30 min values are a nowcast (pysteps) of that mosaic: **radar-derived**, neither
//! is measured at the plant.
//!
//! Endpoints used (every one but the legend needs `?key=`):
//! - `rain/api/v1/layer/list`          radar snapshots available (Unix time, oldest first)
//! - `rain/api/v1/legend?format=json&lang=th`  colour and Thai label of each class (static, no key)
//! - `rain/api/v1/location`            radar rain class at a coordinate, now
//! - `rain/api/v1/forecast/location`   the same for +15 / +30 min
//! - `rain/api/v1/area`                share of a circle with rain and its strongest class, now
//! - `rain/api/v1/forecast/area`       the same for +15 / +30 min
//! - `rain/api/v1/layer/{time}/{z}/{x}/{y}.png`  XYZ tiles, zoom 5–13 (loaded by the browser)
//!
//! The parsers take any JSON value. Where Python would raise on a malformed shape (for example
//! `"radar": "x"`), the Rust parser treats the part as missing.

use std::collections::BTreeSet;

use serde::Serialize;
use serde_json::Value;

use crate::google_weather::{http_client, json_body, py, reason, requests_exc_name};

/// `DEFAULT_BASE_URL` (also `settings.longdo_base_url`'s default).
pub const DEFAULT_BASE_URL: &str = "https://weather.longdo.com/";
/// `LongdoWeatherClient.__init__`'s default timeout, seconds (the service passes
/// `settings.longdo_timeout_s`, 6).
pub const DEFAULT_TIMEOUT_S: f64 = 15.0;
/// `TILE_MIN_ZOOM`
pub const TILE_MIN_ZOOM: u8 = 5;
/// `TILE_MAX_ZOOM`
pub const TILE_MAX_ZOOM: u8 = 13;
/// `ATTRIBUTION`
pub const ATTRIBUTION: &str = "Rain radar © Longdo Map";

/// `LongdoWeatherError`: the API refused or failed. The message never contains the API key.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{message}")]
pub struct LongdoWeatherError {
    /// The Python exception message (`"<path>: HTTP 403 <detail>"`, `"<path>: answer is not JSON"`).
    pub message: String,
    /// The HTTP status when Longdo answered with one other than 200.
    pub status: Option<u16>,
}

impl LongdoWeatherError {
    fn new(message: impl Into<String>, status: Option<u16>) -> Self {
        Self { message: message.into(), status }
    }
}

/// `_int`: `int(v)`, None for null, "", booleans and what `int()` refuses.
pub fn int(v: Option<&Value>) -> Option<i64> {
    v.and_then(|v| py::int_value(v, false))
}

/// `_float`: `float(v)`, None for null, "", booleans and what `float()` refuses.
pub fn float(v: Option<&Value>) -> Option<f64> {
    v.and_then(|v| py::float_value(v, false))
}

/// One radar rain value (`parse_rain`): intensity class 0–5 as reported. Radar-derived.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Rain {
    pub intensity: i64,
    pub description: Option<String>,
}

/// One nowcast row (`parse_forecast`); `rain` None = not available.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ForecastRow {
    pub lead_min: Option<i64>,
    /// Unix time.
    pub time: Option<i64>,
    pub rain: Option<Rain>,
}

/// Rain over a circle (`parse_area_stats`). Radar-derived.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct AreaStats {
    pub coverage_pct: Option<f64>,
    pub max_intensity: Option<i64>,
}

/// One area nowcast row (`parse_forecast_area`); `stats` None = not available.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ForecastAreaRow {
    pub lead_min: Option<i64>,
    /// Unix time.
    pub time: Option<i64>,
    pub stats: Option<AreaStats>,
}

/// One legend class (`parse_legend`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct LegendLevel {
    pub intensity: i64,
    pub label: String,
    pub color: String,
}

/// The items of a JSON list Python would iterate with `for x in (v or [])`; anything else gives
/// none (a dict iterates its keys and a string its characters, which every caller skips; a
/// number raises in Python).
fn items(v: Option<&Value>) -> &[Value] {
    v.and_then(Value::as_array).map_or(&[], Vec::as_slice)
}

/// `parse_frames`: Unix times of the radar snapshots, oldest first (0 and missing left out).
pub fn parse_frames(body: &Value) -> Vec<i64> {
    let past = body.get("radar").and_then(|r| r.get("past"));
    let times: BTreeSet<i64> = items(past).iter().filter(|f| f.is_object()).filter_map(|f| int(f.get("time"))).filter(|t| *t != 0).collect();
    times.into_iter().collect()
}

/// `parse_rain`: `{intensity 0–5, description}` as reported; None when Longdo gave no intensity
/// (or one outside 0–5). Intensity 0 (no rain) is a value, not missing.
pub fn parse_rain(rain: Option<&Value>) -> Option<Rain> {
    let rain = rain.filter(|r| r.is_object())?;
    let intensity = int(rain.get("intensity")).filter(|i| (0..=5).contains(i))?;
    let text = py::get_truthy(rain, "description").or_else(|| py::get_truthy(rain, "level"));
    Some(Rain { intensity, description: text.and_then(py::str_value) })
}

/// `leads[i] if i < len(leads)` of `body.get("lead_minutes") or []`.
fn lead(leads: Option<&Value>, i: usize) -> Option<i64> {
    match leads.filter(|l| py::truthy(l))? {
        Value::Array(a) => int(a.get(i)),
        Value::String(s) => s.chars().nth(i).and_then(|c| py::int_str(&c.to_string())),
        _ => None, // Python raises (dict: KeyError, number: TypeError)
    }
}

/// `item.get("available", True)` is truthy.
fn available(item: &Value) -> bool {
    item.get("available").is_none_or(py::truthy)
}

/// `parse_forecast`: one row per lead time `{lead_min, time (Unix), rain}`; `rain` None = not
/// available (never a 0).
pub fn parse_forecast(body: &Value) -> Vec<ForecastRow> {
    let leads = body.get("lead_minutes");
    items(body.get("forecast"))
        .iter()
        .enumerate()
        .filter(|(_, item)| item.is_object())
        .map(|(i, item)| ForecastRow {
            lead_min: lead(leads, i),
            time: int(item.get("unix_time")),
            rain: if available(item) { parse_rain(item.get("rain")) } else { None },
        })
        .collect()
}

/// `parse_area_stats`: `{coverage_pct, max_intensity}` of a circle; None when Longdo gave
/// neither. A `max_intensity` outside 0–5 is None (the row is still returned when present).
pub fn parse_area_stats(stats: Option<&Value>) -> Option<AreaStats> {
    let stats = stats.filter(|s| s.is_object())?;
    let cover = float(stats.get("rain_coverage_pct"));
    let top = int(stats.get("max_intensity"));
    if cover.is_none() && top.is_none() {
        return None;
    }
    Some(AreaStats { coverage_pct: cover.map(|c| py::round(c, 1)), max_intensity: top.filter(|t| (0..=5).contains(t)) })
}

/// `parse_forecast_area`: one row per lead time `{lead_min, time (Unix), stats}`; `stats` None =
/// not available.
pub fn parse_forecast_area(body: &Value) -> Vec<ForecastAreaRow> {
    let leads = body.get("lead_minutes");
    items(body.get("forecast"))
        .iter()
        .enumerate()
        .filter(|(_, item)| item.is_object())
        .map(|(i, item)| ForecastAreaRow {
            lead_min: lead(leads, i),
            time: int(item.get("unix_time")),
            stats: if available(item) { parse_area_stats(item.get("stats")) } else { None },
        })
        .collect()
}

/// `parse_legend`: the classes with an intensity and a `hex` colour, by intensity (stable).
pub fn parse_legend(body: &Value) -> Vec<LegendLevel> {
    let mut rows: Vec<LegendLevel> = items(body.get("levels"))
        .iter()
        .filter(|lv| lv.is_object())
        .filter_map(|lv| {
            let intensity = int(lv.get("intensity"))?;
            let color = lv.get("hex").and_then(Value::as_str)?;
            let label = py::get_truthy(lv, "label").and_then(py::str_value).unwrap_or_default();
            Some(LegendLevel { intensity, label, color: color.to_string() })
        })
        .collect();
    rows.sort_by_key(|r| r.intensity);
    rows
}

/// `LongdoWeatherClient`: thin client; one HTTP call per method call. The key goes in the `key`
/// query parameter (and the browser tile URL) and is masked as `***` in every error.
pub struct LongdoWeatherClient {
    key: String,
    base: String,
    http: reqwest::Client,
}

impl std::fmt::Debug for LongdoWeatherClient {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("LongdoWeatherClient").field("base", &self.base).finish_non_exhaustive()
    }
}

impl LongdoWeatherClient {
    /// `LongdoWeatherClient.__init__(api_key, base_url, timeout)`; an empty key is an error.
    pub fn new(api_key: &str, base_url: &str, timeout_s: f64) -> Result<Self, LongdoWeatherError> {
        if api_key.is_empty() {
            return Err(LongdoWeatherError::new("LONGDO_API_KEY is not set", None));
        }
        Ok(Self { key: api_key.to_string(), base: format!("{}/", base_url.trim_end_matches('/')), http: http_client(timeout_s) })
    }

    /// `_get`: one GET of `base + path` with `params` (+ `key` unless `with_key` is false); any
    /// JSON answer (JSON `null` or not JSON is an error).
    async fn get(&self, path: &str, params: &[(&str, String)], with_key: bool) -> Result<Value, LongdoWeatherError> {
        let mut query: Vec<(&str, &str)> = params.iter().map(|(k, v)| (*k, v.as_str())).collect();
        if with_key {
            query.push(("key", &self.key));
        }
        let sent = self.http.get(format!("{}{path}", self.base)).query(&query).send().await;
        let resp = sent.map_err(|e| LongdoWeatherError::new(format!("{path}: {}", requests_exc_name(&e)), None))?;
        let status = resp.status();
        let bytes = resp.bytes().await.map_err(|e| LongdoWeatherError::new(format!("{path}: {}", requests_exc_name(&e)), None))?;
        let body = json_body(&bytes).filter(|b| !b.is_null());
        if status != reqwest::StatusCode::OK {
            let msg = match body.as_ref().and_then(|b| b.get("detail")) {
                Some(Value::String(d)) => d.clone(),
                _ => reason(status).unwrap_or("error").to_string(),
            };
            let text = format!("{path}: HTTP {} {msg}", status.as_u16()).replace(&self.key, "***");
            return Err(LongdoWeatherError::new(text, Some(status.as_u16())));
        }
        body.ok_or_else(|| LongdoWeatherError::new(format!("{path}: answer is not JSON"), None))
    }

    fn point(lat: f64, lon: f64) -> Vec<(&'static str, String)> {
        vec![("lat", py::repr_f64(lat)), ("lon", py::repr_f64(lon))]
    }

    fn circle(lat: f64, lon: f64, radius_km: f64) -> Vec<(&'static str, String)> {
        let mut p = Self::point(lat, lon);
        p.push(("radius_km", py::repr_f64(radius_km)));
        p
    }

    /// `frames`: Unix times of the radar snapshots, oldest first.
    pub async fn frames(&self) -> Result<Vec<i64>, LongdoWeatherError> {
        Ok(parse_frames(&self.get("rain/api/v1/layer/list", &[], true).await?))
    }

    /// `legend`: colour and Thai label of each intensity class (no key sent).
    pub async fn legend(&self) -> Result<Vec<LegendLevel>, LongdoWeatherError> {
        let params = [("format", "json".to_string()), ("lang", "th".to_string())];
        Ok(parse_legend(&self.get("rain/api/v1/legend", &params, false).await?))
    }

    /// `rain_at`: radar rain class at a coordinate, now (radar-derived).
    pub async fn rain_at(&self, lat: f64, lon: f64) -> Result<Option<Rain>, LongdoWeatherError> {
        let body = self.get("rain/api/v1/location", &Self::point(lat, lon), true).await?;
        Ok(parse_rain(body.get("rain")))
    }

    /// `forecast_at`: the +15 / +30 min nowcast at a coordinate (radar-derived).
    pub async fn forecast_at(&self, lat: f64, lon: f64) -> Result<Vec<ForecastRow>, LongdoWeatherError> {
        Ok(parse_forecast(&self.get("rain/api/v1/forecast/location", &Self::point(lat, lon), true).await?))
    }

    /// `area_at`: share of a circle with rain and its strongest class, now (radar-derived).
    pub async fn area_at(&self, lat: f64, lon: f64, radius_km: f64) -> Result<Option<AreaStats>, LongdoWeatherError> {
        let body = self.get("rain/api/v1/area", &Self::circle(lat, lon, radius_km), true).await?;
        Ok(parse_area_stats(body.get("stats")))
    }

    /// `forecast_area_at`: the same for +15 / +30 min (radar-derived).
    pub async fn forecast_area_at(&self, lat: f64, lon: f64, radius_km: f64) -> Result<Vec<ForecastAreaRow>, LongdoWeatherError> {
        Ok(parse_forecast_area(&self.get("rain/api/v1/forecast/area", &Self::circle(lat, lon, radius_km), true).await?))
    }

    /// `tile_url`: Leaflet URL template of one snapshot's tiles; `{time}` is a Unix time from
    /// [`Self::frames`]. It carries the key: Longdo Map keys are browser keys (restrict by domain).
    pub fn tile_url(&self) -> String {
        format!("{}rain/api/v1/layer/{{time}}/{{z}}/{{x}}/{{y}}.png?key={}", self.base, self.key)
    }
}
