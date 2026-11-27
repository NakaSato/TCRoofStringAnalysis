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
use tcroof_services::growatt_energy as ge;
use tcroof_services::retention as r;

use crate::phases::{per_phase, PhaseCtx};
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
        "growatt_energy" => Ported(|ctx| Box::pin(job_growatt_energy(ctx))),
        "energy_backfill" => Ported(|ctx| Box::pin(job_energy_backfill(ctx))),
        "publish_today" => NotPorted { phase: "4.3" },
        "publish_yesterday" => NotPorted { phase: "4.3" },
        "retention" => Ported(|ctx| Box::pin(job_retention(ctx))),
        "google_weather" => NotPorted { phase: "4.3" },
        "alarms" => NotPorted { phase: "4.2" },
        "alarms_yesterday" => NotPorted { phase: "4.2" },
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

/// Python `job_growatt_energy`: Growatt's own figures for finished days: each plant's daily kWh
/// (`plant/energy`, last 7 days), its 5-minute curve (`plant/power`) and each inverter's kWh
/// (`day_energy`) for the days not stored yet. Never today (realtime).
pub async fn job_growatt_energy(ctx: Ctx) -> JobResult {
    let day = today();
    per_phase(&ctx, move |pc: PhaseCtx| async move {
        let o = ge::EnergyOptions::default();
        Ok(ge::sync_growatt_energy(&pc.pool, &pc.client, day, Some(pc.phase), pc.include_untagged, o).await?)
    })
    .await
}

/// Python `job_energy_backfill`: Growatt's daily kWh (`plant/energy`) for the last
/// HISTORY_RETENTION_DAYS finished days of every plant missing some (not scheduled: queue once
/// after deploy).
pub async fn job_energy_backfill(ctx: Ctx) -> JobResult {
    let day = today();
    let days = ctx.worker.history_retention_days;
    per_phase(&ctx, move |pc: PhaseCtx| async move {
        let o = ge::EnergyOptions::default();
        Ok(ge::backfill_plant_energy(&pc.pool, &pc.client, day, days, Some(pc.phase), pc.include_untagged, o).await?)
    })
    .await
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
        assert_eq!(ported, ["growatt_energy", "energy_backfill", "retention"]);
    }

    #[test]
    fn not_ported_names_the_phase() {
        let e = not_ported("history", "4.2");
        assert!(e.to_string().starts_with("NotImplementedError: job history is not ported to Rust yet (Phase 4.2"));
        assert_eq!(e.detail.unwrap()["phase"], "4.2");
    }
}
