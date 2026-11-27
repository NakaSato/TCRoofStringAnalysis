//! Calendar Team planning maths (docs/plans/calendar-team.md §7). Port of
//! `backend/solar_core/om_planning.py`.
//!
//! - [`occurrences`]: the days a recurring plan falls on in a window (every N weeks / months
//!   from its start, inside an optional season that may wrap the year, moved to the plan's
//!   weekday or the next working day).
//! - [`schedule_round`]: spread a cleaning round over working days for a number of crews,
//!   longest-uncleaned plants first, grouped (e.g. by province) to keep travel short.
//!
//! Weekdays are Python's `date.weekday()`: 0 = Monday … 6 = Sunday.

use chrono::{Datelike, Duration, NaiveDate};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fmt;

/// Monday … Friday.
pub const WORKDAYS: [u32; 5] = [0, 1, 2, 3, 4];
/// A weekday / working-day shift never moves an occurrence further than this.
pub const MAX_SHIFT_DAYS: i64 = 14;

/// Python's `ValueError` of this module.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PlanningError(pub String);

impl fmt::Display for PlanningError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for PlanningError {}

fn weekday(d: NaiveDate) -> u32 {
    d.weekday().num_days_from_monday()
}

fn days_in_month(y: i32, m: u32) -> u32 {
    let (ny, nm) = if m == 12 { (y + 1, 1) } else { (y, m + 1) };
    let first_next = NaiveDate::from_ymd_opt(ny, nm, 1).expect("valid month");
    first_next.pred_opt().expect("has a previous day").day()
}

/// Port of `om_planning.add_months`: same day of month `n` months later, clamped to the
/// month's last day (31 Jan + 1 = 28/29 Feb). Negative `n` goes back (Python floor division).
///
/// Unlike Python, years outside 1..=9999 are not rejected (chrono's range is wider).
pub fn add_months(d: NaiveDate, n: i64) -> Result<NaiveDate, PlanningError> {
    let m = d.month0() as i64 + n;
    let y = d.year() as i64 + m.div_euclid(12);
    let m = (m.rem_euclid(12) + 1) as u32;
    // Python's `date` holds years 1–9999 only and raises ValueError outside them
    if !(1..=9999).contains(&y) {
        return Err(PlanningError(format!("year {y} is out of range")));
    }
    let y = y as i32;
    Ok(NaiveDate::from_ymd_opt(y, m, d.day().min(days_in_month(y, m))).expect("valid date"))
}

/// Port of `om_planning.in_season`: `season_from` … `season_to` inclusive; wraps the year
/// when from > to (Nov … Apr). Either None = all year.
pub fn in_season(month: u32, season_from: Option<u32>, season_to: Option<u32>) -> bool {
    let (Some(a), Some(b)) = (season_from, season_to) else {
        return true;
    };
    if a <= b {
        a <= month && month <= b
    } else {
        month >= a || month <= b
    }
}

/// Port of `om_planning.next_working_day`: `d` or the first later day on one of `weekdays`
/// that is not a holiday (None if none within 14 days).
pub fn next_working_day(
    d: NaiveDate,
    weekdays: &[u32],
    holidays: &HashSet<NaiveDate>,
) -> Option<NaiveDate> {
    (0..=MAX_SHIFT_DAYS)
        .map(|i| d + Duration::days(i))
        .find(|x| weekdays.contains(&weekday(*x)) && !holidays.contains(x))
}

/// Recurrence unit of [`occurrences`] (Python's `unit` "week" | "month").
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Unit {
    Week,
    Month,
}

impl Unit {
    /// Python's check: "week" or "month", anything else a ValueError.
    pub fn parse(s: &str) -> Result<Self, PlanningError> {
        match s {
            "week" => Ok(Unit::Week),
            "month" => Ok(Unit::Month),
            _ => Err(PlanningError("unit must be week or month".into())),
        }
    }
}

