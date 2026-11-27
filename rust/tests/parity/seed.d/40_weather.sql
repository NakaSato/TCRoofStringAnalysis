-- Stored weather area (rust/crates/services/src/{weather,meter,curtailment,google_weather_stored}.rs):
-- weather sensors + readings, an energy meter, Google hourly rows, stored curtailment days.
-- Plant ids 4000–4999 only. 4001 and 4002 are assigned to the engineer; 4003 and 4004 are not.
--   4001: located (Google cell 13.76,100.50), two sensors, a meter, Google hours, curtailment days
--   4002: no location, no sensor, no meter, daily rows without curtailment judged
--   4003: one sensor (readings only on 2026-11-20, humidity probe never fitted), curtailment days
--   4004: located (another cell, no Google hours stored), a sensor without readings

INSERT INTO growatt_plants (plant_id, name, phase, latitude, longitude, peak_power_kwp, synced_at) VALUES
  (4001, 'Weather plant 4001', 1, 13.7563, 100.5018, 100.0, now()),
  (4002, 'Weather plant 4002', 2, NULL, NULL, 50.0, now()),
  (4003, 'Weather plant 4003', NULL, 14.0012, 100.6049, 80.0, now()),
  (4004, 'Weather plant 4004', 3, 15.12345, 101.98765, NULL, now());

INSERT INTO user_plant_assignments (user_id, plant_id, assigned_by, created_at)
SELECT id, p, 'parity', now() FROM users, unnest(ARRAY[4001, 4002]) AS p WHERE username = 'engineer';

INSERT INTO growatt_env_sensors (datalogger_sn, address, plant_id, device_name, synced_at) VALUES
  ('WXDL4001A', 1, 4001, 'Env A', now()),
  ('WXDL4001B', 2, 4001, NULL, now()),
  ('WXDL4003', 1, 4003, 'Env 4003', now()),
  ('WXDL4004', 7, 4004, 'Env 4004', now());

-- 4001 sensor A, 2026-11-21: every 5 min 05:30–18:30, a few records off the slot edge, a frozen
-- (stale) stretch 12:00–12:20, wind around north (circular mean), humidity measured
INSERT INTO growatt_env_readings (datalogger_sn, address, timestamp, irradiance_wm2, ambient_temp_c, module_temp_c, humidity_pct, wind_speed_ms, wind_dir_deg)
SELECT 'WXDL4001A', 1, ts,
       CASE WHEN ts BETWEEN '2026-11-21 12:00' AND '2026-11-21 12:20' THEN 812.5
            ELSE greatest(0, round((1050 * sin(pi() * (extract(epoch FROM ts - '2026-11-21 06:00'::timestamp) / 43200.0)))::numeric, 1)) END,
       26 + 6 * sin(pi() * (extract(epoch FROM ts - '2026-11-21 06:00'::timestamp) / 43200.0)),
       27 + 25 * greatest(0, sin(pi() * (extract(epoch FROM ts - '2026-11-21 06:00'::timestamp) / 43200.0))),
       70 - 20 * sin(pi() * (extract(epoch FROM ts - '2026-11-21 06:00'::timestamp) / 43200.0)),
       1.3 + (extract(minute FROM ts)::int % 4) * 0.7,
       CASE WHEN extract(minute FROM ts)::int % 10 = 0 THEN 350 ELSE 15 END
FROM generate_series('2026-11-21 05:30'::timestamp, '2026-11-21 18:30', interval '5 minutes') AS ts;
-- two records inside one slot (10:00 bucket gets 10:02:30 as well), and one at 13:01:10
INSERT INTO growatt_env_readings (datalogger_sn, address, timestamp, irradiance_wm2, ambient_temp_c, module_temp_c, humidity_pct, wind_speed_ms, wind_dir_deg) VALUES
  ('WXDL4001A', 1, '2026-11-21 10:02:30', 905.0, 30.1, 47.3, 55.0, 2.2, 5),
  ('WXDL4001A', 1, '2026-11-21 13:01:10', 990.0, 31.0, 50.2, 52.0, 3.1, 20);
-- 4001 sensor B, 2026-11-21: 07:00–17:00 every 10 min, no humidity probe (0 all day), module temp
-- missing (NULL) in the afternoon, wind direction opposite to A at some points
INSERT INTO growatt_env_readings (datalogger_sn, address, timestamp, irradiance_wm2, ambient_temp_c, module_temp_c, humidity_pct, wind_speed_ms, wind_dir_deg)
SELECT 'WXDL4001B', 2, ts,
       round((980 * sin(pi() * (extract(epoch FROM ts - '2026-11-21 06:00'::timestamp) / 43200.0)))::numeric, 0),
       27.5,
       CASE WHEN ts < '2026-11-21 14:00' THEN 40 + extract(hour FROM ts)::int ELSE NULL END,
       0,
       2.0,
       CASE WHEN extract(hour FROM ts)::int = 9 THEN 170 ELSE 10 END
