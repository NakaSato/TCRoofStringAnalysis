# Data-Driven Decisions for the TC Roof Solar / GenZ Monitoring Dashboard: KPIs, Thresholds and Decision Rules for Thai C&I Rooftop PV

The dashboard should make decisions from three normalized signals: (1) a temperature-corrected Performance Ratio and an Energy Performance Index (measured ÷ modelled energy) at plant and inverter level; (2) peer-normalized string current, with persistence and irradiance gating, at string level; and (3) energy-based availability with lost kWh priced in THB. Each alarm should be ranked by baht lost per day, not by alarm count. Most numeric thresholds in circulation are vendor practice or research findings, not IEC requirements. Ship them as configurable defaults and calibrate them on 60–90 days of your own fleet data.

## TL;DR

- **Compute these KPIs:** IEC 61724-1 yields (Yr, Ya, Yf), raw and temperature-corrected PR, EPI against a pvlib model, and time- and energy-based availability. Filter data before computing: POA irradiance 200–1,200 W/m² for performance and trends, 30–70 W/m² minimum for availability, plus stale, clipping and curtailment flags. Below inverter level, the main tool should be string current divided by the median of a matched peer group. A string below 0.80–0.85 of its peers for more than 2 hours on 2 or more days is a solid default. Treat it as vendor practice to tune, not a standard.
- **Rank every alarm in THB.** Lost kWh/day × avoided tariff gives the priority. For a factory on TOU at 22–33 kV, the on-peak energy rate is 4.1839 THB/kWh plus Ft 0.1623, so a weekday-weighted solar kWh is worth about 3.9 THB before VAT. Under a private PPA, use the PPA rate instead. Response tiers follow IEA PVPS and SolarPower Europe practice: safety faults or total outage in 4–8 h, major loss in 24–48 h, minor faults at the next scheduled visit.
- **Base soiling, degradation and warranty decisions on long-horizon analytics, not single-day dips.** Use RdTools SRR and CODS for soiling and the year-on-year method for performance-loss rate. Trigger cleaning when the cumulative soiling loss in baht exceeds the cleaning cost, and suppress cleaning in Thailand's monsoon months, when rain does the job. Open a warranty case only when the year-on-year rate, with its confidence interval, is clearly worse than the module warranty slope and drone IR or I–V checks confirm a module-level cause.

## Key Findings

1. **What the standards say.** IEC 61724-1:2021 defines the metrics (yields, PR, the 25 °C and annual-temperature-equivalent PR, bifacial PR, soiling ratio) and the sensor classes.\[1\]\[2\] It does not define alarm thresholds. Those come from contracts (SolarPower Europe, IEA PVPS Task 13) and from vendor or research practice.
2. **Raw PR is a poor alarm signal in Bangkok.** High module temperatures and frequent cloud transients make it noisy. Use temperature-corrected PR' or EPI for decisions, and keep raw PR for reporting.
3. **A failing string is invisible in plant PR.** One string at 80% of its peers on a 400-string plant moves plant PR by about 0.05 percentage points, far below monthly noise. String-level peer comparison is therefore the highest-value analytic in your product.
4. **Several faults have recognizable signatures:**
   - Open string: current ≈ 0 while peers carry current.
   - Shorted bypass diode: a step drop in string voltage of about one-third of one module's voltage, with current unchanged.
   - Soiling: a slow, plant-wide downward ramp that recovers after rain.
   - Shading: a repeatable, time-of-day-locked dip.
   - PID: a progressive loss concentrated on strings or modules near the negative pole.
5. **Soiling in Thailand is seasonal.** A three-year Thailand Science Park study (Journal of Renewable and Sustainable Energy, 2015) found soiling strongly affected PV performance in the dry season, while temperature was the dominant loss in summer. IEA PVPS report T13-25:2022 states that appropriate cleaning in Thailand can cut soiling-related production losses by 6–8% in the summer months.
6. **Degradation benchmarks.** Jordan et al.'s NREL PV Fleet study (Progress in Photovoltaics, 2022; 4,915 inverters) found a median performance-loss rate of −0.75%/yr, from −0.48%/yr in cooler climates to −0.88%/yr in hotter climates, with a fleet P90 of −1.90%/yr. Anything persistently worse than about −1%/yr on a modern c-Si system deserves investigation.
7. **Contract norms.** The availability guarantee is at least 98–99% per year; SolarPower Europe's own text gives both 98% and 99%+ at inverter level.\[3\]\[4\]\[5\]\[6\] Contract availability should be calculated from inverter-level data at 15-minute granularity or finer.\[6\] SolarPower Europe's C&I guidance asks for inverter alarms to be acknowledged at least daily, with action within 2 days on smaller C&I sites.\[7\]

## Details

### 1. KPI catalogue (plant / inverter level)

| KPI | Formula | Data needed | Frequency | Threshold / use | Basis |
|---|---|---|---|---|---|
| Reference yield Yr | H_POA / G_STC (kWh/m² ÷ 1 kW/m² = hours) | POA irradiance (Class A pyranometer or calibrated reference cell) | 1–5 min sampling, 15-min aggregate | Input only | IEC 61724-1 |
| Final (specific) yield Yf | E_AC / P0 (kWh/kWp) | AC meter (±0.5%), nameplate P_STC per inverter | Daily, monthly | Benchmark inverters against each other; flag an inverter below the plant median by >3% for 3 days (site calibration) | IEC 61724-1; threshold is practice |
| Array yield Ya | E_DC / P0 | Inverter DC power | Daily | Ya − Yf = BOS/inverter loss; inverter efficiency drift alarm | IEC 61724-1 |
| PR | Yf / Yr | Above | Daily, monthly, annual | Reporting KPI. Do not alarm on raw daily PR in the tropics. | IEC 61724-1 |
| Temperature-corrected PR' (25 °C or annual-equivalent) | PR / [1 + γ·(T_mod − T_ref)], with T_mod irradiance-weighted | Back-of-module temperature (±2 °C), γ from datasheet | Daily | Alarm: PR' below its 30-day rolling median by >5% for ≥3 clear-ish days (calibrate) | IEC 61724-1 §14.3.2; IEA PVPS T13 Eq. 4 |
| Energy Performance Index (EPI) | E_measured / E_expected(model) | pvlib model fed with measured POA, T_mod, wind | 15 min → daily | Primary decision KPI. Daily EPI < 0.95 is "investigate", < 0.90 is "act" (practice, calibrate). | IEA PVPS T13 |
| Technical availability (time) | (T_useful − T_down) / T_useful, counted only when POA ≥ MIT | Inverter status, POA | 15 min | Annual guarantee ≥98–99% | IEA PVPS T13; SolarPower Europe |
| Contractual availability | (T_useful − T_down + T_excluded) / T_useful | As above + exclusion log (grid, owner-ordered, force majeure) | 15 min | Contract KPI | SolarPower Europe; IEA PVPS T13 |
| Energy-based availability | E_exp,available / E_exp,total (IEC 61724-3) | Expected-energy model | Daily, monthly | Use for THB loss accounting; better than time-based for C&I | IEC 61724-3; IEA PVPS T13 Eq. 13 |
| Soiling ratio SR / soiling loss SL | SR = P_soiled / P_clean (or Isc ratio); SL = 1 − SR | Soiling station (clean vs dirty reference), or RdTools SRR on normalized energy | Daily | Cleaning trigger: see §4 | IEC 61724-1; IEA PVPS T13 Eq. 6–8 |
| Performance loss rate (PLR) | RdTools year-on-year median slope of normalized daily energy | ≥2 years of filtered data | Quarterly re-estimate | Warranty and replacement decisions (§5) | RdTools / NREL |
| Data availability | Valid samples / expected samples | Logger heartbeat | Daily | Below 95% raises a data-quality ticket. KPIs computed on poor data should be greyed out, never shown as 0. | Practice |

