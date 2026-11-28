//! The Issues queue, reading and acting on it (DB only). Port of the "reading" half of
//! backend/app/services/growatt_issues.py: `serialize`, `_names`, `STATUS_FILTERS`, `sort_key`,
//! `list_issues`, `summarize` and `apply_action` (acknowledge / resolve / dismiss / reopen / note).
//! Turning findings into issues (`sync`, `_link_parents`, auto-close) belongs to the rules
//! engine (`issues_sync`), not here. kWh and baht are estimates; `shadow` issues are for admins only.

use std::cmp::Ordering;
use std::collections::{BTreeMap, HashMap, HashSet};

use chrono::{DateTime, NaiveDate, SubsecRound, Utc};
use serde_json::{json, Map, Value};
use sqlx::{PgConnection, PgPool};

use crate::common::{isoformat_utc, py_round, Result, ServiceError};
use crate::plant_documents::py_strip;

/// Python `growatt_issues.ACTIVE`
pub const ACTIVE: [&str; 2] = ["open", "acknowledged"];
/// Python `growatt_issues.CLOSED`
pub const CLOSED: [&str; 2] = ["resolved", "dismissed"];
/// Python `growatt_issues.ACTIONS`
pub const ACTIONS: [&str; 5] = ["acknowledge", "resolve", "dismiss", "reopen", "note"];

/// Python `growatt_rules.RULE_NAMES`
pub fn rule_name(rule: &str) -> &str {
    match rule {
        "R1" => "Weak string",
        "R2" => "Open string",
        "R3" => "Insulation / ground fault",
        "R4" => "Bypass diode (voltage drop)",
        "R5" => "Slow string drift",
        "R6" => "PID / rapid string degradation",
        "R7" => "Inverter underperforming",
        "R8" => "Inverter down",
        "R9" => "Grid trips",
        "R10" => "Plant EPI anomaly",
        "R11" => "Inverter Ya − Yf loss drift",
        "R12" => "Soiling wallet: cleaning pays off",
        "R13" => "Incomplete recovery after rain",
        "R16" => "Weather sensor suspect",
        "R17" => "Data gap",
        "R18" => "Power limiting",
        other => other,
    }
}

/// Python `growatt_rules.TIER_ORDER.get(tier, 9)`
pub fn tier_rank(t: &str) -> i32 {
    match t {
        "P1" => 0,
        "P2" => 1,
        "P3" => 2,
        "P4" => 3,
        "Info" => 4,
        _ => 9,
    }
}

/// Python `growatt_issues.STATUS_FILTERS` (an unknown filter = active)
pub fn status_filter(status: &str) -> Vec<&'static str> {
    match status {
        "open" => vec!["open"],
        "acknowledged" => vec!["acknowledged"],
        "resolved" => vec!["resolved"],
        "dismissed" => vec!["dismissed"],
        "closed" => CLOSED.to_vec(),
        "all" => ACTIVE.iter().chain(CLOSED.iter()).copied().collect(),
        _ => ACTIVE.to_vec(),
    }
}

/// One `growatt_issues` row (Python `GrowattIssue`)
#[derive(Debug, Clone, PartialEq, sqlx::FromRow)]
pub struct Issue {
    pub id: i32,
    pub plant_id: i32,
    pub device_sn: Option<String>,
    pub string_no: Option<i32>,
    pub rule: String,
    pub tier: String,
    pub safety: bool,
    pub parent_id: Option<i32>,
    pub opened_day: NaiveDate,
    pub last_seen_day: NaiveDate,
    pub days_seen: i32,
    pub lost_kwh_est: Option<f64>,
    pub thb_per_day_est: Option<f64>,
    pub lost_kwh_total_est: Option<f64>,
    pub thb_total_est: Option<f64>,
    pub evidence: Option<Value>,
    pub daily: Option<Value>,
    pub status: String,
    pub ack_by: Option<String>,
    pub ack_at: Option<DateTime<Utc>>,
    pub note: Option<String>,
    pub feedback: Option<String>,
    pub shadow: bool,
    pub closed_at: Option<DateTime<Utc>>,
    pub closed_by: Option<String>,
    pub close_reason: Option<String>,
}

