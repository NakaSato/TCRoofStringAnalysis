//! `/growatt/live/rain-radar`, `/live/rain`, `/live/plants/{id}/rain` and
//! `/live/plants/{id}/google-weather` (routes/growatt/live_weather.rs) against stub Longdo,
//! RainViewer and Google Weather servers run in-process. Never the real services: every test
//! points all three base URLs at the stub. Needs `TEST_DATABASE_URL` (rust/scripts/test_pg.sh).

mod common;

use std::collections::HashMap;
use std::sync::Mutex;

use axum::extract::{Path, RawQuery, State};
use axum::routing::get;
use common::*;

#[derive(Default)]
struct Stub {
    calls: Mutex<HashMap<String, usize>>,
}

impl Stub {
    fn hit(&self, what: &str) {
        *self.calls.lock().unwrap().entry(what.to_owned()).or_default() += 1;
    }
    fn calls(&self, what: &str) -> usize {
        self.calls.lock().unwrap().get(what).copied().unwrap_or(0)
    }
}

fn q(raw: &Option<String>) -> HashMap<String, String> {
    form_urlencoded::parse(raw.as_deref().unwrap_or("").as_bytes()).into_owned().collect()
}

type Reply = (StatusCode, axum::Json<Value>);

fn reply(v: Value) -> Reply {
    (StatusCode::OK, axum::Json(v))
}

async fn longdo(State(s): State<Arc<Stub>>, Path(rest): Path<String>, RawQuery(raw): RawQuery) -> Reply {
    s.hit(&rest);
    let p = q(&raw);
    if rest == "rain/api/v1/legend" {
        return reply(json!({"levels": [{"intensity": 0, "hex": "#fff", "label": "ไม่มีฝน"}]}));
    }
    if p.get("key").map(String::as_str) != Some("good") {
        return (StatusCode::FORBIDDEN, axum::Json(json!({"detail": "invalid key"})));
    }
    let lat: f64 = p.get("lat").and_then(|v| v.parse().ok()).unwrap_or(0.0);
    let wet = lat >= 18.0;
    match rest.as_str() {
        "rain/api/v1/layer/list" => reply(json!({"radar": {"past": [{"time": 200}, {"time": 100}]}})),
        "rain/api/v1/location" => reply(json!({"rain": {"intensity": if wet { 2 } else { 0 }, "description": "x"}})),
        "rain/api/v1/forecast/location" => reply(json!({"lead_minutes": [15], "forecast": [{"unix_time": 300, "rain": {"intensity": 1}}]})),
        "rain/api/v1/area" => reply(json!({"stats": {"rain_coverage_pct": if wet { 5.0 } else { 0.0 }, "max_intensity": if wet { 2 } else { 0 }}})),
        "rain/api/v1/forecast/area" => reply(json!({"lead_minutes": [15], "forecast": [{"unix_time": 300, "stats": {"max_intensity": 0}}]})),
        _ => (StatusCode::NOT_FOUND, axum::Json(json!({"detail": "no"}))),
    }
}

async fn rainviewer(State(s): State<Arc<Stub>>) -> Reply {
    s.hit("rainviewer");
    reply(json!({"host": "https://tiles.example", "radar": {"past": [{"time": 10, "path": "/a"}, {"time": 20, "path": "/b"}]}}))
}

async fn google(State(s): State<Arc<Stub>>, RawQuery(raw): RawQuery) -> Reply {
    s.hit("google");
    let p = q(&raw);
    if p.get("key").map(String::as_str) != Some("good") {
        return (StatusCode::FORBIDDEN, axum::Json(json!({"error": {"message": "API key not valid"}})));
    }
    reply(json!({"temperature": {"degrees": 30.5, "unit": "CELSIUS"}, "cloudCover": 40, "weatherCondition": {"type": "CLEAR"}}))
}

async fn serve(stub: Arc<Stub>) -> String {
    let app = axum::Router::new()
        .route("/longdo/{*rest}", get(longdo))
        .route("/rv/weather-maps.json", get(rainviewer))
        .route("/google/v1/currentConditions:lookup", get(google))
        .with_state(stub);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    format!("http://{addr}")
}

/// A database with the weather services pointed at the stub; `tune` sets keys / budgets.
async fn weather_db(stub: &Arc<Stub>, tune: impl FnOnce(&mut Settings) + Send + 'static) -> Option<TestDb> {
    let base = serve(Arc::clone(stub)).await;
    let db = TestDb::with_settings(
        move |s| {
            s.longdo_base_url = format!("{base}/longdo/");
            s.rainviewer_url = format!("{base}/rv/weather-maps.json");
            s.google_weather_base_url = format!("{base}/google/v1/");
            s.google_weather_api_key = String::new();
            s.longdo_api_key = String::new();
            tune(s);
        },
        false,
    )
    .await?;
    for (id, lat, lon) in [(7501, Some(13.7563), Some(100.5018)), (7502, Some(18.79), Some(98.98)), (7503, None, None)] {
        sqlx::query("INSERT INTO growatt_plants (plant_id, name, latitude, longitude, synced_at) VALUES ($1, 'W', $2, $3, now())")
            .bind(id)
            .bind(lat)
            .bind(lon)
            .execute(&db.pool)
            .await
            .unwrap();
    }
    Some(db)
}

