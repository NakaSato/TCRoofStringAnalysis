//! Electricity tariff for pricing energy (docs/plans/decision-rules.md §4.1). Port of
//! backend/app/services/tariff.py: SQL `app_settings` key `tariff`, mirrored to Firestore
//! `config/tariff`; `DEFAULT_TARIFF` with `source = "default"` until an admin saves it. A plant
//! with an entry in `plant_rates` (e.g. a PPA price) is priced at that flat rate. Every baht
//! figure made with this is an **estimate**.

use std::collections::{HashMap, HashSet};

use chrono::{Datelike, NaiveDate, NaiveDateTime, NaiveTime};
use serde_json::{json, Map, Value};
use sqlx::PgPool;

use crate::common::py_round;
use crate::fleet_settings::{get_setting, put_setting, with_defaults};
use crate::publish::Doc;

/// Python `TARIFF_KEY`
pub const TARIFF_KEY: &str = "tariff";

/// Python `DEFAULT_TARIFF` key order (`for k in DEFAULT_TARIFF`)
pub const TARIFF_KEYS: [&str; 9] = [
    "on_peak_thb",
    "off_peak_thb",
    "ft_thb",
    "on_peak_days",
    "on_peak_start",
    "on_peak_end",
    "holidays",
    "valid_from",
    "plant_rates",
];

/// Python `DEFAULT_TARIFF`
pub fn default_tariff() -> Map<String, Value> {
    match json!({
        "on_peak_thb": 4.1839,
        "off_peak_thb": 2.6037,
        "ft_thb": 0.1623,
        "on_peak_days": [0, 1, 2, 3, 4],
        "on_peak_start": "09:00",
        "on_peak_end": "22:00",
        "holidays": [
            "2026-08-12", "2026-10-13", "2026-10-23", "2026-12-05", "2026-12-10", "2026-12-31",
            "2027-01-01", "2027-04-06", "2027-04-13", "2027-04-14", "2027-04-15",
        ],
        "valid_from": "2026-09-01",
        "plant_rates": {},
    }) {
        Value::Object(m) => m,
        _ => unreachable!(),
    }
}

/// Python `tariff.get_tariff` (a saved value that is not an object counts as unsaved)
pub async fn get_tariff(pool: &PgPool) -> Result<Value, sqlx::Error> {
    let row = get_setting(pool, TARIFF_KEY).await?.filter(|r| r.value.is_object());
    Ok(with_defaults(default_tariff(), row))
}

/// Python `tariff.put_tariff`: only the `DEFAULT_TARIFF` keys are kept.
pub async fn put_tariff(pool: &PgPool, value: &Value, username: Option<&str>) -> Result<Value, sqlx::Error> {
    let mut clean = Map::new();
    for k in TARIFF_KEYS {
        if let Some(v) = value.get(k) {
            clean.insert(k.into(), v.clone());
        }
    }
    put_setting(pool, TARIFF_KEY, &Value::Object(clean), username).await?;
    get_tariff(pool).await
}

/// Python `tariff._hm`: "HH:MM"; 24:00 and later = 23:59:59
fn hm(s: &str) -> NaiveTime {
    let (h, m) = s.split_once(':').unwrap_or((s, "0"));
    let h: u32 = h.trim().parse().unwrap_or(0);
    let m: u32 = m.trim().parse().unwrap_or(0);
    if h >= 24 {
        NaiveTime::from_hms_opt(23, 59, 59).expect("time")
    } else {
        NaiveTime::from_hms_opt(h, m, 0).unwrap_or(NaiveTime::MIN)
    }
}

fn num(v: Option<&Value>) -> Option<f64> {
    match v? {
        Value::Number(n) => n.as_f64(),
        Value::String(s) => s.trim().parse().ok(),
        Value::Bool(b) => Some(if *b { 1.0 } else { 0.0 }),
        _ => None,
    }
}

/// Python truthiness of a JSON value
fn truthy(v: Option<&Value>) -> bool {
    match v {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => n.as_f64() != Some(0.0),
        Some(Value::String(s)) => !s.is_empty(),
        Some(Value::Array(a)) => !a.is_empty(),
        Some(Value::Object(o)) => !o.is_empty(),
    }
}

