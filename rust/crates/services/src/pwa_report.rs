//! Data for the Monitoring PWA Report Google Sheet, as the worker's sheet fill reads it: port of
//! backend/app/services/pwa_report.py `firestore_day_docs`, `_registry`, `_sql_checks` and
//! `build` (with an explicit day-docs reader, i.e. no API memory cache: the worker path).
//!
//! The published daily docs come from Firestore (`daily/{day}` + `daily/{day}/plants`); a check
//! slot frozen in SQL `pwa_check_slots` that Firestore lacks is filled in from SQL (the same frozen
//! snapshot). Plant names, locations and datalogger serials come from the SQL registry. Nothing
//! else comes from SQL: missing stays missing.

use std::collections::{BTreeMap, BTreeSet, HashMap};

use chrono::{DateTime, NaiveDate, Utc};
use serde_json::{json, Map, Value};
use sqlx::PgPool;
use tcroof_clients::firestore_read::{FirestoreError, FirestoreReader};

use crate::devices::is_replaced;

/// Python `DAY_FIELDS`: only what the sheet uses
pub const DAY_FIELDS: [&str; 6] = ["hourly_kw", "yield_kwh", "checks", "weather.has_sensor", "weather.slots", "google_weather.slots"];

/// Where the Firestore day docs are read (Python: `firebase_admin` with FIREBASE_CREDENTIALS_FILE
/// and FIREBASE_PROJECT_ID; FIRESTORE_EMULATOR_HOST is honoured as Google's SDKs do).
#[derive(Debug, Clone, Default)]
pub struct FirestoreConfig {
    pub project_id: String,
    pub credentials_file: String,
    pub emulator_host: String,
}

/// A registry plant (Python `{name, latitude, longitude}`).
#[derive(Debug, Clone, PartialEq)]
pub struct PlantInfo {
    pub name: Option<String>,
    pub latitude: Option<f64>,
    pub longitude: Option<f64>,
}

/// Python `build`'s answer (the parts the sheet fill reads).
#[derive(Debug, Clone, Default)]
pub struct ReportData {
    pub day: String,
    /// plant id (as text) → info, in plant id order
    pub plants: Vec<(String, PlantInfo)>,
    /// datalogger SN → plant id
    pub loggers: HashMap<String, String>,
    /// datalogger SN → the datalogger's own firmware: always empty (Growatt gives none), but
    /// present, so the fill blanks stale Firmware cells (Python `firmware = {}`)
    pub firmware: HashMap<String, String>,
    /// datalogger SN → the inverter versions older reports wrote into the Firmware column
    pub inverter_firmware: HashMap<String, Vec<String>>,
    /// check hours published in full ("09", ...); None = not stated (older day): all count
    pub checks_ready: Option<Vec<String>>,
    /// plant id → day doc (Firestore, with SQL check slots filled in)
    pub days: BTreeMap<String, Value>,
    /// Python `sql_fallback`: {"plants", "checks"} taken from SQL
    pub sql_fallback: Value,
    /// exception class name when Firestore could not be read
    pub firestore_error: Option<String>,
}

/// Python `firestore_day_docs`: the fleet doc's `checks_ready` (head, `{}` when it does not
/// exist) and (plant_id, doc) of every plant doc of `day`, with only [`DAY_FIELDS`].
pub async fn firestore_day_docs(cfg: &FirestoreConfig, day: NaiveDate) -> Result<(Map<String, Value>, Vec<(String, Map<String, Value>)>), FirestoreError> {
    let r = FirestoreReader::new(&cfg.project_id, &cfg.credentials_file, &cfg.emulator_host)?;
    // the fleet doc first: it is written after every plant doc of a publish
    let head = r.get_doc(&format!("daily/{day}"), &["checks_ready"]).await?.unwrap_or_default();
    let docs = r.list_docs(&format!("daily/{day}/plants"), &DAY_FIELDS).await?;
    Ok((head, docs))
}

