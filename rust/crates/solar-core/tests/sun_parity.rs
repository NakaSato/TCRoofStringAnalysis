//! Parity of `sun` with backend/solar_core/sun.py (fixtures/sun.json).
mod common;

use common::{close, date, f, load, opt_f};
use tcroof_core::sun::{clear_sky_ghi, sun_times, DEFAULT_UTC_OFFSET_H};

#[test]
fn sun_times_match_python_to_the_microsecond() {
    let fx = load("sun.json");
    let cases = fx["sun_times"].as_array().unwrap();
    let mut nones = 0;
    for c in cases {
        let got = sun_times(
            date(&c["day"]),
            f(&c["lat"]),
            f(&c["lon"]),
            f(&c["utc_offset_h"]),
        );
        let got = got.map(|(r, s)| {
            [
                r.format("%Y-%m-%dT%H:%M:%S%.6f").to_string(),
                s.format("%Y-%m-%dT%H:%M:%S%.6f").to_string(),
            ]
        });
        let want = c["result"].as_array().map(|a| {
            [
                a[0].as_str().unwrap().to_string(),
                a[1].as_str().unwrap().to_string(),
            ]
        });
        nones += want.is_none() as usize;
        assert_eq!(got, want, "case {c}");
    }
    assert!(
        cases.len() > 1000 && nones > 10,
        "{} cases, {nones} polar",
        cases.len()
    );
}

#[test]
fn clear_sky_ghi_matches_python() {
    let fx = load("sun.json");
    let cases = fx["clear_sky_ghi"].as_array().unwrap();
    let mut zeros = 0;
    for c in cases {
        let off = opt_f(&c["utc_offset_h"]).unwrap_or(DEFAULT_UTC_OFFSET_H);
        let got = clear_sky_ghi(
            date(&c["day"]),
            f(&c["lat"]),
            f(&c["lon"]),
            f(&c["minute_of_day"]),
            off,
        );
        let want = f(&c["ghi"]);
        zeros += (want == 0.0) as usize;
        assert!(close(got, want), "got {got}, want {want}: {c}");
    }
    assert!(cases.len() > 3000 && zeros > 100);
}
