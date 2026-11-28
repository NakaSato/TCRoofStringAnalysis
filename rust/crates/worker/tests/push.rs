//! Push notifications with a fake (recording) sender against a fresh copy of the database Python
//! seeded (rust/scripts/test_pg.sh sets `TEST_DATABASE_URL`; without it the tests print a skip
//! message and pass): `push_test`, `faults_push` and the alarm push of `alarms`
//! (services/push.rs, fault_push.rs). The seed is the worker parity's (seed.d/60_push.sql); the
//! alarm log the stub would answer is written directly here. Python's counterparts:
//! backend/tests/test_push.py, test_fault_push.py. Nothing here reaches FCM.

use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Arc;

use chrono::{Duration, Utc};
use serde_json::{json, Value};
use sqlx::postgres::PgPoolOptions;
use sqlx::{Connection, Executor, PgConnection, PgPool};
use tcroof_api::Settings;
use tcroof_services::push::{self, PushError, RecordingSender, SenderSource, GONE};
use tcroof_worker::jobs::{job_faults_push, job_push_test};
use tcroof_worker::{today, Ctx, WorkerSettings};

const SEED: &str = include_str!("../../../tests/worker_parity/seed.d/60_push.sql");
static SEQ: AtomicU32 = AtomicU32::new(0);

struct Db {
    name: String,
    admin_url: String,
    pool: PgPool,
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
        let name = format!("push_{}_{}_{}", std::process::id(), SEQ.fetch_add(1, Ordering::SeqCst), Utc::now().timestamp_subsec_nanos());
        let mut admin = PgConnection::connect(&admin_url).await.unwrap();
        let mut tries = 0;
        loop {
            match admin.execute(format!(r#"CREATE DATABASE "{name}" TEMPLATE "{template}""#).as_str()).await {
                Ok(_) => break,
                Err(e) if tries < 50 && e.to_string().contains("being accessed by other users") => {
                    tries += 1;
                    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
                }
                Err(e) => panic!("CREATE DATABASE: {e}"),
            }
        }
        admin.close().await.ok();
        let pool = PgPoolOptions::new().max_connections(4).connect(&format!("{prefix}/{name}")).await.unwrap();
        sqlx::raw_sql(SEED).execute(&pool).await.expect("push seed");
        Some(Db { name, admin_url, pool })
    }

    fn ctx(&self, sender: Option<Arc<RecordingSender>>) -> Ctx {
        let mut ctx = Ctx::new(self.pool.clone(), Settings::default(), WorkerSettings::default());
        ctx.push_sender = sender.map(|s| s as Arc<dyn push::Sender>);
        ctx
    }

    async fn finish(self) {
        self.pool.close().await;
        if let Ok(mut admin) = PgConnection::connect(&self.admin_url).await {
            let _ = admin.execute(format!(r#"DROP DATABASE IF EXISTS "{}" WITH (FORCE)"#, self.name).as_str()).await;
        }
    }

    async fn tokens(&self) -> Vec<String> {
        sqlx::query_scalar("SELECT token FROM push_tokens ORDER BY token").fetch_all(&self.pool).await.unwrap()
    }
}

/// fcm_stub.py's answers, by token
fn stub_rule() -> RecordingSender {
    RecordingSender::with_rule(|m| {
        if m.token.contains("-gone") || m.token.contains("-mismatch") {
            Some(GONE.into())
        } else if m.token.contains("-bad") {
            Some("InvalidArgumentError".into())
        } else {
            None
        }
    })
}

fn get<'a>(m: &'a push::Msg, k: &str) -> &'a str {
    m.data.iter().find(|(key, _)| key == k).map(|(_, v)| v.as_str()).unwrap_or("")
}

