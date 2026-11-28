//! The Site log (DB only), ported from backend/app/api/routes/growatt/events.py: fleet
//! `GET /growatt/events`, `GET/POST /growatt/plants/{plant_id}/events` and
//! `PATCH/DELETE /growatt/plants/{plant_id}/events/{event_id}`; service in
//! `tcroof_services::site_events` (backend/app/services/site_events.py).
//!
//! Read / write: admin or the assigned engineer (`require_plant_read` / `require_plant_write`;
//! an unassigned plant is 404). DELETE: admin or whoever recorded the event (403 otherwise). A
//! link to a shadow issue is hidden from engineers. Every write is an `app.audit` line worded as
//! Python's. (`/plants/{plant_id}/soiling`, in the same Python module, needs the rules engine and
//! lives elsewhere.)

use std::collections::HashMap;

use axum::body::Bytes;
use axum::extract::{Path, RawQuery, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, patch};
use axum::{Json, Router};
use chrono::NaiveDate;
use serde_json::{Map, Value};

use tcroof_services::site_events::{self as se, EventChanges, EventFilter, NewEvent, EVENT_TYPES};

use super::issues::{allowed, date_param, int_param, parse_date, path_int, query_pairs, str_param, svc, unprocessable, who};
use crate::error::ApiError;
use crate::extract::{PlantRead, PlantWrite, Scoped};
use crate::validate as v;
use crate::AppState;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/events", get(list_site_events))
        .route("/plants/{plant_id}/events", get(list_plant_site_events).post(create_plant_site_event))
        .route("/plants/{plant_id}/events/{event_id}", patch(patch_plant_site_event).delete(delete_plant_site_event))
}

/// Python `events.EVENT_TYPE_PATTERN`
const EVENT_TYPE_PATTERN: &str =
    "^(cleaning|repair|module_replaced|inverter_replaced|ir_flight|pm_inspection|inverter_service|site_visit|curtailment|other)$";

/// `limit: int = Query(500, ge=1, le=5000)`
fn limit_param(pairs: &[(String, String)]) -> Result<usize, ApiError> {
    Ok(int_param(pairs, "limit", Some(1), Some(5000))?.unwrap_or(500) as usize)
}

// --------------------------------------------------------------------------- reading

/// GET /growatt/events: Python `events.list_site_events`. Site events of every plant the user
/// may see, newest first (`since` matches any day an event covers).
async fn list_site_events(State(st): State<AppState>, s: Scoped, RawQuery(q): RawQuery) -> Result<Json<Value>, ApiError> {
    let pairs = query_pairs(q.as_deref());
    let plant_id = int_param(&pairs, "plant_id", None, None)?;
    let event_type = str_param(&pairs, "type", usize::MAX, Some(EVENT_TYPE_PATTERN))?;
    let since = date_param(&pairs, "since")?;
    let until = date_param(&pairs, "until")?;
    let limit = limit_param(&pairs)?;
    let scope = allowed(&s.scope);
    if let (Some(ids), Some(p)) = (scope, plant_id) {
        if !ids.contains(&p) {
            return Err(ApiError::NotFound(format!("Plant {p} not found")));
        }
    }
    let f = EventFilter { plant_id, event_type, device_sn: None, since, until, limit, allow_shadow: scope.is_none() };
    let mut out = se::list_events(&st.pool, scope, &f).await.map_err(svc)?;
    out["meta"] = serde_json::json!({"source": "db"});
    Ok(Json(out))
}

/// GET /growatt/plants/{plant_id}/events: Python `events.list_plant_site_events`
async fn list_plant_site_events(State(st): State<AppState>, p: PlantRead, RawQuery(q): RawQuery) -> Result<Json<Value>, ApiError> {
    let pairs = query_pairs(q.as_deref());
    let event_type = str_param(&pairs, "type", usize::MAX, Some(EVENT_TYPE_PATTERN))?;
    let device_sn = str_param(&pairs, "sn", 64, None)?;
    let since = date_param(&pairs, "since")?;
    let until = date_param(&pairs, "until")?;
    let limit = limit_param(&pairs)?;
    let f = EventFilter {
        plant_id: Some(p.plant_id),
        event_type,
        device_sn,
        since,
        until,
        limit,
        allow_shadow: p.user.is_admin(),
    };
    let out = se::list_events(&st.pool, None, &f).await.map_err(svc)?;
    let mut m = Map::new();
    m.insert("plant_id".into(), Value::from(p.plant_id));
    if let Value::Object(o) = out {
        m.extend(o);
    }
    m.insert("meta".into(), serde_json::json!({"source": "db"}));
    Ok(Json(Value::Object(m)))
}

// --------------------------------------------------------------------------- body fields (pydantic, lax)

