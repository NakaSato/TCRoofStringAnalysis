//! `/growatt/live/*` (routes/growatt/live.rs) against a stub Growatt OpenAPI served in-process
//! (the client's base URL points at it, as `GROWATT_BASE_URL` does). Needs `TEST_DATABASE_URL`
//! (rust/scripts/test_pg.sh); without it the tests skip.

mod common;

use std::collections::{HashMap, HashSet};
use std::sync::Mutex;

use axum::extract::{Path, RawQuery, State};
use axum::routing::{get, post};
use chrono::{Duration as CDuration, NaiveDateTime};
use common::*;

// ------------------------------------------------------------------------------- stub Growatt

#[derive(Default)]
struct Stub {
    calls: Mutex<HashMap<String, usize>>,
    /// serials / plant ids / paths answered with 10012
    refuse: Mutex<HashSet<String>>,
}

impl Stub {
    fn hit(&self, what: &str) {
        *self.calls.lock().unwrap().entry(what.to_owned()).or_default() += 1;
    }
    fn calls(&self, what: &str) -> usize {
        self.calls.lock().unwrap().get(what).copied().unwrap_or(0)
    }
    fn refused(&self, what: &str) -> bool {
        self.refuse.lock().unwrap().contains(what)
    }
}

fn local_now() -> NaiveDateTime {
    Utc::now().naive_utc() + CDuration::hours(7)
}

fn fmt(t: NaiveDateTime) -> String {
    t.format("%Y-%m-%d %H:%M:%S").to_string()
}

fn ok(data: Value) -> Json {
    J(json!({"error_code": 0, "error_msg": "", "data": data}))
}

fn limited() -> Json {
    J(json!({"error_code": 10012, "error_msg": "error_frequently_access"}))
}

type Json = axum::Json<Value>;
use axum::Json as J;

fn params(raw: &Option<String>, body: &str) -> HashMap<String, String> {
    let mut m: HashMap<String, String> = form_urlencoded::parse(raw.as_deref().unwrap_or("").as_bytes()).into_owned().collect();
    m.extend(form_urlencoded::parse(body.as_bytes()).into_owned());
    m
}

/// A `max_data` record `mins` minutes old, four strings, string 4 open when `open4`.
fn max_record(sn: &str, mins: i64, open4: bool) -> Value {
    let t = local_now() - CDuration::minutes(mins);
    json!({
        "serialNum": sn, "time": fmt(t), "status": 1, "pac": 20000.0, "ppv": 21000.0,
        "eacToday": 50.5, "eacTotal": 1000.0, "temperature": 41.0, "fac": 50.01,
        "vpv1": 600.0, "ipv1": 16.0, "ppv1": 9600.0, "vpv2": 610.0, "ipv2": 16.2, "ppv2": 9882.0,
        "vString1": 600.0, "currentString1": 8.0, "vString2": 600.0, "currentString2": 8.1,
        "vString3": 610.0, "currentString3": 8.0, "vString4": 610.0, "currentString4": if open4 { 0.0 } else { 8.2 },
        "faultType": 0, "warnCode": 0, "pvIso": 65535, "epv1Today": 25.0, "epv1Total": 500.0,
        "vacr": 230.0, "iacr": 29.0, "pf": 1.0, "timeTotal": 3600000,
    })
}

async fn plant_list(State(s): State<Arc<Stub>>) -> Json {
    s.hit("plant/list");
    if s.refused("plant/list") {
        return limited();
    }
    ok(json!({"count": 3, "plants": [
        {"plant_id": 7001, "name": "Live A", "current_power": "12.5", "total_energy": "1000", "peak_power": 100, "status": 1},
        {"plant_id": 7002, "name": "Live B", "current_power": "", "total_energy": null, "peak_power": "50.5", "status": 4},
        {"plant_id": "7003", "name": "Live C", "current_power": 0, "total_energy": "x", "peak_power": 0, "status": 0},
    ]}))
}

async fn plant_data(State(s): State<Arc<Stub>>, RawQuery(q): RawQuery) -> Json {
    s.hit("plant/data");
    let p = params(&q, "");
    let pid = p.get("plant_id").cloned().unwrap_or_default();
    if s.refused(&format!("pdata {pid}")) {
        return limited();
    }
    let upd = if pid == "7002" { fmt(local_now() - CDuration::days(1)) } else { fmt(local_now() - CDuration::minutes(3)) };
    ok(json!({"today_energy": "123.4", "last_update_time": upd}))
}

