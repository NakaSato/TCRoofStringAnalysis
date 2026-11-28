//! Expected values are what backend/app/services/pwa_sheet.py answers for the same input.

use super::*;

fn ign() -> BTreeSet<i64> {
    parse_codes("1")
}

fn day() -> NaiveDate {
    NaiveDate::from_ymd_opt(2026, 11, 28).unwrap()
}

fn info() -> PlantInfo {
    PlantInfo { name: Some("P".into()), latitude: Some(13.75), longitude: Some(100.5) }
}

#[test]
fn capped_cuts_at_a_whole_entry() {
    let e = vec!["a".repeat(200), "b".repeat(90), "c".repeat(20)];
    assert_eq!(capped(&e, LOG_MAX), format!("{}, {}, …(+1)", "a".repeat(200), "b".repeat(90)));
    assert_eq!(capped(&["x".repeat(400)], LOG_MAX), format!("{}…", "x".repeat(299)));
}

#[test]
fn issue_text_and_data_log() {
    let i = json!({"inv":"INV3","state":"Fault","items":[{"code":117,"message":"Relay check fail","since":"06:19","count":5},{"code":"203"}]});
    assert_eq!(issue_text(&i), "INV3 Fault: 117 Relay check fail (06:19, ×5) / 203");
    assert_eq!(issue_text(&json!({"inv":"INV2","state":"Offline","last":null,"items":[]})), "INV2 Offline (no data today)");
    let c = check(Some(&json!({"inverters":3,"offline":["INV1"],"fault":[],"alarms":[],"issues":[
        {"inv":"INV1","state":"Offline","last":"07:40","items":[]},{"inv":"INV2","state":"Alarm","items":[{"code":"1"}]}]})))
    .unwrap();
    assert_eq!(data_log(Some(12.5), Some(&c), &ign()), "INV1 Offline (last data 07:40)");
    let idle = check(Some(&json!({"inverters":2,"offline":[],"fault":[],"alarms":[]}))).unwrap();
    assert_eq!(data_log(Some(0.0), Some(&idle), &ign()), NOT_PRODUCING);
    assert_eq!(note(Some(12.5), Some(&c), Some(584), true, true), "INV1 Offline ค่าแสง 584 (ฝนตก)");
}

#[test]
fn plant_cells_from_check_slots() {
    let doc = json!({"yield_kwh": 123.456, "weather": {"has_sensor": true}, "checks": {
        "09": {"kw": 45.27, "at": "08:50", "irradiance_wm2": 612.5, "inverters": 3, "offline": [], "fault": [], "alarms": [], "issues": [],
               "google": {"raining": false, "condition": "PARTLY_CLOUDY", "cloud_cover_pct": 40}},
        "13": {"kw": 0, "at": "12:50", "irradiance_wm2": null, "inverters": 3, "offline": ["INV1","INV2","INV3"], "fault": [], "alarms": [],
               "issues": null, "errors": ["E1", "E2"]}}});
    let ready = vec!["09".to_owned(), "13".to_owned()];
    let c = plant_cells(day(), &doc, &info(), &[9, 13, 17], Some(&ready), &ign());
    assert_eq!(c.checks["09"], vec![json!("Normal"), json!("INV ทำงานปกติ ค่าแสง 612"), json!(612), json!(SKY_CLOUD), json!("—"), json!(45.3), json!("3/3")]);
    assert_eq!(c.checks["13"], vec![json!("Abnormal"), json!("INV Offline"), json!("—"), json!("—"), json!("offline: E1, E2"), json!(0), json!("0/3")]);
    assert_eq!(c.checks["17"], vec![dash(); 7]);
    assert_eq!(c.sources["09"], Some("google"));
    assert_eq!(c.weather_detail, "loss (13:00)");
    assert_eq!(c.yield_kwh, json!(123.5));
}

#[test]
fn plant_cells_from_an_older_doc() {
    let mut hourly = vec![json!(0); 9];
    hourly.push(json!(30));
    let doc = json!({"hourly_kw": hourly, "weather": {"has_sensor": true, "slots": {"09": {"irradiance_wm2": 700}}}});
    let c = plant_cells(day(), &doc, &info(), &[9, 13], None, &ign());
    assert_eq!(c.checks["09"], vec![json!("Normal"), json!("INV ทำงานปกติ ค่าแสง 700"), json!(700), json!(SKY_CLEAR), json!("—"), json!(30), json!("—")]);
    assert_eq!(c.checks["13"], vec![json!("—"), json!("INV Offline"), json!("—"), json!("—"), json!("offline"), json!("—"), json!("—")]);
    assert_eq!(c.sources["09"], Some("growatt"));
    assert_eq!(c.yield_kwh, dash());
}

#[test]
fn clear_sky_matches_python() {
    assert!((clear_sky(13.75, 100.5, day(), 8, 50) - 498.945_661_573_286_66).abs() < 1e-9);
}

fn s(v: &[&str]) -> Vec<Value> {
    v.iter().map(|x| json!(x)).collect()
}

#[test]
fn layout_finds_the_columns() {
    let rows = vec![
        s(&["No", "Plant", "SN", "weather Status", "Yield (kWh)", "09:00", "", "", "", "", "", "13:00", "", "", "", "", "", "17:00", "", "", "", "", "", "Firmware"]),
        s(&["", "", "", "", "", "Status", "kW", "INV online", "ค่าแสง", "สภาพอากาศ", "DATA LOG", "Status ", "kW", "INV online", "ค่าแสง", "สภาพอากาศ", "Data Log",
            "status", "kw", "inv online", "ค่าแสง", "สภาพอากาศ", "DATA  LOG"]),
    ];
    let l = layout(&rows, "t").unwrap();
    assert_eq!((l.weather, l.first, l.last, l.yield_kwh, l.firmware), (4, 4, 23, 5, 24));
    assert_eq!(l.blocks[0], Block { hour: 9, status: 6, note: 0, irr: 9, wx: 10, log: 11, kw: 7, inv: 8 });
    assert_eq!(l.blocks[2], Block { hour: 17, status: 18, note: 0, irr: 21, wx: 22, log: 23, kw: 19, inv: 20 });
    assert_eq!(layout(&rows[1..], "x").unwrap_err(), "Sheet x: no \"weather Status\" header in row 1");
}

#[test]
fn helpers_match_python() {
    assert_eq!(col_letter(1), "A");
    assert_eq!(col_letter(27), "AA");
    assert_eq!(col_letter(52), "AZ");
    assert!(py_eq(&json!(12), &json!(12.0)));
    assert_eq!(py_str(&json!(12.0)), "12.0");
    assert_eq!(py_repr(&json!(["a", 1, true])), "['a', 1, True]");
    let t = NaiveDate::from_ymd_opt(2026, 11, 28).unwrap().and_hms_opt(12, 50, 0).unwrap();
    assert_eq!(published_hours(t, 10), vec![9, 13]);
    assert_eq!(published_hours(t, 1440), vec![9, 13, 17]);
    assert!(published_hours(t, -1440).is_empty());
    assert_eq!(google_sky(Some(&json!({"condition": "WINDY", "cloud_cover_pct": 30}))), Some(SKY_CLEAR));
    assert_eq!(google_sky(Some(&json!({}))), None);
}
