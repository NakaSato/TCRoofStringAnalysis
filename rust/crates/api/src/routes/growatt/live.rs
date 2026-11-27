//! `/growatt/live/*` (backend/app/api/routes/growatt/live.py): realtime values straight from the
//! Growatt cloud, cached in memory only ([`tcroof_services::live`], mirrored in Redis when
//! configured). Never written to the database: these handlers only read the registry (which
//! plants / inverters a user may see, a plant's phase and coordinates, String Layout rows).
//!
//! Ported: `/live/plants`, `/live/plants/today`, `/live/inverters/snapshot`,
//! `/live/plants/{plant_id}/latest`, `/live/plants/{plant_id}/strings/operating`,
//! `/live/plants/{plant_id}/meter`, `/live/plants/{plant_id}/alarms`, `/live/sensors/status`,
//! `/live/sensors/{datalogger_sn}/{address}` (+ `/today`) and `/live/plants/{plant_id}/weather`.
//! Google Weather live and the rain routes (Longdo / RainViewer) are not Growatt and live elsewhere.

use std::collections::{BTreeSet, HashMap, HashSet};

use axum::extract::{Path, RawQuery, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use chrono::{NaiveDate, NaiveDateTime};
use std::collections::BTreeMap;
use serde_json::{json, Map, Value};
use tcroof_services::common::{self, ServiceError};
use tcroof_services::string_operating::{self, OperatingError};
use tcroof_services::{layout, meter, sensors, weather};
use tcroof_services::live::string_check::{self, Layout};
use tcroof_services::live::LiveError;

use crate::error::ApiError;
use crate::config::parse_bool;
use crate::extract::{parse_int, PlantRead, PlantScope, Scoped};
use crate::AppState;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/live/plants", get(live_plants))
        .route("/live/plants/today", get(live_plants_today))
        .route("/live/inverters/snapshot", get(live_inverter_snapshot))
        .route("/live/plants/{plant_id}/latest", get(live_plant_latest))
        .route("/live/plants/{plant_id}/strings/operating", get(live_string_operating))
        .route("/live/plants/{plant_id}/meter", get(live_plant_meter))
        .route("/live/plants/{plant_id}/alarms", get(live_plant_alarms))
        .route("/live/sensors/status", get(live_sensor_status))
        .route("/live/sensors/{datalogger_sn}/{address}", get(live_sensor))
        .route("/live/sensors/{datalogger_sn}/{address}/today", get(live_sensor_today))
        .route("/live/plants/{plant_id}/weather", get(live_plant_weather))
}

// --------------------------------------------------------------------------- errors

/// A live route's failure: Python `HTTPException(503, "Growatt live data unavailable: …")` for
/// `LiveUnavailable`, else the usual API errors.
pub enum LiveRouteError {
    Api(ApiError),
    Live(LiveError),
}

impl From<ApiError> for LiveRouteError {
    fn from(e: ApiError) -> Self {
        LiveRouteError::Api(e)
    }
}
impl From<LiveError> for LiveRouteError {
    fn from(e: LiveError) -> Self {
        LiveRouteError::Live(e)
    }
}
impl From<ServiceError> for LiveRouteError {
    fn from(e: ServiceError) -> Self {
        LiveRouteError::Api(match e {
            ServiceError::NotFound(m) => ApiError::NotFound(m),
            ServiceError::Invalid(m) => ApiError::Unprocessable(m),
            ServiceError::Db(e) => ApiError::Internal(format!("database error: {e}")),
        })
    }
}
impl From<sqlx::Error> for LiveRouteError {
    fn from(e: sqlx::Error) -> Self {
        LiveRouteError::Api(ApiError::Internal(format!("database error: {e}")))
    }
}

impl IntoResponse for LiveRouteError {
    fn into_response(self) -> Response {
        match self {
            LiveRouteError::Api(e) => e.into_response(),
            LiveRouteError::Live(LiveError::Unavailable(m)) => {
                (StatusCode::SERVICE_UNAVAILABLE, Json(json!({"detail": format!("Growatt live data unavailable: {m}")}))).into_response()
            }
            LiveRouteError::Live(LiveError::Internal(m)) => ApiError::Internal(m).into_response(),
        }
    }
}

type LiveResponse = Result<Json<Value>, LiveRouteError>;

