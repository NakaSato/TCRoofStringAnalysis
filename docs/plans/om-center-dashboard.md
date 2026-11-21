# Plan: O&M Dashboard (engineer O&M team, finance view)

Status: **Phase 1 built 2026-11-21** (endpoint, page `/center`, tests; see §7), Phases 2–3 not started · Created 2026-11-21 · Owner: Chanthawat
Related: [`decision-rules.md`](decision-rules.md) (issues, tariff, daily tables), [`calendar-team.md`](calendar-team.md), [`claims.md`](claims.md), [`pwa-meter-daily.md`](pwa-meter-daily.md), research report §7 (economics) and §8 (portfolio level).

One page for the O&M engineers that answers, in baht: **what are we losing, why, what do we fix first, and is the work keeping up?** The app already computes every input. They sit on separate pages (Rule review, Calendar, Claims, PWA Meter, Maintenance), and no page puts them side by side.

It is an O&M page with money as the unit. It is not a finance page: no invoices, no billing, no IRR, no TFRS figures.

---

## 1. State today (checked in code, 2026-11-21)

| Need | What exists | Gap |
|---|---|---|
| Loss in baht | `growatt_issues`: `thb_per_day_est`, `thb_total_est`, `daily` = {day: {kwh, thb}} per issue; `summarize()` gives active count, by tier, by rule, THB/day | Shown only in Rule review (admin). `/issues` is in the plan but has no route in `App.tsx` today. |
| Price of a kWh | `services/tariff.py` `Pricer`: TOU + Ft, holidays, flat per-plant rate (PPA) | Source is `default` until an admin saves it; lunar holidays missing. |
| Plant KPIs | `growatt_plant_daily`: energy, PR, PR', EPI, modelled energy; `growatt_inverter_daily`: minutes per state, lost kWh by cause | No fleet roll-up over a period. |
| Planned work and cost | `om_tasks` (`est_cost_thb`, linked issue), `om_plans`, `/calendar/due`, `om_plant_settings.cleaning_cost_thb` | Not set against the loss it is meant to stop. |
| Money spent | `site_events.cost_thb` (entered, null when not entered) | Never summed. |
| Contract result | `/pwa/meter/summary`: vs contract %, losses by cause in MWh and THB, outages, availability (phases 1–2, 131 sites, imported monthly) | Own page, own price (`book_price_thb_per_kwh` 2.7647). |
| Claims | `/claims`: status, days outstanding | No money by design. |
| Home page | `/` = plant directory; hero has live "Revenue today" | Live only, nothing about loss or work. |

## 2. Rules from CLAUDE.md that shape this

| Rule | What it means here |
|---|---|
| Never store realtime values | The page reads **stored days only** (yesterday and back). No live tiles; "now" stays on the directory and the map. |
| Never invent numbers | Every baht figure is labelled: **estimated** (lost kWh × tariff), **modelled** (expected energy, contract kWh), **entered** (costs typed by the team). A sum says how many rows had no value ("12 of 15 priced"). Missing = "—", never 0. |
| Engineers see assigned plants only | Every figure is filtered with `allowed_plant_ids`. An engineer's totals are "your plants", never the fleet. PWA phase totals stay admin only, as today. |
| No new Growatt calls, ฿3,000/month | SQL only, aggregates over the daily tables and `growatt_issues`. No new table, no worker job, nothing in Firestore. |

## 3. The page

Route `/center`, sidebar label **O&M Dashboard**, open to both roles. Period picker: 7 days / month to date / last 30 days / custom; default month to date. Pieces in `pages/center/`, shadcn Cards, no decorative icons, charts through `PanelChart`.

### 3.1 Money strip (`StatTile` row)

| Tile | Value | Source | Label |
|---|---|---|---|
| Losing now | THB/day of active issues, safety count as the tag | `growatt_issues` active | estimated |
| Lost in period | THB and kWh, with % of produced value | sum of `daily` entries inside the period | estimated |
| Produced | kWh and its value | `growatt_plant_daily.energy_kwh` × `Pricer` | measured kWh, estimated THB |
| Availability | inverter time producing ÷ daylight time | `growatt_inverter_daily` minutes per state | measured |
| O&M spend | THB of site-log events in the period, "n of m events have a cost" | `site_events.cost_thb` | entered |
| Committed | est. cost of planned tasks not done yet | `om_tasks.est_cost_thb` | entered |

