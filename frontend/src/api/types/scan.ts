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
}

/** how a value got into a field */
export type InputMethod = "hid" | "camera" | "photo" | "manual";
