/** Measuring Tools data: the instrument list, read on mount, after each change and every 5 min
 * while the page is visible. DB only (no live values). Uses the in-memory mock while
 * `TOOLS_MOCK` is on (see `api/toolsMock.ts`). */
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../../api/client";
import type { InstrumentList } from "../../api/client";
import { TOOLS_MOCK, toolsMock } from "../../api/toolsMock";
import { useAppContext } from "../../context/AppContext";

/** the API the page uses: the real client, or the mock with the same signatures */
export const toolsApi = TOOLS_MOCK
  ? toolsMock
  : {
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
  const { growattPlants } = useAppContext();
  const [data, setData] = useState<InstrumentList | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);

  // mock only: let the seeded check-outs point at the user's own plants
  if (TOOLS_MOCK && growattPlants.length) toolsMock.setPlants(growattPlants.slice(0, 5).map((p) => p.plant_id));

  const reload = useCallback(async () => {
    const n = ++seq.current;
    setLoading(true);
    try {
      const d = await toolsApi.listInstruments(includeRetired);
      if (n !== seq.current) return;
      setData(d);
      setError(null);
    } catch (e) {
      if (n !== seq.current) return;
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (n === seq.current) setLoading(false);
    }
  }, [includeRetired]);

  useEffect(() => {
    void reload();
    const t = setInterval(() => {
      if (!document.hidden) void reload();
    }, REFRESH_MS);
    return () => clearInterval(t);
  }, [reload]);

  return { data, loading, error, reload, mock: TOOLS_MOCK };
}
