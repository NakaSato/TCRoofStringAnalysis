import React, { createContext, useCallback, useContext, useEffect, useMemo } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import type { AnalysisRun, Plant } from "../api/client";
import { isAdmin } from "../auth/access";
import { AuthProvider, useAuth } from "./AuthContext";
import type { AuthContextValue } from "./AuthContext";
import { FleetProvider, useFleet } from "./FleetContext";
import type { FleetContextValue } from "./FleetContext";
import { PlantProvider, usePlant } from "./PlantContext";
import type { PlantContextValue } from "./PlantContext";
import { LegacyProvider, useLegacy } from "./LegacyContext";
import type { LegacyContextValue } from "./LegacyContext";
import { getLastPlantId, parsePlantPath, plantPath, routeData, setLastPlantId } from "./routes";
import type { PlantPage } from "./routes";

/**
 * App state is split by what loads it:
 * - `AuthProvider` (every route): the user. Loads no data.
 * - `DataScope` (inside the router): reads the URL and tells each data provider whether the
 *   current route needs it (`routeData`): `FleetProvider` (plant list, live fleet poll),
 *   `PlantProvider` (the `/plant/:id` overview + live inverter records), `LegacyProvider`
 *   (old analysis tables, admin). A provider not needed by the route fetches and polls nothing.
 * `useAppContext()` merges them for components; a value whose provider is idle is empty / null.
 */
export const AppProvider = AuthProvider;

interface ScopeValue {
  /** legacy analysis plant, with the Growatt plant's name / location / PR target when one is open */
  activePlant: Plant | null;
  /** string summary, anomalies and KPIs of the open plant in the legacy analysis shape */
  analysisRun: AnalysisRun | null;
  /** open a plant, keeping the current plant page (Inverters stays Inverters) */
  selectGrowattPlant: (plantId: number) => void;
  /** re-read whatever the current route shows */
  refreshAll: () => Promise<void>;
  loading: boolean;
  error: string | null;
}

const ScopeContext = createContext<ScopeValue>({
  activePlant: null,
  analysisRun: null,
  selectGrowattPlant: () => undefined,
  refreshAll: async () => undefined,
  loading: false,
  error: null,
});

