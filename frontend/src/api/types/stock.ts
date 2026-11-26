/** Spares register (`/stock`, docs/plans/spares-failed-units.md), phase 1. No money anywhere. */

export const PART_CATEGORIES = ["inverter", "datalogger", "weather_station", "revenue_meter", "router", "pqm", "shinemaster", "grid_meter", "module", "other"] as const;
export type PartCategory = (typeof PART_CATEGORIES)[number];
export const LOCATION_KINDS = ["store", "bin", "van", "supplier"] as const;
export type LocationKind = (typeof LOCATION_KINDS)[number];
export type UnitState = "in_stock" | "installed" | "failed" | "at_supplier" | "scrapped" | "void" | "missing";
export type MovementKind = "receive" | "transfer" | "issue" | "return" | "correction" | "failed_in" | "ship_out" | "supplier_return" | "scrap" | "count_adjust";

export interface StockPart {
  id: number;
  code: string;
  name: string;
  category: PartCategory;
  make: string | null;
  model: string | null;
  serialised: boolean;
  unit: string;
  min_qty: number | null;
  active: boolean;
  note: string | null;
  /** units in stock, counted from the register (never typed in) */
  on_hand: number;
  on_hand_by_location: { location_id: number | null; qty: number }[];
  below_min: boolean;
}

export type StockPartBody = Partial<Pick<StockPart, "code" | "name" | "category" | "make" | "model" | "min_qty" | "active" | "note">>;

export interface StockLocation {
  id: number;
  code: string;
  name: string;
  kind: LocationKind;
  parent_id: number | null;
  holder_user_id: number | null;
  holder_name: string | null;
  active: boolean;
  note: string | null;
  units: number;
  /** the last confirmed count of this location (phase 5); null = never counted */
  last_count_at: string | null;
  last_count_by: string | null;
}

export type StockLocationBody = Partial<Pick<StockLocation, "code" | "name" | "kind" | "parent_id" | "holder_user_id" | "active" | "note">>;

export interface StockUnit {
  id: number;
  part_id: number;
  part_code: string;
  part_name: string;
  serial: string;
  state: UnitState;
  location_id: number | null;
  location_code: string | null;
  plant_id: number | null;
  plant_name: string | null;
  received_day: string | null;
  note: string | null;
}

export interface StockMovement {
  id: number;
  batch_id: string;
  kind: MovementKind;
  /** null for a failed unit that is not in the catalogue */
  part_id: number | null;
  part_code: string | null;
  part_name: string | null;
  unit_id: number | null;
  serial: string | null;
  qty: number;
  from_location_id: number | null;
  from_location_code: string | null;
  to_location_id: number | null;
  to_location_code: string | null;
  plant_id: number | null;
  plant_name: string | null;
  /** a spare unit's state, or a failed unit's status on rows that move only a failed unit */
  from_state: UnitState | FailedUnitStatus | null;
  to_state: UnitState | FailedUnitStatus | null;
  corrects_id: number | null;
  failed_unit_id: number | null;
  by: string | null;
  at: string | null;
  day: string;
  note: string | null;
  input_method: "hid" | "camera" | "photo" | "manual" | null;
  raw_scan: string | null;
}

export interface StockMovementList {
  total: number;
  movements: StockMovement[];
}

export interface StockMovementRow {
  kind: "receive" | "transfer" | "issue" | "return";
  part_id?: number;
  unit_id?: number;
  serial?: string;
  to_location_id?: number;
  plant_id?: number;
  note?: string;
  input_method?: "hid" | "camera" | "photo" | "manual";
  raw_scan?: string;
}

export interface StockMovementQuery {
  kind?: string;
  part_id?: number;
  location_id?: number;
  plant_id?: number;
  serial?: string;
  unit_id?: number;
  limit?: number;
  offset?: number;
}

export interface StockSummary {
  in_stock: number;
  installed: number;
  parts_below_min: number;
  /** failed units still open (tagged, in store, at the supplier) */
  failed_open: number;
  /** open failed units not sent to the supplier after STOCK_FAILED_UNSENT_DAYS */
  failed_unsent_overdue: number;
  /** units a confirmed count did not find (state `missing`) */
  missing_units: number;
}

/** a 409 from the batch: which rows did not fit */
export interface StockBatchError {
  message: string;
  errors: { row: number | null; error: string }[];
}

// ---- failed units (phase 2): a failed unit off site, bound to a pre-printed red tag

export const FAILED_STATUSES = ["tagged", "in_store", "sent", "repaired", "replaced", "scrapped"] as const;
export type FailedUnitStatus = (typeof FAILED_STATUSES)[number];
/** still with us or at the supplier */
export const FAILED_OPEN_STATUSES: readonly FailedUnitStatus[] = ["tagged", "in_store", "sent"];

export interface FailedUnit {
  id: number;
  red_tag: string;
  /** null = not in the catalogue */
  part_id: number | null;
  part_code: string | null;
  part_name: string | null;
  serial: string | null;
  plant_id: number | null;
  plant_name: string | null;
  site_device_id: number | null;
  site_device_label: string | null;
  inverter_sn: string | null;
  removed_day: string;
  fault: string;
  status: FailedUnitStatus;
  location_id: number | null;
  location_code: string | null;
  claim_id: number | null;
  claim_number: string | null;
  age_days: number;
  /** open and not sent to the supplier after the set number of days */
  unsent_overdue: boolean;
  created_by: string | null;
}

export interface FailedUnitDetail extends FailedUnit {
  /** its movements, newest first */
  trail: StockMovement[];
}

export interface FailedUnitQuery {
  status?: FailedUnitStatus;
  plant_id?: number;
  q?: string;
  open?: boolean;
}

