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
- **`src/context/AppContext.tsx`**: shared state through `useAppContext()`.
  - Holds the user/auth, the analysis plant and dataset, and the Growatt fleet list and selected plant.
  - Data loading uses `useEffect` and `setInterval`. `@tanstack/react-query` is installed but **not used**, so don't mix in a second fetching style without migrating the context.
- **`src/pages/*`**: one page per route (`App.tsx`). The routes are `/`, `growatt`, `generation`, `strings`, `alarms`, `maintenance`, `she` and `settings`, all inside `components/Layout.tsx`.
- **`src/components/ui.tsx`**: shared UI pieces.
  - Components: `PageHeader`, `Panel`, `KpiTile`, `StatusBadge`, `Led`, `Meter`, `EmptyState`, `LoadingState`.
  - Formatters `fmt` and `fmtInt` return `"—"` for null or non-finite values.
- **Charts:** D3 only (no Plotly). Every x/y chart is `components/PanelChart.tsx`: pass a `PanelChartSpec` built with `useMemo` (`xKind` time / linear / band, stacked `panels`, each with **one** y scale; never a second y axis, so two units = two panels). Nulls are gaps, never 0. Colours come from `components/chartTheme.ts` by role (`SERIES.ac`, `SERIES.dc`, …; `STATUS.*` only for state); modelled series are labelled "(modelled)" and drawn dashed/dotted in `SERIES.reference`. Special-purpose D3 charts (comparison bars, string heatmap) are in `D3Charts.tsx`; shared tooltip/sizing helpers in `chartKit.tsx`.
- **Styling:**
  - Tailwind v4 design tokens are in `src/index.css` under `@theme`: `ink-*` surfaces, `solar-*` and `energy-*` accents.
  - Component classes live under `@layer components`: `panel`, `btn`/`btn-ghost`/`btn-sm`, `badge-*`, `led-*`, `data-table`, `num`, `input`/`input-sm`, `select`, `tabs`/`tab`, `callout-*`.
  - Reuse these classes before adding new ones. The UI is a dark control-room theme.

## Growatt data in the UI

**Live and DB data stay separate; the context combines them.**

| Data | Source | Refresh |
|---|---|---|
| Fleet list | `api.listGrowattPlants()` (DB), overlaid with `api.getGrowattLivePlants()` | live every 60 s |
| Selected plant overview | `api.getGrowattPlantOverview(id, day?)` (DB) | every 5 min |
| Selected plant live values | `api.getGrowattLivePlantLatest(id)` | every 60 s |

- **What the overlay changes.** `selectedPlantOverview` is the DB overview with the latest live record applied. Only "current" fields change: `kpis.current_power_kw`, `inverters[].current_ac_kw`, `mppt_latest`, `live_at`, and `strings[].live_voltage_v`/`live_current_a`/`live_power_w`. Daily aggregates always come from the DB.
- **Polling** stops while `document.hidden`. Live values are never stored, in the browser or anywhere else.
- **Show freshness:** "Live · hh:mm" when live data is fresh, "Last sync" when it's stale or unavailable.
- **Many numeric fields are `number | null`.**
  - Render them with `fmt()`.
  - Never substitute plausible defaults (`|| 98.1`, `?? 229.8`, `capacity * 0.72` …). Show "—" instead.
  - Don't show data the backend doesn't measure; there's no grid or load meter data.
- **The Growatt API token never reaches the browser.** All Growatt calls go through the backend.
