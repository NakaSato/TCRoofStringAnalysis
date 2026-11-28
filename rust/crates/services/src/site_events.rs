//! Site events: work done on a Growatt plant (docs/plans/decision-rules.md §6). Port of
//! backend/app/services/site_events.py: cleanings, repairs, module / inverter replacements, IR
//! flights, PM inspections, inverter service, site visits and curtailment, with the plant-local
//! date of the work, an optional inverter / string, the cost paid (THB, null when not entered)
//! and a note. An event can answer a decision-rule issue (`issue_id`) and resolve it in the same
//! step. Records of work, not measurements: SQL only, kept indefinitely.

use std::collections::{BTreeMap, HashMap, HashSet};

use chrono::{DateTime, Duration, FixedOffset, NaiveDate, Utc};
use serde_json::{json, Value};
use sqlx::{PgConnection, PgPool};

use crate::common::{isoformat_utc, py_round, Result, ServiceError};
use crate::issues::{self, id32, Issue};
use crate::plant_documents::py_strip;

/// Python `site_events.EVENT_TYPES` with `EVENT_LABELS`
pub const EVENT_TYPES: [(&str, &str); 10] = [
    ("cleaning", "Cleaning"),
    ("repair", "Repair"),
    ("module_replaced", "Module replaced"),
    ("inverter_replaced", "Inverter replaced"),
    ("ir_flight", "IR flight"),
    ("pm_inspection", "PM inspection"),
    ("inverter_service", "Inverter service"),
    ("site_visit", "Site visit"),
    ("curtailment", "Curtailment"),
    ("other", "Other"),
];
/// Python `site_events.MAX_SPAN_DAYS`
pub const MAX_SPAN_DAYS: i64 = 366;

/// Python `EVENT_LABELS.get(t, t)`
pub fn label(t: &str) -> &str {
    EVENT_TYPES.iter().find(|(k, _)| *k == t).map_or(t, |(_, l)| l)
}

/// Python `site_events._today()`: today in Asia/Bangkok (UTC+7, no DST)
pub fn today() -> NaiveDate {
    Utc::now().with_timezone(&FixedOffset::east_opt(7 * 3600).expect("UTC+7")).date_naive()
}