fn literal_type(field: &str, x: &Value) -> Result<String, ApiError> {
    match x {
        Value::String(s) if EVENT_TYPES.iter().any(|(k, _)| k == s) => Ok(s.clone()),
        _ => Err(unprocessable(
            field,
            format!(
                "Input should be {}",
                EVENT_TYPES.iter().map(|(k, _)| format!("'{k}'")).collect::<Vec<_>>().join(", ").replacen(", 'other'", " or 'other'", 1)
            ),
        )),
    }
}

fn date_value(field: &str, x: &Value) -> Result<NaiveDate, ApiError> {
    match x {
        Value::String(s) => parse_date(s).ok_or_else(|| unprocessable(field, "Input should be a valid date or datetime, invalid date separator")),
        _ => Err(unprocessable(field, "Input should be a valid date")),
    }
}

/// pydantic lax `float`: a number, a bool, or a number in a string
fn float_value(field: &str, x: &Value) -> Result<f64, ApiError> {
    match x {
        Value::Number(n) => n.as_f64().ok_or_else(|| unprocessable(field, "Input should be a valid number")),
        Value::Bool(b) => Ok(if *b { 1.0 } else { 0.0 }),
        Value::String(s) => s
            .trim()
            .parse::<f64>()
            .ok()
            .filter(|f| f.is_finite())
            .ok_or_else(|| unprocessable(field, "Input should be a valid number, unable to parse string as a number")),
        _ => Err(unprocessable(field, "Input should be a valid number")),
    }
}

/// `cost_thb: Optional[float] = Field(ge=0, le=10_000_000)`
fn cost_value(x: &Value) -> Result<f64, ApiError> {
    let c = float_value("cost_thb", x)?;
    if c.is_nan() || c < 0.0 {
        return Err(unprocessable("cost_thb", "Input should be greater than or equal to 0"));
    }
    if c > 10_000_000.0 {
        return Err(unprocessable("cost_thb", "Input should be less than or equal to 10000000"));
    }
    Ok(c)
}

/// `string_no: Optional[int] = Field(ge=1, le=64)`
fn string_no_value(x: &Value) -> Result<i32, ApiError> {
    let n = v::integer("string_no", x)?;
    if n < 1 {
        return Err(unprocessable("string_no", "Input should be greater than or equal to 1"));
    }
    if n > 64 {
        return Err(unprocessable("string_no", "Input should be less than or equal to 64"));
    }
    Ok(n as i32)
}

/// An optional field: absent = None, null = Some(None), else the parsed value
fn opt<T>(obj: &Map<String, Value>, k: &str, f: impl Fn(&Value) -> Result<T, ApiError>) -> Result<Option<Option<T>>, ApiError> {
    match obj.get(k) {
        None => Ok(None),
        Some(Value::Null) => Ok(Some(None)),
        Some(x) => f(x).map(|t| Some(Some(t))),
    }
}

/// Python `api_schemas.SiteEventCreate`
fn create_body(obj: &Map<String, Value>) -> Result<NewEvent, ApiError> {
    let event_type = match obj.get("event_type") {
        None => return Err(unprocessable("event_type", "Field required")),
        Some(x) => literal_type("event_type", x)?,
    };
    let day = match obj.get("day") {
        None => return Err(unprocessable("day", "Field required")),
        Some(x) => date_value("day", x)?,
    };
    Ok(NewEvent {
        event_type,
        day,
        end_day: opt(obj, "end_day", |x| date_value("end_day", x))?.flatten(),
        device_sn: opt(obj, "device_sn", |x| v::string("device_sn", x, 0, 64))?.flatten(),
        string_no: opt(obj, "string_no", string_no_value)?.flatten(),
        cost_thb: opt(obj, "cost_thb", cost_value)?.flatten(),
        issue_id: opt(obj, "issue_id", |x| v::integer("issue_id", x))?.flatten(),
        close_issue: v::bool_or(obj, "close_issue", false)?,
        note: opt(obj, "note", |x| v::string("note", x, 0, 2000))?.flatten(),
    })
}

/// Python `api_schemas.SiteEventPatch.changes()`: only the fields sent; `event_type` / `day`
/// sent as null mean "unchanged"
fn patch_body(obj: &Map<String, Value>) -> Result<EventChanges, ApiError> {
    Ok(EventChanges {
        event_type: opt(obj, "event_type", |x| literal_type("event_type", x))?.flatten(),
        day: opt(obj, "day", |x| date_value("day", x))?.flatten(),
        end_day: opt(obj, "end_day", |x| date_value("end_day", x))?,
        device_sn: opt(obj, "device_sn", |x| v::string("device_sn", x, 0, 64))?,
        string_no: opt(obj, "string_no", string_no_value)?,
        cost_thb: opt(obj, "cost_thb", cost_value)?,
        issue_id: opt(obj, "issue_id", |x| v::integer("issue_id", x))?,
        close_issue: obj.get("close_issue").map(|x| v::boolean("close_issue", x)).transpose()?,
        note: opt(obj, "note", |x| v::string("note", x, 0, 2000))?,
    })
}

