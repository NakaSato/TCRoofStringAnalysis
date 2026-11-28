//! The job table (Python `jobs.JOBS`) and the job bodies ported so far. Each body returns
//! `(status, detail)` with status `ok` | `partial`; an error fails the run (`runs::execute`).
//!
//! A job not ported yet is [`Job::NotPorted`]: its run fails with `NotImplementedError: job … is
//! not ported to Rust yet (Phase …)` and `detail_json = {"not_ported": true, "phase": …}`, so it can
//! never look `ok`. One line per job in [`job`], so each wave only touches its own lines.

use std::future::Future;
use std::pin::Pin;

use chrono::{Duration, Timelike, Utc};
use serde_json::{json, Map, Value};
use tcroof_services::growatt_sync::inverters::default_overlap;
use tcroof_services::growatt_sync::{self as gs, SyncOptions};
use tcroof_services::retention as r;

use crate::phases::{per_phase, PhaseCtx};
use crate::{plant_now, today, Ctx, JobError};

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
        "history" => Ported(|ctx| Box::pin(job_history(ctx))),
        "env_history" => Ported(|ctx| Box::pin(job_env_history(ctx))),
        "inverter_latest" => Ported(|ctx| Box::pin(job_inverter_latest(ctx))),
        "backfill" => Ported(|ctx| Box::pin(job_backfill(ctx))),
        "fleet" => Ported(|ctx| Box::pin(job_fleet(ctx))),
        "power_limits" => Ported(|ctx| Box::pin(job_power_limits(ctx))),
        "growatt_energy" => NotPorted { phase: "4.2" },
        "energy_backfill" => NotPorted { phase: "4.2" },
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

// --------------------------------------------------------------------------- Growatt history (4.2)

/// Python `{**a, **b, **c}`: later keys win, a key keeps its first place.
fn merge(into: &mut Map<String, Value>, v: Value) {
    if let Value::Object(m) = v {
        into.extend(m);
    }
}

/// Python `sync_incremental` / `sync_env_incremental` / `sync_meter_incremental` defaults
/// (`overlap` 30 min, `max_back_days` 7, `pause_s` 0.3)
const MAX_BACK_DAYS: i64 = 7;
const PAUSE_S: f64 = 0.3;

/// Python `job_history`: new inverter/string, weather-sensor and energy-meter records since the
/// last run, per account; the meter sweep last (a rate-limited one stops early and never delays
/// inverter history).
pub async fn job_history(ctx: Ctx) -> JobResult {
    let today = today();
    let batch = ctx.worker.worker_history_batch_size.max(0) as usize;
    per_phase(&ctx, move |pc: PhaseCtx| async move {
        let opts = SyncOptions::from_env();
        let (pool, c, ph, ut) = (&pc.pool, &pc.client, Some(pc.phase), pc.include_untagged);
        let ov = default_overlap();
        let mut d = Map::new();
        merge(&mut d, gs::sync_incremental(pool, c, &opts, today, ov, MAX_BACK_DAYS, PAUSE_S, ph, ut, batch).await?);
        merge(&mut d, gs::sync_env_incremental(pool, c, &opts, today, ov, MAX_BACK_DAYS, PAUSE_S, ph, ut, 3, None).await?);
        merge(&mut d, gs::sync_meter_incremental(pool, c, &opts, today, ov, MAX_BACK_DAYS, PAUSE_S, ph, ut).await?);
        Ok(d)
    })
    .await
}

/// Python `job_env_history`: weather-sensor records only, no retries on 10012; 3 in a row end
/// the account's sweep (`MAX_RATE_LIMITED`, run `partial`).
pub async fn job_env_history(ctx: Ctx) -> JobResult {
    let today = today();
    per_phase(&ctx, move |pc: PhaseCtx| async move {
        let opts = SyncOptions::from_env();
        let v = gs::sync_env_incremental(
            &pc.pool,
            &pc.client,
            &opts,
            today,
            default_overlap(),
            MAX_BACK_DAYS,
            PAUSE_S,
            Some(pc.phase),
            pc.include_untagged,
            0,
            Some(gs::MAX_RATE_LIMITED),
        )
        .await?;
        let mut d = Map::new();
        merge(&mut d, v);
        Ok(d)
    })
    .await
}

