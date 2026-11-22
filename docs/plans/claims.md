# Plan & Spec: Operations → Claims (frontend)

Status: **Built 2026-11-20**: frontend 2026-11-19 on mock data, backend `/claims` 2026-11-20 (mock removed) · Created 2026-11-19 · Owner: Chanthawat

A new **Claims** page in the sidebar's **Operations** group. It tracks every **warranty and insurance claim** for plant equipment: a failed Growatt inverter sent for RMA, modules below warranted power, a lightning-damaged datalogger, storm damage claimed on insurance. For each claim it shows what failed, at which plant, who the claim is with, what evidence is attached, and where the claim stands. This plan covers the frontend. It lists only the API the page needs (§8); the backend gets its own plan.

---

## 1. Why

- Inverter RMAs and module claims are handled by email and spreadsheets today. Nobody can see which claims are waiting on Growatt, which are waiting on us, or how long a replacement has been outstanding while the plant loses energy.
- The app already holds most of the evidence a claim needs: the inverter's alarm log (Active Alarm), the issue with its estimated loss (Issues), the I-V sweep that flags a **module test candidate** (String Analysis), the site log (Maintenance). A claim should link to that evidence instead of copying screenshots.
- `docs/plans/Data-Driven Decisions…md` §5 already defines when a module claim is justified (PLR worse than the warranty slope, confirmed by IR / I-V). The page gives that rule somewhere to land.

## 2. Scope

**In (v1)**
- `/claims` (sidebar label **Claims**), open to **everyone**, scoped like the rest of the app: an engineer sees only claims on their assigned plants.
- Claim list with search, filters, summary counts and CSV export.
- Create a claim from scratch, or prefilled from an **Issue**, an **inverter** (Inverters page) or an **I-V sweep** that is a module test candidate.
- Status workflow with a timeline (status changes, notes, messages sent / received, shipments).
- Evidence checklist per claim type, with links into the app's own pages.
- No money: the page tracks no amounts (claimed, approved, recovered, costs or estimated loss).
- For an inverter swap: the serial number taken out and the one put in.

**Out (later)**
- File uploads (photos, PDFs, IR reports). v1 stores URLs (e.g. a Google Drive folder per claim).
- Sending emails to the manufacturer or insurer from the app.
- A warranty register (warranty end date per inverter / module batch). The Growatt registry has no warranty dates, and the page will not guess them (§4). See §10.
- Expense / reimbursement claims (staff costs). This page is about equipment.

## 3. Claim types

`type` is a fixed list, so filters, the evidence checklist and reports stay consistent:

| Type | With (counterparty) | Scope | Evidence checklist (v1) |
|---|---|---|---|
| `inverter_warranty` | Manufacturer (Growatt) | plant + inverter SN | Alarm / fault log extract · photos of the display / nameplate · site log entry of the failure · Growatt case number |
| `module_warranty` | Module manufacturer | plant + inverter + string(s) + module serials | I-V sweep at STC (module test candidate) · second source (IR flight or time-series issue) · PLR analysis (when ≥ 2 years of data) · module serials · photos |
| `equipment_warranty` | Manufacturer / supplier | plant + device (datalogger, meter, weather sensor, optimiser, combiner, other) | Device SN · fault description · photos |
| `insurance` | Insurer | plant (+ any devices) | Incident report · photos · weather evidence (radar / Google Weather for the day, labelled as modelled / radar-derived) · repair quotation · police report (theft) |
| `workmanship` | Installer / EPC | plant (+ devices) | Defect description · photos · contract / warranty reference |

The checklist items are ticks a person sets, each with an optional link or note. Where the app has the evidence, the item offers a link to it (e.g. "Alarm log for this inverter" → `/alarms?…` filtered to the SN and dates; "I-V sweep #123" → the String Analysis page). The app never ticks an item on its own.

**Incident cause** (for insurance and to report on later): `lightning`, `storm_wind`, `flood`, `fire`, `theft`, `animal`, `manufacturing_defect`, `degradation`, `installation`, `unknown`, `other`.

## 4. Constraints from the project rules

