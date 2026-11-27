//! Routes ported so far. Each mirrors a FastAPI handler; the Python source is named on each.

use axum::body::Bytes;
use axum::extract::{FromRef, FromRequestParts, State};
use axum::http::request::Parts;
use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use chrono::{DateTime, SecondsFormat, Utc};
use serde::{Deserialize, Serialize};
use serde_json::json;

use tcroof_db::User;

use crate::auth::{create_access_token, decode_access_token, verify_password};
use crate::config::{APP_NAME, APP_VERSION};
use crate::error::ApiError;
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

async fn health() -> Json<serde_json::Value> {
    Json(json!({ "status": "ok", "service": APP_NAME, "version": APP_VERSION }))
}

/// Python `datetime.isoformat()` of an aware UTC time: microseconds only when non-zero, `+00:00`.
fn py_isoformat(t: DateTime<Utc>) -> String {
    let fmt = if t.timestamp_subsec_micros() == 0 { SecondsFormat::Secs } else { SecondsFormat::Micros };
    t.to_rfc3339_opts(fmt, false)
}

async fn worker_health(State(st): State<AppState>) -> Response {
    match tcroof_db::last_history_finished(&st.pool).await {
        Ok(last) => {
            let ok = last.is_some_and(|t| Utc::now() - t < chrono::Duration::minutes(WORKER_STALE_AFTER_MIN));
            let body = json!({ "ok": ok, "last_history_at": last.map(py_isoformat) });
            (if ok { StatusCode::OK } else { StatusCode::SERVICE_UNAVAILABLE }, Json(body)).into_response()
        }
        Err(e) => {
            tracing::warn!(error = %e, "worker health: database unavailable");
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

#[derive(Serialize)]
struct UserOut {
    id: i32,
    username: Option<String>,
    email: String,
    full_name: String,
    role: String,
    is_active: bool,
    store_keeper: bool,
    /// null = every plant (admin), else the assigned ids
    plant_ids: Option<Vec<i32>>,
}

#[derive(Serialize)]
struct TokenResponse {
    access_token: String,
    token_type: &'static str,
    user: UserOut,
}

/// Python `services/users.user_out`
async fn user_out(st: &AppState, u: &User) -> Result<UserOut, ApiError> {
    let plant_ids = if u.is_admin() { None } else { Some(tcroof_db::assigned_plant_ids(&st.pool, u.id).await?) };
    Ok(UserOut {
        id: u.id,
        username: u.username.clone(),
        email: u.email.clone(),
        full_name: u.full_name.clone(),
        role: u.role.clone(),
        is_active: u.is_active,
        store_keeper: u.store_keeper,
        plant_ids,
    })
}

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
        let shown: String = ident.chars().take(64).collect();
        tracing::info!(target: "app.audit", "failed login for {shown:?}");
        return Err(ApiError::Unauthorized { detail: "Invalid username or password".into(), bearer: false });
    };
    let token = create_access_token(&user, &st.settings.jwt_secret_key, st.settings.jwt_expire_minutes)
        .map_err(|e| ApiError::Internal(e.to_string()))?;
    Ok(Json(TokenResponse { access_token: token, token_type: "bearer", user: user_out(&st, &user).await? }))
}

/// The signed-in, active user (Python `auth.get_current_user`).
pub struct CurrentUser(pub User);

impl<S> FromRequestParts<S> for CurrentUser
where
    AppState: FromRef<S>,
    S: Send + Sync,
{
    type Rejection = ApiError;

    async fn from_request_parts(parts: &mut Parts, state: &S) -> Result<Self, Self::Rejection> {
        let st = AppState::from_ref(state);
        // HTTPBearer: scheme "Bearer" in any case, non-empty credentials
        let token = parts
            .headers
            .get(header::AUTHORIZATION)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.split_once(' '))
            .filter(|(scheme, cred)| scheme.eq_ignore_ascii_case("bearer") && !cred.trim().is_empty())
            .map(|(_, cred)| cred.trim().to_owned());
        let Some(token) = token else {
            return Err(ApiError::Unauthorized { detail: "Authentication required".into(), bearer: true });
        };
        let claims = decode_access_token(&token, &st.settings.jwt_secret_key).map_err(|e| ApiError::Unauthorized {
            detail: format!("Invalid or expired authentication token: {}", crate::auth::pyjwt_message(&token, &e)),
            bearer: true,
        })?;
        let inactive = || ApiError::Unauthorized { detail: "User account not found or inactive".into(), bearer: false };
        let id: i32 = claims.sub.parse().map_err(|_| inactive())?;
        match tcroof_db::user_by_id(&st.pool, id).await? {
            Some(u) if u.is_active => Ok(CurrentUser(u)),
            _ => Err(inactive()),
        }
    }
}

async fn me(State(st): State<AppState>, CurrentUser(user): CurrentUser) -> Result<Json<UserOut>, ApiError> {
    Ok(Json(user_out(&st, &user).await?))
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    #[test]
    fn isoformat_matches_python() {
        let t = Utc.with_ymd_and_hms(2026, 11, 27, 10, 0, 0).unwrap();
        assert_eq!(py_isoformat(t), "2026-11-27T10:00:00+00:00");
        let t = t + chrono::Duration::microseconds(1234);
        assert_eq!(py_isoformat(t), "2026-11-27T10:00:00.001234+00:00");
    }

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
