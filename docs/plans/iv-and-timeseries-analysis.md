# Implementation Guide: I–V Curve Analysis & Time-Series Performance Analysis

Status: **Implemented (Option B — Pure NumPy in `solar_core/`, no `scipy` or `pvlib` runtime dependency)** · Created 2026-11-15 · Owner: Chanthawat

This document describes the architecture, mathematical models, database schema, API endpoints, decision rules, and UI components for the two analytical capabilities implemented in the **TC Roof Solar** platform:

1. **I–V Curve Analysis (String & Module Level)** — measurement condition gating, IEC 60891 Procedure 1 STC translation, parameter extraction, single-diode fitting (`rectify_iv_curve`, `fit_sandia_simple`, `fit_desoto`), 8-signature fault classification, $\pm 5\%$ dead band, and two-source module-test candidates.
2. **Time-Series Performance Analysis (Plant, Inverter & String Level)** — pre-KPI data filtering ($\text{POA } 200\text{–}1,200\text{ W/m}^2$, stale-value, clipping, and curtailment masks), temperature-corrected $\text{PR}'$, Energy Performance Index ($\text{EPI}$, Rule R10), inverter/BOS loss ($Y_a - Y_f$, Rule R11), same-orientation/tilt/module-count string peer ratio ($R_i$), irradiance gating, and string fault rules (`R1`, `R2`, `R4` with per-string voltage sensing check, `R5`, `R6`).

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

**Quality Gate** (`validate_sweep_conditions`):

| Condition | Result | Basis |
|---|---|---|
| $G_1 < 400\text{ W/m}^2$ | No diagnosis: `quality_gate_passed = False`, `shape_gate_passed = False` | IEC 62446-1 minimum |
| $400 \le G_1 < 700\text{ W/m}^2$ | Shape only: `quality_gate_passed = False`, `shape_gate_passed = True` | IEC 61829 minimum for STC translation |
| $700 \le G_1 < 800\text{ W/m}^2$ | Passes with a `gate_warnings` entry | IEA PVPS T13-24 best practice |
| $|\Delta G| > 2\%$ during the sweep | Both gates fail | Engineering practice |
| $1\% < |\Delta G| \le 2\%$ | Passes with a `gate_warnings` entry | IEA PVPS T13-24 best practice |

- Sweeps that fail `quality_gate_passed` are stored with explicit `gate_reasons`. Their STC power is never judged: no module-test candidate, and no ticket except for steps.
- A sweep with `shape_gate_passed` can still raise a `steps_in_curve` ticket, because steps are read from the measured curve.
- `gate_warnings` and `shape_gate_passed` are stored inside `classification`.
- Module temperature stability and sweep time for high-capacitance modules are optional inputs, gated in §2.9.

### 2.2 Data Cleaning (`rectify_iv_curve`)

Before parameter extraction or STC translation, `rectify_iv_curve(voltage, current)` cleans raw $(V, I)$ arrays:
1. Drops `NaN`/`Inf` pairs and points in quadrants with $V < 0$ or $I < 0$.
2. Sorts points by ascending voltage $V$ and merges duplicate voltages by median current.
3. Anchors $(0, I_{\text{sc}})$ by linear extrapolation of the low-voltage segment and $(V_{\text{oc}}, 0)$ by linear interpolation/extrapolation of the high-voltage drop-off.
4. A sweep that runs past $V_{\text{oc}}$ ends in several points at $I = 0$. Only the first of them is kept, so $V_{\text{oc}}$ is read where the current first reaches zero, not at the end of the sweep.

