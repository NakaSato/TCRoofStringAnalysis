# Growatt endpoints found by the probe: bring them into the app

Status: first batch merged 15 Nov 2026 (PR #23); second batch built, its calls not yet made against Growatt.
Open checks are under each "Verify". Source: `backend/scripts/probe_growatt_endpoints.py` (read-only probe of the
`growatt-public-api` endpoint list, phases 1–3, 15 Nov 2026). `readPower` is already in (`power_limits` job).

## What each endpoint gives and where it goes

| Endpoint | Gives | Kind | Goes to |
|---|---|---|---|
| `plant/energy` | Growatt's daily kWh per plant, a date range per call | source-dated history | SQL `growatt_plant_energy_days` (finished days only), kept indefinitely |
| `device/inverter/day_energy` | Growatt's kWh of one inverter for one day | source-dated history | SQL `growatt_inverter_energy_days` (finished days only), kept indefinitely |
| `plant/power` | Growatt's own 5-min plant AC curve (288 points/day, W, plant-local) | source-timestamped history | SQL `growatt_plant_power` (finished days only), deleted with raw readings after `HISTORY_RETENTION_DAYS` |
| `plant/details` | static plant fields (51; mostly empty in this fleet) | registry | `growatt_plants`: `timezone`, `address`, `growatt_inverter_count`, `growatt_datalogger_count`, `details_synced_at` |
| `new-api/queryDeviceInfoParam` | model text ("MAX 80KTL3 LV"), datalogger model, nominal power | registry | `growatt_inverters`: `device_model`, `datalogger_model`, `rated_power_w`, `param_synced_at` |
| `device/max/maxs_data` | newest full record of ≤ 50 inverters per page | **realtime** | memory / Redis only (rule 1): `/growatt/live/inverters/snapshot` |

Today's partial values (today's kWh so far, today's curve) are realtime and are never stored: the jobs only
write days before today (plant-local).

## Jobs

- `growatt_energy` daily at **00:50** (after `alarms_yesterday` 00:30 and `rules_yesterday` 00:45): per account,
  per plant: `plant/energy` for the last `ENERGY_LOOKBACK_DAYS` (7) finished days (re-reads late uploads),
  `plant/power` for yesterday (skipped when stored), `day_energy` for each inverter for yesterday (skipped when
  stored). ≈ 234 + 234 + 629 calls a day over the accounts in parallel, `ENERGY_PAUSE_S` (1 s) apart.
- `energy_backfill` (not scheduled; queue once after deploy): `plant/energy` for the last 90 days of every plant
  (one call per plant per 31-day chunk).
- `fleet` (05:30) also reads `plant/details` (each plant every 7 days) and `queryDeviceInfoParam` (each
  inverter every 30 days), oldest first.

Rate limits of these endpoints are unknown (each was called once by the probe). Every sweep stops an account
after 3 × 10012 in a row (run `partial`); the next run starts where it stopped (missing / oldest first).

## Live fleet snapshot (`maxs_data`)

Measured 15 Nov 2026: ≈ 50 serials per page, about 4 calls per account, then 10012 until ≈ 5 min after the
first; it does **not** share `max_data`'s per-inverter window. So:

- Chunks of 50 serials per account (sorted, stable), one cache key per chunk, TTL `INVERTER_SNAPSHOT_TTL_S`
  (300), at most `INVERTER_SNAPSHOT_SWEEP_PER_REQUEST` (4) chunks refreshed per request, swept like
  `/live/sensors/status` (oldest first, `refresh_in_s` short until complete).
- Per inverter: record time (its own, plant-local), status, AC/DC power, today's kWh (null when the record is
  not from today), temperature, fault/warning codes, `lost` (true on all 629 inverters on 15 Nov, also those
  uploading that minute, so the UI ignores it and judges by record time). Old records (e.g. June 2025 from a
  silent inverter) are served with their own time, never as current.
