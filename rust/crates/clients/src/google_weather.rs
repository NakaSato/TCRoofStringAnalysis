//! Port of `backend/solar_core/google_weather.py`: Google Maps Platform Weather API client
//! (<https://developers.google.com/maps/documentation/weather>).
//!
//! Pure HTTP + parsing. Every response is flattened into one record of SI values (°C, %, mm,
//! m/s, hPa, km); a field Google leaves out is `None`, never a default.
//!
//! The values are **modelled** (Google's weather model for the coordinates), not measured at the
//! plant. The plant's own weather sensor stays the source for irradiance and IEC PR.
//!
//! Endpoints used:
//! - `currentConditions:lookup`  current conditions + the past 24 h's rain / min / max temperature
//! - `history/hours:lookup`      the past 24 hours, hourly (one page of 24 rows per call)
//!
//! The parsers take any JSON value. Where Python would raise on a malformed shape (for example
//! `"wind": "x"`, where it calls `.get` on a string), the Rust parser treats the part as missing.

pub mod py;

use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use chrono::{DateTime, NaiveDateTime, TimeDelta, Timelike, Utc};
use serde::{Serialize, Serializer};
use serde_json::Value;

/// `DEFAULT_BASE_URL` (also `settings.google_weather_base_url`'s default).
pub const DEFAULT_BASE_URL: &str = "https://weather.googleapis.com/v1/";

/// `GoogleWeatherClient.__init__`'s default timeout, seconds (the service uses the default).
pub const DEFAULT_TIMEOUT_S: f64 = 20.0;

/// `FIELDS`: flat numeric fields of one parsed record (current conditions or one history hour).
pub const FIELDS: [&str; 14] = [
    "temp_c",
    "feels_like_c",
    "dew_point_c",
    "humidity_pct",
    "cloud_cover_pct",
    "uv_index",
    "precip_mm",
    "precip_prob_pct",
    "thunder_prob_pct",
    "wind_speed_ms",
    "wind_gust_ms",
    "wind_dir_deg",
    "pressure_hpa",
    "visibility_km",
];

/// `_SPEED_TO_MS`
fn speed_to_ms(unit: &str) -> Option<f64> {
    match unit {
        "KILOMETERS_PER_HOUR" => Some(1.0 / 3.6),
        "MILES_PER_HOUR" => Some(0.44704),
        _ => None,
    }
}

/// `_LENGTH_TO_MM`
fn length_to_mm(unit: &str) -> Option<f64> {
    match unit {
        "MILLIMETERS" => Some(1.0),
        "INCHES" => Some(25.4),
        _ => None,
    }
}

/// `_DIST_TO_KM`
fn dist_to_km(unit: &str) -> Option<f64> {
    match unit {
        "KILOMETERS" => Some(1.0),
        "MILES" => Some(1.609344),
        _ => None,
    }
}

/// `GoogleWeatherError`: the Weather API refused or failed. The message never contains the API
/// key. `Display` is the Python message (`"<path>: HTTP 429 <message>"`, `"<path>: ReadTimeout"`);
/// callers match `"HTTP 429"` in it as Python does.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{message}")]
pub struct GoogleWeatherError {
    /// The Python exception message.
    pub message: String,
    /// The HTTP status when Google answered with one other than 200.
    pub status: Option<u16>,
}

impl GoogleWeatherError {
    fn new(message: impl Into<String>, status: Option<u16>) -> Self {
        Self { message: message.into(), status }
    }
}

/// `_num`: `float(v)`, None for null, "" and what `float()` refuses (booleans count as 0 / 1).
pub fn num(v: Option<&Value>) -> Option<f64> {
    v.and_then(|v| py::float_value(v, true))
}

/// `_temp_c`: `{degrees, unit}` in °C (FAHRENHEIT converted), rounded to 0.1.
pub fn temp_c(t: Option<&Value>) -> Option<f64> {
    let t = t.filter(|t| t.is_object())?;
    let deg = num(t.get("degrees"))?;
    let c = if t.get("unit").and_then(Value::as_str) == Some("FAHRENHEIT") { (deg - 32.0) * 5.0 / 9.0 } else { deg };
    Some(py::round(c, 1))
}

