//! Python semantics the Growatt code relies on, so the port answers exactly what
//! `backend/solar_core/growatt/` answers for the same Growatt reply: `float()`, `int()`,
//! `str()` / `repr()`, truthiness, `round()`, `str.strip()` / `str.split()`, `datetime.strptime`
//! for the two formats Growatt times use, and `date.fromisoformat`.
//!
//! Public only so the parity tests (`tests/growatt_parity.rs`) can check each helper against
//! the Python fixtures; callers should use the client and parsers instead.
//!
//! Known gaps (none seen in Growatt replies): Python's `\d` and `int()` / `float()` accept
//! non-ASCII decimal digits, this port only ASCII; `str.isprintable` (used by `repr` of text) is
//! approximated for unassigned code points; integers beyond 64 bits arrive as floats.

use std::fmt;

use chrono::{NaiveDate, NaiveDateTime, Weekday};
use serde::de::{self, Deserialize, Deserializer, MapAccess, SeqAccess, Visitor};
use serde_json::{Map, Number, Value};

// --------------------------------------------------------------------------- an order-keeping JSON value

/// A JSON value as Python's `json.loads` builds it: objects keep their key order (and a repeated
/// key keeps its first position with its last value). `serde_json::Value` sorts object keys in
/// this workspace (no `preserve_order` feature), and the order shows in Growatt error texts
/// (`repr` of the reply), so replies are read into this first.
#[derive(Debug, Clone, PartialEq)]
pub enum PyValue {
    /// `None`
    Null,
    /// `bool`
    Bool(bool),
    /// `int` (signed range)
    Int(i64),
    /// `int` above `i64::MAX`
    UInt(u64),
    /// `float`
    Float(f64),
    /// `str`
    Str(String),
    /// `list`
    List(Vec<PyValue>),
    /// `dict`, in insertion order
    Dict(Vec<(String, PyValue)>),
}

impl PyValue {
    /// `dict.get(key)` on a dict value; `None` when this is not a dict or has no such key.
    pub fn get(&self, key: &str) -> Option<&PyValue> {
        match self {
            PyValue::Dict(items) => items.iter().find(|(k, _)| k == key).map(|(_, v)| v),
            _ => None,
        }
    }
}

impl<'de> Deserialize<'de> for PyValue {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        struct V;
        impl<'de> Visitor<'de> for V {
            type Value = PyValue;
            fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
                f.write_str("any JSON value")
            }
            fn visit_bool<E>(self, v: bool) -> Result<PyValue, E> {
                Ok(PyValue::Bool(v))
            }
            fn visit_i64<E>(self, v: i64) -> Result<PyValue, E> {
                Ok(PyValue::Int(v))
            }
            fn visit_u64<E>(self, v: u64) -> Result<PyValue, E> {
                Ok(i64::try_from(v).map_or(PyValue::UInt(v), PyValue::Int))
            }
            fn visit_f64<E>(self, v: f64) -> Result<PyValue, E> {
                Ok(PyValue::Float(v))
            }
            fn visit_str<E: de::Error>(self, v: &str) -> Result<PyValue, E> {
                Ok(PyValue::Str(v.to_owned()))
            }
            fn visit_string<E: de::Error>(self, v: String) -> Result<PyValue, E> {
                Ok(PyValue::Str(v))
            }
            fn visit_unit<E>(self) -> Result<PyValue, E> {
                Ok(PyValue::Null)
            }
            fn visit_none<E>(self) -> Result<PyValue, E> {
                Ok(PyValue::Null)
            }
            fn visit_some<D2: Deserializer<'de>>(self, d: D2) -> Result<PyValue, D2::Error> {
                PyValue::deserialize(d)
            }
            fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<PyValue, A::Error> {
                let mut out = Vec::new();
                while let Some(v) = seq.next_element()? {
                    out.push(v);
                }
                Ok(PyValue::List(out))
            }
            fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<PyValue, A::Error> {
                let mut out: Vec<(String, PyValue)> = Vec::new();
                while let Some((k, v)) = map.next_entry::<String, PyValue>()? {
                    match out.iter_mut().find(|(ok, _)| *ok == k) {
                        Some(slot) => slot.1 = v,
                        None => out.push((k, v)),
                    }
                }
                Ok(PyValue::Dict(out))
            }
        }
        d.deserialize_any(V)
    }
}

