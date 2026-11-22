/** Knowledge Base library data (DB only): read on mount / when the query changes / after a change,
 * never polled. `useKbContext` lives in `context/kbContextStore.ts` (re-exported here). */
import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError } from "../../api/client";
import { errText } from "./format";

export interface Loaded<T> {
  data: T | null;
  setData: (v: T | null) => void;
  loading: boolean;
  /** a re-read with data on screen */
  refreshing: boolean;
  error: { text: string; status: number | null } | null;
  reload: () => Promise<void>;
}

/** `load` runs again whenever `key` changes; the answer of an older key is dropped. `key` null = off. */
export function useLoad<T>(key: string | null, load: () => Promise<T>, { keepOnKeyChange = true } = {}): Loaded<T> {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(key != null);
  const [error, setError] = useState<Loaded<T>["error"]>(null);
  const seq = useRef(0);
  const loadRef = useRef(load);
  loadRef.current = load;

  const reload = useCallback(async () => {
    if (key == null) return;
    const n = ++seq.current;
    setLoading(true);
    try {
      const d = await loadRef.current();
      if (n !== seq.current) return;
      setData(d);
      setError(null);
    } catch (e) {
      if (n !== seq.current) return;
      setError({ text: errText(e), status: e instanceof ApiError ? e.status : null });
    } finally {
      if (n === seq.current) setLoading(false);
    }
  }, [key]);

  useEffect(() => {
    if (!keepOnKeyChange) {
      setData(null);
      setError(null);
    }
    void reload();
  }, [reload, keepOnKeyChange]);

  return { data, setData, loading, refreshing: loading && data != null, error, reload };
}

export { faultKey, invalidateKbContext, modelKey, useKbContext } from "../../context/kbContextStore";
