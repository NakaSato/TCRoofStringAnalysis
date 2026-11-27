-- `fleet` and `power_limits` (jobs.py `job_fleet` / `job_power_limits`, growatt_sync/registry.py
-- and power_limits.py). Plants 3001-3009, serials INVF*, dataloggers DLF*; the Growatt stub answers
-- them for the tokens starting "fleet-" (phase 2 in jobs.json) and readPower for any token.
--   3001  phase NULL (fleet tags it 2; power_limits reads it with phase 1, the first account);
--         INVF3001A: info read 1 h ago (not due), model read 40 days ago (due), creation date
--         known, power limit 100 % read 2 days ago (stub now answers 80.5: a change line)
--   3002  phase 2: INVF3002A (no datalogger; readPower code 5), INVF3002N marked not installed
--   3003  phase 2: INVF3003A (readPower without a value), INVF3003B power limit read 1 h ago
--   3004  phase 2, not listed by Growatt: INVF3004A-C answer readPower 10012 (3 in a row end it)
--   3009  blocked in the fleet run (GROWATT_BLOCKED_PLANT_IDS=3009): removed at worker start with
--         its inverter, readings, sensor, issue, task (+ assignee), suggestion mark, plan link,
--         plant settings, document and O&M register station + device
INSERT INTO growatt_plants (plant_id, phase, name, details_synced_at, synced_at) VALUES
  (3001, NULL, 'Old name A', now() - interval '1 day', now() - interval '3 days'),
  (3002, 2, 'Fleet B', NULL, now() - interval '3 days'),
  (3003, 2, 'Fleet C', now() - interval '30 days', now() - interval '3 days'),
  (3004, 2, 'Fleet D unlisted', NULL, now() - interval '3 days'),
  (3009, 2, 'Blocked', NULL, now() - interval '3 days');

INSERT INTO growatt_inverters (device_sn, plant_id, datalogger_sn, model, info_synced_at, param_synced_at, device_model,
  datalogger_model, growatt_created_at, power_limit_pct, power_limit_read_at, not_installed_at, not_installed_by, synced_at) VALUES
  ('INVF3001A', 3001, 'DLF3001', 'MAX', now() - interval '1 hour', now() - interval '40 days', 'OLD MODEL', 'DM-OLD',
   '2023-01-01 08:00:00', 100, now() - interval '2 days', NULL, NULL, now() - interval '3 days'),
  ('INVF3002A', 3002, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, now() - interval '3 days'),
  ('INVF3002N', 3002, 'DLF3002', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, now() - interval '5 days', 'admin', now() - interval '3 days'),
  ('INVF3003A', 3003, 'DLF3003', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, now() - interval '3 days'),
  ('INVF3003B', 3003, 'DLF3003', NULL, NULL, NULL, NULL, NULL, NULL, 90, now() - interval '1 hour', NULL, NULL, now() - interval '3 days'),
  ('INVF3004A', 3004, 'DLF3004', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, now() - interval '3 days'),
  ('INVF3004B', 3004, 'DLF3004', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, now() - interval '3 days'),
  ('INVF3004C', 3004, 'DLF3004', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, now() - interval '3 days'),
  ('INVF3009A', 3009, 'DLF3009', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, now() - interval '3 days');

INSERT INTO growatt_inverter_readings (device_sn, timestamp, pac_w) VALUES ('INVF3009A', '2026-11-20 10:00:00', 1000), ('INVF3001A', '2026-11-20 10:00:00', 2000);
INSERT INTO growatt_env_sensors (datalogger_sn, address, plant_id, device_name, synced_at) VALUES
  ('DLF3009', 1, 3009, 'ENV', now()), ('DLF3001', 1, 3001, 'stale name', now() - interval '3 days');

-- the blocked plant's O&M rows
INSERT INTO growatt_issues (id, plant_id, rule, tier, safety, opened_day, last_seen_day, days_seen, status, shadow, created_at, updated_at)
  VALUES (930001, 3009, 'R1', 'plant', false, '2026-11-20', '2026-11-21', 2, 'open', false, now(), now()),
         (930002, 3001, 'R1', 'plant', false, '2026-11-20', '2026-11-21', 2, 'open', false, now(), now());
INSERT INTO om_tasks (id, plant_id, task_type, start_day, end_day, status, created_at, updated_at)
  VALUES (930001, 3009, 'cleaning', '2026-12-01', '2026-12-01', 'planned', now(), now()),
         (930002, 3001, 'cleaning', '2026-12-01', '2026-12-01', 'planned', now(), now());
INSERT INTO om_task_assignees (task_id, user_id) SELECT t.id, u.id FROM (VALUES (930001), (930002)) t(id), (SELECT min(id) AS id FROM users) u;
INSERT INTO om_cleaning_suggestion_marks (plant_id, reset_day, action, task_id, at) VALUES (3009, '2026-11-01', 'accepted', 930001, now());
INSERT INTO om_plans (id, name, task_type, every_n, unit, duration_days, starts_on, active, created_at, updated_at)
  VALUES (930001, 'Fleet plan', 'cleaning', 3, 'month', 1, '2026-01-01', true, now(), now());
INSERT INTO om_plan_plants (plan_id, plant_id) VALUES (930001, 3009), (930001, 3001);
INSERT INTO om_plant_settings (plant_id, cleaning_crew_days, updated_at) VALUES (3009, 1.5, now()), (3001, 2.0, now());
INSERT INTO plant_documents (id, plant_id, kind, url, source, updated_at) VALUES (930001, 3009, 'asbuilt', 'https://example.invalid/a', 'manual', now());
INSERT INTO site_register (site_code, plant_id, name, imported_at) VALUES ('FLT-3009', 3009, 'Blocked site', now()), ('FLT-3001', 3001, 'Site A', now());
INSERT INTO site_devices (id, site_code, kind, seq) VALUES (930001, 'FLT-3009', 'inverter', 1), (930002, 'FLT-3001', 'inverter', 1);
