//! The production subscriber (`logging::init_tracing`, as main.rs sets it up) under a global
//! dispatcher and a multi-thread runtime: the audit line of a request reaches app_logs. Its own
//! test binary, because a global subscriber can be set only once per process. A per-layer filter
//! setup once passed the scoped-subscriber tests but stored nothing in the real server.

mod common;
use common::*;

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn audit_line_reaches_app_logs_with_the_global_subscriber() {
    let Some(db) = TestDb::new().await else { return };
    let s = settings(&db.url);
    let sink = DbLog::from_settings("api", &s, db.pool.clone());
    tcroof_api::logging::init_tracing(sink.clone());
    let app = app(AppState { logs: sink, ..AppState::new(db.pool.clone(), s) });
    // from another task, like a served connection
    let r = tokio::spawn(async move { login(&app, json!({"username": "Ghost", "password": "x"})).await }).await.unwrap();
    assert_eq!(r.status, StatusCode::UNAUTHORIZED);
    let rows: Vec<(String, String, String)> = sqlx::query_as("SELECT logger, message, source FROM app_logs ORDER BY id")
        .fetch_all(&db.pool)
        .await
        .unwrap();
    assert_eq!(rows, [("app.audit".to_owned(), "failed login for 'ghost'".to_owned(), "api".to_owned())]);
    db.finish().await;
}
