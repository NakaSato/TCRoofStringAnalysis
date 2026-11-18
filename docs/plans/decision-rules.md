# Plan: Decision rules and the Issues queue

Status: **Phases 1–2 built and merged, every rule starts in shadow mode; Phase 3 partly built (plant daily table, PR', EPI, R10, R11, R16 in shadow mode; not the fitted system factor); Phase 4: site log built (§6.1), soiling analysis not started** · Created 2026-11-15 · Owner: Chanthawat
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
| R2 Open string | `open_min` | at least 15 min (3 slots) on a day | P1 if its loss is above the P1 THB line, else P2 |
| R3 Insulation / ground fault | Growatt alarm codes for Riso / GFDI (list to be confirmed, §9) | any | P1, safety |
| R5 Slow drift | 30-day median of `ratio_median` | below 0.95 | P3 |
| R7 Inverter underperforming | `yf_vs_median_pct` | below −3 % on 2 days in a row | P3 (P2 above the THB line) |
| R8 Inverter down | Fault minutes during daylight | any | P1 when it is more than 30 % of the plant's kWp, else P2 |
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
- **Rule review** (admin): each rule's fired count, confirmed vs false-alarm rate and THB found, for tuning.

### 4.4 Shadow mode and calibration

1. Every rule starts with `shadow = true`: issues are recorded but shown only in Rule review.
2. Run `rules_backfill` and compare the 90 days of shadow issues with what engineers found. The PWA string checks in `Monitoring Report/String Check.xlsx` are a ready-made list of real faults.
3. Turn a rule on when it keeps **about 1 false dispatch or fewer per 10 true ones** (report's target). Expected order: R2 and R8 first, then R1, then R7 and R5.

### 4.5 As built (2026-11-15)

- `services/tariff.py` (setting `tariff`, `config/tariff`), `services/growatt_issues.py` (table `growatt_issues`), migration `b4c5d6e7f8a9`; routes `GET /growatt/issues`, `GET/PATCH /growatt/issues/{id}`, `GET/PUT /growatt/rules`, `GET/PUT /growatt/tariff`, `GET /growatt/plants/{id}/rules/daily`; UI `/issues`, `/rules` (Rule review, with the thresholds and tariff forms), the String page's Decision rules panel. The Plant Overview Issues card (§4.3) was built, then removed when the overview was made compact.
- Per-slot pricing: the daily tables store the on-peak part of each lost kWh (`lost_on_peak_kwh_est`, `lost_down_on_peak_kwh_est`, `lost_no_data_on_peak_kwh_est`) under the tariff's on-peak hours at compute time; baht are computed when the rules run, so a rate change applies from the next run and a changed on-peak window needs `rules_backfill` for past days. R7 has no slot split (priced at off-peak).
- Not built yet: the Inverters page panel (inverter issues show on the String page panel and in `/issues`), the Firestore issue counts on plant day docs, Thai lunar holidays (admin to add), the Overview revenue / PWA report still multiply by a single rate (now the day's energy-weighted tariff rate).
- `p1_thb_per_day` = 300 THB/day is a placeholder until §9 Q4 is answered.
- Dev data (11–12 Nov, all rules shadow): 628 active issues, ฿31,075/day estimated (R2 307 · R17 133 · R1 105 · R8 45 · R7 38). Next: `rules_backfill` on the VM, then calibrate against `String Check.xlsx` in Rule review before turning R2 / R8 live.

## 5. Phase 3: weather-based plant KPIs (weeks 6–10)

Only on plants whose sensor covers the day (`iec_pr` coverage check).

- **PR corrected for module temperature**: PR' = PR / [1 + γ(T_mod − 25)], with T_mod weighted by irradiance and γ = `temp_coeff_pmax_pct` from `fleet_module` (−0.30 %/K). Shown next to IEC PR and labelled. It replaces raw PR in any PR alarm.
- **Expected energy and EPI**: a PVWatts-style model per plant per slot: P0 × G/1000 × [1 + γ(T_mod − 25)] × system factor. No pvlib is needed (keeps the Cloud Run image small; add pvlib later only for transposition if sensors turn out to be horizontal). The system factor is fitted per plant on its best 10 clear days and stored. EPI = measured ÷ modelled, labelled **modelled**.
- **R10 EPI control chart**: alarm below μ − 3σ for 1 day or μ − 2σ for 3 days, with μ and σ over the last 30–60 days, skipping days with open issues.
- **R16 Sensor health**: a stale value (3 or more identical non-zero irradiance readings in daylight), irradiance above the clear-sky value × 1.2, or a sensor reading far below its neighbouring plants' sensors on a day Google reports as clear (`cloud_cover_pct`). Google's stored hours carry no irradiance, so the report's sensor-vs-satellite ratio isn't possible; the other plants' sensors take its place (231 plants have one). A failing sensor greys out PR, PR' and EPI for that day.
- New table `growatt_plant_daily` (kept indefinitely): energy, Yr, Yf, PR, PR', EPI, availability (time- and energy-based), lost kWh by cause and data coverage. It is also the base for Phase 4 and for future degradation analysis.

### 5.1 As built (checked 2026-11-16)

- Built: `growatt_plant_daily`, PR', EPI, R10 and R11; details and thresholds are in [`iv-and-timeseries-analysis.md`](iv-and-timeseries-analysis.md) §3.1.
- Different from the plan above: the model uses a fixed, assumed factor of 0.985 for every plant. No system factor is fitted per plant.
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
- Still to build: the cleaning step (EPI before / after), the soiling wallet (R12, needs §9 Q5 cleaning costs; `cost_thb` on cleanings gives a per-plant figure once entered), R13.

## 7. Later (not planned yet)

- Degradation (R14) per inverter and string from the daily tables, after 2 or more years.
- Drone IR findings keyed to strings (R15), joined with string issues.
- MTTR and response-time compliance from `issues`.
- ML anomaly detection.

## 8. Testing

- Unit tests per rule with fixed readings: a cloud transient (one bad slot, no issue), morning low light (no verdict), an open string (P2 in 15 min), a limited inverter (no fault), a no-data gap that `eac_today` later fills (data issue, no lost kWh).
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
