# Plan & Spec: Field faults (defect register before and around a replacement)

Status: **Building**: steps 1, 4 and 5 (API) and step 2 (Faults page, `/faults`) done 2026-11-27 · Created 2026-11-26 · Owner: Chanthawat
Related: PMBOK *Field Equipment Defect & Replacement Management* (FEDR) §1.5 items 1–2, 6; [`spares-failed-units.md`](spares-failed-units.md) (Inventory: spares, failed units, Replace dialog); [`inventory-installed-base.md`](inventory-installed-base.md); [`claims.md`](claims.md); [`decision-rules.md`](decision-rules.md) (issues, Site log); [`devices-page.md`](devices-page.md) (device checks); [`calendar-team.md`](calendar-team.md); [`barcode-scanning.md`](barcode-scanning.md) (`df:` label kind, reserved)

A **field fault** is one physical or service problem on one plant, recorded by a person: a router that is dead, a VPN tunnel that is down, a SIM that has expired, an optimizer that does not report, a cracked module, a burnt MC4 connector, an inverter showing a fault code. The record follows the fault from the moment it is found, through the decision (repair, replace, claim, monitor, nothing), to the day the plant works again. It links the evidence the app already has (issue, alarm, device check) and the actions it already records (Inventory replacement, failed unit, claim, Site log, Calendar task), without copying them.

This is the part of FEDR that Inventory does not cover. Inventory starts at "take a spare, swap it, tag the failed unit". Nothing records the fault *before* that, a fault fixed without a part (a reset, a config change, a reseated connector), or how long the plant waited.

---

## 1. Why

- **Issues** (`growatt_issues`) are opened only by decision rules, on inverters and strings. A dead 4G router, an expired SIM, a down VPN tunnel, a failed optimizer or a cracked module found on a visit has no record until someone opens a claim or swaps a part.
- **Site log** (`site_events`) records work done (repair, replaced, site visit), not the problem waiting for work: no "found on", no severity, no decision, no owner.
- **Inventory** records the swap and the failed unit, and **Claims** the warranty case, but neither answers:
  - what is broken right now on plant P2-031, and since when?
  - which faults are waiting on a part, the supplier, or site access?
- **Time to restore** (found → working) cannot be measured today. FEDR objective O5 needs it, with a baseline taken from real data, not assumed.
- The scanner already reserves the `df:` label kind for this register (`services/scan.py`, "a label kind whose register is not built yet (defects)").

## 2. Scope

**In (v1)**
- `/faults` (sidebar Operations → **Faults**), open to everyone, scoped like the rest of the app: an engineer sees and edits faults on assigned plants only. Others answer 404.
- Create a fault by hand, or prefilled from:
  - an **Issue**
  - an **Active Alarm** row
  - a **Devices check** row
  - an **Installed** row in Inventory
  - a **scan** of a device serial
- A status workflow with a timeline, a decision with a reason, a **next action date**, and an owner.
- Links to the records that answer it:
  - an Inventory replacement (movement batch) and the failed unit(s)
  - a claim
  - Site log entries
  - a Calendar task
- Restore time computed from the fault's own timestamps.
- Fault list with search, filters, summary counts and CSV export; a plant card "Open faults"; `df:` labels resolve to the fault.

**Out (later)**
- Photo uploads. v1 stores URLs, the same as Claims v1 (a Drive folder per fault or a KB link).
- Money of any kind (cost of the fault, cost of the part), as in Claims and Inventory. Estimated loss appears only as the linked Issue already shows it, labelled *estimated*.
- Automatic fault creation from rules or checks. Rules already make issues; a person decides when an issue is a field fault.
- Router / VPN live checks. The app has no route into the site VPN (`om-asset-network.md`).
- Mean time between failures per model. This waits for enough closed faults; see §11 Q6.

## 3. Fault kinds

`kind` is a fixed list, aligned with the Inventory part categories so a replacement can be offered for the right parts:

| Kind | What | How the device is identified | Typical decision |
|---|---|---|---|
| `inverter` | Fault code, fan, AFCI, display, no output | Growatt SN (registry) | repair on site · replace (Inventory) · claim (`inverter_warranty`) |
| `pv_module` | Cracked glass, hot spot, burnt junction box, low power | Position: inverter SN + MPPT + string + module no.; module SN if readable | replace · claim (`module_warranty`) · monitor |
| `optimizer` / `rsd` | Unit failed, not reporting | Position as above; unit SN | replace · claim (`equipment_warranty`) |
| `datalogger` | Offline, stuck firmware, damaged | SN (registry / Site Register) | reset · replace |
| `router_4g` | Dead, power supply, antenna | Site Register device (SN, IP) | replace · repair |
| `revenue_meter` / `grid_meter` | No readings, comm loss, wrong CT | Site Register / Growatt meter | repair · replace · PEA |
| `weather_station` | Sensor fault, wrong values | Site Register / Growatt sensor | clean · replace |
| `pqm` / `shinemaster` | No data | Site Register device | reset · replace |
| `dc_bos` | DC fuse, SPD, isolator, MC4, cable | Location text (combiner / string) | repair on site |
| `ac_bos` | Breaker, AC SPD, cable, panel part | Location text (panel / feeder) | repair on site |
| `structure` | Clamp, rail, tray, walkway | Location text | repair |
| **`service`** | **VPN tunnel down, SIM expired / blocked / no data, APN or router config lost** | Site Register router (SN, IP, network, SIM) + what failed (`vpn` / `sim` / `config` / `other`) | **remote fix** · carrier ticket · replace SIM |
| `other` | Anything else | Free text | |

