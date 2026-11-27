//! Stored weather area against Postgres: `/growatt/plants/{id}/weather`, `/google-weather`,
//! `/growatt/curtailment` and the meter / calibration services, on the parity seed
//! (rust/tests/parity/seed.d/40_weather.sql). Expected values were taken from the Python services
//! (backend/app/services/growatt_weather.py, google_weather.py, growatt_meter.py,
//! growatt_curtailment.py) on the same rows. Skipped without TEST_DATABASE_URL.

mod common;
use common::*;

use chrono::{NaiveDate, NaiveDateTime};
use tcroof_services::{curtailment, meter};

const SEED: &str = include_str!("../../../tests/parity/seed.d/40_weather.sql");

async fn seeded() -> Option<TestDb> {
    let db = TestDb::new().await?;
    sqlx::raw_sql(SEED).execute(&db.pool).await.expect("weather seed");
    Some(db)
}

fn d(s: &str) -> NaiveDate {
    NaiveDate::parse_from_str(s, "%Y-%m-%d").unwrap()
}

fn t(s: &str) -> NaiveDateTime {
    NaiveDateTime::parse_from_str(s, "%Y-%m-%d %H:%M:%S").unwrap()
}

async fn get(db: &TestDb, uri: &str, tok: &str) -> Res {
    send(&db.app, Method::GET, uri, Some(tok), None).await
}

#[tokio::test]
async fn weather_day() {
    let Some(db) = seeded().await else { return };
    let admin = db.admin().await;
    let r = get(&db, "/api/growatt/plants/4001/weather", &admin).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    let b = &r.body;
    assert_eq!(b["meta"]["day"], json!("2026-11-21"));
    assert_eq!(b["meta"]["data_until"], json!("2026-11-21 18:30:00"));
    assert_eq!(b["meta"]["window"], Value::Null);
    assert_eq!(b["has_sensor"], json!(true));
    let k = &b["kpis"];
    assert_eq!(k["insolation_kwh_m2"], json!(7.822));
    assert_eq!(k["peak_irradiance_wm2"], json!(1050.0));
    assert_eq!(k["irradiance_weighted_module_temp_c"], json!(47.3));
    assert_eq!(k["avg_humidity_pct"], json!(58.0));
    assert_eq!(k["poa_filtered_slots"], json!(127));
    assert_eq!(b["series"].as_array().unwrap().len(), 157);
    assert_eq!(b["series"][0]["wind_dir_deg"], json!(350.0));
    // sensor B never measured humidity: left out of its measured list
    assert_eq!(b["sensors"][1]["measured"], json!(["irradiance_wm2", "ambient_temp_c", "module_temp_c", "wind_speed_ms", "wind_dir_deg"]));
    let slots = tcroof_services::weather::check_slots(b["series"].as_array().unwrap(), Some(d("2026-11-21")));
    assert_eq!(slots["09"], json!({"at": "09:00", "irradiance_wm2": 717.8, "module_temp_c": 46.8}));

    // window and one sensor
    let r = get(&db, "/growatt/plants/4001/weather?day=2026-11-21&sensor=WXDL4001A:1&start=09:00&end=13:30", &admin).await;
    assert_eq!(r.body["kpis"]["insolation_kwh_m2"], json!(4.343)); // Python sum() is compensated
    assert_eq!(r.body["meta"]["window"], json!({"start": "09:00", "end": "13:30"}));
    assert_eq!(r.body["meta"]["sensor"], json!({"datalogger_sn": "WXDL4001A", "address": 1}));

    // no sensor at all: listed empty, nulls
    let r = get(&db, "/api/growatt/plants/4002/weather", &admin).await;
    assert_eq!(r.body["has_sensor"], json!(false));
    assert_eq!(r.body["kpis"]["insolation_kwh_m2"], Value::Null);
    assert_eq!(r.body["kpis"]["stale_irradiance_slots"], json!(0));
    // a sensor without readings: listed, no day
    let r = get(&db, "/api/growatt/plants/4004/weather", &admin).await;
    assert_eq!(r.body["meta"]["day"], Value::Null);
    assert_eq!(r.body["sensors"][0]["samples"], json!(0));

    // errors
    assert_eq!(get(&db, "/api/growatt/plants/4001/weather?sensor=WXDL4003:1", &admin).await.status, StatusCode::NOT_FOUND);
    assert_eq!(get(&db, "/api/growatt/plants/4001/weather?sensor=bad", &admin).await.status, StatusCode::UNPROCESSABLE_ENTITY);
    let r = get(&db, "/api/growatt/plants/4001/weather?start=13:00&end=09:00", &admin).await;
    assert_eq!((r.status, r.body["detail"].clone()), (StatusCode::UNPROCESSABLE_ENTITY, json!("start must not be after end")));
    let r = get(&db, "/api/growatt/plants/4900/weather", &admin).await;
    assert_eq!((r.status, r.body["detail"].clone()), (StatusCode::NOT_FOUND, json!("Plant 4900 not found")));

    // engineer: assigned 4001, not 4003 (404, before the bad query is looked at)
    let eng = db.engineer().await;
    assert_eq!(get(&db, "/api/growatt/plants/4001/weather", &eng).await.status, StatusCode::OK);
    let r = get(&db, "/api/growatt/plants/4003/weather?day=x", &eng).await;
    assert_eq!((r.status, r.body["detail"].clone()), (StatusCode::NOT_FOUND, json!("Plant 4003 not found")));
    db.finish().await;
}

