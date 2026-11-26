# Plan: Decision rules and the Issues queue

Status: **Phases 1–2 built and merged, every rule starts in shadow mode; Phase 3 built (plant daily table, PR', EPI with a per-plant fitted system factor, R10, R11, R16 in shadow mode); shadow review 2026-11-26 (§4.6: zero-export slots skipped, R2 / R3 / R8 tightened, R4 needs a String Layout; R2, R3, R8, R16 live); Phase 4: site log built (§6.1), cleaning step and R13 built 2026-11-22 in shadow mode (§6.2), soiling wallet R12 built 2026-11-25 in shadow mode (§6.3; rain-forecast gate not built)** · Created 2026-11-15 · Owner: Chanthawat
Source: the research report `docs/plans/Data-Driven Decisions for the TC Roof Solar Dashboard_ KPIs, Thresholds and Decision Rules for Thai Commercial and Industrial Rooftop PV.md` (rule numbers R1–R18 below are its §8 master table).

Turn the data the platform already stores into **issues ranked by baht lost per day**. Each issue has an owner, a tier and evidence, and engineers can acknowledge and close it. Today the platform shows statuses (string Healthy / Warning / Critical, inverter fault codes, PR), but nothing says what to fix first or what a fault costs.

---

## 1. What the platform had before this work (checked 2026-11-15)

The Gap column is the starting point, not today's state: the "As built" sections (§3.5, §4.5, §6.1) and [`iv-and-timeseries-analysis.md`](iv-and-timeseries-analysis.md) say what has closed since (the tariff setting, the daily tables, PR', EPI, the site log).

| Need from the report | What existed | Gap |
|---|---|---|
| String current vs peers | Live check `services/live_string_check.py`: newest record vs inverter median, −15 % Warning / −40 % Critical, gated at a median of 3 A, persistence over the records in one API call (about 10 min). Stored day `growatt_strings._classify_strings`: **whole-day averages** (`i_avg`) vs the median, plus a peer-relative "PR" index (Critical < 68, Warning < 81 or current −12 %). | The stored check averages the whole day, so morning and evening light dilute it. It has no gate on light, no persistence across hours or days, and no memory between days. |
| Open string | Live `OPEN_A` = 0.3 A; stored `i_max < 0.3`; inactive inputs `_split_inactive` (7-day lookback). | No duration and no cost. |
| Bypass diode (voltage step) | Live and stored voltage per module, −8 % / −5 %, only when the String Layout has every module count. | `vString` is the **MPPT voltage**: strings on one MPPT share it, so a one-diode step (≈ 1.7 %) can't be seen. This stays a drone-IR job (R4 is out of scope). |
| Irradiance | 231 of 234 plants have a weather sensor (`growatt_env_readings`, 5 min). It reports module temperature. | Whether the sensor is horizontal or in the plane of the modules is unknown (§9). |
| PR | IEC 61724 PR in `growatt_weather.iec_pr` (coverage-checked), target 85 %. | No temperature correction and no expected-energy model (EPI). |
| Inverter states | `status` per 5-min reading, `on_off`, `active_rate_pct`, Growatt alarm log (`growatt_alarms`). | No per-slot state model and no lost kWh. |
| Tariff | Hard-coded `4.2` THB/kWh in `growatt_overview.py`. | No TOU split, Ft or per-plant PPA rate. |
| Work orders | `cm_work_orders`, tied to the **legacy** `plants` table and admin only. | Nothing is tied to Growatt plants or engineers. |
| Long history | Raw readings are kept 90 days (`HISTORY_RETENTION_DAYS`); Firestore keeps daily summaries. | Nothing in SQL lasts longer than 90 days, so drift, soiling and degradation can't be computed. |
| Events | None. | Cleanings, repairs and inverter swaps aren't recorded. |

Fleet size for the estimates: 629 inverters, about 20 wired strings each, so about 12,600 string-days per day.

## 2. Rules from CLAUDE.md that shape this

| Rule | What it means here |
|---|---|
| 1. Never store realtime values | Rules run **only on stored, source-timestamped history**. The live string check keeps showing "now" but never opens an issue. The new daily tables are aggregates of stored history, so SQL may keep them. |
| 2. Firestore: daily summaries + registry | No new collections. At most, add an `issues` count and THB lost to the existing plant day doc (no extra writes). Rule settings and the tariff go under `config/` like `fleet_module`. |
| 3. Never invent numbers | A rule with too few gated slots gives **no verdict**, not "Healthy". Lost kWh estimated from peers and THB are labelled **estimated**; expected energy and EPI are labelled **modelled**. Missing values show "—". |
| No new Growatt calls | Everything reads SQL. The Growatt rate limits are already tight. |
| Engineers see only assigned plants | Every issue route filters with `allowed_plant_ids`, and unassigned plants get a 404 like today. Engineers can acknowledge and close issues on their plants; only admins edit rules and the tariff. |
| ฿3,000/month | The rules are computed on the VM worker, never on Cloud Run per request. Storage: about 12,600 string rows plus 629 inverter rows a day, roughly 0.5 GB a year, within the 100 GB disk. |

