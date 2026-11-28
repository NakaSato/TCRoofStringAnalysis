//! Monitoring PWA Report Google Sheet, filled by the worker through the Google Sheets API: port of
//! backend/app/services/pwa_sheet.py (`google_sky`, `sheet_name`, `published_hours`, `layout`,
//! `sky_th`, `_check`, `note`, `_issue_text`, `_ignored_item`, `_shown_issues`, `_capped`,
//! `data_log`, `plant_cells`, `match_plant`, `fill_rows`, `col_letter`, `ensure_day_sheet`,
//! `fill_day`, `run_for_now`) and of jobs.py `_pwa_sheet`.
//!
//! Off unless PWA_SHEET_ID is set. The worker writes as a service account (key file
//! PWA_SHEET_CREDENTIALS_FILE, else FIREBASE_CREDENTIALS_FILE). Same rules as the Apps Script: a
//! check cell is written only while empty, a check not published yet is skipped, and only the
//! cells a fill changes are written. Nothing is made up: no source = "—". สภาพอากาศ is Google's
//! (modelled) sky first, the sensor's sky class only when Google has none.
//!
//! Sheet values are handled as JSON values (what the Sheets API answers with
//! `UNFORMATTED_VALUE`); Python's `str()` of a cell is [`py_str`] and `==` between cells is
//! [`py_eq`] (1 == 1.0).

use std::collections::{BTreeSet, HashMap};

use chrono::{Duration, NaiveDate, NaiveDateTime, NaiveTime};
use serde_json::{json, Value};
use sqlx::PgPool;
use tcroof_clients::google_sheets::{a1, SheetsClient, SheetsError};

use crate::common::py_round;
use crate::publish::py_float_repr;
use crate::pwa_report::{self, FirestoreConfig, PlantInfo, ReportData};

/// Python `check_slots.CHECK_HOURS`
pub const CHECK_HOURS: [u32; 3] = crate::weather::CHECK_HOURS;
/// Python `WX_NORMAL`, `WX_ABNORMAL`
pub const WX_NORMAL: &str = "Normal";
pub const WX_ABNORMAL: &str = "Abnormal";
/// Python `FIRST_ROW` (1-based)
pub const FIRST_ROW: usize = 3;
/// Python `DASH`
pub const DASH: &str = "—";
/// Python `SKY_CLEAR`, `SKY_CLOUD`, `SKY_RAIN`
pub const SKY_CLEAR: &str = "ท้องฟ้าปลอดโปร่ง";
pub const SKY_CLOUD: &str = "มีเมฆมาก";
pub const SKY_RAIN: &str = "ฝนตก";
/// Python `GOOGLE_CLEAR_COVER_PCT`
pub const GOOGLE_CLEAR_COVER_PCT: f64 = 30.0;
/// Python `LOG_MAX`
pub const LOG_MAX: usize = 300;
/// Python `NOT_PRODUCING`
pub const NOT_PRODUCING: &str = "INV ไม่ผลิตไฟ";
/// Python `CELL_COLUMNS`
pub const CELL_COLUMNS: [&str; 7] = ["status", "note", "irr", "wx", "log", "kw", "inv"];

/// The settings the sheet fill reads.
#[derive(Debug, Clone, Default)]
pub struct PwaSheetConfig {
    /// `PWA_SHEET_ID` (empty = off)
    pub sheet_id: String,
    /// `PWA_SHEET_CREDENTIALS_FILE`, else `FIREBASE_CREDENTIALS_FILE`
    pub credentials_file: String,
    /// The Sheets API root. Python's is fixed (`pwa_sheet.API`); `PWA_SHEET_API_URL` overrides it
    /// for the parity harness only (empty = Google's).
    pub sheets_api: String,
    /// where the published day docs are read
    pub firestore: FirestoreConfig,
    /// `CHECK_OFFSET_MIN` (10)
    pub check_offset_min: i64,
    /// `PWA_IGNORE_WARN_CODES` ("1") as numbers
    pub ignored_warn_codes: BTreeSet<i64>,
}

impl PwaSheetConfig {
    /// From the environment, with Python's defaults (backend/app/config.py).
    pub fn from_env() -> Self {
        let get = |k: &str| std::env::var(k).ok().map(|v| v.trim().to_owned()).filter(|v| !v.is_empty());
        let firebase = get("FIREBASE_CREDENTIALS_FILE").unwrap_or_default();
        PwaSheetConfig {
            sheet_id: get("PWA_SHEET_ID").unwrap_or_default(),
            credentials_file: get("PWA_SHEET_CREDENTIALS_FILE").unwrap_or_else(|| firebase.clone()),
            sheets_api: get("PWA_SHEET_API_URL").unwrap_or_default(),
            firestore: FirestoreConfig {
                project_id: get("FIREBASE_PROJECT_ID").unwrap_or_default(),
                credentials_file: firebase,
                emulator_host: get("FIRESTORE_EMULATOR_HOST").unwrap_or_default(),
            },
            check_offset_min: get("CHECK_OFFSET_MIN").and_then(|v| v.parse().ok()).unwrap_or(10),
            ignored_warn_codes: parse_codes(&std::env::var("PWA_IGNORE_WARN_CODES").unwrap_or_else(|_| "1".into())),
        }
    }
}

/// Python `Settings.pwa_ignored_warn_codes`
pub fn parse_codes(s: &str) -> BTreeSet<i64> {
    s.split(',').map(str::trim).filter(|p| !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit())).filter_map(|p| p.parse().ok()).collect()
}

