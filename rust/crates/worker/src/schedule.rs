//! The schedule (backend/app/worker.py `Schedule`, `default_schedule`, `_bootstrap_due`,
//! `_last_start`, `tick`). Times are plant-local (Asia/Bangkok, UTC+7); `now` / `last` are UTC
//! instants. Daily jobs fire only within `GRACE` after their slot, so a worker started at noon does
//! not publish a half day. Last-run times come from `sync_runs`, so restarts don't re-run jobs.

use std::time::Instant;

use chrono::{DateTime, Datelike, Duration, NaiveDate, NaiveTime, Timelike, Utc};
use sqlx::PgPool;

use crate::config::WorkerSettings;
use crate::runs::{self, ClaimError};
use crate::{plant_tz, Ctx};

/// Python `GRACE`
pub fn grace() -> Duration {
    Duration::hours(3)
}
/// Python `TICK_S`
pub const TICK_S: u64 = 60;
/// Python `POWER_LIMITS_AT`
pub const POWER_LIMITS_AT: (u32, u32) = (10, 40);
/// Python `ALARMS_PWA_GAP_MIN`
pub const ALARMS_PWA_GAP_MIN: i64 = 5;
/// Python `check_slots.CHECK_HOURS`: the PWA report checks 09 / 13 / 17
pub const PWA_CHECK_HOURS: [u32; 3] = [9, 13, 17];
/// Python `jobs.LATEST_MIN_INTERVAL_MIN`
pub const LATEST_MIN_INTERVAL_MIN: i64 = 5;

fn registry_retry() -> Duration {
    Duration::minutes(15)
}
fn untagged_retry() -> Duration {
    Duration::hours(6)
}
fn fleet_retry() -> Duration {
    Duration::hours(6)
}

/// Python `Schedule`
#[derive(Debug, Clone, PartialEq)]
pub struct Schedule {
    pub job: &'static str,
    pub every: Option<Duration>,
    pub at: Option<NaiveTime>,
    /// `every` jobs only: plant-local hours [start, end) the job may start in
    pub between: Option<(i64, i64)>,
    /// `every` jobs only: other jobs whose start also counts as a run of this one
    pub covered_by: Vec<&'static str>,
    /// `every` jobs only: plant-local [from, to) windows the job does not start in
    pub skip: Vec<(NaiveTime, NaiveTime)>,
    /// `at` jobs only: plant-local weekdays (0 = Monday); None = every day
    pub weekdays: Option<Vec<u32>>,
}

impl Schedule {
    pub fn every(job: &'static str, every: Duration) -> Schedule {
        Schedule { job, every: Some(every), at: None, between: None, covered_by: vec![], skip: vec![], weekdays: None }
    }
    pub fn at(job: &'static str, at: NaiveTime) -> Schedule {
        Schedule { job, every: None, at: Some(at), between: None, covered_by: vec![], skip: vec![], weekdays: None }
    }

    /// Python `Schedule.is_due`
    pub fn is_due(&self, now: DateTime<Utc>, last: Option<DateTime<Utc>>) -> bool {
        let local = now.with_timezone(&plant_tz());
        if let Some(every) = self.every {
            if let Some((a, b)) = self.between {
                let h = i64::from(local.hour());
                if !(a <= h && h < b) {
                    return false;
                }
            }
            let t = local.time();
            if self.skip.iter().any(|(a, b)| *a <= t && t < *b) {
                return false;
            }
            return last.is_none_or(|l| now - l >= every);
        }
        let at = self.at.expect("a Schedule has `every` or `at`");
        let slot = local
            .with_hour(at.hour())
            .and_then(|d| d.with_minute(at.minute()))
            .and_then(|d| d.with_second(0))
            .and_then(|d| d.with_nanosecond(0))
            .expect("a valid wall-clock time");
        if let Some(days) = &self.weekdays {
            if !days.contains(&slot.weekday().num_days_from_monday()) {
                return false;
            }
        }
        if !(slot <= local && local < slot + grace()) {
            return false;
        }
        last.is_none_or(|l| l < slot)
    }
}

fn hm(h: u32, m: u32) -> NaiveTime {
    NaiveTime::from_hms_opt(h, m, 0).expect("valid time")
}

