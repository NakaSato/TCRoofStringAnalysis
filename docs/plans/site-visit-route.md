# Plan: Site visit route (Operations → Visit Route)

Status: **Phases 1–2 and the §9 redesign built (2026-11-22), not deployed** · Created 2026-11-22 · Owner: Chanthawat

A page where an O&M engineer plans a day of site visits:

1. Pick the plants that need a visit, or take a team's Calendar tasks for that day.
2. Choose a start point (the team base or the phone's location).
3. Get the best visit order with drive times.
4. See the route on the map.
5. Open it in Google Maps to navigate.

---

## 1. Why

- Plants are spread over Thailand (234 sites, 5 regions). A team usually covers 2–10 sites a day, and a bad order costs hours of driving.
- The app already knows **why** a plant needs a visit, and that should drive the stop list:
  - open alarms and faults
  - P1–P2 issues with baht per day lost
  - overdue cleaning and PM
  - claims with a next-action day
  - planned `site_visit` / repair tasks
- Today the Calendar groups rounds by `city` or `phase` only (`solar_core/om_planning.py:139`). Route optimisation was out of scope in `calendar-team.md:34`.

## 2. Scope

**In (v1)**
- `/route` page in the sidebar's **Operations** group, for admins and engineers. Engineers see only their assigned plants (`allowed_plant_ids`).
- **Stop candidates** for a chosen day, each with its reason:
  - Calendar tasks of a team or person on that day
  - top issues from `/growatt/center`
  - plants with an open fault alarm
  - claims due
  - free pick from the fleet
- **Start and end**: the team base (new), the phone's location (browser geolocation, asked only on click), or any plant. End at the start (round trip) or at the last stop.
- **Order**: exact for up to 10 stops, a heuristic up to 25. A service time per stop, defaulting by task type (cleaning = crew days from `OmPlantSettings`, inspection 1 h, other 45 min). Leave time, then arrival and leave times per stop, flagged after sunset or after 18:00.
- **Map**:
  - a route line and numbered stops on the Leaflet map, on its own layer above the radar and below the plant markers
  - a stop list with a drive time and distance per leg
  - drag to reorder and recompute times; lock the order
- **Navigate**: "Open in Google Maps" links (`/maps/dir/?api=1`, `dir_action=navigate`), split into legs of at most 4 stops so phones keep every waypoint. Also share or copy the stop list.
- **Save the plan** as a visit: it links the Calendar tasks it covers, so the Calendar shows "Route: 4 stops, 312 km".

**Out (later)**
- Multi-team / multi-vehicle assignment (VRP across teams).
- Live tracking of where a team is.
- Traffic-aware times.
- Toll and fuel cost.

## 3. Routing engine (decision)

Use the hosted **Geoapify** API (OpenStreetMap data) plus an **in-process solver**. Nothing is self-hosted, so there is no VM memory or disk cost, and it works while GCP is stopped. It adds ฿0/month within the free plan.

| Option | Why not (or why) |
|---|---|
| **Geoapify** (chosen, decided 2026-11-22) | The free plan allows commercial and production use with attribution ("Powered by Geoapify" + "© OpenStreetMap contributors" near the map), 3,000 credits/day, 5 req/s. `POST /v1/routematrix` gives the matrix (up to 1,000 cells; 26 × 26 = 676), and `GET /v1/routing` gives the road line (MultiLineString, one line per leg). |
| OSRM self-hosted | ฿0 but needs about 1 GB RAM and a few GB on the `tcroof-db` VM, a monthly data rebuild and a firewall rule. Dropped: the user prefers a hosted open API. The service keeps the provider behind one function, so it can come back if the free plan changes. |
| OSRM demo server (FOSSGIS) | Not for production, no heavy use, may go offline. |
| openrouteservice free API | The Standard plan bars commercial use. |
| LocationIQ | The free plan allows commercial use with attribution, but it is unclear whether its matrix API is on the free plan. Keep it as the second choice. |
| Google Routes / Route Optimization | Results must be shown on a **Google** map, and our map is Leaflet. It also adds billing risk under the cost guard. |
| Longdo routing | One origin and one destination per call. No matrix, no reordering. It also shares the radar's 100k/month quota. |

**Credits** (Geoapify's rules): matrix = max(S, T) × min(S, T, 10); routing = waypoints − 1 (+1 per 500 km over 500 km).

| Stops (+ start) | Matrix | Route line | One solve |
|---|---|---|---|
| 5 | 6 × 6 = 36 | 5 | ≈ 41 |
| 10 | 11 × 10 = 110 | 10 | ≈ 120 |
| 25 | 26 × 10 = 260 | 25 | ≈ 285 |

- Geoapify's limits are soft (it does not block when the quota is exceeded), so the backend enforces its own cap: `GEOAPIFY_DAILY_CREDITS` (2,800), counted per Bangkok day in `external_api_call_counts` (api `geoapify`) like Longdo. Over the cap, the answer is a straight-line estimate with `fallback_reason: "budget"`.
- The matrix is cached in memory for 24 h by point set, so reordering stops or solving again costs 0 credits. The route line is cached by its ordered waypoints.
- Privacy: plant coordinates, and the phone's location when a route starts from it, are sent to Geoapify. No names or user details are sent.

**Solver** (`solar_core/visit_route.py`, pure and tested):
- Up to 10 stops: an exact search on the duration matrix plus service times. With time windows it keeps (lateness, time) labels per state, so it equals brute force.
- 11–25 stops: nearest neighbour plus 2-opt / Or-opt from several seeded starts.
- More than 25: refused with "split the day".

**Settings**: `GEOAPIFY_API_KEY` (Secret Manager `tcroof-geoapify-key` in production; empty = straight-line estimates only, labelled "straight line, not road"), `GEOAPIFY_TIMEOUT_S`, `GEOAPIFY_COOLDOWN_S`, `GEOAPIFY_DAILY_CREDITS`, `ROUTE_SOLVE_PER_MIN` (10 per user). The key stays on the backend (rule 4).

## 4. Data model

| Table | Columns | Notes |
|---|---|---|
| `route_offices` (built) | `id`, `name` (≤ 80, unique case-insensitively via `name_key`), `address?` (≤ 200), `lat`, `lon` (usable location, never 0,0), `is_default`, `created_by?`, `created_at`, `updated_at` | Saved offices a route can start from (`backend/app/db/models/route.py`, migration `f5a6b7c8d9e0`). Static config, not plant-scoped. At most one default: the first office is it, a new default clears the old one, deleting the default promotes the oldest remaining office. |
| `om_team_bases` | `team_id` PK, `name`, `latitude`, `longitude`, `updated_by/at` | The team's office or base. Teams have none today (`OmTeam` holds name/colour/active). Admin-edited in Calendar → Teams. |
| `om_visit_routes` | `id`, `day`, `team_id?`, `user_id?`, `start` (json: kind + lat/lon + label), `end_mode` (`return` \| `last`), `leave_at`, `status` (`planned` \| `done` \| `cancelled`), `distance_km`, `drive_min`, `source` (`geoapify` \| `straight_line`), `created_by/at`, `updated_by/at` | A saved plan. The distance and time are modelled values and are labelled so. |
| `om_visit_stops` | `route_id`, `seq`, `plant_id`, `task_id?`, `issue_id?`, `reason` (`task` \| `issue` \| `alarm` \| `claim` \| `manual`), `service_min`, `eta`, `etd`, `leg_km`, `leg_min` | Ordered stops |

- Route geometry is **not** stored. It is fetched from Geoapify on open and cached in memory (`live_store.cache_map`, keyed by stop coordinates) for 24 h.
- A plan stores only what people decided: stops, order and times.
- Plants without coordinates (`hasLocation` false, or `normalize_coords` nulled them) are listed as "no location in Growatt, can't be routed". They can't be added until Growatt has their location.

## 5. API (`/growatt/routes`, new router `api/routes/growatt/visit_route.py`)

| Method | Path | Notes |
|---|---|---|
| GET | `/candidates?day=&team_id=&user_id=` | Plants to visit with their reasons: tasks covering `day`, top issues, open fault alarms, claims due, overdue cleaning/PM. DB only; scoped to `allowed_plant_ids`. |
| POST | `/solve` | Body `{start, end_mode, leave_at, stops:[{plant_id, service_min, window?}], keep_order?}`; `start` = `{kind:"plant", plant_id}` \| `{kind:"point", lat, lon, label?}` \| `{kind:"office", office_id}` (unknown office 404; the answer's `start` carries `kind`, `office_id` and the office name as `name`). Answers the order, ETA/ETD per stop, per-leg km and minutes, a GeoJSON line, Google Maps links (split), `source: "geoapify"` or `"straight_line"` with `fallback_reason`, `credits_used` and the attribution. Rate-limited per user (10/min). |
| GET | `/offices` (built) | Saved offices, default first, then by name. Any signed-in user (not plant-scoped). Router `api/routes/growatt/route_offices.py`, service `services/route_offices.py`. |
| POST/PATCH/DELETE | `/offices`, `/offices/{id}` (built) | `require_admin` (403 for engineers). 404 unknown id, 409 duplicate name, 422 bad location (out of range, 0,0) or unsetting the default (make another office the default instead). DELETE answers `default_office_id`. |
| GET/POST/PATCH/DELETE | `/` , `/{id}` | Saved plans; write = `require_write_access` on plants the user may see |
| PUT | `/growatt/calendar/teams/{id}/base` | `require_admin` |

- Service: `services/visit_route.py`. It handles the Geoapify client (timeout, cooldown on failure through `live_store.cooldown_map`, daily credit cap), the matrix and the solver.
- Router registered in `main.py`.
- Schemas in `api_schemas.py`.

## 6. UI (`frontend/src/pages/VisitRoutePage.tsx` + `pages/visitRoute/*`)

**Layout:**
- A left panel with day, team/person, start, leave time and the stop list (drag to reorder, service minutes, reason badge, remove), and a candidates drawer grouped by reason.
- On the right, the map: the Leaflet setup taken from `PlantMapPage` into a shared `plantMap/useLeafletMap.ts`, a route layer in its own pane, and numbered `divIcon` stops.

**On a phone:**
- The map sits on top and the stop list underneath.
- Big "Navigate" buttons: one per leg of at most 4 stops.
- "Use my location" calls `navigator.geolocation` only on click; a denial falls back to the team base.

**URL state** (`useUrlState`): `d`, `team`, `user`, `route` (saved plan id). Unsaved stops are kept only in component state.

**Labels:**
- Drive time and distance carry "road estimate (Geoapify, OpenStreetMap)", or "straight line" when Geoapify is off, down or over the day's credits.
- Missing values show "—".
- The map shows "Powered by Geoapify" (linked) and "© OpenStreetMap contributors", as the free plan requires.

**Entry points:**
- Calendar day / week "Plan route for this day"
- O&M Dashboard top issues "Add to route"
- Plant Map selected plant "Add to route"

**i18n**: `th/route.ts`.

## 7. Phases

1. **Engine and solver**:
   - `solar_core/visit_route.py` with tests: exact search equals brute force for up to 8 stops; heuristic within 5 % of exact for 10; time windows; service times.
   - Geoapify client with the credit cap, memory cache and the straight-line fallback; `/solve`.
2. **Page v1**: candidates, stop list, map, Google Maps links. No saving yet. Then **2b: page redesign (§9)**.
3. **Saving and Calendar**: tables, migration, saved plans, links to tasks, team bases, Calendar entry point.
4. **Production**: secret `tcroof-geoapify-key` (created by `deploy/gcp.sh setup` from `.env`, like the Longdo key), passed to Cloud Run by `backend`. Restrict the key by IP in the Geoapify dashboard if Cloud Run's outbound address allows it.

## 8. Decisions needed

1. **Team bases:** partly answered 2026-11-22: offices are a saved list managed by admins (`route_offices`, `/growatt/routes/offices`), and a route can start from one (`start.kind = "office"`); per-team bases (`om_team_bases`) later. Each office still needs its real coordinate entered.
2. **Working hours:** the default leave time (08:00?) and the latest finish (17:00 or sunset?).
3. **Who may save:** may engineers save plans for their own team, or is that admin only? (Plan: engineers may save plans for their own team.)
4. ~~**OSRM on the VM**~~ Decided 2026-11-22: use the hosted Geoapify API instead. Someone needs to sign up for a free Geoapify key and put it in `.env` as `GEOAPIFY_API_KEY`.

---

## 9. Page redesign (v2 layout)

Phase 2 works end to end, but the page reads as a long form. This section replaces the layout in §6. The data hook `useVisitRoute`, the map component and the backend stay as they are.

### 9.1 What is wrong with v1 (screenshots 2026-11-22, desktop 1440 px and phone 390 px)

1. **The order of work is upside down.** You start by picking plants, but "Plants to visit" is the last block in the panel. On a phone it sits below the whole form.
2. **The answer is hidden.** Drive, time on site and finish are cut off under the sticky Navigate bar on desktop. The one number that matters ("finish 20:54, after sunset") is easy to miss.
3. **Stop cards are tall** (about 155 px each). Each has a time-on-site input, "Default time: no task type behind it", an arrival-window button, and arrive/leave on their own lines. Three stops fill the screen, so 10–25 stops can't be read at all.
4. **Settings used once take the most space.** Day, team, person, start, end of day, leave and latest finish take about 300 px at the top of the panel.
5. **Two yellow primary buttons compete**: "Plan best order" and "Navigate".
6. **Warnings repeat.** "After latest finish" shows on the last stop and again on the return leg.
7. **Unclear labels.** "Navigate Start–Start" doesn't say what it does. The page description repeats the breadcrumb.

### 9.2 New layout

**Desktop (≥ lg):**

```
┌ Visit Route ────────────────────────────────────────────────────────────────────┐
│ [Sun 22 Nov ▾] [All teams ▾] [Everyone ▾] │ Start: ⌂ P1_2 Ayutthaya ✎ │ 08:00 → 18:00 │ ⟲ Round trip ▾ │
├──────────────────────────────┬──────────────────────────────────────────────────┤
│ [ Plants to visit 12 ][ Route 3/25 ] │                                          │
│ ┌ Finish 20:54 ⚠ after sunset ─┐ │                                              │
│ │ Drive 832 km · 9 h 03        │ │                 MAP                          │
│ │ On site 3 h · Road estimate  │ │   candidates by reason colour + legend       │
│ └──────────────────────────────┘ │   numbered stops, route line, ⌂ start        │
│ ⌂ Start 08:00                    │   [fit route]                                │
│ ┆ 371 km · 4 h 20                │                                              │
│ ① P1_33 ห้วยเสนง · Surin      ⋮ │                                              │
│   12:20–13:50 · 90 min           │                                              │
│ ┆ 58 km · 50 min                 │                                              │
│ ② P1_30 ห้วยจรเข้ · Buriram     │                                              │
│   14:41–15:26 · 45 min           │                                              │
│ ┆ 330 km · 3 h 53                │                                              │
│ ③ P1_2 … · Ayutthaya   ⚠ sunset │                                              │
│   19:18–20:03 · 45 min           │                                              │
│ ┆ 72 km · 51 min → ⌂ 20:54       │                                              │
├──────────────────────────────┤                                                  │
│ [ ➤ Navigate (Google Maps) ][⋯] │                                                  │
└──────────────────────────────┴──────────────────────────────────────────────────┘
```

1. **Settings bar** (new `RouteSettingsBar.tsx`). It is one row above the map and the panel, and wraps to two rows below xl.
   - Day, team and person stay in the URL (`d`, `team`, `user`).
   - Start is a chip. It opens a popover with today's `StartPicker` content (my location, a plant, pick on map).
   - Leave → latest finish are two time inputs.
   - Round trip / end at the last stop is a small select.
2. **Panel with two tabs** (shadcn `Tabs`). The panel opens on "Route" when it already has stops (for example from `add=`); otherwise it opens on "Plants to visit". Both tabs show counts. Adding a plant never switches tabs; the Route tab's count bumps and a short toast says "Added P1_33 (3 / 25)".
   - **Plants to visit** is today's `CandidatesPanel` without the collapsible:
     - a search box for "Add any plant" (`FleetPicker` inline) at the top
     - reason filter chips
     - grouped rows (name, district, reason badges, default time on site, a + / ✓ toggle)
     - per group, "Add all" (up to the 25-stop cap)
   - **Route** is an itinerary timeline. See §9.3.
3. **One action slot**, sticky at the bottom of the panel (new `ActionBar.tsx`, which replaces `NavigateBar`). It shows exactly one primary button, depending on the state:

   | State | Primary button | Secondary |
   |---|---|---|
   | No start | "Choose a start" (opens the start popover) | — |
   | No stops | "Add plants to visit" (switches to that tab) | — |
   | Not planned yet, or the stops / start changed | "Plan best order · n stops" | — |
   | Planned, order on screen = plan | "Navigate in Google Maps". With more than one link, one button per leg, labelled by stop numbers, e.g. "Stops 1–3", "Stops 3–5". | ⋯ menu: copy stop list, plan again |
   | Planned, then reordered by hand | Times update by themselves, as today. Primary stays "Navigate". | "Best order again" as a text button |

   A solve error or a rate limit shows as a callout just above the bar. The error stays inside the Route tab and doesn't push the timeline down.
4. **Map**: same `RouteMap`, with these additions:
   - a small legend of reason colours
   - a "fit route" button
   - clicking a marker selects the plant and scrolls its row into view in whichever tab is open
   - the candidate popup's "Add to route" / "Remove" stays as it is
5. **Header**: keep `PageHeader` for consistency, but cut the description to one short line: "Pick plants, get the best order and drive times. Nothing is saved yet."

**Phone (< lg):**

```
┌ Visit Route ─────────────────┐
│ Sun 22 Nov · from P1_2 · 08:00–18:00 · round trip  ✎ │  ← one line, opens a sheet with the settings
│ ┌──────── MAP (30vh) ───────┐ │
│ │                  [⤢ larger]│ │  ← toggles 30vh / 65vh
│ └───────────────────────────┘ │
│ [ Plants to visit 12 ][ Route 3 ] │
│ … same tab content as desktop … │
├──────────────────────────────┤
│ [ ➤ Navigate · Stops 1–3 ]     │  ← sticky action slot, safe-area padding
└──────────────────────────────┘
```

- The settings open in a `Sheet` from the bottom. They hold the same fields as the bar.
- A bottom sheet dragged over a full-screen map (Google Maps style) was considered and left for later. It needs drag and snap code, it is awkward with long lists and inputs, and the tabbed stack above covers the same flow.

### 9.3 Route tab: itinerary timeline (`StopList.tsx` rewritten)

- **Summary strip on top** (`RouteSummary.tsx` as a compact sticky strip):
  - **Finish** is the big figure. It turns amber when it is after the latest finish or after sunset, and red when a time window is missed.
  - Then drive km · time, time on site (and wait), the source badge ("Road estimate" or "Straight line, not road"), and the method in a tooltip.
  - Warnings for the whole day show here once and are not repeated on the return leg.
  - Before a plan exists, the strip shows "— " values and the hint ("Choose a start first.", …).
- **Start row**: ⌂, the start name, the leave time.
- **Stop row**, two lines and about 56 px:
  - line 1: drag handle, sequence badge, name (truncated, full name in the title), district
  - line 2: `arrive–leave` · `n min on site` (a chip; its tooltip says "default: no task type" or "from the task: 2 crew-days"), plus a window chip only when a window is set
  - warning icon chips only on that stop: after sunset, after latest, late
  - a ⋮ menu: move up / down, remove
- **Clicking a row** expands an inline editor under it (one open at a time): time on site, arrival window open–close, remove. Invalid input keeps the row open and outlined, as today. The page also selects the plant on the map.
- **Leg connector** between rows: `┆ 58 km · 50 min`, dashed and labelled "straight line" when `leg_source` is not the road. Before a plan exists it is a plain spacer.
- **Return row**: `┆ 72 km · 51 min → ⌂ 20:54`, or "Ends at the last stop".
- Drag to reorder stays (HTML5 drag on desktop, ↑ / ↓ in the ⋮ menu on touch).

### 9.4 Files

| File | Change |
|---|---|
| `pages/VisitRoutePage.tsx` | New grid: settings bar row, then panel (tabs + action slot) and map; phone stack with the settings line and map size toggle |
| `visitRoute/RouteSettingsBar.tsx` | **New.** Day / team / person / start chip / leave → finish / end mode; `RouteControls.tsx` folds into it |
| `visitRoute/StartPicker.tsx` | Content moves into a popover (desktop) / sheet (phone); logic unchanged |
| `visitRoute/StopList.tsx` | Compact timeline rows, inline editor, ⋮ menu, leg connectors |
| `visitRoute/RouteSummary.tsx` | Compact strip, finish first, warnings once |
| `visitRoute/ActionBar.tsx` | **New**, replaces `NavigateBar.tsx`: one primary action by state |
| `visitRoute/CandidatesPanel.tsx` | Tab body: inline search, "Add all" per group, no collapsible |
| `visitRoute/RouteMap.tsx` + `routeMap.css` | Legend, fit-route button, `onSelect` scrolls the list |
| `i18n/th/route.ts` | New keys; remove the unused ones |
| `components/ui/sheet.tsx` | **New** (`bunx --bun shadcn@latest add sheet`, restyled to the theme): the phone settings sheet. There is no `Sheet` in `ui/` yet |
| `frontend/CLAUDE.md` | Add `/route` to the Routes list (it isn't documented there yet) |

No backend or API change. `useVisitRoute` keeps its shape; at most it gets a `tab` helper and a `firstIssue` (the hint behind the action slot).

- **Tab in the URL:** `tab=plants|route` via `useUrlState` (frontend rule: page choices go in the query string). No `tab` = automatic: Route when there are stops, otherwise Plants.
- **The 25-stop warning** ("At most 25 stops a day: split the day") and the plan hint move into the action slot, under the button.
- The ⋮ stop menu uses the existing `ui/dropdown-menu`; the start popover uses `ui/popover`.
- As built: the desktop bar shows one "Hours" caption with leave → latest finish (each input keeps its own label); the map legend is hidden below `sm` (the two-line attribution covers it on a phone); multi-link navigation is a 3-column grid of leg buttons ("Start → 3", "3 → 6", …) under "Navigate in Google Maps, leg by leg"; "Plan best order" also switches to the Route tab.

### 9.5 Order of work

1. Settings bar + page grid + action slot (the frame). Check desktop and phone.
2. Route tab: summary strip and timeline rows (the largest part).
3. Plants tab: inline search, "Add all".
4. Map: legend, fit, scroll-into-view.
5. `bun run lint && bun run build`, then a browser check at 1440 px and 390 px, in EN and TH, with 3, 10 and 25 stops and with the straight-line fallback (key removed).

Steps 2 and 3 touch separate files and can run in parallel. Step 1 has to land first, because both tabs sit in its grid.

### 9.6 Open questions

Decided 2026-11-22 ("go" = the defaults): plans are made at a desk, so the tabbed layout stays and the drag-up sheet is deferred; no distance column for now.

1. **Who plans and where?** If plans are mostly made at a desk (an admin plans for a team) and the phone is used mainly to navigate, the layout above is right. If engineers plan on the phone in the field, the full-screen map with a drag-up sheet (§9.2, deferred) becomes worth building.
2. **Distance from the start in "Plants to visit":** a straight-line km per candidate, labelled "≈ straight line", would help pick nearby plants. It is derived from coordinates and is not a road distance. Add it?
