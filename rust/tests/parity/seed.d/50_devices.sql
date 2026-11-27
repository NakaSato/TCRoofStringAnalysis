-- Devices area (routes/growatt/devices.rs): weather sensors, Active Alarm, Devices page and its
-- checks. Plant ids 5000–5999 only. Times are plant-local "today" / "yesterday" (Asia/Bangkok),
-- so the flags depend on when the run happens; both backends see the same rows and clock.
--   5001 Devices Alpha (phase 1, Bangkok coordinates): 2 installed inverters + 1 not installed,
--        a weather sensor with an all-zero module probe and zero irradiance while producing,
--        a meter with today's records, a site-register logger SN that differs, issues, alarms
--   5002 Devices Beta (phase 2, engineer): one inverter that never reported, no meter, a sensor
--        with nothing stored
--   5003 devices gamma (no phase, engineer): 4 inverters (firmware majority), a meter never
--        stored, a sensor with yesterday's readings, a register SN that is a prefix

INSERT INTO growatt_plants (plant_id, phase, name, city, latitude, longitude, peak_power_kwp,
                            growatt_inverter_count, growatt_datalogger_count, synced_at)
VALUES (5001, 1, 'Devices Alpha', 'Bangkok', 13.75, 100.5, 160, 4, 1, now()),
       (5002, 2, 'Devices Beta', NULL, NULL, NULL, 50, 1, 2, now()),
       (5003, NULL, 'devices gamma', '', 0, 0, 300, 4, NULL, now());

INSERT INTO user_plant_assignments (user_id, plant_id, assigned_by, created_at)
SELECT id, p, 'parity', now() FROM users, unnest(ARRAY[5002, 5003]) AS p WHERE username = 'engineer';

CREATE TEMP TABLE d50 AS SELECT (now() AT TIME ZONE 'Asia/Bangkok')::date AS today;

INSERT INTO growatt_inverters (device_sn, plant_id, datalogger_sn, model, alias, nominal_power_w, fw_version,
    active_rate_pct, power_limit_pct, on_off, info_synced_at, param_synced_at, device_model, datalogger_model,
    rated_power_w, growatt_created_at, history_synced_until, not_installed_at, not_installed_by, not_installed_note, synced_at)
SELECT * FROM (VALUES
  ('DEVA0001', 5001, 'DL5001', 'MAX 80KTL3 LV', 'INVERTER 1', 80000.0, 'TL1.0', 100.0, NULL::float, 1,
   now() - interval '2 hours', now() - interval '5 days', 'MAX 80KTL3 LV', 'ShineMaster', 80000.0,
   (SELECT today FROM d50) - 400 + time '08:00', (SELECT today FROM d50) + time '14:55', NULL::timestamptz, NULL, NULL, now()),
  ('DEVA0002', 5001, 'DL5001', 'MAX 80KTL3 LV', 'Inverter no.2', NULL, 'TL2.0', NULL, 80.0, 0,
   NULL, now() - interval '200 days', 'MAX 80KTL3 LV', 'ShineMaster', 80000.0,
   (SELECT today FROM d50) - 400 + time '08:00', (SELECT today FROM d50) + time '10:30', NULL, NULL, NULL, now()),
  ('DEVA0003', 5001, 'DL5001X', 'MAX 80KTL3 LV', 'INVERTER 3 old', 80000.0, 'TL1.0', NULL, NULL, 1,
   now(), now(), 'MAX 80KTL3 LV', 'ShineLan', 80000.0,
   NULL, (SELECT today FROM d50) - 30 + time '12:00', now() - interval '3 days', 'admin', 'removed on site', now()),
  ('DEVB0001', 5002, 'DL5002', 'MAX 50KTL3 LV', 'DEVB0001', NULL, NULL, NULL, NULL, NULL,
   now() - interval '1 hour', now() - interval '1 day', NULL, NULL, NULL,
   (SELECT today FROM d50) - 10 + time '09:15', NULL, NULL, NULL, NULL, now()),
  ('DEVC0001', 5003, 'DL5003', 'MAX 80KTL3 LV', '(1) DEVC0001', 80000.0, 'TL1.0', 90.5, NULL, 1,
   now() - interval '1 hour', now() - interval '1 day', 'MAX 80KTL3 LV', 'ShineMaster', 80000.0,
   NULL, (SELECT today FROM d50) - 1 + time '17:55', NULL, NULL, NULL, now()),
  ('DEVC0002', 5003, 'DL5003', 'MAX 80KTL3 LV', 'INV No.02_ST2', 80000.0, 'TL1.0', NULL, NULL, 1,
   now() - interval '1 hour', now() - interval '1 day', 'MAX 80KTL3 LV', 'ShineMaster', 80000.0,
   NULL, (SELECT today FROM d50) - 1 + time '17:50', NULL, NULL, NULL, now()),
  ('DEVC0003', 5003, 'DL5003', 'MAX 80KTL3 LV', 'Inverter03', 80000.0, 'TL1.0', NULL, NULL, 1,
   now() - interval '1 hour', now() - interval '1 day', 'MAX 80KTL3 LV', 'ShineMaster', 80000.0,
   NULL, NULL, NULL, NULL, NULL, now()),
  ('DEVC0004', 5003, 'DL5003', 'MAX 80KTL3 LV', 'INV4', 80000.0, 'xx1.0', NULL, NULL, 1,
   now() - interval '1 hour', now() - interval '1 day', 'MAX 80KTL3 LV', NULL, 80000.0,
   NULL, NULL, NULL, NULL, NULL, now())
) AS v;

