//! Integration tests of the "history" area: `/growatt/plants/{id}/inverters/{sn}/timeseries|raw|daily`
//! and `/growatt/plants/{id}/strings/{sn}/{n}` (backend/app/api/routes/growatt/plants.py,
//! services/growatt_inverter_history.py, services/growatt_strings.py). Run with rust/scripts/test_pg.sh.
//! The data is the parity seed rust/tests/parity/seed.d/30_history.sql (plants 3001 / 3002).

mod common;
use common::*;

const SEED: &str = include_str!("../../../tests/parity/seed.d/30_history.sql");

async fn seeded() -> Option<TestDb> {
    let db = TestDb::new().await?;
    sqlx::raw_sql(SEED).execute(&db.pool).await.expect("history seed");
    Some(db)
}

async fn get(db: &TestDb, uri: &str, tok: &str) -> Res {
    send(&db.app, Method::GET, uri, Some(tok), None).await
}

#[tokio::test]
async fn ownership_and_scope_answer_404() {
    let Some(db) = seeded().await else { return };
    let (admin, eng) = (db.admin().await, db.engineer().await);
    for sub in ["timeseries", "raw", "daily"] {
        // engineer: an unassigned plant is 404, never 403
        let r = get(&db, &format!("/api/growatt/plants/3002/inverters/H3002A/{sub}"), &eng).await;
        assert_eq!((r.status, r.body.clone()), (StatusCode::NOT_FOUND, json!({"detail": "Plant 3002 not found"})), "{sub}");
        // another plant's inverter under an allowed plant
        let r = get(&db, &format!("/growatt/plants/3001/inverters/H3002A/{sub}"), &eng).await;
        assert_eq!(r.status, StatusCode::NOT_FOUND, "{sub}");
        assert_eq!(r.body["detail"], "Inverter H3002A not found on plant 3001");
        let r = get(&db, &format!("/growatt/plants/3999/inverters/H3001A/{sub}"), &admin).await;
        assert_eq!(r.body["detail"], "Plant 3999 not found");
        assert_eq!(get(&db, &format!("/growatt/plants/3001/inverters/H3001A/{sub}"), &eng).await.status, StatusCode::OK);
    }
    // the string detail checks ownership too (Python does not: cross-plant IDOR)
    let r = get(&db, "/api/growatt/plants/3001/strings/H3002A/1?day=2026-11-20", &eng).await;
    assert_eq!(r.status, StatusCode::NOT_FOUND);
    assert_eq!(r.body["detail"], "Inverter H3002A not found on plant 3001");
    let r = get(&db, "/api/growatt/plants/3002/strings/H3002A/1?day=2026-11-20", &admin).await;
    assert_eq!(r.status, StatusCode::OK);
    // scope before validation: a bad string_no on an unassigned plant is still 404
    assert_eq!(get(&db, "/api/growatt/plants/3002/strings/H3002A/x", &eng).await.status, StatusCode::NOT_FOUND);
    assert_eq!(get(&db, "/api/growatt/plants/3001/strings/H3001A/x", &eng).await.status, StatusCode::UNPROCESSABLE_ENTITY);
    db.finish().await;
}

#[tokio::test]
async fn timeseries_shape_and_capacity() {
    let Some(db) = seeded().await else { return };
    let admin = db.admin().await;
    // A: every string that carried current has a layout row: 3 × 18 × 570 + 16 × 575 W
    let r = get(&db, "/growatt/plants/3001/inverters/H3001A/timeseries", &admin).await;
    assert_eq!(r.status, StatusCode::OK);
    let b = &r.body;
    assert_eq!(b["meta"], json!({"source": "db", "day": "2026-11-21"}));
    assert_eq!(b["capacity_basis"], "string_layout");
    assert_eq!(b["capacity_kwp"], 39.98);
    assert_eq!(b["nominal_power_kw"], 50.0);
    assert_eq!(b["strings"]["string_nos"], json!([1, 2, 3, 4]));
    let ts = b["timeseries"].as_array().unwrap();
    assert_eq!(ts.len(), 145, "00:00 slot + 144 daytime slots");
    assert_eq!(ts[0]["timestamp"], "2026-11-21 00:00:00");
    // slot 06:50 (n = 10) has a null pac, counted as 0
    let n10 = ts.iter().find(|p| p["timestamp"] == "2026-11-21 06:50:00").unwrap();
    assert_eq!(n10["pac_kw"], 0.0);
    // B has no layout: plant kWp / installed inverters (the not-installed one does not count)
    let r = get(&db, "/growatt/plants/3001/inverters/H3001B/timeseries?day=2026-11-20", &admin).await;
    assert_eq!(r.body["capacity_basis"], "plant_share");
    assert_eq!(r.body["capacity_kwp"], 50.0);
    // 3002: Growatt's peak power is implausible for its rated AC → no capacity, no envelope
    let r = get(&db, "/growatt/plants/3002/inverters/H3002A/timeseries", &admin).await;
    assert_eq!(r.body["capacity_kwp"], Value::Null);
    assert!(r.body["timeseries"].as_array().unwrap().iter().all(|p| p["expected_kw"].is_null()));
    // a day without records
    let r = get(&db, "/growatt/plants/3001/inverters/H3001X/timeseries", &admin).await;
    assert_eq!(r.body["meta"]["day"], Value::Null);
    assert_eq!(r.body["timeseries"], json!([]));
    db.finish().await;
}

