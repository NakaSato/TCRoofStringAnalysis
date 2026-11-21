"""Inverter model datasheets (static metadata), keyed by Growatt's model name.

Values are copied from the manufacturer's datasheet as printed; a value the datasheet does not
give is left out (never guessed). Look a model up with `model_spec(device_model)`, where
`device_model` is Growatt's own name (`queryDeviceInfoParam`), e.g. "MAX 125KTL3-X LV".

Sources:
- MAX 125KTL3-X LV: Growatt "MAX 100~125KTL3-X LV" datasheet, Primary Specification
  (https://solarmagazine.nl/u/webshop/datasheetmax100-125ktl3-x-lv.pdf).
"""

from __future__ import annotations

import re
from typing import Any, Dict, Optional

_MAX_100_125_LV_URL = "https://solarmagazine.nl/u/webshop/datasheetmax100-125ktl3-x-lv.pdf"

INVERTER_MODELS: Dict[str, Dict[str, Any]] = {
    "MAX 125KTL3-X LV": {
        "manufacturer": "Growatt",
        "model": "MAX 125KTL3-X LV",
        "series": "MAX 100~125KTL3-X LV",
        "datasheet_url": _MAX_100_125_LV_URL,
        # Input data (DC)
        "max_dc_voltage_v": 1100.0,
        "start_voltage_v": 195.0,
        "nominal_dc_voltage_v": 600.0,
        "mppt_voltage_min_v": 180.0,
        "mppt_voltage_max_v": 1000.0,
        "mppt_count": 10,
        "strings_per_mppt": 2,
        "max_input_current_per_mppt_a": 32.0,
        "max_short_circuit_current_per_mppt_a": 40.0,
        # Output data (AC)
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
        # Efficiency
        "max_efficiency_pct": 98.8,
        "euro_efficiency_pct": 98.5,
        "mppt_efficiency_pct": 99.9,
        # Protection devices
        "dc_reverse_polarity_protection": True,
        "dc_switch": True,
        "surge_protection": "AC Type II / DC Type II",
        "insulation_resistance_monitoring": True,
        "ac_short_circuit_protection": True,
        "ground_fault_monitoring": True,
        "string_detection": True,
        "anti_pid": "optional",
        "afci": "optional",
        # General data
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
    },
}


def _key(name: str) -> str:
    """Growatt writes the same model with or without spaces ("MAX 125KTL3-X LV", "MAX125KTL3-XLV")."""
    return re.sub(r"[\s_]+", "", name).upper()


_BY_KEY = {_key(k): v for k, v in INVERTER_MODELS.items()}


def model_spec(device_model: Optional[str]) -> Optional[Dict[str, Any]]:
    """The datasheet of a Growatt model name, or None for a model not in the catalog."""
    if not device_model:
        return None
    spec = _BY_KEY.get(_key(device_model))
    return dict(spec) if spec else None
