# frontend/CLAUDE.md

React 19 + Vite 6 + TypeScript (strict) + Tailwind v4 + react-router 7. Run commands from `frontend/`.

## Commands

The package manager is **Bun** (`bun.lock`). Don't use npm, yarn or pnpm, and don't commit their lockfiles.

```bash
bun install                 # bun add <pkg> / bun add -d <pkg> for new dependencies
bun run dev     # :5173, proxies /api -> http://127.0.0.1:8000 (start the backend first)
bun run lint    # tsc --noEmit — type check only, there is no ESLint
bun run build   # tsc -b && vite build
bunx <tool>     # instead of npx
```

Run `bun run lint` and `bun run build` after every change. The Docker build (`Dockerfile`) uses `oven/bun` with `bun install --frozen-lockfile`.

## Structure

- **`src/api/client.ts`**: the only REST client.
  - It defines `apiFetch` and the `api.*` methods, with all response types next to them.
  - Base URL is `VITE_API_BASE_URL` (default `/api`). The JWT is kept in localStorage.
  - New endpoints get a typed method here; don't call `fetch` from components.
- **Routes** (`App.tsx`, all inside `components/Layout.tsx`). **The plant is in the URL**, never in hidden state:
  - Fleet-wide: `/` (plant directory, `FleetHomePage`), `/growatt`, `/alarms`, `/sensors` (Weather Sensors: `?tab=status|info`, `sensor`, `status` (incl. `low` = data gaps, `flags` = health flags), `phase`, `q`, `sort`, `desc`; page-local DB list re-read every 5 min, overlaid by `key` with the live status from `useLivePoll(api.getLiveSensorStatus)`; header shows "Status checked N / M" until the backend sweep is complete, then "Live · hh:mm"; health flags = DB `flags` + live `flags` (`stale_history`), shown as chips with the reason as tooltip; the Info tab polls `api.getLiveSensor` for the open sensor (live state, newest reading, next-refresh countdown, admin-only raw record) and charts today's stored series via `getGrowattPlantWeather(…, sensor)`; Weather Station links to it with "Sensor status"; no context), `/she`, `/settings`, `/users`.
  - One plant: `/plant/:plantId` (overview), `/plant/:plantId/{generation,inverters,sensors,strings,string-layout,maintenance}`. `sensors` is `PlantSensorsPage`: the Weather Sensors Status / Info views for that plant only (`listSensors(plantId)` / `getLiveSensorStatus(plantId)` send `?plant_id=`, so the live sweep checks only its dataloggers; the plant column and phase filter are hidden). Today's chart there appends the live readings newer than the last stored slot (component memory, ≤ 24 points, dropped once stored), like Weather Station. Plant Overview's Sensors card shows each sensor's newest reading as reported: live (`useLivePoll(api.getGrowattLiveWeather)`) when at least as new as the stored record, else the stored record ("Last sync"). `PlantRoute` shows "not found" when the backend answers 404 (unknown, or not assigned to an engineer).
  - Old URLs (`/inverters`, …) redirect to the same page of the last plant opened (`localStorage`, guarded), else `/`.
  - Build plant links with `plantPath(id, page)` (`context/routes.ts`) or `usePlantHref()`; switch plant with `selectGrowattPlant(id)`, which keeps the current page.
  - **A page's own choices go in the query string** via `useUrlState()` (`src/lib/useUrlState.ts`): `set({ key: value })` patches several keys at once, drops defaults (null / "" / false) and replaces the history entry. Validate what you read (`pick`, `pickDay`, `pickTime`): URLs are hand-editable. Don't reset such state in an effect on mount (it would wipe the URL); switching plant drops the query by itself. In use: Inverters `sn`, `tab`, `days`; Strings `inv`, `status`, `q`, `string`; String Layout `filter`; Generation `wxDay`, `wxFrom`, `wxTo`, `wxSensor`; Active Alarm `day`, `q`, `level`, `open`, `plant`, `code`.
- **`src/context/`**: data is loaded **per route**. `routes.ts` → `routeData(pathname)` is the one place that decides what a route needs; `DataScope` (in `AppContext.tsx`) mounts every provider once and switches each on or off from the URL. A provider that is off fetches and polls nothing.
  - `AuthContext`: user, login/logout. Loads no data.
  - `FleetContext`: plant list (`/growatt/plants`, read once per session when first wanted: `/`, `/growatt`, `/users`, or the plant switcher opening) and the live fleet poll (`/`, `/growatt`, plant pages for the plant status).
  - `PlantContext`: the URL plant's DB overview (memory cache per plant, so switching its tabs doesn't refetch; refreshed every 5 min) and `/live/plants/{id}/latest`, polled on every plant page (the banner's string status is judged on it; the backend caches each inverter ≥ 270 s, so page switches add no Growatt calls).
  - `LegacyContext`: old analysis tables (`/plants`, datasets, latest analysis), admin only, on `/she`, `/settings`, plant Maintenance, or when the quick-parameters drawer opens.
  - `useAppContext()` merges them; values of a provider that is off are empty / null. Adding a page: add its route, then its needs in `routeData`.
  - Data loading uses `useEffect` and `setInterval`. `@tanstack/react-query` is installed but **not used**, so don't mix in a second fetching style without migrating the context.
  - Dev only: `window.__apiLog` lists every API request with the route it was made on (check what a page loads).
- **`src/pages/*`**: one page per route.
- **PWA and branding** (`vite-plugin-pwa` in `vite.config.ts`): installable app with `manifest.webmanifest` and a Workbox service worker (`registerType: autoUpdate`). It precaches the static build only; `/api/**` is excluded from the navigation fallback and there is **no runtime caching**, so API calls always hit the network and no live value is stored in the browser. Don't add runtime caching for `/api`. Icons come from the TC Renewable logo (the iOS app's `AppIcon-source.svg`): `public/favicon.svg` (also the brand mark in the sidebar and on the login page), `favicon-32.png`, `apple-touch-icon.png` (180), `icons/icon-192.png`, `icons/icon-512.png` and `icons/maskable-512.png` (logo at 75 % inside the maskable safe zone). Regenerate the PNGs with `rsvg-convert`. `firebase.json` serves `sw.js`, `registerSW.js` and the manifest with `Cache-Control: no-cache` so updates reach users.
- **`src/components/ui.tsx`**: shared app pieces, built on the shadcn primitives below.
  - Components: `PageHeader`, `Panel`, `KpiTile`, `StatusBadge`, `Led`, `Meter`, `EmptyState`, `LoadingState`.
  - Formatters `fmt` and `fmtInt` return `"—"` for null or non-finite values.