#[tokio::test]
async fn google_weather_day() {
    let Some(db) = seeded().await else { return };
    let admin = db.admin().await;
    let r = get(&db, "/api/growatt/plants/4001/google-weather", &admin).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    let b = &r.body;
    assert_eq!(b["meta"]["modelled"], json!(true));
    assert_eq!(b["meta"]["day"], json!("2026-11-21"));
    assert_eq!(b["meta"]["cell"], json!({"key": "13.76,100.50", "latitude": 13.76, "longitude": 100.5}));
    assert_eq!(b["configured"], json!(false));
    assert_eq!(b["hours"].as_array().unwrap().len(), 12);
    let k = &b["kpis"];
    assert_eq!(k["rain_mm"], json!(0.4));
    assert_eq!(k["rain_hours"], json!(1));
    assert_eq!(k["condition"], json!("CLEAR"));
    assert_eq!(k["rained"], json!(true));
    assert_eq!(k["humidity_avg_pct"], json!(78.0));
    assert_eq!(b["slots"]["13"]["status_th"], json!("ฝนตก"));
    // an incomplete day (11-17) between: days since rain unknown
    assert_eq!(b["rain"]["days_since_rain"], Value::Null);
    let r = get(&db, "/api/growatt/plants/4001/google-weather?day=2026-11-16", &admin).await;
    assert_eq!(r.body["rain"], json!({"days_since_rain": 2, "last_rain_day": "2026-11-14", "last_rain_mm": 3.0}));
    // no location
    let r = get(&db, "/api/growatt/plants/4002/google-weather", &admin).await;
    assert_eq!((r.body["has_location"].clone(), r.body["meta"]["cell"].clone()), (json!(false), Value::Null));
    assert_eq!(r.body["kpis"]["complete"], json!(false));
    assert_eq!(r.body["slots"]["09"], Value::Null);
    let eng = db.engineer().await;
    assert_eq!(get(&db, "/api/growatt/plants/4003/google-weather", &eng).await.status, StatusCode::NOT_FOUND);
    db.finish().await;
}

