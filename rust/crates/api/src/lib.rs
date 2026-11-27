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
}

impl AppState {
    /// A state without DB logging (tests that don't look at `app_logs`).
    pub fn new(pool: PgPool, settings: Settings) -> AppState {
        AppState { pool, settings: Arc::new(settings), logs: None }
    }
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
