//! Settings read from the same environment variables (and `.env`) as backend/app/config.py.
//! Only the keys the ported routes need are here; each phase adds its own.

use std::env;

pub const APP_NAME: &str = "TC Roof Solar PV String & O&M Engineering API";
pub const APP_VERSION: &str = "1.0.0";
/// The Python default secret; `APP_ENV=prod` refuses it (as Python does).
const DEFAULT_JWT_SECRET: &str = "tc-roof-solar-super-secret-jwt-key-2026-engineering";

#[derive(Debug, Clone)]
pub struct Settings {
    pub app_env: String,
    pub database_url: String,
    pub jwt_secret_key: String,
    pub jwt_algorithm: String,
    pub jwt_expire_minutes: i64,
    pub port: u16,
}

impl Settings {
    pub fn from_env() -> anyhow::Result<Self> {
        let get = |k: &str| env::var(k).ok().filter(|v| !v.trim().is_empty());
        let s = Settings {
            app_env: get("APP_ENV").unwrap_or_else(|| "dev".into()),
            database_url: get("DATABASE_URL").ok_or_else(|| anyhow::anyhow!("DATABASE_URL is not set"))?,
            jwt_secret_key: get("JWT_SECRET_KEY").unwrap_or_else(|| DEFAULT_JWT_SECRET.into()),
            jwt_algorithm: get("JWT_ALGORITHM").unwrap_or_else(|| "HS256".into()),
            jwt_expire_minutes: get("JWT_EXPIRE_MINUTES").map(|v| v.parse()).transpose()?.unwrap_or(60 * 24 * 7),
            // RUST_API_PORT so a shared .env can't move it onto Python's 8000
            port: get("RUST_API_PORT").map(|v| v.parse()).transpose()?.unwrap_or(8001),
        };
        if s.jwt_algorithm != "HS256" {
            anyhow::bail!("JWT_ALGORITHM {:?} is not supported (HS256 only, as in production)", s.jwt_algorithm);
        }
        if s.app_env == "prod" && s.jwt_secret_key == DEFAULT_JWT_SECRET {
            anyhow::bail!("APP_ENV=prod refuses the default JWT_SECRET_KEY");
        }
        Ok(s)
    }
}
