-- Fleet config area (routes/growatt/fleet_config.rs): fleet module, string layout, the "not
-- installed" mark, tariff and plant documents. Plant ids 6000–6999 only.
--   6001 Config Alpha (phase 1): 3 inverters (MAX 125KTL3-X LV with a layout and a removed
--        input, a MAX 80KTL3 LV without one, MID 40KTL3-X marked not installed), string records
--        of today (inputs 1–4 with current, input 5 at 0 A), AC power today on- and off-peak,
--        two active issues and a closed one on CFGA0002, a PWA meter site, a matched as-built link
--   6002 Config Beta (phase 2, engineer): one inverter of a model not in the catalog, no records,
--        a PWA meter site, a manual site-photos link
--   6003 config gamma (no phase, engineer): no inverters

INSERT INTO growatt_plants (plant_id, phase, name, city, peak_power_kwp, synced_at)
VALUES (6001, 1, 'Config Alpha', 'Bangkok', 250, now()),
       (6002, 2, 'Config Beta', NULL, 60, now()),
       (6003, NULL, 'config gamma', NULL, NULL, now());

INSERT INTO user_plant_assignments (user_id, plant_id, assigned_by, created_at)
SELECT id, p, 'parity', now() FROM users, unnest(ARRAY[6002, 6003]) AS p WHERE username = 'engineer';

CREATE TEMP TABLE d60 AS SELECT (now() AT TIME ZONE 'Asia/Bangkok')::date AS today;

INSERT INTO growatt_inverters (device_sn, plant_id, datalogger_sn, model, device_types, alias, nominal_power_w,
    rated_power_w, device_model, not_installed_at, not_installed_by, not_installed_note, synced_at)
VALUES ('CFGA0001', 6001, 'DL6001', 'MAX 125KTL3-X LV', 'max,inv', 'INV 1', 125000.0, NULL, 'MAX 125KTL3-X LV',
        NULL, NULL, NULL, '2026-11-20 03:00:00+00'),
       ('CFGA0002', 6001, 'DL6001', 'MAX 80KTL3 LV', NULL, NULL, 80000.0, 80000.0, 'MAX80KTL3LV',
        NULL, NULL, NULL, '2026-11-20 03:00:00+00'),
       ('CFGA0003', 6001, NULL, NULL, '', NULL, NULL, NULL, 'MID 40KTL3-X',
        '2026-11-01 02:00:00.123456+00', 'admin', 'never installed', '2026-11-20 03:00:00+00'),
       ('CFGB0001', 6002, 'DL6002', 'MAX 50KTL3 LV', NULL, 'B1', 50000.0, NULL, 'MAX 50KTL3 LV',
        NULL, NULL, NULL, '2026-11-20 03:00:00+00');

INSERT INTO growatt_string_layouts (device_sn, string_no, modules, module_wp, azimuth_deg, tilt_deg, updated_at)
VALUES ('CFGA0001', 1, 18, NULL, 180.0, 10.0, now()),
       ('CFGA0001', 2, 16, 580.0, NULL, NULL, now()),
       ('CFGA0001', 7, 18, NULL, NULL, NULL, now());
INSERT INTO growatt_string_removed (device_sn, string_no, removed_at) VALUES ('CFGA0001', 4, now());

-- string records of today, every 5 min 10:00–11:00: [string_no, mppt_no, voltage, current]
INSERT INTO growatt_string_records (device_sn, timestamp, strings)
SELECT 'CFGA0001', (SELECT today FROM d60) + time '10:00' + g * interval '5 minutes',
       '[[1,1,650.5,9.1],[2,1,640.0,8.7],[3,2,655.0,9.0],[4,2,655.0,0.9],[5,3,610.0,0.0]]'::json
FROM generate_series(0, 12) AS g;
INSERT INTO growatt_string_records (device_sn, timestamp, strings)
SELECT 'CFGA0002', (SELECT today FROM d60) + time '10:00' + g * interval '5 minutes',
       '[[1,1,600.0,7.5],[3,2,601.0,7.4]]'::json
FROM generate_series(0, 6) AS g;

-- AC power: today 07:00–09:55 (off-peak window part on weekdays) and 10:00–11:00, yesterday too
INSERT INTO growatt_inverter_readings (device_sn, timestamp, pac_w)
SELECT 'CFGA0001', d + t, CASE WHEN t < interval '9 hours' THEN 20000.0 ELSE 60000.0 END
FROM (SELECT today AS d FROM d60 UNION ALL SELECT today - 1 FROM d60) days,
     (SELECT interval '7 hours' + g * interval '15 minutes' AS t FROM generate_series(0, 16) AS g) ts;
INSERT INTO growatt_inverter_readings (device_sn, timestamp, pac_w)
SELECT 'CFGA0002', (SELECT today FROM d60) + time '12:00' + g * interval '5 minutes', 0.0
FROM generate_series(0, 3) AS g;

INSERT INTO growatt_issues (plant_id, device_sn, string_no, rule, tier, safety, opened_day, last_seen_day, days_seen, status, shadow, created_at, updated_at)
VALUES (6001, 'CFGA0002', NULL, 'R1', 'P2', false, (SELECT today FROM d60) - 3, (SELECT today FROM d60), 3, 'open', false, now(), now()),
       (6001, 'CFGA0002', 3, 'R2', 'P1', false, (SELECT today FROM d60) - 2, (SELECT today FROM d60), 2, 'acknowledged', false, now(), now()),
       (6001, 'CFGA0002', NULL, 'R3', 'P1', false, (SELECT today FROM d60) - 9, (SELECT today FROM d60) - 5, 4, 'resolved', false, now(), now());

INSERT INTO pwa_meter_sites (site_id, phase, name, kwp, growatt_plant_id, kwp_mismatch, updated_at)
VALUES ('P1-6001', 1, 'PWA Config Alpha', 250, 6001, false, now()),
       ('P2-6002', 2, 'PWA Config Beta', 60, 6002, false, now()),
       ('P2-6002B', 2, 'PWA Config Beta 2', 60, 6002, false, now());

INSERT INTO plant_documents (plant_id, kind, drive_id, url, title, revision, source, match_score, updated_by, updated_at)
VALUES (6001, 'asbuilt', '1AbCdEfGhIjKlMn', 'https://drive.google.com/file/d/1AbCdEfGhIjKlMn/view', 'Alpha As-built REV.2',
        'REV.2', 'matched', 0.93, 'matcher', '2026-11-20 03:00:00+00'),
       (6002, 'site_photos', NULL, 'https://example.com/photos/beta', 'Beta photos', NULL, 'manual', NULL, 'admin',
        '2026-11-21 04:00:00.5+00');