**Notes for implementation:**

- **Temperature correction.** IEA PVPS recommends the multiplicative form PR' = PR / [1 + γ(T_mod − T_ref)], the form used in IEC 61724-1. When you aggregate over a period, the module temperature must be irradiance-weighted.\[8\] A worked conversion: with γ = −0.35%/K and T_mod = 55 °C, the 25 °C correction factor is 1 − 0.105 = 0.895. A raw PR of 0.76 therefore becomes PR' ≈ 0.85. This is why raw PR thresholds such as "PR < 70%" give misleading results on hot Bangkok roofs.
- **Other corrections** are available in IEA PVPS Task 13 if your contracts need them: curtailment (exclude curtailed periods and log every exclusion, as IEC 61724-1 requires), soiling (PR/SR) and power factor (PR × PF_ref/PF_meas).\[8\]
- **Where PR and EPI fit.** PR is transparent and contract-friendly. EPI needs a digital-twin model, which is less transparent to the contract parties but easier to correct for weather.\[8\] Use PR for contracts and EPI for operations.
- **Related IEC documents:**
  - IEC TS 61724-2 is the short-term (several sunny days) capacity test, useful at commissioning.
  - IEC TS 61724-3 is the one-year energy evaluation.
  - IEC TS 63265:2022 ("Reliability practices for operation") defines a normative minimum set of reliability processes and tools for operation.\[9\] It relies on the IEC TS 63019 availability information model, which is a good template for your fault and state taxonomy in System → Logs.\[10\]
  - IEC 62446-1 covers as-built documentation and commissioning tests (I–V and insulation baselines you should store per string).

**Monitoring resolution (IEA PVPS Task 13 recommendations):**

- String current and voltage for every string, at 15-minute resolution or better.\[8\]
- Inverter variables sampled in under 1 minute, with up to 15-minute granularity.\[8\]
- Revenue meter uncertainty of ±0.5%.\[8\]

For a cloud-transient climate, store 1–5-minute string data if the inverter API allows it. Peer comparison then works inside cloud gaps.

**Data-quality filtering rules** (run before any KPI; pvanalytics implements most of them):

1. **Day/night mask.** Use solar zenith (pvlib) plus a power-based day/night mask.
2. **Irradiance plausibility.**
   - QCrad limits on GHI/DHI/DNI (`check_irradiance_limits_qcrad`).\[11\]
   - Clear-sky limit: flag POA well above the clear-sky value (`clearsky_limits`).\[11\]
   - Daily insolation limits (`daily_insolation_limits`).\[11\]
3. **Stale or flatlined values.** Use `stale_values_round` (window of about 3 samples) and `interpolation_diff` to catch logger forward-fill.\[12\] This matters for your realtime weather station: a frozen irradiance value silently inflates PR.
4. **Temperature limits.** The PV Fleets QA pipeline uses −40 to 185 °C for module temperature and −40 to 120 °C for ambient, plus a z-score outlier filter (>4σ).\[12\]
5. **Performance/trend filter.** Use POA between 200 and 1,200 W/m², the NREL/RdTools default; below about 200 W/m², start-up and low-light effects dominate.\[13\]\[14\] Cell temperature should be within −50 to 110 °C.\[13\] Add a normalized-energy outlier filter.
6. **Availability threshold.** Count a period as "should be producing" only when POA is at least 30 W/m² (IEA) or 50–70 W/m² (typical SolarPower Europe minimum irradiance threshold).\[6\]\[8\] Choose one value and write it into the contract.
7. **Clipping.** Use pvanalytics `features.clipping.geometric/levels/threshold` or RdTools `clip_filter` / `logic_clip_filter` / `xgboost_clip_filter`.\[11\]\[15\] A simple fallback excludes AC power above 99% of the 95th-percentile power.\[14\]
8. **Data shifts.** Use `detect_data_shifts` (changepoint detection) for sensor swaps, recalibration and capacity changes.\[16\] Pair it with change-management records whenever an inverter or sensor is replaced.
9. **Curtailment and export limiting.** On a zero-export or export-limited C&I site, a flat power plateau below inverter rating while POA is high is self-curtailment, not a fault. Detect it from the export-limiter or meter signal. Label it "curtailed" and exclude it from PR and availability penalties, but report it as lost opportunity.

### 2. String-level analytics and decision rules

**Core metric.** For each string i in a peer group (same inverter or MPPT, same orientation, tilt and module count):

- Normalized current: I_norm,i = I_i / (I_ref × G_POA/1000), where I_ref is the module Imp or Isc at STC.
- Peer ratio: R_i = I_i / median(I_peers).
- Deviation: D_i = 100 × (I_i − I_ref,peer) / I_ref,peer.

The median is preferred over the mean because a single dead string would otherwise drag the reference down. Normalize by installed DC capacity when strings differ in length or module count.\[17\] Never compare east-facing strings with west-facing ones.

**Gating, to avoid false alarms in tropical cloud transients:**

- Evaluate only when POA is at least 300–400 W/m² (or the best string carries at least about 2 A), the sun is more than 0.5 h past sunrise and before sunset, and the 5-minute irradiance variability index is low.
- Require persistence before alarming.
- Use time-of-day-aware thresholds. One fixed threshold either suppresses midday faults or fires every morning.\[18\]

**Published threshold references** (none of these is an IEC value):

- **Locus Energy (AlsoEnergy) default:** string-to-best-string ratio 0.8, held for 2 hours, best string above 2 A, 0.5 h sunrise/sunset buffer, using 5-minute normalized current.\[19\]
- **SCADA-vendor guidance:** "more than 15% deviation for three consecutive valid intervals", explicitly "not a universal IEC threshold".\[17\]
- **Monitoring vendors:**
  - Investigate when deviation exceeds 10%; treat it as critical above 20%.\[20\]
  - Flag strings 15% below the group average for 3 or more consecutive days.\[20\]
  - Some propose 5% for string-to-string comparison, which in practice is only workable on clear days and with good sensors.\[21\]
