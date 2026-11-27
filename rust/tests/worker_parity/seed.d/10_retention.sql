-- Rows on both sides of every `retention` cutoff (jobs.py `job_retention`, run with the defaults:
-- HISTORY_RETENTION_DAYS 90, HISTORY_STRING_RETENTION_DAYS 30, HISTORY_RAW_RETENTION_DAYS 7,
-- LOG_RETENTION_DAYS 14; LOG_MAX_ROWS is set to 8 for this job in jobs.json). Day d = plant-local
-- today − d; a row at d 00:00 sits exactly on the cutoff and is kept. Plants 9501–9502.
CREATE TEMP TABLE t AS SELECT (now() AT TIME ZONE 'Asia/Bangkok')::date AS today;

INSERT INTO growatt_plants (plant_id, name, synced_at) VALUES (9501, 'Retention plant A', now()), (9502, 'Retention plant B', now());
INSERT INTO growatt_inverters (device_sn, plant_id, synced_at) VALUES ('RTINV01', 9501, now()), ('RTINV02', 9501, now()), ('RTINV03', 9502, now());
INSERT INTO growatt_env_sensors (datalogger_sn, address, plant_id, synced_at) VALUES ('RTDL01', 1, 9501, now());
INSERT INTO growatt_meters (datalogger_sn, address, plant_id, synced_at) VALUES ('RTDL01', 36, 9501, now());

-- inverter / weather / meter readings: the oldest is day 95 (5 days to walk), cutoff day 90 00:00
INSERT INTO growatt_inverter_readings (device_sn, timestamp, pac_w)
SELECT sn, (t.today - d) + h * interval '1 hour', 1000 + d
FROM t, (VALUES ('RTINV01'), ('RTINV02'), ('RTINV03')) s(sn), (VALUES (95, 12), (91, 23), (90, 0), (89, 12)) x(d, h);
INSERT INTO growatt_env_readings (datalogger_sn, address, timestamp, irradiance_wm2)
SELECT 'RTDL01', 1, (t.today - d) + h * interval '1 hour', 500 FROM t, (VALUES (93, 10), (90, 0), (2, 10)) x(d, h);
INSERT INTO growatt_meter_readings (datalogger_sn, address, timestamp, active_power_w)
SELECT 'RTDL01', 36, (t.today - d) + h * interval '1 hour', -100 FROM t, (VALUES (92, 10), (91, 0), (89, 10)) x(d, h);

-- string records: cutoff day 30 00:00
INSERT INTO growatt_string_records (device_sn, timestamp, strings)
SELECT sn, (t.today - d) + h * interval '1 hour', '[[1,1,600.0,8.1]]'::json
FROM t, (VALUES ('RTINV01'), ('RTINV03')) s(sn), (VALUES (45, 9), (31, 9), (30, 0), (29, 9)) x(d, h);

-- whole max_data records: cutoff day 7 00:00
INSERT INTO growatt_inverter_raw (device_sn, timestamp, data)
SELECT 'RTINV02', (t.today - d) + h * interval '1 hour', '{"pac":1}'::json FROM t, (VALUES (9, 9), (8, 23), (7, 0), (6, 9)) x(d, h);

-- Google hours: cutoff day 90 00:00
INSERT INTO google_weather_hourly (cell_key, hour, fetched_at)
SELECT '13.75,100.50', (t.today - d) + h * interval '1 hour', now() FROM t, (VALUES (91, 17), (90, 0), (89, 6)) x(d, h);

-- alarm log and its sync stamps: cutoff date day 90 (day < cutoff goes)
INSERT INTO growatt_alarms (device_sn, plant_id, day, alarm_code)
SELECT 'RTINV01', 9501, t.today - d, '117' FROM t, (VALUES (92), (91), (90), (1)) x(d);
INSERT INTO growatt_alarm_syncs (device_sn, day, plant_id, synced_at, alarm_count)
SELECT 'RTINV01', t.today - d, 9501, now(), 1 FROM t, (VALUES (91), (90)) x(d);

-- frozen PWA check slots: cutoff day 90
INSERT INTO pwa_check_slots (day, plant_id, hour, slot_json, built_at)
SELECT t.today - d, 9501, 9, '{}'::json, now() FROM t, (VALUES (91), (90), (3)) x(d);

-- Growatt plant curve: cutoff day 90 00:00
INSERT INTO growatt_plant_power (plant_id, timestamp, power_w)
SELECT 9501, (t.today - d) + h * interval '1 hour', 2000 FROM t, (VALUES (90, 0), (91, 12), (100, 12)) x(d, h);

-- alarm push marks: past days go, today stays
INSERT INTO alarm_push_marks (device_sn, alarm_code, day, event_start, pushed_at)
SELECT 'RTINV01', '117', t.today - d, (t.today - d) + interval '9 hours', now() FROM t, (VALUES (2), (1), (0)) x(d);

-- Calendar Team push marks: older than 14 days go
INSERT INTO om_push_marks (user_id, kind, day, tasks, pushed_at)
SELECT u.id, 'tomorrow', t.today - d, 1, now() FROM t, users u, (VALUES (15), (14), (3)) x(d) WHERE u.username = 'admin';

-- app logs: older than 14 days go (two), then the oldest beyond LOG_MAX_ROWS (8)
INSERT INTO app_logs (ts, level, level_no, source, host, logger, message)
SELECT now() - d * interval '1 day', 'INFO', 20, 'worker', 'seed', 'app.services.jobs', 'seed log ' || d || ' days old'
FROM (VALUES (20), (15), (13.9), (12), (11), (10), (9), (8), (7), (6), (5), (4), (3), (2), (1)) x(d);

-- job runs: finished ones older than 90 days go, unless the newest of their job; running / queued stay
INSERT INTO sync_runs (job, trigger, status, started_at, finished_at, detail_json)
VALUES
  ('history', 'schedule', 'ok', now() - interval '120 days', now() - interval '120 days', '{"inverters":3}'),
  ('history', 'schedule', 'failed', now() - interval '95 days', now() - interval '95 days', NULL),
  ('history', 'schedule', 'ok', now() - interval '2 days', now() - interval '2 days', '{"inverters":3}'),
  ('fleet', 'schedule', 'ok', now() - interval '150 days', now() - interval '150 days', '{"inverters":3}'),
  ('backfill', 'api', 'running', now() - interval '100 days', NULL, NULL),
  ('om_plans', 'api', 'queued', now() - interval '100 days', NULL, NULL),
  ('retention', 'schedule', 'ok', now() - interval '91 days', now() - interval '91 days', '{}'),
  ('retention', 'schedule', 'ok', now() - interval '89 days', now() - interval '89 days', '{}');