pub const ISSUE_COLS: &str = "id, plant_id, device_sn, string_no, rule, tier, safety, parent_id, opened_day, last_seen_day, \
     days_seen, lost_kwh_est, thb_per_day_est, lost_kwh_total_est, thb_total_est, evidence, daily, status, ack_by, ack_at, \
     note, feedback, shadow, closed_at, closed_by, close_reason";

/// Ids as SQL binds: always int4 (an id beyond int4 matches no row, as a lookup finds nothing in Python)
pub fn id32(v: i64) -> i32 {
    i32::try_from(v).unwrap_or(i32::MIN)
}

/// Python truthiness of a JSON value (`x or {}`)
fn truthy(v: &Value) -> bool {
    match v {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().is_some_and(|x| x != 0.0),
        Value::String(s) => !s.is_empty(),
        Value::Array(a) => !a.is_empty(),
        Value::Object(o) => !o.is_empty(),
    }
}

fn or_empty(v: &Option<Value>) -> Value {
    match v {
        Some(x) if truthy(x) => x.clone(),
        _ => Value::Object(Map::new()),
    }
}

/// Python `growatt_issues.serialize`
pub fn serialize(i: &Issue, plants: &HashMap<i32, String>, inverters: &HashMap<String, String>) -> Value {
    json!({
        "id": i.id,
        "plant_id": i.plant_id,
        "plant_name": plants.get(&i.plant_id),
        "device_sn": i.device_sn,
        "inverter_name": inverters.get(i.device_sn.as_deref().unwrap_or("")),
        "string_no": i.string_no,
        "rule": i.rule,
        "name": rule_name(&i.rule),
        "tier": i.tier,
        "safety": i.safety,
        "parent_id": i.parent_id,
        "opened_day": i.opened_day.format("%Y-%m-%d").to_string(),
        "last_seen_day": i.last_seen_day.format("%Y-%m-%d").to_string(),
        "days_seen": i.days_seen,
        "lost_kwh_est": i.lost_kwh_est,
        "thb_per_day_est": i.thb_per_day_est,
        "lost_kwh_total_est": i.lost_kwh_total_est,
        "thb_total_est": i.thb_total_est,
        "evidence": or_empty(&i.evidence),
        "daily": or_empty(&i.daily),
        "status": i.status,
        "ack_by": i.ack_by,
        "ack_at": i.ack_at.map(isoformat_utc),
        "note": i.note,
        "feedback": i.feedback,
        "shadow": i.shadow,
        "closed_at": i.closed_at.map(isoformat_utc),
        "closed_by": i.closed_by,
        "close_reason": i.close_reason,
    })
}

/// Python `growatt_issues._names` (also `site_events._serialize_all`'s lookups): plant names of
/// `plant_ids`, and `alias or serial` of the inverters `sns` (any plant).
pub async fn names(
    pool: &PgPool,
    plant_ids: &HashSet<i32>,
    sns: &HashSet<String>,
) -> Result<(HashMap<i32, String>, HashMap<String, String>)> {
    let mut plants = HashMap::new();
    if !plant_ids.is_empty() {
        let ids: Vec<i32> = plant_ids.iter().copied().collect();
        let rows: Vec<(i32, Option<String>)> =
            sqlx::query_as("SELECT plant_id, name FROM growatt_plants WHERE plant_id = ANY($1)").bind(ids).fetch_all(pool).await?;
        // Python `dict(rows)`: a plant without a name maps to None (`plants.get` → null either way)
        plants = rows.into_iter().filter_map(|(id, n)| n.map(|n| (id, n))).collect();
    }
    let mut inverters = HashMap::new();
    if !sns.is_empty() {
        let list: Vec<String> = sns.iter().cloned().collect();
        let rows: Vec<(String, Option<String>)> =
            sqlx::query_as("SELECT device_sn, alias FROM growatt_inverters WHERE device_sn = ANY($1)").bind(list).fetch_all(pool).await?;
        for (sn, alias) in rows {
            let name = alias.filter(|a| !a.is_empty()).unwrap_or_else(|| sn.clone());
            inverters.insert(sn, name);
        }
    }
    Ok((plants, inverters))
}