| Rule | What it means here |
|---|---|
| Never invent numbers (CLAUDE.md rule 3) | Dates, serials and warranty terms come only from what people enter. No warranty end date is shown unless someone entered it on the claim. A missing value shows "—". The page shows no amounts. |
| Data loaded per route (`routeData`) | The page loads its own data. `routeData` is unchanged. |
| Page state in the URL (`useUrlState`) | Tab, search, filters, sort and the open claim go in the query string, validated with `pick`. |
| One REST client | Types in `api/types/claims.ts`, methods in `api/client.ts`, no `fetch` in components. |
| shadcn, no decorative icons | Active Alarm / Measuring Tools layout: `Card`, line `Tabs`, `Select`, `Table` + `Pagination`, `Dialog`, `Popover` + `Calendar`, `Checkbox`, `DropdownMenu`. |
| Firestore = summaries + registry | Claims live in SQL only. |
| Plant scoping | An engineer can open a claim only on an assigned plant; the plant `Select` uses the scoped fleet list. |

## 5. Status workflow

```
draft ──submit──► submitted ──► under_review ──► approved ──► fulfilled ──► closed
  │                   │              │  ▲           │            (replaced / repaired / paid)
  │                   │              ▼  │           │
  │                   │         info_requested
  │                   │
  └──withdraw─────────┴────────────────────────────► withdrawn
                                     under_review ──► rejected ──► closed (or reopen → under_review)
```

- **Waiting on us**: `draft`, `info_requested`, and `approved` when the next step is ours (ship the failed unit, sign the settlement). **Waiting on them**: `submitted`, `under_review`, `approved` awaiting the replacement or payment.
- Every status change asks for a note and adds a timeline entry. The timeline also takes **message** entries (sent / received, with a date and a short summary) and **shipment** entries (direction out / in, carrier, tracking number, SN).
- **Next action date**: set when the status changes (e.g. "Growatt said 10 working days"). Past it, the claim shows "Follow up" in red. The app does not assume a response time; with no date entered, nothing is flagged.
- **Inverter swap**: on `fulfilled`, an `inverter_warranty` claim asks for the new inverter SN. The registry picks the new SN up from Growatt on the next `fleet` run; the claim keeps both serials so the inverter's history can be followed across the swap (later: show the claim on both inverters' pages).

## 6. Page layout (`/claims`)

```
┌ PageHeader: Claims                                                [New claim] ┐
├ Summary Card: Open · Waiting on us · Waiting on them · Follow-up overdue      │
│               (each count is a button that sets the filter)                   │
├ Card ──────────────────────────────────────────────────────────────────────── │
│  Tabs: Open | Closed | All                                                    │
│  [Search no. / plant / SN / ref] [Type ▾] [Status ▾] [With ▾] [Plant ▾]  CSV  │
│  Table (rows fit the screen, Pagination under it)                             │
└───────────────────────────────────────────────────────────────────────────────┘
```

**Table columns**: claim no. (`CL-2026-014`), type, plant (link), what (inverter SN / string / device, with the cause below), with (counterparty + their reference), status badge, age (days since submitted, or since created for drafts), next action (date, red when past), actions (⋯: Open, Change status, Add note, Add message, Add shipment, Withdraw).

**Badges**: `draft` neutral · `submitted` / `under_review` info · `info_requested` warn · `approved` ok · `fulfilled` ok · `rejected` crit · `closed` / `withdrawn` neutral. "Follow up" crit when the next action date is past.

**Detail dialog** (URL `claim=<id>`, wide, scrollable), sections:
1. Header: claim no., type, status, plant, counterparty + reference, actions.
2. **What failed**: plant, inverter SN (link to `plantPath(id, "inverters")` with the SN selected), string(s), module serials, device; incident day, discovered day, cause, description.
3. **Linked records**: issues, I-V sweeps, site log entries. Each is a link; "Link…" adds one by id or from a picker of the plant's open issues.
4. **Evidence checklist** for the type (§3): tick, link / note, who ticked it and when. "Ready to submit" shows when all required items are ticked; submitting with items missing asks for a confirmation.
5. **Timeline**: status changes, notes, messages, shipments, newest first.

