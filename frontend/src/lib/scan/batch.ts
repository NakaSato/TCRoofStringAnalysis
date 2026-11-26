/**
 * Batch scanning of spare units (`/inventory/scan`, docs/plans/spares-failed-units.md §5.1, §5.2,
 * §5.6; barcode-scanning.md §7.3): one row per scanned serial, its status by mode and destination,
 * the batch rows sent on Confirm, and the list kept in `sessionStorage` across a reload.
 * Pure module (no React), `bun test`.
 */
import type { InputMethod } from "../../api/types/scan";
import type { StockLookupKind, StockMovementRow, StockUnit, UnitState } from "../../api/types/stock";

export const BATCH_MODES = ["receive", "transfer", "return"] as const;
export type BatchMode = (typeof BATCH_MODES)[number];

export type RowStatus = "ok" | "warn" | "error";

export interface BatchPart {
  id: number;
  code: string;
  name: string;
}

export interface BatchRow {
  /** local key */
  id: string;
  /** the scanned text as read */
  raw: string;
  input_method: InputMethod;
  /** the serial (as the register compares it), or the code for a row that is not a serial */
  serial: string;
  /** what the lookup said the code is */
  kind: StockLookupKind;
  /** units with this serial (lookup); one for an `sp:<id>` label */
  units: StockUnit[];
  /** the unit picked when several parts have the serial */
  unit_id: number | null;
  /** receive: the part a new serial goes in as */
  part: BatchPart | null;
  /** the server refused this row on Confirm (409) */
  server_error: string | null;
}

/** A row's status. `msg` is the English text (translated by the page); `state` / `where` fill it. */
export interface RowEval {
  status: RowStatus;
  msg: string;
  state?: UnitState;
  where?: string;
  /** the row goes into the batch on Confirm */
  send: boolean;
  /** several units: the page asks which one */
  pick?: boolean;
}

/** The comparison key of a serial: duplicates in one list. */
export const serialKey = (s: string): string => s.trim().toUpperCase();

/** The unit a row stands for: the only one, or the one picked. */
export const rowUnit = (r: Pick<BatchRow, "units" | "unit_id">): StockUnit | null =>
  r.units.length === 1 ? r.units[0] : (r.units.find((u) => u.id === r.unit_id) ?? null);

const whereOf = (u: StockUnit): string => u.location_code ?? u.plant_name ?? "—";

export const evaluateRow = (mode: BatchMode, row: BatchRow, destId: number | null): RowEval => {
  if (row.server_error) return { status: "error", msg: row.server_error, send: false };
  if (row.kind === "part" || row.kind === "location" || row.kind === "unknown") return { status: "error", msg: "Not a serial", send: false };

  if (mode === "receive") {
    if (row.units.length) {
      const u = row.units[0];
      return { status: "error", msg: "Already in the register ({state} at {where})", state: u.state, where: whereOf(u), send: false };
    }
    if (row.kind !== "serial") return { status: "error", msg: "Not a serial", send: false };
    if (!row.part) return { status: "error", msg: "Pick the part first", send: false };
    return { status: "ok", msg: "New", send: true };
  }

  if (!row.units.length) return { status: "error", msg: "Not in the register", send: false };
  const u = rowUnit(row);
  if (!u) return { status: "warn", msg: "Several parts have this serial: pick one", send: false, pick: true };
  const pick = row.units.length > 1;

  if (mode === "transfer") {
    if (u.state === "in_stock") {
      if (destId != null && u.location_id === destId) return { status: "warn", msg: "Already here", where: whereOf(u), send: false, pick };
      return { status: "ok", msg: "From {where}", where: whereOf(u), send: true, pick };
    }
    if (u.state === "installed") return { status: "error", msg: "Installed at {where}: use Return", where: whereOf(u), state: u.state, send: false, pick };
    if (u.state === "failed") return { status: "error", msg: "A failed unit: move it from Failed units", state: u.state, send: false, pick };
    return { status: "error", msg: "{state}: cannot be moved", state: u.state, send: false, pick };
  }

  // return: a unit installed at a plant comes back
  if (u.state === "installed") return { status: "ok", msg: "From {where}", where: whereOf(u), send: true, pick };
  if (u.state === "in_stock") return { status: "error", msg: "Not installed: in stock at {where}", where: whereOf(u), send: false, pick };
  return { status: "error", msg: "{state}: cannot be returned", state: u.state, send: false, pick };
};