## 3. Phase 1: gated string and inverter rules with memory (weeks 1–3)

Highest value, and it needs only data the platform already stores.

### 3.1 Daily string statistics: `growatt_string_daily` (new SQL table, kept indefinitely)

Computed from `growatt_string_readings` for each inverter and plant-local day. A **gated slot** is a 5-min slot where:
- the inverter's status is normal (1),
- the median current of its wired strings is at least `GATE_MEDIAN_A` (3 A, the same gate as the live check),
- the slot is not clipped: AC power is below 98 % of `nominal_power_w`, and the inverter isn't limited (`active_rate_pct` < 100 → excluded),
- when the plant's sensor has a reading, irradiance is at least 400 W/m².

| Column | Meaning |
|---|---|
| `device_sn`, `string_no`, `day` | Key. |
| `gated_slots` | How many slots passed the gate. A day with fewer than 12 (1 h) gets no verdict. |
| `ratio_median` | Median over gated slots of I / median(I of peers on the same inverter). |
| `low_min` | Minutes with a ratio below 0.80 (`LOW_RATIO`; the plan first said 0.85). |
| `severe_min` | Minutes with a ratio below 0.60. |
| `open_min` | Minutes at or below 0.3 A while the peer median is at least 2 A. |
| `v_ratio_median` | Voltage per module vs peers; null unless the String Layout covers the inverter. |
| `energy_kwh`, `lost_kwh_est` | Energy, and the energy missing against the peer median over gated slots (labelled estimated). |

Peers are the other wired strings of the same inverter, as today. The **median** is used, not the mean. The UI's String page mean comparison should change to the median as well.

### 3.2 Daily inverter statistics: `growatt_inverter_daily` (new SQL table, kept indefinitely)

Each 5-min daylight slot of an inverter gets one state (report §3):

| State | How it is detected | Counts as downtime |
|---|---|---|
| Producing | status 1, power above 0 | No |
| Fault | status 3, or an open Growatt alarm of type Fault | **Yes** |
| Switched off | `on_off` = 0 | Yes, cause "off" |
| Limited | `active_rate_pct` < 100 and power held flat | No: lost opportunity |
| No data | no record while other inverters of the plant produce; **not lost** if the next record's `eac_today` shows the energy arrived anyway | No: a data issue (P4) |
| Night | outside sunrise–sunset (`solar_core/sun.py`) | No |

