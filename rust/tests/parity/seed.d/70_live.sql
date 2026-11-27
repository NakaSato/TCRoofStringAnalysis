-- Growatt live routes (/growatt/live/*, cases.d/70_live.json): registry rows only, plant ids 7000-7999.
-- The live values come from the stub Growatt server (growatt_stub.py), never from SQL.
INSERT INTO growatt_plants (plant_id, name, phase, latitude, longitude, synced_at) VALUES
  (7001, 'Live A', 1, 13.75, 100.5, now()),
  (7002, 'Live B', 1, NULL, NULL, now()),
  (7003, 'Live C', NULL, 14.0, 100.6, now()),
  (7004, 'Live D', 2, NULL, NULL, now()),
  (7005, 'Live E', 1, 13.9, 100.4, now());

INSERT INTO growatt_inverters (device_sn, plant_id, synced_at, not_installed_at) VALUES
  ('INV7001A', 7001, now(), NULL),
  ('INV7001B', 7001, now(), NULL),
  ('INV7001X', 7001, now(), now()),
  ('INV7002A', 7002, now(), NULL),
  ('INV7004Z', 7004, now(), NULL),
  ('INV7005A', 7005, now(), NULL),
  ('INV7005B', 7005, now(), NULL);

INSERT INTO growatt_string_layouts (device_sn, string_no, modules, updated_at)
SELECT 'INV7001B', n, 20, now() FROM generate_series(1, 4) AS n;

INSERT INTO user_plant_assignments (user_id, plant_id, assigned_by, created_at)
SELECT id, 7001, 'parity', now() FROM users WHERE username = 'engineer';
