//! OAuth 2.0 access tokens for a Google service account (the JWT-bearer grant), as google-auth's
//! `service_account.Credentials.refresh` does for the Python backend (firebase_admin, Firestore).
//!
//! The key file is the service-account JSON (`FIREBASE_CREDENTIALS_FILE`); the token is asked from
//! the file's own `token_uri`, so a test key file can point it at a local stub. Tokens are cached
//! per (key file, scopes) until [`REFRESH_MARGIN_S`] before they expire. Neither the key nor a
//! token is ever logged.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

/// google-auth refreshes a token this close to its expiry (`_helpers.REFRESH_THRESHOLD`, 3 min
/// 45 s); a little earlier here
pub const REFRESH_MARGIN_S: u64 = 300;
/// lifetime asked for in the assertion (google-auth `_DEFAULT_TOKEN_LIFETIME_SECS`)
const ASSERTION_LIFETIME_S: u64 = 3600;
const GRANT_TYPE: &str = "urn:ietf:params:oauth:grant-type:jwt-bearer";

#[derive(Debug, thiserror::Error)]
pub enum GoogleAuthError {
    #[error("cannot read the service-account key file {path}: {source}")]
    Read { path: String, source: std::io::Error },
    #[error("not a service-account key file ({0})")]
    Key(String),
    #[error("token request failed: {0}")]
    Http(String),
    #[error("token request refused ({status}): {body}")]
    Refused { status: u16, body: String },
}

impl GoogleAuthError {
    /// The Python exception class the same failure raises (FileNotFoundError for a missing key
    /// file, ValueError for a bad one, google-auth's RefreshError for the token request).
    pub fn py_kind(&self) -> &'static str {
        match self {
            GoogleAuthError::Read { source, .. } if source.kind() == std::io::ErrorKind::NotFound => "FileNotFoundError",
            GoogleAuthError::Read { .. } => "OSError",
            GoogleAuthError::Key(_) => "ValueError",
            GoogleAuthError::Http(_) | GoogleAuthError::Refused { .. } => "RefreshError",
        }
    }
}

/// The fields of a service-account key file this module uses.
#[derive(Debug, Clone, Deserialize)]
pub struct ServiceAccountKey {
    #[serde(rename = "type", default)]
    pub kind: String,
    #[serde(default)]
    pub project_id: Option<String>,
    #[serde(default)]
    pub private_key_id: Option<String>,
    pub private_key: String,
    pub client_email: String,
    pub token_uri: String,
}

/// Read and check a key file (firebase_admin `credentials.Certificate`: `type` must be
/// `service_account`, and the private key must parse).
pub fn read_key(creds_file: &str) -> Result<ServiceAccountKey, GoogleAuthError> {
    let raw = std::fs::read_to_string(creds_file).map_err(|source| GoogleAuthError::Read { path: creds_file.to_owned(), source })?;
    let key: ServiceAccountKey = serde_json::from_str(&raw).map_err(|e| GoogleAuthError::Key(e.to_string()))?;
    if key.kind != "service_account" {
        return Err(GoogleAuthError::Key(format!(
            "Invalid service account certificate. Certificate must contain a \"type\" field set to \"service_account\"; got {:?}",
            key.kind
        )));
    }
    jsonwebtoken::EncodingKey::from_rsa_pem(key.private_key.as_bytes()).map_err(|e| GoogleAuthError::Key(format!("private_key: {e}")))?;
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

#[derive(Deserialize)]
struct TokenResponse {
    access_token: String,
    #[serde(default)]
    expires_in: Option<u64>,
}

type CacheKey = (String, String);

fn cache() -> &'static Mutex<HashMap<CacheKey, (String, Instant)>> {
    static CACHE: OnceLock<Mutex<HashMap<CacheKey, (String, Instant)>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// An access token for the service account in `creds_file` with `scopes`, from the cache while it
/// has more than [`REFRESH_MARGIN_S`] left, else from the key file's `token_uri`.
pub async fn access_token(http: &reqwest::Client, creds_file: &str, scopes: &[&str]) -> Result<String, GoogleAuthError> {
    let scope = scopes.join(" ");
    let ck = (creds_file.to_owned(), scope.clone());
    if let Some((tok, until)) = cache().lock().expect("token cache").get(&ck) {
        if Instant::now() + Duration::from_secs(REFRESH_MARGIN_S) < *until {
            return Ok(tok.clone());
        }
    }
    let key = read_key(creds_file)?;
    let iat = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    let claims = Claims { iss: &key.client_email, scope, aud: &key.token_uri, iat, exp: iat + ASSERTION_LIFETIME_S };
    let mut header = jsonwebtoken::Header::new(jsonwebtoken::Algorithm::RS256);
    header.kid = key.private_key_id.clone().filter(|k| !k.is_empty());
    let enc = jsonwebtoken::EncodingKey::from_rsa_pem(key.private_key.as_bytes()).map_err(|e| GoogleAuthError::Key(format!("private_key: {e}")))?;
    let assertion = jsonwebtoken::encode(&header, &claims, &enc).map_err(|e| GoogleAuthError::Key(e.to_string()))?;
    let asked = Instant::now();
    let resp = http
        .post(&key.token_uri)
        .form(&[("grant_type", GRANT_TYPE), ("assertion", assertion.as_str())])
        .send()
        .await
        .map_err(|e| GoogleAuthError::Http(e.to_string()))?;
    let status = resp.status();
    let body = resp.text().await.map_err(|e| GoogleAuthError::Http(e.to_string()))?;
    if !status.is_success() {
        return Err(GoogleAuthError::Refused { status: status.as_u16(), body: body.chars().take(500).collect() });
    }
    let t: TokenResponse = serde_json::from_str(&body).map_err(|e| GoogleAuthError::Http(format!("not a token answer: {e}")))?;
    let until = asked + Duration::from_secs(t.expires_in.unwrap_or(ASSERTION_LIFETIME_S));
    cache().lock().expect("token cache").insert(ck, (t.access_token.clone(), until));
    Ok(t.access_token)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_missing_key_file_is_file_not_found() {
        let e = read_key("/nonexistent/key.json").unwrap_err();
        assert_eq!(e.py_kind(), "FileNotFoundError");
    }

    #[test]
    fn a_key_file_of_another_type_is_refused() {
        let dir = std::env::temp_dir().join(format!("google-auth-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("k.json");
        std::fs::write(&p, r#"{"type":"authorized_user","private_key":"x","client_email":"a@b","token_uri":"http://127.0.0.1:9/token"}"#).unwrap();
        let e = read_key(p.to_str().unwrap()).unwrap_err();
        assert_eq!(e.py_kind(), "ValueError");
        std::fs::remove_dir_all(&dir).ok();
    }
}