const ScopeBridge: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const navigate = useNavigate();
  const location = useLocation();
  const { refreshGrowattPlants, plantListLoaded } = useFleet();
  const { selectedPlantOverview: ov, selectedGrowattPlantId, reloadPlant, plantOverviewLoading } = usePlant();
  const { legacyPlant, legacyRun, legacyLoading, legacyError, reloadLegacy } = useLegacy();

  const activePlant = useMemo<Plant | null>(() => {
    if (!ov || !legacyPlant) return legacyPlant;
    return {
      ...legacyPlant,
      name: ov.plant.name,
      location: [ov.plant.city, ov.plant.country].filter(Boolean).join(", ") || "Thailand",
      target_pr_pct: ov.kpis.target_pr_pct,
      tariff_thb_per_kwh: ov.kpis.tariff_thb_per_kwh,
    };
  }, [ov, legacyPlant]);

  // The open plant's strings / anomalies / KPIs in the legacy shape used by the string inspector,
  // alarm centre and command palette. Without a legacy run (engineers, or the legacy tables not
  // loaded on this route) `id` is 0: actions on the legacy run (CM work orders) are unavailable.
  const analysisRun = useMemo<AnalysisRun | null>(() => {
    if (!ov) return legacyRun;
    const k = ov.kpis;
    const base: AnalysisRun = legacyRun ?? {
      id: 0,
      plant_id: 0,
      dataset_id: 0,
      target_pr_pct: k.target_pr_pct,
      tariff_thb_per_kwh: k.tariff_thb_per_kwh,
      plant_kpis_json: {},
      string_summary_json: [],
      daily_string_json: [],
      anomalies_json: [],
      daily_plant_json: [],
      monthly_plant_json: [],
      waterfall_json: [],
      opportunities_json: [],
      created_at: ov.meta.synced_at ?? "",
    };
    return {
      ...base,
      target_pr_pct: k.target_pr_pct,
      tariff_thb_per_kwh: k.tariff_thb_per_kwh,
      plant_kpis_json: {
        ...base.plant_kpis_json,
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
        current_power_kw: ov.plant.current_power_w != null ? ov.plant.current_power_w / 1000 : k.current_power_kw,
        conversion_efficiency_pct: k.conversion_efficiency_pct,
        avg_temp_c: k.avg_temp_c,
        max_temp_c: k.max_temp_c,
        avg_freq_hz: k.avg_freq_hz,
      },
      string_summary_json: ov.strings,
      anomalies_json: ov.anomalies,
    };
  }, [ov, legacyRun]);

  const selectGrowattPlant = useCallback(
    (plantId: number) => {
      const page = parsePlantPath(location.pathname)?.page ?? "";
      navigate(plantPath(plantId, page));
      window.scrollTo({ top: 0, behavior: "smooth" });
    },
    [location.pathname, navigate]
  );

  const refreshAll = useCallback(async () => {
    await Promise.all([
      selectedGrowattPlantId != null ? reloadPlant().catch(() => undefined) : null,
      legacyPlant ? reloadLegacy(legacyPlant.id) : null,
      plantListLoaded ? refreshGrowattPlants(false).catch(() => undefined) : null,
    ]);
  }, [selectedGrowattPlantId, reloadPlant, legacyPlant, reloadLegacy, plantListLoaded, refreshGrowattPlants]);

  const value = useMemo<ScopeValue>(
    () => ({
      activePlant,
      analysisRun,
      selectGrowattPlant,
      refreshAll,
      loading: legacyLoading || plantOverviewLoading,
      error: legacyError,
    }),
    [activePlant, analysisRun, selectGrowattPlant, refreshAll, legacyLoading, plantOverviewLoading, legacyError]
  );
  return <ScopeContext.Provider value={value}>{children}</ScopeContext.Provider>;
};

/** Mounts every data provider once and switches each on or off from the current URL. */
export const DataScope: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { user } = useAuth();
  const { pathname } = useLocation();
  const scope = routeData(pathname, isAdmin(user));

  useEffect(() => {
    if (scope.plantId != null) setLastPlantId(scope.plantId);
  }, [scope.plantId]);

  return (
    <FleetProvider listWanted={scope.fleetList} liveWanted={scope.fleetLive}>
      <PlantProvider plantId={scope.plantId} live={scope.plantLive}>
        <LegacyProvider enabled={scope.legacy}>
          <ScopeBridge>{children}</ScopeBridge>
        </LegacyProvider>
      </PlantProvider>
    </FleetProvider>
  );
};

export type AppContextValue = AuthContextValue &
  FleetContextValue &
  PlantContextValue &
  Omit<LegacyContextValue, "legacyPlant" | "legacyRun" | "legacyLoading" | "legacyError"> &
  ScopeValue;

/** Everything components read, merged from the providers above. */
export const useAppContext = (): AppContextValue => {
  const auth = useAuth();
  const fleet = useFleet();
  const plant = usePlant();
  const { legacyPlant: _p, legacyRun: _r, legacyLoading: _l, legacyError: _e, ...legacy } = useLegacy();
  const scope = useContext(ScopeContext);
  return { ...auth, ...fleet, ...plant, ...legacy, ...scope };
};

/** Link to a page of the open plant (else the last plant opened; none → the plant directory). */
export const usePlantHref = (): ((page?: PlantPage) => string) => {
  const { selectedGrowattPlantId } = usePlant();
  return useCallback(
    (page: PlantPage = "") => {
      const id = selectedGrowattPlantId ?? getLastPlantId();
      return id != null ? plantPath(id, page) : "/";
    },
    [selectedGrowattPlantId]
  );
};
