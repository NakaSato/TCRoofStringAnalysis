# Spec: How inverter data is used for analysis (method catalogue)

Owner: Chanthawat · Written 2026-11-22 · Repo: TCRoofStringAnalysis

Related:
- `pwa-inverter-om-analysis-spec.md`: O&M rules, events, KPIs.
- `string-iv-realtime-spec.md`: string and I-V diagnostics.
- `pwa-inverter-plot-style-spec.md`: chart style.
- `pwa-meter-daily-spec.md`: meter data layer.

Purpose: the single reference for **which inverter data is used for which analysis, and how**. The other specs build features. This one defines the methods they share, so a number such as "PR" or "availability" means the same thing on every page.

Status: method spec only, no code. Thresholds are **proposed** and belong in criteria files, never in code. Growatt field names marked **(confirm)** must be checked per inverter model.

---

## 1. Data inventory

### 1.1 Inverter data (Growatt)

| Group | Fields | Resolution | Main uses |
|---|---|---|---|
| AC output | P_ac, E_day, E_total, V_ac, I_ac, frequency, power factor | 5 min | Energy, availability, clipping, PR, grid issues |
| DC input | V and I per MPPT (`vpv1…n`, `ipv1…n`), P per MPPT; current per string (`currentString1…n`, some models) **(confirm)** | 5 min | MPPT and string loss, mismatch, the I-V operating point |
| State | status (waiting / normal / fault), fault code, warning code | event / 5 min | Availability, cause, MTBF / MTTR |
| Control | active power limit %, export-limit flag, derating flag **(confirm)** | 5 min | Separating curtailment from a fault |
| Thermal | internal / heatsink temperature | 5 min | Thermal derating, fan / cooling faults |
| Insulation | ISO resistance, residual current (on some models) **(confirm)** | event / daily | Insulation and earth-leakage faults, a PID hint |
| Static | serial number, model, rated AC power, MPPT count, firmware | — | Normalisation, model-specific fault maps |

### 1.2 Data used with it

| Source | Fields | Why |
|---|---|---|
| Weather station | POA irradiance G, module temperature T_mod, ambient temperature, rain | Expected power, PR, temperature correction, soiling resets |
| String registry | modules per string, strings per MPPT, module model, kWp, orientation | Normalising by kWp, expected curves |
| Module datasheet | STC values, α, β, γ, NOCT | Temperature correction, single-diode model |
| Daily report (PWA) | Cewe meter kWh, notes, weather | Billing reference, causes, meter check |
| Design (PVsyst) | monthly kWh, PR | Expected vs design |

---

## 2. Data preparation (applies to every analysis)

### 2.1 Time
- Every value keeps its **source timestamp** (Growatt sample time), stored naive plant-local (Asia/Bangkok) as the Growatt reading tables are; only app bookkeeping columns are UTC.
- Align to a fixed 5-min grid by flooring. Several samples in one slot are averaged for power and take the last value for counters.
- Join weather by nearest time within ±2.5 min; otherwise leave the value unjoined.

### 2.2 Energy counters
- Daily energy = the E_day value at the end of the day. If E_day resets late or is missing, use the ΔE_total of the day.
- Never integrate P_ac when a counter exists; use P_ac only to fill a single missing slot, and flag the value as `filled`.
- A negative Δ or a jump of more than rated power × slot time is a counter fault, and the slot is null.

### 2.3 Missing data
- **Null is not zero.** A slot with no sample is null and is never treated as zero production.
- A slot is a gap until the inverter state says otherwise (§3.1).
- Gaps of at most 15 min may be interpolated **for charts only**, and are marked as interpolated. They are never interpolated for energy or KPIs.

### 2.4 Sanity flags (per slot)

| Flag | Condition |
|---|---|
| `stale` | Same non-zero value repeated for ≥ 3 slots |
| `out_of_range` | P_ac > 1.05 × rating, V or I outside the datasheet limits, or a temperature below 0 or above 100 °C |
| `night_power` | P_ac > 1 % of rating while G < 10 W/m² |
| `clock` | A sample time more than 10 min from the poll time |

A flagged slot is left out of every analysis below and counted under data quality (§4.10).

