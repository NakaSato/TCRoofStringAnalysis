-- Jobs growatt_energy / energy_backfill (services/growatt_energy.py) against growatt_stub.py
-- (`_energy`). Plants 4001-4004; day d = plant-local today - d. jobs.json gives phase 2 a token
-- too, so phase 1 takes 4001 and the untagged 4002 (and the retention plants), phase 2 takes
-- 4003 and 4004, whose 10012s end its sweep (3 in a row: partial).
CREATE TEMP TABLE t4 AS SELECT (now() AT TIME ZONE 'Asia/Bangkok')::date AS today;

INSERT INTO growatt_plants (plant_id, name, phase, synced_at) VALUES
  (4001, 'Energy plant A', 1, now()),
  (4002, 'Energy plant B (untagged)', NULL, now()),
  (4003, 'Energy plant C (refuses)', 2, now()),
  (4004, 'Energy plant D (refuses)', 2, now());

-- INV4001N is not installed: never asked
INSERT INTO growatt_inverters (device_sn, plant_id, synced_at, not_installed_at) VALUES
  ('INV4001A', 4001, now(), NULL), ('INV4001B', 4001, now(), NULL), ('INV4001N', 4001, now(), now()),
  ('INV4002A', 4002, now(), NULL), ('INV4003A', 4003, now(), NULL);

-- plant 4001: curve of day 1 already stored (not asked again), day 2 missing
INSERT INTO growatt_plant_power (plant_id, timestamp, power_w)
SELECT 4001, (t4.today - 1) + m * interval '1 minute', 500 FROM t4, (VALUES (600), (605)) x(m);
-- INV4001A day 2 stored: only day 1 asked
INSERT INTO growatt_inverter_energy_days (device_sn, day, plant_id, energy_kwh, synced_at)
SELECT 'INV4001A', t4.today - 2, 4001, 3.5, now() FROM t4;

-- plant 4001: day 3 re-read (updated), day 20 outside the 7-day window (kept as is)
INSERT INTO growatt_plant_energy_days (plant_id, day, energy_kwh, synced_at)
SELECT 4001, t4.today - d, d, now() FROM t4, (VALUES (3), (20)) x(d);
-- plant 4002: all of the last 40 days stored (energy_backfill with 40 days skips it)
INSERT INTO growatt_plant_energy_days (plant_id, day, energy_kwh, synced_at)
SELECT 4002, t4.today - d, 7, now() FROM t4, generate_series(1, 40) d;