async fn dataloggers(State(s): State<Arc<Stub>>) -> Json {
    s.hit("datalogger/list");
    ok(json!({"count": 2, "dataloggers": [
        {"sn": "DL2", "model": "ShineMaster", "lost": "false", "last_update_time": {"time": 1_763_002_800_000_i64}},
        {"sn": " DL1 ", "model": "", "lost": true, "last_update_time": null},
    ]}))
}

async fn maxs_data(State(s): State<Arc<Stub>>, RawQuery(q): RawQuery, body: String) -> Json {
    s.hit("maxs_data");
    let p = params(&q, &body);
    let mut out = serde_json::Map::new();
    for sn in p.get("maxs").map(String::as_str).unwrap_or("").split(',').filter(|s| !s.is_empty()) {
        if sn.ends_with('Z') {
            continue; // not answered: absent
        }
        let mut rec = max_record(sn, 2, false);
        rec["statusText"] = json!("Normal");
        rec["lost"] = json!("false");
        out.insert(sn.into(), json!({sn: rec, "dataloggerSn": "DL1"}));
    }
    ok(Value::Object(out))
}

async fn max_data(State(s): State<Arc<Stub>>, RawQuery(q): RawQuery, body: String) -> Json {
    let p = params(&q, &body);
    let sn = p.get("max_sn").cloned().unwrap_or_default();
    s.hit(&format!("max_data {sn}"));
    tokio::time::sleep(Duration::from_millis(150)).await; // lets concurrent requests overlap
    if s.refused(&sn) {
        return limited();
    }
    let recs: Vec<Value> = (0..8).map(|i| max_record(&sn, 2 + 5 * i, sn.ends_with('B'))).collect();
    ok(json!({"count": recs.len(), "datas": recs}))
}

async fn max_last(State(s): State<Arc<Stub>>, RawQuery(q): RawQuery, body: String) -> Json {
    let p = params(&q, &body);
    let sn = p.get("max_sn").cloned().unwrap_or_default();
    s.hit(&format!("max_last_data {sn}"));
    if s.refused(&format!("last {sn}")) {
        return limited();
    }
    ok(max_record(&sn, 1, false))
}

async fn query_last(State(s): State<Arc<Stub>>) -> Json {
    s.hit("queryLastData");
    J(json!({"code": 10012, "message": "error_frequently_access"}))
}

async fn alarm_data(State(s): State<Arc<Stub>>, RawQuery(q): RawQuery, body: String) -> Json {
    let p = params(&q, &body);
    let (sn, day) = (p.get("max_sn").cloned().unwrap_or_default(), p.get("date").cloned().unwrap_or_default());
    s.hit("alarm_data");
    if s.refused(&format!("alarm {sn}")) {
        return limited();
    }
    ok(json!({"count": 2, "alarms": [
        {"start_time": format!("{day} 09:00:00"), "end_time": format!("{day} 09:10:00"), "alarm_code": 202,
         "alarm_message": "PV isolation low", "fault_type": "", "status": 0},
        {"start_time": format!("{day} 13:30:00"), "end_time": "", "alarm_code": 117, "alarm_message": "",
         "fault_type": 3, "status": 1, "extra": sn},
    ]}))
}

async fn unknown(Path(p): Path<String>) -> Json {
    J(json!({"error_code": 10001, "error_msg": format!("stub has no {p}")}))
}

/// Serves the stub on a free local port; returns its base URL.
async fn serve_stub(stub: Arc<Stub>) -> String {
    let app = axum::Router::new()
        .route("/v1/plant/list", get(plant_list))
        .route("/v1/plant/data", get(plant_data))
        .route("/v1/device/datalogger/list", get(dataloggers))
        .route("/v1/device/max/maxs_data", post(maxs_data))
        .route("/v1/device/max/max_data", post(max_data))
        .route("/v1/device/max/max_last_data", post(max_last))
        .route("/v1/new-api/queryLastData", post(query_last))
        .route("/v1/device/max/alarm_data", post(alarm_data))
        .route("/v1/{*rest}", get(unknown).post(unknown))
        .with_state(stub);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    format!("http://{addr}/v1/")
}

