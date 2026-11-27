//! Devices page (docs/plans/devices-page.md): fleet lists of inverters, meters and dataloggers,
//! ported from backend/app/services/devices.py.
//!
//! DB only (`meta.source = "db"`), scoped by the user's plants (None = every plant). Live state
//! comes from the `/growatt/live/*` sweeps; nothing here calls Growatt or writes anything.
//! Missing values are null, never 0. Inverters marked not installed are listed only on request
//! (`include_not_installed`) and left out of every average.

#![allow(clippy::type_complexity)] // sqlx row tuples

use std::collections::{BTreeMap, HashMap, HashSet};

use chrono::{DateTime, NaiveDate, NaiveDateTime, Utc};
use serde_json::{json, Value};
use sqlx::PgPool;

use crate::alarms::plant_tz;
use crate::common::{bucket, day_bounds, integrate_kwh, isoformat_utc, py_round, round_opt, Inverter, Plant, Result, INVERTER_COLS, PLANT_COLS};

/// Python `ACTIVE_ISSUE`
const ACTIVE_ISSUE: [&str; 2] = ["open", "acknowledged"];

/// Python `growatt_rules.TIER_ORDER` (unknown tiers rank 9)
fn tier_rank(t: &str) -> i32 {
    match t {
        "P1" => 0,
        "P2" => 1,
        "P3" => 2,
        "P4" => 3,
        "Info" => 4,
        _ => 9,
    }
}

/// The user's plants as SQL binds: None = every plant (Python `_scoped`: an empty set matches nothing)
pub fn scope_ids(plant_ids: Option<&HashSet<i64>>) -> Option<Vec<i32>> {
    plant_ids.map(|a| {
        let mut v: Vec<i32> = a.iter().filter_map(|p| i32::try_from(*p).ok()).collect();
        v.sort_unstable();
        v
    })
}

// --------------------------------------------------------------------------- inverter labels

fn word_char(c: char) -> bool {
    c.is_alphanumeric() || c == '_'
}

/// Python `daily_checks.is_replaced`: alias names it replaced (`\bold\b|เก่า`, case-insensitive).
pub fn is_replaced(alias: Option<&str>) -> bool {
    let Some(a) = alias else { return false };
    if a.contains("เก่า") {
        return true;
    }
    let chars: Vec<char> = a.chars().collect();
    (0..chars.len().saturating_sub(2)).any(|i| {
        chars[i..i + 3].iter().map(|c| c.to_ascii_lowercase()).eq("old".chars())
            && (i == 0 || !word_char(chars[i - 1]))
            && chars.get(i + 3).is_none_or(|c| !word_char(*c))
    })
}

/// Python `daily_checks.left_out`: named as replaced, or marked not installed.
pub fn left_out(inv: &Inverter) -> bool {
    is_replaced(inv.alias.as_deref()) || inv.not_installed_at.is_some()
}

/// `\d+` at `i`: (digits, end)
fn digits_at(c: &[char], i: usize) -> Option<(String, usize)> {
    let mut j = i;
    while j < c.len() && c[j].is_ascii_digit() {
        j += 1;
    }
    (j > i).then(|| (c[i..j].iter().collect(), j))
}

fn lit_ci(c: &[char], i: usize, lit: &str) -> bool {
    let n = lit.chars().count();
    i + n <= c.len() && c[i..i + n].iter().map(|x| x.to_ascii_lowercase()).eq(lit.chars())
}

/// Python `daily_checks._INV_NO.search`: `inv(?:erter)?[\s.]*(?:no\.?)?\s*(\d+)`, case-insensitive
fn inv_no(c: &[char]) -> Option<String> {
    for start in 0..c.len() {
        if !lit_ci(c, start, "inv") {
            continue;
        }
        let mut i = start + 3;
        if lit_ci(c, i, "erter") {
            i += 5;
        }
        while i < c.len() && (c[i].is_whitespace() || c[i] == '.') {
            i += 1;
        }
        let skip_ws = |mut j: usize| {
            while j < c.len() && c[j].is_whitespace() {
                j += 1;
            }
            j
        };
        if lit_ci(c, i, "no") {
            let mut j = i + 2;
            if j < c.len() && c[j] == '.' {
                j += 1;
            }
            if let Some((d, _)) = digits_at(c, skip_ws(j)) {
                return Some(d);
            }
        }
        if let Some((d, _)) = digits_at(c, skip_ws(i)) {
            return Some(d);
        }
    }
    None
}

