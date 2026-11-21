import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { api, AnalysisRun, DatasetInfo, Plant } from "../api/client";
import { isAdmin } from "../auth/access";
import { translate } from "../i18n";
import { useAuth } from "./AuthContext";

export interface LegacyContextValue {
  plants: Plant[];
  /** legacy analysis plant (local `plants` table, not a Growatt plant) */
  legacyPlant: Plant | null;
  datasets: DatasetInfo[];
  activeDataset: DatasetInfo | null;
  /** latest analysis run of the legacy plant */
  legacyRun: AnalysisRun | null;
  legacyLoading: boolean;
  legacyError: string | null;
  /** load the legacy tables if they aren't yet */
  ensureLegacy: () => void;
  /** (re)load, optionally for another legacy plant */
  reloadLegacy: (plantId?: number) => Promise<void>;
  selectDataset: (datasetId: number) => Promise<void>;
}

const LegacyContext = createContext<LegacyContextValue>({
  plants: [],
  legacyPlant: null,
  datasets: [],
  activeDataset: null,
  legacyRun: null,
  legacyLoading: false,
  legacyError: null,
  ensureLegacy: () => undefined,
  reloadLegacy: async () => undefined,
  selectDataset: async () => undefined,
});

/**
 * The legacy plant / dataset / analysis tables (admin only: the backend answers 403 to engineers).
 * Read once per session, only when a route that uses them is open (`enabled`) or `ensureLegacy()`
 * was called.
 */
export const LegacyProvider: React.FC<{ enabled: boolean; children: React.ReactNode }> = ({ enabled, children }) => {
  const { user } = useAuth();
  const admin = isAdmin(user);
  const [plants, setPlants] = useState<Plant[]>([]);
  const [legacyPlant, setLegacyPlant] = useState<Plant | null>(null);
  const [datasets, setDatasets] = useState<DatasetInfo[]>([]);
  const [activeDataset, setActiveDataset] = useState<DatasetInfo | null>(null);
  const [legacyRun, setLegacyRun] = useState<AnalysisRun | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [requested, setRequested] = useState(false);

  useEffect(() => {
    setPlants([]);
    setLegacyPlant(null);
    setDatasets([]);
    setActiveDataset(null);
    setLegacyRun(null);
    setLoaded(false);
    setRequested(false);
    setError(null);
  }, [user?.id]);

  const reloadLegacy = useCallback(
    async (plantId?: number) => {
      if (!admin) return;
      setLoading(true);
      setError(null);
      try {
        const plantList = await api.listPlants();
        setPlants(plantList);
        const chosen = plantList.find((p) => p.id === plantId) || plantList[0] || null;
        setLegacyPlant(chosen);
        setDatasets([]);
        setActiveDataset(null);
        setLegacyRun(null);
        if (chosen) {
          const [dsList, latestRun] = await Promise.all([
            api.listDatasets(chosen.id),
            // 404 = no analysis run yet (production starts without demo data)
            api.getLatestAnalysis(chosen.id).catch(() => null),
          ]);
          setDatasets(dsList);
          setLegacyRun(latestRun);
          if (latestRun) setActiveDataset(await api.getDataset(latestRun.dataset_id));
          else if (dsList.length > 0) setActiveDataset(await api.getDataset(dsList[0].id));
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : translate("Failed to load the analysis plant"));
      } finally {
        setLoaded(true);
        setLoading(false);
      }
    },
    [admin]
  );

  useEffect(() => {
    if (admin && !loaded && !loading && (enabled || requested)) reloadLegacy();
  }, [admin, loaded, loading, enabled, requested, reloadLegacy]);

  const selectDataset = useCallback(
    async (datasetId: number) => {
      setLoading(true);
      try {
        const detail = await api.getDataset(datasetId);
        setActiveDataset(detail);
        setLegacyRun(
          detail.latest_analysis_run_id
            ? await api.getAnalysisRun(detail.latest_analysis_run_id)
            : await api.analyzeDataset(datasetId)
        );
        if (legacyPlant) setDatasets(await api.listDatasets(legacyPlant.id));
      } finally {
        setLoading(false);
      }
    },
    [legacyPlant]
  );

  const value = useMemo<LegacyContextValue>(
    () => ({
      plants,
      legacyPlant,
      datasets,
      activeDataset,
      legacyRun,
      legacyLoading: loading,
      legacyError: error,
      ensureLegacy: () => setRequested(true),
      reloadLegacy,
      selectDataset,
    }),
    [plants, legacyPlant, datasets, activeDataset, legacyRun, loading, error, reloadLegacy, selectDataset]
  );

  return <LegacyContext.Provider value={value}>{children}</LegacyContext.Provider>;
};

export const useLegacy = (): LegacyContextValue => useContext(LegacyContext);
