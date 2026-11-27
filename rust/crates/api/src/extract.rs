//! The auth dependencies of backend/app/auth.py as axum extractors (plan §4): a handler that takes
//! `AdminUser` cannot run for an engineer, one that takes `PlantRead` cannot run for a plant the
//! engineer was not assigned. Rejections answer exactly as FastAPI does, in the same order:
//! 401 (no / bad token) → 403 (role) → 422 (bad `plant_id`) → 404 (plant not assigned).

use std::collections::HashSet;

use axum::extract::{FromRef, FromRequestParts, RawPathParams};
use axum::http::header;
use axum::http::request::Parts;
use tcroof_db::{PgPool, User};

use crate::auth::{decode_access_token, pyjwt_message};
use crate::error::ApiError;
use crate::AppState;

/// The signed-in, active user (Python `auth.get_current_user`).
pub struct CurrentUser(pub User);

impl<S> FromRequestParts<S> for CurrentUser
where
    AppState: FromRef<S>,
    S: Send + Sync,
{
    type Rejection = ApiError;

    async fn from_request_parts(parts: &mut Parts, state: &S) -> Result<Self, Self::Rejection> {
        // the user is resolved once per request, like FastAPI's dependency cache
        if let Some(CachedUser(u)) = parts.extensions.get::<CachedUser>() {
            return Ok(CurrentUser(u.clone()));
        }
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
            detail: format!("Invalid or expired authentication token: {}", pyjwt_message(&token, &e)),
            bearer: true,
        })?;
        let inactive = || ApiError::Unauthorized { detail: "User account not found or inactive".into(), bearer: false };
        let id: i32 = claims.sub.parse().map_err(|_| inactive())?;
        match tcroof_db::user_by_id(&st.pool, id).await? {
            Some(u) if u.is_active => {
                parts.extensions.insert(CachedUser(u.clone()));
                Ok(CurrentUser(u))
            }
            _ => Err(inactive()),
        }
    }
}

#[derive(Clone)]
struct CachedUser(User);

/// Python `require_write_access`: admin or engineer.
pub struct WriteUser(pub User);

impl<S> FromRequestParts<S> for WriteUser
where
    AppState: FromRef<S>,
    S: Send + Sync,
{
    type Rejection = ApiError;

    async fn from_request_parts(parts: &mut Parts, state: &S) -> Result<Self, Self::Rejection> {
        let CurrentUser(u) = CurrentUser::from_request_parts(parts, state).await?;
        if u.role != "admin" && u.role != "engineer" {
            return Err(ApiError::Forbidden(
                "Insufficient permissions: 'admin' or 'engineer' role required for write operations.".into(),
            ));
        }
        Ok(WriteUser(u))
    }
}

/// Python `require_admin`: fleet-wide settings, jobs, user management, System → Logs.
pub struct AdminUser(pub User);

impl<S> FromRequestParts<S> for AdminUser
where
    AppState: FromRef<S>,
    S: Send + Sync,
{
    type Rejection = ApiError;

    async fn from_request_parts(parts: &mut Parts, state: &S) -> Result<Self, Self::Rejection> {
        let CurrentUser(u) = CurrentUser::from_request_parts(parts, state).await?;
        if !u.is_admin() {
            return Err(ApiError::Forbidden("Admin role required.".into()));
        }
        Ok(AdminUser(u))
    }
}

/// Python `can_manage_stock`: spares receive / count / catalogue / locations.
pub fn can_manage_stock(u: &User) -> bool {
    u.is_admin() || u.store_keeper
}

/// Python `require_store_keeper`: admin or store keeper.
pub struct StoreKeeper(pub User);

impl<S> FromRequestParts<S> for StoreKeeper
where
    AppState: FromRef<S>,
    S: Send + Sync,
{
    type Rejection = ApiError;

    async fn from_request_parts(parts: &mut Parts, state: &S) -> Result<Self, Self::Rejection> {
        let CurrentUser(u) = CurrentUser::from_request_parts(parts, state).await?;
        if !can_manage_stock(&u) {
            return Err(ApiError::Forbidden("Admin or store keeper required.".into()));
        }
        Ok(StoreKeeper(u))
    }
}

/// The Growatt plants a user may see (Python `allowed_plant_ids`: `None` = every plant).
/// Read from the DB on every request, so an assignment change applies at once.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PlantScope {
    /// admin: every plant
    All,
    /// engineer: the assigned plants
    Assigned(HashSet<i64>),
}

impl PlantScope {
    /// Python `allowed_plant_ids`
    pub async fn of(pool: &PgPool, user: &User) -> Result<PlantScope, ApiError> {
        if user.is_admin() {
            return Ok(PlantScope::All);
        }
        let ids = tcroof_db::assigned_plant_ids(pool, user.id).await?;
        Ok(PlantScope::Assigned(ids.into_iter().map(i64::from).collect()))
    }

    pub fn allows(&self, plant_id: i64) -> bool {
        match self {
            PlantScope::All => true,
            PlantScope::Assigned(ids) => ids.contains(&plant_id),
        }
    }

    /// Python `ensure_plant_access`: 404 (not 403) outside the assignments, so ids are not revealed.
    pub fn ensure(&self, plant_id: i64) -> Result<(), ApiError> {
        if self.allows(plant_id) {
            Ok(())
        } else {
            Err(ApiError::NotFound(format!("Plant {plant_id} not found")))
        }
    }
}

