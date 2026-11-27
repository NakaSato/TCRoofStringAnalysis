//! Integration tests of the fleet config area (routes/growatt/fleet_config.rs): fleet module,
//! string layout, the "not installed" mark, tariff and plant documents, against the parity seed
//! rows of rust/tests/parity/seed.d/60_fleet_config.sql. Run with rust/scripts/test_pg.sh.
//!
//! The expected behaviour is Python's: backend/app/api/routes/growatt/fleet_config.py and
//! documents.py, backend/app/services/{fleet_settings,growatt_layout,inverter_install,tariff,
//! plant_documents,daily_summary}.py.

mod common;
use common::*;

use std::path::PathBuf;

const SEED: &str = include_str!("../../../tests/parity/seed.d/60_fleet_config.sql");

/// A test database with the area's seed rows, the JSON sink in a fresh temporary folder
/// (Python's tests/conftest.py does the same), and the sink kind `sink`.
async fn db_with(sink: &str, creds: &str) -> Option<(TestDb, PathBuf)> {
    let dir = std::env::temp_dir().join(format!("tcroof-fc-{}-{}", std::process::id(), Utc::now().timestamp_nanos_opt().unwrap()));
    let (d, s, c) = (dir.clone(), sink.to_owned(), creds.to_owned());
    let db = TestDb::with_settings(
        move |st| {
            st.data_dir = d;
            st.publish_sink = s;
            st.firebase_credentials_file = c;
        },
        false,
    )
    .await?;
    sqlx::raw_sql(SEED).execute(&db.pool).await.expect("seed 60_fleet_config.sql");
    Some((db, dir))
}

async fn db() -> Option<(TestDb, PathBuf)> {
    db_with("json", "").await
}

async fn req(db: &TestDb, method: Method, uri: &str, tok: &str, body: Option<Value>) -> Res {
    send(&db.app, method, uri, Some(tok), body).await
}

// --------------------------------------------------------------------------- fleet module