/// Python `tariff.Pricer`: prices kWh at a plant-local time, built from the tariff setting.
#[derive(Debug, Clone)]
pub struct Pricer {
    pub on: f64,
    pub off: f64,
    pub ft: f64,
    pub days: HashSet<u32>,
    pub start: NaiveTime,
    pub end: NaiveTime,
    pub holidays: HashSet<String>,
    pub plant_rates: Map<String, Value>,
}

impl Pricer {
    /// Python `Pricer.__init__`
    pub fn new(cfg: &Value) -> Pricer {
        let text = |k: &str, d: &str| -> String {
            match cfg.get(k) {
                Some(Value::String(s)) if !s.is_empty() => s.clone(),
                _ => d.to_owned(),
            }
        };
        Pricer {
            on: num(cfg.get("on_peak_thb")).unwrap_or(f64::NAN),
            off: num(cfg.get("off_peak_thb")).unwrap_or(f64::NAN),
            ft: if truthy(cfg.get("ft_thb")) { num(cfg.get("ft_thb")).unwrap_or(0.0) } else { 0.0 },
            days: cfg
                .get("on_peak_days")
                .and_then(Value::as_array)
                .map(|a| a.iter().filter_map(|d| num(Some(d))).map(|d| d as i64 as u32).collect())
                .unwrap_or_default(),
            start: hm(&text("on_peak_start", "09:00")),
            end: hm(&text("on_peak_end", "22:00")),
            holidays: cfg
                .get("holidays")
                .and_then(Value::as_array)
                .map(|a| a.iter().map(|d| d.as_str().map(str::to_owned).unwrap_or_else(|| d.to_string())).collect())
                .unwrap_or_default(),
            plant_rates: cfg.get("plant_rates").and_then(Value::as_object).cloned().unwrap_or_default(),
        }
    }

    fn off_day(&self, day: NaiveDate) -> bool {
        !self.days.contains(&day.weekday().num_days_from_monday()) || self.holidays.contains(&day.format("%Y-%m-%d").to_string())
    }

    /// Python `Pricer.is_on_peak`
    pub fn is_on_peak(&self, t: NaiveDateTime) -> bool {
        if self.off_day(t.date()) {
            return false;
        }
        self.start <= t.time() && t.time() < self.end
    }

    /// Python `Pricer.plant_rate`
    pub fn plant_rate(&self, plant_id: i64) -> Option<f64> {
        match self.plant_rates.get(&plant_id.to_string()) {
            Some(Value::Object(r)) => match r.get("thb_per_kwh") {
                None | Some(Value::Null) => None,
                v => num(v),
            },
            _ => None,
        }
    }

    /// Python `Pricer.thb`
    pub fn thb(&self, plant_id: i64, kwh: Option<f64>, on_peak_kwh: Option<f64>) -> Option<f64> {
        let kwh = kwh?;
        if let Some(flat) = self.plant_rate(plant_id) {
            return Some(kwh * flat);
        }
        let on = on_peak_kwh.unwrap_or(0.0).max(0.0).min(kwh);
        Some(on * (self.on + self.ft) + (kwh - on) * (self.off + self.ft))
    }

    /// Python `Pricer.rate_at`
    pub fn rate_at(&self, plant_id: i64, t: NaiveDateTime) -> f64 {
        if let Some(flat) = self.plant_rate(plant_id) {
            return flat;
        }
        (if self.is_on_peak(t) { self.on } else { self.off }) + self.ft
    }

    /// Python `Pricer.on_peak_window`: the day's on-peak hours, None on an off-peak day
    pub fn on_peak_window(&self, day: NaiveDate) -> Option<(NaiveDateTime, NaiveDateTime)> {
        if self.off_day(day) {
            return None;
        }
        Some((day.and_time(self.start), day.and_time(self.end)))
    }

    /// Python `Pricer.split_rate`: None share = unknown split, priced at off-peak
    pub fn split_rate(&self, plant_id: i64, on_peak_share: Option<f64>) -> f64 {
        if let Some(flat) = self.plant_rate(plant_id) {
            return flat;
        }
        let share = on_peak_share.unwrap_or(0.0).clamp(0.0, 1.0);
        share * (self.on + self.ft) + (1.0 - share) * (self.off + self.ft)
    }

