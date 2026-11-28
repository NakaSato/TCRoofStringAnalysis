//! Integration tests of the Issues queue, the daily rule / KPI rows and the Site log
//! (routes/growatt/issues.rs, events.rs), against the parity seed rows of
//! rust/tests/parity/seed.d/80_rules_events.sql. Run with rust/scripts/test_pg.sh.
//!
//! The expected behaviour is Python's: backend/app/api/routes/growatt/rules.py and events.py,
//! backend/app/services/{growatt_issues,site_events}.py.

mod common;
use common::*;

const SEED: &str = include_str!("../../../tests/parity/seed.d/80_rules_events.sql");

async fn db() -> Option<TestDb> {
    let db = TestDb::new().await?;
    sqlx::raw_sql(SEED).execute(&db.pool).await.expect("seed 80_rules_events.sql");
    Some(db)
}

async fn req(db: &TestDb, method: Method, uri: &str, tok: &str, body: Option<Value>) -> Res {
    send(&db.app, method, uri, Some(tok), body).await
}

fn ids(v: &Value, key: &str) -> Vec<i64> {
    v[key].as_array().unwrap().iter().map(|i| i["id"].as_i64().unwrap()).collect()
}

// --------------------------------------------------------------------------- issues

#[tokio::test]
async fn issues_scoping_and_shadow() {
    let Some(db) = db().await else { return };
    let (admin, eng) = (db.admin().await, db.engineer().await);

    // admin, live active of 8602: safety first, then tier / THB/day
    let r = req(&db, Method::GET, "/growatt/issues?plant_id=8602", &admin, None).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    assert_eq!(ids(&r.body, "issues"), vec![86002, 86006, 86001, 86009]);
    assert_eq!(r.body["summary"]["active"], 4);
    assert_eq!(r.body["summary"]["safety"], 1);
    assert_eq!(r.body["summary"]["thb_per_day_est"], json!(132.0));
    assert_eq!(r.body["meta"]["source"], "db");
    let first = &r.body["issues"][0];
    assert_eq!(first["name"], "Insulation / ground fault");
    assert_eq!(first["inverter_name"], "B2");
    assert_eq!(first["plant_name"], "Rules Beta");
    assert_eq!(first["ack_at"], "2026-11-27T02:15:00.500000+00:00");
    let r1 = &r.body["issues"][2];
    assert_eq!(r1["inverter_name"], "EVTB0001", "empty alias = the serial");
    assert_eq!(r1["evidence"]["low_min"], 240);
    assert_eq!(r.body["issues"][3]["name"], "R99", "unknown rule keeps its code");

    // shadow only / both
    let r = req(&db, Method::GET, "/growatt/issues?plant_id=8602&shadow=true", &admin, None).await;
    assert_eq!(ids(&r.body, "issues"), vec![86003]);
    let r = req(&db, Method::GET, "/growatt/issues?plant_id=8602&status=all&include_shadow=true", &admin, None).await;
    assert_eq!(r.body["total"], 7);
    let r = req(&db, Method::GET, "/growatt/issues?plant_id=8602&status=all&tier=P1&include_shadow=true", &admin, None).await;
    assert_eq!(ids(&r.body, "issues"), vec![86002, 86003]);
    assert_eq!(r.body["summary"]["active"], 5, "summary before the tier filter");

    // engineer: never shadow, other plants 404
    let r = req(&db, Method::GET, "/growatt/issues?status=all&shadow=true&include_shadow=true", &eng, None).await;
    assert_eq!(r.status, StatusCode::OK);
    let got = ids(&r.body, "issues");
    assert!(!got.contains(&86003) && !got.contains(&86007) && !got.contains(&86008), "{got:?}");
    assert!(got.contains(&86001));
    let r = req(&db, Method::GET, "/growatt/issues?plant_id=8601", &eng, None).await;
    assert_eq!(r.status, StatusCode::NOT_FOUND);
    assert_eq!(r.body["detail"], "Plant 8601 not found");
    for (uri, code) in [
        ("/growatt/issues/86003", StatusCode::NOT_FOUND),
        ("/growatt/issues/86007", StatusCode::NOT_FOUND),
        ("/growatt/issues/86001", StatusCode::OK),
        ("/growatt/issues/abc", StatusCode::UNPROCESSABLE_ENTITY),
    ] {
        assert_eq!(req(&db, Method::GET, uri, &eng, None).await.status, code, "{uri}");
    }
    let r = req(&db, Method::GET, "/api/growatt/issues/86004", &admin, None).await;
    assert_eq!(r.body["daily"], json!({}), "JSON null daily = {{}}");
    for bad in ["status=bogus", "tier=P9", "rule=R123456789", "shadow=maybe"] {
        let r = req(&db, Method::GET, &format!("/growatt/issues?{bad}"), &admin, None).await;
        assert_eq!(r.status, StatusCode::UNPROCESSABLE_ENTITY, "{bad}");
    }
    db.finish().await;
}

