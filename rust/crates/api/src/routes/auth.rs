//! `/health`, `/health/worker` (backend/app/main.py) and `/auth/*` (backend/app/api/routes/auth.py).

use axum::body::Bytes;
use axum::extract::State;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use serde_json::json;

use tcroof_db::User;

use crate::auth::{create_access_token, verify_password};
use crate::config::{APP_NAME, APP_VERSION};
use crate::error::ApiError;
use crate::extract::CurrentUser;
use crate::pyfmt::{isoformat, repr_str};
use crate::AppState;

/// Python `jobs.WORKER_STALE_AFTER`
const WORKER_STALE_AFTER_MIN: i64 = 120;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/health", get(health))
        .route("/health/worker", get(worker_health))
        .route("/auth/login", post(login))
        .route("/auth/me", get(me))
}

// ------------------------------------------------------------------ health (backend/app/main.py)

/// Python `main.health_check`
async fn health() -> Json<serde_json::Value> {
    Json(json!({ "status": "ok", "service": APP_NAME, "version": APP_VERSION }))
}

/// Python `main.worker_health_check` + `jobs.worker_health`
async fn worker_health(State(st): State<AppState>) -> Response {
    match tcroof_db::last_history_finished(&st.pool).await {
        Ok(last) => {
            let ok = last.is_some_and(|t| Utc::now() - t < chrono::Duration::minutes(WORKER_STALE_AFTER_MIN));
            let body = json!({ "ok": ok, "last_history_at": last.map(isoformat) });
            (if ok { StatusCode::OK } else { StatusCode::SERVICE_UNAVAILABLE }, Json(body)).into_response()
        }
        Err(e) => {
            // Python reports this in the body only; nothing goes to app_logs
            tracing::debug!(error = %e, "worker health: database unavailable");
            let body = json!({ "ok": false, "last_history_at": null, "error": "database unavailable" });
            (StatusCode::SERVICE_UNAVAILABLE, Json(body)).into_response()
        }
    }
}

// ------------------------------------------------------------- auth (backend/app/api/routes/auth.py)

#[derive(Deserialize)]
struct LoginRequest {
    username: Option<String>,
    email: Option<String>,
    password: String,
}

impl LoginRequest {
    /// `(username or email or "").strip().lower()`: an empty username falls through to the email.
    fn identifier(&self) -> String {
        let pick = |v: &Option<String>| v.as_deref().filter(|s| !s.is_empty()).map(str::to_owned);
        pick(&self.username).or_else(|| pick(&self.email)).unwrap_or_default().trim().to_lowercase()
    }
}

/// Python `schemas.api_schemas.UserOut`
#[derive(Serialize, Debug, Clone, PartialEq)]
pub struct UserOut {
    pub id: i32,
    pub username: Option<String>,
    pub email: String,
    pub full_name: String,
    pub role: String,
    pub is_active: bool,
    pub store_keeper: bool,
    /// null = every plant (admin), else the assigned ids
    pub plant_ids: Option<Vec<i32>>,
}

impl UserOut {
    /// Python `services/users.user_out` with the assignments already read
    pub fn new(u: &User, assigned: Vec<i32>) -> UserOut {
        UserOut {
            id: u.id,
            username: u.username.clone(),
            email: u.email.clone(),
            full_name: u.full_name.clone(),
            role: u.role.clone(),
            is_active: u.is_active,
            store_keeper: u.store_keeper,
            plant_ids: if u.is_admin() { None } else { Some(assigned) },
        }
    }
}

#[derive(Serialize)]
struct TokenResponse {
    access_token: String,
    token_type: &'static str,
    user: UserOut,
}

/// Python `services/users.user_out`
pub async fn user_out(st: &AppState, u: &User) -> Result<UserOut, ApiError> {
    let assigned = if u.is_admin() { Vec::new() } else { tcroof_db::assigned_plant_ids(&st.pool, u.id).await? };
    Ok(UserOut::new(u, assigned))
}

/// Python `routes/auth.login`
async fn login(State(st): State<AppState>, body: Bytes) -> Result<Json<TokenResponse>, ApiError> {
    // FastAPI answers a malformed body with 422 and a list of field errors; this keeps the status
    // and a plain message (the UI shows only the status for this route)
    let req: LoginRequest =
        serde_json::from_slice(&body).map_err(|e| ApiError::Unprocessable(format!("Invalid login body: {e}")))?;
    let ident = req.identifier();
    if ident.is_empty() {
        return Err(ApiError::Unprocessable("Username is required".into()));
    }
    let user = tcroof_db::user_by_login(&st.pool, &ident).await?;
    // Same message for unknown user, wrong password and disabled account: don't reveal which.
    let Some(user) = user.filter(|u| u.is_active && verify_password(&req.password, &u.hashed_password)) else {
        // the name tried, never the password
        let shown: String = ident.chars().take(64).collect();
        tracing::info!(target: "app.audit", "failed login for {}", repr_str(&shown));
        return Err(ApiError::Unauthorized { detail: "Invalid username or password".into(), bearer: false });
    };
    let token = create_access_token(&user, &st.settings.jwt_secret_key, st.settings.jwt_expire_minutes)
        .map_err(|e| ApiError::Internal(e.to_string()))?;
    Ok(Json(TokenResponse { access_token: token, token_type: "bearer", user: user_out(&st, &user).await? }))
}

/// Python `routes/auth.get_me`
async fn me(State(st): State<AppState>, CurrentUser(user): CurrentUser) -> Result<Json<UserOut>, ApiError> {
    Ok(Json(user_out(&st, &user).await?))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identifier_follows_python_or_chain() {
        let r = |u: Option<&str>, e: Option<&str>| LoginRequest {
            username: u.map(Into::into),
            email: e.map(Into::into),
            password: String::new(),
        };
        assert_eq!(r(Some(" Admin "), None).identifier(), "admin");
        assert_eq!(r(Some(""), Some("A@B.co")).identifier(), "a@b.co");
        assert_eq!(r(None, None).identifier(), "");
    }
}