impl From<&Value> for PyValue {
    fn from(v: &Value) -> Self {
        match v {
            Value::Null => PyValue::Null,
            Value::Bool(b) => PyValue::Bool(*b),
            Value::Number(n) => {
                if let Some(i) = n.as_i64() {
                    PyValue::Int(i)
                } else if let Some(u) = n.as_u64() {
                    PyValue::UInt(u)
                } else {
                    PyValue::Float(n.as_f64().unwrap_or(f64::NAN))
                }
            }
            Value::String(s) => PyValue::Str(s.clone()),
            Value::Array(a) => PyValue::List(a.iter().map(PyValue::from).collect()),
            Value::Object(m) => PyValue::Dict(
                m.iter()
                    .map(|(k, v)| (k.clone(), PyValue::from(v)))
                    .collect(),
            ),
        }
    }
}

impl From<&PyValue> for Value {
    fn from(v: &PyValue) -> Self {
        match v {
            PyValue::Null => Value::Null,
            PyValue::Bool(b) => Value::Bool(*b),
            PyValue::Int(i) => Value::Number((*i).into()),
            PyValue::UInt(u) => Value::Number((*u).into()),
            PyValue::Float(f) => Number::from_f64(*f).map_or(Value::Null, Value::Number),
            PyValue::Str(s) => Value::String(s.clone()),
            PyValue::List(a) => Value::Array(a.iter().map(Value::from).collect()),
            PyValue::Dict(items) => {
                let mut m = Map::new();
                for (k, v) in items {
                    m.insert(k.clone(), Value::from(v));
                }
                Value::Object(m)
            }
        }
    }
}

// --------------------------------------------------------------------------- errors Python would raise

/// An exception Python raises (and the Growatt code does not catch) on a reply of an unexpected
/// shape: `AttributeError`, `TypeError`, `ValueError`, `OverflowError`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PyError(pub String);

impl fmt::Display for PyError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for PyError {}

/// Python's type name of a JSON value (`type(v).__name__`).
pub fn type_name(v: &Value) -> &'static str {
    match v {
        Value::Null => "NoneType",
        Value::Bool(_) => "bool",
        Value::Number(n) if n.is_f64() => "float",
        Value::Number(_) => "int",
        Value::String(_) => "str",
        Value::Array(_) => "list",
        Value::Object(_) => "dict",
    }
}

/// `v.get(...)` on a value that must be a dict: anything else is Python's `AttributeError`.
pub fn as_dict(v: &Value) -> Result<&Map<String, Value>, PyError> {
    v.as_object().ok_or_else(|| {
        PyError(format!(
            "AttributeError: '{}' object has no attribute 'get'",
            type_name(v)
        ))
    })
}

/// `d.get(key)`: a missing key is `None` (`Value::Null`).
pub fn get<'a>(d: &'a Map<String, Value>, key: &str) -> &'a Value {
    static NULL: Value = Value::Null;
    d.get(key).unwrap_or(&NULL)
}

/// `x or {}` followed by `.get(...)`: a falsy value is an empty dict, a dict is itself, anything
/// else raises `AttributeError` at the `.get`.
pub fn or_dict(v: &Value) -> Result<Map<String, Value>, PyError> {
    if !truthy(v) {
        return Ok(Map::new());
    }
    as_dict(v).cloned()
}

/// `x if isinstance(x, dict) else {}`.
pub fn dict_or_empty(v: &Value) -> Map<String, Value> {
    v.as_object().cloned().unwrap_or_default()
}

/// `x or []` followed by iterating it: a falsy value is empty, a list its items, a dict its keys,
/// a string its characters; a number (or `True`) raises `TypeError` (not iterable).
pub fn or_list(v: &Value) -> Result<Vec<Value>, PyError> {
    if !truthy(v) {
        return Ok(Vec::new());
    }
    match v {
        Value::Array(a) => Ok(a.clone()),
        Value::Object(m) => Ok(m.keys().map(|k| Value::String(k.clone())).collect()),
        Value::String(s) => Ok(s.chars().map(|c| Value::String(c.to_string())).collect()),
        other => Err(PyError(format!(
            "TypeError: '{}' object is not iterable",
            type_name(other)
        ))),
    }
}