/// Python `daily_checks._PAREN_NO.match`: `^\s*\(\s*(\d+)\s*\)`
fn paren_no(c: &[char]) -> Option<String> {
    let mut i = 0;
    while i < c.len() && c[i].is_whitespace() {
        i += 1;
    }
    if c.get(i) != Some(&'(') {
        return None;
    }
    i += 1;
    while i < c.len() && c[i].is_whitespace() {
        i += 1;
    }
    let (d, mut j) = digits_at(c, i)?;
    while j < c.len() && c[j].is_whitespace() {
        j += 1;
    }
    (c.get(j) == Some(&')')).then_some(d)
}

/// Python `daily_checks.inverter_label`: "INV3" from the inverter number in the Growatt alias;
/// an alias that is the serial is not a number: "INV1" for a plant's only inverter, else the serial.
pub fn inverter_label(inv: &Inverter, sole: bool) -> String {
    let alias = inv.alias.as_deref().unwrap_or("").trim();
    if !alias.is_empty() && alias.to_uppercase() != inv.device_sn.to_uppercase() {
        let c: Vec<char> = alias.chars().collect();
        if let Some(d) = inv_no(&c).or_else(|| paren_no(&c)) {
            let n = d.trim_start_matches('0');
            return format!("INV{}", if n.is_empty() { "0" } else { n });
        }
    }
    if sole {
        "INV1".into()
    } else {
        inv.device_sn.clone()
    }
}

// --------------------------------------------------------------------------- shared

/// Python `devices.local_today`: plant-local today (UTC+7).
pub fn local_today(now: DateTime<Utc>) -> NaiveDate {
    now.with_timezone(&plant_tz()).date_naive()
}

/// Python `devices.history_synced_at`: start of the newest finished `history` run (UTC ISO).
async fn history_synced_at(pool: &PgPool) -> Result<Option<String>> {
    let started: Option<DateTime<Utc>> = sqlx::query_scalar(
        "SELECT started_at FROM sync_runs WHERE job = 'history' AND status IN ('ok', 'partial') \
         AND finished_at IS NOT NULL ORDER BY finished_at DESC LIMIT 1",
    )
    .fetch_optional(pool)
    .await?;
    Ok(started.map(isoformat_utc))
}

/// Python `devices.meta`
async fn meta(pool: &PgPool, today: NaiveDate) -> Result<Value> {
    Ok(json!({"source": "db", "day": today.format("%Y-%m-%d").to_string(), "synced_at": history_synced_at(pool).await?}))
}

/// Python `devices._local_iso`: plant-local naive timestamp → "YYYY-MM-DDTHH:MM:SS"
fn local_iso(ts: Option<NaiveDateTime>) -> Option<String> {
    ts.map(|t| t.format("%Y-%m-%dT%H:%M:%S").to_string())
}

/// Python `devices._plants`
async fn plants(pool: &PgPool, ids: Option<&[i32]>) -> Result<BTreeMap<i32, Plant>> {
    let rows: Vec<Plant> =
        sqlx::query_as(&format!("SELECT {PLANT_COLS} FROM growatt_plants WHERE ($1::int[] IS NULL OR plant_id = ANY($1))"))
            .bind(ids)
            .fetch_all(pool)
            .await?;
    Ok(rows.into_iter().map(|p| (p.plant_id, p)).collect())
}

type Register = HashMap<i32, (String, Option<String>)>;

/// Python `devices._register`: {plant_id: (site_code, province)} of the matched site-register stations.
async fn register(pool: &PgPool, plant_ids: &[i32]) -> Result<Register> {
    if plant_ids.is_empty() {
        return Ok(HashMap::new());
    }
    let rows: Vec<(Option<i32>, String, Option<String>)> =
        sqlx::query_as("SELECT plant_id, site_code, province FROM site_register WHERE plant_id = ANY($1)")
            .bind(plant_ids)
            .fetch_all(pool)
            .await?;
    Ok(rows.into_iter().filter_map(|(pid, code, prov)| pid.map(|p| (p, (code, prov)))).collect())
}

