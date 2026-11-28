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
        "growatt_energy" => Ported(|ctx| Box::pin(job_growatt_energy(ctx))),
        "energy_backfill" => Ported(|ctx| Box::pin(job_energy_backfill(ctx))),
        "publish_today" => NotPorted { phase: "4.3" },
        "publish_yesterday" => NotPorted { phase: "4.3" },
        "retention" => Ported(|ctx| Box::pin(job_retention(ctx))),
        "google_weather" => Ported(|ctx| Box::pin(job_google_weather(ctx))),
        "alarms" => Ported(|ctx| Box::pin(job_alarms(ctx))),
        "alarms_yesterday" => Ported(|ctx| Box::pin(job_alarms_yesterday(ctx))),
        "push_test" => NotPorted { phase: "4.3" },
        "faults_push" => NotPorted { phase: "4.3" },
        "pwa_sheet" => Ported(|ctx| Box::pin(job_pwa_sheet(ctx))),
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

/// Python `job_growatt_energy`: Growatt's own figures for finished days: each plant's daily kWh
/// (`plant/energy`, last 7 days), its 5-minute curve (`plant/power`) and each inverter's kWh
/// (`day_energy`) for the days not stored yet. Never today (realtime).
pub async fn job_growatt_energy(ctx: Ctx) -> JobResult {
    use tcroof_services::growatt_energy_sync as ge;
    let day = today();
    per_phase(&ctx, move |pc: PhaseCtx| async move {
        let opts = SyncOptions::from_env();
        let v = ge::sync_growatt_energy(
            &pc.pool,
            &pc.client,
            &opts,
            day,
            Some(pc.phase),
            pc.include_untagged,
            ge::ENERGY_LOOKBACK_DAYS,
            ge::CURVE_DAYS,
            ge::ENERGY_PAUSE_S,
            ge::MAX_RATE_LIMITED,
        )
        .await?;
        let mut d = Map::new();
        merge(&mut d, v);
        Ok(d)
    })
    .await
}

/// Python `job_energy_backfill`: Growatt's daily kWh (`plant/energy`) for the last
/// HISTORY_RETENTION_DAYS finished days of every plant missing some (not scheduled: queue once
/// after deploy).
pub async fn job_energy_backfill(ctx: Ctx) -> JobResult {
    use tcroof_services::growatt_energy_sync as ge;
    let day = today();
    let days = ctx.worker.history_retention_days;
    per_phase(&ctx, move |pc: PhaseCtx| async move {
        let opts = SyncOptions::from_env();
        let v = ge::backfill_plant_energy(
            &pc.pool,
            &pc.client,
            &opts,
            day,
            days,
            Some(pc.phase),
            pc.include_untagged,
            ge::ENERGY_PAUSE_S,
            ge::MAX_RATE_LIMITED,
        )
        .await?;
        let mut d = Map::new();
        merge(&mut d, v);
        Ok(d)
    })
    .await
}

// --------------------------------------------------------------------------- alarms (4.2)

/// Python `jobs.alarm_tiers`
fn alarm_tiers(ctx: &Ctx) -> tcroof_services::alarm_sync::Tiers {
    let w = &ctx.worker;
    let m = chrono::Duration::minutes;
    tcroof_services::alarm_sync::Tiers {
        hot: m(w.worker_alarms_hot_min),
        warm: m(w.worker_alarms_warm_min),
        cold: m(w.worker_alarms_cold_min),
        tick: Some(m(w.worker_alarms_tick_min)),
    }
}

/// Python `growatt_alarms.sync_alarms` default `pause_s`
const ALARM_PAUSE_S: f64 = 0.3;

