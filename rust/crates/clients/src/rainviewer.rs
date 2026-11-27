//! Port of `backend/solar_core/rainviewer.py`: RainViewer Weather Maps API client
//! (<https://www.rainviewer.com/api/weather-maps-api.html>).
//!
//! Pure HTTP + parsing. Used only as the fallback rain radar on the Plant Map when Longdo is not
//! configured or has nothing to serve. No key, no point values: only the list of radar snapshots
//! (past ~2 h, 10 min apart) and their XYZ tiles, which the browser loads itself.
//!
//! `weather-maps.json` answers `{host, radar: {past: [{time, path}]}}`; each snapshot has its own
//! `path` (a hash, not the time), so the tile URL is given per snapshot. Tiles exist up to zoom 7.
//! RainViewer asks for the credit "Weather data by RainViewer" with a link, and the free API is
//! meant for personal, educational and small community use, without an SLA.

use std::collections::BTreeMap;

use serde::Serialize;
use serde_json::Value;

use crate::google_weather::{http_client, json_body, py, requests_exc_name};

/// `DEFAULT_URL` (also `settings.rainviewer_url`'s default).
pub const DEFAULT_URL: &str = "https://api.rainviewer.com/public/weather-maps.json";
/// `RainViewerClient.__init__`'s default timeout, seconds (`settings.rainviewer_timeout_s`, 6).
pub const DEFAULT_TIMEOUT_S: f64 = 6.0;
/// `TILE_MIN_ZOOM`
pub const TILE_MIN_ZOOM: u8 = 0;
/// `TILE_MAX_ZOOM`
pub const TILE_MAX_ZOOM: u8 = 7;
/// `TILE_SIZE`
pub const TILE_SIZE: u32 = 256;
/// `COLOR_SCHEME`: "Universal Blue", the scheme the free API serves.
pub const COLOR_SCHEME: u32 = 2;
/// `OPTIONS`: smoothed, no separate snow colours.
pub const OPTIONS: &str = "1_0";
/// `ATTRIBUTION`
pub const ATTRIBUTION: &str = r#"<a href="https://www.rainviewer.com/" target="_blank" rel="noreferrer">Weather data by RainViewer</a>"#;

/// `RainViewerError`: the API refused or failed, or answered something that is not the
/// snapshot list.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{0}")]
pub struct RainViewerError(pub String);

/// `parse_maps`'s result: `{frames: [Unix time, oldest first], tiles: {str(time): XYZ tile URL}}`.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize)]
pub struct Maps {
    pub frames: Vec<i64>,
    /// Keyed by Unix time; serialized with string keys in time order, as Python's dict.
    pub tiles: BTreeMap<i64, String>,
}

/// `parse_maps`: the past radar snapshots; a snapshot without a time (or time 0) or a path
/// starting with `/` is left out. Errors when the answer is not an object or has no `https://` host.
pub fn parse_maps(body: &Value) -> Result<Maps, RainViewerError> {
    if !body.is_object() {
        return Err(RainViewerError("RainViewer answered no snapshot list".into()));
    }
    let host = py::get_truthy(body, "host").and_then(py::str_value).unwrap_or_default();
    let host = host.trim_end_matches('/');
    if !host.starts_with("https://") {
        return Err(RainViewerError("RainViewer answered no tile host".into()));
    }
    let past = body.get("radar").filter(|r| r.is_object()).and_then(|r| r.get("past"));
    let mut tiles = BTreeMap::new();
    for f in past.and_then(Value::as_array).map_or(&[][..], Vec::as_slice) {
        if !f.is_object() {
            continue;
        }
        let t = f.get("time").and_then(|v| py::int_value(v, false));
        let path = f.get("path").and_then(Value::as_str);
        if let (Some(t), Some(path)) = (t.filter(|t| *t != 0), path.filter(|p| p.starts_with('/'))) {
            tiles.insert(t, format!("{host}{path}/{TILE_SIZE}/{{z}}/{{x}}/{{y}}/{COLOR_SCHEME}/{OPTIONS}.png"));
        }
    }
    Ok(Maps { frames: tiles.keys().copied().collect(), tiles })
}

/// `RainViewerClient`: one GET of the snapshot list per [`RainViewerClient::maps`] call.
#[derive(Debug)]
pub struct RainViewerClient {
    /// `url`
    pub url: String,
    http: reqwest::Client,
}

impl RainViewerClient {
    /// `RainViewerClient.__init__(url, timeout)`.
    pub fn new(url: &str, timeout_s: f64) -> Self {
        Self { url: url.to_string(), http: http_client(timeout_s) }
    }

    /// `maps`: fetch and parse `weather-maps.json`.
    pub async fn maps(&self) -> Result<Maps, RainViewerError> {
        let unreachable = |e: reqwest::Error| RainViewerError(format!("RainViewer not reachable: {}", requests_exc_name(&e)));
        let resp = self.http.get(&self.url).send().await.map_err(unreachable)?;
        let status = resp.status();
        if status != reqwest::StatusCode::OK {
            return Err(RainViewerError(format!("RainViewer answered HTTP {}", status.as_u16())));
        }
        let bytes = resp.bytes().await.map_err(unreachable)?;
        let body = json_body(&bytes).ok_or_else(|| RainViewerError("RainViewer answered no JSON".into()))?;
        parse_maps(&body)
    }
}