/// `_scaled`: `d[value_key]` times the factor of `d["unit"]` (or `default_unit` when the unit is
/// missing / falsy); None for an unknown unit.
fn scaled(d: Option<&Value>, value_key: &str, table: fn(&str) -> Option<f64>, default_unit: &str, digits: usize) -> Option<f64> {
    let d = d.filter(|d| d.is_object())?;
    let v = num(d.get(value_key));
    let factor = match d.get("unit").filter(|u| py::truthy(u)) {
        None => table(default_unit),
        Some(Value::String(u)) => table(u),
        Some(_) => None, // Python: a number misses the table; a list / dict raises TypeError
    };
    match (v, factor) {
        (Some(v), Some(f)) => Some(py::round(v * f, digits)),
        _ => None,
    }
}

/// `_local_naive`: `displayDateTime` (location-local wall clock) as a naive datetime.
pub fn local_naive(dd: Option<&Value>) -> Option<NaiveDateTime> {
    let dd = dd.filter(|d| d.is_object())?;
    let part = |k: &str| dd.get(k).and_then(|v| py::int_value(v, true));
    let (y, m, d) = (part("year")?, part("month")?, part("day")?);
    let h = if dd.get("hours").is_some() { part("hours")? } else { 0 };
    let mi = if dd.get("minutes").is_some() { part("minutes")? } else { 0 };
    if !(1..=9999).contains(&y) {
        return None;
    }
    let date = chrono::NaiveDate::from_ymd_opt(y as i32, u32::try_from(m).ok()?, u32::try_from(d).ok()?)?;
    date.and_hms_opt(u32::try_from(h).ok()?, u32::try_from(mi).ok()?, 0)
}

/// `_utc`: an RFC 3339 timestamp (nanoseconds cut to microseconds) as UTC. As in Python, an
/// explicit offset in the string is replaced by UTC, not converted.
pub fn utc(ts: Option<&Value>) -> Option<DateTime<Utc>> {
    let ts = ts.and_then(Value::as_str).filter(|s| !s.is_empty())?;
    let mut s = ts.trim_end_matches('Z').to_string();
    if let Some((head, frac)) = s.split_once('.') {
        let frac6: String = frac.chars().take(6).collect();
        s = format!("{head}.{frac6}");
    }
    py::fromisoformat_naive(&s).map(|n| n.and_utc())
}

fn str_of(v: Option<&Value>) -> Option<String> {
    v.and_then(Value::as_str).map(String::from)
}

fn ser_opt_utc<S: Serializer>(t: &Option<DateTime<Utc>>, s: S) -> Result<S::Ok, S::Error> {
    match t {
        Some(t) => s.serialize_str(&py::isoformat_utc(t)),
        None => s.serialize_none(),
    }
}

fn ser_naive<S: Serializer>(t: &NaiveDateTime, s: S) -> Result<S::Ok, S::Error> {
    s.serialize_str(&py::isoformat_naive(t))
}

/// One flattened record: the dict `parse_conditions` returns. Modelled values (Google's model).
///
/// The passthrough fields (`condition`, `condition_text`, `icon_uri`, `is_daytime`,
/// `precip_type`) keep only a string (bool for `is_daytime`); Python passes any JSON type through.
#[derive(Debug, Clone, PartialEq, Default, Serialize)]
pub struct Conditions {
    pub condition: Option<String>,
    pub condition_text: Option<String>,
    pub icon_uri: Option<String>,
    pub is_daytime: Option<bool>,
    pub temp_c: Option<f64>,
    pub feels_like_c: Option<f64>,
    pub dew_point_c: Option<f64>,
    pub humidity_pct: Option<f64>,
    pub cloud_cover_pct: Option<f64>,
    pub uv_index: Option<f64>,
    pub precip_mm: Option<f64>,
    pub precip_prob_pct: Option<f64>,
    pub precip_type: Option<String>,
    pub thunder_prob_pct: Option<f64>,
    pub wind_speed_ms: Option<f64>,
    pub wind_gust_ms: Option<f64>,
    pub wind_dir_deg: Option<f64>,
    pub pressure_hpa: Option<f64>,
    pub visibility_km: Option<f64>,
}

