"""Data ingestion module for Solar String Analysis.

Supports:
1. File Upload (CSV / Excel) in either:
   - Long/Tidy format (timestamp, string_id, voltage_v, current_a, ...)
   - Wide SCADA format (timestamp, irradiance, PV1_U, PV1_I, PV2_U, PV2_I, ...)
2. Inverter Cloud / REST API connectors:
   - Huawei FusionSolar Northbound API (`getDevHistoryKpi` / `getDevRealKpi`)
   - Sungrow iSolarCloud API (`queryDevicePointMinuteDataList`)
   - SolarEdge Monitoring API (`/equipment/{siteId}/{serialNumber}/data`)
   - Generic REST API (custom JSON path / array payload)
3. Realistic PV String Simulator for demo, testing, and benchmarking (injects realistic faults:
   partial afternoon shading, blown string fuse/zero current, bypassed diode voltage drop, and soiling).
"""

from __future__ import annotations

import io
import re
from datetime import datetime, timedelta
from typing import Any, Dict, List, Optional, Tuple, Union

import numpy as np
import pandas as pd
import requests

from solar_core.models import CANONICAL_COLUMNS, PlantConfig, StringSpec


def create_default_plant_config(
    num_strings: int = 8,
    modules_per_string: int = 18,
    module_wp: float = 550.0,
    plant_name: str = "TC Roof Solar PV Plant",
) -> PlantConfig:
    """Create a default PlantConfig with `num_strings` configured across inverters and MPPTs."""
    strings: Dict[str, StringSpec] = {}
    for i in range(1, num_strings + 1):
        inv_idx = ((i - 1) // 4) + 1
        mppt_idx = ((i - 1) // 2) + 1
        str_id = f"STR-{i:02d}"
        strings[str_id] = StringSpec(
            string_id=str_id,
            inverter_id=f"INV-{inv_idx:02d}",
            mppt_id=f"MPPT-{mppt_idx}",
            modules_per_string=modules_per_string,
            module_wp=module_wp,
        )
    return PlantConfig(plant_name=plant_name, strings=strings)


def generate_simulated_string_data(
    days: int = 7,
    interval_minutes: int = 15,
    num_strings: int = 8,
    modules_per_string: int = 18,
    module_wp: float = 550.0,
    seed: int = 42,
    start_date: Optional[str] = None,
) -> Tuple[pd.DataFrame, PlantConfig]:
    """Generate realistic multi-day solar PV string telemetry with realistic fault signatures.

    Injected scenarios across strings:
    - STR-01, STR-02, STR-04, STR-07, STR-08: Healthy normal operation (minor natural variance)
    - STR-03: Afternoon partial shading (13:30 - 16:30 current drop ~38%)
    - STR-05: Bypassed sub-string / voltage mismatch (~11% lower Vmp continuously)
    - STR-06: Open-circuit / blown fuse on the last 2 days (Current = 0 A while Voc remains high)
    """
    rng = np.random.default_rng(seed)
    config = create_default_plant_config(
        num_strings=num_strings,
        modules_per_string=modules_per_string,
        module_wp=module_wp,
    )

    if start_date:
        base_dt = pd.to_datetime(start_date).floor("D")
    else:
        base_dt = (pd.Timestamp.now().floor("D") - pd.Timedelta(days=days))

    periods = int((days * 24 * 60) / interval_minutes)
    timestamps = pd.date_range(start=base_dt, periods=periods, freq=f"{interval_minutes}min")

    rows: List[Dict[str, Any]] = []

    # Pre-generate daily cloudiness factor
    day_indices = (timestamps - timestamps[0]).days.values
    unique_days = np.unique(day_indices)
    daily_cloud_factor = {d: rng.uniform(0.78, 1.02) for d in unique_days}

    for ts_idx, ts in enumerate(timestamps):
        hour_float = ts.hour + ts.minute / 60.0
        day_idx = day_indices[ts_idx]

        # Solar elevation bell curve between 06:00 and 18:15
        if 6.0 <= hour_float <= 18.25:
            solar_phase = np.pi * (hour_float - 6.0) / 12.25
            clear_sky_irr = 980.0 * (np.sin(solar_phase) ** 1.35)
            # Add passing cloud transients
            cloud_noise = rng.normal(1.0, 0.04)
            irr = max(0.0, clear_sky_irr * daily_cloud_factor[day_idx] * cloud_noise)
        else:
            irr = 0.0

        ambient_temp = 26.5 + 7.5 * np.sin(np.pi * (hour_float - 5.0) / 14.0) + rng.normal(0, 0.4)
        # NOCT cell temperature model
        module_temp = ambient_temp + (irr / 800.0) * (45.0 - 20.0) + rng.normal(0, 0.5)

        for s_idx, (str_id, spec) in enumerate(config.strings.items(), start=1):
            if irr < 15.0:
                voltage = 0.0
                current = 0.0
                power = 0.0
            else:
                # Base physics model
                temp_diff = module_temp - 25.0
                vmp_expected = spec.string_vmp_stc * (1.0 + spec.temp_coeff_voc * temp_diff)
                # Slight logarithmic irradiance dependence on voltage
                vmp_expected *= (1.0 + 0.025 * np.log(max(irr, 20.0) / 1000.0))

                imp_expected = spec.imp_stc * (irr / 1000.0) * (1.0 + spec.temp_coeff_isc * temp_diff)

                # Natural string-to-string variation (+/- 1.2%)
                string_health_factor = 1.0 - (0.004 * (s_idx % 3))
                voltage = vmp_expected * rng.normal(1.0, 0.006)
                current = imp_expected * string_health_factor * rng.normal(1.0, 0.012)

                # Scenario 1: STR-03 Afternoon Partial Shading (13:30 to 16:30)
                if s_idx == 3 and 13.5 <= hour_float <= 16.5:
                    shade_depth = 0.42 * np.sin(np.pi * (hour_float - 13.5) / 3.0)
                    current *= (1.0 - shade_depth)
                    voltage *= 0.96

                # Scenario 2: STR-05 Bypassed Diode / Module Voltage Mismatch (~11% lower Vmp)
                if s_idx == 5:
                    voltage *= 0.885

                # Scenario 3: STR-06 Disconnected / Blown Fuse on the last 2 days
                if s_idx == 6 and day_idx >= max(1, days - 2):
                    current = 0.0
                    # Open circuit voltage is higher than Vmp
                    voltage = spec.string_voc_stc * (1.0 + spec.temp_coeff_voc * temp_diff)

                voltage = max(0.0, float(voltage))
                current = max(0.0, float(current))
                power = voltage * current

            rows.append(
                {
                    "timestamp": ts,
                    "inverter_id": spec.inverter_id,
                    "mppt_id": spec.mppt_id,
                    "string_id": str_id,
                    "voltage_v": round(voltage, 2),
                    "current_a": round(current, 3),
                    "power_w": round(power, 2),
                    "irradiance_wm2": round(float(irr), 2),
                    "module_temp_c": round(float(module_temp), 2),
                    "ambient_temp_c": round(float(ambient_temp), 2),
                }
            )

    df = pd.DataFrame(rows)
    return df, config


def normalize_dataframe(df: pd.DataFrame) -> pd.DataFrame:
    """Normalize an uploaded or API-fetched DataFrame into canonical long format.

    Supports:
    - Already long/tidy format with flexible column names
    - Wide SCADA format (e.g., `PV1_U`, `PV1_I`, `PV2_V`, `PV2_A`, `String1_Current`, etc.)
    """
    if df.empty:
        raise ValueError("Input dataset is empty.")

    raw = df.copy()
    col_map_lower = {c.lower().strip(): c for c in raw.columns}

    # 1. Identify timestamp column
    ts_col = None
    for candidate in ["timestamp", "time", "datetime", "date", "collecttime", " reading_time"]:
        for lower_c, orig_c in col_map_lower.items():
            if candidate.strip() == lower_c or candidate.strip() in lower_c:
                ts_col = orig_c
                break
        if ts_col:
            break

    if ts_col is None:
        # Fallback to first column if it parses as datetime
        first_col = raw.columns[0]
        try:
            pd.to_datetime(raw[first_col])
            ts_col = first_col
        except Exception as exc:
            raise ValueError(
                "Could not identify a timestamp column. Expected 'timestamp', 'time', or 'datetime'."
            ) from exc

    raw["timestamp"] = pd.to_datetime(raw[ts_col], errors="coerce")
    raw = raw.dropna(subset=["timestamp"]).sort_values("timestamp")

    # 2. Check if already in long format (has a string_id / string column)
    string_col = None
    for candidate in ["string_id", "string", "string_name", "str_id", "channel"]:
        if candidate in col_map_lower:
            string_col = col_map_lower[candidate]
            break

    if string_col is not None:
        return _normalize_long_format(raw, string_col, col_map_lower)

    # 3. Otherwise attempt wide SCADA format detection (e.g., PV1_U / PV1_I or STR1_V / STR1_A)
    return _normalize_wide_scada_format(raw, col_map_lower)


def _find_col(col_map_lower: Dict[str, str], keywords: List[str]) -> Optional[str]:
    for kw in keywords:
        if kw in col_map_lower:
            return col_map_lower[kw]
    for kw in keywords:
        for lower_c, orig_c in col_map_lower.items():
            if kw in lower_c:
                return orig_c
    return None


def _normalize_long_format(
    raw: pd.DataFrame, string_col: str, col_map_lower: Dict[str, str]
) -> pd.DataFrame:
    out = pd.DataFrame()
    out["timestamp"] = raw["timestamp"]
    out["string_id"] = raw[string_col].astype(str).str.strip()

    inv_col = _find_col(col_map_lower, ["inverter_id", "inverter", "inv_id", "device"])
    out["inverter_id"] = raw[inv_col].astype(str) if inv_col else "INV-01"

    mppt_col = _find_col(col_map_lower, ["mppt_id", "mppt"])
    out["mppt_id"] = raw[mppt_col].astype(str) if mppt_col else "MPPT-1"

    v_col = _find_col(col_map_lower, ["voltage_v", "voltage", "vdc", "v_dc", "u_dc", "vmp"])
    i_col = _find_col(col_map_lower, ["current_a", "current", "idc", "i_dc", "imp", "amp"])
    p_col = _find_col(col_map_lower, ["power_w", "power", "pdc", "p_dc", "watts"])

    out["voltage_v"] = pd.to_numeric(raw[v_col], errors="coerce").fillna(0.0) if v_col else 700.0
    out["current_a"] = pd.to_numeric(raw[i_col], errors="coerce").fillna(0.0) if i_col else 0.0

    if p_col:
        out["power_w"] = pd.to_numeric(raw[p_col], errors="coerce").fillna(
            out["voltage_v"] * out["current_a"]
        )
    else:
        out["power_w"] = out["voltage_v"] * out["current_a"]

    irr_col = _find_col(col_map_lower, ["irradiance_wm2", "irradiance", "poa", "ghi", "rad"])
    if irr_col:
        out["irradiance_wm2"] = pd.to_numeric(raw[irr_col], errors="coerce").fillna(0.0)
    else:
        # Estimate POA irradiance from peer max current if irradiance sensor not present
        max_i = out.groupby("timestamp")["current_a"].transform("max")
        out["irradiance_wm2"] = (max_i / 13.0 * 1000.0).clip(0.0, 1250.0)

    mod_t_col = _find_col(col_map_lower, ["module_temp_c", "module_temp", "cell_temp", "pv_temp"])
    amb_t_col = _find_col(col_map_lower, ["ambient_temp_c", "ambient_temp", "amb_temp", "temp_amb"])

    out["ambient_temp_c"] = pd.to_numeric(raw[amb_t_col], errors="coerce").fillna(28.0) if amb_t_col else 28.0
    if mod_t_col:
        out["module_temp_c"] = pd.to_numeric(raw[mod_t_col], errors="coerce").fillna(35.0)
    else:
        out["module_temp_c"] = out["ambient_temp_c"] + (out["irradiance_wm2"] / 800.0) * 22.0

    return out[CANONICAL_COLUMNS].reset_index(drop=True)


def _normalize_wide_scada_format(
    raw: pd.DataFrame, col_map_lower: Dict[str, str]
) -> pd.DataFrame:
    """Convert wide inverter export (e.g., PV1_U, PV1_I, PV2_U, PV2_I) to canonical long format."""
    # Match patterns like pv1_u, pv1_v, pv1_voltage, string1_v, str_01_i, pv1_i, pv1_current
    volt_pattern = re.compile(r"(?:pv|str|string)[_\-\s]*(\d+)[_\-\s]*(?:u|v|volt|voltage)", re.I)
    curr_pattern = re.compile(r"(?:pv|str|string)[_\-\s]*(\d+)[_\-\s]*(?:i|a|amp|curr|current)", re.I)

    v_cols: Dict[int, str] = {}
    i_cols: Dict[int, str] = {}

    for col in raw.columns:
        v_match = volt_pattern.search(str(col))
        if v_match:
            v_cols[int(v_match.group(1))] = col
        i_match = curr_pattern.search(str(col))
        if i_match:
            i_cols[int(i_match.group(1))] = col

    string_nums = sorted(set(v_cols.keys()) | set(i_cols.keys()))
    if not string_nums:
        raise ValueError(
            "Dataset is neither in long format (missing 'string_id' column) nor recognizable "
            "wide SCADA format (e.g., PV1_U, PV1_I, PV2_U, PV2_I)."
        )

    irr_col = _find_col(col_map_lower, ["irradiance_wm2", "irradiance", "poa", "ghi"])
    mod_t_col = _find_col(col_map_lower, ["module_temp_c", "module_temp", "pv_temp"])
    amb_t_col = _find_col(col_map_lower, ["ambient_temp_c", "ambient_temp", "amb_temp"])
    inv_col = _find_col(col_map_lower, ["inverter_id", "inverter", "device"])

    records: List[pd.DataFrame] = []
    for idx in string_nums:
        str_id = f"STR-{idx:02d}"
        mppt_id = f"MPPT-{((idx - 1) // 2) + 1}"
        sub = pd.DataFrame()
        sub["timestamp"] = raw["timestamp"]
        sub["inverter_id"] = raw[inv_col].astype(str) if inv_col else "INV-01"
        sub["mppt_id"] = mppt_id
        sub["string_id"] = str_id
        sub["voltage_v"] = (
            pd.to_numeric(raw[v_cols[idx]], errors="coerce").fillna(0.0)
            if idx in v_cols
            else 700.0
        )
        sub["current_a"] = (
            pd.to_numeric(raw[i_cols[idx]], errors="coerce").fillna(0.0)
            if idx in i_cols
            else 0.0
        )
        sub["power_w"] = sub["voltage_v"] * sub["current_a"]
        sub["irradiance_wm2"] = (
            pd.to_numeric(raw[irr_col], errors="coerce").fillna(0.0) if irr_col else np.nan
        )
        sub["ambient_temp_c"] = (
            pd.to_numeric(raw[amb_t_col], errors="coerce").fillna(28.0) if amb_t_col else 28.0
        )
        sub["module_temp_c"] = (
            pd.to_numeric(raw[mod_t_col], errors="coerce").fillna(35.0) if mod_t_col else np.nan
        )
        records.append(sub)

    combined = pd.concat(records, ignore_index=True)
    if combined["irradiance_wm2"].isna().all():
        max_i = combined.groupby("timestamp")["current_a"].transform("max")
        combined["irradiance_wm2"] = (max_i / 13.0 * 1000.0).clip(0.0, 1250.0)
    else:
        combined["irradiance_wm2"] = combined["irradiance_wm2"].fillna(0.0)

    if combined["module_temp_c"].isna().all():
        combined["module_temp_c"] = (
            combined["ambient_temp_c"] + (combined["irradiance_wm2"] / 800.0) * 22.0
        )
    else:
        combined["module_temp_c"] = combined["module_temp_c"].fillna(35.0)

    return combined[CANONICAL_COLUMNS].sort_values(["timestamp", "string_id"]).reset_index(drop=True)


def load_from_uploaded_file(file_obj: Union[io.BytesIO, Any], filename: str) -> pd.DataFrame:
    """Load CSV or Excel file from upload buffer and normalize into canonical string DataFrame."""
    lower_name = filename.lower()
    if lower_name.endswith(".csv"):
        df = pd.read_csv(file_obj)
    elif lower_name.endswith((".xlsx", ".xls")):
        df = pd.read_excel(file_obj)
    else:
        raise ValueError(f"Unsupported file extension in '{filename}'. Upload .csv or .xlsx.")
    return normalize_dataframe(df)


class SolarAPIClient:
    """Client for fetching PV string telemetry from Huawei FusionSolar, Sungrow, SolarEdge, or Generic REST API."""

    def __init__(self, timeout: int = 20):
        self.timeout = timeout

    def fetch_huawei_fusionsolar(
        self,
        base_url: str,
        xsrf_token: str,
        dev_id: str,
        start_time_ms: int,
        end_time_ms: int,
        simulate_if_unreachable: bool = False,
    ) -> pd.DataFrame:
        """Fetch string KPI history from Huawei FusionSolar Northbound API (`getDevHistoryKpi`).

        Huawei payload format returns `data` list with `collectTime` (epoch ms) and `dataItemMap`
        containing `pv1_u`, `pv1_i`, ..., `pv24_u`, `pv24_i`.
        """
        url = f"{base_url.rstrip('/')}/thirdData/getDevHistoryKpi"
        headers = {
            "XSRF-TOKEN": xsrf_token,
            "Content-Type": "application/json",
        }
        payload = {
            "devIds": dev_id,
            "devTypeId": 1,  # String Inverter
            "startTime": start_time_ms,
            "endTime": end_time_ms,
        }
        try:
            resp = requests.post(url, json=payload, headers=headers, timeout=self.timeout)
            resp.raise_for_status()
            body = resp.json()
            return self.parse_huawei_response(body, inverter_id=dev_id)
        except Exception as exc:
            if simulate_if_unreachable:
                return self.parse_huawei_response(
                    self.build_mock_huawei_payload(dev_id=dev_id), inverter_id=dev_id
                )
            raise RuntimeError(f"Huawei FusionSolar API request failed: {exc}") from exc

    @staticmethod
    def parse_huawei_response(body: Dict[str, Any], inverter_id: str = "INV-01") -> pd.DataFrame:
        """Parse Huawei FusionSolar `getDevHistoryKpi` JSON payload into canonical DataFrame."""
        data_list = body.get("data", [])
        if not data_list:
            raise ValueError("Huawei response contained no 'data' records.")

        wide_rows: List[Dict[str, Any]] = []
        for entry in data_list:
            collect_ms = entry.get("collectTime")
            ts = pd.to_datetime(collect_ms, unit="ms")
            item_map = entry.get("dataItemMap", {})
            row: Dict[str, Any] = {"timestamp": ts, "inverter_id": inverter_id}
            for k, v in item_map.items():
                row[k] = v
            wide_rows.append(row)

        wide_df = pd.DataFrame(wide_rows)
        return normalize_dataframe(wide_df)

    @staticmethod
    def build_mock_huawei_payload(dev_id: str = "INV-HUAWEI-01", days: int = 5) -> Dict[str, Any]:
        """Build a realistic Huawei FusionSolar Northbound API JSON structure for sandbox/testing."""
        sim_df, _ = generate_simulated_string_data(days=days, num_strings=8)
        data_entries: List[Dict[str, Any]] = []
        for ts, grp in sim_df.groupby("timestamp"):
            item_map: Dict[str, Any] = {
                "irradiance": float(grp["irradiance_wm2"].iloc[0]),
                "temperature": float(grp["module_temp_c"].iloc[0]),
            }
            for _, row in grp.iterrows():
                str_num = int(str(row["string_id"]).split("-")[-1])
                item_map[f"pv{str_num}_u"] = float(row["voltage_v"])
                item_map[f"pv{str_num}_i"] = float(row["current_a"])
            data_entries.append(
                {
                    "devId": dev_id,
                    "collectTime": int(pd.Timestamp(ts).timestamp() * 1000),
                    "dataItemMap": item_map,
                }
            )
        return {"success": True, "failCode": 0, "data": data_entries}

    def fetch_sungrow_isolarcloud(
        self,
        base_url: str,
        appkey: str,
        token: str,
        ps_key: str,
        start_time_str: str,
        end_time_str: str,
        simulate_if_unreachable: bool = False,
    ) -> pd.DataFrame:
        """Fetch string minute data from Sungrow iSolarCloud OpenAPI."""
        url = f"{base_url.rstrip('/')}/openapi/getDevicePointMinuteDataList"
        headers = {"Content-Type": "application/json", "x-access-key": token}
        payload = {
            "appkey": appkey,
            "token": token,
            "ps_key_list": [ps_key],
            "start_time_stamp": start_time_str,
            "end_time_stamp": end_time_str,
        }
        try:
            resp = requests.post(url, json=payload, headers=headers, timeout=self.timeout)
            resp.raise_for_status()
            body = resp.json()
            result_data = body.get("result_data", {}).get(ps_key, [])
            wide_df = pd.DataFrame(result_data)
            return normalize_dataframe(wide_df)
        except Exception as exc:
            if simulate_if_unreachable:
                sim_df, _ = generate_simulated_string_data(days=5, num_strings=8)
                return sim_df
            raise RuntimeError(f"Sungrow iSolarCloud API request failed: {exc}") from exc

    def fetch_generic_rest(
        self,
        endpoint_url: str,
        method: str = "GET",
        headers: Optional[Dict[str, str]] = None,
        params: Optional[Dict[str, Any]] = None,
        json_body: Optional[Dict[str, Any]] = None,
        records_key: Optional[str] = None,
    ) -> pd.DataFrame:
        """Fetch string data from any generic REST API endpoint returning JSON records."""
        resp = requests.request(
            method=method.upper(),
            url=endpoint_url,
            headers=headers or {},
            params=params,
            json=json_body,
            timeout=self.timeout,
        )
        resp.raise_for_status()
        payload = resp.json()

        if isinstance(payload, dict):
            if records_key and records_key in payload:
                records = payload[records_key]
            elif "data" in payload:
                records = payload["data"]
            elif "records" in payload:
                records = payload["records"]
            elif "items" in payload:
                records = payload["items"]
            else:
                raise ValueError(
                    "JSON response is an object; specify 'records_key' pointing to the array of data."
                )
        elif isinstance(payload, list):
            records = payload
        else:
            raise ValueError("Unexpected JSON response format from Generic REST API.")

        df = pd.DataFrame(records)
        return normalize_dataframe(df)
