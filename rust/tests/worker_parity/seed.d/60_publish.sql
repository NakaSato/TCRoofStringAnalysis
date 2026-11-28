-- publish_today / publish_yesterday (jobs.py `_publish`; daily_summary.py `build_day_docs`,
-- `build_registry_docs`; check_slots.py `day_slots`, `compute_slots`). Plants 9701-9703, serials
-- PB*, datalogger PBDL1. Every other seeded plant is published too (one fleet doc per day).
-- Reading times are naive plant-local clock times of yesterday / today; bookkeeping times are UTC.
-- Yesterday's three checks are always ready (a past day); today's are ready once their slot time
-- (08:50 / 12:50 / 16:50) has passed, because of the `history` run seeded below (started now).
-- Google Weather has no key in the harness: no current conditions, stored hours only.
CREATE TEMP TABLE p AS SELECT (now() AT TIME ZONE 'Asia/Bangkok')::date AS t, (now() AT TIME ZONE 'Asia/Bangkok')::date - 1 AS y;

INSERT INTO growatt_plants (plant_id, name, phase, latitude, longitude, peak_power_kwp, city, country, create_date, synced_at) VALUES
  (9701, 'Publish plant A', 3, 13.7563, 100.5018, 50.0, 'Bangkok', 'Thailand', '2024-01-05', now()),
  (9702, 'Publish plant B (no inverters)', 4, 14.0, 101.0, NULL, NULL, NULL, NULL, now()),
  (9703, 'Publish plant C', 3, NULL, NULL, 9000.0, 'Chiang Mai', 'Thailand', NULL, now());

