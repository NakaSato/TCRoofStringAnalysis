/** Barcode / QR scans (`/scan/resolve`, docs/plans/barcode-scanning.md §9). */

export type ScanMatchKind = "instrument" | "inverter" | "datalogger" | "site_device" | "failed_unit" | "spare_unit" | "part" | "location";

export interface ScanMatch {
  kind: ScanMatchKind;
  /** instrument / site device id, inverter or datalogger serial */
  id: string;
  label: string;
  /** what matched: asset_tag | serial | sim | device_sn | datalogger_sn | id */
  field: string;
  /** where it opens in the app */
  path: string;
  plant_id: number | null;
  plant_name: string | null;
  detail: string | null;
}

export interface ScanResolve {
  /** the value compared (normalised) */
  code: string;
  app_code: { kind: string; code: string } | null;
  /** an app label kind with no register yet (rt, sp, loc, df) */
  unsupported_kind: string | null;
  /** an `rt` app code: the pre-printed red tag (blank until a failed unit is bound to it) */
  red_tag: RedTagInfo | null;
  /** the label said P/N */
  part_number: boolean;
  matches: ScanMatch[];
  /** a typed code that matched nothing (`suggest`): the O/0, I/1 spellings that do, fewest swaps first */
  did_you_mean: ScanSuggestion[];
}

export interface ScanSuggestion {
  code: string;
  matches: ScanMatch[];
}

/** which field of a multi-field label is the serial, per category + model (`/scan/field-hints`) */
export interface ScanFieldHint {
  id: number;
  category: string;
  model: string;
  /** the key printed before the value (`S/N`, `(21)`); null = the label prints no keys */
  field_key: string | null;
  field_index: number;
  field_count: number;
  updated_at: string | null;
}

export interface ScanFieldHintBody {
  category: string;
  model: string;
  field_key: string | null;
  field_index: number;
  field_count: number;
}

/** how a value got into a field */
export type InputMethod = "hid" | "camera" | "photo" | "manual";

export interface RedTagInfo {
  code: string;
  /** reserved (blank) | bound | void */
  status: string;
  batch: number;
  reserved_at: string | null;
}

/** tool = instrument, dev = site device, rt = red tag, sp = spare unit, loc = stock location */
export type ScanLabelKind = "tool" | "dev" | "rt" | "sp" | "loc";

/** one printable label (`/scan/labels`); the QR holds `origin + path`, `code` is printed under it */
export interface ScanLabel {
  kind: ScanLabelKind;
  key: string;
  code: string;
  path: string;
  title: string;
  lines: string[];
}

export interface ScanLabelList {
  kind: ScanLabelKind;
  items: ScanLabel[];
}

export interface ScanLabelQuery {
  kind: ScanLabelKind;
  ids?: string;
  plant_id?: number;
  site_code?: string;
  batch?: number;
  /** sp: the units in stock of this part */
  part_id?: number;
}

export interface RedTagBatch {
  batch: number;
  first: string;
  last: string;
  count: number;
  bound: number;
  reserved_at: string | null;
  reserved_by: string | null;
}

export interface RedTagReserved {
  batch: number;
  first: string;
  last: string;
  count: number;
}

/** §6.3: how a serial differs from the registered serials of its category (+ model); warnings only */
export type SerialWarning =
  | { code: "length"; min: number; max: number; got: number }
  | { code: "digits" | "alnum" | "imei" | "iccid" }
  | { code: "prefix"; prefix: string };

export interface SerialCheck {
  serial: string;
  warnings: SerialWarning[];
  /** the shape learned from the registry; null = too few known serials to expect anything */
  expected: { count: number; min_len: number; max_len: number; charset: "digits" | "alnum" | null; prefix: string | null } | null;
  basis: "model" | "category" | null;
}