    /// Python `Pricer.energy_weighted_rate`
    pub fn energy_weighted_rate(&self, plant_id: i64, points: &[(NaiveDateTime, f64)]) -> Option<f64> {
        if let Some(flat) = self.plant_rate(plant_id) {
            return Some(flat);
        }
        let tot: f64 = points.iter().map(|(_, p)| p.max(0.0)).sum();
        if tot <= 0.0 {
            return None;
        }
        Some(points.iter().map(|(t, p)| p.max(0.0) * self.rate_at(plant_id, *t)).sum::<f64>() / tot)
    }
}

/// Python `tariff.pricer`
pub async fn pricer(pool: &PgPool) -> Result<Pricer, sqlx::Error> {
    Ok(Pricer::new(&get_tariff(pool).await?))
}

/// Python `tariff.day_rates`: THB/kWh of each plant's generation on `day` (flat rate, else TOU
/// weighted by the on-peak share of its stored AC power; no power yet = off-peak with
/// `on_peak_share` null). `plant_ids` None = every plant. An estimate.
pub async fn day_rates(pool: &PgPool, day: NaiveDate, plant_ids: Option<&[i64]>) -> Result<Vec<(i64, Value)>, sqlx::Error> {
    let pr = pricer(pool).await?;
    let pids: Vec<i64> = match plant_ids {
        Some(ids) => sqlx::query_scalar::<_, i32>("SELECT plant_id FROM growatt_plants WHERE plant_id = ANY($1)")
            .bind(ids.iter().map(|&i| crate::plant_documents::id32(i)).collect::<Vec<i32>>())
            .fetch_all(pool)
            .await?,
        None => sqlx::query_scalar::<_, i32>("SELECT plant_id FROM growatt_plants").fetch_all(pool).await?,
    }
    .into_iter()
    .map(i64::from)
    .collect();
    let lo = day.and_time(NaiveTime::MIN);
    let hi = lo + chrono::Duration::days(1);
    let win = pr.on_peak_window(day);
    // one aggregate query; the on-peak sum only on an on-peak day
    let (on_col, w0, w1) = match win {
        Some((a, b)) => ("sum(CASE WHEN r.timestamp >= $3 AND r.timestamp < $4 THEN r.pac_w ELSE 0.0 END)", a, b),
        None => ("NULL::double precision", lo, lo),
    };
    let filter = if plant_ids.is_some() { " AND i.plant_id = ANY($5)" } else { "" };
    let sql = format!(
        "SELECT i.plant_id, sum(r.pac_w), {on_col} FROM growatt_inverter_readings r \
         JOIN growatt_inverters i ON i.device_sn = r.device_sn \
         WHERE r.timestamp >= $1 AND r.timestamp < $2 AND r.pac_w > 0 \
         AND ($3::timestamp IS NOT NULL OR $4::timestamp IS NOT NULL){filter} GROUP BY i.plant_id"
    );
    let mut q = sqlx::query_as::<_, (i32, Option<f64>, Option<f64>)>(&sql).bind(lo).bind(hi).bind(w0).bind(w1);
    if plant_ids.is_some() {
        q = q.bind(pids.iter().map(|&i| crate::plant_documents::id32(i)).collect::<Vec<i32>>());
    }
    let mut shares: HashMap<i64, f64> = HashMap::new();
    for (pid, tot, on) in q.fetch_all(pool).await? {
        let tot = tot.unwrap_or(0.0);
        if tot > 0.0 {
            shares.insert(i64::from(pid), if win.is_some() { on.unwrap_or(0.0) / tot } else { 0.0 });
        }
    }
    Ok(pids
        .into_iter()
        .map(|pid| {
            let flat = pr.plant_rate(pid);
            let share = shares.get(&pid).copied();
            let basis = if flat.is_some() {
                "plant_rate"
            } else if share.is_some() {
                "tou"
            } else {
                "off_peak_unknown_split"
            };
            (
                pid,
                json!({
                    "thb_per_kwh": py_round(pr.split_rate(pid, share), 4),
                    "on_peak_share": if flat.is_some() { None } else { share.map(|s| py_round(s, 3)) },
                    "basis": basis,
                }),
            )
        })
        .collect())
}

/// Python `tariff.config_doc`: `config/tariff` (the timestamp left out)
pub async fn config_doc(pool: &PgPool) -> Result<Doc, sqlx::Error> {
    let mut t = get_tariff(pool).await?;
    if let Some(o) = t.as_object_mut() {
        o.remove("updated_at");
    }
    Ok((format!("config/{TARIFF_KEY}"), t))
}

