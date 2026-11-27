//! Integration tests: the axum Router driven in-process against a Postgres database whose schema
//! and seed came from Python (rust/scripts/schema.sh). Run them with rust/scripts/test_pg.sh.
//!
//! `TEST_DATABASE_URL` names the seeded database. Each test copies it into a fresh database
//! (`CREATE DATABASE … TEMPLATE`), so no test sees another's rows. Without the variable the DB
//! tests print a skip message and pass, so a plain `cargo test` still works.
//!
//! The expected behaviour is Python's: backend/app/main.py (health), backend/app/services/jobs.py
//! (`worker_health`), backend/app/api/routes/auth.py, backend/app/auth.py and
//! backend/app/services/users.py (`user_out`).

use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Arc;
use std::time::Duration;

use axum::body::Body;
use axum::http::{header, HeaderMap, Method, Request, StatusCode};
use axum::Router;
use chrono::{DateTime, SubsecRound, Utc};
use serde_json::{json, Value};
use sha2::Sha256;
use sqlx::postgres::PgPoolOptions;
use sqlx::{Connection, Executor, PgConnection, PgPool};
use tower::ServiceExt;

use tcroof_api::{app, AppState, Settings};

const SECRET: &str = "integration-test-secret";

fn settings(database_url: &str) -> Settings {
    Settings {
        app_env: "dev".into(),
        database_url: database_url.into(),
        jwt_secret_key: SECRET.into(),
        jwt_algorithm: "HS256".into(),
        jwt_expire_minutes: 60,
        port: 0,
    }
}

fn router(pool: PgPool, url: &str) -> Router {
    app(AppState { pool, settings: Arc::new(settings(url)) })
}

// ------------------------------------------------------------------------------- fresh database

/// A fresh copy of the seeded database, dropped by `finish`.
struct TestDb {
    name: String,
    admin_url: String,
    pool: PgPool,
    app: Router,
}

static SEQ: AtomicU32 = AtomicU32::new(0);

/// Split `postgres://…/dbname?x` into (`postgres://…/postgres?x`, `dbname`, `postgres://…/{new}?x` maker).
fn split_url(url: &str) -> (String, String, impl Fn(&str) -> String) {
    let url = tcroof_db::normalize_url(url).expect("TEST_DATABASE_URL must be a Postgres URL");
    let (base, query) = match url.split_once('?') {
        Some((b, q)) => (b.to_owned(), format!("?{q}")),
        None => (url.clone(), String::new()),
    };
    let (prefix, db) = base.rsplit_once('/').expect("TEST_DATABASE_URL needs a database name");
    let prefix = prefix.to_owned();
    let admin = format!("{prefix}/postgres{query}");
    (admin, db.to_owned(), move |name: &str| format!("{prefix}/{name}{query}"))
}

