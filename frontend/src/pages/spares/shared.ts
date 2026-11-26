/** Spares page helpers (docs/plans/spares-failed-units.md). */
import { ApiError, type LocationKind, type MovementKind, type PartCategory, type StockBatchError, type UnitState, type UserProfile } from "../../api/client";

export const CATEGORY_LABEL: Record<PartCategory, string> = {
  inverter: "Inverter",
  datalogger: "Data logger",
  weather_station: "Weather station",
  revenue_meter: "Revenue meter",
  router: "4G router",
  pqm: "PQM",
  shinemaster: "ShineMaster",
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
};

export const STATE_LABEL: Record<UnitState, string> = {
  in_stock: "In stock",
  installed: "Installed",
  failed: "Failed",
  at_supplier: "At supplier",
  scrapped: "Scrapped",
  void: "Void",
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