/// Python `devices._province`: site register province, else Growatt `city`.
fn province(p: &Plant, reg: &Register) -> Option<String> {
    let prov = reg.get(&p.plant_id).and_then(|r| r.1.clone()).filter(|s| !s.is_empty());
    prov.or_else(|| p.city.clone().filter(|s| !s.is_empty()))
}

/// Python `devices._register_logger_sn`: {plant_id: logger SN} from the site register's
/// datalogger device (lowest seq) of the plant's station.
async fn register_logger_sn(pool: &PgPool, plant_ids: &[i32]) -> Result<HashMap<i32, String>> {
    let mut out = HashMap::new();
    if plant_ids.is_empty() {
        return Ok(out);
    }
    let rows: Vec<(Option<i32>, Option<String>)> = sqlx::query_as(
        "SELECT r.plant_id, d.serial FROM site_register r JOIN site_devices d ON d.site_code = r.site_code \
         WHERE r.plant_id = ANY($1) AND d.kind = 'datalogger' AND d.serial IS NOT NULL ORDER BY r.plant_id, d.seq",
    )
    .bind(plant_ids)
    .fetch_all(pool)
    .await?;
    for (pid, serial) in rows {
        let sn = serial.unwrap_or_default().trim().to_owned();
        if let Some(pid) = pid {
            if !sn.is_empty() {
                out.entry(pid).or_insert(sn);
            }
        }
    }
    Ok(out)
}

/// Python `devices.register_match`: "match" / "prefix" / "differs"; None without a register SN.
pub fn register_match(register_sn: Option<&str>, serial: &str) -> Option<&'static str> {
    let reg = register_sn.unwrap_or("").trim().to_uppercase();
    if reg.is_empty() {
        return None;
    }
    let sn = serial.trim().to_uppercase();
    Some(if reg == sn {
        "match"
    } else if sn.starts_with(&reg) {
        "prefix"
    } else {
        "differs"
    })
}

/// Python sort key `(phase is None, phase or 0, plant_name, plant_id, …)`
fn phase_key(phase: Option<i32>) -> (bool, i32) {
    (phase.is_none(), phase.unwrap_or(0))
}

// --------------------------------------------------------------------------- inverters

/// Python `devices._yield_today`: {serial: eac_today of its newest record today}.
async fn yield_today(pool: &PgPool, sns: &[String], today: NaiveDate) -> Result<HashMap<String, f64>> {
    if sns.is_empty() {
        return Ok(HashMap::new());
    }
    let (start, end) = day_bounds(today);
    let rows: Vec<(String, Option<f64>)> = sqlx::query_as(
        "SELECT r.device_sn, r.eac_today_kwh FROM growatt_inverter_readings r JOIN ( \
           SELECT device_sn AS sn, max(timestamp) AS ts FROM growatt_inverter_readings \
           WHERE timestamp >= $1 AND timestamp < $2 AND eac_today_kwh IS NOT NULL AND device_sn = ANY($3) \
           GROUP BY device_sn) n ON r.device_sn = n.sn AND r.timestamp = n.ts",
    )
    .bind(start)
    .bind(end)
    .bind(sns)
    .fetch_all(pool)
    .await?;
    Ok(rows.into_iter().filter_map(|(sn, v)| v.map(|v| (sn, v))).collect())
}

/// Python `devices._issues`: {serial: (active issue count, highest tier)}; shadow issues left out.
async fn issues(pool: &PgPool, ids: Option<&[i32]>) -> Result<HashMap<String, (i64, Option<String>)>> {
    let rows: Vec<(Option<String>, String)> = sqlx::query_as(
        "SELECT device_sn, tier FROM growatt_issues WHERE status = ANY($1) AND shadow IS false \
         AND device_sn IS NOT NULL AND ($2::int[] IS NULL OR plant_id = ANY($2)) ORDER BY id",
    )
    .bind(&ACTIVE_ISSUE[..])
    .bind(ids)
    .fetch_all(pool)
    .await?;
    let mut out: HashMap<String, (i64, Option<String>)> = HashMap::new();
    for (sn, tier) in rows {
        let Some(sn) = sn else { continue };
        let e = out.entry(sn).or_insert((0, None));
        e.0 += 1;
        if e.1.as_deref().is_none_or(|top| tier_rank(&tier) < tier_rank(top)) {
            e.1 = Some(tier);
        }
    }
    Ok(out)
}