// --------------------------------------------------------------------------- registry reads

/// Python `growatt_overview.list_inverters(db, plant_id)` (installed only), serials only.
async fn plant_inverter_sns(st: &AppState, plant_id: i64) -> Result<Vec<String>, LiveRouteError> {
    let Ok(id) = i32::try_from(plant_id) else { return Ok(Vec::new()) };
    Ok(sqlx::query_scalar(
        "SELECT device_sn FROM growatt_inverters WHERE plant_id = $1 AND not_installed_at IS NULL ORDER BY device_sn",
    )
    .bind(id)
    .fetch_all(&st.pool)
    .await?)
}

/// Python `growatt_layout.load_layout(db, sns, fleet_wp=False)`: module count per string input
/// (the module rating is not used by the live string check).
async fn load_layout(st: &AppState, sns: &[String]) -> Result<Layout, LiveRouteError> {
    if sns.is_empty() {
        return Ok(Layout::new());
    }
    let rows: Vec<(String, i32, i32)> =
        sqlx::query_as("SELECT device_sn, string_no, modules FROM growatt_string_layouts WHERE device_sn = ANY($1)")
            .bind(sns)
            .fetch_all(&st.pool)
            .await?;
    Ok(rows.into_iter().map(|(sn, no, m)| ((sn, i64::from(no)), i64::from(m))).collect())
}

/// Python `growatt_layout.wired_inputs` (services/layout.rs, one cache shared with
/// `strings/operating`), string numbers as the live string check wants them.
async fn wired_inputs(st: &AppState, sns: &[String]) -> Result<HashMap<String, BTreeSet<i64>>, LiveRouteError> {
    Ok(layout::wired_inputs(&st.pool, sns)
        .await?
        .into_iter()
        .map(|(sn, set)| (sn, set.into_iter().map(i64::from).collect()))
        .collect())
}

/// The last value of each query parameter (Starlette's `QueryParams.get`).
fn query(raw: &Option<String>) -> HashMap<String, String> {
    form_urlencoded::parse(raw.as_deref().unwrap_or("").as_bytes()).into_owned().collect()
}

// --------------------------------------------------------------------------- handlers

/// Python `live.live_plants`: realtime plant power / status for the fleet (an engineer's assigned
/// plants). The memory cache stays fleet-wide; only the answer is filtered.
async fn live_plants(State(st): State<AppState>, scoped: Scoped) -> LiveResponse {
    let coords = common::plant_coords(&st.pool, None).await?;
    let mut env = st.live.plants(&coords).await?;
    if let PlantScope::Assigned(ids) = &scoped.scope {
        if let Some(Value::Array(list)) = env.get_mut("data") {
            list.retain(|p| p.get("plant_id").and_then(Value::as_i64).is_some_and(|id| ids.contains(&id)));
        }
    }
    Ok(Json(env))
}

/// Python `live.live_plants_today`: today's energy of every plant the user may see (`plant/data`,
/// swept `PLANT_TODAY_SWEEP_PER_REQUEST` plants per request; memory only).
async fn live_plants_today(State(st): State<AppState>, scoped: Scoped) -> LiveResponse {
    let rows: Vec<(i32, Option<i32>)> = sqlx::query_as("SELECT plant_id, phase FROM growatt_plants").fetch_all(&st.pool).await?;
    let plants: Vec<(i64, Option<i32>)> =
        rows.into_iter().map(|(p, ph)| (i64::from(p), ph)).filter(|(p, _)| scoped.scope.allows(*p)).collect();
    let coords = common::plant_coords(&st.pool, None).await?;
    Ok(Json(st.live.plant_today(&plants, &coords).await?))
}