-- phases 3 and 4: no Growatt account in any harness job, so no other job reads these inverters
-- PB1A "INVERTER 1", PB1B "Inverter no.2", PB1C replaced ("INV 3 old", left out of the checks),
-- PB1D not installed, PB3A on plant C with its serial as alias (the plant's only one: INV1)
INSERT INTO growatt_inverters (device_sn, plant_id, alias, model, datalogger_sn, device_types, nominal_power_w, device_model, synced_at) VALUES
  ('PB1A', 9701, 'INVERTER 1', 'MAX 50KTL3-X LV', 'PBDL1', '1,4', 50000, 'MAX 50KTL3 LV', now()),
  ('PB1B', 9701, 'Inverter no.2', 'MAX 50KTL3-X LV', 'PBDL1', '1', 50000, NULL, now()),
  ('PB1C', 9701, 'INV 3 old', NULL, 'PBDL1', NULL, NULL, NULL, now()),
  ('PB1D', 9701, 'INV 4', NULL, 'PBDL1', NULL, NULL, NULL, now()),
  ('PB3A', 9703, 'pb3a', 'MAX 5KTL3', 'PBDL3', '1', 5000, NULL, now());
UPDATE growatt_inverters SET not_installed_at = now(), not_installed_by = 'admin' WHERE device_sn = 'PB1D';
INSERT INTO growatt_string_layouts (device_sn, string_no, modules, module_wp, azimuth_deg, updated_at) VALUES
  ('PB1A', 1, 20, NULL, 180.0, now()), ('PB1A', 2, 22, 570.0, NULL, now());
INSERT INTO growatt_string_removed (device_sn, string_no, removed_at) VALUES ('PB1A', 5, now());

-- readings (yesterday and today): PB1A in fault at the 13 check, warning code 1 (ignored) at 17,
-- PB1B offline at 13 (last reading 11:20), PB3A only in the morning
INSERT INTO growatt_inverter_readings (device_sn, timestamp, status, pac_w, ppv_w, eac_today_kwh, eac_total_kwh, temperature_c, fac_hz, fault_code, warn_code)
SELECT sn, d + tm, st, pac, ppv, eac, tot, temp, hz, fc, wc FROM p, (VALUES
  ('PB1A', time '06:30', 1, 1200.0, 1300.0, 0.4, 1000.4, 31.0, 50.01, NULL::int, NULL::int),
  ('PB1A', time '08:40', 1, 20500.5, 21000.0, 25.2, 1025.2, 42.5, 49.98, NULL, NULL),
  ('PB1A', time '08:45', 1, 21000.0, 21800.0, 27.0, 1027.0, 43.0, 50.0, NULL, NULL),
  ('PB1A', time '12:40', 3, 0.0, 0.0, 80.1, 1080.1, 38.0, 50.0, 117, NULL),
  ('PB1A', time '16:45', 1, 3000.0, 3100.0, 120.3, 1120.3, 35.0, 50.02, NULL, 1),
  ('PB1B', time '08:48', 1, 19800.25, 20500.0, 24.0, 2024.0, 41.0, 50.0, NULL, NULL),
  ('PB1B', time '11:20', 1, 30000.0, 31000.0, 70.0, 2070.0, 45.0, 50.0, NULL, NULL),
  ('PB1B', time '16:40', 1, 2500.0, 2600.0, 110.0, 2110.0, 34.0, 50.0, NULL, 203),
  ('PB3A', time '08:36', 1, 2100.0, 2200.0, 3.1, 503.1, 39.0, 50.0, NULL, NULL)) x(sn, tm, st, pac, ppv, eac, tot, temp, hz, fc, wc),
  LATERAL (VALUES (p.y), (p.t)) dd(d);
INSERT INTO growatt_string_records (device_sn, timestamp, strings)
SELECT sn, d + tm, s::json FROM p, (VALUES
  ('PB1A', time '08:40', '[[1,1,610.0,8.1],[2,1,610.0,8.3]]'),
  ('PB1A', time '08:45', '[[1,1,612.0,8.4],[2,1,612.0,2.1]]'),
  ('PB1B', time '08:48', '[[1,1,605.5,7.9]]')) x(sn, tm, s),
  LATERAL (VALUES (p.y), (p.t)) dd(d);

-- alarm log of both days
INSERT INTO growatt_alarms (device_sn, plant_id, day, start_time, end_time, alarm_code, alarm_message, fault_type, status)
SELECT sn, 9701, d, d + st, CASE WHEN en IS NULL THEN NULL ELSE d + en END, code, msg, ft, 0 FROM p, (VALUES
  ('PB1A', time '12:10', time '12:30', '117', 'Relay check fail', 'Error'),
  ('PB1A', time '12:20', time '12:20', '117', 'Relay check fail', 'Error'),
  ('PB1A', time '12:40', NULL::time, '300', 'undown error', 'Error'),
  ('PB1A', time '16:30', time '16:30', '203', '', 'Warning'),
  ('PB1B', time '08:00', time '08:00', '203', 'PV Circuit short', 'Warning'),
  ('PB1B', time '07:30', time '07:30', '203', 'PV Circuit short', 'Warning'),
  ('PB1B', time '16:20', time '16:25', '', 'Fan alarm', 'Warning'),
  ('PB1C', time '08:30', NULL, '1', 'old inverter', 'Warning')) x(sn, st, en, code, msg, ft),
  LATERAL (VALUES (p.y), (p.t)) dd(d);
INSERT INTO growatt_alarm_syncs (device_sn, day, plant_id, synced_at, alarm_count)
SELECT sn, d, 9701, now() - interval '5 minutes', 3 FROM p, (VALUES ('PB1A'), ('PB1B')) x(sn), LATERAL (VALUES (p.y), (p.t)) dd(d);

-- weather sensor: irradiance at 08:45 (and 08:30, outside the window), 12:47; 16:40 without module temperature
INSERT INTO growatt_env_sensors (datalogger_sn, address, plant_id, synced_at) VALUES ('PBDL1', 1, 9701, now());
INSERT INTO growatt_env_readings (datalogger_sn, address, timestamp, irradiance_wm2, module_temp_c, ambient_temp_c)
SELECT 'PBDL1', 1, d + tm, irr, mt, 30.5 FROM p, (VALUES
  (time '08:30', 480.0, 40.0), (time '08:45', 520.4, 41.2), (time '12:47', 801.0, 55.5), (time '16:40', 210.0, NULL::float)) x(tm, irr, mt),
  LATERAL (VALUES (p.y), (p.t)) dd(d);

-- Google Weather hours (modelled) of yesterday for plant A's cell; 16:00 for plant B's
INSERT INTO google_weather_hourly (cell_key, hour, condition, is_daytime, temp_c, humidity_pct, cloud_cover_pct, uv_index, precip_mm, precip_prob_pct, fetched_at)
SELECT c, p.y + h, cond, true, tc, 70.0, cc, 5.0, pr, 20.0, now() FROM p, (VALUES
  ('13.76,100.50', time '08:00', 'PARTLY_CLOUDY', 29.5, 40.0, 0.0),
  ('13.76,100.50', time '12:00', 'LIGHT_RAIN', 31.0, 90.0, 1.4),
  ('13.76,100.50', time '16:00', 'CLOUDY', 30.0, 70.0, 0.0),
  ('14.00,101.00', time '16:00', 'CLEAR', 33.0, 5.0, NULL::float)) x(c, h, cond, tc, cc, pr);

-- yesterday's 09 check of plant A frozen earlier without Google weather: reused as frozen, its
-- `google` filled from the stored 08:00 hour
INSERT INTO pwa_check_slots (day, plant_id, hour, slot_json, built_at)
SELECT y, 9701, 9, '{"at":"08:50","inverters":2,"offline":[],"fault":[],"alarms":["INV2 frozen"],"errors":[],"issues":[],"kw":40.5,"reading_at":"08:48","irradiance_wm2":500.0,"module_temp_c":40.0,"sensor_at":"08:45","google":null}'::json, now() - interval '1 day' FROM p;

-- the as-built link and the O&M site register station of plant A
INSERT INTO plant_documents (plant_id, kind, url, title, revision, source, updated_at) VALUES
  (9701, 'asbuilt', 'https://drive.google.com/file/d/pb-asbuilt/view', 'As-built A', 'REV.2', 'manual', now());
INSERT INTO site_register (site_code, plant_id, name, project_phase, province, cod_actual, imported_at) VALUES
  ('P9-701', 9701, 'Publish A', 0, 'กรุงเทพมหานคร', DATE '2024-03-01', now()),
  ('P9-702', 9702, 'Publish B', NULL, '', NULL, now());

-- a finished `history` run that started now: every check of today whose slot time has passed is ready
INSERT INTO sync_runs (job, trigger, status, started_at, finished_at, detail_json)
VALUES ('history', 'schedule', 'ok', now(), now(), '{}');

DROP TABLE p;
