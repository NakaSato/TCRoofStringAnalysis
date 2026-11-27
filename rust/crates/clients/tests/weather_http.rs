//! Request building and error handling of the weather clients against a local stub HTTP server,
//! mirroring backend/tests/test_google_weather.py (`test_client_errors_never_contain_the_api_key`)
//! and backend/tests/test_longdo_weather.py (`test_client_error_never_shows_the_key`, tile URL,
//! empty key), plus the query strings Python's `requests` sends.

use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use tcroof_clients::google_weather::GoogleWeatherClient;
use tcroof_clients::longdo_weather::LongdoWeatherClient;
use tcroof_clients::rainviewer::RainViewerClient;

/// One canned answer: status line, body; `None` = accept and never answer (read timeout).
type Reply = Option<(&'static str, String)>;

/// A stub server answering `replies` in order, one connection each; returns its base URL and the
/// request target (`/path?query`) of every request received.
fn serve(replies: Vec<Reply>) -> (String, Arc<Mutex<Vec<String>>>) {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
    let base = format!("http://{}", listener.local_addr().unwrap());
    let seen = Arc::new(Mutex::new(Vec::new()));
    let log = seen.clone();
    thread::spawn(move || {
        for reply in replies {
            let Ok((mut s, _)) = listener.accept() else { return };
            log.lock().unwrap().push(read_target(&mut s));
            match reply {
                None => thread::sleep(Duration::from_secs(3)),
                Some((status, body)) => {
                    let resp = format!(
                        "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                        body.len()
                    );
                    let _ = s.write_all(resp.as_bytes());
                }
            }
        }
    });
    (base, seen)
}

fn read_target(s: &mut TcpStream) -> String {
    let mut buf = Vec::new();
    let mut chunk = [0u8; 1024];
    while !buf.windows(4).any(|w| w == b"\r\n\r\n") {
        match s.read(&mut chunk) {
            Ok(0) | Err(_) => break,
            Ok(n) => buf.extend_from_slice(&chunk[..n]),
        }
    }
    let text = String::from_utf8_lossy(&buf);
    text.lines().next().unwrap_or("").split(' ').nth(1).unwrap_or("").to_string()
}

/// A local port nothing listens on.
fn closed_port() -> String {
    let l = TcpListener::bind("127.0.0.1:0").unwrap();
    let base = format!("http://{}", l.local_addr().unwrap());
    drop(l);
    base
}

const KEY: &str = "AIza-secret-key-123";

// --------------------------------------------------------------------------- Google Weather

#[tokio::test]
async fn google_current_request_and_parse() {
    let body = r#"{"currentTime":"2026-11-12T05:00:00.123456789Z","temperature":{"degrees":86,"unit":"FAHRENHEIT"},"cloudCover":80,
                   "currentConditionsHistory":{"qpf":{"quantity":0.1,"unit":"INCHES"}}}"#;
    let (base, seen) = serve(vec![Some(("200 OK", body.into()))]);
    let c = GoogleWeatherClient::new(KEY, &format!("{base}/v1"), 5.0).unwrap();
    let cur = c.current(13.7, 100.5).await.unwrap();
    assert_eq!(cur.conditions.temp_c, Some(30.0));
    assert_eq!(cur.past24h_precip_mm, Some(2.54));
    assert_eq!(cur.conditions.humidity_pct, None);
    assert_eq!(cur.time_utc.as_deref(), Some("2026-11-12T05:00:00.123456+00:00"));
    assert_eq!(c.calls(), 1);
    assert_eq!(
        seen.lock().unwrap()[0],
        format!("/v1/currentConditions:lookup?location.latitude=13.70000&location.longitude=100.50000&unitsSystem=METRIC&key={KEY}")
    );
}

