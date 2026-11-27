-- Parity seed for the "plants" area (/growatt/plants, /plants/{id}/inverters, /overview, /power,
-- /sync/*). Plant ids 2000-2999 only. Reading times are naive plant-local (Bangkok) time; fixed
-- days (2026-11-25 / 26, plus a night record on 27) so both backends see the same data.
--   2001  phase 1, 120 kWp, 2 installed inverters (5-min and drifting 5-min records), one not
--         installed (with readings that must stay out), a weather sensor, a grid meter, Growatt's
--         own day / curve figures, string layout; assigned to the engineer
--   2002  phase 2, peak power impossible for its inverter (rejected), one inverter, few readings
--   2003  untagged phase, no coordinates, no inverters

INSERT INTO growatt_plants (plant_id, phase, name, city, country, latitude, longitude, peak_power_kwp, create_date,
                            timezone, address, growatt_inverter_count, growatt_datalogger_count, synced_at)
VALUES (2001, 1, 'Parity Roof A', 'Bangkok', 'Thailand', 13.75, 100.5, 120.0, '2024-03-01', 'GMT+7', '1 Parity Rd', 3, 1,
        '2026-11-26 23:10:05.123456+00'),
       (2002, 2, 'Parity Roof B', 'Chiang Mai', 'Thailand', 18.79, 98.98, 5000.0, '2024-05-02', NULL, NULL, NULL, NULL,
        '2026-11-26 23:10:06+00'),
       (2003, NULL, 'Parity Roof C', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, '2026-11-26 23:10:07+00');

INSERT INTO user_plant_assignments (user_id, plant_id, assigned_by, created_at)
SELECT id, 2001, 'parity', now() FROM users WHERE username = 'engineer';

INSERT INTO growatt_inverters (device_sn, plant_id, datalogger_sn, model, device_types, alias, nominal_power_w, fw_version,
                               inner_version, active_rate_pct, reactive_rate_pct, pf_setting, pf_model, export_limit,
                               export_limit_rate_pct, on_off, info_synced_at, power_limit_pct, power_limit_read_at,
                               device_model, datalogger_model, rated_power_w, growatt_created_at, history_synced_until,
                               not_installed_at, not_installed_by, not_installed_note, synced_at)
VALUES ('PAR2001A01', 2001, 'DLPAR2001', 'MAX 50KTL3 LV', 'inverter,max', 'INVERTER 1', 50000, 'TL1.0', 'ZB12', 100, 0, 1,
        0, 0, 0, 1, '2026-11-20 02:00:00+00', 90, '2026-11-26 03:40:00.5+00', 'MAX 50KTL3 LV', 'ShineMaster', 50000,
        '2024-03-01 10:11:12', '2026-11-27 00:02:00', NULL, NULL, NULL, '2026-11-26 23:10:05+00'),
       ('PAR2001A02', 2001, 'DLPAR2001', 'MAX 50KTL3 LV', 'inverter,max', 'INVERTER 2', 50000, 'TL1.0', NULL, NULL, NULL,
        NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, '2026-11-26 18:30:00', NULL, NULL, NULL,
        '2026-11-26 23:10:05+00'),
       ('PAR2001X99', 2001, 'DLPAR2001', 'MAX 50KTL3 LV', '', 'INVERTER 9', 50000, NULL, NULL, 80, NULL, NULL, NULL, NULL,
        NULL, NULL, NULL, NULL, NULL, NULL, NULL, 15000, NULL, NULL, '2026-11-20 05:00:00+00', 'admin', 'listed, not on the roof',
        '2026-11-26 23:10:05+00'),
       ('PAR2002B01', 2002, 'DLPAR2002', 'MAX 20KTL3', 'inverter', NULL, 20000, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
        NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, '2026-11-26 23:10:06+00');

-- inverter records: a sine day 06:00-18:30, A01 every 5 min on the minute, A02 drifting 2.5 min
-- late (slot edges), the not-installed X99 a few records that must not count; a night standby
-- record after midnight carrying yesterday's eac_today (midnight carry-over)
WITH slots AS (
  SELECT d::date AS day, sn, ts
  FROM generate_series('2026-11-25'::date, '2026-11-26'::date, interval '1 day') AS d,
       (VALUES ('PAR2001A01', interval '0'), ('PAR2001A02', interval '150 seconds'), ('PAR2001X99', interval '0')) AS i(sn, off),
       generate_series(d + interval '6 hours' + off, d + interval '18 hours 30 minutes', interval '5 minutes') AS ts
), vals AS (
  SELECT day, sn, ts,
         greatest(0, sin(pi() * extract(epoch FROM ts - (day + interval '6 hours')) / 45000.0)) AS x,
         CASE WHEN sn = 'PAR2001A02' THEN 0.9 ELSE 1.0 END * CASE WHEN day = '2026-11-26' THEN 1.0 ELSE 0.8 END AS k
  FROM slots
  WHERE sn <> 'PAR2001X99' OR extract(hour FROM ts) BETWEEN 10 AND 11
)
INSERT INTO growatt_inverter_readings (device_sn, timestamp, status, pac_w, ppv_w, eac_today_kwh, eac_total_kwh,
                                       temperature_c, fac_hz, mppt_json, fault_code, warn_code)
SELECT sn, ts, CASE WHEN x > 0 THEN 1 ELSE 0 END,
       round((42000 * k * x)::numeric, 1)::float8,
       round((43500 * k * x)::numeric, 1)::float8,
       round((42 * k * 12.5 / pi() * (1 - cos(pi() * extract(epoch FROM ts - (day + interval '6 hours')) / 45000.0)))::numeric, 1)::float8,
       round((150000 + extract(day FROM day) * 300 + 42 * k * 12.5 / pi() * (1 - cos(pi() * extract(epoch FROM ts - (day + interval '6 hours')) / 45000.0)))::numeric, 1)::float8,
       CASE WHEN x > 0 THEN round((30 + 25 * x)::numeric, 1)::float8 ELSE NULL END,
       CASE WHEN x > 0.05 THEN 50.0 + (extract(minute FROM ts)::int % 3) * 0.01 ELSE 0 END,
       json_build_array(json_build_array(1, round((620 * (0.9 + 0.1 * x))::numeric, 1), round((36 * k * x)::numeric, 2), round((620 * 36 * k * x)::numeric, 1)),
                        json_build_array(2, round((610 * (0.9 + 0.1 * x))::numeric, 1), round((35 * k * x)::numeric, 2), round((610 * 35 * k * x)::numeric, 1))),
       NULL, NULL
FROM vals;

INSERT INTO growatt_inverter_readings (device_sn, timestamp, status, pac_w, ppv_w, eac_today_kwh, eac_total_kwh, temperature_c, fac_hz, mppt_json)
VALUES ('PAR2001A01', '2026-11-27 00:02:00', 0, 0, 0, 321.4, 158100.0, NULL, 0, NULL),
       ('PAR2002B01', '2026-11-26 11:00:00', 1, 15000, 15500, 40.2, 9000.5, 41.5, 50.01, '[[1,600.1,12.5,7500.0]]'),
       ('PAR2002B01', '2026-11-26 11:05:00', 1, 15200, 15700, 41.4, 9001.7, 41.9, 50.02, '[[1,601.1,12.7,7634.0]]'),
       ('PAR2002B01', '2026-11-26 11:20:00', 1, 14800, 15300, 45.2, 9005.5, 42.2, 49.99, '[[1,599.0,12.3,7368.0]]');

-- per-string records while producing: 4 inputs each; A01 input 4 never carries current (no
-- layout row: inactive), A02 input 3 at 70 % (a weak string)
INSERT INTO growatt_string_records (device_sn, timestamp, strings)
SELECT device_sn, timestamp,
       json_build_array(
         json_build_array(1, 1, round((620 * (0.9 + 0.1 * r))::numeric, 1), round((9.0 * r)::numeric, 2)),
         json_build_array(2, 1, round((620 * (0.9 + 0.1 * r))::numeric, 1), round((9.1 * r)::numeric, 2)),
         json_build_array(3, 2, round((610 * (0.9 + 0.1 * r))::numeric, 1),
                          round((9.0 * r * CASE WHEN device_sn = 'PAR2001A02' THEN 0.7 ELSE 1.0 END)::numeric, 2)),
         json_build_array(4, 2, round((610 * (0.9 + 0.1 * r))::numeric, 1),
                          CASE WHEN device_sn = 'PAR2001A01' THEN 0.0 ELSE round((8.9 * r)::numeric, 2) END))
FROM (SELECT device_sn, timestamp, ppv_w / 43500.0 AS r FROM growatt_inverter_readings
      WHERE device_sn IN ('PAR2001A01', 'PAR2001A02') AND ppv_w > 0) s;

INSERT INTO growatt_string_layouts (device_sn, string_no, modules, module_wp, updated_at)
VALUES ('PAR2001A01', 1, 18, NULL, now()), ('PAR2001A01', 2, 18, NULL, now()), ('PAR2001A01', 3, 17, NULL, now());

-- weather sensor on plant 2001: POA follows the same day shape; humidity probe not fitted (0)
INSERT INTO growatt_env_sensors (datalogger_sn, address, plant_id, device_name, history_synced_until, synced_at)
VALUES ('DLPAR2001', 1, 2001, 'Weather 1', '2026-11-26 18:30:00', '2026-11-26 23:10:05+00');
INSERT INTO growatt_env_readings (datalogger_sn, address, timestamp, irradiance_wm2, ambient_temp_c, module_temp_c,
                                  humidity_pct, wind_speed_ms, wind_dir_deg)
SELECT 'DLPAR2001', 1, ts,
       round((980 * greatest(0, sin(pi() * extract(epoch FROM ts - (ts::date + interval '6 hours')) / 45000.0)))::numeric, 1)::float8,
       round((27 + 6 * greatest(0, sin(pi() * extract(epoch FROM ts - (ts::date + interval '6 hours')) / 45000.0)))::numeric, 1)::float8,
       round((28 + 30 * greatest(0, sin(pi() * extract(epoch FROM ts - (ts::date + interval '6 hours')) / 45000.0)))::numeric, 1)::float8,
       0, 1.5, 180
FROM generate_series('2026-11-25 06:00'::timestamp, '2026-11-26 18:30'::timestamp, interval '5 minutes') AS ts
WHERE extract(hour FROM ts) BETWEEN 6 AND 18;

-- grid meter at the connection point: import all day (above the zero-export band, so not curtailed), counter rising
INSERT INTO growatt_meters (datalogger_sn, address, plant_id, device_name, device_type, history_synced_until, synced_at)
VALUES ('DLPAR2001', 36, 2001, 'CHNT_THREE', '1', '2026-11-26 23:55:00', '2026-11-26 23:10:05+00');
INSERT INTO growatt_meter_readings (datalogger_sn, address, timestamp, active_power_w, import_counter_kwh, frequency_hz)
SELECT 'DLPAR2001', 36, ts,
       CASE WHEN extract(hour FROM ts) BETWEEN 7 AND 17 THEN 25000 ELSE 18000 END,
       round((5000 + extract(epoch FROM ts - '2026-11-25'::timestamp) / 3600.0 * 9)::numeric, 1)::float8,
       50.0
FROM generate_series('2026-11-25 00:00'::timestamp, '2026-11-26 23:55'::timestamp, interval '5 minutes') AS ts;

-- Growatt's own figures (finished days); 2002's day is above 10 kWh/kWp of nothing (no capacity)
INSERT INTO growatt_plant_energy_days (plant_id, day, energy_kwh, synced_at)
VALUES (2001, '2026-11-25', 520.4, now()), (2001, '2026-11-26', 99999.0, now()), (2002, '2026-11-26', 120.5, now());
INSERT INTO growatt_inverter_energy_days (device_sn, day, plant_id, energy_kwh, synced_at)
VALUES ('PAR2001A01', '2026-11-25', 2001, 270.1, now()), ('PAR2001A02', '2026-11-25', 2001, 245.3, now()),
       ('PAR2001A01', '2026-11-26', 2001, 335.0, now());
INSERT INTO growatt_plant_power (plant_id, timestamp, power_w)
SELECT 2001, ts, round((80000 * greatest(0, sin(pi() * extract(epoch FROM ts - (ts::date + interval '6 hours')) / 45000.0)))::numeric, 1)::float8
FROM generate_series('2026-11-25 06:00'::timestamp, '2026-11-25 18:30'::timestamp, interval '5 minutes') AS ts;

-- worker runs: a queued one for `fleet` (POST answers 409), a stale queued `backfill` (failed by
-- the next POST), a finished `alarms`
INSERT INTO sync_runs (job, trigger, status, started_at, finished_at, detail_json, error)
VALUES ('fleet', 'api', 'queued', now() - interval '3 minutes', NULL, NULL, NULL),
       ('backfill', 'api', 'queued', now() - interval '3 hours', NULL, NULL, NULL),
       ('alarms', 'schedule', 'partial', now() - interval '40 minutes', now() - interval '38 minutes',
        '{"phases": {"1": {"read": 12}}, "push": {"sent": 0}}', 'phase 2: 10012');

-- R16 sensor evidence for 2001 on 26 Nov (frozen readings: the verdict flags `stale`), a clean
-- day on 25 Nov, and a fitted EPI factor for 2001 (2002 keeps the default; its row is rejected)
INSERT INTO growatt_plant_daily (plant_id, day, filtered_slots, stale_masked_slots, clipped_masked_slots, curtailed_masked_slots,
                                 sensor_stale_slots, sensor_high_slots, sensor_neighbour_ratio, cloud_midday_pct, computed_at)
VALUES (2001, '2026-11-26', 0, 0, 0, 0, 14, 2, 0.55, 12.0, now()),
       (2001, '2026-11-25', 0, 0, 0, 0, 0, NULL, 0.95, 60.0, now());
INSERT INTO growatt_plant_epi_fit (plant_id, status, factor, spread_pct, days_used, candidate_days, start_day, end_day,
                                   min_clearness, reason, fitted_at)
VALUES (2001, 'fitted', 0.962, 2.4, 10, 31, '2026-10-01', '2026-11-20', 0.74, NULL, '2026-11-21 17:45:00.25+00'),
       (2002, 'rejected', 1.31, 9.5, 10, 12, '2026-10-05', '2026-11-20', 0.71, 'factor outside 0.5-1.2', '2026-11-21 17:45:00+00');
