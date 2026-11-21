# Plan: PWA daily meter report in the app

Status: **Built 2026-11-21: tables, CSV import, read API, criteria file, tests, the meter lists and tiles of the O&M Dashboard (`/center`, one page since 2026-11-21; `/pwa-meter` redirects there), daily report Excel import, monthly expected energy from the model.** · Owner: Chanthawat
Data: phases 1–2 daily reports (Cewe meters), 131 sites, 8 Jan – 18 Nov 2026 (phase 1 from 17 Jan), 40,412 site-days.

The PWA daily report is the billing record: the meter kWh each site sends to PEA every day. The Growatt data in the app is inverter-side and kept 90 days. This module stores the meter days indefinitely and computes, from one criteria file, the same engineering and finance figures as the phases 1–2 Engineering & Finance dashboard, so the team can query them from the app.

## 1. What was built

| Piece | Where |
|---|---|
| Tables `pwa_meter_sites`, `pwa_meter_days` | `app/db/models/pwa.py`, migration `5e1f2a3b4c6d` |
| Import (upsert, all-or-nothing) and summaries | `app/services/pwa_meter.py` |
| Criteria: every threshold and formula | `app/services/pwa_meter_criteria.json` |
| Read API `/pwa/meter/*` | `app/api/routes/pwa_meter.py` |
| Daily report Excel import (preview, then all-or-nothing) | `app/services/pwa_meter_report.py` (parse), `pwa_meter.import_report` (match, compare, store); `POST /pwa/meter/import`, PWA Meter → Import Billing |
| Monthly expected energy `pwa_meter_expected` (+ `pwa_meter_sites.meter_no`) | `app/services/pwa_meter_model.py`, migration `6f2a3b4c5d7e` |
| Tests | `tests/test_pwa_meter.py` |
| Clean CSVs (gitignored) | `data/imports/pwa_meter/pwa_meter_sites.csv`, `pwa_meter_days.csv` |

Rules from CLAUDE.md:
- These are source-dated daily records, not realtime values, so SQL may keep them. Nothing goes to Firestore.
- Never invent numbers: a reading the report did not give is null (a `loss_inv` day has `inverter_kwh` null, never 0). `contract_kwh` and `pvsyst_kwh` are **modelled**; losses, the meter gap and THB values are **estimated** (the API returns `labels`).
- Scope: an engineer sees the report sites whose Growatt plant is assigned to them; a site with no Growatt plant is admin only. Engineers get no fleet totals (`phases: []`), because PI_free and the losses compare a site with every site of its phase.

## 2. Import

```bash
export UV_PROJECT_ENVIRONMENT=...   # optional
PYTHONPATH=backend uv run python -m app.services.pwa_meter import \
  --sites data/imports/pwa_meter/pwa_meter_sites.csv --days data/imports/pwa_meter/pwa_meter_days.csv
PYTHONPATH=backend uv run python -m app.services.pwa_meter summary --start 2026-01-01
```