/// Python `devices._alarms_today`: {serial: (records today, still open)} for every inverter whose
/// alarm log was read today; an inverter not read today is absent (null, never 0).
async fn alarms_today(pool: &PgPool, ids: Option<&[i32]>, today: NaiveDate) -> Result<HashMap<String, (i64, i64)>> {
    let synced: Vec<String> = sqlx::query_scalar(
        "SELECT device_sn FROM growatt_alarm_syncs WHERE day = $1 AND ($2::int[] IS NULL OR plant_id = ANY($2))",
    )
    .bind(today)
    .bind(ids)
    .fetch_all(pool)
    .await?;
    let mut out: HashMap<String, (i64, i64)> = synced.into_iter().map(|sn| (sn, (0, 0))).collect();
    let rows: Vec<(String, i64, i64)> = sqlx::query_as(
        "SELECT device_sn, count(*), count(end_time) FROM growatt_alarms \
         WHERE day = $1 AND ($2::int[] IS NULL OR plant_id = ANY($2)) GROUP BY device_sn",
    )
    .bind(today)
    .bind(ids)
    .fetch_all(pool)
    .await?;
    for (sn, n, ended) in rows {
        if let Some(e) = out.get_mut(&sn) {
            *e = (n, n - ended);
        }
    }
    Ok(out)
}