-- inverter records today: DEVA0001 10:00–14:55 producing, DEVA0002 10:00–10:30
INSERT INTO growatt_inverter_readings (device_sn, timestamp, status, pac_w, eac_today_kwh)
SELECT 'DEVA0001', (SELECT today FROM d50) + time '10:00' + n * interval '5 minutes', 1, 40000 + n * 10, 20.5 + n * 3.3
FROM generate_series(0, 59) AS n;
INSERT INTO growatt_inverter_readings (device_sn, timestamp, status, pac_w, eac_today_kwh)
SELECT 'DEVA0002', (SELECT today FROM d50) + time '10:00' + n * interval '5 minutes', CASE WHEN n = 6 THEN 3 ELSE 1 END,
       30000, CASE WHEN n = 6 THEN NULL ELSE 15.25 + n END
FROM generate_series(0, 6) AS n;
-- yesterday's records of plant 5003 (not today: no yield today)
INSERT INTO growatt_inverter_readings (device_sn, timestamp, status, pac_w, eac_today_kwh)
VALUES ('DEVC0001', (SELECT today FROM d50) - 1 + time '17:55', 1, 100, 300.4),
       ('DEVC0002', (SELECT today FROM d50) - 1 + time '17:50', 1, 90, 290.1);

INSERT INTO growatt_string_layouts (device_sn, string_no, modules, module_wp, updated_at)
VALUES ('DEVA0001', 1, 20, 550, now()), ('DEVA0001', 2, 20, 550, now()), ('DEVC0001', 1, 18, 545, now());

-- issues: active, acknowledged, closed, shadow
INSERT INTO growatt_issues (plant_id, device_sn, rule, tier, safety, opened_day, last_seen_day, days_seen, status, shadow, created_at, updated_at)
VALUES (5001, 'DEVA0001', 'R1', 'P3', false, (SELECT today FROM d50) - 3, (SELECT today FROM d50), 3, 'open', false, now(), now()),
       (5001, 'DEVA0001', 'R2', 'P1', false, (SELECT today FROM d50) - 2, (SELECT today FROM d50), 2, 'acknowledged', false, now(), now()),
       (5001, 'DEVA0001', 'R3', 'P1', false, (SELECT today FROM d50) - 9, (SELECT today FROM d50) - 5, 4, 'closed', false, now(), now()),
       (5001, 'DEVA0002', 'R4', 'P2', false, (SELECT today FROM d50) - 1, (SELECT today FROM d50), 1, 'open', true, now(), now()),
       (5003, 'DEVC0002', 'R5', 'Info', false, (SELECT today FROM d50) - 1, (SELECT today FROM d50), 1, 'open', false, now(), now()),
       (5003, NULL, 'R6', 'P2', false, (SELECT today FROM d50) - 1, (SELECT today FROM d50), 1, 'open', false, now(), now());

