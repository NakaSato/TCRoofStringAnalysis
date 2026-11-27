//! Python built-in semantics the weather parsers rely on (`float()`, `int()`, `round()`,
//! `repr(float)`, truthiness, `datetime.fromisoformat`, `datetime.isoformat`), so the Rust parsers
//! give the same answer as `backend/solar_core/{google_weather,longdo_weather,rainviewer}.py` for
//! any JSON value. Shared by the three weather modules.

use chrono::{DateTime, NaiveDate, NaiveDateTime, NaiveTime, Timelike, Utc};
use serde_json::Value;

/// Python truthiness of a JSON value (`bool(v)`): null, false, 0, 0.0, "", [] and {} are false.
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

/// `x or default` for a JSON object member: the value when it is truthy, else None.
pub fn get_truthy<'a>(v: &'a Value, key: &str) -> Option<&'a Value> {
    v.get(key).filter(|x| truthy(x))
}

/// Zero code points of the Unicode decimal-digit (Nd) blocks in the Basic Multilingual Plane;
/// Python's `int()` / `float()` read every Nd digit (Thai `๑๒` = 12, fullwidth `１２` = 12).
/// Digits outside the BMP are not mapped (Python reads them too).
const ND_ZEROS: [u32; 37] = [
    0x0660, 0x06F0, 0x07C0, 0x0966, 0x09E6, 0x0A66, 0x0AE6, 0x0B66, 0x0BE6, 0x0C66, 0x0CE6, 0x0D66, 0x0DE6, 0x0E50, 0x0ED0, 0x0F20, 0x1040,
    0x1090, 0x17E0, 0x1810, 0x1946, 0x19D0, 0x1A80, 0x1A90, 0x1B50, 0x1BB0, 0x1C40, 0x1C50, 0xA620, 0xA8D0, 0xA900, 0xA9D0, 0xA9F0, 0xAA50,
    0xABF0, 0xFF10, 0x0030,
];

fn unicode_digit(c: char) -> Option<u8> {
    let u = c as u32;
    ND_ZEROS.iter().find(|&&z| (z..z + 10).contains(&u)).map(|z| (u - z) as u8)
}

/// Strip Python whitespace and check / drop `_` digit separators (`int("1_000")`, `float("1_0.5")`):
/// an underscore is allowed only between two digits.
fn strip_numeric(s: &str) -> Option<String> {
    let t = s.trim_matches(|c: char| c.is_whitespace());
    let ascii: String;
    let t = if t.is_ascii() {
        t
    } else {
        ascii = t.chars().map(|c| unicode_digit(c).map_or(c, |d| char::from(b'0' + d))).collect();
        &ascii
    };
    if !t.contains('_') {
        return Some(t.to_string());
    }
    let chars: Vec<char> = t.chars().collect();
    let mut out = String::with_capacity(t.len());
    for (i, &c) in chars.iter().enumerate() {
        if c == '_' {
            let prev = i.checked_sub(1).map(|j| chars[j]);
            let next = chars.get(i + 1).copied();
            if !(prev.is_some_and(|p| p.is_ascii_digit()) && next.is_some_and(|n| n.is_ascii_digit())) {
                return None;
            }
        } else {
            out.push(c);
        }
    }
    Some(out)
}

/// Python `float(s)` for a string; None where Python raises `ValueError`.
pub fn float_str(s: &str) -> Option<f64> {
    let t = strip_numeric(s)?;
    let body = t.strip_prefix(['+', '-']).unwrap_or(&t);
    let lower = body.to_ascii_lowercase();
    let special = matches!(lower.as_str(), "nan" | "inf" | "infinity");
    // Rust's parser accepts the same decimal grammar as Python apart from the special words,
    // which Python allows only exactly ("nan", "inf", "infinity", any case, optional sign).
    if !special && !body.chars().all(|c| c.is_ascii_digit() || matches!(c, '.' | 'e' | 'E' | '+' | '-')) {
        return None;
    }
    t.parse::<f64>().ok()
}

/// Python `int(s)` for a string (base 10); None where Python raises `ValueError` or the value
/// does not fit an i64 (Python would give a big int).
pub fn int_str(s: &str) -> Option<i64> {
    let t = strip_numeric(s)?;
    let body = t.strip_prefix(['+', '-']).unwrap_or(&t);
    if body.is_empty() || !body.chars().all(|c| c.is_ascii_digit()) {
        return None;
    }
    t.parse::<i64>().ok()
}

/// `float(v)` of a JSON value: numbers, numeric strings and (when `allow_bool`) booleans;
/// None for null, "" and anything Python's `float()` refuses.
pub fn float_value(v: &Value, allow_bool: bool) -> Option<f64> {
    match v {
        Value::Number(n) => n.as_f64(),
        Value::String(s) if s.is_empty() => None,
        Value::String(s) => float_str(s),
        Value::Bool(b) if allow_bool => Some(if *b { 1.0 } else { 0.0 }),
        _ => None,
    }
}

