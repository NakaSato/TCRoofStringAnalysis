# Implementation Guide: I–V Curve Analysis & Time-Series Performance Analysis

Status: **Implemented (Option B — Pure NumPy in `solar_core/`, no `scipy` or `pvlib` runtime dependency)** · Created 2026-11-15 · Owner: Chanthawat

This document describes the architecture, mathematical models, database schema, API endpoints, decision rules, and UI components for the two analytical capabilities implemented in the **TC Roof Solar** platform:

1. **I–V Curve Analysis (String & Module Level)** — measurement condition gating, IEC 60891 Procedure 1 STC translation, parameter extraction, single-diode fitting (`rectify_iv_curve`, `fit_sandia_simple`, `fit_desoto`), 8-signature fault classification, $\pm 3\text{–}5\%$ dead band, and two-source warranty claim verification.
2. **Time-Series Performance Analysis (Plant, Inverter & String Level)** — pre-KPI data filtering ($\text{POA } 200\text{–}1,200\text{ W/m}^2$, stale-value, clipping, and curtailment masks), temperature-corrected $\text{PR}'$, Energy Performance Index ($\text{EPI}$, Rule R10), inverter/BOS loss ($Y_a - Y_f$, Rule R11), same-orientation/tilt/module-count string peer ratio ($R_i$), low-variability irradiance gating, and string fault rules (`R1`, `R2`, `R4` with per-string voltage sensing check, `R5`, `R6`).

---

## 1. Architectural Principles & Project Rules

