# Spec: PWA daily meter report

Status: describes the module as built on 2026-11-21 (criteria `version` `2026-11-21c`).
Sources: `docs/plans/pwa-meter-daily.md` (the plan) and the code listed in §12. Where the two differ, this spec follows the code, and §11 lists each difference.

The PWA daily report is the billing record: the Cewe meter kWh that each site of phases 1–2 sends to PEA every day. The module stores these meter days indefinitely, links each site to its Growatt plant, and computes the engineering and finance figures of the phases 1–2 Engineering & Finance dashboard from one criteria file.

Requirement IDs (`PM-…`) are stable. Tests name the IDs they cover (§13).

---

## 1. Scope and rules

| ID | Requirement |
|---|---|
| PM-G1 | Meter days are source-dated daily records (the report's own day), not realtime values. They are stored in SQL only, kept indefinitely, and never written to Firestore. `retention` does not touch them. |
| PM-G2 | A reading the report did not give is `null`, never 0. A `loss_inv` day stores `inverter_kwh` null and a `loss_meter` day stores `meter_kwh` null. |
| PM-G3 | `contract_kwh` and `pvsyst_kwh` are **modelled**. Losses, the meter gap and every THB value are **estimated**. Responses that carry them return a `labels` map that says so. |
| PM-G4 | Every threshold, keyword list, price and formula comes from `backend/app/services/pwa_meter_criteria.json`, never from constants in the code. The service reads the file once per process (`lru_cache`), so a change applies after a restart of the API and the worker. |
| PM-G5 | All SQL runs on SQLite and on Postgres: SQLAlchemy expressions only, with bucketing done in Python and pandas. |
| PM-G6 | Nothing in this module calls Growatt or any other external service. It reads stored rows only. |

## 2. Data model

### 2.1 `pwa_meter_sites` (one row per report site)

| Column | Type | Rule |
|---|---|---|
| `site_id` | str(16), PK | `P1-<contract no.>` or `P2-<report company id>` |
| `phase` | int, required | 1 or 2 today (the API accepts 1–4) |
| `name` | str(200), required | as in the report |
| `region` | str(32) | PWA region, e.g. `เขต 1` |
| `kwp` | float, required | contract / PVsyst capacity, the basis of expected energy and yield |
| `contract_seq`, `pvsyst_seq` | int | row (`ลำดับ`) in the model's `ประมาณการ_kWh` and `PVsyst_ระยะN` sheets |
| `growatt_plant_id` | int, indexed, **no FK** | the matched Growatt plant. The site stays readable after the plant leaves the registry. |
| `growatt_name`, `growatt_kwp` | | the registry's values at match time |
| `kwp_mismatch` | bool | true when the registry kWp differs from `kwp` by more than 1 % |
| `meter_no` | str(16), indexed | Cewe meter number (e.g. `WP078250`), learned from the first report import that matched the site (PM-R8) |
| `updated_at` | UTC | |

### 2.2 `pwa_meter_days` (one row per site and day)

| Column | Rule |
|---|---|
| `site_id`, `day` | unique together (`uq_pwa_meter_days_site_day`); FK to the site with `ON DELETE CASCADE`; index on `day` |
| `meter_kwh` | Cewe meter, the billed energy; null on a `loss_meter` day |
| `inverter_kwh` | inverter total from the report; null on a `loss_inv` day |
| `contract_kwh`, `pvsyst_kwh` | modelled expected energy for the day (PM-E) |
| `status` | `ok` / `outage` / `loss_inv` / `loss_meter` (PM-S1); always equal to `classify(meter, inverter)` |
| `curtailment_note` | true when the note contains the keyword `curtailment.note_keyword` (`หรี่`) |
| `weather` | `clear` / `cloudy` / `rain` / null |
| `note` | the report's note with whitespace collapsed |
| `imported_at` | UTC |

### 2.3 `pwa_meter_expected` (one row per site and calendar month)

PK (`site_id`, `month`), where `month` is the first day of the month. `contract_kwh_day` and `pvsyst_kwh_day` are both modelled kWh per day, and null where the model gives no figure. `basis` says how the contract figure was made (e.g. `contract sheet`, `2025 × 0.993^1`, `kWp × yield × phase-2 season`). `source` is the model workbook's file name.

### 2.4 Schema

`ensure_schema` creates the tables at startup. The Alembic migrations are `5e1f2a3b4c6d` (sites, days) and `6f2a3b4c5d7e` (`pwa_meter_expected` and `pwa_meter_sites.meter_no`).

## 3. Day status (`day_status`)

| ID | Requirement |
|---|---|
| PM-S1 | With `zero_kwh` = 1.0 and a missing reading counted as 0: **outage** when meter < 1 and inverter < 1; **loss_inv** when inverter < 1 and meter ≥ 1; **loss_meter** when meter < 1 and inverter ≥ 1; otherwise **ok**. |
| PM-S2 | Outage days count as downtime. `loss_inv` and `loss_meter` days count as data gaps. `ok` days count as producing. |

## 4. CSV import (sites + days)

CLI: `python -m app.services.pwa_meter import --sites S.csv --days D.csv`. The files are UTF-8, a BOM is accepted, and they have headers.

| ID | Requirement |
|---|---|
| PM-C1 | The sites file needs the columns `site_id, phase, name, region, kwp`. The days file needs `day, site_id, meter_kwh, inverter_kwh`. A missing column refuses the import before anything is read. |
| PM-C2 | Sites are upserted on `site_id`, then days on (`site_id`, `day`). A re-import of a longer report adds the new days and overwrites changed ones. Importing the same files twice changes nothing. |
| PM-C3 | All or nothing: the first bad row rolls back the whole import, and the message names the file, the row number (header = row 1) and the field. |
| PM-C4 | A row is refused for: a missing `site_id` / `phase` / `name` / `kwp`; a `site_id` that is in neither the sites file nor the DB; a `day` that is not YYYY-MM-DD; a number that is negative or not numeric; a weather value outside `clear` / `cloudy` / `rain`; a (site, day) given twice; a `status` outside the four values; or a `status` that does not equal `classify(meter, inverter)`. |
| PM-C5 | An empty `status` is computed with `classify`. An empty number is null. Booleans accept `1` / `true` / `yes` / `y`. |
| PM-C6 | The CLI prints the counts `{sites_added, sites_updated, days_added, days_updated}`. When the import is refused, it prints `import refused: <reason>` and exits with 1. |

## 5. Daily report workbook import (Excel)

API `POST /pwa/meter/import` (admin); CLI `python -m app.services.pwa_meter report FILE… [--commit] [--day "FILE::SHEET=YYYY-MM-DD|skip"]`. The parser is in `pwa_meter_report.py`. Matching, comparing and storing are in `pwa_meter.import_report`.

### 5.1 Parsing

| ID | Requirement |
|---|---|
| PM-R1 | The per-site table is found by the header cell `หน่วยจากมิเตอร์`, never by sheet name or column position. A sheet without that header (charts, the problem list) is skipped. A workbook with no such sheet is a problem. A file that openpyxl cannot open is a problem too. |
| PM-R2 | The columns are located by their header text: `ลำดับ`, `สถานที่`, `หน่วยจากมิเตอร์`, `หน่วยจากอินเวอร์เตอร์`, `สภาพอากาศ`, `หมายเหตุ`. A header with no name / meter / inverter column is an error on that sheet. |
| PM-R3 | Site rows: a name, plus a numeric `ลำดับ` (or, without a `ลำดับ` column, any reading). The meter number (`[A-Z]{2}\d{5,8}`) is read from the next one to three rows, up to the next site row. |
| PM-R4 | **Phase 2** (`comp_id` column to the left of the header row): the meter, inverter and weather values come from the system pull columns `Cewe` / `Growatt` / `Weather` on the left, not from the typed table. The typed table repeats an old inverter figure on days the inverter was not reporting (P2-1073, 11–12 Jan 2026). |
| PM-R5 | Numbers: blank, `-`, `–`, `—` and `N/A` are null. Thousands commas are removed. A negative or non-numeric value is an error. Values are rounded to `report_import.round_kwh` (2) decimals. |
| PM-R6 | **Day:** (1) the title `…ประจำวันที่ D <Thai month> YYYY` (full or abbreviated month; a year above 2400 is Buddhist Era, minus 543); else (2) the sheet name. `D.M`, `D/M` and `D-M` are read directly. A name of 2–4 digits is read as both d+mm and dd+m, and the reading kept is the one closest to the previous dated sheet that is not more than 15 days before it. The year is the previous sheet's year, or the next year when the date wraps. The first name-dated sheet takes the latest candidate not after today. `day_source` is `title`, `sheet name` or `set by you`. A sheet with no day is a problem until it gets a day or is skipped. |

### 5.2 Matching and checks

| ID | Requirement |
|---|---|
| PM-R7 | A row is matched to a site in this order: (1) `comp_id` → `P2-<comp_id>`; (2) the stored `meter_no`; (3) for phase-1 sites, the name key (the name cut at `กปภ.สาขา` / `กปภ. สาขา` / `การประปาส่วนภูมิภาค`, spaces and `ประปา` removed), first exact, then a unique substring match. Nothing is guessed: a row that matches no site, or several, is listed under `unmatched` with its reason and blocks the import. |
| PM-R8 | Meter numbers are learned: a matched site without `meter_no` gets the row's number on commit, unless another site already holds that number. A number that differs from the stored one is a warning; the stored number is kept. |
| PM-R9 | Weather: the first group of `report_import.weather_keywords` with a keyword in the text (this covers the report's typos). An unknown word is stored as null and listed as a warning on its sheet. |
| PM-R10 | Days before `report_import.skip_before` for the site's phase (1 Jan 2026 for both phases) are counted as `before_start` and not stored. A sheet before the earliest start date is not matched at all. |
| PM-R11 | Problems that block the commit: a future day; a day value in `days` that is not YYYY-MM-DD; the same (site, day) on two sheets; unmatched rows; an undated sheet; parse errors. A skipped sheet's problems do not count. |
| PM-R12 | The stored readings follow PM-G2: on a `loss_inv` / `loss_meter` day the reading under 1 kWh becomes null. `curtailment_note` is set from the note (PM-S, §2.2). |
| PM-R13 | Contract / PVsyst for each day come from `pwa_meter_expected` for its month. When the month has no row, the day keeps its stored figures; a new day gets null and its month is listed in `months_without_expected`. |
| PM-R14 | Comparison with stored days: a day is `unchanged` when every kWh field is within 0.011 and every other field is equal. Otherwise it is `changed`, or `new` when nothing was stored. Unchanged days are not written. |

### 5.3 Preview and commit

| ID | Requirement |
|---|---|
| PM-R15 | Without `commit`, nothing is written. The response is the preview: `ok` (no problems), `committed` false, `sheets[]` (`key` = `file::sheet`, `file`, `sheet`, `day`, `day_source`, `skipped`, `rows`, `matched`, `unmatched[]` {row, name, comp_id, meter_no, reason}, `new`, `changed`, `unchanged`, `before_start`, `errors[]`, `warnings[]`), `totals` over the included sheets, `days` {first, last}, `months_without_expected`, `meter_numbers_learned`. |
| PM-R16 | With `commit` and no problems, every new and changed day and every learned meter number is written in one transaction (all or nothing), and the response has `committed: true`. With problems, `commit` writes nothing and returns the preview. |
| PM-R17 | `days` (form field, a JSON object) maps `file::sheet` to `YYYY-MM-DD` (sets the day) or `skip`. A value that is not an object gives 422. |
| PM-R18 | Only `.xlsx` / `.xlsm` files are accepted (422 otherwise), at most 40 MB in total per request (`REPORT_MAX_BYTES`; 413 above). "Today" is the Bangkok date. |
| PM-R19 | A committed import is logged to `app.audit` with the username, new / changed counts, the day range and the number of files. |
| PM-R20 | Re-importing the same workbooks reports every day `unchanged` and writes nothing. |
| PM-R21 | The CLI prints a brief (ok, committed, totals, days, months without expected, meter numbers learned, the first five problems per sheet, and the warnings) and exits with 1 when `ok` is false. |

## 6. Expected energy (`expected_energy`, modelled)

CLI: `python -m app.services.pwa_meter expected --model <workbook> [--start YYYY-MM] [--until YYYY-MM] [--check]`. The defaults are January 2026 through December of next year. The builder is `pwa_meter_model.py`.

| ID | Requirement |
|---|---|
| PM-E1 | The workbook must have the sheets `PVsyst_ระยะ1`, `PVsyst_ระยะ2` and `ประมาณการ_kWh`. Each PVsyst sheet must have a header row with `ลำดับ`, `kWp` and the twelve columns `ม.ค.` … `ธ.ค.` in order. `ประมาณการ_kWh` must have date-valued month columns. `PVsyst_ระยะ2` must state `ผลผลิตจำเพาะตามสัญญา ระยะ 2 ปีแรก`. Anything missing raises `ModelError` with what is missing. |
| PM-E2 | PVsyst kWh/day = the month's E_Grid (MWh) × 1000 × site kWp ÷ PVsyst kWp ÷ days in the month, using the site's `pvsyst_seq` row. |
| PM-E3 | Phase 1 contract kWh/day = the `ประมาณการ_kWh` month (row `contract_seq`) ÷ days. For a month the sheet does not cover, use the same calendar month of the latest covered year × `contract_degradation_per_year` (0.993) for each year back. |
| PM-E4 | Phase 2 contract kWh/day = kWp × first-year specific yield (1,412.37 kWh/kWp/yr) × that month's share of phase 2's fleet PVsyst year ÷ days, × 0.993 for each full contract year since `phase2_contract_start` (2026-01-01). No figure before that date. |
| PM-E5 | A figure the workbook does not give stays null and is reported as a warning (missing PVsyst or contract row). Values are rounded to 2 decimals. |
| PM-E6 | The rows are upserted on (site, month). The result has `months_added`, `months_updated`, `sites` and `warnings`. `--check` adds the largest difference in kWh/day against the contract / PVsyst stored on imported days. |

## 7. Performance, losses and issues (`summary`)

The window is [start, end] over the stored days. Each formula below is computed over the days in the window.

| ID | Requirement |
|---|---|
| PM-P1 | A **curtailed site** has more than `site_curtailed_min_note_days` (30) curtailment-note days in the window. |
| PM-P2 | Meter energy is compared only on days that have the modelled figure: `vs_contract_pct` = Σ meter on days with contract ÷ Σ contract. `PI_PVsyst` (`vs_pvsyst_pct`) = Σ meter ÷ Σ PVsyst over the site's **ok** days that have a PVsyst figure. |
| PM-P3 | **PI_free** per phase = the pooled PI_PVsyst of the phase's non-curtailed sites on ok days. It is always computed over **every** site of the phase, whoever asks and whatever `phase` filter is set. |
| PM-P4 | Losses (estimated, kWh): curtailment = max(0, (PI_free − site PI_PVsyst) × Σ PVsyst on ok days), curtailed sites only; outage = Σ PVsyst on outage days × PI_free; under-performance = max(0, (`under_performance_ratio` 0.95 × PI_free − site PI_PVsyst) × Σ PVsyst on ok days), non-curtailed sites only. Without a PI_free or a site PI_PVsyst, the loss is 0. |
| PM-P5 | THB = kWh × `tariff.book_price_thb_per_kwh` (2.7647). `loss_thb` = the sum of the three losses × price. |
| PM-P6 | Availability = 1 − outage days ÷ site-days. Data availability = 1 − (`loss_inv` + `loss_meter`) days ÷ site-days. Site-days are the stored days of the site in the window. |
| PM-P7 | Issues and owner (`issue_flags`): `หรี่กำลัง` (curtailment loss ≥ 20,000 kWh, PM); `ผลิตต่ำกว่าคาด` (under-performance ≥ 10,000 kWh, O&M); `ระบบล่ม` (≥ 5 outage days, O&M); `ข้อมูลขาด` (≥ 15 data-gap days, O&M); `ล่มช่วง 14 วันล่าสุด` (an outage day in the 14 days ending on the newest stored day in the window, O&M). `owner` joins the owners with ` + `, PM first, and is null when there are no issues. |
| PM-P8 | The site rows are sorted by `loss_thb` descending and numbered `rank` from 1, over all sites before the scope and phase filters. |
| PM-P9 | Site row fields: `site_id, phase, name, region, kwp, growatt_plant_id, days, meter_mwh, contract_mwh, pvsyst_mwh, vs_contract_pct, vs_pvsyst_pct, yield_kwh_kwp, availability_pct, data_availability_pct, outage_days, data_gap_days, outage_recent_days, curtailment_note_days, curtailed, curtailment_loss_mwh, outage_loss_mwh, under_loss_mwh, loss_thb, issues[], owner, rank`. `yield_kwh_kwp` = Σ meter ÷ kWp. |
| PM-P10 | Phase rows (admins only): `phase, sites, kwp, first_day, last_day, meter_mwh, contract_mwh, pvsyst_mwh, vs_contract_pct, pi_free_pct, availability_pct, data_availability_pct, curtailed_sites, curtailment_loss_mwh, outage_loss_mwh, under_loss_mwh, fee_thb` (fee = Σ meter × book price). |
| PM-P11 | `window` returns the first and last stored day in the result, not the requested bounds. When no day is stored, it echoes the request and `phases` and `sites` are empty. |

## 8. Outage events and meter check

| ID | Requirement |
|---|---|
| PM-O1 | An outage event is a run of consecutive outage days of one site within the window. Fields: `site_id, phase, name, region, start, end, days, lost_mwh, lost_thb, cause, note`. Lost = Σ PVsyst of the event's days × the phase's PI_free (estimated). The rows are sorted by `days` descending, then by `start`. |
| PM-O2 | Cause = the first group of `outage_event.cause_keywords` whose keyword appears in the event's notes (distinct notes joined with ` \| `), else `ไม่ระบุ`. |
| PM-O3 | MTTR (mean event length), long events (≥ `long_event_days`, 7) and fixed fast (≤ `fixed_fast_days`, 3) are computed in the UI over the events shown, with the thresholds read from `/criteria`. Daily data cannot see outages of a few hours. |
| PM-M1 | Ratio = meter ÷ inverter on days where both are > 0. The site's normal ratio is its median over the window. |
| PM-M2 | Only days on which the inverter made more than `production_gate_kwh_per_kwp` (0.5) × kWp are judged. A **low** day has a ratio below the median − `low_day_drop` (0.03). A **high** day has a ratio above `high_day_ratio` (1.005). Inverter-missing days have meter > 0 and inverter not > 0. Meter-missing days are the reverse. |
| PM-M3 | Flags: `สัดส่วนต่ำกว่าปกติ` (median < 98.5 %); `มิเตอร์อ่านต่ำ/ขาด` (low + meter-missing days ≥ 3); `ข้อมูลอินเวอร์เตอร์ขาด` (inverter-missing days ≥ 10); `มิเตอร์สูงกว่าอินเวอร์เตอร์` (high days ≥ 10). |
| PM-M4 | Gap (estimated) = Σ over low and high days of (inverter × median − meter) + Σ inverter × median on meter-missing days, floored at 0 per site. High days count negative, which offsets meter read-time shifts. |
| PM-M5 | Fields: `site_id, phase, name, region, median_ratio_pct, p05_ratio_pct, low_days, high_days, inverter_missing_days, meter_missing_days, gap_mwh, gap_thb, flags[]`, sorted by `gap_thb` descending. The meter check is computed per site, so it does not depend on other sites. |

## 9. API (`/pwa/meter`, mounted at `/api` and `/`; DB only)

Every route needs a signed-in user. `start` / `end` are ISO dates; `end < start` gives **422**.

| ID | Route | Response |
|---|---|---|
| PM-A1 | `GET /criteria` | the criteria file as JSON |
| PM-A2 | `GET /sites` | the visible sites (`site_id … kwp_mismatch`; §2.1 without `meter_no` / `updated_at`) |
| PM-A3 | `GET /sites/{site_id}/days?start&end` | `{site, days[]}`. Each day has the stored fields plus `yield_kwh_kwp` = meter ÷ kWp (3 decimals, null with no meter). **404** outside the scope or for an unknown site. |
| PM-A4 | `GET /summary?start&end&phase` (`phase` 1–4) | `{window, phases[], sites[], labels}` (§7) |
| PM-A5 | `GET /outages?start&end` | outage events (§8) |
| PM-A6 | `GET /meter-check?start&end` | meter check rows (§8) |
| PM-A7 | `GET /plants/{plant_id}?start&end` | one Growatt plant's report days beside Growatt's own `plant/energy` day (PM-A9) |
| PM-A8 | `POST /import` (admin; multipart `files[]`, `commit` bool, `days` JSON) | preview / commit (§5.3); **403** for engineers |

**PM-A9, plant comparison.** The site is the first report site by `site_id` with that `growatt_plant_id`. The default window is the 60 days ending on the site's last report day. Each day adds `growatt_kwh` (from `growatt_plant_energy_days`, 1 decimal) and `meter_vs_growatt_pct` = 100 × meter ÷ Growatt, set only where both are > 0. A Growatt day above 10 kWh/kWp × (`growatt_kwp`, else `kwp`) is withheld: `growatt_kwh` null and `growatt_implausible` true. `summary` has `report_days`, `compared_days`, `meter_kwh`, `median_meter_vs_growatt_pct` and the pooled `meter_vs_growatt_pct`. The response also has `site`, `last_report_day`, `window` and `labels`. **404** when the plant is outside the scope or has no report site.

### 9.1 Scope

| ID | Requirement |
|---|---|
| PM-A10 | Admin: every site, with phase totals. |
| PM-A11 | Engineer: only the sites whose `growatt_plant_id` is assigned to them (assignments are read per request). A site without a Growatt plant is admin only. Other sites answer 404 and never appear in lists. |
| PM-A12 | Engineers get `phases: []`, because the totals include plants they may not see. PI_free and the losses are still judged against every site of the phase (PM-P3). |

## 10. UI

### 10.1 PWA Meter page (`/pwa-meter`, Operations → PWA Meter, everyone)

| ID | Requirement |
|---|---|
| PM-U1 | Data = summary + outages + meter check for the window, read on mount, on a window change and on Refresh. The page never polls, because the report is imported monthly. |
| PM-U2 | Period: the presets Whole report / Year to date / Last 90 days / Last 30 days count back from the **report's last day** (the report lags up to a month), or From / To dates. |
| PM-U3 | Stat strip: Sites, With issues, O&M to act, PM (curtailment), and Outage events with MTTR, % fixed ≤ 3 d and long count (PM-O3). The first four filter the Sites tab. "—" means not read yet, never 0. |
| PM-U4 | Admins see a Phase totals table. Engineers see none. |
| PM-U5 | Tabs Sites / Outage events / Meter check, each with search (every word in name, id or region), a phase filter, sorting and Export CSV (with a BOM, for the Thai words). |
| PM-U6 | A site row opens the site dialog (`?site=`). It shows meter and inverter per day, with contract / PVsyst dashed as modelled, outage days shaded and missing readings hatched. A ratio panel shows meter ÷ inverter on 90–104 %, with days outside the range drawn on the edge in red and the real value in the tooltip. The dialog also has the site's figures, its outage events, the report's notes and a link to the Growatt plant's Generation tab. |
| PM-U7 | Losses, ฿ and the gap are marked `est.`; contract / PVsyst are marked `mod.`. |
| PM-U8 | URL state: `tab` (sites \| outages \| meter), `from`, `to`, `phase`, `q`, `show` (all \| issues \| om \| pm), `sort`, `desc`, `site`. |
| PM-U9 | **Import report** (admins): pick the workbooks → preview (rows matched, new / changed / same days, pre-contract rows, problems; only sheets with problems or changes are listed, problems first) → set a sheet's day or tick Skip → Check again → Import. Import is disabled while the preview is stale or has problems. The files are sent again on every check; nothing is kept between checks. |

### 10.2 Generation page card

| ID | Requirement |
|---|---|
| PM-U10 | `generation/PwaMeterCard` is shown only for a plant in the report. It is hidden on 404. It shows the last 60 report days of meter energy beside Growatt's day energy, the report's inverter total and the contract (modelled, dashed), and meter ÷ Growatt on the same 90–104 % ratio panel (`pwaMeter/chart.ts`), with a link to the site in PWA Meter. |

## 11. Differences between the plan and the code, and open points

1. ~~**Route docstring is stale.**~~ Fixed 2026-11-21: `api/routes/pwa_meter.py` now names `POST /import` beside the CLI.
2. ~~**Cause rule wording.**~~ Fixed 2026-11-21 (criteria `2026-11-21c`): `outage_event.cause_rule` now says the event's notes, as the code and the plan do.
3. **Recent-outage window.** The plan says "the last 14 days of the window". The code counts back from the newest stored day in the window, which is earlier than the requested `end` when the report lags. This spec follows the code (PM-P7).
4. **Site-days.** Availability and data availability divide by the days stored for the site, so a day missing from the report entirely does not count against either. This is not stated in the plan.
5. **Criteria reload.** The plan says to change thresholds in the file. The file is cached per process, so a change needs a restart (PM-G4).
6. **Several sites per plant.** `/plants/{plant_id}` uses the first site by `site_id` when two report sites share a Growatt plant. No such case exists today.
7. **Expected-energy check tolerance.** The plan says "within 0.01 kWh/day" and the criteria note says "within 0.006". Both describe the same 21 Nov check.
8. **To confirm with the contract:** the 0.993 contract degradation per year (PM-E3, PM-E4). It is not stated in the model workbook.
9. **To confirm with the auditor:** the TFRS 16 remeasurement (`tfrs16`: remeasure when actual ÷ contract is off by more than 5 %; liability × that ratio; the model assumes 90 %). No route computes it yet.
10. **Not used yet:** `kpi_targets_fy2570` and `alerts_proposed` are in the criteria file only. Nothing in the app reads them.
11. **Registry kWp mismatches to fix in Growatt:** บ้านด่าน, พนมทวน, นิเวศรัตน์, แม่สาย, สันทราย (plan §2.1).

## 12. Code map

| Piece | File |
|---|---|
| Models | `backend/app/db/models/pwa.py` |
| Service: CSV import, reads, summary, outages, meter check, report import, plant comparison, CLI | `backend/app/services/pwa_meter.py` |
| Workbook parser | `backend/app/services/pwa_meter_report.py` |
| Expected energy from the model | `backend/app/services/pwa_meter_model.py` |
| Criteria | `backend/app/services/pwa_meter_criteria.json` |
| Routes | `backend/app/api/routes/pwa_meter.py` |
| UI | `frontend/src/pages/PwaMeterPage.tsx`, `frontend/src/pages/pwaMeter/*`, `frontend/src/pages/generation/PwaMeterCard.tsx`, `frontend/src/api/types/pwaMeter.ts` |
| Tests | `backend/tests/test_pwa_meter.py` |

## 13. Test coverage (`backend/tests/test_pwa_meter.py`)

| Test | Covers |
|---|---|
| `test_classify_follows_criteria` | PM-S1 |
| `test_import_is_idempotent_and_keeps_missing_as_null` | PM-C2, PM-G2 |
| `test_bad_row_rolls_back_the_whole_import` | PM-C3, PM-C4 |
| `test_summary_losses_and_issues` | PM-P1–PM-P8 |
| `test_outage_events_and_meter_check` | PM-O1, PM-O2, PM-M1–PM-M5 |
| `test_engineer_sees_only_assigned_sites` | PM-A11, PM-A12 |
| `test_plant_days_compare_meter_with_growatt` | PM-A9 |
| `test_report_dates_from_title_and_sheet_names` | PM-R6 |
| `test_report_preview_commit_and_reimport` | PM-R14–PM-R16, PM-R20 |
| `test_report_phase2_uses_system_pull_and_nulls_missing_reading` | PM-R4, PM-R12 |
| `test_report_overrides_skip_and_pre_contract_sheets` | PM-R10, PM-R17 |
| `test_report_route_is_admin_only` | PM-A8 |
| `test_expected_rows_follow_the_model_rules` | PM-E2–PM-E4 |
| `test_summary_counts_only_days_with_a_contract_figure` | PM-P2 |
| `test_report_matches_by_learned_meter_number_then_name` | PM-R7, PM-R8 |
| `test_report_refuses_a_future_day` | PM-R11 |
| `test_report_route_size_limit` | PM-R18 |
| `test_window_checks_and_empty_window` | 422 for `end < start` (§9), PM-P11 |
| `test_model_workbook_without_the_sheets_is_refused` | PM-E1 |

Still without a test: PM-C1 (a missing CSV column), PM-R19 (the audit log line) and PM-E6 `--check`. The UI requirements (PM-U*) are checked only by `bun run lint && bun run build`.