- `--days` is optional: `import --sites …` alone loads only the site list (then `expected --model …`), onto which the daily report workbooks (§2.3) are imported. The report import never creates sites: a report row carries neither the site id (`P1-<contract no.>`, e.g. มาบประชัน = ลำดับ 1 = P1-04) nor the model rows, so with no sites loaded its preview says so.
- Idempotent: rows are keyed on (`site_id`, `day`); a longer report adds days and corrects changed ones.
- One bad row refuses the whole file, naming the row: unknown site, a date not YYYY-MM-DD, a negative or non-numeric reading, an unknown weather, a duplicated site-day, or a `status` that does not match the readings.
- Monthly: the daily reports are parsed into these two CSVs outside the app (the parser handles the reports' sheet naming, which changes every month). Then run the import. On the VM, run it inside the worker container.

### 2.1 Sites file (`pwa_meter_sites.csv`)

| Column | Meaning |
|---|---|
| `site_id` | `P1-<contract no.>` or `P2-<report company id>` |
| `phase`, `name`, `region` | as in the report (`region` = PWA region, e.g. เขต 1) |
| `kwp` | contract / PVsyst capacity, the basis of expected energy |
| `contract_seq`, `pvsyst_seq` | row in the TFRS 16 model's contract and PVsyst sheets |
| `growatt_plant_id`, `growatt_name`, `growatt_kwp` | matched Growatt plant |
| `kwp_mismatch` | 1 when the registry kWp differs from `kwp` by more than 1 % |

Matching (all 131 sites, one-to-one): phase 1 by plant number + name + kWp, phase 2 by name + kWp. Five phase-2 registry kWp values differ: บ้านด่าน (registry 0), พนมทวน (140,220), นิเวศรัตน์ (102.04 vs 176.70), แม่สาย (113.38 vs 133.38), สันทราย (106.20 vs 102.60). Fix them in the Growatt registry. พระนครศรีอยุธยา 1 uses the contract 304.38 kWp; the report header says 474.24.

### 2.2 Days file (`pwa_meter_days.csv`)

| Column | Meaning |
|---|---|
| `day`, `site_id` | key |
| `meter_kwh` | Cewe meter, billed energy; null on a `loss_meter` day |
| `inverter_kwh` | inverter total from the report; null on a `loss_inv` day |
| `contract_kwh` | contract expected energy for the day (modelled): phase 1 per site per month from ประมาณการ_kWh (Oct–Nov 2026 = same month 2025 × 0.993), phase 2 = kWp × 1,412.37 kWh/kWp/yr spread by PVsyst season |
| `pvsyst_kwh` | PVsyst P50 for the day (modelled, unlimited load) |
| `status` | `ok` / `outage` / `loss_inv` / `loss_meter` (§3.1) |
| `curtailment_note` | 1 when the note contains หรี่ |
| `weather` | `clear` / `cloudy` / `rain` (report typos normalised) |
| `note` | the report's note, whitespace collapsed |

Excluded: phase 1 sheets of May 2025 (commissioning tests).

### 2.3 Daily report workbooks (Excel, from the sites)

The daily reports can be imported as sent, without the CSV step: PWA Meter → **Import Billing** (admin), or
`python -m app.services.pwa_meter report FILE… [--commit] [--day "FILE::SHEET=YYYY-MM-DD|skip"]`.

- Two layouts: phase 1 = one day per workbook (sheet `สรุปหน่วยรายวัน`, title "…ประจำวันที่ 11 พฤศจิกายน 2569"); phase 2 = one growing workbook with a sheet per day (names `711`, `017`, `19`, `7.11`, `18.11`, …). The table is found by its header text `หน่วยจากมิเตอร์`, never by sheet name or column, so the changing sheet names no longer matter.
- Day: the sheet title when it has one (Buddhist Era year converted), else the sheet name read in sequence (digits read as d+mm or dd+m, the reading that follows the previous sheet; the year rolls over in order). The preview says where each day came from; a sheet with no day (`Sheet`) is a problem until it gets a day or is skipped.
- Phase 2 values come from the system pull on the left of the header row (`Cewe`, `Growatt`, `Weather`), not the typed table: the table repeats an old inverter figure on days the inverter was not reporting (P2-1073, 11–12 Jan 2026). The phase 1 workbook has the same layout, but its typed table is kept: it is `=Q` / `=R` / `=V` of the pull except where an inverter figure was typed over a wrong Growatt total (18 Nov 2026: มาบประชัน 190.2 over Growatt 0, วารินชำราบ 2,614.3 over 24,719); a blank table cell takes the pull's value. On a `loss_inv` / `loss_meter` day the reading under 1 kWh is stored as null. kWh rounded to 2 decimals.
- Matching: phase 2 rows by `comp_id` (= `P2-<comp_id>`), on a sheet where some `comp_id` is a phase 2 site (the phase 1 workbook uses the same layout with its own `comp_id`, 1 = มาบประชัน = P1-04, which is ignored); other rows by the meter number learned from earlier imports (`pwa_meter_sites.meter_no`, filled on the first import that matched the site), then by site name without the "กปภ.สาขา…" suffix (phase 1 sites). A row that matches nothing is listed and blocks the import; nothing is guessed.
- Weather by keyword (`report_import.weather_keywords`), including the report's typos; an unknown word is stored as null with a note.
- Days before each phase's start (`report_import.skip_before`, 1 Jan 2026) are counted as "pre-start" and not stored (the Nov–Dec 2025 commissioning sheets of phase 2).
- Contract / PVsyst of each day come from `pwa_meter_expected` for its month (§3.8); a month without it keeps the day's stored figures, or null with a warning.
- Checked 21 Nov 2026 on a copy of the database holding the CSV import: phase 1 report of 11 Nov = 43 / 43 unchanged; the phase 2 workbook (331 sheets, 12 s) = 27,209 days unchanged, 247 changed (notes the CSV had dropped on the sheets of the 10th, 20th and 30th of Jul–Sep), 1,040 pre-start rows, 0 unmatched; a second import = all unchanged; the summary figures unchanged.

## 3. Criteria (`pwa_meter_criteria.json`)

The service reads every threshold from this file; change it there, not in the code.

### 3.1 Day status
| Status | When | Counts as |
|---|---|---|
| outage | meter < 1 kWh and inverter < 1 kWh | downtime |
| loss_inv | inverter < 1, meter ≥ 1 | data gap (usually communications) |
| loss_meter | meter < 1, inverter ≥ 1 | data gap (meter) |
| ok | otherwise | producing |

### 3.2 Performance and losses (estimated)
- Curtailed site: more than 30 curtailment-note days in the window. Curtailment is a PM matter, not an O&M KPI.
- PI_contract = Σ meter ÷ Σ contract. PI_PVsyst = Σ meter ÷ Σ PVsyst on ok days.
- PI_free (per phase) = pooled PI_PVsyst of the non-curtailed sites.
- Curtailment loss = (PI_free − site PI_PVsyst) × PVsyst on ok days, curtailed sites, ≥ 0.
- Outage loss = PVsyst on outage days × PI_free.
- Under-performance loss = (0.95 × PI_free − site PI_PVsyst) × PVsyst on ok days, non-curtailed sites, ≥ 0.
- THB = kWh × 2.7647 (book price). Other prices in the file: TOU net 2.6356, TOU P90 2.4268, PWA grid 3.686.

### 3.3 Issues and owner
| Issue | Fires when | Owner |
|---|---|---|
| หรี่กำลัง | curtailment loss ≥ 20,000 kWh | PM |
| ผลิตต่ำกว่าคาด | under-performance loss ≥ 10,000 kWh | O&M |
| ระบบล่ม | ≥ 5 outage days | O&M |
| ข้อมูลขาด | ≥ 15 data-gap days | O&M |
| ล่มช่วง 14 วันล่าสุด | an outage day in the last 14 days of the window | O&M |

### 3.4 Outage events
Consecutive outage days of a site. MTTR = mean event length; a long event is ≥ 7 days; fixed fast = ≤ 3 days. Cause = the first keyword group found in the event's notes: น้ำท่วม, มิเตอร์ชำรุด, ทดสอบ/ปิดตามแผน, งานฝั่ง กปภ., สื่อสาร/zero export, เบรกเกอร์/อุปกรณ์ไฟฟ้า, หรี่จนหยุดผลิต, else ไม่ระบุ (keywords in the file). Daily data cannot see outages of a few hours.

### 3.5 Meter vs inverter
- Ratio = meter ÷ inverter on days both > 0; the site's normal ratio is its median (fleet ≈ 99.4 %, the AC losses).
- Days judged only when the inverter made > 0.5 kWh/kWp. Low day: ratio more than 3 points under the site median. High day: ratio > 1.005.
- Flags: median < 98.5 %; low + meter-missing days ≥ 3; inverter-missing days ≥ 10; high days ≥ 10.
- Gap (energy the meter may have missed, estimated) = Σ over low and high days of (inverter × median − meter), floored at 0 per site (high days offset meter read-time shifts), + inverter × median on meter-missing days.

### 3.6 TFRS 16
Remeasure when actual ÷ contract energy is off by more than 5 %. Remeasured liability = book liability × that ratio (the model's sheet ประเมินใหม่; confirm with the auditor). The model currently assumes 90 %.

### 3.7 FY2570 targets (O&M plan)
| KPI | Start (Jan–Nov 2026) | Target |
|---|---|---|
| Availability | 99.19 % / 99.03 % | ≥ 99.5 % |
| Data availability | 99.94 % / 98.28 % | ≥ 99.5 % |
| MTTR | 5.2 days | ≤ 3 days |
| Fixed within 3 days | 65 % | ≥ 85 % |
| Outage events | ≈ 83 / year | ≤ 50 / year |
| PI_free | 95.9 % | ≥ 97 % |
| Meter flags open > 30 days | 35 sites flagged | 0 |
| Energy recovered | — | ≥ 600 MWh/yr |

The proposed monitoring alerts (comms lost > 2 h in daylight, zero output while the region produces, meter ratio drop > 3 points 2 days, yield < 80 % of the region median 3 days) are in `alerts_proposed`; nothing in the app uses them yet.

### 3.8 Expected energy per month (`expected_energy`, modelled)
`pwa_meter_expected` holds each site's contract and PVsyst kWh/day per calendar month, built from the model workbook (`Solar-TFRS16-Model-PVsyst-ระยะ1-4.xlsx`, the copy with the `ประมาณการ_kWh` sheet):

```bash
PYTHONPATH=backend uv run python -m app.services.pwa_meter expected --model Solar-TFRS16-Model-PVsyst-ระยะ1-4.xlsx --until 2027-12 --check
```

- PVsyst = the station's month (PVsyst_ระยะN, row `pvsyst_seq`) × site kWp ÷ PVsyst kWp ÷ days.
- Phase 1 contract = `ประมาณการ_kWh` (row `contract_seq`) ÷ days; a month past the sheet (it ends Sep 2026) = the same month of the latest year × 0.993 per year.
- Phase 2 contract = kWp × 1,412.37 kWh/kWp/yr × the month's share of phase 2's fleet PVsyst year ÷ days, × 0.993 per contract year after the first (from 1 Jan 2026).
- Checked against all 1,440 site-months of the CSV import: within 0.01 kWh/day. The 0.993 a year is the CSV's rule, not stated in the model: confirm it with the contract. Re-run the command when the model changes or before the table runs out (default: through December next year).

## 4. API (DB only)

| Route | Returns |
|---|---|
| `GET /pwa/meter/criteria` | the criteria file |
| `GET /pwa/meter/sites` | visible sites |
| `GET /pwa/meter/sites/{site_id}/days?start=&end=` | the site's days + `yield_kwh_kwp`; 404 outside scope |
| `GET /pwa/meter/summary?start=&end=&phase=` | per-site KPIs, losses, issues, owner, rank; per-phase totals (admins) |
| `GET /pwa/meter/outages?start=&end=` | outage events with cause and estimated loss |
| `GET /pwa/meter/meter-check?start=&end=` | meter vs inverter per site, flags and estimated gap |
| `POST /pwa/meter/import` (admin, multipart `files`, `commit`, `days` JSON) | daily report import: preview per sheet, or store when `commit` and no problem |
| `GET /pwa/meter/vs-growatt?start=&end=` | every visible site's meter days against Growatt's `plant/energy` day (both measured): per site pooled / median / P05 meter ÷ Growatt, low / high / missing days and flags (criteria `meter_vs_growatt`), per day and phase the pooled energy; Engineering O&M's Meter vs Growatt |
| `GET /pwa/meter/plants/{plant_id}?start=&end=` | one Growatt plant's report days (default last 60) with Growatt's own day energy and meter ÷ Growatt; 404 if not in the report |

Checked on the full import (2026-01-01 → 11-18): phase 1 106.1 % of contract, phase 2 92.6 %; PI_free 95.9 % both; availability 99.19 % / 99.03 %; losses (MWh) curtailment 811 / 2,250, outage 145 / 374, under-performance 337 / 127; 71 outage events; 35 sites with meter flags, gap 81.6 MWh. Same as the dashboard.

## 5. Next
1. ~~UI: a PWA Meter page~~ done (`/pwa-meter`, frontend/CLAUDE.md).
2. ~~Compare the meter day with Growatt `growatt_plant_energy_days` per plant~~ done: `GET /pwa/meter/plants/{plant_id}` and the PWA meter card on the plant's Generation page (meter ÷ Growatt per day). Production reach depends on how far back `growatt_plant_energy_days` goes (`energy_backfill` fills 90 days). Fleet-wide since 2026-11-21: `GET /pwa/meter/vs-growatt` and Engineering O&M's Meter vs Growatt tile, chart and list.
3. ~~Import from the Excel reports in the app~~ done (§2.3): headers, not sheet names, find the table.
4. Confirm the 0.993 a year contract degradation with the contract (§3.8).

## Billing by month (Engineering O&M, 21 Nov 2026)

`GET /pwa/meter/billing?start=&end=&phase=` (`pwa_meter.billing`, rules in the criteria file `billing`): per site and calendar month the billed meter kWh at the book price, the contract's kWh (modelled) and the shortfall (contract − meter on the days with a contract figure; negative = above contract), split into outage, under-performance and meter gap (recoverable by O&M) and curtailment (PM: PWA's own load); the rest is "not explained" (weather against the model, model error, overlap of meter gap and under-performance on a low-meter day). Each month's causes come from `summary()` / `meter_check()` over that month alone, so a site's months add up to its period total in this view, not to the period summary. Losses come from the summary in MWh with 2 decimals, so the month causes have 10 kWh resolution. `sites` ranks the sites by recoverable ฿ and names the main recoverable cause, its owner and the action (`cause_owner` / `cause_action`). Whole report (8 Jan – 18 Nov 2026, admin): 52,486 MWh billed (฿145.1 M at the book price), net 271 MWh short of the contract, ฿7.15 M recoverable (est.), mostly under-performance.

Import of `billing/Phase 1.xlsx`, `Phase 2.xlsx`, `example.xlsx` (21 Nov 2026): no new day. Phase 1 has every day 4–31 May twice (`0405` and `04.05`, …) with different readings; the database holds the dotted sheets for 4–27 May and the undotted `2805`–`3105`, the other copies match no stored day. `Sheet18` / `Sheet` (phase 1) and `Sheet` (phase 2) have no date; `example.xlsx` is phase 1's `18.11`. Skipping those, all 40,369 matched days are unchanged.

## Cleaned workbooks and analysis table (`billing/clean/`, gitignored, 21 Nov 2026)

- `backend/scripts/clean_pwa_report_workbooks.py`: copies of `Phase 1.xlsx` / `Phase 2.xlsx` with one visible sheet per day named `DD.MM.YYYY`, in date order (302 / 330 sheets). Dropped: `Sheet18`, `Sheet` (no date) and, for 4–31 May (phase 1), the copy whose readings are not the ones stored in `pwa_meter_days`. Only the workbook index is edited (cells, formats and drawings byte for byte); `<name> (clean)_log.csv` lists each original sheet. The import reads a `DD.MM.YYYY` name as that exact day (`pwa_meter_report.sheet_full_day`); importing the clean copies = all 40,369 matched days unchanged.
- `backend/scripts/build_pwa_meter_analysis.py`: `pwa_meter_analysis.xlsx` / `.csv`, one row per site and day from the contract start with only the columns used for calculation and decisions: keys (site_id, Growatt plant id, kWp), measured meter / inverter kWh read by the import's rules (identical to the database on all 40,369 rows), day status, weather class, curtailment note, the Growatt pull's status / API error, the **modelled** proposal estimate and contract kWh, and derived yield and ratios (Excel formulas). Dropped: comp_pid, ลำดับ, peak sun hours, the diff / %Diff columns (recomputed), b_id / b_name.
- The proposal estimate (หน่วยประมาณการจากเล่มข้อเสนอ) is the proposal's annual kWh ÷ 365: phase 1 cells are formulas `=950424/365`, phase 2 typed daily numbers (`=AB*4` on 8–11 Nov 2025 only, before the contract start). Constant per site except P2-1084 (480,920 → 442,376 kWh/yr from 23 Apr 2026) and P2-1105 (181,423 → 253,025 from 28 Mar 2026); P2-1126 is 0 on 6–8 Apr 2026 (left empty). It is a flat daily figure, not the contract's monthly shape: the app's `contract_kwh` runs 0.84× (Nov) to 1.11× (Apr) of it.