// --------------------------------------------------------------------------- Python value helpers

/// Python truthiness of a JSON value
pub fn truthy(v: &Value) -> bool {
    match v {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().is_some_and(|x| x != 0.0),
        Value::String(s) => !s.is_empty(),
        Value::Array(a) => !a.is_empty(),
        Value::Object(o) => !o.is_empty(),
    }
}

fn num_str(n: &serde_json::Number) -> String {
    if let Some(i) = n.as_i64() {
        i.to_string()
    } else if let Some(u) = n.as_u64() {
        u.to_string()
    } else {
        py_float_repr(n.as_f64().unwrap_or(f64::NAN))
    }
}

/// Python `str()` of a JSON value (`None`, `True`, `12.0`, the text itself).
pub fn py_str(v: &Value) -> String {
    match v {
        Value::Null => "None".into(),
        Value::Bool(b) => if *b { "True" } else { "False" }.into(),
        Value::Number(n) => num_str(n),
        Value::String(s) => s.clone(),
        other => py_repr(other),
    }
}

fn str_repr(s: &str) -> String {
    let q = if s.contains('\'') && !s.contains('"') { '"' } else { '\'' };
    let mut out = String::new();
    out.push(q);
    for ch in s.chars() {
        match ch {
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if c == q => {
                out.push('\\');
                out.push(c);
            }
            c => out.push(c),
        }
    }
    out.push(q);
    out
}

/// Python `repr()` of a JSON value (dicts in their key order)
pub fn py_repr(v: &Value) -> String {
    match v {
        Value::String(s) => str_repr(s),
        Value::Array(a) => format!("[{}]", a.iter().map(py_repr).collect::<Vec<_>>().join(", ")),
        Value::Object(o) => format!("{{{}}}", o.iter().map(|(k, v)| format!("{}: {}", str_repr(k), py_repr(v))).collect::<Vec<_>>().join(", ")),
        other => py_str(other),
    }
}

/// Python `==` between two cell values: numbers by value (1 == 1.0)
pub fn py_eq(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Number(x), Value::Number(y)) => x.as_f64() == y.as_f64(),
        _ => a == b,
    }
}

fn dash() -> Value {
    Value::String(DASH.into())
}

/// Python `round(x, 1)`: an integer stays an integer
fn round1(v: &Value) -> Value {
    if v.is_i64() || v.is_u64() {
        return v.clone();
    }
    v.as_f64().map(|x| json!(py_round(x, 1))).unwrap_or(Value::Null)
}

/// Python `round(x)`: an integer, half to even
fn round0(v: &Value) -> Option<i64> {
    if let Some(i) = v.as_i64() {
        return Some(i);
    }
    v.as_f64().filter(|x| x.is_finite()).map(|x| x.round_ties_even() as i64)
}

/// A JSON number as f64 (a bool counts as 0 / 1, as in Python arithmetic)
fn f(v: &Value) -> Option<f64> {
    match v {
        Value::Bool(b) => Some(f64::from(u8::from(*b))),
        _ => v.as_f64(),
    }
}

// --------------------------------------------------------------------------- small pieces

/// Python `google_sky`: Google's conditions as one of the three sky values; None when Google gave
/// nothing.
pub fn google_sky(g: Option<&Value>) -> Option<&'static str> {
    let g = g.filter(|g| truthy(g))?;
    if g.get("raining").is_some_and(truthy) {
        return Some(SKY_RAIN);
    }
    let cond = g.get("condition").filter(|c| truthy(c)).map(py_str).unwrap_or_default().to_uppercase();
    if cond == "CLEAR" || cond == "MOSTLY_CLEAR" {
        return Some(SKY_CLEAR);
    }
    if cond.contains("CLOUD") || cond.starts_with("CHANCE_OF") {
        return Some(SKY_CLOUD);
    }
    match g.get("cloud_cover_pct").filter(|c| !c.is_null()).and_then(f) {
        Some(cover) => Some(if cover <= GOOGLE_CLEAR_COVER_PCT { SKY_CLEAR } else { SKY_CLOUD }),
        None => None,
    }
}

/// Python `sheet_name`: DD.MM
pub fn sheet_name(day: NaiveDate) -> String {
    day.format("%d.%m").to_string()
}

/// Python `check_slots.slot_time`: hh:00 − CHECK_OFFSET_MIN
pub fn slot_time(day: NaiveDate, hour: u32, offset_min: i64) -> NaiveDateTime {
    day.and_time(NaiveTime::from_hms_opt(hour, 0, 0).expect("hour")) - Duration::minutes(offset_min)
}

/// Python `published_hours`: check hours whose snapshot time has passed (plant-local `now`).
pub fn published_hours(now: NaiveDateTime, offset_min: i64) -> Vec<u32> {
    CHECK_HOURS.into_iter().filter(|h| now >= slot_time(now.date(), *h, offset_min)).collect()
}

/// Python `sky_th`: measured ÷ clear-sky → clear (≥ 0.75) or cloudy; None when the sun is too low.
pub fn sky_th(irr: f64, cs: f64) -> Option<&'static str> {
    if cs < 80.0 {
        return None;
    }
    Some(if irr / cs >= 0.75 { SKY_CLEAR } else { SKY_CLOUD })
}

