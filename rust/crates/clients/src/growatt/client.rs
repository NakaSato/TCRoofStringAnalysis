//! Port of `backend/solar_core/growatt/client.py`: the Growatt OpenAPI v1 client, one method per
//! endpoint, with the same in-memory TTL cache for the list endpoints.
//!
//! Base URL `https://openapi.growatt.com/v1/`, the account token in header `token` (marked
//! sensitive, never logged or printed by `Debug`). Classic endpoints answer
//! `{"error_code", "error_msg", "data"}`, the `new-api/*` ones `{"code", "message", "data"}`; a
//! non-zero code is an error even on HTTP 200 and comes back as [`GrowattApiError`] with
//! Growatt's own code (10012 = rate limited, [`GrowattApiError::is_rate_limited`]).
//!
//! Like Python, the client itself never retries and keeps no cooldown: the callers (live
//! services, worker jobs) decide what a 10012 means (60 s cooldowns, "3 × 10012 in a row ends
//! an account's sweep", `_retry`). One client = one Growatt account (project phase).

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::fmt;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use chrono::{NaiveDate, NaiveDateTime};
use reqwest::header::{HeaderMap, HeaderValue, ACCEPT};
use serde::Serialize;
use serde_json::{Map, Value};

use super::parsers::{self, MaxInfo, Record};
use super::py::{self, PyError, PyValue, TimeFormat};

/// `POOL_MAXSIZE`: keep-alive connections per host for one client (one Growatt account).
pub const POOL_MAXSIZE: usize = 32;

/// Default base URL (`GrowattClient(base_url=...)`).
pub const DEFAULT_BASE_URL: &str = "https://openapi.growatt.com/v1/";

/// Default request timeout in seconds (requests' `timeout=30`: connect and each read).
pub const DEFAULT_TIMEOUT_S: u64 = 30;

/// Default TTL of the list cache in seconds (`cache_ttl_s=300`).
pub const DEFAULT_CACHE_TTL_S: u64 = 300;

/// `DEVICE_TYPE_NAMES`: `device/list` `type` codes.
pub const DEVICE_TYPE_NAMES: [(i64, &str); 10] = [
    (1, "inverter"),
    (2, "storage"),
    (3, "other"),
    (4, "max"),
    (5, "sph"),
    (6, "spa"),
    (7, "min"),
    (8, "pcs"),
    (9, "hps"),
    (10, "pbd"),
];

/// `INVERTER_TYPES`: `device/list` types that are inverters.
pub const INVERTER_TYPES: [i64; 5] = [1, 4, 5, 6, 7];

/// `INVERTER_STATUS_NAMES`: inverter `status` codes. "Offline" is not a code: it is an inverter
/// Growatt lost contact with (`lost`) or one with no record today.
pub const INVERTER_STATUS_NAMES: [(i64, &str); 3] = [(0, "Waiting"), (1, "Normal"), (3, "Fault")];

/// `OFFLINE_LABEL`.
pub const OFFLINE_LABEL: &str = "Offline";

/// `ERROR_SNIPPET_MAX`: longest raw reply quoted in an error message.
pub const ERROR_SNIPPET_MAX: usize = 300;

/// `GrowattClient.MAXS_PAGE`: `device/max/maxs_data` answers about 50 serials per page.
pub const MAXS_PAGE: usize = 50;

/// Growatt's "called too often" code (the callers' `exc.error_code == 10012`).
pub const RATE_LIMITED_CODE: i64 = 10012;

// --------------------------------------------------------------------------- errors

/// Port of `GrowattAPIError`: a refused or failed Growatt call. `error_code` is Growatt's code
/// exactly as it sent it (`None` for transport failures, unreadable replies, a missing code).
#[derive(Debug, Clone, PartialEq)]
pub struct GrowattApiError {
    pub message: String,
    pub error_code: Option<Value>,
}

impl GrowattApiError {
    fn new(message: impl Into<String>, error_code: Option<Value>) -> Self {
        Self {
            message: message.into(),
            error_code,
        }
    }

    /// The code as Python compares it (`error_code == 10012` is true for 10012 and 10012.0, not
    /// for "10012").
    pub fn code(&self) -> Option<i64> {
        match self.error_code.as_ref()? {
            Value::Bool(b) => Some(i64::from(*b)),
            Value::Number(n) => n
                .as_i64()
                .or_else(|| n.as_f64().filter(|f| f.fract() == 0.0).map(|f| f as i64)),
            _ => None,
        }
    }

    /// Growatt error 10012 ("error_frequently_access").
    pub fn is_rate_limited(&self) -> bool {
        self.code() == Some(RATE_LIMITED_CODE)
    }
}

impl fmt::Display for GrowattApiError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

/// Everything a client method can fail with.
#[derive(Debug, Clone, PartialEq, thiserror::Error)]
pub enum GrowattError {
    /// `GrowattAPIError`: Growatt refused the call, or it failed / answered something unreadable.
    #[error("{0}")]
    Api(GrowattApiError),
    /// The `ValueError` the client raises itself for a date range Growatt would refuse.
    #[error("{0}")]
    InvalidArgument(String),
    /// A reply of a shape the Python client does not handle either (Python raises
    /// `AttributeError` / `TypeError` / `ValueError` there).
    #[error("unexpected Growatt reply: {0}")]
    Unexpected(#[from] PyError),
}

impl GrowattError {
    /// The [`GrowattApiError`], when this is one.
    pub fn api(&self) -> Option<&GrowattApiError> {
        match self {
            GrowattError::Api(e) => Some(e),
            _ => None,
        }
    }

