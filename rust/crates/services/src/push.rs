//! Alarm push notifications over Firebase Cloud Messaging (web push), ported from
//! backend/app/services/push.py (the worker's side: `notify_new_alarms`, `send_tests`, `_send`).
//!
//! Alarm events that are new in the stored alarm log (`growatt_alarms`, Growatt's own start
//! times) go to the devices of the users who may see the plant (admins: every plant, engineers:
//! their assigned plants). Only bookkeeping is written: `push_tokens` (a token FCM reports as gone
//! is deleted, test requests are cleared) and `alarm_push_marks` (what was already pushed).
//! Messages are data-only. Tokens are never logged.
//!
//! The sender is a trait ([`Sender`]): [`FcmSender`] sends over FCM HTTP v1
//! (`tcroof_clients::fcm`), [`RecordingSender`] records the messages and answers from a rule
//! (tests, the "push (fake sender)" exit gate).

use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, Mutex};

use chrono::{DateTime, Duration, NaiveDate, NaiveDateTime, Utc};
use serde_json::{json, Map, Value};
use sqlx::PgPool;
use tcroof_clients::fcm::{FcmClient, FcmMessage};

use crate::alarms::plant_tz;
use crate::common::{Inverter, INVERTER_COLS};
use crate::devices::inverter_label;

/// push.py `Msg`
pub type Msg = FcmMessage;
/// push.py `GONE`: FCM no longer knows the token
pub const GONE: &str = tcroof_clients::fcm::GONE;
/// push.py `TTL_S`: a device offline longer than this does not get the push late
pub const TTL_S: u64 = 3600;
/// push.py `TEST_MAX_AGE` (minutes): a test asked for longer ago (worker was down) is dropped
pub const TEST_MAX_AGE_MIN: i64 = 10;
/// push.py `EVENT_GAP` (minutes): Growatt re-reports a present alarm every ~5 min
pub const EVENT_GAP_MIN: i64 = 10;
/// push.py `BODY_LINES`
pub const BODY_LINES: usize = 3;
/// push.py `LEVELS`
pub const LEVELS: [&str; 3] = ["fault", "warning", "info"];
/// push.py's `skipped` reason without a sender
pub const SKIPPED: &str = "FIREBASE_CREDENTIALS_FILE is not set";
const LOG: &str = "app.services.push";

/// A push failure that ends the step (Python raises; `jobs._push` reports `"{class}: {message}"`).
#[derive(Debug, Clone, thiserror::Error)]
#[error("{kind}: {message}")]
pub struct PushError {
    pub kind: String,
    pub message: String,
}

impl PushError {
    pub fn new(kind: &str, message: impl Into<String>) -> PushError {
        PushError { kind: kind.to_owned(), message: message.into() }
    }
}

impl From<sqlx::Error> for PushError {
    fn from(e: sqlx::Error) -> Self {
        PushError::new("DatabaseError", e.to_string())
    }
}

impl From<tcroof_clients::google_auth::GoogleAuthError> for PushError {
    fn from(e: tcroof_clients::google_auth::GoogleAuthError) -> Self {
        PushError::new(e.py_kind(), e.to_string())
    }
}

// ---- settings ----------------------------------------------------------------------------------

/// The push settings of backend/app/config.py (`PUSH_*`), with Python's defaults.
#[derive(Debug, Clone)]
pub struct PushSettings {
    pub alarm_levels: String,
    pub alarm_max_age_min: i64,
    pub alarm_repeat_min: i64,
    pub max_plants_per_user: i64,
}

impl Default for PushSettings {
    fn default() -> Self {
        PushSettings { alarm_levels: "fault".into(), alarm_max_age_min: 90, alarm_repeat_min: 120, max_plants_per_user: 5 }
    }
}

impl PushSettings {
    /// push.py `levels`: the pushed levels (`PUSH_ALARM_LEVELS`), in severity order
    pub fn levels(&self) -> Vec<&'static str> {
        let chosen: HashSet<String> = self.alarm_levels.split(',').map(|p| p.trim().to_lowercase()).collect();
        LEVELS.iter().copied().filter(|l| chosen.contains(*l)).collect()
    }
}

