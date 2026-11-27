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
    #[error("{0}")]
    Unprocessable(String),
    #[error("database error")]
    Db(#[from] tcroof_db::Error),
    #[error("internal error")]
    Internal(String),
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let (status, detail, bearer) = match &self {
            ApiError::Unauthorized { detail, bearer } => (StatusCode::UNAUTHORIZED, detail.clone(), *bearer),
            ApiError::Unprocessable(m) => (StatusCode::UNPROCESSABLE_ENTITY, m.clone(), false),
            ApiError::Db(e) => {
                tracing::error!(error = %e, "database error");
                (StatusCode::INTERNAL_SERVER_ERROR, "Internal Server Error".into(), false)
            }
            ApiError::Internal(m) => {
                tracing::error!(error = %m, "internal error");
                (StatusCode::INTERNAL_SERVER_ERROR, "Internal Server Error".into(), false)
            }
        };
        let mut res = (status, Json(json!({ "detail": detail }))).into_response();
        if bearer {
            res.headers_mut().insert(header::WWW_AUTHENTICATE, HeaderValue::from_static("Bearer"));
        }
        res
    }
}
