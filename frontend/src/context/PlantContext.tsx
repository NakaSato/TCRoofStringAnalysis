import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { api, ApiError, GrowattLive, GrowattLivePlantLatest, GrowattPlantOverview } from "../api/client";
import { useAuth } from "./AuthContext";
import { useFleet } from "./FleetContext";
import { useLivePoll } from "./useLivePoll";
import { overviewCache } from "./plantCache";

const OVERVIEW_REFRESH_MS = 5 * 60_000; // DB history refresh (worker syncs every 10 min)

/**
 * Same names as the backend's solar_core.growatt.INVERTER_STATUS_NAMES. An inverter is Normal,
 * Waiting or Offline (plus Fault when Growatt reports code 3). Offline is not a code: it is an
 * inverter Growatt lost contact with, or one with no record today.
 */
export const INVERTER_STATUS_NAMES: Record<number, string> = { 0: "Waiting", 1: "Normal", 3: "Fault" };
export const OFFLINE_LABEL = "Offline";

/** Colour of an inverter status code: Normal ok, Waiting amber, Fault red, not reported neutral. */
export const inverterStatusLevel = (st: number | null | undefined): "ok" | "warn" | "crit" | "neutral" =>
  st === 1 ? "ok" : st === 3 ? "crit" : st == null ? "neutral" : "warn";


export interface PlantContextValue {
  /** plant in the URL (null outside `/plant/:id`) */
  selectedGrowattPlantId: number | null;
  /** DB overview with the newest live record overlaid ("current" fields only) */
  selectedPlantOverview: GrowattPlantOverview | null;
  plantOverviewLoading: boolean;
  /** last overview failure; `status` 404 = unknown plant or not assigned to this user */
  plantError: { status: number | null; message: string } | null;
  /** the selected plant's live record (inverter status) has not answered yet */
  plantLiveLoading: boolean;
  /**
   * The plant's newest live record as the backend sent it (memory only), whatever the overview's
   * day: the overlay above is applied only when both are the same day, so a page that shows
   * "now" next to an older stored day reads it from here.
   */
  plantLive: GrowattLive<GrowattLivePlantLatest> | null;
  /** the last live request failed (DB values remain) */
  plantLiveFailed: boolean;
  /** re-read the overview now */
  reloadPlant: () => Promise<void>;
}

const PlantContext = createContext<PlantContextValue>({
  selectedGrowattPlantId: null,
  selectedPlantOverview: null,
  plantOverviewLoading: false,
  plantError: null,
  plantLiveLoading: false,
  plantLive: null,
  plantLiveFailed: false,
  reloadPlant: async () => undefined,
});

/**
 * One plant's DB overview (refreshed every 5 min while visible) and, on pages that show live
 * values (`live`), its newest inverter records. `plantId` comes from the URL via `routeData`.
 */
