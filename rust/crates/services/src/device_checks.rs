//! Device checks for the Devices page (`GET /growatt/devices/checks`), ported from
//! backend/app/services/device_checks.py.
//!
//! Computed on request from stored data only (DB, `meta.source = "db"`); nothing is stored and no
//! issue is opened. Inverters marked not installed are left out of every check and count. The
//! list is scoped to `plant_ids` (None = every plant).

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};

use chrono::{DateTime, Duration, NaiveDate, NaiveDateTime, Utc};
use serde_json::{json, Map, Number, Value};
use sqlx::PgPool;

use crate::alarms::plant_tz;
use crate::common::{isoformat_utc, py_round, Inverter, Plant, Result, INVERTER_COLS, PLANT_COLS};
use crate::devices::inverter_label;
use crate::sensors;

/// Python `SETTING_KEY`
const SETTING_KEY: &str = "device_checks";
/// Python `PLANT_UTC_OFFSET_H`
const PLANT_UTC_OFFSET_H: f64 = 7.0;
/// Python `growatt_sync.registry.INFO_REFRESH_HOURS`
const INFO_REFRESH_HOURS: i64 = 20;
/// Python `growatt_sync.registry.PARAM_REFRESH_DAYS`
const PARAM_REFRESH_DAYS: i64 = 30;

/// Python `DEVICE_CHECKS` (all ints there)
const DEVICE_CHECKS: [(&str, i64); 8] = [
    ("never_reported_days", 3),
    ("silent_hours", 2),
    ("meter_silent_hours", 2),
    ("limit_below_pct", 100),
    ("info_stale_factor", 3),
    ("firmware_min_group", 5),
    ("daylight_start_h", 6),
    ("daylight_end_h", 18),
];

/// Python `SEVERITY`
fn severity(code: &str) -> &'static str {
    match code {
        "inverter_never_reported" | "inverter_silent" | "inverter_switched_off" | "logger_sn_mismatch" | "meter_silent"
        | "sensor_probe_missing" | "sensor_irradiance_zero_daylight" => "warn",
        _ => "info",
    }
}

/// Python `SENSOR_FLAG_CODE`
fn sensor_flag_code(code: &str) -> Option<&'static str> {
    match code {
        "probe_missing" => Some("sensor_probe_missing"),
        "irradiance_zero_daylight" => Some("sensor_irradiance_zero_daylight"),
        _ => None,
    }
}

/// The thresholds: JSON numbers as saved (int or float, shown as such in `meta.thresholds`).
struct Th(Map<String, Value>);

impl Th {
    fn get(&self, k: &str) -> f64 {
        self.0.get(k).and_then(Value::as_f64).unwrap_or(0.0)
    }
    fn json(&self, k: &str) -> Value {
        self.0.get(k).cloned().unwrap_or(Value::Null)
    }
    /// Python `f"{th[k]:g}"`
    fn g(&self, k: &str) -> String {
        fmt_g(self.get(k))
    }
}

/// Python `thresholds`: `DEVICE_CHECKS` with the numeric overrides saved under `app_settings`
/// `device_checks`.
async fn thresholds(pool: &PgPool) -> Result<Th> {
    let saved: Option<Value> = sqlx::query_scalar("SELECT value FROM app_settings WHERE key = $1")
        .bind(SETTING_KEY)
        .fetch_optional(pool)
        .await?;
    let mut out: Map<String, Value> = DEVICE_CHECKS.iter().map(|(k, v)| ((*k).to_owned(), json!(v))).collect();
    if let Some(Value::Object(m)) = saved {
        for (k, v) in m {
            if out.contains_key(&k) && v.is_number() {
                out.insert(k, v);
            }
        }
    }
    Ok(Th(out))
}