/// One `site_events` row (Python `SiteEvent`)
#[derive(Debug, Clone, PartialEq, sqlx::FromRow)]
pub struct SiteEvent {
    pub id: i32,
    pub plant_id: i32,
    pub event_type: String,
    pub day: NaiveDate,
    pub end_day: Option<NaiveDate>,
    pub device_sn: Option<String>,
    pub string_no: Option<i32>,
    pub cost_thb: Option<f64>,
    pub issue_id: Option<i32>,
    pub note: Option<String>,
    pub created_by: Option<String>,
    pub updated_by: Option<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

const EVENT_COLS: &str = "id, plant_id, event_type, day, end_day, device_sn, string_no, cost_thb, issue_id, note, \
     created_by, updated_by, created_at, updated_at";

fn iso(d: NaiveDate) -> String {
    d.format("%Y-%m-%d").to_string()
}

// --------------------------------------------------------------------------- reading

/// Python `site_events.serialize`; `hidden` = shadow issues the caller may not see (their id is
/// left out too).
fn serialize(
    ev: &SiteEvent,
    plants: &HashMap<i32, String>,
    inverters: &HashMap<String, String>,
    issues: &HashMap<i32, Issue>,
    hidden: &HashSet<i32>,
) -> Value {
    let i = ev.issue_id.and_then(|id| issues.get(&id));
    json!({
        "id": ev.id,
        "plant_id": ev.plant_id,
        "plant_name": plants.get(&ev.plant_id),
        "event_type": ev.event_type,
        "label": label(&ev.event_type),
        "day": iso(ev.day),
        "end_day": ev.end_day.map(iso),
        "device_sn": ev.device_sn,
        "inverter_name": inverters.get(ev.device_sn.as_deref().unwrap_or("")),
        "string_no": ev.string_no,
        "cost_thb": ev.cost_thb,
        "issue_id": if ev.issue_id.is_some_and(|id| hidden.contains(&id)) { None } else { ev.issue_id },
        "issue": i.map(|i| json!({"id": i.id, "rule": i.rule, "status": i.status, "string_no": i.string_no, "device_sn": i.device_sn})),
        "note": ev.note,
        "created_by": ev.created_by,
        "updated_by": ev.updated_by,
        "created_at": isoformat_utc(ev.created_at),
        "updated_at": isoformat_utc(ev.updated_at),
    })
}

/// Python `site_events._serialize_all`
async fn serialize_all(pool: &PgPool, rows: &[SiteEvent], allow_shadow: bool) -> Result<Vec<Value>> {
    let pids: HashSet<i32> = rows.iter().map(|e| e.plant_id).collect();
    let sns: HashSet<String> = rows.iter().filter_map(|e| e.device_sn.clone()).filter(|s| !s.is_empty()).collect();
    let iids: Vec<i32> = rows.iter().filter_map(|e| e.issue_id).collect::<HashSet<_>>().into_iter().collect();
    let (plants, inverters) = issues::names(pool, &pids, &sns).await?;
    let mut found: HashMap<i32, Issue> = HashMap::new();
    let mut hidden: HashSet<i32> = HashSet::new(); // shadow issues: engineers see neither their id nor their details
    if !iids.is_empty() {
        let list: Vec<Issue> = sqlx::query_as(&format!("SELECT {} FROM growatt_issues WHERE id = ANY($1)", issues::ISSUE_COLS))
            .bind(iids)
            .fetch_all(pool)
            .await?;
        for i in list {
            if allow_shadow || !i.shadow {
                found.insert(i.id, i);
            } else {
                hidden.insert(i.id);
            }
        }
    }
    Ok(rows.iter().map(|e| serialize(e, &plants, &inverters, &found, &hidden)).collect())
}

/// Filters of Python `site_events.list_events`
#[derive(Debug, Clone)]
pub struct EventFilter {
    pub plant_id: Option<i64>,
    pub event_type: Option<String>,
    pub device_sn: Option<String>,
    pub since: Option<NaiveDate>,
    pub until: Option<NaiveDate>,
    pub limit: usize,
    pub allow_shadow: bool,
}

/// Python `site_events.list_events`: events of `plant_ids` (None = every plant), newest first.
/// `since` / `until` match any day the event covers (`day` … `end_day`).
pub async fn list_events(pool: &PgPool, plant_ids: Option<&HashSet<i64>>, f: &EventFilter) -> Result<Value> {
    let scope: Option<Vec<i32>> = plant_ids.map(|s| s.iter().filter_map(|p| i32::try_from(*p).ok()).collect());
    let rows: Vec<SiteEvent> = sqlx::query_as(&format!(
        "SELECT {EVENT_COLS} FROM site_events WHERE ($1::int4[] IS NULL OR plant_id = ANY($1)) \
         AND ($2::int4 IS NULL OR plant_id = $2) AND ($3::text IS NULL OR event_type = $3) \
         AND ($4::text IS NULL OR device_sn = $4) AND ($5::date IS NULL OR day <= $5) \
         AND ($6::date IS NULL OR (day >= $7 AND COALESCE(end_day, day) >= $6)) \
         ORDER BY day DESC, id DESC"
    ))
    .bind(scope)
    .bind(f.plant_id.map(id32))
    .bind(f.event_type.clone().filter(|t| !t.is_empty()))
    .bind(f.device_sn.clone().filter(|s| !s.is_empty()))
    .bind(f.until)
    .bind(f.since)
    .bind(f.since.map(|s| s - Duration::days(MAX_SPAN_DAYS)))
    .fetch_all(pool)
    .await?;
    let total = rows.len();
    // Python `sum(cost)`: left to right, newest first
    let cost: Vec<f64> = rows.iter().filter_map(|e| e.cost_thb).collect();
    let mut by_type: BTreeMap<String, i64> = BTreeMap::new();
    for e in &rows {
        *by_type.entry(e.event_type.clone()).or_default() += 1;
    }
    let shown = &rows[..rows.len().min(f.limit)];
    Ok(json!({
        "total": total,
        "summary": {
            "by_type": by_type,
            "cost_thb": if cost.is_empty() { None } else { Some(py_round(cost.iter().fold(0.0, |a, b| a + b), 2)) },
            "costed": cost.len(),
        },
        "events": serialize_all(pool, shown, f.allow_shadow).await?,
        "types": EVENT_TYPES.iter().map(|(v, l)| json!({"value": v, "label": l})).collect::<Vec<_>>(),
    }))
}

/// Python `site_events.get_event`: the plant's event, else not found
pub async fn get_event(pool: &PgPool, plant_id: i64, event_id: i64) -> Result<SiteEvent> {
    let ev: Option<SiteEvent> = sqlx::query_as(&format!("SELECT {EVENT_COLS} FROM site_events WHERE id = $1"))
        .bind(id32(event_id))
        .fetch_optional(pool)
        .await?;
    match ev {
        Some(e) if i64::from(e.plant_id) == plant_id => Ok(e),
        _ => Err(ServiceError::NotFound(format!("Event {event_id} not found"))),
    }
}

/// Python `site_events.one`
pub async fn one(pool: &PgPool, ev: &SiteEvent, allow_shadow: bool) -> Result<Value> {
    Ok(serialize_all(pool, std::slice::from_ref(ev), allow_shadow).await?.remove(0))
}

// --------------------------------------------------------------------------- writing

/// Python `site_events._check`
#[allow(clippy::too_many_arguments)]
async fn check(
    conn: &mut PgConnection,
    plant_id: i32,
    event_type: &str,
    day: NaiveDate,
    end_day: Option<NaiveDate>,
    device_sn: Option<&str>,
    string_no: Option<i32>,
    cost_thb: Option<f64>,
) -> Result<()> {
    let bad = |m: String| Err(ServiceError::Invalid(m));
    if !EVENT_TYPES.iter().any(|(k, _)| *k == event_type) {
        return bad(format!("event_type must be one of {}", EVENT_TYPES.iter().map(|(k, _)| *k).collect::<Vec<_>>().join(", ")));
    }
    let today = today();
    if day > today {
        return bad("The date is in the future: record work once it is done".into());
    }
    if let Some(end) = end_day {
        if end < day {
            return bad("end_day is before day".into());
        }
        if end > today {
            return bad("end_day is in the future".into());
        }
        if (end - day).num_days() > MAX_SPAN_DAYS {
            return bad(format!("An event spans at most {MAX_SPAN_DAYS} days"));
        }
    }
    if string_no.is_some() && device_sn.is_none() {
        return bad("A string needs its inverter (device_sn)".into());
    }
    if let Some(sn) = device_sn {
        let inv: Option<String> = sqlx::query_scalar("SELECT device_sn FROM growatt_inverters WHERE plant_id = $1 AND device_sn = $2")
            .bind(plant_id)
            .bind(sn)
            .fetch_optional(&mut *conn)
            .await?;
        if inv.is_none() {
            return bad(format!("Inverter {sn} does not belong to plant {plant_id}"));
        }
    }
    if cost_thb.is_some_and(|c| c < 0.0) {
        return bad("cost_thb is negative".into());
    }
    Ok(())
}

/// Python `site_events._issue`: an issue of the plant the caller may see, else a 422 message
async fn linked_issue(conn: &mut PgConnection, plant_id: i32, issue_id: i64, allow_shadow: bool) -> Result<Issue> {
    match issues::get_issue_for_update(conn, issue_id).await? {
        Some(i) if i.plant_id == plant_id && (!i.shadow || allow_shadow) => Ok(i),
        _ => Err(ServiceError::Invalid(format!("Issue {issue_id} is not an issue of plant {plant_id}"))),
    }
}

/// Python `site_events._resolve_issue`: resolve the linked issue as confirmed, its note naming the event
async fn resolve_issue(conn: &mut PgConnection, i: &Issue, ev: &SiteEvent, username: &str) -> Result<()> {
    if !issues::ACTIVE.contains(&i.status.as_str()) {
        return Ok(()); // already closed: the link is kept, nothing to resolve
    }
    let mut note = format!("{} on {} (site event #{})", label(&ev.event_type), iso(ev.day), ev.id);
    if let Some(n) = ev.note.as_deref().filter(|n| !n.is_empty()) {
        note = format!("{note}: {n}");
    }
    if let Some(n) = i.note.as_deref().filter(|n| !n.is_empty()) {
        note = format!("{n}\n{note}");
    }
    let note: String = note.chars().take(2000).collect();
    issues::apply_action(conn, i, "resolve", username, Some(&note), Some("confirmed")).await?;
    Ok(())
}

/// The body of a POST (Python `SiteEventCreate.model_dump()`)
#[derive(Debug, Clone)]
pub struct NewEvent {
    pub event_type: String,
    pub day: NaiveDate,
    pub end_day: Option<NaiveDate>,
    pub device_sn: Option<String>,
    pub string_no: Option<i32>,
    pub cost_thb: Option<f64>,
    pub issue_id: Option<i64>,
    pub close_issue: bool,
    pub note: Option<String>,
}

fn clean_note(n: Option<&str>) -> Option<String> {
    let t = py_strip(n.unwrap_or(""));
    (!t.is_empty()).then(|| t.to_owned())
}

/// Python `site_events.create_event`: validate and store one event; `close_issue` resolves the
/// linked issue (feedback confirmed). One transaction.
pub async fn create_event(pool: &PgPool, plant_id: i64, p: &NewEvent, username: &str, allow_shadow: bool) -> Result<SiteEvent> {
    let mut tx = pool.begin().await?;
    let pid = id32(plant_id);
    let exists: Option<i32> =
        sqlx::query_scalar("SELECT plant_id FROM growatt_plants WHERE plant_id = $1").bind(pid).fetch_optional(&mut *tx).await?;
    if exists.is_none() {
        return Err(ServiceError::NotFound(format!("Plant {plant_id} not found")));
    }
    let end_day = p.end_day.filter(|e| *e != p.day);
    let device_sn = p.device_sn.clone().filter(|s| !s.is_empty());
    check(&mut tx, pid, &p.event_type, p.day, end_day, device_sn.as_deref(), p.string_no, p.cost_thb).await?;
    let issue = match p.issue_id {
        Some(id) => Some(linked_issue(&mut tx, pid, id, allow_shadow).await?),
        None if p.close_issue => return Err(ServiceError::Invalid("close_issue needs issue_id".into())),
        None => None,
    };
    let ev: SiteEvent = sqlx::query_as(&format!(
        "INSERT INTO site_events (plant_id, event_type, day, end_day, device_sn, string_no, cost_thb, issue_id, note, \
         created_by, updated_by, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10, now(), now()) \
         RETURNING {EVENT_COLS}"
    ))
    .bind(pid)
    .bind(&p.event_type)
    .bind(p.day)
    .bind(end_day)
    .bind(&device_sn)
    .bind(p.string_no)
    .bind(p.cost_thb)
    .bind(issue.as_ref().map(|i| i.id))
    .bind(clean_note(p.note.as_deref()))
    .bind(username)
    .fetch_one(&mut *tx)
    .await?;
    if let (Some(i), true) = (&issue, p.close_issue) {
        resolve_issue(&mut tx, i, &ev, username).await?;
    }
    tx.commit().await?;
    Ok(ev)
}

/// A PATCH body (Python `SiteEventPatch.changes()`): only the fields sent; `Some(None)` = sent as
/// null (clears an optional field). `event_type` / `day` sent as null are left out (unchanged).
#[derive(Debug, Clone, Default)]
pub struct EventChanges {
    pub event_type: Option<String>,
    pub day: Option<NaiveDate>,
    pub end_day: Option<Option<NaiveDate>>,
    pub device_sn: Option<Option<String>>,
    pub string_no: Option<Option<i32>>,
    pub cost_thb: Option<Option<f64>>,
    pub issue_id: Option<Option<i64>>,
    pub close_issue: Option<bool>,
    pub note: Option<Option<String>>,
}

impl EventChanges {
    /// `sorted(changes)`: the names of the fields sent
    pub fn keys(&self) -> Vec<&'static str> {
        let mut k = Vec::new();
        if self.close_issue.is_some() {
            k.push("close_issue");
        }
        if self.cost_thb.is_some() {
            k.push("cost_thb");
        }
        if self.day.is_some() {
            k.push("day");
        }
        if self.device_sn.is_some() {
            k.push("device_sn");
        }
        if self.end_day.is_some() {
            k.push("end_day");
        }
        if self.event_type.is_some() {
            k.push("event_type");
        }
        if self.issue_id.is_some() {
            k.push("issue_id");
        }
        if self.note.is_some() {
            k.push("note");
        }
        if self.string_no.is_some() {
            k.push("string_no");
        }
        k
    }
}