#[tokio::test]
async fn google_history_follows_page_token_up_to_max_pages() {
    let hour = |h: u32| {
        format!(
            r#"{{"interval":{{"startTime":"2026-11-11T{:02}:00:00Z"}},"displayDateTime":{{"year":2026,"month":11,"day":11,"hours":{h},"utcOffset":"25200s"}},
                "temperature":{{"degrees":25}},"wind":{{"speed":{{"value":36,"unit":"KILOMETERS_PER_HOUR"}}}}}}"#,
            h - 7
        )
    };
    let p1 = format!(r#"{{"historyHours":[{},{}],"nextPageToken":"tok+1/="}}"#, hour(12), hour(11));
    let p2 = format!(r#"{{"historyHours":[{},"x"],"nextPageToken":"again"}}"#, hour(10));
    let (base, seen) = serve(vec![Some(("200 OK", p1)), Some(("200 OK", p2))]);
    let c = GoogleWeatherClient::new(KEY, &base, 5.0).unwrap();
    let rows = c.history_hours(13.7, 100.5, 24, 2).await.unwrap();
    let hours: Vec<String> = rows.iter().map(|r| r.hour_local.format("%H").to_string()).collect();
    assert_eq!(hours, ["10", "11", "12"]); // oldest first; the bad item dropped
    assert_eq!(rows[0].conditions.wind_speed_ms, Some(10.0));
    assert_eq!(c.calls(), 2); // max_pages reached although a token came back
    let seen = seen.lock().unwrap();
    let loc = "location.latitude=13.70000&location.longitude=100.50000&unitsSystem=METRIC&hours=24&pageSize=24";
    assert_eq!(seen[0], format!("/history/hours:lookup?{loc}&key={KEY}"));
    assert_eq!(seen[1], format!("/history/hours:lookup?{loc}&pageToken=tok%2B1%2F%3D&key={KEY}"));
}

#[tokio::test]
async fn google_errors_never_contain_the_key() {
    let msg = format!(r#"{{"error":{{"code":400,"message":"API key not valid: https://weather.googleapis.com/v1/x?key={KEY}"}}}}"#);
    let (base, _) = serve(vec![Some(("400 Bad Request", msg)), Some(("429 Too Many Requests", "quota".into())), Some(("200 OK", "not json".into()))]);
    let c = GoogleWeatherClient::new(KEY, &base, 5.0).unwrap();
    let e = c.current(13.7, 100.5).await.unwrap_err();
    assert_eq!(e.to_string(), "currentConditions:lookup: HTTP 400 API key not valid: https://weather.googleapis.com/v1/x?key=***");
    assert_eq!(e.status, Some(400));
    let e = c.current(13.7, 100.5).await.unwrap_err();
    assert_eq!(e.to_string(), "currentConditions:lookup: HTTP 429 Too Many Requests");
    assert!(e.to_string().contains("HTTP 429")); // what the service's quota stop matches
    let cur = c.current(13.7, 100.5).await.unwrap(); // 200, not JSON: `{}`, every field None
    assert_eq!(cur, Default::default());
    assert_eq!(c.calls(), 3);

    let c = GoogleWeatherClient::new(KEY, &closed_port(), 5.0).unwrap();
    let e = c.current(13.7, 100.5).await.unwrap_err();
    assert_eq!(e.to_string(), "currentConditions:lookup: ConnectionError");
    assert!(!format!("{e:?}{c:?}").contains(KEY));
    assert_eq!(c.calls(), 1); // a failed call still counts

    assert_eq!(GoogleWeatherClient::new("", &base, 5.0).unwrap_err().to_string(), "GOOGLE_WEATHER_API_KEY is not set");
}

#[tokio::test]
async fn google_read_timeout() {
    let (base, _) = serve(vec![None]);
    let c = GoogleWeatherClient::new(KEY, &base, 0.3).unwrap();
    let e = c.history_hours(13.7, 100.5, 24, 2).await.unwrap_err();
    assert_eq!(e.to_string(), "history/hours:lookup: ReadTimeout");
}

// ----------------------------------------------------------------------------------- Longdo

#[tokio::test]
async fn longdo_requests_and_parsing() {
    let (base, seen) = serve(vec![
        Some(("200 OK", r#"{"radar":{"past":[{"time":20},{"time":10},{"time":null},"x"]}}"#.into())),
        Some(("200 OK", r##"{"levels":[{"intensity":2,"label":"Light","hex":"#40adfa"},{"intensity":1}]}"##.into())),
        Some(("200 OK", r#"{"rain":{"level":"moderate","description":"ฝนปานกลาง","intensity":3}}"#.into())),
        Some(("200 OK", r#"{"lead_minutes":[15,30],"forecast":[{"unix_time":100,"available":true,"rain":{"intensity":1}},{"unix_time":200,"available":false,"rain":{"intensity":4}}]}"#.into())),
        Some(("200 OK", r#"{"stats":{"rain_coverage_pct":20.014,"max_intensity":4}}"#.into())),
        Some(("200 OK", r#"{"lead_minutes":[15],"forecast":[{"unix_time":1,"stats":{"rain_coverage_pct":5}}]}"#.into())),
    ]);
    let c = LongdoWeatherClient::new("SECRETKEY", &format!("{base}/"), 5.0).unwrap();
    assert_eq!(c.frames().await.unwrap(), [10, 20]);
    let legend = c.legend().await.unwrap();
    assert_eq!((legend.len(), legend[0].color.as_str()), (1, "#40adfa"));
    let rain = c.rain_at(13.7, 100.0).await.unwrap().unwrap();
    assert_eq!((rain.intensity, rain.description.as_deref()), (3, Some("ฝนปานกลาง")));
    let fc = c.forecast_at(13.7, 100.0).await.unwrap();
    assert_eq!((fc[0].lead_min, fc[1].time, fc[1].rain.clone()), (Some(15), Some(200), None)); // unavailable is never a 0
    let area = c.area_at(13.7, 100.0, 10.0).await.unwrap().unwrap();
    assert_eq!((area.coverage_pct, area.max_intensity), (Some(20.0), Some(4)));
    let fa = c.forecast_area_at(13.7, 100.0, 10.0).await.unwrap();
    assert_eq!(fa[0].stats.as_ref().unwrap().max_intensity, None);
    let seen = seen.lock().unwrap();
    assert_eq!(
        *seen,
        [
            "/rain/api/v1/layer/list?key=SECRETKEY",
            "/rain/api/v1/legend?format=json&lang=th", // the legend is static: no key
            "/rain/api/v1/location?lat=13.7&lon=100.0&key=SECRETKEY", // floats as Python str()
            "/rain/api/v1/forecast/location?lat=13.7&lon=100.0&key=SECRETKEY",
            "/rain/api/v1/area?lat=13.7&lon=100.0&radius_km=10.0&key=SECRETKEY",
            "/rain/api/v1/forecast/area?lat=13.7&lon=100.0&radius_km=10.0&key=SECRETKEY",
        ]
    );
}

#[tokio::test]
async fn longdo_errors_never_show_the_key() {
    let (base, _) = serve(vec![
        Some(("403 Forbidden", r#"{"detail":"bad key SECRETKEY"}"#.into())),
        Some(("500 Internal Server Error", r#"{"detail":{"msg":"x"}}"#.into())),
        Some(("200 OK", "<html>".into())),
        Some(("200 OK", "null".into())),
    ]);
    let c = LongdoWeatherClient::new("SECRETKEY", &base, 5.0).unwrap();
    let e = c.frames().await.unwrap_err();
    assert_eq!(e.to_string(), "rain/api/v1/layer/list: HTTP 403 bad key ***");
    assert_eq!(e.status, Some(403));
    assert_eq!(c.frames().await.unwrap_err().to_string(), "rain/api/v1/layer/list: HTTP 500 Internal Server Error");
    assert_eq!(c.frames().await.unwrap_err().to_string(), "rain/api/v1/layer/list: answer is not JSON");
    assert_eq!(c.frames().await.unwrap_err().to_string(), "rain/api/v1/layer/list: answer is not JSON");
    assert!(c.tile_url().ends_with("/rain/api/v1/layer/{time}/{z}/{x}/{y}.png?key=SECRETKEY"));
    assert!(!format!("{c:?}").contains("SECRETKEY"));
    assert_eq!(LongdoWeatherClient::new("", &base, 5.0).unwrap_err().to_string(), "LONGDO_API_KEY is not set");

    let c = LongdoWeatherClient::new("SECRETKEY", &closed_port(), 5.0).unwrap();
    assert_eq!(c.rain_at(13.7, 100.5).await.unwrap_err().to_string(), "rain/api/v1/location: ConnectionError");
}

// ------------------------------------------------------------------------------- RainViewer

#[tokio::test]
async fn rainviewer_maps_and_errors() {
    let body = r#"{"host":"https://tilecache.rainviewer.com","radar":{"past":[{"time":1740449400,"path":"/v2/radar/bbb"},{"time":1740448800,"path":"/v2/radar/aaa"},{"time":5}]}}"#;
    let (base, seen) = serve(vec![
        Some(("200 OK", body.into())),
        Some(("503 Service Unavailable", "{}".into())),
        Some(("200 OK", "nope".into())),
        Some(("200 OK", "[]".into())),
    ]);
    let c = RainViewerClient::new(&format!("{base}/public/weather-maps.json"), 5.0);
    let m = c.maps().await.unwrap();
    assert_eq!(m.frames, [1740448800, 1740449400]);
    assert_eq!(m.tiles[&1740448800], "https://tilecache.rainviewer.com/v2/radar/aaa/256/{z}/{x}/{y}/2/1_0.png");
    let j = serde_json::to_value(&m).unwrap();
    assert!(j["tiles"]["1740449400"].is_string()); // string keys, as Python's dict
    assert_eq!(c.maps().await.unwrap_err().to_string(), "RainViewer answered HTTP 503");
    assert_eq!(c.maps().await.unwrap_err().to_string(), "RainViewer answered no JSON");
    assert_eq!(c.maps().await.unwrap_err().to_string(), "RainViewer answered no snapshot list");
    assert_eq!(seen.lock().unwrap()[0], "/public/weather-maps.json"); // no key, no query

    let c = RainViewerClient::new(&closed_port(), 5.0);
    assert_eq!(c.maps().await.unwrap_err().to_string(), "RainViewer not reachable: ConnectionError");
}