/// Python `format(x, 'g')`: 6 significant digits, trailing zeros dropped, exponent outside 1e-4..1e6.
pub fn fmt_g(x: f64) -> String {
    if x == 0.0 {
        return "0".into();
    }
    if !x.is_finite() {
        return if x.is_nan() { "nan".into() } else if x > 0.0 { "inf".into() } else { "-inf".into() };
    }
    let sci = format!("{x:.5e}");
    let (mant, exp) = sci.split_once('e').expect("exponent");
    let exp: i32 = exp.parse().expect("exponent digits");
    let strip = |s: String| {
        if s.contains('.') {
            s.trim_end_matches('0').trim_end_matches('.').to_owned()
        } else {
            s
        }
    };
    if (-4..6).contains(&exp) {
        strip(format!("{:.*}", (5 - exp) as usize, x))
    } else {
        format!("{}e{}{:02}", strip(mant.to_owned()), if exp < 0 { '-' } else { '+' }, exp.abs())
    }
}

/// Python `str(float)` for the values shown in reasons (rounded to 0.1, so no exponent forms)
fn py_float(x: f64) -> String {
    if x.fract() == 0.0 && x.abs() < 1e16 {
        format!("{x:.1}")
    } else {
        format!("{x}")
    }
}

/// Python `timedelta(hours=x)` (microsecond resolution)
fn hours(x: f64) -> Duration {
    Duration::microseconds((x * 3_600_000_000.0).round() as i64)
}

/// Python `_local`
fn local(ts: NaiveDateTime) -> String {
    ts.format("%Y-%m-%dT%H:%M:%S").to_string()
}

/// Python `_hours`
fn hours_of(td: Duration) -> f64 {
    py_round(td.num_microseconds().unwrap_or(i64::MAX) as f64 / 1e6 / 3600.0, 1)
}

/// Python `fw_read`: a firmware version Growatt actually read (not empty, no masked digits).
pub fn fw_read(fw: Option<&str>) -> bool {
    fw.is_some_and(|f| !f.is_empty() && !f.to_lowercase().contains('x'))
}

/// Python `_daylight`: plant-local (sunrise, sunset) from the plant's coordinates, else the
/// fallback hours. A plant at 0,0 has no location.
fn daylight(p: &Plant, day: NaiveDate, th: &Th) -> (NaiveDateTime, NaiveDateTime) {
    if let (Some(lat), Some(lon)) = (p.latitude, p.longitude) {
        if !(lat == 0.0 && lon == 0.0) {
            if let Some(st) = tcroof_core::sun::sun_times(day, lat, lon, PLANT_UTC_OFFSET_H) {
                return st;
            }
        }
    }
    let day0 = day.and_hms_opt(0, 0, 0).expect("midnight");
    (day0 + hours(th.get("daylight_start_h")), day0 + hours(th.get("daylight_end_h")))
}

/// Python `_check`
#[allow(clippy::too_many_arguments)]
fn check(
    code: &str,
    kind: &str,
    plant: &Plant,
    device_key: Option<String>,
    device_label: Option<String>,
    reason: String,
    params: Value,
    fix_path: Option<String>,
    sev: Option<&str>,
) -> Value {
    json!({
        "code": code,
        "severity": sev.unwrap_or_else(|| severity(code)),
        "kind": kind,
        "plant_id": plant.plant_id,
        "plant_name": plant.name,
        "device_key": device_key,
        "device_label": device_label,
        "reason": reason,
        "params": params,
        "fix_path": fix_path,
    })
}

/// Python `_Ctx`: the plants in scope, their installed inverters, the clock.
struct Ctx {
    plant_ids: Option<HashSet<i64>>,
    th: Th,
    now_utc: DateTime<Utc>,
    now_local: NaiveDateTime,
    /// in Python's dict order (plants by name)
    plants: Vec<Plant>,
    plant_idx: HashMap<i32, usize>,
    /// installed inverters per plant, plant_id order
    by_plant: BTreeMap<i32, Vec<Inverter>>,
    daylight: HashMap<i32, (NaiveDateTime, NaiveDateTime)>,
    synced: Option<DateTime<Utc>>,
}

impl Ctx {
    fn pids(&self) -> Vec<i32> {
        self.plants.iter().map(|p| p.plant_id).collect()
    }
    fn plant(&self, pid: i32) -> Option<&Plant> {
        self.plant_idx.get(&pid).map(|i| &self.plants[*i])
    }
    /// Python `_Ctx.in_daylight`
    fn in_daylight(&self, pid: i32) -> bool {
        let (rise, sset) = self.daylight[&pid];
        rise <= self.now_local && self.now_local < sset
    }
}