/// Keyword arguments of Python's `occurrences` (all default to None / no holidays).
#[derive(Debug, Clone, Default)]
pub struct OccurrenceOptions {
    pub season_from: Option<u32>,
    pub season_to: Option<u32>,
    /// 0 = Monday; None = the first Monday–Friday.
    pub weekday: Option<u32>,
    pub ends_on: Option<NaiveDate>,
    pub holidays: Vec<NaiveDate>,
}

/// Port of `om_planning.occurrences`: days in `window_from` … `window_to` a plan falls on.
///
/// The k-th nominal day is `starts_on` + k × N weeks / months; one outside the season (by its
/// nominal month) is skipped; it then moves to `weekday` (0 = Monday), or with no weekday to
/// the first Monday–Friday, never onto a holiday.
pub fn occurrences(
    starts_on: NaiveDate,
    every_n: i64,
    unit: Unit,
    window_from: NaiveDate,
    window_to: NaiveDate,
    opts: &OccurrenceOptions,
) -> Result<Vec<NaiveDate>, PlanningError> {
    if every_n < 1 {
        return Err(PlanningError("every_n must be at least 1".into()));
    }
    let hol: HashSet<NaiveDate> = opts.holidays.iter().copied().collect();
    let single;
    let days: &[u32] = match opts.weekday {
        Some(w) => {
            single = [w];
            &single
        }
        None => &WORKDAYS,
    };
    let last = match opts.ends_on {
        Some(e) => window_to.min(e),
        None => window_to,
    };
    let mut out: Vec<NaiveDate> = Vec::new();
    let mut k: i64 = 0;
    loop {
        let nominal = match unit {
            Unit::Week => starts_on + Duration::weeks(every_n * k),
            Unit::Month => add_months(starts_on, every_n * k)?,
        };
        k += 1;
        if nominal > last {
            break;
        }
        if !in_season(nominal.month(), opts.season_from, opts.season_to) {
            continue;
        }
        let Some(day) = next_working_day(nominal, days, &hol) else {
            continue;
        };
        if day < window_from || day > last || day < starts_on {
            continue;
        }
        if out.last().is_none_or(|&l| day > l) {
            out.push(day);
        }
    }
    Ok(out)
}

/// Python's `RoundPlant`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RoundPlant {
    pub plant_id: i64,
    /// Crew-days one cleaning takes (om_plant_settings); None = not entered, counted as 1.
    pub crew_days: Option<f64>,
    /// Days since the last recorded cleaning; None = none recorded.
    pub days_since: Option<i64>,
    pub group: Option<String>,
}

impl RoundPlant {
    pub fn new(plant_id: i64) -> Self {
        RoundPlant {
            plant_id,
            crew_days: None,
            days_since: None,
            group: None,
        }
    }
}

/// Python's `RoundSlot`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RoundSlot {
    pub plant_id: i64,
    pub start_day: NaiveDate,
    pub end_day: NaiveDate,
    /// 1-based.
    pub crew: usize,
    pub crew_days: f64,
    pub duration_set: bool,
    pub working_days: Vec<NaiveDate>,
}

/// Python's `RoundResult`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RoundResult {
    pub slots: Vec<RoundSlot>,
    pub unscheduled: Vec<i64>,
    pub order: Vec<i64>,
}

/// Port of `om_planning.round_order`: priority = most days since the last cleaning (none
/// recorded first: unknown is never assumed clean). With `group`, plants of a group stay
/// together; groups go in order of their most urgent plant (None and "" are one group).
pub fn round_order(plants: &[RoundPlant], group: bool) -> Vec<RoundPlant> {
    let mut ranked: Vec<RoundPlant> = plants.to_vec();
    // key (0 if None else 1, -(days_since or 0), plant_id); stable like Python's sorted
    ranked.sort_by_key(|p| {
        (
            p.days_since.is_some() as u8,
            -p.days_since.unwrap_or(0),
            p.plant_id,
        )
    });
    if !group {
        return ranked;
    }
    let mut names: Vec<&str> = Vec::new(); // in order of first appearance = order of `first`
    let mut groups: HashMap<&str, Vec<&RoundPlant>> = HashMap::new();
    for p in &ranked {
        let g = p.group.as_deref().unwrap_or("");
        groups
            .entry(g)
            .or_insert_with(|| {
                names.push(g);
                Vec::new()
            })
            .push(p);
    }
    names
        .iter()
        .flat_map(|g| groups[g].iter().map(|p| (*p).clone()))
        .collect()
}

