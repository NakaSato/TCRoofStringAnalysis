//! The API side of the worker's run log (`sync_runs`), ported from backend/app/services/jobs.py:
//! the job names (`JOBS`), `run_out`, and `enqueue` (a `queued` row the worker's `claim_queued`
//! turns into a run on its next tick). The API never runs a job itself.

use chrono::{DateTime, Duration, Utc};
use serde_json::{json, Value};
use sqlx::PgPool;

use crate::common::{isoformat_utc, Result};

/// Python `jobs.JOBS` keys, in their order (the worker's job table).
pub const JOBS: [&str; 25] = [
    "history",
    "env_history",
    "inverter_latest",
    "backfill",
    "fleet",
    "power_limits",
    "growatt_energy",
    "energy_backfill",
    "publish_today",
    "publish_yesterday",
    "retention",
    "google_weather",
    "alarms",
    "alarms_yesterday",
    "push_test",
    "faults_push",
    "pwa_sheet",
    "rules_today",
    "rules_yesterday",
    "rules_backfill",
    "epi_refit",
    "om_plans",
    "om_reminders",
    "om_weekly",
    "kb_ocr",
];

/// Python `jobs.STALE_AFTER`: a `running` / `queued` row older than this is treated as crashed.
pub const STALE_AFTER_H: i64 = 2;

/// A row of `sync_runs` (Python `SyncRun`).
#[derive(Debug, Clone, sqlx::FromRow)]
pub struct SyncRun {
    pub id: i32,
    pub job: String,
    pub trigger: String,
    pub status: String,
    pub started_at: DateTime<Utc>,
    pub finished_at: Option<DateTime<Utc>>,
    pub detail_json: Option<Value>,
    pub error: Option<String>,
}

const RUN_COLS: &str = "id, job, trigger, status, started_at, finished_at, detail_json, error";

/// Python `jobs.run_out`
pub fn run_out(run: &SyncRun) -> Value {
    json!({
        "id": run.id,
        "job": run.job,
        "trigger": run.trigger,
        "status": run.status,
        "started_at": isoformat_utc(run.started_at),
        "finished_at": run.finished_at.map(isoformat_utc),
        "detail": run.detail_json,
        "error": run.error,
    })
}

/// Python `routes/growatt/sync.sync_status`: the latest run per job (null when none) plus the
/// `limit` most recent runs (`{"jobs": {...}, "recent": [...]}`).
pub async fn status(pool: &PgPool, limit: i64) -> Result<Value> {
    let mut latest = serde_json::Map::new();
    for job in JOBS {
        let run = sqlx::query_as::<_, SyncRun>(&format!(
            "SELECT {RUN_COLS} FROM sync_runs WHERE job = $1 ORDER BY started_at DESC LIMIT 1"
        ))
        .bind(job)
        .fetch_optional(pool)
        .await?;
        latest.insert(job.to_owned(), run.as_ref().map(run_out).unwrap_or(Value::Null));
    }
    let recent = sqlx::query_as::<_, SyncRun>(&format!("SELECT {RUN_COLS} FROM sync_runs ORDER BY started_at DESC LIMIT $1"))
        .bind(limit)
        .fetch_all(pool)
        .await?;
    Ok(json!({"jobs": latest, "recent": recent.iter().map(run_out).collect::<Vec<_>>()}))
}

/// Outcome of [`enqueue`] besides a database error.
#[derive(Debug)]
pub enum Enqueue {
    /// the new run's id
    Queued(i32),
    /// Python `jobs.JobBusy`: the job is already running or queued (the message as Python words it)
    Busy(String),
}

/// Python `jobs.enqueue` (with `_check_free` / `_fail_stale`): a `queued` run (`started_at` = when
/// it was requested, UTC), unless a live `running` / `queued` run of the job exists. Stale ones
/// (older than `STALE_AFTER`) are failed in the same transaction; on busy nothing is written (the
/// Python route raises before its commit). The caller checks the job name against [`JOBS`].
pub async fn enqueue(pool: &PgPool, job: &str, trigger: &str) -> Result<Enqueue> {
    let now = Utc::now();
    let mut tx = pool.begin().await?;
    let runs = sqlx::query_as::<_, SyncRun>(&format!(
        "SELECT {RUN_COLS} FROM sync_runs WHERE job = $1 AND status IN ('running', 'queued')"
    ))
    .bind(job)
    .fetch_all(&mut *tx)
    .await?;
    for run in &runs {
        if now - run.started_at < Duration::hours(STALE_AFTER_H) {
            tx.rollback().await?;
            return Ok(Enqueue::Busy(format!(
                "{job} is already {} (run {}, since {})",
                run.status,
                run.id,
                run.started_at.format("%Y-%m-%d %H:%M")
            )));
        }
        // Python `_fail_stale`
        let error = if run.status == "running" { "abandoned (worker stopped mid-run)" } else { "never picked up (is the worker running?)" };
        sqlx::query("UPDATE sync_runs SET status = 'failed', finished_at = $2, error = $3 WHERE id = $1")
            .bind(run.id)
            .bind(now)
            .bind(error)
            .execute(&mut *tx)
            .await?;
    }
    let id: i32 = sqlx::query_scalar(
        "INSERT INTO sync_runs (job, trigger, status, started_at) VALUES ($1, $2, 'queued', $3) RETURNING id",
    )
    .bind(job)
    .bind(trigger)
    .bind(now)
    .fetch_one(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(Enqueue::Queued(id))
}
