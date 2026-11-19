# Plan & Spec: Operations → Measuring Tools (frontend)

Status: **Frontend built on mock data 2026-11-19** (backend `/tools` not started) · Created 2026-11-19 · Owner: Chanthawat

A new **Measuring Tools** page in the sidebar's **Operations** group. It is the O&M team's register of measuring instruments (drones, thermal cameras, clamp meters, I-V curve tracers, insulation testers, …) and shows who has each instrument, which plant it is at, and when its calibration or its documents (drone registration, insurance) run out. This plan covers the frontend. It lists only the API the page needs (§7); the backend gets its own plan.

---

## 1. Why

- String diagnostics, IR flights and repairs depend on instruments in the field. Today nobody can see who has the drone or the I-V tracer, or whether its calibration is still valid.
- A reading taken with an instrument whose calibration has lapsed can't be trusted. A clamp meter that isn't rated for PV DC voltage is a safety risk on a 1,000 V string.
- A drone flown with expired registration or insurance is illegal. The page has to show this before anyone takes the drone to a site.

## 2. Scope

**In (v1)**
- `/tools` (sidebar label **Measuring Tools**), open to **everyone**. Engineers can view instruments, check them out and back in, and report damage. Admins can also add, edit and retire instruments and record calibrations and documents.
- Register table with search and filters, summary counts, CSV export.
- Check-out / check-in: holder, plant (optional), due back, condition on return.
- **Due dates**: calibration plus documents (drone registration, insurance, certificate), each with a state of ok / due soon / overdue.
- Detail dialog: specs, calibration history, documents, check-out history.

**Out (later)**
- Hand tools, PPE (SH&E covers PPE) and spare-parts stock.
- File uploads (certificate PDFs, photos). v1 stores a number, the issuer and an optional URL.
- Importing the readings the instruments take (I-V tracer files, IR images). See §9.
- QR / barcode scanning.

## 3. Instrument types

`category` is a fixed list, so filters and specs stay consistent:

| Category | Examples | Specs shown | Due dates |
|---|---|---|---|
| `drone` | Thermal / RGB inspection drone | camera (thermal resolution), batteries (count, cycles as entered) | CAAT registration, NBTC registration, insurance, pilot licence (holder) |
| `thermal_camera` | Handheld IR camera | resolution, temp range | calibration |
| `iv_tracer` | I-V curve tracer (+ its irradiance / temp sensor) | max V / max A | calibration |
| `insulation_tester` | Insulation-resistance (megger) tester | test voltages (500 / 1000 V) | calibration |
| `clamp_meter` | AC/DC clamp meter | **CAT rating**, **max DC V**, max A | calibration |
| `multimeter` | Digital multimeter | **CAT rating**, **max DC V** | calibration |
| `irradiance_meter` | Handheld pyranometer / reference cell | range W/m² | calibration |
| `earth_tester` | Earth-resistance tester | method | calibration |
| `power_analyser` | Power-quality analyser | channels | calibration |
| `other` | Thermometer, module temp probe, … | free text | calibration (optional) |

All specs are entered by people. A field left empty shows "—". The page **never** fills in a typical rating or interval. A clamp meter or multimeter without a CAT rating or max DC V gets a "Rating not entered" badge in the table, because whether it can be used on PV strings depends on that rating.

## 4. Constraints from the project rules

| Rule | What it means here |
|---|---|
| Never invent numbers (CLAUDE.md rule 3) | Specs, dates, intervals and cost come only from what people enter. The backend computes the next due date only from an interval someone entered. A missing date shows "—", never "ok". |
| Data loaded per route (`routeData`) | The page loads its own data. `routeData` is unchanged (`fleetList` / `fleetLive` only for the sidebar and the plant picker). |
| Page state in the URL (`useUrlState`) | Tab, search, filters, sort and the open instrument go in the query string and are validated with `pick`. |
| One REST client | Types in `api/types/tools.ts`, methods in `api/client.ts`, no `fetch` in components. |
| shadcn, no decorative icons | Active Alarm layout: `Card`, line `Tabs`, `Select`, `Table` + `Pagination`, `Dialog`, `Popover` + `Calendar`. Category icons appear only in the category `Select` and the detail dialog title. |
| Firestore = summaries + registry | Instruments live in SQL only. |