/// `parse_current`'s result: current conditions plus the past-24-h summary.
#[derive(Debug, Clone, PartialEq, Default, Serialize)]
pub struct Current {
    #[serde(flatten)]
    pub conditions: Conditions,
    /// `currentTime` as Python's `isoformat()` (`2026-11-12T05:00:00.123456+00:00`).
    pub time_utc: Option<String>,
    pub time_zone: Option<String>,
    pub past24h_precip_mm: Option<f64>,
    pub past24h_max_temp_c: Option<f64>,
    pub past24h_min_temp_c: Option<f64>,
}

/// `parse_history_hour`'s result: one `historyHours` item.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct HistoryHour {
    /// Location-local start of the hour (naive).
    #[serde(serialize_with = "ser_naive")]
    pub hour_local: NaiveDateTime,
    /// `interval.startTime` in UTC.
    #[serde(serialize_with = "ser_opt_utc")]
    pub hour_utc: Option<DateTime<Utc>>,
    #[serde(flatten)]
    pub conditions: Conditions,
}

/// `parse_conditions`: flatten one current-conditions response or one `historyHours` item.
pub fn parse_conditions(d: &Value) -> Conditions {
    let cond = d.get("weatherCondition");
    let precip = d.get("precipitation");
    let wind = d.get("wind");
    fn get<'a>(v: Option<&'a Value>, k: &str) -> Option<&'a Value> {
        v.and_then(|v| v.get(k))
    }
    let prob = get(precip, "probability");
    Conditions {
        condition: str_of(get(cond, "type")),
        condition_text: str_of(get(get(cond, "description"), "text")),
        icon_uri: str_of(get(cond, "iconBaseUri")),
        is_daytime: d.get("isDaytime").and_then(Value::as_bool),
        temp_c: temp_c(d.get("temperature")),
        feels_like_c: temp_c(d.get("feelsLikeTemperature")),
        dew_point_c: temp_c(d.get("dewPoint")),
        humidity_pct: num(d.get("relativeHumidity")),
        cloud_cover_pct: num(d.get("cloudCover")),
        uv_index: num(d.get("uvIndex")),
        precip_mm: scaled(get(precip, "qpf"), "quantity", length_to_mm, "MILLIMETERS", 2),
        precip_prob_pct: num(get(prob, "percent")),
        precip_type: str_of(get(prob, "type")),
        thunder_prob_pct: num(d.get("thunderstormProbability")),
        wind_speed_ms: scaled(get(wind, "speed"), "value", speed_to_ms, "KILOMETERS_PER_HOUR", 1),
        wind_gust_ms: scaled(get(wind, "gust"), "value", speed_to_ms, "KILOMETERS_PER_HOUR", 1),
        wind_dir_deg: num(get(get(wind, "direction"), "degrees")),
        pressure_hpa: num(get(d.get("airPressure"), "meanSeaLevelMillibars")),
        visibility_km: scaled(d.get("visibility"), "distance", dist_to_km, "KILOMETERS", 1),
    }
}

/// `parse_current`: current conditions plus the past-24-h summary Google returns with them.
pub fn parse_current(d: &Value) -> Current {
    let hist = d.get("currentConditionsHistory");
    let get = |k: &str| hist.and_then(|h| h.get(k));
    Current {
        conditions: parse_conditions(d),
        time_utc: utc(d.get("currentTime")).map(|t| py::isoformat_utc(&t)),
        time_zone: str_of(d.get("timeZone").and_then(|z| z.get("id"))),
        past24h_precip_mm: scaled(get("qpf"), "quantity", length_to_mm, "MILLIMETERS", 2),
        past24h_max_temp_c: temp_c(get("maxTemperature")),
        past24h_min_temp_c: temp_c(get("minTemperature")),
    }
}