- **`src/components/ui/*`**: shadcn/ui components (Radix, `components.json`, style `radix-nova`), owned source.
  - Use them instead of raw elements: `Button` (variants `default` = solar CTA, `secondary` (default), `outline`, `accent`, `destructive`, `ghost`; sizes `sm`/`xs`/`icon-sm`…), `Input`, `Textarea`, `Label`, `Select`, `Tabs`, `Table` (`containerClassName="table-wrap"` for the scroll-shadow frame), `Badge` (variants `ok`/`warn`/`crit`/`info`/`neutral`), `Card`, `Dialog`, `Tooltip` (provider in `App.tsx`), `Command`.
  - They are restyled to the control-room theme; keep that when adding more (`bunx --bun shadcn@latest add <name>`, then fix any `from "cn"` import to `@/lib/utils` and match the compact `text-xs` sizing).
  - Import with the `@/` alias (`@/components/ui/button`); `cn()` is in `src/lib/utils.ts`.
- **Charts:** D3 only (no Plotly). Every x/y chart is `components/PanelChart.tsx`: pass a `PanelChartSpec` built with `useMemo` (`xKind` time / linear / band, stacked `panels`, each with **one** y scale; never a second y axis, so two units = two panels). Nulls are gaps, never 0. Colours come from `components/chartTheme.ts` by role (`SERIES.ac`, `SERIES.dc`, …; `STATUS.*` only for state); modelled series are labelled "(modelled)" and drawn dashed/dotted in `SERIES.reference`. Special-purpose D3 charts (comparison bars, string heatmap) are in `D3Charts.tsx`; shared tooltip/sizing helpers in `chartKit.tsx`.
- **Styling:**
  - Tailwind v4 design tokens are in `src/index.css` under `@theme`: `ink-*` surfaces, `solar-*` and `energy-*` accents. shadcn's variables (`--background`, `--primary`, `--border`, …) are mapped onto them in `:root`; the app is dark only (`<html class="dark">`).
  - Remaining component classes under `@layer components`: `panel-pad`/`panel-header`, `eyebrow`, `led-*`, `num`, `table-wrap`, `callout-*`. The old `btn`/`input`/`select`/`data-table`/`tabs`/`badge-*` classes were removed; use the shadcn components.
  - The UI is a dark control-room theme.