/// Python `clear_sky`: Haurwitz clear-sky GHI (modelled) at Bangkok wall-clock `hour:minute`.
pub fn clear_sky(lat: f64, lon: f64, day: NaiveDate, hour: u32, minute: u32) -> f64 {
    tcroof_core::sun::clear_sky_ghi(day, lat, lon, f64::from(hour * 60 + minute), tcroof_core::sun::DEFAULT_UTC_OFFSET_H)
}

// --------------------------------------------------------------------------- layout

/// Python `Block` (1-based columns, 0 = not in this layout)
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct Block {
    pub hour: u32,
    pub status: usize,
    pub note: usize,
    pub irr: usize,
    pub wx: usize,
    pub log: usize,
    pub kw: usize,
    pub inv: usize,
}

impl Block {
    fn col(&self, name: &str) -> usize {
        match name {
            "status" => self.status,
            "note" => self.note,
            "irr" => self.irr,
            "wx" => self.wx,
            "log" => self.log,
            "kw" => self.kw,
            "inv" => self.inv,
            _ => 0,
        }
    }
}

/// Python `Layout`
#[derive(Debug, Clone, PartialEq)]
pub struct Layout {
    pub weather: usize,
    pub blocks: Vec<Block>,
    pub first: usize,
    pub last: usize,
    pub yield_kwh: usize,
    pub firmware: usize,
}

/// Python `_cell`: 0-based row / col into a ragged grid; missing or null = "".
pub fn cell(rows: &[Vec<Value>], r: usize, c: usize) -> Value {
    match rows.get(r).and_then(|row| row.get(c)) {
        None | Some(Value::Null) => Value::String(String::new()),
        Some(v) => v.clone(),
    }
}

/// `re.search(a\s*b, s, re.I)`
fn search_ws(s: &str, a: &str, b: &str) -> bool {
    let l = s.to_lowercase();
    let mut from = 0;
    while let Some(i) = l[from..].find(a) {
        let rest = l[from + i + a.len()..].trim_start();
        if rest.starts_with(b) {
            return true;
        }
        from += i + a.len();
    }
    false
}

/// `re.match(prefix, s, re.I)`
fn starts_ci(s: &str, prefix: &str) -> bool {
    s.to_lowercase().starts_with(prefix)
}

/// `re.match(r"kw\b", s, re.I)`
fn kw_word(s: &str) -> bool {
    let l = s.to_lowercase();
    l.starts_with("kw") && l[2..].chars().next().is_none_or(|c| !(c.is_alphanumeric() || c == '_'))
}

/// Python `layout`: the column map from header rows 1–2. Each "Status" in row 2 after "weather
/// Status" starts the next check block. Err = Python's ValueError text.
pub fn layout(rows: &[Vec<Value>], title: &str) -> Result<Layout, String> {
    let width = rows.iter().take(2).map(Vec::len).max().unwrap_or(0);
    let r1: Vec<String> = (0..width).map(|k| py_str(&cell(rows, 0, k))).collect();
    let r2: Vec<String> = (0..width).map(|k| py_str(&cell(rows, 1, k)).trim().to_owned()).collect();
    let weather = r1.iter().position(|v| search_ws(v, "weather", "status")).map(|k| k + 1).unwrap_or(0);
    if weather == 0 {
        return Err(format!("Sheet {title}: no \"weather Status\" header in row 1"));
    }
    let starts: Vec<usize> = r2.iter().enumerate().filter(|(k, v)| k + 1 > weather && starts_ci(v, "status")).map(|(k, _)| k + 1).collect();
    if starts.len() < CHECK_HOURS.len() {
        return Err(format!("Sheet {title}: expected {} \"Status\" columns in row 2", CHECK_HOURS.len()));
    }
    let mut blocks = Vec::new();
    for (k, hour) in CHECK_HOURS.into_iter().enumerate() {
        let frm = starts[k];
        let to = if k + 1 < starts.len() { starts[k + 1] - 1 } else { width.min(frm + CELL_COLUMNS.len() - 1) };
        let mut b = Block { hour, status: frm, ..Block::default() };
        for col in frm + 1..=to {
            let v = &r2[col - 1];
            if starts_ci(v, "note") {
                b.note = col;
            } else if v.contains("ค่าแสง") {
                b.irr = col;
            } else if v.contains("สภาพอากาศ") {
                b.wx = col;
            } else if search_ws(v, "data", "log") {
                b.log = col;
            } else if kw_word(v) || v.contains("กำลังผลิต") {
                b.kw = col;
            } else if search_ws(v, "inv", "online") {
                b.inv = col;
            }
        }
        blocks.push(b);
    }
    let yield_kwh = r1.iter().position(|v| v.to_lowercase().contains("yield") || v.contains("พลังงาน")).map(|k| k + 1).unwrap_or(0);
    let mut cols = vec![weather, yield_kwh];
    for b in &blocks {
        cols.extend([b.status, b.note, b.irr, b.wx, b.log, b.kw, b.inv]);
    }
    cols.retain(|c| *c != 0);
    let firmware = r1.iter().position(|v| v.to_lowercase().contains("firmware")).map(|k| k + 1).unwrap_or(0);
    Ok(Layout {
        weather,
        blocks,
        first: *cols.iter().min().expect("weather"),
        last: *cols.iter().max().expect("weather"),
        yield_kwh,
        firmware,
    })
}

// --------------------------------------------------------------------------- cell values

