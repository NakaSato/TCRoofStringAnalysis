# Plan & Spec: Calendar Team (O&M and cleaning planning)

Status: **Phases 1–2 built 2026-11-19** (Phase 1: tasks, teams, calendar page, Upcoming work card, migration `a6b7c8d9e0f1`; Phase 2: recurring plans + nightly `om_plans` job, Due view, cleaning rounds, per-plant crew-days / cost, drag to move, migration `7a1c2e9b4d60`; Phase 3: push reminders `om_reminders` / `om_weekly`, per-user ICS feed, migration `8b2d4f6a1c93`), Phase 4 not started · Created 2026-11-19 · Owner: Chanthawat
Related: [`decision-rules.md`](decision-rules.md) §6 (site log, soiling wallet R12, R13), `services/site_events.py`, `solar_core/om_management.py` (legacy demo PM schedule)

A shared **team calendar** where admins and engineers plan O&M work per plant: a weekly plan for the crews, a monthly plan for the fleet, recurring preventive maintenance, and **panel-cleaning rounds** for the dry season. When planned work is finished, it becomes a Site log event. The Site log already records work that was done; the calendar adds work that is planned.

---

## 1. State today (checked in code, 2026-11-19)

| Piece | Today | Where |
|---|---|---|
| Work done | `site_events`: cleaning, repair, module / inverter replaced, IR flight, curtailment, other. `day` … `end_day` is **never in the future**. Has optional inverter / string, `cost_thb`, a linked issue, and a note. | `services/site_events.py`, `routes/growatt/events.py`, `SiteEventsCard.tsx` |
| Work planned | **None.** The admin-only legacy PM table (`get_default_pm_schedule`) is hard-coded demo data (subcontractor names, "Next_Due") and is not stored. | `solar_core/om_management.py:254` |
| Roles | admin = everything. engineer = only the plants in `user_plant_assignments`. Unassigned plants answer 404. | `app/auth.py:129-160` |
| Cleaning signals | "Last cleaning" on the Site log. The soiling wallet (R12) and R13 are not built yet. | decision-rules.md §6 |
| Notifications | FCM web push for alarms (`services/push.py`, per user's devices). | |
| UI kit | shadcn `calendar.tsx` (react-day-picker 10), Popover, Dialog, Tabs, Select, Table. There is no full calendar grid component. | `frontend/src/components/ui/` |

## 2. Goals

1. **One calendar for the team.** Month, week and list views of planned O&M across every plant the user can see.
2. **Weekly plan.** Who goes where on which day. One lane per engineer or crew, so double booking is easy to spot.
3. **Monthly plan.** Coverage across the fleet: which plants are due for cleaning or PM this month, and which are overdue.
4. **Recurring PM.** For example, cleaning every 2 months in the dry season, inverter filter and fan checks quarterly, and an IR flight yearly. Occurrences are generated automatically.
5. **Cleaning rounds.** Pick plants (by phase, province or "most days since last cleaning"), then spread them over days while respecting crew capacity.
6. **Close the loop.** "Mark done" writes the Site log event (type, real dates, cost, note), so last-cleaning and future soiling analysis use it automatically.
7. **Same access rules as the rest of the app.** Engineers see and work only on their assigned plants.

## 3. Non-goals (v1)

- A full CMMS: no spare parts, purchase orders or subcontractor billing.
- Route optimisation or travel-time maps. The map only shows the day's plants.
- Sync with Google Calendar or Outlook. An ICS export is planned for Phase 3; two-way sync is out of scope.
- Firestore. The calendar is **SQL only**, like `site_events`, and adds no Spark-plan writes (rule 2).
- Weather-driven auto-rescheduling. No stored daily forecast exists (decision-rules §9 Q7). Show the stored rain where it exists, and leave suggestions for later.

## 4. Concepts

| Term | Meaning |
|---|---|
| **Task** | One planned job on one plant over a date range (`start_day` … `end_day`, plant-local). Optional inverter or string. It has a type, assignees, a status and notes. |
| **Task type** | Shared with the Site log (`cleaning`, `repair`, `module_replaced`, `inverter_replaced`, `ir_flight`, `pm_inspection`, `inverter_service`, `site_visit`, `other`; `curtailment` stays Site-log-only). `pm_inspection` (visual / torque / thermal), `inverter_service` (filters, fans) and `site_visit` are added as first-class `site_events` types (`EVENT_TYPES` + `EVENT_TYPE_PATTERN`), so marking any task done writes its exact type to the Site log. |
| **Recurring plan** | A template: plant(s), type, interval (every N weeks or N months), optional season window (e.g. Nov–Apr), preferred weekday, and default assignees. Quick presets in the UI: cleaning every 2 months (Nov–Apr), inverter service quarterly, and IR flight yearly. The worker (or the plan save) creates tasks up to 90 days ahead. |
| **Team / crew** | A named group of users or external contractor crew, e.g. "Crew North" or "Cleaning contractor A". Only in-house admins and engineers have app logins; external contractors are tracked as named teams (`om_teams`, optionally with 0 user members) without a third login role. A task can be assigned to users, a team, or both. |
| **Status** | `planned` → `in_progress` → `done`, or `skipped`, `cancelled`. Engineers schedule tasks directly as `planned` on their assigned plants (no approval workflow). Moving a task to another date keeps its status as `planned` (or `in_progress`) and records the old `start_day` / `end_day` in `om_task_history` (no separate `postponed` status, so moved tasks remain active on the calendar). A task is **overdue** when `end_day` < today and the status is `planned` or `in_progress`. Overdue is computed, not stored. |

## 5. Data model (SQL, Alembic migration, kept indefinitely)

```text
om_teams            id, name, color, active, created_at
om_team_members     team_id (FK CASCADE), user_id (FK CASCADE)  (PK both)
om_plans            id, name, task_type, plant_ids (via om_plan_plants), every_n, unit ('week'|'month'),
                    season_from_month, season_to_month (null = all year), weekday (0-6, null = any),
                    duration_days, default_team_id (FK SET NULL), default_user_ids (via om_plan_assignees),
                    starts_on, ends_on (null), active, created_by, updated_by, timestamps
om_plan_plants      plan_id (FK CASCADE), plant_id              (PK both)
om_plan_assignees   plan_id (FK CASCADE), user_id (FK CASCADE)  (PK both)
om_tasks            id, plant_id, task_type, title, start_day, end_day,
                    scheduled_day (null = one-off; original occurrence date for plan idempotency),
                    device_sn, string_no, status, team_id (FK SET NULL),
                    plan_id (FK SET NULL, null = one-off), issue_id (optional link to growatt_issues),
                    est_cost_thb, note, site_event_id (FK site_events.id ON DELETE SET NULL, set when done),
                    done_at, done_by, created_by, updated_by, timestamps
om_task_assignees   task_id (FK CASCADE), user_id (FK CASCADE)  (PK both)
om_task_history     id, task_id (FK CASCADE), at, by, change (JSON: field → [old, new]), comment
om_plant_settings   plant_id (PK), cleaning_crew_days (float, null), cleaning_cost_thb (float, null),
                    updated_by, updated_at
```

Indexes: `om_tasks(start_day, end_day)`, `om_tasks(plant_id, start_day)`, `om_task_assignees(user_id)`, unique partial/composite `om_tasks(plan_id, plant_id, scheduled_day)`.

Rules:
- Tasks may be in the future. Only the Site log forbids future dates: when marking a task done (`POST .../done`), `actual_start_day` and `actual_end_day` default to `min(task.start_day, today)` and `min(task.end_day, today)` and must be `≤ today` before calling `site_events.create_event()`.
- Deleting a plant (`remove_blocked_plants` in `app/services/growatt_sync/registry.py`) also deletes its `om_tasks`, `om_plan_plants` and `om_plant_settings` rows, just as it does for issues and readings.
- Optional per-plant planning fields in `om_plant_settings`, all null until entered (rule 3: never invent): `cleaning_crew_days` (how long a cleaning takes) and `cleaning_cost_thb` (also answers decision-rules §9 Q5).
- Shadow issues: engineers may only link or view non-shadow issues (`allow_shadow = user.role == "admin"`), matching `site_events.py`.

## 6. Access

| Action | admin | engineer |
|---|---|---|
| See tasks | all | tasks on assigned plants. Tasks on unassigned plants assigned to the engineer—or to a colleague/team visible in their weekly lanes (users who share at least one assigned plant)—are returned as masked `"Busy"` blocks (`plant_id: null`, `plant_name: null`, `title: "Busy"`, dates and assignee only) so weekly lanes prevent double-booking without leaking unassigned plant names or IDs. |
| Create or edit a one-off task | any plant | assigned plants only (`require_plant_write`) |
| Assign people | anyone | themselves, plus other users/teams assigned to the same plant (listed via `GET /growatt/calendar/assignees`) |
| Recurring plans, teams, cleaning rounds | yes | no (read only on teams/plans covering their plants) |
| Change status, mark done | yes | tasks on their plants |
| Delete | yes | only tasks they created that are still `planned` |

Unassigned plants still answer **404**. Lists are filtered with `allowed_plant_ids`, as in `app/api/routes/growatt/plants.py`.

## 7. API (new router `app/api/routes/growatt/calendar.py`, DB only)

```text
GET    /growatt/calendar/tasks?from=&to=&plant_id=&type=&status=&user_id=&team_id=   → tasks overlapping range (max 100 days), overdue flag, assignees, masked 'Busy' slots
GET    /growatt/calendar/assignees?plant_id=                → users & teams the caller can assign / view lanes for
POST   /growatt/plants/{plant_id}/tasks                     (require_plant_write)
PATCH  /growatt/plants/{plant_id}/tasks/{id}                (move dates, reassign, status; writes om_task_history)
POST   /growatt/plants/{plant_id}/tasks/{id}/done           body: actual start/end day (≤ today), cost_thb, note, close_issue
                                                            → calls site_events.create_event, sets site_event_id & status='done'
DELETE /growatt/plants/{plant_id}/tasks/{id}
GET    /growatt/calendar/due?month=YYYY-MM                  → per plant: last cleaning / last PM per type, next planned, overdue, cleaning_crew_days, cleaning_cost_thb
PUT    /growatt/plants/{plant_id}/om-settings               (admin) set cleaning_crew_days, cleaning_cost_thb
GET/POST/PATCH/DELETE /growatt/calendar/plans               (admin) recurring plans; save regenerates future 'planned' occurrences
GET/POST/PATCH/DELETE /growatt/calendar/teams               (admin)
POST   /growatt/calendar/rounds/preview                     (admin) plant_ids, from, crew/day capacity, weekdays → proposed tasks, not saved
POST   /growatt/calendar/rounds                             (admin) save the previewed tasks in one transaction
GET    /growatt/calendar/export.csv?from=&to=
```

As built (Phase 2): the CSV export stays in the browser (List view, Phase 1), so there is no `export.csv` route. Plans are read by everyone (`GET /growatt/calendar/plans`; engineers only plans covering their plants, with only those plants); `DELETE` of a plan removes its untouched future tasks and keeps the others as one-off tasks. An occurrence falls on the plan's weekday, or with none on the first Mon–Fri day that is not a tariff holiday; the season is judged on the nominal day's month. Round scheduler: each crew cleans one plant at a time; a plant of ≤ 1 crew-day shares the crew's day while it has room, a longer one starts on a fresh day and takes ⌈crew-days⌉ working days; plants that don't fit within 120 days are listed as unscheduled. Plants with no cleaning recorded go first (unknown is never assumed clean).

Services: `app/services/om_calendar.py` contains task CRUD, history, occurrence generation and the round scheduler wrapper. The scheduler is a pure function in `solar_core/om_planning.py`, so it can be unit tested without the DB.

**Occurrence generation.** When a plan is saved, and nightly in a worker job `om_plans` (00:40, before the 00:45 `rules_yesterday` and 00:50 `growatt_energy` jobs), keep `planned` tasks up to 90 days ahead. Never touch tasks that were already moved (`start_day != scheduled_day`), started (`in_progress`) or finished (`done`, `skipped`, `cancelled`). Skip occurrences outside the season window. Generation is idempotent on `(plan_id, plant_id, scheduled_day)` so moving a task's `start_day` never regenerates a duplicate on the original `scheduled_day`.

**Round scheduler (cleaning).** Input: plants, start date, working weekdays (defaults to Mon–Fri, with a checkbox in the dialog to include Saturday), holidays (reuses the holiday list from the `tariff` setting in `app_settings`), and daily capacity (crews × slots/day, configurable per round in the UI). Plants are ordered by priority, using days since last cleaning first, then grouped by province (`city`) or phase to keep travel short. Output: one task per plant. Each plant consumes `om_plant_settings.cleaning_crew_days` slots; when `cleaning_crew_days` is null, it counts as 1 slot (1 day) and the preview marks it `"duration not set"`.

## 8. UI

New fleet page **Calendar** at `/calendar` (nav item next to Active Alarm). The view is in the URL, as with other pages: `view=month|week|list`, `d=YYYY-MM-DD`, `type`, `team`, `user`, `plant`, `q`.

- **Month view.** A 7-column grid. Each day has colored chips by type (cleaning = blue, PM = green, repair = amber, overdue = red outline), with "+N more" when a day is full. Click an empty day to create a task. Drag a chip to move it (Phase 2; v1 uses "Move" in the dialog).
- **Week view, the weekly plan.** One row per engineer or team and one column per day (Mon–Sun). A task spans its days, and a cell with two tasks shows a conflict marker. A header row shows the stored rain for past days. For future days it shows nothing until a forecast exists (no invented numbers).
- **List / agenda.** A table of date, plant, type, assignees, status and cost, with Export CSV. This is the default on phones.
- **Due this month panel (monthly plan).** Plants with days since the last cleaning or PM, the next planned date, and overdue first. It has "Plan cleaning round…" (admin), which opens the round dialog: choose plants (filters for phase, province, "not cleaned in > N days") → set capacity and weekdays → preview on the calendar → save.
- **Task dialog.** Plant (searchable, only visible plants), type, dates, optional inverter / string, assignees and team, estimated cost, note, and an optional link to an Issue. The footer has Start, Mark done (opens the Site log form prefilled with type, dates clamped to `≤ today`, and cost), Skip and Delete. The History tab lists who changed what.
- **Plant Maintenance tab.** A small "Upcoming work" card above the Site log shows the next tasks for this plant, plus "Plan task".
- **My tasks.** The `user=me` filter is on by default for engineers, so they open on their own week.

Components are shadcn only, as on Active Alarm. The month and week grids are built in-house with CSS grid and `date-fns`-style helpers. **Don't add FullCalendar**: it brings its own styling and bundle size, and the two grids are simple.

## 9. Notifications and calendar feed (Phase 3, built)

**Push reminders** over the existing FCM web push (`services/push.py` channel; `services/om_reminders.py`). A person's work = tasks assigned to them directly or through a team they are a member of, on plants they may see now. Off while push is not configured; only users with a registered device get anything.
- `om_reminders` (worker, 18:00): "Tomorrow: Cleaning · {plant}" (title, and the length when it spans several days) for `planned` tasks starting tomorrow; several tasks become "Tomorrow: N tasks" with the first three. Opens `/calendar?view=list&d=…&user=me`.
- `om_weekly` (worker, Monday 07:30; `Schedule.weekdays`): "This week: N tasks, M overdue" (planned / in progress overlapping Monday … Sunday, overdue = ended before Monday), first three by day. Opens the week view.
- `om_push_marks` (user, kind `tomorrow` | `week`, day) stops a re-run pushing twice; rows older than 14 days are pruned. The weekly summary is this push (no email).

**ICS feed** (`services/om_ics.py`): the Calendar page's Subscribe button makes a secret link `/api/ics/calendar/{token}.ics` (no login: calendar apps send none). Only the SHA-256 of the secret is stored (`om_ics_feeds`, one per user), so the link is shown once; "Make a new link" or "Turn off" stops the old one at once, and an inactive user's feed answers 404. Content: the user's own work (as above, plant access checked on every read), 30 days back to 180 days ahead, not cancelled; all-day events in plant-local days with type, plant, title, status, inverter / string, team, assignees, note and a link back to the calendar (built from the forwarded host). Read-only; calendar apps poll it on their own schedule (Google: several hours).

## 10. Phases

| Phase | Scope | Size |
|---|---|---|
| **1. Tasks + calendar (MVP)** | Migration (`om_tasks`, assignees, history, teams) + extend `site_events` types (`pm_inspection`, `inverter_service`, `site_visit`). CRUD API with access rules & masked `'Busy'` blocks. Calendar page with month, week and list views. Task dialog. Mark done → Site log. Upcoming card on the plant Maintenance tab. Tests: engineer 404 / filter / Busy masking, done → event, history. | ~1 week |
| **2. Monthly plan + cleaning rounds** | `om_plans` recurring templates (with presets) and the `om_plans` worker job. Due-this-month panel. Round scheduler with preview / save (Mon–Fri default + tariff holidays + optional Saturday). Per-plant `om_plant_settings` (`cleaning_crew_days`, `cleaning_cost_thb`). Drag to move. CSV export. | ~1 week |
| **3. Reminders + export** (built) | Push reminders, ICS feed (per-user secret URL, read-only), and a weekly summary (Monday push). | ~3 days |
| **4. Data-driven cleaning** | Once decision-rules §6 has the cleaning step and soiling wallet (R12): "suggested" ghost tasks when the THB lost since the last cleaning exceeds the plant's cleaning cost, outside the monsoon window. An admin accepts a suggestion to turn it into a task. Suggestions are estimates and labelled as such. | after R12 |

## 11. Resolved design decisions (2026-11-19)

1. **Crews & logins:** Only in-house admins and engineers have logins. External cleaning contractors are represented as named teams (`om_teams`, which may have 0 user accounts) with no third `contractor` role.
2. **Cleaning capacity:** Configurable per round in the round dialog, combined with optional per-plant `cleaning_crew_days` in `om_plant_settings` (defaults to 1 slot/plant when not entered, flagged `"duration not set"` in preview).
3. **Event types:** `pm_inspection`, `inverter_service` and `site_visit` become first-class `site_events` types (`EVENT_TYPES` in `app/services/site_events.py` and `EVENT_TYPE_PATTERN` in `app/api/routes/growatt/events.py`).
4. **Recurring intervals:** Editable per recurring plan (`om_plans`), with UI presets for cleaning every 2 months (Nov–Apr), inverter service quarterly, and IR flight yearly.
5. **Working days & holidays:** Scheduler defaults to Mon–Fri and skips public holidays from the existing `tariff` setting (`app_settings`), with a checkbox in the round dialog to include Saturday.
6. **Approval:** Engineers can schedule one-off tasks directly as `planned` on their assigned plants with no admin approval step.
7. **Customer visibility:** Internal O&M tool only (SQL only, never synced to Firestore or exposed to plant owners).
