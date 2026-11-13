# Plan & Spec: Sensors page with a Status tab (realtime)

Status: **Agreed** · Created 2026-11-13 · Decisions 2026-11-13 (§11) · Owner: Chanthawat
Related: [`weather-station-realtime.md`](weather-station-realtime.md) (live tail, `env_history` job)

Add a **Sensors** page whose **Status** tab lists every Growatt weather sensor the user can see, with its online state, last upload, newest reading and health flags, kept current in near realtime. Clicking a sensor opens an **Info** view with everything known about it.

---

## 1. Current state (checked in code, 2026-11-13)

| Piece | Today | Where |
|---|---|---|
| Sensor registry | `growatt_env_sensors`: `(datalogger_sn, address)`, `plant_id`, `device_name`, `history_synced_until`, `synced_at`. Filled by the `fleet` job from `device/list` (type 3, `device_sn` "env") + `device/env/env_list`. | `db/models.py:384`, `services/growatt_sync.py:248` |
| Online state | `env_list` returns `lost` and `lastUpdateTime` per sensor, but they are **realtime and deliberately not stored**. Nothing serves them today. | `solar_core/growatt.py:184`, comment `growatt_sync.py:275` |
| Stored readings | `growatt_env_readings` 5-min (irradiance, ambient/module temp, humidity, wind speed/dir), synced by `history` every 30 min | `db/models.py:402` |
| Newest reading | `GET /growatt/live/plants/{id}/weather` → `env_last_data` per sensor of **one plant**, memory only | `routes/growatt.py:144`, `growatt_live.py:382` |
| Measured probes | `wx.measured_fields(db, plant_id, since)`: a field that read 0 all day is "not fitted" → null | `services/growatt_weather.py` |
| UI | Only the per-plant `WeatherStationPanel` (Generation & PR). **No page or tab lists all sensors.** | |

## 2. Goals

1. One place to see the state of all ~231 sensors (engineers: only their assigned plants).
2. Online / late / offline / lost status that stays current without a page reload.
3. Per-sensor info: identity, plant, datalogger, address, last upload, newest reading, probes fitted, stored-data coverage, health flags, link to the plant's Weather Station.
4. Stay inside Growatt rate limits and keep the "never store realtime values" rule.

## 3. Non-goals

- Storing online state or live readings anywhere (SQL, Firestore, localStorage).
- Editing sensor settings on Growatt (no write API used).
- Push notifications (email / LINE). Offline sensors **are** shown on the Active Alarm page (§6.4).
- Sensor calibration checks against modelled irradiance (later; needs clear-sky model per plant).

## 4. Where it lives in the UI

- New fleet-wide page **`/sensors`** → nav label **"Weather Sensors"** in the **Monitoring** group (`components/Layout.tsx`), icon `Gauge`, description "Every weather sensor: status, last upload & newest reading". Visible to admins and engineers (filtered by plant).
- Page tabs (shadcn `Tabs`, value kept in the URL query `?tab=`, per commit `5695c1a` "Keep each page's choices in the URL query"):
  - **Status** (default): fleet table, §6.2.
  - **Info**: one sensor's full detail, §6.3 (`?tab=info&sensor=<datalogger_sn>:<address>`). Also reachable as a side sheet from a Status row.
- On the per-plant Weather Station panel, a "Sensor status" link opens `/sensors?tab=info&sensor=…`.

## 5. Backend spec

### 5.1 Status sources and rules