impl TestDb {
    async fn new() -> Option<TestDb> {
        let Ok(url) = std::env::var("TEST_DATABASE_URL") else {
            eprintln!("skipped: TEST_DATABASE_URL is not set (run rust/scripts/test_pg.sh)");
            return None;
        };
        let (admin_url, template, url_for) = split_url(&url);
        let name = format!(
            "t_{}_{}_{}",
            std::process::id(),
            SEQ.fetch_add(1, Ordering::SeqCst),
            Utc::now().timestamp_subsec_nanos()
        );
        let mut admin = PgConnection::connect(&admin_url).await.expect("connect to the postgres database");
        // Two copies of one template at the same moment can collide ("being accessed by other users").
        let mut tries = 0;
        loop {
            match admin.execute(format!(r#"CREATE DATABASE "{name}" TEMPLATE "{template}""#).as_str()).await {
                Ok(_) => break,
                Err(e) if tries < 50 && e.to_string().contains("being accessed by other users") => {
                    tries += 1;
                    tokio::time::sleep(Duration::from_millis(100)).await;
                }
                Err(e) => panic!("CREATE DATABASE {name} TEMPLATE {template}: {e}"),
            }
        }
        admin.close().await.ok();
        let db_url = url_for(&name);
        let pool = PgPoolOptions::new().max_connections(4).connect(&db_url).await.expect("connect to the test database");
        let app = router(pool.clone(), &db_url);
        Some(TestDb { name, admin_url, pool, app })
    }

    async fn finish(self) {
        self.pool.close().await;
        if let Ok(mut admin) = PgConnection::connect(&self.admin_url).await {
            let _ = admin.execute(format!(r#"DROP DATABASE IF EXISTS "{}" WITH (FORCE)"#, self.name).as_str()).await;
            admin.close().await.ok();
        }
    }

    async fn user_id(&self, username: &str) -> i32 {
        sqlx::query_scalar("SELECT id FROM users WHERE username = $1")
            .bind(username)
            .fetch_one(&self.pool)
            .await
            .expect("seeded user")
    }

    /// A user with the password `pw`, hashed the Python way (fewer iterations; the count is in the hash).
    async fn add_user(&self, username: &str, pw: &str, role: &str, active: bool) -> i32 {
        let salt = "0123456789abcdef0123456789abcdef";
        let mut dk = [0u8; 32];
        pbkdf2::pbkdf2_hmac::<Sha256>(pw.as_bytes(), salt.as_bytes(), 1000, &mut dk);
        let hashed = format!("pbkdf2_sha256$1000${salt}${}", hex::encode(dk));
        sqlx::query_scalar(
            "INSERT INTO users (username, email, full_name, hashed_password, role, is_active, store_keeper, created_at) \
             VALUES ($1, $2, $3, $4, $5, $6, false, now()) RETURNING id",
        )
        .bind(username)
        .bind(format!("{username}@example.test"))
        .bind(format!("Test {username}"))
        .bind(hashed)
        .bind(role)
        .bind(active)
        .fetch_one(&self.pool)
        .await
        .expect("insert user")
    }

    async fn add_run(&self, job: &str, status: &str, finished_at: Option<DateTime<Utc>>) {
        let started = finished_at.unwrap_or_else(Utc::now) - chrono::Duration::minutes(5);
        sqlx::query("INSERT INTO sync_runs (job, trigger, status, started_at, finished_at) VALUES ($1, 'schedule', $2, $3, $4)")
            .bind(job)
            .bind(status)
            .bind(started)
            .bind(finished_at)
            .execute(&self.pool)
            .await
            .expect("insert sync run");
    }
}

// ----------------------------------------------------------------------------------- requests

struct Res {
    status: StatusCode,
    headers: HeaderMap,
    body: Value,
}

async fn send(app: &Router, method: Method, uri: &str, token: Option<&str>, body: Option<Value>) -> Res {
    let mut req = Request::builder().method(method).uri(uri);
    if let Some(t) = token {
        req = req.header(header::AUTHORIZATION, t);
    }
    let req = match body {
        Some(b) => req.header(header::CONTENT_TYPE, "application/json").body(Body::from(b.to_string())),
        None => req.body(Body::empty()),
    }
    .unwrap();
    let res = app.clone().oneshot(req).await.unwrap();
    let status = res.status();
    let headers = res.headers().clone();
    let bytes = axum::body::to_bytes(res.into_body(), 1 << 20).await.unwrap();
    let body = if bytes.is_empty() { Value::Null } else { serde_json::from_slice(&bytes).expect("JSON body") };
    Res { status, headers, body }
}

async fn login(app: &Router, body: Value) -> Res {
    send(app, Method::POST, "/auth/login", None, Some(body)).await
}

async fn me(app: &Router, authorization: Option<&str>) -> Res {
    send(app, Method::GET, "/api/auth/me", authorization, None).await
}

fn bearer(res: &Res) -> String {
    format!("Bearer {}", res.body["access_token"].as_str().expect("access_token"))
}

fn www_auth(res: &Res) -> Option<&str> {
    res.headers.get(header::WWW_AUTHENTICATE).and_then(|v| v.to_str().ok())
}

// -------------------------------------------------------------------------- no database needed

/// A pool that can never connect (port 1), failing fast.
fn dead_pool() -> PgPool {
    PgPoolOptions::new()
        .acquire_timeout(Duration::from_secs(2))
        .connect_lazy("postgres://nobody:x@127.0.0.1:1/none")
        .unwrap()
}

#[tokio::test]
async fn health_at_root_and_api() {
    let app = router(dead_pool(), "postgres://nobody:x@127.0.0.1:1/none");
    for uri in ["/health", "/api/health"] {
        let r = send(&app, Method::GET, uri, None, None).await;
        assert_eq!(r.status, StatusCode::OK, "{uri}");
        assert_eq!(
            r.body,
            json!({"status": "ok", "service": "TC Roof Solar PV String & O&M Engineering API", "version": "1.0.0"}),
            "{uri}"
        );
    }
}

#[tokio::test]
async fn worker_health_without_database_is_503() {
    let app = router(dead_pool(), "postgres://nobody:x@127.0.0.1:1/none");
    for uri in ["/health/worker", "/api/health/worker"] {
        let r = send(&app, Method::GET, uri, None, None).await;
        assert_eq!(r.status, StatusCode::SERVICE_UNAVAILABLE, "{uri}");
        assert_eq!(r.body, json!({"ok": false, "last_history_at": null, "error": "database unavailable"}));
    }
}

// ------------------------------------------------------------------------------------- login

#[tokio::test]
async fn login_by_username_email_and_loose_identifier() {
    let Some(db) = TestDb::new().await else { return };
    let admin_id = db.user_id("admin").await;
    let engineer_id = db.user_id("engineer").await;

    let admin_out = json!({
        "id": admin_id, "username": "admin", "email": "admin@tcroofsolar.com",
        "full_name": "Chanthawat W. (O&M Lead Engineer)", "role": "admin",
        "is_active": true, "store_keeper": false, "plant_ids": null,
    });
    let engineer_out = json!({
        "id": engineer_id, "username": "engineer", "email": "engineer@tcroofsolar.com",
        "full_name": "Anucha P. (Senior O&M Engineer)", "role": "engineer",
        "is_active": true, "store_keeper": false, "plant_ids": [],
    });

    let cases = [
        (json!({"username": "admin", "password": "admin123"}), &admin_out),
        (json!({"email": "admin@tcroofsolar.com", "password": "admin123"}), &admin_out),
        // either field takes either form, case and surrounding spaces ignored
        (json!({"username": "  ADMIN@TCRoofSolar.com ", "password": "admin123"}), &admin_out),
        (json!({"email": " Admin", "password": "admin123"}), &admin_out),
        // an empty username falls through to the email (Python `username or email`)
        (json!({"username": "", "email": "ENGINEER", "password": "engineer123"}), &engineer_out),
        (json!({"username": "engineer", "password": "engineer123"}), &engineer_out),
        (json!({"username": "Engineer@tcroofsolar.com", "password": "engineer123"}), &engineer_out),
    ];
    for (body, want) in cases {
        let r = login(&db.app, body.clone()).await;
        assert_eq!(r.status, StatusCode::OK, "{body}: {}", r.body);
        assert_eq!(r.body["token_type"], "bearer", "{body}");
        assert_eq!(&r.body["user"], want, "{body}");
        assert_eq!(r.body.as_object().unwrap().len(), 3, "{body}: {}", r.body);
        // the token works on /auth/me and returns the same user
        let m = me(&db.app, Some(&bearer(&r))).await;
        assert_eq!(m.status, StatusCode::OK, "{body}");
        assert_eq!(&m.body, want, "{body}");
    }
    // also mounted under /api
    let r = send(&db.app, Method::POST, "/api/auth/login", None, Some(json!({"username": "admin", "password": "admin123"}))).await;
    assert_eq!(r.status, StatusCode::OK);
    db.finish().await;
}

#[tokio::test]
async fn login_failures() {
    let Some(db) = TestDb::new().await else { return };
    db.add_user("sleeper", "sleeper-pass", "engineer", false).await;
    db.add_user("awake", "awake-pass", "engineer", true).await;

    // the helper's hash works: an active user signs in
    let ok = login(&db.app, json!({"username": "awake", "password": "awake-pass"})).await;
    assert_eq!(ok.status, StatusCode::OK, "{}", ok.body);

    for body in [
        json!({"username": "admin", "password": "wrong"}),
        json!({"username": "admin", "password": ""}),
        json!({"username": "nobody", "password": "admin123"}),
        json!({"email": "engineer@tcroofsolar.com", "password": "admin123"}),
        // a disabled account answers exactly like a wrong password
        json!({"username": "sleeper", "password": "sleeper-pass"}),
    ] {
        let r = login(&db.app, body.clone()).await;
        assert_eq!(r.status, StatusCode::UNAUTHORIZED, "{body}");
        assert_eq!(r.body, json!({"detail": "Invalid username or password"}), "{body}");
        assert_eq!(www_auth(&r), None, "{body}: a failed login sends no WWW-Authenticate");
    }

    for body in [
        json!({"username": "", "password": "admin123"}),
        json!({"username": "   ", "password": "admin123"}),
        json!({"password": "admin123"}),
        json!({"username": null, "email": "", "password": "admin123"}),
    ] {
        let r = login(&db.app, body.clone()).await;
        assert_eq!(r.status, StatusCode::UNPROCESSABLE_ENTITY, "{body}");
        assert_eq!(r.body, json!({"detail": "Username is required"}), "{body}");
    }
    // malformed bodies are 422 too (FastAPI validation)
    for body in [json!({"username": "admin"}), json!({"username": 5, "password": "x"}), json!([])] {
        let r = login(&db.app, body.clone()).await;
        assert_eq!(r.status, StatusCode::UNPROCESSABLE_ENTITY, "{body}");
    }
    db.finish().await;
}

// ---------------------------------------------------------------------------------- /auth/me

#[tokio::test]
async fn me_requires_a_valid_token_of_an_active_user() {
    let Some(db) = TestDb::new().await else { return };

    for auth in [None, Some("Bearer "), Some("Basic YWRtaW46YWRtaW4xMjM="), Some("token-without-scheme")] {
        let r = me(&db.app, auth).await;
        assert_eq!(r.status, StatusCode::UNAUTHORIZED, "{auth:?}");
        assert_eq!(r.body, json!({"detail": "Authentication required"}), "{auth:?}");
        assert_eq!(www_auth(&r), Some("Bearer"), "{auth:?}");
    }

    // a garbage token and one signed with another key: 401 + WWW-Authenticate, PyJWT-style detail
    let other = {
        // the same database, a different signing key
        let s =Settings { jwt_secret_key: "another-secret".into(), ..settings("unused") };
        let a = app(AppState { pool: db.pool.clone(), settings: Arc::new(s) });
        bearer(&login(&a, json!({"username": "admin", "password": "admin123"})).await)
    };
    let expired = {
        let s = Settings { jwt_expire_minutes: -1, ..settings("unused") };
        let a = app(AppState { pool: db.pool.clone(), settings: Arc::new(s) });
        bearer(&login(&a, json!({"username": "admin", "password": "admin123"})).await)
    };
    for (auth, why) in [
        ("Bearer not-a-jwt", "Not enough segments"),
        (other.as_str(), "Signature verification failed"),
        (expired.as_str(), "Signature has expired"),
    ] {
        let r = me(&db.app, Some(auth)).await;
        assert_eq!(r.status, StatusCode::UNAUTHORIZED, "{auth}");
        assert_eq!(r.body, json!({"detail": format!("Invalid or expired authentication token: {why}")}));
        assert_eq!(www_auth(&r), Some("Bearer"), "{auth}");
    }

    // a valid token whose user was disabled afterwards: 401 without WWW-Authenticate
    let id = db.add_user("leaver", "leaver-pass", "engineer", true).await;
    let r = login(&db.app, json!({"username": "leaver", "password": "leaver-pass"})).await;
    assert_eq!(r.status, StatusCode::OK);
    let token = bearer(&r);
    assert_eq!(me(&db.app, Some(&token)).await.status, StatusCode::OK);
    sqlx::query("UPDATE users SET is_active = false WHERE id = $1").bind(id).execute(&db.pool).await.unwrap();
    let r = me(&db.app, Some(&token)).await;
    assert_eq!(r.status, StatusCode::UNAUTHORIZED);
    assert_eq!(r.body, json!({"detail": "User account not found or inactive"}));
    assert_eq!(www_auth(&r), None);
    // and the deleted user
    sqlx::query("DELETE FROM users WHERE id = $1").bind(id).execute(&db.pool).await.unwrap();
    let r = me(&db.app, Some(&token)).await;
    assert_eq!(r.status, StatusCode::UNAUTHORIZED);
    assert_eq!(r.body, json!({"detail": "User account not found or inactive"}));

    // the scheme is case-insensitive (HTTPBearer)
    let admin = login(&db.app, json!({"username": "admin", "password": "admin123"})).await;
    let lower = bearer(&admin).replacen("Bearer", "bearer", 1);
    assert_eq!(me(&db.app, Some(&lower)).await.status, StatusCode::OK);
    db.finish().await;
}

#[tokio::test]
async fn engineer_plant_ids_are_sorted_assignments_admin_null() {
    let Some(db) = TestDb::new().await else { return };
    let engineer_id = db.user_id("engineer").await;
    let admin_id = db.user_id("admin").await;
    for (uid, pid) in [(engineer_id, 30), (engineer_id, 5), (engineer_id, 1200), (engineer_id, 12), (admin_id, 7)] {
        sqlx::query("INSERT INTO user_plant_assignments (user_id, plant_id, assigned_by, created_at) VALUES ($1, $2, 'test', now())")
            .bind(uid)
            .bind(pid)
            .execute(&db.pool)
            .await
            .unwrap();
    }
    let e = login(&db.app, json!({"username": "engineer", "password": "engineer123"})).await;
    assert_eq!(e.body["user"]["plant_ids"], json!([5, 12, 30, 1200]));
    assert_eq!(me(&db.app, Some(&bearer(&e))).await.body["plant_ids"], json!([5, 12, 30, 1200]));
    // an admin sees every plant: null, even with assignment rows
    let a = login(&db.app, json!({"username": "admin", "password": "admin123"})).await;
    assert_eq!(a.body["user"]["plant_ids"], Value::Null);
    assert_eq!(me(&db.app, Some(&bearer(&a))).await.body["plant_ids"], Value::Null);
    db.finish().await;
}

// ----------------------------------------------------------------------------- /health/worker

async fn worker(db: &TestDb) -> Res {
    let r = send(&db.app, Method::GET, "/health/worker", None, None).await;
    let r2 = send(&db.app, Method::GET, "/api/health/worker", None, None).await;
    assert_eq!((r.status, &r.body), (r2.status, &r2.body), "/health/worker and /api/health/worker differ");
    r
}

fn last_at(r: &Res) -> DateTime<Utc> {
    let s = r.body["last_history_at"].as_str().expect("last_history_at");
    assert!(s.ends_with("+00:00"), "Python isoformat of a UTC time: {s}");
    DateTime::parse_from_rfc3339(s).unwrap().with_timezone(&Utc)
}

#[tokio::test]
async fn worker_health_no_history_run() {
    let Some(db) = TestDb::new().await else { return };
    // runs that don't count: another job, a running and a failed history run
    db.add_run("fleet", "ok", Some(Utc::now())).await;
    db.add_run("history", "running", None).await;
    db.add_run("history", "failed", Some(Utc::now())).await;
    let r = worker(&db).await;
    assert_eq!(r.status, StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(r.body, json!({"ok": false, "last_history_at": null}));
    db.finish().await;
}

#[tokio::test]
async fn worker_health_fresh_run_is_ok_and_failed_newer_ignored() {
    let Some(db) = TestDb::new().await else { return };
    let fresh = (Utc::now() - chrono::Duration::minutes(10)).trunc_subsecs(6);
    db.add_run("history", "ok", Some(fresh - chrono::Duration::minutes(30))).await;
    db.add_run("history", "partial", Some(fresh)).await;
    db.add_run("history", "failed", Some(Utc::now())).await;
    let r = worker(&db).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    assert_eq!(r.body["ok"], true);
    assert_eq!(last_at(&r), fresh);
    assert_eq!(r.body.as_object().unwrap().len(), 2);
    db.finish().await;
}

#[tokio::test]
async fn worker_health_stale_run_is_503() {
    let Some(db) = TestDb::new().await else { return };
    // whole seconds: Python isoformat leaves out the microseconds
    let stale = (Utc::now() - chrono::Duration::minutes(121)).trunc_subsecs(0);
    db.add_run("history", "ok", Some(stale)).await;
    let r = worker(&db).await;
    assert_eq!(r.status, StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(r.body["ok"], false);
    assert_eq!(last_at(&r), stale);
    assert!(!r.body["last_history_at"].as_str().unwrap().contains('.'), "{}", r.body);
    db.finish().await;
}