#[tokio::test]
async fn issue_patch_transitions() {
    let Some(db) = db().await else { return };
    let (admin, eng) = (db.admin().await, db.engineer().await);
    let patch = |id: i64, tok: String, body: Value| {
        let app = db.app.clone();
        async move { send(&app, Method::PATCH, &format!("/growatt/issues/{id}"), Some(&tok), Some(body)).await }
    };

    assert_eq!(patch(86003, eng.clone(), json!({"action": "acknowledge"})).await.status, StatusCode::NOT_FOUND, "shadow");
    assert_eq!(patch(86007, eng.clone(), json!({"action": "acknowledge"})).await.status, StatusCode::NOT_FOUND);
    assert_eq!(patch(86001, eng.clone(), json!({"action": "close"})).await.status, StatusCode::UNPROCESSABLE_ENTITY);

    let r = patch(86001, eng.clone(), json!({"action": "acknowledge", "note": "  on it "})).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    assert_eq!(r.body["status"], "acknowledged");
    assert_eq!(r.body["ack_by"], "engineer");
    assert_eq!(r.body["note"], "on it");
    assert!(r.body["ack_at"].as_str().unwrap().ends_with("+00:00"));

    let r = patch(86001, admin.clone(), json!({"action": "note", "note": "  ", "feedback": "false_alarm"})).await;
    assert_eq!(r.body["note"], Value::Null);
    assert_eq!(r.body["feedback"], "false_alarm");

    let r = patch(86001, eng.clone(), json!({"action": "resolve"})).await;
    assert_eq!(r.body["status"], "resolved");
    assert_eq!(r.body["close_reason"], "resolved");
    assert_eq!(r.body["closed_by"], "engineer");
    assert_eq!(r.body["feedback"], "confirmed");

    let r = patch(86001, admin.clone(), json!({"action": "resolve"})).await;
    assert_eq!(r.status, StatusCode::CONFLICT);
    assert_eq!(r.body["detail"], "Issue is resolved");

    // reopen 86001; its dismissed twin 86005 (same string and rule) then clashes with it
    let r = patch(86001, admin.clone(), json!({"action": "reopen"})).await;
    assert_eq!(r.status, StatusCode::OK);
    assert_eq!(r.body["status"], "open");
    assert_eq!(r.body["closed_at"], Value::Null);
    assert_eq!(r.body["feedback"], Value::Null);
    let r = patch(86005, admin.clone(), json!({"action": "reopen"})).await;
    assert_eq!(r.status, StatusCode::CONFLICT);
    assert_eq!(r.body["detail"], "Issue #86001 is already open for this string and rule");
    let r = patch(86001, admin.clone(), json!({"action": "reopen"})).await;
    assert_eq!(r.body["detail"], "Issue is already open");

    let r = patch(86003, admin.clone(), json!({"action": "dismiss"})).await;
    assert_eq!(r.body["status"], "dismissed");
    assert_eq!(r.body["feedback"], "false_alarm");
    db.finish().await;
}

// --------------------------------------------------------------------------- daily rows

