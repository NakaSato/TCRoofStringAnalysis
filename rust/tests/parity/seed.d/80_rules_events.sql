-- Issues queue, Site log and daily rule / KPI rows (routes/growatt/issues.rs, events.rs).
-- Plant ids 8600–8699, issue ids 86001–86099, site event ids 86101–86199 (explicit ids, far
-- above the sequences, so new rows the cases write never collide).
--   8601 Rules Alpha (admin only): inverter EVTA0001 (alias A1), EVTA0002 (no alias); a live
--        plant-level R10 issue and a shadow R16; two events (IR flight over two days, other)
--   8602 Rules Beta (engineer): EVTB0001 (alias ''), EVTB0002; live R1 string issue (open), live
--        R3 safety (acknowledged), shadow R2 (open), resolved R7 for reopen, resolved R1 twin of
--        the active one on string 2 (reopen clash), live R8 (open, for close_issue); events by the
--        engineer and the admin, linked to a live, a shadow and a missing issue; daily rule rows
--        of EVTB0001 (+ string 2) and plant KPI rows with R16 evidence; a fitted EPI factor
--   8603 rules gamma (engineer): nothing stored

INSERT INTO growatt_plants (plant_id, phase, name, city, peak_power_kwp, synced_at)
VALUES (8601, 1, 'Rules Alpha', 'Chiang Mai', 120, now()),
       (8602, 2, 'Rules Beta', NULL, 80, now()),
       (8603, NULL, 'rules gamma', NULL, NULL, now());

INSERT INTO user_plant_assignments (user_id, plant_id, assigned_by, created_at)
SELECT id, p, 'parity', now() FROM users, unnest(ARRAY[8602, 8603]) AS p WHERE username = 'engineer';

CREATE TEMP TABLE d80 AS SELECT (now() AT TIME ZONE 'Asia/Bangkok')::date AS today;

INSERT INTO growatt_inverters (device_sn, plant_id, datalogger_sn, model, alias, nominal_power_w, synced_at)
VALUES ('EVTA0001', 8601, 'DL8601', 'MAX 60KTL3 LV', 'A1', 60000.0, '2026-11-20 03:00:00+00'),
       ('EVTA0002', 8601, 'DL8601', 'MAX 60KTL3 LV', NULL, 60000.0, '2026-11-20 03:00:00+00'),
       ('EVTB0001', 8602, 'DL8602', 'MAX 50KTL3 LV', '', 50000.0, '2026-11-20 03:00:00+00'),
       ('EVTB0002', 8602, 'DL8602', 'MAX 50KTL3 LV', 'B2', 50000.0, '2026-11-20 03:00:00+00');

INSERT INTO growatt_issues (id, plant_id, device_sn, string_no, rule, tier, safety, parent_id, opened_day, last_seen_day, days_seen,
    lost_kwh_est, thb_per_day_est, lost_kwh_total_est, thb_total_est, evidence, daily, status, ack_by, ack_at, note, feedback,
    shadow, closed_at, closed_by, close_reason, created_at, updated_at)
