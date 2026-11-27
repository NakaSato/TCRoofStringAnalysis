-- Live weather / rain cases (cases.d/75_live_weather.json, weather_modes/*.json): plants 7501-7599.
-- Two plants share one Google Weather grid cell (7501, 7502), one in the north (wet in the stub),
-- one in the south (light rain, the nowcast fails), one without coordinates and one at 0,0
-- (Growatt's "not set").
INSERT INTO growatt_plants (plant_id, name, phase, latitude, longitude, synced_at) VALUES
  (7501, 'Weather live A', 1, 13.7563, 100.5018, now()),
  (7502, 'Weather live A2', 1, 13.7581, 100.5021, now()),
  (7503, 'Weather live north', 2, 18.7883, 98.9853, now()),
  (7504, 'Weather live no coordinates', 1, NULL, NULL, now()),
  (7505, 'Weather live zero', 1, 0.0, 0.0, now()),
  (7506, 'Weather live south', 3, 7.0086, 100.4747, now());
