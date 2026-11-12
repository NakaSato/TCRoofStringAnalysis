from __future__ import annotations

from dataclasses import dataclass, field
from typing import Dict, List, Optional
import pandas as pd


@dataclass
class StringSpec:
    """Configuration and metadata for an individual PV string."""
    string_id: str
    inverter_id: str = "INV-01"
    mppt_id: str = "MPPT-1"
    modules_per_string: int = 18
    module_wp: float = 550.0  # Watts peak per module
    voc_stc: float = 49.8     # Open-circuit voltage per module (V)
    vmp_stc: float = 41.9     # Maximum power voltage per module (V)
    isc_stc: float = 13.98    # Short-circuit current per module (A)
    imp_stc: float = 13.13    # Maximum power current per module (A)
    temp_coeff_pmax: float = -0.0035  # -0.35% / °C
    temp_coeff_voc: float = -0.0027   # -0.27% / °C
    temp_coeff_isc: float = 0.00048   # +0.048% / °C

    @property
    def capacity_kwp(self) -> float:
        return (self.modules_per_string * self.module_wp) / 1000.0

    @property
    def string_vmp_stc(self) -> float:
        return self.modules_per_string * self.vmp_stc

    @property
    def string_voc_stc(self) -> float:
        return self.modules_per_string * self.voc_stc


@dataclass
class PlantConfig:
    """Overall PV plant configuration."""
    plant_name: str = "TC Roof Solar PV Plant"
    location: str = "Bangkok, Thailand"
    latitude: float = 13.7563
    longitude: float = 100.5018
    system_loss_factor: float = 0.04  # Inverter + cabling loss (4%)
    underperformance_threshold_pct: float = 10.0  # Flag strings >10% below peer median
    zero_current_threshold_a: float = 0.25        # Current < 0.25A when POA > 150 W/m²
    min_irradiance_for_anomaly_wm2: float = 150.0
    strings: Dict[str, StringSpec] = field(default_factory=dict)

    @property
    def total_capacity_kwp(self) -> float:
        return sum(s.capacity_kwp for s in self.strings.values())


# Standard canonical DataFrame columns used across the project:
# - timestamp (datetime64[ns])
# - inverter_id (str)
# - mppt_id (str)
# - string_id (str)
# - voltage_v (float)
# - current_a (float)
# - power_w (float)
# - irradiance_wm2 (float)  [Plane of Array Irradiance W/m²]
# - module_temp_c (float)   [Module temperature °C]
# - ambient_temp_c (float)  [Ambient temperature °C]
CANONICAL_COLUMNS = [
    "timestamp",
    "inverter_id",
    "mppt_id",
    "string_id",
    "voltage_v",
    "current_a",
    "power_w",
    "irradiance_wm2",
    "module_temp_c",
    "ambient_temp_c",
]