`service` faults never need a part. They need an owner, a reference (carrier ticket no., config version) and a fix date. **Secrets never go in a fault**: no keys, passwords or VPN config text. A config backup is referred to by its name and location only.

**Severity** (set by the person, changeable, recorded on the timeline):
- `S1` safety: exposed live parts, burnt connector, damaged module glass on a walkway. Shows the PTW / isolation reminder and pushes to the plant's engineers at once.
- `S2` generation or revenue
- `S3` data / monitoring only
- `S4` minor

**How found:** `alarm` · `issue` · `device_check` · `site_visit` · `client_report` · `ir_flight` · `iv_sweep` · `other`.
**Cause:** the Claims list (lightning, storm_wind, flood, fire, theft, animal, manufacturing_defect, degradation, installation, unknown, other) plus `config` and `carrier` for service faults.

## 4. Constraints from the project rules, and where faults live

| Rule | What it means here |
|---|---|
| Never invent numbers (CLAUDE.md rule 3) | Dates, serials and positions are as entered or scanned. Lost energy is never computed here; a linked issue's `lost_kwh_est` / `thb_per_day_est` is shown as-is with the label *estimated*. Restore time is computed only from recorded timestamps; a fault with no restore time shows "—". |
| SQL only | Faults live in SQL. Firestore gets nothing. |
| Plant scoping | Every fault has a plant. Lists are filtered with `allowed_plant_ids`; other plants answer 404 (resolve of `df:` included, as for other kinds). |
| Page state in the URL | Tab, search, filters, sort and the open fault (`fault=<id>`) via `useUrlState`. |
| One REST client | Types in `api/types/faults.ts`, methods in `api/client.ts`. |
| Audit | Every change adds a timeline event and goes to `app.audit`. Faults are never deleted; a wrong one is `cancelled` with a note. |
| Serials | A fault's device serial is read from the register when the device is picked. A typed or scanned serial records `input_method` and `raw_scan` like Inventory. O ↔ 0 and I ↔ 1 are never swapped. |

**Why a new table, not manual rows in `growatt_issues`** (decision F-1):
- Issues are rule-driven: at most one open per (plant, inverter, string, rule).
- They close themselves after 2 quiet days, carry `shadow` and `feedback`, and feed rule calibration and the O&M Dashboard loss bars.
- Manual rows there would distort those figures and could auto-close.
- A fault links to issues instead (many-to-many, via `field_fault_links`).

## 5. Status workflow

```
open ──► diagnosed ──► waiting ──► scheduled ──► restored ──► closed
  │          │            ▲  │                       ▲
  │          └──decision──┘  └─(part / claim / supplier / access / carrier)
  │                                                    │
  ├──► monitor ───────────────────────────────────────┤ (restored or closed when it is clear)
  ├──► no_action ──► closed
  └──► cancelled (recorded in error / duplicate)
```

- `waiting` has a **reason**: `part` (no spare on hand) · `claim` (waiting on the manufacturer) · `supplier` (a unit away for repair) · `access` (site or client permission, PTW) · `carrier` (SIM / network ticket) · `other`.
- **Decision** (asked when leaving `open` / `diagnosed`, with a reason): `repair_on_site` · `replace` · `claim` · `remote_fix` (service) · `monitor` · `no_action`. A decision can change; each change is on the timeline.
- **Next action date**, optional. Past it, the fault shows "Follow up" in red. With no date entered, nothing is flagged; the app never assumes a response time.
- **Restored** needs a restore timestamp (default now, editable, not in the future, not before `found_at`). For `replace`, it is offered when the Inventory replacement is saved (§6.3).
- **Closed** needs `restored` (or `no_action` / `monitor` with a note). It stays reopenable by anyone with the plant.
- **Waiting on us:** `open`, `diagnosed`, `scheduled`, `waiting` with reason `part` / `access`. **Waiting on others:** `waiting` with reason `claim` / `supplier` / `carrier`.

## 6. Flows

