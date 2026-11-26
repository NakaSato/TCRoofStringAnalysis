# Plan & Spec: Inventory linked to the installed equipment (2026-11-26)

**Built 2026-11-26** (L-1 to L-4). Local DB: 2,318 installed devices (625 inverters, 236 dataloggers = 233 site register + 3 only in Growatt, 233 weather stations, 289 CEWE meters, 233 routers, 233 PQM, 233 ShineMaster, 236 grid meters), 12 model rows, 10 catalogue proposals. Data notes: the site register names every datalogger model just "Growatt" (Growatt says ShineMaster); PQM and ShineMaster have no model recorded.

Inventory (`/inventory`, docs/plans/spares-failed-units.md) holds spares, failed units and their
movements. The equipment already on the plants is in other tables: Growatt inverters and
dataloggers (`growatt_inverters`), the O&M site register's devices (`site_devices`: datalogger,
weather station, CEWE revenue meters, Teltonika routers with IP / network (VPN) and SIM, PQM,
ShineMaster) and the Growatt grid-point meters (`growatt_meters`, no serial). This links them:
**read from the existing tables, nothing copied or synced**; the registry stays the source.

Local DB, 26 Nov 2026: 629 inverters, 233 Growatt dataloggers, site register 233 stations
(233 dataloggers, 289 CEWE meters, 233 routers of which 145 have a serial and 233 an IP, 43 a SIM,
233 PQM / ShineMaster / weather stations without serials), 236 grid meters.

## Decisions (asked 2026-11-26, all four chosen)

- **L-1 Installed tab:** one list of every installed device per plant, searchable, filterable, CSV; open the device or Replace from the row.
- **L-2 Catalogue from models:** propose catalogue parts for the models in use; a store keeper reviews and applies (nothing is created without that).
- **L-3 Serial cross-links:** a serial shown in Inventory says where the registry has it; receiving a spare whose serial is registered as installed warns.
- **L-4 Spare counts per model:** installed vs in stock vs failed per model and project phase. Counts only, no money.

Rules: scoped by `allowed_plant_ids` (a site register station without a plant: admin only, as the
register); inverters marked not installed are left out (`inverter_installed()`); a value the
registry does not have is null ("—"), never guessed; a model not recorded is its own row
("Model not recorded"), never assigned to another.

New part category **`grid_meter`** (Growatt grid-point meter, e.g. CHNT_THREE), so L-2 can propose it.

## API (contract; backend `services/stock_installed.py`, routes in `api/routes/stock.py`)

### `GET /stock/installed?category=&plant_id=&phase=&q=&limit=500&offset=0` (everyone signed in)

```
{ items: InstalledDevice[], total: int, counts: {category: int}  (every filter but `category`, before limit: the chips stay useful while one is picked),
  meta: { source: "db" } }
InstalledDevice {
  key: str            # "inv:<sn>" | "dl:<sn>:<plant_id>" | "sd:<site_devices.id>" | "gm:<datalogger_sn>:<address>"
  source: "inverter" | "datalogger" | "site_device" | "grid_meter"
  category: PartCategory   # inverter, datalogger, weather_station, revenue_meter, router, pqm, shinemaster, grid_meter
  label: str          # inverter alias or SN; "Data logger"; site device label as the resolver's ("Revenue meter 2"); "Grid meter · addr 36"
  serial: str | null
  model: str | null   # inverter device_model or model; datalogger_model; site device brand_model; grid meter device_name
  plant_id: int | null, plant_name: str | null, site_code: str | null, phase: int | null  (growatt_plants.phase)
  ip: str | null, network: str | null, sim: str | null      # site devices only (router IP / network = the VPN address)
  status: str | null  # site device status as written
  site_device_id: int | null, inverter_sn: str | null       # what POST /stock/replacements takes as the target
  path: str           # app route that opens it (same as the resolver's paths)
  spare_unit_id: int | null   # a spare unit `installed` with this serial (any part), when visible
  spare_part_id: int | null   # that unit's part (the Stock tab opens a unit only with `part=`: /inventory?tab=stock&part=&unit=)
  failed_open: bool           # an open failed unit (tagged / in store / sent) has this serial
}
```
- Dataloggers: the site register's `datalogger` devices, plus each Growatt `datalogger_sn` per plant
  that no site-register datalogger of that plant has (same serial, case-insensitive) → `source: datalogger`.