- **Your own TCRoof iPad settings** already default to "low string current 20%" and "low PR 70%".\[22\] The string default is reasonable as an "act" tier. The PR default should move to PR' or EPI.

**Fault-signature rules:**

| Fault | Signature in string data | Rule (default, calibrate) | Confirm with |
|---|---|---|---|
| Open circuit / blown fuse / disconnected MC4 | I ≈ 0 (<0.1 A) while peers > 2 A; V ≈ open-circuit or 0 depending on topology | 3 consecutive valid samples → Critical (immediate for C&I safety review) | Site check: fuse, connector, isolator |
| Short circuit / reverse current / ground fault | Negative or abnormally high current; inverter insulation (Riso) or GFDI alarm | Any occurrence → Critical, safety | Insulation-resistance test (IEC 62446-1) |
| Shorted bypass diode | Step drop in string V of about Vmp_module/3 (≈1/(3N) of string V; for N = 20 modules ≈ 1.7%), current unchanged, persists in full sun | String V below peer-median V by >1.2% (one-diode step) for ≥2 days at POA > 500 W/m² → Major. The tight band needs voltage sensing better than 0.5%. | Drone IR: one hot substring (third of module) "patchwork" pattern; Voc check per module |
| Multiple diodes / modules bypassed | Larger V steps in multiples of the single-diode step | Same rule, severity scales with step count | IR + I–V |
| Soiling | All strings decline slowly together; recovers after rain >~1–10 mm/day | Not a string alarm; plant-level SRR (§4) | Visual, soiling station |
| Non-uniform soiling (bird droppings, lower edge dirt) | Some strings drift down relative to peers; partial recovery after rain | R_i down 3–8% vs post-clean baseline for >7 days → Minor, add to next cleaning | Drone RGB/IR |
| Shading (structure, new obstacle, vegetation) | Time-of-day-locked dip, repeatable on clear days, seasonal | Dip recurs at the same solar position on ≥3 clear days → classify "shading" and suppress future alarms in that window | Site photo, horizon survey |
| Mismatch / degraded modules / cracked cells | Persistent R_i 0.90–0.97 with no time pattern | 30-day median R_i < 0.95 → Minor, schedule IR | IR thermography, I–V curve |
| PID | Gradual multi-month loss in a group of strings, often worse at night-humid seasons; modules nearest negative pole hottest/weakest | Month-on-month R_i decline >1%/month on ≥2 strings in same inverter → Major, investigate | IR (module-wide warm cells near negative end), EL, I–V |
| Wrong string count / miswiring | Constant V offset of ≈ one module's Vmp from day 1 | At commissioning or after any repair | As-built check |

**Why voltage resolution matters.** Bypass-diode detection from monitoring data depends on resolving a voltage step of about 1–2%. Many inverters report string voltage only per MPPT, and all strings on one MPPT share the same voltage, so the step cannot be seen there. On those inverters, detection falls to drone IR. Record in the dashboard which inverters provide per-string voltage.

### 3. Inverter and system-level rules

- **Inverter availability state model.** Classify each 15-minute interval as Producing, Fault (OEM code), Grid-out (AC voltage/frequency outside limits, utility event), Curtailed/export-limited, Planned maintenance, Communication loss (production unknown, kept separate from downtime), or Night. Only "Fault" counts against technical availability; contractual availability additionally excludes grid and owner-ordered events.\[6\] Follow IEC TS 63019 categories for the taxonomy.
- **Communication loss versus real outage.** A missing data stream is not downtime. Cross-check the revenue meter or the neighbouring inverter, and raise a separate "data" ticket. The pvOps package (Sandia) exists precisely because production data alone cannot distinguish an offline logger from an offline plant.\[23\]
- **Inverter underperformance.** Flag an inverter when its daily Yf is below the plant's inverter median by more than 3% on two consecutive days, at irradiance-weighted conditions. If DC power is normal but AC is low, suspect inverter efficiency, fan or filter, or thermal derating. IEA PVPS reports inverter cabinets reaching 60 °C in Thailand and recommends ventilation design and regular filter cleaning.\[24\]
- **Thermal derating rule.** Flag when AC power plateaus below the rating while POA rises and the internal temperature exceeds the OEM derate point. The action is to clean the filters and check ventilation.
- **Clipping.** Clipping is not a fault but an economic signal. Report clipped energy (modelled DC minus AC cap) monthly. Exclude clipped periods from PR', EPI and string-ratio analyses.
- **MPPT issues.** Detect MPPT tracking or hunting when the DC voltage oscillates and power sits below the model on a stable-irradiance interval. Also flag MPPT inputs whose voltage sits far from the expected Vmp (temperature-corrected) by more than 5%.
- **Grid events.** Log over- and under-voltage and frequency trips, with their counts per week. Repeated afternoon overvoltage trips on a weak feeder are a common C&I problem. The action is to review reactive-power and volt-var settings with the utility or customer, not to dispatch a technician.
- **Alarm prioritization and alarm-fatigue control:**
  - Deduplicate: one root-cause ticket per inverter, with string alarms nested under it.
  - Require persistence: N consecutive valid intervals and/or N days.
  - Suppress alarms during known exclusions: night, curtailment, grid-out, planned maintenance.
  - Auto-classify recurring shading windows.
  - Rank the ticket queue by THB/day lost, not by the order alarms arrived.
  - Link every ticket to the alarm that triggered it, as SolarPower Europe recommends.\[4\] That history is your future ML training set.
  - Track the alarm-to-work-order conversion rate monthly. If fewer than about 30–50% of alarms turn into real work, the thresholds are too tight (this cut-off is a heuristic).
- **Escalation model.** SolarPower Europe's support model has three levels. The Operations Center (1st level) detects the fault, opens the ticket and tries to resolve it remotely. It escalates to engineers (2nd level), then to vendor or specialist experts (3rd level).\[4\]

### 4. Soiling and cleaning decisions

**Estimation options, from best to cheapest:**

1. **Soiling station.** A clean reference module (or cell) is compared with a soiled one: SR = P_soiled/P_clean, with the Isc ratio as fallback.\[8\] IEC 61724-1 defines this.
2. **RdTools SRR (stochastic rate and recovery; Deceglie et al., IEEE JPV 2018).** It works on daily insolation-weighted normalized energy, finds soiling intervals between cleaning or rain events, and produces a Monte-Carlo P50 insolation-weighted soiling ratio with confidence intervals.\[25\]\[26\] It works best on "sawtooth" soiling: a linear decline followed by a sharp recovery.\[27\]
3. **RdTools CODS (combined degradation and soiling; Skomedal & Deceglie 2020).** It separates trend, seasonality and soiling.\[28\]\[29\] This matters in Thailand, where seasonal temperature and soiling are confounded.
4. **Cleaning-event step estimate.** Take normalized energy over the 3–5 clear days after a manual cleaning minus the 3–5 days before; the difference is the realized recovery. Log each cleaning as an event so SRR can use it.

