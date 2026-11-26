/**
 * Stock count (`/inventory/scan?mode=count`, docs/plans/spares-failed-units.md §5.7, §8 step 5):
 * scan everything at one location, the backend compares the scans with the register
 * (`POST /stock/counts/preview`) and an admin or store keeper confirms (D-1). The list holds only
 * the scans (no stock write per scan); this module builds the scans sent, maps the preview's rows
 * (by scan index) back to the list rows, groups them, decides whether Confirm is allowed and keeps
 * the list in `sessionStorage`. Pure module (no React), `bun test`.
 */
import type { InputMethod } from "../../api/types/scan";
import type { CountPreview, CountResult, CountRow, CountScan, StockBatchError, StockLookupKind, StockUnit } from "../../api/types/stock";
import { serialKey } from "./batch";

export interface CountListRow {
  /** local key */
  id: string;
  /** the scanned text as read (sent as `raw`) */
  raw: string;
  input_method: InputMethod;
  /** the serial as the lookup read it (duplicates, display before the preview answers) */
  serial: string;
  /** what the lookup said the code is */
  kind: StockLookupKind;
  /** units with this serial (lookup); one for an `sp:<id>` label */
  units: StockUnit[];
  /** the part picked on this row: among several parts with the serial, or for a new serial */
  part_id: number | null;
  /** the server refused this row on Confirm (409) */
  server_error: string | null;
}

/** The scans to send, oldest first (the list shows newest first), with the list row id of each scan index. */
export const buildCountScans = (rows: CountListRow[], partForNew: number | null): { scans: CountScan[]; ids: string[] } => {
  const scans: CountScan[] = [];
  const ids: string[] = [];
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i];
    const s: CountScan = { raw: r.raw, input_method: r.input_method };
    if (r.kind === "unit" && r.units.length === 1) {
      s.unit_id = r.units[0].id;
    } else if (r.units.length > 1) {
      const u = r.part_id != null ? r.units.find((x) => x.part_id === r.part_id) : undefined;
      if (u) {
        s.unit_id = u.id;
        s.part_id = u.part_id;
      }
    } else if (!r.units.length && r.kind === "serial") {
      const p = r.part_id ?? partForNew;
      if (p != null) s.part_id = p;
    }
    scans.push(s);
    ids.push(r.id);
  }
  return { scans, ids };
};

/** What a preview was made for: a preview whose key differs from the list's is stale. */
export const scansKey = (locationId: number | null, scans: CountScan[]): string => JSON.stringify([locationId, scans]);

/** The preview's rows by list row id (`index` = position in the scans sent). */
export const previewByRow = (preview: CountPreview | null, ids: string[]): Map<string, CountRow> => {
  const out = new Map<string, CountRow>();
  for (const r of preview?.rows ?? []) {
    if (r.index >= 0 && r.index < ids.length) out.set(ids[r.index], r);
  }
  return out;
};

/** rows that stop the confirm until fixed or removed */
export const BLOCKING: readonly CountResult[] = ["needs_part", "ambiguous", "blocked"];

export type CountTone = "ok" | "info" | "warn" | "error";

export const RESULT_TONE: Record<CountResult, CountTone> = {
  matched: "ok",
  moved_here: "info",
  found_again: "info",
  new: "info",
  needs_part: "error",
  ambiguous: "warn",
  blocked: "error",
  duplicate: "warn",
  not_a_unit: "error",
};

export const RESULT_LABEL: Record<CountResult, string> = {
  matched: "Matched",
  moved_here: "Will move here",
  found_again: "Found again",
  new: "New",
  needs_part: "Needs part",
  ambiguous: "Several parts",
  blocked: "Can't count",
  duplicate: "Duplicate",
  not_a_unit: "Not a unit",
};

/** list order of the groups: what needs a hand first, then what changes stock, then what matched */
export const GROUP_ORDER: readonly CountResult[] = ["needs_part", "ambiguous", "blocked", "not_a_unit", "duplicate", "moved_here", "found_again", "new", "matched"];

export type GroupKey = CountResult | "pending";

/** List rows grouped by their preview result; rows the preview has not answered yet first ("pending"). Order inside a group = list order. */
export const groupRows = (rows: CountListRow[], byId: Map<string, CountRow>): { key: GroupKey; rows: CountListRow[] }[] => {
  const g = new Map<GroupKey, CountListRow[]>();
  for (const r of rows) {
    const k: GroupKey = byId.get(r.id)?.result ?? "pending";
    if (!g.has(k)) g.set(k, []);
    g.get(k)!.push(r);
  }
  return (["pending", ...GROUP_ORDER] as GroupKey[]).filter((k) => g.has(k)).map((k) => ({ key: k, rows: g.get(k)! }));
};