/// Port of `om_planning.working_days`: the days of `start` … `start + limit_days - 1` on one
/// of `weekdays` that are not holidays (empty when `limit_days` ≤ 0).
pub fn working_days(
    start: NaiveDate,
    weekdays: &[u32],
    holidays: &[NaiveDate],
    limit_days: i64,
) -> Vec<NaiveDate> {
    let hol: HashSet<NaiveDate> = holidays.iter().copied().collect();
    (0..limit_days.max(0))
        .map(|i| start + Duration::days(i))
        .filter(|d| weekdays.contains(&weekday(*d)) && !hol.contains(d))
        .collect()
}

/// Keyword arguments of Python's `schedule_round`.
#[derive(Debug, Clone)]
pub struct ScheduleOptions {
    pub weekdays: Vec<u32>,
    pub holidays: Vec<NaiveDate>,
    pub group: bool,
    pub horizon_days: i64,
}

impl Default for ScheduleOptions {
    /// Python's defaults: Monday–Friday, no holidays, grouped, 120 days.
    fn default() -> Self {
        ScheduleOptions {
            weekdays: WORKDAYS.to_vec(),
            holidays: Vec::new(),
            group: true,
            horizon_days: 120,
        }
    }
}

/// Port of `om_planning.schedule_round`: each crew works one plant at a time on working
/// days. A plant of ≤ 1 crew-day shares the crew's day with the next while the day has room
/// (two 0.5-day plants = one day); a longer one starts on a fresh day and takes ⌈crew-days⌉
/// working days. The next plant goes to the crew free earliest. Plants that don't fit within
/// `horizon_days` are returned in `unscheduled`.
pub fn schedule_round(
    plants: &[RoundPlant],
    start: NaiveDate,
    crews: i64,
    opts: &ScheduleOptions,
) -> Result<RoundResult, PlanningError> {
    if crews < 1 {
        return Err(PlanningError("crews must be at least 1".into()));
    }
    let crews = crews as usize;
    let days = working_days(start, &opts.weekdays, &opts.holidays, opts.horizon_days);
    let order = round_order(plants, opts.group);
    // per crew: index into `days` of its current day, and the part of that day already used
    let mut pos = vec![0usize; crews];
    let mut used = vec![0.0f64; crews];
    let mut slots = Vec::new();
    let mut unscheduled = Vec::new();
    for p in &order {
        // Python: `p.crew_days if p.crew_days and p.crew_days > 0 else 1.0` (NaN → 1.0)
        let need = match p.crew_days {
            Some(c) if c > 0.0 => c,
            _ => 1.0,
        };
        let mut best: Option<(usize, usize)> = None;
        for c in 0..crews {
            let (i, u) = (pos[c], used[c]);
            let begin = if need <= 1.0 && u + need <= 1.0 + 1e-9 {
                i
            } else if u > 1e-9 {
                i + 1
            } else {
                i
            };
            if best.is_none_or(|(_, b)| begin < b) {
                best = Some((c, begin));
            }
        }
        let (c, begin) = best.expect("crews >= 1");
        // Python's math.ceil(need - 1e-9) raises OverflowError for an infinite need
        if need.is_infinite() {
            return Err(PlanningError("cannot convert float infinity to integer".into()));
        }
        let span: usize = if need <= 1.0 {
            1
        } else {
            (need - 1e-9).ceil() as usize
        };
        if begin + span > days.len() {
            // Python: begin + span - 1 >= len(days)
            unscheduled.push(p.plant_id);
            continue;
        }
        let wd = days[begin..begin + span].to_vec();
        slots.push(RoundSlot {
            plant_id: p.plant_id,
            start_day: wd[0],
            end_day: *wd.last().expect("span >= 1"),
            crew: c + 1,
            crew_days: need,
            duration_set: p.crew_days.is_some(),
            working_days: wd,
        });
        if need <= 1.0 {
            used[c] = (if begin == pos[c] { used[c] } else { 0.0 }) + need;
            pos[c] = begin;
            if used[c] >= 1.0 - 1e-9 {
                pos[c] = begin + 1;
                used[c] = 0.0;
            }
        } else {
            pos[c] = begin + span;
            used[c] = 0.0;
        }
    }
    Ok(RoundResult {
        slots,
        unscheduled,
        order: order.iter().map(|p| p.plant_id).collect(),
    })
}

