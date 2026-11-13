/** Plant directory row (fleet home page), built from the Growatt plant list and its live overlay. */
import type { StatusLevel } from "../ui";

export interface UnifiedPlantItem {
  uid: string;
  source: "local" | "growatt";
  id: number;
  /** project phase (Growatt account); null = not yet tagged */
  phase: number | null;
  name: string;
  location: string;
  /** null when Growatt has no plausible capacity for the plant */
  capacityKwp: number | null;
  currentPowerKw: number | null; // realtime (live overlay); null when live is unavailable
  /** measured energy of the latest synced day; null when the plant has no data for it */
  yieldTodayKwh: number | null;
  totalEnergyKwh: number | null;
  specificEnergyKwhPerKwp: number | null;
  prPct: number | null;
  statusLabel: "Normal" | "Faulty" | "Disconnected" | "Loading…";
  statusLevel: StatusLevel;
  stringsCount: number | null;
  modulesCount: number | null;
  invertersCount: number | null;
  deviceSnList: string[];
  deviceType: string;
  batteryStatus: string;
  createdDate: string | null;
}

/* -------------------------------------------------------------------------- */
/* Multi-segment SVG Donut Chart (FusionSolar style)                          */
