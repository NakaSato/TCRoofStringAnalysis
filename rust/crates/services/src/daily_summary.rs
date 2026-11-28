//! Port of the daily documents of backend/app/services/daily_summary.py (`build_day_docs`,
//! `build_registry_docs`, `plant_links`, `plant_sites`, `run`) and of `jobs._publish`
//! ([`publish_day`]), which the `publish_today` / `publish_yesterday` jobs and the
//! `google_weather` job (re-publishing yesterday) call. The machinery (`publish`, the change
//! check, the write budget, the sinks) is `publish.rs`.
//!
//! Layout (Python module docstring): `daily/{day}` (fleet summary, every plant embedded, written
//! last), `daily/{day}/plants/{id}`, `daily/{day}/inverters/{sn}`, and the static registry
//! `plants/{id}`, `inverters/{sn}`, `config/*`. Only daily summaries and static fields: never a
//! realtime value.

use std::collections::{BTreeMap, HashMap};

use chrono::{NaiveDate, NaiveDateTime};
use serde_json::{json, Map, Value};
use sqlx::PgPool;

use crate::check_slots::{self, CheckConfig};
use crate::common::{plant_rated_ac_w, plausible_capacity_kwp, py_round, py_sum, Plant, ServiceError, PLANT_COLS};
use crate::google_weather_stored;
use crate::overview::build_plant_overview;
use crate::publish::{build_inverter_docs, make_sink, publish, Doc, PublishReport, SinkConfig, SCHEMA_VERSION};

/// Python `daily_summary.TOP_ANOMALIES`
pub const TOP_ANOMALIES: usize = 10;
/// Python `daily_summary.SITE_FIELDS`: O&M site register fields that go to Firestore
pub const SITE_FIELDS: [&str; 4] = ["site_code", "project_phase", "province", "cod_actual"];

/// A publish that failed: Python's exception class and message (the run's `error`).
#[derive(Debug, Clone, thiserror::Error)]
#[error("{kind}: {message}")]
pub struct PublishError {
    pub kind: String,
    pub message: String,
}

impl From<ServiceError> for PublishError {
    fn from(e: ServiceError) -> Self {
        match e {
            ServiceError::Db(e) => PublishError { kind: "DatabaseError".into(), message: e.to_string() },
            ServiceError::NotFound(m) => PublishError { kind: "GrowattNotFound".into(), message: m },
            ServiceError::Invalid(m) => PublishError { kind: "ValueError".into(), message: m },
        }
    }
}

impl From<sqlx::Error> for PublishError {
    fn from(e: sqlx::Error) -> Self {
        PublishError { kind: "DatabaseError".into(), message: e.to_string() }
    }
}

/// What a publish reads from the settings.
#[derive(Debug, Clone)]
pub struct PublishConfig {
    /// `PUBLISH_SINK` and the sink's settings
    pub sink: SinkConfig,
    /// `PUBLISH_DAILY_WRITE_BUDGET`
    pub budget: i64,
    /// the PWA check slots and Google Weather
    pub checks: CheckConfig,
}

// --------------------------------------------------------------------------- build

/// Python `_round2`
fn round2(v: &Value) -> Value {
    json!(v.as_f64().map(|x| py_round(x, 2)))
}

/// Python `_hourly_kw`: mean plant AC power per hour (24 values); a meter-only slot (no inverter
/// record, `pac_kw` null) does not count.
fn hourly_kw(timeseries: &[Value]) -> Vec<Option<f64>> {
    let mut acc: BTreeMap<u32, Vec<f64>> = BTreeMap::new();
    for r in timeseries {
        let Some(kw) = r["pac_kw"].as_f64() else { continue };
        let Some(h) = r["timestamp"].as_str().and_then(|t| t.get(11..13)).and_then(|h| h.parse::<u32>().ok()) else { continue };
        acc.entry(h).or_default().push(kw);
    }
    (0..24).map(|h| acc.get(&h).filter(|v| !v.is_empty()).map(|v| py_round(py_sum(v.iter().copied()) / v.len() as f64, 2))).collect()
}

/// Python `round(sum(x or 0.0 for x in xs), 2)`: 0 (an int) for no values, else a float.
fn round_sum(xs: &[&Value]) -> Value {
    if xs.is_empty() {
        return json!(0);
    }
    json!(py_round(py_sum(xs.iter().map(|v| v.as_f64().unwrap_or(0.0))), 2))
}