**Create / edit dialog**: type first; the form then shows the fields for that type (§3). Prefill:
- From an **Issue** (new row action "Open claim" on `IssuesPage` / `InverterIssuesCard`): plant, inverter SN, string, link to the issue; type `inverter_warranty` for inverter rules, `module_warranty` for string rules.
- From the **Inverters** page (fault log card): plant, SN, type `inverter_warranty`, incident day = the first fault of the selected period.
- From an **I-V sweep** with `module_test_candidate`: plant, SN, string, link to the sweep, type `module_warranty`.
- A claim that already exists for the same SN and is still open is offered first ("CL-2026-009 is open for this inverter: open it instead?").

**URL state**: `tab` (open | closed | all), `q`, `type`, `status`, `with`, `plant`, `wait` (us | them | followup), `sort`, `desc`, `claim` (id), and `new` (blank | issue | inverter | sweep) with `p` (plant), `sn`, `no` (string), `ref` (issue / sweep id) for the prefilled create dialog, so the other pages just link to it.

## 7. Files

```
src/api/types/claims.ts               Claim, ClaimType, ClaimStatus, ClaimCause, Counterparty, EvidenceItem,
                                      ClaimEvent (status | note | message | shipment), ClaimLink,
                                      ClaimList (+ summary), bodies for create / patch / status / event / evidence
src/api/client.ts                     re-export the types, add the api.* methods of §8
src/api/claimsMock.ts                 mock with the same signatures, `CLAIMS_MOCK` (dev or VITE_CLAIMS_MOCK=1),
                                      like the Measuring Tools mock; removed before merging the backend
src/pages/ClaimsPage.tsx              page export only: header, summary, tabs, filters; reads useUrlState
src/pages/claims/useClaims.ts         listClaims on mount and after each change; re-read every 5 min while visible
src/pages/claims/ClaimTable.tsx       the table (filter / sort in memory: tens to hundreds of claims)
src/pages/claims/dialogs.tsx         create / edit (fields by type, prefill from `new=`, "already open" check), change status,
                                      note / message / shipment, evidence item, link a record
src/pages/claims/ClaimDetail.tsx      detail dialog sections (§6)
src/lib/claimLinks.ts                 `newClaimHref()` for the entry points, so they don't load the Claims page code
src/pages/claims/format.ts            type / status / cause labels, badges, allowed transitions, claim no., CSV columns
```

Wiring:
- `App.tsx`: `const ClaimsPage = page(() => import("./pages/ClaimsPage"), "ClaimsPage")` and the route `/claims`.
- `Layout.tsx` `NAV_GROUPS` → Operations, after Issues: `{ to: "/claims", label: "Claims", icon: FileWarning, description: "Warranty & insurance claims: what failed, who has it, where it stands" }`.
- Entry points: "Claim" in `IssueActions` (components/issues.tsx: Issues page, inverter Issues tab, String page rules panel; issues with an inverter only), "Open claim" in the inverter's Issues tab header (`InverterIssuesCard`), and in `StringIvSweepPanel` next to the module-test-candidate badge. Each is a `Link` built by `newClaimHref()`: `/claims?new=issue|inverter|sweep&p=<plant>&sn=&no=&ref=<issue / sweep id>`.
- `routeData`: no change. Add `/claims` to the routes list in `frontend/CLAUDE.md`.
- No new shadcn components: `dropdown-menu` and `checkbox` came with Measuring Tools.

## 8. API the page needs (backend contract)

```
GET    /claims?status=&type=&plant_id=        → ClaimList { claims[], summary{ open, waiting_us, waiting_them,
                                                   followup_overdue }, meta{ today } }
GET    /claims/{id}                            → Claim + events[] + evidence[] + links[]
POST   /claims                                 → Claim            (status draft; engineer on an assigned plant)
PATCH  /claims/{id}                            → Claim            (fields)
POST   /claims/{id}/status                     → Claim            { status, note, next_action_day?, new_sn? }
POST   /claims/{id}/events                     → ClaimEvent       { kind: note|message|shipment, day, direction?, summary,
                                                                    carrier?, tracking_no?, sn? }
PUT    /claims/{id}/evidence/{key}             → EvidenceItem     { done, url?, note? }
POST   /claims/{id}/links                      → ClaimLink        { kind: issue|iv_sweep|site_log, ref_id }
DELETE /claims/{id}/links/{link_id}
DELETE /claims/{id}                   (admin)  only a draft; otherwise withdraw
```

