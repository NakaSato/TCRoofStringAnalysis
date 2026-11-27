-- Growatt live weather sensors, energy meters and string operating points
-- (cases.d/71_live_sensors.json): registry rows and stored history only, plant ids 7101-7199.
-- Live values come from the stub Growatt (growatt_stub.py: DL71R refuses, address 9 / 99 has no record).
INSERT INTO growatt_plants (plant_id, name, phase, latitude, longitude, synced_at) VALUES
  (7101, 'Live S1', 1, 13.7, 100.5, now()),
  (7102, 'Live S2', 1, 14.1, 100.7, now()),
  (7103, 'Live S3', NULL, NULL, NULL, now()),
  (7104, 'Live S4', 4, 13.8, 100.4, now());

INSERT INTO growatt_inverters (device_sn, plant_id, alias, nominal_power_w, synced_at) VALUES
  ('INV7101A', 7101, 'INV 1', 25000, now()),
  ('INV7101B', 7101, 'INV 2', 20000, now()),
  ('INV7102A', 7102, NULL, NULL, now()),
  ('INV7104A', 7104, NULL, 30000, now());

-- 7101 A: strings 1-2 of 14 fleet modules, 3 of another module (450 Wp), 4 not entered; B: none
INSERT INTO growatt_string_layouts (device_sn, string_no, modules, module_wp, updated_at) VALUES
  ('INV7101A', 1, 14, NULL, now()),
  ('INV7101A', 2, 14, 570, now()),
  ('INV7101A', 3, 14, 450, now()),
  ('INV7102A', 1, 20, NULL, now()),
  ('INV7102A', 2, 20, NULL, now());

INSERT INTO growatt_env_sensors (datalogger_sn, address, plant_id, device_name, history_synced_until, synced_at) VALUES
  ('DL71A', 1, 7101, 'ENV1', (now() AT TIME ZONE 'Asia/Bangkok') - interval '3 hours', now()),
  ('DL71A', 2, 7101, 'ENV2', NULL, now()),
  ('DL71A', 3, 7101, 'ENV3', date_trunc('second', (now() AT TIME ZONE 'Asia/Bangkok') - interval '10 minutes'), now()),
  ('DL71R', 1, 7101, 'ENVR', NULL, now()),
  ('DL71B', 1, 7102, 'ENVB', NULL, now()),
  ('DL74', 9, 7104, 'ENV9', NULL, now());

-- stored readings in the last 7 days: humidity and wind read 0 (not fitted), ENV3 has no module temperature
INSERT INTO growatt_env_readings (datalogger_sn, address, timestamp, irradiance_wm2, ambient_temp_c, module_temp_c, humidity_pct, wind_speed_ms, wind_dir_deg)
SELECT 'DL71A', 1, date_trunc('minute', (now() AT TIME ZONE 'Asia/Bangkok') - interval '1 day') + n * interval '5 minutes', 500 + n, 30, 45, 0, 0, 0
FROM generate_series(0, 11) AS n;
INSERT INTO growatt_env_readings (datalogger_sn, address, timestamp, irradiance_wm2, ambient_temp_c, module_temp_c, humidity_pct, wind_speed_ms, wind_dir_deg)
SELECT 'DL71A', 3, date_trunc('minute', (now() AT TIME ZONE 'Asia/Bangkok') - interval '2 days') + n * interval '5 minutes', 400, 29, 0, 0, 0, 0
FROM generate_series(0, 5) AS n;
INSERT INTO growatt_env_readings (datalogger_sn, address, timestamp, irradiance_wm2, ambient_temp_c, module_temp_c, humidity_pct, wind_speed_ms, wind_dir_deg)
SELECT 'DL71B', 1, date_trunc('minute', (now() AT TIME ZONE 'Asia/Bangkok') - interval '1 day') + n * interval '5 minutes', 610, 31, 47.5, 55, 1.5, 90
FROM generate_series(0, 5) AS n;

INSERT INTO growatt_meters (datalogger_sn, address, plant_id, device_name, device_type, synced_at) VALUES
  ('DL71A', 36, 7101, 'CHNT_THREE', '3', now()),
  ('DL71A', 99, 7101, 'CHNT_THREE', '3', now()),
  ('DL71B', 36, 7102, 'CHNT_THREE', '3', now()),
  ('DL71R', 36, 7104, 'CHNT_THREE', '3', now());
