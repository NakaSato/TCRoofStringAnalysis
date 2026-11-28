//! Firebase Cloud Messaging HTTP v1 (`POST {base}/v1/projects/{project}/messages:send`), as
//! firebase_admin `messaging.send_each` sends for backend/app/services/push.py `firebase_sender`:
//! one request per message, data-only, web push headers `Urgency: high` and `TTL`, the service
//! account's OAuth token ([`crate::google_auth`]).
//!
//! Each message's outcome is what push.py makes of firebase_admin's answer: `None` = accepted,
//! [`GONE`] = the token is no longer registered (UNREGISTERED / SENDER_ID_MISMATCH), else the
//! name of the exception class firebase_admin raises (`InvalidArgumentError`, `UnavailableError`, …).
//! Retries as firebase_admin's `DEFAULT_RETRY_CONFIG`: HTTP 500 / 503 up to 4 times with
//! exponential backoff, a connection error once. Tokens are never logged.

use std::sync::Arc;
use std::time::Duration;

use serde_json::{json, Map, Value};

use crate::google_auth::{self, GoogleAuthError};

/// The real FCM endpoint (firebase_admin `_MessagingService.FCM_URL`)
pub const DEFAULT_BASE_URL: &str = "https://fcm.googleapis.com";
/// OAuth scope for sending
pub const SCOPE: &str = "https://www.googleapis.com/auth/firebase.messaging";
/// push.py `GONE`
pub const GONE: &str = "gone";
/// push.py `BATCH` (firebase_admin `send_each` limit)
pub const BATCH: usize = 500;
/// firebase_admin `_http_client.DEFAULT_TIMEOUT_SECONDS`
pub const TIMEOUT_S: u64 = 120;
/// at most this many requests in flight (firebase_admin uses one thread per message of a batch)
const CONCURRENCY: usize = 50;

/// One data-only message: the device token and its data (string values).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FcmMessage {
    pub token: String,
    pub data: Vec<(String, String)>,
}

#[derive(Debug, Clone)]
pub struct FcmClient {
    http: reqwest::Client,
    base_url: String,
    project_id: String,
    creds_file: String,
    ttl_s: u64,
}

/// A failure of the whole send (no message outcome): the OAuth token could not be had.
#[derive(Debug, thiserror::Error)]
#[error("{0}")]
pub struct FcmError(#[from] pub GoogleAuthError);

impl FcmClient {
    /// push.py `firebase_sender`: the key file is read and checked now (firebase_admin's
    /// `credentials.Certificate`), the project is `project_id` or else the key file's own.
    pub fn new(base_url: &str, project_id: &str, creds_file: &str, ttl_s: u64) -> Result<FcmClient, GoogleAuthError> {
        let key = google_auth::read_key(creds_file)?;
        let project = if project_id.is_empty() { key.project_id.unwrap_or_default() } else { project_id.to_owned() };
        if project.is_empty() {
            return Err(GoogleAuthError::Key(
                "Project ID is required to access Cloud Messaging service. Either set the projectId option, or use service account credentials.".into(),
            ));
        }
        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(TIMEOUT_S))
            .build()
            .map_err(|e| GoogleAuthError::Http(e.to_string()))?;
        Ok(FcmClient {
            http,
            base_url: base_url.trim_end_matches('/').to_owned(),
            project_id: project,
            creds_file: creds_file.to_owned(),
            ttl_s,
        })
    }

    pub fn url(&self) -> String {
        format!("{}/v1/projects/{}/messages:send", self.base_url, self.project_id)
    }

    /// The request body firebase_admin encodes for `Message(token, data, webpush=WebpushConfig(headers))`.
    pub fn body(&self, m: &FcmMessage) -> Value {
        let data: Map<String, Value> = m.data.iter().map(|(k, v)| (k.clone(), Value::String(v.clone()))).collect();
        json!({"message": {
            "data": data,
            "token": m.token,
            "webpush": {"headers": {"Urgency": "high", "TTL": self.ttl_s.to_string()}},
        }})
    }

    /// firebase_admin `send_each` in batches of [`BATCH`]: one outcome per message, in order.
    pub async fn send_each(&self, msgs: &[FcmMessage]) -> Result<Vec<Option<String>>, FcmError> {
        let mut out = Vec::with_capacity(msgs.len());
        for chunk in msgs.chunks(BATCH) {
            // one token for the batch (google-auth refreshes before the first request)
            let token = Arc::new(google_auth::access_token(&self.http, &self.creds_file, &[SCOPE]).await?);
            let url = Arc::new(self.url());
            let mut results: Vec<Option<Option<String>>> = vec![None; chunk.len()];
            for (start, part) in chunk.chunks(CONCURRENCY).enumerate().map(|(i, p)| (i * CONCURRENCY, p)) {
                let mut set = tokio::task::JoinSet::new();
                for (j, m) in part.iter().enumerate() {
                    let (http, url, token, body) = (self.http.clone(), url.clone(), token.clone(), self.body(m));
                    set.spawn(async move { (start + j, send_one(&http, &url, &token, &body).await) });
                }
                while let Some(r) = set.join_next().await {
                    // a panicked task is left as UnknownError below
                    if let Ok((i, outcome)) = r {
                        results[i] = Some(outcome);
                    }
                }
            }
            out.extend(results.into_iter().map(|r| r.unwrap_or_else(|| Some("UnknownError".into()))));
        }
        Ok(out)
    }
}

/// urllib3 `Retry.get_backoff_time` with `backoff_factor=0.5`: no wait before the first retry,
/// then 1, 2, 4 s
fn backoff(retry_no: u32) -> Duration {
    if retry_no <= 1 {
        Duration::ZERO
    } else {
        Duration::from_millis(500 * (1u64 << (retry_no - 1)))
    }
}

