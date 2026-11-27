//! Port of `backend/solar_core/growatt/parsers.py`: Growatt records → rows (inverter, string,
//! weather-sensor and meter records). Pure, no HTTP. Values are kept as Growatt reports them;
//! a missing or unreadable number is `None`, never a made-up value, except where Python itself
//! substitutes 0 (noted on the field).
//!
//! Times are naive plant-local (Bangkok) wall-clock times, as Growatt sends them.
//!
//! A record that is not a JSON object, or a `time` Python cannot parse, makes Python raise; the
//! port returns [`PyError`] in those places (the same records that break the Python job).

use std::collections::{BTreeSet, HashMap};
use std::hash::Hash;

use chrono::NaiveDateTime;
use serde::Serialize;
use serde_json::{Map, Value};

use super::py::{self, PyError, TimeFormat};

/// A JSON record (one element of a Growatt `datas` / `env_data` / `meter_data` list).
pub type Record = Map<String, Value>;

/// `ENV_FIELDS`: weather-sensor fields kept → column. `env_data` also returns ~20 other fields
/// (rain, pressure, …) this fleet's sensors are not fitted with; they are always 0 and dropped.
pub const ENV_FIELDS: [(&str, &str); 6] = [
    ("radiant", "irradiance_wm2"),
    ("envTemp", "ambient_temp_c"),
    ("panelTemp", "module_temp_c"),
    ("envHumidity", "humidity_pct"),
    ("windSpeed", "wind_speed_ms"),
    ("windAngle", "wind_dir_deg"),
];

/// `METER_FIELDS`: meter fields kept → column (CHNT_THREE at the grid connection point).
pub const METER_FIELDS: [(&str, &str); 11] = [
    ("activePower", "active_power_w"),
    ("activePowerL1", "active_power_l1_w"),
    ("activePowerL2", "active_power_l2_w"),
    ("activePowerL3", "active_power_l3_w"),
    ("reactivePower", "reactive_power_var"),
    ("powerFactor", "power_factor"),
    ("frequency", "frequency_hz"),
    ("posiActivePower", "import_counter_kwh"),
    ("positiveActiveTodayEnergy", "forward_today_kwh"),
    ("reverActivePower", "rever_active_power_raw"),
    ("reverseActiveTodayEnergy", "reverse_today_kwh"),
];

/// `MAX_GRID_FIELDS`: `max_data` grid-side fields, as reported (V, A, Hz; reactPower in var).
pub const MAX_GRID_FIELDS: [(&str, &str); 12] = [
    ("vacr", "v_r"),
    ("vacs", "v_s"),
    ("vact", "v_t"),
    ("vacRs", "v_rs"),
    ("vacSt", "v_st"),
    ("vacTr", "v_tr"),
    ("iacr", "i_r"),
    ("iacs", "i_s"),
    ("iact", "i_t"),
    ("pf", "pf"),
    ("reactPower", "reactive_var"),
    ("fac", "fac_hz"),
];

/// `PV_ISO_NO_READING`: Growatt reports PV insulation resistance 65530 when it has no reading.
pub const PV_ISO_NO_READING: f64 = 65530.0;

/// `RAW_SKIP_FIELDS`: left out of the raw copy (`calendar` repeats `time`; the other two are the
/// row's own key).
pub const RAW_SKIP_FIELDS: [&str; 3] = ["calendar", "serialNum", "time"];

// --------------------------------------------------------------------------- scalar helpers

/// Port of `parsers._f`: a number as float; `None`, `""` or anything `float()` refuses = `None`.
pub fn f(v: &Value) -> Option<f64> {
    match v {
        Value::Null => None,
        Value::String(s) if s.is_empty() => None,
        other => py::float(other),
    }
}

/// `_f(r.get(key))`.
fn fk(r: &Record, key: &str) -> Option<f64> {
    f(py::get(r, key))
}

/// Port of `parsers._text`: `str(v).strip()`, empty = `None`.
pub fn text(v: &Value) -> Option<String> {
    if v.is_null() {
        return None;
    }
    let s = py::str_of(v);
    let t = py::strip(&s);
    (!t.is_empty()).then(|| t.to_owned())
}

