//! Integration tests of the "devices" area: `/growatt/sensors`, `/growatt/alarms` and
//! `/growatt/devices/{inverters,meters,dataloggers,checks}` (backend/app/api/routes/growatt/plants.py
//! `fleet_sensors` / `fleet_alarms`, routes/growatt/devices.py; services growatt_sensors.py,
//! growatt_alarms.py, devices.py, device_checks.py). Run with rust/scripts/test_pg.sh.
//! The data is the parity seed rust/tests/parity/seed.d/50_devices.sql (plants 5001–5003; the
//! engineer has 5002 and 5003). Assertions that depend on the clock (daylight checks, today's
//! coverage) are left to the parity run against Python.

mod common;
use common::*;

const SEED: &str = include_str!("../../../tests/parity/seed.d/50_devices.sql");

async fn seeded() -> Option<TestDb> {
    let db = TestDb::new().await?;
    sqlx::raw_sql(SEED).execute(&db.pool).await.expect("devices seed");
    Some(db)
}

async fn get(db: &TestDb, uri: &str, tok: &str) -> Res {
    let r = send(&db.app, Method::GET, uri, Some(tok), None).await;
    assert_eq!(r.status, StatusCode::OK, "{uri}: {}", r.body);
    r
}

fn ids(v: &Value, list: &str, key: &str) -> Vec<Value> {
    v[list].as_array().expect("list").iter().map(|x| x[key].clone()).collect()
}

#[tokio::test]
async fn engineer_sees_only_assigned_plants() {
    let Some(db) = seeded().await else { return };
    let eng = db.engineer().await;
    for (uri, list) in [
        ("/api/growatt/sensors", "sensors"),
        ("/growatt/devices/inverters?include_not_installed=true", "inverters"),
        ("/api/growatt/devices/meters", "meters"),
        ("/api/growatt/devices/dataloggers", "dataloggers"),
        ("/api/growatt/devices/checks", "checks"),
        ("/api/growatt/alarms", "alarms"),
    ] {
        let r = get(&db, uri, &eng).await;
        for pid in ids(&r.body, list, "plant_id") {
            assert!(pid == 5002 || pid == 5003, "{uri}: plant {pid}");
        }
    }
    // sensor_scope: a plant the engineer was not given answers an empty list, not 404
    let r = get(&db, "/api/growatt/sensors?plant_id=5001", &eng).await;
    assert_eq!(r.body["sensors"], json!([]));
    let r = get(&db, "/api/growatt/sensors?plant_id=5003", &eng).await;
    assert_eq!(ids(&r.body, "sensors", "key"), vec![json!("DL5003:2")]);
    // bad parameters are 422; no token is 401
    for uri in ["/api/growatt/sensors?plant_id=x", "/api/growatt/alarms?day=2026-02-30", "/api/growatt/devices/inverters?include_not_installed=maybe"] {
        assert_eq!(send(&db.app, Method::GET, uri, Some(&eng), None).await.status, StatusCode::UNPROCESSABLE_ENTITY, "{uri}");
    }
    assert_eq!(send(&db.app, Method::GET, "/api/growatt/devices/checks", None, None).await.status, StatusCode::UNAUTHORIZED);
    db.finish().await;
}

#[tokio::test]
async fn alarm_day_rows_coverage_and_run_times() {
    let Some(db) = seeded().await else { return };
    let admin = db.admin().await;
    let r = get(&db, "/api/growatt/alarms", &admin).await;
    let b = &r.body;
    // newest first, a missing start time first (Postgres DESC), then by id
    let starts = ids(b, "alarms", "start_time");
    assert_eq!(starts[0], Value::Null);
    let alpha: Vec<&Value> = b["alarms"].as_array().unwrap().iter().filter(|a| a["plant_id"] == 5001).collect();
    let codes: Vec<Value> = alpha.iter().map(|a| a["alarm_code"].clone()).collect();
    // '' stays text, '0102' is the int 102, 'A12' text; the not-installed inverter's alarm is still listed (as Python does)
    assert_eq!(codes, vec![json!(""), json!("A12"), json!(102), json!(201), json!(300)]);
    assert!(alpha.iter().all(|a| a["read_at"].as_str().is_some_and(|s| s.ends_with("+00:00"))));
    // coverage counts installed inverters only (DEVA0003's read is left out)
    let p: Vec<&Value> = b["plants"].as_array().unwrap().iter().filter(|p| p["plant_id"] == 5001).collect();
    assert_eq!((p[0]["inverters"].clone(), p[0]["synced_inverters"].clone()), (json!(2), json!(2)));
    let beta: Vec<&Value> = b["plants"].as_array().unwrap().iter().filter(|p| p["plant_id"] == 5002).collect();
    assert_eq!((beta[0]["synced_inverters"].clone(), beta[0]["synced_at"].clone()), (json!(0), Value::Null));
    // the abandoned run does not count as the last start; today has a next run
    let ok_start: DateTime<Utc> = sqlx::query_scalar("SELECT started_at FROM sync_runs WHERE job = 'alarms' AND status = 'ok'")
        .fetch_one(&db.pool)
        .await
        .unwrap();
    assert_eq!(b["meta"]["last_run_at"], json!(tcroof_api::pyfmt::isoformat(ok_start)));
    assert!(b["meta"]["next_run_at"].is_string());
    assert_eq!(b["meta"]["source"], "db");

    let r = get(&db, "/growatt/alarms?day=2026-11-20", &admin).await;
    assert_eq!(r.body["day"], "2026-11-20");
    assert_eq!(r.body["meta"]["next_run_at"], Value::Null);
    let past: Vec<&Value> = r.body["alarms"].as_array().unwrap().iter().filter(|a| a["plant_id"].as_i64().is_some_and(|p| p >= 5000)).collect();
    assert_eq!(past.len(), 2);
    assert_eq!(past[0]["start_time"], "2026-11-20 13:00:00");
    assert_eq!(past[0]["alarm_code"], 4);
    db.finish().await;
}