/** The batch rows to post, with the list index of each (to map a 409's `errors[].row` back). */
export const buildBatch = (mode: BatchMode, rows: BatchRow[], destId: number): { rows: StockMovementRow[]; index: number[] } => {
  const out: StockMovementRow[] = [];
  const index: number[] = [];
  rows.forEach((r, i) => {
    if (!evaluateRow(mode, r, destId).send) return;
    const common = { to_location_id: destId, input_method: r.input_method, raw_scan: r.raw };
    if (mode === "receive") {
      if (!r.part) return;
      out.push({ kind: "receive", part_id: r.part.id, serial: r.serial, ...common });
    } else {
      const u = rowUnit(r);
      if (!u) return;
      out.push({ kind: mode, unit_id: u.id, ...common });
    }
    index.push(i);
  });
  return { rows: out, index };
};

/** A 409's failing rows (0-based batch indexes) put on the list rows they came from; `ids` = the list row id of each batch row (`buildBatch` index → id, taken when posting, so rows scanned meanwhile do not shift them). */
export const markServerErrors = (rows: BatchRow[], ids: string[], errors: { row: number | null; error: string }[]): BatchRow[] => {
  const byId = new Map<string, string>();
  for (const e of errors) {
    if (e.row == null || e.row < 0 || e.row >= ids.length) continue;
    const id = ids[e.row];
    byId.set(id, byId.has(id) ? `${byId.get(id)}; ${e.error}` : e.error);
  }
  return rows.map((r) => (byId.has(r.id) ? { ...r, server_error: byId.get(r.id)! } : r));
};

/** Index of a row already holding this serial (a row in error does not count: the scan replaces it). */
export const findDuplicate = (mode: BatchMode, rows: BatchRow[], serial: string, destId: number | null): number => {
  const k = serialKey(serial);
  return rows.findIndex((r) => serialKey(r.serial) === k && evaluateRow(mode, r, destId).status !== "error");
};

export interface Counts {
  total: number;
  ok: number;
  warn: number;
  error: number;
}

export const countRows = (mode: BatchMode, rows: BatchRow[], destId: number | null): Counts => {
  const c: Counts = { total: rows.length, ok: 0, warn: 0, error: 0 };
  for (const r of rows) c[evaluateRow(mode, r, destId).status] += 1;
  return c;
};

// ---------------------------------------------------------------- sessionStorage

export const storageKey = (mode: BatchMode, loc: number | null): string => `tcroof.batch.${mode}.${loc ?? "none"}`;

const isRow = (x: unknown): x is BatchRow => {
  if (!x || typeof x !== "object") return false;
  const r = x as Record<string, unknown>;
  return typeof r.id === "string" && typeof r.raw === "string" && typeof r.serial === "string" && typeof r.kind === "string" && Array.isArray(r.units);
};

/** A stored list, or [] when there is none or it cannot be read. */
export const parseRows = (text: string | null): BatchRow[] => {
  if (!text) return [];
  try {
    const v: unknown = JSON.parse(text);
    return Array.isArray(v)
      ? v.filter(isRow).map((r) => ({ ...r, unit_id: r.unit_id ?? null, part: r.part ?? null, server_error: r.server_error ?? null, input_method: r.input_method ?? "manual" }))
      : [];
  } catch {
    return [];
  }
};

export const readRows = (key: string): BatchRow[] => {
  try {
    return parseRows(sessionStorage.getItem(key));
  } catch {
    return [];
  }
};

export const writeRows = (key: string, rows: BatchRow[]): void => {
  try {
    if (rows.length) sessionStorage.setItem(key, JSON.stringify(rows));
    else sessionStorage.removeItem(key);
  } catch {
    // private window / blocked storage: the list lasts this page only
  }
};
