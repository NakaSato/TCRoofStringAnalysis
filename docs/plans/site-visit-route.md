# Plan: Site visit route (Operations → Visit Route)

Status: **Planned** · Created 2026-11-22 · Owner: Chanthawat

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

Use self-hosted **OSRM** (Thailand extract) plus an **in-process solver**, which adds ฿0/month.

| Option | Why not (or why) |
|---|---|
| **OSRM self-hosted** (chosen) | The Thailand OSM extract is 315 MB. An MLD car profile needs about 1 GB RAM to serve and 2–4 GB disk (estimate, to be measured). It runs as one more internal container on the VM beside Postgres and Redis. `/table` gives the matrix and `/route` gives the GeoJSON line. Its data is OSM, which may draw on Leaflet with attribution. |
| Google Routes / Route Optimization | Cheap at our volume (`optimizeWaypointOrder` ≈ 900 req/month, inside the 5,000 Pro free cap). But the policy says results must be shown on a **Google** map, and our map is Leaflet. It also adds billing risk under the cost guard. Keep it in reserve in case the map ever moves to Google. |
| Longdo routing | One origin and one destination per call. No matrix, no reordering. The terms restrict display to Longdo maps. It also shares the radar's 100k/month quota. |
| ORS / GraphHopper / Stadia hosted | The free tiers bar commercial use; the paid tiers are a large share of the ฿1,000 budget. |

**Solver** (`solar_core/visit_route.py`, pure and tested):
- Up to 10 stops: an exact Held–Karp search on the OSRM duration matrix plus service times. Time windows are checked on arrival.
- 11–25 stops: nearest neighbour plus 2-opt / Or-opt, or `pyvroom` (BSD-2) when time windows are tight.
- More than 25: refused with "split the day".

**Infrastructure**:
- `deploy/vm/compose.yml` gets an `osrm` service (`osrm/osrm-backend`, `osrm-routed --algorithm mld`).
  - Data is preprocessed by `deploy/osrm/build.sh` (download the Geofabrik Thailand extract, `osrm-extract` / `-partition` / `-customize`). Run it on a laptop and copy the result to `/opt/tcroof/osrm`; rebuild monthly.
  - It listens on the internal IP only. A new firewall rule `tcroof-allow-osrm-internal` opens port 5000 inside the VPC, as for Postgres and Redis.
- `docker-compose.yml` (dev) gets the same service.
- `OSRM_URL` (empty = route page shows straight-line estimates labelled "straight line, not road").

## 4. Data model

| Table | Columns | Notes |
|---|---|---|
| `om_team_bases` | `team_id` PK, `name`, `latitude`, `longitude`, `updated_by/at` | The team's office or base. Teams have none today (`OmTeam` holds name/colour/active). Admin-edited in Calendar → Teams. |
| `om_visit_routes` | `id`, `day`, `team_id?`, `user_id?`, `start` (json: kind + lat/lon + label), `end_mode` (`return` \| `last`), `leave_at`, `status` (`planned` \| `done` \| `cancelled`), `distance_km`, `drive_min`, `osrm_data_date`, `created_by/at`, `updated_by/at` | A saved plan. The distance and time are modelled values and are labelled so. |
| `om_visit_stops` | `route_id`, `seq`, `plant_id`, `task_id?`, `issue_id?`, `reason` (`task` \| `issue` \| `alarm` \| `claim` \| `manual`), `service_min`, `eta`, `etd`, `leg_km`, `leg_min` | Ordered stops |

- Route geometry is **not** stored. It is recomputed from OSRM on open and cached in memory (`live_store.cache_map`, keyed by stop coordinates) for 24 h.
- A plan stores only what people decided: stops, order and times.
- Plants without coordinates (`hasLocation` false, or `normalize_coords` nulled them) are listed as "no location in Growatt, can't be routed". They can't be added until Growatt has their location.

## 5. API (`/growatt/routes`, new router `api/routes/growatt/visit_route.py`)

| Method | Path | Notes |
|---|---|---|
| GET | `/candidates?day=&team_id=&user_id=` | Plants to visit with their reasons: tasks covering `day`, top issues, open fault alarms, claims due, overdue cleaning/PM. DB only; scoped to `allowed_plant_ids`. |
| POST | `/solve` | Body `{start, end_mode, leave_at, stops:[{plant_id, service_min, window?}], keep_order?}`. Answers the order, ETA/ETD per stop, per-leg km and minutes, a GeoJSON line, Google Maps links (split), `source: "osrm"` with OSRM data date, or `"straight_line"` as the fallback. Rate-limited per user (10/min). |
| GET/POST/PATCH/DELETE | `/` , `/{id}` | Saved plans; write = `require_write_access` on plants the user may see |
| PUT | `/growatt/calendar/teams/{id}/base` | `require_admin` |

- Service: `services/visit_route.py`. It handles the OSRM client (timeout 5 s, cooldown on failure through `live_store.cooldown_map`), the matrix and the solver.
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
- Drive time and distance carry "road estimate (OSRM, OpenStreetMap)", or "straight line" when OSRM is down.
- Missing values show "—".
- The map shows the "© OpenStreetMap contributors" attribution.

**Entry points:**
- Calendar day / week "Plan route for this day"
- O&M Dashboard top issues "Add to route"
- Plant Map selected plant "Add to route"

**i18n**: `th/route.ts`.

## 7. Phases

1. **Engine and solver**:
   - OSRM build script and compose service (dev first).
   - `solar_core/visit_route.py` with tests: exact search equals brute force for up to 8 stops; heuristic within 5 % of exact for 10; time windows; service times.
   - `/solve` with the straight-line fallback.
2. **Page v1**: candidates, stop list, map, Google Maps links. No saving yet.
3. **Saving and Calendar**: tables, migration, saved plans, links to tasks, team bases, Calendar entry point.
4. **Production**:
   - Copy OSRM data to the VM and add the firewall rule.
   - Set `OSRM_URL` in `deploy/gcp.config`.
   - Check VM memory (Postgres settings are sized for 8 GB; OSRM needs about 1 GB).

## 8. Decisions needed

1. **Team bases:** where are the team offices or bases? Each one needs a coordinate. Without them, routes start from the phone's location only.
2. **Working hours:** the default leave time (08:00?) and the latest finish (17:00 or sunset?).
3. **Who may save:** may engineers save plans for their own team, or is that admin only? (Plan: engineers may save plans for their own team.)
4. **OSRM:** confirm it on the VM (≈ 1 GB RAM). GCP is stopped since 2026-11-21, so production waits for it to reopen; dev runs locally with Docker.
