# Plan: O&M site assets and network register

Status: **Built (phases 0–2, v1)** 2026-11-22: tables, converter + matcher + import (API and CLI), the plant Documents tab card, the directory province filter; first import applied locally 2026-11-22 (233 stations, 1,454 devices, 233 matched: 230 by logger SN, 2 by truncated SN, 1 by the code in the Growatt name; 20 stations flagged for review). Settings → Site register (list with checks, admin import: file → preview → apply) built 2026-11-22, with an .xlsx export in the workbook layout that imports again unchanged (checked on the real register: 0 differing values). Firestore `plants/{id}.site` (site_code, project_phase, province, cod_actual) approved and published 2026-11-22 (233 docs), republished on each applied import; the Calendar's province grouping uses the register. Not built: warranty alerts (no warranty data yet) · Created 2026-11-22 · Owner: Chanthawat

Source: `data/OM-Asset & Network.xlsx`, the O&M team's register of each station's site data, contract / COD dates and the
communication devices on site (logger, weather station, revenue meters, 4G router, PQM, ShineMaster), with their serials,
IPs and SIMs.

Goal: keep this register in the app per Growatt plant, so an engineer on a plant page sees the station code, PEA meter and
billing details, COD and the site network without opening the spreadsheet. Admins import the workbook again whenever the
team updates it.

---

## 1. What is in the workbook (surveyed 2026-11-22)

233 stations, codes `P1-001` … `P4-xxx` (no duplicates). Every device sheet repeats `รหัส` + `สถานี`.

| Sheet | Rows | Columns (filled / 233 unless noted) |
|---|---|---|
| `ข้อมูลสถานี` (station master) | 233 | รหัส, สถานี, ระยะ (1–4), kWp, เลขมิเตอร์ กฟภ. (233, unique), จังหวัด (233, 70 provinces), SN Data logger (233), Firmware logger, Teltonika IP (233), SIM (AIS) (43), ShineMaster IP, PQM IP, จำนวน Revenue meter (1–8), วันตัดรอบบิล (`30,31`, `19,20`, …), COD จริง (40), อุปกรณ์ที่ยังไม่มี SN (3 / 4) |
| `_นำเข้า COD` | 233 | สาขา กปภ., เขต กปภ., เขต กฟภ., kWp, Inverter รวม (kW), กันย้อน (HV / MV / LV), บัญชีผู้ใช้ไฟ (233), สถานะขนานไฟ (กฟภ.) (102), วิศวกรดูแล, ช่าง O&M (nicknames, e.g. `ต้า, เปรม`), ผรม. (เคลม DLP) (S / C / B), เริ่มสัญญา PEA (งวด 1), COD Baseline (102), COD จริง (40) |
| `อุปกรณ์ - Data logger` | 233 | Growatt, SN, firmware, สถานะ, warranty start (40), warranty end (0), note (0) |
| `อุปกรณ์ - Weather station` | 233 | Growatt Weather Station, SN (0), Address (18), สถานะ, warranty start (40) |
| `อุปกรณ์ - Revenue meter` | **289** (1–8 per station) | ลำดับ, CEWE Prometer, SN (289, unique, e.g. `WP076110`), IP, CT ตั้งค่า (178), CT หน้างาน (85), วันตัดรอบบิล, วันเริ่มขายไฟ (60), Clear data COD (22, free text), สถานะเชื่อมต่อ (4), สถานะ, warranty start (73) |
| `อุปกรณ์ - Router 4G` | 233 | Teltonika RUT, SN (145), IP, Network (43, e.g. `10.2.1.0/24`), SIM (43), สถานะ |
| `อุปกรณ์ - PQM` | 233 | IP only (brand, SN empty) |
| `อุปกรณ์ - ShineMaster` | 233 | IP only (brand, SN empty) |
| `ตั้งค่า` | — | warranty years per device kind: **all empty** |

What the survey shows:

- **The logger serial joins each station to its Growatt plant.** 230 of 233 `SN Data logger` values are a
  `growatt_inverters.datalogger_sn` of exactly one plant. The other 3 are typos in the workbook:
  - `P1-026` `DYDCE9304` is Growatt's `DYDCE9304C` (last character missing), plant 10029546 `P1_26 สถานีผลิตน้ำท่าพระ…`
  - `P1-038` `DYDCE9302` is Growatt's `DYDCE93028` (last character missing), plant 10126064 `สถานีผลิตน้ำบ้านบางโจ`
  - `P2-039` `DYDDF6K03U` is not in Growatt; plant 10608931 `P2A_39 สถานีจ่ายน้ำบางแสน` reports `DYDDF46072`.
  With these 3 the register covers all 233 local Growatt plants 1 : 1.
