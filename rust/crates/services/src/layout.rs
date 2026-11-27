//! String layout (modules x Wp per string input) and which inputs are wired, from stored
//! history. Port of backend/app/services/growatt_layout.py (re-exported by `growatt_overview` in
//! Python). Timestamps are plant-local (Thai) time; values that cannot be computed are `None`.

use std::collections::{BTreeSet, HashMap, HashSet};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use chrono::NaiveDateTime;
use serde_json::{json, Value};
use sqlx::PgPool;

use crate::common::{get_plant, Inverter, Result, ServiceError, INACTIVE_MAX_A, INVERTER_COLS};
use crate::fleet_settings::fleet_module_wp;
use crate::inverter_models::model_spec;

/// Python `Layout`: (device_sn, string_no) -> (modules, module_wp or None)
pub type Layout = HashMap<(String, i32), (i32, Option<f64>)>;

/// Python `LAYOUT_SEEN_LOOKBACK` (7 days)
pub const LAYOUT_SEEN_LOOKBACK: chrono::Duration = chrono::Duration::days(7);
/// Python `WIRED_LOOKBACK` (30 days)
pub const WIRED_LOOKBACK: chrono::Duration = chrono::Duration::days(30);
/// Python `WIRED_CACHE_S` (6 h)
pub const WIRED_CACHE_S: u64 = 6 * 3600;

type LayoutRow = (String, i32, i32, Option<f64>, Option<f64>, Option<f64>);

async fn layout_rows(pool: &PgPool, sns: &[String]) -> Result<Vec<LayoutRow>> {
    Ok(sqlx::query_as(
        "SELECT device_sn, string_no, modules, module_wp, azimuth_deg, tilt_deg FROM growatt_string_layouts WHERE device_sn = ANY($1)",
    )
    .bind(sns)
    .fetch_all(pool)
    .await?)
}

/// Python `growatt_layout.load_layout`: registry rows for `sns`. A string without its own
/// `module_wp` gets the fleet module's rating unless `fleet_wp` is false (raw rows, for the editor).
pub async fn load_layout(pool: &PgPool, sns: &[String], fleet_wp: bool) -> Result<Layout> {
    if sns.is_empty() {
        return Ok(Layout::new());
    }
    let default_wp = if fleet_wp { fleet_module_wp(pool).await? } else { None };
    Ok(layout_rows(pool, sns)
        .await?
        .into_iter()
        .map(|(sn, no, modules, wp, _, _)| ((sn, no), (modules, wp.or(default_wp))))
        .collect())
}

/// Python `growatt_layout.load_layout_orientations`: `(azimuth_deg, tilt_deg)` per string input
pub async fn load_layout_orientations(
    pool: &PgPool,
    sns: &[String],
) -> Result<HashMap<(String, i32), (Option<f64>, Option<f64>)>> {
    if sns.is_empty() {
        return Ok(HashMap::new());
    }
    Ok(layout_rows(pool, sns).await?.into_iter().map(|(sn, no, _, _, az, tilt)| ((sn, no), (az, tilt))).collect())
}

/// Python `growatt_layout.newest_string_ts`: newest stored string record of these inverters
/// (optionally one input), one primary-key lookup per inverter.
pub async fn newest_string_ts(pool: &PgPool, sns: &[String], string_no: Option<i32>) -> Result<Option<NaiveDateTime>> {
    let mut best: Option<NaiveDateTime> = None;
    let mut seen = HashSet::new();
    for sn in sns {
        if !seen.insert(sn) {
            continue;
        }
        let ts: Option<NaiveDateTime> = match string_no {
            Some(no) => sqlx::query_scalar(
                "SELECT timestamp FROM growatt_string_readings WHERE device_sn = $1 AND string_no = $2 \
                 ORDER BY device_sn DESC, timestamp DESC LIMIT 1",
            )
            .bind(sn)
            .bind(no)
            .fetch_optional(pool)
            .await?,
            None => sqlx::query_scalar(
                "SELECT timestamp FROM growatt_string_readings WHERE device_sn = $1 ORDER BY device_sn DESC, timestamp DESC LIMIT 1",
            )
            .bind(sn)
            .fetch_optional(pool)
            .await?,
        };
        if let Some(t) = ts {
            if best.is_none_or(|b| t > b) {
                best = Some(t);
            }
        }
    }
    Ok(best)
}

type WiredMap = HashMap<String, BTreeSet<i32>>;
type WiredCache = Mutex<HashMap<Vec<String>, (Instant, WiredMap)>>;