/// Python `build_day_docs`: every daily document of one plant-local day. Plants without data that
/// day are skipped, except once a PWA check slot is ready (every plant has a doc then). The fleet
/// doc `daily/{day}` comes last and lists the checks built in `checks_ready`. `now` = naive
/// plant-local (default the current time); `freeze` false = a dry run (nothing frozen).
pub async fn build_day_docs(
    pool: &PgPool,
    cfg: &CheckConfig,
    day: NaiveDate,
    now: Option<NaiveDateTime>,
    freeze: bool,
) -> Result<Vec<Doc>, PublishError> {
    let ds = day.format("%Y-%m-%d").to_string();
    let mut docs: Vec<Doc> = Vec::new();
    // insertion order of Python's `fleet` dict (serde_json sorts map keys anyway)
    let mut fleet: Vec<(String, Value)> = Vec::new();
    let ready = check_slots::ready_hours(pool, cfg, day, now.unwrap_or_else(check_slots::now_local)).await?;

    let plants: Vec<Plant> = sqlx::query_as(&format!("SELECT {PLANT_COLS} FROM growatt_plants ORDER BY plant_id")).fetch_all(pool).await?;
    for plant in &plants {
        let ov = build_plant_overview(pool, i64::from(plant.plant_id), Some(day)).await?;
        let k = &ov["kpis"];
        let timeseries = ov["timeseries"].as_array().cloned().unwrap_or_default();
        let has_data = timeseries.iter().any(|r| !r["pac_kw"].is_null());
        let pid = plant.plant_id.to_string();
        // every plant gets its check slots: one without inverters still carries the check's weather
        let slots = check_slots::day_slots(pool, cfg, plant, day, &ready, freeze).await?;
        fleet.push((
            pid.clone(),
            json!({
                "name": plant.name,
                "phase": plant.phase,
                "capacity_kwp": round2(&k["capacity_kwp"]),
                "yield_kwh": k["yield_today_kwh"],
                "specific_yield": k["specific_yield_kwh_per_kwp"],
                "peak_kw": k["peak_power_kw"],
                "pr_index_pct": k["plant_pr_pct"],
                "iec_pr_pct": k["iec_pr_pct"],
                "insolation_kwh_m2": k["insolation_kwh_m2"],
                "critical_strings": k["critical_strings"],
                "warning_strings": k["warning_strings"],
                "has_data": has_data,
            }),
        ));
        if !has_data && slots.is_empty() {
            continue;
        }

        // measured irradiance at the 09/13/17 checks; null = sensor silent then, or not built yet
        let mut weather_slots = Map::new();
        for h in check_slots::CHECK_HOURS {
            let key = check_slots::hh(h);
            let v = match slots.get(&key) {
                Some(c) if !c["irradiance_wm2"].is_null() => {
                    json!({"at": c["sensor_at"], "irradiance_wm2": c["irradiance_wm2"], "module_temp_c": c["module_temp_c"]})
                }
                _ => Value::Null,
            };
            weather_slots.insert(key, v);
        }
        let anomalies: Vec<Value> = ov["anomalies"]
            .as_array()
            .map(|a| {
                a.iter()
                    .take(TOP_ANOMALIES)
                    .map(|a| {
                        let mut m = Map::new();
                        for key in ["string_id", "severity", "category", "pr_pct", "energy_loss_kwh"] {
                            m.insert(key.into(), a[key].clone());
                        }
                        Value::Object(m)
                    })
                    .collect()
            })
            .unwrap_or_default();
        let checks = if slots.is_empty() { Value::Null } else { Value::Object(slots.clone().into_iter().collect()) };
        let data_until = if ov["meta"]["day"].as_str() == Some(ds.as_str()) { ov["meta"]["data_until"].clone() } else { Value::Null };
        docs.push((
            format!("daily/{ds}/plants/{pid}"),
            json!({
                "schema": SCHEMA_VERSION,
                "day": ds,
                "plant_id": plant.plant_id,
                "phase": plant.phase,
                "name": plant.name,
                "has_data": has_data,
                "capacity_kwp": round2(&k["capacity_kwp"]),
                "yield_kwh": k["yield_today_kwh"],
                "specific_yield": k["specific_yield_kwh_per_kwp"],
                "peak_kw": k["peak_power_kw"],
                // peer-relative string index (strings compared with each other)
                "pr_index_pct": k["plant_pr_pct"],
                // IEC 61724-1 PR from the plant's weather sensor; null without one / poor coverage
                "iec_pr_pct": k["iec_pr_pct"],
                "weather": {
                    "has_sensor": ov["weather"]["has_sensor"],
                    "insolation_kwh_m2": k["insolation_kwh_m2"],
                    "peak_irradiance_wm2": k["peak_irradiance_wm2"],
                    "avg_module_temp_c": k["avg_module_temp_c"],
                    "avg_ambient_temp_c": k["avg_ambient_temp_c"],
                    "pr_coverage_pct": ov["weather"]["iec_pr"]["coverage_pct"],
                    "slots": weather_slots,
                },
                // Google Maps Weather for the plant's grid cell: modelled, not measured
                "google_weather": google_weather_stored::day_summary(pool, &cfg.google, plant, day).await?,
                "conversion_efficiency_pct": k["conversion_efficiency_pct"],
                "avg_temp_c": k["avg_temp_c"],
                "max_temp_c": k["max_temp_c"],
                "avg_freq_hz": k["avg_freq_hz"],
                "inverter_count": k["inverter_count"],
                "string_count": k["string_count"],
                "healthy_strings": k["healthy_strings"],
                "warning_strings": k["warning_strings"],
                "critical_strings": k["critical_strings"],
                "avg_health_score": k["avg_health_score"],
                "hourly_kw": hourly_kw(&timeseries),
                // the PWA checks 09/13/17 (check_slots); only built slots
                "checks": checks,
                "anomalies": anomalies,
                "data_until": data_until,
            }),
        ));

        let mut strings_by_sn: HashMap<String, Map<String, Value>> = HashMap::new();
        for s in ov["strings"].as_array().map(Vec::as_slice).unwrap_or(&[]) {
            let sn = s["device_sn"].as_str().unwrap_or("").to_owned();
            let no = match &s["string_no"] {
                Value::String(t) => t.clone(),
                other => other.to_string(),
            };
            strings_by_sn.entry(sn).or_default().insert(
                no,
                json!({
                    "mppt": s["mppt_no"],
                    "kwh": s["actual_energy_kwh"],
                    "v_avg": s["v_avg"],
                    "i_avg": s["i_avg"],
                    "i_max": s["i_max"],
                    "pr_index_pct": s["pr_pct"],
                    "health": s["status"], // daily diagnostic: Healthy / Warning / Critical
                }),
            );
        }
        for inv in ov["inverters"].as_array().map(Vec::as_slice).unwrap_or(&[]) {
            if inv["peak_ac_kw"].is_null() {
                continue; // no readings that day
            }
            let sn = inv["device_sn"].as_str().unwrap_or("").to_owned();
            docs.push((
                format!("daily/{ds}/inverters/{sn}"),
                json!({
                    "schema": SCHEMA_VERSION,
                    "day": ds,
                    "plant_id": plant.plant_id,
                    "device_sn": sn,
                    "yield_kwh": inv["yield_today_kwh"],
                    "integrated_kwh": inv["period_energy_kwh"],
                    "peak_ac_kw": inv["peak_ac_kw"],
                    "peak_dc_kw": inv["peak_dc_kw"],
                    "efficiency_pct": inv["efficiency_pct"],
                    "pr_index_pct": inv["pr_pct"],
                    "avg_temp_c": inv["avg_temp_c"],
                    "max_temp_c": inv["max_temp_c"],
                    "avg_freq_hz": inv["avg_freq_hz"],
                    "string_count": inv["string_count"],
                    "strings": strings_by_sn.remove(&sn).unwrap_or_default(),
                }),
            ));
        }
    }

    let with_data: Vec<&Value> = fleet.iter().map(|(_, p)| p).filter(|p| p["has_data"] == json!(true)).collect();
    let caps: Vec<&Value> = fleet.iter().map(|(_, p)| &p["capacity_kwp"]).collect();
    let yields: Vec<&Value> = with_data.iter().map(|p| &p["yield_kwh"]).collect();
    docs.push((
        format!("daily/{ds}"),
        json!({
            "schema": SCHEMA_VERSION,
            "day": ds,
            "plant_count": fleet.len(),
            "plants_with_data": with_data.len(),
            // PWA checks built (and frozen) for every plant; written last, so a reader that sees an
            // hour here sees every plant doc of that publish
            "checks_ready": ready.iter().map(|h| check_slots::hh(*h)).collect::<Vec<_>>(),
            "capacity_kwp": round_sum(&caps),
            "yield_kwh": round_sum(&yields),
            "plants": fleet.into_iter().collect::<Map<String, Value>>(),
        }),
    ));
    Ok(docs)
}