/// push.py `level_of`: Growatt's `fault_type` label → level (same rule as the UI's `alarmLevel`)
pub fn level_of(fault_type: Option<&str>) -> &'static str {
    let s = fault_type.unwrap_or("").to_lowercase();
    if s.contains("fault") || s.contains("error") || s.contains("fail") {
        "fault"
    } else if s.contains("warn") {
        "warning"
    } else {
        "info"
    }
}

// ---- senders -----------------------------------------------------------------------------------

pub type SendFuture<'a> = Pin<Box<dyn Future<Output = Result<Vec<Option<String>>, PushError>> + Send + 'a>>;

/// push.py `Sender`: one result per message, `None` = accepted, [`GONE`] = token no longer
/// registered, else an error name. An `Err` is a failure of the whole send (Python raises).
pub trait Sender: Send + Sync {
    fn send<'a>(&'a self, msgs: &'a [Msg]) -> SendFuture<'a>;
}

/// push.py `firebase_sender`: FCM HTTP v1 as the service account.
pub struct FcmSender(pub FcmClient);

impl Sender for FcmSender {
    fn send<'a>(&'a self, msgs: &'a [Msg]) -> SendFuture<'a> {
        Box::pin(async move {
            self.0.send_each(msgs).await.map_err(|e| {
                // firebase_admin wraps a credentials failure inside send_each as UnknownError
                PushError::new("UnknownError", format!("Unknown error while making remote service calls: {e}"))
            })
        })
    }
}

type Rule = Box<dyn Fn(&Msg) -> Option<String> + Send + Sync>;
/// A message's data (string values, in order)
pub type Data = Vec<(String, String)>;

/// A fake sender for tests: records every message and answers each with `rule(msg)`.
pub struct RecordingSender {
    pub sent: Mutex<Vec<Msg>>,
    rule: Rule,
    fail: Option<PushError>,
}

impl RecordingSender {
    /// accepts every message
    pub fn ok() -> RecordingSender {
        RecordingSender::with_rule(|_| None)
    }

    pub fn with_rule(rule: impl Fn(&Msg) -> Option<String> + Send + Sync + 'static) -> RecordingSender {
        RecordingSender { sent: Mutex::new(Vec::new()), rule: Box::new(rule), fail: None }
    }

    /// every send fails as a whole (FCM unreachable), nothing recorded
    pub fn failing(e: PushError) -> RecordingSender {
        RecordingSender { sent: Mutex::new(Vec::new()), rule: Box::new(|_| None), fail: Some(e) }
    }

    pub fn messages(&self) -> Vec<Msg> {
        self.sent.lock().expect("recording sender").clone()
    }
}

impl Sender for RecordingSender {
    fn send<'a>(&'a self, msgs: &'a [Msg]) -> SendFuture<'a> {
        Box::pin(async move {
            if let Some(e) = &self.fail {
                return Err(e.clone());
            }
            self.sent.lock().expect("recording sender").extend(msgs.iter().cloned());
            Ok(msgs.iter().map(|m| (self.rule)(m)).collect())
        })
    }
}

/// Where the sender comes from: push.py `_sender(sender)` (a given one, else FCM when
/// FIREBASE_CREDENTIALS_FILE is set, else none). Resolved only when something is to be sent,
/// as in Python, so a bad key file fails only then.
#[derive(Clone)]
pub enum SenderSource {
    None,
    Given(Arc<dyn Sender>),
    Fcm { base_url: String, project_id: String, creds_file: String },
}

impl SenderSource {
    pub fn fcm(base_url: &str, project_id: &str, creds_file: &str) -> SenderSource {
        if creds_file.is_empty() {
            SenderSource::None
        } else {
            SenderSource::Fcm { base_url: base_url.to_owned(), project_id: project_id.to_owned(), creds_file: creds_file.to_owned() }
        }
    }

