-- Parity seed for the "history" area: /growatt/plants/{id}/inverters/{sn}/timeseries|raw|daily and
-- /growatt/plants/{id}/strings/{sn}/{n}. Plants 3001 (assigned to the engineer) and 3002 (not).
-- Readings are naive Bangkok time, two days (2026-11-20 / 21), 5-minute records with drifting
-- seconds; plant 3001's inverter B reports twice per slot for part of the day.

INSERT INTO growatt_plants (plant_id, name, peak_power_kwp, latitude, longitude, synced_at) VALUES
  (3001, 'History plant A', 100.0, 13.75, 100.5, now()),
  (3002, 'History plant B', 3000.0, 14.0, 100.6, now());   -- 3000 kWp: implausible for 50 kW AC

INSERT INTO growatt_inverters (device_sn, plant_id, model, nominal_power_w, synced_at, not_installed_at, not_installed_by, not_installed_note) VALUES
  ('H3001A', 3001, 'MAX', 50000, now(), NULL, NULL, NULL),
  ('H3001B', 3001, 'MAX', 60000, now(), NULL, NULL, NULL),
  ('H3001X', 3001, 'MAX', NULL, now(), now(), 'admin', 'listed, not on the roof'),
  ('H3002A', 3002, 'MAX', 50000, now(), NULL, NULL, NULL);

INSERT INTO user_plant_assignments (user_id, plant_id, assigned_by, created_at)
SELECT id, 3001, 'parity', now() FROM users WHERE username = 'engineer';

-- String Layout: A's strings 1-3 have 18 modules (fleet module Wp), string 4 16 × 575 W
INSERT INTO growatt_string_layouts (device_sn, string_no, modules, module_wp, updated_at) VALUES
  ('H3001A', 1, 18, NULL, now()), ('H3001A', 2, 18, NULL, now()),
  ('H3001A', 3, 18, NULL, now()), ('H3001A', 4, 16, 575.0, now());

-- inverter records 06:00 → 17:55 (n = 0..143), seconds drift 0..2
INSERT INTO growatt_inverter_readings (device_sn, timestamp, status, pac_w, ppv_w, eac_today_kwh, eac_total_kwh, temperature_c)
SELECT sn, d + time '06:00' + n * interval '5 minutes' + (n % 3) * interval '1 second', 1,
       CASE WHEN sn = 'H3001A' AND n = 10 THEN NULL ELSE k * 50000.0 * sin(pi() * n / 143.0) END,
       k * 51234.5 * sin(pi() * n / 143.0),
       CASE WHEN n = 0 THEN NULL ELSE k * n * 0.3517 + extract(day from d) / 7.0 END,
       10000 + n,
       CASE WHEN n % 17 = 0 THEN NULL WHEN n = 5 THEN 0 ELSE 30 + 12.34 * sin(pi() * n / 143.0) END
FROM (VALUES ('H3001A', 1.0), ('H3001B', 0.83), ('H3002A', 0.9)) AS i(sn, k),
     (VALUES (date '2026-11-20'), (date '2026-11-21')) AS dd(d),
     generate_series(0, 143) AS n;
-- B: a second record in the same 5-minute slot between 10:00 and 11:00
INSERT INTO growatt_inverter_readings (device_sn, timestamp, status, pac_w, ppv_w, eac_today_kwh, temperature_c)
SELECT 'H3001B', d + time '06:02:30' + n * interval '5 minutes', 1,
       0.83 * 49000.0 * sin(pi() * n / 143.0), 0.83 * 50001.25 * sin(pi() * n / 143.0), NULL, 41.7
FROM (VALUES (date '2026-11-20'), (date '2026-11-21')) AS dd(d), generate_series(48, 59) AS n;
-- just after midnight A still carries yesterday's eac_today (the last record of the day counts)
INSERT INTO growatt_inverter_readings (device_sn, timestamp, status, pac_w, ppv_w, eac_today_kwh, temperature_c)
VALUES ('H3001A', '2026-11-21 00:02:00', 0, 0, 0, 77.7, 25.0);

-- string records while producing (n = 1..142): A 4 strings (string 3 weak), B 2, 3002's A 1
INSERT INTO growatt_string_records (device_sn, timestamp, strings)
SELECT sn, d + time '06:00' + n * interval '5 minutes' + (n % 3) * interval '1 second',
       CASE sn
         WHEN 'H3001A' THEN json_build_array(
           json_build_array(1, 1, 610.0 + 40 * sin(pi() * n / 143.0), 9.1 * sin(pi() * n / 143.0)),
           json_build_array(2, 1, 612.5 + 40 * sin(pi() * n / 143.0), 9.3 * sin(pi() * n / 143.0)),
           json_build_array(3, 2, 605.0 + 38 * sin(pi() * n / 143.0), 5.4 * sin(pi() * n / 143.0)),
           json_build_array(4, 2, 542.2 + 35 * sin(pi() * n / 143.0), 9.2 * sin(pi() * n / 143.0)))
         WHEN 'H3001B' THEN json_build_array(
           json_build_array(1, 1, 600.0 + 30 * sin(pi() * n / 143.0), 8.0 * sin(pi() * n / 143.0)),
           json_build_array(2, 1, 601.0 + 30 * sin(pi() * n / 143.0), 0.05))
         ELSE json_build_array(json_build_array(1, 1, 590.0 + 20 * sin(pi() * n / 143.0), 7.7 * sin(pi() * n / 143.0)))
       END
FROM (VALUES ('H3001A'), ('H3001B'), ('H3002A')) AS i(sn),
     (VALUES (date '2026-11-20'), (date '2026-11-21')) AS dd(d),
     generate_series(1, 142) AS n;

-- whole max_data records as Growatt reported them (only A, 21 Nov; one carries its own "time")
INSERT INTO growatt_inverter_raw (device_sn, timestamp, data) VALUES
  ('H3001A', '2026-11-21 10:00:01', '{"pac": 30123.4, "vpv1": 640.2, "status": 1, "faultType": 0, "serialNum": "H3001A"}'),
  ('H3001A', '2026-11-21 10:05:02', '{"pac": 30456.7, "vpv1": 641.0, "status": 1, "ipmTemperature": 41.5, "time": "2026-11-21 10:05:00"}'),
  ('H3001A', '2026-11-21 10:10:00', '{"pac": 0, "warnCode": 1, "nested": {"a": [1, 2.5]}, "ศัพท์": "ไทย"}'),
  ('H3001A', '2026-11-20 12:00:00', '{"pac": 1.0}');
