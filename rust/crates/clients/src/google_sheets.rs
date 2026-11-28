//! Minimal Google Sheets API v4 client (service account), port of
//! backend/app/services/pwa_sheet.py `SheetsClient` and `_a1`.
//!
//! The access token comes from [`crate::google_auth::access_token`] with the key file the caller
//! names (Python: `PWA_SHEET_CREDENTIALS_FILE`, else `FIREBASE_CREDENTIALS_FILE`). Python's fallback
//! to Application Default Credentials without a key file is not ported: that is an error here.

use serde_json::{json, Value};

use crate::google_auth::{access_token, GoogleAuthError};

/// Python `pwa_sheet.API`
pub const DEFAULT_API: &str = "https://sheets.googleapis.com/v4/spreadsheets";
/// Python `pwa_sheet.SCOPES`
pub const SCOPES: [&str; 1] = ["https://www.googleapis.com/auth/spreadsheets"];
/// Python `self.session.request(..., timeout=60)`
const TIMEOUT_S: u64 = 60;

/// A failed Sheets call, as the Python exception it stands for: `kind` = class name
/// (`PermissionError`, `HTTPError`, `ConnectionError`, `RefreshError`, `ValueError`).
#[derive(Debug, Clone, thiserror::Error)]
#[error("{message}")]
pub struct SheetsError {
    pub kind: String,
    pub message: String,
}

impl SheetsError {
    pub fn new(kind: &str, message: impl Into<String>) -> Self {
        SheetsError { kind: kind.into(), message: message.into() }
    }
}

impl From<GoogleAuthError> for SheetsError {
    fn from(e: GoogleAuthError) -> Self {
        SheetsError::new(e.kind(), e.to_string())
    }
}