// --------------------------------------------------------------------------- truthiness, float(), int()

/// Python truthiness (`bool(v)`): `None`, `False`, `0`, `0.0`, `""`, `[]`, `{}` are false;
/// NaN and the string `"false"` are true.
pub fn truthy(v: &Value) -> bool {
    match v {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => {
            n.as_f64().is_some_and(|f| f != 0.0) || n.as_f64().is_some_and(f64::is_nan)
        }
        Value::String(s) => !s.is_empty(),
        Value::Array(a) => !a.is_empty(),
        Value::Object(m) => !m.is_empty(),
    }
}

/// [`truthy`] for an order-keeping value.
pub fn py_truthy(v: &PyValue) -> bool {
    match v {
        PyValue::Null => false,
        PyValue::Bool(b) => *b,
        PyValue::Int(i) => *i != 0,
        PyValue::UInt(u) => *u != 0,
        PyValue::Float(f) => *f != 0.0 || f.is_nan(),
        PyValue::Str(s) => !s.is_empty(),
        PyValue::List(a) => !a.is_empty(),
        PyValue::Dict(d) => !d.is_empty(),
    }
}

/// `str.isspace()` for one character (Unicode whitespace plus the separators U+001C–U+001F).
pub fn is_space(c: char) -> bool {
    c.is_whitespace() || ('\u{1c}'..='\u{1f}').contains(&c)
}

/// `str.strip()`.
pub fn strip(s: &str) -> &str {
    s.trim_matches(is_space)
}

/// `float(s)` for a string: whitespace around it is ignored, `_` is allowed between digits,
/// `inf` / `infinity` / `nan` in any case with an optional sign; `None` = `ValueError`.
pub fn float_from_str(s: &str) -> Option<f64> {
    let t = strip(s);
    if t.is_empty() {
        return None;
    }
    let (sign, body) = match t.as_bytes()[0] {
        b'+' => (1.0, &t[1..]),
        b'-' => (-1.0, &t[1..]),
        _ => (1.0, t),
    };
    let lower = body.to_ascii_lowercase();
    if lower == "inf" || lower == "infinity" {
        return Some(sign * f64::INFINITY);
    }
    if lower == "nan" {
        return Some(f64::NAN);
    }
    // underscores only between two digits
    let chars: Vec<char> = body.chars().collect();
    let mut clean = String::with_capacity(chars.len());
    for (i, &c) in chars.iter().enumerate() {
        if c == '_' {
            let ok = i > 0
                && i + 1 < chars.len()
                && chars[i - 1].is_ascii_digit()
                && chars[i + 1].is_ascii_digit();
            if !ok {
                return None;
            }
            continue;
        }
        clean.push(c);
    }
    // decimal grammar: digits [. digits] | . digits, then [e [sign] digits]
    let b = clean.as_bytes();
    let mut i = 0;
    let int_start = i;
    while i < b.len() && b[i].is_ascii_digit() {
        i += 1;
    }
    let int_digits = i - int_start;
    let mut frac_digits = 0;
    if i < b.len() && b[i] == b'.' {
        i += 1;
        let fs = i;
        while i < b.len() && b[i].is_ascii_digit() {
            i += 1;
        }
        frac_digits = i - fs;
    }
    if int_digits + frac_digits == 0 {
        return None;
    }
    if i < b.len() && (b[i] == b'e' || b[i] == b'E') {
        i += 1;
        if i < b.len() && (b[i] == b'+' || b[i] == b'-') {
            i += 1;
        }
        let es = i;
        while i < b.len() && b[i].is_ascii_digit() {
            i += 1;
        }
        if i == es {
            return None;
        }
    }
    if i != b.len() {
        return None;
    }
    clean.parse::<f64>().ok().map(|f| sign * f)
}

/// `float(v)`: numbers and booleans convert, strings parse ([`float_from_str`]); `None` for the
/// `TypeError` / `ValueError` cases.
pub fn float(v: &Value) -> Option<f64> {
    match v {
        Value::Bool(b) => Some(if *b { 1.0 } else { 0.0 }),
        Value::Number(n) => n.as_f64(),
        Value::String(s) => float_from_str(s),
        _ => None,
    }
}

