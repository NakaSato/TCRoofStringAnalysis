//! Rust API (Phase 0 / 1 of docs/plans/rust-port-master-plan.md). Same JSON contract as the
//! FastAPI app, mounted at both `/api/*` and `/*` like backend/app/main.py.
//!
//! Ported so far: `/health`, `/health/worker`, `/auth/login`, `/auth/me`.

pub mod auth;
pub mod config;
pub mod error;
mod routes;

use std::sync::Arc;

use axum::Router;
use tcroof_db::PgPool;

pub use config::Settings;

#[derive(Clone)]
pub struct AppState {
    pub pool: PgPool,
    pub settings: Arc<Settings>,
}

pub fn app(state: AppState) -> Router {
    let api = routes::router();
    Router::new()
        .nest("/api", api.clone())
        .merge(api)
        .layer(tower_http::trace::TraceLayer::new_for_http())
        .with_state(state)
}
