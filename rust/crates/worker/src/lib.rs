//! Rust worker (Phase 4 of docs/plans/rust-port-master-plan.md): backend/app/worker.py (schedule,
//! tick, main loop) and backend/app/services/jobs.py (the job table, the run log / lock in
//! `sync_runs`, the per-account runner). Not deployed: the Python worker stays the only worker
//! running against production until every job is ported (plan §5, Phase 4 note).
//!
//! - [`runs`]: `claim`, `enqueue`, `claim_queued`, `fail_abandoned`, `execute`, `run_job`,
//!   `last_run`, `last_started` (Python `jobs.py`, "run log / lock").
//! - [`jobs`]: the 25 job names of Python `JOBS` and their bodies; a job not ported yet fails its
//!   run with a "not ported to Rust yet" error naming the phase it belongs to, never `ok`.
//! - [`phases`]: Python `_per_phase` (one Growatt account per project phase).
//! - [`schedule`]: Python `Schedule`, `default_schedule`, `_bootstrap_due`, `tick`.

pub mod config;
pub mod jobs;
pub mod phases;
pub mod runs;
pub mod schedule;

use std::sync::Arc;

use chrono::{DateTime, FixedOffset, NaiveDate, Utc};
use tcroof_api::Settings;
use tcroof_db::PgPool;

pub use config::WorkerSettings;

/// Python `jobs.PLANT_TZ` (Asia/Bangkok: UTC+7 all year, no daylight saving)
pub fn plant_tz() -> FixedOffset {
    FixedOffset::east_opt(7 * 3600).expect("valid offset")
}

/// Plant-local now (Python `datetime.now(PLANT_TZ)`).
pub fn plant_now() -> DateTime<FixedOffset> {
    Utc::now().with_timezone(&plant_tz())
}

/// Python `jobs._today()`: the plant-local date.
pub fn today() -> NaiveDate {
    plant_now().date_naive()
}

/// What every job body gets (Python passes a `Session`; here the pool and both settings).
#[derive(Clone)]
pub struct Ctx {
    pub pool: PgPool,
    pub settings: Arc<Settings>,
    pub worker: Arc<WorkerSettings>,
}

/// A job's failure as Python records it in `sync_runs.error`: `"{exception class}: {message}"`.
#[derive(Debug, Clone, thiserror::Error)]
#[error("{kind}: {message}")]
pub struct JobError {
    pub kind: String,
    pub message: String,
    /// stored as the failed run's `detail_json` (Python leaves it null; only "not ported" sets it)
    pub detail: Option<serde_json::Value>,
}

impl JobError {
    pub fn new(kind: &str, message: impl Into<String>) -> JobError {
        JobError { kind: kind.to_owned(), message: message.into(), detail: None }
    }
}

impl From<sqlx::Error> for JobError {
    fn from(e: sqlx::Error) -> Self {
        JobError::new("DatabaseError", e.to_string())
    }
}

impl From<tcroof_services::retention::RetentionError> for JobError {
    fn from(e: tcroof_services::retention::RetentionError) -> Self {
        JobError::new(e.kind(), e.to_string())
    }
}

impl From<tcroof_services::common::ServiceError> for JobError {
    fn from(e: tcroof_services::common::ServiceError) -> Self {
        use tcroof_services::common::ServiceError as S;
        match e {
            S::NotFound(m) => JobError::new("LookupError", m),
            S::Invalid(m) => JobError::new("ValueError", m),
            S::Db(e) => e.into(),
        }
    }
}