fn wired_cache() -> &'static WiredCache {
    static CACHE: std::sync::OnceLock<WiredCache> = std::sync::OnceLock::new();
    CACHE.get_or_init(Default::default)
}

/// Python `growatt_layout.wired_inputs`: string inputs known to be connected, per inverter (String
/// Layout rows plus inputs that carried current in the last `WIRED_LOOKBACK`), kept in memory for
/// `WIRED_CACHE_S`. An inverter with neither is absent (wiring unknown). As in Python, a layout
/// save does not clear this cache.
pub async fn wired_inputs(pool: &PgPool, sns: &[String]) -> Result<WiredMap> {
    let mut key = sns.to_vec();
    key.sort();
    if let Some((at, hit)) = wired_cache().lock().expect("wired cache").get(&key) {
        if at.elapsed() < Duration::from_secs(WIRED_CACHE_S) {
            return Ok(hit.clone());
        }
    }
    let mut out = WiredMap::new();
    for (sn, no) in load_layout(pool, sns, false).await?.into_keys() {
        out.entry(sn).or_default().insert(no);
    }
    if let Some(latest) = newest_string_ts(pool, sns, None).await? {
        let rows: Vec<(String, i32)> = sqlx::query_as(
            "SELECT device_sn, string_no FROM growatt_string_readings WHERE device_sn = ANY($1) AND timestamp >= $2 \
             AND current_a > $3 GROUP BY device_sn, string_no",
        )
        .bind(sns)
        .bind(latest - WIRED_LOOKBACK)
        .bind(INACTIVE_MAX_A)
        .fetch_all(pool)
        .await?;
        for (sn, no) in rows {
            out.entry(sn).or_default().insert(no);
        }
    }
    wired_cache().lock().expect("wired cache").insert(key, (Instant::now(), out.clone()));
    Ok(out)
}

/// Python `growatt_layout.get_string_layout`: module count per string input of a plant (registry
/// rows plus inputs seen in the last week); `modules` null where nobody entered it. Inputs with a
/// removed mark are left out of `strings` and listed in `removed_strings`.
pub async fn get_string_layout(pool: &PgPool, plant_id: i64) -> Result<Value> {
    let plant = get_plant(pool, plant_id).await?;
    let invs: Vec<Inverter> = sqlx::query_as(&format!(
        "SELECT {INVERTER_COLS} FROM growatt_inverters WHERE plant_id = $1 AND not_installed_at IS NULL ORDER BY device_sn"
    ))
    .bind(crate::plant_documents::id32(plant_id))
    .fetch_all(pool)
    .await?;
    let sns: Vec<String> = invs.iter().map(|i| i.device_sn.clone()).collect();
    let layout = load_layout(pool, &sns, false).await?;
    let orientations = load_layout_orientations(pool, &sns).await?;
    let removed: HashSet<(String, i32)> = if sns.is_empty() {
        HashSet::new()
    } else {
        sqlx::query_as::<_, (String, i32)>("SELECT device_sn, string_no FROM growatt_string_removed WHERE device_sn = ANY($1)")
            .bind(&sns)
            .fetch_all(pool)
            .await?
            .into_iter()
            .collect()
    };
    let mut seen: HashMap<(String, i32), i32> = HashMap::new();
    if let Some(latest) = newest_string_ts(pool, &sns, None).await? {
        let rows: Vec<(String, i32, Option<i32>)> = sqlx::query_as(
            "SELECT device_sn, string_no, max(mppt_no) FROM growatt_string_readings WHERE device_sn = ANY($1) \
             AND timestamp >= $2 AND current_a > $3 GROUP BY device_sn, string_no",
        )
        .bind(&sns)
        .bind(latest - LAYOUT_SEEN_LOOKBACK)
        .bind(INACTIVE_MAX_A)
        .fetch_all(pool)
        .await?;
        for (sn, no, mppt) in rows {
            seen.insert((sn, no), mppt.unwrap_or(0));
        }
    }
    let mut out = Vec::with_capacity(invs.len());
    for inv in &invs {
        let sn = &inv.device_sn;
        let gone: BTreeSet<i32> = removed.iter().filter(|(s, _)| s == sn).map(|(_, n)| *n).collect();
        let nos: BTreeSet<i32> = seen
            .keys()
            .chain(layout.keys())
            .filter(|(s, _)| s == sn)
            .map(|(_, n)| *n)
            .filter(|n| !gone.contains(n))
            .collect();
        let strings: Vec<Value> = nos
            .iter()
            .map(|&n| {
                let k = (sn.clone(), n);
                let l = layout.get(&k);
                let o = orientations.get(&k);
                json!({
                    "string_no": n,
                    // Python (n + 1) // 2 (floor division)
                    "mppt_no": seen.get(&k).copied().unwrap_or_else(|| (n + 1).div_euclid(2)),
                    "modules": l.map(|l| l.0),
                    "module_wp": l.and_then(|l| l.1),
                    "azimuth_deg": o.and_then(|o| o.0),
                    "tilt_deg": o.and_then(|o| o.1),
                    "active": seen.contains_key(&k),
                })
            })
            .collect();
        out.push(json!({
            "device_sn": sn,
            "model": inv.model.clone().unwrap_or_default(),
            "device_model": inv.device_model,
            "alias": inv.alias,
            "rated_power_w": inv.rated_power_w.or(inv.nominal_power_w),
            "datasheet": model_spec(inv.device_model.as_deref()),
            "strings": strings,
            "removed_strings": gone.into_iter().collect::<Vec<_>>(),
        }));
    }
    Ok(json!({
        "plant_id": plant.plant_id,
        "plant_name": plant.name,
        "fleet_module_wp": fleet_module_wp(pool).await?,
        "inverters": out,
    }))
}