**Thailand and Southeast Asia considerations:**

- A three-year Thailand Science Park study (Journal of Renewable and Sustainable Energy, 2015) found soiling dominated performance loss in the dry season, while summer losses were mostly thermal. The rainy season showed high performance-loss rates linked to low irradiance and high humidity, not to soiling.
- A South Asian sub-tropical field study concluded that "cleaning is redundant in the monsoon season". Its dry-season soiling rates ranged from 1.21%/day on horizontal modules down to 0.05%/day at steep tilt.\[30\]
- Low-tilt C&I roofs soil fastest. Many Thai metal-sheet roofs are 5–10°, so expect dry-season rates closer to the high end. Measure yours.
- The rain needed to clean modules is reported as 1–10 mm/day, sometimes up to 20 mm/day.\[31\] Light rain can make soiling worse by cementing dust.\[32\]
- Industrial-roof contaminants (exhaust soot, rice husk ash, bird droppings) may not wash off in rain. Watch for incomplete recovery after rain events in SRR (`random_clean` / `half_norm_clean` recovery modes).

**Decision rule (economic).** With a roughly linear soiling rate r (fraction/day), clean-plant daily energy E (kWh/day), avoided tariff p (THB/kWh) and cleaning cost C (THB per event):

- Average daily cost over an interval T is C/T + r·E·p·T/2. It is minimized at **T\* = √(2C / (r·E·p))**.
- Equivalently: **clean when cumulative lost revenue since the last cleaning, Σ(SL_t·E_t·p), exceeds C**. Implement this as a running "soiling wallet" on the dashboard.
- Gates:
  - Do not clean if a rain event of 10 mm or more is forecast within the next 3–5 days.
  - Do not clean in the monsoon (roughly mid-May to mid-October in central Thailand; calibrate to local rain data).
  - Concentrate cleaning in the dry season (November to April).
- **Illustrative example** (assumptions, replace with site data): a 1 MWp roof, E = 3,800 kWh/day, r = 0.10%/day, p = 3.9 THB/kWh and C = 20,000 THB per wash give r·E·p ≈ 14.8 THB/day². Then T\* ≈ √(2×20,000/14.8) ≈ 52 days, with about 5% soiling loss at the moment of cleaning. Doubling the soiling rate shortens T\* to about 37 days.

**Research benchmarks for calibration:**

- Micheli et al. (Progress in PV, 2022): three cleanings per year were optimal at $1.9/kW cleaning cost and $0.16/kWh. Cleaning only the dirtiest strings improved profit by less than 1%, so whole-roof cleaning is usually fine.\[33\]
- Seasonal-soiling economics (Energy, 2020): even with 2.8% annual soiling, an optimized schedule raised profits by up to 3.6%.\[34\]
- Senegal utility plant: the optimal dry-season interval was 14 days and reduced dust-related cost by 31%.\[35\]
- Global analysis (Applied Energy, 2021): median revenue loss in Asia/MENA stays at about 2.5% even with optimal cleaning every 5–6 days.\[36\] This is a desert-dominated benchmark that will overstate Thailand.

### 5. Degradation, warranty and replacement decisions

- **Method.** Run RdTools `degradation_year_on_year` on daily, insolation-weighted, filtered normalized energy (sensor-based or clear-sky workflow).\[27\]\[37\]\[38\] Report the median PLR, the 68.2% confidence interval and the P95 exceedance value.\[26\]\[38\] Run the clear-sky workflow in parallel: when the two disagree, it usually exposes pyranometer drift or recalibration.\[15\] Data needs are at least 2 years (3 or more for a stable estimate), with data shifts removed.
- **Benchmarks.**
  - NREL PV Fleet (4,915 inverters): median −0.75%/yr; cooler climates −0.48%/yr, hotter climates −0.88%/yr.\[39\]
  - Jordan & Kurtz meta-review (Progress in PV, 2013; nearly 2,000 rates): median 0.5%/yr, mean 0.8%/yr.
  - Hot-humid c-Si: Jordan et al. reported a median of about 0.6%/yr (683 observations).\[40\]
- **Decision rules:**
  - PLR between 0 and −0.8%/yr: normal, no action.
  - PLR of −0.8 to −1.5%/yr, or worse than the module datasheet's linear warranty slope: investigate. Run per-inverter and per-string PLR to localize the loss, then commission a drone IR survey (IEC TS 62446-3) and sample I–V curves.
  - PLR worse than −1.5%/yr with the confidence interval excluding the warranty slope, and a module-level cause confirmed by IR, EL or I–V: prepare a warranty claim. Attach the PLR analysis, IR report, I–V data corrected to STC, and serial numbers.
  - PLR concentrated in specific strings (PID, backsheet failure): treat as a defect claim, not a degradation claim.
- **Replacement economics.**
  - Replace a module or string when the NPV of recovered energy over the remaining life exceeds the replacement cost (parts, labour, roof access and downtime). Treat safety-class thermal defects (CoA 3) as mandatory regardless of NPV.
  - For an inverter fault, compare repair or replacement cost against the daily THB loss times the expected downtime. This is why spare-inverter stock pays off on multi-site portfolios.
  - When replacing modules, match string current. Mixing old 7 A modules with new 10 A modules forces bypass-diode operation on the old ones.\[41\]

### 6. Expected-energy modelling, anomaly detection and drone IR integration

**Physical model (start here).** Build a pvlib ModelChain per inverter or MPPT:

- Transposition: measured POA, or GHI → POA via Perez/Hay.
- Cell temperature: SAPM or Faiman, fitted to your back-of-module sensors.
- DC model: PVWatts or single-diode.
- Losses: inverter efficiency curve, wiring, clipping.

The output is E_expected per 15 minutes, which feeds both EPI and energy-based availability. pvOps also includes an IEC-style expected-energy calculation (`timeseries.models.iec`) and linear-regression models.\[42\]

**Data-driven layer (add after 3–6 months of clean data):**

- **Regression or gradient boosting.** Predict inverter or string power from POA, T_mod, solar angles and time features, trained only on healthy and clean periods.
- **Unsupervised detectors.** Published options include variational autoencoders, one-class SVM, ICA and kernel-norm monitoring.\[43\] They are useful for multi-signal anomalies, such as fan or temperature behaviour, but harder to explain to technicians.
- **Digital twins and edge ML.** Examples include the 2026 Scientific Reports VEAD edge framework and hybrid physics-based twin plus ML classifiers for DC–DC converters.\[44\]\[45\] Treat them as roadmap items; most report synthetic or injected faults rather than long fleet validations.

**Recommended rule.** Compute daily residuals, EPI − 1. Estimate μ and σ over a rolling 30–60 days excluding labelled events. Alarm at **EPI < μ − 3σ** for 1 day ("act") or **< μ − 2σ for 3 days** ("investigate"). This is standard control-chart practice and should be tuned per site.

