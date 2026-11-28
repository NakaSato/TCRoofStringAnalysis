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
        "publish_today" => Ported(|ctx| Box::pin(job_publish_today(ctx))),
        "publish_yesterday" => Ported(|ctx| Box::pin(job_publish_yesterday(ctx))),
        "retention" => Ported(|ctx| Box::pin(job_retention(ctx))),
        "google_weather" => Ported(|ctx| Box::pin(job_google_weather(ctx))),
        "alarms" => Ported(|ctx| Box::pin(job_alarms(ctx))),
        "alarms_yesterday" => Ported(|ctx| Box::pin(job_alarms_yesterday(ctx))),
        "push_test" => Ported(|ctx| Box::pin(job_push_test(ctx))),
        "faults_push" => Ported(|ctx| Box::pin(job_faults_push(ctx))),
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

// --------------------------------------------------------------------------- publish (4.3)

/// The settings a publish reads (Python `settings.publish_*`, `firebase_*`, the PWA checks and
/// Google Weather).
pub fn publish_config(ctx: &Ctx) -> tcroof_services::daily_summary::PublishConfig {
    use tcroof_services::check_slots::{parse_warn_codes, CheckConfig};
    let (st, w) = (&ctx.settings, &ctx.worker);
    tcroof_services::daily_summary::PublishConfig {
        sink: st.sink_config(),
        budget: st.publish_daily_write_budget,
        checks: CheckConfig {
            offset_min: w.check_offset_min,
            history_lead_min: w.pwa_history_lead_min,
            fault_lookback_min: w.pwa_fault_lookback_min,
            ignored_warn_codes: parse_warn_codes(&w.pwa_ignore_warn_codes),
            google: st.google_cells(),
            google_api_key: st.google_weather_api_key.clone(),
            google_base_url: st.google_weather_base_url.clone(),
            google_monthly_budget: st.google_weather_monthly_budget,
        },
    }
}

impl From<tcroof_services::daily_summary::PublishError> for JobError {
    fn from(e: tcroof_services::daily_summary::PublishError) -> Self {
        JobError::new(&e.kind, e.message)
    }
}

/// Python `jobs._publish`: the registry and `day`'s daily docs to the sink `PUBLISH_SINK`
/// names; `partial` when documents were deferred (write budget) or too large.
pub async fn publish(ctx: &Ctx, day: chrono::NaiveDate) -> JobResult {
    Ok(tcroof_services::daily_summary::publish_day(&ctx.pool, &publish_config(ctx), day).await?)
}

/// Python `jobs._pwa_sheet`: today's tab of the PWA Report Google Sheet, checks published so far;
/// None when PWA_SHEET_ID is not set. Errors go into the detail, never fail a publish.
pub async fn pwa_sheet(ctx: &Ctx, now: chrono::DateTime<chrono::FixedOffset>) -> Option<Value> {
    tcroof_services::pwa_sheet::run_for_now_safe(&ctx.pool, &pwa_sheet_config(ctx), now.naive_local()).await
}

/// The PWA sheet settings (`PWA_SHEET_*`, the Firestore the day docs are read from) with the
/// worker's `CHECK_OFFSET_MIN`.
fn pwa_sheet_config(ctx: &Ctx) -> tcroof_services::pwa_sheet::PwaSheetConfig {
    let mut cfg = tcroof_services::pwa_sheet::PwaSheetConfig::from_env();
    cfg.check_offset_min = ctx.worker.check_offset_min;
    cfg
}

/// Python `job_publish_today`: today's docs (08:50 / 12:50 / 16:50 freeze the PWA checks, 19:30
/// after sunset), then the PWA Report sheet's tab.
pub async fn job_publish_today(ctx: Ctx) -> JobResult {
    let (mut status, mut detail) = publish(&ctx, today()).await?;
    if let Some(sheet) = pwa_sheet(&ctx, plant_now()).await {
        if sheet.get("error").is_some() {
            status = "partial".into();
        }
        detail["pwa_sheet"] = sheet;
    }
    Ok((status, detail))
}

