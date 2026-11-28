//! The worker's own settings: the keys of backend/app/config.py that only the worker reads, with
//! Python's defaults. Everything shared with the API (DATABASE_URL, Growatt tokens, log settings,
//! publish sink, …) comes from [`tcroof_api::Settings`], read from the same environment.
//! An empty variable counts as unset (the default applies), as in the API's settings.

use std::env;

use tcroof_api::config::parse_bool;

#[derive(Debug, Clone)]
pub struct WorkerSettings {
    pub worker_history_interval_min: i64,
    pub worker_history_batch_size: i64,
    pub worker_alarms_tick_min: i64,
    pub worker_alarms_hot_min: i64,
    pub worker_alarms_warm_min: i64,
    pub worker_alarms_cold_min: i64,
    pub worker_alarms_start_h: i64,
    pub worker_alarms_end_h: i64,
    pub worker_env_interval_min: i64,
    pub worker_env_start_h: i64,
    pub worker_env_end_h: i64,
    pub worker_latest_interval_min: i64,
    pub worker_latest_start_h: i64,
    pub worker_latest_end_h: i64,
    pub worker_kb_ocr_interval_min: i64,
    pub worker_parallel_accounts: bool,
    pub history_retention_days: i64,
    pub history_string_retention_days: i64,
    pub history_raw_retention_days: i64,
    pub log_max_rows: i64,
    pub check_offset_min: i64,
    pub pwa_history_lead_min: i64,
    pub pwa_fault_lookback_min: i64,
    /// `PWA_IGNORE_WARN_CODES` as written ("1"); parsed by `check_slots::parse_warn_codes`
    pub pwa_ignore_warn_codes: String,
    /// `PWA_SHEET_ID` (empty = no PWA Report sheet fill)
    pub pwa_sheet_id: String,
}

impl Default for WorkerSettings {
    /// Python's defaults (backend/app/config.py `Settings`).
    fn default() -> Self {
        WorkerSettings {
            worker_history_interval_min: 10,
            worker_history_batch_size: 0,
            worker_alarms_tick_min: 10,
            worker_alarms_hot_min: 10,
            worker_alarms_warm_min: 30,
            worker_alarms_cold_min: 60,
            worker_alarms_start_h: 5,
            worker_alarms_end_h: 20,
            worker_env_interval_min: 10,
            worker_env_start_h: 5,
            worker_env_end_h: 20,
            worker_latest_interval_min: 0,
            worker_latest_start_h: 5,
            worker_latest_end_h: 20,
            worker_kb_ocr_interval_min: 30,
            worker_parallel_accounts: true,
            history_retention_days: 90,
            history_string_retention_days: 30,
            history_raw_retention_days: 7,
            log_max_rows: 500_000,
            check_offset_min: 10,
            pwa_history_lead_min: 3,
            pwa_fault_lookback_min: 60,
            pwa_ignore_warn_codes: "1".into(),
            pwa_sheet_id: String::new(),
        }
    }
}

impl WorkerSettings {
    pub fn from_env() -> anyhow::Result<Self> {
        let get = |k: &str| env::var(k).ok().filter(|v| !v.trim().is_empty());
        let int = |k: &str, d: i64| -> anyhow::Result<i64> {
            get(k).map(|v| v.trim().parse::<i64>().map_err(|e| anyhow::anyhow!("{k}: {e}"))).transpose().map(|v| v.unwrap_or(d))
        };
        let d = WorkerSettings::default();
        Ok(WorkerSettings {
            worker_history_interval_min: int("WORKER_HISTORY_INTERVAL_MIN", d.worker_history_interval_min)?,
            worker_history_batch_size: int("WORKER_HISTORY_BATCH_SIZE", d.worker_history_batch_size)?,
            worker_alarms_tick_min: int("WORKER_ALARMS_TICK_MIN", d.worker_alarms_tick_min)?,
            worker_alarms_hot_min: int("WORKER_ALARMS_HOT_MIN", d.worker_alarms_hot_min)?,
            worker_alarms_warm_min: int("WORKER_ALARMS_WARM_MIN", d.worker_alarms_warm_min)?,
            worker_alarms_cold_min: int("WORKER_ALARMS_COLD_MIN", d.worker_alarms_cold_min)?,
            worker_alarms_start_h: int("WORKER_ALARMS_START_H", d.worker_alarms_start_h)?,
            worker_alarms_end_h: int("WORKER_ALARMS_END_H", d.worker_alarms_end_h)?,
            worker_env_interval_min: int("WORKER_ENV_INTERVAL_MIN", d.worker_env_interval_min)?,
            worker_env_start_h: int("WORKER_ENV_START_H", d.worker_env_start_h)?,
            worker_env_end_h: int("WORKER_ENV_END_H", d.worker_env_end_h)?,
            worker_latest_interval_min: int("WORKER_LATEST_INTERVAL_MIN", d.worker_latest_interval_min)?,
            worker_latest_start_h: int("WORKER_LATEST_START_H", d.worker_latest_start_h)?,
            worker_latest_end_h: int("WORKER_LATEST_END_H", d.worker_latest_end_h)?,
            worker_kb_ocr_interval_min: int("WORKER_KB_OCR_INTERVAL_MIN", d.worker_kb_ocr_interval_min)?,
            worker_parallel_accounts: match get("WORKER_PARALLEL_ACCOUNTS") {
                Some(v) => parse_bool(&v).ok_or_else(|| anyhow::anyhow!("WORKER_PARALLEL_ACCOUNTS: not a boolean: {v:?}"))?,
                None => d.worker_parallel_accounts,
            },
            history_retention_days: int("HISTORY_RETENTION_DAYS", d.history_retention_days)?,
            history_string_retention_days: int("HISTORY_STRING_RETENTION_DAYS", d.history_string_retention_days)?,
            history_raw_retention_days: int("HISTORY_RAW_RETENTION_DAYS", d.history_raw_retention_days)?,
            log_max_rows: int("LOG_MAX_ROWS", d.log_max_rows)?,
            check_offset_min: int("CHECK_OFFSET_MIN", d.check_offset_min)?,
            pwa_history_lead_min: int("PWA_HISTORY_LEAD_MIN", d.pwa_history_lead_min)?,
            pwa_fault_lookback_min: int("PWA_FAULT_LOOKBACK_MIN", d.pwa_fault_lookback_min)?,
            // Python reads an empty value as "" (no code ignored), not as the default
            pwa_ignore_warn_codes: env::var("PWA_IGNORE_WARN_CODES").unwrap_or(d.pwa_ignore_warn_codes),
            pwa_sheet_id: get("PWA_SHEET_ID").unwrap_or_default(),
        })
    }
}
