//! The job table (Python `jobs.JOBS`) and the job bodies ported so far. Each body returns
//! `(status, detail)` with status `ok` | `partial`; an error fails the run (`runs::execute`).
//!
//! A job not ported yet is [`Job::NotPorted`]: its run fails with `NotImplementedError: job … is
//! not ported to Rust yet (Phase …)` and `detail_json = {"not_ported": true, "phase": …}`, so it can
//! never look `ok`. One line per job in [`job`], so each wave only touches its own lines.

use std::future::Future;
use std::pin::Pin;

use chrono::Utc;
use serde_json::{json, Map, Value};
use tcroof_services::retention as r;

use crate::{today, Ctx, JobError};

pub type JobResult = Result<(String, Value), JobError>;
pub type JobFuture = Pin<Box<dyn Future<Output = JobResult> + Send>>;
pub type JobFn = fn(Ctx) -> JobFuture;

/// One entry of the job table.
#[derive(Clone, Copy)]
pub enum Job {
    Ported(JobFn),
    /// the phase / wave of docs/plans/rust-port-master-plan.md that ports it
    NotPorted { phase: &'static str },
}

/// Python `JOBS[name]`; `None` for a name Python does not know either. The names (and their
/// order) are `tcroof_services::sync_status::JOBS`.
pub fn job(name: &str) -> Option<Job> {
    use Job::*;
    Some(match name {
        "history" => NotPorted { phase: "4.2" },
        "env_history" => NotPorted { phase: "4.2" },
        "inverter_latest" => NotPorted { phase: "4.2" },
        "backfill" => NotPorted { phase: "4.2" },
        "fleet" => NotPorted { phase: "4.2" },
        "power_limits" => NotPorted { phase: "4.2" },
        "growatt_energy" => NotPorted { phase: "4.2" },
        "energy_backfill" => NotPorted { phase: "4.2" },
        "publish_today" => NotPorted { phase: "4.3" },
        "publish_yesterday" => NotPorted { phase: "4.3" },
        "retention" => Ported(|ctx| Box::pin(job_retention(ctx))),
        "google_weather" => NotPorted { phase: "4.3" },
        "alarms" => Ported(|ctx| Box::pin(job_alarms(ctx))),
        "alarms_yesterday" => Ported(|ctx| Box::pin(job_alarms_yesterday(ctx))),
        "push_test" => NotPorted { phase: "4.3" },
        "faults_push" => NotPorted { phase: "4.3" },
        "pwa_sheet" => NotPorted { phase: "4.3" },
        "rules_today" => NotPorted { phase: "5" },
        "rules_yesterday" => NotPorted { phase: "5" },
        "rules_backfill" => NotPorted { phase: "5" },
        "epi_refit" => NotPorted { phase: "5" },
        "om_plans" => NotPorted { phase: "6" },
        "om_reminders" => NotPorted { phase: "6" },
        "om_weekly" => NotPorted { phase: "6" },
        "kb_ocr" => NotPorted { phase: "7" },
        _ => return None,
    })
}

/// The failure of a job that is not ported yet.
pub fn not_ported(name: &str, phase: &str) -> JobError {
    JobError {
        kind: "NotImplementedError".into(),
        message: format!(
            "job {name} is not ported to Rust yet (Phase {phase} of docs/plans/rust-port-master-plan.md); run it with the Python worker"
        ),
        detail: Some(json!({"not_ported": true, "phase": phase})),
    }
}

/// Python `job_retention`: delete raw readings and alarm logs older than HISTORY_RETENTION_DAYS
/// (daily summaries are kept), per-string readings older than HISTORY_STRING_RETENTION_DAYS, whole
/// max_data records older than HISTORY_RAW_RETENTION_DAYS, app logs older than LOG_RETENTION_DAYS
/// or beyond LOG_MAX_ROWS, and job runs older than HISTORY_RETENTION_DAYS (each job's newest run kept).
pub async fn job_retention(ctx: Ctx) -> JobResult {
    let (pool, w) = (&ctx.pool, &ctx.worker);
    let keep = w.history_retention_days;
    let mut detail: Map<String, Value> = r::prune_history(pool, today(), keep, Some(w.history_string_retention_days)).await?;
    detail.insert("raw_rows".into(), json!(r::prune_raw(pool, today(), w.history_raw_retention_days.min(keep)).await?));
    detail.insert("google_weather_rows".into(), json!(r::prune_google_weather(pool, today(), keep).await?));
    detail.insert("alarm_rows".into(), json!(r::prune_alarms(pool, today(), keep).await?));
    detail.insert("pwa_check_slots".into(), json!(r::prune_check_slots(pool, today(), keep).await?));
    detail.insert("growatt_power_rows".into(), json!(r::prune_plant_power(pool, today(), keep).await?));
    detail.insert("alarm_push_marks".into(), json!(r::prune_push_marks(pool, today()).await?));
    detail.insert("om_push_marks".into(), json!(r::prune_om_push_marks(pool, today()).await?));
    detail.insert(
        "log_rows".into(),
        json!(r::prune_logs(pool, Utc::now(), ctx.settings.log_retention_days, w.log_max_rows).await?),
    );
    detail.insert("sync_runs".into(), json!(r::prune_runs(pool, Utc::now(), keep).await?));
    Ok(("ok".into(), Value::Object(detail)))
}

// --------------------------------------------------------------------------- alarms (4.2)

/// Python `jobs.alarm_tiers`
fn alarm_tiers(ctx: &Ctx) -> tcroof_services::alarm_sync::Tiers {
    let w = &ctx.worker;
    tcroof_services::alarm_sync::Tiers::from_minutes(
        w.worker_alarms_hot_min,
        w.worker_alarms_warm_min,
        w.worker_alarms_cold_min,
        w.worker_alarms_tick_min,
    )
}

/// Python `jobs._alarms`: one day's Growatt alarm log of every account's inverters → SQL
/// (`growatt_alarms.sync_alarms`), tiered (only the inverters due) for today's `alarms` run.
async fn alarms_day(ctx: &Ctx, day: chrono::NaiveDate, tiered: bool) -> JobResult {
    use tcroof_services::alarm_sync::{self as s, AlarmSyncError};
    let tiers = tiered.then(|| alarm_tiers(ctx));
    let (status, mut detail) = crate::phases::per_phase(ctx, move |pc| async move {
        let invs = s::inverters_query(&pc.pool, Some(pc.phase), pc.include_untagged).await?;
        s::sync_alarms(&pc.pool, &pc.client, day, &invs, s::PAUSE, tiers, None).await.map_err(|e| match e {
            AlarmSyncError::ZeroDivision => JobError::new("ZeroDivisionError", e.to_string()),
            AlarmSyncError::Service(e) => e.into(),
        })
    })
    .await?;
    detail["day"] = json!(day.to_string());
    Ok((status, detail))
}

/// Python `jobs.job_alarms`: today's Growatt alarm log → SQL (replaces each inverter-day), only
/// the inverters due by tier: hot (open alarm / fault status) often, cold (no alarms today) rarely.
pub async fn job_alarms(ctx: Ctx) -> JobResult {
    let started = Utc::now();
    let (status, mut detail) = alarms_day(&ctx, today(), true).await?;
    detail["push"] = alarm_push(&ctx, started).await;
    Ok((status, detail))
}

/// Python `jobs.job_alarms_yesterday`: yesterday's alarm log once more after midnight (evening
/// alarms and late closings), every inverter, no tiers.
pub async fn job_alarms_yesterday(ctx: Ctx) -> JobResult {
    alarms_day(&ctx, today() - chrono::Duration::days(1), false).await
}

/// Python `push.TEST_MAX_AGE` (minutes) and `fault_push.S1_MAX_AGE` (hours)
const PUSH_TEST_MAX_AGE_MIN: i64 = 10;
const S1_MAX_AGE_H: i64 = 6;
/// Python `faults.ACTIVE`
const FAULT_ACTIVE: [&str; 5] = ["open", "diagnosed", "waiting", "scheduled", "monitor"];
const PUSH_SKIPPED: &str = "FIREBASE_CREDENTIALS_FILE is not set";

/// Python `job_alarms`'s `detail["push"] = _push(db, lambda push: {**push.notify_new_alarms(db,
/// today, started), **push.send_tests(db), **_fault_s1(db)})`.
///
/// TODO(Phase 4.3): the FCM push itself (services/push.py `notify_new_alarms`, `send_tests`,
/// fault_push.py `notify_s1`) is not ported; replace this hook with it. Ported here are only the
/// paths that send nothing: no device / test request / S1 fault, or no sender
/// (FIREBASE_CREDENTIALS_FILE empty), with Python's detail. When a sender is configured and
/// something would be sent, the detail is `{"error": "NotImplementedError: …"}` and nothing is
/// written. As in Python, push trouble never changes the run's status.
async fn alarm_push(ctx: &Ctx, _since: chrono::DateTime<Utc>) -> Value {
    match alarm_push_unsent(ctx).await {
        Ok(v) => v,
        Err(e) => {
            tracing::error!(target: "jobs", exc_text = %e, "push notifications failed");
            json!({"error": e.to_string()})
        }
    }
}

async fn alarm_push_unsent(ctx: &Ctx) -> Result<Value, JobError> {
    use chrono::{DateTime, Duration};
    let pool = &ctx.pool;
    let no_sender = ctx.settings.firebase_credentials_file.is_empty();
    let not_ported = || {
        Err(JobError::new(
            "NotImplementedError",
            "alarm push is not ported to Rust yet (Phase 4.3 of docs/plans/rust-port-master-plan.md)",
        ))
    };
    let now = Utc::now();
    let mut out = Map::new();
    // push.notify_new_alarms
    let devices: i64 = sqlx::query_scalar("SELECT count(*) FROM push_tokens").fetch_one(pool).await?;
    out.insert("devices".into(), json!(devices));
    if devices > 0 {
        if !no_sender {
            return not_ported();
        }
        out.insert("skipped".into(), json!(PUSH_SKIPPED));
    }
    // push.send_tests: the requests are cleared even without a sender, as in Python
    let asked: Vec<DateTime<Utc>> = sqlx::query_scalar(
        "SELECT t.test_requested_at FROM push_tokens t JOIN users u ON u.id = t.user_id \
         WHERE t.test_requested_at IS NOT NULL AND u.is_active",
    )
    .fetch_all(pool)
    .await?;
    if asked.is_empty() {
        out.insert("tests".into(), json!(0));
    } else {
        if !no_sender {
            return not_ported();
        }
        let due = asked.iter().filter(|a| now - **a <= Duration::minutes(PUSH_TEST_MAX_AGE_MIN)).count();
        sqlx::query(
            "UPDATE push_tokens t SET test_requested_at = NULL FROM users u \
             WHERE u.id = t.user_id AND t.test_requested_at IS NOT NULL AND u.is_active",
        )
        .execute(pool)
        .await?;
        out.insert("tests".into(), json!(due));
        out.insert("skipped".into(), json!(PUSH_SKIPPED));
    }
    // fault_push.notify_s1
    let s1: Vec<DateTime<Utc>> = sqlx::query_scalar(
        "SELECT s1_at FROM field_faults WHERE severity = 'S1' AND s1_pushed_at IS NULL \
         AND s1_at IS NOT NULL AND status = ANY($1)",
    )
    .bind(&FAULT_ACTIVE[..])
    .fetch_all(pool)
    .await?;
    let n_s1 = s1.iter().filter(|at| now - **at <= Duration::hours(S1_MAX_AGE_H)).count();
    let faults = if n_s1 == 0 {
        json!({"s1_faults": 0})
    } else if no_sender {
        json!({"s1_faults": n_s1, "skipped": PUSH_SKIPPED})
    } else {
        return not_ported();
    };
    out.insert("faults".into(), faults);
    Ok(Value::Object(out))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tcroof_services::sync_status::JOBS;

    #[test]
    fn the_table_has_every_python_job_and_no_other() {
        for name in JOBS {
            assert!(job(name).is_some(), "{name} missing");
        }
        assert!(job("nope").is_none());
        let ported: Vec<&str> = JOBS.iter().copied().filter(|n| matches!(job(n), Some(Job::Ported(_)))).collect();
        assert_eq!(ported, ["retention", "alarms", "alarms_yesterday"]);
    }

    #[test]
    fn not_ported_names_the_phase() {
        let e = not_ported("history", "4.2");
        assert!(e.to_string().starts_with("NotImplementedError: job history is not ported to Rust yet (Phase 4.2"));
        assert_eq!(e.detail.unwrap()["phase"], "4.2");
    }
}
