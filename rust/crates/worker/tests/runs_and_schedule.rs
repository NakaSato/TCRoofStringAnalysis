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
        let ctx = Ctx::new(pool.clone(), settings, WorkerSettings::default());
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
    let run = runs::run_job(&db.ctx, "kb_ocr", "cli").await.unwrap();
    assert_eq!(run.status, "failed");
    let err = run.error.unwrap();
    assert!(err.starts_with("NotImplementedError: job kb_ocr is not ported to Rust yet (Phase 7"), "{err}");
    assert_eq!(run.detail_json.unwrap()["phase"], "7");
    assert!(run.finished_at.is_some());
    db.finish().await;
}

#[tokio::test]
async fn publish_yesterday_writes_the_json_sink_and_counts_writes() {
    let Some(db) = Db::new().await else { return };
    // the JSON sink in a temp folder, never data/firestore_export, never Firestore
    let dir = std::env::temp_dir().join(format!("tcroof-worker-publish-{}", std::process::id()));
    let mut settings = (*db.ctx.settings).clone();
    settings.publish_sink = "json".into();
    settings.publish_json_dir = dir.to_string_lossy().into_owned();
    let ctx = Ctx { settings: Arc::new(settings), ..db.ctx.clone() };
    sqlx::query("INSERT INTO growatt_plants (plant_id, name, synced_at) VALUES (77, 'p', now())").execute(&db.pool).await.unwrap();
    let run = runs::run_job(&ctx, "publish_yesterday", "cli").await.unwrap();
    assert_eq!(run.status, "ok", "{:?}", run.error);
    let d = run.detail_json.unwrap();
    let day = (plant_now().date_naive() - Duration::days(1)).to_string();
    assert_eq!(d["day"], day.as_str());
    assert_eq!(d["sink"], "json");
    // plants/77, config/fleet_module, config/tariff, daily/{day}/plants/77 (no data, but its checks
    // are built: every plant has a doc then), daily/{day}
    assert_eq!(d["written"], 5);
    let fleet: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(dir.join(format!("daily/{day}.json"))).unwrap()).unwrap();
    assert_eq!(fleet["plant_count"], 1);
    assert_eq!(fleet["checks_ready"], serde_json::json!(["09", "13", "17"]));
    assert!(fleet["published_at"].is_string());
    // every check of yesterday frozen for the plant, even without inverters
    let n: i64 = sqlx::query_scalar("SELECT count(*) FROM pwa_check_slots WHERE plant_id = 77").fetch_one(&db.pool).await.unwrap();
    assert_eq!(n, 3);
    // a second run writes nothing: every document unchanged
    let again = runs::run_job(&ctx, "publish_yesterday", "cli").await.unwrap();
    assert_eq!(again.detail_json.unwrap()["unchanged"], 5);
    let _ = std::fs::remove_dir_all(&dir);
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

// --------------------------------------------------------------------------- google_weather / pwa_sheet (4.3)

/// A one-route Google Weather stand-in on 127.0.0.1 (a thread): `history/hours:lookup` answers
/// HTTP 429 for latitude 17.x, else `hours` rows of 2026-11-27 from 06:00 on. Never the real API.
fn weather_mock() -> String {
    use std::io::{Read, Write};
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let addr = listener.local_addr().unwrap();
    std::thread::spawn(move || {
        for s in listener.incoming() {
            let Ok(mut s) = s else { return };
            let mut buf = vec![0u8; 8192];
            let n = s.read(&mut buf).unwrap_or(0);
            let req = String::from_utf8_lossy(&buf[..n]).to_string();
            let line = req.lines().next().unwrap_or("").to_owned();
            let q = |k: &str| line.split(['?', '&', ' ']).find_map(|p| p.strip_prefix(&format!("{k}="))).unwrap_or("").to_owned();
            let (status, body) = if q("location.latitude").starts_with("17.") {
                ("429 Too Many Requests", serde_json::json!({"error": {"code": 429, "message": "Quota exceeded"}}))
            } else {
                let n: u32 = q("hours").parse().unwrap_or(1);
                let rows: Vec<Value> = (0..n)
                    .map(|i| {
                        serde_json::json!({
                            "displayDateTime": {"year": 2026, "month": 11, "day": 27 + (6 + i) / 24, "hours": (6 + i) % 24},
                            "weatherCondition": {"type": "CLEAR"}, "temperature": {"degrees": 30.0 + f64::from(i)},
                            "precipitation": {"qpf": {"quantity": 0.5}}
                        })
                    })
                    .collect();
                ("200 OK", serde_json::json!({"historyHours": rows}))
            };
            let b = body.to_string();
            let resp = format!("HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{b}", b.len());
            let _ = s.write_all(resp.as_bytes());
        }
    });
    format!("http://{addr}/v1/")
}

