/** Shared pieces of the Devices page's Meters, Dataloggers and Checks tabs (docs/plans/devices-page.md). */
import React, { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { ArrowUpRight, RefreshCw } from "lucide-react";
import { plantPath } from "../../context/routes";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import { useI18n } from "../../i18n";

/** rows per page of every tab's table */
export const TABS_PAGE = 50;
/** a stored record older than this (minutes) shows amber */
export const STALE_MIN = 120;

/** Read once on mount, on `refresh()` and when `signal` changes (the page-level Refresh), never polled.
 * `loading` covers the first read and re-reads. */
export function useDeviceList<T>(load: () => Promise<T>, signal = 0) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    load()
      .then((r) => !cancelled && (setData(r), setError(null)))
      .catch((e) => !cancelled && setError(e instanceof Error ? e.message : String(e)))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
    // `load` is a stable api method; only Refresh re-reads
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick, signal]);
  const refresh = useCallback(() => setTick((n) => n + 1), []);
  return { data, error, loading, refresh };
}

/** A plant-local "YYYY-MM-DDTHH:MM:SS" (Bangkok) as a Date; null when missing or unreadable. */
export const plantLocalDate = (v: string | null | undefined): Date | null => {
  if (!v) return null;
  const hasZone = /([zZ]|[+-]\d{2}:?\d{2})$/.test(v);
  const ms = Date.parse(hasZone ? v : `${v}+07:00`);
  return Number.isFinite(ms) ? new Date(ms) : null;
};

/** Minutes since a plant-local timestamp; null when missing. */
export const ageMinutes = (v: string | null | undefined, now = Date.now()): number | null => {
  const d = plantLocalDate(v);
  return d ? Math.max(0, (now - d.getTime()) / 60_000) : null;
};

/** Sort with nulls last whatever the direction. */
export const sortNullsLast = <T,>(rows: T[], get: (r: T) => number | string | null, desc: boolean): T[] =>
  [...rows].sort((a, b) => {
    const va = get(a);
    const vb = get(b);
    if (va == null && vb == null) return 0;
    if (va == null) return 1;
    if (vb == null) return -1;
    return (va < vb ? -1 : va > vb ? 1 : 0) * (desc ? -1 : 1);
  });

/** The newest stored record and how old it is; amber past `STALE_MIN`, "—" when nothing is stored. */
export const RecordAge: React.FC<{ value: string | null }> = ({ value }) => {
  const { t, locale } = useI18n();
  const d = plantLocalDate(value);
  if (!d) return <span className="text-muted-foreground">—</span>;
  const min = ageMinutes(value) ?? 0;
  const sameDay = d.toLocaleDateString("en-CA", { timeZone: "Asia/Bangkok" }) === new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Bangkok" });
  const time = d.toLocaleTimeString(locale, { timeZone: "Asia/Bangkok", hour: "2-digit", minute: "2-digit" });
  const shown = sameDay ? time : `${d.toLocaleDateString(locale, { timeZone: "Asia/Bangkok", day: "numeric", month: "short" })} ${time}`;
  const age =
    min < 60 ? t("{n} min ago", { n: Math.round(min) }) : min < 48 * 60 ? t("{n} h ago", { n: Math.floor(min / 60) }) : t("{n} d ago", { n: Math.floor(min / 1440) });
  const stale = min > STALE_MIN;
  return (
    <span className="flex flex-col whitespace-nowrap" title={value ?? undefined}>
      <span className={cn("num", stale && "text-amber-300")}>{shown}</span>
      <span className={cn("num text-[11px]", stale ? "text-amber-300/80" : "text-muted-foreground")}>{age}</span>
    </span>
  );
};

/** Plant name linking to its overview, with the id under it. */
export const PlantLink: React.FC<{ id: number; name: string }> = ({ id, name }) => (
  <span className="flex min-w-0 flex-col">
    <Link to={plantPath(id)} className="group flex min-w-0 items-center gap-1 font-medium text-foreground hover:text-sky-300">
      <span className="truncate" title={name}>
        {name}
      </span>
      <ArrowUpRight className="size-3 shrink-0 text-sky-400 opacity-0 transition group-hover:opacity-100" />
    </Link>
    <span className="num text-[11px] text-muted-foreground">{id}</span>
  </span>
);

export const RefreshButton: React.FC<{ loading: boolean; onClick: () => void }> = ({ loading, onClick }) => {
  const { t } = useI18n();
  return (
    <Button variant="outline" size="sm" onClick={onClick} disabled={loading}>
      {loading ? <Spinner data-icon="inline-start" className="size-3" /> : <RefreshCw data-icon="inline-start" />}
      {t("Refresh")}
    </Button>
  );
};

/** "Stored data · synced hh:mm" line under a tab's title. */
export const SyncedLine: React.FC<{ syncedAt: string | null | undefined }> = ({ syncedAt }) => {
  const { t, locale } = useI18n();
  const d = syncedAt ? new Date(syncedAt) : null;
  return (
    <span className="text-xs text-muted-foreground">
      {t("Stored data")}
      {" · "}
      {d && Number.isFinite(d.getTime())
        ? t("last history sync {time}", { time: d.toLocaleString(locale, { timeZone: "Asia/Bangkok", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) })
        : t("no history sync yet")}
    </span>
  );
};