/// `int(f)` for a float: truncates towards zero; infinity raises `OverflowError`, NaN `ValueError`.
pub fn int_from_f64(f: f64) -> Result<i64, PyError> {
    if f.is_nan() {
        return Err(PyError(
            "ValueError: cannot convert float NaN to integer".into(),
        ));
    }
    if f.is_infinite() {
        return Err(PyError(
            "OverflowError: cannot convert float infinity to integer".into(),
        ));
    }
    let t = f.trunc();
    if t >= 9.223_372_036_854_776e18 || t < -9.223_372_036_854_776e18 {
        return Err(PyError("OverflowError: integer beyond 64 bits".into()));
    }
    Ok(t as i64)
}

/// `int(v)`: an int is itself, a float truncates, a bool is 0 / 1, a string must be an integer
/// literal (whitespace around it, a sign, `_` between digits); anything else raises.
pub fn int(v: &Value) -> Result<i64, PyError> {
    match v {
        Value::Bool(b) => Ok(i64::from(*b)),
        Value::Number(n) => {
            if let Some(i) = n.as_i64() {
                Ok(i)
            } else if n.as_u64().is_some() {
                Err(PyError("OverflowError: integer beyond 64 bits".into()))
            } else {
                int_from_f64(n.as_f64().unwrap_or(f64::NAN))
            }
        }
        Value::String(s) => {
            let t = strip(s);
            let (neg, body) = match t.as_bytes().first() {
                Some(b'+') => (false, &t[1..]),
                Some(b'-') => (true, &t[1..]),
                _ => (false, t),
            };
            let bad = || PyError(format!("ValueError: invalid literal for int() with base 10: {}", repr_str(s)));
            let b = body.as_bytes();
            if b.is_empty() || !b[0].is_ascii_digit() || !b[b.len() - 1].is_ascii_digit() {
                return Err(bad());
            }
            let mut digits = String::new();
            for (i, &c) in b.iter().enumerate() {
                if c == b'_' {
                    if !(b[i - 1].is_ascii_digit() && b[i + 1].is_ascii_digit()) {
                        return Err(bad());
                    }
                } else if c.is_ascii_digit() {
                    digits.push(c as char);
                } else {
                    return Err(bad());
                }
            }
            let n: i64 = digits.parse().map_err(|_| PyError("OverflowError: integer beyond 64 bits".into()))?;
            Ok(if neg { -n } else { n })
        }
        other => Err(PyError(format!(
            "TypeError: int() argument must be a string, a bytes-like object or a real number, not '{}'",
            type_name(other)
        ))),
    }
}

/// `round(x, n)` for a float: correctly rounded, ties to even on the exact binary value.
pub fn round(x: f64, n: usize) -> f64 {
    if !x.is_finite() {
        return x;
    }
    let s = format!("{x:.n$}");
    s.parse::<f64>().unwrap_or(x)
}

// --------------------------------------------------------------------------- str() / repr()

/// `repr(f)` for a float: the shortest round-trip text, exponent form below 1e-4 or from 1e16
/// (`1e+20`, `1e-05`), `inf`, `nan`.
pub fn repr_float(f: f64) -> String {
    if f.is_nan() {
        return "nan".into();
    }
    if f.is_infinite() {
        return if f > 0.0 { "inf".into() } else { "-inf".into() };
    }
    let s = format!("{f:?}");
    match s.split_once('e') {
        None => s,
        Some((mant, exp)) => {
            let (sign, digits) = match exp.strip_prefix('-') {
                Some(d) => ('-', d),
                None => ('+', exp),
            };
            let mant = mant.strip_suffix(".0").unwrap_or(mant);
            format!("{mant}e{sign}{digits:0>2}")
        }
    }
}

