//! `/growatt/plants`, `/plants/{id}/inverters`, `/overview`, `/power` and `/growatt/sync/*` against
//! Postgres (Python routes/growatt/plants.py and sync.py). Data: the parity seed of this area
//! (rust/tests/parity/seed.d/20_plants.sql), applied to each fresh test database.

mod common;
use common::*;

const SEED: &str = include_str!("../../../tests/parity/seed.d/20_plants.sql");

async fn db() -> Option<TestDb> {
    let t = TestDb::new().await?;
    sqlx::raw_sql(SEED).execute(&t.pool).await.expect("plants seed");
    Some(t)
}

async fn get(t: &TestDb, uri: &str, token: &str) -> Res {
    send(&t.app, Method::GET, uri, Some(token), None).await
}

fn ids(v: &Value) -> Vec<i64> {
    v.as_array().unwrap().iter().map(|p| p["plant_id"].as_i64().unwrap()).collect()
}

#[tokio::test]
async fn plant_list_scoped_and_ordered() {
    let Some(t) = db().await else { return };
    let (admin, eng) = (t.admin().await, t.engineer().await);

    let r = get(&t, "/api/growatt/plants", &admin).await;
    assert_eq!(r.status, StatusCode::OK);
    let all = ids(&r.body);
    let pos = |id| all.iter().position(|x| *x == id).unwrap();
    // phase 1, phase 2, untagged last
    assert!(pos(2001) < pos(2002) && pos(2002) < pos(2003), "{all:?}");
    let p = |id: i64| r.body.as_array().unwrap().iter().find(|p| p["plant_id"] == id).unwrap().clone();
    let a = p(2001);
    assert_eq!(a["inverter_count"], 2); // the not-installed one is not counted
    assert_eq!(a["peak_power_kwp"], 120.0);
    assert!(a["reported_peak_power_kwp"].is_null());
    assert!(a["current_power_w"].is_null() && a["status"].is_null());
    assert_eq!(a["synced_at"], "2026-11-26T23:10:05.123456+00:00");
    assert!(a["total_energy_kwh"].as_f64().unwrap() > 300_000.0);
    // 5000 kWp on 20 kW of inverters is impossible: rejected, Growatt's figure kept aside
    let b = p(2002);
    assert!(b["peak_power_kwp"].is_null());
    assert_eq!(b["reported_peak_power_kwp"], 5000.0);
    assert_eq!(p(2003)["inverter_count"], 0);

    let r = get(&t, "/growatt/plants", &eng).await;
    assert_eq!(ids(&r.body), vec![2001]);
    assert_eq!(send(&t.app, Method::GET, "/growatt/plants", None, None).await.status, StatusCode::UNAUTHORIZED);
    t.finish().await;
}

#[tokio::test]
async fn inverters_hide_not_installed() {
    let Some(t) = db().await else { return };
    let (admin, eng) = (t.admin().await, t.engineer().await);

    let r = get(&t, "/api/growatt/plants/2001/inverters", &admin).await;
    assert_eq!(r.status, StatusCode::OK);
    let sns: Vec<&str> = r.body.as_array().unwrap().iter().map(|i| i["device_sn"].as_str().unwrap()).collect();
    assert_eq!(sns, ["PAR2001A01", "PAR2001A02"]);
    let a = &r.body[0];
    assert_eq!(a["nominal_power_kw"], 50.0);
    assert_eq!(a["device_types"], json!(["inverter", "max"]));
    assert_eq!(a["settings"]["active_rate_pct"], 90.0); // readPower wins over max_data_info
    assert_eq!(a["settings"]["active_rate_source"], "read_power");
    assert_eq!(a["settings"]["power_limit_read_at"], "2026-11-26T03:40:00.500000+00:00");
    assert_eq!(a["growatt_created_at"], "2024-03-01 10:11:12");
    assert!(a["not_installed"].is_null() && a["status"].is_null());
    assert!(r.body[1]["settings"]["active_rate_source"].is_null());

    let r = get(&t, "/api/growatt/plants/2001/inverters?include_not_installed=true", &eng).await;
    let all = r.body.as_array().unwrap();
    assert_eq!(all.len(), 3);
    assert_eq!(all[2]["not_installed"]["by"], "admin");
    assert_eq!(all[2]["device_types"], json!([]));
    assert_eq!(all[2]["settings"]["active_rate_source"], "max_data_info");

    assert_eq!(get(&t, "/api/growatt/plants/2001/inverters?include_not_installed=maybe", &admin).await.status, StatusCode::UNPROCESSABLE_ENTITY);
    let r = get(&t, "/api/growatt/plants/2002/inverters", &eng).await;
    assert_eq!((r.status, r.body["detail"].as_str()), (StatusCode::NOT_FOUND, Some("Plant 2002 not found")));
    assert_eq!(get(&t, "/api/growatt/plants/2999/inverters", &admin).await.body, json!([]));
    assert_eq!(get(&t, "/api/growatt/plants/x/inverters", &admin).await.status, StatusCode::UNPROCESSABLE_ENTITY);
    t.finish().await;
}

