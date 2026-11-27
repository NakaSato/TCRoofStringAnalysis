//! Inverter model datasheets (static metadata), keyed by Growatt's model name. Port of
//! backend/app/services/inverter_models.py: values copied from the manufacturer's datasheet as
//! printed; a value the datasheet does not give is left out (never guessed). Keep the catalog in
//! step with the Python file (sources are listed there).

use std::collections::HashMap;
use std::sync::OnceLock;

use serde_json::{json, Map, Value};

const MAX_100_125_LV_URL: &str = "https://solarmagazine.nl/u/webshop/datasheetmax100-125ktl3-x-lv.pdf";
const MAX_50_80_LV_URL: &str = "https://liriksolar.com/image/uploads/Growatt%20MAX%2080KTL3%20LV%20Datasheet.pdf";
const MID_25_40_URL: &str = "https://www.pvo-int.com/wp-content/uploads/2019/01/Datasheet-Growatt-MID-25-40KTL3-X.pdf";

/// Python `_MAX_50_80_LV`: values the MAX 50~80KTL3 LV models share
fn max_50_80_lv() -> Value {
    merged(json!({
        "manufacturer": "Growatt",
        "series": "MAX 50~80KTL3 LV",
        "datasheet_url": MAX_50_80_LV_URL,
        "max_dc_voltage_v": 1100.0,
        "start_voltage_v": 250.0,
        "mppt_voltage_min_v": 200.0,
        "mppt_voltage_max_v": 1000.0,
        "strings_per_mppt": 2,
        "max_input_current_per_mppt_a": 26.0,
        "max_short_circuit_current_per_mppt_a": 32.0,
        "nominal_ac_voltage": "220V/380V, 230V/400V",
        "ac_voltage_min_v": 340.0,
        "ac_voltage_max_v": 440.0,
        "grid_frequency": "50/60 Hz (45-55 Hz / 55-65 Hz)",
        "power_factor": "0.8 leading ... 0.8 lagging",
        "thdi_max_pct": 3.0,
        "grid_connection": "3W+N+PE",
        "mppt_efficiency_pct": 99.9,
    }), json!({
        "dc_reverse_polarity_protection": true,
        "dc_switch": true,
        "surge_protection": "AC Type II / DC Type II",
        "insulation_resistance_monitoring": true,
        "ac_short_circuit_protection": true,
        "ground_fault_monitoring": true,
        "grid_monitoring": true,
        "anti_islanding_protection": true,
        "residual_current_monitoring": true,
        "string_detection": true,
        "afci": "optional",
        "width_mm": 860.0,
        "height_mm": 600.0,
        "depth_mm": 300.0,
        "operating_temp_min_c": -25.0,
        "operating_temp_max_c": 60.0,
        "night_consumption_w_max": 1.0,
        "topology": "Transformerless",
        "cooling": "Smart air cooling",
        "protection_degree": "IP65",
        "relative_humidity": "0-100%",
        "max_altitude_m": 4000.0,
        "dc_connection": "H4/MC4 (optional)",
        "ac_connection": "Cable gland + OT terminal",
        "display": "LED / WiFi + APP",
        "interfaces": "RS485, USB; WiFi / RF / GPRS optional",
        "warranty": "5 years (10 years optional)",
        "certifications": [
            "CE", "VDE0126", "Greece", "EN50438", "EN50549-1", "C10/C11", "UTE C 15-712", "IEC62116",
            "IEC61727", "IEC 60068", "IEC 61683", "CEI0-21", "CEI 0-16", "N4105", "DRRG", "G98/G99",
            "G100", "NRS 097-2-1", "MEA", "PEA", "KSC8565",
        ],
    }))
}

/// `{**base, **extra}`
fn merged(base: Value, extra: Value) -> Value {
    let mut m: Map<String, Value> = base.as_object().cloned().unwrap_or_default();
    if let Value::Object(e) = extra {
        m.extend(e);
    }
    Value::Object(m)
}