`Claim` fields:
- `id, number, type, status, cause, plant_id, plant_name, device_sn | null, string_nos[], module_serials[], device_label | null`
- `counterparty, counterparty_ref | null, incident_day | null, discovered_day | null, submitted_day | null, closed_day | null`
- `next_action_day | null, followup_overdue, waiting_on (us | them | null)`
- `old_sn | null, new_sn | null, warranty_end_day | null (as entered)`
- `evidence_done, evidence_required` (counts), `created_by, updated_by, created_at, updated_at`

The backend checks status transitions (409 on an invalid one), computes `waiting_on`, `followup_overdue` and `summary`, numbers claims per year, and scopes everything to the user's plants.

## 9. Build order

1. Types, client methods and `claimsMock.ts` (about 12 claims across every type and status, one with a past follow-up date, one partly approved, one inverter swap with old / new SN, one draft with missing evidence).
2. Route, sidebar entry, header, summary, tabs, filters, table, URL state, CSV.
3. Create / edit dialog with fields by type; detail dialog sections 1–3 and 5.
4. Status workflow, timeline, note / message / shipment dialogs.
5. Evidence checklist with links into the app.
6. Entry points from Issues, Inverters and the I-V sweep panel (`from=` prefill, "already open" check).
7. `bun run lint && bun run build`. Run as admin and as engineer: the engineer sees only claims on assigned plants, cannot change status or delete, and `window.__apiLog` shows only `/claims*` plus the sidebar's fleet calls.

## 9a. Backend as built (2026-11-20)

- Tables (SQL only, kept indefinitely, migration `9c3e5a7b2d14`): `claims`, `claim_events` (timeline; an `edit` keeps old → new in `detail`), `claim_evidence` (a row only once an item is set; the item list per type is in `services/claims.py`), `claim_links` (unique per claim, kind, ref). `plant_id` has no FK, like `site_events`: claims are kept when a plant is blocked.
- `services/claims.py` owns the numbering (CL-YYYY-NNN, the next after the year's highest, so a deleted draft's number is never reused; two claims opened at once retry on the unique number, then 409), `TRANSITIONS`, `WAITING`, the evidence checklist (police report required for theft), `followup_overdue` and the summary. Routes in `api/routes/claims.py`.
- Access (§11 Q3 as the mock had it): everyone works on claims of their plants (others answer 404): create, edit open claims, evidence, links, notes / messages / shipments. Admins only: status changes, any change to a closed / withdrawn claim (fields, evidence, links, timeline entries; 409 for engineers, and the detail hides those actions), deleting a draft.
- Checks: an inverter warranty needs `device_sn`; an SN must be an inverter of the plant; strings need their inverter; incident / discovered days not in the future, discovered ≥ incident; linked records must be of the claim's plant (shadow issues: admins only; a link to one is left out of the detail for engineers and unlinking it answers 404); a claim with links cannot move to another plant; evidence links only http(s) or an app path (the UI opens an app path with the router).
- Tests: `backend/tests/test_claims.py`.

## 10. Later (not v1)

- File uploads (photos, reports) to Cloud Storage, linked to evidence items.
- Warranty register: warranty end per inverter / module batch, entered once (or from purchase records), so a new claim shows "in warranty until …" and a report lists units out of warranty soon.
- Claim on the plant's Maintenance page and on both inverters' pages after a swap.
- Reports: approval rate by counterparty, days to close, failures by cause / model (e.g. MAX 50KTL3 failures per year).
- Packaging a module claim per the Data-Driven Decisions §5 rule once PLR exists: PLR analysis + IR + I-V at STC + serials in one export.
- AI Assistant: "draft the RMA email for CL-2026-014" from the claim's fields and evidence.

## 11. Open questions

1. Is "Claim" meant as **warranty / insurance claims for equipment** (this plan), or something else (e.g. staff expense claims, customer complaints)?
2. Which counterparties are common besides Growatt: module brands, the insurer, the EPC? Should counterparties be a fixed list an admin edits?
3. Can engineers create and submit claims, or only draft them for an admin to submit (the current plan: engineers draft and add evidence, admins submit)?
4. Is there an existing claim number format or spreadsheet to import from?
5. Should the UI labels be in Thai (เคลม), English, or both?
