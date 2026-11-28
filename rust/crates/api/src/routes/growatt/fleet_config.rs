//! Settings stored in SQL (backend/app/api/routes/growatt/fleet_config.py): the fleet module, a
//! plant's string layout, the "not installed" mark and the tariff; plus the per-plant document
//! links (backend/app/api/routes/growatt/documents.py). Writes that Python mirrors to the summary
//! sink right away call `tcroof_services::publish` (`SinkPublisher`); a failed publish never
//! undoes the save and is reported in `published`.
//!
//! Auth exactly as Python: fleet module PUT, installed PUT, tariff writes and document writes are
//! admin only; the string layout PUT is any writer of the plant (`require_plant_write`). Request
//! bodies are validated the pydantic way (status 422; the body is one message, see validate.rs).

use std::cmp::Ordering;

use axum::body::Bytes;
use axum::extract::{Path, RawQuery, State};
use axum::http::{header, HeaderMap};
use axum::routing::{get, post, put};
use axum::{Json, Router};
use chrono::{FixedOffset, NaiveDate, Utc};
use serde_json::{json, Map, Value};

use tcroof_db::User;
use tcroof_services::common::ServiceError;
use tcroof_services::layout::LayoutEntry;
use tcroof_services::plant_documents::{self as docs, ImportRow};
use tcroof_services::publish::{published_json, Publisher, SinkPublisher};
use tcroof_services::{fleet_settings, inverter_install, layout, tariff};

use crate::error::ApiError;
use crate::extract::{parse_int, AdminUser, CurrentUser, PlantRead, PlantScope, PlantWrite, Scoped};
use crate::pyfmt::repr_str;
use crate::validate as v;
use crate::AppState;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/fleet-module", get(get_fleet_module).put(put_fleet_module))
        .route("/plants/{plant_id}/string-layout", get(get_string_layout).put(put_string_layout))
        .route("/plants/{plant_id}/inverters/{device_sn}/installed", put(put_inverter_installed))
        .route("/tariff", get(get_tariff).put(put_tariff))
        .route("/tariff/pwa-rates", post(post_tariff_pwa_rates))
        .route("/tariff/rates", get(get_tariff_rates))
        .route("/documents", get(list_plant_documents))
        .route("/documents/import", post(import_plant_documents))
        .route("/plants/{plant_id}/documents", get(get_plant_documents))
        .route("/plants/{plant_id}/documents/{kind}", put(put_plant_document).delete(delete_plant_document))
}

// --------------------------------------------------------------------------- helpers

/// Python `user.username or user.email`
fn who(u: &User) -> String {
    u.username.clone().filter(|s| !s.is_empty()).unwrap_or_else(|| u.email.clone())
}

fn service_err(e: ServiceError) -> ApiError {
    match e {
        ServiceError::NotFound(m) => ApiError::NotFound(m),
        ServiceError::Invalid(m) => ApiError::Unprocessable(m),
        ServiceError::Db(e) => ApiError::Db(e),
    }
}

fn db_err(e: tcroof_db::Error) -> ApiError {
    ApiError::Db(e)
}

fn unprocessable(field: &str, msg: impl std::fmt::Display) -> ApiError {
    ApiError::Unprocessable(format!("{field}: {msg}"))
}

/// The settings' publisher (Python `make_sink(settings.publish_sink)` + the write budget)
fn publisher(st: &AppState) -> SinkPublisher {
    SinkPublisher { sink: st.settings.sink_config(), budget: st.settings.publish_daily_write_budget }
}

/// `{**a, key: value}`
fn with(mut a: Value, key: &str, value: Value) -> Value {
    if let Some(o) = a.as_object_mut() {
        o.insert(key.into(), value);
    }
    a
}

/// FastAPI's `plant_id: int` path parameter of a route without a plant dependency
fn path_plant_id(raw: &str) -> Result<i64, ApiError> {
    parse_int(raw).ok_or_else(|| unprocessable("plant_id", format!("Input should be a valid integer, got {raw:?}")))
}

/// FastAPI's JSON body read (any JSON value; `validate::json_object` for objects)
fn json_value(headers: &HeaderMap, body: &[u8]) -> Result<Value, ApiError> {
    let ct = headers.get(header::CONTENT_TYPE).and_then(|v| v.to_str().ok()).unwrap_or("");
    let mime = ct.split(';').next().unwrap_or("").trim().to_ascii_lowercase();
    let is_json = mime.is_empty() || mime == "application/json" || (mime.starts_with("application/") && mime.ends_with("+json"));
    if !is_json {
        return Err(unprocessable("body", "Input should be a valid list"));
    }
    if body.is_empty() {
        return Err(unprocessable("body", "Field required"));
    }
    match serde_json::from_slice::<Value>(body) {
        Ok(Value::Null) => Err(unprocessable("body", "Field required")),
        Ok(v) => Ok(v),
        Err(e) => Err(unprocessable("body", format!("JSON decode error: {e}"))),
    }
}

