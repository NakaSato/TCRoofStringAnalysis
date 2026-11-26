# Plan & Spec: Spares and failed units (store register)

Status: **Phase 1 built 2026-11-26** (catalogue, locations, serialised units, movement ledger with corrections, store keeper flag, `/spares` Stock / Movements / Catalogue / Locations; §8 step 1). Phases 2–6 not built · Owner: Chanthawat

A register of the **spare parts** the O&M team keeps (in the store and in the crews' vans) and of the **failed units** taken off site, with every move between them recorded. It is the piece the scanning plan is waiting on (docs/plans/barcode-scanning.md §7.2, §7.3, §12 steps 5–6): binding a red tag to a failed unit, labels for bins and spares, and batch receive / issue / count at the store desk.

---

## 1. Why

- Spare routers, dataloggers, meters, inverters and consumables are tracked on paper or in a spreadsheet today. Nobody can see what is in the store or in a van before a crew drives out, so a visit can end with "no spare on hand".
- A failed unit taken off a roof has no record until someone opens a claim. Units get lost between the site, the van, the store and the supplier, and a claim cannot show where the failed unit is.
- The app already holds the other half of each story: the Site Register knows each device's serial on site, Claims keeps `old_sn` / `new_sn` and shipments, red tags are reserved and printed (scanning step 5), and the scanner resolves serials and app labels. A store register links them instead of adding another spreadsheet.

## 2. Scope

**In (v1)**
- **Parts catalogue**: what can be stocked (`P-ROUTER-RUT241`, "Teltonika RUT241 4G router"), its category (the Site Register's device kinds, plus inverter, module, consumable), make / model, and whether each unit has a serial.
- **Stock locations**: the store and its bins, each crew's van (decision D-3), the supplier (a unit away for RMA) and "on site" (installed, tied to a plant).
- **Spare units**: one row per serialised unit, with its state and where it is. Quantities of non-serialised parts come from the movements alone (decision D-2).
- **Failed units**: one row per device taken off site, bound to a red tag, with what failed, where it came from, where it is now, and the claim it belongs to.
- **Movements**: an append-only ledger of every receive, transfer, issue, return, failed-in, ship-out, return-from-supplier, scrap and count adjustment. Stock on hand is computed from it, never typed in.
- **Scanning**: the flows of barcode-scanning.md §7.2 (replacement on site, failed unit + red tag) and §7.3 (batch receive / issue / transfer / count), with `input_method` and `raw_scan` on each row.
- Links: a failed unit ↔ its claim; an install ↔ the Site Register device (or the Growatt inverter) it replaced.

**Out (later)**
- Money of any kind: prices, stock value, purchase orders, invoices. Like Claims, the register holds no amounts.
- Purchasing and reorder automation. v1 may show "below minimum" when an admin sets a minimum (decision D-6), but orders nothing.
- Photos of each unit (Knowledge Base / claim links cover evidence for now).
- Modules by serial at scale (thousands per plant): v1 stocks modules as a part with a quantity; module serials stay on the claim.

## 3. Constraints from the project rules

| Rule | What it means here |
|---|---|
| Never invent numbers (CLAUDE.md rule 3) | Quantities come only from movements and counts people confirmed. A count never overwrites stock silently: it proposes adjustment movements an authorised person confirms (§5.7). Nothing is estimated. |
| SQL only | Stock lives in SQL. Firestore gets nothing (no registry change). |
| Plant scoping | Store and van stock are fleet-wide, visible to everyone signed in. Anything tied to a plant (an install, a failed unit from a site) follows the usual scoping: an engineer sees only their plants' rows, others answer 404. |
| Audit | The ledger is the audit trail. Rows are never edited or deleted; a mistake is corrected with a reversing movement that names the one it corrects. |
| Serials | A serial is in exactly one place at a time. The same serial cannot be in stock and installed, or be two failed units at once (409 with the record that holds it). O ↔ 0 and I ↔ 1 are never swapped (barcode-scanning.md §6.2). |
| Red tags | A tag binds to one failed unit, once; numbers are never reused (`red_tags`, scanning step 5). |

## 4. Data model

```
parts            id, code (unique, e.g. P-ROUTER-RUT241), name, category, make, model,
                 serialised (bool), unit ("pc", "m", "box"), min_qty (null), active, note
stock_locations  id, code (unique, e.g. STORE-A-03, VAN-CREW2, SUPPLIER-GROWATT), name,
                 kind (store | bin | van | supplier), parent_id (bin → store), holder_user_id (van), active
spare_units      id, part_id, serial (unique per part), state (in_stock | installed | failed | at_supplier | scrapped),
                 location_id (null when installed), plant_id + site_device_id / inverter_sn (when installed),
                 received_day, note
failed_units     id, red_tag_id (unique), part_id (null = not in the catalogue), serial, plant_id,
                 site_device_id / inverter_sn (what it was), removed_day, fault (text), status (§5.5),
                 location_id, claim_id (null), spare_unit_id (when it was one of our spares)
stock_movements  id, batch_id (one confirm = one batch), kind, part_id, serial (null for quantities), qty,
                 from_location_id, to_location_id, plant_id (install / remove), failed_unit_id, claim_id,
                 corrects_id (a reversing movement), by, at, day, note, input_method, raw_scan
```

- **Kinds of movement**: `receive` (supplier / purchase → store), `transfer` (location → location), `issue` (store / van → installed at a plant), `return` (site → van / store, unused), `failed_in` (a failed unit off site → van / store), `ship_out` (→ supplier, for RMA), `supplier_return` (supplier → store, repaired or replacement), `scrap`, `count_adjust` (from a confirmed count), `correction` (reverses one movement).
- **Stock on hand** per location and part = movements in − movements out (non-serialised); for serialised parts, the spare units whose `location_id` is that location. A view or a query, never a stored total.
- The scan resolver (`services/scan.py`) gains `sp` (spare unit by serial or part code), `loc` (location code) and `rt` bound to a failed unit, in the lookup order of barcode-scanning.md §9.

## 5. Flows

### 5.1 Receive at the store (desk scanner)
Batch mode `/spares/scan?mode=receive&loc=STORE-A-03`: scan the bin label, then each unit. A known part code adds a quantity; a manufacturer serial asks once for the part (remembered per model like the label field hints) and creates a spare unit. A serial already in the register is refused with where it is. Confirm = one batch of `receive` movements. Optional: print `sp` labels for units with no readable barcode.

### 5.2 Load a van / issue to a crew
`transfer` store → van, by scanning in batch mode. Each crew sees its van's stock on the phone before a visit (decision D-3).

### 5.3 Replacement on site (phone camera, the main field flow)
From the plant's Site register card ("Replace device") or the Inverters page:
1. **Old unit**: scan its serial. It must match the register's device, or the app asks "Register says X, label says Y: update the register?" (barcode-scanning.md §7.2; no silent overwrite).
2. **Red tag**: scan a blank tag. It binds: a failed unit is created (`failed_in` to the crew's van) with plant, device, serial, day and the fault typed in. A tag already in use is refused (409).
3. **New unit**: scan the spare's serial. It must differ from the old one; it must be in this crew's van or the store (else a warning, and the person says where it came from). Confirm = `issue` (van → installed at the plant).
4. **Register**: the device's serial in the Site Register changes to the new one (decision D-4). For an inverter, the Growatt registry picks the new SN up on the next `fleet` run; the old SN is marked "not installed" by an admin as today.
5. **Claim**: offer "Open a claim" prefilled (type by category, plant, old SN, new SN, the failed unit and its red tag).

### 5.4 Failed unit back to the store
Scan the red tag at the desk: `transfer` van → store bin for failed units. The failed unit's page shows its trail: site → van → store → supplier → back.

### 5.5 Failed unit status
`tagged` (on site / in a van) → `in_store` → `sent` (to the supplier, with the claim's shipment) → `repaired` (back as a spare, same serial) / `replaced` (supplier sent another unit: a new spare unit, the failed one closed) / `scrapped` → `closed`. A claim's shipment entry and the movement are made together, so the two never disagree.

### 5.6 Return unused parts
`return` site → van / store, for a spare taken to site and not installed.

### 5.7 Count (stock take)
Count mode: scan a bin, scan everything in it. The page compares the scan with the computed stock: match · missing · extra · in another location. Nothing changes until an authorised person (decision D-1) confirms; the confirm writes `count_adjust` movements, each with the count it came from.

## 6. UI

- Sidebar **Operations → Spares** (`/spares`), tabs:
  - **Stock**: by part (on hand per location, below minimum flagged) and by location; search, filters, CSV.
  - **Failed units**: red tag, plant, device, serial, status, age, claim; filters by status and age.
  - **Movements**: the ledger, filterable by part, serial, location, plant, person, kind, day; CSV.
  - **Catalogue** and **Locations** (admin, decision D-1).
- `/spares/scan?mode=receive|issue|transfer|return|count&loc=` batch page (barcode-scanning.md §7.3): rows with status (new · duplicate · elsewhere · unknown), editable quantities, kept in `sessionStorage` until confirmed, one all-or-nothing confirm (`POST /stock/movements/batch`, 409 with the failing rows).
- A unit's / failed unit's page: where it is now and its full trail.
- Site register card: **Replace device** (§5.3). Claim page: the failed unit with its trail and a "ship" action that records the shipment and the movement together.
- Labels: `sp` (spare unit, part code) and `loc` (bin) join the `/labels` page; red tags already print.

## 7. API (sketch)

```
GET/POST/PATCH  /stock/parts, /stock/locations            (POST / PATCH: decision D-1)
GET             /stock/on-hand?part=&location=            computed from the ledger
GET             /stock/units?serial=&state=&location=     serialised spare units
GET/POST        /stock/failed-units                       POST binds a red tag (409 when used)
PATCH           /stock/failed-units/{id}                  fault text, claim link (status moves only by movements)
GET             /stock/movements?…                        the ledger
POST            /stock/movements/batch                    all-or-nothing; rows carry input_method + raw_scan
POST            /stock/replacements                       §5.3 in one transaction: failed_in + issue + register update
POST            /stock/counts  → proposal;  POST /stock/counts/{id}/confirm → count_adjust movements
```

## 8. Build order

1. **Built 2026-11-26.** Catalogue, locations, ledger, on-hand query; receive / transfer / issue / return by hand (the serial field takes a scanner or the camera; batch scanning is step 4); corrections (a unit's latest movement, store keeper, reason required); Stock, Movements, Catalogue and Locations tabs; store keeper column in Users & Access. Tests (`backend/tests/test_stock.py`): replaying the ledger gives every unit's state and place; a serial is in one place; all-or-nothing batches; permissions; plant scoping. A store keeper is still scoped to the plants assigned.
2. Failed units + red tag binding; Failed units tab; claim link and ship action.
3. Replacement on site (§5.3) from the Site register card, with the register update (D-4).
4. Batch scan page (receive / transfer / return), `sp` / `loc` resolver and labels.
5. Count mode with confirmed adjustments.
6. Initial stock load (D-5), then the device matrix check of barcode-scanning.md §11 at the store desk.

## 9. Decisions (2026-11-26)

1. **D-1 Who manages stock:** admins, plus users with a **store keeper** permission (a flag on the user, set in Users & Access). Store keepers and admins receive, confirm counts and edit the catalogue and locations; engineers do the field moves (load a van, replace a device, return parts, move a failed unit).
2. **D-2 Scope of v1:** **serialised units only** (routers, dataloggers, meters, inverters, one row per serial). Counted consumables (fuses, MC4 connectors, cable) come in a later phase; the data model keeps `qty` so they need no migration.
3. **D-3 Vans:** **one stock location per crew van**. A crew sees its van's stock before a visit, and a replacement takes the spare from the van.
4. **D-4 Site Register on replacement:** **updated at once** with the new serial (the replacement records who and when). The next O&M workbook import then shows the workbook as out of date for that device; the workbook is brought up to date from the app's register export.
5. **D-5 Starting stock:** **a first full count with the scanner** at the store desk, after the bins are set up and labelled. No spreadsheet import.
6. **D-6 Alerts (in the app only, nothing ordered or emailed):** a **minimum per part** with "below minimum" on the Stock tab, and **failed units not sent** to the supplier after a number of days (a setting, `STOCK_FAILED_UNSENT_DAYS`, default 14, until you set another).
7. **D-7 Typed serials:** a label **photo is optional**. A typed serial is marked "Typed" (`input_method = manual`, `raw_scan` kept) on its movement.