/// Port of `parsers._nonzero_int`: a Growatt code field as int; 0, empty or unreadable = `None`.
/// Infinity raises in Python (`OverflowError`, not caught there).
pub fn nonzero_int(v: &Value) -> Result<Option<i64>, PyError> {
    let x = match v {
        Value::Null | Value::Array(_) | Value::Object(_) => return Ok(None),
        other => match py::float(other) {
            Some(x) => x,
            None => return Ok(None),
        },
    };
    if x.is_nan() {
        return Ok(None);
    }
    let n = py::int_from_f64(x)?;
    Ok((n != 0).then_some(n))
}

/// Port of `parsers._env_time`: `timeText` (plant-local wall clock; the Java `calendar` block
/// next to it is an hour off and ignored).
pub fn env_time(r: &Record) -> Option<NaiveDateTime> {
    py::strptime(&py::str_of(py::get(r, "timeText")), TimeFormat::Seconds)
}

/// Port of `parsers._record_time`: `time` of a `max_data` record.
pub fn record_time(r: &Record) -> Option<NaiveDateTime> {
    py::strptime(&py::str_of(py::get(r, "time")), TimeFormat::Seconds)
}

/// Port of `parsers._round_h`: `timeTotal` seconds → hours, 1 decimal.
pub fn round_h(seconds: Option<f64>) -> Option<f64> {
    seconds.map(|s| py::round(s / 3600.0, 1))
}

/// `int(_f(r.get(k)))` or `None` (the `num` lambdas of `parse_max_diagnostics` / `parse_max_info`).
fn int_k(r: &Record, key: &str) -> Result<Option<i64>, PyError> {
    fk(r, key).map(py::int_from_f64).transpose()
}

/// `x or 0.0` in Python: `None` and 0 become 0.0 (NaN stays NaN). Python substitutes this 0
/// itself (`ppv`, MPPT and string values); the port keeps it for parity.
fn or_zero(x: Option<f64>) -> f64 {
    match x {
        Some(v) if v != 0.0 || v.is_nan() => v,
        _ => 0.0,
    }
}

/// Python truthiness of an optional float.
fn fl_truthy(x: Option<f64>) -> bool {
    x.is_some_and(|v| v != 0.0 || v.is_nan())
}

/// `{key: row}` in Python dict order: a repeated key keeps its first position, the last value.
struct OrderedRows<K, V> {
    index: HashMap<K, usize>,
    rows: Vec<V>,
}

impl<K: Eq + Hash, V> OrderedRows<K, V> {
    fn new() -> Self {
        Self {
            index: HashMap::new(),
            rows: Vec::new(),
        }
    }
    fn insert(&mut self, key: K, row: V) {
        match self.index.get(&key) {
            Some(&i) => self.rows[i] = row,
            None => {
                self.index.insert(key, self.rows.len());
                self.rows.push(row);
            }
        }
    }
}

fn records(records: &[Value]) -> Result<Vec<&Record>, PyError> {
    records.iter().map(py::as_dict).collect()
}

// --------------------------------------------------------------------------- weather sensors / meters

/// One `growatt_env_readings` row.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct EnvRow {
    pub datalogger_sn: String,
    pub address: i64,
    pub timestamp: NaiveDateTime,
    pub irradiance_wm2: Option<f64>,
    pub ambient_temp_c: Option<f64>,
    pub module_temp_c: Option<f64>,
    pub humidity_pct: Option<f64>,
    pub wind_speed_ms: Option<f64>,
    pub wind_dir_deg: Option<f64>,
}

/// Port of `parsers.parse_env_records`: `env_data` records → `growatt_env_readings` rows, one per
/// timestamp (a later record of the same time wins), values as reported (an unfitted probe
/// reads 0; readers turn that into null per day). Records without a readable `timeText` are
/// skipped.
pub fn parse_env_records(
    datalogger_sn: &str,
    address: i64,
    recs: &[Value],
) -> Result<Vec<EnvRow>, PyError> {
    let mut rows = OrderedRows::new();
    for r in records(recs)? {
        let Some(ts) = env_time(r) else { continue };
        rows.insert(
            ts,
            EnvRow {
                datalogger_sn: datalogger_sn.to_owned(),
                address,
                timestamp: ts,
                irradiance_wm2: fk(r, "radiant"),
                ambient_temp_c: fk(r, "envTemp"),
                module_temp_c: fk(r, "panelTemp"),
                humidity_pct: fk(r, "envHumidity"),
                wind_speed_ms: fk(r, "windSpeed"),
                wind_dir_deg: fk(r, "windAngle"),
            },
        );
    }
    Ok(rows.rows)
}