### 2.5 Normalisation
- **Specific yield** = kWh ÷ kWp (DC).
- **Normalised power** = P_ac ÷ P_rated (AC).
- Peer comparisons use specific yield or normalised power, never raw kW.

---

## 3. Base states (computed once, reused)

### 3.1 Inverter state per slot
These are the same states as `pwa-inverter-om-analysis-spec.md` §7.2:
- `night`
- `producing`
- `limited`
- `fault`
- `idle_unexplained`
- `offline_comms`
- `plant_offline`

Daylight means G ≥ 50 W/m², or 06:00–18:30 when there is no sensor.

### 3.2 Expected power per slot (three methods, by preference)

| Method | Formula | When to use |
|---|---|---|
| **A. Peer** | median normalised power of healthy same-config inverters at the plant (or region) × own rating | Always available, and weather cancels out. This is the default for O&M |
| **B. Irradiance** | P_exp = kWp × (G / 1000) × [1 + γ·(T_cell − 25)] × η_sys | When a plant POA sensor exists. η_sys comes from the site's own PR over 30 clear days |
| **C. Model** | pvlib chain: POA → cell temperature → module power (single-diode) → DC losses → inverter efficiency curve | For engineering studies, design comparison and I-V work |

Each result records which method produced it (`expected_method`), and the UI labels the value "(modelled)" or "(peer)".

---

## 4. Analysis catalogue

Each analysis lists: question → inputs → method → output → default threshold → chart.

### 4.1 Availability
- **Question:** what share of the time and energy was lost because the inverter was not able to produce?
- **Inputs:** states (§3.1), expected power.
- **Method:**
  - Time availability = (producing + limited) ÷ (daylight − excluded) slots.
  - Energy availability = 1 − lost_O&M ÷ (actual + lost_O&M).
  - Lost energy during `fault` or `idle_unexplained` = Σ expected power × slot time.
- **Excluded causes:** grid outage, PWA-side work and floods. The list must be agreed with กปภ.
- **Output:** per inverter, site and fleet, by day and by month.
- **Target:** 99.5 % (to be signed off).
- **Chart:** monthly bars per site; heatmap of sites × days by state.

### 4.2 Energy and yield
- **Question:** how much was produced against what was expected?
- **Method:** daily kWh, specific yield, and performance index PI = actual ÷ expected (method A or B), with PVsyst monthly kWh as the design line.
- **Output:** PI per day and month, with the monthly gap in MWh.
- **Chart:** bars for actual, a dashed line for expected "(modelled)".

### 4.3 Performance ratio (PR), only where a POA sensor exists
- **Formula:** PR = E_ac ÷ (kWp × H_poa / 1000), where H_poa is the daily POA irradiation in kWh/m².
- **Temperature-corrected PR (PR′):** divide by [1 + γ·(T_cell − 25)] weighted by irradiance, so the summer heat dip does not read as a fault.
- **Gates:** only days with ≥ 90 % of daylight slots valid, H_poa ≥ 2 kWh/m², and no `limited` slots at a curtailed site.
- **Output:** daily and 30-day rolling PR and PR′.
- **Flag:** PR′ < site baseline − 5 points for 7 days.
- **Chart:** a line with a 30-day band; PR and PR′ on separate panels.

### 4.4 Peer comparison (relative performance)
- **Question:** is this inverter, MPPT or site doing worse than its neighbours under the same weather?
- **Method:** r = own normalised power (or specific yield) ÷ peer median.
  - Peers are: same plant and configuration for inverters; the same PWA region on the same day for sites (as in the O&M spec).
  - Use only slots where G ≥ 400 W/m², or where peers are above 30 % of rating.
- **Output:** r per slot, the daily median, and a 30-day trend.
- **Flag:** r < 0.85 for 1 h (realtime) or < 0.80 for a day (daily).
- **Chart:** a ranked dot plot, and a sites × months heatmap with diverging colours.

### 4.5 MPPT and string analysis
- **Question:** is one input (MPPT or string) losing current or voltage?
- **Method:**
  - Current ratio per MPPT = I_mppt ÷ median I of the inverter's other MPPTs with the same strings per MPPT.
  - Voltage step = a drop in V_mppt by about Vmp_module / 3 (one bypass diode) or one Vmp_module (a missing module), compared with previous days at similar G and T.