-- alarm log: today (open, closed, fault, non-numeric code, a not-installed inverter), yesterday
INSERT INTO growatt_alarms (device_sn, plant_id, day, start_time, end_time, alarm_code, alarm_message, fault_type, status)
VALUES ('DEVA0001', 5001, (SELECT today FROM d50), (SELECT today FROM d50) + time '09:10', NULL, '0102', 'PV Isolation Low', NULL, 1),
       ('DEVA0001', 5001, (SELECT today FROM d50), (SELECT today FROM d50) + time '08:05', (SELECT today FROM d50) + time '08:20', '201', 'Grid voltage high', NULL, 0),
       ('DEVA0002', 5001, (SELECT today FROM d50), (SELECT today FROM d50) + time '10:30', (SELECT today FROM d50) + time '10:30', 'A12', 'Fan fault', 'fault', 3),
       ('DEVA0002', 5001, (SELECT today FROM d50), NULL, NULL, '', NULL, NULL, NULL),
       ('DEVA0003', 5001, (SELECT today FROM d50), (SELECT today FROM d50) + time '07:00', NULL, '300', 'Old unit', 'warning', 1),
       ('DEVC0001', 5003, (SELECT today FROM d50), (SELECT today FROM d50) + time '06:45', (SELECT today FROM d50) + time '06:50', '115', 'Warning 115', 'warning', 0),
       ('DEVA0001', 5001, (SELECT today FROM d50) - 1, (SELECT today FROM d50) - 1 + time '16:00', (SELECT today FROM d50) - 1 + time '16:40', '201', 'Grid voltage high', NULL, 0),
       ('DEVC0002', 5003, (SELECT today FROM d50) - 1, (SELECT today FROM d50) - 1 + time '12:00', NULL, '4', 'Bus fault', 'fault', 3),
       ('DEVA0001', 5001, date '2026-11-20', timestamp '2026-11-20 11:00', timestamp '2026-11-20 11:30', '201', 'Grid voltage high', NULL, 0),
       ('DEVC0001', 5003, date '2026-11-20', timestamp '2026-11-20 13:00', NULL, '4', 'Bus fault', 'fault', 3);
INSERT INTO growatt_alarm_syncs (device_sn, day, plant_id, synced_at, alarm_count)
VALUES ('DEVA0001', (SELECT today FROM d50), 5001, now() - interval '7 minutes', 2),
       ('DEVA0002', (SELECT today FROM d50), 5001, now() - interval '37 minutes 12.5 seconds', 2),
       ('DEVA0003', (SELECT today FROM d50), 5001, now() - interval '2 minutes', 1),
       ('DEVC0001', (SELECT today FROM d50), 5003, now() - interval '50 minutes', 1),
       ('DEVA0001', (SELECT today FROM d50) - 1, 5001, now() - interval '1 day', 1),
       ('DEVC0002', (SELECT today FROM d50) - 1, 5003, now() - interval '20 hours', 1),
       ('DEVC0001', (SELECT today FROM d50) - 1, 5003, now() - interval '20 hours', 0),
       ('DEVA0001', date '2026-11-20', 5001, timestamptz '2026-11-21 00:30:05.123456+07', 1),
       ('DEVC0001', date '2026-11-20', 5003, timestamptz '2026-11-21 00:31:00+07', 1);
INSERT INTO sync_runs (job, trigger, status, started_at, finished_at)
VALUES ('alarms', 'schedule', 'ok', now() - interval '8 minutes', now() - interval '6 minutes'),
       ('alarms', 'schedule', 'failed', now() - interval '3 minutes', now() - interval '2 minutes');
UPDATE sync_runs SET error = 'abandoned (worker stopped mid-run)'
WHERE job = 'alarms' AND status = 'failed' AND started_at > now() - interval '4 minutes';

-- weather sensors
INSERT INTO growatt_env_sensors (datalogger_sn, address, plant_id, device_name, history_synced_until, synced_at)
VALUES ('DL5001', 1, 5001, 'Env Alpha', (SELECT today FROM d50) + time '17:55', now()),
       ('DL5002', 1, 5002, NULL, NULL, now()),
       ('DL5003', 2, 5003, 'Env Gamma', timestamp '2026-11-20 17:55', now());