- `q`: case-insensitive substring of serial, label, model, plant name, site code, IP, SIM.
- Order: plant name, category (the order above), label.

### `GET /stock/installed/models` (everyone)

```
{ items: ModelRow[] }
ModelRow {
  category: PartCategory, model: str | null, model_key: str | null   # key = upper case, spaces collapsed
  installed: int, installed_by_phase: { "<phase>" | "none": int }
  in_stock: int, failed_open: int, at_supplier: int                    # spare units / failed units of the matching parts
  parts: [{ id, code, name, min_qty, active }]                         # catalogue parts matching (category + model key)
}
```
- "Thin" (UI) = in stock below the sum of the **active** parts' `min_qty` (as `below_min` of `/stock/parts`); an inactive part's minimum is left out.
- A part matches when its category is the row's and `key(model)` or `key(make + " " + model)` equals the row's key.
- Parts that match no installed model still get a row (installed 0), so every spare is counted.
- Counts are scoped like everything else (installed per visible plant; spares as `/stock/units`).

### `POST /stock/parts/from-models` (store keeper: `auth.can_manage_stock`, 403 otherwise)

Body `{ apply: bool, items?: [{ category, model, make, code, name }] }`.
- `apply: false` → `{ proposals: [{ category, model, make, code, name, installed, part_id, model_key }] }` for every
  (category, model) installed with a model recorded; `part_id` = an existing matching part (then nothing
  to create); `model_key` = the installed model's key (the `ModelRow.model_key` it came from; `model` may
  have its make split off, so match a row on `category` + `model_key`, never on `model`). Suggested make: Growatt for inverter / datalogger / shinemaster / weather_station; Chint for a `CHNT…` grid meter (Growatt reads it, it does not make it), else none;
  otherwise the first word of a multi-word model ("CEWE Prometer" → make CEWE, model Prometer;
  "Teltonika RUT" → Teltonika / RUT). Code `P-<CAT>-<MODEL>` (upper, non-alphanumerics → `-`, ≤ 40,
  `-2`, `-3` … when taken); name = make + model.
- `apply: true` → creates `items` with the catalogue's own validation, all or nothing (409
  `{message, errors: [{row, error}]}` as the batch), answers `{ created: StockPart[] }`; `app.audit` line.

### `GET /stock/registry-where?serials=A,B,…` (everyone; ≤ 200 serials, each ≤ 64; 422 otherwise)

```
{ items: { "<SERIAL KEY>": RegistryHit[] } }   # only serials with a hit; key = trimmed upper case
RegistryHit { source, category, label, plant_id, plant_name, site_code, ip, network, sim, path }
```
Matched exactly (case-insensitive) on inverter `device_sn` (installed ones), `datalogger_sn`, site
device `serial`. Scoped: hits on plants the user may not see are left out.

## Frontend

- `pages/spares/InstalledTab.tsx` (tab `installed`): filters (category, plant, phase, search), counts per category as chips, table (category, label, serial, model, plant / site code, IP / network, SIM, status, links: open, Replace (opens `ReplaceDialog` preset when it takes a target), spare / failed unit badges), CSV of the filtered rows, phone layout as the other tabs.
- `pages/spares/ModelsTab.tsx` (tab `models`, "Spares per model"): rows per model (installed, per phase, in stock, failed open, at supplier, min qty of the matching parts, a "thin" flag when in stock < the active parts' `min_qty` sum), filter by category, CSV; store keepers get "Add to catalogue" for a row with no part.
- `pages/spares/FromModelsDialog.tsx`: preview of the proposals, editable code / name / make, tick to include, apply; from the Catalogue tab ("From installed models", store keepers) and the Models tab.
- `pages/spares/RegistryWhere.tsx`: `useRegistryWhere(serials)` (batched, cached per serial for the page) and a small `RegistryChip` (category + label · site code, link to `path`, IP in the title). Used on the Stock tab's units (an `in_stock` / `missing` unit whose serial is registered as installed = amber: the spare is also on a plant), the failed units list and dialog, the movement list, and as a warning on receive (MoveDialog and the batch page's receive rows).
- Thai text in `i18n/th/stockInstalled.ts` (L-1, L-2, L-4) and `i18n/th/stockLinks.ts` (L-3).