#[derive(sqlx::FromRow)]
struct InvRow {
    plant_id: i64,
    datalogger_sn: Option<String>,
    alias: Option<String>,
    not_installed_at: Option<DateTime<Utc>>,
    fw_version: Option<String>,
    inner_version: Option<String>,
}

/// Python `daily_checks.left_out`: named as replaced, or marked not installed
fn left_out(i: &InvRow) -> bool {
    is_replaced(i.alias.as_deref()) || i.not_installed_at.is_some()
}

async fn inverters(pool: &PgPool, with_logger: bool) -> Result<Vec<InvRow>, sqlx::Error> {
    let cond = if with_logger { "WHERE datalogger_sn IS NOT NULL " } else { "" };
    sqlx::query_as(&format!(
        "SELECT plant_id::bigint AS plant_id, datalogger_sn, alias, not_installed_at, fw_version, inner_version \
         FROM growatt_inverters {cond}ORDER BY device_sn"
    ))
    .fetch_all(pool)
    .await
}

/// Python `_registry` (the parts the sheet uses): plants, loggers, the (empty) datalogger
/// firmware and each datalogger's inverter versions (`inverter_firmware`).
async fn registry(pool: &PgPool) -> Result<(Vec<(String, PlantInfo)>, HashMap<String, String>, HashMap<String, Vec<String>>), sqlx::Error> {
    type PlantRow = (i64, Option<String>, Option<f64>, Option<f64>);
    let plants: Vec<PlantRow> =
        sqlx::query_as("SELECT plant_id::bigint, name, latitude, longitude FROM growatt_plants ORDER BY plant_id").fetch_all(pool).await?;
    let plants = plants.into_iter().map(|(id, name, latitude, longitude)| (id.to_string(), PlantInfo { name, latitude, longitude })).collect();
    let mut loggers = HashMap::new();
    let mut versions: BTreeMap<(String, &'static str), BTreeSet<String>> = BTreeMap::new();
    for inv in inverters(pool, true).await? {
        let Some(sn) = inv.datalogger_sn.clone().filter(|s| !s.is_empty()) else { continue };
        loggers.insert(sn.clone(), inv.plant_id.to_string());
        if !left_out(&inv) {
            let inner = inv.inner_version.clone().filter(|v| !v.is_empty()).or_else(|| inv.fw_version.clone());
            for (kind, v) in [("inner", inner), ("fw", inv.fw_version.clone())] {
                let v = v.unwrap_or_default().trim().to_owned();
                if !v.is_empty() {
                    versions.entry((sn.clone(), kind)).or_default().insert(v);
                }
            }
        }
    }
    let mut stale: HashMap<String, Vec<String>> = HashMap::new();
    for ((sn, _), vs) in versions {
        let text = vs.into_iter().collect::<Vec<_>>().join(", ");
        let e = stale.entry(sn).or_default();
        if !e.contains(&text) {
            e.push(text);
        }
    }
    Ok((plants, loggers, stale))
}

/// Python `check_slots.hh`
fn hh(hour: i64) -> String {
    format!("{hour:02}")
}

/// Python `_sql_checks`: the day's frozen check slots that Firestore lacks. A check hour is ready
/// from SQL when every plant with an inverter not left out has it frozen.
async fn sql_checks(
    pool: &PgPool,
    day: NaiveDate,
    mut docs: BTreeMap<String, Value>,
    ready: Option<Vec<String>>,
) -> Result<(BTreeMap<String, Value>, Option<Vec<String>>, Value), sqlx::Error> {
    let rows: Vec<(i64, i64, Value)> =
        sqlx::query_as("SELECT plant_id::bigint, hour::bigint, slot_json FROM pwa_check_slots WHERE day = $1 ORDER BY plant_id, hour")
            .bind(day)
            .fetch_all(pool)
            .await?;
    let mut frozen: BTreeMap<String, BTreeMap<String, Value>> = BTreeMap::new();
    for (pid, hour, slot) in rows {
        frozen.entry(pid.to_string()).or_default().insert(hh(hour), slot);
    }
    let (mut n_plants, mut n_checks) = (0, 0);
    if frozen.is_empty() {
        return Ok((docs, ready, json!({"plants": 0, "checks": 0})));
    }
    let active: BTreeSet<String> = inverters(pool, false).await?.iter().filter(|i| !left_out(i)).map(|i| i.plant_id.to_string()).collect();
    let all_hours: BTreeSet<&String> = frozen.values().flat_map(|s| s.keys()).collect();
    let sql_ready: Vec<String> = all_hours
        .into_iter()
        .filter(|h| !active.is_empty() && active.iter().all(|pid| frozen.get(pid).is_some_and(|s| s.contains_key(*h))))
        .cloned()
        .collect();
    let mut set: BTreeSet<String> = ready.unwrap_or_default().into_iter().collect();
    set.extend(sql_ready);
    let ready = Some(set.into_iter().collect());

    let sensors: BTreeSet<String> =
        sqlx::query_scalar::<_, i64>("SELECT plant_id::bigint FROM growatt_env_sensors").fetch_all(pool).await?.into_iter().map(|p| p.to_string()).collect();
    for (pid, slots) in frozen {
        let doc = docs.get(&pid).cloned();
        let have = doc.as_ref().and_then(|d| d.get("checks")).filter(|c| crate::pwa_sheet::truthy(c)).cloned().unwrap_or(json!({}));
        let have_map = have.as_object().cloned().unwrap_or_default();
        let add: Map<String, Value> = slots.into_iter().filter(|(h, _)| !have_map.contains_key(h)).collect();
        if add.is_empty() {
            continue;
        }
        n_checks += add.len();
        match doc {
            None => {
                n_plants += 1;
                docs.insert(pid.clone(), json!({"checks": add, "weather": {"has_sensor": sensors.contains(&pid)}, "source": "sql"}));
            }
            Some(d) => {
                let mut new = d.as_object().cloned().unwrap_or_default();
                let mut checks = have_map;
                checks.extend(add);
                new.insert("checks".into(), Value::Object(checks));
                if !new.contains_key("weather") {
                    new.insert("weather".into(), json!({"has_sensor": sensors.contains(&pid)}));
                }
                docs.insert(pid, Value::Object(new));
            }
        }
    }
    Ok((docs, ready, json!({"plants": n_plants, "checks": n_checks})))
}

/// Python `build(db, day, firestore_day_docs)`: registry + the day's published docs, with frozen
/// check slots Firestore lacks filled in from SQL. A Firestore failure is logged and only SQL slots
/// are served (`firestore_error`).
pub async fn build(pool: &PgPool, fs: &FirestoreConfig, day: NaiveDate) -> Result<ReportData, sqlx::Error> {
    let (plants, loggers, inverter_firmware) = registry(pool).await?;
    let mut firestore_error = None;
    let (head, docs) = match firestore_day_docs(fs, day).await {
        Ok((head, docs)) => (head, docs.into_iter().map(|(id, d)| (id, Value::Object(d))).collect::<BTreeMap<_, _>>()),
        Err(e) => {
            tracing::warn!(target: "app.services.pwa_report", "PWA report {day}: Firestore read failed, using SQL check slots only: {e}");
            firestore_error = Some(e.kind.clone());
            (Map::new(), BTreeMap::new())
        }
    };
    let mut ready = match head.get("checks_ready") {
        Some(Value::Array(a)) => Some(a.iter().map(crate::pwa_sheet::py_str).collect()),
        _ => None,
    };
    if firestore_error.is_some() {
        ready = Some(vec![]); // never "all count" without the fleet doc
    }
    let (days, checks_ready, sql_fallback) = sql_checks(pool, day, docs, ready).await?;
    Ok(ReportData {
        day: day.to_string(),
        plants,
        loggers,
        firmware: HashMap::new(),
        inverter_firmware,
        checks_ready,
        days,
        sql_fallback,
        firestore_error,
    })
}