    pub fn resolve(&self) -> Result<Option<Arc<dyn Sender>>, PushError> {
        Ok(match self {
            SenderSource::None => None,
            SenderSource::Given(s) => Some(s.clone()),
            SenderSource::Fcm { base_url, project_id, creds_file } => {
                Some(Arc::new(FcmSender(FcmClient::new(base_url, project_id, creds_file, TTL_S)?)))
            }
        })
    }
}

/// push.py `_send` counts
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Counts {
    pub sent: i64,
    pub failed: i64,
    pub removed: i64,
}

impl Counts {
    pub fn insert_into(&self, m: &mut Map<String, Value>) {
        m.insert("sent".into(), json!(self.sent));
        m.insert("failed".into(), json!(self.failed));
        m.insert("removed".into(), json!(self.removed));
    }
}

/// push.py `_send` / `_send_each`: send, delete the tokens FCM no longer knows, count the outcomes.
pub async fn send(pool: &PgPool, sender: &dyn Sender, msgs: &[Msg]) -> Result<Counts, PushError> {
    let results = sender.send(msgs).await?;
    let gone: Vec<String> = {
        let s: HashSet<&str> = msgs.iter().zip(&results).filter(|(_, r)| r.as_deref() == Some(GONE)).map(|(m, _)| m.token.as_str()).collect();
        s.into_iter().map(str::to_owned).collect()
    };
    if !gone.is_empty() {
        sqlx::query("DELETE FROM push_tokens WHERE token = ANY($1)").bind(&gone).execute(pool).await?;
    }
    let failed: Vec<&str> = results.iter().filter_map(|r| r.as_deref()).filter(|r| *r != GONE).collect();
    if !failed.is_empty() {
        let mut names: Vec<&str> = failed.iter().copied().collect::<HashSet<_>>().into_iter().collect();
        names.sort_unstable();
        tracing::warn!(target: LOG, "push: {} of {} messages failed ({})", failed.len(), msgs.len(), names.join(", "));
    }
    Ok(Counts { sent: results.iter().filter(|r| r.is_none()).count() as i64, failed: failed.len() as i64, removed: gone.len() as i64 })
}

fn data(pairs: &[(&str, String)]) -> Vec<(String, String)> {
    pairs.iter().map(|(k, v)| ((*k).to_owned(), v.clone())).collect()
}

// ---- new alarm events --------------------------------------------------------------------------

/// push.py `Event`
#[derive(Debug, Clone)]
pub struct Event {
    pub plant_id: i32,
    pub device_sn: String,
    /// "" = Growatt gave no code
    pub code: String,
    pub message: Option<String>,
    pub fault_type: Option<String>,
    /// plant-local, as Growatt reports it
    pub start: NaiveDateTime,
    pub last: NaiveDateTime,
    pub reports: i64,
}

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct AlarmRow {
    pub plant_id: i32,
    pub device_sn: String,
    pub alarm_code: Option<String>,
    pub alarm_message: Option<String>,
    pub fault_type: Option<String>,
    pub start_time: Option<NaiveDateTime>,
}

/// push.py `_latest_events`: the newest event of each inverter + code (its records ≤ EVENT_GAP
/// apart), from rows ordered by inverter, code and start time; in the order the keys first appear.
pub fn latest_events(rows: &[AlarmRow]) -> Vec<Event> {
    let mut order: Vec<(String, String)> = Vec::new();
    let mut latest: HashMap<(String, String), Event> = HashMap::new();
    let gap = Duration::minutes(EVENT_GAP_MIN);
    for a in rows {
        let Some(start) = a.start_time else { continue };
        let key = (a.device_sn.clone(), a.alarm_code.clone().unwrap_or_default());
        match latest.get_mut(&key) {
            Some(ev) if start - ev.last <= gap => {
                ev.last = start;
                ev.reports += 1;
                // Python `a.alarm_message or ev.message`: an empty string does not replace
                ev.message = a.alarm_message.clone().filter(|s| !s.is_empty()).or(ev.message.take());
                ev.fault_type = a.fault_type.clone().filter(|s| !s.is_empty()).or(ev.fault_type.take());
            }
            existing => {
                if existing.is_none() {
                    order.push(key.clone());
                }
                let ev = Event {
                    plant_id: a.plant_id,
                    device_sn: a.device_sn.clone(),
                    code: key.1.clone(),
                    message: a.alarm_message.clone(),
                    fault_type: a.fault_type.clone(),
                    start,
                    last: start,
                    reports: 1,
                };
                latest.insert(key, ev);
            }
        }
    }
    order.into_iter().filter_map(|k| latest.remove(&k)).collect()
}