/// Python `devices.list_inverters`: every inverter the user may see, one row each (not
/// installed ones only with `include_not_installed`).
pub async fn list_inverters(pool: &PgPool, plant_ids: Option<&HashSet<i64>>, include_not_installed: bool, now: DateTime<Utc>) -> Result<Value> {
    let today = local_today(now);
    let ids = scope_ids(plant_ids);
    let plants = plants(pool, ids.as_deref()).await?;
    let invs: Vec<Inverter> = sqlx::query_as::<_, Inverter>(&format!(
        "SELECT {INVERTER_COLS} FROM growatt_inverters WHERE ($1::int[] IS NULL OR plant_id = ANY($1)) ORDER BY plant_id, device_sn"
    ))
    .bind(ids.as_deref())
    .fetch_all(pool)
    .await?
    .into_iter()
    .filter(|i| plants.contains_key(&i.plant_id))
    .collect();
    let installed: Vec<&Inverter> = invs.iter().filter(|i| i.installed()).collect();
    let summary = json!({
        "inverters": invs.len(),
        "installed": installed.len(),
        "not_installed": invs.len() - installed.len(),
        "plants": installed.iter().map(|i| i.plant_id).collect::<HashSet<_>>().len(),
    });
    let rows: Vec<&Inverter> = if include_not_installed { invs.iter().collect() } else { installed.clone() };
    let sns: Vec<String> = rows.iter().map(|i| i.device_sn.clone()).collect();

    let pids: Vec<i32> = plants.keys().copied().collect();
    let reg = register(pool, &pids).await?;
    let yields = yield_today(pool, &sns, today).await?;
    let issues = issues(pool, ids.as_deref()).await?;
    let alarms = alarms_today(pool, ids.as_deref(), today).await?;
    let with_layout: HashSet<String> =
        sqlx::query_scalar("SELECT DISTINCT device_sn FROM growatt_string_layouts WHERE device_sn = ANY($1)")
            .bind(&sns)
            .fetch_all(pool)
            .await?
            .into_iter()
            .collect();

    // the plant's mean yield over its installed inverters with a yield today
    let mut per_plant: BTreeMap<i32, Vec<f64>> = BTreeMap::new();
    for i in &installed {
        if let Some(y) = yields.get(&i.device_sn) {
            per_plant.entry(i.plant_id).or_default().push(*y);
        }
    }
    let plant_mean: HashMap<i32, f64> =
        per_plant.iter().map(|(pid, v)| (*pid, v.iter().fold(0.0, |a, b| a + b) / v.len() as f64)).collect();
    // "INV1" for a plant's only inverter (as the daily checks name it)
    let mut counted: HashMap<i32, usize> = HashMap::new();
    for i in invs.iter().filter(|i| !left_out(i)) {
        *counted.entry(i.plant_id).or_default() += 1;
    }

    let mut out: Vec<(((bool, i32), String, i32, String), Value)> = Vec::with_capacity(rows.len());
    for i in rows {
        let p = &plants[&i.plant_id];
        let y = yields.get(&i.device_sn).copied();
        let mean = plant_mean.get(&i.plant_id).copied().filter(|m| *m != 0.0);
        let pct = match (y, mean) {
            (Some(y), Some(m)) if i.installed() => Some(py_round(y / m * 100.0, 1)),
            _ => None,
        };
        let (n_issues, top) = issues.get(&i.device_sn).cloned().unwrap_or((0, None));
        let alarm = alarms.get(&i.device_sn);
        let rated_w = i.nominal_power_w.filter(|w| *w != 0.0).or(i.rated_power_w).filter(|w| *w != 0.0);
        let row = json!({
            "device_sn": i.device_sn,
            "plant_id": i.plant_id,
            "plant_name": p.name,
            "phase": p.phase,
            "province": province(p, &reg),
            "site_code": reg.get(&i.plant_id).map(|r| r.0.clone()),
            "label": inverter_label(i, counted.get(&i.plant_id).copied().unwrap_or(0) == 1),
            "alias": i.alias,
            "model": i.model,
            "device_model": i.device_model,
            "rated_kw": rated_w.map(|w| py_round(w / 1000.0, 1)),
            "fw_version": i.fw_version,
            "datalogger_sn": i.datalogger_sn,
            "datalogger_model": i.datalogger_model,
            "growatt_created_at": i.growatt_created_at.map(|t| t.format("%Y-%m-%d %H:%M:%S").to_string()),
            "power_limit_pct": i.active_limit_pct(),
            "power_limit_source": if i.power_limit_pct.is_some() {
                Some("read_power")
            } else if i.active_rate_pct.is_some() {
                Some("max_data_info")
            } else {
                None
            },
            "on_off": i.on_off,
            "last_record": local_iso(i.history_synced_until),
            "yield_today_kwh": round_opt(y, 2),
            "pct_of_plant_avg": pct,
            "open_issues": n_issues,
            "top_tier": top,
            "alarms_today": alarm.map(|a| a.0),
            "alarms_open": alarm.map(|a| a.1),
            "has_string_layout": with_layout.contains(&i.device_sn),
            "not_installed": i.not_installed_at.map(|at| json!({
                "at": isoformat_utc(at), "by": i.not_installed_by, "note": i.not_installed_note,
            })),
        });
        out.push(((phase_key(p.phase), p.name.clone(), i.plant_id, i.device_sn.clone()), row));
    }
    out.sort_by(|a, b| a.0.cmp(&b.0));
    Ok(json!({
        "meta": meta(pool, today).await?,
        "inverters": out.into_iter().map(|(_, v)| v).collect::<Vec<_>>(),
        "summary": summary,
    }))
}

// --------------------------------------------------------------------------- meters

/// Python `devices._meter_energy`: (import kWh, export kWh) of one meter's records of a day.
fn meter_energy(rows: &[(NaiveDateTime, Option<f64>, Option<f64>)]) -> (Option<f64>, Option<f64>) {
    let mut slots: BTreeMap<NaiveDateTime, Vec<f64>> = BTreeMap::new();
    let mut counters: Vec<f64> = Vec::new();
    for (ts, p, counter) in rows {
        if let Some(p) = p {
            slots.entry(bucket(*ts)).or_default().push(*p);
        }
        if let Some(c) = counter.filter(|c| *c > 0.0) {
            counters.push(c);
        }
    }
    let pts: Vec<(NaiveDateTime, f64)> =
        slots.iter().map(|(t, v)| (*t, v.iter().fold(0.0, |a, b| a + b) / v.len() as f64)).collect();
    let (mut imp, mut exp) = (None, None);
    if !pts.is_empty() {
        let pos: Vec<_> = pts.iter().map(|(t, w)| (*t, Some(w.max(0.0)))).collect();
        let neg: Vec<_> = pts.iter().map(|(t, w)| (*t, Some((-w).max(0.0)))).collect();
        imp = Some(py_round(integrate_kwh(&pos), 1));
        exp = Some(py_round(integrate_kwh(&neg), 1));
    }
    if counters.len() >= 2 {
        let hi = counters.iter().copied().fold(f64::NEG_INFINITY, f64::max);
        let lo = counters.iter().copied().fold(f64::INFINITY, f64::min);
        imp = Some(py_round(hi - lo, 1));
    }
    (imp, exp)
}

