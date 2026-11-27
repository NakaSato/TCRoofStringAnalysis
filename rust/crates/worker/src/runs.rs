//! The run log and job lock (`sync_runs`), ported from backend/app/services/jobs.py ("run log /
//! lock"). Each run is a row; while a run is `running` or `queued` (and younger than
//! `STALE_AFTER`), another run of the same job is refused. The API only queues runs
//! (`tcroof_services::sync_status::enqueue`); the worker claims and executes them.
//!
//! Python's session has `autoflush=False`, but the ORM's identity map makes a run changed earlier
//! in the same session look changed to later queries; here every change is an UPDATE inside one
//! transaction, which reads the same.

use chrono::{DateTime, Duration, Utc};
use serde_json::Value;
use sqlx::{PgPool, Postgres, Transaction};
use tcroof_services::sync_status::{SyncRun, JOBS};

use crate::jobs::{self, Job};
use crate::{Ctx, JobError};

/// Python `STALE_AFTER`: a `running` row older than this is treated as crashed
pub fn stale_after() -> Duration {
    Duration::hours(tcroof_services::sync_status::STALE_AFTER_H)
}

/// Python `ABANDONED`
pub const ABANDONED: &str = "abandoned (worker stopped mid-run)";
const NEVER_PICKED_UP: &str = "never picked up (is the worker running?)";
/// Python `RUN_TEXT_MAX`: longest text kept from a job's detail
pub const RUN_TEXT_MAX: usize = 500;
/// The longest error text kept (Python `_clip(..., 2000)` in `execute`)
pub const RUN_ERROR_MAX: usize = 2000;

const RUN_COLS: &str = "id, job, trigger, status, started_at, finished_at, detail_json, error";