// ------------------------------------------------------------------------------- fixtures

async fn live_db(stub: &Arc<Stub>, tokens: bool) -> Option<TestDb> {
    let base = serve_stub(Arc::clone(stub)).await;
    let db = TestDb::with_settings(
        move |s| {
            s.growatt_base_url = base;
            if tokens {
                s.growatt_token_phase1 = "stub-token".into();
            }
            s.growatt_live_night_ttl_s = 0;
        },
        false,
    )
    .await?;
    let p = &db.pool;
    for (id, phase, lat) in [(7001, Some(1), Some(13.75)), (7002, Some(1), None), (7003, None, Some(14.0)), (7004, Some(2), None)] {
        sqlx::query("INSERT INTO growatt_plants (plant_id, name, phase, latitude, longitude, synced_at) VALUES ($1, $2, $3, $4, $5, now())")
            .bind(id)
            .bind(format!("Live {id}"))
            .bind(phase)
            .bind(lat)
            .bind(lat.map(|_| 100.5))
            .execute(p)
            .await
            .unwrap();
    }
    for (sn, pid, installed) in [("INV7001A", 7001, true), ("INV7001B", 7001, true), ("INV7001X", 7001, false), ("INV7002A", 7002, true), ("INV7004Z", 7004, true)] {
        sqlx::query(
            "INSERT INTO growatt_inverters (device_sn, plant_id, synced_at, not_installed_at) VALUES ($1, $2, now(), CASE WHEN $3 THEN NULL ELSE now() END)",
        )
        .bind(sn)
        .bind(pid)
        .bind(installed)
        .execute(p)
        .await
        .unwrap();
    }
    for n in 1..=4 {
        sqlx::query("INSERT INTO growatt_string_layouts (device_sn, string_no, modules, updated_at) VALUES ('INV7001B', $1, 20, now())")
            .bind(n)
            .execute(p)
            .await
            .unwrap();
    }
    let eng = db.user_id("engineer").await;
    db.assign(eng, &[7001]).await;
    Some(db)
}

async fn get_(db: &TestDb, uri: &str, token: &str) -> Res {
    send(&db.app, Method::GET, uri, Some(token), None).await
}

fn assert_envelope(body: &Value) {
    for k in ["source", "fetched_at", "stale", "error", "refresh_in_s", "data"] {
        assert!(body.get(k).is_some(), "envelope key {k}: {body}");
    }
    assert_eq!(body["source"], json!("live"));
    assert!(body["refresh_in_s"].as_i64().unwrap() >= 15);
}

// ------------------------------------------------------------------------------- tests

#[tokio::test]
async fn plants_merged_filtered_and_cached() {
    let stub = Arc::new(Stub::default());
    let Some(db) = live_db(&stub, true).await else { return };
    let admin = db.admin().await;
    let r = get_(&db, "/api/growatt/live/plants", &admin).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    assert_envelope(&r.body);
    assert_eq!(r.body["stale"], json!(false));
    assert_eq!(r.body["refresh_in_s"], json!(120));
    let plants = r.body["data"].as_array().unwrap();
    assert_eq!(plants.len(), 3);
    assert_eq!(plants[0], json!({"plant_id": 7001, "phase": 1, "name": "Live A", "current_power_w": 12.5,
        "total_energy_kwh": 1000.0, "peak_power_kwp": 100.0, "status": 1}));
    assert_eq!(plants[1]["current_power_w"], Value::Null);
    assert_eq!(plants[2]["plant_id"], json!(7003));
    assert_eq!(plants[2]["total_energy_kwh"], Value::Null);
    // cached: no second Growatt call, the same fetched_at; the engineer sees only 7001
    let eng = db.engineer().await;
    let r2 = get_(&db, "/growatt/live/plants", &eng).await;
    assert_eq!(r2.status, StatusCode::OK);
    assert_eq!(stub.calls("plant/list"), 1);
    assert_eq!(r2.body["fetched_at"], r.body["fetched_at"]);
    assert_eq!(r2.body["data"].as_array().unwrap().len(), 1);
    assert!(get_(&db, "/growatt/live/plants", "Bearer nope").await.status == StatusCode::UNAUTHORIZED);
    db.finish().await;
}