const FORMAT_CHARS: &[(u32, u32)] = &[
    (0x00AD, 0x00AD),
    (0x0600, 0x0605),
    (0x061C, 0x061C),
    (0x06DD, 0x06DD),
    (0x070F, 0x070F),
    (0x0890, 0x0891),
    (0x08E2, 0x08E2),
    (0x180E, 0x180E),
    (0x200B, 0x200F),
    (0x202A, 0x202E),
    (0x2060, 0x2064),
    (0x2066, 0x206F),
    (0xFEFF, 0xFEFF),
    (0xFFF9, 0xFFFB),
    (0x110BD, 0x110BD),
    (0x110CD, 0x110CD),
    (0x13430, 0x1343F),
    (0x1BCA0, 0x1BCA3),
    (0x1D173, 0x1D17A),
    (0xE0001, 0xE0001),
    (0xE0020, 0xE007F),
];

/// `str.isprintable()` for one character (approximated for unassigned code points).
pub fn is_printable(c: char) -> bool {
    if c == ' ' {
        return true;
    }
    if c.is_control() || is_space(c) {
        return false;
    }
    let u = c as u32;
    if FORMAT_CHARS.iter().any(|&(a, b)| (a..=b).contains(&u)) {
        return false;
    }
    // private use and non-characters
    if (0xE000..=0xF8FF).contains(&u)
        || u >= 0xF0000
        || (u & 0xFFFE) == 0xFFFE
        || (0xFDD0..=0xFDEF).contains(&u)
    {
        return false;
    }
    true
}

/// `repr(s)` for a string: single quotes unless the text has `'` and no `"`; `\\`, the quote,
/// `\t` `\n` `\r` and unprintable characters escaped.
pub fn repr_str(s: &str) -> String {
    let quote = if s.contains('\'') && !s.contains('"') {
        '"'
    } else {
        '\''
    };
    let mut out = String::with_capacity(s.len() + 2);
    out.push(quote);
    for c in s.chars() {
        match c {
            '\\' => out.push_str("\\\\"),
            '\t' => out.push_str("\\t"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            c if c == quote => {
                out.push('\\');
                out.push(c);
            }
            c if is_printable(c) => out.push(c),
            c => {
                let u = c as u32;
                if u <= 0xFF {
                    out.push_str(&format!("\\x{u:02x}"));
                } else if u <= 0xFFFF {
                    out.push_str(&format!("\\u{u:04x}"));
                } else {
                    out.push_str(&format!("\\U{u:08x}"));
                }
            }
        }
    }
    out.push(quote);
    out
}

/// `repr(v)`.
pub fn repr(v: &PyValue) -> String {
    match v {
        PyValue::Null => "None".into(),
        PyValue::Bool(true) => "True".into(),
        PyValue::Bool(false) => "False".into(),
        PyValue::Int(i) => i.to_string(),
        PyValue::UInt(u) => u.to_string(),
        PyValue::Float(f) => repr_float(*f),
        PyValue::Str(s) => repr_str(s),
        PyValue::List(a) => format!("[{}]", a.iter().map(repr).collect::<Vec<_>>().join(", ")),
        PyValue::Dict(items) => format!(
            "{{{}}}",
            items
                .iter()
                .map(|(k, v)| format!("{}: {}", repr_str(k), repr(v)))
                .collect::<Vec<_>>()
                .join(", ")
        ),
    }
}

/// `str(v)`: a string is itself, anything else its `repr`.
pub fn py_str(v: &PyValue) -> String {
    match v {
        PyValue::Str(s) => s.clone(),
        other => repr(other),
    }
}

/// [`py_str`] for a `serde_json::Value` (dict keys in this workspace's sorted order).
pub fn str_of(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        other => repr(&PyValue::from(other)),
    }
}

/// `s[:n]` (characters, not bytes).
pub fn head(s: &str, n: usize) -> &str {
    match s.char_indices().nth(n) {
        Some((i, _)) => &s[..i],
        None => s,
    }
}

// --------------------------------------------------------------------------- strptime / fromisoformat

/// The two `datetime.strptime` formats Growatt times are read with.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TimeFormat {
    /// `"%Y-%m-%d %H:%M:%S"` (`max_data` `time`, `env_data` / `meter_data` `timeText`, create dates)
    Seconds,
    /// `"%Y-%m-%d %H:%M"` (`plant/power` `time`)
    Minutes,
}

