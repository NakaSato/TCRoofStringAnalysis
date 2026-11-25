# Plan: Devices page (every inverter in one table, other devices by tab, device checks)

Status: **Built 2026-11-25** (phases 1–3, without the live datalogger sweep; see §8) · Owner: Chanthawat

## 1. Goal

One fleet page, **Devices** at `/devices`, where the O&M team finds any device without opening each plant:

- **Inverters**: all 629 MAX inverters in one table (registry, settings, stored freshness, today's stored yield, issues and alarms), with the live state from the existing fleet snapshot overlaid.
- **Weather sensors**, **Meters**, and **Dataloggers**, each on its own tab.
- **Checks**: a computed list of device problems, each with the reason it fired and a link to where it gets fixed.

## 2. State today (checked in code, 2026-11-25)

| Need | What exists | Gap |
|---|---|---|
| Inverter registry | `growatt_inverters`: alias, model, `device_model`, rated / nominal W, firmware, datalogger SN / model, settings (`active_limit_pct`, `on_off`), `growatt_created_at`, `history_synced_until`, `not_installed_*` | Read only per plant (`/growatt/plants/{id}/inverters`). There is no fleet list. |
| Inverter live state, fleet-wide | `GET /growatt/live/inverters/snapshot` (`maxs_data`, 50 per call, swept, memory only, scoped). Used by the plant directory. | None. The page reuses it. |
| Weather sensors | `/sensors` page (`SensorsView`): `/growatt/sensors` (DB) + `/growatt/live/sensors/status` (sweep), health flags | Only the page's location changes. |
| Meters | `growatt_meters` (one grid-point meter per plant), `growatt_meter_readings`, `history_synced_until` | No fleet list. Live data (`meter_last_data`) is per meter, and a call within a few minutes is refused (10012). |
| Dataloggers | No table. The serial is on `growatt_inverters.datalogger_sn` and on the sensor / meter keys. The model comes from `queryDeviceInfoParam`. `growatt_plants.growatt_datalogger_count`. Live: `device/datalogger/list` per plant (`plant_dataloggers`, cached, used only by `/latest`). Site register: logger SN per station. | No list and no fleet live state. |
| Site register devices | `site_devices` (data logger, weather station, revenue meters, router, PQM, ShineMaster: brand, SN, IP, SIM, status, warranty); `checks` computed per station | Shown only per plant (Documents tab card). |

## 3. Rules that shape this

- **Live values stay in memory.** The live columns come from the existing `/growatt/live/*` sweeps, and nothing new is written to SQL or Firestore. The page shows each record's own time (`record_time`), because a silent inverter's snapshot record can be months old.
- **Inverters marked not installed** are left out of every count and check (`inverter_installed()`). The Inverters tab still shows them behind a "Show not installed" filter, greyed, with who marked them and the note.
- **Scope:** engineers see only their assigned plants (`allowed_plant_ids`). There are no fleet totals for engineers beyond their own plants, the same as other fleet pages.
- **No new Growatt route** (the growatt-new-endpoints rule). A fleet datalogger sweep reuses `device/datalogger/list` inside an existing live service (§5.4).
- **Never invent numbers.** A value Growatt never gave is "—". A setting block Growatt answered as 0 is already stored as null.

## 4. The page

Route `/devices`, with the tab in the URL: `?tab=inverters|sensors|meters|dataloggers|checks` (default `inverters`). Filters are in the URL too: `q`, `phase`, `province`, `plant`, `status`, `model`. A sidebar item **Devices** replaces **Weather Sensors**, and `/sensors` redirects to `/devices?tab=sensors` so existing links keep working. The plant tabs (Inverters, Plant Sensors) stay as they are.

A header strip of `StatTile`s: inverters (installed), live Normal / Waiting / Fault / Offline / Not checked, sensors online / offline, open device checks.

### 4.1 Inverters tab

One row per inverter. Columns:
- **Identity:** plant (link), phase, province (site register, Growatt `city` as fallback), INV label (`daily_checks.inverter_label`), alias, serial, `device_model`, rated kW, firmware, datalogger SN.
- **Now (live, snapshot):** status LED, AC kW, today kWh, temperature, record time (the "stale" style when it is not from today).
- **Stored:** last stored record (`history_synced_until`, age), today's stored yield, % of the plant's inverter average.
- **Settings:** power limit % (marked as configured, with its source `read_power` / `max_data_info`), on / off.
- **Work:** open issues (count, highest tier), alarms today (count, open ones).

Filters: status (Normal now / Not producing / Fault / Offline / Not checked), model, firmware, "limit < 100 %", "with issues", "show not installed". Sortable columns, client-side search, and CSV export in the browser. A row opens `/plant/:id/inverters?sn=`. 629 rows render with a virtualized table body (or pages of 100 if virtualization is not already in the project).

### 4.2 Weather sensors tab

`SensorsView` moved as it is: the same status sweep and the same Info view. No backend change.

### 4.3 Meters tab

One row per registered meter: plant, datalogger SN, address, device name / type, last stored record and its age, today's stored import / export kWh (`growatt_meter.day_energy`, measured), and the record count today against the slots expected. There is no live column: a fleet sweep of `meter_last_data` would be one call per meter (234) against a per-meter window. The plant page keeps the live meter. A row opens the plant overview.

### 4.4 Dataloggers tab

One row per datalogger serial, built from the inverters, sensors and meters that name it: plant, serial, model, devices behind it (inverters / sensors / meters), the site register's logger SN and whether it matches, and Growatt's datalogger count for the plant. Live (Phase 2): Growatt's `lost` flag and last upload, from a sweep of `device/datalogger/list` per plant (§5.4).

### 4.5 Checks tab

A computed list, never stored, where every check carries `code`, `severity` (warn / info), the device, a `reason` with the values behind it, and a link to the fix. Grouped by check, then by plant. Proposed first set:

| Code | Fires when | Source |
|---|---|---|
| `inverter_never_reported` | Installed, but `history_synced_until` is null since `growatt_created_at` + 3 days | DB. Fix: mark not installed, or check on site. |
| `inverter_silent` | Daylight, and its newest stored record is more than 2 h behind the plant's other inverters | DB |
| `inverter_switched_off` / `inverter_limited` | `on_off = 0` / active limit < 100 % | DB (configured values) |
| `nameplate_missing` | `nominal_power_w` and `rated_power_w` both null (breaks `rated_ac_kw` and clipping gates) | DB |
| `info_not_read` | `info_synced_at` / `param_synced_at` older than 3 × their refresh | DB |
| `firmware_minority` | Firmware differs from what most inverters of the same `device_model` run (info); a masked version (`xx1.0`, not read by Growatt) is neither counted nor judged | DB |
| `no_string_layout` | One check per plant whose installed inverters lack String Layout rows, naming them (voltage per module and per-kWp peers stay off) | DB |
| `inverter_count_mismatch` | `growatt_inverter_count` (Growatt's entered count) matches neither the installed count nor the registry total (not installed included) | DB |
| `logger_sn_mismatch` | Site register logger SN ≠ Growatt's (the register's existing check, listed fleet-wide) | DB |
| `no_meter` / `meter_silent` | Plant without a registered meter / newest stored meter record more than 2 h old in daylight | DB |
| `sensor_*` | The existing sensor flags (`probe_missing`, `irradiance_zero_daylight`, `stale_history`) | DB + live overlay |
| `datalogger_lost` | Growatt's `lost` flag on a datalogger (Phase 2) | live |

Thresholds go in one `DEVICE_CHECKS` dict, overridable through `app_settings` like `decision_rules`. Checks are separate from issues: they do not open `growatt_issues`.

## 5. Backend

New module `services/devices.py` and router `api/routes/growatt/devices.py`, DB only, scoped by `allowed_plant_ids`, with `meta.source = "db"`:

1. `GET /growatt/devices/inverters?include_not_installed=`: one query joining plants, inverters, the site register (province / code), today's `growatt_inverter_daily` row (stored yield), active issue counts per serial, and today's alarm counts per serial. Reuse `inverter_out` for the registry and settings fields.
2. `GET /growatt/devices/meters`: meters with their stored freshness and today's import / export.
3. `GET /growatt/devices/dataloggers`: serials grouped from the three registry tables, plus the site register.
4. `GET /growatt/devices/checks`: the §4.5 list with `summary` (count per code / severity).
5. **Phase 2, live dataloggers:** a `datalogger_status` sweep in `GrowattLiveService` that reuses the `("dataloggers", phase, plant_id)` cache of `plant_dataloggers` and is swept like `plant_today` (N plants per request, oldest first, `refresh_in_s` = 15 until complete), served as `data.dataloggers` on the existing `/growatt/live/sensors/status`. Alternatively it gets its own `/growatt/live/dataloggers/status`; decide in §7.

Tests: scoping (an engineer sees only assigned plants), not-installed handling (left out of counts and checks, listed only with the flag), null handling (no stored record → "—", never 0), and each check's fire / no-fire boundary.

## 6. Phases

| Phase | Scope | Size |
|---|---|---|
| 1 | `/devices` shell with tabs, Inverters tab (DB endpoint + snapshot overlay, filters, CSV), Weather sensors tab moved, `/sensors` redirect, nav, tests | 3–4 days |
| 2 | Meters and Dataloggers tabs; live datalogger sweep | 2–3 days |
| 3 | Checks tab and endpoint, thresholds in settings, check count in the header and nav badge | 2–3 days |
| Later | AI Assistant tool over `/devices/checks`, site-register devices (router, PQM, ShineMaster) as their own tab, a weekly push of new checks | not planned |

Update `backend/CLAUDE.md` and `frontend/CLAUDE.md` in each phase.

## 7. Open questions for the owner

1. **"Devices checking":** the automated checks of §4.5 (proposed), or also a field checklist where an engineer ticks devices inspected on a visit (it would need a table and could log a `pm_inspection` site event)?
2. **Replace Weather Sensors in the nav** with Devices (proposed), or keep both?
3. **Live datalogger sweep:** about 234 extra `device/datalogger/list` calls per 5 min while the tab is open. Acceptable, or show the live state only on the plant page?
4. **Site register devices** (router, PQM, ShineMaster, revenue meters 1–8): a tab of their own in Phase 2, or leave them on the plant's Documents card?

## 8. As built (2026-11-25)

Owner answers to §7: 1 = automated checks of §4.5 only; 2 = Devices replaces Weather Sensors in the nav; 3 = no live datalogger sweep (deferred); 4 = site register devices stay on the Documents card.

Built:
- Backend, DB only, scoped by `allowed_plant_ids`, shapes = `frontend/src/api/types/devices.ts`: `GET /growatt/devices/inverters?include_not_installed=` · `/meters` · `/dataloggers` (`services/devices.py`) and `/checks` (`services/device_checks.py`), routes in `api/routes/growatt/devices.py`. Tests `test_devices.py`, `test_device_checks.py`.
- Checks: every §4.5 code except `datalogger_lost` (needs the live sweep). Thresholds in `DEVICE_CHECKS`, overridable by `app_settings` key `device_checks`, returned as `meta.thresholds`. `inverter_never_reported` without a Growatt create date = info. `firmware_minority` against the fleet-wide majority per `device_model` (tie = not judged). `meter_silent` against the last `history` run start, daylight only, off with `METER_HISTORY_ENABLED=false`. `logger_sn_mismatch` = the site register's `logger_sn_differs`. Sensor checks = today's `growatt_sensors.list_sensors` flags (`stale_history` left out: live).
- Issue counts leave shadow issues out for every role.
- Frontend: sidebar Operations → Devices (`/devices`), header strip (live counts from the inverter snapshot, open checks), tabs Inverters / Weather sensors / Meters / Dataloggers / Checks (`?tab=`; a tab switch drops the other tabs' keys). `/sensors` redirects to `/devices?tab=sensors` keeping its query (`tab=status|info` → `view`); `HIDDEN_NAV` is empty.

Deferred:
- Live datalogger sweep (§5 item 5) and the `datalogger_lost` check; the Dataloggers tab is DB only.
- Site register devices (router, PQM, ShineMaster) as a tab.
- Field checklist (devices ticked on a visit).
- Nav badge with the check count, AI Assistant tool, weekly push of new checks.

`no_string_layout` is one check per plant (it was one per inverter: 625 info checks on the local DB, 2026-11-25). A logger SN the Dataloggers tab calls `prefix` (register SN truncated) is still a `logger_sn_mismatch` warn, as in the site register.
