//! Integration tests of the auth dependencies (extract.rs), Users & Access (`/users*`), System →
//! Logs (`/system/logs*`) and the request / app_logs logging. Run with rust/scripts/test_pg.sh.
//!
//! The expected behaviour is Python's: backend/app/auth.py, backend/app/api/routes/users.py,
//! backend/app/services/users.py, backend/app/api/routes/system.py,
//! backend/app/services/system_logs.py, backend/app/logging_db.py, backend/app/api/request_log.py.

mod common;
use common::*;

use axum::routing::get;
use tcroof_api::extract::{AdminUser, CurrentUser, PlantRead, PlantWrite, StoreKeeper, WriteUser};
use tcroof_api::logging::Record;

// --------------------------------------------------------------------------- auth dependencies

/// Routes that only run their extractor (the dependencies have no routes of their own yet).
fn deps_app(state: AppState) -> Router {
    Router::new()
        .route("/t/user", get(|CurrentUser(u): CurrentUser| async move { u.username.unwrap_or_default() }))
        .route("/t/admin", get(|AdminUser(u): AdminUser| async move { u.username.unwrap_or_default() }))
        .route("/t/write", get(|WriteUser(u): WriteUser| async move { u.username.unwrap_or_default() }))
        .route("/t/store", get(|StoreKeeper(u): StoreKeeper| async move { u.username.unwrap_or_default() }))
        .route("/t/plants/{plant_id}/read", get(|p: PlantRead| async move { p.plant_id.to_string() }))
        .route("/t/plants/{plant_id}/write", get(|p: PlantWrite| async move { p.plant_id.to_string() }))
        .with_state(state)
}

async fn get_t(app: &Router, uri: &str, tok: Option<&str>) -> (StatusCode, Value) {
    let r = send(app, Method::GET, uri, tok, None).await;
    (r.status, r.body)
}

fn detail(s: &str) -> Value {
    json!({ "detail": s })
}

#[tokio::test]
async fn role_dependencies_answer_like_fastapi() {
    let Some(db) = TestDb::new().await else { return };
    let t = deps_app(AppState::new(db.pool.clone(), settings(&db.url)));
    db.add_user("viewer1", "viewer-pass", "viewer", true).await;
    let keeper = db.add_user("keeper", "keeper-pass", "engineer", true).await;
    sqlx::query("UPDATE users SET store_keeper = true WHERE id = $1").bind(keeper).execute(&db.pool).await.unwrap();
    let (admin, eng) = (db.admin().await, db.engineer().await);
    let viewer = token(&db.app, "viewer1", "viewer-pass").await;
    let keeper = token(&db.app, "keeper", "keeper-pass").await;

    for uri in ["/t/user", "/t/admin", "/t/write", "/t/store", "/t/plants/1/read", "/t/plants/x/write"] {
        assert_eq!(get_t(&t, uri, None).await, (StatusCode::UNAUTHORIZED, detail("Authentication required")), "{uri}");
    }
    assert_eq!(get_t(&t, "/t/admin", Some(&admin)).await.0, StatusCode::OK);
    assert_eq!(get_t(&t, "/t/admin", Some(&eng)).await, (StatusCode::FORBIDDEN, detail("Admin role required.")));
    assert_eq!(get_t(&t, "/t/admin", Some(&keeper)).await.0, StatusCode::FORBIDDEN);

    let write_msg = "Insufficient permissions: 'admin' or 'engineer' role required for write operations.";
    assert_eq!(get_t(&t, "/t/write", Some(&eng)).await.0, StatusCode::OK);
    assert_eq!(get_t(&t, "/t/write", Some(&admin)).await.0, StatusCode::OK);
    assert_eq!(get_t(&t, "/t/write", Some(&viewer)).await, (StatusCode::FORBIDDEN, detail(write_msg)));
    // the role check comes before the path parameter (FastAPI solves sub-dependencies first)
    assert_eq!(get_t(&t, "/t/plants/abc/write", Some(&viewer)).await, (StatusCode::FORBIDDEN, detail(write_msg)));
    assert_eq!(get_t(&t, "/t/user", Some(&viewer)).await.0, StatusCode::OK, "any active role is signed in");

    let store_msg = "Admin or store keeper required.";
    assert_eq!(get_t(&t, "/t/store", Some(&eng)).await, (StatusCode::FORBIDDEN, detail(store_msg)));
    assert_eq!(get_t(&t, "/t/store", Some(&keeper)).await.0, StatusCode::OK);
    assert_eq!(get_t(&t, "/t/store", Some(&admin)).await.0, StatusCode::OK);
    db.finish().await;
}

