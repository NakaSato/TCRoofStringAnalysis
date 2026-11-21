/** Engineering O&M overview for one window: read on mount, when the window or the shadow switch
 * changes and on Refresh. DB only, stored days, so nothing polls. */
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../../api/client";
import type { OmCenter } from "../../api/client";

/** `enabled` false = the window is not known yet: nothing is read, `loading` stays true */
export function useCenter(start: string | null, end: string | null, includeShadow: boolean, enabled = true) {
  const [data, setData] = useState<OmCenter | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);

  const reload = useCallback(async () => {
    const n = ++seq.current;
    setLoading(true);
    try {
      const res = await api.getOmCenter({ start, end, includeShadow });
      if (n !== seq.current) return;
      setData(res);
      setError(null);
    } catch (e) {
      if (n !== seq.current) return;
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (n === seq.current) setLoading(false);
    }
  }, [start, end, includeShadow]);

  useEffect(() => {
    if (enabled) void reload();
  }, [reload, enabled]);

  return { data, loading, error, reload };
}
