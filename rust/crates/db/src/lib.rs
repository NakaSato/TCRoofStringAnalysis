//! Postgres access for the Rust API. The schema is owned by Python: `ensure_schema`
//! (backend/app/db/session.py) creates and extends it on API / worker start, and Alembic keeps the
//! Postgres migrations. Nothing here creates or alters a table.
//!
//! Queries use sqlx's runtime API for now; they move to the compile-time checked macros once the
//! schema script (rust/scripts/schema.sh) also runs `cargo sqlx prepare`.

use chrono::{DateTime, Utc};
use sqlx::postgres::PgPoolOptions;

pub mod logs;
pub mod users;

pub use sqlx::Error;
pub type PgPool = sqlx::postgres::PgPool;

/// The Python URL form (`postgresql+psycopg://…`) is accepted as is; SQLite is refused, because the
/// Rust backend speaks Postgres only (plan §6).
pub fn normalize_url(url: &str) -> Result<String, String> {
    let url = url.trim();
    if url.starts_with("sqlite") {
        return Err("DATABASE_URL is SQLite; the Rust API needs Postgres 16 (set DATABASE_URL to a postgresql:// URL)".into());
    }
    for prefix in ["postgresql+psycopg://", "postgresql+psycopg2://", "postgresql://", "postgres://"] {
        if let Some(rest) = url.strip_prefix(prefix) {
            return Ok(format!("postgres://{rest}"));
        }
    }
    Err(format!("DATABASE_URL must be a Postgres URL, got scheme {:?}", url.split("://").next().unwrap_or("")))
}

pub async fn connect(url: &str, max_connections: u32) -> Result<PgPool, String> {
    let url = normalize_url(url)?;
    PgPoolOptions::new()
        .max_connections(max_connections)
        .acquire_timeout(std::time::Duration::from_secs(10))
        .connect_lazy(&url)
        .map_err(|e| format!("bad DATABASE_URL: {e}"))
}

/// A row of `users` (backend/app/db/models/users.py `User`).
#[derive(Debug, Clone, sqlx::FromRow)]
pub struct User {
    pub id: i32,
    pub username: Option<String>,
    pub email: String,
    pub full_name: String,
    pub hashed_password: String,
    pub role: String,
    pub is_active: bool,
    pub store_keeper: bool,
}

impl User {
    pub fn is_admin(&self) -> bool {
        self.role == "admin"
    }
}

pub(crate) const USER_COLS: &str = "id, username, email, full_name, hashed_password, role, is_active, store_keeper";

/// Login lookup: the identifier matches the username or the email (Python `routes/auth.py`).
pub async fn user_by_login(pool: &PgPool, ident: &str) -> Result<Option<User>, Error> {
    sqlx::query_as::<_, User>(&format!("SELECT {USER_COLS} FROM users WHERE username = $1 OR email = $1 LIMIT 1"))
        .bind(ident)
        .fetch_optional(pool)
        .await
}

pub async fn user_by_id(pool: &PgPool, id: i32) -> Result<Option<User>, Error> {
    sqlx::query_as::<_, User>(&format!("SELECT {USER_COLS} FROM users WHERE id = $1"))
        .bind(id)
        .fetch_optional(pool)
        .await
}

/// The plants assigned to a user, sorted (an admin has none and sees every plant).
pub async fn assigned_plant_ids(pool: &PgPool, user_id: i32) -> Result<Vec<i32>, Error> {
    sqlx::query_scalar::<_, i32>("SELECT plant_id FROM user_plant_assignments WHERE user_id = $1 ORDER BY plant_id")
        .bind(user_id)
        .fetch_all(pool)
        .await
}

/// `finished_at` of the newest `history` run that ended ok / partial (Python `jobs.worker_health`).
pub async fn last_history_finished(pool: &PgPool) -> Result<Option<DateTime<Utc>>, Error> {
    sqlx::query_scalar::<_, DateTime<Utc>>(
        "SELECT finished_at FROM sync_runs WHERE job = 'history' AND status IN ('ok', 'partial') \
         AND finished_at IS NOT NULL ORDER BY finished_at DESC LIMIT 1",
    )
    .fetch_optional(pool)
    .await
}

#[cfg(test)]
mod tests {
    use super::normalize_url;

    #[test]
    fn python_urls_become_sqlx_urls() {
        assert_eq!(normalize_url("postgresql+psycopg://u:p@h:5432/d").unwrap(), "postgres://u:p@h:5432/d");
        assert_eq!(normalize_url("postgres://u@h/d").unwrap(), "postgres://u@h/d");
        assert!(normalize_url("sqlite:///data/solar_fullstack.db").unwrap_err().contains("Postgres"));
        assert!(normalize_url("mysql://x").is_err());
    }
}