const STATUS_RETRIES: u32 = 4;
const CONNECT_RETRIES: u32 = 1;

async fn send_one(http: &reqwest::Client, url: &str, token: &str, body: &Value) -> Option<String> {
    let (mut status_retries, mut connect_retries) = (0u32, 0u32);
    loop {
        let r = http
            .post(url)
            .bearer_auth(token)
            .header("X-GOOG-API-FORMAT-VERSION", "2")
            .header("X-FIREBASE-CLIENT", "fire-admin-rust")
            .json(body)
            .send()
            .await;
        match r {
            Err(e) if e.is_connect() && connect_retries < CONNECT_RETRIES => {
                connect_retries += 1;
            }
            Err(e) => return Some(transport_error(&e).into()),
            Ok(resp) => {
                let status = resp.status().as_u16();
                if (status == 500 || status == 503) && status_retries < STATUS_RETRIES {
                    status_retries += 1;
                    tokio::time::sleep(backoff(status_retries)).await;
                    continue;
                }
                if (200..300).contains(&status) {
                    return None;
                }
                let text = resp.text().await.unwrap_or_default();
                return Some(error_name(status, &text).into());
            }
        }
    }
}

/// firebase_admin `_utils.handle_requests_error` for an error without a response
fn transport_error(e: &reqwest::Error) -> &'static str {
    if e.is_timeout() {
        "DeadlineExceededError"
    } else if e.is_connect() {
        "UnavailableError"
    } else {
        "UnknownError"
    }
}

/// The outcome of an HTTP error answer: firebase_admin `_MessagingService._build_fcm_error`
/// (FCM's own error code), else `_utils._handle_func_requests` (the error's `status`, else the
/// HTTP status), as push.py records it: GONE or the exception class name.
pub fn error_name(status: u16, body: &str) -> &'static str {
    let err = serde_json::from_str::<Value>(body).ok().and_then(|v| v.get("error").cloned()).filter(|e| e.is_object());
    if let Some(e) = &err {
        let fcm_code = e.get("details").and_then(Value::as_array).and_then(|ds| {
            ds.iter()
                .find(|d| d.get("@type").and_then(Value::as_str) == Some("type.googleapis.com/google.firebase.fcm.v1.FcmError"))
                .and_then(|d| d.get("errorCode").and_then(Value::as_str))
        });
        match fcm_code {
            Some("UNREGISTERED") | Some("SENDER_ID_MISMATCH") => return GONE,
            Some("APNS_AUTH_ERROR") | Some("THIRD_PARTY_AUTH_ERROR") => return "ThirdPartyAuthError",
            Some("QUOTA_EXCEEDED") => return "QuotaExceededError",
            _ => {}
        }
    }
    let code = err.as_ref().and_then(|e| e.get("status")).and_then(Value::as_str).filter(|s| !s.is_empty());
    let code = match code {
        Some(c) => c,
        None => match status {
            400 => "INVALID_ARGUMENT",
            401 => "UNAUTHENTICATED",
            403 => "PERMISSION_DENIED",
            404 => "NOT_FOUND",
            409 => "CONFLICT",
            412 => "FAILED_PRECONDITION",
            429 => "RESOURCE_EXHAUSTED",
            500 => "INTERNAL",
            503 => "UNAVAILABLE",
            _ => "UNKNOWN",
        },
    };
    match code {
        "INVALID_ARGUMENT" => "InvalidArgumentError",
        "FAILED_PRECONDITION" => "FailedPreconditionError",
        "OUT_OF_RANGE" => "OutOfRangeError",
        "UNAUTHENTICATED" => "UnauthenticatedError",
        "PERMISSION_DENIED" => "PermissionDeniedError",
        "NOT_FOUND" => "NotFoundError",
        "ABORTED" => "AbortedError",
        "ALREADY_EXISTS" => "AlreadyExistsError",
        "CONFLICT" => "ConflictError",
        "RESOURCE_EXHAUSTED" => "ResourceExhaustedError",
        "CANCELLED" => "CancelledError",
        "DATA_LOSS" => "DataLossError",
        "INTERNAL" => "InternalError",
        "UNAVAILABLE" => "UnavailableError",
        "DEADLINE_EXCEEDED" => "DeadlineExceededError",
        _ => "UnknownError",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fcm(code: &str, status: &str) -> String {
        json!({"error": {"code": 404, "status": status, "message": "x",
            "details": [{"@type": "type.googleapis.com/google.firebase.fcm.v1.FcmError", "errorCode": code}]}})
        .to_string()
    }

    #[test]
    fn error_names_like_firebase_admin() {
        assert_eq!(error_name(404, &fcm("UNREGISTERED", "NOT_FOUND")), GONE);
        assert_eq!(error_name(403, &fcm("SENDER_ID_MISMATCH", "PERMISSION_DENIED")), GONE);
        assert_eq!(error_name(429, &fcm("QUOTA_EXCEEDED", "RESOURCE_EXHAUSTED")), "QuotaExceededError");
        assert_eq!(error_name(400, &fcm("INVALID_ARGUMENT", "INVALID_ARGUMENT")), "InvalidArgumentError");
        assert_eq!(error_name(400, "not json"), "InvalidArgumentError");
        assert_eq!(error_name(502, ""), "UnknownError");
        assert_eq!(error_name(500, r#"{"error": {"status": "UNAVAILABLE"}}"#), "UnavailableError");
    }

    #[test]
    fn backoff_like_urllib3() {
        let s: Vec<u128> = (1..=4).map(|n| backoff(n).as_millis()).collect();
        assert_eq!(s, [0, 1000, 2000, 4000]);
    }
}