| Field | Source | Stored? |
|---|---|---|
| Identity, plant, name, address | `growatt_env_sensors` + `growatt_plants` | yes (registry) |
| `lost`, `last_update_time` | `env_list` per datalogger, **live** | **no**, memory only |
| Newest reading (6 fields + record time) | `env_last_data` per sensor, **live**, only for sensors being viewed | **no**, memory only |
| Last stored reading, coverage today | `growatt_env_readings` (`MAX(timestamp)`, count of today's 5-min slots) | yes (history) |
| Probes fitted | `measured_fields` over the last 7 days | derived from history |

Derived `status` (computed on the backend, one place):

| Status | Rule |
|---|---|
| `online` | `lost = false` and last upload ≤ 15 min ago |
| `late` | `lost = false` and last upload 15–60 min ago |
| `offline` | `lost = true`, or last upload > 60 min ago |
| `unknown` | live state not fetched yet in this sweep (shows last stored reading time instead) |
| `not_synced` | registered but no stored reading yet |

Thresholds from settings (`SENSOR_LATE_MIN` = 15, `SENSOR_OFFLINE_MIN` = 60). "Last upload" = `lastUpdateTime` (plant-local) when live is known, else the last stored reading time, labelled "Last sync".

Health **flags** (checks, not measurements; each with a reason text):
- `probe_missing`: a field that was measured in the last 7 days reads 0 all of today's daylight (probe fault or disconnected).
- `irradiance_zero_daylight`: irradiance 0 for ≥ 1 h between 10:00 and 15:00 while the plant's inverters produced power (stored data).
- `stale_history`: `history_synced_until` older than 2 h while `online` (sync problem, not sensor problem).
No flag is shown without data to support it; "—" otherwise.

### 5.2 Fleet live status without overloading Growatt

`env_list` is one call per **datalogger** (~231), limited per datalogger, and the API (Cloud Run) must not run background sweeps. So the sweep is **incremental, driven by polling**:

- `GrowattLiveService.sensor_status(dataloggers, phase_of)` keeps an in-memory map `datalogger → (fetched_at, [{address, lost, last_update_time}])`.
- Each request refreshes at most `SENSOR_SWEEP_PER_REQUEST` (default **12**) dataloggers whose entry is older than `SENSOR_STATUS_TTL_S` (default **300 s**), oldest first, in parallel (`LIVE_WORKERS`), each with the usual per-key lock, cooldown on error and 10012 back-off. The rest is served from memory (or `unknown`).
- The response carries `sweep: {fresh, total, oldest_age_s}` and `refresh_in_s`: **15 s** while some dataloggers are not fresh yet, else the time until the oldest entry expires. The UI's `useLivePoll` therefore converges on the whole fleet in about 231 / 12 × 15 s ≈ 5 min, then refreshes each datalogger about every 5 min.
- Engineers' requests sweep only their plants' dataloggers. The cache is fleet-wide (shared), like the live plants cache.
- Night mode: outside daylight (existing `_night`) entries live up to `GROWATT_LIVE_NIGHT_TTL_S`.
- Budget check: daytime ≈ 231 calls / 5 min ≈ 2 800 calls/h **only while someone has the page open**. If 10012s rise on inverter `max_data`, raise `SENSOR_STATUS_TTL_S` to 600.

Newest readings (`env_last_data`) are **not** swept fleet-wide: they are fetched for the sensor open in Info, and for up to `SENSOR_READING_ROWS` (default 0 = off) rows on the Status table. The Status table shows the **last stored reading** (≤ 30 min old, ≤ 10 min with `env_history`) labelled "Last sync".

### 5.3 Endpoints

All read-only, `require_plant_read` / `allowed_plant_ids` filtering, mounted at `/api` and `/`.

**`GET /growatt/sensors`** (DB only, `meta.source = "db"`): registry + stored facts for every visible sensor.
```json
{"meta": {"source": "db"},
 "sensors": [{"key": "DL123:1", "datalogger_sn": "DL123", "address": 1, "device_name": "env",
              "plant_id": 42, "plant_name": "…", "phase": 2,
              "last_reading_at": "2026-11-13 09:15:00", "history_synced_until": "…",
              "coverage_today_pct": 96.0, "measured": ["irradiance_wm2", "module_temp_c"],
              "last": {"irradiance_wm2": 612.0, "module_temp_c": 41.2, "ambient_temp_c": null, …},
              "flags": [{"code": "probe_missing", "field": "ambient_temp_c", "reason": "…"}]}]}
```

**`GET /growatt/live/sensors/status`** (memory only): live `lost` / `last_update_time` per visible sensor + derived `status`, envelope with `stale`, `fetched_at`, `refresh_in_s`, plus `sweep`. Never writes SQL.

**`GET /growatt/live/sensors/{datalogger_sn}/{address}`** (memory only): one sensor's live state + newest `env_last_data` record. Fields not in `measured` → null. Includes `raw` = the record's other fields **as reported**, for the Info tab's "Raw record" section (admin only; engineers get `raw: null`).
404 when the sensor is not registered or its plant is not visible.

### 5.4 Config

| Key | Default |
|---|---|
| `SENSOR_STATUS_TTL_S` | `300` |
| `SENSOR_SWEEP_PER_REQUEST` | `12` |
| `SENSOR_LATE_MIN` / `SENSOR_OFFLINE_MIN` | `15` / `60` |
| `SENSOR_READING_ROWS` | `0` |
| `SENSOR_ALARM_COVERAGE_PCT` | `80` |

## 6. Frontend spec

### 6.1 Client and state
- `api.listSensors()`, `api.getLiveSensorStatus()`, `api.getLiveSensor(dl, addr)` in `src/api/client.ts`, with types `SensorRow`, `SensorLiveStatus`, `SensorLive`.
- Page-local state (no new context): DB list loaded once and re-read every 5 min; live status via `useLivePoll` on `refresh_in_s`; overlay live onto DB rows by `key` (same pattern as the fleet list). Polling stops while `document.hidden`. Nothing written to storage.

### 6.2 Status tab
- **KPI tiles** (`KpiTile`): Online · Late · Offline · Unknown/not synced · Flags, counts over visible sensors. Sweep progress "Status checked for 180 / 231 sensors" until complete.
- **Filters** (in URL): status, phase, plant search, "flags only".
- **Table** (`Table`, `table-wrap`), sortable:
  `Status` (`Led` + `Badge`: ok/warn/crit/neutral) · Plant · Sensor (`DL#addr`, name) · Last upload (relative + time; "Last sync" label when from DB) · Irradiance · Module temp · Ambient temp · Humidity · Wind · Coverage today · Flags (chips with tooltip reason).
  Unmeasured fields "—"; values from DB carry the stored time in the tooltip.
- Freshness header: "Live · hh:mm" when the sweep is fresh, "Last sync hh:mm" when stale.
- Row click → Info sheet; plant name → `/plant/:id/generation#weather`.
- Empty states: no sensors visible; engineer with no plants.

### 6.3 Info tab / sheet
- **Identity:** plant (link), phase, datalogger SN, bus address, device name, registered/updated time.
- **Live state:** status badge, `lost`, last upload (plant-local), next refresh countdown.
- **Newest reading** (live, polls on `refresh_in_s`): irradiance (`Meter` max 1 100), module/ambient temp, humidity, wind speed + compass direction, record time. Probes not fitted shown as "Not fitted" instead of a number.
- **Stored data:** last stored reading, `history_synced_until`, coverage today, mini chart of today's irradiance (reuse `PanelChart`, stored series, nulls as gaps).
- **Health flags** with reasons.
- **Raw record** (admin only, collapsed): every field from `env_last_data` as reported, with a note that fields outside the kept six are always 0 at these plants.

### 6.4 Active Alarm page: offline sensors

Decision 2 (§11): offline sensors also appear on **Active Alarm** (`pages/ActiveAlarmPage.tsx`).

- Sensor online state is live and never stored, so it **is not mixed into the Growatt alarm log** (that log is SQL history with Growatt's own start/end times, and the CSV export stays Growatt alarms only).
- New panel **"Weather sensors"** on Active Alarm, under the KPI row:
  - **Today:** sensors with status `offline` or `late`, plus sensors with a health flag (§5.1), from `GET /growatt/live/sensors/status` overlaid on `GET /growatt/sensors`. Columns: status, plant (link), sensor `DL#addr`, last upload, flags. Sorted offline → late → flags, then longest silent first. Polled with `useLivePoll` like the Sensors page (shares the same backend sweep, so opening both pages does not double Growatt calls).
  - **Past day** (`?day=` before today): online state does not exist for past days. The panel instead lists sensors whose **stored** daylight coverage (06:00–18:00 5-min slots) was below `SENSOR_ALARM_COVERAGE_PCT` (default 80) that day, titled "Data gaps (stored readings)". This is history, not a live state.
  - While the sweep is incomplete: "Status checked for N / M sensors"; unchecked sensors are not listed as offline.
- KPI tile "Sensors offline" (count) next to the existing alarm tiles; click scrolls to the panel.
- Plant filter on Active Alarm also filters this panel; engineers see only assigned plants.
- Sidebar: the Active Alarm nav badge stays Growatt alarms only (no extra polling from the Layout).
- Link "All sensors" → `/sensors?status=offline`.

Backend: `GET /growatt/sensors?day=` gains `coverage_pct` for a past `day` (DB only) so the past-day list needs no new endpoint.

### 6.5 Access
- `/sensors` not in `ADMIN_ONLY_PATHS`; data filtered by the backend. Raw record hidden for engineers.

## 7. Plan (phases)

1. **DB endpoint + Status tab from stored data** (useful at once, zero extra Growatt calls).
2. **Live fleet status** (incremental sweep) overlaid on the table.
3. **Info tab** with live newest reading and raw record.
4. **Health flags.**
5. **Active Alarm: offline sensors panel** (after Phase 2 and 4).
6. **Docs & deploy.**

## 8. Checklist

### Phase 1: DB list + Status tab
_Done 2026-11-13. Deviations: `last_reading_at` is the sensor's `history_synced_until` (the sync sets it to the stored max) and the last reading is an exact key join, not a `MAX` group-by over 90 days. Coverage today counts slots 06:00 → start of the last finished `history`/`backfill` run (`meta.coverage_window`), so slots not fetched yet are not gaps. KPI tiles are Sensors / Stored today / Data gaps (< 80 %) / Not synced until Phase 2 can count online/late/offline (showing 0 online would be false). The Info tab shows the stored facts; Phase 3 adds live._
- [x] `services/growatt_sensors.py`: `list_sensors(db, allowed_plant_ids)` with last reading, coverage today, `measured` (SQLAlchemy only; `growatt_weather.measured_by_sensor` shared with `measured_fields`)
- [x] `GET /growatt/sensors` in `routes/growatt.py`, filtered by `allowed_plant_ids`
- [x] Types + `api.listSensors()` in `api/client.ts`
- [x] `pages/SensorsPage.tsx` with `Tabs` (`status`, `info`), tab in URL query
- [x] Route `sensors` in `App.tsx`; nav item "Weather Sensors" in Monitoring
- [x] Status table + KPI tiles from DB with "Last sync" labels; status `unknown` until Phase 2
- [x] Tests: engineer sees only assigned plants' sensors; `not_synced` sensor; coverage on mixed intervals; SQLite-safe
- [x] `uv run pytest -q`, `bun run lint`, `bun run build` pass

### Phase 2: live fleet status
_Built 2026-11-13 (dev trial pending). Deviations: status is judged in `growatt_sensors.overlay_live_status` at request time (a cached entry still ages into late / offline); a sensor its datalogger's `env_list` no longer lists is `unknown` with `listed: false`. `sweep` also carries `checked` (dataloggers fetched at least once). Envelope `stale` only when an expired entry's refresh failed (cooldown), not while the sweep is in progress. `SENSOR_READING_ROWS` / `SENSOR_ALARM_COVERAGE_PCT` wait for the phases that use them. Checked against real Growatt: `lastUpdateTime` = "YYYY-MM-DD HH:MM:SS" in **China time (UTC+8)**, one hour ahead of the same upload's `timeText` (found and fixed in Phase 3, 2026-11-13; it had made every upload look 60 min newer), `lost` = "0"/"1"; 12 dataloggers per request in ≈ 2.3 s._
- [x] `GrowattLiveService.sensor_status()` with per-datalogger cache, `SENSOR_SWEEP_PER_REQUEST`, TTL, cooldown, night TTL
- [x] Derived `status` function shared by API responses (thresholds from settings)
- [x] `GET /growatt/live/sensors/status` with `sweep` and `refresh_in_s` (15 s while sweeping)
- [x] Config keys (§5.4) in `config.py` and `.env.example`
- [x] Frontend: `useLivePoll` overlay, sweep progress, Live / Last sync freshness
- [x] Tests (fake client, no network): sweep refreshes at most N per request, oldest first; 10012 → cooldown, others served; engineer sweep limited to own dataloggers; nothing written to SQL
- [ ] One-day dev trial: 10012 counts on inverter `max_data` with the page open vs closed

### Phase 3: Info tab
_Done 2026-11-13. Deviations: a Status row opens the Info tab (no side sheet: the app has no sheet component and the tab keeps the URL shareable). The endpoint reuses both existing caches (`env_list` sweep entry, `env_last_data` per sensor), so opening Info while the plant's Weather Station is open costs no extra calls; a failed part is reported in `data.errors` and only both failing gives 503. `raw` keeps scalar fields only. Checked against real Growatt (admin 200 with raw, engineer 404 for an unassigned plant)._
- [x] `GET /growatt/live/sensors/{dl}/{addr}` (newest reading, measured nulls, `raw` admin only)
- [x] Info view: identity, live state + next-refresh countdown, newest reading (irradiance meter, wind compass), stored data + today's chart, raw record (collapsed)
- [x] Opened from a Status row and via `?tab=info&sensor=`; "Sensor status" link from `WeatherStationPanel`
- [x] Tests: 404 for invisible / unregistered sensor (no Growatt call); engineer gets `raw: null`; unmeasured → null; reading failure still serves status; `lastUpdateTime` China-time conversion

### Phase 4: health flags
_Done 2026-11-13. Deviations: `probe_missing` checks irradiance, module/ambient temperature and humidity only. Wind is left out because a calm day reads 0 m/s (and direction 0 = north). It also needs readings in ≥ 24 slots (2 h) between 09:00 and 15:00, otherwise there is no judgement, and an all-day-zero irradiance gives `probe_missing` only, not `irradiance_zero_daylight` too. `irradiance_zero_daylight` counts 5-min slots in total (≥ 12, not necessarily in a row) in which irradiance read 0 and a stored inverter reading of the plant had `pac_w > 0`; inverter readings are read only for plants with a candidate sensor. `stale_history` is computed in the live overlay (`live_row`, also on the Info endpoint) as last upload − `history_synced_until` > 2 h while `online`; nothing stored = no flag (status `not_synced` says it). The DB list's daylight query now serves both coverage and the flags (one query; 0.30 s for 234 sensors on the dev DB). The frontend merges DB and live flags. First real hit on the dev DB: DYDDG1X04V#4 ambient + humidity read 0 all of 2026-11-12 after 30.6 °C / 93 % the day before._
- [x] `probe_missing`, `irradiance_zero_daylight`, `stale_history` in `growatt_sensors.py`, each with reason text
- [x] Flag chips + "flags only" filter (Flags column, "Health flags" tile, `?status=flags`; flag list with reasons on Info and the plant Sensors tab)
- [x] Tests for each flag, including no flag when data is missing

### Phase 5: Active Alarm
- [ ] `GET /growatt/sensors?day=` returns `coverage_pct` for that day (DB only); `SENSOR_ALARM_COVERAGE_PCT` in config + `.env.example`
- [ ] "Weather sensors" panel on `ActiveAlarmPage.tsx`: today = live offline/late/flagged; past day = stored data gaps
- [ ] "Sensors offline" KPI tile; plant filter applies; link to `/sensors?status=offline`
- [ ] Growatt alarm log and CSV export unchanged (no sensor rows)
- [ ] Unchecked sensors (sweep incomplete) never listed as offline
- [ ] Tests: past-day coverage per sensor on mixed intervals; engineer filter
- [ ] `bun run lint` and `bun run build` pass

### Phase 6: docs & deploy
- [ ] `backend/CLAUDE.md`: Growatt data rules table rows for the 3 endpoints; weather-sensor section (live sweep, status rules)
- [ ] `frontend/CLAUDE.md`: route list + Sensors page notes; Active Alarm sensors panel (live today, stored gaps for past days)
- [ ] `CLAUDE.md`: data-flow diagram line for sensor status (live, memory only); Config keys
- [ ] Deploy backend, frontend; verify sweep completes in ≈ 5 min on prod and counts match Growatt's portal for a sample of plants

## 9. Acceptance criteria

- The Status tab lists every registered sensor the user may see, with a status for each within ~5 min of opening the page, and keeps them current without reload while visible.
- A sensor that stops uploading turns `late` within 15 min and `offline` within 60 min of its last upload (plus up to one TTL).
- The Info view shows the newest reading within one sensor interval (≈ 5 min) of Growatt receiving it.
- Engineers never see sensors of unassigned plants; the raw record is admin only.
- No sensor online state or live reading is written to SQL, Firestore or browser storage.
- With the page open all day, inverter `history` sync shows no rise in 10012 failures.
- Active Alarm (today) lists every `offline` / `late` sensor the sweep has checked; for a past day it lists sensors with stored daylight coverage below 80 %. The Growatt alarm log and its CSV contain no sensor rows.

## 10. Risks

| Risk | Mitigation |
|---|---|
| `env_list` sweep competes with inverter calls on the same datalogger | Per-request cap, 5-min TTL, cooldown on 10012, sweep only while the page is open, one-day trial |
| Two users / dev + prod share tokens and both sweep | Shared in-process cache per instance; prod max 1 instance; keep dev TTL longer |
| `lastUpdateTime` timezone confusion | Treat as plant-local like `timeText`; test with a fixture |
| Flags look like measurements | Labelled as checks with reasons; never shown without supporting data |

## 11. Decisions (2026-11-13)

1. **Nav placement:** "Weather Sensors" in the **Monitoring** group, as in §4.
2. **Active Alarm:** yes, offline sensors are shown there (§6.4).
3. **Table readings:** the Status table shows the **last stored reading**; a fresh live reading is fetched only for the sensor open in Info (`SENSOR_READING_ROWS` = 0).