/// Python `live.live_inverter_snapshot`: newest record of every inverter the user may see, from
/// `maxs_data` (50 inverters per call, swept; memory only). `data.inverters` is keyed by serial,
/// with `plant_id` from the registry.
async fn live_inverter_snapshot(State(st): State<AppState>, scoped: Scoped, RawQuery(raw): RawQuery) -> LiveResponse {
    let q = query(&raw);
    let plant_id = match q.get("plant_id") {
        Some(v) => {
            Some(parse_int(v).ok_or_else(|| ApiError::Unprocessable(format!("plant_id: Input should be a valid integer, got {v:?}")))?)
        }
        None => None,
    };
    if let (Some(pid), PlantScope::Assigned(_)) = (plant_id, &scoped.scope) {
        if !scoped.scope.allows(pid) {
            return Err(ApiError::NotFound("Plant not found".into()).into());
        }
    }
    let rows: Vec<(String, i32, Option<i32>)> = sqlx::query_as(
        "SELECT i.device_sn, i.plant_id, p.phase FROM growatt_inverters i \
         JOIN growatt_plants p ON p.plant_id = i.plant_id WHERE i.not_installed_at IS NULL",
    )
    .fetch_all(&st.pool)
    .await?;
    let plant_of: HashMap<&str, i64> = rows.iter().map(|(sn, pid, _)| (sn.as_str(), i64::from(*pid))).collect();
    let wanted: Option<HashSet<String>> = match (plant_id, &scoped.scope) {
        (Some(pid), _) => Some(rows.iter().filter(|r| i64::from(r.1) == pid).map(|r| r.0.clone()).collect()),
        (None, PlantScope::Assigned(ids)) => Some(rows.iter().filter(|r| ids.contains(&i64::from(r.1))).map(|r| r.0.clone()).collect()),
        (None, PlantScope::All) => None,
    };
    let inverters: Vec<(String, Option<i32>)> = rows.iter().map(|(sn, _, ph)| (sn.clone(), *ph)).collect();
    let coords = common::plant_coords(&st.pool, plant_id).await?;
    let mut out = st.live.inverter_snapshot(&inverters, wanted.as_ref(), &coords).await?;
    if let Some(Value::Object(invs)) = out.pointer_mut("/data/inverters") {
        for (sn, row) in invs.iter_mut() {
            row["plant_id"] = json!(plant_of.get(sn.as_str()));
        }
    }
    Ok(Json(out))
}

/// Python `live.live_plant_latest`: newest record per inverter (power, MPPT, per-string V / I) for
/// one plant, the live string check and the plant's dataloggers. The DB is read only for the
/// inverter list, String Layout module counts and which inputs are wired.
async fn live_plant_latest(State(st): State<AppState>, pr: PlantRead) -> LiveResponse {
    let plant_id = pr.plant_id;
    let sns = plant_inverter_sns(&st, plant_id).await?;
    if sns.is_empty() {
        return Err(ApiError::NotFound(format!("Plant {plant_id} has no inverters")).into());
    }
    let phase = common::plant_phase(&st.pool, plant_id).await?;
    let coords = common::plant_coords(&st.pool, Some(plant_id)).await?;
    let day = st.live.now_local().date();
    let mut env = st.live.plant_latest(plant_id, &sns, day, phase, &coords).await?;
    let (loggers, loggers_error) = st.live.plant_dataloggers(plant_id, phase, &coords).await;
    let inverters: Vec<Value> = env["data"]["inverters"].as_array().cloned().unwrap_or_default();
    let check = string_check::check_plant(&inverters, &load_layout(&st, &sns).await?, &wired_inputs(&st, &sns).await?);
    // the older records were only input to the check: don't send them to the browser
    let invs: Vec<Value> = inverters
        .into_iter()
        .map(|mut inv| {
            if let Some(m) = inv.as_object_mut() {
                m.remove("previous_strings");
            }
            inv
        })
        .collect();
    let data: &mut Map<String, Value> = env["data"].as_object_mut().expect("plant_latest data is an object");
    data.insert("inverters".into(), Value::Array(invs));
    data.insert("string_check".into(), check);
    data.insert("dataloggers".into(), loggers.unwrap_or(Value::Null));
    data.insert("dataloggers_error".into(), json!(loggers_error));
    Ok(Json(env))
}

/// `YYYY-MM-DD` (pydantic `date` from a query string).
fn parse_day(v: &str) -> Option<NaiveDate> {
    let b = v.as_bytes();
    if b.len() != 10 || b[4] != b'-' || b[7] != b'-' {
        return None;
    }
    NaiveDate::parse_from_str(v, "%Y-%m-%d").ok()
}