**Weather station versus satellite irradiance:**

- **Ground sensors.** Class A pyranometers achieve about ±3% hourly and ±2% daily uncertainty. Class C sensors are about ±20% hourly and ±10% daily.\[46\]
- **Satellite products.**
  - Solcast's global validation: hourly GHI rRMSE of 3.4% in clear sky, 25.6% in cloudy sky and 16.9% all-sky.\[47\]
  - IEA PVPS Task 13: hourly RMSE of about 19–23% for the better satellite services, and about 9–11% on daily totals.\[48\]
  - A Thai Himawari-8 deep-learning study: best-model MAE of 78.58 W/m² against Thai ground stations.\[49\]
- **Implication.** Use your on-site station for 5–15-minute EPI and availability. Use satellite as a cross-check and gap-filler, and for monthly or annual reporting where errors average out. Never fire a string or inverter alarm on satellite irradiance alone. String peer ratios need no irradiance at all, which is their strength.
- **Station-health rule.** Flag the irradiance sensor when the ratio of daily on-site POA insolation to satellite POA drifts by more than 5% over 14 days. Likely causes are soiled dome, misalignment or a stale value.

**Drone IR (DJI Mavic 3T) integrated with IEC TS 62446-3:**

- **Capture conditions.**
  - POA irradiance of at least 600 W/m², stable sky;\[50\] check the irradiance log from your weather station and save it with the flight.\[8\]
  - Camera NETD ≤ 0.1 K.\[8\]\[51\]
  - Resolution of about 3 cm of module edge per pixel or finer;\[51\] check altitude against the 640-pixel thermal sensor.
- **Classes.** The TS defines three Classes of Abnormality: CoA 1 (no abnormality), CoA 2 (thermal abnormality) and CoA 3 (safety-relevant thermal abnormality).\[52\] ΔT bands depend on the thermal pattern, and the TS itself does not give universal temperature cut-offs.\[51\]\[53\] Industry commonly reads about ΔT ≥ 10 K against comparable modules as CoA 2,\[50\] with higher ΔT, or any connector or junction-box heating, escalating to CoA 3. Some providers normalize ΔT to 1,000 W/m² (ΔT_n = ΔT × 1000/G) and use 10 K / 20 K bins.\[54\] Treat these as provider conventions, not normative values.
- **Fusion rules:**
  1. Geotag each anomaly to module ID → string → inverter, using the as-built string map.
  2. Join with string analytics. An IR "substring hot" finding on a string with a ~1.7% voltage step confirms a bypass diode (raise confidence and priority). An IR hotspot on a string with no electrical deviation stays CoA 2 "monitor" unless it is safety-relevant.
  3. Convert each finding to estimated kW lost (substring ≈ 1/3 module; full module; whole string), then to THB/day for the work-order queue.
  4. Re-fly after repair for closure evidence.
- **Cost reference.** IEA PVPS cites aerial IR at about 0.5–3 € per module on a twice-yearly basis, against base O&M of 6.5–16.5 €/kWp·yr.\[8\] For C&I roofs, an in-house Mavic 3T makes annual (dry-season) and post-alarm flights cheap.

### 7. Decision economics in THB

**Price of a lost kWh.** For a factory on a TOU tariff (category 3/4) at 22–33 kV, rates are:

- On-peak 4.1839 THB/kWh (Mon–Fri 09:00–22:00).\[55\]
- Off-peak 2.6037 THB/kWh.\[55\]
- Plus Ft of 16.23 satang/kWh for September–December 2026, which ERC held at the previous level by applying 16,127.17 million THB of claw-back funds (25.04 satang/unit), keeping the average tariff at 3.95 THB/kWh before VAT.
- Plus 7% VAT.

Most rooftop solar falls on-peak on weekdays, while weekend output is off-peak. A simple weighting (5/7 × 4.346 + 2/7 × 2.766) gives an avoided cost of about **3.9 THB/kWh** excluding VAT. Use the actual metered interval split once you have it. Demand-charge savings (132.93 THB/kW at 22–33 kV)\[55\] are not reliable from solar alone, so exclude them from fault valuation.

**Under a private PPA**, use the PPA rate: the developer loses revenue and the customer loses the discount. Thai market PPAs are typically 15–25 years at 10–30% below the grid tariff (installer marketing figures; check each contract).\[56\]\[57\] For export to the grid, the residential net-billing buyback is 2.20 THB/kWh.\[58\] C&I export is usually limited, so exported kWh are worth far less than self-consumed kWh.

**Fault valuation:**

- THB/day = (kW lost) × (equivalent full-sun hours/day) × (THB/kWh).
- Example: one 20-module string of 550 W modules (11 kWp) fully open, at about 3.8 kWh/kWp/day (replace with your measured Yf), loses about 42 kWh/day, worth about 163 THB/day or about 4,900 THB/month.
- A shorted bypass diode costs about 1/3 of one module: roughly 0.7 kWh/day, about 2.7 THB/day. It is still worth fixing at the next visit because of the hotspot risk.
- An inverter of 100 kW down on a sunny weekday loses about 380 kWh, about 1,480 THB/day.

**Work-order priority score.** Priority = safety flag (overrides everything) → THB/day × expected days-to-fix if not escalated → cost to fix. Dispatch immediately when (THB/day × days saved by an extra trip) > extra trip cost. Otherwise bundle the fix into the next planned visit.

**Response-time tiers:**

- IEA PVPS Task 13: safety-impacting faults or 100% plant outage are critical, responded to within 4–8 hours. Faults with major production loss are major, addressed within 24–48 hours. Non-critical events wait for the next periodic maintenance cycle.\[8\]
- SolarPower Europe's v1.0 example table: about 2 h acknowledgement / 12 h response for plant-wide events, 4 h / 24 h for the next class, and 6 h / 36 h for the next. It adds that the "times will vary greatly depending on the location of the plant and the contract."\[59\]
- SolarPower Europe's C&I guidance: acknowledge inverter alarms at least daily, act within 2 days on smaller C&I sites, and repair or replace failed inverters within 1 day.\[7\]
- Response Time = Acknowledgement Time + Intervention Time. Resolution Time is generally not guaranteed.\[4\]\[6\]\[60\]

**O&M contract KPIs to compute and display:**

- Guaranteed availability (best practice ≥98%/yr,\[4\] with SolarPower Europe also citing 99%+ at inverter level; IEA says at least 99%).\[3\]\[5\]\[8\]
- Guaranteed PR, if used. Two approaches exist: set the guarantee equal to the theoretical PR (e.g. 85%), or set it slightly below.\[8\]
- Response-time compliance.
- MTTR (mean of fault-to-resolution time per fault class).
- MTBF per component type (operating hours ÷ failures). Log failures by component and OEM, which pvOps survival analysis can use.
- Data availability.
- Alarm-to-ticket ratio.