- **Output:** flags S1–S5, defined in `string-iv-realtime-spec.md`.
- **Chart:** I-V operating points on the modelled curve; current-ratio trend.

### 4.6 Clipping (inverter saturation)
- **Question:** how much energy is lost because the DC array exceeds the inverter's AC rating?
- **Method:**
  - A slot is clipped when P_ac ≥ 98 % of rating and P_dc_expected > P_rating.
  - Lost energy = Σ (P_dc_expected × η − P_rating) over clipped slots.
- **Output:** clipped hours and kWh per month. The DC/AC ratio comes from the registry.
- **Use:** a design check, and an argument for or against re-stringing. This is not an O&M fault.
- **Chart:** a P_ac vs G scatter with the flat top highlighted.

### 4.7 Curtailment (export limit / zero export)
- **Question:** how much energy was held back by the power limit or the PWA's load, as opposed to a fault?
- **Method:**
  - A slot is curtailed when the power limit is below 100 % or the export-limit flag is set **(confirm field)**.
  - Fallback where there is no flag: P_ac sits below 0.8 × expected while the MPPT voltage is above 1.05 × the modelled Vmp. This means the operating point has moved toward Voc.
  - Lost energy = Σ (expected − actual) over curtailed slots.
- **Output:** curtailment kWh per site and month, and the share of potential energy lost.
- **Use:** the PM's case for a BESS, an export deal or load matching. It is kept apart from O&M losses everywhere.
- **Chart:** stacked monthly bars of actual, curtailment and O&M loss.

### 4.8 Inverter efficiency
- **Question:** is the conversion efficiency dropping?
- **Method:**
  - η = P_ac ÷ ΣP_dc per slot, binned by load (10 % bins of rating).
  - Compare with the datasheet efficiency curve, and with the inverter's own baseline from its first 90 days.
- **Flag:** a drop of 1.5 points in the 30–70 % load bins, sustained for 14 days.
- **Use:** an early sign of failing IGBTs or capacitors, a fan problem, or a sensor offset.
- **Chart:** an efficiency vs load curve, baseline against now.

### 4.9 Thermal derating and cooling
- **Question:** is the inverter cutting power because it runs hot?
- **Method:**
  - Derating = the derating flag **(confirm)**, or P_ac capped below rating while T_inv > the model's derate temperature and G is high.
  - Track T_inv − T_amb against normalised power. A rising slope over weeks means a blocked fan or filter, or a hot room.
- **Flag:** derating on ≥ 3 days in 14, or a slope ≥ 20 % above baseline.
- **Chart:** T_inv − T_amb vs load scatter, colour-coded by month.

### 4.10 Data quality and comms
- **Question:** can we trust the data, and where do we lose it?
- **Method:** daily data availability = valid slots ÷ daylight slots. Count `stale`, `out_of_range`, `offline_comms` and `clock` flags per inverter.
- **Flag:** data availability < 95 % on a day, or a gap of ≥ 30 min. A gap of 30 min or more is reported as rule R32.
- **Chart:** strip of inverters × days in status colours.

### 4.11 Fault analytics (reliability)
- **Question:** which faults recur, and how reliable is each inverter and model?
- **Method:**
  - Fault events come from the state runs (§3.1). Each run of a code is one event, and events less than 10 min apart are merged.
  - Pareto of events, downtime hours and lost kWh, each counted by fault code and by cause group.
  - MTBF = operating hours ÷ events, per inverter and per model.
  - MTTR = mean time from fault to back producing.
  - Repeat-fault flag: the same code ≥ 3 times in 30 days (R35).
  - With ≥ 2 years of data, fit a Weibull distribution to time-between-failure per model to plan spares.
- **Output:** a Pareto table, MTBF and MTTR per model, and a list of repeat offenders.
- **Chart:** Pareto bars with a cumulative line on a *separate* panel, never a second y-axis.

### 4.12 Insulation and earth leakage
- **Question:** is an insulation or earth-leakage fault building up?
- **Method:** trend the morning ISO resistance per inverter **(confirm availability)**. Count residual-current trips.
- **Flag:**
  - ISO trends below the model's alarm level + 50 %.
  - Or a gradual fall of > 30 % over 30 days, which is a wet-season or PID hint.
  - Or ≥ 2 trips in 7 days.
- **Use:** plan an insulation test and a check of DC cable and connectors before the trip turns into an outage.