/// One `growatt_meter_readings` row (Growatt's own meanings: `activePower` signed grid power,
/// + import / − export; `posiActivePower` the import counter).
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct MeterRow {
    pub datalogger_sn: String,
    pub address: i64,
    pub timestamp: NaiveDateTime,
    pub active_power_w: Option<f64>,
    pub active_power_l1_w: Option<f64>,
    pub active_power_l2_w: Option<f64>,
    pub active_power_l3_w: Option<f64>,
    pub reactive_power_var: Option<f64>,
    pub power_factor: Option<f64>,
    pub frequency_hz: Option<f64>,
    pub import_counter_kwh: Option<f64>,
    pub forward_today_kwh: Option<f64>,
    pub rever_active_power_raw: Option<f64>,
    pub reverse_today_kwh: Option<f64>,
}

/// Port of `parsers.parse_meter_records`: `meter_data` records → `growatt_meter_readings` rows,
/// one per timestamp, values as reported.
pub fn parse_meter_records(
    datalogger_sn: &str,
    address: i64,
    recs: &[Value],
) -> Result<Vec<MeterRow>, PyError> {
    let mut rows = OrderedRows::new();
    for r in records(recs)? {
        let Some(ts) = env_time(r) else { continue };
        rows.insert(
            ts,
            MeterRow {
                datalogger_sn: datalogger_sn.to_owned(),
                address,
                timestamp: ts,
                active_power_w: fk(r, "activePower"),
                active_power_l1_w: fk(r, "activePowerL1"),
                active_power_l2_w: fk(r, "activePowerL2"),
                active_power_l3_w: fk(r, "activePowerL3"),
                reactive_power_var: fk(r, "reactivePower"),
                power_factor: fk(r, "powerFactor"),
                frequency_hz: fk(r, "frequency"),
                import_counter_kwh: fk(r, "posiActivePower"),
                forward_today_kwh: fk(r, "positiveActiveTodayEnergy"),
                rever_active_power_raw: fk(r, "reverActivePower"),
                reverse_today_kwh: fk(r, "reverseActiveTodayEnergy"),
            },
        );
    }
    Ok(rows.rows)
}

// --------------------------------------------------------------------------- MAX inverters

/// Registry fields of one MAX inverter (`max_data_info` / `queryDeviceInfo`). The settings are
/// configured values, not measurements.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct MaxInfo {
    pub alias: Option<String>,
    /// 0 = not reported → `None`
    pub nominal_power_w: Option<f64>,
    pub fw_version: Option<String>,
    pub inner_version: Option<String>,
    /// active power limit, % of rated; < 100 = curtailed
    pub active_rate_pct: Option<f64>,
    pub reactive_rate_pct: Option<f64>,
    pub pf_setting: Option<f64>,
    /// Growatt PF mode code
    pub pf_model: Option<i64>,
    /// export limitation flag / mode as reported
    pub export_limit: Option<i64>,
    pub export_limit_rate_pct: Option<f64>,
    /// 1 = on, 0 = switched off
    pub on_off: Option<i64>,
}