#[cfg(test)]
mod tests {
    //! backend/tests/test_om_planning.py
    use super::*;

    fn d(y: i32, m: u32, day: u32) -> NaiveDate {
        NaiveDate::from_ymd_opt(y, m, day).unwrap()
    }

    fn rp(
        id: i64,
        crew_days: Option<f64>,
        days_since: Option<i64>,
        group: Option<&str>,
    ) -> RoundPlant {
        RoundPlant {
            plant_id: id,
            crew_days,
            days_since,
            group: group.map(str::to_string),
        }
    }

    #[test]
    fn add_months_clamps_and_seasons_wrap() {
        assert_eq!(add_months(d(2027, 1, 31), 1).unwrap(), d(2027, 2, 28));
        assert!(add_months(d(9999, 12, 1), 1).is_err());
        assert!(add_months(d(1, 1, 1), -1).is_err());
        assert_eq!(add_months(d(2026, 11, 30), 3).unwrap(), d(2027, 2, 28));
        assert!(
            in_season(12, Some(11), Some(4))
                && in_season(4, Some(11), Some(4))
                && !in_season(5, Some(11), Some(4))
        );
        assert!(
            in_season(6, Some(3), Some(8))
                && !in_season(9, Some(3), Some(8))
                && in_season(9, None, None)
        );
    }

    #[test]
    fn occurrences_season_weekday_and_holidays() {
        let season = OccurrenceOptions {
            season_from: Some(11),
            season_to: Some(4),
            ..Default::default()
        };
        let days = occurrences(
            d(2026, 11, 2),
            2,
            Unit::Month,
            d(2026, 11, 1),
            d(2027, 12, 31),
            &season,
        )
        .unwrap();
        assert_eq!(
            days,
            vec![d(2026, 11, 2), d(2027, 1, 4), d(2027, 3, 2), d(2027, 11, 2)]
        );
        let with_hol = OccurrenceOptions {
            holidays: vec![d(2027, 1, 4)],
            ..season.clone()
        };
        let days = occurrences(
            d(2026, 11, 2),
            2,
            Unit::Month,
            d(2026, 11, 1),
            d(2027, 2, 1),
            &with_hol,
        )
        .unwrap();
        assert_eq!(days, vec![d(2026, 11, 2), d(2027, 1, 5)]);
        let weekly = OccurrenceOptions {
            weekday: Some(2),
            ends_on: Some(d(2026, 12, 9)),
            ..Default::default()
        };
        let days = occurrences(
            d(2026, 11, 19),
            1,
            Unit::Week,
            d(2026, 11, 1),
            d(2027, 1, 1),
            &weekly,
        )
        .unwrap();
        assert_eq!(days, vec![d(2026, 11, 25), d(2026, 12, 2), d(2026, 12, 9)]);
        let days = occurrences(
            d(2026, 1, 5),
            3,
            Unit::Month,
            d(2026, 11, 1),
            d(2027, 2, 1),
            &Default::default(),
        )
        .unwrap();
        assert_eq!(days, vec![d(2027, 1, 5)]);
        assert!(occurrences(
            d(2026, 1, 5),
            0,
            Unit::Month,
            d(2026, 1, 1),
            d(2026, 2, 1),
            &Default::default()
        )
        .is_err());
        assert!(Unit::parse("day").is_err());
    }

