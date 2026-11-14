# Plan & Spec: Weather Station realtime updates

Status: **Draft** · Created 2026-11-13 · Owner: Chanthawat

Make the Weather Station (Growatt environmental sensor: POA irradiance, module/ambient temperature, humidity, wind) update in near realtime, the way inverter power already does, without breaking the "never store realtime values" rule.

---

## 1. Current state (checked in code, 2026-11-13)

| Piece | Today | Where |
|---|---|---|
| Live endpoint | `GET /growatt/live/plants/{id}/weather` → `env_last_data` per sensor, memory only, cached until the next 5-min record is due (`_latest_ttl`, `DEFAULT_INTERVAL_S` because `interval_s` is always null), never sooner than `GROWATT_LIVE_DEVICE_GAP_S` (270 s); night TTL up to 1800 s | `routes/growatt.py:144`, `services/growatt_live.py:382`, `_env_row` :522 |
| Stored history | `history` job every 30 min → `sync_env_incremental` → `growatt_env_readings` | `services/jobs.py:128`, `services/growatt_sync.py:352` |
| UI panel | `WeatherStationPanel` only on **Generation & PR** (moved off Plant Overview) | `pages/GenerationPrPage.tsx:283` |
| UI live polling | `useLivePoll` on the live endpoint **only** when: plant has a sensor, viewing **today**, and **no time window** | `WeatherStationPanel.tsx:112` |
| What updates live | The 4 KPI cards (irradiance now, module/ambient temp, humidity/wind) and a `LIVE hh:mm` badge | `WeatherStationPanel.tsx` |
| What does **not** update live | The irradiance/temperature chart, peak irradiance, insolation (kWh/m²), daylight averages, IEC PR: all DB, refreshed only when `data_until` changes after a `history` run (up to ~30 min + 5 min overview poll) | |
| Multiple sensors | Live cards use `sensors[0]` only; other sensors' live readings are dropped | `WeatherStationPanel.tsx:128` |
| Plant Overview | No live weather at all (only Google modelled rain slots tile) | `pages/OverviewPage.tsx:139` |

**User-visible problem:** the cards move every ~5 min, but the chart and day totals sit still for up to ~35 min, so the station looks frozen. On Plant Overview there is no measured weather at all.

## 2. Goals

1. The Weather Station chart and cards show a new reading within **≤ 6 min** of the sensor recording it (sensor interval 5 min + upload grace), while the page is open and visible.
2. Day KPIs (peak, insolation) stored in the DB lag by **≤ 15 min** instead of ≤ 35 min.
3. A compact live weather tile on **Plant Overview**.
4. Every sensor of a plant is shown, not just the first.
5. No extra writes of realtime values to SQL/Firestore; no extra Growatt rate-limit failures for inverters.

## 3. Non-goals

- Fleet-wide live weather (231 sensors × rate limits); the fleet list keeps DB values.
- Second-level updates: the sensor records every 5 min, so polling faster returns the same record.
- WebSocket/SSE: polling on `refresh_in_s` is enough with Cloud Run max 1 instance.
- Changing Google Weather (modelled) behaviour.

## 4. Rules that apply (from CLAUDE.md files)

- **Never store realtime values.** Live readings stay in backend memory and in React component state (tab memory, dropped on reload / plant change). Not in localStorage, SQL or Firestore.
- **History is allowed in SQL** because it is source-timestamped (`env_data` records). Syncing env history more often is fine.
- **Never invent numbers.** A field the sensor does not measure (`measured` set) stays `null` → "—". No interpolation of gaps; nulls are gaps in charts.
- **Freshness labels:** "Live · hh:mm" when fresh, "Last sync hh:mm" when stale or unavailable.
- **Rate limits:** `env_data` / `env_last_data` are limited per datalogger, and the datalogger also carries the inverters. Back off on 10012 like the other live calls.
- **SQL on SQLite and Postgres.** **Jobs only in the worker.**

## 5. Spec

### 5.1 Backend: faster env history (DB side)

New worker job **`env_history`**, separate from `history`:
- Runs every `WORKER_ENV_INTERVAL_MIN` (default **10**) between `WORKER_ENV_START_H` and `WORKER_ENV_END_H` (default 05–20, plant-local; irradiance is 0 at night). Outside the window `history` (30 min) still covers env, so night data is not lost.
- Body: `_per_phase(... sync_env_incremental ...)` only, no inverter calls. Reuses the existing upsert (idempotent), so overlapping with `history` is harmless.
- Rate limits: stops an account's sweep after 3 consecutive 10012s (same rule as `alarms`); the run becomes `partial`, not `failed`.
- Run log in `sync_runs` like every job; `POST /growatt/sync/env_history` works via `jobs.JOBS`.
- Expected load: ≤ 231 `env_data` GETs per run, about 6 runs/h in daytime.
- **Gate before enabling in prod:** measure 10012 rate on `env_data` and on inverter `max_data` for one day with the job on (compare `sync_runs.detail`). If inverter sync gets worse, raise the interval to 15 min.

