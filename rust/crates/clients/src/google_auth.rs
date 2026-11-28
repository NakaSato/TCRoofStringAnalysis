//! Google service-account OAuth access tokens (the part of `google-auth` / `firebase_admin`'s
//! `credentials.Certificate` the backend relies on): a key file's private key signs a JWT
//! assertion (RS256), exchanged at the key file's `token_uri` for a bearer token.
//!
//! Shared by the Firestore sink (services/publish.rs), FCM push and the PWA Google Sheet. Tokens
//! are cached per (key file, scopes) in this process until [`REFRESH_MARGIN_S`] before they
//! expire; nothing is stored anywhere else and a token is never logged (errors name the key
//! file's path and the token endpoint's answer, never the key or the token).
//!
//! The token endpoint is the key file's `token_uri` (Google's default when missing), so a test
//! points a throwaway key file at a local stub; never run tests with the real key in `secrets/`.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// `google.oauth2.service_account` default token endpoint
pub const DEFAULT_TOKEN_URI: &str = "https://oauth2.googleapis.com/token";
/// Lifetime asked for in the assertion (Google's maximum, as `google-auth`)
pub const ASSERTION_LIFETIME_S: u64 = 3600;
/// A cached token is renewed this long before its expiry (`google-auth` refreshes ~3-4 min early)
pub const REFRESH_MARGIN_S: u64 = 300;

#[derive(Debug, thiserror::Error)]
pub enum GoogleAuthError {
    /// The key file is missing, unreadable or not a service-account key.
    #[error("service account key {path}: {reason}")]
    KeyFile { path: String, reason: String },
    /// Signing the assertion failed (a malformed private key).
    #[error("service account key {path}: cannot sign: {reason}")]
    Sign { path: String, reason: String },
    /// The token endpoint could not be reached or refused the assertion.
    #[error("token request to {uri} failed: {reason}")]
    Token { uri: String, reason: String },
}

/// The fields of a service-account key file this module reads.
#[derive(Debug, Clone, Deserialize)]
pub struct ServiceAccountKey {
    #[serde(default, rename = "type")]
    pub kind: Option<String>,
    pub client_email: String,
    pub private_key: String,
    #[serde(default)]
    pub private_key_id: Option<String>,
    #[serde(default)]
    pub project_id: Option<String>,
    #[serde(default)]
    pub token_uri: Option<String>,
}

impl ServiceAccountKey {
    /// The token endpoint: the key file's `token_uri`, else Google's.
    pub fn token_uri(&self) -> &str {
        self.token_uri.as_deref().filter(|u| !u.is_empty()).unwrap_or(DEFAULT_TOKEN_URI)
    }
}

/// Read and check a service-account key file.
pub fn read_key(creds_file: &str) -> Result<ServiceAccountKey, GoogleAuthError> {
    let err = |reason: String| GoogleAuthError::KeyFile { path: creds_file.to_owned(), reason };
    if creds_file.is_empty() {
        return Err(err("no key file configured".into()));
    }
    let text = std::fs::read_to_string(creds_file).map_err(|e| err(e.to_string()))?;
    let key: ServiceAccountKey = serde_json::from_str(&text).map_err(|e| err(format!("not a service account key ({e})")))?;
    if key.kind.as_deref().is_some_and(|k| k != "service_account") {
        return Err(err(format!("type is {:?}, expected \"service_account\"", key.kind.as_deref().unwrap_or(""))));
    }
    Ok(key)
}

#[derive(Serialize)]
struct Claims<'a> {
    iss: &'a str,
    scope: String,
    aud: &'a str,
    iat: u64,
    exp: u64,
}

/// The signed JWT assertion (RS256) for `scopes`, issued at `iat` (Unix seconds).
pub fn assertion(key: &ServiceAccountKey, creds_file: &str, scopes: &[&str], iat: u64) -> Result<String, GoogleAuthError> {
    let sign_err = |reason: String| GoogleAuthError::Sign { path: creds_file.to_owned(), reason };
    let enc = jsonwebtoken::EncodingKey::from_rsa_pem(key.private_key.as_bytes()).map_err(|e| sign_err(e.to_string()))?;
    let mut header = jsonwebtoken::Header::new(jsonwebtoken::Algorithm::RS256);
    header.kid = key.private_key_id.clone();
    let claims = Claims { iss: &key.client_email, scope: scopes.join(" "), aud: key.token_uri(), iat, exp: iat + ASSERTION_LIFETIME_S };
    jsonwebtoken::encode(&header, &claims, &enc).map_err(|e| sign_err(e.to_string()))
}

struct Cached {
    token: String,
    renew_at: Instant,
}

fn cache() -> &'static Mutex<HashMap<(String, String), Cached>> {
    static CACHE: std::sync::OnceLock<Mutex<HashMap<(String, String), Cached>>> = std::sync::OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Drop every cached token (tests; a rotated key file is picked up at the next expiry anyway).
pub fn clear_cache() {
    cache().lock().unwrap_or_else(|p| p.into_inner()).clear();
}

/// A bearer access token for `scopes` from the service-account key file `creds_file`, cached in
/// this process until [`REFRESH_MARGIN_S`] before it expires.
pub async fn access_token(http: &reqwest::Client, creds_file: &str, scopes: &[&str]) -> Result<String, GoogleAuthError> {
    let ck = (creds_file.to_owned(), scopes.join(" "));
    if let Some(c) = cache().lock().unwrap_or_else(|p| p.into_inner()).get(&ck) {
        if Instant::now() < c.renew_at {
            return Ok(c.token.clone());
        }
    }
    let key = read_key(creds_file)?;
    let uri = key.token_uri().to_owned();
    let tok_err = |reason: String| GoogleAuthError::Token { uri: uri.clone(), reason };
    let now = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    let jwt = assertion(&key, creds_file, scopes, now)?;
    let resp = http
        .post(&uri)
        .form(&[("grant_type", "urn:ietf:params:oauth:grant-type:jwt-bearer"), ("assertion", jwt.as_str())])
        .send()
        .await
        .map_err(|e| tok_err(e.without_url().to_string()))?;
    let status = resp.status();
    let body: Value = resp.json().await.unwrap_or(Value::Null);
    if !status.is_success() {
        let why = body
            .get("error_description")
            .or_else(|| body.get("error"))
            .and_then(Value::as_str)
            .unwrap_or("no reason given");
        return Err(tok_err(format!("HTTP {}: {why}", status.as_u16())));
    }
    let token = body
        .get("access_token")
        .and_then(Value::as_str)
        .filter(|t| !t.is_empty())
        .ok_or_else(|| tok_err("answer has no access_token".into()))?
        .to_owned();
    let lifetime = body.get("expires_in").and_then(Value::as_u64).unwrap_or(ASSERTION_LIFETIME_S);
    let renew_at = Instant::now() + Duration::from_secs(lifetime.saturating_sub(REFRESH_MARGIN_S));
    cache().lock().unwrap_or_else(|p| p.into_inner()).insert(ck, Cached { token: token.clone(), renew_at });
    Ok(token)
}