## 5. Page layout (`/tools`)

```
┌ PageHeader: Measuring Tools                         [Add instrument] (admin) ┐
├ Summary Card: Instruments · Available · Checked out · Overdue back ·         │
│               Due ≤ 30 d · Overdue (calibration / documents)                 │
│               (each number is a button that sets the filter)                 │
├ Card ─────────────────────────────────────────────────────────────────────── │
│  Tabs: Register | Checked out | Due dates                                    │
│  [Search name / tag / serial] [Category ▾] [Status ▾] [Due ▾]        CSV     │
│  Table (rows fit the screen, Pagination under it)                            │
└──────────────────────────────────────────────────────────────────────────────┘
```

**Tabs**
- **Register** (default): every instrument that isn't retired. Columns: asset tag, name (make / model below it), category, key spec (CAT rating + max DC V for meters; thermal resolution for drones and cameras; max V / A for I-V tracers), status, holder / plant, next due (the earliest calibration or document date, as a badge), and actions (Check out / Check in, ⋯).
- **Checked out**: open check-outs. Columns: instrument, holder, plant (links to `plantPath(id, "maintenance")`), out since, due back (red when overdue), Check in.
- **Due dates**: one row per calibration or document, ordered overdue → due soon → ok. Columns: instrument, what (Calibration / CAAT registration / NBTC / Insurance / Pilot licence), date, issuer / lab, number, and "Record renewal" (admin).

**Badges** (`Badge` variants)
- Status: `available` ok · `checked_out` info · `at_calibration` neutral · `repair` warn · `retired` neutral (hidden unless `show=retired`).
- Due: `overdue` crit · `due_soon` warn · `ok` ok · no date = "—" with the tooltip "No date entered". The tooltip lists every due item of the instrument.

**Check-out guard**
- If calibration is overdue, an `Alert` says: "Calibration overdue since …: readings may not be valid". Checking the box lets you go ahead.
- If a **drone** has an expired registration or insurance, a `crit` Alert says: "Registration / insurance expired: do not fly". Checking the box lets you go ahead, because the drone may be going out for repair or renewal. The backend records the acknowledgement on the check-out. (Should this block instead? See open question 2.)

**URL state**: `tab` (register | out | due), `q`, `cat`, `status`, `due` (overdue | due_soon | ok | none), `show` (retired), `sort`, `desc`, `tool` (id: detail dialog open, so the dialog can be linked).

## 6. Files

```
src/api/types/tools.ts              Instrument, InstrumentCategory, InstrumentStatus, DueItem, DueState,
                                    Checkout, InstrumentList (+ summary), bodies for create / patch / checkout / return / due
src/api/client.ts                   re-export the types, add the api.* methods of §7
src/pages/ToolsPage.tsx             page export only: header, summary, tabs; reads useUrlState
src/pages/tools/useInstruments.ts   listInstruments on mount and after each change; re-read every 5 min while visible
src/pages/tools/InstrumentTable.tsx the three tab tables (filter / sort in memory: tens of instruments, not thousands)
src/pages/tools/InstrumentDialog.tsx add / edit (admin); the spec fields shown depend on the category (§3)
src/pages/tools/CheckoutDialog.tsx  holder (default = me), plant (fleet list, already scoped), due back, guard of §5
src/pages/tools/ReturnDialog.tsx    condition ok / damaged / lost + note; damaged → status repair
src/pages/tools/DueDialog.tsx       record calibration or a document renewal (admin): kind, date, next due, number, issuer, cost THB
src/pages/tools/InstrumentDetail.tsx specs, due items, calibration and check-out history
src/pages/tools/format.ts           category labels and icons, status / due badges, key-spec text, CSV columns
```