/// Python `check_slots.clock(hour, minus)`: wall-clock time of check `hour`'s slot
/// (`CHECK_OFFSET_MIN` before the hour) minus `minus`, wrapping over midnight as Python's does.
pub fn check_clock(w: &WorkerSettings, hour: u32, minus: Duration) -> NaiveTime {
    let base = NaiveDate::from_ymd_opt(2000, 1, 1).expect("valid date").and_time(hm(hour, 0));
    (base - Duration::minutes(w.check_offset_min) - minus).time()
}

/// Python `default_schedule()`; `fleet` first: on an empty registry it runs before `history`
/// in the same tick.
pub fn default_schedule(w: &WorkerSettings) -> Vec<Schedule> {
    let mut s = vec![
        Schedule::at("fleet", hm(5, 30)),
        Schedule::every("history", Duration::minutes(w.worker_history_interval_min)),
        Schedule::at("backfill", hm(2, 0)),
        Schedule::at("publish_yesterday", hm(6, 0)),
    ];
    // each PWA check: fresh history PWA_HISTORY_LEAD_MIN before it, then publish today so far
    for h in PWA_CHECK_HOURS {
        s.push(Schedule::at("history", check_clock(w, h, Duration::minutes(w.pwa_history_lead_min))));
    }
    for h in PWA_CHECK_HOURS {
        s.push(Schedule::at("publish_today", check_clock(w, h, Duration::zero())));
    }
    s.push(Schedule::at("publish_today", hm(19, 30)));
    s.push(Schedule::at("pwa_sheet", hm(6, 5)));
    s.push(Schedule::at("retention", hm(3, 0)));
    s.push(Schedule::at("google_weather", hm(18, 15)));
    s.push(Schedule::at("power_limits", hm(POWER_LIMITS_AT.0, POWER_LIMITS_AT.1)));
    s.push(Schedule {
        between: Some((w.worker_alarms_start_h, w.worker_alarms_end_h)),
        // keep the worker free for each PWA check's history pull (08:47) and publish (08:50)
        skip: PWA_CHECK_HOURS
            .iter()
            .map(|&h| {
                (
                    check_clock(w, h, Duration::minutes(w.pwa_history_lead_min + ALARMS_PWA_GAP_MIN)),
                    check_clock(w, h, Duration::minutes(-1)),
                )
            })
            .collect(),
        ..Schedule::every("alarms", Duration::minutes(w.worker_alarms_tick_min))
    });
    s.push(Schedule::at("alarms_yesterday", hm(0, 30)));
    s.push(Schedule::at("om_plans", hm(0, 40)));
    s.push(Schedule::at("om_reminders", hm(18, 0)));
    s.push(Schedule { weekdays: Some(vec![0]), ..Schedule::at("om_weekly", hm(7, 30)) });
    s.push(Schedule::at("rules_yesterday", hm(0, 45)));
    s.push(Schedule::at("growatt_energy", hm(0, 50)));
    // right behind `history`: when both are due in a tick, the rules see the new records
    s.push(Schedule { between: Some((6, 20)), ..Schedule::every("rules_today", Duration::minutes(w.worker_history_interval_min)) });
    if w.worker_env_interval_min > 0 {
        s.push(Schedule {
            between: Some((w.worker_env_start_h, w.worker_env_end_h)),
            covered_by: vec!["history"],
            ..Schedule::every("env_history", Duration::minutes(w.worker_env_interval_min))
        });
    }
    if w.worker_latest_interval_min > 0 {
        s.push(Schedule {
            between: Some((w.worker_latest_start_h, w.worker_latest_end_h)),
            ..Schedule::every("inverter_latest", Duration::minutes(LATEST_MIN_INTERVAL_MIN.max(w.worker_latest_interval_min)))
        });
    }
    if w.worker_kb_ocr_interval_min > 0 {
        s.push(Schedule::every("kb_ocr", Duration::minutes(w.worker_kb_ocr_interval_min)));
    }
    s
}

async fn registry_empty(pool: &PgPool) -> Result<bool, sqlx::Error> {
    Ok(sqlx::query_scalar::<_, String>("SELECT device_sn FROM growatt_inverters LIMIT 1").fetch_optional(pool).await?.is_none())
}