FROM generate_series('2026-11-21 07:00'::timestamp, '2026-11-21 17:00', interval '10 minutes') AS ts;
-- 4001 sensor A on the day before (fewer readings, ambient only)
INSERT INTO growatt_env_readings (datalogger_sn, address, timestamp, irradiance_wm2, ambient_temp_c, module_temp_c, humidity_pct, wind_speed_ms, wind_dir_deg)
SELECT 'WXDL4001A', 1, ts, 400.0 + extract(minute FROM ts)::int, 29.0, 0, 0, 0, 0
FROM generate_series('2026-11-20 09:00'::timestamp, '2026-11-20 11:00', interval '5 minutes') AS ts;
-- 4003: 2026-11-20 only, humidity 0 all day
INSERT INTO growatt_env_readings (datalogger_sn, address, timestamp, irradiance_wm2, ambient_temp_c, module_temp_c, humidity_pct, wind_speed_ms, wind_dir_deg)
SELECT 'WXDL4003', 1, ts, 300.0 + 10 * extract(hour FROM ts)::int, 30.5, 45.25, 0, 1.15, 90
FROM generate_series('2026-11-20 08:00'::timestamp, '2026-11-20 16:00', interval '5 minutes') AS ts;

-- 4001 energy meter (DB part of growatt_meter; read by the overview / power ports)
INSERT INTO growatt_meters (datalogger_sn, address, plant_id, device_name, device_type, synced_at) VALUES
  ('WXDL4001A', 36, 4001, 'CHNT_THREE', '3', now());
INSERT INTO growatt_meter_readings (datalogger_sn, address, timestamp, active_power_w, import_counter_kwh)
SELECT 'WXDL4001A', 36, ts,
       CASE WHEN extract(hour FROM ts)::int BETWEEN 10 AND 14 THEN 800 ELSE 25000 END,
       1000 + extract(epoch FROM ts - '2026-11-21 00:00'::timestamp) / 3600.0
FROM generate_series('2026-11-21 00:00'::timestamp, '2026-11-21 23:55', interval '5 minutes') AS ts;

-- Google hourly rows (modelled), naive plant-local hours, cell of 4001 ("13.76,100.50"):
-- 2026-11-10 … 2026-11-21 daytime hours 05:00–19:00 (05 and 18/19 are outside the 06–18 window
-- and must not count); rain on 11-14 (3 mm) and 11-21 afternoon; 11-17 incomplete (4 hours)
INSERT INTO google_weather_hourly (cell_key, hour, condition, is_daytime, temp_c, feels_like_c, dew_point_c, humidity_pct,
  cloud_cover_pct, uv_index, precip_mm, precip_prob_pct, thunder_prob_pct, wind_speed_ms, wind_gust_ms, wind_dir_deg,
  pressure_hpa, visibility_km, fetched_at)
SELECT '13.76,100.50', h,
       CASE WHEN h::date = '2026-11-14' AND extract(hour FROM h)::int BETWEEN 13 AND 15 THEN 'RAIN'
            WHEN h::date = '2026-11-21' AND extract(hour FROM h)::int = 13 THEN 'THUNDERSHOWER'
            WHEN h::date = '2026-11-21' AND extract(hour FROM h)::int = 9 THEN 'CHANCE_OF_SHOWERS'
            WHEN extract(hour FROM h)::int % 3 = 0 THEN 'PARTLY_CLOUDY' ELSE 'CLEAR' END,
       extract(hour FROM h)::int BETWEEN 6 AND 17,
       24.5 + extract(hour FROM h)::int * 0.55, 26.0, 21.3, 66.0 + extract(hour FROM h)::int,
       CASE WHEN extract(hour FROM h)::int % 2 = 0 THEN 35 ELSE 62 END,
       greatest(0, 11 - abs(12 - extract(hour FROM h)::int)),
       CASE WHEN h::date = '2026-11-14' AND extract(hour FROM h)::int BETWEEN 13 AND 15 THEN 1.0
            WHEN h::date = '2026-11-21' AND extract(hour FROM h)::int = 14 THEN 0.35
            WHEN h::date = '2026-11-21' AND extract(hour FROM h)::int = 15 THEN 0.05
            ELSE 0 END,
       20, CASE WHEN h::date = '2026-11-21' THEN 45 ELSE 5 END, 2.5, 5.75 + extract(hour FROM h)::int * 0.1, 120,
       1009.8, 10.0, now()