#[tokio::test]
async fn google_weather_and_pwa_sheet_are_skipped_when_not_configured() {
    let Some(db) = Db::new().await else { return };
    // Settings::default() has no GOOGLE_WEATHER_API_KEY
    let run = runs::run_job(&db.ctx, "google_weather", "cli").await.unwrap();
    assert_eq!(run.status, "ok");
    assert_eq!(run.detail_json.unwrap()["skipped"], "GOOGLE_WEATHER_API_KEY not set");
    let cfg = tcroof_services::pwa_sheet::PwaSheetConfig::default(); // no PWA_SHEET_ID
    assert_eq!(tcroof_services::pwa_sheet::run_for_now(&db.pool, &cfg, plant_now().naive_local()).await.unwrap(), None);
    db.finish().await;
}

#[tokio::test]
async fn google_weather_history_stores_daytime_hours_and_stops_at_a_429() {
    use tcroof_clients::google_weather::GoogleWeatherClient;
    use tcroof_services::google_weather_history::{sync_history, HistoryConfig, HistoryError};
    let Some(db) = Db::new().await else { return };
    let p = &db.pool;
    let base = weather_mock();
    let cfg = HistoryConfig { api_key: "test-key".into(), base_url: base.clone(), monthly_budget: 30000, history_hours_per_day: 4000, cells: Default::default() };
    let now = chrono::NaiveDate::from_ymd_opt(2026, 11, 28).unwrap().and_hms_opt(18, 15, 0).unwrap(); // 13 h back
    let client = || Arc::new(GoogleWeatherClient::new("test-key", &base, 5.0).unwrap());
    let cells = |v: &[(&str, f64)]| Some(v.iter().map(|(k, lat)| ((*k).to_owned(), (*lat, 100.0))).collect());
    let billed = || async {
        let n: i64 = sqlx::query_scalar("SELECT COALESCE(sum(calls), 0)::bigint FROM external_api_call_counts WHERE api = 'google_weather_history'")
            .fetch_one(p)
            .await
            .unwrap();
        n
    };

    // one good cell: 13 hours asked, the 06–17 ones stored (18:00 is outside the daytime window)
    let (status, d) = sync_history(p, client(), &cfg, cells(&[("13.00,100.00", 13.0)]), 8, now).await.unwrap();
    assert_eq!(status, "ok");
    assert_eq!((d["lookback_hours"].as_u64(), d["hours_returned"].as_u64(), d["hours_stored"].as_u64()), (Some(13), Some(13), Some(12)));
    assert_eq!(d["calls"], 1);
    let n: i64 = sqlx::query_scalar("SELECT count(*) FROM google_weather_hourly WHERE cell_key = '13.00,100.00'").fetch_one(p).await.unwrap();
    assert_eq!(n, 12);
    assert_eq!(billed().await, 1);

    // the quota cell goes first (nothing stored yet), one worker: its 429 stops the next call, and
    // the refused call is not billed
    let err = sync_history(p, client(), &cfg, cells(&[("17.00,100.00", 17.0), ("13.00,100.00", 13.0)]), 1, now).await.unwrap_err();
    assert!(matches!(err, HistoryError::AllFailed(ref m) if m.contains("HTTP 429")), "{err}");
    assert_eq!(billed().await, 1);
    db.finish().await;
}