async fn has_untagged_plants(pool: &PgPool) -> Result<bool, sqlx::Error> {
    Ok(sqlx::query_scalar::<_, i32>("SELECT plant_id FROM growatt_plants WHERE phase IS NULL LIMIT 1").fetch_optional(pool).await?.is_some())
}

async fn last_fleet_incomplete(pool: &PgPool) -> Result<bool, sqlx::Error> {
    Ok(runs::last_run(pool, "fleet").await?.is_some_and(|r| r.status == "partial" || r.status == "failed"))
}

/// Python `_bootstrap_due`: `fleet` also runs whenever the inverter registry is empty (retrying
/// every REGISTRY_RETRY), every UNTAGGED_RETRY while some plants have no phase yet, and every
/// FLEET_RETRY while the last fleet run was partial / failed.
pub async fn bootstrap_due(job: &str, pool: &PgPool, now: DateTime<Utc>, last: Option<DateTime<Utc>>) -> Result<bool, sqlx::Error> {
    if job != "fleet" {
        return Ok(false);
    }
    if registry_empty(pool).await? {
        return Ok(last.is_none_or(|l| now - l >= registry_retry()));
    }
    if last.is_none_or(|l| now - l >= untagged_retry()) && has_untagged_plants(pool).await? {
        return Ok(true);
    }
    Ok(match last {
        Some(l) if now - l >= fleet_retry() => last_fleet_incomplete(pool).await?,
        _ => false,
    })
}

/// Python `_last_start`: when the job (or one of the jobs covering it) last started.
pub async fn last_start(pool: &PgPool, s: &Schedule) -> Result<Option<DateTime<Utc>>, sqlx::Error> {
    let mut best: Option<DateTime<Utc>> = None;
    for j in std::iter::once(&s.job).chain(s.covered_by.iter()) {
        if let Some(t) = runs::last_started(pool, j).await? {
            best = Some(best.map_or(t, |b| b.max(t)));
        }
    }
    Ok(best)
}

/// Python `tick`: run queued (API-requested) runs, then every due job once, one after another.
/// Each job is judged due and stamped `started_at` when it starts (`now` + the whole seconds the
/// tick has run so far). The jobs started.
pub async fn tick(ctx: &Ctx, schedule: &[Schedule], now: DateTime<Utc>) -> Result<Vec<String>, sqlx::Error> {
    let t0 = Instant::now();
    // whole seconds: a job's few milliseconds must not push the next one past an exact boundary
    let clock = || now + Duration::seconds(t0.elapsed().as_secs() as i64);
    let mut started = Vec::new();
    for run_id in runs::claim_queued(&ctx.pool, Some(now)).await? {
        let run = runs::execute(ctx, run_id, Some(clock())).await?;
        tracing::info!(target: "worker", "{} (queued) → {} {}", run.job, run.status, outcome(&run));
        started.push(run.job);
    }
    for s in schedule {
        let at = clock();
        let last = last_start(&ctx.pool, s).await?;
        if !(s.is_due(at, last) || bootstrap_due(s.job, &ctx.pool, at, last).await?) {
            continue;
        }
        let run_id = match runs::claim(&ctx.pool, s.job, "schedule", Some(at)).await {
            Ok(id) => id,
            Err(ClaimError::Busy(m)) => {
                tracing::info!(target: "worker", "skip {}: {}", s.job, m);
                continue;
            }
            Err(ClaimError::UnknownJob(j)) => {
                tracing::error!(target: "worker", "skip {}: not a job", j);
                continue;
            }
            Err(ClaimError::Db(e)) => return Err(e),
        };
        let run = runs::execute(ctx, run_id, None).await?;
        tracing::info!(target: "worker", "{} → {} {}", s.job, run.status, outcome(&run));
        started.push(s.job.to_owned());
    }
    Ok(started)
}

