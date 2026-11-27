//! Errors answered as FastAPI does: `{"detail": "..."}` with the status code.

use axum::http::{header, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde_json::json;

#[derive(Debug, thiserror::Error)]
pub enum ApiError {
    /// 401; `bearer` adds `WWW-Authenticate: Bearer` (Python sends it on a missing or bad token,
    /// not on a failed login or an inactive account)
    #[error("{detail}")]
    Unauthorized { detail: String, bearer: bool },
    /// 403 (`require_admin`, `require_write_access`, `require_store_keeper`)
    #[error("{0}")]
    Forbidden(String),
    /// 404, e.g. a plant outside the engineer's assignments (never 403: ids are not revealed)
    #[error("{0}")]
    NotFound(String),
    /// 422: FastAPI's validation errors (a list there; one message here) and the services' own
    #[error("{0}")]
    Unprocessable(String),
    #[error("database error")]
    Db(#[from] tcroof_db::Error),
    #[error("internal error")]
    Internal(String),
}

/// On a 500 response: the error behind it. The request middleware logs it as Python logs an
/// unhandled exception (`log.exception(... failed: unhandled exception)`, backend/app/api/request_log.py).
#[derive(Debug, Clone)]
pub struct Unhandled(pub String);

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let (status, detail, bearer, unhandled) = match self {
            ApiError::Unauthorized { detail, bearer } => (StatusCode::UNAUTHORIZED, detail, bearer, None),
            ApiError::Forbidden(m) => (StatusCode::FORBIDDEN, m, false, None),
            ApiError::NotFound(m) => (StatusCode::NOT_FOUND, m, false, None),
            ApiError::Unprocessable(m) => (StatusCode::UNPROCESSABLE_ENTITY, m, false, None),
            ApiError::Db(e) => {
                (StatusCode::INTERNAL_SERVER_ERROR, "Internal Server Error".into(), false, Some(format!("database error: {e}")))
            }
            ApiError::Internal(m) => (StatusCode::INTERNAL_SERVER_ERROR, "Internal Server Error".into(), false, Some(m)),
        };
        let mut res = (status, Json(json!({ "detail": detail }))).into_response();
        if bearer {
            res.headers_mut().insert(header::WWW_AUTHENTICATE, HeaderValue::from_static("Bearer"));
        }
        if let Some(e) = unhandled {
            res.extensions_mut().insert(Unhandled(e));
        }
        res
    }
}