### 3.2 Fix first (the main table)

Active issues, safety first, then tier, then THB/day (the order `growatt_issues.sort_key` already gives). Columns: plant, inverter / string, rule, tier, **THB/day**, **THB so far**, age in days, acknowledged by, next planned visit at the plant, linked claim.

- A column **Cost of waiting** = THB/day × days until the plant's next planned task (or "no visit planned"). This is the report's dispatch test without the trip cost, which the app does not have (§6, question 3).
- Row actions that exist already: acknowledge, plan a visit (Calendar task with the issue linked), open a claim (prefilled from the issue).

### 3.3 Loss by cause

Stacked bars per day over the period, THB estimated, grouped by rule family: inverter down (R8), inverter under-yield (R7), string low / open (R1, R2), plant-level (R10, R11), other. Curtailment and limiting are drawn apart as **lost opportunity** (not an O&M loss). Data gaps are counted in days, never in baht.

### 3.4 Plants

One row per plant: THB lost in period (est.), share of its produced value, EPI and PR' (median of period), availability, open issues, days since last cleaning, next visit, O&M spend. Sortable, CSV export, row opens `/plant/:id`.

### 3.5 Work and response

- This week: tasks planned / done / overdue, due recurring plans (`/calendar/due`).
- Response: median days from opened to acknowledged and opened to closed, per tier, against the report's targets (P1 same day, P2 within 2 days). Issues are dated by day, so this is in days, not hours.
- Claims waiting: count by status and oldest age (no money).

### 3.6 Contract (PWA phases 1–2)

A compact card from `/pwa/meter/summary` for the same period: energy vs contract %, loss THB by cause (curtailment, outage, under-performance), open outages. It shows "data to <last imported day>" because the report is imported monthly. Engineers get their sites only and no phase totals. It keeps the PWA book price and says so; it is never added to the tariff-priced figures above.

## 4. Backend

One read endpoint, `GET /growatt/center?start&end` (`services/om_center.py`, route in `routes/growatt/`), composed from the existing services so the page makes one request plus the PWA summary:

```
{ window, money: {...}, issues: {summary, top[]}, loss_by_cause: [{day, family, kwh_est, thb_est}],
  plants: [...], work: {...}, response: {...},
  meta: {source: "db", estimated: [...], modelled: [...], entered: [...], tariff_source: "default" | "saved"} }
```

- Period sums come from `growatt_issues.daily`, so no recompute and no new table.
- A string issue with an open parent inverter issue (`parent_id`) must not be counted twice in a total. Check how `sync` prices the two before summing; this decides the "Lost in period" number.
- `tariff_source: "default"` shows a notice on the page: baht figures use the default tariff until an admin saves the real one.
- Tests: scoping (engineer sees only assigned plants, shadow issues never), null handling in sums, parent / child double count, period edges.

## 5. Phases

| Phase | Scope | Size |
|---|---|---|
| 1 | Endpoint (money, issues, loss by cause, plants), page with §3.1–3.4, route, sidebar entry, tests | about 1 week |
| 2 | §3.5 work and response, row actions into Calendar and Claims, cost of waiting | 3–4 days |
| 3 | §3.6 contract card, CSV export, AI Assistant tool for the same endpoint | 2–3 days |
| Later | Dispatch verdict (needs a trip cost), soiling wallet (R12, not built), energy vs budget (P50, no budget in the app yet) | not planned |

Update `frontend/CLAUDE.md` and `backend/CLAUDE.md` with the page and endpoint in each phase.

## 6. Open questions for the owner

