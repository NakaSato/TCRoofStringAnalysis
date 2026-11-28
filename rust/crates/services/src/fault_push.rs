//! Field fault notifications over the alarm push channel, ported from
//! backend/app/services/fault_push.py `notify_s1` (docs/plans/defects.md §9).
//!
//! `faults_push` (queued by the API when a fault is recorded as S1 or raised to it, and flushed by
//! every `alarms` run): one notification per S1 fault to the devices of everyone who may see its
//! plant (admins and the engineers assigned to it), except the person who raised it.
//! `field_faults.s1_pushed_at` keeps it to once; a fault that became S1 more than `S1_MAX_AGE_H`
//! ago is no longer pushed. (`fault_followups` of `om_weekly` is ported with Phase 6.)

use std::collections::{HashMap, HashSet};

use chrono::{DateTime, Duration, Utc};
use serde_json::{json, Map, Value};
use sqlx::PgPool;

use crate::push::{self, Counts, Msg, PushError, SenderSource, SKIPPED};

/// fault_push.py `S1_MAX_AGE` (hours)
pub const S1_MAX_AGE_H: i64 = 6;
/// faults.py `ACTIVE`
pub const ACTIVE: [&str; 5] = ["open", "diagnosed", "waiting", "scheduled", "monitor"];
const LOG: &str = "app.services.fault_push";

#[derive(Debug, Clone, sqlx::FromRow)]
struct S1Fault {
    id: i32,
    no: String,
    plant_id: i32,
    kind: String,
    serial: Option<String>,
    position: Option<Value>,
    symptom: String,
    s1_at: DateTime<Utc>,
    created_by: Option<String>,
    updated_by: Option<String>,
}

/// Python truthiness of an optional string
fn truthy(s: &Option<String>) -> Option<&str> {
    s.as_deref().filter(|s| !s.is_empty())
}

/// fault_push.py `_s1_message`
fn s1_message(f: &S1Fault, plant: Option<&str>) -> Vec<(String, String)> {
    let location = f.position.as_ref().and_then(|p| p.get("location")).and_then(Value::as_str).filter(|s| !s.is_empty());
    let place = truthy(&f.serial).or(location).unwrap_or("");
    let symptom: String = f.symptom.chars().take(120).collect();
    let body = [format!("{} {}", f.no, f.kind.replace('_', " ")), place.to_owned(), symptom]
        .into_iter()
        .filter(|x| !x.is_empty())
        .collect::<Vec<_>>()
        .join(" · ");
    let plant = plant.filter(|p| !p.is_empty()).map(str::to_owned).unwrap_or_else(|| format!("plant {}", f.plant_id));
    vec![
        ("title".into(), format!("S1 safety fault · {plant}")),
        ("body".into(), body),
        ("url".into(), format!("/faults?fault={}", f.id)),
        ("tag".into(), format!("fault-{}", f.id)),
    ]
}