#[tokio::test]
async fn fleet_module_default_put_and_publish() {
    let Some((db, dir)) = db().await else { return };
    let (admin, eng) = (db.admin().await, db.engineer().await);

    let r = req(&db, Method::GET, "/growatt/fleet-module", &eng, None).await;
    assert_eq!(r.status, StatusCode::OK);
    assert_eq!(r.body["source"], "default");
    assert_eq!(r.body["wp"], json!(570.0));
    assert_eq!(r.body["updated_at"], Value::Null);
    assert_eq!(send(&db.app, Method::GET, "/api/growatt/fleet-module", None, None).await.status, StatusCode::UNAUTHORIZED);

    let body = json!({"manufacturer": "Jinko", "model": "JKM580N", "wp": 580, "vmp_stc": "43.1", "rs_ohm": null});
    let r = req(&db, Method::PUT, "/growatt/fleet-module", &eng, Some(body.clone())).await;
    assert_eq!(r.status, StatusCode::FORBIDDEN);
    assert_eq!(r.body, json!({"detail": "Admin role required."}));
    let r = req(&db, Method::PUT, "/growatt/fleet-module", &admin, Some(json!({"manufacturer": "x", "model": "y", "wp": 10}))).await;
    assert_eq!(r.status, StatusCode::UNPROCESSABLE_ENTITY);

    let r = req(&db, Method::PUT, "/api/growatt/fleet-module", &admin, Some(body.clone())).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    assert_eq!(r.body["source"], "saved");
    assert_eq!(r.body["updated_by"], "admin");
    assert_eq!(r.body["wp"], json!(580.0));
    assert_eq!(r.body["vmp_stc"], json!(43.1));
    assert_eq!(r.body["rs_ohm"], Value::Null, "explicit null overrides the default");
    assert_eq!(r.body["kappa_ohm_per_k"], json!(0.0012), "absent = the model default");
    assert_eq!(r.body["datasheet_url"], Value::Null, "the whole model is saved");
    assert_eq!(r.body["published"], json!({"sink": "json", "written": 2, "deferred": false}));
    let f = std::fs::read_to_string(dir.join("firestore_export/config/fleet_module.json")).expect("JSON sink file");
    let doc: Value = serde_json::from_str(&f).unwrap();
    assert_eq!(doc["schema"], 1);
    assert_eq!(doc["model"], "JKM580N");
    assert!(doc.get("updated_at").is_none() && doc["published_at"].is_string());
    let first_at = r.body["updated_at"].clone();

    // the same save again: nothing changed, nothing written, updated_at kept (no UPDATE)
    let r = req(&db, Method::PUT, "/growatt/fleet-module", &admin, Some(body)).await;
    assert_eq!(r.body["published"], json!({"sink": "json", "written": 0, "deferred": false}));
    assert_eq!(r.body["updated_at"], first_at);
    let n: i32 = sqlx::query_scalar("SELECT writes FROM publish_write_counts WHERE sink = 'json'").fetch_one(&db.pool).await.unwrap();
    assert_eq!(n, 2);
    db.finish().await;
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn firestore_sink_failure_keeps_the_save() {
    let Some((db, dir)) = db_with("firestore", "").await else { return };
    let admin = db.admin().await;
    let r = req(&db, Method::PUT, "/growatt/fleet-module", &admin, Some(json!({"manufacturer": "A", "model": "B", "wp": 600}))).await;
    assert_eq!(r.status, StatusCode::OK);
    assert_eq!(
        r.body["published"],
        json!({"sink": null, "written": 0, "error": "Set FIREBASE_CREDENTIALS_FILE in .env to publish to Firestore."})
    );
    assert_eq!(r.body["wp"], json!(600.0));
    db.finish().await;
    let _ = std::fs::remove_dir_all(dir);
}

// --------------------------------------------------------------------------- string layout

#[tokio::test]
async fn string_layout_read_and_replace() {
    let Some((db, dir)) = db().await else { return };
    let (admin, eng) = (db.admin().await, db.engineer().await);

    let r = req(&db, Method::GET, "/growatt/plants/6001/string-layout", &admin, None).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    assert_eq!(r.body["plant_name"], "Config Alpha");
    assert_eq!(r.body["fleet_module_wp"], json!(570.0));
    let invs = r.body["inverters"].as_array().unwrap();
    assert_eq!(invs.iter().map(|i| i["device_sn"].as_str().unwrap()).collect::<Vec<_>>(), ["CFGA0001", "CFGA0002"]);
    let a = &invs[0];
    // inputs seen with current (1, 2, 3) + layout rows (1, 2, 7) − removed (4); 5 had 0 A
    let nos: Vec<i64> = a["strings"].as_array().unwrap().iter().map(|s| s["string_no"].as_i64().unwrap()).collect();
    assert_eq!(nos, [1, 2, 3, 7]);
    assert_eq!(a["removed_strings"], json!([4]));
    assert_eq!(a["strings"][0], json!({"string_no": 1, "mppt_no": 1, "modules": 18, "module_wp": null, "azimuth_deg": 180.0, "tilt_deg": 10.0, "active": true}));
    assert_eq!(a["strings"][3], json!({"string_no": 7, "mppt_no": 4, "modules": 18, "module_wp": null, "azimuth_deg": null, "tilt_deg": null, "active": false}));
    assert_eq!(a["rated_power_w"], json!(125000.0), "rated power falls back to the nominal");
    assert_eq!(a["datasheet"]["mppt_count"], 10);
    assert_eq!(invs[1]["datasheet"]["model"], "MAX 80KTL3 LV", "MAX80KTL3LV matches without spaces");

    assert_eq!(req(&db, Method::GET, "/growatt/plants/6001/string-layout", &eng, None).await.status, StatusCode::NOT_FOUND);
    let r = req(&db, Method::GET, "/growatt/plants/6999/string-layout", &admin, None).await;
    assert_eq!((r.status, r.body), (StatusCode::NOT_FOUND, json!({"detail": "Plant 6999 not found"})));
    let r = req(&db, Method::GET, "/growatt/plants/6002/string-layout", &eng, None).await;
    assert_eq!(r.body["inverters"][0]["datasheet"], Value::Null);

    let put = |body: Value| req(&db, Method::PUT, "/growatt/plants/6001/string-layout", &admin, Some(body));
    let r = put(json!([{"device_sn": "CFGA0001", "string_no": 1, "modules": 18}, {"device_sn": "CFGA0001", "string_no": 1, "removed": true}])).await;
    assert_eq!((r.status, r.body), (StatusCode::UNPROCESSABLE_ENTITY, json!({"detail": "Duplicate entry for CFGA0001 string 1"})));
    let r = put(json!([{"device_sn": "CFGB0001", "string_no": 1, "modules": 18}])).await;
    assert_eq!(r.body, json!({"detail": "Inverter CFGB0001 does not belong to plant 6001"}));
    assert_eq!(put(json!([{"device_sn": "CFGA0001", "string_no": 1}])).await.status, StatusCode::UNPROCESSABLE_ENTITY);

    let r = put(json!([
        {"device_sn": "CFGA0001", "string_no": 1, "modules": 18, "azimuth_deg": 90},
        {"device_sn": "CFGA0001", "string_no": 5, "removed": true},
        {"device_sn": "CFGA0002", "string_no": 3, "modules": "17", "module_wp": 575.5},
        {"device_sn": "CFGA0003", "string_no": 1, "modules": 10},
    ]))
    .await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    assert_eq!(r.body["published"], json!({"sink": "json", "written": 3, "deferred": false}));
    let a = &r.body["inverters"][0];
    assert_eq!(a["removed_strings"], json!([5]), "the old mark (4) was cleared");
    let nos: Vec<i64> = a["strings"].as_array().unwrap().iter().map(|s| s["string_no"].as_i64().unwrap()).collect();
    assert_eq!(nos, [1, 2, 3, 4], "layout rows 2 and 7 cleared; 4 is back (it carried current)");
    // Firestore inverter docs carry the topology
    let doc: Value =
        serde_json::from_str(&std::fs::read_to_string(dir.join("firestore_export/inverters/CFGA0002.json")).unwrap()).unwrap();
    assert_eq!(doc["strings"], json!([{"string_no": 3, "modules": 17, "module_wp": 575.5, "mppt": 2}]));
    assert_eq!(doc["inputs"], json!({"mppt_count": 7, "strings_per_mppt": 2}));
    assert_eq!(doc["device_model"], "MAX80KTL3LV");
    let doc: Value =
        serde_json::from_str(&std::fs::read_to_string(dir.join("firestore_export/inverters/CFGA0003.json")).unwrap()).unwrap();
    assert_eq!(doc["not_installed"], true);
    assert_eq!(doc["device_types"], json!([]));
    db.finish().await;
    let _ = std::fs::remove_dir_all(dir);
}

// --------------------------------------------------------------------------- not installed

#[tokio::test]
async fn inverter_installed_mark_and_clear() {
    let Some((db, dir)) = db().await else { return };
    let (admin, eng) = (db.admin().await, db.engineer().await);
    let uri = "/growatt/plants/6001/inverters/CFGA0002/installed";
    assert_eq!(req(&db, Method::PUT, uri, &eng, Some(json!({"installed": false}))).await.status, StatusCode::FORBIDDEN);
    let r = req(&db, Method::PUT, "/growatt/plants/6002/inverters/CFGA0002/installed", &admin, Some(json!({"installed": false}))).await;
    assert_eq!(r.body, json!({"detail": "Inverter CFGA0002 not found on plant 6002"}));

    let r = req(&db, Method::PUT, uri, &admin, Some(json!({"installed": false, "note": "  roof B "}))).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    assert_eq!(r.body["issues_closed"], 2);
    assert_eq!(r.body["inverter"]["not_installed"]["by"], "admin");
    assert_eq!(r.body["inverter"]["not_installed"]["note"], "roof B");
    let at = r.body["inverter"]["not_installed"]["at"].clone();
    let (st, reason): (String, Option<String>) =
        sqlx::query_as("SELECT status, close_reason FROM growatt_issues WHERE device_sn = 'CFGA0002' AND rule = 'R1'")
            .fetch_one(&db.pool)
            .await
            .unwrap();
    assert_eq!((st.as_str(), reason.as_deref()), ("dismissed", Some("not_installed")));

    let r = req(&db, Method::PUT, uri, &admin, Some(json!({"installed": false}))).await;
    assert_eq!(r.body["issues_closed"], 0);
    assert_eq!(r.body["inverter"]["not_installed"]["at"], at, "the first mark time is kept");
    assert_eq!(r.body["inverter"]["not_installed"]["note"], Value::Null);

    let r = req(&db, Method::PUT, uri, &admin, Some(json!({"installed": true}))).await;
    assert_eq!(r.body["inverter"]["not_installed"], Value::Null);
    assert_eq!(r.body["issues_closed"], 0);
    assert_eq!(r.body["published"]["sink"], "json");
    db.finish().await;
    let _ = std::fs::remove_dir_all(dir);
}

// --------------------------------------------------------------------------- tariff

#[tokio::test]
async fn tariff_put_scope_pwa_rates_and_day_rates() {
    let Some((db, dir)) = db().await else { return };
    let (admin, eng) = (db.admin().await, db.engineer().await);

    let r = req(&db, Method::GET, "/growatt/tariff", &admin, None).await;
    assert_eq!(r.body["source"], "default");
    assert_eq!(r.body["pwa_contract"]["plant_ids"], json!([6001, 6002]));
    assert_eq!(r.body["pwa_contract"]["book_price_thb_per_kwh"], json!(2.7647));
    let r = req(&db, Method::GET, "/growatt/tariff", &eng, None).await;
    assert_eq!(r.body["pwa_contract"]["plant_ids"], json!([6002]));

    let t = json!({"on_peak_thb": 4.5, "off_peak_thb": "2.7", "ft_thb": -0.1, "on_peak_days": [4, 2, 2, 0],
        "holidays": ["2026-12-31", " 20261205 ", "", "2026-W53-4"],
        "plant_rates": {"6002": {"thb_per_kwh": 3.25, "basis": "PPA"}, "42": {"thb_per_kwh": 2}}});
    assert_eq!(req(&db, Method::PUT, "/growatt/tariff", &eng, Some(t.clone())).await.status, StatusCode::FORBIDDEN);
    let mut bad = t.clone();
    bad["on_peak_days"] = json!([7]);
    assert_eq!(req(&db, Method::PUT, "/growatt/tariff", &admin, Some(bad)).await.status, StatusCode::UNPROCESSABLE_ENTITY);
    let r = req(&db, Method::PUT, "/growatt/tariff", &admin, Some(t)).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    assert_eq!(r.body["on_peak_days"], json!([0, 2, 4]));
    assert_eq!(r.body["holidays"], json!(["2026-12-05", "2026-12-31"]));
    assert_eq!(r.body["valid_from"], Value::Null);
    assert_eq!(r.body["plant_rates"]["42"], json!({"thb_per_kwh": 2.0, "basis": null}));
    // both config docs: neither was published before
    assert_eq!(r.body["published"]["written"], 2);

    let r = req(&db, Method::GET, "/growatt/tariff", &eng, None).await;
    let keys: Vec<&String> = r.body["plant_rates"].as_object().unwrap().keys().collect();
    assert_eq!(keys, ["6002"], "an engineer sees the rates of the assigned plants only");

    let r = req(&db, Method::POST, "/growatt/tariff/pwa-rates", &admin, None).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    assert_eq!((r.body["added"].clone(), r.body["kept"].clone(), r.body["applied"].clone()), (json!(1), json!(2), json!(true)));
    assert_eq!(r.body["plants"], json!([6001]));
    assert_eq!(r.body["tariff"]["plant_rates"]["6001"], json!({"thb_per_kwh": 2.7647, "basis": "PWA contract"}));
    assert_eq!(r.body["published"]["written"], 1);
    let r = req(&db, Method::POST, "/growatt/tariff/pwa-rates", &admin, None).await;
    assert_eq!((r.body["applied"].clone(), r.body["published"].clone()), (json!(false), Value::Null));

    let r = req(&db, Method::GET, "/growatt/tariff/rates?day=2026-11-26", &admin, None).await;
    assert_eq!(r.body["day"], "2026-11-26");
    assert_eq!(r.body["plants"]["6001"], json!({"thb_per_kwh": 2.7647, "on_peak_share": null, "basis": "plant_rate"}));
    assert_eq!(r.body["plants"]["6003"], json!({"thb_per_kwh": 2.6, "on_peak_share": null, "basis": "off_peak_unknown_split"}));
    assert_eq!(r.body["meta"], json!({"source": "db", "estimated": true}));
    let r = req(&db, Method::GET, "/growatt/tariff/rates", &eng, None).await;
    let mut keys: Vec<&String> = r.body["plants"].as_object().unwrap().keys().collect();
    keys.sort();
    assert!(keys.contains(&&"6002".to_string()) && !keys.contains(&&"6001".to_string()));
    assert_eq!(req(&db, Method::GET, "/growatt/tariff/rates?day=x", &admin, None).await.status, StatusCode::UNPROCESSABLE_ENTITY);
    db.finish().await;
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn tariff_rates_tou_share() {
    let Some((db, dir)) = db().await else { return };
    let admin = db.admin().await;
    // a Thursday: on-peak 09:00–22:00; CFGA0001 has 8 slots at 20 kW before 09:00 and 9 at 60 kW after
    sqlx::raw_sql(
        "DELETE FROM growatt_inverter_readings WHERE device_sn = 'CFGA0001' \
           AND timestamp::date <> (now() AT TIME ZONE 'Asia/Bangkok')::date; \
         UPDATE growatt_inverter_readings SET timestamp = date '2026-11-26' + timestamp::time WHERE device_sn = 'CFGA0001'",
    )
    .execute(&db.pool)
    .await
    .unwrap();
    let r = req(&db, Method::GET, "/growatt/tariff/rates?day=2026-11-26", &admin, None).await;
    let p = &r.body["plants"]["6001"];
    assert_eq!(p["basis"], "tou");
    assert_eq!(p["on_peak_share"], json!(0.771));
    sqlx::query("UPDATE growatt_inverter_readings SET timestamp = timestamp + interval '2 days' WHERE device_sn = 'CFGA0001'")
        .execute(&db.pool)
        .await
        .unwrap();
    let r = req(&db, Method::GET, "/growatt/tariff/rates?day=2026-11-28", &admin, None).await;
    assert_eq!(r.body["plants"]["6001"]["on_peak_share"], json!(0.0), "Saturday: off-peak all day");
    db.finish().await;
    let _ = std::fs::remove_dir_all(dir);
}

// --------------------------------------------------------------------------- documents

#[tokio::test]
async fn plant_documents_crud_and_import() {
    let Some((db, dir)) = db().await else { return };
    let (admin, eng) = (db.admin().await, db.engineer().await);

    let r = req(&db, Method::GET, "/growatt/documents", &eng, None).await;
    let plants = r.body["plants"].as_array().unwrap();
    assert_eq!(plants.iter().map(|p| p["plant_id"].as_i64().unwrap()).filter(|p| *p >= 6000).collect::<Vec<_>>(), [6002, 6003]);
    assert_eq!(r.body["kinds"], json!(["asbuilt", "site_photos"]));
    let b = plants.iter().find(|p| p["plant_id"] == 6002).unwrap();
    assert_eq!(b["asbuilt"], Value::Null);
    assert_eq!(b["site_photos"]["updated_at"], "2026-11-21T04:00:00.500000+00:00");
    assert_eq!(req(&db, Method::GET, "/growatt/plants/6001/documents", &eng, None).await.status, StatusCode::NOT_FOUND);
    let r = req(&db, Method::GET, "/growatt/plants/6998/documents", &admin, None).await;
    assert_eq!(r.body, json!({"plant_id": 6998, "documents": {}}));

    let put = |uri: &'static str, body: Value| req(&db, Method::PUT, uri, &admin, Some(body));
    let r = put("/growatt/plants/6001/documents/plans", json!({"url": "https://a.example/x"})).await;
    assert_eq!(r.body, json!({"detail": "kind must be one of asbuilt, site_photos"}));
    let r = put("/growatt/plants/6001/documents/asbuilt", json!({"url": "http://a.example/x"})).await;
    assert_eq!(r.body, json!({"detail": "url must be an https link (at most 1000 characters)"}));
    let r = put("/growatt/plants/6999/documents/asbuilt", json!({"url": "https://a.example/x"})).await;
    assert_eq!((r.status, r.body), (StatusCode::NOT_FOUND, json!({"detail": "Plant 6999 not found"})));
    let r = put("/growatt/plants/6001/documents/asbuilt", json!({"url": " https://drive.google.com/drive/folders/ZyXwVuTsRq_-12?x ", "title": "  New "})).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    assert_eq!(r.body["source"], "manual");
    assert_eq!(r.body["title"], "New");
    assert_eq!(r.body["revision"], Value::Null);
    assert_eq!(r.body["match_score"], Value::Null);
    let drive: Option<String> = sqlx::query_scalar("SELECT drive_id FROM plant_documents WHERE plant_id = 6001 AND kind = 'asbuilt'")
        .fetch_one(&db.pool)
        .await
        .unwrap();
    assert_eq!(drive.as_deref(), Some("ZyXwVuTsRq_-12"));

    let r = req(&db, Method::DELETE, "/growatt/plants/6002/documents/site_photos", &admin, None).await;
    assert_eq!(r.body, json!({"plant_id": 6002, "kind": "site_photos", "removed": true}));
    let r = req(&db, Method::DELETE, "/growatt/plants/6002/documents/site_photos", &admin, None).await;
    assert_eq!((r.status, r.body), (StatusCode::NOT_FOUND, json!({"detail": "Plant 6002 has no site_photos link"})));

    let rows = json!({"rows": [
        {"plant_id": 6001, "kind": "asbuilt", "url": "https://drive.google.com/file/d/AAAAAAAAAAAA/view"},
        {"plant_id": "6002", "kind": "asbuilt", "url": "https://b.example/x", "title": "Beta", "match_score": 0.9},
        {"plant_id": 6002, "kind": "asbuilt", "url": "https://b.example/dup"},
        {"plant_id": 6777, "kind": "asbuilt", "url": "https://x.example/u"},
        {"plant_id": 6001, "kind": "site_photos", "url": "ftp://x"},
    ]});
    let want_errors = json!([
        "row 3: plant 6002 asbuilt given twice",
        "row 4: plant 6777 not in the registry",
        "row 5: url must be an https link (at most 1000 characters)",
    ]);
    let r = req(&db, Method::POST, "/growatt/documents/import", &admin, Some(rows.clone())).await;
    assert_eq!(r.body, json!({"applied": false, "created": 1, "updated": 0, "unchanged": 0, "kept_manual": 1, "errors": want_errors}));
    let n: i64 = sqlx::query_scalar("SELECT count(*) FROM plant_documents WHERE plant_id = 6002").fetch_one(&db.pool).await.unwrap();
    assert_eq!(n, 0, "a dry run writes nothing");
    let r = req(&db, Method::POST, "/growatt/documents/import?apply=true", &admin, Some(rows.clone())).await;
    assert_eq!(r.body["created"], 1);
    let r = req(&db, Method::POST, "/growatt/documents/import?apply=yes", &admin, Some(rows)).await;
    assert_eq!((r.body["created"].clone(), r.body["unchanged"].clone()), (json!(0), json!(1)));
    assert_eq!(
        req(&db, Method::POST, "/growatt/documents/import?apply=maybe", &admin, Some(json!({"rows": []}))).await.status,
        StatusCode::UNPROCESSABLE_ENTITY
    );
    assert_eq!(req(&db, Method::POST, "/growatt/documents/import", &eng, Some(json!({"rows": []}))).await.status, StatusCode::FORBIDDEN);
    db.finish().await;
    let _ = std::fs::remove_dir_all(dir);
}