/// Python `_check`: a check's inverter state lists (None when the doc has no dict there)
#[derive(Debug, Clone)]
pub struct Check {
    inverters: f64,
    inverters_text: String,
    offline: Vec<Value>,
    fault: Vec<Value>,
    alarms: Vec<Value>,
    errors: Option<Vec<Value>>,
    issues: Option<Vec<Value>>,
}

fn list(v: Option<&Value>) -> Vec<Value> {
    match v {
        Some(Value::Array(a)) => a.clone(),
        _ => vec![],
    }
}

/// Python `_check`
fn check(c: Option<&Value>) -> Option<Check> {
    let c = c?.as_object()?;
    let inv = c.get("inverters").filter(|v| truthy(v)).cloned().unwrap_or(json!(0));
    Some(Check {
        inverters: f(&inv).unwrap_or(0.0),
        inverters_text: py_str(&inv),
        offline: list(c.get("offline")),
        fault: list(c.get("fault")),
        alarms: list(c.get("alarms")),
        errors: c.get("errors").and_then(Value::as_array).cloned(),
        issues: c.get("issues").and_then(Value::as_array).cloned(),
    })
}

fn joined(items: &[Value], sep: &str) -> String {
    items.iter().map(py_str).collect::<Vec<_>>().join(sep)
}

/// Python `note` (old layout's Note column)
pub fn note(kw: Option<f64>, c: Option<&Check>, irr: Option<i64>, has_sensor: bool, rain: bool) -> String {
    let mut parts: Vec<String> = Vec::new();
    if let Some(c) = c {
        if !c.alarms.is_empty() {
            parts.push(format!("({})", joined(&c.alarms, ", ")));
        }
    }
    let all_offline = match c {
        Some(c) => c.offline.len() as f64 >= c.inverters,
        None => kw.is_none(),
    };
    match kw {
        Some(kw) if !all_offline => {
            let bad: Vec<String> = match c {
                Some(c) => c.offline.iter().map(|x| format!("{} Offline", py_str(x))).chain(c.fault.iter().map(|x| format!("{} Fault", py_str(x)))).collect(),
                None => vec![],
            };
            parts.push(if !bad.is_empty() {
                bad.join(" ")
            } else if kw > 0.0 {
                "INV ทำงานปกติ".into()
            } else {
                NOT_PRODUCING.into()
            });
            if let Some(irr) = irr {
                parts.push(format!("ค่าแสง {irr}"));
            } else if has_sensor {
                parts.push("Weather offline".into());
            }
        }
        _ => parts.push("INV Offline".into()),
    }
    if rain {
        parts.push("(ฝนตก)".into());
    }
    parts.join(" ")
}

/// Python `_issue_text`: "INV3 Fault: 117 Relay check fail (06:19, ×5)"; an offline inverter
/// "INV2 Offline (last data 07:40)" / "(no data today)".
fn issue_text(issue: &Value) -> String {
    let mut parts: Vec<String> = Vec::new();
    for it in list(issue.get("items")) {
        let text = [it.get("code"), it.get("message")]
            .into_iter()
            .flatten()
            .filter(|v| !v.is_null() && *v != &Value::String(String::new()))
            .map(|v| py_str(v).trim().to_owned())
            .collect::<Vec<_>>()
            .join(" ");
        if text.is_empty() {
            continue;
        }
        let count = it.get("count").filter(|c| truthy(c)).cloned().unwrap_or(json!(0));
        let mut when: Vec<String> = it.get("since").filter(|s| truthy(s)).map(py_str).into_iter().collect();
        if f(&count).unwrap_or(0.0) > 1.0 {
            when.push(format!("×{}", py_str(&count)));
        }
        let text = if when.is_empty() { text } else { format!("{text} ({})", when.join(", ")) };
        if !parts.contains(&text) {
            parts.push(text);
        }
    }
    let get = |k: &str| issue.get(k).map(py_str).unwrap_or_else(|| "None".into());
    let mut head = format!("{} {}", get("inv"), get("state"));
    if issue.get("state") == Some(&json!("Offline")) {
        if let Some(last) = issue.get("last") {
            if truthy(last) {
                head += &format!(" (last data {})", py_str(last));
            } else {
                head += " (no data today)";
            }
        }
    }
    if parts.is_empty() {
        head
    } else {
        format!("{head}: {}", parts.join(" / "))
    }
}

/// Python `_ignored_item`: a reading's own code in PWA_IGNORE_WARN_CODES with no text and no `since`
fn ignored_item(it: &Value, ignored: &BTreeSet<i64>) -> bool {
    let code = it.get("code").filter(|c| truthy(c)).map(py_str).unwrap_or_default();
    let code = code.trim();
    !code.is_empty()
        && code.chars().all(|c| c.is_ascii_digit())
        && code.parse::<i64>().is_ok_and(|n| ignored.contains(&n))
        && !it.get("message").is_some_and(truthy)
        && !it.get("since").is_some_and(truthy)
}

/// Python `_shown_issues`: ignored codes out; an Alarm entry left with no item dropped
fn shown_issues(issues: &[Value], ignored: &BTreeSet<i64>) -> Vec<Value> {
    let mut out = Vec::new();
    for i in issues {
        let items: Vec<Value> = list(i.get("items")).into_iter().filter(|it| !ignored_item(it, ignored)).collect();
        if i.get("state") == Some(&json!("Alarm")) && items.is_empty() {
            continue;
        }
        let mut o = i.as_object().cloned().unwrap_or_default();
        o.insert("items".into(), Value::Array(items));
        out.push(Value::Object(o));
    }
    out
}