/// pydantic lax `float`: a number, a bool, or a number in a string
fn float(field: &str, val: &Value) -> Result<f64, ApiError> {
    match val {
        Value::Number(n) => n.as_f64().ok_or_else(|| unprocessable(field, "Input should be a valid number")),
        Value::Bool(b) => Ok(if *b { 1.0 } else { 0.0 }),
        Value::String(s) => s
            .trim()
            .parse::<f64>()
            .map_err(|_| unprocessable(field, "Input should be a valid number, unable to parse string as a number")),
        _ => Err(unprocessable(field, "Input should be a valid number")),
    }
}

/// Bounds of a pydantic `Field(gt / ge / lt / le)`
#[derive(Clone, Copy)]
enum Lo {
    Gt(f64),
    Ge(f64),
}

fn bounded(field: &str, x: f64, lo: Lo, le: f64) -> Result<f64, ApiError> {
    match lo {
        Lo::Gt(g) if x.partial_cmp(&g) != Some(Ordering::Greater) => return Err(unprocessable(field, format!("Input should be greater than {}", num_text(g)))),
        Lo::Ge(g) if !matches!(x.partial_cmp(&g), Some(Ordering::Greater | Ordering::Equal)) => {
            return Err(unprocessable(field, format!("Input should be greater than or equal to {}", num_text(g))))
        }
        _ => {}
    }
    if !matches!(x.partial_cmp(&le), Some(Ordering::Less | Ordering::Equal)) {
        return Err(unprocessable(field, format!("Input should be less than or equal to {}", num_text(le))));
    }
    Ok(x)
}

fn num_text(x: f64) -> String {
    if x.fract() == 0.0 {
        format!("{}", x as i64)
    } else {
        format!("{x}")
    }
}

/// A required `float` field with bounds
fn req_float(obj: &Map<String, Value>, field: &str, lo: Lo, le: f64) -> Result<f64, ApiError> {
    match obj.get(field) {
        None => Err(unprocessable(field, "Field required")),
        Some(x) => bounded(field, float(field, x)?, lo, le),
    }
}

/// An `Optional[float] = default` field with bounds: absent = the default, null = None
fn opt_float(obj: &Map<String, Value>, field: &str, default: Option<f64>, lo: Lo, le: f64) -> Result<Option<f64>, ApiError> {
    match obj.get(field) {
        None => Ok(default),
        Some(Value::Null) => Ok(None),
        Some(x) => bounded(field, float(field, x)?, lo, le).map(Some),
    }
}

fn int_in(field: &str, val: &Value, ge: i64, le: i64) -> Result<i64, ApiError> {
    let n = v::integer(field, val)?;
    if n < ge {
        return Err(unprocessable(field, format!("Input should be greater than or equal to {ge}")));
    }
    if n > le {
        return Err(unprocessable(field, format!("Input should be less than or equal to {le}")));
    }
    Ok(n)
}

/// A `str` field matching a pydantic `pattern` (Rust `regex` semantics, as pydantic-core uses)
fn pattern(field: &str, s: &str, pat: &str) -> Result<(), ApiError> {
    let re = regex::Regex::new(pat).expect("valid pattern");
    if re.is_match(s) {
        Ok(())
    } else {
        Err(unprocessable(field, format!("String should match pattern '{pat}'")))
    }
}

fn object<'a>(field: &str, val: &'a Value) -> Result<&'a Map<String, Value>, ApiError> {
    val.as_object().ok_or_else(|| unprocessable(field, "Input should be a valid dictionary or object to extract fields from"))
}

fn list<'a>(field: &str, val: &'a Value) -> Result<&'a Vec<Value>, ApiError> {
    val.as_array().ok_or_else(|| unprocessable(field, "Input should be a valid list"))
}

/// The query string as Starlette reads it; the last value of a key wins
fn query_last(raw: Option<&str>, key: &str) -> Option<String> {
    form_urlencoded::parse(raw.unwrap_or("").as_bytes()).into_owned().filter(|(k, _)| k == key).last().map(|(_, v)| v)
}

/// Python `jobs._today()`: today in plant-local (Bangkok, UTC+7) time
fn plant_today() -> NaiveDate {
    Utc::now().with_timezone(&FixedOffset::east_opt(7 * 3600).expect("UTC+7")).date_naive()
}