/// Python `site_events.update_event`: change the fields present in `changes` (null clears an
/// optional field). An engineer's `issue_id: null` keeps a link to a shadow issue they never saw.
/// One transaction.
pub async fn update_event(pool: &PgPool, ev: &SiteEvent, changes: &EventChanges, username: &str, allow_shadow: bool) -> Result<SiteEvent> {
    let mut tx = pool.begin().await?;
    let event_type = changes.event_type.clone().unwrap_or_else(|| ev.event_type.clone());
    let day = changes.day.unwrap_or(ev.day);
    let end_day = changes.end_day.unwrap_or(ev.end_day).filter(|e| *e != day);
    let device_sn = changes.device_sn.clone().unwrap_or_else(|| ev.device_sn.clone()).filter(|s| !s.is_empty());
    let mut string_no = changes.string_no.unwrap_or(ev.string_no);
    if changes.device_sn.is_some() && device_sn.is_none() && changes.string_no.is_none() {
        string_no = None; // the inverter was cleared: so is its string
    }
    let cost = changes.cost_thb.unwrap_or(ev.cost_thb);
    check(&mut tx, ev.plant_id, &event_type, day, end_day, device_sn.as_deref(), string_no, cost).await?;
    let mut issue_change = changes.issue_id;
    if !allow_shadow && issue_change == Some(None) {
        if let Some(cur) = ev.issue_id {
            let shadow: Option<bool> =
                sqlx::query_scalar("SELECT shadow FROM growatt_issues WHERE id = $1").bind(cur).fetch_optional(&mut *tx).await?;
            if shadow == Some(true) {
                issue_change = None; // they never saw the link: keep it
            }
        }
    }
    let close = changes.close_issue == Some(true);
    let mut issue: Option<Issue> = None;
    let mut issue_id = ev.issue_id;
    if let Some(change) = issue_change {
        if let Some(id) = change {
            issue = Some(linked_issue(&mut tx, ev.plant_id, id, allow_shadow).await?);
        }
        issue_id = issue.as_ref().map(|i| i.id);
    } else if let (Some(cur), true) = (ev.issue_id, close) {
        issue = Some(linked_issue(&mut tx, ev.plant_id, i64::from(cur), allow_shadow).await?);
    }
    if close && issue.is_none() {
        return Err(ServiceError::Invalid("close_issue needs issue_id".into()));
    }
    let note = match &changes.note {
        Some(n) => clean_note(n.as_deref()),
        None => ev.note.clone(),
    };
    let mut n = ev.clone();
    n.event_type = event_type;
    n.day = day;
    n.end_day = end_day;
    n.device_sn = device_sn;
    n.string_no = string_no;
    n.cost_thb = cost;
    n.issue_id = issue_id;
    n.note = note;
    n.updated_by = Some(username.to_owned());
    let saved = if n == *ev {
        n // SQLAlchemy issues no UPDATE (updated_at kept) when nothing changed
    } else {
        sqlx::query_as(&format!(
            "UPDATE site_events SET event_type = $2, day = $3, end_day = $4, device_sn = $5, string_no = $6, cost_thb = $7, \
             issue_id = $8, note = $9, updated_by = $10, updated_at = now() WHERE id = $1 RETURNING {EVENT_COLS}"
        ))
        .bind(ev.id)
        .bind(&n.event_type)
        .bind(n.day)
        .bind(n.end_day)
        .bind(&n.device_sn)
        .bind(n.string_no)
        .bind(n.cost_thb)
        .bind(n.issue_id)
        .bind(&n.note)
        .bind(username)
        .fetch_one(&mut *tx)
        .await?
    };
    if let (Some(i), true) = (&issue, close) {
        resolve_issue(&mut tx, i, &saved, username).await?;
    }
    tx.commit().await?;
    Ok(saved)
}

/// Python `site_events.delete_event`: a resolved linked issue stays resolved (its note names the event)
pub async fn delete_event(pool: &PgPool, ev: &SiteEvent) -> Result<()> {
    sqlx::query("DELETE FROM site_events WHERE id = $1").bind(ev.id).execute(pool).await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn labels_and_keys() {
        assert_eq!(label("ir_flight"), "IR flight");
        assert_eq!(label("unknown"), "unknown");
        let c = EventChanges { note: Some(None), day: Some(today()), close_issue: Some(false), ..Default::default() };
        assert_eq!(c.keys(), vec!["close_issue", "day", "note"]);
    }
}
