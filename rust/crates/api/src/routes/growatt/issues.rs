//! The Issues queue and the daily rule / KPI rows (DB only), ported from
//! backend/app/api/routes/growatt/rules.py: `GET /growatt/issues`, `GET/PATCH
//! /growatt/issues/{issue_id}`, `GET /growatt/plants/{plant_id}/rules/daily` and
//! `GET /growatt/plants/{plant_id}/kpi-daily`. (`/rules/findings` and `/center` need the rules
//! engine and live elsewhere.)
//!
//! Scoping as Python: lists are filtered with `allowed_plant_ids`; engineers never see shadow
//! issues (404 on GET / PATCH of one, `shadow` / `include_shadow` ignored); a plant outside the
//! engineer's assignments is 404. PATCH is admin or engineer (`require_write_access`); its refused
//! transitions are 409. Every PATCH is an `app.audit` line worded as Python's.

use std::collections::HashSet;

use axum::body::Bytes;
use axum::extract::{Path, RawQuery, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use chrono::{FixedOffset, NaiveDate, Utc};
use serde_json::{json, Value};

use tcroof_db::User;
use tcroof_services::common::ServiceError;
use tcroof_services::issues::{self, Issue, IssueFilter};
use tcroof_services::rule_daily;

use crate::error::ApiError;
use crate::extract::{parse_int, PlantRead, PlantScope, Scoped, WriteUser};
use crate::validate as v;
use crate::AppState;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/issues", get(list_issues))
        .route("/issues/{issue_id}", get(get_issue).patch(patch_issue))
        .route("/plants/{plant_id}/rules/daily", get(plant_rule_daily))
        .route("/plants/{plant_id}/kpi-daily", get(plant_kpi_daily))
}

// --------------------------------------------------------------------------- shared with events.rs

/// Python `user.username or user.email`
pub(super) fn who(u: &User) -> String {
    u.username.clone().filter(|s| !s.is_empty()).unwrap_or_else(|| u.email.clone())
}

pub(super) fn unprocessable(field: &str, msg: impl std::fmt::Display) -> ApiError {
    ApiError::Unprocessable(format!("{field}: {msg}"))
}

/// `GrowattNotFound` → 404, `ValueError` → 422
pub(super) fn svc(e: ServiceError) -> ApiError {
    match e {
        ServiceError::NotFound(m) => ApiError::NotFound(m),
        ServiceError::Invalid(m) => ApiError::Unprocessable(m),
        ServiceError::Db(e) => ApiError::Db(e),
    }
}

/// The query string as Starlette reads it (`+` a space, repeated keys in order)
pub(super) fn query_pairs(raw: Option<&str>) -> Vec<(String, String)> {
    form_urlencoded::parse(raw.unwrap_or("").as_bytes()).into_owned().collect()
}

/// A scalar query parameter: the last value wins (Starlette `QueryParams.get`)
pub(super) fn last<'a>(pairs: &'a [(String, String)], key: &str) -> Option<&'a str> {
    pairs.iter().rev().find(|(k, _)| k == key).map(|(_, v)| v.as_str())
}

/// pydantic `date` from text: `YYYY-MM-DD`
pub(super) fn parse_date(s: &str) -> Option<NaiveDate> {
    let b = s.as_bytes();
    let ok = b.len() == 10 && b[4] == b'-' && b[7] == b'-';
    ok.then(|| NaiveDate::parse_from_str(s, "%Y-%m-%d").ok()).flatten()
}

/// `Optional[date]` query parameter
pub(super) fn date_param(pairs: &[(String, String)], key: &str) -> Result<Option<NaiveDate>, ApiError> {
    last(pairs, key)
        .map(|s| parse_date(s).ok_or_else(|| unprocessable(key, "Input should be a valid date or datetime")))
        .transpose()
}

/// `Optional[int]` query parameter with optional bounds (`Query(ge=…, le=…)`)
pub(super) fn int_param(pairs: &[(String, String)], key: &str, ge: Option<i64>, le: Option<i64>) -> Result<Option<i64>, ApiError> {
    let Some(s) = last(pairs, key) else { return Ok(None) };
    let n = parse_int(s).ok_or_else(|| unprocessable(key, "Input should be a valid integer, unable to parse string as an integer"))?;
    if let Some(g) = ge.filter(|g| n < *g) {
        return Err(unprocessable(key, format!("Input should be greater than or equal to {g}")));
    }
    if let Some(l) = le.filter(|l| n > *l) {
        return Err(unprocessable(key, format!("Input should be less than or equal to {l}")));
    }
    Ok(Some(n))
}