/// Python `_context`
async fn context(pool: &PgPool, plant_ids: Option<&HashSet<i64>>, now: DateTime<Utc>) -> Result<Ctx> {
    let now_local = now.with_timezone(&plant_tz()).naive_local();
    let th = thresholds(pool).await?;
    let ids = crate::devices::scope_ids(plant_ids);
    let plants: Vec<Plant> = sqlx::query_as(&format!(
        "SELECT {PLANT_COLS} FROM growatt_plants WHERE ($1::int[] IS NULL OR plant_id = ANY($1)) ORDER BY name"
    ))
    .bind(ids.as_deref())
    .fetch_all(pool)
    .await?;
    let pids: Vec<i32> = plants.iter().map(|p| p.plant_id).collect();
    let mut by_plant: BTreeMap<i32, Vec<Inverter>> = BTreeMap::new();
    let invs: Vec<Inverter> = sqlx::query_as(&format!(
        "SELECT {INVERTER_COLS} FROM growatt_inverters WHERE plant_id = ANY($1) AND not_installed_at IS NULL \
         ORDER BY plant_id, device_sn"
    ))
    .bind(&pids)
    .fetch_all(pool)
    .await?;
    for i in invs {
        by_plant.entry(i.plant_id).or_default().push(i);
    }
    let daylight = plants.iter().map(|p| (p.plant_id, daylight(p, now_local.date(), &th))).collect();
    Ok(Ctx {
        plant_ids: plant_ids.cloned(),
        th,
        now_utc: now,
        now_local,
        plant_idx: plants.iter().enumerate().map(|(i, p)| (p.plant_id, i)).collect(),
        plants,
        by_plant,
        daylight,
        synced: sensors::last_env_sync(pool).await?,
    })
}

/// Python `_firmware_majority`: {device model: (firmware most run, inverters on it, group size)}
/// over the whole installed fleet; small groups and ties left out.
async fn firmware_majority(pool: &PgPool, th: &Th) -> Result<HashMap<String, (String, i64, i64)>> {
    let rows: Vec<(String, String)> = sqlx::query_as(
        "SELECT device_model, fw_version FROM growatt_inverters \
         WHERE not_installed_at IS NULL AND device_model IS NOT NULL AND fw_version IS NOT NULL",
    )
    .fetch_all(pool)
    .await?;
    // per model: firmware counts in first-seen order (Counter.most_common keeps it among equals)
    let mut fleet: HashMap<String, Vec<(String, i64)>> = HashMap::new();
    for (dm, fw) in rows {
        if dm.is_empty() || !fw_read(Some(&fw)) {
            continue;
        }
        let c = fleet.entry(dm).or_default();
        match c.iter_mut().find(|(f, _)| *f == fw) {
            Some(x) => x.1 += 1,
            None => c.push((fw, 1)),
        }
    }
    let mut out = HashMap::new();
    for (dm, mut cnt) in fleet {
        let total: i64 = cnt.iter().map(|x| x.1).sum();
        cnt.sort_by_key(|a| std::cmp::Reverse(a.1)); // stable: first seen wins among equals
        if total as f64 >= th.get("firmware_min_group") && cnt.len() > 1 && cnt[0].1 > cnt[1].1 {
            out.insert(dm, (cnt[0].0.clone(), cnt[0].1, total));
        }
    }
    Ok(out)
}

type Found = (&'static str, String, Value, Option<&'static str>);