fn clen(s: &str) -> usize {
    s.chars().count()
}

/// Python `_capped`: entries joined with ", "; over `limit` (characters), cut at a whole entry
/// and end with "…(+N)".
pub fn capped(entries: &[String], limit: usize) -> String {
    let full = entries.join(", ");
    if clen(&full) <= limit {
        return full;
    }
    for keep in (1..entries.len()).rev() {
        let text = format!("{}, …(+{})", entries[..keep].join(", "), entries.len() - keep);
        if clen(&text) <= limit {
            return text;
        }
    }
    let tail = if entries.len() > 1 { format!("…(+{})", entries.len() - 1) } else { "…".into() };
    let keep = limit.saturating_sub(clen(&tail));
    entries[0].chars().take(keep).collect::<String>() + &tail
}

/// Python `data_log`: DATA LOG (Fault log) of one check
pub fn data_log(kw: Option<f64>, c: Option<&Check>, ignored: &BTreeSet<i64>) -> String {
    let all_offline = c.is_some_and(|c| c.offline.len() as f64 >= c.inverters);
    let Some(kw) = kw.filter(|_| !all_offline) else {
        if let Some(c) = c {
            if c.issues.is_none() {
                if let Some(errs) = c.errors.as_ref().filter(|e| !e.is_empty()) {
                    let mut e = vec![format!("offline: {}", py_str(&errs[0]))];
                    e.extend(errs[1..].iter().map(py_str));
                    return capped(&e, LOG_MAX);
                }
            }
        }
        return "offline".into();
    };
    let idle: Vec<String> = if kw <= 0.0 { vec![NOT_PRODUCING.into()] } else { vec![] };
    let Some(c) = c else {
        return idle.first().cloned().unwrap_or_else(|| DASH.into());
    };
    let entries: Vec<String> = match &c.issues {
        Some(issues) => shown_issues(issues, ignored).iter().map(issue_text).collect(),
        None => {
            let log = c.errors.clone().unwrap_or_else(|| c.alarms.clone());
            c.offline
                .iter()
                .map(|x| format!("{} Offline", py_str(x)))
                .chain(c.fault.iter().map(|x| format!("{} Fault", py_str(x))))
                .chain(log.iter().map(py_str))
                .collect()
        }
    };
    if idle.is_empty() && entries.is_empty() {
        return DASH.into();
    }
    capped(&[idle, entries].concat(), LOG_MAX)
}

/// Python `plant_cells`' answer
#[derive(Debug, Clone)]
pub struct PlantCells {
    /// "09" → [status, note, irr, wx, log, kw, inv] (CELL_COLUMNS)
    pub checks: HashMap<String, Vec<Value>>,
    /// "09" → "growatt" / "google" / None: where the sky class came from
    pub sources: HashMap<String, Option<&'static str>>,
    pub weather_status: &'static str,
    pub weather_detail: String,
    pub yield_kwh: Value,
}

fn is_hh_mm(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 5 && b[2] == b':' && [0, 1, 3, 4].iter().all(|i| b[*i].is_ascii_digit())
}

