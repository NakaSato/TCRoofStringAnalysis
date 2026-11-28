-- Push notifications: `push_test` (push.py `send_tests`), `faults_push` (fault_push.py
-- `notify_s1`) and the alarm push after `alarms` (push.py `notify_new_alarms`; jobs.json
-- `alarms_push`, phase 3 = the stub's AL6… serials in growatt_stub.py `push_alarms`). FCM and its
-- OAuth token server are rust/tests/worker_parity/fcm_stub.py; the token decides the answer:
-- "-gone" 404 UNREGISTERED, "-mismatch" 403 SENDER_ID_MISMATCH (both: token deleted),
-- "-bad" 400 INVALID_ARGUMENT (failed, kept), anything else accepted.
CREATE TEMP TABLE p AS SELECT (now() AT TIME ZONE 'Asia/Bangkok')::date AS today, (now() AT TIME ZONE 'Asia/Bangkok') AS lnow;

INSERT INTO users (id, username, email, full_name, hashed_password, role, is_active, store_keeper, created_at) VALUES
  (9101, 'push_admin', 'push_admin@example.invalid', 'Push Admin', 'x', 'admin', true, false, now()),
  (9102, 'push_eng', 'push_eng@example.invalid', 'Push Engineer', 'x', 'engineer', true, false, now()),
  (9103, NULL, 'push_eng2@example.invalid', 'Push Engineer 2', 'x', 'engineer', true, false, now()),  -- no plants
  (9104, 'push_off', 'push_off@example.invalid', 'Push Off', 'x', 'admin', false, false, now());       -- inactive
INSERT INTO user_plant_assignments (user_id, plant_id, created_at) VALUES (9102, 9701, now()), (9102, 9702, now());

INSERT INTO push_tokens (user_id, token, label, created_at, last_seen_at, test_requested_at) VALUES
  (9101, 'ptok-admin-a', 'Chrome', now() - interval '3 days', now() - interval '1 day', now() - interval '2 minutes'),
  (9101, 'ptok-admin-gone', 'Old phone', now() - interval '9 days', now() - interval '9 days', now() - interval '1 minute'),
  (9102, 'ptok-eng-a', 'Phone', now() - interval '2 days', now() - interval '2 days', now() - interval '30 minutes'),  -- too old: cleared, not sent
  (9102, 'ptok-eng-mismatch', 'Other app', now() - interval '5 days', now() - interval '5 days', NULL),
  (9102, 'ptok-eng-bad', 'Tablet', now() - interval '1 day', now() - interval '1 day', now() - interval '1 minute'),
  (9103, 'ptok-eng2', NULL, now() - interval '1 day', now() - interval '1 day', NULL),
  (9104, 'ptok-off', NULL, now() - interval '1 day', now() - interval '1 day', now() - interval '1 minute');  -- inactive: untouched

-- alarm push plants (phase 3: only the `alarms_push` case has a phase-3 account)
INSERT INTO growatt_plants (plant_id, name, phase, synced_at) VALUES
  (9701, 'Push plant A', 3, now()), (9702, 'Push plant B', 3, now()), (9703, 'Push C1', 3, now()),
  (9704, 'Push C2', 3, now()), (9705, 'Push C3', 3, now()), (9706, 'Push C4', 3, now()), (9707, 'Push C5', 3, now()),
  (9708, '', 3, now());  -- no name: "Plant 9708"
INSERT INTO growatt_inverters (device_sn, plant_id, alias, synced_at) VALUES
  ('AL6A1', 9701, 'INV 2', now()), ('AL6A2', 9701, 'AL6A2', now()), ('AL6NI', 9701, 'INV 9', now()),
  ('AL6B1', 9702, '(1)', now()), ('AL6B2', 9702, 'Inverter No.2', now()), ('AL6B3', 9702, 'INV03', now()),
  ('AL6C1', 9703, 'AL6C1', now()), ('AL6C2', 9704, NULL, now()), ('AL6C3', 9705, 'INV1', now()),
  ('AL6C4', 9706, NULL, now()), ('AL6C5', 9707, NULL, now()), ('AL6C6', 9708, NULL, now());
UPDATE growatt_inverters SET not_installed_at = now() WHERE device_sn = 'AL6NI';

-- what was pushed before: B1 this event (a mark newer than any stub record), B2 an older event
-- 30 min ago (inside PUSH_ALARM_REPEAT_MIN), B3 an older event 3 h ago; yesterday's mark is ignored
INSERT INTO alarm_push_marks (device_sn, alarm_code, day, event_start, pushed_at)
SELECT sn, code, d, ev, now() - m * interval '1 minute' FROM p, (VALUES
  ('AL6B1', '117', 0, 60, 5), ('AL6B2', '118', 0, -300, 30), ('AL6B3', '119', 0, -300, 180), ('AL6C1', '501', 1, -300, 900)) x(sn, code, back, evm, m),
  LATERAL (SELECT p.today - back AS d, p.lnow + evm * interval '1 minute' AS ev) y;

-- field faults (S1 pushes)
INSERT INTO field_faults (id, no, plant_id, kind, serial, position, symptom, how_found, found_at, severity, status,
                          s1_at, s1_pushed_at, evidence_urls, created_by, updated_by, created_at, updated_at) VALUES
  -- raised by push_eng: the engineer is not told, the admin is
  (9201, 'DF-2026-9201', 9701, 'dc_cable', NULL, '{"location": "Roof B, row 4"}', 'Melted MC4 connector, smoke marks', 'inspection',
   now() - interval '2 hours', 'S1', 'open', now() - interval '1 hour', NULL, '[]', 'push_eng', NULL, now(), now()),
  -- a plant not in the registry; raised (updated) by someone else
  (9202, 'DF-2026-9202', 9799, 'inverter', 'SN-77', NULL, repeat('Arc fault alarm and burning smell. ', 6), 'alarm',
   now() - interval '20 minutes', 'S1', 'diagnosed', now() - interval '10 minutes', NULL, '[]', 'push_admin', 'someone', now(), now()),
  (9203, 'DF-2026-9203', 9701, 'structure', NULL, NULL, 'too old', 'inspection', now() - interval '9 hours', 'S1', 'open',
   now() - interval '8 hours', NULL, '[]', NULL, NULL, now(), now()),
  (9204, 'DF-2026-9204', 9701, 'structure', NULL, NULL, 'pushed', 'inspection', now() - interval '1 hour', 'S1', 'open',
   now() - interval '1 hour', now() - interval '50 minutes', '[]', NULL, NULL, now(), now()),
  (9205, 'DF-2026-9205', 9702, 'structure', NULL, NULL, 'closed', 'inspection', now() - interval '1 hour', 'S1', 'closed',
   now() - interval '1 hour', NULL, '[]', NULL, NULL, now(), now()),
  (9206, 'DF-2026-9206', 9702, 'structure', NULL, NULL, 'not S1', 'inspection', now() - interval '1 hour', 'S2', 'open',
   NULL, NULL, '[]', NULL, NULL, now(), now()),
  -- assigned engineer and admin, no location: body = number, kind, symptom
  (9207, 'DF-2026-9207', 9702, 'ac_breaker', NULL, '{}', 'Breaker hot', 'inspection', now() - interval '1 hour', 'S1', 'monitor',
   now() - interval '5 hours', NULL, '[]', 'nobody', NULL, now(), now());
