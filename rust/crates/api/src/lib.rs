//! Rust API (Phase 1 of docs/plans/rust-port-master-plan.md). Same JSON contract as the FastAPI
//! app, mounted at both `/api/*` and `/*` like backend/app/main.py.
//!
//! Ported so far: `/health`, `/health/worker`, `/auth/login`, `/auth/me`, `/users*`,
//! `/system/logs*`, the request-logging middleware and the `app_logs` handler.

pub mod auth;
pub mod config;
pub mod error;
pub mod extract;
pub mod logging;
pub mod pyfmt;
pub mod request_log;
pub mod routes;
pub mod validate;

use std::sync::Arc;

use axum::Router;
use tcroof_db::PgPool;

pub use config::Settings;
pub use logging::DbLog;

#[derive(Clone)]
pub struct AppState {
    pub pool: PgPool,
    pub settings: Arc<Settings>,
    /// the `app_logs` sink (None when `LOG_DB_ENABLED` is false); the request middleware flushes it
    pub logs: Option<Arc<DbLog>>,
    /// Growatt live service (services/live.rs, Python `get_live_service`): memory cache mirrored
    /// in Redis when `REDIS_URL` is set; never written to SQL
    pub live: tcroof_services::live::LiveService,
}

impl AppState {
    /// A state without DB logging (tests that don't look at `app_logs`).
    pub fn new(pool: PgPool, settings: Settings) -> AppState {
        let live = live_service(&settings);
        AppState { pool, settings: Arc::new(settings), logs: None, live }
    }
}

/// Python `get_live_service`: the accounts of `settings`, the Redis mirror of `REDIS_URL`.
pub fn live_service(settings: &Settings) -> tcroof_services::live::LiveService {
    let accounts = tcroof_services::live::GrowattAccounts {
        tokens: settings.growatt_accounts(),
        base_url: settings.growatt_base_url.clone(),
        blocked_plant_ids: settings.blocked_plant_ids(),
    };
    let redis = tcroof_services::live_store::redis_link(&settings.redis_url);
    tcroof_services::live::LiveService::new(settings.live_config(), accounts, redis)
}

pub fn app(state: AppState) -> Router {
    let api = routes::router()
        .route_layer(axum::middleware::from_fn(request_log::capture_route))
        .method_not_allowed_fallback(routes::method_not_allowed);
    Router::new()
        .nest("/api", api.clone())
        .merge(api)
        .fallback(routes::not_found)
        .layer(axum::middleware::from_fn_with_state(state.clone(), request_log::request_log))
        .layer(tower_http::trace::TraceLayer::new_for_http())
        .with_state(state)
}