/// `int(v)` of a JSON value (floats truncate toward zero); None for null, "", booleans
/// (when `allow_bool` is false) and anything Python's `int()` refuses.
pub fn int_value(v: &Value, allow_bool: bool) -> Option<i64> {
    match v {
        Value::Number(n) => {
            if let Some(i) = n.as_i64() {
                Some(i)
            } else {
                let x = n.as_f64()?;
                let t = x.trunc();
                (x.is_finite() && t >= i64::MIN as f64 && t < i64::MAX as f64).then_some(t as i64)
            }
        }
        Value::String(s) if s.is_empty() => None,
        Value::String(s) => int_str(s),
        Value::Bool(b) if allow_bool => Some(i64::from(*b)),
        _ => None,
    }
}

/// Python `round(x, digits)` (correctly rounded, ties to even on the exact binary value).
pub fn round(x: f64, digits: usize) -> f64 {
    if !x.is_finite() {
        return x;
    }
    format!("{x:.digits$}").parse().unwrap_or(x)
}

/// Python `repr(x)` / `str(x)` of a float (`100.0`, `13.7`, `1e-05`, `1e+16`); what `requests`
/// puts in a query string for a float parameter.
pub fn repr_f64(x: f64) -> String {
    if x.is_nan() {
        return "nan".into();
    }
    if x.is_infinite() {
        return if x > 0.0 { "inf".into() } else { "-inf".into() };
    }
    if x == 0.0 {
        return if x.is_sign_negative() { "-0.0".into() } else { "0.0".into() };
    }
    let sci = format!("{x:e}"); // shortest round-trip digits: "-1.375e2"
    let (mant, exp) = sci.split_once('e').expect("{:e} has an exponent");
    let exp: i32 = exp.parse().expect("exponent");
    let (sign, mant) = mant.strip_prefix('-').map_or(("", mant), |m| ("-", m));
    let digits: String = mant.chars().filter(|c| *c != '.').collect();
    let n = digits.len() as i32;
    let decpt = exp + 1;
    if -4 < decpt && decpt <= 16 {
        if decpt <= 0 {
            format!("{sign}0.{}{digits}", "0".repeat((-decpt) as usize))
        } else if decpt >= n {
            format!("{sign}{digits}{}.0", "0".repeat((decpt - n) as usize))
        } else {
            let (a, b) = digits.split_at(decpt as usize);
            format!("{sign}{a}.{b}")
        }
    } else {
        let (a, b) = digits.split_at(1);
        let rest = if b.is_empty() { String::new() } else { format!(".{b}") };
        let esign = if exp < 0 { '-' } else { '+' };
        format!("{sign}{a}{rest}e{esign}{:02}", exp.abs())
    }
}