/// Python `plant_cells`: the sheet's values for one plant. `doc` = the published daily doc
/// (`{}` = not published), `ready` = check hours published in full (None = all). A check not ready
/// is "—" in every column, for every plant.
pub fn plant_cells(day: NaiveDate, doc: &Value, info: &PlantInfo, hours: &[u32], ready: Option<&[String]>, ignored: &BTreeSet<i64>) -> PlantCells {
    let empty = json!({});
    let doc = if doc.is_object() { doc } else { &empty };
    let hourly = list(doc.get("hourly_kw").filter(|v| truthy(v)));
    let weather = doc.get("weather").filter(|v| truthy(v)).cloned().unwrap_or(json!({}));
    let has_sensor = weather.get("has_sensor").is_some_and(truthy);
    let sensor_slots = weather.get("slots").filter(|v| truthy(v)).cloned().unwrap_or(json!({}));
    let google_slots = doc.get("google_weather").filter(|v| truthy(v)).and_then(|g| g.get("slots")).filter(|v| truthy(v)).cloned().unwrap_or(json!({}));
    let checks = doc.get("checks").filter(|v| truthy(v)).cloned().unwrap_or(json!({}));
    let mut out = PlantCells { checks: HashMap::new(), sources: HashMap::new(), weather_status: WX_ABNORMAL, weather_detail: String::new(), yield_kwh: dash() };
    let mut sensor_hit: Vec<(u32, bool)> = Vec::new();
    for &hour in hours {
        let hh = format!("{hour:02}");
        if ready.is_some_and(|r| !r.contains(&hh)) {
            out.checks.insert(hh.clone(), vec![dash(); CELL_COLUMNS.len()]);
            out.sources.insert(hh, None);
            continue;
        }
        let raw = checks.get(&hh);
        let c = check(raw);
        let (mut at_h, mut at_m) = (hour, 0u32);
        let (kw_v, irr_v, g): (Value, Value, Option<Value>) = match raw.and_then(Value::as_object).filter(|o| o.contains_key("kw")) {
            Some(o) => {
                if let Some(at) = o.get("at").and_then(Value::as_str).filter(|a| is_hh_mm(a)) {
                    at_h = at[..2].parse().unwrap_or(hour);
                    at_m = at[3..].parse().unwrap_or(0);
                }
                (o.get("kw").cloned().unwrap_or(Value::Null), o.get("irradiance_wm2").cloned().unwrap_or(Value::Null), o.get("google").cloned())
            }
            None => (
                hourly.get(hour as usize).cloned().unwrap_or(Value::Null),
                sensor_slots.get(&hh).filter(|v| truthy(v)).and_then(|s| s.get("irradiance_wm2")).cloned().unwrap_or(Value::Null),
                google_slots.get(&hh).cloned(),
            ),
        };
        let kw = if kw_v.is_null() { None } else { f(&kw_v) };
        let irr = if irr_v.is_null() { None } else { round0(&irr_v) };
        sensor_hit.push((hour, irr.is_some()));
        let rain = g.as_ref().is_some_and(|g| truthy(g) && g.get("raining").is_some_and(truthy));

        let bad = c.as_ref().is_some_and(|c| !c.offline.is_empty() || !c.fault.is_empty());
        let ok = kw.is_some_and(|k| k > 0.0) && !bad;
        let has_inv = c.as_ref().is_some_and(|c| c.inverters != 0.0);
        let status = if kw.is_none() && !has_inv { DASH } else if ok { "Normal" } else { "Abnormal" };

        let sky = match (irr, info.latitude, info.longitude) {
            (Some(irr), Some(lat), Some(lon)) => sky_th(irr as f64, clear_sky(lat, lon, day, at_h, at_m)),
            _ => None,
        };
        let (wx, src) = match (google_sky(g.as_ref()), sky) {
            (Some(gs), _) => (gs, Some("google")),
            (None, Some(s)) => (s, Some("growatt")),
            _ => (DASH, None),
        };
        let inv = match &c {
            Some(c) if c.inverters != 0.0 => {
                let online = c.inverters - c.offline.len() as f64;
                let online = if c.inverters.fract() == 0.0 && !c.inverters_text.contains('.') { format!("{}", online as i64) } else { py_float_repr(online) };
                format!("{online}/{}", c.inverters_text)
            }
            _ => DASH.into(),
        };
        out.checks.insert(
            hh.clone(),
            vec![
                json!(status),
                json!(note(kw, c.as_ref(), irr, has_sensor, rain)),
                irr.map(|i| json!(i)).unwrap_or_else(dash),
                json!(wx),
                json!(data_log(kw, c.as_ref(), ignored)),
                if kw_v.is_null() { dash() } else { round1(&kw_v) },
                json!(inv),
            ],
        );
        out.sources.insert(hh, src);
    }
    let detail = if doc.as_object().is_none_or(|o| o.is_empty()) {
        DASH.to_owned()
    } else if !has_sensor {
        "ไม่มีเซนเซอร์".to_owned()
    } else if sensor_hit.is_empty() {
        DASH.to_owned()
    } else if sensor_hit.iter().all(|(_, hit)| *hit) {
        "normal".to_owned()
    } else {
        format!("loss ({})", sensor_hit.iter().filter(|(_, hit)| !hit).map(|(h, _)| format!("{h:02}:00")).collect::<Vec<_>>().join(", "))
    };
    out.weather_status = if detail == "normal" { WX_NORMAL } else { WX_ABNORMAL };
    out.weather_detail = detail;
    out.yield_kwh = match doc.get("yield_kwh") {
        None | Some(Value::Null) => dash(),
        Some(y) => round1(y),
    };
    out
}

/// Python `match_plant`: datalogger SN first, then a unique plant-name match.
pub fn match_plant(sn: &str, name: &str, loggers: &HashMap<String, String>, names: &[(String, Option<String>)]) -> Option<String> {
    if let Some(pid) = loggers.get(sn).filter(|p| !p.is_empty()) {
        return Some(pid.clone());
    }
    if name.is_empty() {
        return None;
    }
    let hits: Vec<&String> = names.iter().filter(|(_, n)| n.as_deref().unwrap_or("").contains(name)).map(|(p, _)| p).collect();
    (hits.len() == 1).then(|| hits[0].clone())
}

/// Python `FillStats`
#[derive(Debug, Clone, Default)]
pub struct FillStats {
    pub rows: i64,
    pub normal: i64,
    pub abnormal: i64,
    pub no_power: i64,
    pub wx_growatt: i64,
    pub wx_google: i64,
    pub unmatched: i64,
    pub written: i64,
    pub kept: i64,
    pub published_plants: i64,
    pub firmware: i64,
    pub hours: Vec<u32>,
    pub skipped_hours: Vec<u32>,
}

impl FillStats {
    /// `stats.__dict__`, in field order
    fn pairs(&self) -> Vec<(&'static str, Value)> {
        vec![
            ("rows", json!(self.rows)),
            ("normal", json!(self.normal)),
            ("abnormal", json!(self.abnormal)),
            ("no_power", json!(self.no_power)),
            ("wx_growatt", json!(self.wx_growatt)),
            ("wx_google", json!(self.wx_google)),
            ("unmatched", json!(self.unmatched)),
            ("written", json!(self.written)),
            ("kept", json!(self.kept)),
            ("published_plants", json!(self.published_plants)),
            ("firmware", json!(self.firmware)),
            ("hours", json!(self.hours)),
            ("skipped_hours", json!(self.skipped_hours)),
        ]
    }
}

fn is_empty_cell(v: &Value) -> bool {
    v.is_null() || v == &Value::String(String::new())
}

