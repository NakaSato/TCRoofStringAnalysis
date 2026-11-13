/**
 * State and derived data of the plant directory (fleet home page): the rows built from the
 * Growatt plant list, fleet totals and alarm counts for the hero banner, filters, sort and paging.
 */
import { useMemo, useState } from "react";
import { useAppContext } from "../../context/AppContext";
import { plantToday, useAlarmLog } from "../../context/alarmLogStore";
import { LOADING_STATUS } from "../ui";
import type { StatusLevel } from "../ui";
import type { UnifiedPlantItem } from "./types";

export const useFleetDirectory = () => {
  const {
    activePlant,
    activeDataset,
    analysisRun,
    setInspectedStringId,
    growattPlants,
    selectedGrowattPlantId,
    selectGrowattPlant,
    refreshGrowattPlants,
    growattLiveStatus,
  } = useAppContext();
  const alarmLog = useAlarmLog(plantToday()).view?.result ?? null;
  const [loadingCloud, setLoadingCloud] = useState(false);
  const [cloudNotice, setCloudNotice] = useState<string | null>(null);

  // FusionSolar Filter bar state
  const [plantNameFilter, setPlantNameFilter] = useState("");
  const [regionFilter, setRegionFilter] = useState("");
  const [deviceTypeFilter, setDeviceTypeFilter] = useState("ALL");
  const [phaseFilter, setPhaseFilter] = useState<"ALL" | "NONE" | number>("ALL");
  const [deviceSnFilter, setDeviceSnFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState<"ALL" | "Normal" | "Faulty" | "Disconnected">("ALL");
  const [expandedFilters, setExpandedFilters] = useState(false);

  // Applied filters (updated when clicking Search, or live on input)
  const [sortField, setSortField] = useState<
    "name" | "location" | "createdDate" | "capacityKwp" | "stringsCount" | "currentPowerKw" | "specificEnergyKwhPerKwp" | "yieldTodayKwh" | "totalEnergyKwh"
  >("capacityKwp");
  const [sortAsc, setSortAsc] = useState(false);
  const [pageSize, setPageSize] = useState(10);
  const [currentPage, setCurrentPage] = useState(1);
  const [selectedUid, setSelectedUid] = useState<string>("local-1");
  const [showInspectorDrawer, setShowInspectorDrawer] = useState<boolean>(true);

  const fetchCloudPlants = async (refresh = false) => {
    setLoadingCloud(true);
    setCloudNotice(null);
    try {
      await refreshGrowattPlants(refresh);
    } catch (e) {
      setCloudNotice(e instanceof Error ? e.message : String(e));
    } finally {
      setLoadingCloud(false);
    }
  };

  // Build unified plant directory from Growatt plants
  const unifiedPlants = useMemo<UnifiedPlantItem[]>(() => {
    const items: UnifiedPlantItem[] = [];

    for (const gp of growattPlants) {
      // status / power are realtime (live overlay only); null means live data is unavailable
      const isUnknown = gp.status == null;
      const isNormal = gp.status === 1;
      const isDisconnected = gp.status === 0 || gp.status === 4;
      const capKwp = gp.peak_power_kwp ?? null;
      const totalKwh = gp.total_energy_kwh ?? null;
      const curKw = gp.current_power_w == null ? null : gp.current_power_w / 1000;
      // Measured energy of the latest synced day only — null (shown "—") when it is missing.
      const dayKwh = gp.today_energy_kwh ?? null;
      const invCnt = gp.inverter_count ?? null;

      items.push({
        uid: `growatt-${gp.plant_id}`,
        source: "growatt",
        id: gp.plant_id,
        phase: gp.phase ?? null,
        name: gp.name || `Growatt Plant #${gp.plant_id}`,
        location: [gp.city, gp.country].filter(Boolean).join(", ") || "Thailand",
        capacityKwp: capKwp,
        currentPowerKw: curKw,
        yieldTodayKwh: dayKwh,
        totalEnergyKwh: totalKwh,
        specificEnergyKwhPerKwp: capKwp && dayKwh != null ? dayKwh / capKwp : null,
        prPct: null,
        statusLabel: isUnknown ? LOADING_STATUS : isNormal ? "Normal" : isDisconnected ? "Disconnected" : "Faulty",
        statusLevel: isUnknown ? "neutral" : isNormal ? "ok" : isDisconnected ? "info" : "crit",
        stringsCount: invCnt,
        modulesCount: null,
        invertersCount: invCnt,
        // the plant list carries no inverter serials: the ID filter matches the Growatt plant id
        deviceSnList: [String(gp.plant_id)],
        deviceType: "Growatt MAX Inverter",
        batteryStatus: "--",
        createdDate: gp.create_date || null,
      });
    }

    return items;
  }, [activePlant, activeDataset, analysisRun, growattPlants, growattLiveStatus.loading]);

  // Compute Fleet KPIs, Plant Status breakdown, and Active Alarms breakdown for the 3-column Hero Banner
  const heroMetrics = useMemo(() => {
    // Sum only known values; null (shown as "—") when no plant has one.
    const sumKnown = (vals: Array<number | null>) => {
      const known = vals.filter((v): v is number => v != null);
      return known.length ? known.reduce((a, v) => a + v, 0) : null;
    };
    const currentPowerKw = sumKnown(unifiedPlants.map((p) => p.currentPowerKw));
    const yieldTodayKwh = sumKnown(unifiedPlants.map((p) => p.yieldTodayKwh));
    const totalYieldKwh = sumKnown(unifiedPlants.map((p) => p.totalEnergyKwh));
    const ratedPowerKwp = unifiedPlants.reduce((a, p) => a + (p.capacityKwp ?? 0), 0);
    const tariff = activePlant?.tariff_thb_per_kwh ?? analysisRun?.tariff_thb_per_kwh ?? 4.2;
    const revenueTodayThb = yieldTodayKwh == null ? null : yieldTodayKwh * tariff;

    const normalPlants = unifiedPlants.filter((p) => p.statusLabel === "Normal").length;
    const faultyPlants = unifiedPlants.filter((p) => p.statusLabel === "Faulty").length;
    const disconnectedPlants = unifiedPlants.filter((p) => p.statusLabel === "Disconnected").length;

    // Today's Growatt alarm log of every visible plant (the Active Alarm page's data, DB only).
    // Null until it has answered, or when the worker has not read any plant's log today:
    // shown as "—", never as zero alarms.
    const rows = alarmLog && alarmLog.syncedAt != null ? alarmLog.rows : null;
    const countLevel = (lvl: StatusLevel) => (rows ? rows.filter((r) => r.level === lvl).length : null);
    const faultCount = countLevel("crit");
    const warningCount = countLevel("warn");
    const otherCount = rows ? rows.length - (faultCount ?? 0) - (warningCount ?? 0) : null;
    const openCount = rows ? rows.filter((r) => r.open).length : null;
    const totalAlarms = rows ? rows.length : null;

    return {
      currentPowerKw,
      yieldTodayKwh,
      revenueTodayThb,
      ratedPowerKwp,
      totalYieldKwh,
      totalPlants: unifiedPlants.length,
      normalPlants,
      faultyPlants,
      disconnectedPlants,
      faultCount,
      warningCount,
      otherCount,
      openCount,
      totalAlarms,
    };
  }, [unifiedPlants, activePlant, analysisRun, alarmLog]);

  // Filter & Sort plants for the table
  const filteredPlants = useMemo(() => {
    const nameQ = plantNameFilter.trim().toLowerCase();
    const regionQ = regionFilter.trim().toLowerCase();
    const snQ = deviceSnFilter.trim().toLowerCase();

    const list = unifiedPlants.filter((p) => {
      if (nameQ && !p.name.toLowerCase().includes(nameQ) && !String(p.id).includes(nameQ)) {
        return false;
      }
      if (regionQ && !p.location.toLowerCase().includes(regionQ)) {
        return false;
      }
      if (deviceTypeFilter !== "ALL" && p.deviceType !== deviceTypeFilter) {
        return false;
      }
      if (phaseFilter === "NONE" ? p.phase != null : phaseFilter !== "ALL" && p.phase !== phaseFilter) {
        return false;
      }
      if (snQ && !p.deviceSnList.some((sn) => sn.toLowerCase().includes(snQ))) {
        return false;
      }
      if (statusFilter !== "ALL" && p.statusLabel !== statusFilter) {
        return false;
      }
      return true;
    });

    return [...list].sort((a, b) => {
      // missing values sort last in either direction
      if (a[sortField] == null || b[sortField] == null) return (a[sortField] == null ? 1 : 0) - (b[sortField] == null ? 1 : 0);
      const av = a[sortField];
      const bv = b[sortField];
      if (typeof av === "number" && typeof bv === "number") {
        return sortAsc ? av - bv : bv - av;
      }
      return sortAsc
        ? String(av).localeCompare(String(bv))
        : String(bv).localeCompare(String(av));
    });
  }, [unifiedPlants, plantNameFilter, regionFilter, deviceTypeFilter, phaseFilter, deviceSnFilter, statusFilter, sortField, sortAsc]);

  // Phases present in the registry (one Growatt account each), with plant counts
  const phaseOptions = useMemo(() => {
    const counts = new Map<number, number>();
    let untagged = 0;
    for (const p of unifiedPlants) {
      if (p.phase == null) untagged += 1;
      else counts.set(p.phase, (counts.get(p.phase) ?? 0) + 1);
    }
    return { phases: [...counts.entries()].sort((a, b) => a[0] - b[0]), untagged };
  }, [unifiedPlants]);

  const handleSort = (
    field:
      | "name"
      | "location"
      | "createdDate"
      | "capacityKwp"
      | "stringsCount"
      | "currentPowerKw"
      | "specificEnergyKwhPerKwp"
      | "yieldTodayKwh"
      | "totalEnergyKwh"
  ) => {
    if (sortField === field) {
      setSortAsc(!sortAsc);
    } else {
      setSortField(field);
      setSortAsc(false);
    }
  };

  const handleResetFilters = () => {
    setPlantNameFilter("");
    setRegionFilter("");
    setDeviceTypeFilter("ALL");
    setPhaseFilter("ALL");
    setDeviceSnFilter("");
    setStatusFilter("ALL");
    setCurrentPage(1);
  };

  const totalPages = Math.max(1, Math.ceil(filteredPlants.length / pageSize));
  const safePage = Math.min(currentPage, totalPages);
  const pagedPlants = filteredPlants.slice((safePage - 1) * pageSize, safePage * pageSize);

  const selectedPlant =
    unifiedPlants.find((p) => p.uid === selectedUid) || unifiedPlants[0] || null;

  const strings = analysisRun?.string_summary_json || [];

  return {
    activePlant,
    activeDataset,
    analysisRun,
    setInspectedStringId,
    growattPlants,
    selectedGrowattPlantId,
    selectGrowattPlant,
    refreshGrowattPlants,
    growattLiveStatus,
    alarmLog,
    loadingCloud,
    setLoadingCloud,
    cloudNotice,
    setCloudNotice,
    plantNameFilter,
    setPlantNameFilter,
    regionFilter,
    setRegionFilter,
    deviceTypeFilter,
    setDeviceTypeFilter,
    phaseFilter,
    setPhaseFilter,
    deviceSnFilter,
    setDeviceSnFilter,
    statusFilter,
    setStatusFilter,
    expandedFilters,
    setExpandedFilters,
    sortField,
    setSortField,
    sortAsc,
    setSortAsc,
    pageSize,
    setPageSize,
    currentPage,
    setCurrentPage,
    selectedUid,
    setSelectedUid,
    showInspectorDrawer,
    setShowInspectorDrawer,
    fetchCloudPlants,
    unifiedPlants,
    heroMetrics,
    filteredPlants,
    phaseOptions,
    handleSort,
    handleResetFilters,
    totalPages,
    safePage,
    pagedPlants,
    selectedPlant,
    strings,
  };
};

export type FleetDirectory = ReturnType<typeof useFleetDirectory>;