    /// Growatt error 10012.
    pub fn is_rate_limited(&self) -> bool {
        self.api().is_some_and(GrowattApiError::is_rate_limited)
    }
}

fn api_err(message: impl Into<String>, code: Option<Value>) -> GrowattError {
    GrowattError::Api(GrowattApiError::new(message, code))
}

/// Port of `client._snippet`: a reply quoted in an error, whitespace collapsed, at most
/// [`ERROR_SNIPPET_MAX`] characters (`…` when cut).
pub fn snippet(value: &PyValue) -> String {
    let text = match value {
        PyValue::Str(s) => s.clone(),
        other => py::repr(other),
    };
    let joined = text
        .split(py::is_space)
        .filter(|w| !w.is_empty())
        .collect::<Vec<_>>()
        .join(" ");
    if joined.chars().count() <= ERROR_SNIPPET_MAX {
        joined
    } else {
        format!("{}…", py::head(&joined, ERROR_SNIPPET_MAX - 1))
    }
}

/// Port of `client.growatt_error_text`: Growatt's own reason for a refused call: `error_msg`,
/// else another message field it sent (`msg`, `message`, …), else the raw reply (shortened).
/// Never a made-up text. `body` is the reply's fields in Growatt's order.
pub fn growatt_error_text(body: &[(String, PyValue)]) -> String {
    let dict = PyValue::Dict(body.to_vec());
    for key in [
        "error_msg",
        "msg",
        "message",
        "error_message",
        "error",
        "result_msg",
    ] {
        if let Some(PyValue::Str(s)) = dict.get(key) {
            let t = py::strip(s);
            if !t.is_empty() {
                return t.to_owned();
            }
        }
    }
    let rest: Vec<(String, PyValue)> = body
        .iter()
        .filter(|(k, _)| k != "error_code")
        .cloned()
        .collect();
    if rest.is_empty() {
        "no message and no other fields".into()
    } else {
        format!("no message; reply {}", snippet(&PyValue::Dict(rest)))
    }
}

// --------------------------------------------------------------------------- results

/// One inverter of a plant from `list_inverters` (MAX inverters merged by serial). Fields other
/// than the labels are Growatt's values as reported.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct InverterEntry {
    /// `str(device_sn)` ("None" when Growatt sent none, as Python)
    pub device_sn: String,
    /// `model or ""`
    pub model: Value,
    pub datalogger_sn: Value,
    pub manufacturer: Value,
    pub status: Value,
    pub status_label: String,
    pub lost: bool,
    pub last_update_time: Value,
    pub device_types: Vec<String>,
}

/// `device_info_param`: model text, datalogger model and nominal power of one MAX inverter.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct DeviceInfoParam {
    pub device_model: Option<String>,
    pub datalogger_model: Option<String>,
    /// non-positive = `None`
    pub rated_power_w: Option<f64>,
}

/// `plant_details`: the static plant fields worth keeping.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct PlantDetails {
    pub timezone: Option<String>,
    pub address: Option<String>,
    pub growatt_inverter_count: Option<i64>,
    pub growatt_datalogger_count: Option<i64>,
}

// --------------------------------------------------------------------------- pure reply handling

/// `INVERTER_TYPES` membership with Python equality (`1`, `1.0` and `True` are all type 1).
fn inverter_type(dtype: &Value) -> Option<i64> {
    let n = match dtype {
        Value::Bool(b) => i64::from(*b),
        Value::Number(n) => match n.as_i64() {
            Some(i) => i,
            None => {
                let f = n.as_f64()?;
                if f.fract() != 0.0 {
                    return None;
                }
                f as i64
            }
        },
        _ => return None,
    };
    INVERTER_TYPES.contains(&n).then_some(n)
}

/// Port of the merge in `GrowattClient.list_inverters`: inverters of a `device/list` answer,
/// de-duplicated by serial (Growatt lists each MAX twice, type 1 and type 4), sorted by serial.
pub fn merge_inverters(devices: &[Value]) -> Result<Vec<InverterEntry>, PyError> {
    let mut merged: BTreeMap<String, InverterEntry> = BTreeMap::new();
    for dev in devices {
        let dev = py::as_dict(dev)?;
        let Some(dtype) = inverter_type(py::get(dev, "type")) else {
            continue;
        };
        let sn = py::str_of(py::get(dev, "device_sn"));
        let entry = merged.entry(sn.clone()).or_insert_with(|| {
            let status = py::get(dev, "status").clone();
            let or_blank = |k: &str| {
                let v = py::get(dev, k);
                if py::truthy(v) {
                    v.clone()
                } else {
                    Value::String(String::new())
                }
            };
            let status_label = if py::truthy(py::get(dev, "lost")) {
                OFFLINE_LABEL.to_owned()
            } else {
                // isinstance(status, int): ints and booleans
                let code = match &status {
                    Value::Bool(b) => Some(i64::from(*b)),
                    Value::Number(n) => n.as_i64(),
                    _ => None,
                };
                match code {
                    Some(c) => INVERTER_STATUS_NAMES
                        .iter()
                        .find(|(k, _)| *k == c)
                        .map_or_else(
                            || format!("Status {}", py::str_of(&status)),
                            |(_, name)| (*name).to_owned(),
                        ),
                    None => format!("Status {}", py::str_of(&status)),
                }
            };
            InverterEntry {
                device_sn: sn,
                model: or_blank("model"),
                datalogger_sn: or_blank("datalogger_sn"),
                manufacturer: or_blank("manufacturer"),
                status,
                status_label,
                lost: py::truthy(py::get(dev, "lost")),
                last_update_time: py::get(dev, "last_update_time").clone(),
                device_types: Vec::new(),
            }
        });
        let name = DEVICE_TYPE_NAMES
            .iter()
            .find(|(k, _)| *k == dtype)
            .map_or("", |(_, n)| n);
        entry.device_types.push(name.to_owned());
    }
    Ok(merged.into_values().collect())
}

/// Port of the fields `GrowattClient.device_info_param` keeps (`norminalPower` is Growatt's
/// spelling; `nominalPower` only when that key is absent).
pub fn parse_device_info_param(data: &Value) -> DeviceInfoParam {
    let d = py::dict_or_empty(data);
    let power_v = d
        .get("norminalPower")
        .unwrap_or_else(|| py::get(&d, "nominalPower"));
    let power = parsers::f(power_v);
    DeviceInfoParam {
        device_model: parsers::text(py::get(&d, "deviceModel")),
        datalogger_model: parsers::text(py::get(&d, "dataloggerModel")),
        rated_power_w: power.filter(|p| *p > 0.0),
    }
}