/// push.py `_fresh_events`: events of the inverters just read that nobody was told about: of a
/// pushed level, still reported within `push_alarm_max_age_min`, newer than the inverter + code's
/// last push, and that push at least `push_alarm_repeat_min` ago.
pub async fn fresh_events(pool: &PgPool, cfg: &PushSettings, day: NaiveDate, sns: &[String], now: DateTime<Utc>) -> Result<Vec<Event>, PushError> {
    if sns.is_empty() {
        return Ok(Vec::new());
    }
    let wanted = cfg.levels();
    let rows: Vec<AlarmRow> = sqlx::query_as(
        "SELECT plant_id, device_sn, alarm_code, alarm_message, fault_type, start_time FROM growatt_alarms \
         WHERE day = $1 AND device_sn = ANY($2) ORDER BY device_sn, alarm_code, start_time",
    )
    .bind(day)
    .bind(sns)
    .fetch_all(pool)
    .await?;
    let marks: HashMap<(String, String), (NaiveDateTime, DateTime<Utc>)> = sqlx::query_as::<_, (String, String, NaiveDateTime, DateTime<Utc>)>(
        "SELECT device_sn, alarm_code, event_start, pushed_at FROM alarm_push_marks WHERE day = $1 AND device_sn = ANY($2)",
    )
    .bind(day)
    .bind(sns)
    .fetch_all(pool)
    .await?
    .into_iter()
    .map(|(sn, code, start, at)| ((sn, code), (start, at)))
    .collect();
    let now_local = now.with_timezone(&plant_tz()).naive_local();
    let oldest = now_local - Duration::minutes(cfg.alarm_max_age_min);
    let repeat = Duration::minutes(cfg.alarm_repeat_min);
    Ok(latest_events(&rows)
        .into_iter()
        .filter(|ev| wanted.contains(&level_of(ev.fault_type.as_deref())) && ev.last >= oldest)
        .filter(|ev| match marks.get(&(ev.device_sn.clone(), ev.code.clone())) {
            Some((event_start, pushed_at)) => !(ev.start <= *event_start || now - *pushed_at < repeat),
            None => true,
        })
        .collect())
}

