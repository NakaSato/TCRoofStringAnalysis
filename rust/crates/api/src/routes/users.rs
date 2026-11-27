//! Users & Access (`/users`, admin only): backend/app/api/routes/users.py and
//! backend/app/services/users.py. Accounts are disabled, never deleted (there is no DELETE route).
//! Every handler takes `AdminUser` first: 401 / 403 come before any body or path validation, as
//! with FastAPI's router-level `Depends(require_admin)`.

use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::routing::{get, patch, put};
use axum::{Json, Router};
use serde_json::{Map, Value};

use tcroof_db::users::{self as q, NewUser};
use tcroof_db::User;

use crate::auth::hash_password;
use crate::error::ApiError;
use crate::extract::{parse_int, AdminUser};
use crate::pyfmt::{int_list, repr_str};
use crate::routes::auth::{user_out, UserOut};
use crate::validate as v;
use crate::AppState;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/users", get(list_users).post(create_user))
        .route("/users/{user_id}", patch(update_user))
        .route("/users/{user_id}/plants", put(set_user_plants))
}

/// Python `routes/users._by`: who acted, for `assigned_by` and the audit log.
fn by(u: &User) -> String {
    u.username.clone().filter(|s| !s.is_empty()).unwrap_or_else(|| u.email.clone())
}

/// Python `UserError` (422) with its message
fn user_error(msg: String) -> ApiError {
    ApiError::Unprocessable(msg)
}

/// FastAPI's `user_id: int` path parameter. An id that can't be a row (beyond int4) is simply
/// not found, as in Python (the lookup finds nothing).
enum UserId {
    Id(i32),
    Missing(i64),
}

fn user_id(raw: &str) -> Result<UserId, ApiError> {
    let n = parse_int(raw)
        .ok_or_else(|| ApiError::Unprocessable(format!("user_id: Input should be a valid integer, got {raw:?}")))?;
    Ok(i32::try_from(n).map_or(UserId::Missing(n), UserId::Id))
}

/// Python `services/users._get`: 404 "User {id} not found"
async fn get_user(st: &AppState, id: &UserId) -> Result<User, ApiError> {
    let (n, found) = match *id {
        UserId::Id(i) => (i64::from(i), tcroof_db::user_by_id(&st.pool, i).await?),
        UserId::Missing(n) => (n, None),
    };
    found.ok_or_else(|| ApiError::NotFound(format!("User {n} not found")))
}

/// Python `services/users._check_plants`: sorted, unique, every id in the Growatt registry.
async fn check_plants(st: &AppState, ids: &[i64]) -> Result<Vec<i64>, ApiError> {
    let mut ids = ids.to_vec();
    ids.sort_unstable();
    ids.dedup();
    if ids.is_empty() {
        return Ok(ids);
    }
    let known: std::collections::HashSet<i64> = q::known_plant_ids(&st.pool, &ids).await?.into_iter().collect();
    let unknown: Vec<i64> = ids.iter().copied().filter(|i| !known.contains(i)).collect();
    if !unknown.is_empty() {
        return Err(user_error(format!("Unknown plant id(s): {}", int_list(&unknown))));
    }
    Ok(ids)
}

async fn hash(password: String) -> Result<String, ApiError> {
    tokio::task::spawn_blocking(move || hash_password(&password))
        .await
        .map_err(|e| ApiError::Internal(format!("hash_password: {e}")))
}

/// GET /users: Python `list_users`, ordered by role, then username.
async fn list_users(State(st): State<AppState>, AdminUser(_): AdminUser) -> Result<Json<Vec<UserOut>>, ApiError> {
    let users = q::list_users(&st.pool).await?;
    let mut assigned = q::all_assignments(&st.pool).await?;
    Ok(Json(users.iter().map(|u| UserOut::new(u, assigned.remove(&u.id).unwrap_or_default())).collect()))
}

/// Python `schemas.api_schemas.UserCreate`
struct UserCreate {
    username: String,
    email: Option<String>,
    full_name: String,
    password: String,
    role: String,
    store_keeper: bool,
    plant_ids: Vec<i64>,
}

fn is_username(s: &str) -> bool {
    s.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
}

impl UserCreate {
    fn parse(o: &Map<String, Value>) -> Result<UserCreate, ApiError> {
        let username = v::required_string(o, "username", 2, 64)?;
        if !is_username(&username) {
            return Err(ApiError::Unprocessable("username: String should match pattern '^[A-Za-z0-9._-]+$'".into()));
        }
        Ok(UserCreate {
            username,
            email: v::optional_string(o, "email", 0, 255)?,
            full_name: v::required_string(o, "full_name", 1, 255)?,
            password: v::required_string(o, "password", 8, 128)?,
            role: o.get("role").map_or(Ok("engineer".to_owned()), |x| v::role("role", x))?,
            store_keeper: v::bool_or(o, "store_keeper", false)?,
            plant_ids: o.get("plant_ids").map_or(Ok(Vec::new()), |x| v::int_list("plant_ids", x))?,
        })
    }
}