/// Python `growatt_issues._names(db, [i])` + `serialize(i, …)` of one issue
pub async fn one(pool: &PgPool, i: &Issue) -> Result<Value> {
    let (plants, inverters) = names(pool, &[i.plant_id].into_iter().collect(), &i.device_sn.iter().cloned().collect()).await?;
    Ok(serialize(i, &plants, &inverters))
}

/// Python `growatt_issues.sort_key`: safety first, then tier, THB/day, lost kWh, id.
pub fn sort_cmp(a: &Value, b: &Value) -> Ordering {
    let safety = |d: &Value| !d["safety"].as_bool().unwrap_or(false);
    let num = |d: &Value, k: &str| -(d[k].as_f64().unwrap_or(0.0));
    safety(a)
        .cmp(&safety(b))
        .then(tier_rank(a["tier"].as_str().unwrap_or("")).cmp(&tier_rank(b["tier"].as_str().unwrap_or(""))))
        .then(num(a, "thb_per_day_est").partial_cmp(&num(b, "thb_per_day_est")).unwrap_or(Ordering::Equal))
        .then(num(a, "lost_kwh_est").partial_cmp(&num(b, "lost_kwh_est")).unwrap_or(Ordering::Equal))
        .then(a["id"].as_i64().cmp(&b["id"].as_i64()))
}

/// Python `growatt_issues.summarize`: counts of the active issues by tier and rule, their safety
/// count and summed THB/day (estimated; null when none is priced).
pub fn summarize(items: &[Value]) -> Value {
    let mut by_tier: BTreeMap<String, i64> = BTreeMap::new();
    let mut by_rule: BTreeMap<String, i64> = BTreeMap::new();
    let mut thb = 0.0_f64;
    let mut priced = 0;
    let mut safety = 0;
    for d in items {
        if !ACTIVE.contains(&d["status"].as_str().unwrap_or("")) {
            continue;
        }
        *by_tier.entry(d["tier"].as_str().unwrap_or("").to_owned()).or_default() += 1;
        *by_rule.entry(d["rule"].as_str().unwrap_or("").to_owned()).or_default() += 1;
        if let Some(x) = d["thb_per_day_est"].as_f64() {
            thb += x;
            priced += 1;
        }
        if d["safety"].as_bool().unwrap_or(false) {
            safety += 1;
        }
    }
    json!({
        "active": by_tier.values().sum::<i64>(),
        "safety": safety,
        "by_tier": by_tier,
        "by_rule": by_rule,
        "thb_per_day_est": if priced > 0 { Some(py_round(thb, 0)) } else { None },
    })
}

/// Filters of Python `growatt_issues.list_issues`
#[derive(Debug, Clone, Default)]
pub struct IssueFilter {
    pub plant_id: Option<i64>,
    pub status: String,
    pub tier: Option<String>,
    pub rule: Option<String>,
    /// Some(false) = live only (default), Some(true) = shadow only, None = both
    pub shadow: Option<bool>,
}