// --------------------------------------------------------------------------- PWA contract price

/// Python `pwa_meter.criteria()`: backend/app/services/pwa_meter_criteria.json, compiled in so
/// both backends read the same file.
pub fn pwa_criteria() -> &'static Value {
    static C: std::sync::OnceLock<Value> = std::sync::OnceLock::new();
    C.get_or_init(|| {
        serde_json::from_str(include_str!("../../../../backend/app/services/pwa_meter_criteria.json"))
            .expect("pwa_meter_criteria.json is valid JSON")
    })
}

/// Python `tariff.pwa_plant_rates`: `plant_rates` entries for the Growatt plants of the PWA meter
/// report sites, at the contract's book price from the criteria file. Sorted by plant id.
pub async fn pwa_plant_rates(pool: &PgPool) -> Result<Vec<(i64, Value)>, sqlx::Error> {
    let price = pwa_criteria()["tariff"]["book_price_thb_per_kwh"].as_f64();
    let ids: Vec<i32> = sqlx::query_scalar(
        "SELECT DISTINCT growatt_plant_id FROM pwa_meter_sites WHERE growatt_plant_id IS NOT NULL ORDER BY growatt_plant_id",
    )
    .fetch_all(pool)
    .await?;
    Ok(ids.into_iter().map(|p| (i64::from(p), json!({"thb_per_kwh": price, "basis": "PWA contract"}))).collect())
}

/// Python `tariff.fill_pwa_plant_rates`: add the PWA book price for PWA plants without a rate (a
/// rate already entered is kept). Returns `{added, kept, applied, plants}`.
pub async fn fill_pwa_plant_rates(pool: &PgPool, username: Option<&str>, apply: bool) -> Result<Value, sqlx::Error> {
    let cur = get_tariff(pool).await?;
    let rates = cur.get("plant_rates").and_then(Value::as_object).cloned().unwrap_or_default();
    let new: Vec<(i64, Value)> =
        pwa_plant_rates(pool).await?.into_iter().filter(|(k, _)| !rates.contains_key(&k.to_string())).collect();
    let applied = apply && !new.is_empty();
    if applied {
        let mut value = Map::new();
        for k in TARIFF_KEYS {
            value.insert(k.into(), cur.get(k).cloned().unwrap_or(Value::Null));
        }
        let mut merged = rates.clone();
        for (k, v) in &new {
            merged.insert(k.to_string(), v.clone());
        }
        value.insert("plant_rates".into(), Value::Object(merged));
        put_tariff(pool, &Value::Object(value), username).await?;
    }
    let plants: Vec<i64> = new.iter().map(|(k, _)| *k).collect();
    Ok(json!({"added": new.len(), "kept": rates.len(), "applied": applied, "plants": plants}))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dt(s: &str) -> NaiveDateTime {
        NaiveDateTime::parse_from_str(s, "%Y-%m-%d %H:%M").unwrap()
    }

    #[test]
    fn pricer_tou_and_flat() {
        let mut cfg = Value::Object(default_tariff());
        cfg["plant_rates"] = json!({"7": {"thb_per_kwh": 3.5, "basis": "PPA"}});
        let p = Pricer::new(&cfg);
        // Friday 2026-11-27 10:00 on-peak; Saturday off-peak; holiday 2026-12-10 (Thu) off-peak
        assert!(p.is_on_peak(dt("2026-11-27 10:00")));
        assert!(!p.is_on_peak(dt("2026-11-28 10:00")));
        assert!(!p.is_on_peak(dt("2026-12-10 10:00")));
        assert!(!p.is_on_peak(dt("2026-11-27 22:00")));
        assert_eq!(p.plant_rate(7), Some(3.5));
        assert_eq!(p.split_rate(7, Some(0.5)), 3.5);
        assert!((p.split_rate(1, None) - (2.6037 + 0.1623)).abs() < 1e-12);
        assert_eq!(p.thb(1, None, None), None);
        assert!(p.on_peak_window(NaiveDate::from_ymd_opt(2026, 11, 28).unwrap()).is_none());
        assert_eq!(hm("24:00"), NaiveTime::from_hms_opt(23, 59, 59).unwrap());
    }

    #[test]
    fn criteria_has_book_price() {
        assert!(pwa_criteria()["tariff"]["book_price_thb_per_kwh"].as_f64().is_some());
    }
}
