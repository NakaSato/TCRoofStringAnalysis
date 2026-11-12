import React, { createContext, useContext, useEffect, useState, useCallback, useMemo } from "react";
import {
  api,
  AnalysisRun,
  DatasetInfo,
  GrowattLive,
  GrowattLivePlant,
  GrowattLivePlantLatest,
  GrowattPlant,
  GrowattPlantOverview,
  Plant,
  UserProfile,
  getStoredToken,
  getStoredUser,
  clearAuthSession,
  AUTH_EXPIRED_EVENT,
} from "../api/client";
import { useLivePoll } from "./useLivePoll";

interface AppContextValue {
  user: UserProfile | null;
  /** false until the stored token has been checked (show a splash, not the login page) */
  authChecked: boolean;
  loginAs: (username: string, password: string) => Promise<void>;
  logout: () => void;
  plants: Plant[];
  activePlant: Plant | null;
  setActivePlantId: (id: number) => void;
  datasets: DatasetInfo[];
  activeDataset: DatasetInfo | null;
  selectDataset: (datasetId: number) => Promise<void>;
  analysisRun: AnalysisRun | null;
  refreshAll: () => Promise<void>;
  loading: boolean;
  error: string | null;
  inspectedStringId: string | null;
  setInspectedStringId: (id: string | null) => void;
  // Growatt Fleet & Single-Plant Selection
  growattPlants: GrowattPlant[];
  selectedGrowattPlantId: number | null;
  selectedGrowattPlant: GrowattPlant | null;
  selectedPlantOverview: GrowattPlantOverview | null;
  plantOverviewLoading: boolean;
  dashboardMode: "directory" | "plant";
  setDashboardMode: (mode: "directory" | "plant") => void;
  selectGrowattPlant: (plantId: number, switchToPlantOverview?: boolean) => void;
  refreshGrowattPlants: (force?: boolean) => Promise<void>;
  /** Freshness of the realtime overlay (backend memory cache; never persisted). */
  /** `loading`: the first fleet live poll has not answered yet (status shows "Loading…"; there is no "Unknown"). */
  growattLiveStatus: { fetchedAt: string | null; stale: boolean; error: string | null; loading: boolean };
  /** The selected plant's live record (inverter status) has not answered yet. */
  plantLiveLoading: boolean;
}

const OVERVIEW_REFRESH_MS = 5 * 60_000; // DB history refresh (worker syncs every 30 min)

const AppContext = createContext<AppContextValue | undefined>(undefined);

/** Same names as the backend's solar_core.growatt.INVERTER_STATUS_NAMES. */
const INVERTER_STATUS_NAMES: Record<number, string> = { 0: "Offline", 1: "Normal", 3: "Fault" };