### 6.1 From the evidence the app already has
- **Issues** page / plant issue row: "Record fault" prefills the plant, inverter SN, string, kind (`inverter` or `pv_module` by rule), how found = `issue`, and the link.
- **Active Alarm** row: "Record fault" with the alarm's plant, device and time (how found = `alarm`). Alarms are not stored per event, so the link keeps the alarm's key and time as text.
- **Devices → Checks** row (e.g. datalogger offline, router no SN): "Record fault" with the device.
- **Inventory → Installed** row: "Record fault" next to "Replace".
- Before creating, the dialog lists **open faults on the same device** and offers "add to this one" instead, so duplicates are avoided.

### 6.2 On site (phone)
1. Scan the device serial or a `dev:` label (ScanField, camera on site) → the plant and device are filled.
2. Kind, symptom, severity, how found = `site_visit`, and an evidence URL if taken.
3. Decide now or later. `repair_on_site` + restored now closes it in one step.

### 6.3 Replace (Inventory)
- "Replace" on a fault opens the existing **ReplaceDialog** (`pages/spares/ReplaceDialog.tsx`) with the plant and device set.
- On save, the replacement's movement batch and the failed unit (red tag) are linked to the fault. The dialog offers "Mark the fault restored" (one tap).
- The Site Register update, the failed-unit record and the optional claim stay exactly as Inventory does them.

### 6.4 Claim
"Start claim" opens the Claims create dialog prefilled (type from the kind, plant, SN, evidence links from the fault). The claim id is linked and the fault goes to `waiting` / `claim` when the decision is `claim`.

### 6.5 Plan the visit
"Plan visit" creates a Calendar task (`om_tasks`) for the plant with the fault in its note and a link back. The fault goes to `scheduled` with the task's day. Visit Route shows the fault as the stop reason.

### 6.6 Service faults
- Kind `service`, sub-type `vpn` / `sim` / `config` / `other`, the router picked from the Site Register.
- Decision `remote_fix` or `waiting` / `carrier`, with the carrier ticket no.
- Restored when data arrives again. The person sets the timestamp; the Devices check going green is shown as a hint, not as an automatic restore.

## 7. Page (`/faults`)

```
┌ PageHeader: Faults                                                   [Record fault] ┐
├ Summary: Open · S1 open · Waiting on us · Waiting on others · Follow-up overdue    │
│          (each count is a button that sets the filter)                              │
├ Card ──────────────────────────────────────────────────────────────────────────────┤
│  Tabs: Open | Restored (not closed) | Closed | All                                  │
│  [Search no. / plant / SN / text] [Kind ▾] [Severity ▾] [Status ▾] [Plant ▾]  CSV   │
│  Table + Pagination                                                                 │
└─────────────────────────────────────────────────────────────────────────────────────┘
```

- **Columns:** no. (`DF-2026-0042`), plant (link), kind + device (SN / position), severity badge, status (+ waiting reason), decision, found (date + age in days), next action (red when past), linked (icons with counts: issue, claim, replacement, task), actions (⋯: open, change status, decide, replace, start claim, plan visit, add note, cancel).
- **Detail dialog** (URL `fault=<id>`):
  - header
  - what (device, position, symptom, cause, how found, evidence URLs)
  - linked records (each a link into its own page)
  - timeline
  - restore time (found → restored, in days and hours; "—" when not restored)
- **Plant page:** an "Open faults" card on the plant overview and the Maintenance tab (count + list, Record fault).
- **Badges:** S1 `crit`, S2 `warn`, S3 `info`, S4 neutral. Status `open` / `diagnosed` warn, `waiting` info, `scheduled` info, `restored` ok, `closed` / `cancelled` / `no_action` neutral, `monitor` neutral.
- **Labels:** `df:` QR via the existing label sheet (scanning step 5) for a fault tag on a device waiting for a part.

## 8. Data model (SQL only; migration + `ensure_schema`)

```
field_faults        id, no (unique, DF-YYYY-NNNN), plant_id, kind, sub_kind (service: vpn|sim|config|other),
                    inverter_sn (null), site_device_id (null), growatt_meter_id (null), stock_unit_id (null),
                    position (JSON: mppt, string_no, module_no, location text; null), serial (null),
                    serial_input (hid|camera|photo|manual|register), serial_raw,
                    symptom (text), how_found, found_at (timestamptz), found_by,
                    severity (S1..S4), cause (null),
                    status, waiting_reason (null), decision (null), decision_reason (null),
                    owner_user_id (null), next_action_day (null),
                    restored_at (null), closed_at, closed_by, close_note,
                    evidence_urls (JSON list), reference (carrier ticket / config version; null),
                    created_by/at, updated_at
field_fault_events  id, fault_id, at, by, kind (status|decision|severity|note|link|unlink), from, to, text
field_fault_links   id, fault_id, kind (issue|alarm|device_check|claim|failed_unit|stock_batch|site_event|om_task|kb),
                    ref_id (int, null), ref_key (text, null: alarm key + time, check code), created_by/at
```