#[tokio::test]
async fn daily_takes_the_last_counter_of_each_day() {
    let Some(db) = seeded().await else { return };
    let admin = db.admin().await;
    let r = get(&db, "/growatt/plants/3001/inverters/H3001A/daily?day=2026-11-21&days=3", &admin).await;
    assert_eq!(r.status, StatusCode::OK);
    assert_eq!(r.body["meta"], json!({"source": "db", "from": "2026-11-19", "to": "2026-11-21", "days": 3}));
    let d = r.body["daily"].as_array().unwrap();
    assert_eq!(d[0]["yield_kwh"], Value::Null);
    assert_eq!(d[0]["inverters_reporting"], 0);
    // last record 17:55 of 21 Nov: 143 × 0.3517 + 21 / 7 (not the 00:02 carry-over of 77.7)
    assert_eq!(d[2]["yield_kwh"], 53.29);
    assert_eq!(d[2]["inverters_reporting"], 2);
    for bad in ["days=0", "days=91", "days=x", "day=2026-02-30"] {
        let r = get(&db, &format!("/growatt/plants/3001/inverters/H3001A/daily?{bad}"), &admin).await;
        assert_eq!(r.status, StatusCode::UNPROCESSABLE_ENTITY, "{bad}");
    }
    db.finish().await;
}

#[tokio::test]
async fn raw_records_as_reported() {
    let Some(db) = seeded().await else { return };
    let admin = db.admin().await;
    let r = get(&db, "/growatt/plants/3001/inverters/H3001A/raw", &admin).await;
    assert_eq!(r.status, StatusCode::OK);
    assert_eq!(r.body["meta"]["day"], "2026-11-21");
    assert_eq!(r.body["meta"]["records"], 3);
    assert_eq!(r.body["meta"]["source"], "growatt max_data, as reported");
    let f: Vec<&str> = r.body["fields"].as_array().unwrap().iter().map(|v| v.as_str().unwrap()).collect();
    assert_eq!(f, ["faultType", "ipmTemperature", "nested", "pac", "serialNum", "status", "time", "vpv1", "warnCode", "ศัพท์"]);
    let recs = r.body["records"].as_array().unwrap();
    assert_eq!(recs[0]["time"], "2026-11-21 10:00:01");
    assert_eq!(recs[1]["time"], "2026-11-21 10:05:00", "the record's own time wins, as {{'time': ..., **data}}");
    assert_eq!(recs[2]["nested"], json!({"a": [1, 2.5]}));
    let r = get(&db, "/growatt/plants/3001/inverters/H3001B/raw", &admin).await;
    assert_eq!(r.body, json!({"meta": {"plant_id": 3001, "device_sn": "H3001B", "day": null, "source": "growatt max_data, as reported", "records": 0}, "fields": [], "records": []}));
    db.finish().await;
}

#[tokio::test]
async fn string_detail_ranges_and_windows() {
    let Some(db) = seeded().await else { return };
    let admin = db.admin().await;
    let base = "/growatt/plants/3001/strings/H3001A";
    let r = get(&db, &format!("{base}/3"), &admin).await;
    assert_eq!(r.status, StatusCode::OK);
    let b = &r.body;
    assert_eq!(b["meta"], json!({"source": "db", "day": "2026-11-21", "end_day": null, "window": null}));
    assert_eq!(b["string_id"], "H3001A · STR-03");
    assert_eq!((b["mppt_no"].clone(), b["modules"].clone(), b["module_wp"].clone()), (json!(2), json!(18), json!(570.0)));
    assert_eq!(b["peer_basis"], "per_kwp");
    assert_eq!(b["timeseries"].as_array().unwrap().len(), 142);
    assert_eq!(b["iv_pv_curve"]["nominal_points"].as_array().unwrap().len(), 46);
    assert!(b["summary"]["pr_pct"].as_f64().unwrap() < 88.5, "weak string below its peers");

    let r = get(&db, &format!("{base}/1?day=2026-11-20&end_day=2026-11-21&start=09:00&end=10:00"), &admin).await;
    assert_eq!(r.body["meta"]["end_day"], "2026-11-21");
    assert_eq!(r.body["meta"]["window"], json!({"start": "09:00", "end": "10:00"}));
    assert_eq!(r.body["daily"].as_array().unwrap().len(), 2);
    assert_eq!(r.body["timeseries"].as_array().unwrap().len(), 26, "13 slots 09:00..10:00 on each day");

    let r = get(&db, &format!("{base}/2?day=2026-11-21&start=19:00&end=20:00"), &admin).await;
    assert_eq!(r.status, StatusCode::NOT_FOUND);
    assert_eq!(r.body["detail"], "No telemetry found for H3001A string 2 on 2026-11-21 between 19:00 and 20:00");
    let r = get(&db, &format!("{base}/2?day=2026-10-01&end_day=2026-11-21"), &admin).await;
    assert_eq!((r.status, r.body.clone()), (StatusCode::UNPROCESSABLE_ENTITY, json!({"detail": "A day range covers at most 31 days"})));
    let r = get(&db, &format!("{base}/2?end_day=2026-11-21"), &admin).await;
    assert_eq!(r.body["detail"], "end_day needs day and must not be before it");
    let r = get(&db, &format!("{base}/2?day=2026-11-21&start=12:00&end=10:00"), &admin).await;
    assert_eq!(r.body["detail"], "start must not be after end");
    let r = get(&db, &format!("{base}/9"), &admin).await;
    assert_eq!((r.status, r.body["detail"].clone()), (StatusCode::NOT_FOUND, json!("No telemetry found for H3001A string 9")));
    db.finish().await;
}