FROM generate_series('2026-11-10 05:00'::timestamp, '2026-11-21 19:00', interval '1 hour') AS h
WHERE extract(hour FROM h)::int BETWEEN 5 AND 19
  AND (h::date <> '2026-11-17' OR extract(hour FROM h)::int BETWEEN 8 AND 11);
-- one hour with no values at all (null precip, null condition) on 11-20 at 12:00
UPDATE google_weather_hourly SET precip_mm = NULL, condition = NULL, temp_c = NULL
WHERE cell_key = '13.76,100.50' AND hour = '2026-11-20 12:00';
-- the newest stored hour is a night one on 11-22 (latest_day must still pick 11-21, complete)
INSERT INTO google_weather_hourly (cell_key, hour, condition, is_daytime, temp_c, precip_mm, fetched_at) VALUES
  ('13.76,100.50', '2026-11-22 03:00', 'CLEAR', false, 23.0, 0, now()),
  ('13.76,100.50', '2026-11-22 06:00', 'CLEAR', true, 23.5, 0, now());
-- another cell (not a fleet plant's) must not leak in
INSERT INTO google_weather_hourly (cell_key, hour, condition, is_daytime, temp_c, precip_mm, fetched_at) VALUES
  ('13.75,100.50', '2026-11-21 10:00', 'RAIN', true, 20.0, 9.0, now());

-- Stored curtailment days (growatt_plant_daily, written by growatt_daily in Python)
INSERT INTO growatt_plant_daily (plant_id, day, capacity_kwp, energy_kwh, filtered_slots, stale_masked_slots, clipped_masked_slots,
  curtailed_masked_slots, curtailed_kwh, curtailed_slots, curtail_judged_slots, curtailed_export_kwh, curtailed_limit_kwh,
  curtail_ratio, curtail_ratio_slots, curtail_ratio_source, curtailed_err_kwh, free_ratio, free_slots, shoulder_ratios, computed_at)
VALUES
  (4001, '2026-11-15', 100.0, 412.34, 80, 0, 0, 0, 0.0, 0, 90, 0.0, 0.0, 0.874, 40, 'plant', NULL, 0.88, 22, '{"8": [0.75, 5], "15": [0.8, 4]}', now()),
  (4001, '2026-11-16', 100.0, 380.0, 80, 0, 0, 6, 36.27, 6, 92, 30.11, 6.16, 0.861, 52, 'plant', 4.43, 0.86, 18, NULL, now()),
  (4001, '2026-11-17', 100.0, 401.5, 80, 0, 0, 3, 12.04, 3, 88, 12.04, 0.0, NULL, 52, NULL, NULL, NULL, 0, NULL, now()),
  (4001, '2026-11-18', 100.0, NULL, 0, 0, 0, 0, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, now()),
  (4001, '2026-11-21', 100.0, 455.05, 80, 0, 0, 8, 51.5, 8, 95, 51.5, 0.0, 0.9, 60, 'blend', 6.25, 0.91, 30, '{"8": [0.71, 6]}', now()),
  (4002, '2026-11-16', 50.0, 210.0, 0, 0, 0, 0, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, now()),
  (4002, '2026-11-21', 50.0, 205.4, 0, 0, 0, 0, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, now()),
  (4003, '2026-11-16', 80.0, 300.0, 60, 0, 0, 0, 0.0, 0, 70, 0.0, 0.0, 0.95, 10, 'fleet', 0.0, 0.93, 4, NULL, now()),
  (4003, '2026-11-20', 80.0, 310.25, 60, 0, 0, 2, 7.3, 2, 72, 0.0, 7.3, 0.95, 10, 'fleet', 1.1, 0.92, 5, NULL, now()),
  (4003, '2026-11-21', 80.0, 0.0, 60, 0, 0, 0, 0.0, 0, 72, 0.0, 0.0, 0.95, 12, 'fleet', NULL, NULL, 0, NULL, now()),
  -- a daily row of a plant missing from the registry is left out
  (4999, '2026-11-21', 10.0, 40.0, 0, 0, 0, 0, 5.0, 1, 10, 5.0, 0.0, NULL, NULL, NULL, NULL, NULL, NULL, NULL, now());
