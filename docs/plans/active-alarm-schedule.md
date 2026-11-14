# Active Alarm: tiered alarm-log schedule

## Problem

The `alarms` job read `alarm_data` for **all 629 inverters every 30 min**, 05:00–21:00:
32 runs × 629 ≈ 20,000 Growatt calls a day, about 2 min per run (4 accounts in parallel). The
worker runs one job at a time, so `history` / `env_history` waited each half hour. Yet about 95 %
of inverter-days have no alarm at all (2026-11-13: 598 of 629). The page re-read the DB every
2 min although the data changed only every 30 min.

## Change

**Worker (`alarms`, `growatt_alarms.sync_alarms` with `Tiers`).** It ticks every
`WORKER_ALARMS_TICK_MIN` (10) from 05:00 to 20:00 (`WORKER_ALARMS_START_H` / `_END_H`). Each tick
reads only the inverters that are due:

| Tier | Rule (SQL only, no Growatt call) | Re-read |
|---|---|---|
| hot | an alarm still reported at the inverter's last read (within 10 min of it, `ONGOING_GAP`), no end time, **or** the newest stored `max_data` status is 3 (fault) | `_HOT_MIN` 10 min |
| warm | alarms today, none ongoing | `_WARM_MIN` 30 min |
| cold | no alarms today | `_COLD_MIN` 60 min |

- Order within a tick: hot, then warm, then cold; oldest read first within each tier.
- Never-read inverters are always read. This means the whole fleet at 05:00 and anything new.
- Cold reads are capped per tick at 1.5 × their fair share (`cold count × tick / cold`). Otherwise
  the whole fleet read at 05:00 would come due at the same time every hour.
- A fault that `history` stores makes an inverter hot on the next tick.
- Growatt never leaves `end_time` empty. An ongoing alarm is re-reported every ~5 min, each record
  with end = start. That is why "hot" uses how recent the last report is, not `end_time IS NULL`.
- No `alarms` run starts at 09/13/17:20–:31, which keeps the worker free for each PWA check's
  history pull (hh:25) and publish (hh:30).
- After 20:00 inverters are off. `alarms_yesterday` (00:30) still reads the whole previous day,
  including any alarms after 20:00.

**API (`/growatt/alarms`).**
- `alarms[].read_at` is the time that inverter's log was last read.
- `meta.last_run_at` and `meta.next_run_at` give the `alarms` job's last start and next start.
  `next_run_at` is in the past when the run is overdue, and is set for today only.

**Page.**
- **When it re-reads:** at `next_run_at` + 45 s, kept between 60 s and 15 min. It falls back to
  every 2 min when the run is overdue or unknown.
- **When the sync badge turns amber:** when `next_run_at` is more than 20 min overdue.
- **When an event is Open:** when its last report is within 10 min of **its inverter's**
  `read_at`, no longer the plant's oldest read. With tiers, that oldest read can be 60 min old,
  which would have shown cleared alarms as Open.

## Expected effect (from the 2026-11-13 tier mix: 6 hot, 25 warm, 598 cold)

| | Before | After |
|---|---|---|
| Growatt `alarm_data` calls / day | ~20,100 | ~10,300 (6×87 + 25×30 + 598×15, + the 05:00 full read) |
| Freshness, faulted / ongoing inverters | 30 min | 10 min |
| Freshness, inverters with no alarms | 30 min | 60 min (a fault in `history` promotes them) |
| Worker time per run | ~2 min every 30 min | ~10–20 s every 10 min (2 min at 05:00) |
| Page DB reads per hour (today) | 30 | ~6 |

## Production check (2026-11-15, data from 2026-11-13 and 2026-11-14)

1. **Inverter-days with no alarm:** 93.5 % and 94.3 % (36–41 of 629 had alarms). This matches
   the plan.
2. **`end_time`:** all 1,354 records have end = start, and none has an empty `end_time`. So
   the "still reported" rule for hot is required; `end_time IS NULL` alone would never fire.
3. **The first alarm of the day per inverter (77 in total):**
   - All **30 `Error`** alarms had fault status 3 stored within ±10 min. The fault promotes the
     inverter to hot, so the delay is bounded by the `history` interval (30 min) plus one tick,
     not by the 60-min cold interval.
   - None of the **47 `Warning`** alarms had a fault status, so they wait for a cold read: up to
     60 min, instead of up to 30 min before. They are short (about 10 min of reports in their
     first hour), so the trade-off is acceptable.
   - 34 of the 77 start at 06:00–06:59 (sunrise). The capped cold reads spread the whole fleet
     over about 06:00–06:40.
4. **Old schedule, 2026-11-14:**
   - 28 runs read 17,432 inverter-days; a run took 99 s on average and 148 s at most.
   - 1 run was cut short by 10012 (rate limit).
   - On 2026-11-13, runs averaged 1,306 s and the longest took 3,703 s.

**Deployed 2026-11-15 01:27 Bangkok:** worker image `backend:2d24824-202611150125` on the VM,
API revision `tcroof-api-00025-bs4`, frontend on Hosting. The first full day on tiers is 2026-11-15.

**Decision:** keep `_COLD_MIN` = 60. After the deploy, compare one day of `sync_runs`
(`alarm_due`, `alarm_hot` / `_warm` / `_cold`, `failed`) with the 2026-11-14 figures above.

`WORKER_ALARMS_INTERVAL_MIN` is gone; an old value in `.env` is ignored (`extra="ignore"`).