/// Port of `parsers.parse_max_info`: `max_data_info` → registry fields; blanks become `None`.
/// A settings block with `activeRate` and `pf` both 0 (or missing) is the OpenAPI's "not read"
/// answer and is stored as unknown, never as 0 % / off.
pub fn parse_max_info(m: &Record) -> Result<MaxInfo, PyError> {
    let txt = |k: &str| -> Option<String> {
        let v = py::get(m, k);
        if v.is_null() || v.as_str() == Some("") {
            return None;
        }
        let s = py::str_of(v);
        let t = py::strip(&s);
        (!t.is_empty()).then(|| t.to_owned())
    };
    let power = fk(m, "normalPower");
    let mut active = fk(m, "activeRate");
    let mut reactive = fk(m, "reactiveRate");
    let mut pf = fk(m, "pf");
    let mut pf_model = int_k(m, "pfModel")?;
    let mut export_limit = int_k(m, "exportLimit")?;
    let mut export_rate = fk(m, "exportLimitPowerRate");
    let mut on_off = int_k(m, "onOff")?;
    if !fl_truthy(active) && !fl_truthy(pf) {
        active = None;
        reactive = None;
        pf = None;
        pf_model = None;
        export_limit = None;
        export_rate = None;
        on_off = None;
    }
    Ok(MaxInfo {
        alias: txt("alias"),
        nominal_power_w: power.filter(|p| *p != 0.0 || p.is_nan()),
        fw_version: txt("fwVersion"),
        inner_version: txt("innerVersion"),
        active_rate_pct: active,
        reactive_rate_pct: reactive,
        pf_setting: pf,
        pf_model,
        export_limit,
        export_limit_rate_pct: export_rate,
        on_off,
    })
}

/// Grid-side values of one `max_data` record (`MAX_GRID_FIELDS`).
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct MaxGrid {
    pub v_r: Option<f64>,
    pub v_s: Option<f64>,
    pub v_t: Option<f64>,
    pub v_rs: Option<f64>,
    pub v_st: Option<f64>,
    pub v_tr: Option<f64>,
    pub i_r: Option<f64>,
    pub i_s: Option<f64>,
    pub i_t: Option<f64>,
    pub pf: Option<f64>,
    pub reactive_var: Option<f64>,
    pub fac_hz: Option<f64>,
}

/// Port of `parsers.parse_max_grid`: grid-side values of one `max_data` record.
pub fn parse_max_grid(r: &Record) -> MaxGrid {
    MaxGrid {
        v_r: fk(r, "vacr"),
        v_s: fk(r, "vacs"),
        v_t: fk(r, "vact"),
        v_rs: fk(r, "vacRs"),
        v_st: fk(r, "vacSt"),
        v_tr: fk(r, "vacTr"),
        i_r: fk(r, "iacr"),
        i_s: fk(r, "iacs"),
        i_t: fk(r, "iact"),
        pf: fk(r, "pf"),
        reactive_var: fk(r, "reactPower"),
        fac_hz: fk(r, "fac"),
    }
}

/// Fault / warning codes, safety values and internal temperatures of one `max_data` record.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct MaxDiagnostics {
    pub fault_type: Option<i64>,
    pub fault_code1: Option<i64>,
    pub fault_code2: Option<i64>,
    pub fault_value: Option<i64>,
    pub warn_code: Option<i64>,
    pub warning_values: [Option<i64>; 3],
    pub pid_fault_code: Option<i64>,
    /// Growatt's string-break bit field (0 = none)
    pub str_break: Option<i64>,
    /// `None` when Growatt has no reading (65530 or above)
    pub pv_iso_kohm: Option<f64>,
    pub afci_status: Option<i64>,
    pub afci_pv: [Option<i64>; 2],
    pub gfci: Option<f64>,
    pub dci: [Option<f64>; 3],
    pub time_total_h: Option<f64>,
    /// AMTemp1 of Growatt's history export
    pub temperature_c: Option<f64>,
    /// `temperature2` = INVTemp (key name kept from an early guess)
    pub ipm_temperature_c: Option<f64>,
    /// `temperature3` = BTTemp
    pub boost_temperature_c: Option<f64>,
}

