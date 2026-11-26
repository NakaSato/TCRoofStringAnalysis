/** Inventory linked to the installed equipment (docs/plans/inventory-installed-base.md): read from
 * the Growatt registry and the site register, never copied. Values the registry lacks are null. */
import type { PartCategory, StockPart } from "./stock";

export type InstalledSource = "inverter" | "datalogger" | "site_device" | "grid_meter";

export interface InstalledDevice {
  /** "inv:<sn>" | "dl:<sn>:<plant_id>" | "sd:<site_devices.id>" | "gm:<datalogger_sn>:<address>" */
  key: string;
  source: InstalledSource;
  category: PartCategory;
  label: string;
  serial: string | null;
  model: string | null;
  plant_id: number | null;
  plant_name: string | null;
  site_code: string | null;
  phase: number | null;
  /** site devices only: router IP / network = the VPN address */
  ip: string | null;
  network: string | null;
  sim: string | null;
  status: string | null;
  /** the target `POST /stock/replacements` takes */
  site_device_id: number | null;
  inverter_sn: string | null;
  /** app route that opens it */
  path: string;
  /** a spare unit `installed` with this serial */
  spare_unit_id: number | null;
  /** an open failed unit has this serial */
  failed_open: boolean;
}

export interface InstalledQuery {
  category?: string;
  plant_id?: number;
  phase?: number;
  q?: string;
  limit?: number;
  offset?: number;
}

export interface InstalledList {
  items: InstalledDevice[];
  total: number;
  /** per category, over the filtered scope before limit */
  counts: Partial<Record<PartCategory, number>>;
  meta: { source: "db" };
}

export interface ModelRow {
  category: PartCategory;
  /** null = model not recorded */
  model: string | null;
  model_key: string | null;
  installed: number;
  /** "<phase>" | "none" */
  installed_by_phase: Record<string, number>;
  in_stock: number;
  failed_open: number;
  at_supplier: number;
  parts: { id: number; code: string; name: string; min_qty: number | null }[];
}

export interface ModelProposal {
  category: PartCategory;
  model: string;
  make: string | null;
  code: string;
  name: string;
  installed: number;
  /** an existing matching part: nothing to create */
  part_id: number | null;
}

export interface FromModelsItem {
  category: PartCategory;
  model: string;
  make: string | null;
  code: string;
  name: string;
}

export interface RegistryHit {
  source: InstalledSource;
  category: PartCategory;
  label: string;
  plant_id: number | null;
  plant_name: string | null;
  site_code: string | null;
  ip: string | null;
  network: string | null;
  sim: string | null;
  path: string;
}

export type { StockPart };
