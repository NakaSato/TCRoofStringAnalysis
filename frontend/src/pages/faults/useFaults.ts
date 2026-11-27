/** Field faults data: the filtered list with the summary counts, read when the filters change,
 * after each change and every 5 min while the page is visible. DB only (`/faults`,
 * docs/plans/defects.md). The API filters; the page sorts and pages the rows it holds. */
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../../api/client";
import type { FaultList, FaultQuery } from "../../api/client";

/** the fault methods the page uses */
export const faultsApi = {
  listFaults: api.listFaults,
  getFault: api.getFault,
  createFault: api.createFault,
  patchFault: api.patchFault,
  setFaultStatus: api.setFaultStatus,
  setFaultDecision: api.setFaultDecision,
  addFaultNote: api.addFaultNote,
  addFaultLink: api.addFaultLink,
  deleteFaultLink: api.deleteFaultLink,
  faultsOpenOnDevice: api.faultsOpenOnDevice,
};

/** rows read per request (the API's maximum); more matching rows = narrow the filters */
export const FAULT_LIMIT = 500;
const REFRESH_MS = 5 * 60_000;

export function useFaults(query: FaultQuery) {
  const [data, setData] = useState<FaultList | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const seq = useRef(0);
  const key = JSON.stringify(query);
  const queryRef = useRef(query);
  queryRef.current = query;

  const reload = useCallback(async (background = false) => {
    const n = ++seq.current;
    setLoading(true);
    setRefreshing(!background);
    try {
      const d = await faultsApi.listFaults({ ...queryRef.current, limit: FAULT_LIMIT });
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
  }, []);

  useEffect(() => {
    void reload();
  }, [key, reload]);

  useEffect(() => {
    const t = setInterval(() => {
      if (!document.hidden) void reload(true);
    }, REFRESH_MS);
    return () => clearInterval(t);
  }, [reload]);

  return { data, loading, refreshing: refreshing && data != null, error, reload };
}
