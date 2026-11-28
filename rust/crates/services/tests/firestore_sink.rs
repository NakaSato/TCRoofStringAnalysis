//! The Firestore summary sink (publish.rs `FirestoreSink`, Python `daily_summary.FirestoreSink`)
//! against a local stub only: batches of 400 documents per `documents:commit`, a refused commit
//! is an error. Never Firestore itself.

use std::io::{Read, Write};
use std::net::TcpListener;
use std::sync::{Arc, Mutex};
use std::thread;

use serde_json::{json, Value};
use tcroof_clients::firestore::{FirestoreAuth, FirestoreClient};
use tcroof_services::publish::{make_sink, DocSink, FirestoreSink, SinkConfig};

/// Answers `replies` in order; records each request body (parsed JSON).
fn serve(replies: Vec<&'static str>) -> (String, Arc<Mutex<Vec<Value>>>) {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
    let base = format!("http://{}", listener.local_addr().unwrap());
    let seen = Arc::new(Mutex::new(Vec::new()));
    let log = seen.clone();
    thread::spawn(move || {
        for status in replies {
            let Ok((mut s, _)) = listener.accept() else { return };
            let mut buf = Vec::new();
            let mut chunk = [0u8; 65536];
            let body = loop {
                if let Some(i) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                    let head = String::from_utf8_lossy(&buf[..i]).to_lowercase();
                    let len: usize = head
                        .lines()
                        .find_map(|l| l.strip_prefix("content-length:").map(|v| v.trim().parse().unwrap_or(0)))
                        .unwrap_or(0);
                    if buf.len() >= i + 4 + len {
                        break buf[i + 4..i + 4 + len].to_vec();
                    }
                }
                match s.read(&mut chunk) {
                    Ok(0) | Err(_) => break Vec::new(),
                    Ok(n) => buf.extend_from_slice(&chunk[..n]),
                }
            };
            log.lock().unwrap().push(serde_json::from_slice(&body).unwrap_or(Value::Null));
            let answer = r#"{"error":{"code":403,"message":"denied"}}"#;
            let body = if status.starts_with("200") { "{}" } else { answer };
            let resp = format!("HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
            let _ = s.write_all(resp.as_bytes());
        }
    });
    (base, seen)
}

#[tokio::test]
async fn writes_in_batches_of_400() {
    let (base, seen) = serve(vec!["200 OK", "200 OK"]);
    let sink = FirestoreSink { client: FirestoreClient::new(&format!("{base}/v1/"), "stub", FirestoreAuth::Emulator, 5.0).unwrap() };
    assert_eq!(sink.name(), "firestore");
    let docs: Vec<(String, Value)> = (0..401).map(|i| (format!("inverters/SN{i:03}"), json!({"schema": 1, "n": i}))).collect();
    sink.write(&docs).await.unwrap();
    let seen = seen.lock().unwrap().clone();
    assert_eq!(seen.len(), 2);
    assert_eq!(seen[0]["writes"].as_array().unwrap().len(), 400);
    assert_eq!(seen[1]["writes"].as_array().unwrap().len(), 1);
    assert_eq!(seen[1]["writes"][0]["update"]["name"], "projects/stub/databases/(default)/documents/inverters/SN400");
    assert_eq!(seen[1]["writes"][0]["update"]["fields"]["n"], json!({"integerValue": "400"}));
}

#[tokio::test]
async fn a_refused_commit_is_an_error() {
    let (base, _) = serve(vec!["403 Forbidden"]);
    let sink = FirestoreSink { client: FirestoreClient::new(&format!("{base}/v1/"), "stub", FirestoreAuth::Emulator, 5.0).unwrap() };
    let e = sink.write(&[("config/x".into(), json!({}))]).await.unwrap_err();
    assert_eq!(e, "Firestore commit failed: HTTP 403: denied");
}

#[test]
fn make_sink_like_python() {
    // Firestore without a key file: Python's RuntimeError text
    let cfg = SinkConfig { kind: "firestore".into(), ..Default::default() };
    assert_eq!(make_sink(&cfg).err().unwrap(), "Set FIREBASE_CREDENTIALS_FILE in .env to publish to Firestore.");
    // JSON: PUBLISH_JSON_DIR, else data_dir/firestore_export
    let mut cfg = SinkConfig { kind: "json".into(), data_dir: "/x/data".into(), ..Default::default() };
    assert_eq!(cfg.json_root(), std::path::PathBuf::from("/x/data/firestore_export"));
    cfg.json_dir = "/tmp/out".into();
    assert_eq!(cfg.json_root(), std::path::PathBuf::from("/tmp/out"));
    assert_eq!(make_sink(&cfg).unwrap().name(), "json");
}