/// Python `jobs._alarms`: one day's Growatt alarm log of every account's inverters → SQL
/// (`growatt_alarms.sync_alarms`), tiered (only the inverters due) for today's `alarms` run.
async fn alarms_day(ctx: &Ctx, day: chrono::NaiveDate, tiered: bool) -> JobResult {
    use tcroof_services::alarm_sync as s;
    let tiers = tiered.then(|| alarm_tiers(ctx));
    let (status, mut detail) = per_phase(ctx, move |pc: PhaseCtx| async move {
        let opts = SyncOptions::from_env();
        let invs: Vec<s::AlarmInverter> = gs::inverters_query(&pc.pool, Some(pc.phase), pc.include_untagged, None)
            .await?
            .into_iter()
            .map(|i| s::AlarmInverter { device_sn: i.device_sn, plant_id: i.plant_id })
            .collect();
        let v = s::sync_alarms(&pc.pool, &pc.client, &opts, day, &invs, ALARM_PAUSE_S, tiers, None).await?;
        let mut d = Map::new();
        merge(&mut d, v);
        Ok(d)
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

// --------------------------------------------------------------------------- Google Weather / PWA sheet (4.3)

/// Python `jobs.job_google_weather`: today's daytime hours of Google Maps Weather (hourly,
/// modelled) for every plant grid cell (`google_weather.run_history_job`); when hours were stored,
/// yesterday's daily docs are re-published (yesterday's 18:00–23:00 hours only arrive now).
pub async fn job_google_weather(ctx: Ctx) -> JobResult {
    use tcroof_services::google_weather_history::{self as gh, HistoryConfig, HistoryError};
    let s = &ctx.settings;
    let cfg = HistoryConfig {
        api_key: s.google_weather_api_key.clone(),
        base_url: s.google_weather_base_url.clone(),
        monthly_budget: s.google_weather_monthly_budget,
        // Python `settings.google_weather_history_hours_per_day` (4000)
        history_hours_per_day: std::env::var("GOOGLE_WEATHER_HISTORY_HOURS_PER_DAY")
            .ok()
            .and_then(|v| v.trim().parse().ok())
            .unwrap_or(4000),
        cells: s.google_cells(),
    };
    let (status, mut detail) = gh::run_history_job(&ctx.pool, &cfg, plant_now().naive_local()).await.map_err(|e| match e {
        HistoryError::AllFailed(_) => JobError::new("RuntimeError", e.to_string()),
        HistoryError::Db(e) => JobError::from(e),
    })?;
    if detail.get("hours_stored").and_then(Value::as_u64).unwrap_or(0) > 0 {
        // TODO(4.3 publish): Python re-publishes yesterday here: `_publish(db, today - 1 day)`,
        // `detail["republished_yesterday"] = {written, unchanged, over_budget}` of its report, and
        // the run becomes `partial` when that publish is not `ok`. Wire in
        // `tcroof_services::publish::publish_day(...)` at merge; until then the re-publish is
        // recorded as not available.
        detail["republished_yesterday"] = json!({"available": false, "reason": "publish is not ported to Rust yet (4.3)"});
    }
    Ok((status, detail))
}

/// Python `jobs.job_pwa_sheet`: today's tab of the PWA Report Google Sheet (created if missing)
/// with the checks published so far; `ok` + skipped without PWA_SHEET_ID, `failed` on an error
/// (the error in the detail, as Python's `_pwa_sheet`).
pub async fn job_pwa_sheet(ctx: Ctx) -> JobResult {
    use tcroof_services::pwa_sheet::{run_for_now_safe, PwaSheetConfig};
    let mut cfg = PwaSheetConfig::from_env();
    cfg.check_offset_min = ctx.worker.check_offset_min;
    Ok(match run_for_now_safe(&ctx.pool, &cfg, plant_now().naive_local()).await {
        None => ("ok".into(), json!({"skipped": "PWA_SHEET_ID not set"})),
        Some(sheet) => ((if sheet.get("error").is_some() { "failed" } else { "ok" }).into(), sheet),
    })
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
        assert_eq!(ported, ["history", "env_history", "inverter_latest", "backfill", "fleet", "power_limits", "growatt_energy", "energy_backfill", "retention", "google_weather", "alarms", "alarms_yesterday", "pwa_sheet"]);
    }

    #[test]
    fn not_ported_names_the_phase() {
        let e = not_ported("history", "4.2");
        assert!(e.to_string().starts_with("NotImplementedError: job history is not ported to Rust yet (Phase 4.2"));
        assert_eq!(e.detail.unwrap()["phase"], "4.2");
    }
}