#[tokio::test]
async fn unavailable_answers_503() {
    let stub = Arc::new(Stub::default());
    stub.refuse.lock().unwrap().insert("plant/list".into());
    let Some(db) = live_db(&stub, true).await else { return };
    let admin = db.admin().await;
    let r = get_(&db, "/growatt/live/plants", &admin).await;
    assert_eq!(r.status, StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(r.body, json!({"detail": "Growatt live data unavailable: phase 1: Growatt plant/list error 10012: error_frequently_access"}));
    // cooling down: no second call
    let r = get_(&db, "/growatt/live/plants", &admin).await;
    assert_eq!(r.body, json!({"detail": "Growatt live data unavailable: phase 1: Growatt rate limit cooldown"}));
    assert_eq!(stub.calls("plant/list"), 1);
    db.finish().await;

    let stub = Arc::new(Stub::default());
    let Some(db) = live_db(&stub, false).await else { return };
    let admin = db.admin().await;
    for uri in ["/growatt/live/plants", "/growatt/live/plants/today", "/growatt/live/inverters/snapshot", "/growatt/live/plants/7001/latest", "/growatt/live/plants/7001/alarms"] {
        let r = get_(&db, uri, &admin).await;
        assert_eq!(r.status, StatusCode::SERVICE_UNAVAILABLE, "{uri}");
        assert_eq!(r.body, json!({"detail": "Growatt live data unavailable: no Growatt token configured"}), "{uri}");
    }
    db.finish().await;
}

#[tokio::test]
async fn plants_today_sweep() {
    let stub = Arc::new(Stub::default());
    stub.refuse.lock().unwrap().insert("pdata 7003".into());
    let Some(db) = live_db(&stub, true).await else { return };
    let admin = db.admin().await;
    let r = get_(&db, "/growatt/live/plants/today", &admin).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    assert_envelope(&r.body);
    let d = &r.body["data"];
    assert_eq!(d["plants"]["7001"]["today_energy_kwh"], json!(123.4));
    assert_eq!(d["plants"]["7001"]["stale"], json!(false));
    assert_eq!(d["plants"]["7002"]["today_energy_kwh"], Value::Null, "last upload yesterday");
    assert!(d["plants"].get("7003").is_none());
    assert_eq!(d["errors"]["7003"], json!("Growatt plant/data error 10012: error_frequently_access"));
    // 7004 is phase 2: no token for it
    assert_eq!(d["errors"]["7004"], json!("no Growatt token configured for phase 2"));
    assert_eq!(d["sweep"]["total"], json!(4));
    assert_eq!(d["sweep"]["fresh"], json!(2));
    assert_eq!(r.body["refresh_in_s"], json!(15), "7004 stays due");
    let eng = db.engineer().await;
    let r = get_(&db, "/growatt/live/plants/today", &eng).await;
    assert_eq!(r.body["data"]["sweep"]["total"], json!(1));
    assert_eq!(stub.calls("plant/data"), 3);
    db.finish().await;
}

#[tokio::test]
async fn inverter_snapshot() {
    let stub = Arc::new(Stub::default());
    let Some(db) = live_db(&stub, true).await else { return };
    let admin = db.admin().await;
    let r = get_(&db, "/growatt/live/inverters/snapshot", &admin).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    let d = &r.body["data"];
    let a = &d["inverters"]["INV7001A"];
    assert_eq!(a["plant_id"], json!(7001));
    assert_eq!(a["status"], json!(1));
    assert_eq!(a["status_label"], json!("Normal"));
    assert_eq!(a["eac_today_kwh"], json!(50.5));
    assert_eq!(a["lost"], json!(false));
    assert_eq!(a["datalogger_sn"], json!("DL1"));
    assert!(d["inverters"].get("INV7001X").is_none(), "not installed");
    // 7004 (phase 2, no token): its chunk fails alone
    assert_eq!(d["errors"].as_object().unwrap().len(), 1);
    let (cid, msg) = d["errors"].as_object().unwrap().iter().next().unwrap();
    assert!(cid.starts_with("p2#1:"), "{cid}");
    assert_eq!(msg, &json!("no Growatt token configured for phase 2"));
    assert_eq!(d["sweep"]["inverters"], json!(4));
    assert_eq!(d["sweep"]["answered"], json!(3));
    let eng = db.engineer().await;
    let r = get_(&db, "/growatt/live/inverters/snapshot?plant_id=7001", &eng).await;
    assert_eq!(r.status, StatusCode::OK);
    assert_eq!(r.body["data"]["inverters"].as_object().unwrap().len(), 2);
    assert_eq!(get_(&db, "/growatt/live/inverters/snapshot?plant_id=7002", &eng).await.status, StatusCode::NOT_FOUND);
    assert_eq!(get_(&db, "/growatt/live/inverters/snapshot?plant_id=x", &eng).await.status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(stub.calls("maxs_data"), 1, "chunk cached");
    db.finish().await;
}

#[tokio::test]
async fn plant_latest_with_string_check_and_single_flight() {
    let stub = Arc::new(Stub::default());
    let Some(db) = live_db(&stub, true).await else { return };
    let admin = db.admin().await;
    // three concurrent requests: one max_data call per inverter
    let (a, b, c) = tokio::join!(
        get_(&db, "/growatt/live/plants/7001/latest", &admin),
        get_(&db, "/growatt/live/plants/7001/latest", &admin),
        get_(&db, "/api/growatt/live/plants/7001/latest", &admin),
    );
    assert_eq!(stub.calls("max_data INV7001A"), 1);
    assert_eq!(stub.calls("max_data INV7001B"), 1);
    assert_eq!(stub.calls("max_data INV7001X"), 0, "not installed");
    for r in [&a, &b, &c] {
        assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    }
    let body = &a.body;
    assert_envelope(body);
    let d = &body["data"];
    let invs = d["inverters"].as_array().unwrap();
    assert_eq!(invs.len(), 2);
    let inv = &invs[0];
    assert_eq!(inv["device_sn"], json!("INV7001A"));
    assert_eq!(inv["record_source"], json!("max_data"));
    assert_eq!(inv["interval_s"], json!(300.0));
    assert_eq!(inv["strings"].as_array().unwrap().len(), 4);
    assert_eq!(inv["mppt"][0], json!({"mppt": 1, "v": 600.0, "i": 16.0, "p": 9600.0}));
    assert_eq!(inv["mppt_energy"], json!([{"mppt": 1, "today_kwh": 25.0, "total_kwh": 500.0}]));
    assert_eq!(inv["diagnostics"]["pv_iso_kohm"], Value::Null);
    assert_eq!(inv["diagnostics"]["time_total_h"], json!(1000.0));
    assert_eq!(inv["power"].as_array().unwrap().len(), 8);
    assert!(inv.get("previous_strings").is_none(), "dropped from the answer");
    assert_eq!(inv["stale"], json!(false));
    // string 4 of B carries no current in all 6 records: Critical, confirmed
    let check = &d["string_check"];
    assert_eq!(check["inverters"]["INV7001B"]["strings"]["4"]["status"], json!("Critical"));
    assert_eq!(check["inverters"]["INV7001B"]["records_judged"], json!(6));
    assert_eq!(check["inverters"]["INV7001B"]["voltage_basis"], json!("per_module"));
    assert_eq!(check["inverters"]["INV7001A"]["strings"]["1"]["status"], json!("Healthy"));
    assert_eq!(check["summary"]["critical"], json!(1));
    assert_eq!(check["summary"]["checked_inverters"], json!(2));
    // dataloggers, sorted, trimmed, with Growatt's flags
    assert_eq!(d["dataloggers_error"], Value::Null);
    let dl = d["dataloggers"].as_array().unwrap();
    assert_eq!(dl[0]["datalogger_sn"], json!("DL1"));
    assert_eq!(dl[0]["model"], Value::Null);
    assert_eq!(dl[0]["lost"], json!(true));
    assert_eq!(dl[1]["last_update_time"], json!("2025-11-13 10:00:00"));
    assert_eq!(stub.calls("datalogger/list"), 1);
    // refresh: the next record is due ~3 min + grace after the newest (2 min old) but never sooner
    // than device_gap_s (270 s)
    let refresh = body["refresh_in_s"].as_i64().unwrap();
    assert!((268..=270).contains(&refresh), "{refresh}");

    // 404 without installed inverters; engineers only for their plants
    assert_eq!(get_(&db, "/growatt/live/plants/7003/latest", &admin).await.status, StatusCode::NOT_FOUND);
    let eng = db.engineer().await;
    assert_eq!(get_(&db, "/growatt/live/plants/7002/latest", &eng).await.status, StatusCode::NOT_FOUND);
    assert_eq!(get_(&db, "/growatt/live/plants/abc/latest", &eng).await.status, StatusCode::UNPROCESSABLE_ENTITY);
    db.finish().await;
}

#[tokio::test]
async fn plant_latest_fallback_and_refused_inverter() {
    let stub = Arc::new(Stub::default());
    {
        let mut r = stub.refuse.lock().unwrap();
        r.insert("INV7001A".into()); // max_data refused, max_last_data answers
        r.insert("INV7001B".into()); // max_data refused ...
        r.insert("last INV7001B".into()); // ... and max_last_data too (queryLastData always refuses)
    }
    let Some(db) = live_db(&stub, true).await else { return };
    let admin = db.admin().await;
    let r = get_(&db, "/growatt/live/plants/7001/latest", &admin).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    let d = &r.body["data"];
    let invs = d["inverters"].as_array().unwrap();
    assert_eq!(invs.len(), 1);
    assert_eq!(invs[0]["record_source"], json!("max_last_data"));
    assert_eq!(invs[0]["interval_s"], Value::Null);
    assert_eq!(d["errors"], json!({"INV7001B": "Growatt device/max/max_data error 10012: error_frequently_access"}));
    assert_eq!(r.body["error"], json!("INV7001B: Growatt device/max/max_data error 10012: error_frequently_access"));
    assert_eq!(r.body["stale"], json!(false), "one inverter is fresh");
    db.finish().await;
}

#[tokio::test]
async fn plant_alarms() {
    let stub = Arc::new(Stub::default());
    stub.refuse.lock().unwrap().insert("alarm INV7001B".into());
    let Some(db) = live_db(&stub, true).await else { return };
    let admin = db.admin().await;
    let r = get_(&db, "/growatt/live/plants/7001/alarms?day=2026-11-20&days=2", &admin).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    let d = &r.body["data"];
    assert_eq!(d["from"], json!("2026-11-19"));
    assert_eq!(d["to"], json!("2026-11-20"));
    let alarms = d["alarms"].as_array().unwrap();
    assert_eq!(alarms.len(), 4);
    assert_eq!(alarms[0]["start_time"], json!("2026-11-20 13:30:00"));
    assert_eq!(alarms[0]["end_time"], Value::Null);
    assert_eq!(alarms[0]["alarm_message"], Value::Null);
    assert_eq!(alarms[0]["fault_type"], json!(3));
    assert_eq!(alarms[1]["fault_type"], Value::Null);
    assert_eq!(alarms[3]["start_time"], json!("2026-11-19 09:00:00"));
    assert_eq!(d["errors"].as_object().unwrap().len(), 2);
    assert_eq!(d["errors"]["INV7001B 2026-11-19"], json!("Growatt device/max/alarm_data error 10012: error_frequently_access"));
    // past days are kept 6 h
    assert_eq!(r.body["refresh_in_s"], json!(60), "the refused days retry after their cooldown");
    assert_eq!(stub.calls("alarm_data"), 4);
    let r2 = get_(&db, "/growatt/live/plants/7001/alarms?day=2026-11-20&days=2", &admin).await;
    assert_eq!(r2.body["data"]["alarms"], r.body["data"]["alarms"]);
    assert_eq!(stub.calls("alarm_data"), 4, "cached");
    for bad in ["days=0", "days=32", "days=x", "day=2026-13-01", "day=20261120"] {
        let r = get_(&db, &format!("/growatt/live/plants/7001/alarms?{bad}"), &admin).await;
        assert_eq!(r.status, StatusCode::UNPROCESSABLE_ENTITY, "{bad}");
    }
    // default window: 7 days ending today
    let r = get_(&db, "/growatt/live/plants/7001/alarms", &admin).await;
    assert_eq!(r.status, StatusCode::OK);
    let today = local_now().date();
    assert_eq!(r.body["data"]["to"], json!(today.to_string()));
    assert_eq!(r.body["data"]["from"], json!((today - CDuration::days(6)).to_string()));
    assert_eq!(get_(&db, "/growatt/live/plants/7003/alarms", &admin).await.status, StatusCode::NOT_FOUND);
    db.finish().await;
}