### 5.2 Backend: live endpoint improvements

`GET /growatt/live/plants/{id}/weather` (still memory only):
- **Real `interval_s`:** keep the previous record's timestamp per sensor in the live cache (memory) and set `interval_s` from the gap, so `_latest_ttl` uses the sensor's actual interval instead of `DEFAULT_INTERVAL_S`. First call stays `None` → default.
- **`stored_until` per sensor:** newest stored `growatt_env_readings.timestamp` for that sensor (one indexed `MAX` query). Lets the UI know which live points are newer than the DB series.
- **`refresh_in_s`** stays the envelope field the UI polls on; unchanged contract.
- No new fields that are not measured; fields outside `measured` stay `null` (already done).

### 5.3 Frontend: Weather Station panel (`components/WeatherStationPanel.tsx`)

- **Live tail on the chart:** while viewing today with no time window, every live reading with `timestamp > stored_until` (and not already in the tail) is appended to an in-memory `liveTail` array (component state, max 24 points = 2 h). The chart draws `stored series + liveTail` as one line; tail points are real measurements, so same series and colour, no dashed style. Tail is cleared when the plant/day changes or when the DB series catches up (`data_until` changes → re-read, then drop tail points `≤` new last stored timestamp).
- **Re-read stored day** when `data_until` changes (already) **and** when any live `stored_until` is newer than the loaded series' last point (picks up `env_history` runs without waiting for the 5-min overview poll).
- **KPI cards:** keep live values for "now"; peak irradiance today = max(stored peak, tail values). Insolation stays DB-only (integrating live points would duplicate `_integrate_kwh` logic in the browser; it lags ≤ 10 min with §5.1).
- **All sensors:** a sensor selector (`Tabs` or `Select`) when `sensors.length > 1`; default the first. Cards, chart and badge follow the selected sensor.
- **Freshness badge:** `LIVE hh:mm` (ok) when fresh; `LIVE (STALE) hh:mm` (warn) when `stale`; `Last sync hh:mm` (neutral) when live is unavailable or not today. The time is the sensor's record time, not fetch time.
- Polling unchanged: `useLivePoll` on `refresh_in_s`, stops while `document.hidden`, error back-off 30/60/120 s.

### 5.4 Frontend: Plant Overview tile (`pages/OverviewPage.tsx`)

- New `WeatherNowTile` next to the existing `WeatherSlotsTile`, only when the plant has a sensor (`selectedPlantOverview.weather` present / `has_sensor`).
- Shows irradiance now (W/m², `Meter` max 1 100), module temp, ambient temp, record time badge. "—" for unmeasured fields. Click → Generation & PR page, scrolled to the Weather Station panel.
- Uses the same live endpoint and `useLivePoll`; one poll per open page (the panel and the tile are on different routes, so no double polling).
- Title tooltip: "Measured by the plant's Growatt weather sensor".

### 5.5 Config (`config.py`, `.env.example`, `CLAUDE.md`)

| Key | Default | Meaning |
|---|---|---|
| `WORKER_ENV_INTERVAL_MIN` | `10` | `env_history` interval; `0` disables the job |
| `WORKER_ENV_START_H` / `WORKER_ENV_END_H` | `5` / `20` | Daytime window (plant-local) |

## 6. Plan (phases)

1. **Frontend first (no backend risk):** all sensors, freshness badge, live tail using `timestamp > last stored point` from the loaded series, Overview tile. Delivers most of the visible "realtime" effect.
2. **Live endpoint:** real `interval_s`, `stored_until`.
3. **`env_history` job:** add, measure rate limits on dev with prod tokens for a day, then enable in prod.
4. **Docs & deploy.**

## 7. Checklist

### Phase 1: frontend
_Done 2026-11-13. Needed one small DB-only backend change: the stored day averaged all sensors, so `GET /growatt/plants/{id}/weather` gained `?sensor=SN:ADDR` (test: `test_weather_route_one_sensor_of_several`). Tail filtering uses the last stored slot until Phase 2 adds `stored_until`._
- [x] `WeatherStationPanel`: sensor selector when > 1 sensor; cards/chart/badge use the selected sensor
- [x] `liveTail` state (max 24 points), appended only for `timestamp >` last stored point, no duplicates
- [x] Chart spec merges stored series + tail; nulls stay gaps
- [x] Tail cleared on plant/day change and trimmed after a stored re-read
- [x] Peak irradiance card = max(stored peak, tail)
- [x] Badge: `LIVE` / `LIVE (STALE)` / `Last sync`, using sensor record time
- [x] Nothing written to localStorage/sessionStorage
- [x] `WeatherNowTile` on Plant Overview, only for plants with a sensor; links to the panel
- [x] `bun run lint` and `bun run build` pass

