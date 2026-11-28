//! Service-account OAuth for Google APIs (what Python gets from
//! `google.oauth2.service_account.Credentials.from_service_account_file(path, scopes=…)`): a JWT
//! signed with the key file's RSA key (RS256, `kid` = `private_key_id`) is exchanged at the key
//! file's own `token_uri` for an access token (`urn:ietf:params:oauth:grant-type:jwt-bearer`).
//!
//! Tokens are cached per (key file, scopes) until 60 s before they expire, as google-auth
//! refreshes. The key and the token never appear in an error or a log line. Application Default
//! Credentials (Python's fallback without a key file) are not supported: the worker always has a
//! key file (`FIREBASE_CREDENTIALS_FILE`).

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// google-auth's refresh margin: a token this close to its expiry is fetched again.
const REFRESH_MARGIN_S: u64 = 60;
/// Lifetime asked for in the assertion (Google's maximum).
const ASSERTION_LIFETIME_S: u64 = 3600;

/// Why no token could be had. `kind()` is the Python exception class for run details.
#[derive(Debug, Clone, thiserror::Error)]
pub enum GoogleAuthError {
    /// The key file is missing, unreadable or not a service-account key.
    #[error("{0}")]
    KeyFile(String),
    /// The token endpoint refused or answered something unusable (google-auth `RefreshError`).
    #[error("{0}")]
    Refresh(String),
}

impl GoogleAuthError {
    /// Python's exception class name for the same failure.
    pub fn kind(&self) -> &'static str {
        match self {
            GoogleAuthError::KeyFile(_) => "ValueError",
            GoogleAuthError::Refresh(_) => "RefreshError",
        }
    }
}

#[derive(Deserialize)]
struct KeyFile {
    #[serde(rename = "type")]
    kind: Option<String>,
    client_email: Option<String>,
    private_key: Option<String>,
    private_key_id: Option<String>,
    token_uri: Option<String>,
}

#[derive(Serialize)]
struct Claims<'a> {
    iss: &'a str,
    scope: String,
    aud: &'a str,
    iat: u64,
    exp: u64,
}

struct Cached {
    token: String,
    until: Instant,
}

fn cache() -> &'static Mutex<HashMap<(String, String), Cached>> {
    static CACHE: OnceLock<Mutex<HashMap<(String, String), Cached>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// An access token for `scopes` from the service-account key file `creds_file`, fetched from the
/// file's `token_uri` and cached until near expiry.
pub async fn access_token(http: &reqwest::Client, creds_file: &str, scopes: &[&str]) -> Result<String, GoogleAuthError> {
    let scope = scopes.join(" ");
    let key = (creds_file.to_owned(), scope.clone());
    if let Some(c) = cache().lock().expect("token cache").get(&key) {
        if Instant::now() < c.until {
            return Ok(c.token.clone());
        }
    }
    let text = std::fs::read_to_string(creds_file)
        .map_err(|e| GoogleAuthError::KeyFile(format!("service account key file {creds_file} could not be read: {e}")))?;
    let kf: KeyFile = serde_json::from_str(&text)
        .map_err(|_| GoogleAuthError::KeyFile(format!("service account key file {creds_file} is not valid JSON")))?;
    if kf.kind.as_deref().is_some_and(|t| t != "service_account") {
        return Err(GoogleAuthError::KeyFile("The key file is not a service account key".into()));
    }
    let missing = |f: &str| GoogleAuthError::KeyFile(format!("Service account info was not in the expected format, missing fields {f}."));
    let email = kf.client_email.ok_or_else(|| missing("client_email"))?;
    let pem = kf.private_key.ok_or_else(|| missing("private_key"))?;
    let token_uri = kf.token_uri.ok_or_else(|| missing("token_uri"))?;

    let now = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    let claims = Claims { iss: &email, scope, aud: &token_uri, iat: now, exp: now + ASSERTION_LIFETIME_S };
    let mut header = jsonwebtoken::Header::new(jsonwebtoken::Algorithm::RS256);
    header.kid = kf.private_key_id;
    let signing = jsonwebtoken::EncodingKey::from_rsa_pem(pem.as_bytes())
        .map_err(|_| GoogleAuthError::KeyFile("No key could be detected in the service account private_key".into()))?;
    let assertion = jsonwebtoken::encode(&header, &claims, &signing)
        .map_err(|e| GoogleAuthError::KeyFile(format!("could not sign the service account assertion: {e}")))?;

    let sent = http
        .post(&token_uri)
        .form(&[("grant_type", "urn:ietf:params:oauth:grant-type:jwt-bearer"), ("assertion", assertion.as_str())])
        .send()
        .await
        .map_err(|e| GoogleAuthError::Refresh(format!("token request failed: {}", crate::google_weather::requests_exc_name(&e))))?;
    let status = sent.status();
    let body: Value = sent.json().await.unwrap_or(Value::Null);
    if !status.is_success() {
        let why = body.get("error_description").or_else(|| body.get("error")).and_then(Value::as_str).unwrap_or("").to_owned();
        return Err(GoogleAuthError::Refresh(format!("token endpoint answered HTTP {}: {why}", status.as_u16())));
    }
    let token = body
        .get("access_token")
        .and_then(Value::as_str)
        .filter(|t| !t.is_empty())
        .ok_or_else(|| GoogleAuthError::Refresh("No access token in response.".into()))?
        .to_owned();
    let expires_in = body.get("expires_in").and_then(Value::as_u64).unwrap_or(ASSERTION_LIFETIME_S);
    let until = Instant::now() + Duration::from_secs(expires_in.saturating_sub(REFRESH_MARGIN_S));
    cache().lock().expect("token cache").insert(key, Cached { token: token.clone(), until });
    Ok(token)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn a_missing_key_file_is_a_key_file_error() {
        let http = reqwest::Client::new();
        let e = access_token(&http, "/nonexistent/key.json", &["s"]).await.unwrap_err();
        assert!(matches!(e, GoogleAuthError::KeyFile(_)));
        assert_eq!(e.kind(), "ValueError");
    }

    #[tokio::test]
    async fn a_key_file_without_fields_names_them() {
        let dir = std::env::temp_dir().join(format!("gauth-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("k.json");
        std::fs::write(&p, r#"{"type": "service_account", "client_email": "a@b"}"#).unwrap();
        let e = access_token(&reqwest::Client::new(), p.to_str().unwrap(), &["s"]).await.unwrap_err();
        assert!(e.to_string().contains("private_key"), "{e}");
    }
}