/// Python `urllib.parse.quote(s, safe='')`: every byte but `A-Za-z0-9_.-~` as `%XX`.
pub fn quote(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'_' | b'.' | b'-' | b'~') {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

/// Python `_a1`: `'Title'!A1:B2` (a `'` in the title doubled).
pub fn a1(title: &str, rng: &str) -> String {
    let t = format!("'{}'", title.replace('\'', "''"));
    if rng.is_empty() {
        t
    } else {
        format!("{t}!{rng}")
    }
}

/// One tab's properties (`sheets.properties(sheetId,title,index)`).
#[derive(Debug, Clone, PartialEq)]
pub struct Tab {
    pub sheet_id: i64,
    pub title: String,
    pub index: i64,
}

/// Python `SheetsClient`.
pub struct SheetsClient {
    id: String,
    api: String,
    creds_file: String,
    http: reqwest::Client,
}

impl SheetsClient {
    /// `api` = the API root (Python's fixed `API`; empty = [`DEFAULT_API`]).
    pub fn new(spreadsheet_id: &str, api: &str, creds_file: &str) -> Self {
        let api = if api.is_empty() { DEFAULT_API } else { api };
        SheetsClient {
            id: spreadsheet_id.to_owned(),
            api: api.trim_end_matches('/').to_owned(),
            creds_file: creds_file.to_owned(),
            http: reqwest::Client::builder()
                .timeout(std::time::Duration::from_secs(TIMEOUT_S))
                .build()
                .unwrap_or_else(|_| reqwest::Client::new()),
        }
    }

    /// Python `_call`: 403 / 404 = PermissionError (share the sheet / enable the API), any other
    /// non-2xx = `raise_for_status`'s HTTPError; the JSON body, `{}` when empty.
    async fn call(&self, method: reqwest::Method, path: &str, query: &[(&str, &str)], body: Option<Value>) -> Result<Value, SheetsError> {
        if self.creds_file.is_empty() {
            return Err(SheetsError::new(
                "DefaultCredentialsError",
                "No service-account key file (PWA_SHEET_CREDENTIALS_FILE / FIREBASE_CREDENTIALS_FILE); application default credentials are not supported by the Rust worker",
            ));
        }
        let token = access_token(&self.http, &self.creds_file, &SCOPES).await?;
        let url = format!("{}/{}{path}", self.api, self.id);
        let mut req = self.http.request(method, &url).bearer_auth(token).query(query);
        if let Some(b) = body {
            req = req.json(&b);
        }
        let resp = req
            .send()
            .await
            .map_err(|e| SheetsError::new(crate::google_weather::requests_exc_name(&e), format!("Sheets API request failed: {e}")))?;
        let status = resp.status();
        let full_url = resp.url().to_string();
        let bytes = resp.bytes().await.map_err(|e| SheetsError::new("ConnectionError", e.to_string()))?;
        let text = String::from_utf8_lossy(&bytes);
        if status.as_u16() == 403 || status.as_u16() == 404 {
            let head: String = text.chars().take(300).collect();
            return Err(SheetsError::new(
                "PermissionError",
                format!(
                    "Sheets API {}: share the sheet with the service account as Editor and enable sheets.googleapis.com ({head})",
                    status.as_u16()
                ),
            ));
        }
        if status.is_client_error() || status.is_server_error() {
            let side = if status.is_client_error() { "Client" } else { "Server" };
            let reason = status.canonical_reason().unwrap_or("");
            return Err(SheetsError::new("HTTPError", format!("{} {side} Error: {reason} for url: {full_url}", status.as_u16())));
        }
        if bytes.is_empty() {
            return Ok(json!({}));
        }
        serde_json::from_slice(&bytes).map_err(|e| SheetsError::new("JSONDecodeError", e.to_string()))
    }

    /// Python `sheets`: the tabs in tab order.
    pub async fn sheets(&self) -> Result<Vec<Tab>, SheetsError> {
        let meta = self.call(reqwest::Method::GET, "", &[("fields", "sheets.properties(sheetId,title,index)")], None).await?;
        let mut tabs: Vec<Tab> = meta
            .get("sheets")
            .and_then(Value::as_array)
            .map(|a| {
                a.iter()
                    .filter_map(|s| s.get("properties"))
                    .map(|p| Tab {
                        sheet_id: p.get("sheetId").and_then(Value::as_i64).unwrap_or(0),
                        title: p.get("title").and_then(Value::as_str).unwrap_or("").to_owned(),
                        index: p.get("index").and_then(Value::as_i64).unwrap_or(0),
                    })
                    .collect()
            })
            .unwrap_or_default();
        tabs.sort_by_key(|t| t.index); // stable, as Python's sorted
        Ok(tabs)
    }

    /// Python `values`: the tab's cells, unformatted (numbers stay numbers).
    pub async fn values(&self, title: &str) -> Result<Vec<Vec<Value>>, SheetsError> {
        let path = format!("/values/{}", quote(&a1(title, "")));
        let res = self.call(reqwest::Method::GET, &path, &[("valueRenderOption", "UNFORMATTED_VALUE")], None).await?;
        Ok(res
            .get("values")
            .and_then(Value::as_array)
            .map(|rows| rows.iter().map(|r| r.as_array().cloned().unwrap_or_default()).collect())
            .unwrap_or_default())
    }

    /// Python `duplicate`
    pub async fn duplicate(&self, source_id: i64, title: &str, index: i64) -> Result<(), SheetsError> {
        let body = json!({"requests": [{"duplicateSheet": {"sourceSheetId": source_id, "insertSheetIndex": index, "newSheetName": title}}]});
        self.call(reqwest::Method::POST, ":batchUpdate", &[], Some(body)).await.map(|_| ())
    }

    /// Python `clear`
    pub async fn clear(&self, rng: &str) -> Result<(), SheetsError> {
        let path = format!("/values/{}:clear", quote(rng));
        self.call(reqwest::Method::POST, &path, &[], Some(json!({}))).await.map(|_| ())
    }

    /// Python `write_cells`: one call, each (A1 cell, value); only these cells are touched.
    pub async fn write_cells(&self, cells: &[(String, Value)]) -> Result<(), SheetsError> {
        if cells.is_empty() {
            return Ok(());
        }
        let data: Vec<Value> = cells.iter().map(|(rng, v)| json!({"range": rng, "majorDimension": "ROWS", "values": [[v]]})).collect();
        let body = json!({"valueInputOption": "RAW", "data": data});
        self.call(reqwest::Method::POST, "/values:batchUpdate", &[], Some(body)).await.map(|_| ())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a1_and_quote_match_python() {
        assert_eq!(a1("28.11", ""), "'28.11'");
        assert_eq!(a1("it's", "C3:Z10"), "'it''s'!C3:Z10");
        // urllib.parse.quote("'28.11'!C3:Z10", safe='')
        assert_eq!(quote("'28.11'!C3:Z10"), "%2728.11%27%21C3%3AZ10");
        assert_eq!(quote("ก a"), "%E0%B8%81%20a");
    }
}