/// Python `live.live_plant_alarms`: Growatt alarm / fault log (`device/max/alarm_data`) of the
/// plant's inverters over the last `days` days (1–31, default 7) ending at `day` (default today),
/// newest first. Memory only; the DB is read only for the inverter list.
async fn live_plant_alarms(State(st): State<AppState>, pr: PlantRead, RawQuery(raw): RawQuery) -> LiveResponse {
    let plant_id = pr.plant_id;
    let q = query(&raw);
    let day = match q.get("day") {
        Some(v) => Some(parse_day(v).ok_or_else(|| ApiError::Unprocessable(format!("day: Input should be a valid date, got {v:?}")))?),
        None => None,
    };
    let days = match q.get("days") {
        Some(v) => parse_int(v).ok_or_else(|| ApiError::Unprocessable(format!("days: Input should be a valid integer, got {v:?}")))?,
        None => 7,
    };
    if !(1..=31).contains(&days) {
        return Err(ApiError::Unprocessable(format!("days: Input should be between 1 and 31, got {days}")).into());
    }
    let sns = plant_inverter_sns(&st, plant_id).await?;
    if sns.is_empty() {
        return Err(ApiError::NotFound(format!("Plant {plant_id} has no inverters")).into());
    }
    let end = day.unwrap_or_else(|| st.live.now_local().date());
    let window: Vec<NaiveDate> = (0..days).map(|i| end - chrono::Duration::days(i)).collect();
    let phase = common::plant_phase(&st.pool, plant_id).await?;
    let coords = common::plant_coords(&st.pool, Some(plant_id)).await?;
    Ok(Json(st.live.plant_alarms(plant_id, &sns, &window, phase, &coords).await?))
}

impl From<OperatingError> for LiveRouteError {
    fn from(e: OperatingError) -> Self {
        match e {
            OperatingError::NotFound(m) => LiveRouteError::Api(ApiError::NotFound(m)),
            OperatingError::Live(l) => LiveRouteError::Live(l),
            OperatingError::Service(s) => s.into(),
        }
    }
}

/// A FastAPI `int` path parameter (422 when it is not one).
fn int_path(path: &HashMap<String, String>, name: &str) -> Result<i64, ApiError> {
    let raw = path.get(name).map(String::as_str).unwrap_or_default();
    parse_int(raw)
        .ok_or_else(|| ApiError::Unprocessable(format!("{name}: Input should be a valid integer, unable to parse string as an integer")))
}

/// The plant-local clock the live cache uses (Python `datetime.now(PLANT_TZ)`, naive).
fn now_local(st: &AppState) -> NaiveDateTime {
    st.live.now_local()
}

/// Python `live.live_string_operating`: each string's newest operating point on the modelled
/// string curve at the sensor's live irradiance and module temperature (memory only).
async fn live_string_operating(State(st): State<AppState>, pr: PlantRead) -> LiveResponse {
    Ok(Json(string_operating::build(&st.pool, &st.live, pr.plant_id).await?))
}

/// Python `live.live_plant_meter`: grid import / export now from the plant's energy meter(s)
/// (`meter_last_data`), and with `load` (default true) the **derived** load = PV AC + grid, PV
/// from the `/latest` inverter cache. 404 without a meter. Memory only.
async fn live_plant_meter(State(st): State<AppState>, pr: PlantRead, RawQuery(raw): RawQuery) -> LiveResponse {
    let plant_id = pr.plant_id;
    let q = query(&raw);
    let load = match q.get("load") {
        Some(v) => parse_bool(v).ok_or_else(|| ApiError::Unprocessable(format!("load: Input should be a valid boolean, got {v:?}")))?,
        None => true,
    };
    let meters: Vec<(String, i64)> =
        meter::plant_meters(&st.pool, plant_id).await?.into_iter().map(|(dl, a)| (dl, i64::from(a))).collect();
    if meters.is_empty() {
        return Err(ApiError::NotFound(format!("Plant {plant_id} has no energy meter")).into());
    }
    let phase = common::plant_phase(&st.pool, plant_id).await?;
    let coords = common::plant_coords(&st.pool, Some(plant_id)).await?;
    let mut env = st.live.plant_meter(plant_id, &meters, phase, &coords).await?;
    if !load {
        return Ok(Json(env));
    }
    let sns = plant_inverter_sns(&st, plant_id).await?;
    let grid = env["data"]["grid"].clone();
    let mut derived = match st.live.plant_latest(plant_id, &sns, now_local(&st).date(), phase, &coords).await {
        Ok(inv) => {
            let d = &inv["data"];
            let invs: Vec<Value> = d["inverters"].as_array().cloned().unwrap_or_default();
            let errors: BTreeMap<String, String> = d["errors"]
                .as_object()
                .map(|m| m.iter().map(|(k, v)| (k.clone(), v.as_str().map(str::to_owned).unwrap_or_else(|| v.to_string()))).collect())
                .unwrap_or_default();
            let derived = meter::live_load(&grid, &sns, &invs, &errors);
            // the inverter cache can expire sooner than the meter's: poll on the earlier of the two
            if let (Some(a), Some(b)) = (env["refresh_in_s"].as_i64(), inv["refresh_in_s"].as_i64()) {
                env["refresh_in_s"] = json!(a.min(b));
            }
            derived
        }
        Err(LiveError::Unavailable(e)) => json!({
            "timestamp": grid["timestamp"],
            "pv_kw": null,
            "load_kw": null,
            "reason": format!("inverters unavailable: {e}"),
        }),
        Err(e) => return Err(e.into()),
    };
    derived["derived"] = json!(true);
    env["data"]["load"] = derived;
    Ok(Json(env))
}