/// POST /users (201): Python `services/users.create_user` + the route's audit line.
async fn create_user(
    State(st): State<AppState>,
    AdminUser(admin): AdminUser,
    headers: HeaderMap,
    body: Bytes,
) -> Result<(StatusCode, Json<UserOut>), ApiError> {
    let data = UserCreate::parse(&v::json_object(&headers, &body)?)?;
    let actor = by(&admin);
    let username = data.username.trim().to_lowercase();
    let email = data.email.as_deref().unwrap_or("").trim().to_lowercase();
    let email = if email.is_empty() { format!("{username}@users.local") } else { email };
    if q::username_or_email_taken(&st.pool, &username, &email).await? {
        return Err(user_error(format!(
            "Username or email already in use: {} / {}",
            repr_str(&username),
            repr_str(&email)
        )));
    }
    let plant_ids = check_plants(&st, &data.plant_ids).await?;
    let hashed = hash(data.password).await?;
    let mut tx = st.pool.begin().await?;
    let user = q::insert_user(
        &mut tx,
        &NewUser {
            username: &username,
            email: &email,
            full_name: data.full_name.trim(),
            hashed_password: &hashed,
            role: &data.role,
            store_keeper: data.store_keeper,
        },
    )
    .await?;
    q::replace_assignments(&mut tx, &user, &plant_ids, &actor).await?;
    tx.commit().await?;
    let out = user_out(&st, &user).await?;
    let name = out.username.clone().filter(|s| !s.is_empty()).unwrap_or_else(|| out.email.clone());
    tracing::info!(target: "app.audit", "{actor} created user {name} ({})", out.role);
    Ok((StatusCode::CREATED, Json(out)))
}

/// Python `schemas.api_schemas.UserUpdate`: fields left out are not changed. `set` holds the
/// fields the body named (`model_dump(exclude_unset=True)`), null ones included.
struct UserUpdate {
    email: Option<String>,
    full_name: Option<String>,
    password: Option<String>,
    role: Option<String>,
    is_active: Option<bool>,
    store_keeper: Option<bool>,
    set: Vec<&'static str>,
}

