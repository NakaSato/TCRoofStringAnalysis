//! Firestore REST client for the summary sink (Python `daily_summary.FirestoreSink`, which writes
//! through the Admin SDK: `client.batch()`, `batch.set(document(path), doc)`, `batch.commit()`).
//!
//! `documents:commit` with one `update` write per document and no field mask, i.e. a full
//! overwrite as `batch.set` does; values are encoded as the Python client's `encode_value` does
//! (`None` → nullValue, bool, int → integerValue (a string), float → doubleValue, str, dict →
//! mapValue, list → arrayValue). Authorised with a service-account access token
//! ([`crate::google_auth`], scope `datastore`), or, with `FIRESTORE_EMULATOR_HOST` set (as the
//! Python SDK honours it), sent to `http://<host>/v1/` with the emulator's `Bearer owner`.

use serde_json::{json, Map, Value};

use crate::google_auth::{self, GoogleAuthError};

pub const DEFAULT_BASE_URL: &str = "https://firestore.googleapis.com/v1/";
/// The scope the Admin SDK asks for Firestore
pub const SCOPES: [&str; 2] = ["https://www.googleapis.com/auth/cloud-platform", "https://www.googleapis.com/auth/datastore"];
pub const DEFAULT_TIMEOUT_S: f64 = 60.0;

#[derive(Debug, thiserror::Error)]
pub enum FirestoreError {
    #[error(transparent)]
    Auth(#[from] GoogleAuthError),
    #[error("Firestore commit failed: {0}")]
    Commit(String),
    #[error("{0}")]
    Config(String),
}

/// How requests are authorised.
#[derive(Debug, Clone)]
pub enum FirestoreAuth {
    /// A service-account key file (`FIREBASE_CREDENTIALS_FILE`)
    ServiceAccount(String),
    /// The emulator (or a local stub): `Authorization: Bearer owner`
    Emulator,
}

#[derive(Debug, Clone)]
pub struct FirestoreClient {
    http: reqwest::Client,
    base: String,
    project: String,
    auth: FirestoreAuth,
}

/// Python `google.cloud.firestore_v1._helpers.encode_value`
pub fn encode_value(v: &Value) -> Value {
    match v {
        Value::Null => json!({"nullValue": null}),
        Value::Bool(b) => json!({"booleanValue": b}),
        Value::Number(n) if n.is_i64() || n.is_u64() => json!({"integerValue": n.to_string()}),
        Value::Number(n) => json!({"doubleValue": n.as_f64()}),
        Value::String(s) => json!({"stringValue": s}),
        Value::Array(a) => json!({"arrayValue": {"values": a.iter().map(encode_value).collect::<Vec<_>>()}}),
        Value::Object(m) => json!({"mapValue": {"fields": encode_fields(m)}}),
    }
}

/// A document's `fields`
pub fn encode_fields(m: &Map<String, Value>) -> Map<String, Value> {
    m.iter().map(|(k, v)| (k.clone(), encode_value(v))).collect()
}

impl FirestoreClient {
    /// `base_url` = `https://firestore.googleapis.com/v1/` (or a stub's); `project` = the
    /// Firebase project id.
    pub fn new(base_url: &str, project: &str, auth: FirestoreAuth, timeout_s: f64) -> Result<FirestoreClient, FirestoreError> {
        if project.is_empty() {
            return Err(FirestoreError::Config("no Firebase project id (FIREBASE_PROJECT_ID or the key file's project_id)".into()));
        }
        let http = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs_f64(timeout_s))
            .build()
            .map_err(|e| FirestoreError::Config(e.to_string()))?;
        Ok(FirestoreClient { http, base: format!("{}/", base_url.trim_end_matches('/')), project: project.to_owned(), auth })
    }

    /// The client the Admin SDK would build: the emulator when `FIRESTORE_EMULATOR_HOST` is set,
    /// else Google's endpoint with the key file's token. `project_id` empty = the key file's.
    pub fn from_settings(credentials_file: &str, project_id: &str) -> Result<FirestoreClient, FirestoreError> {
        if credentials_file.is_empty() {
            return Err(FirestoreError::Config("Set FIREBASE_CREDENTIALS_FILE in .env to publish to Firestore.".into()));
        }
        let key = google_auth::read_key(credentials_file)?;
        let project = if project_id.is_empty() { key.project_id.clone().unwrap_or_default() } else { project_id.to_owned() };
        match std::env::var("FIRESTORE_EMULATOR_HOST").ok().filter(|h| !h.trim().is_empty()) {
            Some(host) => Self::new(&format!("http://{}/v1/", host.trim()), &project, FirestoreAuth::Emulator, DEFAULT_TIMEOUT_S),
            None => Self::new(DEFAULT_BASE_URL, &project, FirestoreAuth::ServiceAccount(credentials_file.to_owned()), DEFAULT_TIMEOUT_S),
        }
    }

    fn database(&self) -> String {
        format!("projects/{}/databases/(default)", self.project)
    }

    /// One `documents:commit`: every `(path, doc)` overwritten (Python `batch.set` + `commit`).
    /// The caller keeps a batch within Firestore's 500 writes.
    pub async fn commit_set(&self, docs: &[(String, Value)]) -> Result<(), FirestoreError> {
        let db = self.database();
        let writes: Vec<Value> = docs
            .iter()
            .map(|(path, doc)| {
                let fields = doc.as_object().map(encode_fields).unwrap_or_default();
                json!({"update": {"name": format!("{db}/documents/{path}"), "fields": fields}})
            })
            .collect();
        let token = match &self.auth {
            FirestoreAuth::Emulator => "owner".to_owned(),
            FirestoreAuth::ServiceAccount(file) => google_auth::access_token(&self.http, file, &SCOPES).await?,
        };
        let resp = self
            .http
            .post(format!("{}{db}/documents:commit", self.base))
            .bearer_auth(token)
            .json(&json!({"writes": writes}))
            .send()
            .await
            .map_err(|e| FirestoreError::Commit(e.without_url().to_string()))?;
        let status = resp.status();
        if !status.is_success() {
            let body: Value = resp.json().await.unwrap_or(Value::Null);
            let msg = body.pointer("/error/message").and_then(Value::as_str).unwrap_or("no message");
            return Err(FirestoreError::Commit(format!("HTTP {}: {msg}", status.as_u16())));
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn values_encode_like_the_python_client() {
        let v = json!({"a": null, "b": true, "c": 3, "d": 2.5, "e": "ไทย", "f": [1, {"g": 0.0}], "h": {}, "i": []});
        let f = encode_fields(v.as_object().unwrap());
        assert_eq!(f["a"], json!({"nullValue": null}));
        assert_eq!(f["b"], json!({"booleanValue": true}));
        assert_eq!(f["c"], json!({"integerValue": "3"}));
        assert_eq!(f["d"], json!({"doubleValue": 2.5}));
        assert_eq!(f["e"], json!({"stringValue": "ไทย"}));
        assert_eq!(
            f["f"],
            json!({"arrayValue": {"values": [{"integerValue": "1"}, {"mapValue": {"fields": {"g": {"doubleValue": 0.0}}}}]}})
        );
        assert_eq!(f["h"], json!({"mapValue": {"fields": {}}}));
        assert_eq!(f["i"], json!({"arrayValue": {"values": []}}));
    }

    #[test]
    fn needs_a_project() {
        assert!(FirestoreClient::new(DEFAULT_BASE_URL, "", FirestoreAuth::Emulator, 5.0).is_err());
    }
}