| Rule (`CLAUDE.md`) | How this implementation enforces it |
|---|---|
| **1. Never store realtime values** | Every time-series KPI ($\text{PR}'$, $\text{EPI}$, $Y_a - Y_f$, $R_i$) and rule (`R1`–`R18`) is computed strictly from stored, source-timestamped SQL history (`growatt_string_readings`, `growatt_inverter_readings`, `growatt_env_readings`). Every ingested I–V sweep requires an explicit measurement timestamp (`swept_at`), plane-of-array irradiance ($G$), and back-of-module temperature ($T$). |
| **2. Firestore is for daily summaries and registry only** | Raw I–V sweeps and daily rule aggregates reside in PostgreSQL/SQLite (`growatt_iv_sweeps`, `growatt_plant_daily`, `growatt_string_daily`). Fleet module temperature coefficients and warranty parameters are stored under `config/fleet_module`. |
| **3. Never invent numbers** | Missing sensor data returns `null` (rendered as `"—"` in the UI). Modelled quantities (`EPI`, `modelled_energy_kwh`, reference STC curves) are explicitly labelled `modelled`. Estimated energy losses are labelled `estimated`. |
| **Pure NumPy (`Option B`)** | All curve cleaning, IEC 60891 translation, numerical differentiation, and single-diode fitting (`fit_sandia_simple`, `fit_desoto`) are implemented in pure NumPy inside `backend/solar_core/iv_analysis.py` (~0.3–1.2 ms per curve, zero cold-start overhead on Cloud Run). |

---

## 2. I–V Curve Analysis (String & Module Level)

Core engine: [`backend/solar_core/iv_analysis.py`](../../backend/solar_core/iv_analysis.py)  
Service layer: [`backend/app/services/growatt_iv.py`](../../backend/app/services/growatt_iv.py)

### 2.1 Measurement Conditions & Quality Gate (`validate_sweep_conditions`)

An I–V curve cannot be interpreted without its measurement conditions. Every sweep must store:
- $G_1$ (`irradiance_wm2`): Plane-of-array (POA) irradiance measured with a reference cell of the same technology ($\text{W/m}^2$).
- $T_1$ (`module_temp_c`): Back-of-module temperature ($^\circ\text{C}$).
- `swept_at`: ISO-8601 timestamp of the sweep.
- $\Delta G$ (`irradiance_change_pct`, optional): Irradiance variation during the sweep ($\%$).

**Quality Gate**:
- $G_1 \ge 700\text{ W/m}^2$ (`MIN_SWEEP_IRRADIANCE_WM2 = 700.0`)
- $|\Delta G| \le 2.0\%$ during the sweep (`MAX_IRRADIANCE_CHANGE_PCT = 2.0`)
- $0\,^\circ\text{C} \le T_1 \le 95\,^\circ\text{C}$

Sweeps that fail the quality gate are stored with `quality_gate_passed = False` and explicit `gate_reasons`, and **never** recommend tickets or warranty claims (`ticket_recommended = False`, `warranty_claim_ready = False`).

### 2.2 Data Cleaning (`rectify_iv_curve`)

Before parameter extraction or STC translation, `rectify_iv_curve(voltage, current)` cleans raw $(V, I)$ arrays:
1. Drops `NaN`/`Inf` pairs and points in quadrants with $V < 0$ or $I < 0$.
2. Sorts points by ascending voltage $V$ and merges duplicate voltages by median current.
3. Anchors $(0, I_{\text{sc}})$ by linear extrapolation of the low-voltage segment and $(V_{\text{oc}}, 0)$ by linear interpolation/extrapolation of the high-voltage drop-off.

### 2.3 Translation to STC — IEC 60891 Procedure 1 (`translate_iec60891_proc1`)

Every curve is translated from measured $(G_1, T_1)$ to Standard Test Conditions ($G_2 = 1000\text{ W/m}^2$, $T_2 = 25\,^\circ\text{C}$) before any comparison:

$$I_2 = I_1 + I_{\text{sc},1}\cdot\left(\frac{G_2}{G_1} - 1\right) + \alpha\cdot(T_2 - T_1)$$

$$V_2 = V_1 - R_s\cdot(I_2 - I_1) - \kappa\cdot I_2\cdot(T_2 - T_1) + \beta\cdot(T_2 - T_1)$$

Where:
- $\alpha$ (`alpha_a_per_k`): Short-circuit current temperature coefficient ($\text{A/K}$), computed from datasheet $\alpha_{\%/\text{K}} \times I_{\text{sc,STC}}$.
- $\beta$ (`beta_v_per_k`): Open-circuit voltage temperature coefficient ($\text{V/K}$), scaled by string module count $N_s$: $\beta_{\%/\text{K}} \times N_s \cdot V_{\text{oc,mod,STC}}$.
- $R_s$ (`r_s_ohm`): String series resistance ($\Omega$), obtained from single-diode fitting or datasheet default ($N_s \cdot R_{s,\text{mod}}$).
- $\kappa$ (`kappa_ohm_per_k`): Curve correction factor ($\Omega/\text{K}$), scaled by $N_s$.

### 2.4 Extracted Parameters per Curve (`extract_iv_parameters`)

Extracted on both the measured curve and the STC-translated curve:
- $I_{\text{sc}}$ (`i_sc_a`): Short-circuit current at $V = 0\text{ V}$.
- $V_{\text{oc}}$ (`v_oc_v`): Open-circuit voltage at $I = 0\text{ A}$.
- $I_{\text{mp}}, V_{\text{mp}}, P_{\text{max}}$ (`i_mp_a`, `v_mp_v`, `p_max_w`): Maximum power point refined via parabolic vertex interpolation around the discrete peak of $P = V \cdot I$.
- $\text{FF}$ (`fill_factor`): Fill factor $\text{FF} = \frac{P_{\text{max}}}{I_{\text{sc}} \cdot V_{\text{oc}}}$.
- `slope_voc_ohm`: Inverse slope $-\left(\frac{dV}{dI}\right)_{V \to V_{\text{oc}}}$ over $[0.85\,V_{\text{oc}}, V_{\text{oc}}]$ — direct indicator of series resistance $R_s$.
- `slope_isc_ohm`: Inverse slope $-\left(\frac{dV}{dI}\right)_{V \to 0}$ over $[0, 0.25\,V_{\text{oc}}]$ — direct indicator of shunt resistance $R_{\text{sh}}$.
- `steps_count`: Number of local steps/notches or inflection regions in $\frac{dI}{dV}$ across $[0.08\,V_{\text{oc}}, 0.92\,V_{\text{oc}}]$ caused by bypass diode activation under partial shading or cell mismatch.

### 2.5 Single-Diode Model Fitting (`fit_sandia_simple`, `fit_desoto`)

- `fit_sandia_simple`: Non-iterative 5-parameter extraction ($I_L, I_o, R_s, R_{\text{sh}}, n N_s V_{\text{th}}$) from the curve asymptotes and MPP using the Lambert-W single-diode equations.
- `fit_desoto`: Refines the Sandia initial guess via damped Gauss–Newton / Levenberg–Marquardt iterations in pure NumPy, enforcing DeSoto temperature/irradiance scaling of $E_g$ and $I_o$.

### 2.6 Fault Signatures & Decision Rule (`classify_iv_fault`)

After translating to STC, $P_{\text{max,STC}}$ is compared against the age-adjusted expected power:

$$P_{\text{expected,STC}} = P_{\text{nameplate}} \times \left(1 - \text{LID}_1 - \text{years} \times d_{\text{warranty}}\right)$$

- **Dead Band**: Field I–V uncertainty of $\pm 3\text{–}5\%$ (default `dead_band_pct = 4.0`). Any deviation within the dead band without curve distortion is not a finding (`is_finding = False`, `ticket_recommended = False`).
- **8 Fault Signatures**:

| Signature ID | Observation (after STC correction) | Detection Criteria | Likely Cause |
|---|---|---|---|
| `steps_in_curve` | Steps or notches in the curve | `steps_count >= 1` | Partial shading, cell mismatch, or cracked cells forcing a bypass diode on |
| `miswiring_or_module_count` | $V_{\text{oc}}$ low by about one full module | $\Delta V_{\text{oc}} \approx -1.0 \times V_{\text{oc,mod}}$ ($\pm 35\%$), normal $I_{\text{sc}}$ | Miswiring or wrong module count |
| `bypass_diode_shorted` | $V_{\text{oc}}$ low by about $\frac{1}{3}$ of one module's $V_{\text{oc}}$ | $\Delta V_{\text{oc}} \approx -\frac{1}{3}\,V_{\text{oc,mod}}$ (or integer multiple of substrings), normal $I_{\text{sc}}$ | Shorted bypass diode, one substring bypassed |
| `pid` | $V_{\text{oc}}$ and $\text{FF}$ down, worse at low irradiance / near negative pole | $V_{\text{oc}}$ drop $> 3\%$, $\text{FF}$ drop $> 4\%$, and ($R_{\text{sh}} < 0.55\,R_{\text{sh,nom}}$ or `near_negative_pole` or `low_irradiance_worse`) | Potential Induced Degradation (PID) |
| `low_shunt_resistance` | Steeper slope near $I_{\text{sc}}$ ($R_{\text{sh}}$ down), $\text{FF}$ down | $R_{\text{sh}} < 0.50\,R_{\text{sh,nom}}$ and $\text{FF}$ drop $> 3.5\%$ | Shunting, PID, or cell cracks |
| `high_series_resistance` | Shallower slope near $V_{\text{oc}}$ ($R_s$ up), $\text{FF}$ down | $R_s > 1.45\,R_{s,\text{nom}}$ and $\text{FF}$ drop $> 3.5\%$ | Solder-bond or ribbon corrosion, bad connector, or cable problem |
| `isc_low_normal_shape` | $I_{\text{sc}}$ low, curve shape normal | $I_{\text{sc}}$ drop outside dead band, $|\Delta V_{\text{oc}}| \le \text{dead band}$, $|\Delta \text{FF}| \le 3.5\%$ | Uniform soiling, optical degradation, or irradiance sensor error (check sensor first) |
| `normal_degradation` | All parameters down a little, uniformly | Outside dead band with uniform reductions in $I_{\text{sc}}, V_{\text{oc}}, \text{FF}$ | Normal degradation; compare drop against warranty slope |

- **Two-Source Warranty Rule**:
  `warranty_claim_ready` is `True` **only** when:
  1. `quality_gate_passed` is `True`,
  2. $P_{\text{max,STC}} < P_{\text{expected,STC}} \times (1 - \text{dead\_band})$, and
  3. A second independent source confirms the finding: either **IR thermography** (`ir_confirmed = True`) or **an active time-series performance issue** on the same string (`timeseries_trend_confirmed = True`, auto-linked from open `R1`/`R4`/`R5`/`R6` issues).

---

## 3. Time-Series Performance Analysis

### 3.1 Plant & Inverter Level

Implemented in [`backend/app/services/growatt_weather.py`](../../backend/app/services/growatt_weather.py), [`backend/app/services/growatt_overview.py`](../../backend/app/services/growatt_overview.py), [`backend/app/services/growatt_daily.py`](../../backend/app/services/growatt_daily.py), and [`backend/app/services/growatt_rules.py`](../../backend/app/services/growatt_rules.py).

#### Data Filters (Applied Before Any KPI)
1. **POA Window**: Only 5-minute slots with $200 \le \text{POA} \le 1,200\text{ W/m}^2$ are included (`POA_FILTER_MIN_WM2 = 200.0`, `POA_FILTER_MAX_WM2 = 1200.0`).
2. **Stale-Value Mask**: Any run of $\ge 3$ consecutive identical non-zero sensor readings (`STALE_RUN_LEN = 3`, $|\Delta G| < 10^{-4}$) is masked out (`stale_masked_slots`).
3. **Clipping Mask**: Slots where inverter AC power is $\ge 98\%$ of `nominal_power_w` (`clipped_masked_slots`).
4. **Curtailment Mask**: Slots where `active_rate_pct < 100` (`curtailed_masked_slots`).

#### Plant & Inverter KPIs
- **Temperature-Corrected $\text{PR}'$ (`pr_temp_corrected_pct`)**:
  $$\text{PR}' = \frac{\text{PR}}{1 + \gamma\cdot(\overline{T}_{\text{mod},G} - 25\,^\circ\text{C})}$$
  where $\overline{T}_{\text{mod},G} = \frac{\sum G_t \cdot T_{\text{mod},t}}{\sum G_t}$ is the irradiance-weighted module temperature (`irradiance_weighted_tmod_c`) and $\gamma < 0$ is the module power temperature coefficient (default $-0.0034\text{ K}^{-1}$). Raw PR is never used to trigger alarms.
- **EPI — Energy Performance Index (`epi`, labelled `modelled`)**:
  $$\text{EPI} = \frac{E_{\text{measured}}}{E_{\text{modelled}}}, \quad E_{\text{modelled}} = \sum_{t \in \text{valid}} P_{\text{STC}} \cdot \frac{G_t}{1000} \cdot \left[1 + \gamma(T_{\text{mod},t} - 25\,^\circ\text{C})\right] \cdot \eta_{\text{inv,nom}} \cdot \Delta t$$
  - **Rule R10 (`EPI low`)**: Alarms when daily $\text{EPI} < \mu - 3\sigma$ for 1 day (`r10_sigma_1d = 3.0`) or $\text{EPI} < \mu - 2\sigma$ for 3 consecutive days (`r10_sigma_3d = 2.0`) relative to the plant's trailing baseline.
- **$Y_a - Y_f$ — Array Yield Minus Final Yield (`ya_minus_yf`)**:
  $$Y_a = \frac{E_{\text{DC}}}{\text{kWp}}, \quad Y_f = \frac{E_{\text{AC}}}{\text{kWp}}, \quad \text{Loss}_{\text{inv+BOS}} = Y_a - Y_f\text{ (h/d)}$$
  - **Rule R11 (`Inverter/BOS loss drift`)**: Alarms when the recent 7-day median of $(Y_a - Y_f)$ exceeds the prior baseline median by more than `r11_drift_pct` ($15\%$).

### 3.2 String Level

Implemented in [`backend/app/services/growatt_daily.py`](../../backend/app/services/growatt_daily.py) and [`backend/app/services/growatt_rules.py`](../../backend/app/services/growatt_rules.py).

#### Peer Grouping (`_peer_groups`)
Peer ratio $R_i = \frac{I_i}{\text{median}(I_{\text{peers}})}$ compares **only** strings that share the same:
1. Module count (`modules`)
2. Orientation (`azimuth_deg`, rounded to nearest $5^\circ$)
3. Tilt (`tilt_deg`, rounded to nearest $2^\circ$)

#### Gating (`_stable_poa_timestamps`)
String ratios are evaluated only in 5-minute slots where:
- $\text{POA} \ge 350\text{ W/m}^2$ (within the $300\text{–}400\text{ W/m}^2$ threshold, configurable via `gate_irradiance_wm2`)
- **Low irradiance variability**: relative step change $|\text{POA}_t - \text{POA}_{t-1}| / \text{POA}_t \le 10\%$ (`MAX_POA_STEP_FRAC = 0.10`) and non-stale sensor reading
- Inverter status is normal (`status == 1`), not clipped ($P_{\text{AC}} < 98\%$ nominal), and not curtailed (`active_rate_pct >= 100`)

#### String Fault Thresholds

| Rule | Condition | Persistence | Points To | Notes |
|---|---|---|---|---|
| **R1** | $R_i < 0.80$ (`r1_low_ratio = 0.80`) | $> 2\text{ h}$ (`r1_low_min = 120` min) | Underperforming string | Configurable in Rule Review |
| **R2** | $I_i \le 0.3\text{ A}$ while $\text{median}(I_{\text{peers}}) \ge 2.0\text{ A}$ | $3\text{ samples}$ (`r2_open_min = 15` min) | Open circuit | P1 if above THB threshold, else P2 |
| **R4** | String voltage $> 1.2\%$ below peer voltage (`v_ratio_median < 0.988`) | $\ge 2\text{ days}$ (`r4_days = 2`) | Bypass diode | **Enforces Voltage Limit Rule**: only evaluated when `voltage_sensing == "per_string"` |
| **R5** | 30-day median $R_i < 0.95$ (`r5_30d_ratio = 0.95`) | 30 days (min 10 valid days) | Mismatch or degradation | Slow drift |
| **R6** | $R_i$ falling $> 1\%$ per month (`r6_slope_pct_per_month = -1.0`) | $\ge 14$ gated days | PID | Linear regression slope in $\%$/30d |

#### Voltage Limit Rule (`voltage_sensing`)
Strings wired in parallel on the same MPPT share a single DC bus voltage. In `compute_string_day` (`backend/app/services/growatt_daily.py`), each string's MPPT is checked:
- If only **1 wired string** is connected to that MPPT (`mppt_wired_counts[mppt] == 1`), `voltage_sensing = "per_string"` and Rule **R4** is active.
- If **2 or more wired strings** share that MPPT, `voltage_sensing = "shared_mppt"` and Rule **R4** is automatically skipped (on those inverters, only an I–V sweep or drone IR can detect a shorted bypass diode).

---

## 4. Database Schema & Migrations

Migration file: [`backend/alembic/versions/c5d6e7f8a9b0_iv_sweeps_and_timeseries_kpis.py`](../../backend/alembic/versions/c5d6e7f8a9b0_iv_sweeps_and_timeseries_kpis.py)  
ORM models: [`backend/app/db/models.py`](../../backend/app/db/models.py)

1. **`growatt_iv_sweeps` (new table)**:
   - Stores sweep metadata (`plant_id`, `device_sn`, `string_no`, `module_no`, `level`, `source`, `swept_at`), conditions (`irradiance_wm2`, `module_temp_c`, `irradiance_change_pct`, `reference_cell_tech`, `modules`), quality gate (`quality_gate_passed`, `gate_reasons_json`), raw and STC curve points (`points_json`, `stc_points_json`), extracted parameters and single-diode fits (`measured_params_json`, `stc_params_json`, `fit_json`), fault classification (`p_max_stc_w`, `expected_pmax_stc_w`, `pmax_dev_pct`, `signature`, `is_finding`, `ticket_recommended`), and two-source warranty fields (`ir_confirmed`, `timeseries_trend_confirmed`, `warranty_claim_ready`).
2. **`growatt_plant_daily` (new table)**:
   - Stores daily filtered plant KPIs: `capacity_kwp`, `energy_kwh`, `dc_energy_kwh`, `modelled_energy_kwh`, `yr_h`, `ya_kwh_kwp`, `yf_kwh_kwp`, `ya_minus_yf`, `pr_pct`, `pr_temp_corrected_pct`, `epi`, `irradiance_weighted_tmod_c`, `filtered_slots`, `stale_masked_slots`, `clipped_masked_slots`, `curtailed_masked_slots`.
3. **`growatt_string_layout` (added columns)**:
   - `azimuth_deg` (`Float`, nullable) and `tilt_deg` (`Float`, nullable) for same-orientation/tilt peer grouping.
4. **`growatt_string_daily` (added column)**:
   - `voltage_sensing` (`String(20)`, `"per_string"` or `"shared_mppt"`).

---

## 5. API Reference

| Method & Path | Description |
|---|---|
| `GET /api/growatt/plant/{plant_id}/iv-sweeps` | Lists stored I–V sweeps for a plant (optional filters: `sn`, `string_no`, `limit`). |
| `POST /api/growatt/plant/{plant_id}/iv-sweeps` | Validates measurement conditions, cleans and translates the curve to STC via IEC 60891 Procedure 1, extracts parameters, fits the single-diode model, classifies fault signatures, checks two-source warranty eligibility, and stores the sweep. |
| `PATCH /api/growatt/plant/{plant_id}/iv-sweeps/{sweep_id}` | Updates `ir_confirmed` (drone/handheld IR confirmation) or `note`, and recomputes `warranty_claim_ready`. |
| `GET /api/growatt/plant/{plant_id}/string-layout` / `PUT` | Reads and saves per-string `modules`, `module_wp`, `azimuth_deg`, and `tilt_deg`. |
| `GET /api/growatt/plant/{plant_id}/overview` | Includes `dc_yield_today_kwh`, `ya_kwh_kwp`, `ya_minus_yf`, `iec_pr_temp_corrected_pct`, `irradiance_weighted_module_temp_c`, and `epi`. |

---

## 6. Frontend Components

- **Measured I–V Sweep & IEC 60891 STC Panel ([`frontend/src/components/stringDetail/StringIvSweepPanel.tsx`](../../frontend/src/components/stringDetail/StringIvSweepPanel.tsx))**:
  Embedded in [`StringDetailPage.tsx`](../../frontend/src/pages/StringDetailPage.tsx). Displays sweep conditions ($G, T, \Delta G$, quality gate badge), interactive dual-panel I–V & P–V chart (Measured vs. IEC 60891 STC vs. Datasheet Reference), 9 extracted STC parameter tiles ($P_{\text{max}}, I_{\text{sc}}, V_{\text{oc}}, I_{\text{mp}}, V_{\text{mp}}, \text{FF}, R_s, R_{\text{sh}}, \text{Steps}$), fault signature callout, IR confirmation toggle, and sweep ingestion form.
- **Generation & PR Page ([`frontend/src/pages/GenerationPrPage.tsx`](../../frontend/src/pages/GenerationPrPage.tsx))**:
  Surfaces temperature-corrected $\text{PR}'$ alongside irradiance-weighted module temperature, $\text{EPI}$ (`modelled`), and $Y_a - Y_f$ ($\text{h/d}$).
- **String Layout Page ([`frontend/src/pages/StringLayoutPage.tsx`](../../frontend/src/pages/StringLayoutPage.tsx))**:
  Adds per-string `Az°` and `Tilt°` inputs alongside module count and $\text{Wp}$.
- **Rule Review & Issues ([`frontend/src/pages/RuleReviewPage.tsx`](../../frontend/src/pages/RuleReviewPage.tsx), [`frontend/src/components/issues.tsx`](../../frontend/src/components/issues.tsx))**:
  Adds threshold configuration and evidence formatting for `R1` ($R_i < 0.80$), `R4` (bypass diode voltage drop), `R6` (PID monthly slope), `R10` (EPI $\mu - 3\sigma$ / $\mu - 2\sigma$), and `R11` ($Y_a - Y_f$ drift).

---

## 7. Verification & Test Suite

Run the automated test suites from the repository root:

```bash
# 1. Pure NumPy I-V analysis, IEC 60891 STC translation, fault signatures, PR', EPI, and R1-R11 rules
uv run pytest backend/tests/test_iv_and_timeseries.py backend/tests/test_decision_rules.py -q

# 2. Type-check backend
uv run pyright

# 3. Lint and build frontend
cd frontend && bun run lint && bun run build
```
