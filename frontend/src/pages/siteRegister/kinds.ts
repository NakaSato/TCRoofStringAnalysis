import { Activity, CloudSun, Cpu, Gauge, Router, Server } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { SiteDeviceKind } from "../../api/client";

/** Device kinds in the register's order (backend `site_register.KINDS`), with their English labels. */
export const KIND_LABEL: Record<SiteDeviceKind, string> = {
  datalogger: "Data logger",
  weather_station: "Weather station",
  revenue_meter: "Revenue meter",
  router: "Router 4G",
  pqm: "PQM",
  shinemaster: "ShineMaster",
};

export const KINDS = Object.keys(KIND_LABEL) as SiteDeviceKind[];

export const KIND_ICON: Record<SiteDeviceKind, LucideIcon> = {
  datalogger: Cpu,
  weather_station: CloudSun,
  revenue_meter: Gauge,
  router: Router,
  pqm: Activity,
  shinemaster: Server,
};