#[derive(sqlx::FromRow)]
struct MeterRow {
    datalogger_sn: String,
    address: i32,
    plant_id: i32,
    device_name: Option<String>,
    device_type: Option<String>,
    history_synced_until: Option<NaiveDateTime>,
}

/// Python `devices.list_meters`: registered energy meters with stored freshness and today's
/// stored import / export.
pub async fn list_meters(pool: &PgPool, plant_ids: Option<&HashSet<i64>>, now: DateTime<Utc>) -> Result<Value> {
    let today = local_today(now);
    let ids = scope_ids(plant_ids);
    let plants = plants(pool, ids.as_deref()).await?;
    let pids: Vec<i32> = plants.keys().copied().collect();
    let reg = register(pool, &pids).await?;
    let meters: Vec<MeterRow> = sqlx::query_as::<_, MeterRow>(
        "SELECT datalogger_sn, address, plant_id, device_name, device_type, history_synced_until FROM growatt_meters \
         WHERE ($1::int[] IS NULL OR plant_id = ANY($1))",
    )
    .bind(ids.as_deref())
    .fetch_all(pool)
    .await?
    .into_iter()
    .filter(|m| plants.contains_key(&m.plant_id))
    .collect();

    let (start, end) = day_bounds(today);
    let mut recs: HashMap<(String, i32), Vec<(NaiveDateTime, Option<f64>, Option<f64>)>> = HashMap::new();
    if !meters.is_empty() {
        let mut dls: Vec<String> = meters.iter().map(|m| m.datalogger_sn.clone()).collect();
        dls.sort();
        dls.dedup();
        let rows: Vec<(String, i32, NaiveDateTime, Option<f64>, Option<f64>)> = sqlx::query_as(
            "SELECT datalogger_sn, address, timestamp, active_power_w, import_counter_kwh FROM growatt_meter_readings \
             WHERE timestamp >= $1 AND timestamp < $2 AND datalogger_sn = ANY($3) ORDER BY timestamp",
        )
        .bind(start)
        .bind(end)
        .bind(&dls)
        .fetch_all(pool)
        .await?;
        for (dl, addr, ts, p, c) in rows {
            recs.entry((dl, addr)).or_default().push((ts, p, c));
        }
    }

    let none = Vec::new();
    let mut out: Vec<(((bool, i32), String, i32, String, i32), Value)> = Vec::new();
    for m in &meters {
        let p = &plants[&m.plant_id];
        let rows = recs.get(&(m.datalogger_sn.clone(), m.address)).unwrap_or(&none);
        let (imp, exp) = meter_energy(rows);
        out.push((
            (phase_key(p.phase), p.name.clone(), m.plant_id, m.datalogger_sn.clone(), m.address),
            json!({
                "plant_id": m.plant_id,
                "plant_name": p.name,
                "phase": p.phase,
                "province": province(p, &reg),
                "datalogger_sn": m.datalogger_sn,
                "address": m.address,
                "device_name": m.device_name,
                "device_type": m.device_type,
                "last_record": local_iso(m.history_synced_until),
                "import_today_kwh": imp,
                "export_today_kwh": exp,
                "records_today": rows.len(),
            }),
        ));
    }
    out.sort_by(|a, b| a.0.cmp(&b.0));
    let with_meter: HashSet<i32> = meters.iter().map(|m| m.plant_id).collect();
    let mut without: Vec<(&str, i32)> =
        plants.iter().filter(|(pid, _)| !with_meter.contains(pid)).map(|(pid, p)| (p.name.as_str(), *pid)).collect();
    without.sort();
    Ok(json!({
        "meta": meta(pool, today).await?,
        "meters": out.into_iter().map(|(_, v)| v).collect::<Vec<_>>(),
        "plants_without_meter": without.into_iter().map(|(n, pid)| json!({"plant_id": pid, "plant_name": n})).collect::<Vec<_>>(),
    }))
}

// --------------------------------------------------------------------------- dataloggers

