//! Live string operating points on the modelled string curve
//! (`/growatt/live/plants/{id}/strings/operating`). Port of backend/app/services/string_operating.py.
//!
//! Memory only, like every `/growatt/live/*` answer: built from the same cached live records as
//! `/live/plants/{id}/latest` and the plant's weather-sensor records (`/live/plants/{id}/weather`'s
//! cache). The database is only read (inverters, String Layout, fleet module); nothing is written.
//!
//! Per string: the newest record's V / I (measured), the ratio to the inverter's other strings in
//! the same record (`r_i`, from the live string check) and, where the module count is on String
//! Layout and a sensor gives irradiance and module temperature, the **modelled** curve at those
//! conditions with `r_imp` / `r_v` and the gates the point fails. Thresholds:
//! backend/app/services/string_live_criteria.json, read at compile time.

use std::collections::{BTreeSet, HashMap};
use std::sync::OnceLock;

use chrono::{Duration, NaiveDateTime};
use serde_json::{json, Map, Value};
use sqlx::PgPool;
use tcroof_core::iv_analysis::{ModuleSpecDict, ModuleStcSpec};
use tcroof_core::iv_operating::{judge_point, string_curve_at, JudgeCriteria, JudgeOptions, StringCurve};

use crate::common::{py_mean, py_round, Inverter, ServiceError, INVERTER_COLS};
use crate::live::string_check::{self, Layout as CheckLayout};
use crate::live::{LiveError, LiveService};
use crate::{fleet_settings, layout, weather};

/// Python `CRITERIA_FILE` (the same file, embedded at build time)
const CRITERIA_JSON: &str = include_str!("../../../../backend/app/services/string_live_criteria.json");
/// Python `TS_FMT`
const TS_FMT: &str = "%Y-%m-%d %H:%M:%S";
/// Python `MODULE_WP_TOLERANCE`: a string's own rating this far from the fleet module's = another module
const MODULE_WP_TOLERANCE: f64 = 0.01;
/// Python `string_curve_at(..., n_points=80)` default
const CURVE_POINTS: usize = 80;

/// Python `string_operating.criteria()`
pub fn criteria() -> &'static Value {
    static C: OnceLock<Value> = OnceLock::new();
    C.get_or_init(|| serde_json::from_str(CRITERIA_JSON).expect("string_live_criteria.json is valid JSON"))
}

