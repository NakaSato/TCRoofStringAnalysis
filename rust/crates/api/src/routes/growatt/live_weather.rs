//! The live weather / rain routes of backend/app/api/routes/growatt/live.py:
//! `/live/plants/{plant_id}/google-weather` (Google current conditions, **modelled**),
//! `/live/rain-radar` (Longdo snapshots, RainViewer fallback), `/live/rain` (radar rain over the
//! fleet) and `/live/plants/{plant_id}/rain` (radar rain over one plant), all **radar-derived** or
//! modelled, never measured. Memory only (mirrored in Redis when configured); SQL is read for the
//! registry and written only for the external API call counts.

use axum::extract::State;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use serde_json::{json, Value};
use tcroof_services::common::{get_plant, ServiceError};
use tcroof_services::google_weather_live::{self as gw, GoogleLiveError};
use tcroof_services::longdo::{self, LongdoError};
use tcroof_services::rainviewer;

use crate::error::ApiError;
use crate::extract::{CurrentUser, PlantRead, PlantScope, Scoped};
use crate::AppState;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/live/plants/{plant_id}/google-weather", get(live_plant_google_weather))
        .route("/live/rain-radar", get(live_rain_radar))
        .route("/live/rain", get(live_fleet_rain))
        .route("/live/plants/{plant_id}/rain", get(live_plant_rain))
}

/// A weather route's failure: Python `HTTPException(503, …)` for the services' "unavailable",
/// else the usual API errors.
pub enum WeatherRouteError {
    Api(ApiError),
    Unavailable(String),
}

impl From<ApiError> for WeatherRouteError {
    fn from(e: ApiError) -> Self {
        WeatherRouteError::Api(e)
    }
}

impl From<ServiceError> for WeatherRouteError {
    fn from(e: ServiceError) -> Self {
        WeatherRouteError::Api(match e {
            ServiceError::NotFound(m) => ApiError::NotFound(m),
            ServiceError::Invalid(m) => ApiError::Unprocessable(m),
            ServiceError::Db(e) => ApiError::Internal(format!("database error: {e}")),
        })
    }
}

impl IntoResponse for WeatherRouteError {
    fn into_response(self) -> Response {
        match self {
            WeatherRouteError::Api(e) => e.into_response(),
            WeatherRouteError::Unavailable(detail) => (StatusCode::SERVICE_UNAVAILABLE, Json(json!({ "detail": detail }))).into_response(),
        }
    }
}

type WeatherResponse = Result<Json<Value>, WeatherRouteError>;

/// A Longdo error as the route answers it: unavailable = 503 with `prefix`, else 500.
fn longdo_err(e: LongdoError, prefix: &str) -> WeatherRouteError {
    match e {
        LongdoError::Unavailable { message, .. } => WeatherRouteError::Unavailable(format!("{prefix}: {message}")),
        LongdoError::Service(e) => e.into(),
    }
}

/// Python `live.live_plant_google_weather`: current conditions from the Google Maps Weather API
/// for the plant's grid cell (modelled, not measured). Cached in memory per cell
/// (`GOOGLE_WEATHER_LIVE_TTL_S`), never stored, and capped per day; over the cap the last value
/// is served as stale.
async fn live_plant_google_weather(State(st): State<AppState>, pr: PlantRead) -> WeatherResponse {
    let plant = get_plant(&st.pool, pr.plant_id).await?;
    match gw::live_plant(&st.pool, &plant, &st.weather.google).await {
        Ok(env) => Ok(Json(env)),
        Err(GoogleLiveError::Unavailable(m)) => Err(WeatherRouteError::Unavailable(format!("Google Weather unavailable: {m}"))),
        Err(GoogleLiveError::Service(e)) => Err(e.into()),
    }
}

/// Python `live.live_rain_radar`: radar snapshots for the Plant Map, the tile URL template and the
/// legend. Longdo first; RainViewer when Longdo has no key or nothing to serve (`frame_tiles`,
/// `point_rain: false`, `fallback_reason`). 404 = neither configured.
async fn live_rain_radar(State(st): State<AppState>, _user: CurrentUser) -> WeatherResponse {
    let lw = &st.weather.longdo;
    let rv = &st.weather.rainviewer;
    let reason: String;
    if longdo::enabled(&lw.cfg) {
        match longdo::radar(&st.pool, lw).await {
            Ok(env) => return Ok(Json(env)),
            Err(LongdoError::Unavailable { message, .. }) => {
                if !rv.cfg.enabled {
                    return Err(WeatherRouteError::Unavailable(format!("Longdo rain radar unavailable: {message}")));
                }
                tracing::warn!("rain radar: falling back to RainViewer ({message})");
                reason = format!("Longdo is unavailable ({message})");
            }
            Err(LongdoError::Service(e)) => return Err(e.into()),
        }
    } else if rv.cfg.enabled {
        reason = "Longdo is not configured".into();
    } else {
        return Err(ApiError::NotFound("Rain radar is not configured".into()).into());
    }
    match rainviewer::radar(rv, Some(&reason)).await {
        Ok(env) => Ok(Json(env)),
        Err(e) => Err(WeatherRouteError::Unavailable(format!("Rain radar unavailable: {reason}; RainViewer: {e}"))),
    }
}

/// Python `live.live_fleet_rain`: radar rain class now over every plant the user may see, swept
/// `LONGDO_RAIN_SWEEP_PER_REQUEST` calls per request inside the rate limit and the monthly budget.
/// Radar-derived, not measured.
async fn live_fleet_rain(State(st): State<AppState>, scoped: Scoped) -> WeatherResponse {
    let lw = &st.weather.longdo;
    if !longdo::enabled(&lw.cfg) {
        return Err(ApiError::NotFound("Longdo rain radar is not configured".into()).into());
    }
    let allowed = match &scoped.scope {
        PlantScope::All => None,
        PlantScope::Assigned(ids) => Some(ids),
    };
    longdo::fleet_rain(&st.pool, lw, allowed).await.map(Json).map_err(|e| longdo_err(e, "Longdo rain radar unavailable"))
}

/// Python `live.live_plant_rain`: rain over the plant from the Longdo weather radar, class 0–5 now
/// and the +15 / +30 min nowcast, plus rain nearby (radar-derived). 404 = not configured or
/// unknown plant; a held-back lookup answers 200 `stale`; 503 only for a plant without coordinates.
async fn live_plant_rain(State(st): State<AppState>, pr: PlantRead) -> WeatherResponse {
    let lw = &st.weather.longdo;
    if !longdo::enabled(&lw.cfg) {
        return Err(ApiError::NotFound("Longdo rain radar is not configured".into()).into());
    }
    let plant = get_plant(&st.pool, pr.plant_id).await?;
    longdo::plant_rain(&st.pool, &plant, lw).await.map(Json).map_err(|e| longdo_err(e, "Longdo rain radar unavailable"))
}