/// `bool` query parameter (pydantic's words)
pub(super) fn bool_param(pairs: &[(String, String)], key: &str) -> Result<Option<bool>, ApiError> {
    last(pairs, key).map(|s| v::boolean(key, &Value::String(s.to_owned()))).transpose()
}

/// `Optional[str]` query parameter with `max_length` and an optional `pattern`
pub(super) fn str_param(pairs: &[(String, String)], key: &str, max: usize, pattern: Option<&str>) -> Result<Option<String>, ApiError> {
    let Some(s) = last(pairs, key) else { return Ok(None) };
    if s.chars().count() > max {
        return Err(unprocessable(key, format!("String should have at most {max} characters")));
    }
    if let Some(p) = pattern {
        if !regex::Regex::new(p).expect("valid pattern").is_match(s) {
            return Err(unprocessable(key, format!("String should match pattern '{p}'")));
        }
    }
    Ok(Some(s.to_owned()))
}

/// FastAPI `int` path parameter
pub(super) fn path_int(raw: &str, key: &str) -> Result<i64, ApiError> {
    parse_int(raw).ok_or_else(|| unprocessable(key, "Input should be a valid integer, unable to parse string as an integer"))
}

/// Python `allowed_plant_ids` (None = every plant)
pub(super) fn allowed(scope: &PlantScope) -> Option<&HashSet<i64>> {
    match scope {
        PlantScope::All => None,
        PlantScope::Assigned(ids) => Some(ids),
    }
}

/// Python `jobs._today()`: plant-local (Bangkok, UTC+7) today
fn plant_today() -> NaiveDate {
    Utc::now().with_timezone(&FixedOffset::east_opt(7 * 3600).expect("UTC+7")).date_naive()
}

// --------------------------------------------------------------------------- issues

/// GET /growatt/issues: Python `rules.list_issues`. The Issues queue of the plants the user may
/// see, safety first, then tier and estimated THB/day. kWh and baht are estimates.
async fn list_issues(State(st): State<AppState>, s: Scoped, RawQuery(q): RawQuery) -> Result<Json<Value>, ApiError> {
    let pairs = query_pairs(q.as_deref());
    let plant_id = int_param(&pairs, "plant_id", None, None)?;
    let status = str_param(&pairs, "status", usize::MAX, Some("^(active|open|acknowledged|resolved|dismissed|closed|all)$"))?
        .unwrap_or_else(|| "active".into());
    let tier = str_param(&pairs, "tier", usize::MAX, Some("^(P1|P2|P3|P4|Info)$"))?;
    let rule = str_param(&pairs, "rule", 8, None)?;
    let mut shadow = bool_param(&pairs, "shadow")?.or(Some(false));
    let mut include_shadow = bool_param(&pairs, "include_shadow")?.unwrap_or(false);
    let scope = allowed(&s.scope);
    if let Some(ids) = scope {
        shadow = Some(false);
        include_shadow = false;
        if plant_id.is_some_and(|p| !ids.contains(&p)) {
            return Err(ApiError::NotFound(format!("Plant {} not found", plant_id.unwrap_or_default())));
        }
    }
    let f = IssueFilter { plant_id, status, tier, rule, shadow: if include_shadow { None } else { shadow } };
    let mut out = issues::list_issues(&st.pool, scope, &f).await.map_err(svc)?;
    out["meta"] = json!({"source": "db", "estimated": ["lost_kwh_est", "thb_per_day_est", "lost_kwh_total_est", "thb_total_est"]});
    Ok(Json(out))
}

/// Python `rules._issue_for`: the issue, else 404 (also outside an engineer's plants, and a
/// shadow issue for an engineer)
async fn issue_for(st: &AppState, user: &User, issue_id: i64) -> Result<Issue, ApiError> {
    let i = issues::get_issue(&st.pool, issue_id).await.map_err(svc)?;
    let scope = PlantScope::of(&st.pool, user).await?;
    match i {
        Some(i) if matches!(scope, PlantScope::All) || (scope.allows(i64::from(i.plant_id)) && !i.shadow) => Ok(i),
        _ => Err(ApiError::NotFound(format!("Issue {issue_id} not found"))),
    }
}

/// GET /growatt/issues/{issue_id}: Python `rules.get_issue`
async fn get_issue(State(st): State<AppState>, s: Scoped, Path(raw): Path<String>) -> Result<Json<Value>, ApiError> {
    let id = path_int(&raw, "issue_id")?;
    let i = issue_for(&st, &s.user, id).await?;
    Ok(Json(issues::one(&st.pool, &i).await.map_err(svc)?))
}