-- DL5001:1 today 06:00–17:55 every 5 min, a gap 12:00–12:55; irradiance 0 10:00–11:55; module
-- probe 0 all day (it read 3 days ago); wind 0
INSERT INTO growatt_env_readings (datalogger_sn, address, timestamp, irradiance_wm2, ambient_temp_c, module_temp_c, humidity_pct, wind_speed_ms, wind_dir_deg)
SELECT 'DL5001', 1, ts,
       CASE WHEN ts::time >= time '10:00' AND ts::time < time '12:00' THEN 0 ELSE 400 + extract(minute FROM ts) END,
       30.5, 0, 65.25, 0, 0
FROM generate_series((SELECT today FROM d50) + time '06:00', (SELECT today FROM d50) + time '17:55', interval '5 minutes') AS ts
WHERE NOT (ts::time >= time '12:00' AND ts::time < time '13:00');
INSERT INTO growatt_env_readings (datalogger_sn, address, timestamp, irradiance_wm2, ambient_temp_c, module_temp_c, humidity_pct, wind_speed_ms, wind_dir_deg)
SELECT 'DL5001', 1, (SELECT today FROM d50) - 3 + time '12:00' + n * interval '5 minutes', 800, 31, 45.5, 60, 1.5, 90
FROM generate_series(0, 3) AS n;
-- DL5003:2 on the fixed past day 2026-11-20 (the cases ask for it by date) 06:00–17:55 every
-- 10 min (half the slots), humidity 0 all that day (it read 3 days before)
INSERT INTO growatt_env_readings (datalogger_sn, address, timestamp, irradiance_wm2, ambient_temp_c, module_temp_c, humidity_pct, wind_speed_ms, wind_dir_deg)
SELECT 'DL5003', 2, ts, 500, 29, 41, 0, NULL, NULL
FROM generate_series(timestamp '2026-11-20 06:00', timestamp '2026-11-20 17:45', interval '10 minutes') AS ts;
INSERT INTO growatt_env_readings (datalogger_sn, address, timestamp, irradiance_wm2, ambient_temp_c, module_temp_c, humidity_pct, wind_speed_ms, wind_dir_deg)
VALUES ('DL5003', 2, timestamp '2026-11-17 12:00', 700, 30, 40, 55, 2, 180),
       ('DL5003', 2, timestamp '2026-11-20 17:55', 20, 27, 28, 0, NULL, NULL);

-- energy meters
INSERT INTO growatt_meters (datalogger_sn, address, plant_id, device_name, device_type, history_synced_until, synced_at)
VALUES ('DL5001', 3, 5001, 'CHNT_THREE', 'meter', (SELECT today FROM d50) + time '09:00', now()),
       ('DL5003', 4, 5003, NULL, NULL, NULL, now());
INSERT INTO growatt_meter_readings (datalogger_sn, address, timestamp, active_power_w, import_counter_kwh)
SELECT 'DL5001', 3, (SELECT today FROM d50) + time '07:00' + n * interval '2 minutes 30 seconds',
       CASE WHEN n % 3 = 0 THEN -1200.5 ELSE 2500 + n END, 1000 + n * 0.25
FROM generate_series(0, 48) AS n;

-- site register
INSERT INTO site_register (site_code, plant_id, match_rule, name, province, kwp, imported_at)
VALUES ('S5001', 5001, 'logger_sn', 'Alpha station', 'Nonthaburi', 160, now()),
       ('S5003', 5003, 'name', 'Gamma station', NULL, 300, now()),
       ('S5099', NULL, NULL, 'Unmatched station', 'Rayong', 10, now());
INSERT INTO site_devices (site_code, kind, seq, serial)
VALUES ('S5001', 'datalogger', 2, 'dl5001y'),
       ('S5001', 'datalogger', 1, ' DL5001Z '),
       ('S5001', 'inverter', 1, 'DEVA0001'),
       ('S5003', 'datalogger', 1, 'DL500'),
       ('S5099', 'datalogger', 1, 'DL5099');

-- device check thresholds: a float override, an unknown key and a bool (both ignored)
INSERT INTO app_settings (key, value, updated_by, updated_at)
VALUES ('device_checks', '{"silent_hours": 1.5, "never_reported_days": 5, "bogus": 1, "limit_below_pct": true}', 'parity', now())
ON CONFLICT (key) DO NOTHING;

DROP TABLE d50;