/// Python `_reporting_checks`: `inverter_never_reported` / `inverter_silent` of one inverter.
fn reporting_checks(c: &Ctx, inv: &Inverter, label: &str, newest_today: &[(String, NaiveDateTime)], judge_silent: bool) -> Vec<Found> {
    let sn = &inv.device_sn;
    let Some(last) = inv.history_synced_until else {
        let Some(created) = inv.growatt_created_at else {
            return vec![(
                "inverter_never_reported",
                format!("{label} ({sn}): no record stored, and Growatt gives no create date to tell how long it has been listed"),
                json!({"growatt_created_at": null, "days": null}),
                Some("info"),
            )];
        };
        if created < c.now_local - hours(c.th.get("never_reported_days") * 24.0) {
            let days = (c.now_local - created).num_seconds().div_euclid(86400);
            return vec![(
                "inverter_never_reported",
                format!(
                    "{label} ({sn}): no record stored since it was added to Growatt on {} ({days} days ago): mark it not installed, or check it on site",
                    created.date().format("%Y-%m-%d")
                ),
                json!({"growatt_created_at": local(created), "days": days}),
                None,
            )];
        }
        return vec![];
    };
    if !judge_silent {
        return vec![];
    }
    let Some(reference) = newest_today.iter().filter(|(s, _)| s != sn).map(|(_, t)| *t).max() else { return vec![] };
    let gap = reference - last;
    if gap <= hours(c.th.get("silent_hours")) {
        return vec![];
    }
    vec![(
        "inverter_silent",
        format!(
            "{label} ({sn}): newest stored record {}, {} h behind the plant's other inverters (newest {}); more than {} h",
            local(last),
            py_float(hours_of(gap)),
            local(reference),
            c.th.g("silent_hours")
        ),
        json!({"last_record": local(last), "plant_newest": local(reference), "behind_h": hours_of(gap), "limit_h": c.th.json("silent_hours")}),
        None,
    )]
}

/// Python `datetime.isoformat(timespec='minutes')` of an aware UTC time
fn iso_minutes(t: DateTime<Utc>) -> String {
    t.format("%Y-%m-%dT%H:%M+00:00").to_string()
}

/// Python `_setting_checks`: switched off, limited, nameplate missing, info not read, firmware minority.
fn setting_checks(c: &Ctx, inv: &Inverter, label: &str, fw_major: &HashMap<String, (String, i64, i64)>) -> Vec<Found> {
    let sn = &inv.device_sn;
    let mut out: Vec<Found> = Vec::new();
    if inv.on_off == Some(0) {
        out.push(("inverter_switched_off", format!("{label} ({sn}) is switched off in its settings (on/off = 0)"), json!({"on_off": 0}), None));
    }
    if let Some(lim) = inv.active_limit_pct() {
        if lim < c.th.get("limit_below_pct") {
            let src = if inv.power_limit_pct.is_some() { "read_power" } else { "max_data_info" };
            out.push((
                "inverter_limited",
                format!("{label} ({sn}): active power limit set to {} % (configured, {src})", fmt_g(lim)),
                json!({"limit_pct": lim, "source": src}),
                None,
            ));
        }
    }
    if inv.nominal_power_w.is_none() && inv.rated_power_w.is_none() {
        out.push((
            "nameplate_missing",
            format!("{label} ({sn}): no rated power from Growatt (nominal and model rating both missing): rated AC kW and the clipping checks are off"),
            json!({"nominal_power_w": null, "rated_power_w": null}),
            None,
        ));
    }

    let factor = c.th.get("info_stale_factor");
    let info_cut = c.now_utc - hours(INFO_REFRESH_HOURS as f64 * factor);
    let param_cut = c.now_utc - hours(PARAM_REFRESH_DAYS as f64 * factor * 24.0);
    let mut stale: Vec<String> = Vec::new();
    let read = |at: Option<DateTime<Utc>>| match at {
        None => "never read".to_owned(),
        Some(t) => format!("last read {}", iso_minutes(t)),
    };
    if inv.info_synced_at.is_none_or(|t| t < info_cut) {
        stale.push(format!("inverter info {} (refresh every {INFO_REFRESH_HOURS} h)", read(inv.info_synced_at)));
    }
    if inv.param_synced_at.is_none_or(|t| t < param_cut) {
        stale.push(format!("model parameters {} (refresh every {PARAM_REFRESH_DAYS} days)", read(inv.param_synced_at)));
    }
    if !stale.is_empty() {
        out.push((
            "info_not_read",
            format!("{label} ({sn}): {}", stale.join("; ")),
            json!({
                "info_synced_at": inv.info_synced_at.map(isoformat_utc),
                "param_synced_at": inv.param_synced_at.map(isoformat_utc),
                "info_refresh_h": INFO_REFRESH_HOURS,
                "param_refresh_days": PARAM_REFRESH_DAYS,
                "factor": c.th.json("info_stale_factor"),
            }),
            None,
        ));
    }

    if let Some((fw0, n, group)) = fw_major.get(inv.device_model.as_deref().unwrap_or("")) {
        if fw_read(inv.fw_version.as_deref()) && inv.fw_version.as_deref() != Some(fw0.as_str()) {
            let fw = inv.fw_version.clone().unwrap_or_default();
            let dm = inv.device_model.clone().unwrap_or_default();
            out.push((
                "firmware_minority",
                format!("{label} ({sn}): firmware {fw}, while {n} of {group} {dm} inverters run {fw0}"),
                json!({"fw_version": fw, "majority_fw": fw0, "majority": n, "group": group, "device_model": dm}),
                None,
            ));
        }
    }
    out
}

