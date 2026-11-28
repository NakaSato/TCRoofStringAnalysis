-- `google_weather` (jobs.py `job_google_weather`, google_weather.py `sync_history`), applied to the
-- google_weather copies only. Every other seeded plant loses its coordinates (no cell), then:
--   9801 + 9802 share cell 13.75,100.50 (stored hours 89-91 days old from 10_retention.sql)
--   9803 cell 14.00,100.60, stored hours from 2 days ago
--   9804 cell 15.00,101.00: the stub answers HTTP 500
--   9805 cell 16.00,102.00, stored hours from today 06:00 (the freshest: left over by the budget)
--   9806 no coordinates
-- Today's budget leaves 3 history calls (google_weather_current calls counted today = today's
-- allowance − 3, computed for the current US/Pacific billing day and month), so the order is
-- 15.00,101.00 (nothing stored), 13.75,100.50, 14.00,100.60; 16.00,102.00 is skipped.
CREATE TEMP TABLE b AS
SELECT d AS bday, ((date_trunc('month', d) + interval '1 month')::date - d) AS days_left
FROM (SELECT (now() AT TIME ZONE 'America/Los_Angeles')::date AS d) x;

UPDATE growatt_plants SET latitude = NULL, longitude = NULL;
INSERT INTO growatt_plants (plant_id, name, phase, latitude, longitude, synced_at) VALUES
  (9801, 'GW One', 1, 13.7512, 100.5013, now()),
  (9802, 'GW Two', 1, 13.7488, 100.4987, now()),
  (9803, 'GW Three', 1, 14.0, 100.6, now()),
  (9804, 'GW Four', 1, 15.0, 101.0, now()),
  (9805, 'GW Five', 1, 16.0, 102.0, now()),
  (9806, 'GW Six', 1, NULL, NULL, now());

INSERT INTO google_weather_hourly (cell_key, hour, fetched_at, condition, precip_mm)
SELECT c, (now() AT TIME ZONE 'Asia/Bangkok')::date - d + h * interval '1 hour', now(), 'CLEAR', 0 FROM (VALUES
  ('14.00,100.60', 2, 9), ('14.00,100.60', 2, 10), ('16.00,102.00', 0, 6)) x(c, d, h);
-- a stored hour inside the stub's day (2026-11-27 07:00) is replaced by the fetch
INSERT INTO google_weather_hourly (cell_key, hour, fetched_at, condition, precip_mm, temp_c)
VALUES ('14.00,100.60', '2026-11-27 07:00', now(), 'OLD', 9.9, 99);

INSERT INTO external_api_call_counts (api, day, calls)
SELECT 'google_weather_current', bday::text, 30000 / days_left - 3 FROM b;
INSERT INTO external_api_call_counts (api, day, calls)
SELECT 'google_weather_history_hours', bday::text, 100 FROM b;