export const PlantProvider: React.FC<{ plantId: number | null; live: boolean; children: React.ReactNode }> = ({
  plantId,
  live,
  children,
}) => {
  const { user } = useAuth();
  const userId = user?.id ?? null; // /auth/me replaces the user object: key effects on the id
  const { livePlant } = useFleet();
  const [dbOverview, setDbOverview] = useState<GrowattPlantOverview | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<PlantContextValue["plantError"]>(null);
  const [liveRec, setLiveRec] = useState<GrowattLive<GrowattLivePlantLatest> | null>(null);
  const [liveFailed, setLiveFailed] = useState(false);

  const fetchOverview = useCallback(async (id: number) => {
    const ov = await api.getGrowattPlantOverview(id);
    overviewCache.set(id, { ov, at: Date.now() });
    return ov;
  }, []);

  useEffect(() => {
    setLiveRec(null);
    setLiveFailed(false);
    if (plantId == null || userId == null) {
      setDbOverview(null);
      setError(null);
      setLoading(false);
      return;
    }
    let cancelled = false;
    const cached = overviewCache.get(plantId);
    setDbOverview(cached?.ov ?? null);
    setError(null);

    const load = () => {
      setLoading(true);
      fetchOverview(plantId)
        .then((ov) => {
          if (cancelled) return;
          setDbOverview(ov);
          setError(null);
        })
        .catch((err) => {
          if (cancelled) return;
          setError({
            status: err instanceof ApiError ? err.status : null,
            message: err instanceof Error ? err.message : String(err),
          });
        })
        .finally(() => !cancelled && setLoading(false));
    };

    if (!cached || Date.now() - cached.at > OVERVIEW_REFRESH_MS) load();
    // Persisted history: re-read so today's curve / yield grow as the worker syncs.
    const id = window.setInterval(() => {
      if (!document.hidden) load();
    }, OVERVIEW_REFRESH_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [plantId, userId, fetchOverview]);

  // Realtime: newest record per inverter, polled when the backend says a newer record can
  // exist, while visible, and only on pages that show live values.
  useLivePoll(
    // not for a plant the backend does not know (or this user may not see)
    userId != null && plantId != null && live && error?.status !== 404,
    `${userId}:${plantId}`,
    () => api.getGrowattLivePlantLatest(plantId!),
    (r) => {
      setLiveRec(r);
      setLiveFailed(false);
    },
    // live unavailable: DB values remain, status keeps showing "Loading…" until a retry succeeds
    () => setLiveFailed(true)
  );

  const reloadPlant = useCallback(async () => {
    if (plantId == null) return;
    setLoading(true);
    try {
      setDbOverview(await fetchOverview(plantId));
      setError(null);
    } finally {
      setLoading(false);
    }
  }, [plantId, fetchOverview]);

  // Overlay the newest record per inverter (power, MPPT, string V/I) on the DB overview.
  // Only "current" fields change; daily aggregates stay from the DB.
  const fleetLive = plantId != null ? livePlant(plantId) : undefined;
  const selectedPlantOverview = useMemo<GrowattPlantOverview | null>(() => {
    const ov = dbOverview;
    if (!ov || ov.plant.plant_id !== plantId) return null; // never show another plant's data
    // plant status is realtime only: from the fleet poll
    const liveStatus = fleetLive?.status ?? ov.plant.status;
    const lv = liveRec?.data;
    if (!lv || lv.plant_id !== ov.plant.plant_id || (ov.meta.day && ov.meta.day !== lv.day)) {
      return liveStatus === ov.plant.status ? ov : { ...ov, plant: { ...ov.plant, status: liveStatus } };
    }
    const byInv = new Map(lv.inverters.map((i) => [i.device_sn, i]));
    const byStr = new Map<string, { voltage_v: number; current_a: number; power_w: number; at: string }>();
    for (const inv of lv.inverters) {
      for (const s of inv.strings) byStr.set(`${inv.device_sn}#${s.string_no}`, { ...s, at: inv.timestamp });
    }
    const check = lv.string_check;
    const liveW = lv.inverters.reduce((a, i) => a + (i.pac_w ?? 0), 0);
    const hasLive = lv.inverters.length > 0;
    const dcReported = lv.inverters.filter((i) => i.ppv_w != null);
    const liveDcKw = dcReported.length ? Math.round(dcReported.reduce((a, i) => a + (i.ppv_w ?? 0), 0) / 10) / 100 : null;
    const liveDataAt = lv.inverters.reduce<string | null>(
      (a, i) => (i.timestamp && (a == null || i.timestamp > a) ? i.timestamp : a),
      null
    );
    // online count from the newest record of each inverter
    const online = hasLive ? lv.inverters.filter((i) => i.status === 1).length : ov.kpis.online_inverters;
    return {
      ...ov,
      live: {
        fetched_at: liveRec!.fetched_at,
        stale: liveRec!.stale,
        data_at: liveDataAt,
        dc_kw: liveDcKw,
        strings: check?.summary ?? null,
      },
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
        if (!l) return s;
        const v = check?.inverters[s.device_sn]?.strings[String(s.string_no)];
        return {
          ...s,
          live_voltage_v: l.voltage_v,
          live_current_a: l.current_a,
          live_power_w: l.power_w,
          live_at: l.at,
          live_status: v?.status ?? null,
          live_reason: v?.reason ?? null,
        };
      }),
    };
  }, [dbOverview, liveRec, fleetLive, plantId]);

  const value = useMemo<PlantContextValue>(
    () => ({
      selectedGrowattPlantId: plantId,
      selectedPlantOverview,
      plantOverviewLoading: loading,
      plantError: error,
      plantLiveLoading: plantId != null && live && !liveRec && !liveFailed,
      plantLive: liveRec && liveRec.data?.plant_id === plantId ? liveRec : null,
      plantLiveFailed: liveFailed,
      reloadPlant,
    }),
    [plantId, selectedPlantOverview, loading, error, live, liveRec, liveFailed, reloadPlant]
  );

  return <PlantContext.Provider value={value}>{children}</PlantContext.Provider>;
};

export const usePlant = (): PlantContextValue => useContext(PlantContext);
