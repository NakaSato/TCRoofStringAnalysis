//! `users` and `user_plant_assignments` queries for Users & Access (backend/app/services/users.py).
//! The rules (last admin, clashes, unknown plants) live in the API crate; these are the statements.

use std::collections::HashMap;

use sqlx::{PgConnection, PgPool};

use crate::{Error, User, USER_COLS};

/// Python `list_users`: `ORDER BY role, username` (the database's collation, NULL usernames last).
pub async fn list_users(pool: &PgPool) -> Result<Vec<User>, Error> {
    sqlx::query_as::<_, User>(&format!("SELECT {USER_COLS} FROM users ORDER BY role, username"))
        .fetch_all(pool)
        .await
}

/// Every user's assigned plants, sorted (one query instead of Python's one per user).
pub async fn all_assignments(pool: &PgPool) -> Result<HashMap<i32, Vec<i32>>, Error> {
    let rows: Vec<(i32, i32)> =
        sqlx::query_as("SELECT user_id, plant_id FROM user_plant_assignments ORDER BY user_id, plant_id")
            .fetch_all(pool)
            .await?;
    let mut out: HashMap<i32, Vec<i32>> = HashMap::new();
    for (u, p) in rows {
        out.entry(u).or_default().push(p);
    }
    Ok(out)
}

/// Python `_active_admins`
pub async fn count_active_admins(pool: &PgPool) -> Result<i64, Error> {
    sqlx::query_scalar("SELECT count(*) FROM users WHERE role = 'admin' AND is_active IS true")
        .fetch_one(pool)
        .await
}

/// Python `create_user`'s clash check: a user with this username or this email.
pub async fn username_or_email_taken(pool: &PgPool, username: &str, email: &str) -> Result<bool, Error> {
    sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM users WHERE username = $1 OR email = $2)")
        .bind(username)
        .bind(email)
        .fetch_one(pool)
        .await
}

/// Python `update_user`'s email check: another user already has this email.
pub async fn email_taken_by_other(pool: &PgPool, email: &str, user_id: i32) -> Result<bool, Error> {
    sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM users WHERE email = $1 AND id <> $2)")
        .bind(email)
        .bind(user_id)
        .fetch_one(pool)
        .await
}

/// Python `_check_plants`: which of `ids` are in the Growatt registry (`growatt_plants`).
pub async fn known_plant_ids(pool: &PgPool, ids: &[i64]) -> Result<Vec<i64>, Error> {
    sqlx::query_scalar("SELECT plant_id::int8 FROM growatt_plants WHERE plant_id = ANY($1)")
        .bind(ids)
        .fetch_all(pool)
        .await
}

/// The new row of Python `create_user` (`is_active` true, `created_at` now, as `_utcnow`).
pub struct NewUser<'a> {
    pub username: &'a str,
    pub email: &'a str,
    pub full_name: &'a str,
    pub hashed_password: &'a str,
    pub role: &'a str,
    pub store_keeper: bool,
}

pub async fn insert_user(conn: &mut PgConnection, u: &NewUser<'_>) -> Result<User, Error> {
    sqlx::query_as::<_, User>(&format!(
        "INSERT INTO users (username, email, full_name, hashed_password, role, is_active, store_keeper, created_at) \
         VALUES ($1, $2, $3, $4, $5, true, $6, now()) RETURNING {USER_COLS}"
    ))
    .bind(u.username)
    .bind(u.email)
    .bind(u.full_name)
    .bind(u.hashed_password)
    .bind(u.role)
    .bind(u.store_keeper)
    .fetch_one(conn)
    .await
}

/// Write back the fields Python `update_user` may change.
pub async fn save_user(conn: &mut PgConnection, u: &User) -> Result<(), Error> {
    sqlx::query(
        "UPDATE users SET email = $2, full_name = $3, hashed_password = $4, role = $5, is_active = $6, \
         store_keeper = $7 WHERE id = $1",
    )
    .bind(u.id)
    .bind(&u.email)
    .bind(&u.full_name)
    .bind(&u.hashed_password)
    .bind(&u.role)
    .bind(u.is_active)
    .bind(u.store_keeper)
    .execute(conn)
    .await
    .map(|_| ())
}

pub async fn delete_assignments(conn: &mut PgConnection, user_id: i32) -> Result<(), Error> {
    sqlx::query("DELETE FROM user_plant_assignments WHERE user_id = $1")
        .bind(user_id)
        .execute(conn)
        .await
        .map(|_| ())
}

/// Python `_replace_assignments`: drop the user's rows, then (engineers only) add `plant_ids`.
/// The ids are known registry plants (`known_plant_ids`), so they fit the int4 column.
pub async fn replace_assignments(
    conn: &mut PgConnection,
    user: &User,
    plant_ids: &[i64],
    by: &str,
) -> Result<(), Error> {
    delete_assignments(&mut *conn, user.id).await?;
    if user.is_admin() || plant_ids.is_empty() {
        return Ok(());
    }
    // assigned_by is String(64); Python would fail the insert on a longer name, which a login name can't be
    sqlx::query(
        "INSERT INTO user_plant_assignments (user_id, plant_id, assigned_by, created_at) \
         SELECT $1, p::int4, $3, now() FROM unnest($2::int8[]) AS p",
    )
    .bind(user.id)
    .bind(plant_ids)
    .bind(by)
    .execute(conn)
    .await
    .map(|_| ())
}