/// Python `routes/growatt/_common.sensor_scope`: plants whose sensors a request covers (None =
/// every plant); a `plant_id` the user may not see gives the empty set.
fn sensor_scope(scope: &PlantScope, plant_id: Option<i64>) -> Option<HashSet<i64>> {
    match (scope, plant_id) {
        (PlantScope::All, None) => None,
        (PlantScope::Assigned(ids), None) => Some(ids.clone()),
        (_, Some(p)) => Some(if scope.allows(p) { HashSet::from([p]) } else { HashSet::new() }),
    }
}

/// Python `live.live_sensor_status`: live online state of every weather sensor the user may see
/// (`env_list`, swept `SENSOR_SWEEP_PER_REQUEST` dataloggers per request; memory only).
async fn live_sensor_status(State(st): State<AppState>, scoped: Scoped, RawQuery(raw): RawQuery) -> LiveResponse {
    let q = query(&raw);
    let plant_id = match q.get("plant_id") {
        Some(v) => {
            Some(parse_int(v).ok_or_else(|| ApiError::Unprocessable(format!("plant_id: Input should be a valid integer, got {v:?}")))?)
        }
        None => None,
    };
    let allowed = sensor_scope(&scoped.scope, plant_id);
    let visible = sensors::visible_sensors(&st.pool, allowed.as_ref()).await?;
    let dataloggers: Vec<(String, Option<i32>)> =
        visible.iter().map(|(dl, _, ph, _)| (dl.clone(), *ph)).collect::<BTreeSet<_>>().into_iter().collect();
    let coords = common::plant_coords(&st.pool, plant_id).await?;
    let env = st.live.sensor_status(&dataloggers, &coords).await?;
    let s = &st.settings;
    Ok(Json(sensors::overlay_live_status(
        &env,
        &visible,
        now_local(&st),
        s.sensor_late_min,
        s.sensor_offline_min,
        Some(s.sensor_inactive_days),
    )))
}

/// The user's plants for a sensor lookup (Python `allowed_plant_ids`: None = every plant).
fn allowed_ids(scope: &PlantScope) -> Option<&HashSet<i64>> {
    match scope {
        PlantScope::All => None,
        PlantScope::Assigned(ids) => Some(ids),
    }
}