#[tokio::test]
async fn overview_default_day_skips_a_night_only_day() {
    let Some(t) = db().await else { return };
    let admin = t.admin().await;
    let r = get(&t, "/api/growatt/plants/2001/overview", &admin).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    let o = &r.body;
    assert_eq!(o["meta"]["source"], "db");
    // the newest record (27 Nov 00:02) is before sunrise: the day before opens
    assert_eq!(o["meta"]["day"], "2026-11-26");
    assert_eq!(o["meta"]["data_until"], "2026-11-26 18:30:00");
    let k = &o["kpis"];
    assert_eq!(k["capacity_kwp"], 120.0);
    assert_eq!(k["inverter_count"], 2);
    assert!(k["yield_today_kwh"].as_f64().unwrap() > 300.0);
    assert_eq!(k["has_meter"], true);
    assert!(k["grid_import_kwh"].as_f64().is_some());
    assert!(k["iec_pr_pct"].as_f64().is_some(), "{}", o["weather"]["iec_pr"]);
    assert!(k["epi"].as_f64().is_some());
    assert!(k["current_power_kw"].is_null() && k["online_inverters"].is_null());
    assert_eq!(k["epi_factor"]["basis"], "fitted");
    assert_eq!(k["epi_factor"]["factor"], 0.962);
    assert_eq!(k["epi_factor"]["fitted_at"], "2026-11-21T17:45:00.250000+00:00");
    // R16 on the stored evidence: frozen readings (14 slots), neighbours judged (cloud 12 %) and low
    assert_eq!(k["sensor_health"]["ok"], false);
    assert_eq!(k["sensor_health"]["flags"], json!(["stale", "below_neighbours"]));
    assert_eq!(o["not_installed_inverters"].as_array().unwrap().len(), 1);
    assert_eq!(o["inverters"].as_array().unwrap().len(), 2);
    assert_eq!(o["inverters"][0]["mppt_latest"][0]["mppt"], 1);
    // input 4 of A01 never carries current: not a string, listed as inactive
    let inactive = o["inactive_strings"].as_array().unwrap();
    assert!(inactive.iter().any(|s| s["device_sn"] == "PAR2001A01" && s["string_no"] == 4), "{inactive:?}");
    assert_eq!(k["string_count"], 7);
    assert_eq!(o["loss_waterfall"].as_array().unwrap().len(), 6);
    let ts = o["timeseries"].as_array().unwrap();
    // meter rows at night have no inverter record: PV null, never 0
    let night = ts.iter().find(|r| r["timestamp"] == "2026-11-26 02:00:00").unwrap();
    assert!(night["pac_kw"].is_null() && night["grid_import_kw"].as_f64().is_some());
    assert!(ts.iter().any(|r| r["held"].as_i64().unwrap_or(0) > 0));
    assert_eq!(o["weather"]["has_sensor"], true);
    assert!(o["plant"]["documents"].as_object().unwrap().is_empty());
    t.finish().await;
}

