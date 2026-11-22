/** Measuring Tools data: the instrument list, read on mount, after each change and every 5 min
 * while the page is visible. DB only (no live values). */
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../../api/client";
import type { InstrumentList } from "../../api/client";

/** the API calls the page and its dialogs use */
export const toolsApi = {
  listInstruments: api.listInstruments,
  getInstrument: api.getInstrument,
  createInstrument: api.createInstrument,
  patchInstrument: api.patchInstrument,
  deleteInstrument: api.deleteInstrument,
  checkoutInstrument: api.checkoutInstrument,
  returnInstrument: api.returnInstrument,
  recordInstrumentDue: api.recordInstrumentDue,
};

const REFRESH_MS = 5 * 60_000;

export function useInstruments(includeRetired: boolean) {
  const [data, setData] = useState<InstrumentList | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // a foreground re-read (Refresh, a change, a filter) with data on screen; the 5-min one stays quiet
  const [refreshing, setRefreshing] = useState(false);
  const seq = useRef(0);

  const reload = useCallback(async (background = false) => {
    const n = ++seq.current;
    setLoading(true);
    setRefreshing(!background);
    try {
      const d = await toolsApi.listInstruments(includeRetired);
      if (n !== seq.current) return;
      setData(d);
      setError(null);
    } catch (e) {
      if (n !== seq.current) return;
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (n === seq.current) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, [includeRetired]);

  useEffect(() => {
    void reload();
    const t = setInterval(() => {
      if (!document.hidden) void reload(true);
    }, REFRESH_MS);
    return () => clearInterval(t);
  }, [reload]);

  return { data, loading, refreshing: refreshing && data != null, error, reload };
}