/// Python `str(x)` of a JSON value (`%s` in a log line): strings bare, containers as `repr`.
fn py_str(x: &Value) -> String {
    match x {
        Value::String(s) => s.clone(),
        other => py_repr(other),
    }
}

fn py_repr(x: &Value) -> String {
    match x {
        Value::Null => "None".into(),
        Value::Bool(b) => (if *b { "True" } else { "False" }).into(),
        Value::Number(n) if n.is_i64() || n.is_u64() => n.to_string(),
        Value::Number(n) => tcroof_services::publish::py_float_repr(n.as_f64().unwrap_or(f64::NAN)),
        Value::String(s) => repr_str(s),
        Value::Array(a) => format!("[{}]", a.iter().map(py_repr).collect::<Vec<_>>().join(", ")),
        Value::Object(m) => {
            format!("{{{}}}", m.iter().map(|(k, x)| format!("{}: {}", repr_str(k), py_repr(x))).collect::<Vec<_>>().join(", "))
        }
    }
}

/// Python `==` of two JSON-loaded values (1 == 1.0)
fn py_eq(a: Option<&Value>, b: Option<&Value>) -> bool {
    match (a, b) {
        (None, None) => true,
        (Some(Value::Number(x)), Some(Value::Number(y))) => x.as_f64() == y.as_f64(),
        (Some(Value::Array(x)), Some(Value::Array(y))) => x.len() == y.len() && x.iter().zip(y).all(|(p, q)| py_eq(Some(p), Some(q))),
        (Some(Value::Object(x)), Some(Value::Object(y))) => {
            x.len() == y.len() && x.iter().all(|(k, p)| y.get(k).is_some_and(|q| py_eq(Some(p), Some(q))))
        }
        (Some(x), Some(y)) => x == y,
        _ => false,
    }
}

// --------------------------------------------------------------------------- fleet module

/// GET /growatt/fleet-module: Python `fleet_config.get_fleet_module`
async fn get_fleet_module(State(st): State<AppState>, CurrentUser(_): CurrentUser) -> Result<Json<Value>, ApiError> {
    Ok(Json(fleet_settings::get_fleet_module(&st.pool).await.map_err(db_err)?))
}

/// Python `api_schemas.FleetModule` → `model_dump()`
fn fleet_module_body(obj: &Map<String, Value>) -> Result<Value, ApiError> {
    let manufacturer = v::required_string(obj, "manufacturer", 1, 64)?;
    let model = v::required_string(obj, "model", 1, 64)?;
    let wp = req_float(obj, "wp", Lo::Ge(50.0), 1500.0)?;
    let f = |k: &str, d: Option<f64>, lo: Lo, le: f64| opt_float(obj, k, d, lo, le);
    let cell_technology = v::optional_string(obj, "cell_technology", 0, usize::MAX)?;
    if let Some(c) = &cell_technology {
        pattern("cell_technology", c, "^(perc|topcon|hjt|ibc)$")?;
    }
    Ok(json!({
        "manufacturer": manufacturer,
        "model": model,
        "wp": wp,
        "vmp_stc": f("vmp_stc", None, Lo::Gt(0.0), 200.0)?,
        "imp_stc": f("imp_stc", None, Lo::Gt(0.0), 50.0)?,
        "voc_stc": f("voc_stc", None, Lo::Gt(0.0), 200.0)?,
        "isc_stc": f("isc_stc", None, Lo::Gt(0.0), 50.0)?,
        "efficiency_pct": f("efficiency_pct", None, Lo::Gt(0.0), 40.0)?,
        "temp_coeff_pmax_pct": f("temp_coeff_pmax_pct", None, Lo::Ge(-2.0), 2.0)?,
        "temp_coeff_voc_pct": f("temp_coeff_voc_pct", None, Lo::Ge(-2.0), 2.0)?,
        "temp_coeff_isc_pct": f("temp_coeff_isc_pct", None, Lo::Ge(-2.0), 2.0)?,
        "bifacial_factor_pct": f("bifacial_factor_pct", None, Lo::Ge(0.0), 100.0)?,
        "rs_ohm": f("rs_ohm", Some(0.22), Lo::Gt(0.0), 10.0)?,
        "kappa_ohm_per_k": f("kappa_ohm_per_k", Some(0.0012), Lo::Ge(0.0), 1.0)?,
        "first_year_lid_pct": f("first_year_lid_pct", Some(1.0), Lo::Ge(0.0), 10.0)?,
        "annual_degradation_pct": f("annual_degradation_pct", Some(0.45), Lo::Ge(0.0), 5.0)?,
        "cell_technology": cell_technology,
        "p2_b1": f("p2_b1", None, Lo::Ge(0.0), 0.5)?,
        "p2_b2": f("p2_b2", None, Lo::Ge(-0.5), 0.5)?,
        "datasheet_url": v::optional_string(obj, "datasheet_url", 0, 500)?,
    }))
}