/// `parse_history_hour`: one `historyHours` item; None when its local hour cannot be told
/// (no valid `displayDateTime` and no `startTime` + `utcOffset` to derive it from).
pub fn parse_history_hour(h: &Value) -> Option<HistoryHour> {
    let start = utc(h.get("interval").and_then(|i| i.get("startTime")));
    let dd = h.get("displayDateTime");
    let mut local = local_naive(dd);
    if local.is_none() {
        if let Some(start) = start {
            // `_num(str(dd.get("utcOffset", "")).rstrip("s"))`
            let off = match dd.and_then(|d| d.get("utcOffset")) {
                None => None,
                Some(v) => py::str_value(v).and_then(|s| {
                    let s = s.trim_end_matches('s');
                    if s.is_empty() {
                        None
                    } else {
                        py::float_str(s)
                    }
                }),
            };
            // `start + timedelta(seconds=off)`; Python raises on NaN / overflow, here None.
            local = off.and_then(|off| {
                let micros = (off * 1e6).round_ties_even();
                if !micros.is_finite() || micros.abs() > 9.0e15 {
                    return None;
                }
                start.naive_utc().checked_add_signed(TimeDelta::microseconds(micros as i64))
            });
        }
    }
    let local = local?;
    let hour_local = local.with_minute(0)?.with_second(0)?.with_nanosecond(0)?;
    Some(HistoryHour { hour_local, hour_utc: start, conditions: parse_conditions(h) })
}

/// Name of the `requests` exception Python would raise for a transport failure, used in the
/// error messages (`"<path>: ReadTimeout"`).
pub fn requests_exc_name(e: &reqwest::Error) -> &'static str {
    if e.is_timeout() {
        if e.is_connect() {
            "ConnectTimeout"
        } else {
            "ReadTimeout"
        }
    } else if e.is_connect() {
        "ConnectionError"
    } else if e.is_redirect() {
        "TooManyRedirects"
    } else if e.is_builder() {
        "InvalidURL"
    } else if e.is_body() || e.is_decode() {
        "ChunkedEncodingError"
    } else {
        "ConnectionError"
    }
}

/// A `reqwest` client with `requests`' timeout semantics: `timeout` applies to the connect and
/// to each read, not to the whole request.
pub fn http_client(timeout_s: f64) -> reqwest::Client {
    let t = Duration::from_secs_f64(timeout_s.max(0.001));
    reqwest::Client::builder().connect_timeout(t).read_timeout(t).build().expect("reqwest client (rustls)")
}

/// The HTTP status reason (`r.reason`); reqwest does not keep the server's own phrase, so this
/// is the canonical one.
pub fn reason(status: reqwest::StatusCode) -> Option<&'static str> {
    status.canonical_reason().filter(|r| !r.is_empty())
}

/// Parse a response body as `r.json()` would (a leading UTF-8 BOM is skipped); None = not JSON.
pub fn json_body(bytes: &[u8]) -> Option<Value> {
    let b = bytes.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(bytes);
    serde_json::from_slice(b).ok()
}

/// `GoogleWeatherClient`: thin client; one HTTP call per method call (plus one per extra history
/// page). The key goes only in the `key` query parameter and is masked as `***` in every error.
pub struct GoogleWeatherClient {
    key: String,
    base: String,
    http: reqwest::Client,
    calls: AtomicU64,
}

impl std::fmt::Debug for GoogleWeatherClient {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("GoogleWeatherClient").field("base", &self.base).field("calls", &self.calls()).finish_non_exhaustive()
    }
}