### 4.13 Degradation (long term, ≥ 2 years of data)
- **Question:** how fast is the plant losing output?
- **Method:** year-on-year PLR (RdTools approach): the median of the PI (or PR′) ratios between the same day in consecutive years, with a confidence interval.
- **Reference:** fleet median about −0.75 %/yr, about −0.9 %/yr in hot climates.
- **Flag:** PLR worse than −1 %/yr with the confidence interval below −1 %.
- **Use:** warranty and contract planning. It needs a long history, so it is not shown until 24 months of data exist.

### 4.14 Soiling
- **Question:** how much energy is lost to dirt, and when is cleaning worth it?
- **Method:**
  - Daily PI (method B) or peer-r on clear days.
  - Find the drop between rain events (≥ 5 mm from the weather station) to get a soiling rate in %/day. This is the RdTools SRR idea.
- **Output:** soiling loss % per site and the estimated kWh between cleanings.
- **Cleaning trigger:** proposed when the accumulated loss × fee exceeds the cleaning cost, which must come from O&M.

### 4.15 Meter reconciliation
- **Question:** do the inverter and the billing meter agree?
- **Method:** daily ratio of meter kWh ÷ inverter kWh against the site's median (fleet median today is 0.994).
- **Flag:** ≥ 5 days more than 0.03 below the site median → check the meter and CTs. The rules are in the meter spec.
- **Use:** stop a meter or CT fault being read as a production loss, and the reverse.

### 4.16 Grid quality (AC side)
- **Question:** are faults caused by the grid rather than the plant?
- **Method:** count slots and trips with V_ac or frequency outside the grid code window, by time of day. Look at trips that hit several inverters at once (common cause: grid).
- **Use:** evidence for PEA/PWA when trips are grid-driven (ไฟตก / ไฟดับ). Such trips are excluded from O&M availability when agreed.

---

## 5. Which analysis serves which user

| User | Analyses | Cadence |
|---|---|---|
| O&M engineer | 4.1, 4.4, 4.5, 4.10, 4.11 (own sites) | Realtime + daily |
| O&M lead | 4.1, 4.11, 4.12, 4.14, KPIs | Weekly / monthly |
| PM | 4.2, 4.7, 4.6, 4.15 | Monthly |
| Engineering / design | 4.3, 4.6, 4.8, 4.9, 4.13 | Quarterly / per study |
| Finance | 4.2 + losses in THB (est.), 4.15 | Monthly |

---

## 6. Loss waterfall (one consistent split)

Every loss figure on any page fits this split, so no number is counted twice:

```
Expected energy (method A/B/C)
 − Curtailment            (4.7)  → PM / commercial
 − Grid / external        (4.16, excluded causes) → not O&M
 − O&M downtime           (4.1)  → O&M
 − Under-performance      (4.4/4.5/4.14 when not curtailed) → O&M
 − Clipping               (4.6)  → design
 − Unexplained remainder
 = Actual inverter energy
 − AC / meter losses      (4.15)
 = Billed meter energy
```

- Each step is labelled "est." where it uses expected power.
- The unexplained remainder is always shown, never hidden. A large remainder means the model or the data is wrong.

---

## 7. Storage and compute

| Item | Rule |
|---|---|
| Raw 5-min samples | SQL, 90 days, source-dated; no Firestore |
| 15-min and daily aggregates | SQL, kept indefinitely |
| Derived results (states, expected power, flags) | Recomputable from raw data and the criteria version; each row stores `criteria_version` and `expected_method` |
| Batch jobs | Nightly: daily aggregates, PR, peer r, efficiency bins, data quality. Weekly: fault Pareto, MTBF. Monthly: soiling, clipping, curtailment. Yearly or on demand: PLR |
| Realtime | States and the R30–R36 rules on each poll (see the O&M spec) |
| Cost | Only SQL work in the existing worker; no new paid services; within the current budget (`BUDGET_AMOUNT` in `deploy/gcp.config`: ฿1,000/month since 2026-11-21, cost guard at ฿960) |

Criteria files:
- `inverter_analysis_criteria.json` (new) holds the gates, flags and bins in §2–§4.
- It is versioned, and changes need a PR.
- The O&M and string specs keep their own files and refer to this one for shared definitions: day state, peers and the zero threshold.