/// Python `jobs.LATEST_MIN_INTERVAL_MIN`: `maxs_data` answers an account again only about 5 min
/// after a sweep
pub const LATEST_MIN_INTERVAL_MIN: i64 = 5;

/// Python `job_inverter_latest`: each inverter's newest record of today (`maxs_data`) into the
/// history tables; the starting chunk moves on with every interval of the plant-local day.
pub async fn job_inverter_latest(ctx: Ctx) -> JobResult {
    let now = plant_now();
    let minutes = i64::from(now.hour()) * 60 + i64::from(now.minute());
    let turn = (minutes / LATEST_MIN_INTERVAL_MIN.max(ctx.worker.worker_latest_interval_min)) as usize;
    let today = today();
    per_phase(&ctx, move |pc: PhaseCtx| async move {
        let opts = SyncOptions::from_env();
        let v = gs::sync_latest_records(&pc.pool, &pc.client, &opts, today, Some(pc.phase), pc.include_untagged, turn, PAUSE_S)
            .await?;
        let mut d = Map::new();
        merge(&mut d, v);
        Ok(d)
    })
    .await
}

/// Python `job_backfill`: re-read the previous two full days (inverters, sensors, meters) to catch
/// uploads that arrived late.
pub async fn job_backfill(ctx: Ctx) -> JobResult {
    let today = today();
    let (start, end) = (today - Duration::days(2), today - Duration::days(1));
    per_phase(&ctx, move |pc: PhaseCtx| async move {
        let opts = SyncOptions::from_env();
        let (pool, c, ph, ut) = (&pc.pool, &pc.client, Some(pc.phase), pc.include_untagged);
        let mut d = Map::new();
        merge(&mut d, gs::sync_all_history(pool, c, &opts, start, end, None, PAUSE_S, ph, ut).await?);
        merge(&mut d, gs::sync_env_all(pool, c, &opts, start, end, PAUSE_S, ph, ut).await?);
        merge(&mut d, gs::sync_meter_all(pool, c, &opts, start, end, PAUSE_S, ph, ut).await?);
        Ok(d)
    })
    .await
}

/// Python `registry.sync_fleet` default `pause_s`
const FLEET_PAUSE_S: f64 = 0.5;

/// Python `job_fleet`: take the blocked plants out of the registry, then per account
/// `sync_fleet` (plants tagged with the account's phase); detail `{"inverters": n}` per phase.
pub async fn job_fleet(ctx: Ctx) -> JobResult {
    gs::remove_blocked_plants(&ctx.pool, &ctx.settings.blocked_plant_ids()).await?;
    per_phase(&ctx, |pc: PhaseCtx| async move {
        let opts = SyncOptions::from_env();
        let invs = gs::sync_fleet(&pc.pool, &pc.client, &opts, FLEET_PAUSE_S, Some(pc.phase)).await?;
        let mut m = Map::new();
        m.insert("inverters".into(), json!(invs.len()));
        Ok(m)
    })
    .await
}

/// Python `job_power_limits`: each inverter's active power limit (`readPower`) per account, once a
/// day in daylight (the read goes through the datalogger to the inverter).
pub async fn job_power_limits(ctx: Ctx) -> JobResult {
    per_phase(&ctx, |pc: PhaseCtx| async move {
        let opts = SyncOptions::from_env();
        let v = gs::sync_power_limits(&pc.pool, &pc.client, &opts, Some(pc.phase), pc.include_untagged, None, gs::POWER_LIMIT_PAUSE_S, 3)
            .await?;
        let mut d = Map::new();
        merge(&mut d, v);
        Ok(d)
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
        assert_eq!(ported, ["history", "env_history", "inverter_latest", "backfill", "fleet", "power_limits", "retention"]);
    }

    #[test]
    fn not_ported_names_the_phase() {
        let e = not_ported("history", "4.2");
        assert!(e.to_string().starts_with("NotImplementedError: job history is not ported to Rust yet (Phase 4.2"));
        assert_eq!(e.detail.unwrap()["phase"], "4.2");
    }
}
