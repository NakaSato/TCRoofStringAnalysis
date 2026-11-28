-- `google_weather` when Google's per-day quota is used up: the only cell (17.00,99.00) answers
-- HTTP 429, so every call failed (the run fails) and the refused call is not counted.
UPDATE growatt_plants SET latitude = NULL, longitude = NULL;
INSERT INTO growatt_plants (plant_id, name, phase, latitude, longitude, synced_at) VALUES
  (9811, 'GW Quota', 1, 17.0, 99.0, now());