/** rows that need fixing before Confirm */
export const blockingCount = (preview: CountPreview | null): number =>
  preview ? preview.counts.needs_part + preview.counts.ambiguous + preview.counts.blocked : 0;

export interface ConfirmGate {
  ok: boolean;
  /** English text (translated by the page), null when ok */
  reason: string | null;
  vars?: Record<string, string | number>;
}

/** Whether Confirm count is allowed, and why not. */
export const confirmGate = (a: { keeper: boolean; locationId: number | null; preview: CountPreview | null; fresh: boolean; busy: boolean; serverErrors: number }): ConfirmGate => {
  if (!a.keeper) return { ok: false, reason: "An admin or store keeper confirms the count" };
  if (a.locationId == null) return { ok: false, reason: "Pick or scan the location first" };
  if (a.busy) return { ok: false, reason: null };
  if (!a.preview || !a.fresh) return { ok: false, reason: "Checking the list…" };
  const n = blockingCount(a.preview);
  if (n > 0) return { ok: false, reason: "{n} rows need a part picked or must be removed first", vars: { n } };
  if (a.serverErrors > 0) return { ok: false, reason: "Fix or remove the rows marked ✕ first" };
  if (!a.preview.rows.length && !a.preview.expected.length) return { ok: false, reason: "Nothing to count yet: scan the units here" };
  return { ok: true, reason: null };
};

/** D-5: a location with no units in the register: everything scanned goes in as new stock */
export const isFirstCount = (preview: CountPreview | null): boolean => !!preview && preview.expected.length === 0;

/** Index of a row already holding this serial. */
export const findCountDuplicate = (rows: CountListRow[], serial: string): number => {
  const k = serialKey(serial);
  return rows.findIndex((r) => serialKey(r.serial) === k);
};

/** a 409's `detail` (duck-typed on `ApiError`'s `status` / `detail`, so this module needs no API client) */
const conflictDetail = (e: unknown): Record<string, unknown> | null => {
  if (!e || typeof e !== "object") return null;
  const x = e as { status?: unknown; detail?: unknown };
  return x.status === 409 && !!x.detail && typeof x.detail === "object" ? (x.detail as Record<string, unknown>) : null;
};

/** A 409 of the confirm: the stock at the location changed since the preview. */
export const isStockChanged = (e: unknown): boolean => conflictDetail(e)?.code === "stock_changed";

/** A 409 of the confirm with failing rows (`row` = scan index). */
export const rowErrors = (e: unknown): StockBatchError | null => {
  const d = conflictDetail(e);
  return d && d.code !== "stock_changed" && Array.isArray(d.errors) ? (d as unknown as StockBatchError) : null;
};

// ---------------------------------------------------------------- sessionStorage

export const countStorageKey = (loc: number | null): string => `tcroof.batch.count.${loc ?? "none"}`;

const isRow = (x: unknown): x is CountListRow => {
  if (!x || typeof x !== "object") return false;
  const r = x as Record<string, unknown>;
  return typeof r.id === "string" && typeof r.raw === "string" && typeof r.serial === "string" && typeof r.kind === "string" && Array.isArray(r.units);
};

/** A stored list, or [] when there is none or it cannot be read. */
export const parseCountRows = (text: string | null): CountListRow[] => {
  if (!text) return [];
  try {
    const v: unknown = JSON.parse(text);
    return Array.isArray(v)
      ? v.filter(isRow).map((r) => ({
          ...r,
          part_id: typeof r.part_id === "number" ? r.part_id : null,
          server_error: r.server_error ?? null,
          input_method: r.input_method ?? "manual",
        }))
      : [];
  } catch {
    return [];
  }
};

export const readCountRows = (key: string): CountListRow[] => {
  try {
    return parseCountRows(sessionStorage.getItem(key));
  } catch {
    return [];
  }
};

export const writeCountRows = (key: string, rows: CountListRow[]): void => {
  try {
    if (rows.length) sessionStorage.setItem(key, JSON.stringify(rows));
    else sessionStorage.removeItem(key);
  } catch {
    // private window / blocked storage: the list lasts this page only
  }
};