- **The phase is the project phase, not the Growatt account.** P1–P3 agree with `growatt_plants.phase`; the 57 P4 stations
  sit in the Growatt phase 3 account. Store the workbook's phase as `project_phase`; don't touch `growatt_plants.phase`.
- **The province is better than Growatt's.** Growatt's `city` matches the workbook's จังหวัด for 1 plant out of 230; the rest are
  districts, English names or blank (`โพแตง`, `Chonburi`, ``). The new plant-directory province filter (uses `city`) should
  switch to this province.
- **kWp agrees with Growatt within 1 % at 221 of 230.** The other 9 are shown as a difference, like `pwa_meter_sites.kwp_mismatch`.
- **Revenue meters (CEWE, `WP…`) are PEA billing meters**, not the Growatt energy meter (CHNT, `growatt_meters`). Their serials
  are what the daily PWA report prints, so they can seed `pwa_meter_sites.meter_no`.
- **Engineers are nicknames** (`ต้า, เปรม`), not app users. They can't replace `user_plant_assignments`; keep them as text, and
  offer a one-time mapping later.
- **Sensitive data.** Private IPs, the site subnets, SIM phone numbers and PEA account numbers. The file is **not gitignored**
  today (`data/` is untracked; only `*.db`, `*.csv`, `*.json` are ignored).

## 2. Scope

**In (v1)**
- `.gitignore`: `data/*.xlsx` (step 0, before anything else).
- Two SQL tables (§3), an admin import with a preview (§4), and a CLI for the same import.
- Plant page: an **Assets & Network** card (§5) for admins and the engineers assigned to the plant.
- Settings → **Site register**: one row per plant, the import, and an XLSX export.
- The plant directory's province filter uses the register's province (Growatt `city` as fallback).

**Out (later)**
- Editing single devices in the app (v1: the workbook stays the source; re-import replaces).
- Checking devices live (ping a router IP, PQM / ShineMaster polling); the app has no route into the site VPN.
- Warranty alerts (the warranty columns and `ตั้งค่า` years are empty today).
- Mapping the nicknames to app users / O&M teams.
- Sending the register to Firestore (§6).

## 3. Data model

Kept out of `growatt_plants` (the Growatt mirror; blocked-plant cleanup deletes its rows). No FK on `plant_id`, like
`plant_documents` and claims; the blocked-plant cleanup also deletes these rows.

**`site_register`**: one row per station

| Column | From | Notes |
|---|---|---|
| `site_code` str(16) PK | รหัส | `P1-001` |
| `plant_id` int, unique, null | logger SN join (§4) | null = not matched yet |
| `name` str(200) | สถานี | |
| `project_phase` int | ระยะ | 1–4 |
| `province` str(64) | จังหวัด | |
| `kwp` float | kWp | contract kWp |
| `inverter_ac_kw` float, null | Inverter รวม (kW) | |
| `export_limit` str(8), null | กันย้อน | HV / MV / LV |
| `pea_meter_no` str(32) | เลขมิเตอร์ กฟภ. | text: leading zeros matter |
| `pea_account_no` str(32) | บัญชีผู้ใช้ไฟ | |
| `pea_connection_status` str(64), null | สถานะขนานไฟ (กฟภ.) | as written |
| `pwa_branch`, `pwa_zone`, `pea_zone` str | สาขา / เขต กปภ., เขต กฟภ. | |
| `billing_cut_days` str(16), null | วันตัดรอบบิล | `30,31` as written |
| `pea_contract_start`, `cod_baseline`, `cod_actual` date, null | | COD จริง: 40 filled; nothing is filled in from the baseline |
| `dlp_contractor` str(8), null | ผรม. (เคลม DLP) | S / C / B; links to Claims later |
| `engineers_text`, `technicians_text` str(200), null | วิศวกรดูแล, ช่าง O&M | text only |
| `missing_sn_count` int, null | อุปกรณ์ที่ยังไม่มี SN | |
| `imported_at`, `imported_by` | | |

**`site_devices`**: one row per device

| Column | Notes |
|---|---|
| `id` PK; `site_code` FK → `site_register` (cascade) | |
| `kind` str(16) | `datalogger` \| `weather_station` \| `revenue_meter` \| `router` \| `pqm` \| `shinemaster` |
| `seq` int | ลำดับ (revenue meters 1–8; 1 for the others) |
| `brand_model`, `serial`, `firmware` str, null | |
| `ip` str(45), `network` str(43), `sim` str(16), null | |
| `address` str(8), null | weather station's Modbus address |
| `ct_setting`, `ct_site` str(16), null | revenue meters; a difference between them is shown as a warning |
| `billing_cut_days` str, `sales_start` date, `cod_clear_note`, `link_status` str, null | revenue meters |
| `status` str(32) | ใช้งาน … as written |
| `warranty_start`, `warranty_end` date, null | |
| `note` text, null | |