/// Why the route fails: 404 (Python `LookupError`), 503 / 500 (live), or a database error.
#[derive(Debug, thiserror::Error)]
pub enum OperatingError {
    #[error("{0}")]
    NotFound(String),
    #[error(transparent)]
    Live(#[from] LiveError),
    #[error(transparent)]
    Service(#[from] ServiceError),
}

impl From<sqlx::Error> for OperatingError {
    fn from(e: sqlx::Error) -> Self {
        OperatingError::Service(ServiceError::Db(e))
    }
}

/// Python `_ts`
fn ts(v: Option<&Value>) -> Option<NaiveDateTime> {
    let s = v?.as_str()?;
    if s.is_empty() {
        return None;
    }
    NaiveDateTime::parse_from_str(s, TS_FMT).ok()
}

fn num(v: Option<&Value>) -> Option<f64> {
    v.and_then(Value::as_f64)
}

fn secs(d: Duration) -> f64 {
    d.num_microseconds().map(|u| u as f64 / 1e6).unwrap_or(d.num_seconds() as f64)
}

/// Python `_weather`: mean of the fresh sensors that read both irradiance and module temperature;
/// the reason when there is none.
fn mean_weather(rows: &[Value]) -> (Option<Value>, Option<String>) {
    let fresh: Vec<&Value> = rows.iter().filter(|r| r.get("stale").and_then(Value::as_bool) != Some(true)).collect();
    let use_: Vec<&Value> = fresh
        .iter()
        .copied()
        .filter(|r| num(r.get("irradiance_wm2")).is_some() && num(r.get("module_temp_c")).is_some())
        .collect();
    if use_.is_empty() {
        if fresh.is_empty() {
            return (None, Some("weather sensor not answering (no fresh record)".into()));
        }
        if fresh.iter().any(|r| num(r.get("irradiance_wm2")).is_some()) {
            return (None, Some("the sensor gives no module temperature: no modelled curve".into()));
        }
        return (None, Some("the sensor gives no irradiance: no modelled curve".into()));
    }
    let times: Vec<NaiveDateTime> = use_.iter().filter_map(|r| ts(r.get("timestamp"))).collect();
    let amb: Vec<f64> = use_.iter().filter_map(|r| num(r.get("ambient_temp_c"))).collect();
    let g: Vec<f64> = use_.iter().filter_map(|r| num(r.get("irradiance_wm2"))).collect();
    let t: Vec<f64> = use_.iter().filter_map(|r| num(r.get("module_temp_c"))).collect();
    (
        Some(json!({
            "irradiance_wm2": py_mean(&g).map(|x| py_round(x, 1)),
            "module_temp_c": py_mean(&t).map(|x| py_round(x, 1)),
            "ambient_temp_c": py_mean(&amb).map(|x| py_round(x, 1)),
            "timestamp": times.iter().max().map(|t| t.format(TS_FMT).to_string()),
            "sensors": use_.len(),
        })),
        None,
    )
}

/// Python `float(v)` of a fleet-module value (a number or numeric text); anything else = unset.
fn fleet_f(m: &Value, k: &str) -> Option<f64> {
    match m.get(k)? {
        Value::Number(n) => n.as_f64(),
        Value::String(s) => s.trim().parse().ok(),
        Value::Bool(b) => Some(if *b { 1.0 } else { 0.0 }),
        _ => None,
    }
}

/// Python `ModuleStcSpec.from_dict(fleet)`
fn module_spec(fleet: &Value) -> ModuleStcSpec {
    let f = |k: &str| fleet_f(fleet, k);
    ModuleStcSpec::from_dict(&ModuleSpecDict {
        wp: f("wp"),
        voc_stc: f("voc_stc"),
        isc_stc: f("isc_stc"),
        vmp_stc: f("vmp_stc"),
        imp_stc: f("imp_stc"),
        temp_coeff_pmax_pct: f("temp_coeff_pmax_pct"),
        temp_coeff_voc_pct: f("temp_coeff_voc_pct"),
        temp_coeff_isc_pct: f("temp_coeff_isc_pct"),
        rs_ohm: f("rs_ohm"),
        kappa_ohm_per_k: f("kappa_ohm_per_k"),
        first_year_lid_pct: f("first_year_lid_pct"),
        annual_degradation_pct: f("annual_degradation_pct"),
        p2_b1: f("p2_b1"),
        p2_b2: f("p2_b2"),
    })
}

/// Python `format(x, 'g')`
fn fmt_g(x: f64) -> String {
    crate::device_checks::fmt_g(x)
}

/// Python `string_operating.build`: the live envelope (`source`, `fetched_at`, `stale`,
/// `refresh_in_s`, `data`). `Live(Unavailable)` when no inverter record can be had (503).
pub async fn build(pool: &PgPool, live: &LiveService, plant_id: i64) -> Result<Value, OperatingError> {
    let invs: Vec<Inverter> = match i32::try_from(plant_id) {
        Ok(id) => sqlx::query_as(&format!(
            "SELECT {INVERTER_COLS} FROM growatt_inverters WHERE plant_id = $1 AND not_installed_at IS NULL ORDER BY device_sn"
        ))
        .bind(id)
        .fetch_all(pool)
        .await?,
        Err(_) => Vec::new(),
    };
    if invs.is_empty() {
        return Err(OperatingError::NotFound(format!("Plant {plant_id} has no inverters")));
    }
    let sns: Vec<String> = invs.iter().map(|i| i.device_sn.clone()).collect();
    let phase = crate::common::plant_phase(pool, plant_id).await?;
    let coords = crate::common::plant_coords(pool, Some(plant_id)).await?;
    let now = live.now_local(); // plant-local, the clock the live cache judges records by
    let env = live.plant_latest(plant_id, &sns, now.date(), phase, &coords).await?;
    let records: Vec<Value> = env["data"]["inverters"].as_array().cloned().unwrap_or_default();

    // weather: the same per-sensor cache as /live/plants/{id}/weather
    let mut weather: Option<Value> = None;
    let weather_reason: Option<String>;
    let mut refresh: Vec<f64> = vec![env["refresh_in_s"].as_f64().unwrap_or(f64::INFINITY)];
    let measured = weather::measured_fields(pool, plant_id, now - Duration::days(7)).await?;
    if measured.is_empty() {
        weather_reason = Some("no weather sensor on this plant: peer ratios only".into());
    } else {
        let sensors: Vec<(String, i64, Option<Vec<String>>)> = measured
            .into_iter()
            .map(|((dl, a), f)| (dl, i64::from(a), f.map(|v| v.into_iter().map(str::to_owned).collect())))
            .collect();
        match live.plant_weather(plant_id, &sensors, phase, &coords).await {
            Ok(wenv) => {
                let rows: Vec<Value> = wenv["data"]["sensors"].as_array().cloned().unwrap_or_default();
                let (w, r) = mean_weather(&rows);
                weather = w;
                weather_reason = r;
                refresh.push(wenv["refresh_in_s"].as_f64().unwrap_or(f64::INFINITY));
            }
            Err(LiveError::Unavailable(e)) => weather_reason = Some(format!("weather sensor unavailable: {e}")),
            Err(e) => return Err(e.into()),
        }
    }

    let cfg = criteria();
    let gates_cfg = &cfg["gates"];
    let gate = |k: &str| gates_cfg[k].as_f64().expect("criteria gate is a number");
    let crit = JudgeCriteria {
        stale_s: gate("stale_s"),
        weather_max_gap_s: gate("weather_max_gap_s"),
        irradiance_min_wm2: gate("irradiance_min_wm2"),
        sanity_current_max: gate("sanity_current_max"),
        sanity_voltage_max: gate("sanity_voltage_max"),
        off_mpp_voltage_ratio: gate("off_mpp_voltage_ratio"),
    };
    let fleet = fleet_settings::get_fleet_module(pool).await?;
    let spec = module_spec(&fleet);
    let own_layout = layout::load_layout(pool, &sns, false).await?;
    let check_layout: CheckLayout = layout::load_layout(pool, &sns, true)
        .await?
        .into_iter()
        .map(|((sn, no), (m, _))| ((sn, i64::from(no)), i64::from(m)))
        .collect();
    let wired: HashMap<String, BTreeSet<i64>> = layout::wired_inputs(pool, &sns)
        .await?
        .into_iter()
        .map(|(sn, set)| (sn, set.into_iter().map(i64::from).collect()))
        .collect();
    let check = string_check::check_plant(&records, &check_layout, &wired);
    let check_invs = &check["inverters"];
    let inv_by_sn: HashMap<&str, &Inverter> = invs.iter().map(|i| (i.device_sn.as_str(), i)).collect();
    let g = weather.as_ref().and_then(|w| num(w.get("irradiance_wm2")));
    let t_mod = weather.as_ref().and_then(|w| num(w.get("module_temp_c")));
    let w_ts = weather.as_ref().and_then(|w| ts(w.get("timestamp")));
    let clip_pct = gate("clip_pct_of_rated");

    // modules -> curve, in first-seen order (Python dict); None = no light to model
    let mut curves: Vec<(i64, Option<StringCurve>)> = Vec::new();
    let mut strings: Vec<Value> = Vec::new();
    let mut inverters: Vec<Value> = Vec::new();
    for rec in &records {
        let sn = rec["device_sn"].as_str().unwrap_or_default().to_owned();
        let inv = inv_by_sn.get(sn.as_str()).copied();
        let rec_ts = ts(rec.get("timestamp"));
        let age = rec_ts.map(|t| secs(now - t));
        let (rated, limit) = inv.map(|i| (i.nominal_power_w, i.active_limit_pct())).unwrap_or((None, None));
        let cap = rated.filter(|r| *r != 0.0).map(|r| r * limit.unwrap_or(100.0) / 100.0);
        let pac = num(rec.get("pac_w"));
        let limited = matches!((cap, pac), (Some(c), Some(p)) if c != 0.0 && p >= clip_pct / 100.0 * c);
        let stale = rec.get("stale").is_some_and(|v| match v {
            Value::Bool(b) => *b,
            Value::Null => false,
            Value::Number(n) => n.as_f64() != Some(0.0),
            Value::String(s) => !s.is_empty(),
            _ => true,
        });
        let status = rec.get("status").cloned().unwrap_or(Value::Null);
        inverters.push(json!({
            "device_sn": sn,
            "alias": inv.and_then(|i| i.alias.clone()),
            "timestamp": rec.get("timestamp").cloned().unwrap_or(Value::Null),
            "age_s": age.map(|a| a.round_ties_even() as i64),
            "status": status,
            "pac_w": rec.get("pac_w").cloned().unwrap_or(Value::Null),
            "limited": limited,
            "stale": stale,
        }));
        let inv_status = status.as_i64().or_else(|| status.as_f64().map(|f| f as i64));
        let verdicts = check_invs.get(sn.as_str()).and_then(|c| c.get("strings"));
        for s in rec.get("strings").and_then(Value::as_array).into_iter().flatten() {
            let no = s["string_no"].as_i64().or_else(|| s["string_no"].as_f64().map(|f| f as i64)).unwrap_or_default();
            let entry = i32::try_from(no).ok().and_then(|n| own_layout.get(&(sn.clone(), n)));
            let (modules, own_wp) = match entry {
                Some((m, wp)) => (Some(i64::from(*m)), *wp),
                None => (None, None),
            };
            let mut model_reason: Option<String> = None;
            let mut curve: Option<&StringCurve> = None;
            match modules {
                None => model_reason = Some("module count not entered (String Layout)".into()),
                Some(_) if own_wp.is_some_and(|w| (w - spec.wp).abs() > MODULE_WP_TOLERANCE * spec.wp) => {
                    model_reason = Some(format!(
                        "its module ({} Wp) is not the fleet module: no datasheet to model it",
                        fmt_g(own_wp.unwrap_or_default())
                    ));
                }
                Some(_) if weather.is_none() => model_reason = weather_reason.clone(),
                Some(m) => {
                    if !curves.iter().any(|(k, _)| *k == m) {
                        curves.push((m, string_curve_at(&spec, m, g, t_mod, CURVE_POINTS)));
                    }
                    curve = curves.iter().find(|(k, _)| *k == m).and_then(|(_, c)| c.as_ref());
                    if curve.is_none() {
                        model_reason = Some("no light to model (irradiance 0)".into());
                    }
                }
            }
            let gap = match (rec_ts, w_ts) {
                (Some(a), Some(b)) => Some(secs(a - b).abs()),
                _ => None,
            };
            let j = judge_point(
                num(s.get("voltage_v")),
                num(s.get("current_a")),
                curve,
                g,
                &crit,
                &JudgeOptions { inverter_status: inv_status, limited, record_age_s: age, weather_gap_s: gap },
            );
            let v = verdicts.and_then(|vs| vs.get(no.to_string())).cloned().unwrap_or(Value::Null);
            let dev = num(v.get("current_dev_pct"));
            let mut row = Map::new();
            row.insert("device_sn".into(), json!(sn));
            row.insert("string_no".into(), json!(no));
            row.insert("mppt_no".into(), s.get("mppt_no").cloned().unwrap_or(Value::Null));
            row.insert("modules".into(), json!(modules));
            row.insert("voltage_v".into(), s.get("voltage_v").cloned().unwrap_or(Value::Null));
            row.insert("current_a".into(), s.get("current_a").cloned().unwrap_or(Value::Null));
            row.insert("power_w".into(), s.get("power_w").cloned().unwrap_or(Value::Null));
            row.insert("timestamp".into(), rec.get("timestamp").cloned().unwrap_or(Value::Null));
            row.insert("r_i".into(), json!(dev.map(|d| py_round(1.0 + d / 100.0, 3))));
            if let Value::Object(jm) = serde_json::to_value(&j).expect("judgement serializes") {
                row.extend(jm);
            }
            row.insert("model_reason".into(), json!(model_reason));
            row.insert("live_status".into(), v.get("status").cloned().unwrap_or(Value::Null));
            row.insert("live_reason".into(), v.get("reason").cloned().unwrap_or(Value::Null));
            strings.push(Value::Object(row));
        }
    }

    let mut criteria_out = Map::new();
    criteria_out.insert("version".into(), cfg["version"].clone());
    criteria_out.insert("status".into(), cfg["status"].clone());
    if let Value::Object(gm) = gates_cfg {
        criteria_out.extend(gm.clone());
    }
    let module: Map<String, Value> =
        ["manufacturer", "model", "wp", "source"].iter().map(|k| ((*k).to_owned(), fleet.get(*k).cloned().unwrap_or(Value::Null))).collect();
    let errors = match env["data"].get("errors") {
        Some(Value::Object(m)) if !m.is_empty() => Value::Object(m.clone()),
        _ => json!({}),
    };
    let mut out = env.as_object().cloned().unwrap_or_default();
    let refresh_min = refresh.into_iter().fold(f64::INFINITY, f64::min);
    out.insert("refresh_in_s".into(), json!(refresh_min as i64));
    out.insert(
        "data".into(),
        json!({
            "plant_id": plant_id,
            "modelled": true,
            "weather": weather,
            "weather_reason": if weather.is_none() { json!(weather_reason) } else { Value::Null },
            "module": module,
            "criteria": criteria_out,
            "curves": curves.into_iter().filter_map(|(_, c)| c).collect::<Vec<_>>(),
            "inverters": inverters,
            "strings": strings,
            "errors": errors,
        }),
    );
    Ok(Value::Object(out))
}