fn put(row: &mut Vec<Value>, col: usize, v: Value) {
    if col == 0 {
        return;
    }
    while row.len() < col {
        row.push(Value::String(String::new()));
    }
    row[col - 1] = v;
}

/// Python `fill_rows`: fills `rows` (the sheet's values, header rows included) in place for the
/// check blocks in `hours` (None = all). See the module doc for the rules.
pub fn fill_rows(day: NaiveDate, lay: &Layout, rows: &mut [Vec<Value>], data: &ReportData, hours: Option<&[u32]>, ignored: &BTreeSet<i64>) -> FillStats {
    let blocks: Vec<Block> = lay.blocks.iter().filter(|b| hours.is_none_or(|h| h.contains(&b.hour))).copied().collect();
    let ready = data.checks_ready.as_deref();
    let names: Vec<(String, Option<String>)> = data.plants.iter().map(|(p, i)| (p.clone(), i.name.clone())).collect();
    let mut stats = FillStats { published_plants: data.days.len() as i64, ..FillStats::default() };
    let asked: Vec<u32> = blocks.iter().map(|b| b.hour).collect();
    let empty = json!({});
    let cells_of: HashMap<&String, PlantCells> =
        data.plants.iter().map(|(pid, info)| (pid, plant_cells(day, data.days.get(pid).unwrap_or(&empty), info, &asked, ready, ignored))).collect();
    let live: Vec<Block> = blocks
        .iter()
        .filter(|b| {
            let hh = format!("{:02}", b.hour);
            cells_of.values().any(|c| c.checks[&hh].iter().any(|v| v != &dash()))
        })
        .copied()
        .collect();
    stats.hours = live.iter().map(|b| b.hour).collect();
    stats.skipped_hours = blocks.iter().filter(|b| !live.contains(b)).map(|b| b.hour).collect();

    for i in FIRST_ROW - 1..rows.len() {
        let sn = py_str(&cell(rows, i, 2)).trim().to_owned();
        if sn.is_empty() {
            continue;
        }
        if lay.firmware != 0 {
            let cur = py_str(&cell(rows, i, lay.firmware - 1)).trim().to_owned();
            let stale = data.inverter_firmware.get(&sn).cloned().unwrap_or_default();
            if cur.is_empty() || cur == DASH || stale.contains(&cur) {
                let v = data.firmware.get(&sn).cloned().unwrap_or_default();
                if v != cur {
                    put(&mut rows[i], lay.firmware, json!(v));
                }
                stats.firmware += i64::from(!v.is_empty());
            }
        }
        let name = py_str(&cell(rows, i, 1)).trim().to_owned();
        let Some(pid) = match_plant(&sn, &name, &data.loggers, &names) else {
            stats.unmatched += 1;
            put(&mut rows[i], lay.weather, json!(WX_ABNORMAL));
            continue;
        };
        stats.rows += 1;
        let Some(cells) = cells_of.get(&pid) else { continue };
        for b in &live {
            let hh = format!("{:02}", b.hour);
            let vals = &cells.checks[&hh];
            for (k, col) in CELL_COLUMNS.iter().enumerate() {
                let c = b.col(col);
                if c == 0 {
                    continue;
                }
                if is_empty_cell(&cell(rows, i, c - 1)) {
                    put(&mut rows[i], c, vals[k].clone());
                    stats.written += 1;
                } else {
                    stats.kept += 1;
                }
            }
            if vals[5] == dash() {
                stats.no_power += 1;
            } else if vals[0] == json!("Normal") {
                stats.normal += 1;
            } else {
                stats.abnormal += 1;
            }
            match cells.sources.get(&hh).copied().flatten() {
                Some("growatt") => stats.wx_growatt += 1,
                Some("google") => stats.wx_google += 1,
                _ => {}
            }
        }
        put(&mut rows[i], lay.weather, json!(cells.weather_status));
        put(&mut rows[i], lay.yield_kwh, cells.yield_kwh.clone());
    }
    stats
}

// --------------------------------------------------------------------------- Sheets API

/// Python `col_letter`: 1 → A, 27 → AA
pub fn col_letter(mut n: usize) -> String {
    let mut s = String::new();
    while n > 0 {
        let r = (n - 1) % 26;
        n = (n - 1) / 26;
        s.insert(0, (b'A' + r as u8) as char);
    }
    s
}

/// A failed fill: Python's exception class and message (jobs `_pwa_sheet` reports
/// `"{class}: {message}"`).
#[derive(Debug, Clone, thiserror::Error)]
#[error("{kind}: {message}")]
pub struct SheetFillError {
    pub kind: String,
    pub message: String,
}

impl From<SheetsError> for SheetFillError {
    fn from(e: SheetsError) -> Self {
        SheetFillError { kind: e.kind, message: e.message }
    }
}

impl From<sqlx::Error> for SheetFillError {
    fn from(e: sqlx::Error) -> Self {
        SheetFillError { kind: "DatabaseError".into(), message: e.to_string() }
    }
}

fn value_error(m: String) -> SheetFillError {
    SheetFillError { kind: "ValueError".into(), message: m }
}

/// Python `DAY_TAB`: `^\d{2}\.\d{2}`
fn is_day_tab(t: &str) -> bool {
    let b = t.as_bytes();
    b.len() >= 5 && b[0].is_ascii_digit() && b[1].is_ascii_digit() && b[2] == b'.' && b[3].is_ascii_digit() && b[4].is_ascii_digit()
}