/// Python `live.live_sensor`: one weather sensor for the Info view (memory only): live state and
/// newest `env_last_data` record; `raw` for admins only. 404 when not registered or not visible.
async fn live_sensor(State(st): State<AppState>, scoped: Scoped, Path(path): Path<HashMap<String, String>>) -> LiveResponse {
    let dl = path.get("datalogger_sn").cloned().unwrap_or_default();
    let address = int_path(&path, "address")?;
    let Some(sensor) = sensors::find_sensor(&st.pool, &dl, address, allowed_ids(&scoped.scope)).await? else {
        return Err(ApiError::NotFound(format!("Weather sensor {dl}#{address} not found")).into());
    };
    let now = now_local(&st);
    let measured: Option<Vec<String>> =
        sensors::measured_for(&st.pool, &sensor, now).await?.map(|v| v.into_iter().map(str::to_owned).collect());
    let coords = common::plant_coords(&st.pool, Some(i64::from(sensor.plant_id))).await?;
    let mut env = st.live.sensor_live(&dl, address, sensor.phase, measured.as_deref(), &coords).await?;
    let s = &st.settings;
    let d = env["data"].take();
    let status = sensors::live_row(
        &dl,
        sensor.address,
        d.get("datalogger").filter(|v| !v.is_null()),
        now,
        s.sensor_late_min as f64,
        s.sensor_offline_min as f64,
        sensor.history_synced_until,
        Some(s.sensor_inactive_days),
    );
    env["data"] = json!({
        "status": status,
        "measured": measured,
        "reading": d["reading"],
        "raw": if scoped.user.is_admin() { d["raw"].clone() } else { Value::Null },
        "errors": d["errors"],
        "thresholds": {
            "late_min": s.sensor_late_min,
            "offline_min": s.sensor_offline_min,
            "inactive_days": s.sensor_inactive_days,
        },
    });
    Ok(Json(env))
}

/// Python `live.live_sensor_today`: today's 5-minute records of one weather sensor straight from
/// Growatt (`env_data`, today only; memory only). 404 when not registered or not visible.
async fn live_sensor_today(State(st): State<AppState>, scoped: Scoped, Path(path): Path<HashMap<String, String>>) -> LiveResponse {
    let dl = path.get("datalogger_sn").cloned().unwrap_or_default();
    let address = int_path(&path, "address")?;
    let Some(sensor) = sensors::find_sensor(&st.pool, &dl, address, allowed_ids(&scoped.scope)).await? else {
        return Err(ApiError::NotFound(format!("Weather sensor {dl}#{address} not found")).into());
    };
    let coords = common::plant_coords(&st.pool, Some(i64::from(sensor.plant_id))).await?;
    Ok(Json(st.live.sensor_today(&dl, address, sensor.phase, &coords).await?))
}

/// Python `live.live_plant_weather`: newest weather-sensor reading per sensor (memory only), with
/// `stored_until` (newest stored reading). 404 when the plant has no weather sensor.
async fn live_plant_weather(State(st): State<AppState>, pr: PlantRead) -> LiveResponse {
    let plant_id = pr.plant_id;
    let since = now_local(&st) - chrono::Duration::days(7);
    let measured = weather::measured_fields(&st.pool, plant_id, since).await?;
    if measured.is_empty() {
        return Err(ApiError::NotFound(format!("Plant {plant_id} has no weather sensor")).into());
    }
    let list: Vec<(String, i64, Option<Vec<String>>)> = measured
        .into_iter()
        .map(|((dl, a), f)| (dl, i64::from(a), f.map(|v| v.into_iter().map(str::to_owned).collect())))
        .collect();
    let phase = common::plant_phase(&st.pool, plant_id).await?;
    let coords = common::plant_coords(&st.pool, Some(plant_id)).await?;
    let mut env = st.live.plant_weather(plant_id, &list, phase, &coords).await?;
    // Python `wx.plant_sensors(...).history_synced_until`
    let stored: Vec<(String, i32, Option<NaiveDateTime>)> = match i32::try_from(plant_id) {
        Ok(id) => {
            sqlx::query_as("SELECT datalogger_sn, address, history_synced_until FROM growatt_env_sensors WHERE plant_id = $1")
                .bind(id)
                .fetch_all(&st.pool)
                .await?
        }
        Err(_) => Vec::new(),
    };
    let stored: HashMap<(String, i64), Option<NaiveDateTime>> =
        stored.into_iter().map(|(dl, a, u)| ((dl, i64::from(a)), u)).collect();
    if let Some(Value::Array(rows)) = env.pointer_mut("/data/sensors") {
        for row in rows.iter_mut() {
            let k = (row["datalogger_sn"].as_str().unwrap_or_default().to_owned(), row["address"].as_i64().unwrap_or(i64::MIN));
            let until = stored.get(&k).copied().flatten();
            row["stored_until"] = json!(until.map(|u| u.format("%Y-%m-%d %H:%M:%S").to_string()));
        }
    }
    Ok(Json(env))
}
