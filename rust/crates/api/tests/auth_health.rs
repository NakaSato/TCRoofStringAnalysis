//! Integration tests of health and auth (harness in tests/common). Run them with
//! rust/scripts/test_pg.sh.
//!
//! The expected behaviour is Python's: backend/app/main.py (health), backend/app/services/jobs.py
//! (`worker_health`), backend/app/api/routes/auth.py, backend/app/auth.py and
//! backend/app/services/users.py (`user_out`).

mod common;
use common::*;

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
        let s = Settings { jwt_secret_key: "another-secret".into(), ..settings("unused") };
        let a = app(AppState::new(db.pool.clone(), s));
        bearer(&login(&a, json!({"username": "admin", "password": "admin123"})).await)
    };
    let expired = {
        let s = Settings { jwt_expire_minutes: -1, ..settings("unused") };
        let a = app(AppState::new(db.pool.clone(), s));
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