/// Port of the fields `GrowattClient.plant_details` keeps: time zone, street address and
/// Growatt's own inverter / datalogger counts (`None` when it lists none).
pub fn parse_plant_details(data: &Value) -> Result<PlantDetails, PyError> {
    let d = py::dict_or_empty(data);
    let count = |rows: &Value, key: &str| -> Result<Option<i64>, PyError> {
        let Value::Array(rows) = rows else {
            return Ok(None);
        };
        let mut vals = Vec::new();
        for r in rows.iter().filter_map(Value::as_object) {
            if let Some(n) = parsers::f(py::get(r, key)) {
                vals.push(py::int_from_f64(n)?);
            }
        }
        Ok((!vals.is_empty()).then(|| vals.iter().sum()))
    };
    let parts: Vec<String> = [py::get(&d, "address1"), py::get(&d, "address2")]
        .into_iter()
        .filter_map(parsers::text)
        .collect();
    let address = parts.join(", ");
    Ok(PlantDetails {
        timezone: parsers::text(py::get(&d, "timezone")),
        address: (!address.is_empty()).then_some(address),
        growatt_inverter_count: count(py::get(&d, "maxs"), "max_num")?,
        growatt_datalogger_count: count(py::get(&d, "dataloggers"), "datalogger_num")?,
    })
}

/// `datetime.strptime(str(v)[:19], "%Y-%m-%d %H:%M:%S")` (create dates).
fn create_time(v: &Value) -> Option<NaiveDateTime> {
    let s = py::str_of(v);
    py::strptime(py::head(&s, 19), TimeFormat::Seconds)
}

/// `int(data.get("count") or 0)`.
fn count_of(d: &Map<String, Value>) -> Result<i64, PyError> {
    let c = py::get(d, "count");
    if py::truthy(c) {
        py::int(c)
    } else {
        Ok(0)
    }
}

/// `isinstance(x, dict) and x.get(key)` truthy → the record, else `None`.
fn record_with(data: &Value, key: &str) -> Option<Record> {
    let d = data.as_object()?;
    py::truthy(py::get(d, key)).then(|| d.clone())
}

/// `rows[0]` of `data["max"]` when that is a non-empty list starting with a dict.
fn first_max(data: &Value) -> Option<Record> {
    data.as_object()?
        .get("max")?
        .as_array()?
        .first()?
        .as_object()
        .cloned()
}

fn dicts(items: Vec<Value>) -> Vec<Record> {
    items
        .into_iter()
        .filter_map(|v| match v {
            Value::Object(m) => Some(m),
            _ => None,
        })
        .collect()
}

fn range_check(
    start: NaiveDate,
    end: NaiveDate,
    max_days: i64,
    msg: &str,
) -> Result<(), GrowattError> {
    if (end - start).num_days() > max_days {
        return Err(GrowattError::InvalidArgument(msg.to_owned()));
    }
    Ok(())
}

fn ymd(d: NaiveDate) -> String {
    d.format("%Y-%m-%d").to_string()
}

// --------------------------------------------------------------------------- the client

/// Construction options of [`GrowattClient`] (the keyword arguments of `GrowattClient.__init__`).
#[derive(Debug, Clone)]
pub struct GrowattClientOptions {
    /// default [`DEFAULT_BASE_URL`]; a trailing `/` is added when missing
    pub base_url: String,
    /// connect timeout and read timeout, each (requests' `timeout`)
    pub timeout: Duration,
    /// TTL of the list cache
    pub cache_ttl: Duration,
    /// plants the app ignores: `list_plants` never returns them (`GROWATT_BLOCKED_PLANT_IDS`)
    pub blocked_plant_ids: Vec<i64>,
}

impl Default for GrowattClientOptions {
    fn default() -> Self {
        Self {
            base_url: DEFAULT_BASE_URL.to_owned(),
            timeout: Duration::from_secs(DEFAULT_TIMEOUT_S),
            cache_ttl: Duration::from_secs(DEFAULT_CACHE_TTL_S),
            blocked_plant_ids: Vec::new(),
        }
    }
}

type CacheKey = (String, Vec<(String, String)>);

#[derive(Clone, Copy, PartialEq, Eq)]
enum Send {
    /// GET with query parameters
    Get,
    /// POST with a form body (`data=`)
    PostForm,
    /// POST with query parameters and no body (`new-api/*`, `params=`)
    PostQuery,
}

/// Port of `GrowattClient`: thin Growatt OpenAPI v1 client with an in-memory TTL cache. Cheap
/// to clone (the HTTP pool and the cache are shared), like the one Python client shared by
/// several thread pools.
#[derive(Clone)]
pub struct GrowattClient {
    base_url: String,
    cache_ttl: Duration,
    blocked_plant_ids: Arc<HashSet<i64>>,
    http: reqwest::Client,
    cache: Arc<Mutex<HashMap<CacheKey, (Instant, Value)>>>,
}

impl fmt::Debug for GrowattClient {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        // never the token
        f.debug_struct("GrowattClient")
            .field("base_url", &self.base_url)
            .finish_non_exhaustive()
    }
}

