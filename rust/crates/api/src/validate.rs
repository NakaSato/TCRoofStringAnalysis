//! Request-body validation the way FastAPI + pydantic v2 (lax mode) do it, for the body models
//! ported so far. Status codes match (422); the body is one `{"detail": "<field>: <message>"}`
//! instead of FastAPI's list of error objects (an accepted difference, see rust/tests/parity).

use axum::http::{header, HeaderMap};
use serde_json::{Map, Value};

use crate::error::ApiError;

fn err(field: &str, msg: impl std::fmt::Display) -> ApiError {
    ApiError::Unprocessable(format!("{field}: {msg}"))
}

/// FastAPI's body read: JSON when the content type is missing or `…/json` / `…+json`, else the
/// raw bytes (which no model accepts). A missing, malformed or non-object body is 422.
pub fn json_object(headers: &HeaderMap, body: &[u8]) -> Result<Map<String, Value>, ApiError> {
    let ct = headers.get(header::CONTENT_TYPE).and_then(|v| v.to_str().ok()).unwrap_or("");
    let mime = ct.split(';').next().unwrap_or("").trim().to_ascii_lowercase();
    let is_json = mime.is_empty() || mime == "application/json" || (mime.starts_with("application/") && mime.ends_with("+json"));
    if !is_json {
        return Err(err("body", "Input should be a valid dictionary or object to extract fields from"));
    }
    if body.is_empty() {
        return Err(err("body", "Field required"));
    }
    match serde_json::from_slice::<Value>(body) {
        Ok(Value::Object(m)) => Ok(m),
        Ok(Value::Null) => Err(err("body", "Field required")),
        Ok(_) => Err(err("body", "Input should be a valid dictionary or object to extract fields from")),
        Err(e) => Err(err("body", format!("JSON decode error: {e}"))),
    }
}

/// A `str` field with pydantic's length limits (in characters). JSON strings only: pydantic does
/// not turn numbers into strings.
pub fn string(field: &str, v: &Value, min: usize, max: usize) -> Result<String, ApiError> {
    let Value::String(s) = v else { return Err(err(field, "Input should be a valid string")) };
    let n = s.chars().count();
    if n < min {
        return Err(err(field, format!("String should have at least {min} character{}", if min == 1 { "" } else { "s" })));
    }
    if n > max {
        return Err(err(field, format!("String should have at most {max} characters")));
    }
    Ok(s.clone())
}

/// A required `str` field.
pub fn required_string(obj: &Map<String, Value>, field: &str, min: usize, max: usize) -> Result<String, ApiError> {
    match obj.get(field) {
        None => Err(err(field, "Field required")),
        Some(v) => string(field, v, min, max),
    }
}

/// An `Optional[str]` field: absent or null = None.
pub fn optional_string(obj: &Map<String, Value>, field: &str, min: usize, max: usize) -> Result<Option<String>, ApiError> {
    match obj.get(field) {
        None | Some(Value::Null) => Ok(None),
        Some(v) => string(field, v, min, max).map(Some),
    }
}

/// pydantic lax `bool`: true / false, the ints 0 / 1 and the usual words.
pub fn boolean(field: &str, v: &Value) -> Result<bool, ApiError> {
    let bad = || err(field, "Input should be a valid boolean");
    match v {
        Value::Bool(b) => Ok(*b),
        Value::Number(n) => match n.as_f64() {
            Some(0.0) => Ok(false),
            Some(1.0) => Ok(true),
            _ => Err(bad()),
        },
        Value::String(s) => match s.to_ascii_lowercase().as_str() {
            "1" | "on" | "t" | "true" | "y" | "yes" => Ok(true),
            "0" | "off" | "f" | "false" | "n" | "no" => Ok(false),
            _ => Err(bad()),
        },
        _ => Err(bad()),
    }
}

/// A `bool = default` field: absent = default, null is an error (as in pydantic).
pub fn bool_or(obj: &Map<String, Value>, field: &str, default: bool) -> Result<bool, ApiError> {
    obj.get(field).map_or(Ok(default), |v| boolean(field, v))
}

/// An `Optional[bool]` field.
pub fn optional_bool(obj: &Map<String, Value>, field: &str) -> Result<Option<bool>, ApiError> {
    match obj.get(field) {
        None | Some(Value::Null) => Ok(None),
        Some(v) => boolean(field, v).map(Some),
    }
}

/// pydantic lax `int`: an int, a float without a fraction, a bool, or digits in a string.
pub fn integer(field: &str, v: &Value) -> Result<i64, ApiError> {
    let bad = || err(field, "Input should be a valid integer");
    match v {
        Value::Number(n) => {
            if let Some(i) = n.as_i64() {
                Ok(i)
            } else if let Some(x) = n.as_f64() {
                if x.fract() == 0.0 && x.abs() < 9.2e18 {
                    Ok(x as i64)
                } else {
                    Err(err(field, "Input should be a valid integer, got a number with a fractional part"))
                }
            } else {
                Err(bad())
            }
        }
        Value::Bool(b) => Ok(i64::from(*b)),
        Value::String(s) => crate::extract::parse_int(s).ok_or_else(|| err(field, "Input should be a valid integer, unable to parse string as an integer")),
        _ => Err(bad()),
    }
}

/// A `List[int]` field (a JSON array).
pub fn int_list(field: &str, v: &Value) -> Result<Vec<i64>, ApiError> {
    let Value::Array(items) = v else { return Err(err(field, "Input should be a valid list")) };
    items.iter().enumerate().map(|(i, x)| integer(&format!("{field}.{i}"), x)).collect()
}

/// `Literal["admin", "engineer"]`
pub fn role(field: &str, v: &Value) -> Result<String, ApiError> {
    match v {
        Value::String(s) if s == "admin" || s == "engineer" => Ok(s.clone()),
        _ => Err(err(field, "Input should be 'admin' or 'engineer'")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn lax_scalars() {
        assert!(boolean("b", &json!("YES")).unwrap());
        assert!(!boolean("b", &json!(0)).unwrap());
        assert!(boolean("b", &json!(2)).is_err());
        assert!(boolean("b", &json!(null)).is_err());
        assert_eq!(integer("i", &json!(5.0)).unwrap(), 5);
        assert_eq!(integer("i", &json!("12")).unwrap(), 12);
        assert_eq!(integer("i", &json!(true)).unwrap(), 1);
        assert!(integer("i", &json!(5.5)).is_err());
        assert!(integer("i", &json!("x")).is_err());
        assert!(string("s", &json!(5), 0, 9).is_err());
        assert!(string("s", &json!("ab"), 3, 9).is_err());
        assert!(string("s", &json!("ช่าง"), 0, 4).is_ok(), "characters, not bytes");
        assert!(role("r", &json!("Admin")).is_err());
    }

    #[test]
    fn body_kinds() {
        let h = HeaderMap::new();
        assert!(json_object(&h, b"{\"a\": 1}").is_ok());
        for bad in [&b""[..], b"null", b"[]", b"{", b"3"] {
            assert!(json_object(&h, bad).is_err());
        }
        let mut form = HeaderMap::new();
        form.insert(header::CONTENT_TYPE, "application/x-www-form-urlencoded".parse().unwrap());
        assert!(json_object(&form, b"{}").is_err());
    }
}