#[derive(Default)]
struct LoggerAcc {
    inverters: i64,
    sensors: i64,
    meters: i64,
    /// model → (count, first seen), for Python `Counter.most_common(1)` (ties: first inserted)
    models: Vec<(String, i64)>,
    last: Option<NaiveDateTime>,
}

impl LoggerAcc {
    fn seen(&mut self, ts: Option<NaiveDateTime>) {
        if let Some(t) = ts {
            if self.last.is_none_or(|l| t > l) {
                self.last = Some(t);
            }
        }
    }
}

/// Python `devices.list_dataloggers`: datalogger serials grouped from inverters, weather sensors
/// and meters, with the site register's SN.
pub async fn list_dataloggers(pool: &PgPool, plant_ids: Option<&HashSet<i64>>, now: DateTime<Utc>) -> Result<Value> {
    let today = local_today(now);
    let ids = scope_ids(plant_ids);
    let plants = plants(pool, ids.as_deref()).await?;
    let pids: Vec<i32> = plants.keys().copied().collect();
    let reg = register(pool, &pids).await?;
    let reg_sn = register_logger_sn(pool, &pids).await?;

    // (serial, plant) → what is behind it, in first-seen order
    let mut order: Vec<(String, i32)> = Vec::new();
    let mut acc: HashMap<(String, i32), LoggerAcc> = HashMap::new();
    let mut entry = |sn: Option<String>, pid: i32| -> Option<(String, i32)> {
        let sn = sn.unwrap_or_default().trim().to_owned();
        if sn.is_empty() || !plants.contains_key(&pid) {
            return None;
        }
        let k = (sn, pid);
        if !acc.contains_key(&k) {
            acc.insert(k.clone(), LoggerAcc::default());
            order.push(k.clone());
        }
        Some(k)
    };
    let mut keyed: Vec<(String, i32, &str, Option<String>, Option<NaiveDateTime>)> = Vec::new();
    let inv: Vec<(Option<String>, i32, Option<String>, Option<NaiveDateTime>)> = sqlx::query_as(
        "SELECT datalogger_sn, plant_id, datalogger_model, history_synced_until FROM growatt_inverters \
         WHERE not_installed_at IS NULL AND ($1::int[] IS NULL OR plant_id = ANY($1))",
    )
    .bind(ids.as_deref())
    .fetch_all(pool)
    .await?;
    for (sn, pid, model, last) in inv {
        if let Some((s, p)) = entry(sn, pid) {
            keyed.push((s, p, "inverters", model, last));
        }
    }
    for (kind, table) in [("sensors", "growatt_env_sensors"), ("meters", "growatt_meters")] {
        let rows: Vec<(String, i32, Option<NaiveDateTime>)> = sqlx::query_as(&format!(
            "SELECT datalogger_sn, plant_id, history_synced_until FROM {table} WHERE ($1::int[] IS NULL OR plant_id = ANY($1))"
        ))
        .bind(ids.as_deref())
        .fetch_all(pool)
        .await?;
        for (sn, pid, last) in rows {
            if let Some((s, p)) = entry(Some(sn), pid) {
                keyed.push((s, p, kind, None, last));
            }
        }
    }
    for (s, p, kind, model, last) in keyed {
        let e = acc.get_mut(&(s, p)).expect("entry made above");
        match kind {
            "inverters" => {
                e.inverters += 1;
                if let Some(m) = model.filter(|m| !m.is_empty()) {
                    match e.models.iter_mut().find(|(x, _)| *x == m) {
                        Some(x) => x.1 += 1,
                        None => e.models.push((m, 1)),
                    }
                }
            }
            "sensors" => e.sensors += 1,
            _ => e.meters += 1,
        }
        e.seen(last);
    }

    // "differs" only when none of the plant's serials matches the register's logger
    let matched_plants: HashSet<i32> = order
        .iter()
        .filter(|(sn, pid)| matches!(register_match(reg_sn.get(pid).map(String::as_str), sn), Some("match" | "prefix")))
        .map(|(_, pid)| *pid)
        .collect();

    let mut found: HashMap<i32, i64> = HashMap::new();
    let mut out: Vec<(((bool, i32), String, i32, String), Value)> = Vec::new();
    for k in &order {
        let (sn, pid) = k;
        let e = &acc[k];
        let p = &plants[pid];
        *found.entry(*pid).or_default() += 1;
        let rsn = reg_sn.get(pid);
        let mut rm = register_match(rsn.map(String::as_str), sn);
        if rm == Some("differs") && matched_plants.contains(pid) {
            rm = None;
        }
        // Counter.most_common(1): highest count, the first inserted among equals
        let mut model: Option<&(String, i64)> = None;
        for m in &e.models {
            if model.is_none_or(|b| m.1 > b.1) {
                model = Some(m);
            }
        }
        out.push((
            (phase_key(p.phase), p.name.clone(), *pid, sn.clone()),
            json!({
                "datalogger_sn": sn,
                "plant_id": pid,
                "plant_name": p.name,
                "phase": p.phase,
                "province": province(p, &reg),
                "model": model.map(|m| m.0.clone()),
                "inverters": e.inverters,
                "sensors": e.sensors,
                "meters": e.meters,
                "last_record": local_iso(e.last),
                "register_sn": rsn,
                "register_match": rm,
            }),
        ));
    }
    out.sort_by(|a, b| a.0.cmp(&b.0));
    let mut plant_rows: Vec<(&str, i32, Value)> = plants
        .iter()
        .map(|(pid, p)| {
            (
                p.name.as_str(),
                *pid,
                json!({
                    "plant_id": pid,
                    "plant_name": p.name,
                    "growatt_count": p.growatt_datalogger_count,
                    "found": found.get(pid).copied().unwrap_or(0),
                }),
            )
        })
        .collect();
    plant_rows.sort_by(|a, b| (a.0, a.1).cmp(&(b.0, b.1)));
    Ok(json!({
        "meta": meta(pool, today).await?,
        "dataloggers": out.into_iter().map(|(_, v)| v).collect::<Vec<_>>(),
        "plants": plant_rows.into_iter().map(|(_, _, v)| v).collect::<Vec<_>>(),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn inv(sn: &str, alias: Option<&str>) -> Inverter {
        Inverter {
            device_sn: sn.into(),
            plant_id: 1,
            datalogger_sn: None,
            model: None,
            device_types: None,
            alias: alias.map(Into::into),
            nominal_power_w: None,
            fw_version: None,
            inner_version: None,
            active_rate_pct: None,
            reactive_rate_pct: None,
            pf_setting: None,
            pf_model: None,
            export_limit: None,
            export_limit_rate_pct: None,
            on_off: None,
            info_synced_at: None,
            power_limit_pct: None,
            power_limit_read_at: None,
            device_model: None,
            datalogger_model: None,
            rated_power_w: None,
            param_synced_at: None,
            growatt_created_at: None,
            history_synced_until: None,
            not_installed_at: None,
            not_installed_by: None,
            not_installed_note: None,
            synced_at: Utc::now(),
        }
    }

    #[test]
    fn labels_like_python() {
        for (alias, want) in [
            ("INVERTER 3", "INV3"),
            ("Inverter no.3", "INV3"),
            ("Inverter03", "INV3"),
            ("INV No.05_ST2", "INV5"),
            ("INV1 MYHSF12345", "INV1"),
            ("(2) GKLRF", "INV2"),
            ("inv. no 7", "INV7"),
            ("Invent 4", "SN1"),
            ("something", "SN1"),
        ] {
            assert_eq!(inverter_label(&inv("SN1", Some(alias)), false), want, "{alias}");
        }
        assert_eq!(inverter_label(&inv("SN1", Some("sn1")), true), "INV1");
        assert_eq!(inverter_label(&inv("SN12", None), false), "SN12");
    }

    #[test]
    fn replaced() {
        assert!(is_replaced(Some("INV 1 old")));
        assert!(is_replaced(Some("INVERTER 1 (เก่า)")));
        assert!(is_replaced(Some("OLD")));
        assert!(!is_replaced(Some("golden")));
        assert!(!is_replaced(None));
    }

    #[test]
    fn register_matching() {
        assert_eq!(register_match(Some(" abc "), "ABC"), Some("match"));
        assert_eq!(register_match(Some("AB"), "abc"), Some("prefix"));
        assert_eq!(register_match(Some("X"), "abc"), Some("differs"));
        assert_eq!(register_match(Some(""), "abc"), None);
    }
}