/// Python `_inverter_checks`: every per-inverter check, and `no_string_layout` (one per plant).
async fn inverter_checks(pool: &PgPool, c: &Ctx) -> Result<Vec<Value>> {
    let sns: Vec<String> = c.by_plant.values().flatten().map(|i| i.device_sn.clone()).collect();
    let with_layout: HashSet<String> = if sns.is_empty() {
        HashSet::new()
    } else {
        sqlx::query_scalar("SELECT DISTINCT device_sn FROM growatt_string_layouts WHERE device_sn = ANY($1)")
            .bind(&sns)
            .fetch_all(pool)
            .await?
            .into_iter()
            .collect()
    };
    let fw_major = firmware_majority(pool, &c.th).await?;
    let day_start = c.now_local.date().and_hms_opt(0, 0, 0).expect("midnight");

    let mut checks = Vec::new();
    for (pid, plist) in &c.by_plant {
        let plant = c.plant(*pid).expect("inverters only of plants in scope");
        let sole = plist.len() == 1;
        let newest_today: Vec<(String, NaiveDateTime)> = plist
            .iter()
            .filter_map(|i| i.history_synced_until.filter(|t| *t >= day_start).map(|t| (i.device_sn.clone(), t)))
            .collect();
        let judge_silent = c.in_daylight(*pid);
        for inv in plist {
            let label = inverter_label(inv, sole);
            let mut found = reporting_checks(c, inv, &label, &newest_today, judge_silent);
            found.extend(setting_checks(c, inv, &label, &fw_major));
            for (code, reason, params, sev) in found {
                checks.push(check(
                    code,
                    "inverter",
                    plant,
                    Some(inv.device_sn.clone()),
                    Some(label.clone()),
                    reason,
                    params,
                    Some(format!("/plant/{pid}/inverters?sn={}", inv.device_sn)),
                    sev,
                ));
            }
        }
        let no_layout: Vec<(String, &str)> =
            plist.iter().filter(|i| !with_layout.contains(&i.device_sn)).map(|i| (inverter_label(i, sole), i.device_sn.as_str())).collect();
        if !no_layout.is_empty() {
            let names = no_layout
                .iter()
                .map(|(lab, sn)| if lab != sn { format!("{lab} ({sn})") } else { (*sn).to_owned() })
                .collect::<Vec<_>>()
                .join(", ");
            checks.push(check(
                "no_string_layout",
                "plant",
                plant,
                None,
                None,
                format!(
                    "{} of {} installed inverters have no String Layout ({names}): voltage per module and per-kWp peer checks stay off",
                    no_layout.len(),
                    plist.len()
                ),
                json!({
                    "missing": no_layout.len(),
                    "installed": plist.len(),
                    "inverters": no_layout.iter().map(|(_, sn)| *sn).collect::<Vec<_>>().join(", "),
                }),
                Some(format!("/plant/{pid}/string-layout?inv={}", no_layout[0].1)),
                None,
            ));
        }
    }
    Ok(checks)
}

#[derive(sqlx::FromRow)]
struct MeterRow {
    datalogger_sn: String,
    address: i32,
    plant_id: i32,
    device_name: Option<String>,
    history_synced_until: Option<NaiveDateTime>,
}