SolarPower Europe considers it best practice to guarantee Availability and Response Time rather than PR,\[3\] because PR mixes O&M performance with design and weather risk the contractor does not control.\[5\]

### 8. Dashboard design

**Levels.** SolarPower Europe calls portfolio, plant and inverter levels a minimum and string level a recommendation. It also asks for aggregations from the raw interval up to monthly and quarterly, and for custom client thresholds.\[4\]

| Level | KPIs shown | Aggregation | Alert tier |
|---|---|---|---|
| Portfolio | Energy vs budget (P50), EPI, energy-based availability, THB lost (by cause), open tickets by THB/day, MTTR, data availability | Daily / MTD / YTD | Weekly review |
| Plant | Yr, Yf, PR, PR', EPI, availability (tech/contract/energy), soiling SR + "soiling wallet", clipping & curtailment loss, weather-station health | 15 min / day / month | Plant-level alarms |
| Inverter | Yf vs inverter median, DC/AC efficiency, internal temperature/derating, fault codes, grid trips | 5–15 min / day | Inverter alarms |
| String / MPPT | Peer ratio R_i heatmap (strings × days), V vs peer V, last IR finding, PLR per string (long term) | 1–15 min / daily median | String alarms (nested under inverter) |

**Alert tiers:**

- **P1 Critical:** safety risk (ground fault, arc, CoA 3), plant or inverter fully down, or more than 30% of plant power lost. Respond within 4–8 h.
- **P2 Major:** lost value above a set THB/day threshold (e.g. 300 THB/day; calibrate) or more than 5% of plant. Respond within 24–48 h.
- **P3 Minor:** small persistent loss. Bundle into the next planned visit.
- **P4 Info/data:** sensor, communications and stale data. Route to the data owner.

**Master decision-rule table** (D = default to configure; R = research-based; S = standard or contract-based; C = calibrate per site):

| # | Signal | Rule | Threshold (basis) | Action | Owner |
|---|---|---|---|---|---|
| 1 | String current vs peer median | R_i below threshold, POA > 400 W/m², persistent | <0.80 for >2 h (D, Locus default); <0.85 on 3 intervals (D, practice) | P2: remote triage → site check | Ops center → field tech |
| 2 | String current ≈ 0 | I < 0.1 A while peers > 2 A | 3 valid samples (D) | P1/P2 by THB: check fuse/MC4/isolator | Field tech |
| 3 | Negative current / Riso / GFDI | Any | Any (S, safety) | P1: isolate, insulation test | Licensed electrician |
| 4 | String V step | V below peer V by one diode step | >1.2% for ≥2 days at >500 W/m² (D/C) | P3: IR flight → replace diode/junction box or module | O&M engineer |
| 5 | Slow peer drift | 30-day median R_i | <0.95 (D/C) | P3: IR + I–V at next visit | O&M engineer |
| 6 | Time-locked dip | Recurs at same solar position | ≥3 clear days (D) | Label shading; suppress; assess trimming/obstacle | Analyst |
| 7 | Inverter Yf vs inverter median | Daily | <−3% for 2 days (D/C) | P2/P3: filters, fans, derating, MPPT check | Field tech / OEM |
| 8 | Inverter down | Status = fault, POA ≥ MIT | Any interval (S) | P1 if large share of plant; OEM ticket; spare swap | Ops center / OEM |
| 9 | Grid trips | Over/under-V or f trips | ≥3/week (D) | Review settings with utility/customer | Engineer |
| 10 | Plant EPI | Daily residual | <μ−3σ (1 day) or <μ−2σ (3 days) (D/C) | Drill down to inverter/string; check sensors | Analyst |
| 11 | PR' trend | vs 30-day median | −5% for ≥3 days (D/C) | Check soiling, sensors, curtailment | Analyst |
| 12 | Soiling wallet | Σ lost THB since last clean ≥ cleaning cost | Economic (R) with rain/monsoon gate | Schedule cleaning; log event | Asset manager |
| 13 | Post-rain recovery incomplete | SRR recovery < 50% after ≥10 mm rain | (D/C) | Manual clean; investigate sticky soiling | O&M |
| 14 | PLR (YoY) | Median & CI | Worse than −0.8%/yr investigate; worse than warranty slope with CI + IR/I–V evidence → claim (R/C) | Warranty claim / replacement NPV | Asset manager |
| 15 | IR finding | CoA 3 / CoA 2 per IEC TS 62446-3 | Pattern-based (S); ΔT ≥10 K common practice (D) | CoA 3 → P1 safety; CoA 2 → value-ranked P2/P3 | O&M engineer |
| 16 | Irradiance sensor | Stale / vs satellite drift | Stale window 3+ samples; >5% drift 14 days (D) | Clean/recalibrate; mark KPIs "low confidence" | Data owner |
| 17 | Data availability | Valid samples per day | <95% (D) | Comms ticket; never show missing as 0 | Data owner |
| 18 | Export limiting | Power plateau + export ≈ 0 | Pattern (D) | Label curtailed; exclude from penalties; report as lost opportunity | Analyst / sales |

### 9. Implementation notes for the developer

- **Pipeline:** ingest (inverter API / Modbus / logger) → raw store (keep raw, never overwrite) → pvanalytics QA flags (stored as boolean columns, not deletions) → pvlib expected power → KPI engine (15-min, daily) → rule engine (persistence counters per entity) → ticket service (linked to alarms, System → Logs) → monthly RdTools jobs (SRR, CODS, YoY) → reports.
- **Configuration.** Make every threshold a per-site, per-peer-group setting with version history. Your existing `stringLowPercent` and `prLowPercent` settings should become a rules table with columns for metric, comparator, threshold, persistence, irradiance gate, tier and owner.
- **Peer groups.** Store orientation, tilt, module model and count per string from the as-built documents. Auto-validate each group by checking that the group's clear-day current correlation exceeds 0.98 (heuristic).
- **Units and timezones.** Store UTC and render Asia/Bangkok. Run pvanalytics time-shift and DST checks anyway, because some loggers ship local time.
- **Missing values.** Display "—" for missing values, never 0. Your iPad issue #353 already specifies this.\[22\]
- **Labelled events.** Log every cleaning, repair, IR flight and curtailment as a typed event. SRR, CODS and future ML all depend on these labels.
- **Libraries:**
  - **pvlib:** solar position, clear sky, transposition, temperature and PV models.
  - **pvanalytics:** QA, clipping, day/night, data shifts, orientation inference.
  - **RdTools:** YoY degradation, SRR and CODS soiling, TrendAnalysis.
  - **pvOps (Sandia, JOSS 2023):** O&M ticket text cleaning, fusion of tickets with time series, expected-energy models, survival analysis, I–V tools.\[61\]\[62\]
