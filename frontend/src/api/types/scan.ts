/** Barcode / QR scans (`/scan/resolve`, docs/plans/barcode-scanning.md §9). */

export type ScanMatchKind = "instrument" | "inverter" | "datalogger" | "site_device";

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
