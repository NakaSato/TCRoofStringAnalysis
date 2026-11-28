//! Service-account tokens (google_auth) and the Firestore commit (firestore) against local stub
//! servers only. The key is a throwaway RSA key made with `openssl` for the test run, in a temp
//! folder; the key file's `token_uri` points at the stub. Never the real key in `secrets/`, never
//! Google. Without `openssl` on PATH the tests say so and pass without checking.

use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::PathBuf;
use std::process::Command;
use std::sync::{Arc, Mutex};
use std::thread;

use serde_json::{json, Value};
use tcroof_clients::firestore::{FirestoreAuth, FirestoreClient};
use tcroof_clients::google_auth;

/// One request: (method + target, headers lower-cased, body)
type Seen = Arc<Mutex<Vec<(String, String, String)>>>;

fn serve(replies: Vec<(&'static str, String)>) -> (String, Seen) {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
    let base = format!("http://{}", listener.local_addr().unwrap());
    let seen: Seen = Arc::new(Mutex::new(Vec::new()));
    let log = seen.clone();
    thread::spawn(move || {
        for (status, body) in replies {
            let Ok((mut s, _)) = listener.accept() else { return };
            log.lock().unwrap().push(read_request(&mut s));
            let resp = format!(
                "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
            let _ = s.write_all(resp.as_bytes());
        }
    });
    (base, seen)
}

fn read_request(s: &mut TcpStream) -> (String, String, String) {
    let mut buf = Vec::new();
    let mut chunk = [0u8; 4096];
    let head_end = loop {
        if let Some(i) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
            break i + 4;
        }
        match s.read(&mut chunk) {
            Ok(0) | Err(_) => return (String::new(), String::new(), String::new()),
            Ok(n) => buf.extend_from_slice(&chunk[..n]),
        }
    };
    let head = String::from_utf8_lossy(&buf[..head_end]).to_lowercase();
    let len: usize = head
        .lines()
        .find_map(|l| l.strip_prefix("content-length:").map(|v| v.trim().parse().unwrap_or(0)))
        .unwrap_or(0);
    while buf.len() < head_end + len {
        match s.read(&mut chunk) {
            Ok(0) | Err(_) => break,
            Ok(n) => buf.extend_from_slice(&chunk[..n]),
        }
    }
    let first = String::from_utf8_lossy(&buf[..head_end]).lines().next().unwrap_or("").to_string();
    (first, head, String::from_utf8_lossy(&buf[head_end..]).to_string())
}

/// A throwaway key pair in a temp folder: (private PEM, public PEM), None without openssl.
fn throwaway_key() -> Option<(String, String)> {
    let dir = std::env::temp_dir().join(format!("tcroof-gauth-{}-{:?}", std::process::id(), thread::current().id()));
    std::fs::create_dir_all(&dir).ok()?;
    let key = dir.join("k.pem");
    let ok = Command::new("openssl")
        .args(["genpkey", "-algorithm", "RSA", "-pkeyopt", "rsa_keygen_bits:2048", "-out"])
        .arg(&key)
        .output()
        .ok()?
        .status
        .success();
    if !ok {
        return None;
    }
    let public = Command::new("openssl").args(["pkey", "-pubout", "-in"]).arg(&key).output().ok()?;
    let private = std::fs::read_to_string(&key).ok()?;
    let _ = std::fs::remove_dir_all(&dir);
    Some((private, String::from_utf8(public.stdout).ok()?))
}

fn key_file(private: &str, token_uri: &str, name: &str) -> PathBuf {
    let p = std::env::temp_dir().join(format!("tcroof-gauth-{}-{name}.json", std::process::id()));
    let doc = json!({
        "type": "service_account", "project_id": "stub-project", "private_key_id": "kid-1",
        "private_key": private, "client_email": "publisher@stub-project.iam.gserviceaccount.com",
        "token_uri": token_uri,
    });
    std::fs::write(&p, doc.to_string()).unwrap();
    p
}

fn form_value(body: &str, key: &str) -> Option<String> {
    body.split('&').find_map(|kv| kv.strip_prefix(&format!("{key}=")).map(|v| v.replace("%3A", ":").replace("%2F", "/")))
}

#[tokio::test]
async fn token_is_fetched_once_and_cached() {
    let Some((private, public)) = throwaway_key() else {
        eprintln!("openssl not found: google_auth token test skipped");
        return;
    };
    let (base, seen) = serve(vec![("200 OK", r#"{"access_token":"tok-1","expires_in":3600,"token_type":"Bearer"}"#.into())]);
    let file = key_file(&private, &format!("{base}/token"), "cache");
    let file = file.to_str().unwrap();
    let http = reqwest::Client::new();
    let scopes = ["https://www.googleapis.com/auth/datastore"];
    assert_eq!(google_auth::access_token(&http, file, &scopes).await.unwrap(), "tok-1");
    assert_eq!(google_auth::access_token(&http, file, &scopes).await.unwrap(), "tok-1");
    let seen = seen.lock().unwrap().clone();
    assert_eq!(seen.len(), 1, "the second call is served from the cache");
    let (line, _, body) = &seen[0];
    assert_eq!(line, "POST /token HTTP/1.1");
    assert_eq!(form_value(body, "grant_type").as_deref(), Some("urn:ietf:params:oauth:grant-type:jwt-bearer"));
    let jwt = form_value(body, "assertion").unwrap();
    let mut v = jsonwebtoken::Validation::new(jsonwebtoken::Algorithm::RS256);
    v.set_audience(&[format!("{base}/token")]);
    let claims = jsonwebtoken::decode::<Value>(&jwt, &jsonwebtoken::DecodingKey::from_rsa_pem(public.as_bytes()).unwrap(), &v)
        .expect("assertion signed with the key file's key")
        .claims;
    assert_eq!(claims["iss"], "publisher@stub-project.iam.gserviceaccount.com");
    assert_eq!(claims["scope"], "https://www.googleapis.com/auth/datastore");
    assert_eq!(claims["exp"].as_u64().unwrap() - claims["iat"].as_u64().unwrap(), 3600);
    assert_eq!(jsonwebtoken::decode_header(&jwt).unwrap().kid.as_deref(), Some("kid-1"));
    let _ = std::fs::remove_file(file);
}

#[tokio::test]
async fn refused_assertion_is_an_error_without_the_key() {
    let Some((private, _)) = throwaway_key() else {
        eprintln!("openssl not found: google_auth error test skipped");
        return;
    };
    let (base, _) = serve(vec![("400 Bad Request", r#"{"error":"invalid_grant","error_description":"Invalid JWT Signature."}"#.into())]);
    let file = key_file(&private, &format!("{base}/token"), "refused");
    let e = google_auth::access_token(&reqwest::Client::new(), file.to_str().unwrap(), &["s"]).await.unwrap_err().to_string();
    assert!(e.contains("HTTP 400: Invalid JWT Signature."), "{e}");
    assert!(!e.contains("PRIVATE KEY"), "{e}");
    let _ = std::fs::remove_file(file);
}

#[tokio::test]
async fn missing_key_file_is_an_error() {
    let e = google_auth::access_token(&reqwest::Client::new(), "/nonexistent/key.json", &["s"]).await.unwrap_err();
    assert!(e.to_string().starts_with("service account key /nonexistent/key.json:"), "{e}");
    assert!(google_auth::read_key("").is_err());
}

#[tokio::test]
async fn firestore_commit_with_a_service_account_token() {
    let Some((private, _)) = throwaway_key() else {
        eprintln!("openssl not found: Firestore commit test skipped");
        return;
    };
    // one server answers the token, then the commit
    let (base, seen) = serve(vec![
        ("200 OK", r#"{"access_token":"tok-fs","expires_in":3600}"#.into()),
        ("200 OK", r#"{"writeResults":[{}],"commitTime":"2026-11-28T00:00:00Z"}"#.into()),
    ]);
    let file = key_file(&private, &format!("{base}/token"), "fs");
    let c = FirestoreClient::new(&format!("{base}/v1/"), "stub-project", FirestoreAuth::ServiceAccount(file.to_str().unwrap().into()), 5.0)
        .unwrap();
    c.commit_set(&[("daily/2026-11-27".into(), json!({"schema": 1, "yield_kwh": 12.5, "plants": {}}))]).await.unwrap();
    let seen = seen.lock().unwrap().clone();
    assert_eq!(seen.len(), 2);
    let (line, head, body) = &seen[1];
    assert_eq!(line, "POST /v1/projects/stub-project/databases/(default)/documents:commit HTTP/1.1");
    assert!(head.contains("authorization: bearer tok-fs"), "{head}");
    let body: Value = serde_json::from_str(body).unwrap();
    assert_eq!(
        body,
        json!({"writes": [{"update": {
            "name": "projects/stub-project/databases/(default)/documents/daily/2026-11-27",
            "fields": {"schema": {"integerValue": "1"}, "yield_kwh": {"doubleValue": 12.5}, "plants": {"mapValue": {"fields": {}}}},
        }}]})
    );
    let _ = std::fs::remove_file(file);
}

#[tokio::test]
async fn firestore_error_names_the_answer() {
    let (base, _) = serve(vec![("403 Forbidden", r#"{"error":{"code":403,"message":"Missing or insufficient permissions."}}"#.into())]);
    let c = FirestoreClient::new(&format!("{base}/v1/"), "p", FirestoreAuth::Emulator, 5.0).unwrap();
    let e = c.commit_set(&[("config/x".into(), json!({}))]).await.unwrap_err().to_string();
    assert_eq!(e, "Firestore commit failed: HTTP 403: Missing or insufficient permissions.");
}