/// Python `growatt_issues.list_issues(limit=1000)`: issues the user may see (`plant_ids` None =
/// every plant), safety first, then tier and THB/day; plus counts of the active ones (before the
/// tier filter).
pub async fn list_issues(pool: &PgPool, plant_ids: Option<&HashSet<i64>>, f: &IssueFilter) -> Result<Value> {
    const LIMIT: usize = 1000;
    let statuses: Vec<String> = status_filter(&f.status).into_iter().map(str::to_owned).collect();
    let scope: Option<Vec<i32>> = plant_ids.map(|s| s.iter().filter_map(|p| i32::try_from(*p).ok()).collect());
    let rule = f.rule.clone().filter(|r| !r.is_empty());
    let rows: Vec<Issue> = sqlx::query_as(&format!(
        "SELECT {ISSUE_COLS} FROM growatt_issues WHERE status = ANY($1) AND ($2::int4[] IS NULL OR plant_id = ANY($2)) \
         AND ($3::int4 IS NULL OR plant_id = $3) AND ($4::bool IS NULL OR shadow = $4) AND ($5::text IS NULL OR rule = $5)"
    ))
    .bind(statuses)
    .bind(scope)
    .bind(f.plant_id.map(id32))
    .bind(f.shadow)
    .bind(rule)
    .fetch_all(pool)
    .await?;
    let pids: HashSet<i32> = rows.iter().map(|i| i.plant_id).collect();
    let sns: HashSet<String> = rows.iter().filter_map(|i| i.device_sn.clone()).filter(|s| !s.is_empty()).collect();
    let (plants, inverters) = names(pool, &pids, &sns).await?;
    let mut items: Vec<Value> = rows.iter().map(|i| serialize(i, &plants, &inverters)).collect();
    items.sort_by(sort_cmp);
    let summary = summarize(&items);
    if let Some(t) = f.tier.as_deref().filter(|t| !t.is_empty()) {
        items.retain(|d| d["tier"] == t);
    }
    let total = items.len();
    items.truncate(LIMIT);
    Ok(json!({"summary": summary, "total": total, "issues": items}))
}

/// `db.get(GrowattIssue, issue_id)`
pub async fn get_issue(pool: &PgPool, issue_id: i64) -> Result<Option<Issue>> {
    Ok(sqlx::query_as(&format!("SELECT {ISSUE_COLS} FROM growatt_issues WHERE id = $1"))
        .bind(id32(issue_id))
        .fetch_optional(pool)
        .await?)
}

/// The same inside a transaction, locking the row
pub async fn get_issue_for_update(conn: &mut PgConnection, issue_id: i64) -> Result<Option<Issue>> {
    Ok(sqlx::query_as(&format!("SELECT {ISSUE_COLS} FROM growatt_issues WHERE id = $1 FOR UPDATE"))
        .bind(id32(issue_id))
        .fetch_optional(conn)
        .await?)
}