/// Python `_plant_checks`: `inverter_count_mismatch`, `no_meter` and `meter_silent`
/// (`meter_history_enabled` is `METER_HISTORY_ENABLED`).
async fn plant_checks(pool: &PgPool, c: &Ctx, meter_history_enabled: bool) -> Result<Vec<Value>> {
    let pids = c.pids();
    // registry total per plant, not installed included (Growatt lists those too)
    let totals: HashMap<i32, i64> =
        sqlx::query_as::<_, (i32, i64)>("SELECT plant_id, count(*) FROM growatt_inverters WHERE plant_id = ANY($1) GROUP BY plant_id")
            .bind(&pids)
            .fetch_all(pool)
            .await?
            .into_iter()
            .collect();
    let mut meters: HashMap<i32, Vec<MeterRow>> = HashMap::new();
    let rows: Vec<MeterRow> = sqlx::query_as(
        "SELECT datalogger_sn, address, plant_id, device_name, history_synced_until FROM growatt_meters \
         WHERE plant_id = ANY($1) ORDER BY datalogger_sn, address",
    )
    .bind(&pids)
    .fetch_all(pool)
    .await?;
    for m in rows {
        meters.entry(m.plant_id).or_default().push(m);
    }
    let meter_gap = hours(c.th.get("meter_silent_hours"));
    let synced_local = c.synced.map(|s| s.with_timezone(&plant_tz()).naive_local());
    let meter_ref = synced_local.map_or(c.now_local, |s| c.now_local.min(s));

    let mut checks = Vec::new();
    for plant in &c.plants {
        let pid = plant.plant_id;
        let n = c.by_plant.get(&pid).map_or(0, Vec::len) as i64;
        let total = totals.get(&pid).copied().unwrap_or(0);
        if let Some(gc) = plant.growatt_inverter_count {
            let gc = i64::from(gc);
            if gc != n && gc != total {
                let extra = if total != n { format!(" ({total} with those marked not installed)") } else { String::new() };
                checks.push(check(
                    "inverter_count_mismatch",
                    "plant",
                    plant,
                    None,
                    None,
                    format!("{n} installed inverters in the registry{extra}, {gc} entered in Growatt"),
                    json!({"installed": n, "registry_total": total, "growatt_count": gc}),
                    Some(format!("/plant/{pid}/inverters")),
                    None,
                ));
            }
        }
        let Some(ms) = meters.get(&pid).filter(|m| !m.is_empty()) else {
            checks.push(check(
                "no_meter",
                "plant",
                plant,
                None,
                None,
                "No energy meter registered in Growatt: grid import / export are not measured".into(),
                json!({}),
                Some(format!("/plant/{pid}")),
                None,
            ));
            continue;
        };
        if !meter_history_enabled || !c.in_daylight(pid) {
            continue;
        }
        for m in ms {
            let key = format!("{}:{}", m.datalogger_sn, m.address);
            let name = m.device_name.clone().filter(|s| !s.is_empty()).unwrap_or_else(|| key.clone());
            let (reason, params) = match m.history_synced_until {
                None => (
                    format!("Meter {name}: no record ever stored (never stored since it was registered)"),
                    json!({"last_record": null, "behind_h": null, "limit_h": c.th.json("meter_silent_hours")}),
                ),
                Some(last) if meter_ref - last > meter_gap => (
                    format!(
                        "Meter {name}: newest stored record {}, {} h before {}; more than {} h",
                        local(last),
                        py_float(hours_of(meter_ref - last)),
                        local(meter_ref),
                        c.th.g("meter_silent_hours")
                    ),
                    json!({
                        "last_record": local(last),
                        "reference": local(meter_ref),
                        "behind_h": hours_of(meter_ref - last),
                        "limit_h": c.th.json("meter_silent_hours"),
                    }),
                ),
                Some(_) => continue,
            };
            checks.push(check("meter_silent", "meter", plant, Some(key), m.device_name.clone(), reason, params, Some(format!("/plant/{pid}")), None));
        }
    }
    Ok(checks)
}