Unique (`site_code`, `kind`, `seq`). Empty cells are null; nothing is guessed (CLAUDE.md rule 3). A warranty end is shown
only where the sheet gives one. Once `ตั้งค่า` has warranty years, an end date computed from them is labelled "computed".

Growatt stays the source of what Growatt reports. The register's logger serial / firmware sit next to Growatt's
`datalogger_sn`, and a difference is flagged, never overwritten either way.

## 4. Import

`POST /site-register/import` (admin; multipart xlsx), `?apply=false` by default, the same flow as the as-built links and
the PWA report imports: preview first, then all or nothing.

1. Read the sheets by name (`ข้อมูลสถานี`, `_นำเข้า COD`, `อุปกรณ์ - *`); a row counts when `รหัส` matches `^P\d-\d{3}$`.
   Missing sheet or column = 422 naming it.
2. Match each station to a plant, in this order:
   1. the logger serial is a `datalogger_sn` of exactly one plant (230 today);
   2. else a Growatt plant whose serial starts with it, only when exactly one does (fixes the truncated pair);
   3. else the code in the Growatt name (`P1_26`, `P2A_39`), only when exactly one plant matches;
   4. else a match kept from an earlier import, or one an admin set;
   5. else unmatched.

   An admin can set or change a match in the preview / Settings table.
3. The preview lists counts and every row that needs a look: unmatched, matched by rule 2 or 3 (with the serial Growatt
   has), kWp off by more than 1 %, CT setting ≠ CT on site, a revenue meter count that differs from `จำนวน Revenue meter`,
   duplicate serials.
4. Apply replaces both tables in one transaction (stations missing from the new file are deleted, after confirming).
   It sets `pwa_meter_sites.meter_no` from revenue meter 1 only where it is empty (never overwrites a learned one).
5. CLI: `PYTHONPATH=backend uv run python -m app.services.site_register "data/OM-Asset & Network.xlsx" [--apply]`.

The uploaded file is read in memory and not stored.

## 5. UI

- **Plant page → Assets & Network card** (Overview, or a tab next to Documents):
  - Site: code, project phase, province, kWp (Growatt kWp beside it when they differ), PEA meter / account, billing cut-off,
    contract start, COD baseline / actual, export limit, DLP contractor, engineers / technicians.
  - Network: one table of devices by kind, with brand / model, serial, IP, SIM, status, warranty, and a copy button on IPs
    and serials. Revenue meters list every meter with CT setting / on site.
  - Badges for what needs a look (logger serial ≠ Growatt's, CT mismatch, no SN).
- **Settings → Site register** (admin): every station with its plant match, filters (phase, province, unmatched, issues), the
  import dialog with its preview, and an XLSX export in the workbook's layout.
- **Plant directory**: the province filter and the Location column use the register's province (Growatt `city` as
  fallback). The Calendar's "same province" rounds should use it too.
- Thai labels for every field (`i18n/th/…`), the workbook's own Thai headings where they exist.

## 6. Access and where the data goes

- `GET /growatt/plants/{id}/site-register`: admin, or an engineer assigned to the plant (`allowed_plant_ids`). The fleet
  list and the import are admin only.
- **Network fields (IP, subnet, SIM) and PEA account numbers stay in SQL and the API:**
  - not in Firestore;
  - not in app logs (the import logs counts only);
  - not given to the AI assistant's tools.
- Firestore (optional, recommended): add `site_code`, `project_phase`, `province`, `cod_actual` to the `plants/{id}`
  registry doc. That's static data, one rewrite of 233 docs, within the write budget. The same "only when present" rule as
  `documents`.

## 7. Phases

0. `.gitignore` gets `data/*.xlsx`.
1. Backend: models + `ensure_schema`, the parser + matcher (`services/site_register.py`), import route + CLI, plant GET,
   blocked-plant cleanup, tests (matcher rules on the 3 known typos, all-or-nothing apply, access by assignment, null for
   empty cells). First import locally; review the preview.
2. Frontend: the plant card, the Settings page with the import, the province switch in the directory and Calendar.
3. Optional: Firestore `plants/` fields, `pwa_meter_sites.meter_no` seeding, warranty years and alerts, nickname → user
   mapping, editing devices in the app.

## 8. Open questions

1. **Is the workbook the source from now on, or should the app become it?** Recommendation: the workbook for v1 (re-import),
   in-app editing later.
2. **Who sees the network details?** Recommendation: admins and the plant's assigned engineers, the same as the plant pages.
3. **Fix the 3 logger serials in the workbook?** `P1-026` → `DYDCE9304C`, `P1-038` → `DYDCE93028`; `P2-039`: check on site
   whether `DYDDF6K03U` or Growatt's `DYDDF46072` is the installed logger.
4. ~~**Firestore `plants/` fields** (§6): wanted?~~ Yes (2026-11-22): built as `plants/{id}.site`.