export interface FailedUnitCreate {
  red_tag: string;
  part_id?: number;
  serial?: string;
  plant_id?: number;
  site_device_id?: number;
  inverter_sn?: string;
  /** YYYY-MM-DD */
  removed_day?: string;
  fault: string;
  to_location_id: number;
  claim_id?: number;
  input_method?: "hid" | "camera" | "photo" | "manual";
  raw_scan?: string;
  note?: string;
}

export interface FailedUnitPatch {
  fault?: string;
  claim_id?: number | null;
  part_id?: number | null;
}

export interface FailedUnitMove {
  kind: "transfer" | "ship_out" | "supplier_return" | "scrap";
  to_location_id?: number;
  outcome?: "repaired" | "replaced";
  new_serial?: string;
  carrier?: string;
  tracking_no?: string;
  note?: string;
}

// ---- replacement on site (phase 3, §5.3): failed unit off, spare on, register updated (D-4)

/** a device on a plant that can be replaced: a Site register device or a Growatt inverter */
export interface ReplaceTarget {
  kind: "site_device" | "inverter";
  site_device_id: number | null;
  inverter_sn: string | null;
  label: string;
  /** a part category (inverter, datalogger, …) */
  category: string;
  serial: string | null;
  model: string | null;
}

export interface ReplaceTargets {
  plant_id: number;
  plant_name: string;
  devices: ReplaceTarget[];
}

export interface ReplacementBody {
  plant_id: number;
  /** exactly one of site_device_id / inverter_sn */
  site_device_id?: number;
  inverter_sn?: string;
  old_serial: string;
  old_input_method?: "hid" | "camera" | "photo" | "manual";
  old_raw_scan?: string;
  /** the old label's serial differs from the register: update the register anyway */
  confirm_register_update?: boolean;
  red_tag: string;
  red_tag_input_method?: "hid" | "camera" | "photo" | "manual";
  red_tag_raw_scan?: string;
  fault: string;
  new_unit_id: number;
  new_input_method?: "hid" | "camera" | "photo" | "manual";
  new_raw_scan?: string;
  failed_to_location_id: number;
  /** YYYY-MM-DD */
  removed_day?: string;
  note?: string;
}

export interface ReplacementClaimPrefill {
  type: "equipment_warranty" | "inverter_warranty";
  plant_id: number;
  device_sn: string;
  new_sn: string;
  device_label: string;
  failed_unit_id: number;
  red_tag: string;
}

export interface ReplacementResult {
  batch_id: string;
  failed_unit: FailedUnit;
  installed_unit: StockUnit;
  register: {
    kind: "site_device" | "inverter";
    updated: boolean;
    site_device_id: number | null;
    inverter_sn: string | null;
    old_serial: string | null;
    new_serial: string;
  };
  warnings: string[];
  claim_prefill: ReplacementClaimPrefill;
}

/** the 409 when the old label's serial is not the one in the register: ask, then resend confirmed */
export interface RegisterMismatch extends StockBatchError {
  code: "register_mismatch";
  register_serial: string | null;
  label_serial: string;
}

// ---- batch scanning (phase 4): what a scanned code is in the register

export type StockLookupKind = "location" | "unit" | "part" | "serial" | "unknown";

/** `GET /stock/lookup?code=` (DB only): a `loc:` / exact location code, an `sp:<unit id>`, an `sp:<PARTCODE>` / exact part code, else a serial */
export interface StockLookup {
  code: string;
  kind: StockLookupKind;
  location: StockLocation | null;
  part: StockPart | null;
  /** unit: the one unit; serial: exact matches in any state but void (empty = a new serial) */
  units: StockUnit[];
}

// ---- stock count (phase 5, §5.7): scan everything at a location, compare, an admin / store keeper confirms

export type CountInputMethod = "hid" | "camera" | "photo" | "manual";

export interface CountScan {
  raw: string;
  /** the unit picked when several parts have the serial */
  unit_id?: number;
  /** the part a serial not in the register goes in as (or the pick among several parts) */
  part_id?: number;
  input_method?: CountInputMethod;
}

export const COUNT_RESULTS = ["matched", "moved_here", "found_again", "new", "needs_part", "ambiguous", "blocked", "duplicate", "not_a_unit"] as const;
export type CountResult = (typeof COUNT_RESULTS)[number];

export interface CountRow {
  /** position in the `scans` sent */
  index: number;
  raw: string;
  input_method: CountInputMethod | null;
  serial: string | null;
  result: CountResult;
  unit: StockUnit | null;
  part_id: number | null;
  message: string | null;
}

export interface CountCounts {
  scanned: number;
  matched: number;
  moved_here: number;
  found_again: number;
  new: number;
  missing: number;
  needs_part: number;
  ambiguous: number;
  blocked: number;
  duplicate: number;
  not_a_unit: number;
}

export interface CountPreview {
  location: StockLocation;
  /** units the register has at the location */
  expected: StockUnit[];
  rows: CountRow[];
  /** expected units not scanned: marked missing on confirm */
  missing: StockUnit[];
  counts: CountCounts;
  /** sent back on confirm, so stock that changed meanwhile is caught (409 `stock_changed`) */
  expected_ids: number[];
}

export interface StockCount {
  id: number;
  location_id: number;
  location_code: string;
  by: string | null;
  at: string | null;
  day: string;
  scanned: number;
  matched: number;
  missing: number;
  moved_here: number;
  new_units: number;
  found_again: number;
  note: string | null;
  batch_id: string | null;
}

export interface StockCountResult {
  count: StockCount;
  movements: StockMovement[];
}