1. **Rules are in shadow mode.** Engineers never see shadow issues, so for them the page's loss figures are empty until an admin takes rules live in Rule review. Take R1, R2, R7, R8 live first, or show admins only until then?
2. **Which price for the PWA sites?** `tariff.py` prices at the TOU default (4.18 / 2.60 + Ft) unless the plant has a flat rate; the PWA contract's book price is 2.7647 THB/kWh. For the 131 PWA sites the tariff figure overstates the loss about 1.5×. Proposed: fill `plant_rates` for PWA plants with the book price (basis "PWA contract") before Phase 1 ships.
3. **Trip cost.** Is there a standard cost per site visit (by region or crew)? With it, "Cost of waiting" becomes a dispatch / bundle verdict.
4. **Home page.** Keep `/` as the plant directory with `/center` beside it (proposed), or make the center the landing page for engineers?
5. **Fleet totals for engineers.** Proposed: no, own plants only (same as PWA Meter).

Answers (2026-11-21): 1 = the page is open to both roles and never flips a rule; engineers see live issues only, admins get a "Shadow rules" switch and a notice with the count left out. 2 = yes, book price for PWA plants (command in §7). 3 = open. 4 = `/center` beside the directory. 5 = own plants only.

## 7. As built: Phase 1 (2026-11-21)

- `services/om_center.py`, `GET /growatt/center?start=&end=&include_shadow=` (route in `routes/growatt/rules.py`), tests `tests/test_om_center.py`. Page `pages/OmCenterPage.tsx` + `pages/center/`, sidebar Operations → O&M Dashboard. `PanelChart` panels gained `stacked` (bars of a category share one bar; the caller gives `y0`).
- **Each lost kWh is counted once** (`om_center.attribute`, per plant and day). The rules overlap: R1 and R5 price the same string-day with the same figure, R7 (inverter vs its peers) contains its strings' loss and R11, and R10 (plant EPI shortfall) contains everything. So: a string-day counts its largest string rule; R7 counts only what its strings and R11 do not explain; R10 only what nothing else explains. R8 (down time) is in other slots than the string rules (they need a producing inverter), so it adds in full. "Losing now" applies the same rule to the active issues' THB/day.
- Issues dismissed by an engineer add no loss. Shadow issues are left out unless an admin asks for them.
- Changed from §3:
  - **Produced has no baht value.** Pricing a period's energy at TOU needs the on-peak share per plant-day, which is only in the raw readings (a scan of millions of rows per request). The tile shows measured kWh, and the loss share is in kWh: lost ÷ (produced + lost).
  - **Data gaps are priced** as their own family: R17's figure is only the energy `eac_today` did not recover, so it is a real estimate of energy not produced or not recorded.
  - **Power limiting** (R18) has no kWh estimate, so it is not in the bars; the Availability tile says the hours limited.
  - "Cost of waiting" and the next visit came forward from Phase 2 (one query). Row actions and the linked claim are still Phase 2.
- **PWA plant prices:** `PYTHONPATH=backend uv run python -m app.services.tariff pwa-rates` lists what it would add (dry run); `--apply` writes the contract's book price into `plant_rates` for PWA plants that have no rate (entered rates are kept). Applies from the next `rules_*` run; baht already stored on issues keep the price of the day they were computed (`rules_backfill` reprices).
- **One page with the PWA meter report** (2026-11-21, replaces §3.6's compact card and the separate PWA Meter page): `/center` shows both sources for one period, side by side and never added: tile groups Inverter side / PWA meter / Work, a Loss by cause card per source, and one tabbed card of lists (Fix first, Plants, Meter sites, Outage events, Meter check). The Plants list carries each plant's "Meter vs contract" from its report site. `/pwa-meter` redirects to `/center?view=sites`; the sidebar entry is gone. The period presets count back from today, so the meter figures cover the report days inside the period (a badge says how far the report reaches); the old page's "Whole report" preset is gone (the inverter-side window is at most 366 days).
- **Charts** (2026-11-21, from the PWA engineering & finance dashboard artifact): Strategy matrix, Fleet by day, Yield by site and day, Loss by region and Plants losing the most, between the Loss by cause cards and the lists. New read endpoint `GET /pwa/meter/daily` for the day-level series (no new table). The artifact's finance pieces (TFRS 16, FY2570 forecast, who gains / loses, price sensitivity) are not brought over: this is an O&M page (§ top).
