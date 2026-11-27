//! Solar curtailment per 5-minute slot: **estimated**, never measured. Ported from
//! backend/app/services/growatt_curtailment.py (see its module docstring for the model).
//!
//! `available_kw` (**modelled**) = kWp × POA / 1000 × (1 + γ (T_mod − 25 °C)) × system factor ×
//! the day's calibration ratio, capped at rated AC. A slot is curtailed when the AC is held well
//! below that and the plant shows why (`export_limit`: the meter reads ~0 kW both ways;
//! `power_limit`: AC at ≥ 98 % of the power-limit setting), in runs of ≥ 2 slots.
//!
//! Curve rows are JSON objects (`serde_json::Map`), as in Python; `fleet` reads only the stored
//! daily rows (`growatt_plant_daily`).

use std::collections::{BTreeMap, HashMap, HashSet};

use chrono::{Duration, NaiveDate, NaiveDateTime};
use serde_json::{json, Map, Value};
use sqlx::PgPool;

use crate::common::{py_median, py_round, py_sum, Inverter, Result, INVERTER_COLS};

pub type Row = Map<String, Value>;

pub const SLOT_H: f64 = 5.0 / 60.0;
pub const MIN_POA_WM2: f64 = 200.0;
pub const MAX_POA_WM2: f64 = 1200.0;
pub const MIN_GAP_FRAC: f64 = 0.15;
pub const MIN_GAP_KW: f64 = 1.0;
pub const EXPORT_BAND_KW: f64 = 3.0;
pub const EXPORT_BAND_FRAC: f64 = 0.03;
pub const LIMIT_FRACTION: f64 = 0.98;
pub const FREE_HOURS: (u32, u32) = (9, 15);
pub const FREE_MIN_POA_WM2: f64 = 400.0;
pub const FREE_IMPORT_FRAC: f64 = 0.30;
pub const CALIBRATION_DAYS: i64 = 14;
pub const CALIBRATION_MIN_SLOTS: i64 = 12;
pub const FLEET_MIN_PLANTS: usize = 10;
pub const SHOULDER_HOURS: [u32; 2] = [8, 15];
pub const SHOULDER_MIN_POA_WM2: f64 = 200.0;
pub const SHOULDER_K_MIN_PLANT_DAYS: usize = 20;
pub const SHOULDER_K_MIN_MID_SLOTS: i64 = 6;
pub const SHOULDER_K_MIN_HOUR_SLOTS: i64 = 3;
/// Python `RATIO_ERROR`: mean |error| of the calibrated available power by source
pub fn ratio_error(source: &str) -> Option<f64> {
    match source {
        "plant" => Some(0.05),
        "blend" => Some(0.10),
        "fleet" => Some(0.15),
        _ => None,
    }
}

const TS_FMT: &str = "%Y-%m-%d %H:%M:%S";

/// Python `plant_limit_kw`: Σ nameplate × active power limit (setting) in kW; None unless every
/// inverter has a nameplate and at least one is limited below 100 %.
pub fn plant_limit_kw(invs: &[Inverter]) -> Option<f64> {
    if invs.is_empty() || invs.iter().any(|i| i.nominal_power_w.is_none_or(|w| w == 0.0)) {
        return None;
    }
    if !invs.iter().any(|i| i.active_limit_pct().is_some_and(|p| p < 100.0)) {
        return None;
    }
    Some(py_sum(invs.iter().map(|i| i.nominal_power_w.unwrap_or(0.0) * i.active_limit_pct().unwrap_or(100.0).min(100.0) / 100.0)) / 1000.0)
}

/// Python `inverters`: the plant's installed inverters.
pub async fn inverters(pool: &PgPool, plant_id: i64) -> Result<Vec<Inverter>> {
    Ok(sqlx::query_as::<_, Inverter>(&format!(
        "SELECT {INVERTER_COLS} FROM growatt_inverters WHERE plant_id = $1 AND not_installed_at IS NULL"
    ))
    .bind(plant_id as i32)
    .fetch_all(pool)
    .await?)
}