/// Python `plant_links`: {plant_id: {kind: {url, title, revision}}} (`plant_documents`)
pub async fn plant_links(pool: &PgPool) -> Result<HashMap<i32, Map<String, Value>>, sqlx::Error> {
    type LinkRow = (i32, String, String, Option<String>, Option<String>);
    let rows: Vec<LinkRow> =
        sqlx::query_as("SELECT plant_id, kind, url, title, revision FROM plant_documents ORDER BY plant_id, kind").fetch_all(pool).await?;
    let mut out: HashMap<i32, Map<String, Value>> = HashMap::new();
    for (pid, kind, url, title, revision) in rows {
        out.entry(pid).or_default().insert(kind, json!({"url": url, "title": title, "revision": revision}));
    }
    Ok(out)
}

/// Python `plant_sites`: {plant_id: {site_code, project_phase, province, cod_actual}} of the
/// matched register stations, fields without a value left out.
pub async fn plant_sites(pool: &PgPool) -> Result<HashMap<i32, Map<String, Value>>, sqlx::Error> {
    type SiteRow = (String, Option<i32>, Option<String>, Option<NaiveDate>, Option<i32>);
    let rows: Vec<SiteRow> = sqlx::query_as(
        "SELECT site_code, project_phase, province, cod_actual, plant_id FROM site_register WHERE plant_id IS NOT NULL",
    )
    .fetch_all(pool)
    .await?;
    let mut out = HashMap::new();
    for (code, phase, province, cod, pid) in rows {
        let Some(pid) = pid else { continue };
        let mut site = Map::new();
        if !code.is_empty() {
            site.insert(SITE_FIELDS[0].into(), json!(code));
        }
        if let Some(p) = phase {
            site.insert(SITE_FIELDS[1].into(), json!(p));
        }
        if let Some(p) = province.filter(|p| !p.is_empty()) {
            site.insert(SITE_FIELDS[2].into(), json!(p));
        }
        if let Some(d) = cod {
            site.insert(SITE_FIELDS[3].into(), json!(d.format("%Y-%m-%d").to_string()));
        }
        out.insert(pid, site);
    }
    Ok(out)
}

