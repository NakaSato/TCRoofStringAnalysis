//! Firestore reads over the REST API (v1), for what Python reads with the Admin SDK in
//! backend/app/services/pwa_report.py `firestore_day_docs`: one document with a field mask and the
//! documents of one collection with a field mask, decoded from Firestore's typed values into plain
//! JSON (`integerValue` → integer, `doubleValue` → float, maps and arrays nested).
//!
//! Authentication: a bearer token from the service-account key file (`FIREBASE_CREDENTIALS_FILE`,
//! scope `datastore`). With `FIRESTORE_EMULATOR_HOST` set (the variable Google's SDKs honour), the
//! reads go to `http://<host>/v1/` with the emulator's `Bearer owner` instead. Nothing is written.

use serde_json::{Map, Value};

use crate::google_auth::{access_token, GoogleAuthError};

/// The Firestore REST root
pub const DEFAULT_BASE: &str = "https://firestore.googleapis.com/v1/";
const SCOPES: [&str; 1] = ["https://www.googleapis.com/auth/datastore"];
const PAGE_SIZE: &str = "300";

/// A failed read; `kind` = the Python exception class it stands for.
#[derive(Debug, Clone, thiserror::Error)]
#[error("{message}")]
pub struct FirestoreError {
    pub kind: String,
    pub message: String,
}

impl FirestoreError {
    fn new(kind: &str, message: impl Into<String>) -> Self {
        FirestoreError { kind: kind.into(), message: message.into() }
    }
}

impl From<GoogleAuthError> for FirestoreError {
    fn from(e: GoogleAuthError) -> Self {
        FirestoreError::new(e.py_kind(), e.to_string())
    }
}

enum Auth {
    Emulator,
    KeyFile(String),
}

/// Reads documents of one project's `(default)` database.
pub struct FirestoreReader {
    http: reqwest::Client,
    root: String,
    auth: Auth,
}

/// Decode one Firestore `Value` into plain JSON.
pub fn decode(v: &Value) -> Value {
    let Some(o) = v.as_object() else { return Value::Null };
    if let Some(s) = o.get("integerValue") {
        let n = s.as_str().and_then(|s| s.parse::<i64>().ok()).or_else(|| s.as_i64());
        return n.map(Value::from).unwrap_or(Value::Null);
    }
    if let Some(d) = o.get("doubleValue") {
        let x = d.as_f64().or_else(|| d.as_str().and_then(|s| s.parse::<f64>().ok()));
        return x.map(Value::from).unwrap_or(Value::Null);
    }
    if let Some(b) = o.get("booleanValue") {
        return b.clone();
    }
    for k in ["stringValue", "timestampValue", "referenceValue", "bytesValue"] {
        if let Some(s) = o.get(k) {
            return s.clone();
        }
    }
    if let Some(m) = o.get("mapValue") {
        return Value::Object(decode_fields(m.get("fields")));
    }
    if let Some(a) = o.get("arrayValue") {
        let vals = a.get("values").and_then(Value::as_array).map(|xs| xs.iter().map(decode).collect()).unwrap_or_default();
        return Value::Array(vals);
    }
    if let Some(g) = o.get("geoPointValue") {
        return g.clone();
    }
    Value::Null
}

/// Decode a document's `fields`.
pub fn decode_fields(fields: Option<&Value>) -> Map<String, Value> {
    fields.and_then(Value::as_object).map(|f| f.iter().map(|(k, v)| (k.clone(), decode(v))).collect()).unwrap_or_default()
}

impl FirestoreReader {
    /// `project`: FIREBASE_PROJECT_ID, else the key file's `project_id`. `emulator_host`:
    /// FIRESTORE_EMULATOR_HOST (empty = the real service with the key file).
    pub fn new(project: &str, creds_file: &str, emulator_host: &str) -> Result<Self, FirestoreError> {
        let (base, auth) = if !emulator_host.is_empty() {
            (format!("http://{}/v1/", emulator_host.trim_end_matches('/')), Auth::Emulator)
        } else if !creds_file.is_empty() {
            (DEFAULT_BASE.to_owned(), Auth::KeyFile(creds_file.to_owned()))
        } else {
            return Err(FirestoreError::new(
                "DefaultCredentialsError",
                "No FIREBASE_CREDENTIALS_FILE; application default credentials are not supported by the Rust worker",
            ));
        };
        let mut project = project.to_owned();
        if project.is_empty() {
            if let Auth::KeyFile(p) = &auth {
                project = std::fs::read_to_string(p)
                    .ok()
                    .and_then(|t| serde_json::from_str::<Value>(&t).ok())
                    .and_then(|v| v.get("project_id").and_then(Value::as_str).map(str::to_owned))
                    .unwrap_or_default();
            }
        }
        if project.is_empty() {
            return Err(FirestoreError::new("ValueError", "No Firestore project id (FIREBASE_PROJECT_ID or the key file's project_id)"));
        }
        Ok(FirestoreReader {
            http: reqwest::Client::builder().timeout(std::time::Duration::from_secs(60)).build().unwrap_or_else(|_| reqwest::Client::new()),
            root: format!("{base}projects/{project}/databases/(default)/documents/"),
            auth,
        })
    }