#[tokio::test]
async fn plant_scope_is_404_outside_the_assignments() {
    let Some(db) = TestDb::new().await else { return };
    let t = deps_app(AppState::new(db.pool.clone(), settings(&db.url)));
    let eid = db.user_id("engineer").await;
    db.assign(eid, &[7, 42]).await;
    let (admin, eng) = (db.admin().await, db.engineer().await);

    for kind in ["read", "write"] {
        assert_eq!(get_t(&t, &format!("/t/plants/7/{kind}"), Some(&eng)).await, (StatusCode::OK, json!(7)));
        assert_eq!(
            get_t(&t, &format!("/t/plants/8/{kind}"), Some(&eng)).await,
            (StatusCode::NOT_FOUND, detail("Plant 8 not found")),
            "never 403: plant ids are not revealed"
        );
        // admin: every plant, also ones not in the registry
        assert_eq!(get_t(&t, &format!("/t/plants/8/{kind}"), Some(&admin)).await, (StatusCode::OK, json!(8)));
        assert_eq!(get_t(&t, &format!("/t/plants/abc/{kind}"), Some(&eng)).await.0, StatusCode::UNPROCESSABLE_ENTITY);
        assert_eq!(get_t(&t, &format!("/t/plants/1.5/{kind}"), Some(&admin)).await.0, StatusCode::UNPROCESSABLE_ENTITY);
        assert_eq!(get_t(&t, &format!("/t/plants/42.0/{kind}"), Some(&eng)).await, (StatusCode::OK, json!(42)));
    }
    // an assignment change applies at once, without signing in again
    sqlx::query("DELETE FROM user_plant_assignments WHERE user_id = $1 AND plant_id = 7")
        .bind(eid)
        .execute(&db.pool)
        .await
        .unwrap();
    assert_eq!(get_t(&t, "/t/plants/7/read", Some(&eng)).await.0, StatusCode::NOT_FOUND);
    // a disabled engineer is signed out
    sqlx::query("UPDATE users SET is_active = false WHERE id = $1").bind(eid).execute(&db.pool).await.unwrap();
    assert_eq!(
        get_t(&t, "/t/plants/42/read", Some(&eng)).await,
        (StatusCode::UNAUTHORIZED, detail("User account not found or inactive"))
    );
    db.finish().await;
}

// ---------------------------------------------------------------------------------- /users

async fn users(db: &TestDb, tok: &str) -> Value {
    let r = send(&db.app, Method::GET, "/api/users", Some(tok), None).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    r.body
}

#[tokio::test]
async fn users_routes_are_admin_only() {
    let Some(db) = TestDb::new().await else { return };
    let eng = db.engineer().await;
    let uid = db.user_id("engineer").await;
    let gone = db.add_user("gone", "gone-pass", "admin", true).await;
    let gone_tok = token(&db.app, "gone", "gone-pass").await;
    sqlx::query("UPDATE users SET is_active = false WHERE id = $1").bind(gone).execute(&db.pool).await.unwrap();

    let reqs: Vec<(Method, String, Option<Value>)> = vec![
        (Method::GET, "/users".into(), None),
        (Method::POST, "/users".into(), Some(json!({"username": "x1", "full_name": "X", "password": "12345678"}))),
        // even an invalid body: 403 comes first
        (Method::POST, "/users".into(), Some(json!({}))),
        (Method::PATCH, format!("/users/{uid}"), Some(json!({"full_name": "Hacked"}))),
        (Method::PATCH, "/users/abc".into(), Some(json!({}))),
        (Method::PUT, format!("/users/{uid}/plants"), Some(json!({"plant_ids": []}))),
        (Method::GET, "/system/logs".into(), None),
        (Method::GET, "/system/logs?level=nope".into(), None),
        (Method::GET, "/system/logs/summary".into(), None),
    ];
    for (m, path, body) in reqs {
        for prefix in ["", "/api"] {
            let uri = format!("{prefix}{path}");
            let r = send(&db.app, m.clone(), &uri, Some(&eng), body.clone()).await;
            assert_eq!((r.status, &r.body), (StatusCode::FORBIDDEN, &detail("Admin role required.")), "{m} {uri}");
            let r = send(&db.app, m.clone(), &uri, None, body.clone()).await;
            assert_eq!(r.status, StatusCode::UNAUTHORIZED, "{m} {uri}");
            let r = send(&db.app, m.clone(), &uri, Some(&gone_tok), body.clone()).await;
            assert_eq!((r.status, &r.body), (StatusCode::UNAUTHORIZED, &detail("User account not found or inactive")));
        }
    }
    // nothing changed
    let full: String = sqlx::query_scalar("SELECT full_name FROM users WHERE id = $1").bind(uid).fetch_one(&db.pool).await.unwrap();
    assert_eq!(full, "Anucha P. (Senior O&M Engineer)");
    // no DELETE route (accounts are disabled, never deleted): 405 before any auth, like Starlette
    let r = send(&db.app, Method::DELETE, &format!("/api/users/{uid}"), None, None).await;
    assert_eq!((r.status, r.body), (StatusCode::METHOD_NOT_ALLOWED, detail("Method Not Allowed")));
    let r = send(&db.app, Method::GET, "/api/nothing-here", None, None).await;
    assert_eq!((r.status, r.body), (StatusCode::NOT_FOUND, detail("Not Found")));
    db.finish().await;
}

#[tokio::test]
async fn list_users_sorted_with_assignments() {
    let Some(db) = TestDb::new().await else { return };
    let admin = db.admin().await;
    let eid = db.user_id("engineer").await;
    let aid = db.user_id("admin").await;
    let zed = db.add_user("zed", "zed-pass-1", "engineer", false).await;
    let abe = db.add_user("abe", "abe-pass-1", "admin", true).await;
    db.assign(eid, &[30, 5]).await;
    db.assign(aid, &[9]).await; // an admin's rows are ignored: null = every plant

    let list = users(&db, &admin).await;
    let names: Vec<&str> = list.as_array().unwrap().iter().map(|u| u["username"].as_str().unwrap()).collect();
    assert_eq!(names, ["abe", "admin", "engineer", "zed"], "ORDER BY role, username");
    let by = |n: &str| list.as_array().unwrap().iter().find(|u| u["username"] == n).unwrap().clone();
    assert_eq!(
        by("engineer"),
        json!({"id": eid, "username": "engineer", "email": "engineer@tcroofsolar.com",
               "full_name": "Anucha P. (Senior O&M Engineer)", "role": "engineer", "is_active": true,
               "store_keeper": false, "plant_ids": [5, 30]})
    );
    assert_eq!(by("admin")["plant_ids"], Value::Null);
    assert_eq!(by("abe")["id"], abe);
    assert_eq!((by("zed")["id"].clone(), by("zed")["is_active"].clone(), by("zed")["plant_ids"].clone()), (json!(zed), json!(false), json!([])));
    // the same at the root mount
    let r = send(&db.app, Method::GET, "/users", Some(&admin), None).await;
    assert_eq!(r.body, list);
    db.finish().await;
}

