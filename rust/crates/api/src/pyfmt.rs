//! Python's text forms where they show in JSON or logs: `repr()` of a string (`{x!r}`, `%r`),
//! `str()` of an int list and `datetime.isoformat()`.

use chrono::{DateTime, SecondsFormat, Utc};

/// Python `datetime.isoformat()` of an aware UTC time: microseconds only when non-zero, `+00:00`.
pub fn isoformat(t: DateTime<Utc>) -> String {
    let fmt = if t.timestamp_subsec_micros() == 0 { SecondsFormat::Secs } else { SecondsFormat::Micros };
    t.to_rfc3339_opts(fmt, false)
}

/// Characters Python's `str.isprintable()` rejects beyond the C0 / C1 controls: the separators
/// other than the space (Zs, Zl, Zp) and the common format characters (Cf).
fn unprintable(c: char) -> bool {
    c.is_control()
        || matches!(c as u32,
            0xA0 | 0xAD | 0x1680 | 0x2000..=0x200F | 0x2028..=0x202F | 0x205F..=0x2064 | 0x3000 | 0xFEFF)
}

/// Python `repr(s)`: single quotes unless the text has a `'` and no `"`; `\\`, the quote, `\t`,
/// `\n`, `\r` escaped; other unprintable characters as `\xNN` / `\uNNNN` / `\UNNNNNNNN`.
pub fn repr_str(s: &str) -> String {
    let q = if s.contains('\'') && !s.contains('"') { '"' } else { '\'' };
    let mut out = String::with_capacity(s.len() + 2);
    out.push(q);
    for c in s.chars() {
        match c {
            '\\' => out.push_str("\\\\"),
            '\t' => out.push_str("\\t"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            c if c == q => {
                out.push('\\');
                out.push(c);
            }
            c if unprintable(c) => {
                let n = c as u32;
                if n <= 0xFF {
                    out.push_str(&format!("\\x{n:02x}"));
                } else if n <= 0xFFFF {
                    out.push_str(&format!("\\u{n:04x}"));
                } else {
                    out.push_str(&format!("\\U{n:08x}"));
                }
            }
            c => out.push(c),
        }
    }
    out.push(q);
    out
}

/// Python `str([1, 2])`: `[1, 2]`
pub fn int_list(v: &[i64]) -> String {
    format!("[{}]", v.iter().map(i64::to_string).collect::<Vec<_>>().join(", "))
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    #[test]
    fn isoformat_matches_python() {
        let t = Utc.with_ymd_and_hms(2026, 11, 27, 10, 0, 0).unwrap();
        assert_eq!(isoformat(t), "2026-11-27T10:00:00+00:00");
        let t = t + chrono::Duration::microseconds(1234);
        assert_eq!(isoformat(t), "2026-11-27T10:00:00.001234+00:00");
    }

    #[test]
    fn repr_matches_python() {
        // values checked against CPython 3.13 repr()
        assert_eq!(repr_str("admin"), "'admin'");
        assert_eq!(repr_str(""), "''");
        assert_eq!(repr_str("it's"), "\"it's\"");
        assert_eq!(repr_str("a'b\"c"), "'a\\'b\"c'");
        assert_eq!(repr_str("a\\b\n\t\r"), "'a\\\\b\\n\\t\\r'");
        assert_eq!(repr_str("\u{1}\u{7f}\u{a0}"), "'\\x01\\x7f\\xa0'");
        assert_eq!(repr_str("\u{200b}ช่าง"), "'\\u200bช่าง'");
    }

    #[test]
    fn int_list_matches_python() {
        assert_eq!(int_list(&[]), "[]");
        assert_eq!(int_list(&[3, -1, 1200]), "[3, -1, 1200]");
    }
}
