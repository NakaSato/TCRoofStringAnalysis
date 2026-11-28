//! Parity of `om_planning` with backend/solar_core/om_planning.py (fixtures/om_planning.json).
mod common;

use common::{close, date, dates, f, load, opt_f};
use serde_json::Value;
use std::collections::HashSet;
use tcroof_core::om_planning::*;

fn u32s(v: &Value) -> Vec<u32> {
    v.as_array()
        .unwrap()
        .iter()
        .map(|x| x.as_u64().unwrap() as u32)
        .collect()
}

fn opt_u32(v: &Value) -> Option<u32> {
    v.as_u64().map(|x| x as u32)
}

fn plants(v: &Value) -> Vec<RoundPlant> {
    v.as_array()
        .unwrap()
        .iter()
        .map(|p| RoundPlant {
            plant_id: p["plant_id"].as_i64().unwrap(),
            crew_days: opt_f(&p["crew_days"]),
            days_since: p["days_since"].as_i64(),
            group: p["group"].as_str().map(str::to_string),
        })
        .collect()
}

#[test]
fn add_months_matches_python() {
    let fx = load("om_planning.json");
    for c in fx["add_months"].as_array().unwrap() {
        assert_eq!(
            add_months(date(&c["d"]), c["n"].as_i64().unwrap()).unwrap(),
            date(&c["result"]),
            "{c}"
        );
    }
}

#[test]
fn in_season_matches_python() {
    let fx = load("om_planning.json");
    for c in fx["in_season"].as_array().unwrap() {
        let got = in_season(
            c["month"].as_u64().unwrap() as u32,
            opt_u32(&c["from"]),
            opt_u32(&c["to"]),
        );
        assert_eq!(got, c["result"].as_bool().unwrap(), "{c}");
    }
}

#[test]
fn next_working_day_matches_python() {
    let fx = load("om_planning.json");
    for c in fx["next_working_day"].as_array().unwrap() {
        let hol: HashSet<_> = dates(&c["holidays"]).into_iter().collect();
        let got = next_working_day(date(&c["d"]), &u32s(&c["weekdays"]), &hol);
        let want = if c["result"].is_null() {
            None
        } else {
            Some(date(&c["result"]))
        };
        assert_eq!(got, want, "{c}");
    }
}

#[test]
fn working_days_match_python() {
    let fx = load("om_planning.json");
    for c in fx["working_days"].as_array().unwrap() {
        let got = working_days(
            date(&c["start"]),
            &u32s(&c["weekdays"]),
            &dates(&c["holidays"]),
            c["limit_days"].as_i64().unwrap(),
        );
        assert_eq!(got, dates(&c["result"]), "{c}");
    }
}

#[test]
fn occurrences_match_python() {
    let fx = load("om_planning.json");
    let cases = fx["occurrences"].as_array().unwrap();
    let mut non_empty = 0;
    for c in cases {
        let opts = OccurrenceOptions {
            season_from: opt_u32(&c["season_from"]),
            season_to: opt_u32(&c["season_to"]),
            weekday: opt_u32(&c["weekday"]),
            ends_on: c.get("ends_on").filter(|v| !v.is_null()).map(date),
            holidays: dates(&c["holidays"]),
        };
        let got = Unit::parse(c["unit"].as_str().unwrap())
            .map_err(|e| e.to_string())
            .and_then(|unit| {
                occurrences(
                    date(&c["starts_on"]),
                    c["every_n"].as_i64().unwrap(),
                    unit,
                    date(&c["window_from"]),
                    date(&c["window_to"]),
                    &opts,
                )
                .map_err(|e| e.to_string())
            });
        match c.get("error") {
            Some(_) => assert!(got.is_err(), "{c}"),
            None => {
                let got = got.unwrap();
                non_empty += !got.is_empty() as usize;
                assert_eq!(got, dates(&c["result"]), "{c}");
            }
        }
    }
    assert!(non_empty > 100, "{non_empty}");
}

#[test]
fn round_order_matches_python() {
    let fx = load("om_planning.json");
    for c in fx["round_order"].as_array().unwrap() {
        let got: Vec<i64> = round_order(&plants(&c["plants"]), c["group"].as_bool().unwrap())
            .iter()
            .map(|p| p.plant_id)
            .collect();
        let want: Vec<i64> = c["result"]
            .as_array()
            .unwrap()
            .iter()
            .map(|x| x.as_i64().unwrap())
            .collect();
        assert_eq!(got, want, "{c}");
    }
}

#[test]
fn schedule_round_matches_python() {
    let fx = load("om_planning.json");
    let cases = fx["schedule_round"].as_array().unwrap();
    let (mut slots_seen, mut unscheduled_seen) = (0, 0);
    for c in cases {
        let opts = ScheduleOptions {
            weekdays: u32s(&c["weekdays"]),
            holidays: dates(&c["holidays"]),
            group: c["group"].as_bool().unwrap(),
            horizon_days: c["horizon_days"].as_i64().unwrap(),
        };
        let got = schedule_round(
            &plants(&c["plants"]),
            date(&c["start"]),
            c["crews"].as_i64().unwrap(),
            &opts,
        );
        if c.get("error").is_some() {
            assert!(got.is_err(), "{c}");
            continue;
        }
        let got = got.unwrap();
        let want = &c["result"];
        let ids = |v: &Value| {
            v.as_array()
                .unwrap()
                .iter()
                .map(|x| x.as_i64().unwrap())
                .collect::<Vec<_>>()
        };
        assert_eq!(got.order, ids(&want["order"]), "{c}");
        assert_eq!(got.unscheduled, ids(&want["unscheduled"]), "{c}");
        let ws = want["slots"].as_array().unwrap();
        assert_eq!(got.slots.len(), ws.len(), "{c}");
        for (g, w) in got.slots.iter().zip(ws) {
            assert_eq!(g.plant_id, w["plant_id"].as_i64().unwrap(), "{c}");
            assert_eq!(g.start_day, date(&w["start_day"]), "{c}");
            assert_eq!(g.end_day, date(&w["end_day"]), "{c}");
            assert_eq!(g.crew as u64, w["crew"].as_u64().unwrap(), "{c}");
            assert!(close(g.crew_days, f(&w["crew_days"])), "{c}");
            assert_eq!(g.duration_set, w["duration_set"].as_bool().unwrap(), "{c}");
            assert_eq!(g.working_days, dates(&w["working_days"]), "{c}");
        }
        slots_seen += got.slots.len();
        unscheduled_seen += got.unscheduled.len();
    }
    assert!(
        slots_seen > 1000 && unscheduled_seen > 50,
        "{slots_seen} {unscheduled_seen}"
    );
}