/// Python `job_publish_yesterday` (06:00): yesterday's docs once more, so late uploads land.
pub async fn job_publish_yesterday(ctx: Ctx) -> JobResult {
    publish(&ctx, today() - Duration::days(1)).await
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

// --------------------------------------------------------------------------- push (4.3)

impl From<tcroof_services::push::PushError> for JobError {
    fn from(e: tcroof_services::push::PushError) -> Self {
        JobError::new(&e.kind, e.message)
    }
}

/// Python `jobs._push`: push trouble is reported in the run detail (`{"error": "{class}: {msg}"}`,
/// logged with its traceback) and never fails the job it follows.
async fn guarded<F>(fut: F) -> Value
where
    F: Future<Output = Result<Map<String, Value>, tcroof_services::push::PushError>>,
{
    match fut.await {
        Ok(m) => Value::Object(m),
        Err(e) => {
            tracing::error!(target: "jobs", exc_text = %e, "push notifications failed");
            json!({"error": e.to_string()})
        }
    }
}

/// Python `jobs._fault_s1`: `{"faults": fault_push.notify_s1(db)}`
async fn fault_s1(ctx: &Ctx) -> Result<Value, tcroof_services::push::PushError> {
    let src = ctx.push_source();
    Ok(Value::Object(tcroof_services::fault_push::notify_s1(&ctx.pool, &src, Utc::now()).await?))
}

/// Python `job_alarms`'s `detail["push"] = _push(db, lambda push: {**push.notify_new_alarms(db,
/// today, started), **push.send_tests(db), **_fault_s1(db)})`: later keys win, a key keeps its
/// first place. The three run in turn; what one wrote stays when a later one fails.
async fn alarm_push(ctx: &Ctx, since: chrono::DateTime<Utc>) -> Value {
    use tcroof_services::push;
    let src = ctx.push_source();
    guarded(async {
        let mut out = push::notify_new_alarms(&ctx.pool, &ctx.worker.push, today(), since, &src, Utc::now()).await?;
        out.extend(push::send_tests(&ctx.pool, &src, Utc::now()).await?);
        out.insert("faults".into(), fault_s1(ctx).await?);
        Ok(out)
    })
    .await
}

/// Python `job_push_test` / `job_faults_push`: `partial` when the push failed or a message did
fn push_status(detail: &Value) -> String {
    let failed = detail.get("failed").is_some_and(|v| v.as_i64().unwrap_or(0) != 0);
    if detail.get("error").is_some() || failed { "partial" } else { "ok" }.into()
}

/// Python `jobs.job_push_test`: test notifications asked for from the UI (POST /push/test queues this).
pub async fn job_push_test(ctx: Ctx) -> JobResult {
    let src = ctx.push_source();
    let detail = guarded(tcroof_services::push::send_tests(&ctx.pool, &src, Utc::now())).await;
    Ok((push_status(&detail), detail))
}

/// Python `jobs.job_faults_push`: field faults recorded as S1 or raised to it, pushed to whoever may
/// see the plant (queued by the API; every `alarms` run flushes them too; services/fault_push.py).
pub async fn job_faults_push(ctx: Ctx) -> JobResult {
    let src = ctx.push_source();
    let detail = guarded(tcroof_services::fault_push::notify_s1(&ctx.pool, &src, Utc::now())).await;
    Ok((push_status(&detail), detail))
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
    let (mut status, mut detail) = gh::run_history_job(&ctx.pool, &cfg, plant_now().naive_local()).await.map_err(|e| match e {
        HistoryError::AllFailed(_) => JobError::new("RuntimeError", e.to_string()),
        HistoryError::Db(e) => JobError::from(e),
    })?;
    if detail.get("hours_stored").and_then(Value::as_u64).unwrap_or(0) > 0 {
        // Yesterday's 18:00–23:00 hours only arrive now: re-publish its daily docs (only docs
        // whose content changed are written). Today's slots go out with publish_today (19:30).
        let (pub_status, pub_detail) = publish(&ctx, today() - Duration::days(1)).await?;
        let pick = |k: &str| pub_detail.get(k).cloned().unwrap_or(Value::Null);
        detail["republished_yesterday"] = json!({"written": pick("written"), "unchanged": pick("unchanged"), "over_budget": pick("over_budget")});
        if pub_status != "ok" {
            status = "partial".into();
        }
    }
    Ok((status, detail))
}

/// Python `jobs.job_pwa_sheet`: today's tab of the PWA Report Google Sheet (created if missing)
/// with the checks published so far; `ok` + skipped without PWA_SHEET_ID, `failed` on an error
/// (the error in the detail, as Python's `_pwa_sheet`).
pub async fn job_pwa_sheet(ctx: Ctx) -> JobResult {
    use tcroof_services::pwa_sheet::run_for_now_safe;
    let cfg = pwa_sheet_config(&ctx);
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
        assert_eq!(ported, ["history", "env_history", "inverter_latest", "backfill", "fleet", "power_limits", "growatt_energy", "energy_backfill", "publish_today", "publish_yesterday", "retention", "google_weather", "alarms", "alarms_yesterday", "push_test", "faults_push", "pwa_sheet"]);
    }

    #[test]
    fn not_ported_names_the_phase() {
        let e = not_ported("history", "4.2");
        assert!(e.to_string().starts_with("NotImplementedError: job history is not ported to Rust yet (Phase 4.2"));
        assert_eq!(e.detail.unwrap()["phase"], "4.2");
    }
}