/// Python `INVERTER_MODELS`
fn catalog() -> Vec<(&'static str, Value)> {
    vec![
        (
            "MID 40KTL3-X",
            merged(json!({
                "manufacturer": "Growatt",
                "model": "MID 40KTL3-X",
                "series": "MID 25~40KTL3-X",
                "datasheet_url": MID_25_40_URL,
                "datasheet_status": "preliminary",
                "max_pv_power_w": 60000.0,
                "max_dc_voltage_v": 1100.0,
                "start_voltage_v": 250.0,
                "nominal_dc_voltage_v": 600.0,
                "mppt_voltage_min_v": 200.0,
                "mppt_voltage_max_v": 1000.0,
                "mppt_count": 4,
                "strings_per_mppt": 2,
                "max_input_current_per_mppt_a": 26.0,
                "max_short_circuit_current_per_mppt_a": 32.0,
                "rated_power_w": 40000.0,
                "max_apparent_power_va": 44000.0,
                "nominal_ac_voltage": "220V/380V, 230V/400V",
                "ac_voltage_min_v": 340.0,
                "ac_voltage_max_v": 440.0,
                "grid_frequency": "50/60 Hz (45-55 Hz / 55-65 Hz)",
                "max_output_current_a": 66.6,
                "power_factor": "0.8 leading ... 0.8 lagging",
                "thdi_max_pct": 3.0,
                "grid_connection": "3W+N+PE",
                "max_efficiency_pct": 98.8,
                "euro_efficiency_pct": 98.5,
                "mppt_efficiency_pct": 99.9,
            }), json!({
                "dc_reverse_polarity_protection": true,
                "dc_switch": true,
                "surge_protection": "AC Type II / DC Type II",
                "insulation_resistance_monitoring": true,
                "ac_short_circuit_protection": true,
                "ground_fault_monitoring": true,
                "grid_monitoring": true,
                "anti_islanding_protection": true,
                "residual_current_monitoring": true,
                "string_detection": true,
                "afci": "optional",
                "width_mm": 580.0,
                "height_mm": 435.0,
                "depth_mm": 230.0,
                "weight_kg": 30.5,
                "operating_temp_min_c": -25.0,
                "operating_temp_max_c": 60.0,
                "night_consumption_w_max": 1.0,
                "topology": "Transformerless",
                "cooling": "Smart air cooling",
                "protection_degree": "IP66",
                "relative_humidity": "0-100%",
                "max_altitude_m": 4000.0,
                "dc_connection": "H4/MC4 (optional)",
                "ac_connection": "Cable gland + OT terminal",
                "display": "OLED + LED / WiFi + APP",
                "interfaces": "RS485, USB; WiFi / GPRS / RF / LAN optional",
                "warranty": "5 years (10 years optional)",
                "certifications": [
                    "CE", "VDE0126", "Greece", "EN50549", "C10/C11", "UTE C 15-712", "IEC62116", "IEC61727",
                    "IEC 60068", "IEC 61683", "CEI0-21", "CEI0-16", "N4105", "TOR Erzeuger", "G98/G99", "G100",
                    "AS/NZS 3100", "AS4777", "UNE217001", "UNE206007", "PO12.2", "KSC8565",
                ],
            })),
        ),
        (
            "MAX 60KTL3 LV",
            merged(
                max_50_80_lv(),
                json!({
                    "model": "MAX 60KTL3 LV",
                    "max_pv_power_w": 90000.0,
                    "nominal_dc_voltage_v": 585.0,
                    "mppt_count": 6,
                    "rated_power_w": 60000.0,
                    "max_apparent_power_va": 66600.0,
                    "max_output_current_a": 96.6,
                    "max_efficiency_pct": 98.8,
                    "euro_efficiency_pct": 98.4,
                    "weight_kg": 82.0,
                }),
            ),
        ),
        (
            "MAX 80KTL3 LV",
            merged(
                max_50_80_lv(),
                json!({
                    "model": "MAX 80KTL3 LV",
                    "max_pv_power_w": 120000.0,
                    "nominal_dc_voltage_v": 600.0,
                    "mppt_count": 7,
                    "rated_power_w": 80000.0,
                    "max_apparent_power_va": 88800.0,
                    "max_output_current_a": 128.8,
                    "max_efficiency_pct": 99.0,
                    "euro_efficiency_pct": 98.5,
                    "weight_kg": 86.0,
                }),
            ),
        ),
        (
            "MAX 125KTL3-X LV",
            merged(json!({
                "manufacturer": "Growatt",
                "model": "MAX 125KTL3-X LV",
                "series": "MAX 100~125KTL3-X LV",
                "datasheet_url": MAX_100_125_LV_URL,
                "max_dc_voltage_v": 1100.0,
                "start_voltage_v": 195.0,
                "nominal_dc_voltage_v": 600.0,
                "mppt_voltage_min_v": 180.0,
                "mppt_voltage_max_v": 1000.0,
                "mppt_count": 10,
                "strings_per_mppt": 2,
                "max_input_current_per_mppt_a": 32.0,
                "max_short_circuit_current_per_mppt_a": 40.0,
                "rated_power_w": 125000.0,
                "max_apparent_power_va": 137500.0,
                "nominal_ac_voltage": "230V/400V",
                "ac_voltage_min_v": 340.0,
                "ac_voltage_max_v": 440.0,
                "grid_frequency": "50/60 Hz (45-55 Hz / 55-65 Hz)",
                "max_output_current_a": 198.5,
                "power_factor": "0.8 leading ... 0.8 lagging",
                "thdi_max_pct": 3.0,
                "grid_connection": "3W/N/PE",
                "max_efficiency_pct": 98.8,
                "euro_efficiency_pct": 98.5,
                "mppt_efficiency_pct": 99.9,
            }), json!({
                "dc_reverse_polarity_protection": true,
                "dc_switch": true,
                "surge_protection": "AC Type II / DC Type II",
                "insulation_resistance_monitoring": true,
                "ac_short_circuit_protection": true,
                "ground_fault_monitoring": true,
                "string_detection": true,
                "anti_pid": "optional",
                "afci": "optional",
                "width_mm": 970.0,
                "height_mm": 640.0,
                "depth_mm": 345.0,
                "weight_kg": 84.0,
                "operating_temp_min_c": -30.0,
                "operating_temp_max_c": 60.0,
                "night_consumption_w_max": 1.0,
                "topology": "Transformerless",
                "cooling": "Smart Cooling",
                "protection_degree": "IP66",
                "relative_humidity": "0~100%",
                "max_altitude_m": 4000.0,
                "dc_connection": "H4/MC4 (max. 6 mm²)",
                "ac_connection": "OT terminal (max. 240 mm²)",
                "display": "LED / WiFi + APP",
                "interfaces": "RS485, USB; PLC / GPRS / 4G / WiFi optional",
                "warranty": "5 years (10 years optional)",
                "certifications": [
                    "CE", "IEC62116", "IEC61727", "CQC", "VDE0126", "VFR2019", "EN50549-1/2", "C10/C11",
                    "UNE206007", "G99", "CEI 0-21/0-16", "N4105&N4110", "UNE206006", "MEA", "PEA", "KSC8565",
                ],
            })),
        ),
    ]
}