VALUES
  (86001, 8602, 'EVTB0001', 2, 'R1', 'P2', false, 86006, (SELECT today FROM d80) - 4, (SELECT today FROM d80) - 1, 3,
   12.5, 52.0, 37.5, 156.0, '{"ratio_median":0.78,"low_min":240,"day":"2026-11-27"}',
   '{"2026-11-25":{"kwh":12.0,"thb":50.0},"2026-11-26":{"kwh":13.0,"thb":54.0},"2026-11-27":{"kwh":12.5,"thb":52.0}}',
   'open', NULL, NULL, NULL, NULL, false, NULL, NULL, NULL, now(), now()),
  (86002, 8602, 'EVTB0002', NULL, 'R3', 'P1', true, NULL, (SELECT today FROM d80) - 2, (SELECT today FROM d80), 2,
   NULL, NULL, NULL, NULL, '{"alarms":2}', '{}', 'acknowledged', 'engineer', '2026-11-27 02:15:00.5+00', '  check isolation  ',
   NULL, false, NULL, NULL, NULL, now(), now()),
  (86003, 8602, 'EVTB0002', 3, 'R2', 'P1', false, NULL, (SELECT today FROM d80) - 1, (SELECT today FROM d80), 1,
   40.0, 300.0, 40.0, 300.0, NULL, NULL, 'open', NULL, NULL, NULL, NULL, true, NULL, NULL, NULL, now(), now()),
  (86004, 8602, 'EVTB0002', NULL, 'R7', 'P3', false, NULL, (SELECT today FROM d80) - 20, (SELECT today FROM d80) - 15, 4,
   3.0, 12.0, 11.0, 44.0, '{}', 'null', 'resolved', NULL, NULL, 'fixed fuse', 'confirmed', false,
   '2026-11-10 08:00:00+00', 'admin', 'resolved', now(), now()),
  (86005, 8602, 'EVTB0001', 2, 'R1', 'P3', false, NULL, (SELECT today FROM d80) - 30, (SELECT today FROM d80) - 25, 2,
   2.0, 8.0, 4.0, 16.0, '{}', '{}', 'dismissed', NULL, NULL, NULL, 'false_alarm', false,
   '2026-11-01 08:00:00+00', 'engineer', 'dismissed', now(), now()),
  (86006, 8602, 'EVTB0001', NULL, 'R8', 'P2', false, NULL, (SELECT today FROM d80) - 1, (SELECT today FROM d80), 1,
   20.0, 80.0, 20.0, 80.0, '{"down_min":45}', '{}', 'open', NULL, NULL, 'old note', NULL, false, NULL, NULL, NULL, now(), now()),
  (86007, 8601, NULL, NULL, 'R10', 'P3', false, NULL, (SELECT today FROM d80) - 3, (SELECT today FROM d80), 3,
   55.5, 230.0, 160.0, 690.0, '{"epi":0.81}', '{}', 'open', NULL, NULL, NULL, NULL, false, NULL, NULL, NULL, now(), now()),
  (86008, 8601, NULL, NULL, 'R16', 'Info', false, NULL, (SELECT today FROM d80) - 1, (SELECT today FROM d80), 1,
   NULL, NULL, NULL, NULL, '{}', '{}', 'open', NULL, NULL, NULL, NULL, true, NULL, NULL, NULL, now(), now()),
  (86009, 8602, 'EVTB0002', 4, 'R99', 'P4', false, NULL, (SELECT today FROM d80) - 1, (SELECT today FROM d80), 1,
   NULL, 0.0, NULL, NULL, '{}', '{}', 'open', NULL, NULL, NULL, NULL, false, NULL, NULL, NULL, now(), now());

INSERT INTO site_events (id, plant_id, event_type, day, end_day, device_sn, string_no, cost_thb, issue_id, note,
    created_by, updated_by, created_at, updated_at)
VALUES
  (86101, 8602, 'cleaning', '2026-10-20', NULL, NULL, NULL, 4500.0, NULL, 'whole roof', 'engineer', 'engineer',
   '2026-10-20 09:00:00+00', '2026-10-20 09:00:00+00'),
  (86102, 8602, 'repair', '2026-10-05', '2026-10-12', 'EVTB0001', 2, 1250.55, 86001, NULL, 'admin', 'admin',
   '2026-10-12 09:00:00.123+00', '2026-10-13 09:00:00+00'),
  (86103, 8602, 'inverter_service', '2026-10-15', NULL, 'EVTB0002', NULL, NULL, 86003, 'shadow link', 'admin', 'engineer',
   '2026-10-15 09:00:00+00', '2026-10-15 09:00:00+00'),
  (86104, 8602, 'site_visit', '2026-10-15', NULL, NULL, NULL, 0.1, 86077, NULL, 'engineer', 'engineer',
   '2026-10-15 10:00:00+00', '2026-10-15 10:00:00+00'),
  (86105, 8602, 'cleaning', '2025-09-01', NULL, NULL, NULL, 0.2, NULL, NULL, NULL, NULL,
   '2025-09-01 10:00:00+00', '2025-09-01 10:00:00+00'),
  (86110, 8601, 'ir_flight', '2026-10-09', '2026-10-10', 'EVTA0002', NULL, 9000.0, 86008, 'drone', 'admin', 'admin',
   '2026-10-10 09:00:00+00', '2026-10-10 09:00:00+00'),
  (86111, 8601, 'other', '2026-09-01', NULL, 'NOPE0001', NULL, NULL, NULL, NULL, 'admin', 'admin',
   '2026-09-01 09:00:00+00', '2026-09-01 09:00:00+00');

-- daily rule rows of EVTB0001 (yesterday and the day before) and its string 2
INSERT INTO growatt_inverter_daily (device_sn, day, plant_id, daylight_min, producing_min, fault_min, off_min, standby_min,
    limited_min, no_data_min, energy_kwh, dc_energy_kwh, kwp, ya_kwh_kwp, yf_kwh_kwp, ya_minus_yf, yf_vs_median_pct,
    plant_kwp_share_pct, lost_fault_kwh_est, lost_off_kwh_est, lost_standby_kwh_est, lost_no_data_kwh_est, computed_at)