/// Python `api_schemas.IssueAction`
fn issue_action(obj: &serde_json::Map<String, Value>) -> Result<(String, Option<String>, Option<String>), ApiError> {
    let action = match obj.get("action") {
        None => return Err(unprocessable("action", "Field required")),
        Some(Value::String(a)) if issues::ACTIONS.contains(&a.as_str()) => a.clone(),
        Some(_) => return Err(unprocessable("action", "Input should be 'acknowledge', 'resolve', 'dismiss', 'reopen' or 'note'")),
    };
    let note = v::optional_string(obj, "note", 0, 2000)?;
    let feedback = match obj.get("feedback") {
        None | Some(Value::Null) => None,
        Some(Value::String(f)) if f == "confirmed" || f == "false_alarm" => Some(f.clone()),
        Some(_) => return Err(unprocessable("feedback", "Input should be 'confirmed' or 'false_alarm'")),
    };
    Ok((action, note, feedback))
}

/// PATCH /growatt/issues/{issue_id}: Python `rules.patch_issue`. Acknowledge, resolve or dismiss
/// (with a note and feedback), reopen a closed one, or only edit the note; a refused transition is
/// 409. Engineers act on their assigned plants' live issues; admins on any.
async fn patch_issue(
    State(st): State<AppState>,
    WriteUser(user): WriteUser,
    Path(raw): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Response, ApiError> {
    let id = path_int(&raw, "issue_id")?;
    let (action, note, feedback) = issue_action(&v::json_object(&headers, &body)?)?;
    let i = issue_for(&st, &user, id).await?;
    let by = who(&user);
    let mut tx = st.pool.begin().await.map_err(ApiError::Db)?;
    let saved = match issues::apply_action(&mut tx, &i, &action, &by, note.as_deref(), feedback.as_deref()).await {
        Ok(s) => s,
        Err(ServiceError::Invalid(m)) => return Ok((StatusCode::CONFLICT, Json(json!({"detail": m}))).into_response()),
        Err(e) => return Err(svc(e)),
    };
    tx.commit().await.map_err(ApiError::Db)?;
    let target = saved.device_sn.clone().filter(|s| !s.is_empty()).unwrap_or_else(|| saved.plant_id.to_string());
    tracing::info!(target: "app.audit", "{by} {action} issue {} ({} {target})", saved.id, saved.rule);
    Ok(Json(issues::one(&st.pool, &saved).await.map_err(svc)?).into_response())
}

// --------------------------------------------------------------------------- daily rows

/// GET /growatt/plants/{plant_id}/rules/daily: Python `rules.plant_rule_daily`. The daily rows
/// behind the rules for one inverter (or one of its strings) over the last `days` days up to
/// `day`; lost kWh are estimates.
async fn plant_rule_daily(State(st): State<AppState>, p: PlantRead, RawQuery(q): RawQuery) -> Result<Json<Value>, ApiError> {
    let pairs = query_pairs(q.as_deref());
    let sn = str_param(&pairs, "sn", 64, None)?.ok_or_else(|| unprocessable("sn", "Field required"))?;
    let string_no = int_param(&pairs, "string_no", Some(1), Some(64))?;
    let days = int_param(&pairs, "days", Some(1), Some(365))?.unwrap_or(30);
    let day = date_param(&pairs, "day")?;
    let end = day.unwrap_or_else(plant_today);
    Ok(Json(rule_daily::rule_daily(&st.pool, p.plant_id, &sn, string_no, days, end).await.map_err(svc)?))
}

/// GET /growatt/plants/{plant_id}/kpi-daily: Python `rules.plant_kpi_daily`. Plant-level daily
/// KPIs from `growatt_plant_daily` with the R16 sensor verdict per day and the EPI factor in use.
async fn plant_kpi_daily(State(st): State<AppState>, p: PlantRead, RawQuery(q): RawQuery) -> Result<Json<Value>, ApiError> {
    let pairs = query_pairs(q.as_deref());
    let days = int_param(&pairs, "days", Some(1), Some(365))?.unwrap_or(30);
    let day = date_param(&pairs, "day")?;
    let end = day.unwrap_or_else(plant_today);
    Ok(Json(rule_daily::kpi_daily(&st.pool, p.plant_id, days, end).await.map_err(svc)?))
}