/// Python `ensure_day_sheet`: creates the DD.MM tab as a copy of the newest DD.MM tab with its
/// check columns cleared; true when it was created.
pub async fn ensure_day_sheet(client: &SheetsClient, day: NaiveDate) -> Result<bool, SheetFillError> {
    let name = sheet_name(day);
    let tabs = client.sheets().await?;
    if tabs.iter().any(|t| t.title == name) {
        return Ok(false);
    }
    let tpl = tabs.iter().rfind(|t| is_day_tab(&t.title)).ok_or_else(|| value_error("No DD.MM template sheet to copy".into()))?;
    client.duplicate(tpl.sheet_id, &name, tabs.len() as i64).await?;
    let rows = client.values(&name).await?;
    let lay = layout(&rows, &name).map_err(value_error)?;
    if rows.len() >= FIRST_ROW {
        client.clear(&a1(&name, &format!("{}{FIRST_ROW}:{}{}", col_letter(lay.first), col_letter(lay.last), rows.len()))).await?;
    }
    Ok(true)
}

/// An ordered detail (Python dict): JSON for the run detail and `repr` for the log line.
#[derive(Default)]
struct Ordered(Vec<(String, Value)>);

impl Ordered {
    fn set(&mut self, k: &str, v: Value) {
        match self.0.iter_mut().find(|(key, _)| key == k) {
            Some(e) => e.1 = v,
            None => self.0.push((k.to_owned(), v)),
        }
    }
    fn json(&self) -> Value {
        Value::Object(self.0.iter().cloned().collect())
    }
    fn repr(&self) -> String {
        format!("{{{}}}", self.0.iter().map(|(k, v)| format!("{}: {}", str_repr(k), py_repr(v))).collect::<Vec<_>>().join(", "))
    }
}

/// Python `fill_day`: fills `day`'s tab (created if missing) for the checks in `hours` (None = all).
pub async fn fill_day(pool: &PgPool, cfg: &PwaSheetConfig, day: NaiveDate, hours: Option<&[u32]>) -> Result<Value, SheetFillError> {
    let client = SheetsClient::new(&cfg.sheet_id, &cfg.sheets_api, &cfg.credentials_file);
    let created = ensure_day_sheet(&client, day).await?;
    let name = sheet_name(day);
    let mut out = Ordered::default();
    out.set("sheet", json!(name));
    out.set("created", json!(created));
    out.set("hours", json!(hours.map(<[u32]>::to_vec).unwrap_or_else(|| CHECK_HOURS.to_vec())));
    if hours.is_some_and(<[u32]>::is_empty) {
        return Ok(out.json());
    }
    // straight from Firestore: the worker fills right after publishing
    let data = pwa_report::build(pool, &cfg.firestore, day).await?;
    if data.days.is_empty() {
        out.set("skipped", json!(format!("no published data for {day}")));
        return Ok(out.json());
    }
    let mut rows = client.values(&name).await?;
    if rows.len() < FIRST_ROW {
        out.set("skipped", json!("no plant rows"));
        return Ok(out.json());
    }
    let lay = layout(&rows, &name).map_err(value_error)?;
    let before = rows.clone();
    let stats = fill_rows(day, &lay, &mut rows, &data, hours, &cfg.ignored_warn_codes);
    // only the cells this fill changed
    let mut cols: Vec<usize> = (lay.first..=lay.last).collect();
    if lay.firmware != 0 && !cols.contains(&lay.firmware) {
        cols.push(lay.firmware);
    }
    let mut changed: Vec<(String, Value)> = Vec::new();
    for i in FIRST_ROW - 1..rows.len() {
        for &c in &cols {
            let now = cell(&rows, i, c - 1);
            if !py_eq(&now, &cell(&before, i, c - 1)) {
                changed.push((a1(&name, &format!("{}{}", col_letter(c), i + 1)), now));
            }
        }
    }
    client.write_cells(&changed).await?;
    for (k, v) in stats.pairs() {
        out.set(k, v);
    }
    out.set("cells_written", json!(changed.len()));
    tracing::info!(target: "app.services.pwa_sheet", "PWA sheet {name}: {}", out.repr());
    Ok(out.json())
}

/// Python `run_for_now`: today's tab with the checks published so far (plant-local `now`); None
/// when PWA_SHEET_ID is not set. Errors propagate (see [`run_for_now_safe`]).
pub async fn run_for_now(pool: &PgPool, cfg: &PwaSheetConfig, now: NaiveDateTime) -> Result<Option<Value>, SheetFillError> {
    if cfg.sheet_id.is_empty() {
        return Ok(None);
    }
    let hours = published_hours(now, cfg.check_offset_min);
    fill_day(pool, cfg, now.date(), Some(&hours)).await.map(Some)
}

/// Python jobs.py `_pwa_sheet`: [`run_for_now`] with an error reported as `{"error": "Class:
/// message"}` (logged with its traceback text) instead of raised, so sheet trouble never undoes a
/// publish. `publish_today` calls this after publishing.
pub async fn run_for_now_safe(pool: &PgPool, cfg: &PwaSheetConfig, now: NaiveDateTime) -> Option<Value> {
    match run_for_now(pool, cfg, now).await {
        Ok(v) => v,
        Err(e) => {
            tracing::error!(target: "jobs", exc_text = %e, "PWA sheet fill failed");
            Some(json!({"error": e.to_string()}))
        }
    }
}

#[cfg(test)]
mod tests;