type Params = Vec<(&'static str, String)>;

impl GrowattClient {
    /// Port of `GrowattClient.__init__`. An empty token is refused with Python's message; a token
    /// that cannot be an HTTP header value is refused here (Python would fail on every call).
    pub fn new(token: &str, opts: GrowattClientOptions) -> Result<Self, GrowattError> {
        if token.is_empty() {
            return Err(api_err(
                "Growatt API token is not configured (set GROWATT_API_TOKEN in .env).",
                None,
            ));
        }
        let mut value = HeaderValue::from_str(token)
            .map_err(|_| api_err("Growatt API token is not a valid HTTP header value.", None))?;
        value.set_sensitive(true);
        let mut headers = HeaderMap::new();
        headers.insert("token", value);
        headers.insert(ACCEPT, HeaderValue::from_static("*/*"));
        let http = reqwest::Client::builder()
            .default_headers(headers)
            .user_agent(concat!("tcroof-clients/", env!("CARGO_PKG_VERSION")))
            .connect_timeout(opts.timeout)
            .read_timeout(opts.timeout)
            .pool_max_idle_per_host(POOL_MAXSIZE)
            .build()
            .map_err(|e| api_err(format!("Growatt HTTP client could not be built: {e}"), None))?;
        Ok(Self {
            base_url: format!("{}/", opts.base_url.trim_end_matches('/')),
            cache_ttl: opts.cache_ttl,
            blocked_plant_ids: Arc::new(opts.blocked_plant_ids.into_iter().collect()),
            http,
            cache: Arc::new(Mutex::new(HashMap::new())),
        })
    }

    /// The base URL every path is appended to (always ends in `/`).
    pub fn base_url(&self) -> &str {
        &self.base_url
    }

    /// Sends one call and reads the reply as an order-keeping dict. Transport failures, HTTP
    /// errors and non-JSON replies are "Growatt request {path} failed: …" (requests raises its
    /// own `JSONDecodeError`, a `RequestException`, for a non-JSON body); a reply that is not a
    /// JSON object is "returned an unexpected reply".
    async fn send(
        &self,
        how: Send,
        path: &str,
        params: &Params,
    ) -> Result<Vec<(String, PyValue)>, GrowattError> {
        let url = format!("{}{}", self.base_url, path);
        let failed =
            |e: &dyn fmt::Display| api_err(format!("Growatt request {path} failed: {e}"), None);
        let req = match how {
            Send::Get => self.http.get(&url).query(params),
            Send::PostForm => self.http.post(&url).form(params),
            Send::PostQuery => self.http.post(&url).query(params),
        };
        let resp = req.send().await.map_err(|e| failed(&e))?;
        let resp = resp.error_for_status().map_err(|e| failed(&e))?;
        let bytes = resp.bytes().await.map_err(|e| failed(&e))?;
        let body: PyValue = serde_json::from_slice(&bytes).map_err(|e| failed(&e))?;
        match body {
            PyValue::Dict(items) => Ok(items),
            other => Err(api_err(
                format!(
                    "Growatt {path} returned an unexpected reply: {}",
                    snippet(&other)
                ),
                None,
            )),
        }
    }

    /// Port of `GrowattClient._request`: a classic endpoint; returns `data` (`Null` when absent).
    /// Any `error_code` other than 0 is an error.
    async fn request(&self, how: Send, path: &str, params: Params) -> Result<Value, GrowattError> {
        let body = self.send(how, path, &params).await?;
        let dict = PyValue::Dict(body.clone());
        let code = dict.get("error_code").cloned().unwrap_or(PyValue::Null);
        if !is_zero(&code) {
            return Err(api_err(
                format!(
                    "Growatt {path} error {}: {}",
                    py::py_str(&code),
                    growatt_error_text(&body)
                ),
                code_value(&code),
            ));
        }
        Ok(dict.get("data").map_or(Value::Null, Value::from))
    }

    /// Port of `GrowattClient._get`: GET through the TTL cache. Every answer is stored, also when
    /// `use_cache` is false, so a refresh renews the cached copy (as in Python).
    async fn get(
        &self,
        path: &str,
        use_cache: bool,
        params: Params,
    ) -> Result<Value, GrowattError> {
        let mut sorted: Vec<(String, String)> = params
            .iter()
            .map(|(k, v)| ((*k).to_owned(), v.clone()))
            .collect();
        sorted.sort();
        let key = (path.to_owned(), sorted);
        let now = Instant::now();
        if use_cache {
            let hit = self
                .cache
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .get(&key)
                .cloned();
            if let Some((at, data)) = hit {
                if now.duration_since(at) < self.cache_ttl {
                    return Ok(data);
                }
            }
        }
        let data = self.request(Send::Get, path, params).await?;
        self.cache
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .insert(key, (now, data.clone()));
        Ok(data)
    }

    /// Port of `GrowattClient._new_api`: POST to a `new-api/*` endpoint (query parameters, no
    /// body). These reply `{code, data, message}`; returns `data`, any refusal is an error with
    /// Growatt's code.
    async fn new_api(&self, path: &str, params: Params) -> Result<Value, GrowattError> {
        let body = self.send(Send::PostQuery, path, &params).await?;
        let dict = PyValue::Dict(body);
        // body.get("code", body.get("error_code")): a present "code" wins, even null
        let code = dict
            .get("code")
            .or_else(|| dict.get("error_code"))
            .cloned()
            .unwrap_or(PyValue::Null);
        if !is_zero(&code) {
            let msg = [dict.get("message"), dict.get("error_msg")]
                .into_iter()
                .flatten()
                .find(|v| py::py_truthy(v))
                .map_or_else(|| snippet(&dict), py::py_str);
            return Err(api_err(
                format!("Growatt {path} error {}: {msg}", py::py_str(&code)),
                code_value(&code),
            ));
        }
        Ok(dict.get("data").map_or(Value::Null, Value::from))
    }

    /// The `while True` paging of the list endpoints (`page`, `perpage=100`) until `count` items
    /// are read or a page is empty.
    async fn get_pages(
        &self,
        path: &str,
        use_cache: bool,
        params: &[(&'static str, String)],
        list_key: &str,
        only_dicts: bool,
    ) -> Result<Vec<Value>, GrowattError> {
        let mut out = Vec::new();
        let mut page = 1u32;
        loop {
            let mut p: Params = params.to_vec();
            p.push(("page", page.to_string()));
            p.push(("perpage", "100".into()));
            let data = py::or_dict(&self.get(path, use_cache, p).await?)?;
            let mut batch = py::or_list(py::get(&data, list_key))?;
            if only_dicts {
                batch.retain(Value::is_object);
            }
            let empty = batch.is_empty();
            out.extend(batch);
            if empty || out.len() as i64 >= count_of(&data)? {
                return Ok(out);
            }
            page += 1;
        }
    }

    /// History paging (`max_data`, `env_data`, `meter_data`): newest first, 100 per page, until
    /// `count`; with `stop_before`, stops once a page reaches records older than it.
    async fn history_pages(
        &self,
        how: Send,
        path: &str,
        params: &[(&'static str, String)],
        list_key: &str,
        time_of: fn(&Record) -> Option<NaiveDateTime>,
        stop_before: Option<NaiveDateTime>,
    ) -> Result<Vec<Value>, GrowattError> {
        let mut records = Vec::new();
        let mut page = 1u32;
        loop {
            let mut p: Params = params.to_vec();
            p.push(("page", page.to_string()));
            p.push(("perpage", "100".into()));
            let data = py::or_dict(&self.request(how, path, p).await?)?;
            let batch = py::or_list(py::get(&data, list_key))?;
            let Some(last) = batch.last().cloned() else {
                return Ok(records);
            };
            records.extend(batch);
            if records.len() as i64 >= count_of(&data)? {
                return Ok(records);
            }
            let oldest = time_of(py::as_dict(&last)?);
            if let (Some(stop), Some(old)) = (stop_before, oldest) {
                if old < stop {
                    return Ok(records);
                }
            }
            page += 1;
        }
    }

    // ------------------------------------------------------------------ plants and devices

    /// Port of `GrowattClient.list_plants`: every plant of the account (`plant/list`, 100 per
    /// page, cached unless `refresh`), blocked plants left out. Plants as Growatt reports them.
    pub async fn list_plants(&self, refresh: bool) -> Result<Vec<Record>, GrowattError> {
        let plants = self
            .get_pages("plant/list", !refresh, &[], "plants", false)
            .await?;
        let mut out = Vec::new();
        for p in plants {
            let d = py::as_dict(&p)?;
            // int(plant_id) in blocked; unreadable ids are never blocked
            let blocked = py::int(py::get(d, "plant_id"))
                .is_ok_and(|id| self.blocked_plant_ids.contains(&id));
            if !blocked {
                out.push(d.clone());
            }
        }
        Ok(out)
    }

    /// Port of `GrowattClient.plant_data`: one plant's current power, today / month / year / total
    /// energy and `last_update_time` (plant-local). Realtime, never cached here; `{}` when
    /// Growatt sends nothing.
    pub async fn plant_data(&self, plant_id: i64) -> Result<Value, GrowattError> {
        let data = self
            .get(
                "plant/data",
                false,
                vec![("plant_id", plant_id.to_string())],
            )
            .await?;
        Ok(if py::truthy(&data) {
            data
        } else {
            Value::Object(Map::new())
        })
    }

    /// Port of `GrowattClient.list_devices`: `device/list` of a plant, 100 per page, cached unless
    /// `refresh`; devices as reported.
    pub async fn list_devices(
        &self,
        plant_id: i64,
        refresh: bool,
    ) -> Result<Vec<Value>, GrowattError> {
        self.get_pages(
            "device/list",
            !refresh,
            &[("plant_id", plant_id.to_string())],
            "devices",
            false,
        )
        .await
    }

    /// Port of `GrowattClient.list_inverters`: the plant's inverters, de-duplicated by serial
    /// ([`merge_inverters`]).
    pub async fn list_inverters(
        &self,
        plant_id: i64,
        refresh: bool,
    ) -> Result<Vec<InverterEntry>, GrowattError> {
        let devices = self.list_devices(plant_id, refresh).await?;
        Ok(merge_inverters(&devices)?)
    }

    /// Port of `GrowattClient.max_info`: static facts of one MAX inverter
    /// (`device/max/max_data_info`): name, rating, firmware, settings. Never cached.
    pub async fn max_info(&self, device_sn: &str) -> Result<MaxInfo, GrowattError> {
        let data = py::or_dict(
            &self
                .get(
                    "device/max/max_data_info",
                    false,
                    vec![("device_sn", device_sn.into())],
                )
                .await?,
        )?;
        let m = match data.get("max") {
            Some(Value::Object(m)) => m.clone(),
            _ => data,
        };
        Ok(parsers::parse_max_info(&m)?)
    }

    /// Port of `GrowattClient.read_power`: active power limit of one MAX inverter, % of rated
    /// (`new-api/readPower`), read from the inverter through its datalogger (daylight only;
    /// code 5 DEVICE_OFFLINE, 18 READ_DEVICE_PARAM_FAIL). An answer without a number is an
    /// error with code 0.
    pub async fn read_power(&self, device_sn: &str) -> Result<f64, GrowattError> {
        let path = "new-api/readPower";
        let data = self
            .new_api(
                path,
                vec![("deviceSn", device_sn.into()), ("deviceType", "max".into())],
            )
            .await?;
        parsers::f(&data).ok_or_else(|| {
            api_err(
                format!("Growatt {path} answered no value"),
                Some(Value::from(0)),
            )
        })
    }

    /// Port of `GrowattClient.device_info`: the `max_info` fields from `new-api/queryDeviceInfo`
    /// (`data.max[0]`, same field names); all `None` when it lists none.
    pub async fn device_info(&self, device_sn: &str) -> Result<MaxInfo, GrowattError> {
        let data = self
            .new_api(
                "new-api/queryDeviceInfo",
                vec![("deviceSn", device_sn.into()), ("deviceType", "max".into())],
            )
            .await?;
        Ok(parsers::parse_max_info(
            &first_max(&data).unwrap_or_default(),
        )?)
    }

    /// Port of `GrowattClient.device_last_record`: newest record of one MAX inverter from
    /// `new-api/queryLastData` (`data.max[0]`, `max_data` fields, `time` plant-local); `None`
    /// when there is none. Realtime: callers must not store it.
    pub async fn device_last_record(
        &self,
        device_sn: &str,
    ) -> Result<Option<Record>, GrowattError> {
        let data = self
            .new_api(
                "new-api/queryLastData",
                vec![("deviceSn", device_sn.into()), ("deviceType", "max".into())],
            )
            .await?;
        Ok(first_max(&data).filter(|r| !r.is_empty() && py::truthy(py::get(r, "time"))))
    }

    /// Port of `GrowattClient.account_create_times`: every device of the account with its
    /// creation time on Growatt (`new-api/queryDeviceList`, 100 per page, at most `max_pages`
    /// pages, default 20); naive, as reported. Unreadable times are left out.
    pub async fn account_create_times(
        &self,
        max_pages: u32,
    ) -> Result<BTreeMap<String, NaiveDateTime>, GrowattError> {
        let mut out = BTreeMap::new();
        for page in 1..=max_pages {
            let data = self
                .new_api("new-api/queryDeviceList", vec![("page", page.to_string())])
                .await?;
            let d = py::dict_or_empty(&data);
            let rows = dicts(py::or_list(py::get(&d, "data"))?);
            for r in &rows {
                if let Some(ts) = create_time(py::get(r, "createDate")) {
                    out.insert(py::str_of(py::get(r, "deviceSn")), ts);
                }
            }
            if rows.is_empty() {
                break;
            }
            // page >= int(_f(d.get("pages")) or 0)
            let pages = match parsers::f(py::get(&d, "pages")) {
                Some(p) if p != 0.0 || p.is_nan() => py::int_from_f64(p)?,
                _ => 0,
            };
            if i64::from(page) >= pages {
                break;
            }
        }
        Ok(out)
    }

    /// Port of `GrowattClient.device_info_param`: model text, datalogger model and nominal power
    /// of one MAX inverter (`new-api/queryDeviceInfoParam`); empty text and a non-positive power
    /// are `None`.
    pub async fn device_info_param(
        &self,
        device_sn: &str,
    ) -> Result<DeviceInfoParam, GrowattError> {
        let data = self
            .new_api(
                "new-api/queryDeviceInfoParam",
                vec![("deviceSn", device_sn.into()), ("deviceType", "max".into())],
            )
            .await?;
        Ok(parse_device_info_param(&data))
    }

    // ------------------------------------------------------------------ Growatt's own energy / curves

    /// Port of `GrowattClient.plant_energy_days`: Growatt's daily energy (kWh) of a plant
    /// (`plant/energy`, `time_unit=day`), both dates inclusive, at most 31 days per call. A day
    /// Growatt lists without a number is `None`; rows without a readable date are skipped.
    pub async fn plant_energy_days(
        &self,
        plant_id: i64,
        start_date: NaiveDate,
        end_date: NaiveDate,
    ) -> Result<Vec<(NaiveDate, Option<f64>)>, GrowattError> {
        range_check(
            start_date,
            end_date,
            30,
            "plant/energy range must not exceed 31 days",
        )?;
        let mut out = Vec::new();
        let mut page = 1u32;
        loop {
            let params = vec![
                ("plant_id", plant_id.to_string()),
                ("start_date", ymd(start_date)),
                ("end_date", ymd(end_date)),
                ("time_unit", "day".into()),
                ("page", page.to_string()),
                ("perpage", "100".into()),
            ];
            let data = py::or_dict(&self.get("plant/energy", false, params).await?)?;
            let batch = py::or_list(py::get(&data, "energys"))?;
            for row in &batch {
                let row = py::as_dict(row)?;
                let s = py::str_of(py::get(row, "date"));
                if let Some(d) = py::date_fromisoformat(py::head(&s, 10)) {
                    out.push((d, parsers::f(py::get(row, "energy"))));
                }
            }
            if batch.is_empty() || out.len() as i64 >= count_of(&data)? {
                return Ok(out);
            }
            page += 1;
        }
    }

    /// Port of `GrowattClient.plant_power_day`: Growatt's 5-minute AC power curve (W) of a plant
    /// for one day (`plant/power`), oldest first, plant-local naive times. Slots Growatt answers
    /// as null (no upload, the future) are left out, never 0.
    pub async fn plant_power_day(
        &self,
        plant_id: i64,
        day: NaiveDate,
    ) -> Result<Vec<(NaiveDateTime, f64)>, GrowattError> {
        let data = py::or_dict(
            &self
                .get(
                    "plant/power",
                    false,
                    vec![("plant_id", plant_id.to_string()), ("date", ymd(day))],
                )
                .await?,
        )?;
        let mut out = Vec::new();
        for row in py::or_list(py::get(&data, "powers"))? {
            let row = py::as_dict(&row)?;
            let Some(w) = parsers::f(py::get(row, "power")) else {
                continue;
            };
            let Some(ts) = py::strptime(&py::str_of(py::get(row, "time")), TimeFormat::Minutes)
            else {
                continue;
            };
            out.push((ts, w));
        }
        out.sort_by(|a, b| a.0.cmp(&b.0).then(a.1.total_cmp(&b.1)));
        Ok(out)
    }

    /// Port of `GrowattClient.inverter_day_energy`: Growatt's energy (kWh) of one inverter for
    /// one day (`device/inverter/day_energy`).
    pub async fn inverter_day_energy(
        &self,
        device_sn: &str,
        day: NaiveDate,
    ) -> Result<Option<f64>, GrowattError> {
        let data = self
            .get(
                "device/inverter/day_energy",
                false,
                vec![("device_sn", device_sn.into()), ("date", ymd(day))],
            )
            .await?;
        Ok(parsers::f(&data))
    }

    /// Port of `GrowattClient.plant_details`: static plant fields from `plant/details`
    /// ([`parse_plant_details`]).
    pub async fn plant_details(&self, plant_id: i64) -> Result<PlantDetails, GrowattError> {
        let data = self
            .get(
                "plant/details",
                false,
                vec![("plant_id", plant_id.to_string())],
            )
            .await?;
        Ok(parse_plant_details(&data)?)
    }

    /// Port of `GrowattClient.maxs_latest`: newest record of several MAX inverters
    /// (`device/max/maxs_data`, POST, about 50 serials per page, at most `max_pages`, default 10),
    /// {serial: record} with the record's `dataloggerSn` added. Realtime: the live services must
    /// not store it. Rate limited per account (about 4 calls, then 10012 for ≈ 5 min).
    pub async fn maxs_latest(
        &self,
        device_sns: &[String],
        max_pages: u32,
    ) -> Result<BTreeMap<String, Record>, GrowattError> {
        let mut out: BTreeMap<String, Record> = BTreeMap::new();
        let wanted: BTreeSet<&str> = device_sns.iter().map(String::as_str).collect();
        for page in 1..=max_pages {
            let data = self
                .request(
                    Send::PostForm,
                    "device/max/maxs_data",
                    vec![
                        ("maxs", device_sns.join(",")),
                        ("pageNum", page.to_string()),
                    ],
                )
                .await?;
            let batch = py::dict_or_empty(&data);
            for (sn, v) in &batch {
                let Some(v) = v.as_object() else { continue };
                if let Some(Value::Object(rec)) = v.get(sn) {
                    let mut rec = rec.clone();
                    rec.insert("dataloggerSn".into(), py::get(v, "dataloggerSn").clone());
                    out.insert(sn.clone(), rec);
                }
            }
            if batch.is_empty()
                || wanted.iter().all(|sn| out.contains_key(*sn))
                || batch.len() < MAXS_PAGE
            {
                break;
            }
        }
        Ok(out)
    }

    /// Port of `GrowattClient.max_history`: records of a MAX inverter between two dates
    /// (inclusive, at most 7 days; `device/max/max_data`, POST, newest first, 100 per page).
    /// With `stop_before`, paging stops once a page reaches records older than it.
    pub async fn max_history(
        &self,
        device_sn: &str,
        start_date: NaiveDate,
        end_date: NaiveDate,
        stop_before: Option<NaiveDateTime>,
    ) -> Result<Vec<Value>, GrowattError> {
        range_check(
            start_date,
            end_date,
            6,
            "Growatt max_data date range must not exceed 7 days",
        )?;
        let params = [
            ("max_sn", device_sn.to_owned()),
            ("start_date", ymd(start_date)),
            ("end_date", ymd(end_date)),
        ];
        self.history_pages(
            Send::PostForm,
            "device/max/max_data",
            &params,
            "datas",
            parsers::record_time,
            stop_before,
        )
        .await
    }

    /// Port of `GrowattClient.max_history_batch`: one day's records of several MAX inverters
    /// (`new-api/queryDevicesHistoricalData`), {serial: records, newest first}. No paging
    /// fields: a caller must check the records reach back far enough.
    pub async fn max_history_batch(
        &self,
        device_sns: &[String],
        day: NaiveDate,
    ) -> Result<BTreeMap<String, Vec<Record>>, GrowattError> {
        let data = self
            .new_api(
                "new-api/queryDevicesHistoricalData",
                vec![
                    ("deviceSn", device_sns.join(",")),
                    ("deviceType", "max".into()),
                    ("date", ymd(day)),
                ],
            )
            .await?;
        let mut out = BTreeMap::new();
        for (sn, recs) in py::dict_or_empty(&data) {
            if let Value::Array(recs) = recs {
                out.insert(sn, dicts(recs));
            }
        }
        Ok(out)
    }

    /// Port of `GrowattClient.max_history_day`: one day's records of one MAX inverter from
    /// `new-api/queryHistoricalData`, newest first. `None` when Growatt says more follow
    /// (`haveNext`; its paging was not probed, so an incomplete answer is not used).
    pub async fn max_history_day(
        &self,
        device_sn: &str,
        day: NaiveDate,
    ) -> Result<Option<Vec<Record>>, GrowattError> {
        let data = self
            .new_api(
                "new-api/queryHistoricalData",
                vec![
                    ("deviceSn", device_sn.into()),
                    ("deviceType", "max".into()),
                    ("date", ymd(day)),
                ],
            )
            .await?;
        let d = py::dict_or_empty(&data);
        if py::truthy(py::get(&d, "haveNext")) {
            return Ok(None);
        }
        Ok(Some(dicts(py::or_list(py::get(&d, "datas"))?)))
    }

    /// Port of `GrowattClient.max_last_record`: newest record of one MAX inverter
    /// (`device/max/max_last_data`, POST); `None` when there is none. Realtime: callers must not
    /// store it.
    pub async fn max_last_record(&self, device_sn: &str) -> Result<Option<Record>, GrowattError> {
        let data = self
            .request(
                Send::PostForm,
                "device/max/max_last_data",
                vec![("max_sn", device_sn.into())],
            )
            .await?;
        Ok(record_with(&data, "time"))
    }

    /// Port of `GrowattClient.device_datalogger`: serial of the datalogger a device hangs on
    /// (`device/sn_datalog`, POST); `None` when Growatt names none.
    pub async fn device_datalogger(&self, device_sn: &str) -> Result<Option<String>, GrowattError> {
        let data = self
            .request(
                Send::PostForm,
                "device/sn_datalog",
                vec![("device_sn", device_sn.into())],
            )
            .await?;
        Ok(data
            .as_object()
            .and_then(|d| parsers::text(py::get(d, "datalogSN"))))
    }

    /// Port of `GrowattClient.list_dataloggers`: dataloggers of one plant
    /// (`device/datalogger/list`): sn, model, `lost`, `last_update_time` (a Java date object).
    /// Never cached; realtime fields must not be stored.
    pub async fn list_dataloggers(&self, plant_id: i64) -> Result<Vec<Record>, GrowattError> {
        let rows = self
            .get_pages(
                "device/datalogger/list",
                false,
                &[("plant_id", plant_id.to_string())],
                "dataloggers",
                true,
            )
            .await?;
        Ok(dicts(rows))
    }

    /// Port of `GrowattClient.devices_create_time`: when each device was added to Growatt
    /// (`device/all/create_date`, POST, several serials per call, at most `max_pages`, default
    /// 10), {serial: createTime}, naive as reported. Serials not answered, or answered without a
    /// readable time, are absent. Paging stops when a page brings no new serial.
    pub async fn devices_create_time(
        &self,
        device_sns: &[String],
        max_pages: u32,
    ) -> Result<BTreeMap<String, NaiveDateTime>, GrowattError> {
        let mut out = BTreeMap::new();
        let wanted: BTreeSet<&str> = device_sns.iter().map(String::as_str).collect();
        let mut seen: BTreeSet<String> = BTreeSet::new();
        for page in 1..=max_pages {
            let data = self
                .request(
                    Send::PostForm,
                    "device/all/create_date",
                    vec![
                        ("pageNum", page.to_string()),
                        ("devices", device_sns.join(",")),
                    ],
                )
                .await?;
            let batch = py::dict_or_empty(&data);
            let new: Vec<&String> = batch.keys().filter(|k| !seen.contains(*k)).collect();
            for sn in &new {
                seen.insert((*sn).clone());
                if let Some(v) = batch[*sn].as_object() {
                    if let Some(ts) = create_time(py::get(v, "createTime")) {
                        out.insert((*sn).clone(), ts);
                    }
                }
            }
            if new.is_empty() || wanted.iter().all(|sn| seen.contains(*sn)) {
                break;
            }
        }
        Ok(out)
    }

    // ------------------------------------------------------------------ weather (environmental) sensors
    // A datalogger with a weather sensor lists a type-3 device whose `device_sn` is literally
    // "env"; the sensor is addressed by (datalogger SN, bus address) from `env_list`. Rate
    // limits apply per datalogger.

    /// Port of `GrowattClient.list_env_sensors`: weather sensors on one datalogger
    /// (`device/env/env_list`): address, name, lost, lastUpdateTime. Cached unless `refresh`.
    pub async fn list_env_sensors(
        &self,
        datalogger_sn: &str,
        refresh: bool,
    ) -> Result<Vec<Value>, GrowattError> {
        self.get_pages(
            "device/env/env_list",
            !refresh,
            &[("datalog_sn", datalogger_sn.into())],
            "envs",
            false,
        )
        .await
    }

    /// Port of `GrowattClient.env_history`: weather-sensor records between two dates (inclusive,
    /// at most 7 days; `device/env/env_data`, GET, newest first, 100 per page). `stop_before`
    /// stops paging once a page reaches records older than it.
    pub async fn env_history(
        &self,
        datalogger_sn: &str,
        address: i64,
        start_date: NaiveDate,
        end_date: NaiveDate,
        stop_before: Option<NaiveDateTime>,
    ) -> Result<Vec<Value>, GrowattError> {
        range_check(
            start_date,
            end_date,
            6,
            "Growatt env_data date range must not exceed 7 days",
        )?;
        let params = [
            ("datalog_sn", datalogger_sn.to_owned()),
            ("address", address.to_string()),
            ("start_date", ymd(start_date)),
            ("end_date", ymd(end_date)),
        ];
        self.history_pages(
            Send::Get,
            "device/env/env_data",
            &params,
            "env_data",
            parsers::env_time,
            stop_before,
        )
        .await
    }

    /// Port of `GrowattClient.env_latest`: newest weather-sensor record
    /// (`device/env/env_last_data`); `None` when the sensor has none.
    pub async fn env_latest(
        &self,
        datalogger_sn: &str,
        address: i64,
    ) -> Result<Option<Record>, GrowattError> {
        let data = self
            .request(
                Send::Get,
                "device/env/env_last_data",
                vec![
                    ("datalog_sn", datalogger_sn.into()),
                    ("address", address.to_string()),
                ],
            )
            .await?;
        Ok(record_with(&data, "timeText"))
    }

    // ------------------------------------------------------------------ energy meters ("ammeter")

    /// Port of `GrowattClient.list_meters`: meters on one datalogger
    /// (`device/ammeter/meter_list`): address, device_name, device_type, lost. Cached unless
    /// `refresh`.
    pub async fn list_meters(
        &self,
        datalogger_sn: &str,
        refresh: bool,
    ) -> Result<Vec<Value>, GrowattError> {
        self.get_pages(
            "device/ammeter/meter_list",
            !refresh,
            &[("datalog_sn", datalogger_sn.into())],
            "meters",
            false,
        )
        .await
    }

    /// Port of `GrowattClient.meter_latest`: newest meter record
    /// (`device/ammeter/meter_last_data`, same fields as `meter_data`, `timeText` plant-local);
    /// `None` when the meter has none.
    pub async fn meter_latest(
        &self,
        datalogger_sn: &str,
        address: i64,
    ) -> Result<Option<Record>, GrowattError> {
        let data = self
            .request(
                Send::Get,
                "device/ammeter/meter_last_data",
                vec![
                    ("datalog_sn", datalogger_sn.into()),
                    ("address", address.to_string()),
                ],
            )
            .await?;
        Ok(record_with(&data, "timeText"))
    }

    /// Port of `GrowattClient.meter_history`: meter records between two dates (inclusive, at
    /// most 7 days; `device/ammeter/meter_data`, GET, newest first, 100 per page).
    pub async fn meter_history(
        &self,
        datalogger_sn: &str,
        address: i64,
        start_date: NaiveDate,
        end_date: NaiveDate,
        stop_before: Option<NaiveDateTime>,
    ) -> Result<Vec<Value>, GrowattError> {
        range_check(
            start_date,
            end_date,
            6,
            "Growatt meter_data date range must not exceed 7 days",
        )?;
        let params = [
            ("datalog_sn", datalogger_sn.to_owned()),
            ("address", address.to_string()),
            ("start_date", ymd(start_date)),
            ("end_date", ymd(end_date)),
        ];
        self.history_pages(
            Send::Get,
            "device/ammeter/meter_data",
            &params,
            "meter_data",
            parsers::env_time,
            stop_before,
        )
        .await
    }

    /// Port of `GrowattClient.max_alarms`: alarm / fault log of one MAX inverter for one
    /// plant-local day (`device/max/alarm_data`, POST; defaults `perpage` 100, `max_pages` 10).
    /// Records as reported (start_time, end_time, alarm_code, alarm_message, fault_type, status).
    pub async fn max_alarms(
        &self,
        device_sn: &str,
        day: NaiveDate,
        perpage: u32,
        max_pages: u32,
    ) -> Result<Vec<Value>, GrowattError> {
        let mut out = Vec::new();
        for page in 1..=max_pages {
            let data = self
                .request(
                    Send::PostForm,
                    "device/max/alarm_data",
                    vec![
                        ("max_sn", device_sn.into()),
                        ("date", day.to_string()),
                        ("page", page.to_string()),
                        ("perpage", perpage.to_string()),
                    ],
                )
                .await?;
            let body = py::dict_or_empty(&data);
            let batch = py::or_list(py::get(&body, "alarms"))?;
            let empty = batch.is_empty();
            out.extend(batch);
            if empty || out.len() as i64 >= count_of(&body)? {
                break;
            }
        }
        Ok(out)
    }
}

/// Port of `client.newest_max_records`: the day's `n` newest `max_data` records, newest first
/// (first page only, one call, no paging).
pub async fn newest_max_records(
    client: &GrowattClient,
    device_sn: &str,
    day: NaiveDate,
    n: usize,
) -> Result<Vec<Value>, GrowattError> {
    let data = client
        .request(
            Send::PostForm,
            "device/max/max_data",
            vec![
                ("max_sn", device_sn.into()),
                ("start_date", ymd(day)),
                ("end_date", ymd(day)),
                ("page", "1".into()),
                ("perpage", "100".into()),
            ],
        )
        .await?;
    let data = py::or_dict(&data)?;
    let datas = py::get(&data, "datas");
    match datas {
        Value::Array(a) => Ok(a.iter().take(n).cloned().collect()),
        v if !py::truthy(v) => Ok(Vec::new()),
        other => Err(PyError(format!("TypeError: cannot slice {}", py::type_name(other))).into()),
    }
}

/// `code != 0` is false for 0, 0.0 and `False` (Python equality).
fn is_zero(code: &PyValue) -> bool {
    match code {
        PyValue::Int(i) => *i == 0,
        PyValue::UInt(u) => *u == 0,
        PyValue::Float(f) => *f == 0.0,
        PyValue::Bool(b) => !*b,
        _ => false,
    }
}

/// The code kept on the error (`None` for a missing / null code).
fn code_value(code: &PyValue) -> Option<Value> {
    match code {
        PyValue::Null => None,
        other => Some(Value::from(other)),
    }
}
