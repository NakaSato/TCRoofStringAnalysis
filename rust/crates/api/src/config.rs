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

    // Summary sink publishing after a settings save (services/daily_summary.py; fleet_config routes)
    pub publish_sink: String,
    pub publish_daily_write_budget: i64,
    pub firebase_credentials_file: String,
    pub firebase_project_id: String,
    /// Rust only, not an environment variable: Python's `config.DATA_DIR` (the JSON sink writes
    /// `firestore_export/` under it); tests point it at a temporary folder
    pub data_dir: std::path::PathBuf,

    // Google Maps Weather, stored day (services/google_weather.py)
    pub google_weather_cell_deg: f64,
    pub google_weather_day_start_h: i64,
    pub google_weather_day_end_h: i64,

    // Weather Sensors / Active Alarm / device checks (routes/growatt/devices.rs)
    pub sensor_alarm_coverage_pct: f64,
    pub worker_alarms_tick_min: i64,
    pub worker_alarms_start_h: i64,
    pub worker_alarms_end_h: i64,
    pub meter_history_enabled: bool,

    // Growatt live (services/growatt_live, services/live.rs): memory / Redis only, never stored
    pub growatt_base_url: String,
    pub growatt_blocked_plant_ids: String,
    pub growatt_live_ttl_s: i64,
    pub growatt_live_night_ttl_s: i64,
    pub growatt_live_device_gap_s: i64,
    pub growatt_live_latest_ttl_s: i64,
    pub sensor_status_ttl_s: i64,
    pub sensor_sweep_per_request: i64,
    pub plant_today_ttl_s: i64,
    pub plant_today_sweep_per_request: i64,
    pub inverter_snapshot_ttl_s: i64,
    pub inverter_snapshot_sweep_per_request: i64,
    // Weather sensor live status (growatt_sensors.live_status): minutes / days since the last upload
    pub sensor_late_min: i64,
    pub sensor_offline_min: i64,
    /// Python float; 0 = off
    pub sensor_inactive_days: f64,

    // Live weather / rain (services/google_weather_live.rs, longdo.rs, rainviewer.rs): memory /
    // Redis only, never stored; only the call counts go to SQL
    pub google_weather_base_url: String,
    pub google_weather_live_ttl_s: i64,
    pub google_weather_monthly_budget: i64,
    pub longdo_base_url: String,
    pub longdo_monthly_budget: i64,
    pub longdo_timeout_s: f64,
    pub longdo_calls_per_min: i64,
    pub longdo_interactive_reserve_per_min: i64,
    pub longdo_radar_ttl_s: i64,
    pub longdo_rain_ttl_s: i64,
    pub longdo_area_radius_km: f64,
    pub longdo_fleet_rain_ttl_s: i64,
    pub longdo_rain_sweep_per_request: i64,
    pub rainviewer_enabled: bool,
    pub rainviewer_url: String,
    pub rainviewer_ttl_s: i64,
    pub rainviewer_timeout_s: f64,
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
            publish_sink: "json".into(),
            publish_daily_write_budget: 15000,
            firebase_credentials_file: String::new(),
            firebase_project_id: String::new(),
            data_dir: tcroof_services::publish::default_data_dir(),
            google_weather_cell_deg: 0.01,
            google_weather_day_start_h: 6,
            google_weather_day_end_h: 18,
            sensor_alarm_coverage_pct: 80.0,
            worker_alarms_tick_min: 10,
            worker_alarms_start_h: 5,
            worker_alarms_end_h: 20,
            meter_history_enabled: true,
            growatt_base_url: tcroof_clients::growatt::DEFAULT_BASE_URL.into(),
            growatt_blocked_plant_ids: String::new(),
            growatt_live_ttl_s: 120,
            growatt_live_night_ttl_s: 1800,
            growatt_live_device_gap_s: 270,
            growatt_live_latest_ttl_s: 300,
            sensor_status_ttl_s: 300,
            sensor_sweep_per_request: 12,
            plant_today_ttl_s: 300,
            plant_today_sweep_per_request: 40,
            inverter_snapshot_ttl_s: 300,
            inverter_snapshot_sweep_per_request: 4,
            sensor_late_min: 15,
            sensor_offline_min: 60,
            sensor_inactive_days: 30.0,
            google_weather_base_url: tcroof_clients::google_weather::DEFAULT_BASE_URL.into(),
            google_weather_live_ttl_s: 1800,
            google_weather_monthly_budget: 30000,
            longdo_base_url: tcroof_clients::longdo_weather::DEFAULT_BASE_URL.into(),
            longdo_monthly_budget: 60000,
            longdo_timeout_s: 6.0,
            longdo_calls_per_min: 30,
            longdo_interactive_reserve_per_min: 8,
            longdo_radar_ttl_s: 300,
            longdo_rain_ttl_s: 300,
            longdo_area_radius_km: 10.0,
            longdo_fleet_rain_ttl_s: 1800,
            longdo_rain_sweep_per_request: 20,
            rainviewer_enabled: true,
            rainviewer_url: tcroof_clients::rainviewer::DEFAULT_URL.into(),
            rainviewer_ttl_s: 300,
            rainviewer_timeout_s: 6.0,
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
    /// Python `Settings.growatt_accounts`: configured Growatt accounts as {phase: token}, ascending,
    /// empty tokens skipped (`GROWATT_API_TOKEN` is phase 1 when `GROWATT_TOKEN_PHASE1` is empty).
    pub fn growatt_accounts(&self) -> std::collections::BTreeMap<i32, String> {
        let p1 = if self.growatt_token_phase1.is_empty() { &self.growatt_api_token } else { &self.growatt_token_phase1 };
        [(1, p1), (2, &self.growatt_token_phase2), (3, &self.growatt_token_phase3), (4, &self.growatt_token_phase4)]
            .into_iter()
            .filter(|(_, t)| !t.trim().is_empty())
            .map(|(p, t)| (p, t.trim().to_owned()))
            .collect()
    }

    /// Python `Settings.blocked_plant_ids`: `GROWATT_BLOCKED_PLANT_IDS` as plant ids (`,` or `;`);
    /// anything that is not a number is ignored.
    pub fn blocked_plant_ids(&self) -> Vec<i64> {
        self.growatt_blocked_plant_ids
            .replace(';', ",")
            .split(',')
            .map(str::trim)
            .filter(|p| !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit()))
            .filter_map(|p| p.parse().ok())
            .collect()
    }

    /// Python `get_live_service` keyword arguments.
    pub fn live_config(&self) -> tcroof_services::live::LiveConfig {
        tcroof_services::live::LiveConfig {
            ttl_s: self.growatt_live_ttl_s as f64,
            latest_ttl_s: self.growatt_live_latest_ttl_s as f64,
            cooldown_s: tcroof_services::live::COOLDOWN_S,
            night_ttl_s: self.growatt_live_night_ttl_s as f64,
            device_gap_s: self.growatt_live_device_gap_s as f64,
            sensor_ttl_s: self.sensor_status_ttl_s as f64,
            sensor_sweep: self.sensor_sweep_per_request.max(1) as usize,
            plant_today_ttl_s: self.plant_today_ttl_s as f64,
            plant_today_sweep: self.plant_today_sweep_per_request.max(1) as usize,
            snapshot_ttl_s: self.inverter_snapshot_ttl_s as f64,
            snapshot_sweep: self.inverter_snapshot_sweep_per_request.max(1) as usize,
        }
    }

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
            publish_sink: get("PUBLISH_SINK").unwrap_or(d.publish_sink),
            publish_daily_write_budget: int("PUBLISH_DAILY_WRITE_BUDGET")?.unwrap_or(d.publish_daily_write_budget),
            firebase_credentials_file: get("FIREBASE_CREDENTIALS_FILE").unwrap_or_default(),
            firebase_project_id: get("FIREBASE_PROJECT_ID").unwrap_or_default(),
            data_dir: d.data_dir,
            google_weather_cell_deg: num("GOOGLE_WEATHER_CELL_DEG")?.unwrap_or(d.google_weather_cell_deg),
            google_weather_day_start_h: int("GOOGLE_WEATHER_DAY_START_H")?.unwrap_or(d.google_weather_day_start_h),
            google_weather_day_end_h: int("GOOGLE_WEATHER_DAY_END_H")?.unwrap_or(d.google_weather_day_end_h),
            sensor_alarm_coverage_pct: num("SENSOR_ALARM_COVERAGE_PCT")?.unwrap_or(d.sensor_alarm_coverage_pct),
            worker_alarms_tick_min: int("WORKER_ALARMS_TICK_MIN")?.unwrap_or(d.worker_alarms_tick_min),
            worker_alarms_start_h: int("WORKER_ALARMS_START_H")?.unwrap_or(d.worker_alarms_start_h),
            worker_alarms_end_h: int("WORKER_ALARMS_END_H")?.unwrap_or(d.worker_alarms_end_h),
            meter_history_enabled: match get("METER_HISTORY_ENABLED") {
                Some(v) => parse_bool(&v).ok_or_else(|| anyhow::anyhow!("METER_HISTORY_ENABLED: not a boolean: {v:?}"))?,
                None => d.meter_history_enabled,
            },
            growatt_base_url: get("GROWATT_BASE_URL").unwrap_or(d.growatt_base_url),
            growatt_blocked_plant_ids: get("GROWATT_BLOCKED_PLANT_IDS").unwrap_or_default(),
            growatt_live_ttl_s: int("GROWATT_LIVE_TTL_S")?.unwrap_or(d.growatt_live_ttl_s),
            growatt_live_night_ttl_s: int("GROWATT_LIVE_NIGHT_TTL_S")?.unwrap_or(d.growatt_live_night_ttl_s),
            growatt_live_device_gap_s: int("GROWATT_LIVE_DEVICE_GAP_S")?.unwrap_or(d.growatt_live_device_gap_s),
            growatt_live_latest_ttl_s: int("GROWATT_LIVE_LATEST_TTL_S")?.unwrap_or(d.growatt_live_latest_ttl_s),
            sensor_status_ttl_s: int("SENSOR_STATUS_TTL_S")?.unwrap_or(d.sensor_status_ttl_s),
            sensor_sweep_per_request: int("SENSOR_SWEEP_PER_REQUEST")?.unwrap_or(d.sensor_sweep_per_request),
            plant_today_ttl_s: int("PLANT_TODAY_TTL_S")?.unwrap_or(d.plant_today_ttl_s),
            plant_today_sweep_per_request: int("PLANT_TODAY_SWEEP_PER_REQUEST")?.unwrap_or(d.plant_today_sweep_per_request),
            inverter_snapshot_ttl_s: int("INVERTER_SNAPSHOT_TTL_S")?.unwrap_or(d.inverter_snapshot_ttl_s),
            inverter_snapshot_sweep_per_request: int("INVERTER_SNAPSHOT_SWEEP_PER_REQUEST")?.unwrap_or(d.inverter_snapshot_sweep_per_request),
            sensor_late_min: int("SENSOR_LATE_MIN")?.unwrap_or(d.sensor_late_min),
            sensor_offline_min: int("SENSOR_OFFLINE_MIN")?.unwrap_or(d.sensor_offline_min),
            sensor_inactive_days: num("SENSOR_INACTIVE_DAYS")?.unwrap_or(d.sensor_inactive_days),
            google_weather_base_url: get("GOOGLE_WEATHER_BASE_URL").unwrap_or(d.google_weather_base_url),
            google_weather_live_ttl_s: int("GOOGLE_WEATHER_LIVE_TTL_S")?.unwrap_or(d.google_weather_live_ttl_s),
            google_weather_monthly_budget: int("GOOGLE_WEATHER_MONTHLY_BUDGET")?.unwrap_or(d.google_weather_monthly_budget),
            longdo_base_url: get("LONGDO_BASE_URL").unwrap_or(d.longdo_base_url),
            longdo_monthly_budget: int("LONGDO_MONTHLY_BUDGET")?.unwrap_or(d.longdo_monthly_budget),
            longdo_timeout_s: num("LONGDO_TIMEOUT_S")?.unwrap_or(d.longdo_timeout_s),
            longdo_calls_per_min: int("LONGDO_CALLS_PER_MIN")?.unwrap_or(d.longdo_calls_per_min),
            longdo_interactive_reserve_per_min: int("LONGDO_INTERACTIVE_RESERVE_PER_MIN")?.unwrap_or(d.longdo_interactive_reserve_per_min),
            longdo_radar_ttl_s: int("LONGDO_RADAR_TTL_S")?.unwrap_or(d.longdo_radar_ttl_s),
            longdo_rain_ttl_s: int("LONGDO_RAIN_TTL_S")?.unwrap_or(d.longdo_rain_ttl_s),
            longdo_area_radius_km: num("LONGDO_AREA_RADIUS_KM")?.unwrap_or(d.longdo_area_radius_km),
            longdo_fleet_rain_ttl_s: int("LONGDO_FLEET_RAIN_TTL_S")?.unwrap_or(d.longdo_fleet_rain_ttl_s),
            longdo_rain_sweep_per_request: int("LONGDO_RAIN_SWEEP_PER_REQUEST")?.unwrap_or(d.longdo_rain_sweep_per_request),
            rainviewer_enabled: match get("RAINVIEWER_ENABLED") {
                Some(v) => parse_bool(&v).ok_or_else(|| anyhow::anyhow!("RAINVIEWER_ENABLED: not a boolean: {v:?}"))?,
                None => d.rainviewer_enabled,
            },
            rainviewer_url: get("RAINVIEWER_URL").unwrap_or(d.rainviewer_url),
            rainviewer_ttl_s: int("RAINVIEWER_TTL_S")?.unwrap_or(d.rainviewer_ttl_s),
            rainviewer_timeout_s: num("RAINVIEWER_TIMEOUT_S")?.unwrap_or(d.rainviewer_timeout_s),
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