#[tokio::test]
async fn inverter_list_meters_and_dataloggers() {
    let Some(db) = seeded().await else { return };
    let admin = db.admin().await;
    let r = get(&db, "/api/growatt/devices/inverters", &admin).await;
    let rows: Vec<&Value> = r.body["inverters"].as_array().unwrap().iter().filter(|i| i["plant_id"].as_i64().is_some_and(|p| (5001..=5003).contains(&p))).collect();
    let sns: Vec<&str> = rows.iter().map(|i| i["device_sn"].as_str().unwrap()).collect();
    // phase order (1, 2, then none); the not-installed inverter left out
    assert_eq!(sns, ["DEVA0001", "DEVA0002", "DEVB0001", "DEVC0001", "DEVC0002", "DEVC0003", "DEVC0004"]);
    let a1 = rows[0];
    assert_eq!(a1["label"], "INV1");
    assert_eq!((a1["open_issues"].clone(), a1["top_tier"].clone()), (json!(2), json!("P1")));
    assert_eq!((a1["alarms_today"].clone(), a1["alarms_open"].clone()), (json!(2), json!(1)));
    assert_eq!(a1["yield_today_kwh"], json!(215.2));
    assert_eq!(a1["has_string_layout"], true);
    assert_eq!(a1["province"], "Nonthaburi");
    assert_eq!(a1["site_code"], "S5001");
    let a2 = rows[1];
    assert_eq!((a2["power_limit_pct"].clone(), a2["power_limit_source"].clone()), (json!(80.0), json!("read_power")));
    // the newest record with a yield (10:25, 20.25 kWh), share of the plant mean
    assert_eq!(a2["yield_today_kwh"], json!(20.25));
    assert_eq!(a2["pct_of_plant_avg"], json!(17.2));
    assert_eq!(a2["open_issues"], 0); // the shadow issue is left out
    let b1 = rows[2];
    assert_eq!((b1["label"].clone(), b1["rated_kw"].clone(), b1["alarms_today"].clone()), (json!("INV1"), Value::Null, Value::Null));
    assert_eq!(rows[3]["label"], "INV1");
    assert_eq!(rows[3]["province"], Value::Null); // city '' and no register province
    assert_eq!(rows[4]["label"], "INV2");
    let r = get(&db, "/api/growatt/devices/inverters?include_not_installed=1", &admin).await;
    let a3: Vec<&Value> = r.body["inverters"].as_array().unwrap().iter().filter(|i| i["device_sn"] == "DEVA0003").collect();
    assert_eq!(a3[0]["not_installed"]["by"], "admin");
    assert_eq!(a3[0]["pct_of_plant_avg"], Value::Null);

    let r = get(&db, "/api/growatt/devices/meters", &admin).await;
    let m: Vec<&Value> = r.body["meters"].as_array().unwrap().iter().filter(|m| m["datalogger_sn"] == "DL5001").collect();
    // import from the counter: (1000 + 48 × 0.25) − 1000 = 12
    assert_eq!((m[0]["import_today_kwh"].clone(), m[0]["records_today"].clone()), (json!(12.0), json!(49)));
    assert!(m[0]["export_today_kwh"].as_f64().is_some_and(|x| x > 0.0));
    let without = ids(&r.body, "plants_without_meter", "plant_id");
    assert!(without.contains(&json!(5002)) && !without.contains(&json!(5001)));

    let r = get(&db, "/api/growatt/devices/dataloggers", &admin).await;
    let mine: Vec<&Value> = r.body["dataloggers"].as_array().unwrap().iter().filter(|d| d["plant_id"].as_i64().is_some_and(|p| (5001..=5003).contains(&p))).collect();
    let got: Vec<(Value, Value, Value)> = mine.iter().map(|d| (d["datalogger_sn"].clone(), d["register_match"].clone(), d["inverters"].clone())).collect();
    assert_eq!(
        got,
        vec![
            (json!("DL5001"), json!("differs"), json!(2)),
            (json!("DL5002"), Value::Null, json!(1)),
            (json!("DL5003"), json!("prefix"), json!(4)),
        ]
    );
    assert_eq!(mine[0]["sensors"], 1);
    assert_eq!(mine[0]["meters"], 1);
    assert_eq!(mine[0]["register_sn"], "DL5001Z");
    assert_eq!(mine[0]["model"], "ShineMaster");
    db.finish().await;
}