/// One day's calibration (Python `calibration()` value): `{ratio, slots, source}`.
#[derive(Debug, Clone, PartialEq)]
pub struct Calibration {
    pub ratio: Option<f64>,
    pub slots: i64,
    /// `plant` | `blend` | `fleet`; None = plain model
    pub source: Option<String>,
}

/// Inputs of `annotate` besides the rows (Python keyword arguments).
#[derive(Debug, Clone, Default)]
pub struct AnnotateArgs {
    pub kwp: Option<f64>,
    pub rated_ac_kw: Option<f64>,
    pub limit_kw: Option<f64>,
    pub gamma_pct: f64,
    pub factor: f64,
    pub inverter_count: i64,
    pub stale: HashSet<String>,
    /// {day: the day's measured module temperature}
    pub tmod_fallback: HashMap<String, Option<f64>>,
    /// {day: calibration}
    pub calibration: HashMap<String, Calibration>,
}

fn num(r: &Row, k: &str) -> Option<f64> {
    r.get(k).and_then(Value::as_f64)
}

/// Python `annotate`: adds `available_kw` (modelled), `curtailed_kw` (estimated) and
/// `curtailed_by` to each curve row in place and returns the period's summary.
pub fn annotate(rows: &mut [Row], a: &AnnotateArgs) -> Value {
    let kwp = a.kwp.filter(|k| *k != 0.0);
    let rated = a.rated_ac_kw.filter(|k| *k != 0.0);
    let limit = a.limit_kw.filter(|k| *k != 0.0);
    let band = kwp.map_or(EXPORT_BAND_KW, |k| EXPORT_BAND_KW.max(EXPORT_BAND_FRAC * k));
    let mut flagged: HashMap<String, &'static str> = HashMap::new();
    let mut judged = 0usize;
    let cal = &a.calibration;
    let mut free: Vec<f64> = Vec::new();
    let mut shoulder: BTreeMap<u32, Vec<f64>> = SHOULDER_HOURS.iter().map(|h| (*h, Vec::new())).collect();
    let day_of = |ts: &str| ts.get(..10).unwrap_or("").to_owned();
    for r in rows.iter_mut() {
        r.insert("available_kw".into(), Value::Null);
        r.insert("curtailed_kw".into(), Value::Null);
        r.insert("curtailed_by".into(), Value::Null);
        let Some(kwp) = kwp else { continue };
        let ts = r.get("timestamp").and_then(Value::as_str).unwrap_or("").to_owned();
        let (Some(g), Some(pac)) = (num(r, "irradiance_wm2"), num(r, "pac_kw")) else { continue };
        if a.stale.contains(&ts) {
            continue;
        }
        let Some(t_mod) = num(r, "module_temp_c").or_else(|| a.tmod_fallback.get(&day_of(&ts)).copied().flatten()) else { continue };
        let model = kwp * (g / 1000.0) * (1.0 + (a.gamma_pct / 100.0) * (t_mod - 25.0)).max(0.5) * a.factor;
        let ratio = cal.get(&day_of(&ts)).and_then(|c| c.ratio).filter(|r| *r != 0.0);
        let mut avail = ratio.map_or(model, |x| model * x);
        if let Some(rated) = rated {
            avail = avail.min(rated);
        }
        let avail_r = py_round(avail, 2);
        r.insert("available_kw".into(), json!(avail_r));
        let inv_n = r.get("inverters").and_then(Value::as_i64).unwrap_or(0);
        if !(MIN_POA_WM2..=MAX_POA_WM2).contains(&g) || (a.inverter_count != 0 && inv_n < a.inverter_count) {
            continue;
        }
        judged += 1;
        r.insert("curtailed_kw".into(), json!(0.0));
        let imp = num(r, "grid_import_kw");
        let hour: u32 = ts.get(11..13).and_then(|h| h.parse().ok()).unwrap_or(0);
        if let Some(imp) = imp {
            if model > 0.0
                && imp > band.max(FREE_IMPORT_FRAC * model)
                && !limit.is_some_and(|l| pac >= LIMIT_FRACTION * l)
                && !rated.is_some_and(|rt| model >= rt || pac >= LIMIT_FRACTION * rt)
            {
                if FREE_HOURS.0 <= hour && hour < FREE_HOURS.1 && g >= FREE_MIN_POA_WM2 {
                    free.push(pac / model);
                } else if let Some(v) = shoulder.get_mut(&hour).filter(|_| g >= SHOULDER_MIN_POA_WM2) {
                    v.push(pac / model);
                }
            }
        }
        let gap = avail - pac;
        if gap < MIN_GAP_KW.max(MIN_GAP_FRAC * avail) {
            continue;
        }
        if limit.is_some_and(|l| pac >= LIMIT_FRACTION * l) {
            flagged.insert(ts, "power_limit");
            continue;
        }
        if let (Some(imp), Some(exp)) = (imp, num(r, "grid_export_kw")) {
            if imp <= band && exp <= band {
                flagged.insert(ts, "export_limit");
            }
        }
    }
    let near = |ts: &str| -> bool {
        let Ok(t) = NaiveDateTime::parse_from_str(ts, TS_FMT) else { return false };
        let step = Duration::minutes(5);
        flagged.contains_key(&(t - step).format(TS_FMT).to_string()) || flagged.contains_key(&(t + step).format(TS_FMT).to_string())
    };
    let mut kwh = 0.0;
    let mut slots = 0usize;
    let mut by: Vec<(&'static str, f64)> = Vec::new();
    let mut err: Option<f64> = Some(0.0);
    for r in rows.iter_mut() {
        let ts = r.get("timestamp").and_then(Value::as_str).unwrap_or("").to_owned();
        let Some(cause) = flagged.get(&ts).copied() else { continue };
        if !near(&ts) {
            continue;
        }
        let avail = num(r, "available_kw").unwrap_or(0.0);
        let kw = py_round(avail - num(r, "pac_kw").unwrap_or(0.0), 2);
        r.insert("curtailed_kw".into(), json!(kw));
        r.insert("curtailed_by".into(), json!(cause));
        kwh += kw * SLOT_H;
        slots += 1;
        match by.iter_mut().find(|(c, _)| *c == cause) {
            Some(e) => e.1 += kw * SLOT_H,
            None => by.push((cause, kw * SLOT_H)),
        }
        let frac = cal.get(&day_of(&ts)).and_then(|c| c.source.as_deref()).and_then(ratio_error);
        err = match (err, frac) {
            (Some(e), Some(f)) => Some(e + f * avail * SLOT_H),
            _ => None,
        };
    }
    let reason = if judged == 0 { Some(if kwp.is_none() { "no_capacity" } else { "no_sensor_slots" }) } else { None };
    let mut days: Vec<String> = rows.iter().filter(|r| !r.get("available_kw").unwrap_or(&Value::Null).is_null()).map(|r| day_of(r.get("timestamp").and_then(Value::as_str).unwrap_or(""))).collect();
    days.sort();
    days.dedup();
    let used: Vec<f64> = days.iter().filter_map(|d| cal.get(d).and_then(|c| c.ratio).filter(|r| *r != 0.0)).collect();
    let last = days.last().and_then(|d| cal.get(d));
    let shoulder_out: Map<String, Value> = shoulder
        .iter()
        .filter(|(_, v)| !v.is_empty())
        .map(|(h, v)| (h.to_string(), json!([py_round(py_median(v).unwrap_or(0.0), 3), v.len()])))
        .collect();
    json!({
        "kwh": (judged > 0).then(|| py_round(kwh, 1)),
        // typical error of `kwh` from the calibration; null = a held slot rests on the plain model
        "err_kwh": if judged > 0 { err.map(|e| py_round(e, 1)) } else { None },
        "slots": slots,
        "judged_slots": judged,
        "by": by.iter().map(|(c, v)| ((*c).to_owned(), json!(py_round(*v, 1)))).collect::<Map<String, Value>>(),
        "reason": reason,
        "estimated": true,
        "factor": a.factor,
        "limit_kw": limit.map(|l| py_round(l, 1)),
        "calibration": {
            "status": last.and_then(|c| c.source.clone()).unwrap_or_else(|| "not_checked".into()),
            "ratio": if used.is_empty() { None } else { Some(py_round(crate::common::py_mean(&used).unwrap_or(0.0), 3)) },
            "slots": last.map_or(0, |c| c.slots),
            "days": CALIBRATION_DAYS,
        },
        "free_ratio": py_median(&free).map(|m| py_round(m, 3)),
        "free_slots": free.len(),
        // per SHOULDER_HOURS hour: [median AC ÷ plain model, slots] of its free slots (stored per day)
        "shoulder": shoulder_out,
    })
}

/// A stored daily free ratio (plant, day, midday ratio, midday slots, shoulder ratios).
type Stored = (i32, NaiveDate, Option<f64>, i64, Map<String, Value>);
/// the stored row as read
type StoredRaw = (i32, NaiveDate, Option<f64>, Option<i32>, Option<Value>);

/// Python `calibration`: {day: {ratio, slots, source}} per day in `days`, from the stored daily
/// free ratios of the CALIBRATION_DAYS before that day (slot-weighted): `plant`, else `blend`,
/// else `fleet`, else none.
pub async fn calibration(pool: &PgPool, plant_id: i64, days: &[NaiveDate]) -> Result<HashMap<String, Calibration>> {
    let (Some(lo), Some(hi)) = (days.iter().min(), days.iter().max()) else { return Ok(HashMap::new()) };
    let lo = *lo - Duration::days(CALIBRATION_DAYS);
    let rows: Vec<StoredRaw> = sqlx::query_as(
        "SELECT plant_id, day, free_ratio, free_slots, shoulder_ratios FROM growatt_plant_daily \
         WHERE day >= $1 AND day < $2 AND (free_ratio IS NOT NULL OR shoulder_ratios IS NOT NULL)",
    )
    .bind(lo)
    .bind(*hi)
    .fetch_all(pool)
    .await?;
    let stored: Vec<Stored> = rows
        .into_iter()
        .map(|(p, d, r, n, sh)| {
            let sh = match sh {
                Some(Value::Object(m)) => m,
                _ => Map::new(),
            };
            (p, d, r, i64::from(n.unwrap_or(0)), sh)
        })
        .collect();
    let mut out = HashMap::new();
    for day in days {
        let win: Vec<&Stored> = stored.iter().filter(|x| *day - Duration::days(CALIBRATION_DAYS) <= x.1 && x.1 < *day).collect();
        let mid: Vec<(i32, f64, i64)> = win.iter().filter_map(|x| x.2.filter(|_| x.3 > 0).map(|r| (x.0, r, x.3))).collect();
        let own: Vec<(f64, i64)> = mid.iter().filter(|m| i64::from(m.0) == plant_id).map(|m| (m.1, m.2)).collect();
        let n_own: i64 = own.iter().map(|o| o.1).sum();
        let key = day.to_string();
        if n_own >= CALIBRATION_MIN_SLOTS {
            let s = py_sum(own.iter().map(|(r, n)| r * *n as f64));
            out.insert(key, Calibration { ratio: Some(py_round(s / n_own as f64, 3)), slots: n_own, source: Some("plant".into()) });
            continue;
        }
        let n_all: i64 = mid.iter().map(|m| m.2).sum();
        let plants: HashSet<i32> = mid.iter().map(|m| m.0).collect();
        if plants.len() < FLEET_MIN_PLANTS || n_all == 0 {
            out.insert(key, Calibration { ratio: None, slots: n_own, source: None });
            continue;
        }
        let fleet_ratio = py_sum(mid.iter().map(|(_, r, n)| r * *n as f64)) / n_all as f64;
        match shoulder_corrected(&win, plant_id) {
            Some(c) => out.insert(key, Calibration { ratio: Some(py_round((fleet_ratio + c) / 2.0, 3)), slots: n_own, source: Some("blend".into()) }),
            None => out.insert(key, Calibration { ratio: Some(py_round(fleet_ratio, 3)), slots: n_own, source: Some("fleet".into()) }),
        };
    }
    Ok(out)
}

/// `sh[h]` = [ratio, slots] of a stored shoulder hour
fn sh_entry(sh: &Map<String, Value>, h: &str) -> Option<(f64, i64)> {
    let v = sh.get(h)?.as_array()?;
    let r = v.first()?.as_f64()?;
    let n = v.get(1).and_then(|n| n.as_i64().or_else(|| n.as_f64().map(|f| f.trunc() as i64)))?;
    Some((r, n))
}

/// Python `_shoulder_corrected`: the plant's own shoulder-hour free ratio scaled to midday by the
/// fleet's k_h; None when k_h cannot be learned or the plant has < CALIBRATION_MIN_SLOTS.
fn shoulder_corrected(win: &[&Stored], plant_id: i64) -> Option<f64> {
    let mut k: Vec<(String, f64)> = Vec::new();
    for h in SHOULDER_HOURS.iter().map(u32::to_string) {
        let rel: Vec<f64> = win
            .iter()
            .filter_map(|x| {
                let r = x.2.filter(|r| *r != 0.0)?;
                if x.3 < SHOULDER_K_MIN_MID_SLOTS {
                    return None;
                }
                let (hr, hn) = sh_entry(&x.4, &h)?;
                (hn >= SHOULDER_K_MIN_HOUR_SLOTS).then_some(hr / r)
            })
            .collect();
        if rel.len() >= SHOULDER_K_MIN_PLANT_DAYS {
            k.push((h, py_median(&rel).unwrap_or(0.0)));
        }
    }
    let mut vals: Vec<(f64, i64)> = Vec::new();
    for x in win.iter().filter(|x| i64::from(x.0) == plant_id) {
        for (h, kh) in &k {
            if let Some((r, n)) = sh_entry(&x.4, h) {
                if n > 0 && *kh > 0.0 {
                    vals.push((r / kh, n));
                }
            }
        }
    }
    let n: i64 = vals.iter().map(|v| v.1).sum();
    (n >= CALIBRATION_MIN_SLOTS).then(|| py_sum(vals.iter().map(|(v, m)| v * *m as f64)) / n as f64)
}

/// The columns of `growatt_plant_daily` that `fleet` reads.
#[derive(Debug, Clone, sqlx::FromRow)]
struct DailyRow {
    plant_id: i32,
    day: NaiveDate,
    capacity_kwp: Option<f64>,
    energy_kwh: Option<f64>,
    curtailed_kwh: Option<f64>,
    curtailed_slots: Option<i32>,
    curtailed_export_kwh: Option<f64>,
    curtailed_limit_kwh: Option<f64>,
    curtail_ratio: Option<f64>,
    curtail_ratio_slots: Option<i32>,
    curtail_ratio_source: Option<String>,
    curtailed_err_kwh: Option<f64>,
}

struct PerPlant {
    kwh: Option<f64>,
    err: Option<f64>,
    energy_kwh: Option<f64>,
    days: i64,
    judged_days: i64,
    curtailed_days: i64,
    export_limit_kwh: f64,
    power_limit_kwh: f64,
    slots: i64,
    last: Option<DailyRow>,
}

struct PerDay {
    kwh: Option<f64>,
    err2: Option<f64>,
    plants: i64,
    energy_kwh: Option<f64>,
}

/// Python `fleet`: curtailment of every plant in scope (`plant_ids` None = all) over
/// `start`..`end` from the stored daily rows (DB only). A plant's days share one calibration, so
/// their errors add; between plants √Σ err². Null when a curtailed day has none (plain model).
pub async fn fleet(pool: &PgPool, start: NaiveDate, end: NaiveDate, plant_ids: Option<&[i64]>) -> Result<Value> {
    let ids: Option<Vec<i32>> = plant_ids.map(|v| v.iter().map(|&i| i as i32).collect());
    let plants: HashMap<i32, (String, Option<i32>)> = {
        let rows: Vec<(i32, String, Option<i32>)> = match &ids {
            Some(ids) => sqlx::query_as("SELECT plant_id, name, phase FROM growatt_plants WHERE plant_id = ANY($1)").bind(ids).fetch_all(pool).await?,
            None => sqlx::query_as("SELECT plant_id, name, phase FROM growatt_plants").fetch_all(pool).await?,
        };
        rows.into_iter().map(|(p, n, ph)| (p, (n, ph))).collect()
    };
    let cols = "plant_id, day, capacity_kwp, energy_kwh, curtailed_kwh, curtailed_slots, curtailed_export_kwh, curtailed_limit_kwh, \
                curtail_ratio, curtail_ratio_slots, curtail_ratio_source, curtailed_err_kwh";
    let rows: Vec<DailyRow> = match &ids {
        Some(ids) => sqlx::query_as(&format!("SELECT {cols} FROM growatt_plant_daily WHERE day >= $1 AND day <= $2 AND plant_id = ANY($3) ORDER BY day"))
            .bind(start)
            .bind(end)
            .bind(ids)
            .fetch_all(pool)
            .await?,
        None => sqlx::query_as(&format!("SELECT {cols} FROM growatt_plant_daily WHERE day >= $1 AND day <= $2 ORDER BY day"))
            .bind(start)
            .bind(end)
            .fetch_all(pool)
            .await?,
    };
    let mut order: Vec<i32> = Vec::new();
    let mut per: HashMap<i32, PerPlant> = HashMap::new();
    let mut days: BTreeMap<String, PerDay> = BTreeMap::new();
    for r in rows {
        if !plants.contains_key(&r.plant_id) {
            continue;
        }
        let p = per.entry(r.plant_id).or_insert_with(|| {
            order.push(r.plant_id);
            PerPlant { kwh: None, err: Some(0.0), energy_kwh: None, days: 0, judged_days: 0, curtailed_days: 0, export_limit_kwh: 0.0, power_limit_kwh: 0.0, slots: 0, last: None }
        });
        p.days += 1;
        if let Some(e) = r.energy_kwh {
            p.energy_kwh = Some(p.energy_kwh.unwrap_or(0.0) + e);
        }
        let d = days.entry(r.day.to_string()).or_insert(PerDay { kwh: None, err2: Some(0.0), plants: 0, energy_kwh: None });
        if let Some(e) = r.energy_kwh {
            d.energy_kwh = Some(d.energy_kwh.unwrap_or(0.0) + e);
        }
        let Some(ck) = r.curtailed_kwh else { continue };
        p.judged_days += 1;
        p.kwh = Some(p.kwh.unwrap_or(0.0) + ck);
        d.kwh = Some(d.kwh.unwrap_or(0.0) + ck);
        let e = if ck == 0.0 { Some(0.0) } else { r.curtailed_err_kwh };
        p.err = match (p.err, e) {
            (Some(a), Some(b)) => Some(a + b),
            _ => None,
        };
        d.err2 = match (d.err2, e) {
            (Some(a), Some(b)) => Some(a + b * b),
            _ => None,
        };
        p.slots += i64::from(r.curtailed_slots.unwrap_or(0));
        p.export_limit_kwh += r.curtailed_export_kwh.unwrap_or(0.0);
        p.power_limit_kwh += r.curtailed_limit_kwh.unwrap_or(0.0);
        if ck > 0.0 {
            p.curtailed_days += 1;
            d.plants += 1;
        }
        p.last = Some(r);
    }
    let last_day: HashMap<i32, NaiveDate> = sqlx::query_as::<_, (i32, NaiveDate)>(
        "SELECT plant_id, max(day) FROM growatt_plant_daily WHERE day >= $1 AND day <= $2 AND curtailed_kwh > 0 GROUP BY plant_id",
    )
    .bind(start)
    .bind(end)
    .fetch_all(pool)
    .await?
    .into_iter()
    .collect();

    struct Out {
        kwh: Option<f64>,
        err: Option<f64>,
        energy: Option<f64>,
        status: String,
        v: Value,
    }
    let mut out_rows: Vec<Out> = Vec::new();
    for pid in order {
        let p = &per[&pid];
        let (name, phase) = &plants[&pid];
        let last = p.last.as_ref();
        let kwh = p.kwh;
        let e = p.energy_kwh;
        let curtailed_kwh = kwh.map(|k| py_round(k, 1));
        let curtailed_err = if kwh.is_some() { p.err.map(|x| py_round(x, 1)) } else { None };
        let pct = match (kwh, e) {
            (Some(k), Some(e)) if k != 0.0 && e + k > 0.0 => Some(py_round(k / (e + k) * 100.0, 1)),
            (Some(0.0), _) => Some(0.0),
            _ => None,
        };
        let status = match last {
            Some(l) if l.curtail_ratio.is_some() => l.curtail_ratio_source.clone().filter(|s| !s.is_empty()).unwrap_or_else(|| "not_checked".into()),
            _ => "not_checked".into(),
        };
        let v = json!({
            "plant_id": pid,
            "name": name,
            "phase": phase,
            "capacity_kwp": last.and_then(|l| l.capacity_kwp),
            "curtailed_kwh": curtailed_kwh,
            // typical error of curtailed_kwh (Σ of its days; null = rests on the plain model somewhere)
            "curtailed_err_kwh": curtailed_err,
            "energy_kwh": e.map(|x| py_round(x, 1)),
            // share of what the plant could have given (produced + curtailed)
            "curtailed_pct": pct,
            "days": p.days,
            "judged_days": p.judged_days,
            "curtailed_days": p.curtailed_days,
            "curtailed_slots": p.slots,
            "by": {"export_limit": py_round(p.export_limit_kwh, 1), "power_limit": py_round(p.power_limit_kwh, 1)},
            "last_curtailed_day": last_day.get(&pid).map(|d| d.to_string()),
            "calibration": {
                "ratio": last.and_then(|l| l.curtail_ratio),
                "slots": last.and_then(|l| l.curtail_ratio_slots),
                "status": status,
            },
        });
        out_rows.push(Out { kwh: curtailed_kwh, err: curtailed_err, energy: e.map(|x| py_round(x, 1)), status, v });
    }
    // stable: null last, then by curtailed kWh, largest first
    out_rows.sort_by(|a, b| {
        (a.kwh.is_none(), -a.kwh.unwrap_or(0.0)).partial_cmp(&(b.kwh.is_none(), -b.kwh.unwrap_or(0.0))).unwrap_or(std::cmp::Ordering::Equal)
    });
    let judged: Vec<&Out> = out_rows.iter().filter(|r| r.kwh.is_some()).collect();
    let count = |s: &str| judged.iter().filter(|r| r.status == s).count();
    let summary = json!({
        "plants": out_rows.len(),
        "judged_plants": judged.len(),
        "curtailed_plants": judged.iter().filter(|r| r.kwh.unwrap_or(0.0) > 0.0).count(),
        "plant_calibrated": count("plant"),
        "blend_calibrated": count("blend"),
        "fleet_calibrated": count("fleet"),
        "curtailed_kwh": if judged.is_empty() { None } else { Some(py_round(py_sum(judged.iter().map(|r| r.kwh.unwrap_or(0.0))), 1)) },
        // √Σ of the plants' errors (independent between plants); null when one is unknown
        "curtailed_err_kwh": if !judged.is_empty() && judged.iter().all(|r| r.err.is_some()) {
            Some(py_round(py_sum(judged.iter().map(|r| { let e = r.err.unwrap_or(0.0); e * e })).sqrt(), 1))
        } else {
            None
        },
        "energy_kwh": if out_rows.is_empty() { None } else { Some(py_round(py_sum(out_rows.iter().map(|r| r.energy.unwrap_or(0.0))), 1)) },
    });
    let days_out: Vec<Value> = days
        .iter()
        .map(|(day, d)| {
            json!({
                "day": day,
                "kwh": d.kwh.map(|k| py_round(k, 1)),
                "err_kwh": match (d.kwh, d.err2) { (Some(_), Some(e2)) => Some(py_round(e2.sqrt(), 1)), _ => None },
                "plants": d.plants,
                "energy_kwh": d.energy_kwh.map(|e| py_round(e, 1)),
            })
        })
        .collect();
    Ok(json!({
        "meta": {
            "source": "db",
            "start": start.to_string(),
            "end": end.to_string(),
            "estimated": true,
            "calibration_days": CALIBRATION_DAYS,
            "calibration_min_slots": CALIBRATION_MIN_SLOTS,
        },
        "summary": summary,
        "plants": out_rows.into_iter().map(|r| r.v).collect::<Vec<_>>(),
        "days": days_out,
    }))
}

/// Python `per_day`: {day: curtailed kWh} from annotated rows; null for a day with no judged slot.
pub fn per_day(rows: &[Row]) -> BTreeMap<String, Option<f64>> {
    let mut out: BTreeMap<String, Option<f64>> = BTreeMap::new();
    for r in rows {
        let d = r.get("timestamp").and_then(Value::as_str).and_then(|t| t.get(..10)).unwrap_or("").to_owned();
        match num(r, "curtailed_kw") {
            None => {
                out.entry(d).or_insert(None);
            }
            Some(kw) => {
                let e = out.entry(d).or_insert(None);
                *e = Some(e.unwrap_or(0.0) + kw * SLOT_H);
            }
        }
    }
    out.into_iter().map(|(d, v)| (d, v.map(|x| py_round(x, 1)))).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(ts: &str, g: f64, pac: f64, imp: f64, exp: f64) -> Row {
        json!({"timestamp": ts, "irradiance_wm2": g, "pac_kw": pac, "module_temp_c": 25.0, "inverters": 1,
               "grid_import_kw": imp, "grid_export_kw": exp}).as_object().unwrap().clone()
    }

    #[test]
    fn export_limit_run() {
        let mut rows = vec![
            row("2026-11-27 11:00:00", 800.0, 40.0, 0.5, 0.0),
            row("2026-11-27 11:05:00", 800.0, 40.0, 0.5, 0.0),
            row("2026-11-27 11:10:00", 800.0, 79.0, 0.5, 0.0),
        ];
        let a = AnnotateArgs { kwp: Some(100.0), factor: 1.0, gamma_pct: -0.3, inverter_count: 1, ..Default::default() };
        let s = annotate(&mut rows, &a);
        assert_eq!(rows[0]["available_kw"], json!(80.0));
        assert_eq!(rows[0]["curtailed_kw"], json!(40.0));
        assert_eq!(rows[0]["curtailed_by"], json!("export_limit"));
        assert_eq!(rows[2]["curtailed_kw"], json!(0.0));
        assert_eq!(s["slots"], json!(2));
        assert_eq!(s["judged_slots"], json!(3));
        assert_eq!(s["kwh"], json!(6.7));
        assert_eq!(s["err_kwh"], Value::Null); // plain model
        assert_eq!(s["calibration"]["status"], json!("not_checked"));
        let pd = per_day(&rows);
        assert_eq!(pd["2026-11-27"], Some(6.7));
    }

    #[test]
    fn no_capacity() {
        let mut rows = vec![row("2026-11-27 11:00:00", 800.0, 40.0, 0.5, 0.0)];
        let s = annotate(&mut rows, &AnnotateArgs { factor: 1.0, ..Default::default() });
        assert_eq!(s["reason"], json!("no_capacity"));
        assert_eq!(s["kwh"], Value::Null);
        assert_eq!(rows[0]["available_kw"], Value::Null);
    }
}
