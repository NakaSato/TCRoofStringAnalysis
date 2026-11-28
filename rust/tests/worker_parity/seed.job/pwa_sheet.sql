-- `pwa_sheet` (jobs.py `job_pwa_sheet`, pwa_sheet.py `fill_day`, pwa_report.py `build`), applied to
-- the pwa_sheet copies only. The Firestore day docs and the sheets come from google_stub.py.
-- Plants 9721-9726: rows of the stub's day tabs by datalogger SN (Delta by its name).
--   9721 Firestore doc with check slots 09 / 13 (its frozen 09 differs: Firestore wins)
--   9722 no Firestore doc: frozen 09 and 13 come from SQL (has a weather sensor)
--   9723 older Firestore doc (hourly curve, weather / Google slots) + a frozen 09 from SQL
--   9724 its only inverter is not installed (not active); sheet row matched by name
--   9725 no coordinates, Firestore 09 with every inverter offline
--   9726 its only inverter is named replaced ("old"): not active, no doc
-- Every other seeded inverter is marked not installed here, so hour 09 is frozen for every active
-- plant (ready from SQL) and 13 only for 9722 (ready from Firestore's checks_ready).
CREATE TEMP TABLE t AS SELECT (now() AT TIME ZONE 'Asia/Bangkok')::date AS today;

UPDATE growatt_inverters SET not_installed_at = now() WHERE not_installed_at IS NULL;

INSERT INTO growatt_plants (plant_id, name, phase, latitude, longitude, synced_at) VALUES
  (9721, 'PWA Alpha', 1, 13.7512, 100.5013, now()),
  (9722, 'PWA Bravo', 1, 14.02, 100.61, now()),
  (9723, 'PWA Charlie', 1, 18.79, 98.98, now()),
  (9724, 'PWA Delta', 1, 12.9, 101.1, now()),
  (9725, 'PWA Echo', 1, NULL, NULL, now()),
  (9726, 'PWA Foxtrot', 1, 15.2, 104.8, now());
INSERT INTO growatt_inverters (device_sn, plant_id, datalogger_sn, alias, fw_version, inner_version, synced_at) VALUES
  ('PWA1A', 9721, 'PWADL01', 'INV1', 'FW1', 'IN1', now()),
  ('PWA1B', 9721, 'PWADL01', 'INV2', 'FW2', '', now()),
  ('PWA2A', 9722, 'PWADL02', 'Inverter 1', NULL, NULL, now()),
  ('PWA3A', 9723, 'PWADL03', 'INV1', 'FWX', NULL, now()),
  ('PWA4A', 9724, 'PWADL04', 'INV1', 'FWD', NULL, now()),
  ('PWA5A', 9725, 'PWADL05', 'INV1', NULL, NULL, now()),
  ('PWA6A', 9726, 'PWADL06', 'INV1 old', 'FWF', NULL, now());
UPDATE growatt_inverters SET not_installed_at = now() WHERE device_sn = 'PWA4A';
INSERT INTO growatt_env_sensors (datalogger_sn, address, plant_id, synced_at) VALUES ('PWADL02', 1, 9722, now());

INSERT INTO pwa_check_slots (day, plant_id, hour, slot_json, built_at)
SELECT t.today, pid, h, s::json, now() FROM t, (VALUES
  (9721, 9, '{"at": "08:50", "kw": 99.9, "irradiance_wm2": 100, "sensor_at": "08:45", "module_temp_c": null, "inverters": 2, "offline": [], "fault": [], "alarms": [], "errors": [], "issues": [], "reading_at": null, "google": null}'),
  (9722, 9, '{"at": "08:50", "kw": 15.5, "irradiance_wm2": 450.5, "sensor_at": "08:45", "module_temp_c": null, "google": null, "inverters": 1, "offline": [], "fault": ["INV1"], "alarms": [], "errors": [], "issues": [{"inv": "INV1", "state": "Fault", "items": [{"code": "1"}, {"code": 203, "message": null, "since": "08:10", "count": 2}]}], "reading_at": null}'),
  (9722, 13, '{"at": "12:50", "kw": 0, "irradiance_wm2": 802, "sensor_at": "12:45", "module_temp_c": null, "google": {"raining": false, "condition": "WINDY", "cloud_cover_pct": 55}, "inverters": 1, "offline": [], "fault": [], "alarms": [], "errors": [], "issues": [], "reading_at": null}'),
  (9723, 9, '{"at": "08:45", "kw": 33.333, "irradiance_wm2": 380, "sensor_at": "08:45", "module_temp_c": null, "google": {"raining": false, "condition": "CLEAR"}, "inverters": 1, "offline": [], "fault": [], "alarms": ["A1"], "errors": null, "issues": null, "reading_at": null}'),
  (9725, 9, '{"at": "08:50", "kw": 1.0, "inverters": 1, "offline": [], "fault": [], "alarms": [], "errors": [], "issues": [], "reading_at": null, "irradiance_wm2": null, "module_temp_c": null, "sensor_at": null, "google": null}')
) x(pid, h, s);