- It does not replace `max_data` where several records are needed (live string check, chart tail).

## API

- `/growatt/plants/{id}/power`: `growatt_timeseries` (Growatt's stored plant curve) and per day
  `growatt_energy_kwh` / `growatt_inverters_kwh` next to the integrated `energy_kwh`.
- `/growatt/plants/{id}/inverters`, inverter card: `device_model`, `datalogger_model`, `rated_power_w`.
- `/growatt/plants/...` plant fields: `timezone`, `address`, `growatt_inverter_count`, `growatt_datalogger_count`.
- `GET /growatt/live/inverters/snapshot[?plant_id=]`: the snapshot above (engineers: their plants only).

## UI

- Production card (Plant Overview): Growatt's curve dashed over ours; "Growatt N kWh" under Energy for a
  finished day or a whole-day range (single day: `/power?records=false` next to the overview); a withheld
  glitch day says so.
- Plant directory: inverters per plant by newest snapshot record (online / fault / silent) in the
  Inverters column, fleet totals in the hero's Inverters tile, with the sweep's progress.
- Inverter card: model, datalogger model, rated power fallback.
- Not shown yet: `plant/details` fields; a per-day / per-inverter Growatt vs our kWh table.

## First real run (local, phase 1, 15 Nov 2026 14:21–14:34)

559 calls in 809 s (1 s apart), **no 10012 and no other error**: 43 plants × 7 `plant/energy` days, 83 of 86
curves (3 plant-days answered no points), 430 / 430 inverter days.

- `plant/energy` = sum of the plant's `day_energy` within 2 % on every plant-day (43 / 43 both days).
- The `plant/power` curve integrates lower than the daily figure (34 / 43 and 37 / 43 within 5 %, worst
  −25 %): Growatt's curve sums only the inverters uploaded in each slot. Use the daily figure for energy.
- Glitch: plant 10004563 (P1_29 อุบล-วาริน, 645.8 kWp) reports 46,027 kWh for 13 Nov (71 kWh/kWp), from two
  serials `BUFUEXB006` / `EPHNEYN00K` answering 22,259 kWh each; those two report identical figures every
  day (also identical `eac_today` in our stored records), i.e. one device listed twice. Stored as reported;
  the API withholds a day figure above `MAX_GROWATT_KWH_PER_KWP_DAY` (10) × kWp (`growatt_implausible`).

## Verify

- [x] tests (client parsing, sweeps skip stored days and stop on 10012, today never stored, snapshot chunks, `records=false`): 309 pass (15 Nov 2026)
- [x] frontend lint + build; `/power?records=false` checked on the local API (14 Nov: 288 points, 2,092 kWh; 13 Nov: withheld)
- [x] UI in a browser (local, 15 Nov): Growatt curve + "Growatt 2,092 kWh" on 14 Nov, "withheld" on 13 Nov; directory
      564 online · 4 fault · 56 silent (after dropping `lost`); inverter card falls back to `model` until `fleet` reads the param
- [x] local phase 1 run ok, no rate limit (above)
- [ ] after deploy: `growatt_energy` run ok on all accounts; stored `plant/energy` vs our integrated kWh within a few % on
      plants with full records
- [ ] snapshot sweep covers all 629 inverters within ≈ 5 min without blocking `/live/plants/{id}/latest`

## Second batch (15 Nov 2026): every other endpoint, merged into existing routes and jobs

Rule (owner, 15 Nov 2026): use every Growatt endpoint that answers data, but add **no new app route** for one;
fold it into a route or job that exists. `new-api/readPower` and `new-api/queryDeviceInfoParam` stay as they
were. The others below are new; all but the first two are **fallbacks**, asked only when the primary call fails
or left a gap. None of their rate limits was measured.

| Endpoint | Gives | Kind | Merged into |
|---|---|---|---|
| `device/datalogger/list` | each datalogger's model, `lost` flag, last upload time | **realtime** | `/growatt/live/plants/{id}/latest`: `data.dataloggers` (memory only, one call per plant); null + `data.dataloggers_error` when the call fails, never failing the inverters' part |
| `device/all/create_date` | when Growatt registered each device, several serials per call | registry | `fleet`: `growatt_inverters.growatt_created_at` (read once per inverter, 50 serials per call); API field `growatt_created_at` |
| `new-api/queryDeviceList` | the account's devices with `createDate`, 100 per page | registry | `fleet`: fills the creation date of inverters `create_date` left without one |
| `device/sn_datalog` | the datalogger of a serial | registry | `fleet`: fills `datalogger_sn` where `device/list` named none |
| `new-api/queryDeviceInfo` | the `max_data_info` fields (alias, rated power, firmware, settings block) | registry | `fleet` inverter info sweep: read through it once `max_data_info` answers 10012, so a run no longer stops at the first refusal |
| `new-api/queryDevicesHistoricalData` | one day's records of several inverters per call | source-timestamped history | `history`: `WORKER_HISTORY_BATCH_SIZE` inverters per call, `max_data` per inverter as fallback. **Off by default (0)** |
| `new-api/queryHistoricalData` | one day's records of one inverter | source-timestamped history | `history`: one more try for an inverter whose `max_data` call failed (`day_fallback`) |
| `device/max/max_last_data`, `new-api/queryLastData` | the newest record of one inverter | **realtime** | `/growatt/live/plants/{id}/latest`: the newest record when `max_data` refuses the inverter (`record_source` on the row) |

Not merged (nothing in the app lacks what they give): `plant/sn_plant`, `device/check/sn`, `user/c_user_list`.
Dropped from the probe script (15 Nov 2026, same answer on all three accounts probed): `readMaxParam` (error
10009), `new-api/getWiFiSignalByDevice` and `new-api/queryDfcData` (no data).

### History from the two `new-api` history endpoints: what is known and what is not

- Known (probe replies, phase 1, 15 Nov 11:30, one inverter): both give the same 70 records as `max_data` and,
  through `parse_max_records`, the same 952 string rows; inverter rows differ only by float32 noise in `pac`
  (275.7 vs 275.70001220703125).
- Not measured: rate limits, the largest serial list, whether a long day is cut short (the batch reply has no
  paging fields; the single one has `haveNext`, whose paging was not probed). A batch call returns the whole day
  so far: 1.85 MB for 3 inverters at 11:30.
- So an answer is stored only when proven complete: the inverter's newest stored record is from today and the
  answer reaches back to it. Only the 30-min overlap window is written. Anything else goes the old way.
- To turn batching on: set `WORKER_HISTORY_BATCH_SIZE` (start with 10) on the worker, run `history` once and
  read the run's `batch_calls` / `batch_inverters` / `batch_fallback` / `batch_errors`.

### Live fallback: what changes for the page

- A row with `record_source` other than `max_data` is the inverter's newest record only: no older records, so
  the live string check cannot confirm a fault over 6 records, and the chart tail gets one point.
- A refused `max_data` now costs up to two more Growatt calls for that inverter before its cooldown.

### UI

- Inverter card, Device and settings: "Datalogger now (live)" (Online / Offline, last upload) and "Added to Growatt".

### Verify

- [x] tests: client parsing of every endpoint above; `/latest` carries `dataloggers`, survives a refused
      datalogger call and falls back to the newest-record endpoints; creation-date and datalogger gaps filled;
      info sweep continues through `queryDeviceInfo`; batch and single-day history store only proven answers
- [x] frontend lint + build
- [ ] none of the new calls has been made against Growatt from this change: check each on the first real runs
      (`fleet` detail and logs, `history` `day_fallback`, a `/latest` row with `record_source` ≠ `max_data`)
- [ ] batch history: one measured `history` run with `WORKER_HISTORY_BATCH_SIZE=10` before leaving it on