#[derive(Clone, Copy)]
enum Tok {
    Y,
    Mo,
    D,
    H,
    Mi,
    S,
    Lit(char),
    Space,
}

const FMT_S: &[Tok] = &[
    Tok::Y,
    Tok::Lit('-'),
    Tok::Mo,
    Tok::Lit('-'),
    Tok::D,
    Tok::Space,
    Tok::H,
    Tok::Lit(':'),
    Tok::Mi,
    Tok::Lit(':'),
    Tok::S,
];
const FMT_M: &[Tok] = &[
    Tok::Y,
    Tok::Lit('-'),
    Tok::Mo,
    Tok::Lit('-'),
    Tok::D,
    Tok::Space,
    Tok::H,
    Tok::Lit(':'),
    Tok::Mi,
];

fn dig(s: &[char], i: usize) -> Option<u32> {
    s.get(i)
        .filter(|c| c.is_ascii_digit())
        .and_then(|c| c.to_digit(10))
}

fn in_range(s: &[char], i: usize, lo: u32, hi: u32) -> Option<u32> {
    dig(s, i).filter(|d| (lo..=hi).contains(d))
}

/// Candidate (length, value) matches of one field at `i`, in the order of the regex
/// alternatives `_strptime` uses (Python 3.13).
fn field(tok: Tok, s: &[char], i: usize) -> Vec<(usize, u32)> {
    let mut out = Vec::new();
    let two = |a: Option<u32>, b: Option<u32>| a.zip(b).map(|(a, b)| a * 10 + b);
    match tok {
        Tok::Y => {
            if let (Some(a), Some(b), Some(c), Some(d)) =
                (dig(s, i), dig(s, i + 1), dig(s, i + 2), dig(s, i + 3))
            {
                out.push((4, a * 1000 + b * 100 + c * 10 + d));
            }
        }
        Tok::Mo => {
            // 1[0-2]|0[1-9]|[1-9]
            if let Some(v) = two(in_range(s, i, 1, 1), in_range(s, i + 1, 0, 2)) {
                out.push((2, v));
            }
            if let Some(v) = two(in_range(s, i, 0, 0), in_range(s, i + 1, 1, 9)) {
                out.push((2, v));
            }
            if let Some(v) = in_range(s, i, 1, 9) {
                out.push((1, v));
            }
        }
        Tok::D => {
            // 3[0-1]|[1-2]\d|0[1-9]|[1-9]| [1-9]
            if let Some(v) = two(in_range(s, i, 3, 3), in_range(s, i + 1, 0, 1)) {
                out.push((2, v));
            }
            if let Some(v) = two(in_range(s, i, 1, 2), dig(s, i + 1)) {
                out.push((2, v));
            }
            if let Some(v) = two(in_range(s, i, 0, 0), in_range(s, i + 1, 1, 9)) {
                out.push((2, v));
            }
            if let Some(v) = in_range(s, i, 1, 9) {
                out.push((1, v));
            }
            if s.get(i) == Some(&' ') {
                if let Some(v) = in_range(s, i + 1, 1, 9) {
                    out.push((2, v));
                }
            }
        }
        Tok::H => {
            // 2[0-3]|[0-1]\d|\d| \d
            if let Some(v) = two(in_range(s, i, 2, 2), in_range(s, i + 1, 0, 3)) {
                out.push((2, v));
            }
            if let Some(v) = two(in_range(s, i, 0, 1), dig(s, i + 1)) {
                out.push((2, v));
            }
            if let Some(v) = dig(s, i) {
                out.push((1, v));
            }
            if s.get(i) == Some(&' ') {
                if let Some(v) = dig(s, i + 1) {
                    out.push((2, v));
                }
            }
        }
        Tok::Mi => {
            // [0-5]\d|\d
            if let Some(v) = two(in_range(s, i, 0, 5), dig(s, i + 1)) {
                out.push((2, v));
            }
            if let Some(v) = dig(s, i) {
                out.push((1, v));
            }
        }
        Tok::S => {
            // 6[0-1]|[0-5]\d|\d
            if let Some(v) = two(in_range(s, i, 6, 6), in_range(s, i + 1, 0, 1)) {
                out.push((2, v));
            }
            if let Some(v) = two(in_range(s, i, 0, 5), dig(s, i + 1)) {
                out.push((2, v));
            }
            if let Some(v) = dig(s, i) {
                out.push((1, v));
            }
        }
        Tok::Lit(_) | Tok::Space => {}
    }
    out
}

