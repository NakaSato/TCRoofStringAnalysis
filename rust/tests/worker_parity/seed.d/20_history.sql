-- history / backfill / env_history / inverter_latest (jobs.json, stub growatt_sync =
-- rust/tests/growatt_sync_golden/sync_stub.py, which answers for today's plant-local day).
-- Plants 9300-9499, serials H-*, dataloggers DL-H*. Reading times are naive plant-local clock times
-- of today (Asia/Bangkok); bookkeeping times relative to now() are UTC.
-- No 10012 on a path that retries: the real jobs wait 60-120 s before each retry.

CREATE TEMP TABLE h_day AS SELECT (now() AT TIME ZONE 'Asia/Bangkok')::date AS d;

INSERT INTO growatt_plants (plant_id, name, phase, synced_at)
VALUES (9301, 'History A', 1, now() - interval '2 days'),
       (9302, 'History B', 1, now() - interval '2 days'),
       (9309, 'History untagged', NULL, now() - interval '2 days'),
       (9401, 'History C', 2, now() - interval '2 days');

-- H-A1: synced to 09:00 today; H-A2: never synced (from yesterday); H-B1: max_data refused (10001,
-- three retries, then queryHistoricalData); H-U1: untagged plant, goes with the first account;
-- H-X1: not installed (never read); H-C1: phase 2 (maxs_data refuses that account)
INSERT INTO growatt_inverters (device_sn, plant_id, datalogger_sn, synced_at, history_synced_until, not_installed_at)
SELECT sn, pid, dl, now() - interval '2 days', hsu, nia FROM h_day, (VALUES
  ('H-A1', 9301, 'DL-H1', (SELECT d FROM h_day) + time '09:00', NULL::timestamptz),
  ('H-A2', 9301, 'DL-H1', NULL::timestamp, NULL),
  ('H-B1', 9302, 'DL-H2', (SELECT d FROM h_day) + time '07:00', NULL),
  ('H-U1', 9309, 'DL-H9', (SELECT d FROM h_day) - 2 + time '23:30', NULL),
  ('H-X1', 9301, 'DL-H1', NULL, now() - interval '9 days'),
  ('H-C1', 9401, 'DL-H4', NULL, NULL)) AS v(sn, pid, dl, hsu, nia);

-- wiring: H-A1 string 4 has a String Layout row (stored at 0 A); H-U1 string 3 a daily row
INSERT INTO growatt_string_layouts (device_sn, string_no, modules, updated_at) VALUES ('H-A1', 4, 20, now());
INSERT INTO growatt_string_daily (device_sn, string_no, day, plant_id, gated_slots, open_min, energy_kwh, computed_at)
SELECT 'H-U1', 3, d - 1, 9309, 0, 0, 0.1, now() FROM h_day;
-- stored records of today (the batch path reads only inverters that hold one); H-A1's string 5 is
-- one a new write leaves out (kept by store_string_rows)
INSERT INTO growatt_inverter_readings (device_sn, timestamp, status, pac_w)
SELECT 'H-A1', d + time '08:30', 1, 1.0 FROM h_day UNION ALL
SELECT 'H-B1', d + time '07:00', 1, 5.0 FROM h_day;
INSERT INTO growatt_string_records (device_sn, timestamp, strings)
SELECT 'H-A1', d + time '08:30', '[[5,3,500.0,1.0],[1,1,1.0,1.0]]' FROM h_day;

INSERT INTO growatt_env_sensors (datalogger_sn, address, plant_id, synced_at, history_synced_until)
SELECT dl, addr, pid, now() - interval '2 days', hsu FROM (VALUES
  ('DL-H1', 1, 9301, (SELECT d FROM h_day) + time '06:00'),
  ('DL-H1', 2, 9301, NULL::timestamp),
  ('DL-H9', 1, 9309, (SELECT d FROM h_day) - 1 + time '17:00'),
  ('DL-H4', 1, 9401, NULL)) AS v(dl, addr, pid, hsu);
INSERT INTO growatt_meters (datalogger_sn, address, plant_id, synced_at, history_synced_until)
SELECT dl, addr, pid, now() - interval '2 days', hsu FROM (VALUES
  ('DL-H1', 36, 9301, NULL::timestamp),
  ('DL-H9', 5, 9309, (SELECT d FROM h_day) + time '07:00'),
  ('DL-H4', 40, 9401, NULL)) AS v(dl, addr, pid, hsu);

DROP TABLE h_day;