## Growatt data in the UI

**Live and DB data stay separate; the context combines them.**

| Data | Source | Refresh |
|---|---|---|
| Fleet list | `api.listGrowattPlants()` (DB), overlaid with `api.getGrowattLivePlants()` | list once per session; live when `refresh_in_s` says, on fleet routes and plant pages |
| URL plant overview | `api.getGrowattPlantOverview(id, day?)` (DB) | every 5 min, cached per plant across its tabs |
| URL plant live values | `api.getGrowattLivePlantLatest(id)` | when `refresh_in_s` says, on every plant page |

- **What the overlay changes.** `selectedPlantOverview` is the DB overview with the latest live record applied. Only "current" fields change: `kpis.current_power_kw`, `inverters[].current_ac_kw`, `mppt_latest`, `live_at`, and `strings[].live_voltage_v`/`live_current_a`/`live_power_w`/`live_status`/`live_reason`, plus `live.strings` (live string-check counts). Daily aggregates always come from the DB.
- **Plant status in the banner is realtime only:** `Disconnected` from the fleet poll's plant status, else `String Fault` / `String Warning` / `Normal` from `live.strings` (the backend's live string check). The stored-day string classification (`kpis.critical_strings`, `strings[].status`) is a day analysis for the Strings page and is not used for the status.
- **Polling** stops while `document.hidden`. Live values are never stored, in the browser or anywhere else.
- **Fleet alarm log** (Active Alarm page): one DB request, `api.getFleetAlarms(day)` (`/growatt/alarms`), for every plant the user can see; the worker syncs Growatt's alarm log into SQL. `context/alarmLogStore.ts` keeps each day's answer in tab memory (not localStorage) so revisits show it at once, and re-reads it in the background (today every 2 min, past days every 30 min) only while the page is visible. Cleared on logout. `plants[].synced_inverters` / `synced_at` give per-plant coverage: show an unsynced plant as "not synced yet", never as "no alarms". The per-plant "Growatt Fault Log" panel still uses the live endpoint.
- **Weather sensors on Active Alarm** (`components/SensorAlarmPanel.tsx`, shared pieces in `components/sensorView.tsx`): kept apart from the Growatt alarm log and its CSV. For **today**, it lists sensors the live sweep found offline or late plus flagged ones (`api.listSensors(undefined, day)` + `useLivePoll(api.getLiveSensorStatus)`, the same backend sweep as `/sensors`); a sensor not checked yet is never listed as offline. For a **past day**, there is no live state, so it lists stored data gaps (`coverage_pct` < `meta.alarm_coverage_pct`). The "Sensors offline" / "Sensor data gaps" tile scrolls to the panel; the page's plant filter applies.
- **Weather Station** (Generation & PR): with several sensors a selector picks one (`?sensor=` on the DB route; default the first). While viewing today with no time window, live readings newer than the last stored 5-min slot are appended to the chart as a tail (component memory, ≤ 24 points) and dropped once the DB has that slot. Plant Overview shows a `WeatherNowTile` (live, first sensor) for plants with a sensor, linking to `generation#weather-station`.
- **Show freshness:** "Live · hh:mm" when live data is fresh, "Last sync" when it's stale or unavailable.
- **Many numeric fields are `number | null`.**
  - Render them with `fmt()`.
  - Never substitute plausible defaults (`|| 98.1`, `?? 229.8`, `capacity * 0.72` …). Show "—" instead.
  - Don't show data the backend doesn't measure; there's no grid or load meter data.
- **The Growatt API token never reaches the browser.** All Growatt calls go through the backend.