/// First match of the tokens from `i` (regex backtracking order); returns the end and the
/// field values [Y, m, d, H, M, S].
fn match_from(s: &[char], i: usize, toks: &[Tok], vals: [u32; 6]) -> Option<(usize, [u32; 6])> {
    let Some((&tok, rest)) = toks.split_first() else {
        return Some((i, vals));
    };
    match tok {
        Tok::Lit(c) => {
            if s.get(i) == Some(&c) {
                match_from(s, i + 1, rest, vals)
            } else {
                None
            }
        }
        Tok::Space => {
            // \s+ (greedy, backtracking)
            let mut j = i;
            while j < s.len() && is_space(s[j]) {
                j += 1;
            }
            while j > i {
                if let Some(m) = match_from(s, j, rest, vals) {
                    return Some(m);
                }
                j -= 1;
            }
            None
        }
        _ => {
            let slot = match tok {
                Tok::Y => 0,
                Tok::Mo => 1,
                Tok::D => 2,
                Tok::H => 3,
                Tok::Mi => 4,
                _ => 5,
            };
            for (len, v) in field(tok, s, i) {
                let mut nv = vals;
                nv[slot] = v;
                if let Some(m) = match_from(s, i + len, rest, nv) {
                    return Some(m);
                }
            }
            None
        }
    }
}

/// `datetime.strptime(s, fmt)` for the two Growatt formats; `None` where Python raises
/// `ValueError` (no match, text left over, an impossible date, second 60 / 61, year 0).
pub fn strptime(s: &str, fmt: TimeFormat) -> Option<NaiveDateTime> {
    let chars: Vec<char> = s.chars().collect();
    let toks = match fmt {
        TimeFormat::Seconds => FMT_S,
        TimeFormat::Minutes => FMT_M,
    };
    let (end, v) = match_from(&chars, 0, toks, [1900, 1, 1, 0, 0, 0])?;
    if end != chars.len() || v[0] < 1 {
        return None;
    }
    NaiveDate::from_ymd_opt(v[0] as i32, v[1], v[2])?.and_hms_opt(v[3], v[4], v[5])
}

/// `date.fromisoformat(s)` (Python 3.13): `YYYY-MM-DD`, `YYYYMMDD`, and the ISO week forms
/// `YYYY-Www`, `YYYY-Www-D`, `YYYYWww`, `YYYYWwwD`; `None` where Python raises `ValueError`.
pub fn date_fromisoformat(s: &str) -> Option<NaiveDate> {
    let c: Vec<char> = s.chars().collect();
    let num = |a: usize, b: usize| -> Option<u32> {
        let mut n = 0u32;
        for ch in c.get(a..b)? {
            n = n * 10 + ch.to_digit(10).filter(|_| ch.is_ascii_digit())?;
        }
        Some(n)
    };
    let year = num(0, 4)?;
    if year < 1 {
        return None;
    }
    let week = |w: u32, d: u32| -> Option<NaiveDate> {
        if !(1..=7).contains(&d) {
            return None;
        }
        let wd = Weekday::try_from(u8::try_from(d - 1).ok()?).ok()?;
        NaiveDate::from_isoywd_opt(year as i32, w, wd)
    };
    let ymd = |m: u32, d: u32| NaiveDate::from_ymd_opt(year as i32, m, d);
    match (c.len(), c.get(4), c.get(5)) {
        (10, Some('-'), Some('W')) if c[8] == '-' => week(num(6, 8)?, num(9, 10)?),
        (10, Some('-'), _) if c[7] == '-' => ymd(num(5, 7)?, num(8, 10)?),
        (8, Some('-'), Some('W')) => week(num(6, 8)?, 1),
        (8, Some('W'), _) => week(num(5, 7)?, num(7, 8)?),
        (8, _, _) => ymd(num(4, 6)?, num(6, 8)?),
        (7, Some('W'), _) => week(num(5, 7)?, 1),
        _ => None,
    }
}