/// Python `repr(s)` of a string: single quotes unless it holds `'` and no `"`.
fn repr_str(s: &str) -> String {
    let q = if s.contains('\'') && !s.contains('"') { '"' } else { '\'' };
    let mut out = String::with_capacity(s.len() + 2);
    out.push(q);
    for c in s.chars() {
        match c {
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if c == q => {
                out.push('\\');
                out.push(c);
            }
            c if (c as u32) < 0x20 || (0x7f..0xa0).contains(&(c as u32)) => out.push_str(&format!("\\x{:02x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push(q);
    out
}

/// Python `repr(v)` of a parsed JSON value (`[1, 'a', None]`, `{'k': True}`).
fn repr_value(v: &Value) -> String {
    match v {
        Value::String(s) => repr_str(s),
        Value::Array(a) => format!("[{}]", a.iter().map(repr_value).collect::<Vec<_>>().join(", ")),
        Value::Object(o) => format!("{{{}}}", o.iter().map(|(k, v)| format!("{}: {}", repr_str(k), repr_value(v))).collect::<Vec<_>>().join(", ")),
        other => str_value(other).unwrap_or_default(),
    }
}

/// Python `str(v)` of a parsed JSON value, as `str(text)` renders it (lists and dicts in their
/// Python repr). Always `Some`; the Option keeps call sites chainable.
pub fn str_value(v: &Value) -> Option<String> {
    match v {
        Value::String(s) => Some(s.clone()),
        Value::Bool(b) => Some(if *b { "True" } else { "False" }.into()),
        Value::Null => Some("None".into()),
        Value::Number(n) => Some(match n.as_i64().or_else(|| n.as_u64().and_then(|u| i64::try_from(u).ok())) {
            Some(i) => i.to_string(),
            None if n.is_u64() => n.to_string(),
            None => repr_f64(n.as_f64().unwrap_or(f64::NAN)),
        }),
        Value::Array(_) | Value::Object(_) => Some(repr_value(v)),
    }
}

fn digits(s: &str, n: usize) -> Option<u32> {
    (s.len() == n && s.bytes().all(|b| b.is_ascii_digit())).then(|| s.parse().ok()).flatten()
}

fn parse_date(s: &str) -> Option<NaiveDate> {
    let (y, m, d) = if s.len() == 10 && s.as_bytes()[4] == b'-' && s.as_bytes()[7] == b'-' {
        (digits(&s[0..4], 4)?, digits(&s[5..7], 2)?, digits(&s[8..10], 2)?)
    } else if s.len() == 8 {
        (digits(&s[0..4], 4)?, digits(&s[4..6], 2)?, digits(&s[6..8], 2)?)
    } else {
        return None;
    };
    if y < 1 {
        return None;
    }
    NaiveDate::from_ymd_opt(y as i32, m, d)
}

/// `HH[:MM[:SS[(.|,)f+]]]` or `HHMM[SS[(.|,)f+]]`; fractional digits beyond 6 are dropped.
fn parse_hms(s: &str) -> Option<NaiveTime> {
    let (main, frac) = match s.find(['.', ',']) {
        Some(i) => (&s[..i], Some(&s[i + 1..])),
        None => (s, None),
    };
    let parts: Vec<&str> = if main.contains(':') {
        main.split(':').collect()
    } else {
        (0..main.len()).step_by(2).map(|i| main.get(i..i + 2).unwrap_or(&main[i..])).collect()
    };
    if parts.is_empty() || parts.len() > 3 || parts.iter().any(|p| p.len() != 2) {
        return None;
    }
    let mut hms = [0u32; 3];
    for (i, p) in parts.iter().enumerate() {
        hms[i] = digits(p, 2)?;
    }
    let micro = match frac {
        None => 0,
        Some(f) => {
            if parts.len() != 3 || f.is_empty() || !f.bytes().all(|b| b.is_ascii_digit()) {
                return None;
            }
            let f6: String = f.chars().take(6).collect();
            format!("{f6:0<6}").parse::<u32>().ok()?
        }
    };
    NaiveTime::from_hms_micro_opt(hms[0], hms[1], hms[2], micro)
}

/// `±HH[:MM[:SS[.ffffff]]]` (or without colons): valid when strictly under 24 h.
fn valid_offset(s: &str) -> bool {
    let Some(body) = s.strip_prefix(['+', '-']) else { return false };
    parse_hms(body).is_some()
}

/// Python 3.13 `datetime.fromisoformat(s)` with any UTC offset dropped (the callers replace the
/// zone, they never convert it). Covers calendar dates (`YYYY-MM-DD`, `YYYYMMDD`), any one
/// separator character, `HH[:MM[:SS[.f]]]` and basic times, and `Z` / `±HH[:MM]` offsets.
/// ISO week dates (`2026-W46-4`) and ordinal dates, which Python also reads, give None.
pub fn fromisoformat_naive(s: &str) -> Option<NaiveDateTime> {
    if !s.is_ascii() {
        // Python allows any one Unicode character as the separator; slice by chars for that case.
        let chars: Vec<char> = s.chars().collect();
        if chars.len() > 10 && chars[..10].iter().all(char::is_ascii) && chars[11..].iter().all(char::is_ascii) {
            let date: String = chars[..10].iter().collect();
            let rest: String = chars[11..].iter().collect();
            return fromisoformat_naive(&format!("{date}T{rest}"));
        }
        return None;
    }
    let date_len = if s.len() >= 10 && s.as_bytes()[4] == b'-' { 10 } else { 8 };
    if s.len() < date_len {
        return None;
    }
    let date = parse_date(&s[..date_len])?;
    if s.len() == date_len {
        return Some(date.and_hms_opt(0, 0, 0).expect("midnight"));
    }
    let rest = &s[date_len + 1..];
    if rest.is_empty() {
        return None;
    }
    let (time, tz) = match rest.find(['Z', '+', '-']) {
        Some(i) => (&rest[..i], Some(&rest[i..])),
        None => (rest, None),
    };
    let time = parse_hms(time)?;
    match tz {
        None => {}
        Some("Z") => {}
        Some(z) if valid_offset(z) => {}
        Some(_) => return None,
    }
    Some(date.and_time(time))
}

/// Python `datetime.isoformat()` of an aware UTC datetime: `2026-11-12T05:00:00+00:00`, with
/// `.ffffff` only when the microseconds are not zero.
pub fn isoformat_utc(t: &DateTime<Utc>) -> String {
    format!("{}+00:00", isoformat_naive(&t.naive_utc()))
}

/// Python `datetime.isoformat()` of a naive datetime: `2026-11-11T10:00:00[.ffffff]`.
pub fn isoformat_naive(t: &NaiveDateTime) -> String {
    let micro = t.nanosecond() / 1000;
    if micro == 0 {
        t.format("%Y-%m-%dT%H:%M:%S").to_string()
    } else {
        format!("{}.{micro:06}", t.format("%Y-%m-%dT%H:%M:%S"))
    }
}