VALUES ('EVTB0001', (SELECT today FROM d80) - 1, 8602, 660, 600, 30, 0, 15, 0, 15, 210.0, 221.4, 40.0, 5.535, 5.25,
        0.285, -2.1, 50.0, 6.2, NULL, 1.1, 0.0, now()),
       ('EVTB0001', (SELECT today FROM d80) - 2, 8602, 660, 660, 0, 0, 0, 0, 0, 230.5, NULL, NULL, NULL, NULL, NULL, NULL,
        NULL, NULL, NULL, NULL, NULL, now()),
       ('EVTB0001', (SELECT today FROM d80) - 40, 8602, 660, 660, 0, 0, 0, 0, 0, 1.0, NULL, NULL, NULL, NULL, NULL, NULL,
        NULL, NULL, NULL, NULL, NULL, now()),
       ('EVTB0002', (SELECT today FROM d80) - 1, 8602, 660, 0, 0, 660, 0, 0, 0, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
        NULL, NULL, 40.0, NULL, NULL, now());
INSERT INTO growatt_string_daily (device_sn, string_no, day, plant_id, gated_slots, ratio_median, low_min, severe_min, open_min,
    v_ratio_median, voltage_sensing, energy_kwh, lost_kwh_est, lost_on_peak_kwh_est, computed_at)
VALUES ('EVTB0001', 2, (SELECT today FROM d80) - 1, 8602, 96, 0.78, 240, 30, 0, NULL, 'shared_mppt', 18.0, 12.5, 4.0, now()),
       ('EVTB0001', 2, (SELECT today FROM d80) - 2, 8602, 8, NULL, NULL, NULL, 0, 1.01, 'per_string', 20.25, NULL, NULL, now()),
       ('EVTB0001', 1, (SELECT today FROM d80) - 1, 8602, 96, 1.0, 0, 0, 0, NULL, 'shared_mppt', 23.0, 0.0, 0.0, now());

-- plant KPI rows of 8602: a clean sensor day, a stale + above-clear-sky day, a day without evidence,
-- a below-neighbours day on a clear sky
INSERT INTO growatt_plant_daily (plant_id, day, capacity_kwp, energy_kwh, dc_energy_kwh, modelled_energy_kwh, yr_h, ya_kwh_kwp,
    yf_kwh_kwp, ya_minus_yf, pr_pct, pr_temp_corrected_pct, epi, system_factor, irradiance_weighted_tmod_c, filtered_slots,
    stale_masked_slots, clipped_masked_slots, curtailed_masked_slots, sensor_stale_slots, sensor_high_slots, sensor_midday_wm2,
    sensor_neighbour_ratio, sensor_neighbours, cloud_midday_pct, computed_at)
VALUES (8602, (SELECT today FROM d80) - 1, 80.0, 420.0, 441.0, 455.2, 5.6, 5.5125, 5.25, 0.2625, 93.75, 98.1, 0.9227, 0.985,
        47.5, 120, 2, 0, 4, 0, 0, 812.5, 0.98, 3, 15.0, now()),
       (8602, (SELECT today FROM d80) - 2, 80.0, 400.0, NULL, 450.0, 5.4, NULL, 5.0, NULL, 92.6, NULL, 0.8889, NULL,
        NULL, 100, 0, 1, 0, 14, 7, 990.0, NULL, NULL, NULL, now()),
       (8602, (SELECT today FROM d80) - 3, NULL, 380.0, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
        NULL, 0, 0, 0, 0, NULL, NULL, NULL, NULL, NULL, NULL, now()),
       (8602, (SELECT today FROM d80) - 4, 80.0, 300.0, NULL, 450.0, 5.4, NULL, 3.75, NULL, 69.4, NULL, 0.6667, NULL,
        NULL, 100, 0, 0, 0, 1, 0, 400.0, 0.5, 4, 10.0, now()),
       (8601, (SELECT today FROM d80) - 1, 120.0, 500.0, NULL, NULL, NULL, NULL, 4.1667, NULL, NULL, NULL, NULL, NULL,
        NULL, 0, 0, 0, 0, NULL, NULL, NULL, NULL, NULL, NULL, now());
INSERT INTO growatt_plant_epi_fit (plant_id, status, factor, spread_pct, days_used, candidate_days, start_day, end_day,
                                   min_clearness, reason, fitted_at)
VALUES (8602, 'fitted', 0.941, 3.1, 10, 25, '2026-10-01', '2026-11-20', 0.72, NULL, '2026-11-22 17:45:00.5+00'),
       (8603, 'too_few_days', NULL, NULL, 3, 3, NULL, NULL, NULL, 'only 3 good days', '2026-11-22 17:45:00+00');