#[tokio::test]
async fn overview_edges() {
    let Some(t) = db().await else { return };
    let (admin, eng) = (t.admin().await, t.engineer().await);
    let r = get(&t, "/api/growatt/plants/2001/overview?day=2026-10-01", &admin).await;
    assert_eq!(r.status, StatusCode::OK);
    assert_eq!(r.body["meta"]["day"], "2026-10-01");
    assert!(r.body["kpis"]["yield_today_kwh"].is_null());
    assert!(r.body["timeseries"].as_array().unwrap().is_empty() || r.body["timeseries"][0]["pac_kw"].is_null());
    let r = get(&t, "/api/growatt/plants/2003/overview", &admin).await;
    assert_eq!(r.status, StatusCode::OK);
    assert!(r.body["meta"]["day"].is_null() && r.body["kpis"]["capacity_kwp"].is_null());
    let r = get(&t, "/api/growatt/plants/2002/overview", &admin).await;
    assert_eq!(r.body["plant"]["reported_peak_power_kwp"], 5000.0);
    assert!(r.body["kpis"]["specific_yield_kwh_per_kwp"].is_null());
    // a rejected fit keeps the default factor
    assert_eq!(r.body["kpis"]["epi_factor"]["basis"], "default");
    assert_eq!(r.body["kpis"]["epi_factor"]["fit_factor"], 1.31);
    assert_eq!(get(&t, "/api/growatt/plants/2999/overview", &admin).await.status, StatusCode::NOT_FOUND);
    assert_eq!(get(&t, "/api/growatt/plants/2002/overview", &eng).await.status, StatusCode::NOT_FOUND);
    assert_eq!(get(&t, "/api/growatt/plants/2001/overview?day=2026-13-01", &admin).await.status, StatusCode::UNPROCESSABLE_ENTITY);
    t.finish().await;
}

