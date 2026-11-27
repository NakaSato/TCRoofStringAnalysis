-- `alarms` / `alarms_yesterday` (jobs.py `job_alarms`, `job_alarms_yesterday`; growatt_alarms.py
-- `sync_alarms`, `inverter_tiers`) with the default tiers: hot 10, warm 30, cold 60 min, tick 10.
-- Plants 9601 (phase 1), 9602 (no phase: goes with the first account), 9603 (phase 2: no account
-- in the harness, never read). Serials AL5… get their answers from growatt_stub.py `worker_alarms`.
-- Sync ages keep a few minutes away from every tier boundary (the two workers run one after the other).
CREATE TEMP TABLE a AS SELECT (now() AT TIME ZONE 'Asia/Bangkok')::date AS today, (now() AT TIME ZONE 'Asia/Bangkok') AS lnow;

INSERT INTO growatt_plants (plant_id, name, phase, synced_at) VALUES
  (9601, 'Alarm plant A', 1, now()), (9602, 'Alarm plant B', NULL, now()), (9603, 'Alarm plant C', 2, now());
INSERT INTO growatt_inverters (device_sn, plant_id, synced_at) VALUES
  ('AL5HOT1', 9601, now()),  -- open alarm (no end), read 15 min ago: hot, due
  ('AL5HOT2', 9601, now()),  -- closed alarms, newest reading status 3 (fault), read 14 min ago: hot, due
  ('AL5HOT3', 9601, now()),  -- alarm reported 5 min before the last read (ongoing), read 25 min ago: hot, due
  ('AL5HOT4', 9601, now()),  -- fault status, read 4 min ago: hot, not due
  ('AL5WRM1', 9601, now()),  -- closed alarms, read 40 min ago: warm, due
  ('AL5WRM2', 9601, now()),  -- closed alarms, read 20 min ago: warm, not due
  ('AL5CLD1', 9601, now()),  -- no alarms, read 95 min ago: cold, due (cap)
  ('AL5CLD2', 9601, now()),  -- no alarms, read 80 min ago: cold, due (cap)
  ('AL5CLD3', 9602, now()),  -- no alarms, read 70 min ago: cold, due (cap)
  ('AL5CLD6', 9602, now()), ('AL5CLD7', 9602, now()),  -- read 75 / 72 min ago: cold, due (cap)
  ('AL5CLD8', 9602, now()),  -- read 68 min ago: cold, due but over the cold cap (19 cold: cap ceil(1.5 x 19 x 10/60) = 5)
  ('AL5CLD4', 9602, now()),  -- no alarms, read 20 min ago: cold, not due
  ('AL5CLD5', 9602, now()),  -- never read today: always due, not capped
  ('AL5ODD1', 9602, now()),  -- odd record values
  ('AL5BAD1', 9602, now()),  -- a record that is not an object: store fails
  ('AL5PAGE', 9602, now()),  -- 150 records over two pages
  ('AL5RL0', 9602, now()),   -- always refused (10012)
  ('AL5RL1', 9602, now()), ('AL5RL2', 9602, now()), ('AL5RL3', 9602, now()), ('AL5RL4', 9602, now()),
  ('AL5NI1', 9601, now()),   -- not installed: never read
  ('AL5P2A', 9603, now());   -- phase 2: no account
UPDATE growatt_inverters SET not_installed_at = now() WHERE device_sn = 'AL5NI1';

-- today's sync stamps and stored alarms
INSERT INTO growatt_alarm_syncs (device_sn, day, plant_id, synced_at, alarm_count)
SELECT sn, a.today, pid, now() - m * interval '1 minute', n FROM a, (VALUES
  ('AL5HOT1', 9601, 15, 1), ('AL5HOT2', 9601, 14, 1), ('AL5HOT3', 9601, 25, 1), ('AL5HOT4', 9601, 4, 0),
  ('AL5WRM1', 9601, 40, 2), ('AL5WRM2', 9601, 20, 1),
  ('AL5CLD1', 9601, 95, 0), ('AL5CLD2', 9601, 80, 0), ('AL5CLD3', 9602, 70, 0), ('AL5CLD4', 9602, 20, 0),
  ('AL5CLD6', 9602, 75, 0), ('AL5CLD7', 9602, 72, 0), ('AL5CLD8', 9602, 68, 0),
  ('AL5NI1', 9601, 300, 0), ('AL5P2A', 9603, 300, 0)) x(sn, pid, m, n);

INSERT INTO growatt_alarms (device_sn, plant_id, day, start_time, end_time, alarm_code, alarm_message, fault_type, status)
SELECT sn, pid, a.today, a.lnow - s * interval '1 minute', CASE WHEN e IS NULL THEN NULL ELSE a.lnow - e * interval '1 minute' END,
       code, 'seeded', 'Warning', 0
FROM a, (VALUES
  ('AL5HOT1', 9601, 120, NULL::int, '117'),
  ('AL5HOT2', 9601, 200, 190, '202'),
  ('AL5HOT3', 9601, 30, 30, '305'),       -- the last read was 25 min ago: reported 5 min before it
  ('AL5WRM1', 9601, 300, 290, '202'), ('AL5WRM1', 9601, 280, 275, '202'),
  ('AL5WRM2', 9601, 200, 195, '202'),
  ('AL5P2A', 9603, 100, NULL, '117')) x(sn, pid, s, e, code);

-- newest reading of the day: fault (3) for HOT2 / HOT4; an older fault then normal for WRM1
-- (kept inside today even just after midnight: no earlier than today 00:30)
INSERT INTO growatt_inverter_readings (device_sn, timestamp, status)
SELECT sn, greatest(date_trunc('minute', a.lnow), a.today + interval '30 minutes') - m * interval '1 minute', st FROM a, (VALUES
  ('AL5HOT2', 3, 3), ('AL5HOT2', 8, 1), ('AL5HOT4', 3, 3), ('AL5WRM1', 13, 3), ('AL5WRM1', 3, 1)) x(sn, m, st);

-- yesterday: the AL5RL* serials were read last (newest stamps), so the refusals end the sweep there
INSERT INTO growatt_alarm_syncs (device_sn, day, plant_id, synced_at, alarm_count)
SELECT sn, a.today - 1, 9602, now() - m * interval '1 minute', 0 FROM a, (VALUES
  ('AL5RL1', 40), ('AL5RL2', 30), ('AL5RL3', 20), ('AL5RL4', 10)) x(sn, m);
INSERT INTO growatt_alarms (device_sn, plant_id, day, start_time, alarm_code)
SELECT 'AL5CLD1', 9601, a.today - 1, a.today - 1 + interval '18 hours', '117' FROM a;
