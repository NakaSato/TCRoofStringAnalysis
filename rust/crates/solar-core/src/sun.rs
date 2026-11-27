//! Sunrise / sunset from the NOAA solar equations (accuracy about a minute) and the Haurwitz
//! clear-sky GHI. Port of `backend/solar_core/sun.py`.

use chrono::{Datelike, Duration, NaiveDate, NaiveDateTime};
use std::f64::consts::PI;

/// The default `utc_offset_h` of Python's `clear_sky_ghi` (Thailand, UTC+7).
pub const DEFAULT_UTC_OFFSET_H: f64 = 7.0;

/// Microseconds of Python's `timedelta(minutes=x)`, with CPython's exact conversion: the
/// integer part of `x` is exact, the fraction goes through one float multiply, and the
/// sub-microsecond leftover is rounded half to even (on the parity of the running total).
pub(crate) fn timedelta_minutes_us(minutes: f64) -> i64 {
    const US_PER_MINUTE: f64 = 60_000_000.0;
    let int_part = minutes.trunc();
    let frac = minutes - int_part;
    let mut sum = int_part as i64 * 60_000_000;
    if frac == 0.0 {
        return sum;
    }
    let dnum = US_PER_MINUTE * frac;
    let int2 = dnum.trunc();
    let leftover = dnum - int2;
    sum += int2 as i64;
    if leftover != 0.0 {
        let mut whole = leftover.round(); // C round(): half away from zero
        if (whole - leftover).abs() == 0.5 {
            let is_odd = (sum & 1) as f64;
            whole = 2.0 * ((leftover + is_odd) * 0.5).round() - is_odd;
        }
        sum += whole as i64;
    }
    sum
}

fn add_minutes(base: NaiveDateTime, minutes: f64) -> NaiveDateTime {
    base + Duration::microseconds(timedelta_minutes_us(minutes))
}

/// Port of `sun.sun_times`: naive local (sunrise, sunset) for `day` at `lat` / `lon` (east
/// positive), to the microsecond as Python's `datetime + timedelta(minutes=…)` gives them.
///
/// `None` when the sun does not rise or set that day (polar day / night).
pub fn sun_times(
    day: NaiveDate,
    lat: f64,
    lon: f64,
    utc_offset_h: f64,
) -> Option<(NaiveDateTime, NaiveDateTime)> {
    let g = 2.0 * PI / 365.0 * (day.ordinal() as f64 - 1.0);
    let eqtime = 229.18
        * (0.000075 + 0.001868 * g.cos()
            - 0.032077 * g.sin()
            - 0.014615 * (2.0 * g).cos()
            - 0.040849 * (2.0 * g).sin()); // minutes
    let decl = 0.006918 - 0.399912 * g.cos() + 0.070257 * g.sin() - 0.006758 * (2.0 * g).cos()
        + 0.000907 * (2.0 * g).sin()
        - 0.002697 * (3.0 * g).cos()
        + 0.00148 * (3.0 * g).sin(); // radians
    let phi = lat.to_radians();
    let cos_ha = 90.833_f64.to_radians().cos() / (phi.cos() * decl.cos()) - phi.tan() * decl.tan();
    // Python: `if abs(cos_ha) > 1: return None` (NaN is not > 1 and falls through)
    if cos_ha.abs() > 1.0 {
        return None;
    }
    let ha = cos_ha.acos().to_degrees();
    let midnight = day.and_hms_opt(0, 0, 0).expect("midnight exists");
    let rise_min = 720.0 - 4.0 * (lon + ha) - eqtime + utc_offset_h * 60.0;
    let set_min = 720.0 - 4.0 * (lon - ha) - eqtime + utc_offset_h * 60.0;
    Some((
        add_minutes(midnight, rise_min),
        add_minutes(midnight, set_min),
    ))
}

/// Port of `sun.clear_sky_ghi`: Haurwitz clear-sky GHI (W/m²) at local wall-clock
/// `minute_of_day` (0–1440) for lat / lon. Modelled, never measured; 0 when the sun is
/// (nearly) below the horizon. Python's default `utc_offset_h` is [`DEFAULT_UTC_OFFSET_H`].
pub fn clear_sky_ghi(
    day: NaiveDate,
    lat: f64,
    lon: f64,
    minute_of_day: f64,
    utc_offset_h: f64,
) -> f64 {
    let doy = day.ordinal() as f64;
    let g = 2.0 * PI / 365.0 * (doy - 1.0 + (minute_of_day / 60.0 - 12.0) / 24.0);
    let decl = 0.006918 - 0.399912 * g.cos() + 0.070257 * g.sin() - 0.006758 * (2.0 * g).cos()
        + 0.000907 * (2.0 * g).sin();
    let eqt = 229.18
        * (0.000075 + 0.001868 * g.cos()
            - 0.032077 * g.sin()
            - 0.014615 * (2.0 * g).cos()
            - 0.040849 * (2.0 * g).sin());
    let solar_min = minute_of_day + eqt + 4.0 * lon - 60.0 * utc_offset_h;
    let ha = (solar_min / 4.0 - 180.0).to_radians();
    let la = lat.to_radians();
    let cosz = la.sin() * decl.sin() + la.cos() * decl.cos() * ha.cos();
    // Python: `0.0 if cosz <= 0.01 else …` (NaN is not <= 0.01 and goes to the formula)
    if cosz <= 0.01 {
        0.0
    } else {
        1098.0 * cosz * (-0.057 / cosz).exp()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn d(y: i32, m: u32, day: u32) -> NaiveDate {
        NaiveDate::from_ymd_opt(y, m, day).unwrap()
    }

    /// backend/tests/test_growatt_routes.py::test_sun_times_bangkok
    #[test]
    fn sun_times_bangkok() {
        let (rise, sset) = sun_times(d(2026, 11, 12), 13.7563, 100.5018, 7.0).unwrap();
        let want_rise = d(2026, 11, 12).and_hms_opt(6, 16, 0).unwrap();
        let want_set = d(2026, 11, 12).and_hms_opt(17, 48, 0).unwrap();
        assert!((rise - want_rise).num_seconds().abs() < 180);
        assert!((sset - want_set).num_seconds().abs() < 180);
    }

    #[test]
    fn polar_night_and_day_are_none() {
        assert!(sun_times(d(2026, 12, 21), 80.0, 15.0, 1.0).is_none());
        assert!(sun_times(d(2026, 6, 21), 80.0, 15.0, 1.0).is_none());
    }

    /// backend/tests/test_sensor_health.py::test_clear_sky_matches_pwa_sheet (the solar_core part)
    #[test]
    fn clear_sky_bangkok_noon_and_night() {
        let day = d(2026, 11, 10);
        let noon = clear_sky_ghi(day, 13.75, 100.5, 720.0, DEFAULT_UTC_OFFSET_H);
        assert!(800.0 < noon && noon < 950.0, "{noon}");
        assert_eq!(
            clear_sky_ghi(day, 13.75, 100.5, 180.0, DEFAULT_UTC_OFFSET_H),
            0.0
        );
    }

    #[test]
    fn timedelta_rounding_matches_cpython() {
        assert_eq!(timedelta_minutes_us(0.0), 0);
        assert_eq!(timedelta_minutes_us(1.5), 90_000_000);
        assert_eq!(timedelta_minutes_us(-1.5), -90_000_000);
        // 1e-8 min = 0.6 us → 1 us; -1e-8 → -1 us
        assert_eq!(timedelta_minutes_us(1e-8), 1);
        assert_eq!(timedelta_minutes_us(-1e-8), -1);
    }
}