/// push.py `_mark`
async fn mark(pool: &PgPool, day: NaiveDate, events: &[Event], now: DateTime<Utc>) -> Result<(), PushError> {
    let mut tx = pool.begin().await?;
    for ev in events {
        sqlx::query(
            "INSERT INTO alarm_push_marks (device_sn, alarm_code, day, event_start, pushed_at) VALUES ($1, $2, $3, $4, $5) \
             ON CONFLICT (device_sn, alarm_code, day) DO UPDATE SET event_start = EXCLUDED.event_start, pushed_at = EXCLUDED.pushed_at",
        )
        .bind(&ev.device_sn)
        .bind(&ev.code)
        .bind(day)
        .bind(ev.start)
        .bind(now)
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;
    Ok(())
}

/// push.py `_recipients`: per active user with a device: (plants they may see, None = all; tokens)
async fn recipients(pool: &PgPool) -> Result<Vec<(Option<HashSet<i32>>, Vec<String>)>, PushError> {
    let rows: Vec<(String, i32, String)> =
        sqlx::query_as("SELECT t.token, u.id, u.role FROM push_tokens t JOIN users u ON u.id = t.user_id WHERE u.is_active IS true")
            .fetch_all(pool)
            .await?;
    let mut order: Vec<i32> = Vec::new();
    let mut tokens: HashMap<i32, Vec<String>> = HashMap::new();
    let mut roles: HashMap<i32, String> = HashMap::new();
    for (token, uid, role) in rows {
        if !tokens.contains_key(&uid) {
            order.push(uid);
        }
        tokens.entry(uid).or_default().push(token);
        roles.insert(uid, role);
    }
    let engineers: Vec<i32> = order.iter().copied().filter(|u| roles[u] != "admin").collect();
    let mut assigned: HashMap<i32, HashSet<i32>> = engineers.iter().map(|u| (*u, HashSet::new())).collect();
    if !engineers.is_empty() {
        let pairs: Vec<(i32, i32)> = sqlx::query_as("SELECT user_id, plant_id FROM user_plant_assignments WHERE user_id = ANY($1)")
            .bind(&engineers)
            .fetch_all(pool)
            .await?;
        for (u, p) in pairs {
            assigned.entry(u).or_default().insert(p);
        }
    }
    Ok(order
        .into_iter()
        .map(|u| (if roles[&u] == "admin" { None } else { assigned.remove(&u) }, tokens.remove(&u).unwrap_or_default()))
        .collect())
}

/// push.py `_plant_messages`: plant_id → (plant name, notification) for the plants with fresh
/// events, in the order the plants first appear.
async fn plant_messages(pool: &PgPool, events: &[Event]) -> Result<Vec<(i32, String, Vec<(String, String)>)>, PushError> {
    let mut order: Vec<i32> = Vec::new();
    let mut by_plant: HashMap<i32, Vec<Event>> = HashMap::new();
    for ev in events {
        if !by_plant.contains_key(&ev.plant_id) {
            order.push(ev.plant_id);
        }
        by_plant.entry(ev.plant_id).or_default().push(ev.clone());
    }
    let names: HashMap<i32, Option<String>> = sqlx::query_as::<_, (i32, Option<String>)>("SELECT plant_id, name FROM growatt_plants WHERE plant_id = ANY($1)")
        .bind(&order)
        .fetch_all(pool)
        .await?
        .into_iter()
        .collect();
    // installed only, so a plant's sole real inverter still reads "INV1" next to a marked one
    let invs: Vec<Inverter> = sqlx::query_as(&format!(
        "SELECT {INVERTER_COLS} FROM growatt_inverters WHERE plant_id = ANY($1) AND not_installed_at IS NULL"
    ))
    .bind(&order)
    .fetch_all(pool)
    .await?;
    let mut inverters: HashMap<i32, Vec<Inverter>> = HashMap::new();
    for i in invs {
        inverters.entry(i.plant_id).or_default().push(i);
    }
    let mut out = Vec::new();
    for pid in order {
        let mut evs = by_plant.remove(&pid).unwrap_or_default();
        let empty = Vec::new();
        let invs = inverters.get(&pid).unwrap_or(&empty);
        let label: HashMap<&str, String> = invs.iter().map(|i| (i.device_sn.as_str(), inverter_label(i, invs.len() == 1))).collect();
        evs.sort_by(|a, b| {
            (level_of(a.fault_type.as_deref()) != "fault", a.start, &a.device_sn).cmp(&(level_of(b.fault_type.as_deref()) != "fault", b.start, &b.device_sn))
        });
        let mut lines: Vec<String> = evs
            .iter()
            .take(BODY_LINES)
            .map(|e| {
                let ft = e.fault_type.as_deref().filter(|s| !s.is_empty()).unwrap_or("Alarm");
                [
                    label.get(e.device_sn.as_str()).cloned().unwrap_or_else(|| e.device_sn.clone()),
                    format!("{ft}:"),
                    e.code.clone(),
                    e.message.clone().unwrap_or_default(),
                    format!("({})", e.start.format("%H:%M")),
                ]
                .into_iter()
                .filter(|p| !p.is_empty())
                .collect::<Vec<_>>()
                .join(" ")
            })
            .collect();
        if evs.len() > BODY_LINES {
            lines.push(format!("+{} more", evs.len() - BODY_LINES));
        }
        let name = names.get(&pid).cloned().flatten().filter(|n| !n.is_empty()).unwrap_or_else(|| format!("Plant {pid}"));
        let d = data(&[
            ("title", format!("Alarm · {name}")),
            ("body", lines.join("\n")),
            ("url", format!("/alarms?plant={pid}")),
            ("tag", format!("plant-{pid}")),
        ]);
        out.push((pid, name, d));
    }
    Ok(out)
}

/// push.py `_summary`
fn summary(names: &[String]) -> Vec<(String, String)> {
    let shown = names.iter().take(BODY_LINES).cloned().collect::<Vec<_>>().join(", ");
    let more = if names.len() > BODY_LINES { format!(" +{} more", names.len() - BODY_LINES) } else { String::new() };
    data(&[
        ("title", format!("New alarms at {} plants", names.len())),
        ("body", shown + &more),
        ("url", "/alarms".into()),
        ("tag", "fleet".into()),
    ])
}

/// push.py `notify_new_alarms`: push the alarm events that are new in the inverter logs read since
/// `since` (UTC, the `alarms` run's start). One notification per plant and device; a user with
/// more than `push_max_plants_per_user` plants in one run gets one summary instead.
pub async fn notify_new_alarms(
    pool: &PgPool,
    cfg: &PushSettings,
    day: NaiveDate,
    since: DateTime<Utc>,
    source: &SenderSource,
    now: DateTime<Utc>,
) -> Result<Map<String, Value>, PushError> {
    let devices: i64 = sqlx::query_scalar("SELECT count(*) FROM push_tokens").fetch_one(pool).await?;
    let mut d = Map::new();
    d.insert("devices".into(), json!(devices));
    if devices == 0 {
        return Ok(d);
    }
    let Some(sender) = source.resolve()? else {
        d.insert("skipped".into(), json!(SKIPPED));
        return Ok(d);
    };
    let sns: Vec<String> = sqlx::query_scalar("SELECT device_sn FROM growatt_alarm_syncs WHERE day = $1 AND synced_at >= $2")
        .bind(day)
        .bind(since)
        .fetch_all(pool)
        .await?;
    let fresh = fresh_events(pool, cfg, day, &sns, now).await?;
    if fresh.is_empty() {
        d.insert("events".into(), json!(0));
        return Ok(d);
    }
    let plants = plant_messages(pool, &fresh).await?;
    let by_pid: HashMap<i32, (&String, &Data)> = plants.iter().map(|(p, n, m)| (*p, (n, m))).collect();
    let mut msgs: Vec<Msg> = Vec::new();
    for (allowed, tokens) in recipients(pool).await? {
        let mut mine: Vec<i32> = plants.iter().map(|(p, _, _)| *p).filter(|p| allowed.as_ref().is_none_or(|a| a.contains(p))).collect();
        mine.sort_unstable();
        if mine.is_empty() {
            continue;
        }
        let payloads: Vec<Vec<(String, String)>> = if mine.len() as i64 > cfg.max_plants_per_user {
            let mut names: Vec<String> = mine.iter().map(|p| by_pid[p].0.clone()).collect();
            names.sort();
            vec![summary(&names)]
        } else {
            mine.iter().map(|p| by_pid[p].1.clone()).collect()
        };
        for token in &tokens {
            for p in &payloads {
                msgs.push(Msg { token: token.clone(), data: p.clone() });
            }
        }
    }
    let counts = if msgs.is_empty() { Counts::default() } else { send(pool, sender.as_ref(), &msgs).await? };
    // after the send: if it failed (FCM unreachable), the next run tries these events again
    mark(pool, day, &fresh, now).await?;
    d.insert("events".into(), json!(fresh.len()));
    d.insert("plants".into(), json!(plants.len()));
    counts.insert_into(&mut d);
    tracing::info!(
        target: LOG,
        "push: {} new alarm events at {} plants, {} sent, {} failed, {} tokens removed",
        fresh.len(),
        plants.len(),
        counts.sent,
        counts.failed,
        counts.removed
    );
    Ok(d)
}

/// push.py `send_tests`: send the test notifications asked for with POST /push/test and clear
/// the requests (a request older than TEST_MAX_AGE is cleared without a send).
pub async fn send_tests(pool: &PgPool, source: &SenderSource, now: DateTime<Utc>) -> Result<Map<String, Value>, PushError> {
    let rows: Vec<(i32, String, DateTime<Utc>)> = sqlx::query_as(
        "SELECT t.id, t.token, t.test_requested_at FROM push_tokens t JOIN users u ON u.id = t.user_id \
         WHERE t.test_requested_at IS NOT NULL AND u.is_active IS true",
    )
    .fetch_all(pool)
    .await?;
    let mut d = Map::new();
    if rows.is_empty() {
        d.insert("tests".into(), json!(0));
        return Ok(d);
    }
    let sender = source.resolve()?;
    let due: Vec<String> =
        rows.iter().filter(|(_, _, asked)| now - *asked <= Duration::minutes(TEST_MAX_AGE_MIN)).map(|(_, t, _)| t.clone()).collect();
    let ids: Vec<i32> = rows.iter().map(|(id, _, _)| *id).collect();
    sqlx::query("UPDATE push_tokens SET test_requested_at = NULL WHERE id = ANY($1)").bind(&ids).execute(pool).await?;
    d.insert("tests".into(), json!(due.len()));
    let Some(sender) = sender else {
        d.insert("skipped".into(), json!(SKIPPED));
        return Ok(d);
    };
    let payload = data(&[
        ("title", "Test notification".into()),
        ("body", "Alarm notifications work on this device.".into()),
        ("url", "/alarms".into()),
        ("tag", "test".into()),
    ]);
    let msgs: Vec<Msg> = due.into_iter().map(|t| Msg { token: t, data: payload.clone() }).collect();
    let counts = if msgs.is_empty() { Counts::default() } else { send(pool, sender.as_ref(), &msgs).await? };
    counts.insert_into(&mut d);
    Ok(d)
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::NaiveDate;

    fn t(h: u32, m: u32) -> NaiveDateTime {
        NaiveDate::from_ymd_opt(2026, 11, 28).unwrap().and_hms_opt(h, m, 0).unwrap()
    }

    fn row(sn: &str, code: Option<&str>, at: NaiveDateTime, msg: Option<&str>, ft: Option<&str>) -> AlarmRow {
        AlarmRow {
            plant_id: 1,
            device_sn: sn.into(),
            alarm_code: code.map(Into::into),
            alarm_message: msg.map(Into::into),
            fault_type: ft.map(Into::into),
            start_time: Some(at),
        }
    }

    #[test]
    fn levels_like_python() {
        assert_eq!(level_of(Some("Fault")), "fault");
        assert_eq!(level_of(Some("PV ERROR")), "fault");
        assert_eq!(level_of(Some("Warning")), "warning");
        assert_eq!(level_of(None), "info");
        let c = PushSettings { alarm_levels: " Info , fault,nope".into(), ..Default::default() };
        assert_eq!(c.levels(), ["fault", "info"]);
    }

    #[test]
    fn events_join_records_within_the_gap() {
        let rows = vec![
            row("A", Some("1"), t(8, 0), Some("first"), Some("Fault")),
            row("A", Some("1"), t(8, 5), Some(""), None),
            row("A", Some("1"), t(8, 15), None, None),
            row("A", Some("1"), t(9, 0), Some("new"), Some("Warning")),
            row("A", None, t(8, 0), None, None),
            row("B", Some("2"), t(7, 0), None, None),
        ];
        let evs = latest_events(&rows);
        assert_eq!(evs.len(), 3);
        assert_eq!((evs[0].code.as_str(), evs[0].start, evs[0].reports), ("1", t(9, 0), 1));
        assert_eq!(evs[1].code, "");
        assert_eq!(evs[2].device_sn, "B");
        let joined = latest_events(&rows[..3]);
        assert_eq!((joined[0].last, joined[0].reports, joined[0].message.as_deref()), (t(8, 15), 3, Some("first")));
    }

    #[test]
    fn summary_lists_three_names() {
        let names: Vec<String> = ["a", "b", "c", "d", "e"].iter().map(|s| s.to_string()).collect();
        let s = summary(&names);
        assert_eq!(s[0].1, "New alarms at 5 plants");
        assert_eq!(s[1].1, "a, b, c +2 more");
    }
}