/// PUT /growatt/fleet-module (admin): Python `fleet_config.put_fleet_module`. Saves to SQL, then
/// publishes `config/*`; a failed publish does not undo the save.
async fn put_fleet_module(
    State(st): State<AppState>,
    AdminUser(user): AdminUser,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Json<Value>, ApiError> {
    let value = fleet_module_body(&v::json_object(&headers, &body)?)?;
    let by = who(&user);
    let saved = fleet_settings::put_fleet_module(&st.pool, &value, Some(&by)).await.map_err(db_err)?;
    tracing::info!(target: "app.audit", "{by} saved the fleet module");
    let published = published_json(publisher(&st).publish_config(&st.pool).await);
    Ok(Json(with(saved, "published", published)))
}

// --------------------------------------------------------------------------- string layout

/// GET /growatt/plants/{plant_id}/string-layout: Python `fleet_config.get_growatt_string_layout`
async fn get_string_layout(State(st): State<AppState>, p: PlantRead) -> Result<Json<Value>, ApiError> {
    Ok(Json(layout::get_string_layout(&st.pool, p.plant_id).await.map_err(service_err)?))
}

/// Python `api_schemas.GrowattStringLayoutEntry` (with its `modules unless removed` check)
fn layout_entry(i: usize, val: &Value) -> Result<LayoutEntry, ApiError> {
    let at = |k: &str| format!("{i}.{k}");
    let obj = object(&i.to_string(), val)?;
    let device_sn = match obj.get("device_sn") {
        None => return Err(unprocessable(&at("device_sn"), "Field required")),
        Some(x) => v::string(&at("device_sn"), x, 1, 64)?,
    };
    let string_no = match obj.get("string_no") {
        None => return Err(unprocessable(&at("string_no"), "Field required")),
        Some(x) => int_in(&at("string_no"), x, 1, 64)?,
    };
    let removed = match obj.get("removed") {
        None => false,
        Some(x) => v::boolean(&at("removed"), x)?,
    };
    let modules = match obj.get("modules") {
        None | Some(Value::Null) => None,
        Some(x) => Some(int_in(&at("modules"), x, 1, 60)?),
    };
    let module_wp = opt_float(obj, "module_wp", None, Lo::Ge(50.0), 1500.0).map_err(|e| prefix(i, e))?;
    let azimuth_deg = opt_float(obj, "azimuth_deg", None, Lo::Ge(0.0), 360.0).map_err(|e| prefix(i, e))?;
    let tilt_deg = opt_float(obj, "tilt_deg", None, Lo::Ge(0.0), 90.0).map_err(|e| prefix(i, e))?;
    if !removed && modules.is_none() {
        return Err(unprocessable(&i.to_string(), "Value error, modules is required unless removed is true"));
    }
    Ok(LayoutEntry {
        device_sn,
        string_no: string_no as i32,
        removed,
        modules: modules.map(|m| m as i32),
        module_wp,
        azimuth_deg,
        tilt_deg,
    })
}

fn prefix(i: usize, e: ApiError) -> ApiError {
    match e {
        ApiError::Unprocessable(m) => ApiError::Unprocessable(format!("{i}.{m}")),
        other => other,
    }
}

/// PUT /growatt/plants/{plant_id}/string-layout (plant writers): Python
/// `fleet_config.put_growatt_string_layout`. Replaces the registry and removed marks, then
/// publishes the plant's `inverters/{sn}` docs.
async fn put_string_layout(
    State(st): State<AppState>,
    p: PlantWrite,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Json<Value>, ApiError> {
    let raw = json_value(&headers, &body)?;
    let entries = list("body", &raw)?.iter().enumerate().map(|(i, x)| layout_entry(i, x)).collect::<Result<Vec<_>, _>>()?;
    let saved = layout::put_string_layout(&st.pool, p.plant_id, &entries).await.map_err(service_err)?;
    let published = published_json(publisher(&st).publish_plant_inverters(&st.pool, p.plant_id).await);
    Ok(Json(with(saved, "published", published)))
}

/// PUT /growatt/plants/{plant_id}/inverters/{device_sn}/installed (admin): Python
/// `fleet_config.put_inverter_installed`
async fn put_inverter_installed(
    State(st): State<AppState>,
    AdminUser(user): AdminUser,
    Path((plant_raw, device_sn)): Path<(String, String)>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Json<Value>, ApiError> {
    let plant_id = path_plant_id(&plant_raw)?;
    let obj = v::json_object(&headers, &body)?;
    let installed = match obj.get("installed") {
        None => return Err(unprocessable("installed", "Field required")),
        Some(x) => v::boolean("installed", x)?,
    };
    let note = v::optional_string(&obj, "note", 0, 255)?;
    let by = who(&user);
    let out = inverter_install::set_installed(&st.pool, plant_id, &device_sn, installed, &by, note.as_deref())
        .await
        .map_err(service_err)?;
    tracing::info!(
        target: "app.audit",
        "{by} marked inverter {device_sn} of plant {plant_id} {} (issues closed: {})",
        if installed { "installed" } else { "not installed" },
        out["issues_closed"]
    );
    let published = published_json(publisher(&st).publish_plant_inverters(&st.pool, plant_id).await);
    Ok(Json(with(out, "published", published)))
}

// --------------------------------------------------------------------------- tariff

/// Python `fleet_config._pwa_contract`: the criteria file's contract prices + version + the PWA
/// plant ids (of `scope`); None when they cannot be read.
async fn pwa_contract(st: &AppState, scope: &PlantScope) -> Value {
    let c = tariff::pwa_criteria();
    let Ok(rates) = tariff::pwa_plant_rates(&st.pool).await else { return Value::Null };
    let ids: Vec<i64> = rates.into_iter().map(|(k, _)| k).filter(|k| scope.allows(*k)).collect();
    let mut m = c.get("tariff").and_then(Value::as_object).cloned().unwrap_or_default();
    m.insert("criteria_version".into(), c.get("version").cloned().unwrap_or(Value::Null));
    m.insert("plant_ids".into(), json!(ids));
    Value::Object(m)
}

/// GET /growatt/tariff: Python `fleet_config.get_tariff`. Engineers get the plant rates and PWA
/// plant ids of their own plants only.
async fn get_tariff(State(st): State<AppState>, s: Scoped) -> Result<Json<Value>, ApiError> {
    let mut t = tariff::get_tariff(&st.pool).await.map_err(db_err)?;
    if let PlantScope::Assigned(_) = &s.scope {
        let rates: Map<String, Value> = t
            .get("plant_rates")
            .and_then(Value::as_object)
            .map(|r| r.iter().filter(|(k, _)| k.parse::<i64>().is_ok_and(|id| s.scope.allows(id))).map(|(k, x)| (k.clone(), x.clone())).collect())
            .unwrap_or_default();
        t = with(t, "plant_rates", Value::Object(rates));
    }
    let pc = pwa_contract(&st, &s.scope).await;
    Ok(Json(with(t, "pwa_contract", pc)))
}

/// POST /growatt/tariff/pwa-rates (admin): Python `fleet_config.post_tariff_pwa_rates`
async fn post_tariff_pwa_rates(State(st): State<AppState>, AdminUser(user): AdminUser) -> Result<Json<Value>, ApiError> {
    let by = who(&user);
    let res = tariff::fill_pwa_plant_rates(&st.pool, Some(&by), true).await.map_err(db_err)?;
    let mut published = Value::Null;
    if res["applied"] == json!(true) {
        tracing::info!(target: "app.audit", "{by} set the PWA contract price on {} plants", res["added"]);
        published = published_json(publisher(&st).publish_config(&st.pool).await);
    }
    let t = tariff::get_tariff(&st.pool).await.map_err(db_err)?;
    let pc = pwa_contract(&st, &PlantScope::All).await;
    let res = with(res, "tariff", with(t, "pwa_contract", pc));
    Ok(Json(with(res, "published", published)))
}

/// GET /growatt/tariff/rates?day=: Python `fleet_config.get_tariff_rates` (DB only; an estimate)
async fn get_tariff_rates(State(st): State<AppState>, s: Scoped, RawQuery(raw): RawQuery) -> Result<Json<Value>, ApiError> {
    let day = match query_last(raw.as_deref(), "day") {
        None => plant_today(),
        Some(d) => NaiveDate::parse_from_str(&d, "%Y-%m-%d")
            .ok()
            .filter(|_| d.len() == 10)
            .ok_or_else(|| unprocessable("day", "Input should be a valid date or datetime"))?,
    };
    let ids: Option<Vec<i64>> = match &s.scope {
        PlantScope::All => None,
        PlantScope::Assigned(a) => Some(a.iter().copied().collect()),
    };
    let rates = tariff::day_rates(&st.pool, day, ids.as_deref()).await.map_err(db_err)?;
    let plants: Map<String, Value> = rates.into_iter().map(|(k, x)| (k.to_string(), x)).collect();
    Ok(Json(json!({
        "day": day.format("%Y-%m-%d").to_string(),
        "plants": plants,
        "meta": {"source": "db", "estimated": true},
    })))
}

/// pydantic `date.fromisoformat` forms Python 3.13 accepts: `YYYY-MM-DD`, `YYYYMMDD`,
/// `YYYY-Www[-D]`, `YYYYWww[D]`
fn iso_date(s: &str) -> Option<NaiveDate> {
    let b = s.as_bytes();
    let digits = |r: std::ops::Range<usize>| b.get(r.clone()).is_some_and(|x| x.iter().all(u8::is_ascii_digit));
    let n = |r: std::ops::Range<usize>| s[r].parse::<u32>().ok();
    match b.len() {
        10 if b[4] == b'-' && b[7] == b'-' && digits(0..4) && digits(5..7) && digits(8..10) => {
            NaiveDate::from_ymd_opt(n(0..4)? as i32, n(5..7)?, n(8..10)?)
        }
        8 if digits(0..8) => NaiveDate::from_ymd_opt(n(0..4)? as i32, n(4..6)?, n(6..8)?),
        _ => {
            let (y, rest) = (s.get(0..4)?, s.get(4..)?);
            if !digits(0..4) {
                return None;
            }
            let rest = rest.strip_prefix('-').map(|r| (r, true)).unwrap_or((rest, false));
            let (r, dashed) = rest;
            let r = r.strip_prefix('W')?;
            let (w, d) = match (r.len(), dashed) {
                (2, _) => (r, "1"),
                (4, true) if r.as_bytes()[2] == b'-' => (&r[0..2], &r[3..4]),
                (3, false) => (&r[0..2], &r[2..3]),
                _ => return None,
            };
            if !w.bytes().chain(d.bytes()).all(|c| c.is_ascii_digit()) {
                return None;
            }
            let wd = match d.parse::<u32>().ok()? {
                1 => chrono::Weekday::Mon,
                2 => chrono::Weekday::Tue,
                3 => chrono::Weekday::Wed,
                4 => chrono::Weekday::Thu,
                5 => chrono::Weekday::Fri,
                6 => chrono::Weekday::Sat,
                7 => chrono::Weekday::Sun,
                _ => return None,
            };
            NaiveDate::from_isoywd_opt(y.parse().ok()?, w.parse().ok()?, wd)
        }
    }
}

/// Python `api_schemas.Tariff` (+ `PlantRate`) → `model_dump()`
fn tariff_body(obj: &Map<String, Value>) -> Result<Value, ApiError> {
    let on = req_float(obj, "on_peak_thb", Lo::Gt(0.0), 50.0)?;
    let off = req_float(obj, "off_peak_thb", Lo::Gt(0.0), 50.0)?;
    let ft = req_float(obj, "ft_thb", Lo::Ge(-5.0), 5.0)?;
    let days: Vec<i64> = match obj.get("on_peak_days") {
        None => vec![0, 1, 2, 3, 4],
        Some(x) => {
            let mut d = v::int_list("on_peak_days", x)?;
            if d.iter().any(|x| !(0..=6).contains(x)) {
                return Err(unprocessable("on_peak_days", "Value error, on_peak_days are 0 (Monday) … 6 (Sunday)"));
            }
            d.sort_unstable();
            d.dedup();
            d
        }
    };
    let hhmm = |k: &str, default: &str, pat: &str| -> Result<String, ApiError> {
        match obj.get(k) {
            None => Ok(default.to_owned()),
            Some(x) => {
                let s = v::string(k, x, 0, usize::MAX)?;
                pattern(k, &s, pat)?;
                Ok(s)
            }
        }
    };
    let start = hhmm("on_peak_start", "09:00", r"^([01]\d|2[0-3]):[0-5]\d$")?;
    let end = hhmm("on_peak_end", "22:00", r"^([01]\d|2[0-4]):[0-5]\d$")?;
    let holidays: Vec<String> = match obj.get("holidays") {
        None => Vec::new(),
        Some(x) => {
            let mut out = std::collections::BTreeSet::new();
            for (i, h) in list("holidays", x)?.iter().enumerate() {
                let s = v::string(&format!("holidays.{i}"), h, 0, usize::MAX)?;
                let t = docs::py_strip(&s);
                if t.is_empty() {
                    continue;
                }
                let d = iso_date(t).ok_or_else(|| {
                    unprocessable(
                        "holidays",
                        format!("Value error, holidays must be YYYY-MM-DD dates (Invalid isoformat string: {})", repr_str(t)),
                    )
                })?;
                out.insert(d.format("%Y-%m-%d").to_string());
            }
            out.into_iter().collect()
        }
    };
    let valid_from = v::optional_string(obj, "valid_from", 0, usize::MAX)?;
    if let Some(vf) = &valid_from {
        pattern("valid_from", vf, r"^\d{4}-\d{2}-\d{2}$")?;
    }
    let mut rates = Map::new();
    if let Some(x) = obj.get("plant_rates") {
        for (k, r) in object("plant_rates", x)? {
            let field = format!("plant_rates.{k}");
            let r = object(&field, r)?;
            let thb = match r.get("thb_per_kwh") {
                None => return Err(unprocessable(&format!("{field}.thb_per_kwh"), "Field required")),
                Some(t) => bounded(&format!("{field}.thb_per_kwh"), float(&format!("{field}.thb_per_kwh"), t)?, Lo::Gt(0.0), 50.0)?,
            };
            let basis = v::optional_string(r, "basis", 0, 32).map_err(|e| match e {
                ApiError::Unprocessable(m) => ApiError::Unprocessable(format!("{field}.{m}")),
                other => other,
            })?;
            rates.insert(k.clone(), json!({"thb_per_kwh": thb, "basis": basis}));
        }
        if rates.keys().any(|k| k.is_empty() || !k.bytes().all(|b| b.is_ascii_digit())) {
            return Err(unprocessable("plant_rates", "Value error, plant_rates keys are plant ids"));
        }
    }
    Ok(json!({
        "on_peak_thb": on,
        "off_peak_thb": off,
        "ft_thb": ft,
        "on_peak_days": days,
        "on_peak_start": start,
        "on_peak_end": end,
        "holidays": holidays,
        "valid_from": valid_from,
        "plant_rates": rates,
    }))
}

/// PUT /growatt/tariff (admin): Python `fleet_config.put_tariff`. Saves, logs each changed key,
/// then publishes `config/*`.
async fn put_tariff(
    State(st): State<AppState>,
    AdminUser(user): AdminUser,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Json<Value>, ApiError> {
    let value = tariff_body(&v::json_object(&headers, &body)?)?;
    let by = who(&user);
    let old = tariff::get_tariff(&st.pool).await.map_err(db_err)?;
    let saved = tariff::put_tariff(&st.pool, &value, Some(&by)).await.map_err(db_err)?;
    for k in tariff::TARIFF_KEYS {
        if !py_eq(old.get(k), saved.get(k)) {
            let show = |x: Option<&Value>| x.map_or_else(|| "None".to_owned(), py_str);
            tracing::info!(target: "app.audit", "{by} changed tariff {k}: {} -> {}", show(old.get(k)), show(saved.get(k)));
        }
    }
    let pc = pwa_contract(&st, &PlantScope::All).await;
    let published = published_json(publisher(&st).publish_config(&st.pool).await);
    Ok(Json(with(with(saved, "pwa_contract", pc), "published", published)))
}

// --------------------------------------------------------------------------- plant documents

/// GET /growatt/documents: Python `documents.list_plant_documents`
async fn list_plant_documents(State(st): State<AppState>, s: Scoped) -> Result<Json<Value>, ApiError> {
    let ids: Option<Vec<i64>> = match &s.scope {
        PlantScope::All => None,
        PlantScope::Assigned(a) => Some(a.iter().copied().collect()),
    };
    let plants = docs::list_all(&st.pool, ids.as_deref()).await.map_err(service_err)?;
    Ok(Json(json!({"plants": plants, "kinds": docs::KINDS, "meta": {"source": "db"}})))
}

/// GET /growatt/plants/{plant_id}/documents: Python `documents.get_plant_documents`
async fn get_plant_documents(State(st): State<AppState>, p: PlantRead) -> Result<Json<Value>, ApiError> {
    let d = docs::for_plant(&st.pool, p.plant_id).await.map_err(service_err)?;
    Ok(Json(json!({"plant_id": p.plant_id, "documents": d})))
}

/// PUT /growatt/plants/{plant_id}/documents/{kind} (admin): Python `documents.put_plant_document`
async fn put_plant_document(
    State(st): State<AppState>,
    AdminUser(user): AdminUser,
    Path((plant_raw, kind)): Path<(String, String)>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Json<Value>, ApiError> {
    let plant_id = path_plant_id(&plant_raw)?;
    let obj = v::json_object(&headers, &body)?;
    let url = v::required_string(&obj, "url", 8, 1000)?;
    let title = v::optional_string(&obj, "title", 0, 300)?;
    let by = who(&user);
    let out = docs::put(&st.pool, Some(&by), plant_id, &kind, &url, title.as_deref()).await.map_err(service_err)?;
    tracing::info!(target: "app.audit", "{by} set the {kind} link of plant {plant_id}");
    Ok(Json(out))
}

/// DELETE /growatt/plants/{plant_id}/documents/{kind} (admin): Python `documents.delete_plant_document`
async fn delete_plant_document(
    State(st): State<AppState>,
    AdminUser(user): AdminUser,
    Path((plant_raw, kind)): Path<(String, String)>,
) -> Result<Json<Value>, ApiError> {
    let plant_id = path_plant_id(&plant_raw)?;
    let removed = docs::remove(&st.pool, plant_id, &kind).await.map_err(service_err)?;
    if !removed {
        return Err(ApiError::NotFound(format!("Plant {plant_id} has no {kind} link")));
    }
    tracing::info!(target: "app.audit", "{} removed the {kind} link of plant {plant_id}", who(&user));
    Ok(Json(json!({"plant_id": plant_id, "kind": kind, "removed": true})))
}

/// Python `api_schemas.PlantDocumentImport` / `PlantDocumentRow`
fn import_body(obj: &Map<String, Value>) -> Result<Vec<ImportRow>, ApiError> {
    let rows = match obj.get("rows") {
        None => return Err(unprocessable("rows", "Field required")),
        Some(x) => list("rows", x)?,
    };
    let mut out = Vec::with_capacity(rows.len());
    for (i, r) in rows.iter().enumerate() {
        let at = |k: &str| format!("rows.{i}.{k}");
        let r = object(&format!("rows.{i}"), r)?;
        let req = |k: &str| r.get(k).ok_or_else(|| unprocessable(&at(k), "Field required"));
        let opt = |k: &str, max: usize| -> Result<Option<String>, ApiError> {
            match r.get(k) {
                None | Some(Value::Null) => Ok(None),
                Some(x) => v::string(&at(k), x, 0, max).map(Some),
            }
        };
        let plant_id = v::integer(&at("plant_id"), req("plant_id")?)?;
        let kind = v::string(&at("kind"), req("kind")?, 0, 32)?;
        let url = v::string(&at("url"), req("url")?, 0, 1000)?;
        let drive_id = opt("drive_id", 128)?;
        let title = opt("title", 300)?;
        let revision = opt("revision", 16)?;
        let match_score = match r.get("match_score") {
            None | Some(Value::Null) => None,
            Some(x) => Some(bounded(&at("match_score"), float(&at("match_score"), x)?, Lo::Ge(0.0), 1.0)?),
        };
        out.push(ImportRow { plant_id, kind, url, drive_id, title, revision, match_score });
    }
    if out.len() > 2000 {
        return Err(unprocessable("rows", "List should have at most 2000 items after validation, not more"));
    }
    Ok(out)
}

/// POST /growatt/documents/import?apply= (admin): Python `documents.import_plant_documents`.
/// `apply=false` (default) is a dry run that only counts.
async fn import_plant_documents(
    State(st): State<AppState>,
    AdminUser(user): AdminUser,
    RawQuery(raw): RawQuery,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Json<Value>, ApiError> {
    let apply = match query_last(raw.as_deref(), "apply") {
        None => false,
        Some(a) => v::boolean("apply", &Value::String(a))?,
    };
    let rows = import_body(&v::json_object(&headers, &body)?)?;
    let by = who(&user);
    let out = docs::import_rows(&st.pool, &rows, apply, Some(&by)).await.map_err(service_err)?;
    if apply {
        tracing::info!(
            target: "app.audit",
            "{by} imported plant document links: {} created, {} updated",
            out["created"],
            out["updated"]
        );
    }
    Ok(Json(out))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn iso_dates_like_python() {
        let d = |s: &str| iso_date(s).map(|d| d.to_string());
        assert_eq!(d("2026-08-12").as_deref(), Some("2026-08-12"));
        assert_eq!(d("20260101").as_deref(), Some("2026-01-01"));
        assert_eq!(d("2026-W01-1").as_deref(), Some("2025-12-29"));
        assert_eq!(d("2026W011").as_deref(), Some("2025-12-29"));
        assert_eq!(d("2026-W01").as_deref(), Some("2025-12-29"));
        assert_eq!(d("2026-02-30"), None);
        assert_eq!(d("2026-8-12"), None);
    }

    #[test]
    fn python_text_forms() {
        assert_eq!(py_str(&json!("09:00")), "09:00");
        assert_eq!(py_str(&json!([0, 1])), "[0, 1]");
        assert_eq!(py_str(&json!(4.1839)), "4.1839");
        assert_eq!(py_str(&json!({"7": {"basis": null}})), "{'7': {'basis': None}}");
        assert!(py_eq(Some(&json!(1)), Some(&json!(1.0))));
        assert!(!py_eq(Some(&json!([1])), Some(&json!([2]))));
    }
}