/// Python `growatt_issues.apply_action` (without its commit: the caller commits): acknowledge /
/// resolve / dismiss / reopen an issue, or only change its note or feedback. A refused action is
/// `ServiceError::Invalid` (the issues route answers 409). Returns the issue as stored.
pub async fn apply_action(
    conn: &mut PgConnection,
    i: &Issue,
    action: &str,
    username: &str,
    note: Option<&str>,
    feedback: Option<&str>,
) -> Result<Issue> {
    if !ACTIONS.contains(&action) {
        return Err(ServiceError::Invalid(format!("Unknown action '{action}'")));
    }
    if !matches!(feedback, None | Some("confirmed") | Some("false_alarm")) {
        return Err(ServiceError::Invalid("feedback must be confirmed or false_alarm".into()));
    }
    // Postgres keeps microseconds: the value written is the value read back
    let now = Utc::now().trunc_subsecs(6);
    let active = ACTIVE.contains(&i.status.as_str());
    if matches!(action, "acknowledge" | "resolve" | "dismiss") && !active {
        return Err(ServiceError::Invalid(format!("Issue is {}", i.status)));
    }
    let mut n = i.clone();
    match action {
        "acknowledge" => {
            n.status = "acknowledged".into();
            n.ack_by = Some(username.to_owned());
            n.ack_at = Some(now);
        }
        "resolve" | "dismiss" => {
            n.status = if action == "resolve" { "resolved" } else { "dismissed" }.into();
            n.close_reason = Some(n.status.clone());
            n.closed_at = Some(now);
            n.closed_by = Some(username.to_owned());
            let default = if action == "resolve" { "confirmed" } else { "false_alarm" };
            n.feedback = Some(feedback.unwrap_or(default).to_owned());
        }
        "reopen" => {
            if active {
                return Err(ServiceError::Invalid("Issue is already open".into()));
            }
            let clash: Option<i32> = sqlx::query_scalar(
                "SELECT id FROM growatt_issues WHERE status = ANY($1) AND plant_id = $2 AND device_sn IS NOT DISTINCT FROM $3 \
                 AND string_no IS NOT DISTINCT FROM $4 AND rule = $5 LIMIT 1",
            )
            .bind(ACTIVE.iter().map(|s| s.to_string()).collect::<Vec<_>>())
            .bind(i.plant_id)
            .bind(&i.device_sn)
            .bind(i.string_no)
            .bind(&i.rule)
            .fetch_optional(&mut *conn)
            .await?;
            if let Some(c) = clash {
                let what = if i.string_no.is_some() { "string" } else { "inverter" };
                return Err(ServiceError::Invalid(format!("Issue #{c} is already open for this {what} and rule")));
            }
            n.status = "open".into();
            n.close_reason = None;
            n.closed_at = None;
            n.closed_by = None;
            n.feedback = None;
        }
        _ => {}
    }
    if let Some(fb) = feedback {
        if !matches!(action, "resolve" | "dismiss") {
            n.feedback = Some(fb.to_owned());
        }
    }
    if let Some(text) = note {
        let t = py_strip(text);
        n.note = (!t.is_empty()).then(|| t.to_owned());
    }
    if n == *i {
        return Ok(n); // SQLAlchemy issues no UPDATE (updated_at kept) when nothing changed
    }
    let saved: Issue = sqlx::query_as(&format!(
        "UPDATE growatt_issues SET status = $2, ack_by = $3, ack_at = $4, close_reason = $5, closed_at = $6, closed_by = $7, \
         feedback = $8, note = $9, updated_at = now() WHERE id = $1 RETURNING {ISSUE_COLS}"
    ))
    .bind(i.id)
    .bind(&n.status)
    .bind(&n.ack_by)
    .bind(n.ack_at)
    .bind(&n.close_reason)
    .bind(n.closed_at)
    .bind(&n.closed_by)
    .bind(&n.feedback)
    .bind(&n.note)
    .fetch_one(&mut *conn)
    .await?;
    Ok(saved)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn item(id: i64, safety: bool, tier: &str, thb: Option<f64>, kwh: Option<f64>, status: &str) -> Value {
        json!({"id": id, "safety": safety, "tier": tier, "thb_per_day_est": thb, "lost_kwh_est": kwh, "status": status, "rule": "R1"})
    }

    #[test]
    fn sort_like_python() {
        let mut v = [
            item(1, false, "P2", Some(10.0), None, "open"),
            item(2, true, "P3", None, None, "open"),
            item(3, false, "P1", None, Some(5.0), "open"),
            item(4, false, "P1", Some(0.0), Some(9.0), "open"),
            item(5, false, "X", Some(99.0), None, "open"),
            item(6, false, "P2", Some(10.0), None, "open"),
        ];
        v.sort_by(sort_cmp);
        let ids: Vec<i64> = v.iter().map(|d| d["id"].as_i64().unwrap()).collect();
        assert_eq!(ids, vec![2, 4, 3, 1, 6, 5]);
    }

    #[test]
    fn summary_counts_active_only() {
        let v = vec![
            item(1, true, "P1", Some(10.4), None, "open"),
            item(2, false, "P2", Some(0.2), None, "acknowledged"),
            item(3, false, "P2", None, None, "resolved"),
        ];
        let s = summarize(&v);
        assert_eq!(s["active"], 2);
        assert_eq!(s["safety"], 1);
        assert_eq!(s["by_tier"], json!({"P1": 1, "P2": 1}));
        assert_eq!(s["thb_per_day_est"], json!(11.0));
        assert_eq!(summarize(&[])["thb_per_day_est"], Value::Null);
    }

    #[test]
    fn evidence_or_empty() {
        assert_eq!(or_empty(&None), json!({}));
        assert_eq!(or_empty(&Some(Value::Null)), json!({}));
        assert_eq!(or_empty(&Some(json!([]))), json!({}));
        assert_eq!(or_empty(&Some(json!({"a": 1}))), json!({"a": 1}));
    }
}