// --------------------------------------------------------------------------- writing

/// POST /growatt/plants/{plant_id}/events (201): Python `events.create_plant_site_event`. Record
/// work done on the plant; with `issue_id` + `close_issue` the issue is resolved as confirmed and
/// its note names the event.
async fn create_plant_site_event(
    State(st): State<AppState>,
    p: PlantWrite,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Response, ApiError> {
    let payload = create_body(&v::json_object(&headers, &body)?)?;
    let by = who(&p.user);
    let admin = p.user.is_admin();
    let ev = se::create_event(&st.pool, p.plant_id, &payload, &by, admin).await.map_err(svc)?;
    let resolved = if payload.close_issue { format!(", resolved issue {}", ev.issue_id.map_or("None".into(), |i| i.to_string())) } else { String::new() };
    tracing::info!(
        target: "app.audit",
        "{by} recorded site event #{} ({} {}) for plant {}{resolved}",
        ev.id, ev.event_type, ev.day.format("%Y-%m-%d"), p.plant_id
    );
    let out = se::one(&st.pool, &ev, admin).await.map_err(svc)?;
    Ok((StatusCode::CREATED, Json(out)).into_response())
}

/// PATCH /growatt/plants/{plant_id}/events/{event_id}: Python `events.patch_plant_site_event`.
/// Change an event (only the fields sent).
async fn patch_plant_site_event(
    State(st): State<AppState>,
    p: PlantWrite,
    Path(path): Path<HashMap<String, String>>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Json<Value>, ApiError> {
    let event_id = path_int(&path["event_id"], "event_id")?;
    let changes = patch_body(&v::json_object(&headers, &body)?)?;
    let by = who(&p.user);
    let admin = p.user.is_admin();
    let ev = se::get_event(&st.pool, p.plant_id, event_id).await.map_err(svc)?;
    let saved = se::update_event(&st.pool, &ev, &changes, &by, admin).await.map_err(svc)?;
    let keys = changes.keys();
    let what = if keys.is_empty() { "nothing".to_owned() } else { keys.join(", ") };
    tracing::info!(target: "app.audit", "{by} changed site event #{event_id} for plant {} ({what})", p.plant_id);
    Ok(Json(se::one(&st.pool, &saved, admin).await.map_err(svc)?))
}

/// DELETE /growatt/plants/{plant_id}/events/{event_id} (204): Python
/// `events.delete_plant_site_event`. Admins, or the person who recorded it.
async fn delete_plant_site_event(
    State(st): State<AppState>,
    p: PlantWrite,
    Path(path): Path<HashMap<String, String>>,
) -> Result<StatusCode, ApiError> {
    let event_id = path_int(&path["event_id"], "event_id")?;
    let by = who(&p.user);
    let ev = se::get_event(&st.pool, p.plant_id, event_id).await.map_err(svc)?;
    if !p.user.is_admin() && ev.created_by.as_deref() != Some(by.as_str()) {
        return Err(ApiError::Forbidden("Only an admin or the person who recorded it can delete this event".into()));
    }
    se::delete_event(&st.pool, &ev).await.map_err(svc)?;
    tracing::info!(
        target: "app.audit",
        "{by} deleted site event #{event_id} ({} {}) for plant {}",
        ev.event_type, ev.day.format("%Y-%m-%d"), p.plant_id
    );
    Ok(StatusCode::NO_CONTENT)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn bodies() {
        let o = |v: Value| v.as_object().unwrap().clone();
        let b = create_body(&o(json!({"event_type": "cleaning", "day": "2026-11-01", "cost_thb": "1500", "string_no": 2.0}))).unwrap();
        assert_eq!(b.cost_thb, Some(1500.0));
        assert_eq!(b.string_no, Some(2));
        assert!(!b.close_issue);
        assert!(create_body(&o(json!({"event_type": "wash", "day": "2026-11-01"}))).is_err());
        assert!(create_body(&o(json!({"event_type": "cleaning", "day": "2026-11-01", "cost_thb": -1}))).is_err());
        assert!(create_body(&o(json!({"event_type": "cleaning", "day": "2026-11-01", "close_issue": null}))).is_err());
        assert!(create_body(&o(json!({"event_type": "cleaning"}))).is_err());
        let c = patch_body(&o(json!({"day": null, "end_day": null, "note": "x", "extra": 1}))).unwrap();
        assert_eq!(c.keys(), vec!["end_day", "note"]);
        assert!(patch_body(&o(json!({"close_issue": null}))).is_err());
    }
}