    #[test]
    fn round_order_unknown_first_then_groups() {
        let ps = vec![
            rp(1, None, Some(100), Some("A")),
            rp(2, None, Some(90), Some("B")),
            rp(3, None, Some(10), Some("A")),
            rp(4, None, None, Some("B")),
        ];
        let ids = |v: Vec<RoundPlant>| v.iter().map(|p| p.plant_id).collect::<Vec<_>>();
        assert_eq!(ids(round_order(&ps, false)), vec![4, 1, 2, 3]);
        assert_eq!(ids(round_order(&ps, true)), vec![4, 2, 1, 3]);
    }

    #[test]
    fn schedule_round_shares_days_and_spans_long_jobs() {
        let ps = vec![
            rp(1, Some(1.0), Some(200), None),
            rp(2, None, None, None),
            rp(3, Some(0.5), Some(10), None),
            rp(4, Some(0.5), Some(50), None),
            rp(5, Some(2.0), Some(30), None),
        ];
        let fri = d(2026, 11, 20);
        let ungrouped = ScheduleOptions {
            group: false,
            ..Default::default()
        };
        let r = schedule_round(&ps, fri, 1, &ungrouped).unwrap();
        let mut got: Vec<(i64, u32, u32)> = r
            .slots
            .iter()
            .map(|s| (s.plant_id, s.start_day.day(), s.end_day.day()))
            .collect();
        got.sort();
        assert_eq!(
            got,
            vec![
                (1, 23, 23),
                (2, 20, 20),
                (3, 27, 27),
                (4, 24, 24),
                (5, 25, 26)
            ]
        );
        assert_eq!(
            r.slots
                .iter()
                .filter(|s| s.plant_id == 2)
                .map(|s| s.duration_set)
                .collect::<Vec<_>>(),
            vec![false]
        );
        let r2 = schedule_round(&ps, fri, 2, &ungrouped).unwrap();
        let mut got2: Vec<(i64, usize, u32, u32)> = r2
            .slots
            .iter()
            .map(|s| (s.plant_id, s.crew, s.start_day.day(), s.end_day.day()))
            .collect();
        got2.sort();
        assert_eq!(
            got2,
            vec![
                (1, 2, 20, 20),
                (2, 1, 20, 20),
                (3, 1, 23, 23),
                (4, 1, 23, 23),
                (5, 2, 23, 24)
            ]
        );
        let two = vec![RoundPlant::new(1), RoundPlant::new(2)];
        let r3 = schedule_round(
            &two,
            d(2026, 12, 4),
            1,
            &ScheduleOptions {
                holidays: vec![d(2026, 12, 7)],
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(
            r3.slots.iter().map(|s| s.start_day).collect::<Vec<_>>(),
            vec![d(2026, 12, 4), d(2026, 12, 8)]
        );
        let r4 = schedule_round(
            &two,
            d(2026, 12, 4),
            1,
            &ScheduleOptions {
                weekdays: vec![0, 1, 2, 3, 4, 5],
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(
            r4.slots.iter().map(|s| s.start_day).collect::<Vec<_>>(),
            vec![d(2026, 12, 4), d(2026, 12, 5)]
        );
        let ten: Vec<RoundPlant> = (0..10).map(RoundPlant::new).collect();
        let r5 = schedule_round(
            &ten,
            d(2026, 12, 1),
            1,
            &ScheduleOptions {
                horizon_days: 7,
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!((r5.slots.len(), r5.unscheduled.len()), (5, 5));
        assert!(schedule_round(&ten, d(2026, 12, 1), 0, &Default::default()).is_err());
        // Python: math.ceil(inf) raises OverflowError
        let inf = [rp(1, Some(f64::INFINITY), None, None)];
        assert!(schedule_round(&inf, d(2026, 12, 1), 1, &Default::default()).is_err());
    }
}