/// One validated entry of the PUT body (Python `GrowattStringLayoutEntry`)
#[derive(Debug, Clone)]
pub struct LayoutEntry {
    pub device_sn: String,
    pub string_no: i32,
    pub removed: bool,
    pub modules: Option<i32>,
    pub module_wp: Option<f64>,
    pub azimuth_deg: Option<f64>,
    pub tilt_deg: Option<f64>,
}

/// Python `growatt_layout.put_string_layout`: replace the plant's module-count registry and
/// removed marks with `entries` (both sets, for every inverter of the plant); strings and marks
/// left out are cleared. One input twice, or an inverter of another plant, is `Invalid` (422).
pub async fn put_string_layout(pool: &PgPool, plant_id: i64, entries: &[LayoutEntry]) -> Result<Value> {
    get_plant(pool, plant_id).await?;
    let sns: HashSet<String> = sqlx::query_scalar::<_, String>("SELECT device_sn FROM growatt_inverters WHERE plant_id = $1")
        .bind(crate::plant_documents::id32(plant_id))
        .fetch_all(pool)
        .await?
        .into_iter()
        .collect();
    let mut keys: HashSet<(String, i32)> = HashSet::new();
    let mut rows: Vec<&LayoutEntry> = Vec::new();
    let mut marks: Vec<&LayoutEntry> = Vec::new();
    for e in entries {
        if !sns.contains(&e.device_sn) {
            return Err(ServiceError::Invalid(format!("Inverter {} does not belong to plant {plant_id}", e.device_sn)));
        }
        if !keys.insert((e.device_sn.clone(), e.string_no)) {
            return Err(ServiceError::Invalid(format!("Duplicate entry for {} string {}", e.device_sn, e.string_no)));
        }
        if e.removed {
            marks.push(e);
            continue;
        }
        if e.modules.is_none() {
            return Err(ServiceError::Invalid(format!("Missing module count for {} string {}", e.device_sn, e.string_no)));
        }
        rows.push(e);
    }
    let all: Vec<String> = sns.into_iter().collect();
    let mut tx = pool.begin().await?;
    if !all.is_empty() {
        sqlx::query("DELETE FROM growatt_string_layouts WHERE device_sn = ANY($1)").bind(&all).execute(&mut *tx).await?;
        sqlx::query("DELETE FROM growatt_string_removed WHERE device_sn = ANY($1)").bind(&all).execute(&mut *tx).await?;
    }
    for e in rows {
        sqlx::query(
            "INSERT INTO growatt_string_layouts (device_sn, string_no, modules, module_wp, azimuth_deg, tilt_deg, updated_at) \
             VALUES ($1, $2, $3, $4, $5, $6, now())",
        )
        .bind(&e.device_sn)
        .bind(e.string_no)
        .bind(e.modules)
        .bind(e.module_wp)
        .bind(e.azimuth_deg)
        .bind(e.tilt_deg)
        .execute(&mut *tx)
        .await?;
    }
    for e in marks {
        sqlx::query("INSERT INTO growatt_string_removed (device_sn, string_no, removed_at) VALUES ($1, $2, now())")
            .bind(&e.device_sn)
            .bind(e.string_no)
            .execute(&mut *tx)
            .await?;
    }
    tx.commit().await?;
    get_string_layout(pool, plant_id).await
}
