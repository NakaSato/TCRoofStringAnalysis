//! Settings read from the same environment variables (and `.env`) as backend/app/config.py, with
//! the same defaults. Only the keys the ported routes need are here; each phase adds its own.
//! An empty variable counts as unset (the default applies).

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
    /// Rust only: `RUST_API_PORT` (8001), so a shared .env can't move it onto Python's 8000
    pub port: u16,

    // System → Logs (backend/app/logging_db.py, services/system_logs.py, api/request_log.py)
    pub log_db_enabled: bool,
    pub log_db_level: String,
    pub log_retention_days: i64,
    pub log_flush_interval_s: f64,
    pub log_buffer_max: usize,
    pub log_slow_request_ms: i64,

    // Values masked in stored log records (logging_db._secret_values); not otherwise used yet
    pub admin_password: String,
    pub redis_url: String,
    pub growatt_api_token: String,
    pub growatt_token_phase1: String,
    pub growatt_token_phase2: String,
    pub growatt_token_phase3: String,
    pub growatt_token_phase4: String,
    pub google_weather_api_key: String,
    pub report_api_key: String,
    pub ai_api_key: String,
    pub longdo_api_key: String,
    pub geoapify_api_key: String,
}

impl Default for Settings {
    /// Python's defaults (`database_url` has none here: the Rust API speaks Postgres only).
    fn default() -> Self {
        Settings {
            app_env: "dev".into(),
            database_url: String::new(),
            jwt_secret_key: DEFAULT_JWT_SECRET.into(),
            jwt_algorithm: "HS256".into(),
            jwt_expire_minutes: 60 * 24 * 7,
            port: 8001,
            log_db_enabled: true,
            log_db_level: "INFO".into(),
            log_retention_days: 14,
            log_flush_interval_s: 5.0,
            log_buffer_max: 5000,
            log_slow_request_ms: 5000,
            admin_password: String::new(),
            redis_url: String::new(),
            growatt_api_token: String::new(),
            growatt_token_phase1: String::new(),
            growatt_token_phase2: String::new(),
            growatt_token_phase3: String::new(),
            growatt_token_phase4: String::new(),
            google_weather_api_key: String::new(),
            report_api_key: String::new(),
            ai_api_key: String::new(),
            longdo_api_key: String::new(),
            geoapify_api_key: String::new(),
        }
    }
}

/// pydantic's bool parsing of a string (case-insensitive)
pub fn parse_bool(v: &str) -> Option<bool> {
    match v.trim().to_ascii_lowercase().as_str() {
        "1" | "on" | "t" | "true" | "y" | "yes" => Some(true),
        "0" | "off" | "f" | "false" | "n" | "no" => Some(false),
        _ => None,
    }
}

impl Settings {
    pub fn from_env() -> anyhow::Result<Self> {
        let get = |k: &str| env::var(k).ok().filter(|v| !v.trim().is_empty());
        let num = |k: &str| -> anyhow::Result<Option<f64>> {
            get(k).map(|v| v.trim().parse::<f64>().map_err(|e| anyhow::anyhow!("{k}: {e}"))).transpose()
        };
        let int = |k: &str| -> anyhow::Result<Option<i64>> {
            get(k).map(|v| v.trim().parse::<i64>().map_err(|e| anyhow::anyhow!("{k}: {e}"))).transpose()
        };
        let d = Settings::default();
        let s = Settings {
            app_env: get("APP_ENV").unwrap_or(d.app_env),
            database_url: get("DATABASE_URL").ok_or_else(|| anyhow::anyhow!("DATABASE_URL is not set"))?,
            jwt_secret_key: get("JWT_SECRET_KEY").unwrap_or(d.jwt_secret_key),
            jwt_algorithm: get("JWT_ALGORITHM").unwrap_or(d.jwt_algorithm),
            jwt_expire_minutes: int("JWT_EXPIRE_MINUTES")?.unwrap_or(d.jwt_expire_minutes),
            port: get("RUST_API_PORT").map(|v| v.parse()).transpose()?.unwrap_or(d.port),
            log_db_enabled: match get("LOG_DB_ENABLED") {
                Some(v) => parse_bool(&v).ok_or_else(|| anyhow::anyhow!("LOG_DB_ENABLED: not a boolean: {v:?}"))?,
                None => d.log_db_enabled,
            },
            log_db_level: get("LOG_DB_LEVEL").unwrap_or(d.log_db_level),
            log_retention_days: int("LOG_RETENTION_DAYS")?.unwrap_or(d.log_retention_days),
            log_flush_interval_s: num("LOG_FLUSH_INTERVAL_S")?.unwrap_or(d.log_flush_interval_s),
            log_buffer_max: int("LOG_BUFFER_MAX")?.map(|v| v.max(1) as usize).unwrap_or(d.log_buffer_max),
            log_slow_request_ms: int("LOG_SLOW_REQUEST_MS")?.unwrap_or(d.log_slow_request_ms),
            admin_password: get("ADMIN_PASSWORD").unwrap_or_default(),
            redis_url: get("REDIS_URL").unwrap_or_default(),
            growatt_api_token: get("GROWATT_API_TOKEN").unwrap_or_default(),
            growatt_token_phase1: get("GROWATT_TOKEN_PHASE1").unwrap_or_default(),
            growatt_token_phase2: get("GROWATT_TOKEN_PHASE2").unwrap_or_default(),
            growatt_token_phase3: get("GROWATT_TOKEN_PHASE3").unwrap_or_default(),
            growatt_token_phase4: get("GROWATT_TOKEN_PHASE4").unwrap_or_default(),
            google_weather_api_key: get("GOOGLE_WEATHER_API_KEY").unwrap_or_default(),
            report_api_key: get("REPORT_API_KEY").unwrap_or_default(),
            ai_api_key: get("AI_API_KEY").unwrap_or_default(),
            longdo_api_key: get("LONGDO_API_KEY").unwrap_or_default(),
            geoapify_api_key: get("GEOAPIFY_API_KEY").unwrap_or_default(),
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