/// Python `_key`: Growatt writes the same model with or without spaces ("MAX 125KTL3-X LV",
/// "MAX125KTL3-XLV"); whitespace and `_` are dropped, letters upper-cased.
fn key(name: &str) -> String {
    name.chars().filter(|c| !c.is_whitespace() && *c != '_').collect::<String>().to_uppercase()
}

/// Python `_BY_KEY`
fn by_key() -> &'static HashMap<String, Value> {
    static BY_KEY: OnceLock<HashMap<String, Value>> = OnceLock::new();
    BY_KEY.get_or_init(|| catalog().into_iter().map(|(k, v)| (key(k), v)).collect())
}

/// Python `inverter_models.model_spec`: the datasheet of a Growatt model name (a copy), or None
/// for a model not in the catalog.
pub fn model_spec(device_model: Option<&str>) -> Option<Value> {
    let name = device_model.filter(|s| !s.is_empty())?;
    by_key().get(&key(name)).cloned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lookup_ignores_spaces_and_case() {
        let a = model_spec(Some("MAX 125KTL3-X LV")).unwrap();
        assert_eq!(a["mppt_count"], 10);
        assert_eq!(model_spec(Some("max125ktl3-x_lv")).unwrap(), a);
        assert!(model_spec(Some("MAX 999")).is_none());
        assert!(model_spec(Some("")).is_none() && model_spec(None).is_none());
        let m60 = model_spec(Some("MAX 60KTL3 LV")).unwrap();
        assert_eq!(m60["strings_per_mppt"], 2);
        assert_eq!(m60["model"], "MAX 60KTL3 LV");
        assert_eq!(m60["series"], "MAX 50~80KTL3 LV");
    }
}