export const AppProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [user, setUser] = useState<UserProfile | null>(getStoredUser());
  const [authChecked, setAuthChecked] = useState<boolean>(false);
  const [plants, setPlants] = useState<Plant[]>([]);
  const [basePlant, setBasePlant] = useState<Plant | null>(null);
  const [datasets, setDatasets] = useState<DatasetInfo[]>([]);
  const [activeDataset, setActiveDataset] = useState<DatasetInfo | null>(null);
  const [baseAnalysisRun, setBaseAnalysisRun] = useState<AnalysisRun | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [inspectedStringId, setInspectedStringId] = useState<string | null>(null);

  // Growatt Fleet & Single-Plant Drill-Down State
  // DB registry (persisted) + realtime overlay (polled, memory only)
  const [growattDbPlants, setGrowattDbPlants] = useState<GrowattPlant[]>([]);
  const [growattLive, setGrowattLive] = useState<GrowattLive<GrowattLivePlant[]> | null>(null);
  const [growattLiveError, setGrowattLiveError] = useState<string | null>(null);
  const [selectedGrowattPlantId, setSelectedGrowattPlantId] = useState<number | null>(null);
  // DB overview (persisted history) + realtime overlay for the selected plant (memory only)
  const [dbPlantOverview, setSelectedPlantOverview] = useState<GrowattPlantOverview | null>(null);
  const [selectedPlantLive, setSelectedPlantLive] = useState<GrowattLive<GrowattLivePlantLatest> | null>(null);
  const [plantLiveFailed, setPlantLiveFailed] = useState(false);
  const [plantOverviewLoading, setPlantOverviewLoading] = useState<boolean>(false);
  const [dashboardMode, setDashboardMode] = useState<"directory" | "plant">("directory");

  // Restore the session from a stored token; without one the login page is shown.
  // (No automatic sign-in: every visitor must log in with their own username.)
  const ensureAuthenticated = useCallback(async () => {
    if (getStoredToken()) {
      try {
        setUser(await api.me());
      } catch {
        clearAuthSession();
        setUser(null);
      }
    } else {
      setUser(null);
    }
    setAuthChecked(true);
  }, []);

  // Any 401 from the API (expired token, disabled account) signs out.
  useEffect(() => {
    const onExpired = () => setUser(null);
    window.addEventListener(AUTH_EXPIRED_EVENT, onExpired);
    return () => window.removeEventListener(AUTH_EXPIRED_EVENT, onExpired);
  }, []);

  const refreshGrowattLive = useCallback(async () => {
    try {
      setGrowattLive(await api.getGrowattLivePlants());
      setGrowattLiveError(null);
    } catch (err) {
      setGrowattLiveError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  const refreshGrowattPlants = useCallback(
    async (force = false) => {
      try {
        const list = await api.listGrowattPlants();
        // Sort by capacity descending so top plants appear first by default
        const sorted = [...list].sort((a, b) => (b.peak_power_kwp || 0) - (a.peak_power_kwp || 0));
        setGrowattDbPlants(sorted);
        // keep the selection only if this user still sees that plant (assignments, user switch)
        setSelectedGrowattPlantId((prev) =>
          prev != null && sorted.some((p) => p.plant_id === prev) ? prev : sorted[0]?.plant_id ?? null
        );
      } catch {
        // ignore
      }
      if (force) await refreshGrowattLive();
    },
    [refreshGrowattLive]
  );

  // Poll realtime values while logged in and the tab is visible, when the backend
  // cache can next change (`refresh_in_s`) rather than on a fixed timer.
  useLivePoll(
    Boolean(user),
    user?.id,
    api.getGrowattLivePlants,
    (r) => {
      setGrowattLive(r);
      setGrowattLiveError(null);
    },
    (err) => setGrowattLiveError(err instanceof Error ? err.message : String(err))
  );

  const livePlantMap = useMemo(
    () => new Map((growattLive?.data ?? []).map((p) => [p.plant_id, p])),
    [growattLive]
  );

  const growattPlants = useMemo<GrowattPlant[]>(
    () =>
      growattDbPlants.map((p) => {
        const live = livePlantMap.get(p.plant_id);
        if (!live) return p;
        return {
          ...p,
          current_power_w: live.current_power_w ?? p.current_power_w,
          total_energy_kwh: live.total_energy_kwh ?? p.total_energy_kwh,
          status: live.status ?? p.status,
        };
      }),
    [growattDbPlants, livePlantMap]
  );

  const growattLiveStatus = useMemo(
    () => ({
      fetchedAt: growattLive?.fetched_at ?? null,
      stale: Boolean(growattLive?.stale || growattLiveError),
      error: growattLiveError ?? growattLive?.error ?? null,
      loading: !growattLive && !growattLiveError,
    }),
    [growattLive, growattLiveError]
  );

  // Overlay the newest record per inverter (power, MPPT, string V/I) on the DB overview.
  // Only "current" fields change; daily aggregates stay from the DB.
  const selectedPlantOverview = useMemo<GrowattPlantOverview | null>(() => {
    const ov = dbPlantOverview;
    const live = selectedPlantLive?.data;
    if (!ov || !live || live.plant_id !== ov.plant.plant_id) return ov;
    if (ov.meta.day && ov.meta.day !== live.day) return ov; // viewing a past day
    const byInv = new Map(live.inverters.map((i) => [i.device_sn, i]));
    const byStr = new Map<string, { voltage_v: number; current_a: number; power_w: number; at: string }>();
    for (const inv of live.inverters) {
      for (const s of inv.strings) byStr.set(`${inv.device_sn}#${s.string_no}`, { ...s, at: inv.timestamp });
    }
    const liveW = live.inverters.reduce((a, i) => a + (i.pac_w ?? 0), 0);
    const hasLive = live.inverters.length > 0;
    // Status is realtime only (null in the DB): plant status from the fleet poll,
    // online count from the newest record of each inverter.
    const liveStatus = livePlantMap.get(ov.plant.plant_id)?.status ?? ov.plant.status;
    const online = hasLive ? live.inverters.filter((i) => i.status === 1).length : ov.kpis.online_inverters;
    return {
      ...ov,
      live: { fetched_at: selectedPlantLive!.fetched_at, stale: selectedPlantLive!.stale },
      plant: { ...ov.plant, status: liveStatus, ...(hasLive ? { current_power_w: liveW } : {}) },
      kpis: {
        ...ov.kpis,
        online_inverters: online,
        ...(hasLive ? { current_power_kw: Math.round(liveW / 10) / 100 } : {}),
      },
      inverters: ov.inverters.map((inv) => {
        const l = byInv.get(inv.device_sn);
        if (!l) return inv;
        return {
          ...inv,
          current_ac_kw: l.pac_w == null ? inv.current_ac_kw : Math.round(l.pac_w / 10) / 100,
          // status is realtime only (null in the DB): take it from the newest record
          status: l.status ?? inv.status,
          status_label: l.status == null ? inv.status_label : INVERTER_STATUS_NAMES[l.status] ?? `Status ${l.status}`,
          mppt_latest: l.mppt.length ? l.mppt : inv.mppt_latest,
          live_at: l.timestamp,
          live_grid: l.grid ?? null,
          live_diagnostics: l.diagnostics ?? null,
          live_mppt_energy: l.mppt_energy ?? null,
        };
      }),
      strings: ov.strings.map((s) => {
        const l = byStr.get(`${s.device_sn}#${s.string_no}`);
        return l
          ? { ...s, live_voltage_v: l.voltage_v, live_current_a: l.current_a, live_power_w: l.power_w, live_at: l.at }
          : s;
      }),
    };
  }, [dbPlantOverview, selectedPlantLive, livePlantMap]);

  const loadPlantContext = useCallback(async (plantId?: number) => {
    setLoading(true);
    setError(null);
    try {
      // The legacy plant / analysis modules are admin only: engineers load just their Growatt plants.
      if (user?.role !== "admin") {
        await refreshGrowattPlants(false);
        setPlants([]);
        setBasePlant(null);
        setDatasets([]);
        setActiveDataset(null);
        setBaseAnalysisRun(null);
        return;
      }
      const [plantList] = await Promise.all([api.listPlants(), refreshGrowattPlants(false)]);
      setPlants(plantList);
      const chosen = plantList.find((p) => p.id === plantId) || plantList[0] || null;
      setBasePlant(chosen);

      if (chosen) {
        const [dsList, latestRun] = await Promise.all([
          api.listDatasets(chosen.id),
          // 404 = no analysis run yet (production starts without demo data)
          api.getLatestAnalysis(chosen.id).catch(() => null),
        ]);
        setDatasets(dsList);
        setBaseAnalysisRun(latestRun);
        if (latestRun) {
          const dsDetail = await api.getDataset(latestRun.dataset_id);
          setActiveDataset(dsDetail);
        } else if (dsList.length > 0) {
          const dsDetail = await api.getDataset(dsList[0].id);
          setActiveDataset(dsDetail);
        }
      }
    } catch (err: any) {
      setError(err.message || "Failed to load plant telemetry context");
    } finally {
      setLoading(false);
    }
  }, [refreshGrowattPlants, user?.role]);

  useEffect(() => {
    ensureAuthenticated();
  }, [ensureAuthenticated]);

  // Load data only once signed in (and again after switching user).
  useEffect(() => {
    if (authChecked && user) loadPlantContext();
  }, [authChecked, user?.id, loadPlantContext]);

  // Load single-plant overview whenever selectedGrowattPlantId changes
  useEffect(() => {
    if (selectedGrowattPlantId == null) return;
    let cancelled = false;
    setPlantOverviewLoading(true);
    api
      .getGrowattPlantOverview(selectedGrowattPlantId)
      .then((ov) => {
        if (!cancelled) {
          setSelectedPlantOverview(ov);
        }
      })
      .catch(() => {
        // keep previous or null
      })
      .finally(() => {
        if (!cancelled) {
          setPlantOverviewLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [selectedGrowattPlantId]);

  // Realtime: newest record per inverter of the selected plant, polled when the backend
  // says a newer record can exist, while visible.
  useEffect(() => {
    setSelectedPlantLive(null);
    setPlantLiveFailed(false);
  }, [user?.id, selectedGrowattPlantId]);
  useLivePoll(
    Boolean(user) && selectedGrowattPlantId != null,
    `${user?.id}:${selectedGrowattPlantId}`,
    () => api.getGrowattLivePlantLatest(selectedGrowattPlantId!),
    (r) => {
      setSelectedPlantLive(r);
      setPlantLiveFailed(false);
    },
    // live unavailable: DB values remain, status keeps showing "Loading…" until a retry succeeds
    () => setPlantLiveFailed(true)
  );

  // Persisted history: re-read the DB overview so today's curve/yield grow as the worker syncs.
  useEffect(() => {
    if (selectedGrowattPlantId == null) return;
    const plantId = selectedGrowattPlantId;
    let cancelled = false;
    const id = window.setInterval(() => {
      if (document.hidden) return;
      api
        .getGrowattPlantOverview(plantId)
        .then((ov) => {
          if (!cancelled) setSelectedPlantOverview(ov);
        })
        .catch(() => {});
    }, OVERVIEW_REFRESH_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [selectedGrowattPlantId]);

  const selectGrowattPlant = useCallback((plantId: number, switchToPlantOverview = true) => {
    setSelectedGrowattPlantId(plantId);
    if (switchToPlantOverview) {
      setDashboardMode("plant");
      window.scrollTo({ top: 0, behavior: "smooth" });
    }
  }, []);

  const selectedGrowattPlant = useMemo(
    () => growattPlants.find((p) => p.plant_id === selectedGrowattPlantId) || selectedPlantOverview?.plant || null,
    [growattPlants, selectedGrowattPlantId, selectedPlantOverview]
  );

  // Synthesize activePlant & analysisRun from selectedPlantOverview so every page/drawer reflects the selected plant
  const activePlant = useMemo<Plant | null>(() => {
    if (selectedPlantOverview && basePlant) {
      const gp = selectedPlantOverview.plant;
      const k = selectedPlantOverview.kpis;
      return {
        ...basePlant,
        name: gp.name,
        location: [gp.city, gp.country].filter(Boolean).join(", ") || "Thailand",
        target_pr_pct: k.target_pr_pct,
        tariff_thb_per_kwh: k.tariff_thb_per_kwh,
      };
    }
    return basePlant;
  }, [selectedPlantOverview, basePlant]);

  const analysisRun = useMemo<AnalysisRun | null>(() => {
    if (selectedPlantOverview && baseAnalysisRun) {
      const k = selectedPlantOverview.kpis;
      const liveW = livePlantMap.get(selectedPlantOverview.plant.plant_id)?.current_power_w;
      return {
        ...baseAnalysisRun,
        target_pr_pct: k.target_pr_pct,
        tariff_thb_per_kwh: k.tariff_thb_per_kwh,
        plant_kpis_json: {
          ...baseAnalysisRun.plant_kpis_json,
          total_capacity_kwp: k.capacity_kwp,
          total_energy_kwh: k.yield_today_kwh,
          lifetime_energy_kwh: k.total_yield_kwh,
          specific_yield_kwh_per_kwp: k.specific_yield_kwh_per_kwp,
          plant_pr_pct: k.plant_pr_pct,
          num_strings: k.string_count,
          healthy_strings: k.healthy_strings,
          warning_strings: k.warning_strings,
          critical_strings: k.critical_strings,
          avg_health_score: k.avg_health_score,
          peak_power_kw: k.peak_power_kw,
          current_power_kw: liveW != null ? liveW / 1000 : k.current_power_kw,
          conversion_efficiency_pct: k.conversion_efficiency_pct,
          avg_temp_c: k.avg_temp_c,
          max_temp_c: k.max_temp_c,
          avg_freq_hz: k.avg_freq_hz,
        },
        string_summary_json: selectedPlantOverview.strings,
        anomalies_json: selectedPlantOverview.anomalies,
      };
    }
    return baseAnalysisRun;
  }, [selectedPlantOverview, baseAnalysisRun, livePlantMap]);

  const setActivePlantId = (id: number) => {
    loadPlantContext(id);
  };

  const selectDataset = async (datasetId: number) => {
    setLoading(true);
    try {
      const detail = await api.getDataset(datasetId);
      setActiveDataset(detail);
      if (detail.latest_analysis_run_id) {
        const run = await api.getAnalysisRun(detail.latest_analysis_run_id);
        setBaseAnalysisRun(run);
      } else {
        const run = await api.analyzeDataset(datasetId);
        setBaseAnalysisRun(run);
      }
      if (basePlant) {
        const dsList = await api.listDatasets(basePlant.id);
        setDatasets(dsList);
      }
    } finally {
      setLoading(false);
    }
  };

  const refreshAll = async () => {
    await loadPlantContext(basePlant?.id);
    if (selectedGrowattPlantId != null) {
      const ov = await api.getGrowattPlantOverview(selectedGrowattPlantId);
      setSelectedPlantOverview(ov);
    }
  };

  const loginAs = async (username: string, password: string) => {
    const res = await api.login(username, password);
    setUser(res.user);
  };

  const logout = () => {
    clearAuthSession();
    setUser(null);
  };

  return (
    <AppContext.Provider
      value={{
        user,
        authChecked,
        loginAs,
        logout,
        plants,
        activePlant,
        setActivePlantId,
        datasets,
        activeDataset,
        selectDataset,
        analysisRun,
        refreshAll,
        loading,
        error,
        inspectedStringId,
        setInspectedStringId,
        growattPlants,
        selectedGrowattPlantId,
        selectedGrowattPlant,
        selectedPlantOverview,
        growattLiveStatus,
        plantLiveLoading: selectedGrowattPlantId != null && !selectedPlantLive && !plantLiveFailed,
        plantOverviewLoading,
        dashboardMode,
        setDashboardMode,
        selectGrowattPlant,
        refreshGrowattPlants,
      }}
    >
      {children}
    </AppContext.Provider>
  );
};

export const useAppContext = (): AppContextValue => {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error("useAppContext must be used inside AppProvider");
  return ctx;
};