Columns: minutes per state, `energy_kwh`, `yf_kwh_kwp` (specific yield), `yf_vs_median_pct` (vs the plant's other inverters), `lost_kwh_est` by cause. Lost kWh for a down inverter = the specific yield of the plant's producing inverters in the same slots × its kWp. This needs no irradiance, so it works on every plant.

### 3.3 Rules (defaults from the report, all editable)

| Rule | Signal | Fires when | Tier |
|---|---|---|---|
| R1 Weak string | `low_min` | at least 120 min on 2 of the last 3 days | P2 |
| R2 Open string | `open_min` | at least 60 min on a day (15 until 2026-11-26, §4.6) | P1 if its loss is above the P1 THB line, else P2 |
| R3 Insulation / ground fault | Growatt alarm messages (`r3_keywords`; codes to be confirmed, §9) | any; an insulation alarm before the inverter's first power only when it then starts > 60 min late, or repeats on 3 of 7 days (§4.6) | P1, safety; the dawn repeat P3 |
| R5 Slow drift | 30-day median of `ratio_median` | below 0.95 | P3 |
| R7 Inverter underperforming | `yf_vs_median_pct` | below −3 % on 2 days in a row | P3 (P2 above the THB line) |
| R8 Inverter down | Fault / off / standby minutes during daylight | fault + off ≥ 15 min, or standby ≥ 60 min (not counting a working inverter parked in a meter-held slot, §4.6) | P1 when it is more than 30 % of the plant's kWp, else P2 |
| R9 Grid trips | grid-fault alarm codes | 3 or more in 7 days | P3, owner: engineer |
| R17 Data gap | No-data minutes / daylight minutes | above 5 % | P4 |
| R18 Export limiting | Limited minutes | any | Info, reported as lost opportunity |

Rules added after this table, described in [`iv-and-timeseries-analysis.md`](iv-and-timeseries-analysis.md) §3: R4 (bypass diode, only where a string has its own MPPT voltage), R6 (PID / rapid string degradation), R10 (plant EPI anomaly) and R11 (inverter Ya − Yf loss drift).

String issues nest under their inverter's issue when the inverter has one. An issue closes itself when its rule has not fired for 2 days in a row with enough gated data.

### 3.4 Jobs

- `rules_yesterday` at 00:45 (after `alarms_yesterday`): computes yesterday's daily rows, runs the rules and opens or closes issues.
- `rules_today` after each `history` run (every 30 min): updates today's rows so P1 issues (open string, inverter down) appear the same day.
- `rules_backfill` (CLI, once): computes the daily rows from the **90 days already stored**. Rules can then be calibrated on three months of history on day one, instead of waiting 60–90 days in shadow mode.
- `retention` skips the two daily tables.

### 3.5 As built (2026-11-15)

- `services/growatt_daily.py` (tables), `services/growatt_rules.py` (rules), jobs `rules_today` / `rules_yesterday` / `rules_backfill`, admin `GET /growatt/rules/findings`, migration `a9b8c7d6e5f4`, tests `tests/test_decision_rules.py`.
- Changes from the plan, found on the dev data (11–12 Nov):
  - The peer median includes every wired string, and a slot where more than a third of the strings read ~0 A together is skipped: on 11 Nov a 125 kW inverter at 28 kW dropped 6 of 7 strings at once (inverter event), which the open-strings-excluded median reported as 6 open strings. Open strings on 11 Nov: 501 → 278.
  - Today is judged per inverter only up to its newest record (accounts sync at different times); past days use the full window.
  - R8 needs ≥ 15 min of downtime (`r8_min_down_min`): 5-min wake-up lags made P1s.
  - A record without power, no fault status, while other inverters produce = `standby` (or `off` when `on_off` = 0), counted as downtime.
  - R3 / R9 match alarm **messages** (`r3_keywords`, `r9_keywords`): codes overlap (203 = "PV Isolation Low" as Error, "PV Circuit short" as Warning). Still to confirm with you (§9 Q3).
- Dev data, 11 Nov: 278 R2, 42 R8, 130 R17. 12 Nov (to 12:55): 105 R1, 90 R2, 38 R7, 7 R8, 54 R17. 13 Nov: 2 R3 (AFCI Fault, PV Isolation Low). These counts are uncalibrated: Phase 2's shadow mode checks them against `String Check.xlsx` before anyone sees them.
- The fleet computes in ~20 s per day locally, so a 90-day backfill should take about 30 min on the VM.

## 4. Phase 2: baht, the Issues queue and shadow mode (weeks 3–6)

### 4.1 Tariff (`app_settings` key `tariff`, mirrored to `config/tariff`)

```json
{ "on_peak_thb": 4.1839, "off_peak_thb": 2.6037, "ft_thb": 0.1623,
  "on_peak": "Mon-Fri 09:00-22:00", "valid_from": "2026-09-01",
  "plant_rates": { "<plant_id>": { "thb_per_kwh": 3.5, "basis": "PPA" } } }
```

Lost kWh are priced per slot (on-peak or off-peak), so THB/day follows the real time of the loss. A plant with a PPA rate uses that rate instead. This replaces the hard-coded `4.2` (the Overview revenue, Generation and the PWA report read the same setting). Thai holidays are off-peak; start with a list in the setting. Ft changes every four months, so the admin edits it in Settings.

### 4.2 `issues` table and API

| Column | Notes |
|---|---|
| `id`, `plant_id`, `device_sn`, `string_no` (nullable), `rule`, `tier`, `parent_id` | One open issue per (entity, rule). |
| `opened_at`, `last_seen_day`, `closed_at`, `close_reason` (auto / resolved / dismissed) | |
| `lost_kwh_est`, `thb_per_day_est` | Mean of the last 3 days; total since opened. |
| `evidence` (JSON) | The daily values that fired the rule, linked Growatt alarm ids. |
| `status` (open / acknowledged / resolved / dismissed), `ack_by`, `ack_at`, `note` | |
| `feedback` (confirmed / false_alarm / null) | Recorded when closing: this measures how many alarms lead to real work. |
| `shadow` (bool) | Copied from the rule when the issue opens. |

Routes (scoped by `allowed_plant_ids`):
- `GET /growatt/issues?plant_id=&status=&tier=&shadow=`: ordered safety first, then by THB/day.
- `PATCH /growatt/issues/{id}`: acknowledge, resolve or dismiss, with a note and feedback.
- `GET/PUT /growatt/rules` (admin): thresholds, persistence, tier, enabled, shadow. Each change is logged to `app_logs` with the old and new value.

### 4.3 UI

- **Issues** page (`/issues`, fleet-wide, in the sidebar): a table sorted by THB/day with tier, plant, entity, rule, since, THB/day (est.) and status. Filters go in the URL (`tier`, `status`, `plant`, `rule`). Rows open the string page or `inverters?sn=`.
- **Plant Overview**: a small Issues card (counts by tier, THB/day) that links to `/issues?plant=`.
- **String page / Inverters page**: the open issue with its evidence and the last 30 days of `ratio_median`.
- **Rule review** (admin): each rule's fired count, confirmed vs false-alarm rate and THB found, for tuning. **Removed 21 Nov 2026** with its thresholds and tariff forms and `GET/PUT /growatt/rules`: rule overrides and per-rule `{enabled, shadow}` are now edited in `app_settings` `decision_rules` directly; the tariff keeps its API (`GET/PUT /growatt/tariff`) without a page.

### 4.4 Shadow mode and calibration

1. Every rule starts with `shadow = true`: issues are recorded but shown only in Rule review.
2. Run `rules_backfill` and compare the 90 days of shadow issues with what engineers found. The PWA string checks in `Monitoring Report/String Check.xlsx` are a ready-made list of real faults.
3. Turn a rule on when it keeps **about 1 false dispatch or fewer per 10 true ones** (report's target). Expected order: R2 and R8 first, then R1, then R7 and R5.

### 4.5 As built (2026-11-15)

- `services/tariff.py` (setting `tariff`, `config/tariff`), `services/growatt_issues.py` (table `growatt_issues`), migration `b4c5d6e7f8a9`; routes `GET /growatt/issues`, `GET/PATCH /growatt/issues/{id}`, `GET/PUT /growatt/rules`, `GET/PUT /growatt/tariff`, `GET /growatt/plants/{id}/rules/daily`; UI `/issues`, `/rules` (Rule review, with the thresholds and tariff forms), the String page's Decision rules panel. The Plant Overview Issues card (§4.3) was built, then removed when the overview was made compact.
- Per-slot pricing: the daily tables store the on-peak part of each lost kWh (`lost_on_peak_kwh_est`, `lost_down_on_peak_kwh_est`, `lost_no_data_on_peak_kwh_est`) under the tariff's on-peak hours at compute time; baht are computed when the rules run, so a rate change applies from the next run and a changed on-peak window needs `rules_backfill` for past days. R7 has no slot split (priced at off-peak).
- Inverters page Issues tab (2026-11-18, `pages/inverters/InverterIssuesCard.tsx`): the inverter's and its strings' active issues (admins also shadow) with actions, and 30 days of `growatt_inverter_daily` (minutes down by state, specific yield vs the plant's other inverters).
- Not built yet: the Firestore issue counts on plant day docs, Thai lunar holidays (admin to add).
- Revenue (2026-11-18): the plant overview prices the day slot by slot (`kpis.tariff_thb_per_kwh` = the day's energy-weighted rate). The fleet directory's Revenue today sums each plant's live yield × its own rate from `GET /growatt/tariff/rates` (`tariff.day_rates`: flat plant rate, else TOU weighted by the on-peak share of the plant's stored AC power that day, one aggregate query; no stored power yet = off-peak). It used to multiply the whole fleet's yield by the open plant's rate or a hard-coded 4.2. The PWA report shows no revenue.
- `p1_thb_per_day` = 300 THB/day is a placeholder until §9 Q4 is answered.
- Dev data (11–12 Nov, all rules shadow): 628 active issues, ฿31,075/day estimated (R2 307 · R17 133 · R1 105 · R8 45 · R7 38). Next: `rules_backfill` on the VM, then calibrate against `String Check.xlsx` in Rule review before turning R2 / R8 live.

### 4.6 Shadow review (2026-11-26, local data 21–25 Nov)

No engineer findings were at hand (the String Check sheets live in Google Sheets), so every rule's shadow issues were checked against the stored 5-min readings.

- **Zero-export plants.** 205 of 233 plants exported under 2 % of their PV on 24 Nov: the grid meter holds about 0 kW and the inverters follow the site load by parking whole MPPTs (string at 0 A for a slot or two, often 2–4 MPPTs at once) or whole inverters. The string and inverter rules read that as faults. Now `growatt_daily._export_held` takes the slots in which the plant's meter reads within the curtailment model's export band (`EXPORT_BAND_KW` / `_FRAC`); the string comparison skips them, and an inverter without power in one is not counted as standby. A plant without a meter has no held slot.
- **R2** `r2_open_min` 15 → 60. Before: about 370 strings a day, of which ~130 open most of the day, ~185 dropping only together with other strings (export controller), ~55 intermittent alone. After (backfill of 21–25 Nov, 25 Nov): 142 = 126 all-day opens + 8 + 8.
- **R8** standby-only downtime needs `r8_min_standby_min` (60); fault / off minutes keep 15. The short standby R8s were morning wake-up lags and controller parks worth ~0 kWh. 25 Nov: 17 → 7, every one with fault minutes or a whole day in standby.
- **R3** `PV Isolation Low` came only at the dawn start-up check (06:00–06:56), mostly dew: an insulation alarm before the inverter's first power is now P1 only when it starts more than `r3_late_start_min` (60) after the median of the plant's other inverters (or not at all), P3 when it repeats on `r3_dawn_days` (3) of `r3_dawn_window_days` (7), else nothing. Arc / ground / residual-current alarms and insulation alarms while producing stay P1. 16 → 13; the P1s left are AFCI faults and starts 64–191 min late.
- **R4** compares voltage per module only (needs the String Layout's module counts). On raw string voltage it flagged 710 strings with drops spread 1–30 % (string length and MPPT operating points, not diodes); now 0 without a layout.
- Kept in shadow: **R1** (still 448 strings on 25 Nov, the same strings every day at a ratio ~0.78: orientation / string length, needs the layout or a baseline against the string's own past), **R7** (every inverter of a plant gets the same kWp without a layout; −3 % is inside the spread of string count and roof direction), **R17** (local gaps are mostly the local history job, judge on production), R5 / R6 / R10–R13 (too few days).
- Independent review of the change (3 reviewers, each finding checked by a refuter), fixed the same day:
  - a meter must be alive: a day whose meter shows fewer than `METER_ALIVE_SLOTS` (3) slots outside the band from the plant's first producing slot on holds nothing (one meter read 0.0 W from 05:00 on 21 Nov, after night import and with one stray reading at 08:00, while its plant produced 34 kW). Rejecting every exactly-0 W slot instead was tried and dropped: 19 % of midday readings on 25 Nov were exactly 0 on working zero-export meters, and the inverter-event R2s rose from 8 to 30;
  - a held slot excuses only a working inverter (switched on and producing at some point of the day); a switched-off or all-day-dead inverter is still down;
  - R3 repeats count only days whose R3 alarms were all dawn insulation alarms (first power per day); with no other inverter producing, lateness is measured from the alarm; during the day (`rules_today`) an inverter not producing yet is late only once the start window has passed;
  - `growatt_issues.sync` no longer downgrades an open safety issue with a later non-safety finding of its rule.
- Live since 2026-11-26 (owner's decision): R2, R3, R8, R16 (`decision_rules.rules.<R>.shadow = false` in `app_settings`; set in the local DB, production is stopped and gets the same setting when it reopens).

## 5. Phase 3: weather-based plant KPIs (weeks 6–10)

Only on plants whose sensor covers the day (`iec_pr` coverage check).

- **PR corrected for module temperature**: PR' = PR / [1 + γ(T_mod − 25)], with T_mod weighted by irradiance and γ = `temp_coeff_pmax_pct` from `fleet_module` (−0.30 %/K). Shown next to IEC PR and labelled. It replaces raw PR in any PR alarm.
- **Expected energy and EPI**: a PVWatts-style model per plant per slot: P0 × G/1000 × [1 + γ(T_mod − 25)] × system factor. No pvlib is needed (keeps the Cloud Run image small; add pvlib later only for transposition if sensors turn out to be horizontal). The system factor is fitted per plant on its best 10 clear days and stored. EPI = measured ÷ modelled, labelled **modelled**.
- **R10 EPI control chart**: alarm below μ − 3σ for 1 day or μ − 2σ for 3 days, with μ and σ over the last 30–60 days, skipping days with open issues.
- **R16 Sensor health**: a stale value (3 or more identical non-zero irradiance readings in daylight), irradiance above the clear-sky value × 1.2, or a sensor reading far below its neighbouring plants' sensors on a day Google reports as clear (`cloud_cover_pct`). Google's stored hours carry no irradiance, so the report's sensor-vs-satellite ratio isn't possible; the other plants' sensors take its place (231 plants have one). A failing sensor greys out PR, PR' and EPI for that day.
- New table `growatt_plant_daily` (kept indefinitely): energy, Yr, Yf, PR, PR', EPI, availability (time- and energy-based), lost kWh by cause and data coverage. It is also the base for Phase 4 and for future degradation analysis.

### 5.1 As built (checked 2026-11-16)

- Built: `growatt_plant_daily`, PR', EPI, R10 and R11; details and thresholds are in [`iv-and-timeseries-analysis.md`](iv-and-timeseries-analysis.md) §3.1.
- Fitted system factor (built 2026-11-18, `services/epi_fit.py`, table `growatt_plant_epi_fit`): until then every plant used an assumed 0.985, which put the fleet's clear-day EPI at about 0.74 (median of 197 plants, 11–18 Nov) and made EPI unreadable across plants. Now each plant's factor = the median of measured ÷ modelled-without-factor over its **10 clearest good days in the last 60** (clearness = measured insolation ÷ Haurwitz clear-sky insolation ≥ 0.7; ≥ 36 filtered slots; sensor passing R16; inverters not producing ≤ 3 % of their daylight minutes). A fitted plant's EPI is about 1.0 on a day like its best days.
  - Guards: a factor outside 0.5–1.2 (wrong kWp, misplaced sensor, a plant mostly down) or a spread (median absolute deviation ÷ factor) above 8 % is `rejected`, and the plant keeps 0.985 so the odd EPI stays visible. A chronic fault present on every good day (one dead string) is folded into the factor; the string rules catch it, not EPI.
  - `rules_yesterday` fits plants without a fit (and `rules_backfill` after its days); a fitted plant is left alone until the unscheduled `epi_refit` job (queue it after a sensor, inverter or module change). A new factor rescales the plant's stored `epi` / `modelled_energy_kwh` (`growatt_plant_daily.system_factor` records the factor behind each row), so R10's baseline stays on one scale. The overview's live EPI uses the same factor (`kpis.epi_factor`, also on `/kpi-daily`); Generation & PR names it next to EPI.
  - Replayed on production's first 8 days with 4 days instead of 10: 122 plants fit (factor 0.51–0.95, median 0.74, typical spread 1.6 %), 16 fall outside 0.5–1.2 (13 between 0.03 and 0.50: worth checking their kWp and sensor) and 9 have clear days that disagree. With 10 days needed, the first plants fit once they have 10 good clear days, about two weeks after 11 Nov.
- R16 sensor health built 2026-11-18 (shadow mode, like every rule):
  - `growatt_daily._sensor_evidence` stores evidence on the plant daily row: `sensor_stale_slots` (daylight slots in runs of ≥ 3 identical non-zero readings), `sensor_high_slots` (slots above **1.5 ×** the Haurwitz clear-sky GHI while it is ≥ 400 W/m²), `sensor_midday_wm2` (mean 10:00–14:00) and `cloud_midday_pct` (Google, modelled). `sensor_neighbours` then sets `sensor_neighbour_ratio` = midday irradiance ÷ the median of the other plants' within 50 km (≥ 3 needed), once every plant's row of the day exists.
  - `growatt_rules.sensor_verdict` judges that evidence with the settings `r16_stale_slots` (12), `r16_high_slots` (6), `r16_neighbour_ratio` (0.7) and `r16_clear_cloud_pct` (20; the neighbour check runs only on a day Google calls clear), so thresholds change without a recompute. A failing day gives an R16 finding (P3, no lost kWh), R10 skips it (today and its baseline), and the overview's `kpis.sensor_health` greys out IEC PR / PR' / EPI in the UI.
  - Different from the plan: the plan said clear sky × 1.2. Measured on the fleet (12–15 Nov 2026), plane-of-array sensors read 1.0–1.05 × Haurwitz GHI at midday and up to ~1.3 in cloud-edge bursts (95th percentile), so 1.2 flagged half the fleet every day. With 1.5 × and clear sky ≥ 400 W/m², 4–8 sensors a day are flagged, several of them on every day (e.g. one peaking at 1,350–1,490 W/m² daily).
  - The neighbour check has not run on real data yet: the local DB holds no clear day with Google hours.

## 6. Phase 4: events, soiling and cleaning (from the 2026–27 dry season)

The dry season starts now (November to April), so **start recording cleanings immediately**, even before this phase is built.

- `site_events` table + a form on the plant Maintenance page: type (cleaning, repair, module or inverter replaced, IR flight, curtailment), plant, optional inverter / string, date, cost in THB, note. Phase 1 issues can be closed with a linked event.
- **Cleaning step**: compare EPI (or plant specific yield vs the fleet median on plants without one) over 3–5 clear days before and after each cleaning to measure what it recovered.
- **Soiling wallet** (R12): the THB lost since the last cleaning, using a soiling rate measured from those steps. Suggest a cleaning when it exceeds the plant's cleaning cost, unless it is the monsoon (mid-May to mid-October, a setting).
  The report's "skip if 10 mm of rain is forecast" gate needs a forecast. The platform stores only Google Weather history (`precip_mm` per hour) and current conditions, so this gate waits until a forecast call is budgeted (it would come out of `GOOGLE_WEATHER_MONTHLY_BUDGET`, 30,000 calls a month, of which about 28,400 are already used).
- **R13 Incomplete recovery**: less than 50 % recovery after a day with 10 mm or more of rain (stored `precip_mm`) → suggest a manual cleaning.
- RdTools SRR / CODS: evaluate after one dry season of `growatt_plant_daily` data. It would run in the worker only.

### 6.1 As built (2026-11-15): the site log

- `site_events` table (`services/site_events.py`, migration `b7c8d9e0f1a2`), SQL only, kept indefinitely. Types: cleaning, repair, module_replaced, inverter_replaced, ir_flight, curtailment, other; `day` … `end_day` (plant-local, never in the future), optional inverter / string, `cost_thb` (null = not entered), note, `issue_id` (+ `close_issue` resolves it as confirmed, its note naming the event).
- Routes: `GET/POST /growatt/plants/{id}/events`, `PATCH/DELETE /growatt/plants/{id}/events/{event_id}`, fleet `GET /growatt/events`. Engineers record on their assigned plants; delete = admin or whoever recorded it.
- UI: the plant Maintenance tab is now open to engineers and starts with the **Site log** card; the legacy PM / CM / RCA modules stay admin only below it.
- Built since: the cleaning step and R13 (§6.2), the soiling wallet R12 (§6.3).

### 6.2 As built (2026-11-22): cleaning step and R13

- `services/soiling.py`, DB only, nothing new stored: it reads `growatt_plant_daily` EPI, the Site log's cleanings and Google Weather's daytime rain.
- **Good day** (the only days compared): EPI from ≥ 36 filtered slots, sensor passing R16, clearness (POA insolation ÷ Haurwitz clear sky) ≥ `soil_min_clearness` (0.6; the EPI fit uses 0.7), inverters down ≤ 3 % of daylight minutes.
- **Cleaning step**: the median EPI of the last `soil_step_days` (5) good days before the cleaning, against the first 5 after it. These days are searched within `soil_window_days` (14), never across the previous or next cleaning, and `soil_min_days` (3) are needed on each side. Statuses: `measured`, `waiting` (the after-window is still open), `too_few_days`, `no_epi`. A heavy rain (≥ `soil_rain_mm`, 10 mm daytime) between the compared days is listed in `rain_between`, since that rain cleaned the array too. A cleaning of one inverter only is `scope: inverter` (its effect on the plant EPI is diluted).
- **Soiling rate** (estimated) = step ÷ days since the last reset (the previous cleaning or heavy rain). It is null when the rain record has a missing or incomplete day in between, or when no reset is known.
- **R13** (P3, shadow) is judged each day by `growatt_rules.evaluate`. It looks at the newest heavy rain since the last cleaning, at most `r13_max_age_days` (30) ago.
  - The clean reference C is the last cleaning's after-median (≥ `r13_min_days` 2 days). Without one, a plant with a fitted EPI factor uses 1.0 (its best clear days); otherwise there is no verdict.
  - B is the median of the good days in the `r13_before_days` (7) before the rain (after the last cleaning and any earlier heavy rain). A is the median of the newest `r13_judge_days` (3) good days after it. There is no verdict unless C − B ≥ `r13_min_deficit` (0.03).
  - The rule fires when (A − B) ÷ (C − B) < `r13_recovery_pct` (50 %) and C − A ≥ 0.03.
  - Lost kWh (est.) = the day's energy × (C − A) ÷ A.
  - Auto-close works like R10: 2 quiet days with an EPI. A new cleaning ends the condition.
- O&M Dashboard attribution: the new family `soiling` (R13) takes what the inverter and string rules leave, and R10 takes what is left after that.
- API: `GET /growatt/plants/{id}/soiling?days=` (plant read), with the steps (newest first), the summary, daily EPI / good / rain and the latest R13 verdict (null for engineers while R13 is shadow). UI: the **Cleaning effect** card on the plant Maintenance tab, under the Site log.
- Local data on 22 Nov 2026: 206 plants have EPI (11–21 Nov) and 183 have good days. No cleaning is recorded, and the stored rain covers 12 Nov only, so there are no steps or R13 verdicts yet. Both need cleanings entered with their real dates, and the daily `google_weather` job running.
- The settings are thresholds in `DEFAULT_RULES` (the `soil_*` / `r13_*` keys), overridable via `app_settings` `decision_rules`.

### 6.3 As built (2026-11-25): soiling wallet R12

- `services/soiling.py` (`wallet`, `wallets`, `r12_findings`), DB only, nothing new stored. Everything in it is **estimated**; the cleaning cost is **entered**.
- **Reset**: the newest plant-wide cleaning (a cleaning of one inverter does not reset the plant) or heavy rain (≥ `soil_rain_mm`) up to the judged day.
- **Soiling rate r**: the median of the plant's own measured rates (§6.2 steps, plant-wide cleanings, last `r12_rate_lookback_days` 365), else the fleet median when ≥ `r12_fleet_min_plants` (3) plants have one (`rate_basis` plant / fleet), else no wallet (`no_rate`).
- **Wallet** = Σ over the days since the reset of the measured energy × SL ÷ (1 − SL), SL = min(r × n, `r12_max_soiling_pct` 20 %), priced with the tariff (unknown on-peak split = off-peak). A day without stored energy adds nothing (`days_without_energy`).
- **Rain record**: every day between the reset and the judged day must have complete Google daytime hours (the judged day itself may still be missing, since `google_weather` runs at 18:15); otherwise `rain_unknown` and no verdict, because a heavy rain could be hidden. Google hours are kept 90 days, so a reset older than that is `rain_unknown` too.
- **Cost C**: `om_plant_settings.cleaning_cost_thb` (Calendar → Due), else the median `cost_thb` entered on the plant's plant-wide cleanings; none = the wallet is shown without a verdict (§9 Q5 still open for a fleet figure).
- **Fires** (P3, shadow) when wallet ≥ C and the day is outside `r12_monsoon` (`["05-15", "10-15"]`, MM-DD, may wrap the year). The finding's lost kWh / THB is that day's soiling loss, so the issue's daily sum follows the wallet; evidence has the wallet, cost and basis, rate and basis, reset, soiling %, and T* = √(2C ÷ (r × V)) (`optimal_interval_days`, V = the mean clean-energy value per day since the reset).
- Auto-close: 2 quiet days with stored plant energy (`growatt_issues._verdicts` `plants_energy`); a cleaning or heavy rain empties the wallet.
- O&M Dashboard: R12 joins the `soiling` family; per plant-day the larger of R12 / R13 counts, before R10's residual.
- Not built: the report's "skip if ≥ 10 mm rain is forecast" gate (no forecast is fetched, §9 Q7).
- API: `GET /growatt/plants/{id}/soiling` adds `wallet` (on the newest stored day; null for engineers while R12 is shadow), `r12_rule` and `monsoon`. UI: an R12 callout on the Cleaning effect card (wallet vs cost meter, reset, rate and basis, soiling now, best interval) and the R12 evidence line in the issue lists.
- Local data on 25 Nov 2026: no cleaning recorded, so no rate: all 233 plants `no_rate`.
- Calendar Team Phase 4 (calendar-team.md §12) turns a firing wallet into a **suggested** cleaning on the Calendar (admins accept / dismiss; hidden from engineers while R12 is shadow).

## 7. Later (not planned yet)

- Degradation (R14) per inverter and string from the daily tables, after 2 or more years.
- Drone IR findings keyed to strings (R15), joined with string issues.
- MTTR and response-time compliance from `issues`.
- ML anomaly detection.

## 8. Testing

- Unit tests per rule with fixed readings: a cloud transient (one bad slot, no issue), morning low light (no verdict), an open string (P2 after 60 min), a limited inverter (no fault), a no-data gap that `eac_today` later fills (data issue, no lost kWh).
- The `rules_backfill` output on the dev DB, checked by hand for three plants against the String page.
- Route tests: engineers see only their plants' issues; only admins change rules.

## 9. Open questions for the owner

1. **Tariffs**: which plants have a PPA rate, and at what price? Is the TOU rate at 22–33 kV right for every customer?
2. **Weather sensors**: horizontal or in the plane of the modules? This decides whether EPI needs transposition.
3. **Growatt alarm codes** for insulation (Riso), ground fault and grid trips on MAX inverters, for R3 and R9.
4. **The P1 / P2 THB line** (the report suggests 300 THB/day for P2) and who acknowledges issues: the assigned engineer, or an admin first?
5. **Cleaning costs** per plant (or one fleet value) for the soiling wallet.
6. **String Layout coverage** in production: per-module voltage and per-kWp normalization need module counts, and the local DB has none.
7. **Rain forecast**: is a Google Weather forecast call worth part of the monthly budget for the cleaning gate?