#[tokio::test]
async fn rule_and_kpi_daily() {
    let Some(db) = db().await else { return };
    let (admin, eng) = (db.admin().await, db.engineer().await);

    let r = req(&db, Method::GET, "/growatt/plants/8602/rules/daily?sn=EVTB0001&days=10", &eng, None).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    let days = r.body["days"].as_array().unwrap();
    assert_eq!(days.len(), 2);
    assert_eq!(days[1]["energy_kwh"], json!(210.0));
    assert_eq!(days[1]["fault_min"], 30);
    assert_eq!(days[1]["lost_off_kwh_est"], Value::Null);
    assert_eq!(r.body["string_no"], Value::Null);
    assert_eq!(r.body["meta"]["estimated"].as_array().unwrap().len(), 4);

    let r = req(&db, Method::GET, "/growatt/plants/8602/rules/daily?sn=EVTB0001&string_no=2", &admin, None).await;
    let days = r.body["days"].as_array().unwrap();
    assert_eq!(days.len(), 2);
    assert_eq!(days[0]["voltage_sensing"], "per_string");
    assert_eq!(days[1]["ratio_median"], json!(0.78));
    assert_eq!(r.body["meta"]["estimated"], json!(["lost_kwh_est"]));

    for bad in ["", "?sn=EVTB0001&string_no=0", "?sn=EVTB0001&days=366", "?sn=EVTB0001&day=2026-02-30"] {
        let r = req(&db, Method::GET, &format!("/growatt/plants/8602/rules/daily{bad}"), &admin, None).await;
        assert_eq!(r.status, StatusCode::UNPROCESSABLE_ENTITY, "{bad}");
    }
    assert_eq!(req(&db, Method::GET, "/growatt/plants/8601/rules/daily?sn=EVTA0001", &eng, None).await.status, StatusCode::NOT_FOUND);

    let r = req(&db, Method::GET, "/growatt/plants/8602/kpi-daily?days=7", &admin, None).await;
    assert_eq!(r.status, StatusCode::OK);
    let days = r.body["days"].as_array().unwrap();
    assert_eq!(days.len(), 4);
    // oldest first: below neighbours on a clear day, no evidence, stale + above clear sky, clean
    assert_eq!(days[0]["sensor_flags"], json!(["below_neighbours"]));
    assert_eq!(days[1]["sensor_ok"], Value::Null);
    assert_eq!(days[1]["sensor_flags"], json!([]));
    assert_eq!(days[2]["sensor_flags"], json!(["stale", "above_clear_sky"]));
    assert_eq!(days[3]["sensor_ok"], json!(true));
    assert_eq!(days[3]["pr_pct"], json!(93.75));
    assert_eq!(r.body["epi_factor"]["basis"], "fitted");
    assert_eq!(r.body["epi_factor"]["factor"], json!(0.941));
    let r = req(&db, Method::GET, "/growatt/plants/8603/kpi-daily", &eng, None).await;
    assert_eq!(r.body["epi_factor"]["basis"], "default");
    assert_eq!(r.body["epi_factor"]["status"], "too_few_days");
    assert_eq!(req(&db, Method::GET, "/growatt/plants/8601/kpi-daily", &eng, None).await.status, StatusCode::NOT_FOUND);
    db.finish().await;
}

// --------------------------------------------------------------------------- site log

#[tokio::test]
async fn events_list_and_scoping() {
    let Some(db) = db().await else { return };
    let (admin, eng) = (db.admin().await, db.engineer().await);

    let r = req(&db, Method::GET, "/growatt/events", &admin, None).await;
    assert_eq!(r.status, StatusCode::OK);
    assert_eq!(ids(&r.body, "events"), vec![86101, 86104, 86103, 86110, 86102, 86111, 86105]);
    assert_eq!(r.body["summary"]["cost_thb"], json!(14750.85));
    assert_eq!(r.body["summary"]["costed"], 5);
    assert_eq!(r.body["summary"]["by_type"]["cleaning"], 2);
    assert_eq!(r.body["types"].as_array().unwrap().len(), 10);
    let shadow_linked = &r.body["events"][2];
    assert_eq!(shadow_linked["issue_id"], 86003);
    assert_eq!(shadow_linked["issue"]["rule"], "R2");

    let r = req(&db, Method::GET, "/growatt/events", &eng, None).await;
    let evs = r.body["events"].as_array().unwrap();
    assert!(evs.iter().all(|e| e["plant_id"] == 8602));
    let hidden = evs.iter().find(|e| e["id"] == 86103).unwrap();
    assert_eq!(hidden["issue_id"], Value::Null, "shadow link hidden from engineers");
    assert_eq!(hidden["issue"], Value::Null);
    let missing = evs.iter().find(|e| e["id"] == 86104).unwrap();
    assert_eq!(missing["issue_id"], 86077, "a missing issue keeps its id");
    assert_eq!(missing["issue"], Value::Null);
    assert_eq!(req(&db, Method::GET, "/growatt/events?plant_id=8601", &eng, None).await.status, StatusCode::NOT_FOUND);

    // since matches any covered day: the repair runs 5–12 Oct
    let r = req(&db, Method::GET, "/growatt/events?since=2026-10-10&plant_id=8602", &admin, None).await;
    assert_eq!(ids(&r.body, "events"), vec![86101, 86104, 86103, 86102]);
    let r = req(&db, Method::GET, "/growatt/events?limit=1", &admin, None).await;
    assert_eq!(r.body["total"], 7);
    assert_eq!(r.body["events"].as_array().unwrap().len(), 1);
    for bad in ["limit=0", "type=wash", "since=yesterday"] {
        assert_eq!(req(&db, Method::GET, &format!("/growatt/events?{bad}"), &admin, None).await.status, StatusCode::UNPROCESSABLE_ENTITY);
    }

    let r = req(&db, Method::GET, "/growatt/plants/8602/events?sn=EVTB0001", &eng, None).await;
    assert_eq!(r.body["plant_id"], 8602);
    assert_eq!(ids(&r.body, "events"), vec![86102]);
    assert_eq!(r.body["events"][0]["inverter_name"], "EVTB0001");
    let r = req(&db, Method::GET, "/growatt/plants/8601/events", &admin, None).await;
    assert_eq!(r.body["events"][1]["inverter_name"], Value::Null, "unknown inverter");
    assert_eq!(r.body["events"][0]["end_day"], "2026-10-10");
    assert_eq!(req(&db, Method::GET, "/growatt/plants/8601/events", &eng, None).await.status, StatusCode::NOT_FOUND);
    db.finish().await;
}

