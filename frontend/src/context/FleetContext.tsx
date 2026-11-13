import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { api, GrowattLive, GrowattLivePlant, GrowattPlant } from "../api/client";
import { useAuth } from "./AuthContext";
import { useLivePoll } from "./useLivePoll";

export interface FleetContextValue {
  /** DB plant list with the live status / power overlaid (empty until loaded) */
  growattPlants: GrowattPlant[];
  /** the DB list has been read this session */
  plantListLoaded: boolean;
  /** load the plant list if it isn't yet (e.g. when the plant switcher opens) */
  ensurePlantList: () => void;
  /** re-read the DB list; `force` also re-reads live status at once */
  refreshGrowattPlants: (force?: boolean) => Promise<void>;
  /** live record of one plant from the fleet poll (status, power), if polled */
  livePlant: (plantId: number) => GrowattLivePlant | undefined;
  /** Freshness of the realtime overlay (backend memory cache; never persisted).
   * `loading`: the first fleet live poll has not answered yet (status shows "Loading…"). */
  growattLiveStatus: { fetchedAt: string | null; stale: boolean; error: string | null; loading: boolean };
}

const noop = () => undefined;
const FleetContext = createContext<FleetContextValue>({
  growattPlants: [],
  plantListLoaded: false,
  ensurePlantList: noop,
  refreshGrowattPlants: async () => undefined,
  livePlant: noop,
  growattLiveStatus: { fetchedAt: null, stale: false, error: null, loading: false },
});

/**
 * Fleet plant list (DB) and the live fleet poll. `listWanted` / `liveWanted` come from the route
 * (`routeData`): the list is read once per session when first wanted, and the live poll runs only
 * while the route shows live fleet values.
 */
export const FleetProvider: React.FC<{ listWanted: boolean; liveWanted: boolean; children: React.ReactNode }> = ({
  listWanted,
  liveWanted,
  children,
}) => {
  const { user } = useAuth();
  const userId = user?.id ?? null; // /auth/me replaces the user object: key effects on the id
  const [dbPlants, setDbPlants] = useState<GrowattPlant[]>([]);
  const [listLoaded, setListLoaded] = useState(false);
  const [listRequested, setListRequested] = useState(false);
  const [live, setLive] = useState<GrowattLive<GrowattLivePlant[]> | null>(null);
  const [liveError, setLiveError] = useState<string | null>(null);

  // another user may see other plants: start over
  useEffect(() => {
    setDbPlants([]);
    setListLoaded(false);
    setListRequested(false);
    setLive(null);
    setLiveError(null);
  }, [user?.id]);

  const loadList = useCallback(async () => {
    const list = await api.listGrowattPlants();
    // largest plants first by default
    setDbPlants([...list].sort((a, b) => (b.peak_power_kwp || 0) - (a.peak_power_kwp || 0)));
    setListLoaded(true);
  }, []);

  useEffect(() => {
    if (userId == null || listLoaded || !(listWanted || listRequested)) return;
    loadList().catch(() => undefined); // directory shows its empty state; retried on refresh
  }, [userId, listLoaded, listWanted, listRequested, loadList]);

  const refreshLive = useCallback(async () => {
    try {
      setLive(await api.getGrowattLivePlants());
      setLiveError(null);
    } catch (err) {
      setLiveError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  const refreshGrowattPlants = useCallback(
    async (force = false) => {
      await loadList();
      if (force) await refreshLive();
    },
    [loadList, refreshLive]
  );

  // polled when the backend cache can next change (`refresh_in_s`), only while the route wants it
  useLivePoll(
    userId != null && liveWanted,
    userId,
    api.getGrowattLivePlants,
    (r) => {
      setLive(r);
      setLiveError(null);
    },
    (err) => setLiveError(err instanceof Error ? err.message : String(err))
  );

  const liveMap = useMemo(() => new Map((live?.data ?? []).map((p) => [p.plant_id, p])), [live]);

  const growattPlants = useMemo<GrowattPlant[]>(
    () =>
      dbPlants.map((p) => {
        const l = liveMap.get(p.plant_id);
        if (!l) return p;
        return {
          ...p,
          current_power_w: l.current_power_w ?? p.current_power_w,
          total_energy_kwh: l.total_energy_kwh ?? p.total_energy_kwh,
          status: l.status ?? p.status,
        };
      }),
    [dbPlants, liveMap]
  );

  const value = useMemo<FleetContextValue>(
    () => ({
      growattPlants,
      plantListLoaded: listLoaded,
      ensurePlantList: () => setListRequested(true),
      refreshGrowattPlants,
      livePlant: (id: number) => liveMap.get(id),
      growattLiveStatus: {
        fetchedAt: live?.fetched_at ?? null,
        stale: Boolean(live?.stale || liveError),
        error: liveError ?? live?.error ?? null,
        loading: !live && !liveError,
      },
    }),
    [growattPlants, listLoaded, refreshGrowattPlants, liveMap, live, liveError]
  );

  return <FleetContext.Provider value={value}>{children}</FleetContext.Provider>;
};

export const useFleet = (): FleetContextValue => useContext(FleetContext);