impl GoogleWeatherClient {
    /// `GoogleWeatherClient.__init__(api_key, base_url, timeout)`; an empty key is an error.
    pub fn new(api_key: &str, base_url: &str, timeout_s: f64) -> Result<Self, GoogleWeatherError> {
        if api_key.is_empty() {
            return Err(GoogleWeatherError::new("GOOGLE_WEATHER_API_KEY is not set", None));
        }
        Ok(Self {
            key: api_key.to_string(),
            base: format!("{}/", base_url.trim_end_matches('/')),
            http: http_client(timeout_s),
            calls: AtomicU64::new(0),
        })
    }

    /// `calls`: HTTP requests made (each one is billable).
    pub fn calls(&self) -> u64 {
        self.calls.load(Ordering::Relaxed)
    }

    /// `_get`: one GET of `base + path` with `params` + `key`; a JSON object (anything else = `{}`).
    async fn get(&self, path: &str, params: &[(String, String)]) -> Result<Value, GoogleWeatherError> {
        self.calls.fetch_add(1, Ordering::Relaxed);
        let mut query: Vec<(&str, &str)> = params.iter().map(|(k, v)| (k.as_str(), v.as_str())).collect();
        query.push(("key", &self.key));
        let sent = self.http.get(format!("{}{path}", self.base)).query(&query).send().await;
        let resp = sent.map_err(|e| GoogleWeatherError::new(format!("{path}: {}", requests_exc_name(&e)), None))?;
        let status = resp.status();
        let bytes = resp.bytes().await.map_err(|e| GoogleWeatherError::new(format!("{path}: {}", requests_exc_name(&e)), None))?;
        let body = json_body(&bytes).unwrap_or_else(|| Value::Object(Default::default()));
        if status != reqwest::StatusCode::OK {
            let msg = body
                .get("error")
                .and_then(|e| e.get("message"))
                .filter(|m| py::truthy(m))
                .and_then(py::str_value)
                .or_else(|| reason(status).map(String::from))
                .unwrap_or_else(|| "error".into());
            let text = format!("{path}: HTTP {} {msg}", status.as_u16()).replace(&self.key, "***");
            return Err(GoogleWeatherError::new(text, Some(status.as_u16())));
        }
        Ok(if body.is_object() { body } else { Value::Object(Default::default()) })
    }

    /// `_loc`: `location.latitude` / `location.longitude` with 5 decimals, metric units.
    fn loc(lat: f64, lon: f64) -> Vec<(String, String)> {
        vec![
            ("location.latitude".into(), format!("{lat:.5}")),
            ("location.longitude".into(), format!("{lon:.5}")),
            ("unitsSystem".into(), "METRIC".into()),
        ]
    }

    /// `current`: `currentConditions:lookup` parsed by [`parse_current`]. Modelled values.
    pub async fn current(&self, lat: f64, lon: f64) -> Result<Current, GoogleWeatherError> {
        Ok(parse_current(&self.get("currentConditions:lookup", &Self::loc(lat, lon)).await?))
    }

    /// `history_hours`: the past `hours` hours (≤ 24), oldest first, following `nextPageToken`
    /// for at most `max_pages` calls (Python defaults: 24 hours, 2 pages). Modelled values.
    pub async fn history_hours(&self, lat: f64, lon: f64, hours: u32, max_pages: u32) -> Result<Vec<HistoryHour>, GoogleWeatherError> {
        let mut params = Self::loc(lat, lon);
        params.push(("hours".into(), hours.to_string()));
        params.push(("pageSize".into(), hours.to_string()));
        let mut rows = Vec::new();
        for _ in 0..max_pages {
            let body = self.get("history/hours:lookup", &params).await?;
            if let Some(items) = body.get("historyHours").and_then(Value::as_array) {
                rows.extend(items.iter().filter_map(parse_history_hour));
            }
            let token = match body.get("nextPageToken").filter(|t| py::truthy(t)).and_then(py::str_value) {
                Some(t) => t,
                None => break,
            };
            params.retain(|(k, _)| k != "pageToken");
            params.push(("pageToken".into(), token));
        }
        rows.sort_by_key(|r| r.hour_local);
        Ok(rows)
    }
}