    async fn get(&self, url: &str, query: &[(&str, &str)]) -> Result<Option<Value>, FirestoreError> {
        let token = match &self.auth {
            Auth::Emulator => "owner".to_owned(),
            Auth::KeyFile(p) => access_token(&self.http, p, &SCOPES).await?,
        };
        let resp = self
            .http
            .get(url)
            .bearer_auth(token)
            .query(query)
            .send()
            .await
            .map_err(|e| FirestoreError::new("ServiceUnavailable", format!("Firestore read failed: {e}")))?;
        let status = resp.status();
        if status.as_u16() == 404 {
            return Ok(None);
        }
        let body: Value = resp.json().await.unwrap_or(Value::Null);
        if !status.is_success() {
            let msg = body.pointer("/error/message").and_then(Value::as_str).unwrap_or("").to_owned();
            let kind = match status.as_u16() {
                401 => "Unauthenticated",
                403 => "PermissionDenied",
                429 => "TooManyRequests",
                _ => "GoogleAPICallError",
            };
            return Err(FirestoreError::new(kind, format!("{} {msg}", status.as_u16())));
        }
        Ok(Some(body))
    }

    /// One document (`path` like `daily/2026-11-28`) with only `mask` fields; None = it does not exist.
    pub async fn get_doc(&self, path: &str, mask: &[&str]) -> Result<Option<Map<String, Value>>, FirestoreError> {
        let q: Vec<(&str, &str)> = mask.iter().map(|m| ("mask.fieldPaths", *m)).collect();
        let doc = self.get(&format!("{}{path}", self.root), &q).await?;
        Ok(doc.map(|d| decode_fields(d.get("fields"))))
    }

    /// Every document of a collection (`daily/2026-11-28/plants`) as (id, fields), with only
    /// `mask` fields, in Firestore's order (by document id).
    pub async fn list_docs(&self, collection: &str, mask: &[&str]) -> Result<Vec<(String, Map<String, Value>)>, FirestoreError> {
        let url = format!("{}{collection}", self.root);
        let mut out = Vec::new();
        let mut token: Option<String> = None;
        loop {
            let mut q: Vec<(&str, &str)> = mask.iter().map(|m| ("mask.fieldPaths", *m)).collect();
            q.push(("pageSize", PAGE_SIZE));
            if let Some(t) = &token {
                q.push(("pageToken", t));
            }
            let Some(body) = self.get(&url, &q).await? else { break };
            for d in body.get("documents").and_then(Value::as_array).into_iter().flatten() {
                let name = d.get("name").and_then(Value::as_str).unwrap_or("");
                let id = name.rsplit('/').next().unwrap_or("").to_owned();
                out.push((id, decode_fields(d.get("fields"))));
            }
            match body.get("nextPageToken").and_then(Value::as_str).filter(|t| !t.is_empty()) {
                Some(t) => token = Some(t.to_owned()),
                None => break,
            }
        }
        Ok(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn typed_values_decode_to_plain_json() {
        let v = json!({"mapValue": {"fields": {
            "n": {"integerValue": "12"}, "x": {"doubleValue": 1.5}, "s": {"stringValue": "ok"},
            "z": {"nullValue": null}, "b": {"booleanValue": true},
            "a": {"arrayValue": {"values": [{"integerValue": "1"}, {"stringValue": "INV1"}]}},
            "e": {"arrayValue": {}}
        }}});
        assert_eq!(decode(&v), json!({"n": 12, "x": 1.5, "s": "ok", "z": null, "b": true, "a": [1, "INV1"], "e": []}));
    }
}