- **Papers to read:**
  - Deceglie, Micheli & Muller (IEEE JPV 2018), SRR.
  - Skomedal & Deceglie (2020), CODS.
  - Jordan & Kurtz (Progress in PV, 2013), degradation review.
  - Jordan et al. (Progress in PV, 2022), PV Fleet insights.
  - Micheli et al. (Progress in PV, 2022), non-uniform soiling and cleaning optimization.
  - IEA PVPS T13-25:2022 (O&M in different climates; Chapter 5.4 was written with KMUTT's CSSC, Bangkok).\[8\]
  - IEA PVPS Task 13 report on uncertainties in PV yield prediction and assessment.
  - arXiv 2409.16320 (Thailand Himawari-8 irradiance mapping).
  - arXiv 2301.12939 (data-driven soiling detection).\[63\]
  - arXiv 2603.07518 (reinforcement-learning cleaning scheduling).\[64\]
  - arXiv 2607.01541 (unsupervised kernel-norm PV fault monitoring, including references to VAE and one-class SVM detectors).

## Recommendations

1. **First 4 weeks.** Implement QA flags, gated string peer ratios (rules 1–3), the inverter state model and energy-based availability. These catch most lost THB on C&I roofs.
2. **By month 3.** Add the pvlib expected-energy model and EPI, temperature-corrected PR' (replace the raw "PR < 70%" alarm), THB valuation and the priority queue. Integrate drone IR results keyed to string IDs.
3. **After one dry season.** Run SRR and CODS. Calibrate the soiling rate per roof, enable the "soiling wallet" cleaning trigger, and lock in a monsoon suppression window.
4. **After 2+ years.** Run YoY PLR per inverter and per string, and add warranty-claim packaging.
5. **Calibration protocol.** Run every default threshold in "shadow mode" for 60–90 days, logging alarms without dispatching. Compare them against confirmed field findings, then set the thresholds that keep about 1 false dispatch or fewer per 10 true ones.

## Caveats

- **Thresholds.** IEC standards define metrics, not alarm thresholds. String, PR and EPI thresholds quoted here are vendor defaults or engineering heuristics, so treat them as starting points. IR ΔT bins are provider conventions; IEC TS 62446-3 classifies by pattern and CoA.
- **Tariffs.** Figures are as published for 2026 (Ft fixed through December 2026). They change every four months and differ by voltage level, so pull them from config, not code.
- **PPA figures.** Discount figures (10–30%) come from installer marketing and vary by contract.
- **Soiling rates.** Rates from South Asian, semi-arid or desert studies do not transfer directly to Thai rooftops. Measure your own with a soiling station or SRR before trusting cleaning economics.
- **Satellite accuracy.** Validation statistics vary by product and region. Thai cloud regimes are harder than the global averages suggest.
- **Contract availability.** SolarPower Europe's guidance gives both 98% and 99%+ minimum guarantees in different sections.\[3\]\[5\] Fix the number in each contract.

## Sources

1. [EN IEC 61724-1:2021 - Photovoltaic System Performance Monitoring Standard](https://standards.iteh.ai/catalog/standards/clc/6bb48c72-4e39-4548-a99b-1fc38e17cf44/en-iec-61724-1-2021)
2. [IEC 61724-1 Edition 2.0 2021-07 INTERNATIONAL STANDARD NORME INTERNATIONALE](https://previewnorm.com/iec/IEC%2061724-1-2021%20PDF.pdf)
3. [Detail - Solar Best Practices](https://solarbestpractices.com/guidelines/detail/executive-summary-2)
4. [Onboarding Best Practice Guidelines](https://solarbestpractices.com/guidelines/detail/monitoring)
5. [Detail - Solar Best Practices](https://solarbestpractices.com/guidelines/detail/contractual-framework)
6. [Detail - Solar Best Practices](https://solarbestpractices.com/guidelines/detail/key-performance-indicators)
7. [Detail - Solar Best Practices](https://solarbestpractices.com/guidelines/detail/o-m-for-rooftop-solar)
8. <https://iea-pvps.org/wp-content/uploads/2022/11/IEA-PVPS-Report-T13-25-2022-OandM-Guidelines.pdf>
9. [IEC TS 63265:2022](https://webstore.iec.ch/en/publication/64942)
10. [IEC TS 63265 Edition 1.0 2022-06 TECHNICAL SPECIFICATION](https://cdn.standards.iteh.ai/samples/103189/0e42ce4fd7be4c62a471c254d16a9b2d/IEC-TS-63265-2022.pdf)
11. [API Reference — PVAnalytics documentation](https://pvanalytics.readthedocs.io/en/stable/api.html)
12. [PV Fleets QA Process: Temperature — PVAnalytics documentation](https://pvanalytics.readthedocs.io/en/latest/generated/gallery/pvfleets-qa-pipeline/pvfleets-temperature-qa.html)
13. [(PDF) Photovoltaic fleet degradation insights](https://www.researchgate.net/publication/360168832_Photovoltaic_fleet_degradation_insights)
14. [Home · NatLabRockies/rdtools Wiki · GitHub](https://github.com/NatLabRockies/rdtools/wiki)
15. [RdTools Overview — RdTools 2.1.8+0.g17970d3.dirty documentation](https://rdtools.readthedocs.io/en/2.1.8/)
16. [PVAnalytics: A Python Package for Automated Processing of ...](https://docs.nrel.gov/docs/fy22osti/83824.pdf)
17. [PV string monitoring: from hidden-loss detection to energy-loss calculation](https://harmonyscada.com/blog/en/pv-string-monitoring-guide.html)
18. [String-Level Monitoring: Catching Underperformance 30 Days Before It Hits Your PR Report](https://www.dynvolt.com/blog/string-level-monitoring-underperformance-detection)
19. [String Performance Alerts](http://help.locusenergy.com/en/articles/2065847-string-performance-alerts)
20. [String-Level Monitoring: Why It Matters for Solar Plant Performance](https://arptechnologies.co/blog/string-level-monitoring-importance/)
21. [What Is String Monitoring? Definition & Guide](https://www.surgepv.com/glossary/string-monitoring)
22. [iPad Monitoring · act on the สตริงกระแสต่ำ and PR ต่ำ thresholds · Issue #353 · NakaSato/TCRoof · GitHub](https://github.com/NakaSato/TCRoof/issues/353)
23. [PvOps: Improving Operational Assessments through Data Fusion](https://www.sandia.gov/research/publications/details/pvops-improving-operational-assessments-through-data-fusion-2021-06-01-1/)
24. [(PDF) Guidelines for Operation and Maintenance of Photovoltaic Power Plants in Different Climates](https://www.researchgate.net/publication/365000034_Guidelines_for_Operation_and_Maintenance_of_Photovoltaic_Power_Plants_in_Different_Climates)
25. [RdTools Release 2.0.1+0.gc6fd05f.dirty Oct 30, 2020](https://rdtools.readthedocs.io/_/downloads/en/2.0.1/pdf/)
26. [Degradation and soiling example — RdTools 3.0.0 documentation](https://rdtools.readthedocs.io/en/3.0.0/examples/degradation_and_soiling_example.html)
27. [RdTools Overview — RdTools 3.2.1 documentation](https://rdtools.readthedocs.io/en/stable/)
28. [rdtools/rdtools/soiling.py at master · NatLabRockies/rdtools · GitHub](https://github.com/NatLabRockies/rdtools/blob/master/rdtools/soiling.py)
29. [rdtools.soiling — RdTools 3.2.1 documentation](https://rdtools.readthedocs.io/en/stable/generated/rdtools.soiling.html)
30. [Experimental study of effects of soiling on various solar panel tilts in a sub-tropical climate in South Asia - ScienceDirect](https://www.sciencedirect.com/science/article/abs/pii/S2213138824002868)
31. [Analysis of Soiling Loss in Photovoltaic Modules: A Review of the Impact of Atmospheric Parameters, Soil Properties, and Mitigation Approaches](https://www.mdpi.com/2071-1050/15/24/16669)
32. [Multi-year field assessment of seasonal variability of photovoltaic soiling and environmental factors in a desert environment - ScienceDirect](https://www.sciencedirect.com/science/article/abs/pii/S0038092X2031135X)
33. [Analysis and mitigation of nonuniform soiling distribution on utility‐scale photovoltaic systems - Micheli - 2022 - Progress in Photovoltaics: Research and Applications - Wiley Online Library](https://onlinelibrary.wiley.com/doi/full/10.1002/pip.3477)
34. [Economics of seasonal photovoltaic soiling and cleaning optimization scenarios - ScienceDirect](https://www.sciencedirect.com/science/article/abs/pii/S0360544220321253)
35. [A framework of optimum cleaning schedule and its financial impact in a large-scale PV solar plant: a case study in Senegal](https://www.epj-pv.org/articles/epjpv/full_html/2022/01/pv220022/pv220022.html)
36. [Global analysis of optimal cleaning cycle and profit of soiling affected solar panels - ScienceDirect](https://www.sciencedirect.com/science/article/abs/pii/S0306261921000039)
37. [RdTools Overview — RdTools 2.0.6+0.gb6dcdd2.dirty documentation](https://rdtools.readthedocs.io/en/2.0.6/)
38. [Degradation and soiling example with clearsky workflow — RdTools 2.0.0+0.gcac6c35.dirty documentation](https://rdtools.readthedocs.io/en/2.0.0/rd_example.html)
39. [Photovoltaic fleet degradation insights - Jordan - 2022 - Progress in Photovoltaics: Research and Applications - Wiley Online Library](https://onlinelibrary.wiley.com/doi/full/10.1002/pip.3566)
40. [Reliability and Degradation of Solar PV Modules—Case Study of 19-Year-Old Polycrystalline Modules in Ghana](https://www.mdpi.com/2227-7080/5/2/22)
41. [“Approaches to Facilitate Responsible PV Module Re-Use” –](https://www.nist.gov/system/files/documents/2022/01/05/Francois%20Rummens.pdf)
42. [pvops Release 0.7.0 pvOps Developers Sep 11, 2025](https://pvops.readthedocs.io/_/downloads/en/latest/pdf/)
43. [An unsupervised kernel norm monitoring for fault detection in a time series photovoltaic system](https://arxiv.org/pdf/2607.01541)
44. [A machine learning-driven virtualized edge framework for real-time monitoring and anomaly detection in solar photovoltaics](https://www.nature.com/articles/s41598-026-58923-y)
45. [(PDF) Digital Twin Approach for Fault Diagnosis in Photovoltaic Plant DC–DC Converters](https://www.researchgate.net/publication/393605797_Digital_Twin_Approach_for_Fault_Diagnosis_in_Photovoltaic_Plant_DC-DC_Converters)
46. [Uncertainty estimates](https://kb.solargis.com/docs/uncertainty-estimates)
47. [Solcast: Validation of a satellite-derived solar irradiance dataset - ScienceDirect](https://www.sciencedirect.com/science/article/abs/pii/S0038092X19307571)
48. [Uncertainties in PV System Yield Predictions and Assessments](https://iea-pvps.org/wp-content/uploads/2020/01/Uncertainties_in_PV_System_Yield_Predictions_and_Assessments_by_Task_13.pdf)
49. [Developing a Thailand solar irradiance map using Himawari-8 satellite imageries and deep learning models](https://arxiv.org/html/2409.16320v3)
50. [IEC TS 62446-3 thermal inspections, explained](https://thermalvariations.com/learn/iec-62446-3-thermal-inspection)
51. [Termografía fotovoltaica con dron: qué detecta la inspección según IEC TS 62446-3](https://dronerotech.com/en/solar-thermography-with-drones-what-the-inspection-detects/)
52. [IEC TS 62446-3 Edition 1.0 2017-06 TECHNICAL SPECIFICATION](https://datatec.es/wp-content/uploads/2019/09/Normativa-IEC-TS-62446-3.pdf)
53. [Application of Infrared Thermography in an Adequate Reusability Analysis of Photovoltaic Modules Affected by Hail](https://www.mdpi.com/2076-3417/12/2/745)
54. [IEC TS 62446-3 Thermal Methodology](https://aerialaccuracy.com/resources/iec-62446-3-methodology)
55. [Thailand Electricity Tariffs: TOU & Demand — LEONICS](https://www.leonics.com/2026-09-28-thailand-electricity-tariff-tou-demand-charge-pea-mea.html)
56. [Solar PPA Thailand — Zero Investment, Instant Savings by CapSolar](https://capsolar.co.th/en/services/ppa)
57. [What is PPA in Thailand? Solar Power Purchase Agreement Explained](https://capsolar.co.th/en/knowledge/what-is-ppa)
58. [Feed-in Tariff (FiT) in Thailand: How Solar and Wind Pricing Works - Green Energy Thailand](https://www.greenenergythailand.com/posts/feed-tariff-fit-thailand/)
59. [(PDF) SolarPower Europe: O&M Best Practices Guidelines](https://www.researchgate.net/publication/304624410_SolarPower_Europe_OM_Best_Practices_Guidelines)
60. [Detail - Solar Best Practices](https://solarbestpractices.com/guidelines/detail/certified-electrician)
61. [pvOps: a Python package for empirical analysis of photovoltaic field data](https://www.sandia.gov/research/publications/details/pvops-a-python-package-for-empirical-analysis-of-photovoltaic-field-data-2023-11-16/)
62. [Overview — pvops 0.7.0 documentation](https://pvops.readthedocs.io/en/latest/)
63. [Data-driven soiling detection in PV modules](https://arxiv.org/pdf/2301.12939)
64. [Reinforcement learning-based dynamic cleaning scheduling framework for solar energy system](https://arxiv.org/pdf/2603.07518)