/// Python `build_registry_docs`: static plant / inverter fields and the `config/*` documents.
pub async fn build_registry_docs(pool: &PgPool) -> Result<Vec<Doc>, PublishError> {
    let mut docs = build_inverter_docs(pool, None).await?;
    let mut inv_by_plant: HashMap<i64, Vec<Value>> = HashMap::new();
    for (_, doc) in &docs {
        if doc.get("not_installed").is_none() {
            inv_by_plant.entry(doc["plant_id"].as_i64().unwrap_or(0)).or_default().push(doc["device_sn"].clone());
        }
    }
    let rated = plant_rated_ac_w(pool, None).await?;
    let links = plant_links(pool).await?;
    let sites = plant_sites(pool).await?;
    let plants: Vec<Plant> = sqlx::query_as(&format!("SELECT {PLANT_COLS} FROM growatt_plants ORDER BY plant_id")).fetch_all(pool).await?;
    for p in &plants {
        let id = i64::from(p.plant_id);
        let cap = plausible_capacity_kwp(p.peak_power_kwp, rated.get(&id).copied()).map(|c| py_round(c, 2));
        let mut doc = json!({
            "schema": SCHEMA_VERSION,
            "plant_id": p.plant_id,
            "phase": p.phase,
            "name": p.name,
            "city": p.city,
            "country": p.country,
            "latitude": p.latitude,
            "longitude": p.longitude,
            "capacity_kwp": cap,
            "create_date": p.create_date,
            "inverters": inv_by_plant.remove(&id).unwrap_or_default(),
        });
        let d = doc.as_object_mut().expect("object");
        if let Some(l) = links.get(&p.plant_id).filter(|l| !l.is_empty()) {
            d.insert("documents".into(), Value::Object(l.clone()));
        }
        if let Some(s) = sites.get(&p.plant_id).filter(|s| !s.is_empty()) {
            d.insert("site".into(), Value::Object(s.clone()));
        }
        docs.push((format!("plants/{}", p.plant_id), doc));
    }
    for (path, doc) in crate::fleet_settings::config_docs(pool).await? {
        let mut m = Map::new();
        m.insert("schema".into(), json!(SCHEMA_VERSION));
        if let Value::Object(o) = doc {
            m.extend(o);
        }
        docs.push((path, Value::Object(m)));
    }
    Ok(docs)
}