- Indexes: (`plant_id`, `status`), (`kind`, `status`), `serial`, `inverter_sn`, `site_device_id`.
- **One open fault per device and kind** is a soft rule: the create dialog warns and offers to add to the open one, and the API answers 409 unless `allow_duplicate: true`. Two failed modules in one string are two faults with different positions.
- Restore time = `restored_at − found_at`, computed in the read API, never stored.
- Numbering: `DF-<Bangkok year>-<4 digits>`, a counter per year (same pattern as `CL-`).

## 9. API (DB only; `services/faults.py`, `api/routes/faults.py`)

```
GET    /faults?status=&kind=&severity=&plant=&q=&waiting=&tab=      → list + summary counts (scoped)
POST   /faults                                                      → create (409 on an open duplicate unless allow_duplicate)
GET    /faults/{id}                                                 → detail, links resolved to labels, timeline
PATCH  /faults/{id}                                                 → fields (symptom, cause, severity, owner, next_action_day, evidence, reference)
POST   /faults/{id}/status        {status, waiting_reason?, restored_at?, note}
POST   /faults/{id}/decision      {decision, reason}
POST   /faults/{id}/links         {kind, ref_id | ref_key}          DELETE /faults/{id}/links/{link_id}
POST   /faults/{id}/notes         {text}
GET    /faults/open-on-device?inverter_sn=|site_device_id=|serial=  → for the duplicate check in create dialogs
GET    /faults/report?start=&end=&group=kind|model|plant|phase      → counts, restore-time median and p90 (closed faults only), CSV
```

- **Scope:** an engineer acts on assigned plants only. Admins see all. Store keepers have no special rights here.
- **Integrations:** the existing endpoints stay as they are. They gain one optional field each:
  - `POST /stock/replacements` and `POST /stock/failed-units`: `fault_id`, which writes the link and offers restore
  - `POST /claims`: `fault_id`
  - Calendar task create: `fault_id`
- **Scan:** `services/scan.py` resolves `df:<no>` to `/faults?fault=<id>` (today "register not built yet").
- **Push:**
  - an S1 fault created → the plant's engineers, at once
  - a weekly digest of follow-ups past due, to each owner

  Both use the existing push service.

## 10. Build order

1. Migration + `services/faults.py` (create, status, decision, links, notes, duplicate check, numbering), tests `tests/test_faults.py`:
   - scoping (404)
   - duplicate 409
   - restore before found → 422
   - a closed fault reopened
   - restore time computed
   - `df:` resolve
2. Page `/faults` (list, filters, summary, detail dialog, CSV) + the "Record fault" dialog with ScanField and the device picker (Growatt inverters, Site Register devices, Growatt meters).
3. "Record fault" entry points: Issues, Active Alarm, Devices checks, Inventory Installed. Plant card.
4. Links out: Replace (ReplaceDialog with `fault_id`), Start claim, Plan visit; the optional `fault_id` on those endpoints.
5. Report (counts and restore time per kind / model / plant / phase) + push (S1, weekly follow-ups).
6. `bun run lint && bun run build`, `uv run pytest -q`, role tests (admin, engineer, store keeper). Update `frontend/CLAUDE.md`, `spares-failed-units.md` (link to faults), `barcode-scanning.md` (`df:` resolves), and the FEDR PMBOK.

## 11. Decisions and open questions

Proposed (see the Decision Log, F-1…F-5):

1. **F-1 Where faults live:** a new `field_faults` table, not manual rows in `growatt_issues` (§4).
2. **F-2 Issue required?** No. Link an issue when one exists.
3. **F-3 Service faults** (VPN, SIM, config) are in scope as kind `service` (§3).
4. **F-4 Who closes:** the engineer on their own plants; anyone with the plant may reopen.

Open:

5. Should an **S1** fault also create an Issue-like alert on the O&M Dashboard, or is the push enough?
6. **Failure rates per model:** show them only after a minimum number of closed faults per model (a setting, no default until someone sets it), labelled *derived*?
7. Do **client reports** (PWA staff calling about a site) need a "reported by" contact field, or is the note enough? *Step 1: the note (no contact field).*
8. Should the **next action date** be required for `waiting` (so nothing waits silently), or stay optional as in Claims? *Step 1: optional, as in Claims.*

Built differently from §8 (step 1): the Growatt meter is referred to by `meter_datalogger_sn` + `meter_address` (its key; there is no meter id), and a fault with no device and no serial (BOS, structure) is never a duplicate. Step 5: the S1 push goes to admins and the plant's engineers (not whoever raised it) through the worker (`faults_push`, queued by the API; the API cannot send), only within 6 h of becoming S1; the weekly follow-up digest rides on `om_weekly`. The report's restore time is median / p90 by nearest rank over closed faults.