/// The signed-in user's plant scope, for list routes that filter rather than reject.
pub struct Scoped {
    pub user: User,
    pub scope: PlantScope,
}

impl<S> FromRequestParts<S> for Scoped
where
    AppState: FromRef<S>,
    S: Send + Sync,
{
    type Rejection = ApiError;

    async fn from_request_parts(parts: &mut Parts, state: &S) -> Result<Self, Self::Rejection> {
        let CurrentUser(user) = CurrentUser::from_request_parts(parts, state).await?;
        let scope = PlantScope::of(&AppState::from_ref(state).pool, &user).await?;
        Ok(Scoped { user, scope })
    }
}

/// FastAPI's `plant_id: int` path parameter: a bad value is 422.
fn plant_id_param(params: &RawPathParams) -> Result<i64, ApiError> {
    let raw = params
        .iter()
        .find(|(k, _)| *k == "plant_id")
        .map(|(_, v)| v)
        .ok_or_else(|| ApiError::Internal("route has no {plant_id} parameter".into()))?;
    parse_int(raw).ok_or_else(|| ApiError::Unprocessable(format!("plant_id: Input should be a valid integer, got {raw:?}")))
}

/// pydantic's lax int from text: surrounding spaces, a sign, `_` between digits (`1_000`) and a
/// zero fraction (`1.0`) allowed; anything else (`1.5`, `1e3`) is not an int.
pub fn parse_int(raw: &str) -> Option<i64> {
    let t = raw.trim();
    let (neg, body) = match t.as_bytes().first() {
        Some(b'-') => (true, &t[1..]),
        Some(b'+') => (false, &t[1..]),
        _ => (false, t),
    };
    let (int_part, frac) = match body.split_once('.') {
        Some((i, f)) => (i, Some(f)),
        None => (body, None),
    };
    if frac.is_some_and(|f| !f.bytes().all(|b| b == b'0')) {
        return None;
    }
    // Python int(): `_` only singly, between digits
    if int_part.is_empty() || int_part.starts_with('_') || int_part.ends_with('_') || int_part.contains("__") {
        return None;
    }
    let digits: String = int_part.chars().filter(|c| *c != '_').collect();
    if !digits.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let n: i64 = digits.parse().ok()?;
    Some(if neg { -n } else { n })
}

/// Python `require_plant_read`: a `/…/plants/{plant_id}/…` read by an admin, or an engineer the
/// plant is assigned to.
pub struct PlantRead {
    pub user: User,
    pub plant_id: i64,
}

impl<S> FromRequestParts<S> for PlantRead
where
    AppState: FromRef<S>,
    S: Send + Sync,
{
    type Rejection = ApiError;

    async fn from_request_parts(parts: &mut Parts, state: &S) -> Result<Self, Self::Rejection> {
        let CurrentUser(user) = CurrentUser::from_request_parts(parts, state).await?;
        let (user, plant_id) = scoped_plant(parts, state, user).await?;
        Ok(PlantRead { user, plant_id })
    }
}

/// Python `require_plant_write`: `require_write_access`, then the plant must be in scope.
pub struct PlantWrite {
    pub user: User,
    pub plant_id: i64,
}

impl<S> FromRequestParts<S> for PlantWrite
where
    AppState: FromRef<S>,
    S: Send + Sync,
{
    type Rejection = ApiError;

    async fn from_request_parts(parts: &mut Parts, state: &S) -> Result<Self, Self::Rejection> {
        let WriteUser(user) = WriteUser::from_request_parts(parts, state).await?;
        let (user, plant_id) = scoped_plant(parts, state, user).await?;
        Ok(PlantWrite { user, plant_id })
    }
}

async fn scoped_plant<S>(parts: &mut Parts, state: &S, user: User) -> Result<(User, i64), ApiError>
where
    AppState: FromRef<S>,
    S: Send + Sync,
{
    let params = RawPathParams::from_request_parts(parts, state)
        .await
        .map_err(|e| ApiError::Internal(format!("path parameters: {e}")))?;
    let plant_id = plant_id_param(&params)?;
    PlantScope::of(&AppState::from_ref(state).pool, &user).await?.ensure(plant_id)?;
    Ok((user, plant_id))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scope_all_and_assigned() {
        assert!(PlantScope::All.allows(123));
        let s = PlantScope::Assigned([5, 7].into_iter().collect());
        assert!(s.allows(7) && !s.allows(8));
        assert!(s.ensure(5).is_ok());
        match s.ensure(8) {
            Err(ApiError::NotFound(m)) => assert_eq!(m, "Plant 8 not found"),
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn lax_int() {
        assert_eq!(parse_int("42"), Some(42));
        assert_eq!(parse_int(" -3 "), Some(-3));
        assert_eq!(parse_int("+7"), Some(7));
        // pydantic: '1.0' -> 1, '1_000' -> 1000 (checked against pydantic 2)
        assert_eq!(parse_int("1.0"), Some(1));
        assert_eq!(parse_int("1_000"), Some(1000));
        for bad in ["", "x", "1.5", "1e3", "--1", "+", "_1", "1__0", "1_", ".0"] {
            assert_eq!(parse_int(bad), None, "{bad}");
        }
    }
}