impl UserUpdate {
    const FIELDS: [&'static str; 6] = ["email", "full_name", "password", "role", "is_active", "store_keeper"];

    fn parse(o: &Map<String, Value>) -> Result<UserUpdate, ApiError> {
        let role = match o.get("role") {
            None | Some(Value::Null) => None,
            Some(x) => Some(v::role("role", x)?),
        };
        let mut set: Vec<&'static str> = Self::FIELDS.into_iter().filter(|f| o.contains_key(*f)).collect();
        set.sort_unstable();
        Ok(UserUpdate {
            email: v::optional_string(o, "email", 0, 255)?,
            full_name: v::optional_string(o, "full_name", 1, 255)?,
            password: v::optional_string(o, "password", 8, 128)?,
            role,
            is_active: v::optional_bool(o, "is_active")?,
            store_keeper: v::optional_bool(o, "store_keeper")?,
            set,
        })
    }
}

/// PATCH /users/{id}: Python `services/users.update_user` (role, name, email, password, active
/// flag, store keeper) + the route's audit line (field names only, never the password).
async fn update_user(
    State(st): State<AppState>,
    AdminUser(admin): AdminUser,
    Path(raw_id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Json<UserOut>, ApiError> {
    // FastAPI validates the path and the body together: either failing is 422, before the lookup
    let id = user_id(&raw_id);
    let data = v::json_object(&headers, &body).and_then(|o| UserUpdate::parse(&o));
    let (id, data) = (id?, data?);
    let mut user = get_user(&st, &id).await?;

    let demotes = data.role.as_deref().is_some_and(|r| r != "admin") && user.is_admin();
    let disables = data.is_active == Some(false) && user.is_active;
    if (demotes || disables) && user.is_admin() && user.is_active && q::count_active_admins(&st.pool).await? <= 1 {
        return Err(user_error("Cannot demote or disable the last active admin".into()));
    }
    if disables && user.id == admin.id {
        return Err(user_error("You cannot disable your own account".into()));
    }
    if let Some(email) = &data.email {
        let email = email.trim().to_lowercase();
        if q::email_taken_by_other(&st.pool, &email, user.id).await? {
            return Err(user_error(format!("Email already in use: {}", repr_str(&email))));
        }
        user.email = email;
    }
    if let Some(name) = &data.full_name {
        user.full_name = name.trim().to_owned();
    }
    if let Some(pw) = data.password.clone().filter(|p| !p.is_empty()) {
        user.hashed_password = hash(pw).await?;
    }
    if let Some(a) = data.is_active {
        user.is_active = a;
    }
    if let Some(k) = data.store_keeper {
        user.store_keeper = k;
    }
    let mut tx = st.pool.begin().await?;
    if let Some(role) = data.role.as_deref().filter(|r| *r != user.role) {
        user.role = role.to_owned();
        if user.is_admin() {
            q::delete_assignments(&mut tx, user.id).await?;
        }
    }
    q::save_user(&mut tx, &user).await?;
    tx.commit().await?;
    let out = user_out(&st, &user).await?;
    let fields = if data.set.is_empty() { "nothing".to_owned() } else { data.set.join(", ") };
    tracing::info!(target: "app.audit", "{} changed user {}: {fields}", by(&admin), raw_id_text(&id));
    Ok(Json(out))
}

fn raw_id_text(id: &UserId) -> String {
    match id {
        UserId::Id(i) => i.to_string(),
        UserId::Missing(n) => n.to_string(),
    }
}

/// PUT /users/{id}/plants: Python `services/users.set_user_plants` (replace the engineer's
/// assigned plants; an empty list removes them all).
async fn set_user_plants(
    State(st): State<AppState>,
    AdminUser(admin): AdminUser,
    Path(raw_id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Json<UserOut>, ApiError> {
    let id = user_id(&raw_id);
    let ids = v::json_object(&headers, &body).and_then(|o| match o.get("plant_ids") {
        None => Err(ApiError::Unprocessable("plant_ids: Field required".into())),
        Some(x) => v::int_list("plant_ids", x),
    });
    let (id, ids) = (id?, ids?);
    let user = get_user(&st, &id).await?;
    if user.is_admin() {
        return Err(user_error("Admins see every plant; assign plants to engineers only".into()));
    }
    let actor = by(&admin);
    let plant_ids = check_plants(&st, &ids).await?;
    let mut tx = st.pool.begin().await?;
    q::replace_assignments(&mut tx, &user, &plant_ids, &actor).await?;
    tx.commit().await?;
    let out = user_out(&st, &user).await?;
    tracing::info!(target: "app.audit", "{actor} set user {}'s plants: {} assigned", raw_id_text(&id), ids.len());
    Ok(Json(out))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn obj(v: Value) -> Map<String, Value> {
        v.as_object().unwrap().clone()
    }

    #[test]
    fn create_rules() {
        let ok = json!({"username": "a.b-c_9", "full_name": "X", "password": "12345678"});
        let c = UserCreate::parse(&obj(ok.clone())).unwrap();
        assert_eq!((c.role.as_str(), c.store_keeper, c.plant_ids.len()), ("engineer", false, 0));
        for (patch, field) in [
            (json!({"username": "a"}), "username"),
            (json!({"username": "a b"}), "username"),
            (json!({"username": "x".repeat(65)}), "username"),
            (json!({"password": "1234567"}), "password"),
            (json!({"full_name": ""}), "full_name"),
            (json!({"role": "viewer"}), "role"),
            (json!({"role": null}), "role"),
            (json!({"store_keeper": null}), "store_keeper"),
            (json!({"plant_ids": null}), "plant_ids"),
            (json!({"plant_ids": [1, "x"]}), "plant_ids.1"),
            (json!({"email": "e".repeat(256)}), "email"),
        ] {
            let mut b = obj(ok.clone());
            b.extend(obj(patch.clone()));
            match UserCreate::parse(&b) {
                Err(ApiError::Unprocessable(m)) => assert!(m.starts_with(&format!("{field}:")), "{patch}: {m}"),
                Err(e) => panic!("{patch}: {e:?}"),
                Ok(_) => panic!("{patch}: accepted"),
            }
        }
        let mut b = obj(ok);
        b.remove("password");
        assert!(UserCreate::parse(&b).is_err());
    }

    #[test]
    fn update_tracks_named_fields() {
        let u = UserUpdate::parse(&obj(json!({"role": null, "full_name": "N", "x": 1}))).unwrap();
        assert_eq!(u.set, vec!["full_name", "role"]);
        assert!(u.role.is_none());
        assert!(UserUpdate::parse(&obj(json!({"password": ""}))).is_err());
        assert!(UserUpdate::parse(&obj(json!({"full_name": ""}))).is_err());
        assert!(UserUpdate::parse(&obj(json!({"is_active": "maybe"}))).is_err());
    }
}