#[tokio::test]
async fn events_write_validation_and_issue_links() {
    let Some(db) = db().await else { return };
    let (admin, eng) = (db.admin().await, db.engineer().await);
    let ev = json!({"event_type": "cleaning", "day": "2026-11-01", "cost_thb": "1500", "note": "  washed  "});
    let with = |k: &str, v: Value| {
        let mut b = ev.clone();
        b[k] = v;
        b
    };
    let post = "/growatt/plants/8602/events";
    for (body, detail) in [
        (with("day", json!("2099-01-01")), "The date is in the future: record work once it is done"),
        (with("end_day", json!("2026-10-01")), "end_day is before day"),
        (with("string_no", json!(2)), "A string needs its inverter (device_sn)"),
        (with("device_sn", json!("EVTA0001")), "Inverter EVTA0001 does not belong to plant 8602"),
        (with("close_issue", json!(true)), "close_issue needs issue_id"),
        (with("issue_id", json!(86007)), "Issue 86007 is not an issue of plant 8602"),
    ] {
        let r = req(&db, Method::POST, post, &admin, Some(body)).await;
        assert_eq!(r.status, StatusCode::UNPROCESSABLE_ENTITY);
        assert_eq!(r.body["detail"], detail);
    }
    let r = req(&db, Method::POST, post, &eng, Some(with("issue_id", json!(86003)))).await;
    assert_eq!(r.body["detail"], "Issue 86003 is not an issue of plant 8602", "engineers may not link shadow issues");
    for body in [with("cost_thb", json!(-1)), with("event_type", json!("wash")), with("close_issue", Value::Null), json!({"event_type": "repair"})] {
        assert_eq!(req(&db, Method::POST, post, &admin, Some(body)).await.status, StatusCode::UNPROCESSABLE_ENTITY);
    }
    assert_eq!(req(&db, Method::POST, "/growatt/plants/8699/events", &admin, Some(ev.clone())).await.status, StatusCode::NOT_FOUND);
    assert_eq!(req(&db, Method::POST, "/growatt/plants/8601/events", &eng, Some(ev.clone())).await.status, StatusCode::NOT_FOUND);

    // create
    let r = req(&db, Method::POST, post, &eng, Some(ev.clone())).await;
    assert_eq!(r.status, StatusCode::CREATED, "{}", r.body);
    assert_eq!(r.body["note"], "washed");
    assert_eq!(r.body["cost_thb"], json!(1500.0));
    assert_eq!(r.body["created_by"], "engineer");
    assert_eq!(r.body["label"], "Cleaning");
    let mine = r.body["id"].as_i64().unwrap();

    // create closing an issue: resolved as confirmed, its note naming the event
    let body = json!({"event_type": "repair", "day": "2026-11-02", "end_day": "2026-11-02", "device_sn": "EVTB0001",
                      "string_no": "3", "issue_id": 86006, "close_issue": true, "note": "replaced fuse"});
    let r = req(&db, Method::POST, post, &admin, Some(body)).await;
    assert_eq!(r.status, StatusCode::CREATED, "{}", r.body);
    assert_eq!(r.body["end_day"], Value::Null, "end_day == day is one day");
    assert_eq!(r.body["issue"]["status"], "resolved");
    let theirs = r.body["id"].as_i64().unwrap();
    let i = req(&db, Method::GET, "/growatt/issues/86006", &admin, None).await.body;
    assert_eq!(i["feedback"], "confirmed");
    assert_eq!(i["closed_by"], "admin");
    assert_eq!(i["note"], format!("old note\nRepair on 2026-11-02 (site event #{theirs}): replaced fuse"));

    // patch
    let url = format!("{post}/{mine}");
    let r = req(&db, Method::PATCH, &url, &eng, Some(json!({"cost_thb": null, "day": null, "device_sn": "EVTB0001", "string_no": 3}))).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    assert_eq!(r.body["cost_thb"], Value::Null);
    assert_eq!(r.body["day"], "2026-11-01");
    assert_eq!(r.body["string_no"], 3);
    let r = req(&db, Method::PATCH, &url, &eng, Some(json!({"device_sn": null}))).await;
    assert_eq!(r.body["string_no"], Value::Null, "clearing the inverter clears its string");
    let r = req(&db, Method::PATCH, &url, &admin, Some(json!({"close_issue": true}))).await;
    assert_eq!(r.status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(r.body["detail"], "close_issue needs issue_id");
    let r = req(&db, Method::PATCH, &url, &eng, Some(json!({"issue_id": 86002, "close_issue": true}))).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    assert_eq!(r.body["issue"]["status"], "resolved");
    assert_eq!(r.body["updated_by"], "engineer");

    // shadow link: an engineer's issue_id null keeps it, close_issue on it is refused
    let shadow = format!("{post}/86103");
    let r = req(&db, Method::PATCH, &shadow, &eng, Some(json!({"issue_id": null, "note": "seen"}))).await;
    assert_eq!(r.status, StatusCode::OK);
    assert_eq!(r.body["issue_id"], Value::Null, "still hidden");
    let linked: Option<i32> = sqlx::query_scalar("SELECT issue_id FROM site_events WHERE id = 86103").fetch_one(&db.pool).await.unwrap();
    assert_eq!(linked, Some(86003), "the link is kept");
    let r = req(&db, Method::PATCH, &shadow, &eng, Some(json!({"close_issue": true}))).await;
    assert_eq!(r.status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(req(&db, Method::PATCH, &format!("{post}/86110"), &admin, Some(json!({"note": "x"}))).await.status, StatusCode::NOT_FOUND);
    assert_eq!(req(&db, Method::PATCH, &url, &admin, Some(json!({"string_no": 99}))).await.status, StatusCode::UNPROCESSABLE_ENTITY);

    // delete: admin or the recorder
    let r = req(&db, Method::DELETE, &format!("{post}/{theirs}"), &eng, None).await;
    assert_eq!(r.status, StatusCode::FORBIDDEN);
    assert_eq!(r.body["detail"], "Only an admin or the person who recorded it can delete this event");
    assert_eq!(req(&db, Method::DELETE, &format!("{post}/86105"), &eng, None).await.status, StatusCode::FORBIDDEN);
    let r = req(&db, Method::DELETE, &url, &eng, None).await;
    assert_eq!(r.status, StatusCode::NO_CONTENT);
    assert_eq!(r.body, Value::Null);
    assert_eq!(req(&db, Method::DELETE, &url, &eng, None).await.status, StatusCode::NOT_FOUND);
    assert_eq!(req(&db, Method::DELETE, &format!("{post}/86101"), &admin, None).await.status, StatusCode::NO_CONTENT);
    assert_eq!(req(&db, Method::DELETE, "/growatt/plants/8601/events/86110", &eng, None).await.status, StatusCode::NOT_FOUND);
    let i = req(&db, Method::GET, "/growatt/issues/86002", &admin, None).await.body;
    assert_eq!(i["status"], "resolved", "a deleted event leaves its resolved issue resolved");
    db.finish().await;
}
