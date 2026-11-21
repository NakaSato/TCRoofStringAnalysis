# Plan: PWA daily meter report in the app

Status: **Built 2026-11-21: tables, CSV import, read API, criteria file, tests, PWA Meter page (`/pwa-meter`).** · Owner: Chanthawat
Data: phases 1–2 daily reports (Cewe meters), 131 sites, 8 Jan – 18 Nov 2026 (phase 1 from 17 Jan), 40,412 site-days.

The PWA daily report is the billing record: the meter kWh each site sends to PEA every day. The Growatt data in the app is inverter-side and kept 90 days. This module stores the meter days indefinitely and computes, from one criteria file, the same engineering and finance figures as the phases 1–2 Engineering & Finance dashboard, so the team can query them from the app.

## 1. What was built

| Piece | Where |
|---|---|
| Tables `pwa_meter_sites`, `pwa_meter_days` | `app/db/models/pwa.py`, migration `5e1f2a3b4c6d` |
| Import (upsert, all-or-nothing) and summaries | `app/services/pwa_meter.py` |
| Criteria: every threshold and formula | `app/services/pwa_meter_criteria.json` |
| Read API `/pwa/meter/*` | `app/api/routes/pwa_meter.py` |
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

## 4. API (DB only)

| Route | Returns |
|---|---|
| `GET /pwa/meter/criteria` | the criteria file |
| `GET /pwa/meter/sites` | visible sites |
| `GET /pwa/meter/sites/{site_id}/days?start=&end=` | the site's days + `yield_kwh_kwp`; 404 outside scope |
| `GET /pwa/meter/summary?start=&end=&phase=` | per-site KPIs, losses, issues, owner, rank; per-phase totals (admins) |
| `GET /pwa/meter/outages?start=&end=` | outage events with cause and estimated loss |
| `GET /pwa/meter/meter-check?start=&end=` | meter vs inverter per site, flags and estimated gap |
| `GET /pwa/meter/plants/{plant_id}?start=&end=` | one Growatt plant's report days (default last 60) with Growatt's own day energy and meter ÷ Growatt; 404 if not in the report |

Checked on the full import (2026-01-01 → 11-18): phase 1 106.1 % of contract, phase 2 92.6 %; PI_free 95.9 % both; availability 99.19 % / 99.03 %; losses (MWh) curtailment 811 / 2,250, outage 145 / 374, under-performance 337 / 127; 71 outage events; 35 sites with meter flags, gap 81.6 MWh. Same as the dashboard.

## 5. Next
1. ~~UI: a PWA Meter page~~ done (`/pwa-meter`, frontend/CLAUDE.md).
2. ~~Compare the meter day with Growatt `growatt_plant_energy_days` per plant~~ done: `GET /pwa/meter/plants/{plant_id}` and the PWA meter card on the plant's Generation page (meter ÷ Growatt per day). Production reach depends on how far back `growatt_plant_energy_days` goes (`energy_backfill` fills 90 days).
3. Import from the Excel reports in the app once the sheet naming is fixed at the source.