async fn create(db: &TestDb, tok: &str, body: Value) -> Res {
    send(&db.app, Method::POST, "/api/users", Some(tok), Some(body)).await
}

#[tokio::test]
async fn create_user_rules_and_defaults() {
    let Some(db) = TestDb::new().await else { return };
    let admin = db.admin().await;
    db.add_plants(&[11, 22, 33]).await;

    let r = create(&db, &admin, json!({
        "username": "Field.Tech-1", "email": "  Field@Example.COM ", "full_name": "  Field Tech  ",
        "password": "fieldpass", "plant_ids": [33, 11, 33], "store_keeper": "yes", "extra": "ignored"
    }))
    .await;
    assert_eq!(r.status, StatusCode::CREATED, "{}", r.body);
    let id = r.body["id"].as_i64().unwrap();
    assert_eq!(
        r.body,
        json!({"id": id, "username": "field.tech-1", "email": "field@example.com", "full_name": "Field Tech",
               "role": "engineer", "is_active": true, "store_keeper": true, "plant_ids": [11, 33]})
    );
    let assigned_by: Vec<String> = sqlx::query_scalar("SELECT assigned_by FROM user_plant_assignments WHERE user_id = $1")
        .bind(id as i32)
        .fetch_all(&db.pool)
        .await
        .unwrap();
    assert_eq!(assigned_by, ["admin", "admin"]);
    // the new account signs in with its password (hashed the Python way: pbkdf2_sha256$120000$…)
    let tok = token(&db.app, "field.tech-1", "fieldpass").await;
    assert_eq!(me(&db.app, Some(&tok)).await.body["plant_ids"], json!([11, 33]));
    let hashed: String = sqlx::query_scalar("SELECT hashed_password FROM users WHERE id = $1").bind(id as i32).fetch_one(&db.pool).await.unwrap();
    assert!(hashed.starts_with("pbkdf2_sha256$120000$"), "{hashed}");

    // no email: <username>@users.local; an admin gets no assignment rows (plant_ids null)
    let r = create(&db, &admin, json!({"username": "boss2", "full_name": "B", "password": "bosspass", "role": "admin", "plant_ids": [22], "email": ""})).await;
    assert_eq!(r.status, StatusCode::CREATED, "{}", r.body);
    assert_eq!((r.body["email"].clone(), r.body["role"].clone(), r.body["plant_ids"].clone()), (json!("boss2@users.local"), json!("admin"), Value::Null));
    let n: i64 = sqlx::query_scalar("SELECT count(*) FROM user_plant_assignments WHERE user_id = $1")
        .bind(r.body["id"].as_i64().unwrap() as i32)
        .fetch_one(&db.pool)
        .await
        .unwrap();
    assert_eq!(n, 0);

    // service errors: 422 with Python's message
    for (body, msg) in [
        (json!({"username": "FIELD.TECH-1", "full_name": "x", "password": "12345678"}),
         "Username or email already in use: 'field.tech-1' / 'field.tech-1@users.local'"),
        (json!({"username": "other", "email": "FIELD@example.com", "full_name": "x", "password": "12345678"}),
         "Username or email already in use: 'other' / 'field@example.com'"),
        (json!({"username": "other", "full_name": "x", "password": "12345678", "plant_ids": [99, 11, 5, 99]}),
         "Unknown plant id(s): [5, 99]"),
    ] {
        let r = create(&db, &admin, body.clone()).await;
        assert_eq!((r.status, r.body), (StatusCode::UNPROCESSABLE_ENTITY, detail(msg)), "{body}");
    }
    // validation errors (FastAPI 422)
    let ok = json!({"username": "valid", "full_name": "V", "password": "12345678"});
    for patch in [
        json!({"username": "v"}), json!({"username": "has space"}), json!({"username": "ไทย"}), json!({"username": 12}),
        json!({"password": "short"}), json!({"password": "p".repeat(129)}), json!({"full_name": ""}),
        json!({"role": "viewer"}), json!({"role": null}), json!({"store_keeper": "perhaps"}),
        json!({"plant_ids": [1.5]}), json!({"plant_ids": "1"}), json!({"email": "e".repeat(256)}),
    ] {
        let mut b = ok.clone();
        b.as_object_mut().unwrap().extend(patch.as_object().unwrap().clone());
        let r = create(&db, &admin, b.clone()).await;
        assert_eq!(r.status, StatusCode::UNPROCESSABLE_ENTITY, "{b}");
    }
    for missing in ["username", "full_name", "password"] {
        let mut b = ok.clone();
        b.as_object_mut().unwrap().remove(missing);
        assert_eq!(create(&db, &admin, b).await.status, StatusCode::UNPROCESSABLE_ENTITY, "{missing}");
    }
    for (ct, body) in [(Some("application/json"), &b"not json"[..]), (Some("text/plain"), br#"{"a":1}"#), (None, b"")] {
        let r = send_raw(&db.app, Method::POST, "/users", Some(&admin), ct, body.to_vec()).await;
        assert_eq!(r.status, StatusCode::UNPROCESSABLE_ENTITY, "{ct:?}");
    }
    // a JSON body without a content type is still read (FastAPI)
    let r = send_raw(&db.app, Method::POST, "/users", Some(&admin), None, ok.to_string().into_bytes()).await;
    assert_eq!(r.status, StatusCode::CREATED, "{}", r.body);
    assert_eq!(r.body["username"], "valid");
    db.finish().await;
}

async fn patch_user(db: &TestDb, tok: &str, id: impl std::fmt::Display, body: Value) -> Res {
    send(&db.app, Method::PATCH, &format!("/api/users/{id}"), Some(tok), Some(body)).await
}

#[tokio::test]
async fn update_user_rules() {
    let Some(db) = TestDb::new().await else { return };
    let admin = db.admin().await;
    let aid = db.user_id("admin").await;
    let eid = db.user_id("engineer").await;
    db.assign(eid, &[3, 1]).await;

    // the only active admin can't be demoted or disabled (not even by itself)
    for body in [json!({"role": "engineer"}), json!({"is_active": false})] {
        let r = patch_user(&db, &admin, aid, body.clone()).await;
        assert_eq!((r.status, r.body), (StatusCode::UNPROCESSABLE_ENTITY, detail("Cannot demote or disable the last active admin")), "{body}");
    }
    // with a second admin: demoting is fine, disabling yourself is not
    let a2 = db.add_user("admin2", "admin2-pass", "admin", true).await;
    let r = patch_user(&db, &admin, aid, json!({"is_active": false})).await;
    assert_eq!((r.status, r.body), (StatusCode::UNPROCESSABLE_ENTITY, detail("You cannot disable your own account")));
    let r = patch_user(&db, &admin, a2, json!({"role": "engineer"})).await;
    assert_eq!((r.status, r.body["role"].clone(), r.body["plant_ids"].clone()), (StatusCode::OK, json!("engineer"), json!([])));

    // email: trimmed, lowercased, unique
    let r = patch_user(&db, &admin, eid, json!({"email": " ADMIN@tcroofsolar.com "})).await;
    assert_eq!((r.status, r.body), (StatusCode::UNPROCESSABLE_ENTITY, detail("Email already in use: 'admin@tcroofsolar.com'")));
    let r = patch_user(&db, &admin, eid, json!({"email": " New@Mail.TEST ", "full_name": " New Name ", "store_keeper": true})).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    assert_eq!(
        r.body,
        json!({"id": eid, "username": "engineer", "email": "new@mail.test", "full_name": "New Name", "role": "engineer",
               "is_active": true, "store_keeper": true, "plant_ids": [1, 3]})
    );
    // its own email is not a clash
    assert_eq!(patch_user(&db, &admin, eid, json!({"email": "new@mail.test"})).await.status, StatusCode::OK);

    // password reset: the old one stops working
    let r = patch_user(&db, &admin, eid, json!({"password": "brand-new-pass"})).await;
    assert_eq!(r.status, StatusCode::OK);
    assert_eq!(login(&db.app, json!({"username": "engineer", "password": "engineer123"})).await.status, StatusCode::UNAUTHORIZED);
    token(&db.app, "engineer", "brand-new-pass").await;

    // nulls and unknown fields change nothing
    let before = patch_user(&db, &admin, eid, json!({})).await.body;
    let r = patch_user(&db, &admin, eid, json!({"email": null, "full_name": null, "password": null, "role": null,
                                                "is_active": null, "store_keeper": null, "username": "renamed"})).await;
    assert_eq!((r.status, &r.body), (StatusCode::OK, &before));

    // promoting to admin drops the assignment rows
    let r = patch_user(&db, &admin, eid, json!({"role": "admin"})).await;
    assert_eq!(r.body["plant_ids"], Value::Null);
    let n: i64 = sqlx::query_scalar("SELECT count(*) FROM user_plant_assignments WHERE user_id = $1").bind(eid).fetch_one(&db.pool).await.unwrap();
    assert_eq!(n, 0);
    // disabling: that user can't sign in
    let r = patch_user(&db, &admin, eid, json!({"is_active": "false"})).await;
    assert_eq!((r.status, r.body["is_active"].clone()), (StatusCode::OK, json!(false)));
    assert_eq!(login(&db.app, json!({"username": "engineer", "password": "brand-new-pass"})).await.status, StatusCode::UNAUTHORIZED);

    // not found / bad ids / bad bodies; the body is checked before the lookup
    assert_eq!(patch_user(&db, &admin, 99_999, json!({})).await.body, detail("User 99999 not found"));
    assert_eq!(patch_user(&db, &admin, 99_999, json!({})).await.status, StatusCode::NOT_FOUND);
    assert_eq!(patch_user(&db, &admin, "99999999999", json!({})).await.body, detail("User 99999999999 not found"));
    assert_eq!(patch_user(&db, &admin, -1, json!({})).await.status, StatusCode::NOT_FOUND);
    for (id, body) in [
        ("abc".to_owned(), json!({})),
        ("1.5".to_owned(), json!({})),
        ("99999".to_owned(), json!({"password": "short"})),
        (eid.to_string(), json!({"full_name": ""})),
        (eid.to_string(), json!({"role": "owner"})),
        (eid.to_string(), json!({"is_active": "perhaps"})),
        (eid.to_string(), json!({"email": 5})),
        (eid.to_string(), json!([])),
    ] {
        let r = patch_user(&db, &admin, &id, body.clone()).await;
        assert_eq!(r.status, StatusCode::UNPROCESSABLE_ENTITY, "{id} {body}");
    }
    db.finish().await;
}

#[tokio::test]
async fn set_user_plants_rules() {
    let Some(db) = TestDb::new().await else { return };
    let admin = db.admin().await;
    let aid = db.user_id("admin").await;
    let eid = db.user_id("engineer").await;
    db.add_plants(&[10, 20, 30]).await;
    db.assign(eid, &[10]).await;
    let put = |id: String, body: Value| {
        let app = db.app.clone();
        let tok = admin.clone();
        async move { send(&app, Method::PUT, &format!("/users/{id}/plants"), Some(&tok), Some(body)).await }
    };

    let r = put(eid.to_string(), json!({"plant_ids": [30, 20, 30]})).await;
    assert_eq!((r.status, r.body["plant_ids"].clone()), (StatusCode::OK, json!([20, 30])));
    let eng = db.engineer().await;
    assert_eq!(me(&db.app, Some(&eng)).await.body["plant_ids"], json!([20, 30]));
    let r = put(eid.to_string(), json!({"plant_ids": []})).await;
    assert_eq!((r.status, r.body["plant_ids"].clone()), (StatusCode::OK, json!([])));

    for (id, body, status, msg) in [
        (aid.to_string(), json!({"plant_ids": [10]}), 422, Some("Admins see every plant; assign plants to engineers only")),
        (eid.to_string(), json!({"plant_ids": [10, 77, 66]}), 422, Some("Unknown plant id(s): [66, 77]")),
        ("424242".to_owned(), json!({"plant_ids": []}), 404, Some("User 424242 not found")),
        (eid.to_string(), json!({}), 422, None),
        (eid.to_string(), json!({"plant_ids": null}), 422, None),
        (eid.to_string(), json!({"plant_ids": ["x"]}), 422, None),
        ("x".to_owned(), json!({"plant_ids": []}), 422, None),
    ] {
        let r = put(id.clone(), body.clone()).await;
        assert_eq!(r.status.as_u16(), status, "{id} {body}: {}", r.body);
        if let Some(m) = msg {
            assert_eq!(r.body, detail(m));
        }
    }
    // a failed request leaves the assignments alone
    assert_eq!(me(&db.app, Some(&eng)).await.body["plant_ids"], json!([]));
    db.finish().await;
}

// ------------------------------------------------------------------------------- /system/logs

/// An `app_logs` row at `ts` (other columns from the arguments, the rest fixed).
async fn add_log(db: &TestDb, ts: DateTime<Utc>, level: &str, source: &str, logger: &str, message: &str, run: Option<(i32, &str)>) -> i32 {
    let no: i16 = match level {
        "DEBUG" => 10,
        "INFO" => 20,
        "WARNING" => 30,
        "ERROR" => 40,
        _ => 50,
    };
    sqlx::query_scalar(
        "INSERT INTO app_logs (ts, level, level_no, source, host, logger, message, exc_text, run_id, job, request_id, extra_json) \
         VALUES ($1, $2, $3, $4, 'h1', $5, $6, NULL, $7, $8, NULL, NULL) RETURNING id",
    )
    .bind(ts)
    .bind(level)
    .bind(no)
    .bind(source)
    .bind(logger)
    .bind(message)
    .bind(run.map(|r| r.0))
    .bind(run.map(|r| r.1))
    .fetch_one(&db.pool)
    .await
    .expect("insert app_logs row")
}

async fn logs(db: &TestDb, tok: &str, query: &str) -> Res {
    send(&db.app, Method::GET, &format!("/api/system/logs{query}"), Some(tok), None).await
}

fn ids(r: &Res) -> Vec<i64> {
    r.body["items"].as_array().unwrap_or_else(|| panic!("{}", r.body)).iter().map(|i| i["id"].as_i64().unwrap()).collect()
}

#[tokio::test]
async fn system_logs_filters_and_paging() {
    let Some(db) = TestDb::new().await else { return };
    let admin = db.admin().await;
    let now = Utc::now().trunc_subsecs(0);
    let h = |n: i64| now - chrono::Duration::hours(n);
    let old = add_log(&db, h(30), "ERROR", "worker", "app.services.growatt_sync", "old failure", Some((5, "history"))).await;
    let a = add_log(&db, h(3), "INFO", "worker", "app.services.growatt_sync", "job history started", Some((5, "history"))).await;
    let b = add_log(&db, h(2), "WARNING", "api", "app.api.request", "GET /api/x slow: 6001 ms (status 200)", None).await;
    let c = add_log(&db, h(1), "ERROR", "cli", "app.cli", "Import FAILED 100%_done", None).await;
    let d = add_log(&db, now, "DEBUG", "worker", "app.services.growatt_sync", "detail", None).await;
    let e = add_log(&db, now, "CRITICAL", "api", "app_services", "boom", None).await;

    // defaults: INFO and up, last 24 h, newest first
    let r = logs(&db, &admin, "").await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    assert_eq!(ids(&r), [e, c, b, a].map(i64::from));
    assert_eq!(r.body["next_before_id"], Value::Null);
    let meta = &r.body["meta"];
    assert_eq!((meta["source"].clone(), meta["retention_days"].clone(), meta["enabled"].clone(), meta["level"].clone()),
               (json!("db"), json!(14), json!(true), json!("INFO")));
    let since = DateTime::parse_from_rfc3339(meta["since"].as_str().unwrap()).unwrap();
    assert!((Utc::now() - chrono::Duration::hours(24) - since.with_timezone(&Utc)).num_seconds().abs() <= 5);
    assert!(meta["since"].as_str().unwrap().ends_with('Z'));
    let item = &r.body["items"][1];
    assert_eq!(
        item,
        &json!({"id": c, "ts": now.checked_sub_signed(chrono::Duration::hours(1)).unwrap().format("%Y-%m-%dT%H:%M:%SZ").to_string(),
                "level": "ERROR", "source": "cli", "host": "h1", "logger": "app.cli", "message": "Import FAILED 100%_done",
                "exc_text": null, "run_id": null, "job": null, "request_id": null, "extra": null})
    );

    let q = |s: &str| s.to_owned();
    for (query, want) in [
        (q("?level=debug"), vec![e, d, c, b, a]),
        (q("?level=%20Error%20"), vec![e, c]),
        (q("?level=CRITICAL"), vec![e]),
        (q("?source=api&source=cli"), vec![e, c, b]),
        (q("?logger=app.services"), vec![a]),
        // the prefix is literal: `_` is not a wildcard (`app_services` doesn't match `app.services`)
        (q("?logger=app_"), vec![e]),
        (q("?job=history"), vec![a]),
        // a run: the whole run, no 24 h window
        (q("?run_id=5"), vec![a, old]),
        (q("?run_id=5&level=ERROR"), vec![old]),
        // text: case-insensitive, `%` / `_` literal
        (q("?q=failed%20100%25_"), vec![c]),
        (q("?q=100%25x"), vec![]),
        (q("?q=SLOW"), vec![b]),
        (q("?q="), vec![e, c, b, a]),
        (q("?logger=&job="), vec![e, c, b, a]),
        (format!("?before_id={c}"), vec![b, a]),
        (format!("?after_id={b}"), vec![e, c]),
        (format!("?after_id={a}&before_id={e}"), vec![c, b]),
        (q("?since=2000-01-01"), vec![e, c, b, a, old]),
        (format!("?until={}", (h(2) + chrono::Duration::seconds(1)).format("%Y-%m-%dT%H:%M:%SZ")), vec![b, a]),
        // without a zone = Bangkok time (UTC+7)
        (format!("?since={}", (h(1) + chrono::Duration::hours(7)).format("%Y-%m-%dT%H:%M:%S")), vec![e, c]),
        (format!("?since={}%2B07:00", (h(1) + chrono::Duration::hours(7)).format("%Y-%m-%dT%H:%M:%S")), vec![e, c]),
        (q("?level=INFO&level=WARNING"), vec![e, c, b]),
    ] {
        let r = logs(&db, &admin, &query).await;
        assert_eq!(r.status, StatusCode::OK, "{query}: {}", r.body);
        assert_eq!(ids(&r), want.iter().map(|&i| i64::from(i)).collect::<Vec<_>>(), "{query}");
    }
    let r = logs(&db, &admin, "?run_id=5").await;
    assert_eq!(r.body["meta"]["since"], Value::Null, "a run has no window");

    // paging: a full page names the next before_id
    let r = logs(&db, &admin, "?limit=2").await;
    assert_eq!((ids(&r), r.body["next_before_id"].clone()), (vec![i64::from(e), i64::from(c)], json!(c)));
    let r = logs(&db, &admin, &format!("?limit=2&before_id={c}")).await;
    assert_eq!((ids(&r), r.body["next_before_id"].clone()), (vec![i64::from(b), i64::from(a)], json!(a)));
    let r = logs(&db, &admin, &format!("?limit=2&before_id={a}")).await;
    assert_eq!((ids(&r), r.body["next_before_id"].clone()), (vec![], Value::Null));

    for (query, msg) in [
        ("?level=LOUD", Some("Unknown level 'LOUD'; choose one of DEBUG, INFO, WARNING, ERROR, CRITICAL")),
        ("?level=", Some("Unknown level ''; choose one of DEBUG, INFO, WARNING, ERROR, CRITICAL")),
        ("?source=api&source=web&source=bot", Some("Unknown source 'bot'; choose one of api, worker, cli")),
        ("?limit=0", None),
        ("?limit=1001", None),
        ("?limit=ten", None),
        ("?run_id=", None),
        ("?before_id=x", None),
        ("?since=yesterday", None),
        ("?until=2026-11-27T25:00", None),
    ] {
        let r = logs(&db, &admin, query).await;
        assert_eq!(r.status, StatusCode::UNPROCESSABLE_ENTITY, "{query}: {}", r.body);
        if let Some(m) = msg {
            assert_eq!(r.body, detail(m), "{query}");
        }
    }
    let long = "x".repeat(201);
    assert_eq!(logs(&db, &admin, &format!("?q={long}")).await.status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(logs(&db, &admin, &format!("?q={}", &long[..200])).await.status, StatusCode::OK);
    db.finish().await;
}

#[tokio::test]
async fn system_logs_summary_counts() {
    let Some(db) = TestDb::new().await else { return };
    let admin = db.admin().await;
    let summary = |q: &'static str| {
        let app = db.app.clone();
        let tok = admin.clone();
        async move { send(&app, Method::GET, &format!("/system/logs/summary{q}"), Some(&tok), None).await }
    };
    // empty table
    let r = summary("").await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    assert_eq!(r.body["total"], 0);
    assert_eq!(r.body["by_level"], json!({"DEBUG": 0, "INFO": 0, "WARNING": 0, "ERROR": 0, "CRITICAL": 0}));
    assert_eq!(r.body["by_source"], json!({"api": 0, "worker": 0, "cli": 0}));
    assert_eq!((r.body["last_error"].clone(), r.body["newest_id"].clone(), r.body["enabled"].clone()), (Value::Null, Value::Null, json!(true)));

    let now = Utc::now().trunc_subsecs(0);
    let h = |n: i64| now - chrono::Duration::hours(n);
    let old_err = add_log(&db, h(30), "ERROR", "worker", "w", "old", None).await;
    add_log(&db, h(3), "INFO", "worker", "w", "i", None).await;
    let err = add_log(&db, h(2), "ERROR", "api", "a", "e1", None).await;
    add_log(&db, h(1), "WARNING", "api", "a", "w1", None).await;
    let newest = add_log(&db, now, "DEBUG", "cli", "c", "d", None).await;

    let r = summary("").await;
    assert_eq!(r.body["total"], 4);
    assert_eq!(r.body["by_level"], json!({"DEBUG": 1, "INFO": 1, "WARNING": 1, "ERROR": 1, "CRITICAL": 0}));
    assert_eq!(r.body["by_source"], json!({"api": 2, "worker": 1, "cli": 1}));
    assert_eq!(r.body["last_error"]["id"], err);
    assert_eq!(r.body["last_error"]["message"], "e1");
    assert_eq!(r.body["newest_id"], newest);
    assert!(r.body["since"].as_str().unwrap().ends_with('Z'));

    let r = summary("?since=2000-01-01T00:00:00Z").await;
    assert_eq!((r.body["total"].clone(), r.body["since"].clone()), (json!(5), json!("2000-01-01T00:00:00Z")));
    assert_eq!(r.body["by_level"]["ERROR"], 2);
    // newest ERROR+ by id, inside the window only
    assert_eq!(r.body["last_error"]["id"], err);
    let _ = old_err;
    let r = summary("?since=2000-01-01").await;
    assert_eq!(r.body["since"], "1999-12-31T17:00:00Z", "a naive date is Bangkok midnight");
    assert_eq!(summary("?since=garbage").await.status, StatusCode::UNPROCESSABLE_ENTITY);
    db.finish().await;
}

// ------------------------------------------------------------------------- request / app_logs

#[derive(Debug, PartialEq, sqlx::FromRow)]
struct Stored {
    level: String,
    level_no: i16,
    source: String,
    logger: String,
    message: String,
    exc_text: Option<String>,
    request_id: Option<String>,
    host: Option<String>,
}

async fn stored(db: &TestDb) -> Vec<Stored> {
    sqlx::query_as("SELECT level, level_no, source, logger, message, exc_text, request_id, host FROM app_logs ORDER BY id")
        .fetch_all(&db.pool)
        .await
        .unwrap()
}

#[tokio::test]
async fn audit_lines_are_stored_with_the_request_id() {
    let Some(db) = TestDb::with_logs(|s| s.jwt_secret_key = "jwt-secret-for-redaction-test".into()).await else { return };
    let r = login(&db.app, json!({"username": "Nobody", "password": "secret-pw"})).await;
    assert_eq!(r.status, StatusCode::UNAUTHORIZED);
    let rid = r.headers.get("x-request-id").and_then(|v| v.to_str().ok()).expect("X-Request-ID").to_owned();
    assert!(rid.len() == 16 && rid.bytes().all(|b| b.is_ascii_hexdigit()), "{rid}");
    // flushed before the response came back
    let rows = stored(&db).await;
    assert_eq!(rows.len(), 1, "{rows:?}");
    let row = &rows[0];
    assert_eq!(
        (row.level.as_str(), row.level_no, row.source.as_str(), row.logger.as_str(), row.message.as_str()),
        ("INFO", 20, "api", "app.audit", "failed login for 'nobody'")
    );
    assert_eq!(row.request_id.as_deref(), Some(rid.as_str()));
    assert!(row.host.as_deref().is_some_and(|h| !h.is_empty() && h.chars().count() <= 64));

    // secrets and token shapes are masked (the name tried is logged; it here holds a secret)
    login(&db.app, json!({"username": "jwt-secret-for-redaction-test", "password": "x"})).await;
    login(&db.app, json!({"username": "token=abcdefghijklmnopq", "password": "x"})).await;
    let rows = stored(&db).await;
    assert_eq!(rows[1].message, "failed login for '***'");
    assert_eq!(rows[2].message, "failed login for 'token=***'");

    // admin actions: names only, never the password
    let admin = db.admin().await;
    let eid = db.user_id("engineer").await;
    let r = send(&db.app, Method::POST, "/users", Some(&admin), Some(json!({"username": "newbie", "full_name": "N", "password": "newbie-pass"}))).await;
    assert_eq!(r.status, StatusCode::CREATED);
    let r = send(&db.app, Method::PATCH, &format!("/users/{eid}"), Some(&admin), Some(json!({"password": "changed-pass", "full_name": "E", "role": null}))).await;
    assert_eq!(r.status, StatusCode::OK);
    send(&db.app, Method::PATCH, &format!("/users/{eid}"), Some(&admin), Some(json!({}))).await;
    send(&db.app, Method::PUT, &format!("/users/{eid}/plants"), Some(&admin), Some(json!({"plant_ids": []}))).await;
    // a refused change is not logged as done
    send(&db.app, Method::PATCH, "/users/424242", Some(&admin), Some(json!({"full_name": "x"}))).await;
    let msgs: Vec<String> = stored(&db).await.into_iter().skip(3).filter(|r| r.logger == "app.audit").map(|r| r.message).collect();
    assert_eq!(
        msgs,
        [
            "admin created user newbie (engineer)".to_owned(),
            format!("admin changed user {eid}: full_name, password, role"),
            format!("admin changed user {eid}: nothing"),
            format!("admin set user {eid}'s plants: 0 assigned"),
        ]
    );
    assert!(stored(&db).await.iter().all(|r| !r.message.contains("changed-pass") && !r.message.contains("newbie-pass")));
    db.finish().await;
}

#[tokio::test]
async fn slow_requests_and_level_threshold() {
    // every request is "slow" (> -1 ms); the route template, not the path, is logged
    let Some(db) = TestDb::with_logs(|s| s.log_slow_request_ms = -1).await else { return };
    let admin = db.admin().await;
    let eid = db.user_id("engineer").await;
    send(&db.app, Method::PATCH, &format!("/api/users/{eid}"), Some(&admin), Some(json!({}))).await;
    send(&db.app, Method::GET, "/health", None, None).await;
    send(&db.app, Method::GET, "/api/no/such/route", None, None).await;
    let slow: Vec<Stored> = stored(&db).await.into_iter().filter(|r| r.logger == "app.api.request").collect();
    let re = regex::Regex::new(r"^(\S+) (\S+) slow: \d+ ms \(status (\d+)\)$").unwrap();
    let got: Vec<(String, String, String)> = slow
        .iter()
        .map(|r| {
            assert_eq!((r.level.as_str(), r.level_no), ("WARNING", 30));
            let c = re.captures(&r.message).unwrap_or_else(|| panic!("{}", r.message));
            (c[1].to_owned(), c[2].to_owned(), c[3].to_owned())
        })
        .collect();
    let want = [
        ("POST", "/auth/login", "200"),
        ("PATCH", "/api/users/{user_id}", "200"),
        ("GET", "/health", "200"),
        ("GET", "/api/no/such/route", "404"),
    ];
    assert_eq!(got, want.map(|(a, b, c)| (a.to_owned(), b.to_owned(), c.to_owned())));
    db.finish().await;

    // LOG_DB_LEVEL=WARNING: the INFO audit line is not stored
    let Some(db) = TestDb::with_logs(|s| s.log_db_level = "warning".into()).await else { return };
    login(&db.app, json!({"username": "nobody", "password": "x"})).await;
    assert!(stored(&db).await.is_empty());
    db.finish().await;

    // LOG_DB_ENABLED=false: no handler at all
    let Some(db) = TestDb::with_logs(|s| s.log_db_enabled = false).await else { return };
    assert!(db.logs.is_none());
    login(&db.app, json!({"username": "nobody", "password": "x"})).await;
    assert!(stored(&db).await.is_empty());
    db.finish().await;
}

#[tokio::test]
async fn unhandled_errors_are_logged_with_their_text() {
    let Some(db) = TestDb::with_logs(|_| {}).await else { return };
    let admin = db.admin().await;
    // break the table the route reads: the handler fails like an unhandled exception in Python
    sqlx::query("ALTER TABLE user_plant_assignments RENAME TO upa_gone").execute(&db.pool).await.unwrap();
    let r = send(&db.app, Method::GET, "/api/users", Some(&admin), None).await;
    assert_eq!(r.status, StatusCode::INTERNAL_SERVER_ERROR);
    let rows = stored(&db).await;
    let row = rows.iter().find(|r| r.logger == "app.api.request").expect("request log row");
    assert_eq!((row.level.as_str(), row.level_no, row.message.as_str()), ("ERROR", 40, "GET /api/users failed: unhandled exception"));
    assert!(row.exc_text.as_deref().is_some_and(|t| t.contains("user_plant_assignments")), "{row:?}");
    // no second "answered 500" warning for the same request
    assert_eq!(rows.iter().filter(|r| r.logger == "app.api.request").count(), 1);
    db.finish().await;
}

fn record(msg: &str) -> Record {
    Record { level: "INFO", level_no: 20, logger: "app.test".into(), message: msg.into(), exc_text: None, extra: None }
}

#[tokio::test]
async fn buffer_limit_and_filters() {
    let Some(db) = TestDb::with_logs(|s| s.log_buffer_max = 2).await else { return };
    let sink = db.logs.clone().unwrap();
    for m in ["one", "two", "three"] {
        sink.emit(record(m));
    }
    // never stored: SQL, below the level, quiet HTTP crates below WARNING
    sink.emit(Record { logger: "sqlx::query".into(), ..record("SELECT 1") });
    sink.emit(Record { level: "DEBUG", level_no: 10, ..record("debug") });
    sink.emit(Record { logger: "hyper::proto".into(), ..record("chatty") });
    sink.emit(Record { level: "WARNING", level_no: 30, logger: "reqwest::connect".into(), ..record("kept: a warning") });
    let long = "é".repeat(5000);
    sink.emit(Record { extra: Some(json!({"url": "https://x?key=abc"})), exc_text: Some(long.clone()), ..record(&long) });
    sink.flush(false).await;
    let rows = stored(&db).await;
    let msgs: Vec<&str> = rows.iter().map(|r| r.message.as_str()).collect();
    assert_eq!(msgs.len(), 3, "{msgs:?}");
    assert_eq!(msgs[0], "kept: a warning");
    assert_eq!(msgs[1].chars().count(), 4000 - 20 + " … [truncated]".chars().count());
    assert!(msgs[1].ends_with(" … [truncated]"));
    assert_eq!(rows[2].logger, "app.logging_db");
    assert_eq!((rows[2].level.as_str(), msgs[2]), ("WARNING", "log buffer full: 3 older records dropped"));
    let extra: Option<Value> = sqlx::query_scalar("SELECT extra_json FROM app_logs WHERE extra_json IS NOT NULL").fetch_one(&db.pool).await.unwrap();
    assert_eq!(extra, Some(json!({"url": "https://x?key=***"})));
    assert_eq!(sink.pending(), 0);
    db.finish().await;
}

#[tokio::test]
async fn a_failed_insert_keeps_the_records_and_pauses() {
    // no database needed: a pool that can't connect
    let dead = PgPoolOptions::new()
        .acquire_timeout(Duration::from_secs(1))
        .connect_lazy("postgres://nobody:x@127.0.0.1:1/none")
        .unwrap();
    let s = Settings { log_buffer_max: 3, ..settings("postgres://nobody:x@127.0.0.1:1/none") };
    let sink = DbLog::from_settings("api", &s, dead).unwrap();
    sink.emit(record("a"));
    sink.emit(record("b"));
    assert!(!sink.waiting());
    sink.flush(false).await;
    assert_eq!(sink.pending(), 2, "records go back in the buffer");
    assert!(sink.waiting(), "flushes pause after a failure");
    sink.flush(false).await; // skipped during the pause
    sink.emit(record("c"));
    sink.emit(record("d"));
    assert_eq!(sink.pending(), 3, "the buffer limit still holds");
    sink.flush(true).await; // shutdown ignores the pause (and fails again)
    assert_eq!(sink.pending(), 3);
}