async fn get_json(db: &TestDb, uri: &str, token: &str) -> Res {
    send(&db.app, Method::GET, uri, Some(token), None).await
}

async fn counted(db: &TestDb, api: &str) -> i64 {
    sqlx::query_scalar("SELECT COALESCE(SUM(calls), 0)::bigint FROM external_api_call_counts WHERE api = $1")
        .bind(api)
        .fetch_one(&db.pool)
        .await
        .unwrap()
}

#[tokio::test]
async fn nothing_configured() {
    let stub = Arc::new(Stub::default());
    let Some(db) = weather_db(&stub, |s| s.rainviewer_enabled = false).await else { return };
    let admin = db.admin().await;
    let r = get_json(&db, "/growatt/live/rain-radar", &admin).await;
    assert_eq!((r.status, r.body["detail"].as_str()), (StatusCode::NOT_FOUND, Some("Rain radar is not configured")));
    let r = get_json(&db, "/growatt/live/rain", &admin).await;
    assert_eq!((r.status, r.body["detail"].as_str()), (StatusCode::NOT_FOUND, Some("Longdo rain radar is not configured")));
    let r = get_json(&db, "/api/growatt/live/plants/7501/rain", &admin).await;
    assert_eq!(r.status, StatusCode::NOT_FOUND);
    let r = get_json(&db, "/growatt/live/plants/7501/google-weather", &admin).await;
    assert_eq!(r.status, StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(r.body["detail"], json!("Google Weather unavailable: Google Weather is not configured (GOOGLE_WEATHER_API_KEY)"));
    let r = send(&db.app, Method::GET, "/growatt/live/rain-radar", None, None).await;
    assert_eq!(r.status, StatusCode::UNAUTHORIZED);
    assert_eq!(stub.calls("rainviewer") + stub.calls("google"), 0);
    db.finish().await;
}

#[tokio::test]
async fn radar_fallbacks() {
    let stub = Arc::new(Stub::default());
    // Longdo refuses the key, RainViewer off: 503
    let Some(db) = weather_db(&stub, |s| {
        s.longdo_api_key = "bad".into();
        s.rainviewer_enabled = false;
    })
    .await
    else {
        return;
    };
    let admin = db.admin().await;
    let r = get_json(&db, "/growatt/live/rain-radar", &admin).await;
    assert_eq!(r.status, StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(r.body["detail"], json!("Longdo rain radar unavailable: rain/api/v1/layer/list: HTTP 403 invalid key"));
    db.finish().await;

    // Longdo refuses, RainViewer on: its tiles, with the reason
    let Some(db) = weather_db(&stub, |s| s.longdo_api_key = "bad".into()).await else { return };
    let admin = db.admin().await;
    let r = get_json(&db, "/growatt/live/rain-radar", &admin).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    let d = &r.body["data"];
    assert_eq!(d["provider"], json!("RainViewer weather radar"));
    assert_eq!(d["frames"], json!([10, 20]));
    assert_eq!(d["tile_url"], json!("https://tiles.example/b/256/{z}/{x}/{y}/2/1_0.png"));
    assert_eq!(d["point_rain"], json!(false));
    assert_eq!(d["fallback_reason"], json!("Longdo is unavailable (rain/api/v1/layer/list: HTTP 403 invalid key)"));
    // the refused call was counted against the budget (Python reserves before calling)
    assert_eq!(counted(&db, "longdo").await, 1);
    db.finish().await;
}

#[tokio::test]
async fn longdo_rain_and_budget() {
    let stub = Arc::new(Stub::default());
    let Some(db) = weather_db(&stub, |s| s.longdo_api_key = "good".into()).await else { return };
    let admin = db.admin().await;
    let r = get_json(&db, "/growatt/live/rain-radar", &admin).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    assert_eq!(r.body["data"]["frames"], json!([100, 200]));
    assert_eq!(r.body["refresh_in_s"], json!(300));
    assert!(r.body["data"]["tile_url"].as_str().unwrap().ends_with("rain/api/v1/layer/{time}/{z}/{x}/{y}.png?key=good"));

    let r = get_json(&db, "/growatt/live/plants/7502/rain", &admin).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    let d = &r.body["data"];
    assert_eq!(d["now"], json!({"intensity": 2, "description": "x"}));
    assert_eq!(d["now_via"], json!("point"));
    assert_eq!(d["radar"], json!(true));
    assert_eq!(d["area"]["now"], json!({"coverage_pct": 5.0, "max_intensity": 2}));
    assert_eq!(r.body["stale"], json!(false));
    assert_eq!(counted(&db, "longdo").await, 1 + 4);

    let r = get_json(&db, "/growatt/live/plants/7503/rain", &admin).await;
    assert_eq!((r.status, r.body["detail"].as_str()), (StatusCode::SERVICE_UNAVAILABLE, Some("Longdo rain radar unavailable: plant has no coordinates")));

    // fleet: two regions, then the wet region's cell
    let r = get_json(&db, "/growatt/live/rain", &admin).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    let rows = r.body["data"]["plants"].as_array().unwrap();
    let by: HashMap<i64, &Value> = rows.iter().map(|p| (p["plant_id"].as_i64().unwrap(), p)).collect();
    assert_eq!(by[&7501]["via"], json!("area"));
    assert_eq!(by[&7501]["rain"], json!({"intensity": 0, "description": null}));
    assert_eq!(by[&7502]["via"], json!("point"));
    assert_eq!(by[&7503]["checked"], json!(false));
    assert_eq!(r.body["data"]["raining"], json!(1));
    assert_eq!(r.body["data"]["usage"]["used_today"], json!(5 + 3));
    db.finish().await;

    // a budget used up: the plant answers 200 stale with the reason, nothing called
    let stub2 = Arc::new(Stub::default());
    let Some(db) = weather_db(&stub2, |s| {
        s.longdo_api_key = "good".into();
        s.longdo_monthly_budget = 0;
    })
    .await
    else {
        return;
    };
    let admin = db.admin().await;
    let r = get_json(&db, "/growatt/live/plants/7501/rain", &admin).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    assert_eq!(r.body["stale"], json!(true));
    assert_eq!(r.body["error"], json!("Longdo call budget for today used up (monthly limit)"));
    assert_eq!(r.body["refresh_in_s"], json!(600));
    assert_eq!(r.body["data"]["now"], Value::Null);
    assert_eq!(r.body["data"]["area"]["error"], json!("Longdo call budget for today used up (monthly limit)"));
    assert_eq!(stub2.calls("rain/api/v1/location"), 0);
    db.finish().await;
}

#[tokio::test]
async fn google_live_counts_calls() {
    let stub = Arc::new(Stub::default());
    let Some(db) = weather_db(&stub, |s| {
        s.google_weather_api_key = "good".into();
        s.google_weather_day_start_h = 0;
        s.google_weather_day_end_h = 24;
    })
    .await
    else {
        return;
    };
    let admin = db.admin().await;
    let r = get_json(&db, "/growatt/live/plants/7501/google-weather", &admin).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    let d = &r.body["data"];
    assert_eq!(d["modelled"], json!(true));
    assert_eq!(d["cell"], json!({"key": "13.76,100.50", "latitude": 13.76, "longitude": 100.5}));
    assert_eq!(d["temp_c"], json!(30.5));
    assert_eq!(r.body["refresh_in_s"], json!(1800));
    // cached: no second call
    let r = get_json(&db, "/growatt/live/plants/7501/google-weather", &admin).await;
    assert_eq!(r.status, StatusCode::OK);
    assert_eq!(stub.calls("google"), 1);
    assert_eq!(counted(&db, "google_weather_current").await, 1);
    let r = get_json(&db, "/growatt/live/plants/7503/google-weather", &admin).await;
    assert_eq!((r.status, r.body["detail"].as_str()), (StatusCode::SERVICE_UNAVAILABLE, Some("Google Weather unavailable: plant has no coordinates")));
    db.finish().await;

    // budget: today's allowance (here 2 calls) minus one call per fleet cell (2) kept for the
    // history job until it has run today -> nothing left for live calls
    let stub2 = Arc::new(Stub::default());
    let days_left = {
        let today = tcroof_services::google_weather_live::billing_day();
        (tcroof_services::google_weather_live::month(today).1 - today).num_days()
    };
    let Some(db) = weather_db(&stub2, move |s| {
        s.google_weather_api_key = "good".into();
        s.google_weather_day_start_h = 0;
        s.google_weather_day_end_h = 24;
        s.google_weather_monthly_budget = 2 * days_left;
    })
    .await
    else {
        return;
    };
    let admin = db.admin().await;
    let r = get_json(&db, "/growatt/live/plants/7501/google-weather", &admin).await;
    assert_eq!(r.status, StatusCode::SERVICE_UNAVAILABLE, "{}", r.body);
    assert_eq!(r.body["detail"], json!("Google Weather unavailable: Google Weather call budget for today used up (monthly free tier)"));
    assert_eq!(stub2.calls("google"), 0);
    db.finish().await;
}
