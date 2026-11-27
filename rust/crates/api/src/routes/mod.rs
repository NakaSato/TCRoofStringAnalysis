//! The ported routers. Each handler names the FastAPI handler it mirrors.

use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::{Json, Router};
use serde_json::json;

use crate::AppState;

pub mod auth;
pub mod growatt;
pub mod system;
pub mod users;

/// backend/app/main.py `api_router`: everything mounted at both `/api` and `/`. `/users` and
/// `/system` are admin only there (`include_router(..., dependencies=[Depends(require_admin)])`);
/// here each of their handlers takes `AdminUser`.
pub fn router() -> Router<AppState> {
    Router::new()
        .merge(auth::router())
        .merge(users::router())
        .merge(system::router())
        .nest("/growatt", growatt::router())
}

/// Starlette's 404 for an unknown path
pub async fn not_found() -> impl IntoResponse {
    (StatusCode::NOT_FOUND, Json(json!({"detail": "Not Found"})))
}

/// Starlette's 405 for a known path with another method (answered before any auth check)
pub async fn method_not_allowed() -> impl IntoResponse {
    (StatusCode::METHOD_NOT_ALLOWED, Json(json!({"detail": "Method Not Allowed"})))
}