---

## 8. Validation

- **Fixtures:** one synthetic plant with 3 inverters × 14 days and known answers for each analysis:
  - a 2.5 h trip;
  - a curtailed afternoon;
  - a clipped noon;
  - a soiling slope reset by rain;
  - an MPPT with a 1/3-module voltage step;
  - a frozen value.
- **Cross-checks on real data:**
  - Σ daily inverter energy vs the daily report inverter column: within 2 % on 95 % of days.
  - Availability from realtime states vs report outage days: the same day set on ≥ 95 % of days.
- **Replay:** the same raw data and criteria version always give the same results.
- **Review:** each new flag runs in shadow mode for 2 weeks. It is promoted only when its false-alarm rate is below 10 % against O&M tickets.

---

## 9. Open questions

1. Which inverter models and firmware are in the fleet, and which of these fields does each expose: per-string current, power-limit flag, derating flag, ISO resistance, internal temperature?
2. Which plants have a calibrated POA sensor in the module plane? That decides where PR and PR′ (method B) are shown, and where only peer methods apply.
3. What does a cleaning cost per kWp, so the soiling trigger (4.14) can be set?
4. Which causes are excluded from O&M availability (grid, PWA work, floods, tests)? This needs agreement with กปภ.
5. Should the loss waterfall (§6) be the standard view for monthly reports to PM and finance?

---

## 10. Checked against the code (2026-11-22)

A read-only check of this spec against the repo and the local DB (`data/solar_fullstack.db`, data 2026-11-11 → 11-22). Two plain errors were fixed in place: §2.1 now says readings are stored plant-local, not UTC, and §7 names the ฿1,000 budget. Every other point below is a finding or a proposed wording change; no threshold above was changed. Paths are under `backend/app/services/` unless stated.

### 10.1 Fleet and fields (answers open question 1)

| Model | Installed | Firmware | MPPT / strings with data |
|---|---|---|---|
| MAX 125KTL3-X LV | 429 | TN1.0 | 10 / 20 |
| MAX 80KTL3 LV | 126 | TI1.0 | 7 / 14 |
| MAX 60KTL3 LV | 54 | TI1.0 | 6–7 / 12 (4 units registered at 80 kW) |
| MID 40KTL3-X | 17 | DM1.0 | 4 / 8 |

Record interval: median 4.95 min on every model; about 10 % of gaps are 1–3 min.

| §1.1 field | Growatt key | Stored as | Correction to §1.1 |
|---|---|---|---|
| Per-string current | `currentString{n}` | `growatt_string_readings` (while ppv > 0) | All four models have it, not "some". `vString{n}` is the MPPT voltage. |
| Power / export limit | `realOPPercent` (0 in every record); settings `activeRate`, `exportLimit`, `readPower` | registry columns, read on a schedule | No 5-min flag exists. Curtailment is always inferred (§4.7 fallback is the main path). |
| Derating | `deratingMode` (0/1/6/7/13/23) | raw JSON only | A mode code, not a flag. Code 13 in ~12 % of producing records. Needs Growatt's code table. |
| ISO, leakage | `pvIso` (65530 = none), `gfci`, `r/s/tDci` | raw JSON only, 30 days | Every 5 min on all models, not event / daily. A 30-day trend (§4.12) needs its own daily column or raw kept ≥ 35 days. |
| V_ac, I_ac, PF | `vacr/s/t`, `iacr/s/t`, `pf` | raw JSON only, 30 days | PF is almost always exactly 1: a setpoint, not a measurement. |
| Temperatures | `temperature` (AMTemp1), `temperature2` (INVTemp), `temperature3` (BTTemp), `temperature5` (AMTemp2) | `temperature_c` = AMTemp1; others raw only | Three sensors, no "heatsink" key. Which one §4.9 uses must be stated (meaning of AMTemp1 not confirmed). |

### 10.2 Preparation, states, storage (§2, §3, §7)

