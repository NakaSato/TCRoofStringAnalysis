/** PWA Meter data for one window: summary, outage events, meter check, the report days and the monthly billing, read together on mount,
 * when the window changes and on Refresh. DB only; the report is imported monthly, so nothing polls. */
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../../api/client";
import type { PwaBilling, PwaMeterCheck, PwaMeterDaily, PwaMeterSummary, PwaMeterWindow, PwaOutageEvent } from "../../api/client";

export interface PwaMeterData {
  summary: PwaMeterSummary;
  outages: PwaOutageEvent[];
  checks: PwaMeterCheck[];
  daily: PwaMeterDaily;
  billing: PwaBilling;
}

export function usePwaMeter(w: PwaMeterWindow) {
  const [data, setData] = useState<PwaMeterData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);
  const start = w.start ?? null;
  const end = w.end ?? null;

  const reload = useCallback(async () => {
    const n = ++seq.current;
    setLoading(true);
    try {
      const win = { start, end };
      const [summary, outages, checks, daily, billing] = await Promise.all([
        api.getPwaMeterSummary(win),
        api.getPwaMeterOutages(win),
        api.getPwaMeterCheck(win),
        api.getPwaMeterDaily(win),
        api.getPwaMeterBilling(win),
      ]);
      if (n !== seq.current) return;
      setData({ summary, outages, checks, daily, billing });
      setError(null);
    } catch (e) {
      if (n !== seq.current) return;
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (n === seq.current) setLoading(false);
    }
  }, [start, end]);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { data, loading, error, reload };
}
