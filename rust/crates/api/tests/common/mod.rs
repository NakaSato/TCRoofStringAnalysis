//! Shared harness of the integration tests: the axum Router driven in-process against a fresh
//! copy (`CREATE DATABASE … TEMPLATE`) of the database Python seeded (rust/scripts/schema.sh,
//! run by rust/scripts/test_pg.sh, which sets `TEST_DATABASE_URL`). Without the variable the DB
//! tests print a skip message and pass, so a plain `cargo test` still works.
#![allow(dead_code, unused_imports)]

pub use std::sync::atomic::{AtomicU32, Ordering};
pub use std::sync::Arc;
pub use std::time::Duration;

pub use axum::body::Body;
pub use axum::http::{header, HeaderMap, Method, Request, StatusCode};
pub use axum::Router;
pub use chrono::{DateTime, SubsecRound, Utc};
pub use serde_json::{json, Value};
use sha2::Sha256;
pub use sqlx::postgres::PgPoolOptions;
pub use sqlx::{Connection, Executor, PgConnection, PgPool};
use tower::ServiceExt;

pub use tcroof_api::{app, AppState, DbLog, Settings};

pub const SECRET: &str = "integration-test-secret";

pub fn settings(database_url: &str) -> Settings {
    Settings {
        database_url: database_url.into(),
        jwt_secret_key: SECRET.into(),
        jwt_expire_minutes: 60,
        port: 0,
        ..Settings::default()
    }
}

pub fn router(pool: PgPool, url: &str) -> Router {
    app(AppState::new(pool, settings(url)))
}

// ------------------------------------------------------------------------------- fresh database

/// A fresh copy of the seeded database, dropped by `finish`.
pub struct TestDb {
    name: String,
    admin_url: String,
    pub url: String,
    pub pool: PgPool,
    pub app: Router,
    /// the app_logs sink, when made with `with_logs`
    pub logs: Option<Arc<DbLog>>,
    /// the thread's tracing subscriber feeding `logs` (#[tokio::test] runs on one thread)
    _guard: Option<tracing::subscriber::DefaultGuard>,
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
    pub async fn new() -> Option<TestDb> {
        Self::with_settings(|_| {}, false).await
    }

    /// With the app_logs handler on (Python `setup_logging("api")`), settings changed by `tune`.
    pub async fn with_logs(tune: impl FnOnce(&mut Settings)) -> Option<TestDb> {
        Self::with_settings(tune, true).await
    }

    pub async fn with_settings(tune: impl FnOnce(&mut Settings), db_logs: bool) -> Option<TestDb> {
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
        let mut s = settings(&db_url);
        tune(&mut s);
        let mut state = AppState::new(pool.clone(), s.clone());
        let mut guard = None;
        if db_logs {
            use tracing_subscriber::layer::SubscriberExt;
            let sink = DbLog::from_settings("api", &s, pool.clone());
            if let Some(sink) = &sink {
                let sub = tracing_subscriber::registry().with(tcroof_api::logging::db_layer(Arc::clone(sink)));
                guard = Some(tracing::subscriber::set_default(sub));
            }
            state.logs = sink;
        }
        let logs = state.logs.clone();
        let app = app(state);
        Some(TestDb { name, admin_url, url: db_url, pool, app, logs, _guard: guard })
    }

    pub async fn finish(self) {
        self.pool.close().await;
        if let Ok(mut admin) = PgConnection::connect(&self.admin_url).await {
            let _ = admin.execute(format!(r#"DROP DATABASE IF EXISTS "{}" WITH (FORCE)"#, self.name).as_str()).await;
            admin.close().await.ok();
        }
    }

    pub async fn user_id(&self, username: &str) -> i32 {
        sqlx::query_scalar("SELECT id FROM users WHERE username = $1")
            .bind(username)
            .fetch_one(&self.pool)
            .await
            .expect("seeded user")
    }

    /// A user with the password `pw`, hashed the Python way (fewer iterations; the count is in the hash).
    pub async fn add_user(&self, username: &str, pw: &str, role: &str, active: bool) -> i32 {
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

    pub async fn add_run(&self, job: &str, status: &str, finished_at: Option<DateTime<Utc>>) {
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

pub struct Res {
    pub status: StatusCode,
    pub headers: HeaderMap,
    pub body: Value,
}

pub async fn send(app: &Router, method: Method, uri: &str, token: Option<&str>, body: Option<Value>) -> Res {
    let ct = body.as_ref().map(|_| "application/json");
    send_raw(app, method, uri, token, ct, body.map(|b| b.to_string().into_bytes()).unwrap_or_default()).await
}

/// Any body with any content type (None = no Content-Type header).
pub async fn send_raw(
    app: &Router,
    method: Method,
    uri: &str,
    token: Option<&str>,
    content_type: Option<&str>,
    body: Vec<u8>,
) -> Res {
    let mut req = Request::builder().method(method).uri(uri);
    if let Some(t) = token {
        req = req.header(header::AUTHORIZATION, t);
    }
    if let Some(ct) = content_type {
        req = req.header(header::CONTENT_TYPE, ct);
    }
    let req = req.body(Body::from(body)).unwrap();
    let res = app.clone().oneshot(req).await.unwrap();
    let status = res.status();
    let headers = res.headers().clone();
    let bytes = axum::body::to_bytes(res.into_body(), 1 << 20).await.unwrap();
    let body = if bytes.is_empty() {
        Value::Null
    } else {
        serde_json::from_slice(&bytes).unwrap_or_else(|_| Value::String(String::from_utf8_lossy(&bytes).into_owned()))
    };
    Res { status, headers, body }
}

pub async fn login(app: &Router, body: Value) -> Res {
    send(app, Method::POST, "/auth/login", None, Some(body)).await
}

pub async fn me(app: &Router, authorization: Option<&str>) -> Res {
    send(app, Method::GET, "/api/auth/me", authorization, None).await
}

pub fn bearer(res: &Res) -> String {
    format!("Bearer {}", res.body["access_token"].as_str().expect("access_token"))
}

pub fn www_auth(res: &Res) -> Option<&str> {
    res.headers.get(header::WWW_AUTHENTICATE).and_then(|v| v.to_str().ok())
}


/// `Authorization: Bearer …` for a user who signs in with `pw`.
pub async fn token(app: &Router, username: &str, pw: &str) -> String {
    let r = login(app, json!({"username": username, "password": pw})).await;
    assert_eq!(r.status, StatusCode::OK, "login {username}: {}", r.body);
    bearer(&r)
}

impl TestDb {
    pub async fn admin(&self) -> String {
        token(&self.app, "admin", "admin123").await
    }

    pub async fn engineer(&self) -> String {
        token(&self.app, "engineer", "engineer123").await
    }

    /// Growatt registry rows (only `plant_id` and `name` are required).
    pub async fn add_plants(&self, ids: &[i32]) {
        for id in ids {
            sqlx::query("INSERT INTO growatt_plants (plant_id, name, synced_at) VALUES ($1, $2, now())")
                .bind(id)
                .bind(format!("Plant {id}"))
                .execute(&self.pool)
                .await
                .expect("insert plant");
        }
    }

    pub async fn assign(&self, user_id: i32, plant_ids: &[i32]) {
        for p in plant_ids {
            sqlx::query("INSERT INTO user_plant_assignments (user_id, plant_id, assigned_by, created_at) VALUES ($1, $2, 'test', now())")
                .bind(user_id)
                .bind(p)
                .execute(&self.pool)
                .await
                .expect("insert assignment");
        }
    }
}