/// The live weather / rain services' settings (Python `get_google_live`, `get_longdo_live`,
/// `get_rainviewer_live` read them from `settings`).
impl Settings {
    /// Python `google_weather.window()` and the cell size (shared with the stored day)
    pub fn google_cells(&self) -> tcroof_services::google_weather_stored::GoogleWeatherConfig {
        tcroof_services::google_weather_stored::GoogleWeatherConfig {
            configured: !self.google_weather_api_key.is_empty(),
            cell_deg: self.google_weather_cell_deg,
            day_start_h: self.google_weather_day_start_h,
            day_end_h: self.google_weather_day_end_h,
        }
    }

    pub fn google_live_config(&self) -> tcroof_services::google_weather_live::GoogleLiveConfig {
        tcroof_services::google_weather_live::GoogleLiveConfig {
            api_key: self.google_weather_api_key.clone(),
            base_url: self.google_weather_base_url.clone(),
            ttl_s: self.google_weather_live_ttl_s as f64,
            monthly_budget: self.google_weather_monthly_budget,
            cells: self.google_cells(),
        }
    }

    pub fn longdo_config(&self) -> tcroof_services::longdo::LongdoConfig {
        tcroof_services::longdo::LongdoConfig {
            api_key: self.longdo_api_key.clone(),
            base_url: self.longdo_base_url.clone(),
            timeout_s: self.longdo_timeout_s,
            monthly_budget: self.longdo_monthly_budget,
            calls_per_min: self.longdo_calls_per_min,
            interactive_reserve_per_min: self.longdo_interactive_reserve_per_min,
            radar_ttl_s: self.longdo_radar_ttl_s as f64,
            rain_ttl_s: self.longdo_rain_ttl_s as f64,
            area_radius_km: self.longdo_area_radius_km,
            fleet_rain_ttl_s: self.longdo_fleet_rain_ttl_s as f64,
            rain_sweep_per_request: self.longdo_rain_sweep_per_request,
            cells: self.google_cells(),
        }
    }

    pub fn rainviewer_config(&self) -> tcroof_services::rainviewer::RainViewerConfig {
        tcroof_services::rainviewer::RainViewerConfig {
            enabled: self.rainviewer_enabled,
            url: self.rainviewer_url.clone(),
            ttl_s: self.rainviewer_ttl_s as f64,
            timeout_s: self.rainviewer_timeout_s,
        }
    }
}