#[tokio::test]
async fn push_test_sends_recent_requests_and_clears_all() {
    let Some(db) = Db::new().await else { return };
    let sender = Arc::new(stub_rule());
    let (status, detail) = job_push_test(db.ctx(Some(sender.clone()))).await.unwrap();
    // ptok-admin-a, ptok-admin-gone, ptok-eng-bad asked within 10 min; ptok-eng-a too long ago;
    // ptok-off belongs to an inactive user
    assert_eq!(detail, json!({"tests": 3, "sent": 1, "failed": 1, "removed": 1}));
    assert_eq!(status, "partial");
    let mut sent: Vec<String> = sender.messages().iter().map(|m| m.token.clone()).collect();
    sent.sort();
    assert_eq!(sent, ["ptok-admin-a", "ptok-admin-gone", "ptok-eng-bad"]);
    assert!(sender.messages().iter().all(|m| get(m, "tag") == "test"));
    assert!(!db.tokens().await.contains(&"ptok-admin-gone".to_string()));
    let left: Vec<String> = sqlx::query_scalar("SELECT token FROM push_tokens WHERE test_requested_at IS NOT NULL")
        .fetch_all(&db.pool)
        .await
        .unwrap();
    assert_eq!(left, ["ptok-off"]);
    // nothing left to send
    let (status, detail) = job_push_test(db.ctx(Some(sender))).await.unwrap();
    assert_eq!((status.as_str(), detail), ("ok", json!({"tests": 0})));
    db.finish().await;
}

#[tokio::test]
async fn faults_push_skips_the_raiser_and_marks_once() {
    let Some(db) = Db::new().await else { return };
    let sender = Arc::new(stub_rule());
    let (_, detail) = job_faults_push(db.ctx(Some(sender.clone()))).await.unwrap();
    assert_eq!(detail["s1_faults"], 3); // 9201, 9202, 9207 (9203 too old, 9204 pushed, 9205 closed, 9206 S2)
    let msgs = sender.messages();
    let to = |tag: &str| {
        let mut t: Vec<String> = msgs.iter().filter(|m| get(m, "tag") == tag).map(|m| m.token.clone()).collect();
        t.sort();
        t
    };
    // raised by push_eng: only the admins' active devices
    assert_eq!(to("fault-9201"), ["ptok-admin-a", "ptok-admin-gone"]);
    // a plant nobody is assigned: admins only; the title names the plant id
    assert_eq!(to("fault-9202"), ["ptok-admin-a", "ptok-admin-gone"]);
    assert!(msgs.iter().any(|m| get(m, "title") == "S1 safety fault · plant 9799"));
    // the assigned engineer and the admins
    assert_eq!(to("fault-9207"), ["ptok-admin-a", "ptok-admin-gone", "ptok-eng-a", "ptok-eng-bad", "ptok-eng-mismatch"]);
    let marked: Vec<i32> = sqlx::query_scalar("SELECT id FROM field_faults WHERE s1_pushed_at IS NOT NULL ORDER BY id")
        .fetch_all(&db.pool)
        .await
        .unwrap();
    assert_eq!(marked, [9201, 9202, 9204, 9207]);
    let (_, again) = job_faults_push(db.ctx(Some(sender))).await.unwrap();
    assert_eq!(again, json!({"s1_faults": 0}));
    db.finish().await;
}

#[tokio::test]
async fn no_sender_and_a_failed_send_mark_nothing() {
    let Some(db) = Db::new().await else { return };
    // FIREBASE_CREDENTIALS_FILE empty: counted, skipped, nothing marked
    let (status, detail) = job_faults_push(db.ctx(None)).await.unwrap();
    assert_eq!((status.as_str(), detail), ("ok", json!({"s1_faults": 3, "skipped": push::SKIPPED})));
    // FCM unreachable: the run is partial with the error, the faults are tried again next run
    let failing = Arc::new(RecordingSender::failing(PushError::new("UnknownError", "down")));
    let (status, detail) = job_faults_push(db.ctx(Some(failing))).await.unwrap();
    assert_eq!((status.as_str(), detail), ("partial", json!({"error": "UnknownError: down"})));
    let n: i64 = sqlx::query_scalar("SELECT count(*) FROM field_faults WHERE s1_pushed_at IS NOT NULL").fetch_one(&db.pool).await.unwrap();
    assert_eq!(n, 1);
    db.finish().await;
}

