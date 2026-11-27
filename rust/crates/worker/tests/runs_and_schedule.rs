//! The worker's run log / lock, queue, schedule tick and `retention` job against a fresh copy of
//! the database Python seeded (rust/scripts/test_pg.sh sets `TEST_DATABASE_URL`; without it the
//! tests print a skip message and pass). Python's counterparts: backend/tests/test_worker.py,
//! test_jobs.py.

use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Arc;
use std::time::Duration as StdDuration;

use chrono::{Duration, Utc};
use serde_json::Value;
use sqlx::postgres::PgPoolOptions;
use sqlx::{Connection, Executor, PgConnection, PgPool};
use tcroof_api::Settings;
use tcroof_worker::runs::{self, ClaimError, ABANDONED};
use tcroof_worker::schedule::{tick, Schedule};
use tcroof_worker::{plant_now, Ctx, WorkerSettings};

static SEQ: AtomicU32 = AtomicU32::new(0);

struct Db {
    name: String,
    admin_url: String,
    pool: PgPool,
    ctx: Ctx,
}

impl Db {
    async fn new() -> Option<Db> {
        let Ok(url) = std::env::var("TEST_DATABASE_URL") else {
            eprintln!("skipped: TEST_DATABASE_URL is not set (run rust/scripts/test_pg.sh)");
            return None;
        };
        let url = tcroof_db::normalize_url(&url).unwrap();
        let (prefix, template) = url.rsplit_once('/').unwrap();
        let admin_url = format!("{prefix}/postgres");
        let name = format!("w_{}_{}_{}", std::process::id(), SEQ.fetch_add(1, Ordering::SeqCst), Utc::now().timestamp_subsec_nanos());
        let mut admin = PgConnection::connect(&admin_url).await.unwrap();
        let mut tries = 0;
        loop {
            match admin.execute(format!(r#"CREATE DATABASE "{name}" TEMPLATE "{template}""#).as_str()).await {
                Ok(_) => break,
                Err(e) if tries < 50 && e.to_string().contains("being accessed by other users") => {
                    tries += 1;
                    tokio::time::sleep(StdDuration::from_millis(100)).await;
                }
                Err(e) => panic!("CREATE DATABASE: {e}"),
            }
        }
        admin.close().await.ok();
        let db_url = format!("{prefix}/{name}");
        let pool = PgPoolOptions::new().max_connections(4).connect(&db_url).await.unwrap();
        let settings = Settings { database_url: db_url, ..Settings::default() };
        let ctx = Ctx { pool: pool.clone(), settings: Arc::new(settings), worker: Arc::new(WorkerSettings::default()) };
        Some(Db { name, admin_url, pool, ctx })
    }

    async fn finish(self) {
        self.pool.close().await;
        if let Ok(mut admin) = PgConnection::connect(&self.admin_url).await {
            let _ = admin.execute(format!(r#"DROP DATABASE IF EXISTS "{}" WITH (FORCE)"#, self.name).as_str()).await;
        }
    }

    async fn status(&self, id: i32) -> (String, Option<String>) {
        sqlx::query_as("SELECT status, error FROM sync_runs WHERE id = $1").bind(id).fetch_one(&self.pool).await.unwrap()
    }
}

#[tokio::test]
async fn claim_is_a_lock_and_stale_runs_are_failed() {
    let Some(db) = Db::new().await else { return };
    let p = &db.pool;
    let first = runs::claim(p, "retention", "cli", None).await.unwrap();
    match runs::claim(p, "retention", "cli", None).await {
        Err(ClaimError::Busy(m)) => assert!(m.starts_with(&format!("retention is already running (run {first}, since ")), "{m}"),
        other => panic!("expected Busy, got {other:?}"),
    }
    // a queued run blocks too
    assert!(matches!(runs::enqueue(p, "retention", "api", None).await, Err(ClaimError::Busy(_))));
    assert!(matches!(runs::claim(p, "nope", "cli", None).await, Err(ClaimError::UnknownJob(_))));
    // 3 h later the running row is stale: failed as abandoned, the new claim goes through
    let later = Utc::now() + Duration::hours(3);
    let second = runs::claim(p, "retention", "schedule", Some(later)).await.unwrap();
    assert_eq!(db.status(first).await, ("failed".into(), Some(ABANDONED.into())));
    assert_eq!(db.status(second).await.0, "running");
    // last_started skips the abandoned run
    sqlx::query("DELETE FROM sync_runs WHERE id = $1").bind(second).execute(p).await.unwrap();
    assert_eq!(runs::last_started(p, "retention").await.unwrap(), None);
    db.finish().await;
}

#[tokio::test]
async fn queued_runs_are_claimed_oldest_first_one_per_job() {
    let Some(db) = Db::new().await else { return };
    let p = &db.pool;
    let now = Utc::now();
    let a = runs::enqueue(p, "retention", "api", Some(now - Duration::minutes(2))).await.unwrap();
    // a queued run whose job is running now waits (Python `_check_free` → JobBusy → continue)
    let running = runs::claim(p, "om_plans", "schedule", Some(now - Duration::minutes(5))).await.unwrap();
    let b: i32 = sqlx::query_scalar("INSERT INTO sync_runs (job, trigger, status, started_at) VALUES ('om_plans', 'api', 'queued', $1) RETURNING id")
        .bind(now - Duration::minutes(1))
        .fetch_one(p)
        .await
        .unwrap();
    let c = runs::enqueue(p, "fleet", "api", Some(now - Duration::minutes(1))).await.unwrap();
    let unknown: i32 = sqlx::query_scalar("INSERT INTO sync_runs (job, trigger, status, started_at) VALUES ('nope', 'api', 'queued', $1) RETURNING id")
        .bind(now)
        .fetch_one(p)
        .await
        .unwrap();
    let stale = runs::enqueue(p, "history", "api", Some(now - Duration::hours(3))).await.unwrap();
    let ids = runs::claim_queued(p, Some(now)).await.unwrap();
    assert_eq!(ids, vec![a, c]);
    assert_eq!(db.status(a).await.0, "running");
    assert_eq!(db.status(b).await.0, "queued"); // waits for the next tick
    assert_eq!(db.status(unknown).await, ("failed".into(), Some("unknown job 'nope'".into())));
    assert_eq!(db.status(stale).await, ("failed".into(), Some("never picked up (is the worker running?)".into())));
    // worker start: running runs are abandoned, queued ones kept
    assert_eq!(runs::fail_abandoned(p, None).await.unwrap(), vec![a, running, c]);
    assert_eq!(db.status(a).await, ("failed".into(), Some(ABANDONED.into())));
    assert_eq!(db.status(b).await.0, "queued");
    db.finish().await;
}

#[tokio::test]
async fn a_job_not_ported_fails_its_run_and_names_the_phase() {
    let Some(db) = Db::new().await else { return };
    let run = runs::run_job(&db.ctx, "history", "cli").await.unwrap();
    assert_eq!(run.status, "failed");
    let err = run.error.unwrap();
    assert!(err.starts_with("NotImplementedError: job history is not ported to Rust yet (Phase 4.2"), "{err}");
    assert_eq!(run.detail_json.unwrap()["phase"], "4.2");
    assert!(run.finished_at.is_some());
    db.finish().await;
}

#[tokio::test]
async fn retention_deletes_only_what_is_past_each_cutoff() {
    let Some(db) = Db::new().await else { return };
    let p = &db.pool;
    // plant-local today 00:00 minus 90 days is the reading cutoff, 30 for strings, 7 for raw
    let today = plant_now().date_naive();
    let at = |days: i64, h: u32| (today - Duration::days(days)).and_hms_opt(h, 0, 0).unwrap();
    sqlx::query("INSERT INTO growatt_plants (plant_id, name, synced_at) VALUES (1, 'p', now())").execute(p).await.unwrap();
    sqlx::query("INSERT INTO growatt_inverters (device_sn, plant_id, synced_at) VALUES ('INV1', 1, now())").execute(p).await.unwrap();
    for (d, h) in [(91, 12), (90, 0), (89, 23)] {
        sqlx::query("INSERT INTO growatt_inverter_readings (device_sn, timestamp) VALUES ('INV1', $1)").bind(at(d, h)).execute(p).await.unwrap();
    }
    for (d, h) in [(31, 9), (30, 0), (29, 9)] {
        sqlx::query("INSERT INTO growatt_string_records (device_sn, timestamp, strings) VALUES ('INV1', $1, '[]')")
            .bind(at(d, h))
            .execute(p)
            .await
            .unwrap();
    }
    // runs: an old finished one of a job with a newer run goes, the newest of each job stays
    for (job, days) in [("history", 100), ("history", 1), ("fleet", 100)] {
        sqlx::query("INSERT INTO sync_runs (job, trigger, status, started_at, finished_at) VALUES ($1, 'schedule', 'ok', $2, $2)")
            .bind(job)
            .bind(Utc::now() - Duration::days(days))
            .execute(p)
            .await
            .unwrap();
    }
    let run = runs::run_job(&db.ctx, "retention", "cli").await.unwrap();
    assert_eq!(run.status, "ok", "{:?}", run.error);
    let d: Value = run.detail_json.unwrap();
    assert_eq!(d["inverter_rows"], 1);
    assert_eq!(d["string_records"], 1);
    assert_eq!(d["sync_runs"], 1);
    assert_eq!(d["cutoff"], format!("{}T00:00:00", today - Duration::days(90)));
    assert_eq!(d["string_cutoff"], format!("{}T00:00:00", today - Duration::days(30)));
    for k in ["env_rows", "meter_rows", "raw_rows", "google_weather_rows", "alarm_rows", "pwa_check_slots", "growatt_power_rows", "alarm_push_marks", "om_push_marks", "log_rows"] {
        assert_eq!(d[k], 0, "{k}");
    }
    let left: i64 = sqlx::query_scalar("SELECT count(*) FROM growatt_inverter_readings").fetch_one(p).await.unwrap();
    assert_eq!(left, 2);
    db.finish().await;
}

#[tokio::test]
async fn tick_runs_queued_first_then_due_jobs_once() {
    let Some(db) = Db::new().await else { return };
    let p = &db.pool;
    let now = Utc::now();
    let local = now.with_timezone(&tcroof_worker::plant_tz());
    // a daily slot one minute ago (inside GRACE)
    let slot = (local - Duration::minutes(1)).time();
    let slot = chrono::NaiveTime::from_hms_opt(chrono::Timelike::hour(&slot), chrono::Timelike::minute(&slot), 0).unwrap();
    let schedule = vec![Schedule::at("retention", slot)];
    let queued = runs::enqueue(p, "om_plans", "api", Some(now)).await.unwrap();
    let started = tick(&db.ctx, &schedule, now).await.unwrap();
    assert_eq!(started, vec!["om_plans".to_owned(), "retention".to_owned()]);
    assert_eq!(db.status(queued).await.0, "failed"); // not ported yet
    let ret: (String, String) = sqlx::query_as("SELECT status, trigger FROM sync_runs WHERE job = 'retention'").fetch_one(p).await.unwrap();
    assert_eq!(ret, ("ok".into(), "schedule".into()));
    // the slot has its run: nothing is due on the next tick
    assert!(tick(&db.ctx, &schedule, now + Duration::minutes(1)).await.unwrap().is_empty());
    db.finish().await;
}
