//! `/growatt/live/*` (backend/app/api/routes/growatt/live.py): realtime values straight from the
//! Growatt cloud, cached in memory only ([`tcroof_services::live`], mirrored in Redis when
//! configured). Never written to the database: these handlers only read the registry (which
//! plants / inverters a user may see, a plant's phase and coordinates, String Layout rows).
//!
//! Ported: `/live/plants`, `/live/plants/today`, `/live/inverters/snapshot`,
//! `/live/plants/{plant_id}/latest`, `/live/plants/{plant_id}/alarms`. The other live routes
//! (strings/operating, meter, sensors, weather, google-weather, rain*) come in a later wave; their
//! service features are already in `LiveService`.

use std::collections::{BTreeSet, HashMap, HashSet};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use axum::extract::{RawQuery, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use chrono::{NaiveDate, NaiveDateTime};
use serde_json::{json, Map, Value};
use tcroof_services::common::{self, ServiceError, INACTIVE_MAX_A};
use tcroof_services::live::string_check::{self, Layout};
use tcroof_services::live::LiveError;

use crate::error::ApiError;
use crate::extract::{parse_int, PlantRead, PlantScope, Scoped};
use crate::AppState;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/live/plants", get(live_plants))
        .route("/live/plants/today", get(live_plants_today))
        .route("/live/inverters/snapshot", get(live_inverter_snapshot))
        .route("/live/plants/{plant_id}/latest", get(live_plant_latest))
        .route("/live/plants/{plant_id}/alarms", get(live_plant_alarms))
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

/// Python `growatt_layout.WIRED_LOOKBACK`
const WIRED_LOOKBACK_DAYS: i64 = 30;
/// Python `growatt_layout.WIRED_CACHE_S`
const WIRED_CACHE_S: u64 = 6 * 3600;

type Wired = HashMap<String, BTreeSet<i64>>;
/// Python `growatt_layout._wired_cache`: sorted serials → (when, wired inputs)
type WiredCache = Mutex<HashMap<Vec<String>, (Instant, Wired)>>;

fn wired_cache() -> &'static WiredCache {
    static CACHE: OnceLock<WiredCache> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Python `growatt_layout.newest_string_ts`: newest stored string record of these inverters, one
/// short backward index read per inverter.
async fn newest_string_ts(st: &AppState, sns: &[String]) -> Result<Option<NaiveDateTime>, LiveRouteError> {
    let mut best: Option<NaiveDateTime> = None;
    let mut seen = HashSet::new();
    for sn in sns.iter().filter(|s| seen.insert(s.as_str())) {
        let ts: Option<NaiveDateTime> = sqlx::query_scalar(
            "SELECT timestamp FROM growatt_string_readings WHERE device_sn = $1 ORDER BY device_sn DESC, timestamp DESC LIMIT 1",
        )
        .bind(sn)
        .fetch_optional(&st.pool)
        .await?;
        if let Some(ts) = ts {
            if best.is_none_or(|b| ts > b) {
                best = Some(ts);
            }
        }
    }
    Ok(best)
}

/// Python `growatt_layout.wired_inputs`: string inputs known to be connected per inverter (String
/// Layout rows plus inputs that carried current in the last 30 days), kept in memory 6 h.
async fn wired_inputs(st: &AppState, sns: &[String]) -> Result<Wired, LiveRouteError> {
    let mut key: Vec<String> = sns.to_vec();
    key.sort();
    if let Some((at, hit)) = wired_cache().lock().unwrap_or_else(|p| p.into_inner()).get(&key) {
        if at.elapsed() < Duration::from_secs(WIRED_CACHE_S) {
            return Ok(hit.clone());
        }
    }
    let mut out = Wired::new();
    for (sn, no) in load_layout(st, sns).await?.into_keys() {
        out.entry(sn).or_default().insert(no);
    }
    if let Some(latest) = newest_string_ts(st, sns).await? {
        let rows: Vec<(String, i32)> = sqlx::query_as(
            "SELECT device_sn, string_no FROM growatt_string_readings \
             WHERE device_sn = ANY($1) AND timestamp >= $2 AND current_a > $3 GROUP BY device_sn, string_no",
        )
        .bind(sns)
        .bind(latest - chrono::Duration::days(WIRED_LOOKBACK_DAYS))
        .bind(INACTIVE_MAX_A)
        .fetch_all(&st.pool)
        .await?;
        for (sn, no) in rows {
            out.entry(sn).or_default().insert(i64::from(no));
        }
    }
    wired_cache().lock().unwrap_or_else(|p| p.into_inner()).insert(key, (Instant::now(), out.clone()));
    Ok(out)
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
