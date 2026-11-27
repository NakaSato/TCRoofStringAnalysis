//! The Rust side of the Growatt sync golden comparison (rust/tests/growatt_sync_golden/run.sh):
//! runs the steps of one scenario of `scenarios.json` with the Rust ports, against the stub, with
//! every pause off, and prints one JSON line per step, as `golden.py run` does for Python.
//!
//!     cargo run -p tcroof-services --example growatt_sync_golden -- <scenario> <db_url> <stub_url> <today>

use chrono::NaiveDate;
use serde_json::{json, Value};
use tcroof_clients::growatt::{GrowattClient, GrowattClientOptions};
use tcroof_services::alarm_sync::{sync_alarms, AlarmInverter, Tiers};
use tcroof_services::growatt_energy_sync::{backfill_plant_energy, sync_growatt_energy, ENERGY_LOOKBACK_DAYS, CURVE_DAYS, MAX_RATE_LIMITED};
use tcroof_services::growatt_sync::inverters::default_overlap;
use tcroof_services::growatt_sync::{self as gs, SyncOptions};

fn day_of(v: &Value, today: NaiveDate) -> NaiveDate {
    let s = v.as_str().expect("a day");
    if s == "D" {
        today
    } else if let Some(n) = s.strip_prefix("D-") {
        today - chrono::Duration::days(n.parse().expect("an offset"))
    } else {
        NaiveDate::parse_from_str(s, "%Y-%m-%d").expect("a date")
    }
}

#[tokio::main]
async fn main() {
    let args: Vec<String> = std::env::args().collect();
    let (scenario, db_url, stub, today) = (&args[1], &args[2], &args[3], &args[4]);
    let today = NaiveDate::parse_from_str(today, "%Y-%m-%d").expect("today");
    let here = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/growatt_sync_golden/scenarios.json");
    let doc: Value = serde_json::from_str(&std::fs::read_to_string(here).expect("scenarios.json")).expect("json");
    let steps = doc["scenarios"][scenario.as_str()].as_array().expect("a scenario").clone();
    let pool = sqlx::postgres::PgPoolOptions::new().max_connections(4).connect(db_url).await.expect("database");
    let client = |n: i64| {
        GrowattClient::new(&format!("tok-p{n}"), GrowattClientOptions { base_url: stub.clone(), ..Default::default() }).expect("client")
    };
    let clients = [client(1), client(2)];
    for (i, step) in steps.iter().enumerate() {
        let a = &step["args"];
        let opts = SyncOptions {
            sleep: false,
            history_store_raw: step["store_raw"].as_bool().unwrap_or(false),
            meter_history_enabled: step["meter_history"].as_bool().unwrap_or(true),
        };
        let c = &clients[(step["account"].as_i64().unwrap_or(1) - 1) as usize];
        let ph = a["phase"].as_i64().map(|p| p as i32);
        let ut = a["include_untagged"].as_bool().unwrap_or(false);
        let fname = step["fn"].as_str().expect("fn");
        let ov = default_overlap();
        let res: Result<Value, String> = match fname {
            "remove_blocked_plants" => {
                let ids: Vec<i64> = a["plant_ids"].as_array().unwrap().iter().filter_map(Value::as_i64).collect();
                gs::remove_blocked_plants(&pool, &ids).await.map(|v| json!(v)).map_err(|e| e.to_string())
            }
            "sync_fleet" => gs::sync_fleet(&pool, c, &opts, 0.0, ph).await.map(|v| json!(v)).map_err(|e| e.to_string()),
            "sync_incremental" => {
                let batch = a["batch_size"].as_u64().unwrap_or(0) as usize;
                gs::sync_incremental(&pool, c, &opts, today, ov, 7, 0.0, ph, ut, batch).await.map_err(|e| e.to_string())
            }
            "sync_env_incremental" => {
                let retries = a["retries"].as_u64().unwrap_or(3) as usize;
                let mrl = a["max_rate_limited"].as_u64().map(|v| v as usize);
                gs::sync_env_incremental(&pool, c, &opts, today, ov, 7, 0.0, ph, ut, retries, mrl).await.map_err(|e| e.to_string())
            }
            "sync_meter_incremental" => {
                gs::sync_meter_incremental(&pool, c, &opts, today, ov, 7, 0.0, ph, ut).await.map_err(|e| e.to_string())
            }
            "sync_all_history" => {
                let sns: Option<Vec<String>> =
                    a["device_sns"].as_array().map(|v| v.iter().filter_map(|s| s.as_str().map(str::to_owned)).collect());
                gs::sync_all_history(&pool, c, &opts, day_of(&a["start"], today), day_of(&a["end"], today), sns.as_deref(), 0.0, ph, ut)
                    .await
                    .map_err(|e| e.to_string())
            }
            "sync_env_all" => gs::sync_env_all(&pool, c, &opts, day_of(&a["start"], today), day_of(&a["end"], today), 0.0, ph, ut)
                .await
                .map_err(|e| e.to_string()),
            "sync_meter_all" => gs::sync_meter_all(&pool, c, &opts, day_of(&a["start"], today), day_of(&a["end"], today), 0.0, ph, ut)
                .await
                .map_err(|e| e.to_string()),
            "sync_latest_records" => {
                let first = a["first_chunk"].as_u64().unwrap_or(0) as usize;
                gs::sync_latest_records(&pool, c, &opts, today, ph, ut, first, 0.0).await.map_err(|e| e.to_string())
            }
            "sync_power_limits" => gs::sync_power_limits(&pool, c, &opts, ph, ut, None, 0.0, 3).await.map_err(|e| e.to_string()),
            "sync_growatt_energy" => {
                sync_growatt_energy(&pool, c, &opts, today, ph, ut, ENERGY_LOOKBACK_DAYS, CURVE_DAYS, 0.0, MAX_RATE_LIMITED)
                    .await
                    .map_err(|e| e.to_string())
            }
            "backfill_plant_energy" => {
                backfill_plant_energy(&pool, c, &opts, today, a["days"].as_i64().unwrap(), ph, ut, 0.0, MAX_RATE_LIMITED)
                    .await
                    .map_err(|e| e.to_string())
            }
            "sync_alarms" => {
                let tiers = a["tiers"].as_array().map(|t| Tiers {
                    hot: chrono::Duration::minutes(t[0].as_i64().unwrap()),
                    warm: chrono::Duration::minutes(t[1].as_i64().unwrap()),
                    cold: chrono::Duration::minutes(t[2].as_i64().unwrap()),
                    tick: t[3].as_i64().map(chrono::Duration::minutes),
                });
                let invs: Vec<AlarmInverter> = gs::inverters_query(&pool, ph, ut, None)
                    .await
                    .expect("inverters")
                    .into_iter()
                    .map(|i| AlarmInverter { device_sn: i.device_sn, plant_id: i.plant_id })
                    .collect();
                sync_alarms(&pool, c, &opts, day_of(&a["day"], today), &invs, 0.0, tiers, None).await.map_err(|e| e.to_string())
            }
            other => panic!("unknown fn {other}"),
        };
        let line = match res {
            Ok(v) => json!({"step": i, "fn": fname, "result": v}),
            Err(e) => json!({"step": i, "fn": fname, "error": e}),
        };
        println!("{line}");
    }
}