#[tokio::test]
async fn new_alarm_events_go_to_who_may_see_the_plant() {
    let Some(db) = Db::new().await else { return };
    let p = &db.pool;
    let day = today();
    let since = Utc::now() - Duration::minutes(1);
    // what the alarms sync would have stored this run: AL6A1 (one event of 3 reports) and a
    // warning, AL6B1 (marked already), AL6B3 (repeat due), AL6C1..C6 (one plant each)
    sqlx::raw_sql(
        "CREATE TEMP TABLE t AS SELECT (now() AT TIME ZONE 'Asia/Bangkok')::date AS d, date_trunc('minute', now() AT TIME ZONE 'Asia/Bangkok') AS n;
         INSERT INTO growatt_alarms (device_sn, plant_id, day, start_time, alarm_code, alarm_message, fault_type)
         SELECT sn, pid, t.d, t.n - m * interval '1 minute', code, msg, ft FROM t, (VALUES
           ('AL6A1', 9701, 30, '117', 'Fan fault', 'Fault'), ('AL6A1', 9701, 25, '117', NULL, NULL), ('AL6A1', 9701, 20, '117', NULL, NULL),
           ('AL6A1', 9701, 15, '305', 'Grid voltage high', 'Warning'),
           ('AL6B1', 9702, 10, '117', 'already pushed', 'Fault'), ('AL6B3', 9702, 8, '119', 'repeat due', 'Fault'),
           ('AL6C1', 9703, 6, '501', 'c', 'Fault'), ('AL6C2', 9704, 7, '502', 'c', 'Fault'), ('AL6C3', 9705, 8, '503', 'c', 'Fault'),
           ('AL6C4', 9706, 9, '504', 'c', 'Fault'), ('AL6C5', 9707, 10, '505', 'c', 'Fault'), ('AL6C6', 9708, 11, '506', 'c', 'Fault'))
           x(sn, pid, m, code, msg, ft);
         INSERT INTO growatt_alarm_syncs (device_sn, day, plant_id, synced_at, alarm_count)
         SELECT DISTINCT device_sn, day, plant_id, now(), 1 FROM growatt_alarms WHERE device_sn LIKE 'AL6%';",
    )
    .execute(p)
    .await
    .unwrap();
    let sender = Arc::new(stub_rule());
    let src = SenderSource::Given(sender.clone());
    let cfg = push::PushSettings::default();
    let d = push::notify_new_alarms(p, &cfg, day, since, &src, Utc::now()).await.unwrap();
    // A1 117, B3 119, C1..C6 = 8 events (the warning is not a pushed level, B1 was pushed)
    assert_eq!(Value::Object(d.clone())["events"], 8);
    assert_eq!(Value::Object(d)["plants"], 8);
    let msgs = sender.messages();
    // the admin has 8 plants > PUSH_MAX_PLANTS_PER_USER: one summary per device
    let admin: Vec<&push::Msg> = msgs.iter().filter(|m| m.token == "ptok-admin-a").collect();
    assert_eq!(admin.len(), 1);
    assert_eq!(get(admin[0], "title"), "New alarms at 8 plants");
    assert_eq!(get(admin[0], "body"), "Plant 9708, Push C1, Push C2 +5 more");
    // the engineer of 9701 / 9702: one message per plant and device
    let eng: Vec<&push::Msg> = msgs.iter().filter(|m| m.token == "ptok-eng-a").collect();
    assert_eq!(eng.len(), 2);
    let a = eng.iter().find(|m| get(m, "tag") == "plant-9701").unwrap();
    assert!(get(a, "body").starts_with("INV2 Fault: 117 Fan fault ("), "{}", get(a, "body"));
    let b = eng.iter().find(|m| get(m, "tag") == "plant-9702").unwrap();
    assert!(get(b, "body").starts_with("INV3 Fault: 119 repeat due ("), "{}", get(b, "body"));
    // nobody else: the unassigned engineer and the inactive admin
    assert!(msgs.iter().all(|m| m.token != "ptok-eng2" && m.token != "ptok-off"));
    // marks written; a second run pushes nothing new
    let marks: i64 = sqlx::query_scalar("SELECT count(*) FROM alarm_push_marks WHERE day = $1").bind(day).fetch_one(p).await.unwrap();
    assert_eq!(marks, 3 + 8 - 1); // seeded today 3 (B1, B2, B3), 8 written, B3 overwritten
    let again = push::notify_new_alarms(p, &cfg, day, since, &src, Utc::now()).await.unwrap();
    assert_eq!(Value::Object(again)["events"], 0);
    db.finish().await;
}