/// Python `run.error or run.detail_json` in the tick's log lines
fn outcome(run: &tcroof_services::sync_status::SyncRun) -> String {
    match (&run.error, &run.detail_json) {
        (Some(e), _) if !e.is_empty() => e.clone(),
        (_, Some(d)) => d.to_string(),
        _ => "None".into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    /// a plant-local wall-clock time as a UTC instant
    fn bkk(y: i32, mo: u32, d: u32, h: u32, mi: u32) -> DateTime<Utc> {
        plant_tz().with_ymd_and_hms(y, mo, d, h, mi, 0).unwrap().with_timezone(&Utc)
    }

    #[test]
    fn daily_job_fires_only_in_its_grace_window_once() {
        let s = Schedule::at("retention", hm(3, 0));
        assert!(!s.is_due(bkk(2026, 11, 27, 2, 59), None));
        assert!(s.is_due(bkk(2026, 11, 27, 3, 0), None));
        assert!(s.is_due(bkk(2026, 11, 27, 5, 59), None));
        assert!(!s.is_due(bkk(2026, 11, 27, 6, 0), None)); // past GRACE
        // already started at/after today's slot → not again; yesterday's start → due
        assert!(!s.is_due(bkk(2026, 11, 27, 3, 30), Some(bkk(2026, 11, 27, 3, 1))));
        assert!(s.is_due(bkk(2026, 11, 27, 3, 30), Some(bkk(2026, 11, 26, 3, 1))));
    }

    #[test]
    fn every_job_with_window_and_skips() {
        let w = WorkerSettings::default();
        let sched = default_schedule(&w);
        let alarms = sched.iter().find(|s| s.job == "alarms").unwrap();
        // 08:42–08:51 skipped (history pull 08:47 − 5 min … publish 08:50 + 1 min)
        assert_eq!(alarms.skip[0], (hm(8, 42), hm(8, 51)));
        assert!(!alarms.is_due(bkk(2026, 11, 27, 8, 45), None));
        assert!(alarms.is_due(bkk(2026, 11, 27, 8, 51), None));
        assert!(!alarms.is_due(bkk(2026, 11, 27, 4, 59), None)); // before 05:00
        assert!(!alarms.is_due(bkk(2026, 11, 27, 20, 0), None)); // end exclusive
        let last = bkk(2026, 11, 27, 9, 0);
        assert!(!alarms.is_due(bkk(2026, 11, 27, 9, 9), Some(last)));
        assert!(alarms.is_due(bkk(2026, 11, 27, 9, 10), Some(last)));
    }

    #[test]
    fn weekly_job_only_on_its_weekday() {
        let w = WorkerSettings::default();
        let s = default_schedule(&w).into_iter().find(|s| s.job == "om_weekly").unwrap();
        assert!(s.is_due(bkk(2026, 11, 30, 7, 30), None)); // a Monday
        assert!(!s.is_due(bkk(2026, 11, 27, 7, 30), None)); // a Friday
    }

    #[test]
    fn schedule_order_and_pwa_clocks_match_python() {
        let w = WorkerSettings::default();
        let s = default_schedule(&w);
        let names: Vec<(&str, Option<NaiveTime>)> = s.iter().map(|x| (x.job, x.at)).collect();
        assert_eq!(names[0], ("fleet", Some(hm(5, 30))));
        assert_eq!(names[1], ("history", None));
        assert_eq!(names[4], ("history", Some(hm(8, 47))));
        assert_eq!(names[6], ("history", Some(hm(16, 47))));
        assert_eq!(names[7], ("publish_today", Some(hm(8, 50))));
        assert_eq!(names[10], ("publish_today", Some(hm(19, 30))));
        // inverter_latest is off by default; env_history and kb_ocr on
        assert!(s.iter().all(|x| x.job != "inverter_latest"));
        let env = s.iter().find(|x| x.job == "env_history").unwrap();
        assert_eq!(env.covered_by, vec!["history"]);
        assert_eq!(s.last().unwrap().job, "kb_ocr");
        let w2 = WorkerSettings { worker_latest_interval_min: 2, ..WorkerSettings::default() };
        let latest = default_schedule(&w2).into_iter().find(|x| x.job == "inverter_latest").unwrap();
        assert_eq!(latest.every, Some(Duration::minutes(5))); // never under 5
    }

    #[test]
    fn check_clock_wraps_like_python() {
        let w = WorkerSettings { check_offset_min: 30, ..WorkerSettings::default() };
        assert_eq!(check_clock(&w, 0, Duration::minutes(5)), hm(23, 25));
    }
}
