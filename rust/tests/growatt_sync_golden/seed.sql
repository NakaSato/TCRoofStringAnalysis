-- Registry and history the Growatt sync golden comparison starts from (run.sh loads it into the
-- template database with psql -v today=YYYY-MM-DD, the plant-local day the stub answers for).
-- Plant ids 9100-9299. Times relative to now() are bookkeeping (UTC); reading times are naive
-- plant-local clock times of :'today'.

INSERT INTO growatt_plants (plant_id, name, phase, synced_at, latitude, longitude) VALUES
  (9101, 'Gold A (seed)', 1, now() - interval '2 days', 1, 1),
  (9102, 'Gold B (seed)', 1, now() - interval '2 days', NULL, NULL),
  (9109, 'Untagged', NULL, now() - interval '2 days', NULL, NULL),
  (9150, 'Blocked', 1, now() - interval '2 days', NULL, NULL),
  (9201, 'Gold C (seed)', 2, now() - interval '2 days', NULL, NULL);
UPDATE growatt_plants SET details_synced_at = now() - interval '1 day' WHERE plant_id = 9102;

INSERT INTO growatt_inverters (device_sn, plant_id, datalogger_sn, synced_at, history_synced_until, power_limit_pct,
                               power_limit_read_at, info_synced_at, param_synced_at, not_installed_at) VALUES
  ('INV-A1', 9101, 'DL-A', now() - interval '2 days', :'today'::date + time '09:00', NULL, NULL, NULL, NULL, NULL),
  ('INV-A2', 9101, '', now() - interval '2 days', :'today'::date + time '08:00', 90, now() - interval '30 hours', NULL, NULL, NULL),
  ('INV-B1', 9102, 'DL-B', now() - interval '2 days', NULL, 100, now() - interval '1 hour', now() - interval '25 hours', now() - interval '2 days', NULL),
  ('INV-U1', 9109, 'DL-U', now() - interval '2 days', :'today'::date - 2 + time '23:30', NULL, NULL, NULL, NULL, NULL),
  ('INV-X1', 9101, 'DL-A', now() - interval '2 days', NULL, NULL, NULL, NULL, NULL, now() - interval '9 days'),
  ('INV-Z1', 9150, 'DL-Z', now() - interval '2 days', NULL, NULL, NULL, NULL, NULL, NULL),
  ('INV-C1', 9201, 'DL-C', now() - interval '2 days', NULL, NULL, NULL, NULL, NULL, NULL);

-- wiring: INV-A1 string 4 has a String Layout row (stored at 0 A); INV-U1 string 3 a daily row
INSERT INTO growatt_string_layouts (device_sn, string_no, modules, updated_at) VALUES ('INV-A1', 4, 20, now());
INSERT INTO growatt_string_daily (device_sn, string_no, day, plant_id, gated_slots, open_min, energy_kwh, computed_at)
VALUES ('INV-U1', 3, :'today'::date - 1, 9109, 0, 0, 0.1, now());
-- a stored record whose string 5 a new write leaves out (kept by store_string_rows)
INSERT INTO growatt_inverter_readings (device_sn, timestamp, status, pac_w) VALUES
  ('INV-A1', :'today'::date + time '08:30', 1, 1.0),
  ('INV-A2', :'today'::date + time '07:00', 3, 0.0);
INSERT INTO growatt_string_records (device_sn, timestamp, strings)
VALUES ('INV-A1', :'today'::date + time '08:30', '[[5,3,500.0,1.0],[1,1,1.0,1.0]]');

INSERT INTO growatt_env_sensors (datalogger_sn, address, plant_id, synced_at, history_synced_until) VALUES
  ('DL-A', 1, 9101, now() - interval '2 days', :'today'::date + time '06:00'),
  ('DL-A', 2, 9101, now() - interval '2 days', NULL),
  ('DL-A', 3, 9101, now() - interval '2 days', NULL),
  ('DL-B', 1, 9102, now() - interval '2 days', NULL),
  ('DL-C', 1, 9201, now() - interval '2 days', NULL);
INSERT INTO growatt_meters (datalogger_sn, address, plant_id, synced_at, history_synced_until) VALUES
  ('DL-A', 36, 9101, now() - interval '2 days', NULL),
  ('DL-B', 40, 9102, now() - interval '2 days', NULL),
  ('DL-U', 5, 9109, now() - interval '2 days', :'today'::date + time '07:00');

-- alarms today: INV-A1 read 15 min ago with an open alarm (hot, due), INV-U1 read 5 min ago with
-- none (cold, not due); INV-A2's newest reading is a fault (hot)
INSERT INTO growatt_alarm_syncs (device_sn, day, plant_id, synced_at, alarm_count) VALUES
  ('INV-A1', :'today', 9101, now() - interval '15 minutes', 1),
  ('INV-U1', :'today', 9109, now() - interval '5 minutes', 0);
INSERT INTO growatt_alarms (device_sn, plant_id, day, start_time, end_time, alarm_code)
VALUES ('INV-A1', 9101, :'today', :'today'::date + time '07:00', NULL, '300');

-- Growatt's own energy already stored
INSERT INTO growatt_plant_power (plant_id, timestamp, power_w) VALUES (9101, :'today'::date - 1 + time '12:00', 5.0);
INSERT INTO growatt_inverter_energy_days (device_sn, day, plant_id, energy_kwh, synced_at)
VALUES ('INV-A1', :'today'::date - 2, 9101, 1.0, now() - interval '1 day');

-- the blocked plant's other rows (remove_blocked_plants deletes them)
INSERT INTO om_plant_settings (plant_id, cleaning_crew_days, updated_at) VALUES (9150, 2, now());
INSERT INTO plant_documents (plant_id, kind, url, source, updated_at) VALUES (9150, 'asbuilt', 'https://example.invalid/x', 'manual', now());
INSERT INTO growatt_issues (plant_id, rule, tier, safety, opened_day, last_seen_day, days_seen, status, shadow, created_at, updated_at)
VALUES (9150, 'R1', 'P2', false, :'today', :'today', 1, 'open', false, now(), now());