/// Port of `parsers.parse_max_diagnostics`: codes (0 = none) and temperatures as reported.
pub fn parse_max_diagnostics(r: &Record) -> Result<MaxDiagnostics, PyError> {
    let iso = fk(r, "pvIso");
    Ok(MaxDiagnostics {
        fault_type: int_k(r, "faultType")?,
        fault_code1: int_k(r, "faultCode1")?,
        fault_code2: int_k(r, "faultCode2")?,
        fault_value: int_k(r, "faultValue")?,
        warn_code: int_k(r, "warnCode1")?,
        warning_values: [
            int_k(r, "warningValue1")?,
            int_k(r, "warningValue2")?,
            int_k(r, "warningValue3")?,
        ],
        pid_fault_code: int_k(r, "pidFaultCode")?,
        str_break: int_k(r, "StrBreak")?,
        // NaN >= 65530 is false in Python too, so a NaN reading is kept
        pv_iso_kohm: iso.filter(|v| v.is_nan() || *v < PV_ISO_NO_READING),
        afci_status: int_k(r, "afciStatus")?,
        afci_pv: [int_k(r, "afciPv1")?, int_k(r, "afciPv2")?],
        gfci: fk(r, "gfci"),
        dci: [fk(r, "rDci"), fk(r, "sDci"), fk(r, "tDci")],
        time_total_h: round_h(fk(r, "timeTotal")),
        temperature_c: fk(r, "temperature"),
        ipm_temperature_c: fk(r, "temperature2"),
        boost_temperature_c: fk(r, "temperature3"),
    })
}

/// Today's and lifetime DC energy of one PV input, kWh.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct MpptEnergy {
    pub mppt: u32,
    pub today_kwh: Option<f64>,
    pub total_kwh: Option<f64>,
}

/// Port of `parsers.parse_max_mppt_energy`: `epv{n}Today` / `epv{n}Total` per PV input
/// (default 16); inputs with neither value non-zero are left out.
pub fn parse_max_mppt_energy(r: &Record, max_mppts: u32) -> Vec<MpptEnergy> {
    (1..=max_mppts)
        .filter_map(|n| {
            let today = fk(r, &format!("epv{n}Today"));
            let total = fk(r, &format!("epv{n}Total"));
            (fl_truthy(today) || fl_truthy(total)).then_some(MpptEnergy {
                mppt: n,
                today_kwh: today,
                total_kwh: total,
            })
        })
        .collect()
}

/// One `growatt_inverter_raw` row: every field of the record as reported, minus
/// [`RAW_SKIP_FIELDS`].
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct RawRow {
    pub device_sn: String,
    pub timestamp: NaiveDateTime,
    pub data: Map<String, Value>,
}

/// `datetime.strptime(r["time"], ...)` where Python does not catch the error: a non-string
/// `time` is a `TypeError`, an unreadable one a `ValueError`.
fn strict_time(t: &Value) -> Result<NaiveDateTime, PyError> {
    match t {
        Value::String(s) => py::strptime(s, TimeFormat::Seconds).ok_or_else(|| {
            PyError(format!(
                "ValueError: time data {} does not match format '%Y-%m-%d %H:%M:%S'",
                py::repr_str(s)
            ))
        }),
        other => Err(PyError(format!(
            "TypeError: strptime() argument 1 must be str, not {}",
            py::type_name(other)
        ))),
    }
}

/// Port of `parsers.parse_max_raw`: `max_data` records → `growatt_inverter_raw` rows, one per
/// timestamp; records without a `time` are skipped.
pub fn parse_max_raw(device_sn: &str, recs: &[Value]) -> Result<Vec<RawRow>, PyError> {
    let mut rows = OrderedRows::new();
    for r in records(recs)? {
        let t = py::get(r, "time");
        if !py::truthy(t) {
            continue;
        }
        let ts = strict_time(t)?;
        let data = r
            .iter()
            .filter(|(k, _)| !RAW_SKIP_FIELDS.contains(&k.as_str()))
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect();
        rows.insert(
            ts,
            RawRow {
                device_sn: device_sn.to_owned(),
                timestamp: ts,
                data,
            },
        );
    }
    Ok(rows.rows)
}

/// One MPPT entry of `mppt_json`.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct MpptPoint {
    pub mppt: u32,
    pub v: f64,
    pub i: f64,
    pub p: f64,
}