| Spec | Code today | Proposed change to the spec |
|---|---|---|
| §2.1 weather join ±2.5 min | Stored: same floored 5-min slot (`growatt_daily.py:130`). Live: ≤ 300 s (`string_live_criteria.json`). | "Same 5-min slot (stored); within `weather_max_gap_s` (live)". |
| §2.2 fallback ΔE_total | Integrates P_ac (`growatt_common._integrate_kwh`); `eac_total` used only for lifetime. No counter-fault check, no `filled` flag. | State which one wins, then build the counter check. |
| §2.3 interpolation ≤ 15 min for charts | Curves hold an inverter's last value ≤ 10 min (`held`); a null `pac` counts as 0 W in the daily rules (`growatt_daily.py:97`). | Adopt the 10-min hold, or replace it. Treat null `pac` as a gap. |
| §2.4 sanity flags | `stale` only for irradiance (`growatt_weather.py`); no `night_power` or `clock`. | "Extends the irradiance stale check to inverter values". |
| §3.1 states, daylight | producing / limited / fault / off / standby / no_data; daylight = sunrise + 30 min … sunset − 30 min (`growatt_daily.py:53`); `limited` = limit < 100 % and AC ≥ 98 % of the limited nameplate. | Map the seven states onto these, or say which change. Use the sunrise / sunset window, or state the switch. |
| §3.2 A, peer | Σ kW ÷ Σ kWp of the producing inverters of the plant, not a median; no region. | Pick one. |
| §3.2 B, irradiance | EPI: T_mod (not T_cell), factor = median of the 10 clearest of 60 days, default 0.985 (`epi_fit.py`). | Describe EPI as method B. |
| §3.2 C, pvlib | Not built (single-diode only in the live I-V check). | — |
| §7 storage | Raw 90 days: same. Raw JSON 30 days, `growatt_plant_power` pruned. No 15-min aggregates, no `expected_method` / `criteria_version` columns, no weekly / monthly jobs. Rule thresholds live in `growatt_rules.DEFAULT_RULES` + `app_settings`, not JSON. | Say how `inverter_analysis_criteria.json` relates to `DEFAULT_RULES`. |
| §7 rule IDs | R1–R18 exist; R12–R15 are planned (`docs/plans/decision-rules.md`). | R32 duplicates R17 "Data gap" (5 % of daylight): say R32 is the single ≥ 30-min gap. R35 overlaps R9 (3 alarms in 7 days). |

### 10.3 Analyses (§4)