### Phase 2: live endpoint
_Done 2026-11-13. `stored_until` reads `growatt_env_sensors.history_synced_until`, which `sync_env` already sets to the stored `MAX(timestamp)` after each upsert, so no extra `MAX` query per request. The interval is measured from the record cached before (memory / Redis), so it survives a Cloud Run cold start when Redis is on; a gap outside 30–900 s (outage) keeps the interval already measured._
- [x] Per-sensor previous record time kept in the live cache → `interval_s`
- [x] `stored_until` per sensor (from `history_synced_until` = stored max; no raw SQL)
- [x] `GrowattLiveWeather` type in `api/client.ts` updated (`interval_s`, `stored_until`)
- [x] Frontend uses `stored_until` for tail filtering and the extra re-read (once per newer stored slot)
- [x] Tests (fake live client, no network): interval from two records; TTL uses it; `stored_until` matches seeded rows; unmeasured fields null; nothing written to SQL by the live route
- [x] `uv run pytest -q` passes (210)

### Phase 3: `env_history` job
_Code done 2026-11-13; trial and prod switch-on open. The worker runs jobs one after another, so a `history` start counts as an env sync (`Schedule.covered_by`): the two never both pull `env_data` in the same tick (otherwise every 30 min each sensor would be read twice). Sensors are swept never-synced / oldest-stored first with `retries=0`, so a sweep cut short by 10012 continues where it lags most and never sleeps 60–120 s per sensor._
- [x] `job_env_history` in `services/jobs.py`, registered in `JOBS`
- [x] Schedule in `worker.py` with interval + daytime window; `0` disables
- [x] 3 × 10012 ends an account's sweep; run `partial`
- [x] Settings keys from §5.5 in `config.py` and `.env.example`
- [x] Tests: job upserts env rows idempotently alongside `history`; window respected; disabled at 0; `history` start covers it; oldest-first + 10012 stop (`uv run pytest -q`: 214)
- [ ] Trial for one day, run on prod instead of dev (a dev worker with the prod tokens would read every sensor a second time and inflate 10012s): `ENV_INTERVAL_MIN=15` in `deploy/gcp.config`, set on the VM 2026-11-14 20:41 Bangkok, so the first full day is 15 Nov 05:00–20:00. Compare 10012 counts for `env_data` and inverter `max_data` (`app_logs` messages containing `10012`) with the job on vs off
  - Baseline, job off, 14 Nov 00:00–17:30 Bangkok: 8 × 10012, all in `history` (5 `env_data` on 2 sensors, 3 `max_data` on 2 inverters), each retried
  - Full day 14 Nov (job off): still 8, all in `history`. Count by `job`, not only by day: the 02:00 `backfill` also hits 10012 (4 × `max_data` on 15 Nov 02:30, its third start after two deploy restarts), and those are not `env_history`'s doing
- [ ] Decide interval (10 or 15 min) from the trial, then enable in prod

### Phase 4: docs & deploy
- [x] `backend/CLAUDE.md`: Worker table (`env_history`) (Weather sensors section: live `interval_s`, `stored_until` done in Phase 2)
- [x] `frontend/CLAUDE.md`: Weather Station live tail and Overview tile under "Growatt data in the UI"
- [x] `CLAUDE.md`: data-flow diagram (env history every 10 min, daytime) and Config keys
- [x] Deploy backend + worker (VM) and frontend (2026-11-14, `deploy/gcp.sh all`, revision `tcroof-api-00024-pl7`)
- [ ] Verify on prod: open a plant with a sensor at midday; a new point appears on the chart within 6 min; badge shows the sensor time; DB series catches up within 15 min

## 8. Acceptance criteria

- During daylight, with the Generation & PR page open, the Weather Station chart gains a new point within 6 min of each sensor record, without a page reload.
- Stored peak / insolation for today lag the sensor by ≤ 15 min (with `env_history` on).
- Plant Overview shows a live irradiance/temperature tile for plants with a sensor, and nothing for plants without one.
- A plant with 2 sensors can switch between them.
- No live weather values appear in SQL, Firestore, localStorage or sessionStorage.
- Inverter `history` sync shows no increase in 10012 failures after `env_history` is enabled.

## 9. Risks

| Risk | Mitigation |
|---|---|
| `env_history` eats the per-datalogger rate limit that inverters need | One-day trial gate; 3 × 10012 stops the sweep; interval configurable / 0 = off |
| Live tail and stored series disagree (Growatt revises a record) | Tail is dropped as soon as the stored series covers that time; DB wins |
| Night: no irradiance, live TTL 30 min | Expected; badge shows the record time, window stops `env_history` at night |
| Sensor clock / `timeText` vs `calendar` hour offset | Use `timeText` (plant-local) only, as today |

## 10. Open questions

1. Should the Weather Station panel move back onto Plant Overview in full, or is the compact tile enough?
2. 10-minute env history: acceptable for cost/rate limits, or start at 15?
3. Show a live weather column in the Fleet list later (DB `stored_until`-based, not live)?