#[tokio::test]
async fn power_curve_range_and_window() {
    let Some(t) = db().await else { return };
    let (admin, eng) = (t.admin().await, t.engineer().await);
    let r = get(&t, "/api/growatt/plants/2001/power?day=2026-11-25&end_day=2026-11-26", &eng).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    let daily = r.body["daily"].as_array().unwrap();
    assert_eq!(daily.len(), 2);
    assert_eq!(daily[0]["growatt_energy_kwh"], 520.4);
    assert_eq!(daily[0]["growatt_inverters_reported"], 2);
    // 99,999 kWh on 120 kWp is a Growatt glitch: withheld
    assert!(daily[1]["growatt_energy_kwh"].is_null());
    assert_eq!(daily[1]["growatt_implausible"], true);
    assert_eq!(r.body["rated_ac_kw"], 100.0);
    assert_eq!(r.body["inverter_count"], 2);
    assert_eq!(r.body["meta"]["window"], json!([null, null]));
    assert!(!r.body["growatt_timeseries"].as_array().unwrap().is_empty());

    let r = get(&t, "/api/growatt/plants/2001/power?day=2026-11-26&start=09:00&end=12:30", &admin).await;
    let ts = r.body["timeseries"].as_array().unwrap();
    assert!(ts.iter().all(|x| { let h = &x["timestamp"].as_str().unwrap()[11..]; ("09:00:00"..="12:30:00").contains(&h) }));
    assert_eq!(r.body["meta"]["window"], json!(["09:00", "12:30"]));
    assert!(r.body["timeseries"][0]["irradiance_wm2"].as_f64().is_some());

    let r = get(&t, "/api/growatt/plants/2001/power?day=2026-11-25&records=false", &admin).await;
    assert!(r.body["daily"][0]["energy_kwh"].is_null());

    for (q, msg) in [
        ("day=2026-11-26&end_day=2026-11-25", "end_day must not be before day"),
        ("day=2026-11-26&start=12:00&end=09:00", "start must not be after end"),
        ("day=2026-10-01&end_day=2026-11-26", "A day range covers at most 31 days"),
    ] {
        let r = get(&t, &format!("/api/growatt/plants/2001/power?{q}"), &admin).await;
        assert_eq!((r.status, r.body["detail"].as_str()), (StatusCode::UNPROCESSABLE_ENTITY, Some(msg)));
    }
    assert_eq!(get(&t, "/api/growatt/plants/2001/power", &admin).await.status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(get(&t, "/api/growatt/plants/2001/power?day=2026-11-26&start=9am", &admin).await.status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(get(&t, "/api/growatt/plants/2002/power?day=2026-11-26", &eng).await.status, StatusCode::NOT_FOUND);
    assert_eq!(get(&t, "/api/growatt/plants/2999/power?day=2026-11-26", &admin).await.status, StatusCode::NOT_FOUND);
    t.finish().await;
}

#[tokio::test]
async fn sync_status_and_queue() {
    let Some(t) = db().await else { return };
    let (admin, eng) = (t.admin().await, t.engineer().await);

    let r = get(&t, "/api/growatt/sync/status", &admin).await;
    assert_eq!(r.status, StatusCode::OK);
    let jobs = r.body["jobs"].as_object().unwrap();
    assert_eq!(jobs.len(), 25);
    assert!(jobs["history"].is_null());
    assert_eq!(jobs["alarms"]["status"], "partial");
    assert_eq!(jobs["alarms"]["detail"]["phases"]["1"]["read"], 12);
    assert_eq!(jobs["fleet"]["finished_at"], Value::Null);
    assert_eq!(get(&t, "/api/growatt/sync/status?limit=1", &admin).await.body["recent"].as_array().unwrap().len(), 1);
    assert_eq!(get(&t, "/api/growatt/sync/status?limit=0", &admin).await.status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(get(&t, "/api/growatt/sync/status", &eng).await.status, StatusCode::FORBIDDEN);

    let post = |job: &'static str, tok: String| {
        let app = t.app.clone();
        async move { send(&app, Method::POST, &format!("/api/growatt/sync/{job}"), Some(&tok), None).await }
    };
    let r = post("nope", admin.clone()).await;
    assert_eq!(r.status, StatusCode::NOT_FOUND);
    assert!(r.body["detail"].as_str().unwrap().starts_with("Unknown job 'nope'; choose one of ['alarms', 'alarms_yesterday', 'backfill',"));
    assert_eq!(post("status", admin.clone()).await.status, StatusCode::NOT_FOUND);
    assert_eq!(post("history", eng.clone()).await.status, StatusCode::FORBIDDEN);
    let r = post("fleet", admin.clone()).await;
    assert_eq!(r.status, StatusCode::CONFLICT);
    assert!(r.body["detail"].as_str().unwrap().starts_with("fleet is already queued (run "));

    let r = post("retention", admin.clone()).await;
    assert_eq!(r.status, StatusCode::ACCEPTED);
    assert_eq!((r.body["job"].as_str(), r.body["status"].as_str()), (Some("retention"), Some("queued")));
    let id = r.body["run_id"].as_i64().unwrap();
    let (trigger, status): (String, String) =
        sqlx::query_as("SELECT trigger, status FROM sync_runs WHERE id = $1").bind(id as i32).fetch_one(&t.pool).await.unwrap();
    assert_eq!((trigger.as_str(), status.as_str()), ("api", "queued"));
    assert_eq!(post("retention", admin.clone()).await.status, StatusCode::CONFLICT);

    // a queued run older than 2 h is failed, and a new one queued
    assert_eq!(post("backfill", admin.clone()).await.status, StatusCode::ACCEPTED);
    let old: (String, Option<String>) = sqlx::query_as("SELECT status, error FROM sync_runs WHERE job = 'backfill' ORDER BY id LIMIT 1")
        .fetch_one(&t.pool)
        .await
        .unwrap();
    assert_eq!(old, ("failed".into(), Some("never picked up (is the worker running?)".into())));
    t.finish().await;
}