| § | Status | Code today | Conflict with the spec |
|---|---|---|---|
| 4.1 Availability | Exists, three meanings | O&M Dashboard: 1 − (fault + off + standby) ÷ (daylight − no_data) (`om_center.py:212`); PWA: outage days ÷ site-days, target 0.995; string `availability_pct` is 100 or 0. UI green at 99 %. | No-data minutes are dropped, not counted lost; no energy availability; target 99 % vs 99.5 %. |
| 4.2 Energy / PI | Partly | EPI = Σ AC ÷ Σ modelled over gated slots (POA 200–1200 W/m², ≥ 6 slots); `pi_pvsyst`, `pi_contract`, `PI_free` in the meter criteria. | Three "PI"s; no peer PI. |
| 4.3 PR / PR′ | Built | `growatt_weather.iec_pr`; PR′ uses irradiance-weighted module temperature, γ −0.30 %/K. Gate: irradiance covers ≥ 90 % of **producing** slots. | No H_poa ≥ 2 gate, no exclusion of limited days, no rolling 30-day value or 7-day flag. The string / plant `pr_pct` (88.5 × energy ÷ peers) is shown as plain "PR" in the UI. `target_pr_pct` is a fixed 85. |
| 4.4 Peer | Exists | R7: inverter Yf below the plant median by > 3 % on 2 days (`growatt_rules.py:57`); peers = every inverter of the plant. | 0.97 vs 0.80; no G ≥ 400 gate; inverter `/daily` uses the mean. |
| 4.5 MPPT / string | Per string | `growatt_string_daily`: low < 0.80, severe < 0.60 vs the inverter's string median, gates status 1, median ≥ 3 A, G ≥ 400, not clipped. R1, R2, R4 (voltage vs peers), R5, R6. | S1–S5 map to R1/R2/R4/R5/R6; `string-iv-realtime-spec.md` is not in the repo. `backend/CLAUDE.md` says < 0.85 (stale). |
| 4.6 Clipping | Not built | 98 % line against nameplate × power limit, used only to mask slots. | Split clipped (nameplate) from limited (setting). |
| 4.7 Curtailment | Partly | `growatt_curtailment.annotate`: available − AC ≥ max(1 kW, 15 %), cause zero export (meter ≈ 0 both ways) or power limit; runs ≥ 2 slots; kWh per day. R18: minutes only. PWA: `หรี่` remarks. | 0.85 vs 0.8; zero export from the meter is the main cause, the V > 1.05 Vmp test exists only live. |
| 4.8 Efficiency | Partly | Daily η = ∫AC ÷ ∫DC; R11 (Ya − Yf drift). | No load bins or baseline. |
| 4.9 Thermal | Not built | The overview's "Thermal Derating Loss" is a module-temperature loss at 0.34 %/K. | Belongs in §6, not here. |
| 4.10 Data quality | Partly | R17: no-data > 5 % of daylight. Sensors: 80 % coverage (`SENSOR_ALARM_COVERAGE_PCT`). | No single-gap ≥ 30 min rule. |
| 4.11 Faults | Partly | Alarm reports merged per inverter + code: 10 min (UI, sync) but 15 min in the rules (`growatt_rules.py:91`). R9 keyword events. | No MTBF, MTTR (inverter), Pareto. One merge gap needed. |
| 4.12 Insulation | Partly | R3: keyword match on alarm text, no trend. Code 203 means both "PV Isolation Low" and "PV Circuit short". | `pvIso` only 30 days in raw; unit and alarm level per model unknown. |
| 4.13 Degradation | Not built | R5 / R6 are 30-day string drift; R14 is planned. | Source must be the daily tables (kept indefinitely), not raw readings (90 days). |
| 4.14 Soiling | Not built | Sensor rain is always 0 and dropped. Only rain: Google Weather (modelled) daytime `precip_mm`; a rain day is ≥ 1 mm in code, R12 / R13 plan 10 mm. | "≥ 5 mm from the weather station" has no source. |
| 4.15 Meter | Built (meter spec) | Low day = ratio < median − 0.03, gate 0.5 kWh/kWp; flag = median < 0.985 (vs report) / 0.97 (vs Growatt), or low + meter-missing days ≥ 3 (`pwa_meter_criteria.json`). | "≥ 5 days" → ≥ 3; 0.994 appears only as "fleet ≈ 99.4 %" in `docs/plans/pwa-meter-daily.md`. |
| 4.16 Grid | Not built | Stored: inverter `fac_hz`, meter `frequency_hz` (90 days); AC voltages only in raw (30 days). No grid window, no common-cause logic. | State the sources; the grid window is still to be set. |

### 10.4 Loss waterfall (§6)

- O&M Dashboard attributes each lost kWh once, in families: down (R8), strings, conversion (R11), under-yield (R7), plant shortfall (R10), data gap (R17) (`om_center.py:44`). No curtailment, grid or clipping step.
- Energy & Billing shortfall: outage, under-performance, meter gap, curtailment, plus `unexplained_kwh`.
- Plant overview (`growatt_overview.py:579`): POA × kWp → optical & soiling → thermal → mismatch → conversion → AC. **Checked:** "Optical & Soiling" is the remainder, so the unexplained part is hidden, against §6. Without a sensor the base is `yield ÷ max(0.65, plant_pr_pct / 100)`, where `plant_pr_pct` is the peer index, not a measured PR, although the code comment says the waterfall is "only built when every input is measured". Thermal uses 0.34 %/K with a 1.5 % floor (the fleet module uses −0.30 %/K).
- Proposed: add "Data gap (not recovered)" as a step, map each step to these keys, and show the overview's remainder as "Unexplained".

### 10.5 Irradiance sensors (open question 2)

234 sensors are registered on 231 plants; 220 plants have stored readings, 219 report irradiance > 0 (all reach ≥ 400 W/m²), 208 report module temperature. Every sensor reports `radiant`, which the code treats as POA; tilt, plane and calibration are not recorded anywhere, so POA is assumed. Proposed: method B only where R16 passes until the mounting is confirmed per site.

### 10.6 Missing references

`pwa-inverter-om-analysis-spec.md`, `string-iv-realtime-spec.md` and `pwa-inverter-plot-style-spec.md` are not in `specs/`, so the states of §3.1, the flags S1–S5 and the rules R30–R36 have no definition in the repo.