Wiring:
- `App.tsx`: `const ToolsPage = page(() => import("./pages/ToolsPage"), "ToolsPage")` and the route `/tools`.
- `Layout.tsx` `NAV_GROUPS` → Operations, after Issues: `{ to: "/tools", label: "Measuring Tools", icon: Ruler, … }` (not `Gauge`, which Weather Sensors already uses). The description reads "Drones, meters & testers: who has them, calibration & due dates".
- `routeData`: no change.
- Add `/tools` to the routes list in `frontend/CLAUDE.md`.
- Add the shadcn components the app doesn't have yet: `bunx --bun shadcn@latest add dropdown-menu checkbox`, then change the imports to `@/lib/utils` and match the `text-xs` sizing.

## 7. API the page needs (backend contract)

```
GET    /tools?include_retired=          → InstrumentList { instruments[], summary{ total, available, checked_out,
                                            overdue_back, due_soon, overdue }, categories[], meta{ due_soon_days } }
GET    /tools/{id}                      → Instrument + due_history[] + checkouts[]
POST   /tools                 (admin)   → Instrument
PATCH  /tools/{id}            (admin)   → Instrument      (incl. status repair / at_calibration / retired)
DELETE /tools/{id}            (admin)   only if it has never been checked out; otherwise retire it
POST   /tools/{id}/checkout             → Checkout        { holder_user_id?, plant_id?, due_back, note, ack_warnings[] }
POST   /tools/{id}/return               → Checkout        { condition: ok|damaged|lost, note }
POST   /tools/{id}/due        (admin)   → Instrument      { kind: calibration|caat|nbtc|insurance|pilot_licence|other,
                                                            day, next_due?, number?, issuer?, cost_thb?, url?, note }
```

`Instrument` fields:
- `id, asset_tag, name, category, make, model, serial_no, status, holder (user | null), open_checkout (Checkout | null)`
- `specs` (an object; keys by category from §3, every value `number | string | null`)
- `due[]` (`{ kind, next_due | null, state }`), `next_due` (the earliest), `due_state`
- `calibration_interval_months | null, purchase_day | null, cost_thb | null, note`
- `created_by, updated_by, created_at, updated_at`

The backend computes `due[].state`, `due_state` and `summary` (due soon = within `meta.due_soon_days`, default 30), so the page, a future push and the AI Assistant all agree. An engineer may pick only their assigned plants for a check-out. The page's plant `Select` already uses the scoped fleet list.

## 8. Build order

1. Types and client methods, plus a mock list in `useInstruments` (one instrument per category, some due / overdue) until the backend exists. Remove the mock before merging.
2. Route, sidebar entry, header, summary and the Register tab with search, filters, sort and URL state.
3. Check-out / check-in dialogs, the Checked out tab and the guard.
4. Due dates tab, DueDialog and the due badges.
5. Admin add / edit / retire with category-specific spec fields, the detail dialog and CSV export.
6. Run `bun run lint && bun run build`. Then run the page against the backend as admin and as engineer: engineers see no Add / Edit / Record renewal, and `window.__apiLog` shows only `/tools*` plus the sidebar's fleet calls.

## 9. Later (not v1)

- Site log: a "Measured with" select on `ir_flight` and repair entries, so a reading or IR flight records which (calibrated) instrument took it. The plant Maintenance page would also get "Instruments on site now".
- String Analysis / I-V: attach an I-V tracer measurement to a string, compared with the Growatt-derived curve.
- A push or Issues entry 14 days before a calibration or drone document runs out, and when a check-out is overdue back.
- A drone flight log (date, plant, pilot, minutes, batteries), which would feed the flight-hours figure.

## 10. Open questions

1. Is the category list in §3 right? Are any instruments missing (e.g. an EL camera, a soiling station)?
2. Should an expired drone registration or insurance **block** the check-out, or only warn (the current plan)?
3. Do engineers add instruments, or only admins?
4. Should the UI labels be in Thai (เครื่องมือวัด), English, or both?