// --------------------------------------------------------------------------- run / publish

/// Python `daily_summary.run`: registry docs (unless `include_registry` is false) plus the docs
/// of each day, published within the budget. A sink that cannot be built (Firestore without a
/// key file) is Python's `RuntimeError`.
pub async fn run(
    pool: &PgPool,
    cfg: &PublishConfig,
    days: &[NaiveDate],
    include_registry: bool,
    dry_run: bool,
) -> Result<PublishReport, PublishError> {
    let sink = make_sink(&cfg.sink).map_err(|message| PublishError { kind: "RuntimeError".into(), message })?;
    let mut docs: Vec<Doc> = if include_registry { build_registry_docs(pool).await? } else { Vec::new() };
    for d in days {
        docs.extend(build_day_docs(pool, &cfg.checks, *d, None, !dry_run).await?);
    }
    publish(pool, sink.as_ref(), &docs, cfg.budget, dry_run, None)
        .await
        .map_err(|message| PublishError { kind: "PublishError".into(), message })
}

/// Python `dataclasses.asdict(PublishReport)`
pub fn report_json(rep: &PublishReport) -> Map<String, Value> {
    let v = json!({
        "sink": rep.sink,
        "considered": rep.considered,
        "unchanged": rep.unchanged,
        "written": rep.written,
        "over_budget": rep.over_budget,
        "too_large": rep.too_large.iter().map(|(p, n)| json!([p, n])).collect::<Vec<_>>(),
        "writes_today": rep.writes_today,
        "budget": rep.budget,
        "max_doc_bytes": rep.max_doc_bytes,
        "total_bytes": rep.total_bytes,
    });
    match v {
        Value::Object(m) => m,
        _ => Map::new(),
    }
}

/// Python `jobs._publish`: publish the registry and `day`'s docs; `(status, detail)` with status
/// `partial` when documents were deferred (write budget) or too large, else `ok`; detail = the
/// report plus `day`. The `google_weather` job calls this to re-publish yesterday.
pub async fn publish_day(pool: &PgPool, cfg: &PublishConfig, day: NaiveDate) -> Result<(String, Value), PublishError> {
    let rep = run(pool, cfg, &[day], true, false).await?;
    let mut detail = report_json(&rep);
    detail.insert("day".into(), json!(day.format("%Y-%m-%d").to_string()));
    let status = if rep.over_budget.is_empty() && rep.too_large.is_empty() { "ok" } else { "partial" };
    Ok((status.into(), Value::Object(detail)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hourly_curve() {
        let ts = vec![
            json!({"timestamp": "2026-11-27 09:00:00", "pac_kw": 1.0}),
            json!({"timestamp": "2026-11-27 09:05:00", "pac_kw": 2.0}),
            json!({"timestamp": "2026-11-27 10:00:00", "pac_kw": null}),
        ];
        let h = hourly_kw(&ts);
        assert_eq!(h.len(), 24);
        assert_eq!(h[9], Some(1.5));
        assert_eq!(h[10], None);
    }

    #[test]
    fn sums_like_python() {
        assert_eq!(round_sum(&[]), json!(0));
        let (a, b) = (json!(1.005), Value::Null);
        assert_eq!(round_sum(&[&a, &b]), json!(1.0)); // round(1.005, 2) on the binary value
    }
}
