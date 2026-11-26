/** Spares register (`/stock`, docs/plans/spares-failed-units.md), phase 1. No money anywhere. */

export const PART_CATEGORIES = ["inverter", "datalogger", "weather_station", "revenue_meter", "router", "pqm", "shinemaster", "module", "other"] as const;
export type PartCategory = (typeof PART_CATEGORIES)[number];
export const LOCATION_KINDS = ["store", "bin", "van", "supplier"] as const;
export type LocationKind = (typeof LOCATION_KINDS)[number];
export type UnitState = "in_stock" | "installed" | "failed" | "at_supplier" | "scrapped" | "void";
export type MovementKind = "receive" | "transfer" | "issue" | "return" | "correction";

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
  part_id: number;
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
  from_state: UnitState | null;
  to_state: UnitState | null;
  corrects_id: number | null;
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
  kind: Exclude<MovementKind, "correction">;
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
}

/** a 409 from the batch: which rows did not fit */
export interface StockBatchError {
  message: string;
  errors: { row: number | null; error: string }[];
}
