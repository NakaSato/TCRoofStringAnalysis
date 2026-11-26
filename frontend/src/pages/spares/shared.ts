/** Spares page helpers (docs/plans/spares-failed-units.md). */
import { ApiError, type FailedUnitStatus, type LocationKind, type MovementKind, type PartCategory, type StockBatchError, type UnitState, type UserProfile } from "../../api/client";

export const CATEGORY_LABEL: Record<PartCategory, string> = {
  inverter: "Inverter",
  datalogger: "Data logger",
  weather_station: "Weather station",
  revenue_meter: "Revenue meter",
  router: "4G router",
  pqm: "PQM",
  shinemaster: "ShineMaster",
  grid_meter: "Grid meter",
  module: "PV module",
  other: "Other",
};

export const KIND_LABEL: Record<LocationKind, string> = { store: "Store", bin: "Bin", van: "Van", supplier: "Supplier" };

export const MOVE_LABEL: Record<MovementKind, string> = {
  receive: "Receive",
  transfer: "Transfer",
  issue: "Install at plant",
  return: "Return from plant",
  correction: "Correction",
  failed_in: "Failed unit in",
  ship_out: "Sent to supplier",
  supplier_return: "Back from supplier",
  scrap: "Scrapped",
  count_adjust: "Count adjustment",
};

export const FAILED_STATUS_LABEL: Record<FailedUnitStatus, string> = {
  tagged: "Tagged",
  in_store: "In store",
  sent: "At supplier",
  repaired: "Repaired",
  replaced: "Replaced",
  scrapped: "Scrapped",
};

export const FAILED_STATUS_VARIANT: Record<FailedUnitStatus, "warn" | "info" | "ok" | "neutral"> = {
  tagged: "warn",
  in_store: "info",
  sent: "info",
  repaired: "ok",
  replaced: "ok",
  scrapped: "neutral",
};

export const STATE_LABEL: Record<UnitState, string> = {
  in_stock: "In stock",
  installed: "Installed",
  failed: "Failed",
  at_supplier: "At supplier",
  scrapped: "Scrapped",
  void: "Void",
  missing: "Missing",
};

/** a movement's state: a spare unit's state or, on a failed unit's own rows, its status */
export const movementStateLabel = (s: UnitState | FailedUnitStatus): string =>
  (STATE_LABEL as Record<string, string>)[s] ?? (FAILED_STATUS_LABEL as Record<string, string>)[s] ?? s;

/** a unit's state badge */
export const STATE_VARIANT: Record<UnitState, "ok" | "warn" | "crit" | "neutral"> = {
  in_stock: "ok",
  installed: "neutral",
  failed: "neutral",
  at_supplier: "neutral",
  scrapped: "neutral",
  void: "neutral",
  missing: "warn",
};

/** a stored timestamp (count, movement) for display, Bangkok time */
export const fmtStockAt = (at: string, locale: string): string => {
  const d = new Date(at);
  return Number.isNaN(d.getTime()) ? at : d.toLocaleString(locale, { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Bangkok" });
};

/** receive, correct, catalogue and locations: admin or store keeper (D-1) */
export const canManageStock = (u: UserProfile | null | undefined) => !!u && (u.role === "admin" || u.store_keeper);

/** An API error as text; a batch 409 lists the rows that did not fit (1-based). */
export const errorText = (e: unknown, t: (k: string, v?: Record<string, string | number>) => string): string => {
  if (e instanceof ApiError && e.status === 409 && e.detail && typeof e.detail === "object" && "errors" in e.detail) {
    const d = e.detail as StockBatchError;
    return d.errors.map((x) => (x.row != null ? t("Row {n}: {error}", { n: x.row + 1, error: x.error }) : x.error)).join("\n");
  }
  return e instanceof Error ? e.message : String(e);
};

const csvCell = (v: unknown) => {
  const s = v == null ? "" : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** a CSV file (UTF-8 with BOM, for Excel) */
export const download = (name: string, rows: unknown[][]) => {
  const blob = new Blob(["﻿" + rows.map((r) => r.map(csvCell).join(",")).join("\r\n")], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
};
