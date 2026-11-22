/** Plant directory row (fleet home page), built from the Growatt plant list and its live overlay. */
import type { StatusLevel } from "../ui";

/** Inverters of a plant by their newest record (snapshot): `normal` / `waiting` / `fault` = a record
 *  from today with status 1 / 0 / 3; `offline` = its newest record is older than today (`maxs_data`'s
 *  `lost` is true on every inverter, so it is not used); `answered` = how many Growatt has answered for so far. */
export interface InverterLiveCounts {
  normal: number;
  waiting: number;
  fault: number;
  offline: number;
  other: number;
  answered: number;
}

export interface UnifiedPlantItem {
  uid: string;
  source: "local" | "growatt";
  id: number;
  /** project phase (Growatt account); null = not yet tagged */
  phase: number | null;
  name: string;
  location: string;
  /** province from the O&M site register, else Growatt's plant `city`; null when neither has one */
  province: string | null;
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
  /** live inverter status from the fleet snapshot (`maxs_data`, memory only); null until any answered */
  invLive: InverterLiveCounts | null;
  deviceSnList: string[];
  deviceType: string;
  batteryStatus: string;
  createdDate: string | null;
}

/* -------------------------------------------------------------------------- */
/* Multi-segment SVG Donut Chart (FusionSolar style)                          */