#[tokio::test]
async fn fleet_curtailment() {
    let Some(db) = seeded().await else { return };
    let admin = db.admin().await;
    let r = get(&db, "/api/growatt/curtailment?start=2026-11-15&end=2026-11-21", &admin).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    let ours: Vec<Value> = r.body["plants"].as_array().unwrap().iter().filter(|p| p["plant_id"].as_i64().unwrap() >= 4000).cloned().collect();
    let got: Vec<(i64, Value, Value, Value)> = ours
        .iter()
        .map(|p| (p["plant_id"].as_i64().unwrap(), p["curtailed_kwh"].clone(), p["curtailed_err_kwh"].clone(), p["curtailed_pct"].clone()))
        .collect();
    assert_eq!(
        got,
        vec![
            (4001, json!(99.8), Value::Null, json!(5.7)),
            (4003, json!(7.3), json!(1.1), json!(1.2)),
            (4002, Value::Null, Value::Null, Value::Null),
        ]
    );
    assert_eq!(ours[0]["calibration"], json!({"ratio": 0.9, "slots": 60, "status": "blend"}));
    assert_eq!(ours[0]["last_curtailed_day"], json!("2026-11-21"));

    // engineer: 4001 + 4002 only
    let eng = db.engineer().await;
    let r = get(&db, "/api/growatt/curtailment?start=2026-11-15&end=2026-11-21", &eng).await;
    let ids: Vec<i64> = r.body["plants"].as_array().unwrap().iter().map(|p| p["plant_id"].as_i64().unwrap()).collect();
    assert!(ids.contains(&4001) && ids.contains(&4002) && !ids.contains(&4003), "{ids:?}");

    let r = get(&db, "/api/growatt/curtailment?start=2026-08-01&end=2026-11-21", &admin).await;
    assert_eq!((r.status, r.body["detail"].clone()), (StatusCode::UNPROCESSABLE_ENTITY, json!("A period covers at most 92 days")));
    let r = get(&db, "/api/growatt/curtailment?start=2026-11-21&end=2026-11-20", &admin).await;
    assert_eq!(r.body["detail"], json!("start is after end"));
    assert_eq!(send(&db.app, Method::GET, "/api/growatt/curtailment", None, None).await.status, StatusCode::UNAUTHORIZED);

    // calibration from the stored free ratios of the 14 days before
    let cal = curtailment::calibration(&db.pool, 4001, &[d("2026-11-22"), d("2026-11-17")]).await.unwrap();
    assert_eq!(cal["2026-11-22"], curtailment::Calibration { ratio: Some(0.888), slots: 70, source: Some("plant".into()) });
    assert_eq!(cal["2026-11-17"], curtailment::Calibration { ratio: Some(0.871), slots: 40, source: Some("plant".into()) });
    db.finish().await;
}

#[tokio::test]
async fn meter_grid_and_energy() {
    let Some(db) = seeded().await else { return };
    let (has, slots) = meter::meter_slots(&db.pool, 4001, t("2026-11-21 00:00:00"), t("2026-11-22 00:00:00")).await.unwrap();
    assert!(has);
    assert_eq!(slots.len(), 288);
    assert_eq!(slots["2026-11-21 12:00:00"], 800.0);
    let (has, _) = meter::meter_slots(&db.pool, 4002, t("2026-11-21 00:00:00"), t("2026-11-22 00:00:00")).await.unwrap();
    assert!(!has);
    assert_eq!(meter::plant_meters(&db.pool, 4001).await.unwrap(), vec![("WXDL4001A".to_owned(), 36)]);

    let row = |ts: &str, pac: f64| json!({"timestamp": ts, "pac_kw": pac}).as_object().unwrap().clone();
    let mut ts = vec![row("2026-11-21 12:00:00", 30.0), row("2026-11-21 12:05:00", 0.5)];
    meter::attach_grid(&mut ts, &slots, Some(100.0));
    assert_eq!(ts.len(), 288);
    assert_eq!(ts[0]["load_kw"], json!(25.0)); // night: derived load = grid
    assert_eq!(ts[0]["pac_kw"], Value::Null);
    let r = ts.iter().find(|r| r["timestamp"] == json!("2026-11-21 12:05:00")).unwrap();
    assert_eq!((r["grid_import_kw"].clone(), r["load_kw"].clone()), (json!(0.8), json!(1.3)));
    let e = meter::day_energy(&db.pool, 4001, t("2026-11-21 00:00:00"), t("2026-11-22 00:00:00"), &ts, true).await.unwrap();
    assert_eq!(e, json!({"grid_import_kwh": 23.9, "grid_export_kwh": 0.0, "load_kwh": 252.7}));
    let e = meter::day_energy(&db.pool, 4001, t("2026-11-21 00:00:00"), t("2026-11-22 00:00:00"), &ts, false).await.unwrap();
    assert_eq!(e["grid_import_kwh"], json!(479.0));
    db.finish().await;
}