### 2.3 Translation to STC — IEC 60891 Procedure 1 (`translate_to_stc_iec60891`, `procedure=1`)

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
- `steps_count` (the classifier uses the **measured** curve's count, because translating a stepped curve can distort it): Number of local steps/notches or inflection regions in $\frac{dI}{dV}$ across $[0.08\,V_{\text{oc}}, 0.92\,V_{\text{oc}}]$ caused by bypass diode activation under partial shading or cell mismatch.

### 2.5 Single-Diode Model Fitting (`fit_sandia_simple`, `fit_desoto`)

- `fit_sandia_simple`: Non-iterative 5-parameter extraction ($I_L, I_o, R_s, R_{\text{sh}}, n N_s V_{\text{th}}$) from the curve asymptotes and MPP using the Lambert-W single-diode equations.
- `fit_desoto`: Refines the Sandia initial guess via damped Gauss–Newton / Levenberg–Marquardt iterations in pure NumPy, enforcing DeSoto temperature/irradiance scaling of $E_g$ and $I_o$.

### 2.6 Fault Signatures & Decision Rule (`classify_iv_fault`)

After translating to STC, $P_{\text{max,STC}}$ is compared against the age-adjusted expected power:

$$P_{\text{expected,STC}} = P_{\text{nameplate}} \times \left(1 - \text{LID}_1 - \text{years} \times d_{\text{warranty}}\right)$$

- **Dead Band**: The expanded uncertainty of field STC $P_{\text{max}}$ is $\pm 3.5\text{–}5\%$ (IEA PVPS T13-24), so the default is `dead_band_pct = 5.0`. Use $3\%$ only with a primary-calibrated reference cell and equivalent cell temperature. Any deviation within the dead band without curve distortion is not a finding (`is_finding = False`, `ticket_recommended = False`).
- **8 Fault Signatures**:

| Signature ID | Observation (after STC correction) | Detection Criteria | Likely Cause |
|---|---|---|---|
| `steps_in_curve` | Steps or notches in the curve | `steps_count >= 1` | Partial shading, cell mismatch, or cracked cells forcing a bypass diode on |
| `miswiring_or_module_count` | $V_{\text{oc}}$ low by about one full module | $\Delta V_{\text{oc}} \approx -1.0 \times V_{\text{oc,mod}}$ ($\pm 35\%$), normal $I_{\text{sc}}$, normal slope near $I_{\text{sc}}$ ($R_{\text{sh}} \ge 0.55\,R_{\text{sh,nom}}$) | Miswiring or wrong module count |
| `bypass_diode_shorted` | $V_{\text{oc}}$ low by about $\frac{1}{3}$ of one module's $V_{\text{oc}}$ | $\Delta V_{\text{oc}} \approx -\frac{1}{3}\,V_{\text{oc,mod}}$ (or integer multiple of substrings), normal $I_{\text{sc}}$, normal slope near $I_{\text{sc}}$ | Shorted bypass diode, one substring bypassed |
| `pid` | $V_{\text{oc}}$ and $\text{FF}$ down, worse at low irradiance / near negative pole | $V_{\text{oc}}$ drop $> 3\%$, $\text{FF}$ drop $> 4\%$, and ($R_{\text{sh}} < 0.45\,R_{\text{sh,nom}}$ or `near_negative_pole` or `low_irradiance_worse`) | Potential Induced Degradation (PID) |
| `low_shunt_resistance` | Steeper slope near $I_{\text{sc}}$ ($R_{\text{sh}}$ down), $\text{FF}$ down | $R_{\text{sh}} < 0.55\,R_{\text{sh,nom}}$ and $\text{FF}$ drop $> 3.5\%$ | Shunting, PID, or cell cracks |
| `high_series_resistance` | Shallower slope near $V_{\text{oc}}$ ($R_s$ up), $\text{FF}$ down | $R_s > 1.30\,R_{s,\text{nom}}$ and $\text{FF}$ drop $> 3.5\%$ | Solder-bond or ribbon corrosion, bad connector, or cable problem |
| `isc_low_normal_shape` | $I_{\text{sc}}$ low, curve shape normal | $I_{\text{sc}}$ drop outside dead band, $|\Delta V_{\text{oc}}| \le \text{dead band}$, $|\Delta \text{FF}| \le 3.5\%$ | Uniform soiling, optical degradation, or irradiance sensor error (check sensor first) |
| `normal_degradation` | All parameters down a little, uniformly | Outside dead band with uniform reductions in $I_{\text{sc}}, V_{\text{oc}}, \text{FF}$ | Normal degradation; compare drop against warranty slope |

- **Voc drop with a collapsed shunt**: low $R_{\text{sh}}$ lowers $V_{\text{oc}}$ too (a synthetic string with $R_{\text{sh}} = 55\,\Omega$ reads about 2.5% low, close to one substring). A missing module or a shorted bypass diode leaves the slope near $I_{\text{sc}}$ normal, so the two structural signatures apply only while that slope is at least $0.55\,R_{\text{sh,nom}}$; otherwise the curve goes on to the PID and low-shunt checks.

- **Module-Test Candidate (two sources)**:
  A string sweep gives the average of its modules, and manufacturers require STC power per module from an accredited laboratory or flasher. So a sweep never makes a warranty claim "ready"; it selects strings whose modules should be tested one by one.
  `module_test_candidate` is `True` **only** when:
  1. `quality_gate_passed` is `True`,
  2. the curve has no steps (the STC power of a stepped curve is for comparison only; `stc_comparison_valid = False`),
  3. $P_{\text{max,STC}} < P_{\text{expected,STC}} \times (1 - \text{dead\_band})$, and
  4. A second independent source confirms the finding: either **IR thermography** (`ir_confirmed = True`) or **an active time-series performance issue** on the same string (`timeseries_trend_confirmed = True`, auto-linked from open `R1`/`R4`/`R5`/`R6` issues; shadow-mode issues do not count).

  The SQL column keeps its old name `warranty_claim_ready`; the API field is `module_test_candidate`.

- **Module count and per-string Wp**: a string sweep needs its module count from String Layout or `modules` in the request; without one the upload is rejected (422). The count is never inferred from the measured $V_{\text{oc}}$, which would make expected $V_{\text{oc}}$ match by construction and hide `miswiring_or_module_count` / `bypass_diode_shorted`. A per-string `module_wp` scales the fleet module's $I_{\text{sc}}$ and $I_{\text{mp}}$ with it ($V_{\text{oc}}$, $V_{\text{mp}}$ kept), so the reference $\text{FF}_{\text{STC}}$ stays the datasheet value (`growatt_iv._spec_for_wp`).

### 2.7 Peer and Baseline Comparison (`growatt_iv._with_comparison`)

Field STC power carries $\pm 3.5\text{–}5\%$ uncertainty, most of it from the irradiance and temperature readings. Strings swept together share those errors, so a ratio against same-time peers shows faults that the absolute comparison hides. Every sweep returned by the API carries `comparison`, **computed on read** from the stored sweeps (the peers of a sweep are often uploaded after it); nothing is stored.

- **Peers** (`comparison.peer`): the other strings of the same inverter, same `source`, swept within `PEER_WINDOW_MIN` (30 min), that passed the quality gate and have no steps; the nearest sweep per string. At least `PEER_MIN` (2) are needed, otherwise `ratios` is `null` with a `reason`. Ratios are this string's STC value over the peers' median: $P_{\text{max}}$ and $V_{\text{oc}}$ per module (strings differ in length), $I_{\text{sc}}$ and FF as they are.
- **Setup check** (`setup_error_suspected`): when at least 3 strings were swept together and $I_{\text{sc}}$ is below the datasheet value by more than the dead band on **every** one, the irradiance reading or the setup is the likely cause, not the strings.
- **Baseline** (`comparison.baseline`): the string's first earlier sweep that passed the gate, has no steps, and has the same `source` and module count. Ratios of STC $P_{\text{max}}$, FF, and the slopes near $V_{\text{oc}}$ / $I_{\text{sc}}$.

| Flag | Level | Status |
|---|---|---|
| `pmax_below_peers` | ratio $< 0.97$ | Proposed, needs site calibration |
| `isc_below_peers` | ratio $< 0.98$ | Proposed, needs site calibration |
| `ff_below_peers` | ratio $< 0.97$ | Proposed, needs site calibration |
| `pmax_below_baseline` | ratio $< 0.97$ | Proposed, needs site calibration |
| `series_resistance_up` | slope near $V_{\text{oc}}$ $> 1.20 \times$ baseline | Proposed, needs site calibration |
| `shunt_resistance_down` | slope near $I_{\text{sc}}$ $< 0.50 \times$ baseline | Proposed, needs site calibration |

These flags mark a sweep in the UI and **never open a ticket**. To calibrate: 10 repeat sweeps on 3–5 healthy strings, then set each level at 2–3 standard deviations of the observed ratios.

### 2.8 Inverter Scans, Procedure 2 Cross-Check and Site Reference

- **Inverter scan** (`source = "inverter_scan"`): irradiance and temperature come from a plant sensor, not a reference cell at the string. The signatures that rest on absolute current or power (`isc_low_normal_shape`, `normal_degradation`) raise no ticket, the sweep is never a module-test candidate, and `stc_comparison_valid = False`. Scans are compared only with other scans (peers and baseline).
- **Procedure 2 cross-check** (`iec60891.procedure_2`): STC $P_{\text{max}}$ by IEC 60891:2021 Procedure 2 with **assumed** irradiance factors $B_1 = 0.045$, $B_2 = 0$ (typical c-Si, not measured for the fleet module). A difference above $1\%$ from Procedure 1 adds a gate warning. Procedure 1 stays the judged result. The Procedure 2 formulas come from the literature (Li et al., 2024) and were not checked against the standard's text.
- **Site reference** (`iec60891.site_reference`): the curve's parameters at $1000\text{ W/m}^2$, $55\,^\circ\text{C}$ (`SITE_REFERENCE_TEMP_C`), closer to operating temperature than STC, so the error from the temperature coefficients is smaller. For trending; shown, not judged.

### 2.9 Optional Conditions, More Cross-Checks and the Uncertainty Estimate

Four optional upload fields (stored on `growatt_iv_sweeps`; `null` = not recorded, never filled in):

| Field | Rule | Result |
|:---|:---|:---|
| `temp_change_k_per_min` | $> 1\text{ K}$ over the minute before the sweep (IEA PVPS T13-24) | gate warning, flag `unstable_T`; no reject level (none is published) |
| `sweep_time_ms` + `cell_technology` (`perc`, `topcon`, `hjt`, `ibc`) | $< 100\text{ ms}$ on TOPCon / HJT / IBC | **fails the quality gate** (power unreliable, curve shape still judged), flag `capacitance_suspect` |
| | $< 100\text{ ms}$, technology not given | gate warning, flag `capacitance_suspect` |
| `irradiance_uncertainty_pct` | sensor calibration uncertainty, $k = 2$ | replaces the assumed $2.5\%$ in the estimate below |

`cell_technology` falls back to the fleet module setting's `cell_technology` key when it has one. `classification.quality_flags` also carries `low_G` and `unstable_G`.

**More cross-checks** (`iec60891.procedure_4`, `iec60891.procedure_dynamic`; Procedure 1 stays the judged result):
- **Procedure 4**: needs no $R_s$ / $\kappa$ / $\beta$ coefficients; uses $\alpha$, the cells in series ($N \times 72$) and the default $\varepsilon = 1.232\text{ V}$. $R_s$ is the Sandia fit of the measured curve.
- **Dynamic procedure** (Li et al., 2024): Procedure 2 applied to the curve without its shunt current, $I' = I_1 + V_1 / R_{sh}$, which is put back afterwards, $I_2 = I' - V_2 / R_{sh}$. $R_s$ and $R_{sh}$ come from the Sandia fit of the measured curve; $R_{sh}$ above $100\ \Omega$ per module is neglected (`shunt_neglected`), and the result then equals Procedure 2. A difference above $1\%$ from Procedure 2 adds a gate warning.
- Procedures 2, 4 and dynamic follow the open-source reference implementation of Li et al. ([DuraMAT/IVcorrection](https://github.com/DuraMAT/IVcorrection)). None was checked against the text of IEC 60891.

**Uncertainty estimate** (`classification.uncertainty`, `estimate_stc_pmax_uncertainty`): expanded uncertainty ($k = 2$) of the judged STC $P_{\text{max}}$, a root sum of squares of:

| Component | Value | Source |
|:---|:---|:---|
| Irradiance sensor | `irradiance_uncertainty_pct`, else $2.5\%$ | input, else assumed (factory-calibrated cell) |
| Irradiance change during the sweep | `irradiance_change_pct` | input (left out when not given) |
| Module temperature | $\sqrt{3^2 + \Delta T^2}\text{ K} \times |\gamma|$ | assumed $\pm 3\text{ K}$, plus the given change per minute |
| Temperature coefficient | $10\% \times |\gamma| \times |25 - T_1|$ | assumed |
| Translation | $1\%$, or the largest difference of Procedure 2 / dynamic from Procedure 1 when larger | assumed, or `procedure_spread` |

It is a **lower bound**: tracer voltage/current accuracy, repeatability, spectral mismatch and sensor alignment are not included (`not_included`). It does not change the verdict: the dead band stays the uploaded value. When the estimate is larger than the dead band, a gate warning says so. Inverter scans get `null`.

### 2.10 Fleet-Level I-V Settings, Sweep Direction, Sensor Alignment and Cell Temperature from Voc

**Fleet module setting** (`/growatt/fleet-module`, form on the Settings page), three optional keys:
- `cell_technology` (`perc`, `topcon`, `hjt`, `ibc`): used for every sweep that does not give its own, so the sweep-time gate of §2.9 applies fleet-wide.
- `p2_b1`, `p2_b2`: measured Procedure 2 irradiance factors of the module. When `p2_b1` is set, Procedure 2 and the dynamic procedure use them and report `coefficients = "fleet_setting"` instead of `"assumed"`. The app does not fit them from sweeps; enter values determined per IEC 60891 from curves at several irradiances.

Two more optional upload fields (stored on `growatt_iv_sweeps`):

| Field | Rule | Result |
|:---|:---|:---|
| `reverse_pmax_w` (measured $P_{\text{max}}$ of the opposite-direction sweep) | differs from this sweep's measured $P_{\text{max}}$ by $> 1\%$ (proposed level) | gate warning, flag `capacitance_suspect`, `classification.forward_reverse`; no rejection |
| `sensor_misalignment_deg` (irradiance sensor vs array plane) | $> 2^\circ$ (IEC 60904-1) | gate warning, flag `sensor_misaligned` |
| | $1$–$2^\circ$ (best practice $1^\circ$) | gate warning |

**Cell temperature from $V_{oc}$** (`classification.equivalent_cell_temp`, modelled): the Procedure 2 open-circuit model solved for temperature,

$$T_{\text{ECT}} = 25 + \frac{V_{oc,1} / (N \cdot V_{oc,\text{STC}}) - 1/f(G_1)}{\beta_{rel} \cdot f(G_1)}$$

with datasheet $V_{oc,\text{STC}}$ and the $B_1$ / $B_2$ in use. It is shown next to the measured back-of-module temperature (`diff_vs_measured_k`) and **never used to translate**: on a string with a $V_{oc}$ fault it reads too hot, and translating with it would hide the fault. It is left out (`null`) for stepped curves, bypass-diode, module-count and PID signatures, and below the shape gate. It is not the IEC 60904-5 procedure, which needs a reference $V_{oc}$ measured on the same device.

### 2.11 Site Coefficients and Procedure 3 (`solar_core/iv_site_fit.py`, `growatt_iv.site_coefficients`)

`GET /growatt/plants/{id}/iv-sweeps/site-coefficients?sn=&string_no=` fits coefficients from one string's stored handheld sweeps. It is computed on read; nothing is stored or applied. An admin enters the values worth keeping in the fleet module setting. The I-V panel shows it under the chart ("Fit").

**Sweeps used**: string level, `source = "upload"`, shape gate passed, no steps on the measured curve, the module count of the newest such sweep. A sweep at $G \ge 700\text{ W/m}^2$ must also have a healthy signature (`normal`, `normal_degradation`, `isc_low_normal_shape`), and at least one such sweep is required. Below $700\text{ W/m}^2$ the signature rests on a long translation and is not used.

| Fitted | How | Needs |
|:---|:---|:---|
| $V_{oc,\text{STC}}$ per module | least squares on $V_{oc} = V_{oc,\text{STC}}\,[1/f(G) + \beta_{rel}\,f(G)\,(T - 25)]$, $f(G) = 1 + B_1 \ln(1000/G)$ | $\ge 3$ sweeps and one of the spans below |
| $B_1$ | search over $0$–$0.15$ in the same fit | irradiance span $\ge 300\text{ W/m}^2$ (IEA PVPS T13-24) |
| $\beta_{rel}$ | same fit | temperature span $\ge 10\text{ K}$ (our choice, no published figure); $\ge 4$ sweeps when $B_1$ is fitted too |
| $R_s$ per module | the value ($0$–$1\ \Omega$) that brings the sweeps' Procedure 2 STC $P_{\text{max}}$ closest together | irradiance span $\ge 300\text{ W/m}^2$ |
| $\kappa$ per module | same search ($0$–$0.005\ \Omega/\text{K}$), after $R_s$ | temperature span $\ge 10\text{ K}$ |

A value the sweeps cannot determine is `null` with a line in `reasons` (too few sweeps, span too small, best fit on the edge of the search range). When irradiance and temperature move together (correlation above $0.9$), `reasons` says that $R_s$ and $\kappa$ cannot be told apart reliably. Not fitted: $\alpha$ (its effect over a field temperature range is smaller than the irradiance sensor's error) and $B_2$.

The fit is an estimate from field sweeps of one string, not the IEC 60891 laboratory determination. The $R_s$ / $\kappa$ search follows the idea of that procedure (minimise the spread of translated $P_{\text{max}}$) without its requirement of equal temperature or equal irradiance between curves. The fitted $R_s$ is informative only: sweeps are translated with the $R_s$ fitted from each curve.

**Procedure 3** (`interpolate_procedure_3`, in the same response as `procedure_3`): linear interpolation between the string's lowest- and highest-irradiance sweeps, pairing points at $I_2 = I_1 + (I_{sc,2} - I_{sc,1})$, to $1000\text{ W/m}^2$. It needs no coefficients. With two curves the temperature is not chosen: $T_3 = T_1 + a\,(T_2 - T_1)$ is returned with the result, so it is $P_{\text{max}}$ at $1000\text{ W/m}^2$ and $T_3$, not at STC. `extrapolated = true` when $1000\text{ W/m}^2$ lies outside the two sweeps (the report warns Procedure 3 distorts when extrapolating). Formulas from the literature, not checked against the standard's text.

### 2.12 Sweeps That Failed the Quality Gate: `not_judged`

A sweep that failed the quality gate (below $700\text{ W/m}^2$, unstable irradiance, or too fast for the cells) is translated over a long distance or has unreliable power, so a signature read from its STC values can be an artefact: a healthy string at $450\text{ W/m}^2$ read as "module count" in tests. Such a sweep now gets `signature = "not_judged"` (not a finding, no ticket), and `classification.unjudged_signature` keeps what the STC values would have been read as, for information. `steps_in_curve` is the exception: it comes from the measured shape and is judged from $400\text{ W/m}^2$. Sweeps stored before this change keep their stored signature.

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
  where $\overline{T}_{\text{mod},G} = \frac{\sum G_t \cdot T_{\text{mod},t}}{\sum G_t}$ is the irradiance-weighted module temperature (`irradiance_weighted_tmod_c`) and $\gamma < 0$ is the module power temperature coefficient: the fleet module's `temp_coeff_pmax_pct`, else `DEFAULT_GAMMA_PCT_PER_K` ($-0.30\,\%/\text{K}$). Raw PR is never used to trigger alarms.
- **EPI — Energy Performance Index (`epi`, labelled `modelled`)**:
  $$\text{EPI} = \frac{E_{\text{measured}}}{E_{\text{modelled}}}, \quad E_{\text{modelled}} = \sum_{t \in \text{valid}} P_{\text{STC}} \cdot \frac{G_t}{1000} \cdot \max\left(0.5,\ 1 + \gamma(T_{\text{mod},t} - 25\,^\circ\text{C})\right) \cdot 0.985 \cdot \Delta t$$
  - $0.985$ is a fixed (assumed) inverter/BOS efficiency, not a nameplate value.
  - A slot without its own module temperature uses the day's irradiance-weighted (else daylight average) measured module temperature. When the sensor measured no module temperature at all that day, the slot is skipped, so EPI is `null` rather than modelled at an assumed $25\,^\circ\text{C}$.
  - Valid slots: POA $200\text{–}1{,}200\text{ W/m}^2$, not stale, not clipped (daily rows also not curtailed). At least 6 (daily rows, `growatt_daily._plant_day`) or 3 (overview) valid slots, else `null`.
  - **Rule R10 (`Plant EPI anomaly`)**: baseline $\mu$, $\sigma$ = daily EPI over `r10_window_days` (30) days before the trailing `r10_two_sigma_days` (3) days, at least `r10_min_days` (7), $\sigma \ge 0.015$. Fires P2 when today's $\text{EPI} < \mu - 3\sigma$, or P3 when each of the last 3 days is $< \mu - 2\sigma$.
- **$Y_a - Y_f$ — Array Yield Minus Final Yield (`ya_minus_yf`)**:
  $$Y_a = \frac{E_{\text{DC}}}{\text{kWp}}, \quad Y_f = \frac{E_{\text{AC}}}{\text{kWp}}, \quad \text{Loss}_{\text{inv+BOS}} = Y_a - Y_f\text{ (h/d)}$$
  - **Rule R11 (`Inverter Ya − Yf loss drift`)**: per inverter, fires when each of the last `r11_days` (2) days has $Y_a - Y_f \ge$ the median of the `r11_window_days` (14) days before them $+$ `r11_gap_increase_h` ($0.15\text{ h/d}$, an absolute gap, not a percentage), with at least `r11_min_days` (5) baseline days.

### 3.2 String Level

Implemented in [`backend/app/services/growatt_daily.py`](../../backend/app/services/growatt_daily.py) (`_strings_day`, daily rows in `growatt_string_daily`) and [`backend/app/services/growatt_rules.py`](../../backend/app/services/growatt_rules.py) (`evaluate`, thresholds in `DEFAULT_RULES`, overridable in Rule Review).

#### Peer Grouping
Peer ratio $R_i = \frac{I_i}{\text{median}(I_{\text{peers}})}$. Each string's peers are the strings of its inverter with the same String Layout key (module count, `azimuth_deg`, `tilt_deg`, compared exactly, not rounded), when that group has at least 2 strings reporting in the slot. Otherwise, or when the string has no layout, the peers are all wired strings of the inverter.

#### Gating
A 5-minute slot counts toward the ratio (`gated`) only when:
- the inverter's status is normal (`status == 1`) and at least `MIN_PEERS` (3) wired strings report;
- not more than a third of the strings read $\le 0.3\text{ A}$ together (that is an inverter event, not the strings);
- the median string current is $\ge$ `GATE_MEDIAN_A` ($3\text{ A}$);
- AC power is below `CLIP_FRACTION` ($98\%$) of the nameplate × active power limit (not clipped);
- where the plant has a weather sensor: POA $\ge$ `GATE_IRRADIANCE_WM2` ($400\text{ W/m}^2$, a constant) and the irradiance step $|G_t - G_{t-1}| / \max(G_t, G_{t-1}) \le$ `MAX_IRR_VARIABILITY` ($15\%$).

Fewer than `MIN_GATED_SLOTS` (12) gated slots = no verdict that day (`null`). The stale-value and curtailment masks of §3.1 apply to the plant KPIs, not to the string gate.

#### String Fault Thresholds

| Rule | Condition | Persistence | Points To | Notes |
|---|---|---|---|---|
| **R1** | $R_i <$ `LOW_RATIO` (0.80) for $\ge$ `r1_low_min` (120) gated minutes in a day | today, and on `r1_days_hit` (2) of the last `r1_days` (3) judged days | Weak string | P2 |
| **R2** | $I_i \le 0.3\text{ A}$ while the peer median $\ge 2.0\text{ A}$ | $\ge$ `r2_open_min` (15) min today | Open string | P1 above `p1_thb_per_day`, else P2 |
| **R4** | daily median voltage ratio $<1 - 1.2\%$ (`r4_v_drop_pct`) | `r4_days` (2) days in a row | Bypass diode | Only with `voltage_sensing == "per_string"` (below) |
| **R5** | median of daily $R_i$ over `r5_window_days` (30) $<$ `r5_ratio` (0.95) | $\ge$ `r5_min_days` (10) days with a verdict | Mismatch or slow degradation | P3 |
| **R6** | linear-regression slope of daily median $R_i$ falls by $>$ `r6_drop_pct_per_month` (1.0 %) per 30 days | over `r6_window_days` (30), $\ge$ `r6_min_days` (10) days with a verdict | PID / rapid degradation | P2; when it fires, R5 is not raised for that string |

#### Voltage Limit Rule (`voltage_sensing`)
Strings wired in parallel on the same MPPT share a single DC bus voltage. In `_strings_day` (`backend/app/services/growatt_daily.py`), each string's MPPT (string $n$ on MPPT $\lceil n/2 \rceil$) is checked:
- If only **1 wired string** is connected to that MPPT, `voltage_sensing = "per_string"` and Rule **R4** is active.
- If **2 or more wired strings** share that MPPT, `voltage_sensing = "shared_mppt"` and Rule **R4** is automatically skipped (on those inverters, only an I–V sweep or drone IR can detect a shorted bypass diode).

---

## 4. Database Schema & Migrations

Migration file: [`backend/alembic/versions/c5d6e7f8a9b0_iv_sweeps_and_timeseries_kpis.py`](../../backend/alembic/versions/c5d6e7f8a9b0_iv_sweeps_and_timeseries_kpis.py)  
ORM models: [`backend/app/db/models.py`](../../backend/app/db/models.py)

1. **`growatt_iv_sweeps` (new table)**:
   - Stores sweep metadata (`plant_id`, `device_sn`, `string_no`, `module_no`, `level`, `source`, `swept_at`), conditions (`irradiance_wm2`, `module_temp_c`, `irradiance_change_pct`, `reference_cell_tech`, `modules`), quality gate (`quality_gate_passed`, `gate_reasons_json`), the measured and STC curves with their extracted parameters and fits (`measured_json`, `stc_json`), the IEC 60891 cross-checks (`iec60891_json`), the full classification (`classification_json`), its headline values (`p_max_stc_w`, `expected_pmax_stc_w`, `pmax_dev_pct`, `signature`, `is_finding`, `ticket_recommended`), and two-source fields (`ir_confirmed`, `timeseries_trend_confirmed`, `warranty_claim_ready` = API `module_test_candidate`), plus `note`, `created_by`, `created_at`.
   - Added by [`a3b4c5d6e7f8_iv_sweep_conditions.py`](../../backend/alembic/versions/a3b4c5d6e7f8_iv_sweep_conditions.py) (and by `ensure_schema` at startup): optional conditions `temp_change_k_per_min`, `sweep_time_ms`, `cell_technology`, `irradiance_uncertainty_pct` (§2.9), `reverse_pmax_w`, `sensor_misalignment_deg` (§2.10).
2. **`growatt_plant_daily` (new table)**:
   - Stores daily filtered plant KPIs: `capacity_kwp`, `energy_kwh`, `dc_energy_kwh`, `modelled_energy_kwh`, `yr_h`, `ya_kwh_kwp`, `yf_kwh_kwp`, `ya_minus_yf`, `pr_pct`, `pr_temp_corrected_pct`, `epi`, `irradiance_weighted_tmod_c`, `filtered_slots`, `stale_masked_slots`, `clipped_masked_slots`, `curtailed_masked_slots`.
3. **`growatt_string_layouts` (added columns)**:
   - `azimuth_deg` (`Float`, nullable) and `tilt_deg` (`Float`, nullable) for same-orientation/tilt peer grouping.
4. **`growatt_string_daily` (added column)**:
   - `voltage_sensing` (`String(20)`, `"per_string"` or `"shared_mppt"`).

---

## 5. API Reference

Every route is mounted at `/api/...` and `/...`; plant routes need `require_plant_read` / `require_plant_write` (an unassigned plant answers 404).

| Method & Path | Description |
|---|---|
| `GET /growatt/plants/{plant_id}/iv-sweeps` | Lists stored I–V sweeps for a plant (optional filters: `sn`, `string_no`, `limit`), each with `comparison` (§2.7) computed on read. |
| `POST /growatt/plants/{plant_id}/iv-sweeps` | Validates measurement conditions, translates to STC (IEC 60891 Procedure 1, cross-checked), extracts parameters, fits the single-diode model, classifies the fault signature, checks the two-source module-test candidate, and stores the sweep. 422 for invalid input, including a string whose module count is unknown (§2.6). |
| `PATCH /growatt/plants/{plant_id}/iv-sweeps/{sweep_id}` | Updates `ir_confirmed` (drone/handheld IR confirmation) or `note`, and recomputes `module_test_candidate`. |
| `GET /growatt/plants/{plant_id}/iv-sweeps/site-coefficients?sn=&string_no=` | Site coefficients and Procedure 3 from one string's stored sweeps (§2.11), computed on read. |
| `GET /growatt/plants/{plant_id}/string-layout` / `PUT` | Reads and saves per-string `modules`, `module_wp`, `azimuth_deg`, and `tilt_deg`. |
| `GET /growatt/plants/{plant_id}/overview` | `kpis` include `dc_yield_today_kwh`, `ya_kwh_kwp`, `ya_minus_yf`, `iec_pr_temp_corrected_pct`, `irradiance_weighted_module_temp_c`, and `epi`. |

---|---|
| `GET /api/growatt/plant/{plant_id}/iv-sweeps` | Lists stored I–V sweeps for a plant (optional filters: `sn`, `string_no`, `limit`). |
| `POST /api/growatt/plant/{plant_id}/iv-sweeps` | Validates measurement conditions, cleans and translates the curve to STC via IEC 60891 Procedure 1, extracts parameters, fits the single-diode model, classifies fault signatures, checks two-source warranty eligibility, and stores the sweep. |
| `PATCH /api/growatt/plant/{plant_id}/iv-sweeps/{sweep_id}` | Updates `ir_confirmed` (drone/handheld IR confirmation) or `note`, and recomputes `module_test_candidate`. |
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

# 2. Type-check the files you changed (whole-tree runs report older pandas-stubs errors in solar_core/)
uv run pyright backend/solar_core/iv_analysis.py backend/app/services/growatt_iv.py backend/app/services/growatt_daily.py backend/app/services/growatt_rules.py

# 3. Lint and build frontend
cd frontend && bun run lint && bun run build
```