/// One `growatt_inverter_readings` row.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct InverterRow {
    pub device_sn: String,
    pub timestamp: NaiveDateTime,
    /// `status` exactly as reported (normally 0 / 1 / 3)
    pub status: Value,
    pub pac_w: Option<f64>,
    /// `ppv`; Python writes 0.0 when it is missing or unreadable
    pub ppv_w: f64,
    pub eac_today_kwh: Option<f64>,
    pub eac_total_kwh: Option<f64>,
    pub temperature_c: Option<f64>,
    pub fac_hz: Option<f64>,
    /// MPPTs with any non-zero V / I / P (missing values written as 0, as Python does)
    pub mppt_json: Vec<MpptPoint>,
    /// the record's own fault code (`faultType`), 0 = `None`
    pub fault_code: Option<i64>,
    /// the record's own warning code (`warnCode`), 0 = `None`
    pub warn_code: Option<i64>,
}

/// One per-string row (`growatt_string_records` entry).
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct StringRow {
    pub device_sn: String,
    pub timestamp: NaiveDateTime,
    pub string_no: u32,
    /// string n sits on MPPT ⌈n/2⌉
    pub mppt_no: u32,
    /// the MPPT voltage (`vString`); missing = 0 as in Python
    pub voltage_v: f64,
    /// per string (`currentString`); missing = 0 as in Python
    pub current_a: f64,
    pub power_w: f64,
}

/// Port of `parsers.parse_max_records` (defaults: 32 strings, 16 MPPTs): split `max_data` records
/// into inverter rows and per-string rows. String rows only while the inverter produces
/// (`ppv > 0`: at night PID recovery holds ~60 V on idle strings), and only for inputs that
/// report voltage or current somewhere in the batch.
pub fn parse_max_records(
    device_sn: &str,
    recs: &[Value],
    max_strings: u32,
    max_mppts: u32,
) -> Result<(Vec<InverterRow>, Vec<StringRow>), PyError> {
    let recs = records(recs)?;
    let mut inv_rows = OrderedRows::new();
    let mut str_rows = OrderedRows::new();
    let mut active = BTreeSet::new();
    for r in &recs {
        for n in 1..=max_strings {
            if or_zero(fk(r, &format!("vString{n}"))) > 0.0
                || or_zero(fk(r, &format!("currentString{n}"))) > 0.0
            {
                active.insert(n);
            }
        }
    }
    for r in &recs {
        let t = py::get(r, "time");
        if !py::truthy(t) {
            continue;
        }
        let ts = strict_time(t)?;
        let ppv = or_zero(fk(r, "ppv"));
        let mut mppts = Vec::new();
        for n in 1..=max_mppts {
            let v = or_zero(fk(r, &format!("vpv{n}")));
            let i = or_zero(fk(r, &format!("ipv{n}")));
            let p = or_zero(fk(r, &format!("ppv{n}")));
            if v != 0.0 || i != 0.0 || p != 0.0 {
                mppts.push(MpptPoint {
                    mppt: n,
                    v: py::round(v, 2),
                    i: py::round(i, 2),
                    p: py::round(p, 1),
                });
            }
        }
        inv_rows.insert(
            ts,
            InverterRow {
                device_sn: device_sn.to_owned(),
                timestamp: ts,
                status: py::get(r, "status").clone(),
                pac_w: fk(r, "pac"),
                ppv_w: ppv,
                eac_today_kwh: fk(r, "eacToday"),
                eac_total_kwh: fk(r, "eacTotal"),
                temperature_c: fk(r, "temperature"),
                fac_hz: fk(r, "fac"),
                mppt_json: mppts,
                fault_code: nonzero_int(py::get(r, "faultType"))?,
                warn_code: nonzero_int(py::get(r, "warnCode"))?,
            },
        );
        // `if ppv <= 0: continue` (NaN passes, as in Python)
        if ppv <= 0.0 {
            continue;
        }
        for &n in &active {
            let v = or_zero(fk(r, &format!("vString{n}")));
            let i = or_zero(fk(r, &format!("currentString{n}")));
            str_rows.insert(
                (ts, n),
                StringRow {
                    device_sn: device_sn.to_owned(),
                    timestamp: ts,
                    string_no: n,
                    mppt_no: n.div_ceil(2),
                    voltage_v: py::round(v, 2),
                    current_a: py::round(i, 3),
                    power_w: py::round(v * i, 1),
                },
            );
        }
    }
    Ok((inv_rows.rows, str_rows.rows))
}
