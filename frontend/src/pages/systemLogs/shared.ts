import type { SystemLogLevel, SystemLogSource } from "../../api/client";
import type { StatusLevel } from "../../components/ui";

export const LEVEL_VIEW: Record<SystemLogLevel, StatusLevel> = { DEBUG: "neutral", INFO: "info", WARNING: "warn", ERROR: "crit", CRITICAL: "crit" };

/** "2026-11-13T02:00:04Z" → Bangkok "2026-11-13" and "09:00:04". */
export const bkk = (iso: string) => {
  const s = new Date(iso).toLocaleString("sv-SE", { timeZone: "Asia/Bangkok" });
  return { day: s.slice(0, 10), time: s.slice(11, 19) };
};

export const shortLogger = (name: string) => name.replace(/^app\.(services|api\.routes|api)\./, "");

export const SOURCE_VIEW: { key: SystemLogSource; label: string; bar: string; dot: string }[] = [
  { key: "api", label: "API", bar: "bg-sky-400/70", dot: "bg-sky-400" },
  { key: "worker", label: "Worker", bar: "bg-violet-400/70", dot: "bg-violet-400" },
  { key: "cli", label: "CLI", bar: "bg-slate-400/60", dot: "bg-slate-400" },
];
