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
  /** plant coordinates from Growatt; null when unset (0,0) or implausible */
  latitude: number | null;
  longitude: number | null;
  /** null when Growatt has no plausible capacity for the plant */
  capacityKwp: number | null;
  currentPowerKw: number | null; // realtime (live overlay); null when live is unavailable
  /** today's energy, realtime (Growatt plant/data); null until checked or when the last upload is not from today */
  yieldTodayKwh: number | null;
  totalEnergyKwh: number | null;
  specificEnergyKwhPerKwp: number | null;
  prPct: number | null;
  statusLabel: "Normal" | "Faulty" | "Disconnected" | "Loading…";
  statusLevel: StatusLevel;
  /** sort key for Status: Faulty 3, Disconnected 2, Normal 1; null while loading (sorts last) */
  statusRank: number | null;
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