/// Python `site_register._logger_plants`: every datalogger serial Growatt reports (installed
/// inverters, weather sensors, meters) → its plants.
async fn logger_plants(pool: &PgPool) -> Result<HashMap<String, BTreeSet<i32>>> {
    let rows: Vec<(String, i32)> = sqlx::query_as(
        "SELECT DISTINCT datalogger_sn, plant_id FROM growatt_inverters WHERE datalogger_sn IS NOT NULL AND not_installed_at IS NULL \
         UNION ALL SELECT DISTINCT datalogger_sn, plant_id FROM growatt_env_sensors WHERE datalogger_sn IS NOT NULL \
         UNION ALL SELECT DISTINCT datalogger_sn, plant_id FROM growatt_meters WHERE datalogger_sn IS NOT NULL",
    )
    .fetch_all(pool)
    .await?;
    let mut out: HashMap<String, BTreeSet<i32>> = HashMap::new();
    for (sn, pid) in rows {
        if !sn.is_empty() {
            out.entry(sn.trim().to_uppercase()).or_default().insert(pid);
        }
    }
    Ok(out)
}

/// Python `_register_checks`: `logger_sn_mismatch`, the site register's own `logger_sn_differs`
/// check (`site_register.list_all` + `_checks`, only that check).
async fn register_checks(pool: &PgPool, c: &Ctx) -> Result<Vec<Value>> {
    let ids = crate::devices::scope_ids(c.plant_ids.as_ref());
    let regs: Vec<(String, Option<i32>)> = sqlx::query_as(
        "SELECT site_code, plant_id FROM site_register WHERE ($1::int[] IS NULL OR plant_id = ANY($1)) ORDER BY site_code",
    )
    .bind(ids.as_deref())
    .fetch_all(pool)
    .await?;
    let regs: Vec<(String, i32)> = regs.into_iter().filter_map(|(code, pid)| pid.filter(|p| c.plant(*p).is_some()).map(|p| (code, p))).collect();
    if regs.is_empty() {
        return Ok(vec![]);
    }
    let codes: Vec<String> = regs.iter().map(|r| r.0.clone()).collect();
    // the station's first datalogger device (lowest seq); its serial may be null
    let loggers: HashMap<String, Option<String>> = sqlx::query_as::<_, (String, Option<String>)>(
        "SELECT DISTINCT ON (site_code) site_code, serial FROM site_devices WHERE site_code = ANY($1) AND kind = 'datalogger' \
         ORDER BY site_code, seq",
    )
    .bind(&codes)
    .fetch_all(pool)
    .await?
    .into_iter()
    .collect();
    let mut growatt_sns: HashMap<i32, Vec<String>> = HashMap::new();
    for (sn, pids) in logger_plants(pool).await? {
        for pid in pids {
            growatt_sns.entry(pid).or_default().push(sn.clone());
        }
    }
    for v in growatt_sns.values_mut() {
        v.sort();
    }

    let mut checks = Vec::new();
    for (code, pid) in &regs {
        let logger = loggers.get(code).cloned().flatten();
        // Python `_text(...)`: stripped, empty = None
        let sn = logger.as_deref().map(str::trim).filter(|s| !s.is_empty()).map(str::to_uppercase);
        let g = growatt_sns.get(pid).filter(|v| !v.is_empty());
        let (Some(sn), Some(g)) = (sn, g) else { continue };
        if g.contains(&sn) {
            continue;
        }
        let text = format!("Logger SN {sn} here, {} in Growatt", g.join(", "));
        let plant = c.plant(*pid).expect("filtered above");
        checks.push(check(
            "logger_sn_mismatch",
            "datalogger",
            plant,
            Some(sn.clone()),
            Some(format!("Site register {code}")),
            format!("Site register {code}: {text}"),
            json!({"site_code": code, "register_sn": sn, "growatt_sns": g.join(", ")}),
            Some(format!("/plant/{pid}/documents")),
            None,
        ));
    }
    Ok(checks)
}