#[tokio::test]
async fn device_checks_and_past_day_sensors() {
    let Some(db) = seeded().await else { return };
    db.add_run("history", "ok", Some(Utc::now())).await;
    let eng = db.engineer().await;
    let r = get(&db, "/api/growatt/devices/checks", &eng).await;
    let b = &r.body;
    // saved overrides: the float and int kept, the unknown key and the bool ignored
    assert_eq!(b["meta"]["thresholds"]["silent_hours"], json!(1.5));
    assert_eq!(b["meta"]["thresholds"]["never_reported_days"], json!(5));
    assert_eq!(b["meta"]["thresholds"]["limit_below_pct"], json!(100));
    assert!(b["meta"]["thresholds"].get("bogus").is_none());
    let checks = b["checks"].as_array().unwrap();
    let sev: Vec<&str> = checks.iter().map(|c| c["severity"].as_str().unwrap()).collect();
    assert!(sev.windows(2).all(|w| !(w[0] == "info" && w[1] == "warn")), "warn first");
    let find = |code: &str, key: Option<&str>| {
        checks.iter().find(|c| c["code"] == code && key.is_none_or(|k| c["device_key"] == k)).cloned()
    };
    let nr = find("inverter_never_reported", Some("DEVB0001")).expect("never reported");
    assert_eq!(nr["severity"], "warn");
    // added 10 days ago at 09:15: 9 or 10 whole days, by the time of day
    assert!(nr["params"]["days"] == 9 || nr["params"]["days"] == 10);
    let nr = find("inverter_never_reported", Some("DEVC0003")).expect("no create date");
    assert_eq!(nr["severity"], "info");
    let lg = find("logger_sn_mismatch", None).expect("register logger");
    assert_eq!(lg["reason"], "Site register S5003: Logger SN DL500 here, DL5003 in Growatt");
    assert_eq!(lg["params"]["growatt_sns"], "DL5003");
    let lim = find("inverter_limited", Some("DEVC0001")).expect("limited");
    assert_eq!(lim["reason"], "INV1 (DEVC0001): active power limit set to 90.5 % (configured, max_data_info)");
    assert!(find("no_meter", None).is_some_and(|c| c["plant_id"] == 5002));
    assert_eq!(b["summary"]["total"], checks.len());

    let admin = db.admin().await;
    let r = get(&db, "/api/growatt/devices/checks", &admin).await;
    let fw = r.body["checks"].as_array().unwrap().iter().find(|c| c["code"] == "firmware_minority" && c["device_key"] == "DEVA0002").cloned();
    assert!(fw.is_some_and(|c| c["params"]["majority_fw"] == "TL1.0"));
    let cm = r.body["checks"].as_array().unwrap().iter().find(|c| c["code"] == "inverter_count_mismatch" && c["plant_id"] == 5001).cloned();
    assert_eq!(cm.unwrap()["reason"], "2 installed inverters in the registry (3 with those marked not installed), 4 entered in Growatt");

    // a past day: the whole 06:00–18:00 window is judged; the humidity probe read 0 all that day
    let r = get(&db, "/api/growatt/sensors?day=2026-11-20&plant_id=5003", &eng).await;
    let s = &r.body["sensors"][0];
    assert_eq!(r.body["meta"]["is_today"], false);
    assert_eq!(r.body["meta"]["coverage_window"]["until"], "18:00");
    assert_eq!(r.body["meta"]["alarm_coverage_pct"], json!(80.0));
    assert_eq!(s["coverage_pct"], json!(50.0));
    assert_eq!(s["coverage_today_pct"], Value::Null);
    assert_eq!(s["status"], "unknown");
    assert_eq!(s["last_reading_at"], "2026-11-20 17:55:00");
    assert_eq!(s["flags"][0]["code"], "probe_missing");
    assert_eq!(s["flags"][0]["field"], "humidity_pct");
    assert_eq!(s["flags"][0]["params"], json!({"slots": 72, "day": "2026-11-20", "from": "06:00", "to": "18:00"}));
    let r = get(&db, "/api/growatt/sensors?plant_id=5002", &eng).await;
    assert_eq!((r.body["sensors"][0]["status"].clone(), r.body["sensors"][0]["last"].clone()), (json!("not_synced"), Value::Null));
    db.finish().await;
}