/// Why a run could not be claimed or queued.
#[derive(Debug, thiserror::Error)]
pub enum ClaimError {
    /// Python `JobBusy` (the message as Python words it)
    #[error("{0}")]
    Busy(String),
    /// Python `KeyError(job)`: not a job of `JOBS`
    #[error("unknown job {0:?}")]
    UnknownJob(String),
    #[error(transparent)]
    Db(#[from] sqlx::Error),
}

/// Python `_clip`: `s` cut at `limit` characters with a note of how many more there were.
pub fn clip(s: &str, limit: usize) -> String {
    let n = s.chars().count();
    if n <= limit {
        return s.to_owned();
    }
    let head: String = s.chars().take(limit).collect();
    format!("{head}… ({} more characters)", n - limit)
}

/// Python `_jsonable`: every string of a job's detail clipped at `RUN_TEXT_MAX` (keys are strings
/// and dates are ISO text already in a JSON value).
pub fn jsonable(v: Value) -> Value {
    match v {
        Value::Object(m) => Value::Object(m.into_iter().map(|(k, x)| (k, jsonable(x))).collect()),
        Value::Array(a) => Value::Array(a.into_iter().map(jsonable).collect()),
        Value::String(s) => Value::String(clip(&s, RUN_TEXT_MAX)),
        other => other,
    }
}

/// Python `_fail_stale`
async fn fail_stale(tx: &mut Transaction<'_, Postgres>, run: &SyncRun, now: DateTime<Utc>) -> Result<(), sqlx::Error> {
    let error = if run.status == "running" { ABANDONED } else { NEVER_PICKED_UP };
    sqlx::query("UPDATE sync_runs SET status = 'failed', finished_at = $2, error = $3 WHERE id = $1")
        .bind(run.id)
        .bind(now)
        .bind(error)
        .execute(&mut **tx)
        .await?;
    Ok(())
}

/// Python `_check_free`: `Busy` while a live running / queued run of `job` exists (other than
/// `ignore_id`); stale ones are failed in the transaction.
async fn check_free(tx: &mut Transaction<'_, Postgres>, job: &str, now: DateTime<Utc>, ignore_id: Option<i32>) -> Result<(), ClaimError> {
    let runs: Vec<SyncRun> =
        sqlx::query_as(&format!("SELECT {RUN_COLS} FROM sync_runs WHERE job = $1 AND status IN ('running', 'queued') ORDER BY id"))
            .bind(job)
            .fetch_all(&mut **tx)
            .await?;
    for run in &runs {
        if Some(run.id) == ignore_id {
            continue;
        }
        if now - run.started_at < stale_after() {
            return Err(ClaimError::Busy(format!(
                "{job} is already {} (run {}, since {})",
                run.status,
                run.id,
                run.started_at.format("%Y-%m-%d %H:%M")
            )));
        }
        fail_stale(tx, run, now).await?;
    }
    Ok(())
}

/// Python `_utc(now)`: `now` or the current time, in UTC.
fn utc(now: Option<DateTime<Utc>>) -> DateTime<Utc> {
    now.unwrap_or_else(Utc::now)
}

async fn insert(pool: &PgPool, job: &str, trigger: &str, status: &str, now: Option<DateTime<Utc>>) -> Result<i32, ClaimError> {
    if !JOBS.contains(&job) {
        return Err(ClaimError::UnknownJob(job.to_owned()));
    }
    let now = utc(now);
    let mut tx = pool.begin().await?;
    // on Busy the transaction is dropped (rolled back), as Python's session closes uncommitted
    check_free(&mut tx, job, now, None).await?;
    let id: i32 = sqlx::query_scalar("INSERT INTO sync_runs (job, trigger, status, started_at) VALUES ($1, $2, $3, $4) RETURNING id")
        .bind(job)
        .bind(trigger)
        .bind(status)
        .bind(now)
        .fetch_one(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(id)
}

/// Python `claim`: record a new `running` run, or `Busy` if one is already running or queued.
pub async fn claim(pool: &PgPool, job: &str, trigger: &str, now: Option<DateTime<Utc>>) -> Result<i32, ClaimError> {
    insert(pool, job, trigger, "running", now).await
}

/// Python `enqueue`: queue a run for the worker (`started_at` = when it was requested).
pub async fn enqueue(pool: &PgPool, job: &str, trigger: &str, now: Option<DateTime<Utc>>) -> Result<i32, ClaimError> {
    insert(pool, job, trigger, "queued", now).await
}

/// Python `claim_queued`: turn queued runs (oldest first) into running ones; their ids. An unknown
/// job fails, a stale one is failed, one whose job is running now waits for the next tick.
pub async fn claim_queued(pool: &PgPool, now: Option<DateTime<Utc>>) -> Result<Vec<i32>, sqlx::Error> {
    let now = utc(now);
    let mut tx = pool.begin().await?;
    let queued: Vec<SyncRun> = sqlx::query_as(&format!("SELECT {RUN_COLS} FROM sync_runs WHERE status = 'queued' ORDER BY id"))
        .fetch_all(&mut *tx)
        .await?;
    let mut ids = Vec::new();
    for run in &queued {
        if !JOBS.contains(&run.job.as_str()) {
            sqlx::query("UPDATE sync_runs SET status = 'failed', finished_at = $2, error = $3 WHERE id = $1")
                .bind(run.id)
                .bind(now)
                .bind(format!("unknown job {}", py_repr(&run.job)))
                .execute(&mut *tx)
                .await?;
            continue;
        }
        if now - run.started_at >= stale_after() {
            fail_stale(&mut tx, run, now).await?;
            continue;
        }
        match check_free(&mut tx, &run.job, now, Some(run.id)).await {
            Ok(()) => {}
            Err(ClaimError::Busy(_)) => continue, // the same job is running now; this one waits
            Err(ClaimError::Db(e)) => return Err(e),
            Err(ClaimError::UnknownJob(_)) => continue,
        }
        sqlx::query("UPDATE sync_runs SET status = 'running', started_at = $2 WHERE id = $1")
            .bind(run.id)
            .bind(now)
            .execute(&mut *tx)
            .await?;
        ids.push(run.id);
    }
    tx.commit().await?;
    Ok(ids)
}

/// Python `repr(str)` for the simple case (single quotes unless the text holds one).
fn py_repr(s: &str) -> String {
    if s.contains('\'') && !s.contains('"') {
        format!("\"{s}\"")
    } else {
        format!("'{}'", s.replace('\\', "\\\\").replace('\'', "\\'"))
    }
}

/// Python `fail_abandoned`: at worker start, runs still `running` were left by a previous worker
/// (there is only one), so fail them now. Queued runs are kept. The failed ids.
pub async fn fail_abandoned(pool: &PgPool, now: Option<DateTime<Utc>>) -> Result<Vec<i32>, sqlx::Error> {
    let now = utc(now);
    let mut ids: Vec<i32> = sqlx::query_scalar(
        "UPDATE sync_runs SET status = 'failed', finished_at = $1, error = $2 WHERE status = 'running' RETURNING id",
    )
    .bind(now)
    .bind(ABANDONED)
    .fetch_all(pool)
    .await?;
    ids.sort_unstable();
    Ok(ids)
}

pub async fn get_run(pool: &PgPool, run_id: i32) -> Result<SyncRun, sqlx::Error> {
    sqlx::query_as(&format!("SELECT {RUN_COLS} FROM sync_runs WHERE id = $1")).bind(run_id).fetch_one(pool).await
}

/// Python `execute`: run a claimed job and record the outcome. `started_at` = when it really
/// starts (queued runs are all claimed at the tick's start, then run one after another). A job's
/// error is recorded (`failed`, `"{class}: {message}"` clipped at 2000), never raised.
pub async fn execute(ctx: &Ctx, run_id: i32, started_at: Option<DateTime<Utc>>) -> Result<SyncRun, sqlx::Error> {
    if let Some(at) = started_at {
        sqlx::query("UPDATE sync_runs SET started_at = $2 WHERE id = $1").bind(run_id).bind(at).execute(&ctx.pool).await?;
    }
    let run = get_run(&ctx.pool, run_id).await?;
    let job = run.job.clone();
    let ctx2 = ctx.clone();
    // every record logged during the run carries its id and job (System → Logs)
    tcroof_api::logging::RUN
        .scope((run_id, job.clone()), async move {
            let ctx = ctx2;
            tracing::info!(target: "jobs", "job {} started (run {}, {})", job, run_id, run.trigger);
            let outcome = match jobs::job(&job) {
                Some(Job::Ported(f)) => f(ctx.clone()).await,
                Some(Job::NotPorted { phase }) => Err(jobs::not_ported(&job, phase)),
                None => Err(JobError::new("KeyError", py_repr(&job))),
            };
            match outcome {
                Ok((status, detail)) => {
                    sqlx::query("UPDATE sync_runs SET status = $2, detail_json = $3, finished_at = $4 WHERE id = $1")
                        .bind(run_id)
                        .bind(&status)
                        .bind(jsonable(detail))
                        .bind(Utc::now())
                        .execute(&ctx.pool)
                        .await?;
                }
                Err(e) => {
                    let text = clip(&e.to_string(), RUN_ERROR_MAX);
                    tracing::error!(target: "jobs", exc_text = %e, "job {} failed", job);
                    sqlx::query("UPDATE sync_runs SET status = 'failed', error = $2, finished_at = $3, detail_json = $4 WHERE id = $1")
                        .bind(run_id)
                        .bind(text)
                        .bind(Utc::now())
                        .bind(e.detail.clone().map(jsonable))
                        .execute(&ctx.pool)
                        .await?;
                }
            }
            let run = get_run(&ctx.pool, run_id).await?;
            let tail = run.error.as_ref().map(|e| format!(" ({e})")).unwrap_or_default();
            if run.status == "ok" {
                tracing::info!(target: "jobs", "job {} finished: {}{}", run.job, run.status, tail);
            } else {
                tracing::warn!(target: "jobs", "job {} finished: {}{}", run.job, run.status, tail);
            }
            Ok(run)
        })
        .await
}

/// Python `run_job`: claim and execute now (the CLI's `--once`).
pub async fn run_job(ctx: &Ctx, job: &str, trigger: &str) -> Result<SyncRun, ClaimError> {
    let id = claim(&ctx.pool, job, trigger, None).await?;
    Ok(execute(ctx, id, None).await?)
}

/// Python `last_run`: the job's newest run (any status).
pub async fn last_run(pool: &PgPool, job: &str) -> Result<Option<SyncRun>, sqlx::Error> {
    sqlx::query_as(&format!("SELECT {RUN_COLS} FROM sync_runs WHERE job = $1 ORDER BY started_at DESC LIMIT 1"))
        .bind(job)
        .fetch_optional(pool)
        .await
}

/// Python `last_started`: when the job last started, for the schedule. A run cut off by a worker
/// restart (`ABANDONED`) doesn't count: its slot is still owed.
pub async fn last_started(pool: &PgPool, job: &str) -> Result<Option<DateTime<Utc>>, sqlx::Error> {
    sqlx::query_scalar(
        "SELECT started_at FROM sync_runs WHERE job = $1 AND (error IS NULL OR error <> $2) ORDER BY started_at DESC LIMIT 1",
    )
    .bind(job)
    .bind(ABANDONED)
    .fetch_optional(pool)
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn clip_and_jsonable() {
        assert_eq!(clip("abc", 5), "abc");
        assert_eq!(clip("abcdefg", 3), "abc… (4 more characters)");
        let long = "x".repeat(600);
        let v = jsonable(json!({"a": [long.clone(), 1], "b": {"c": long}}));
        assert_eq!(v["a"][0].as_str().unwrap().chars().count(), 500 + "… (100 more characters)".chars().count());
        assert_eq!(v["a"][1], json!(1));
    }

    #[test]
    fn repr_of_job_names() {
        assert_eq!(py_repr("nope"), "'nope'");
        assert_eq!(py_repr("it's"), "\"it's\"");
    }
}