/// Python `_sensor_checks`: the weather-sensor list's own stored-data flags for today, mapped one to one.
async fn sensor_checks(pool: &PgPool, c: &Ctx, alarm_coverage_pct: f64) -> Result<Vec<Value>> {
    let sens = sensors::list_sensors(pool, c.plant_ids.as_ref(), c.now_local, None, alarm_coverage_pct).await?;
    let mut checks = Vec::new();
    for s in sens["sensors"].as_array().into_iter().flatten() {
        let Some(plant) = s["plant_id"].as_i64().and_then(|p| i32::try_from(p).ok()).and_then(|p| c.plant(p)) else { continue };
        let key = s["key"].as_str().unwrap_or_default().to_owned();
        let name = s["device_name"].as_str().filter(|n| !n.is_empty()).unwrap_or(&key).to_owned();
        for f in s["flags"].as_array().into_iter().flatten() {
            let Some(code) = f["code"].as_str().and_then(sensor_flag_code) else { continue };
            let mut params = Map::new();
            params.insert("field".into(), f.get("field").cloned().unwrap_or(Value::Null));
            if let Some(Value::Object(p)) = f.get("params") {
                params.extend(p.clone());
            }
            checks.push(check(
                code,
                "sensor",
                plant,
                Some(key.clone()),
                s["device_name"].as_str().map(str::to_owned),
                format!("Sensor {name}: {}", f["reason"].as_str().unwrap_or_default()),
                Value::Object(params),
                Some(format!("/plant/{}/sensors?sensor={key}", plant.plant_id)),
                None,
            ));
        }
    }
    Ok(checks)
}

/// Python `device_checks.build`: the `DeviceCheckList` for the plants in `plant_ids` (None = all).
/// `meter_history_enabled` = `METER_HISTORY_ENABLED`, `alarm_coverage_pct` =
/// `SENSOR_ALARM_COVERAGE_PCT` (only passed through to the sensor list).
pub async fn build(
    pool: &PgPool,
    plant_ids: Option<&HashSet<i64>>,
    now: DateTime<Utc>,
    meter_history_enabled: bool,
    alarm_coverage_pct: f64,
) -> Result<Value> {
    let c = context(pool, plant_ids, now).await?;
    let mut checks = inverter_checks(pool, &c).await?;
    checks.extend(plant_checks(pool, &c, meter_history_enabled).await?);
    checks.extend(register_checks(pool, &c).await?);
    checks.extend(sensor_checks(pool, &c, alarm_coverage_pct).await?);
    let sort_key = |x: &Value| {
        (
            if x["severity"] == "warn" { 0 } else { 1 },
            x["plant_name"].as_str().unwrap_or_default().to_lowercase(),
            x["code"].as_str().unwrap_or_default().to_owned(),
            x["device_key"].as_str().unwrap_or_default().to_owned(),
        )
    };
    checks.sort_by_key(sort_key); // stable, as Python's sort
    let warn = checks.iter().filter(|x| x["severity"] == "warn").count();
    let mut by_code: Map<String, Value> = Map::new();
    for x in &checks {
        let k = x["code"].as_str().unwrap_or_default().to_owned();
        let n = by_code.get(&k).and_then(Value::as_u64).unwrap_or(0) + 1;
        by_code.insert(k, Value::Number(Number::from(n)));
    }
    Ok(json!({
        "meta": {
            "source": "db",
            "day": c.now_local.date().format("%Y-%m-%d").to_string(),
            "synced_at": c.synced.map(isoformat_utc),
            "thresholds": Value::Object(c.th.0),
        },
        "summary": {"total": checks.len(), "warn": warn, "info": checks.len() - warn, "by_code": by_code},
        "checks": checks,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn g_format_like_python() {
        for (x, want) in [(2.0, "2"), (2.5, "2.5"), (100.0, "100"), (99.95, "99.95"), (1234567.0, "1.23457e+06"), (0.0001, "0.0001"), (0.00001, "1e-05"), (80.123456, "80.1235")] {
            assert_eq!(fmt_g(x), want, "{x}");
        }
    }

    #[test]
    fn float_str() {
        assert_eq!(py_float(3.0), "3.0");
        assert_eq!(py_float(26.1), "26.1");
    }

    #[test]
    fn firmware_read() {
        assert!(fw_read(Some("TL1.0")));
        assert!(!fw_read(Some("xx1.0")));
        assert!(!fw_read(Some("")));
        assert!(!fw_read(None));
    }
}