/// fault_push.py `notify_s1`: push the S1 faults not pushed yet, then mark them.
pub async fn notify_s1(pool: &PgPool, source: &SenderSource, now: DateTime<Utc>) -> Result<Map<String, Value>, PushError> {
    let all: Vec<S1Fault> = sqlx::query_as(
        "SELECT id, no, plant_id, kind, serial, position::jsonb AS position, symptom, s1_at, created_by, updated_by \
         FROM field_faults WHERE severity = 'S1' AND s1_pushed_at IS NULL AND s1_at IS NOT NULL AND status = ANY($1)",
    )
    .bind(&ACTIVE[..])
    .fetch_all(pool)
    .await?;
    let rows: Vec<S1Fault> = all.into_iter().filter(|f| now - f.s1_at <= Duration::hours(S1_MAX_AGE_H)).collect();
    let mut d = Map::new();
    d.insert("s1_faults".into(), json!(rows.len()));
    if rows.is_empty() {
        return Ok(d);
    }
    let Some(sender) = source.resolve()? else {
        d.insert("skipped".into(), json!(SKIPPED));
        return Ok(d);
    };
    // per user: (role, login name) and tokens, in the order the users first appear
    let urows: Vec<(String, i32, String, Option<String>, String)> = sqlx::query_as(
        "SELECT t.token, u.id, u.role, u.username, u.email FROM push_tokens t JOIN users u ON u.id = t.user_id WHERE u.is_active IS true",
    )
    .fetch_all(pool)
    .await?;
    let mut order: Vec<i32> = Vec::new();
    let mut users: HashMap<i32, (String, String)> = HashMap::new();
    let mut tokens: HashMap<i32, Vec<String>> = HashMap::new();
    for (token, uid, role, name, email) in urows {
        if !tokens.contains_key(&uid) {
            order.push(uid);
        }
        tokens.entry(uid).or_default().push(token);
        users.insert(uid, (role, truthy(&name).map(str::to_owned).unwrap_or(email)));
    }
    let plant_ids: Vec<i32> = rows.iter().map(|f| f.plant_id).collect::<HashSet<_>>().into_iter().collect();
    let mut assigned: HashMap<i32, HashSet<i32>> = HashMap::new();
    let pairs: Vec<(i32, i32)> = sqlx::query_as("SELECT user_id, plant_id FROM user_plant_assignments WHERE plant_id = ANY($1)")
        .bind(&plant_ids)
        .fetch_all(pool)
        .await?;
    for (u, p) in pairs {
        assigned.entry(p).or_default().insert(u);
    }
    let names: HashMap<i32, Option<String>> =
        sqlx::query_as::<_, (i32, Option<String>)>("SELECT plant_id, name FROM growatt_plants WHERE plant_id = ANY($1)")
            .bind(&plant_ids)
            .fetch_all(pool)
            .await?
            .into_iter()
            .collect();
    let mut msgs: Vec<Msg> = Vec::new();
    for f in &rows {
        let raised_by = truthy(&f.updated_by).or(truthy(&f.created_by));
        let data = s1_message(f, names.get(&f.plant_id).and_then(|n| n.as_deref()));
        for uid in &order {
            let (role, name) = &users[uid];
            if Some(name.as_str()) == raised_by {
                continue; // they know
            }
            if role == "admin" || assigned.get(&f.plant_id).is_some_and(|s| s.contains(uid)) {
                msgs.extend(tokens[uid].iter().map(|t| Msg { token: t.clone(), data: data.clone() }));
            }
        }
    }
    let counts = if msgs.is_empty() { Counts::default() } else { push::send(pool, sender.as_ref(), &msgs).await? };
    // after the send: if it failed (FCM unreachable), the next run tries again
    let ids: Vec<i32> = rows.iter().map(|f| f.id).collect();
    // updated_at too: the ORM's `onupdate=_utcnow` stamps it on Python's flush
    sqlx::query("UPDATE field_faults SET s1_pushed_at = $2, updated_at = $2 WHERE id = ANY($1)").bind(&ids).bind(now).execute(pool).await?;
    counts.insert_into(&mut d);
    // Python `log.info("fault push: %s", detail)` (a dict repr)
    tracing::info!(
        target: LOG,
        "fault push: {{'s1_faults': {}, 'sent': {}, 'failed': {}, 'removed': {}}}",
        rows.len(),
        counts.sent,
        counts.failed,
        counts.removed
    );
    Ok(d)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fault() -> S1Fault {
        S1Fault {
            id: 7,
            no: "DF-2026-0007".into(),
            plant_id: 42,
            kind: "dc_cable".into(),
            serial: None,
            position: Some(json!({"location": "Roof B"})),
            symptom: "x".repeat(130),
            s1_at: Utc::now(),
            created_by: None,
            updated_by: None,
        }
    }

    #[test]
    fn message_like_python() {
        let m = s1_message(&fault(), None);
        assert_eq!(m[0].1, "S1 safety fault · plant 42");
        assert_eq!(m[1].1, format!("DF-2026-0007 dc cable · Roof B · {}", "x".repeat(120)));
        assert_eq!(m[2].1, "/faults?fault=7");
        let mut f = fault();
        f.serial = Some("SN1".into());
        f.symptom = String::new();
        assert_eq!(s1_message(&f, Some("Plant A"))[1].1, "DF-2026-0007 dc cable · SN1");
    }
}
