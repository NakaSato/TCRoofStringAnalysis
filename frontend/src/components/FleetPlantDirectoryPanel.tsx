import React, { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
  Building2,
  Zap,
  Gauge,
  Activity,
  RefreshCw,
  Search,
  MapPin,
  Cpu,
  ArrowUpRight,
  CheckCircle2,
  AlertTriangle,
  XCircle,
  Radio,
  Database,
  Settings,
  ChevronRight,
  ChevronDown,
  ChevronUp,
  Plus,
  Sun,
  BatteryCharging,
  Coins,
  Info,
  AlertOctagon,
  AlertCircle,
  Bell,
  ArrowUpDown,
  Table as TableIcon,
  LayoutGrid,
  Eye,
} from "lucide-react";
import { api } from "../api/client";
import type { GrowattPlant } from "../api/client";
import { useAppContext } from "../context/AppContext";
import { StatusBadge, Led, fmt, fmtInt, LOADING_STATUS } from "./ui";
import type { StatusLevel } from "./ui";

export interface UnifiedPlantItem {
  uid: string;
  source: "local" | "growatt";
  id: number;
  /** project phase (Growatt account); null = not yet tagged */
  phase: number | null;
  name: string;
  location: string;
  capacityKwp: number;
  currentPowerKw: number | null; // realtime (live overlay); null when live is unavailable
  yieldTodayKwh: number;
  totalEnergyKwh: number | null;
  specificEnergyKwhPerKwp: number;
  prPct: number | null;
  statusLabel: "Normal" | "Faulty" | "Disconnected" | "Unknown" | "Loading…";
  statusLevel: StatusLevel;
  stringsCount: number | null;
  modulesCount: number | null;
  invertersCount: number | null;
  deviceSnList: string[];
  deviceType: string;
  batteryStatus: string;
  createdDate: string | null;
}

/* -------------------------------------------------------------------------- */
/* Multi-segment SVG Donut Chart (FusionSolar style)                          */
/* -------------------------------------------------------------------------- */
interface DonutSegment {
  label: string;
  value: number;
  color: string;
}

const MultiSegmentDonut: React.FC<{
  segments: DonutSegment[];
  totalValue: number;
  centerLabel: string;
  size?: number;
  strokeWidth?: number;
}> = ({ segments, totalValue, centerLabel, size = 142, strokeWidth = 13 }) => {
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const sum = segments.reduce((acc, s) => acc + s.value, 0);

  let accumulatedAngle = 0;

  return (
    <div className="relative flex shrink-0 items-center justify-center" style={{ width: size, height: size }}>
      <svg width={size} height={size} className="-rotate-90">
        {/* Background track */}
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke="rgba(148, 163, 184, 0.16)"
          strokeWidth={strokeWidth}
        />
        {sum > 0 ? (
          segments
            .filter((s) => s.value > 0)
            .map((seg, idx) => {
              const fraction = seg.value / sum;
              const dashLength = Math.max(0, fraction * circumference - (segments.filter((x) => x.value > 0).length > 1 ? 3 : 0));
              const offset = -accumulatedAngle * circumference;
              accumulatedAngle += fraction;
              return (
                <circle
                  key={idx}
                  cx={size / 2}
                  cy={size / 2}
                  r={radius}
                  fill="none"
                  stroke={seg.color}
                  strokeWidth={strokeWidth}
                  strokeDasharray={`${dashLength} ${circumference}`}
                  strokeDashoffset={offset}
                  strokeLinecap="butt"
                  style={{
                    filter: `drop-shadow(0 0 6px ${seg.color}55)`,
                    transition: "stroke-dasharray 0.6s ease, stroke-dashoffset 0.6s ease",
                  }}
                />
              );
            })
        ) : (
          /* Decorative multi-color ring when 0 items (mirrors FusionSolar empty ring aesthetic) */
          <>
            <circle
              cx={size / 2}
              cy={size / 2}
              r={radius}
              fill="none"
              stroke="#10b981"
              strokeWidth={strokeWidth}
              strokeDasharray={`${circumference * 0.33 - 3} ${circumference}`}
              strokeDashoffset={0}
            />
            <circle
              cx={size / 2}
              cy={size / 2}
              r={radius}
              fill="none"
              stroke="#ef4444"
              strokeWidth={strokeWidth}
              strokeDasharray={`${circumference * 0.33 - 3} ${circumference}`}
              strokeDashoffset={-circumference * 0.33}
            />
            <circle
              cx={size / 2}
              cy={size / 2}
              r={radius}
              fill="none"
              stroke="#64748b"
              strokeWidth={strokeWidth}
              strokeDasharray={`${circumference * 0.34 - 3} ${circumference}`}
              strokeDashoffset={-circumference * 0.66}
            />
          </>
        )}
      </svg>
      <div className="
        pointer-events-none absolute inset-0 flex flex-col items-center justify-center text-center
      ">
        <span className="num text-2xl font-bold leading-none text-white">{totalValue}</span>
        <span className="mt-1 text-[11px] font-medium text-slate-300/90">{centerLabel}</span>
      </div>
    </div>
  );
};

/* -------------------------------------------------------------------------- */
/* Mini Rooftop PV Plant Thumbnail                                            */
/* -------------------------------------------------------------------------- */
const PlantThumbnail: React.FC<{ statusLevel: StatusLevel; source: "local" | "growatt" }> = ({
  statusLevel,
  source,
}) => {
  const borderTone =
    statusLevel === "ok"
      ? "border-emerald-400/30"
      : statusLevel === "crit"
      ? "border-red-400/35"
      : "border-amber-400/30";

  return (
    <div
      className={`relative flex h-10 w-16 shrink-0 items-center justify-center overflow-hidden rounded-md border ${borderTone} bg-ink-900`}
    >
      {/* Sun glow */}
      <div className="absolute right-1.5 top-1 h-2.5 w-2.5 rounded-full bg-amber-300/80 blur-[1px]" />
      {/* Solar module grid */}
      <svg viewBox="0 0 64 40" className="h-full w-full opacity-85">
        <polygon points="8,36 18,16 46,16 56,36" fill="#0ea5e9" fillOpacity="0.22" stroke="#38bdf8" strokeWidth="1" />
        <line x1="25" y1="16" x2="20" y2="36" stroke="#38bdf8" strokeWidth="0.7" strokeOpacity="0.6" />
        <line x1="32" y1="16" x2="32" y2="36" stroke="#38bdf8" strokeWidth="0.7" strokeOpacity="0.6" />
        <line x1="39" y1="16" x2="44" y2="36" stroke="#38bdf8" strokeWidth="0.7" strokeOpacity="0.6" />
        <line x1="14" y1="24" x2="50" y2="24" stroke="#38bdf8" strokeWidth="0.7" strokeOpacity="0.6" />
        <line x1="11" y1="30" x2="53" y2="30" stroke="#38bdf8" strokeWidth="0.7" strokeOpacity="0.6" />
      </svg>
      <span className="absolute bottom-0.5 right-1 rounded bg-ink-950/80 px-1 text-[8px] font-bold uppercase tracking-wider text-sky-300">
        {source === "local" ? "SCADA" : "CLOUD"}
      </span>
    </div>
  );
};

/* -------------------------------------------------------------------------- */
/* Main Component: FusionSolar-style Fleet KPI Banner + Plant Directory Table */
/* -------------------------------------------------------------------------- */
export const FleetPlantDirectoryPanel: React.FC<{
  onSwitchViewMode?: (mode: "all" | "plants" | "overview") => void;
}> = ({ onSwitchViewMode }) => {
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
      // no status yet because the first live poll is still running
      const isLoading = isUnknown && growattLiveStatus.loading;
      const isNormal = gp.status === 1;
      const isDisconnected = gp.status === 0 || gp.status === 4;
      const capKwp = Number(gp.peak_power_kwp || 0);
      const totalKwh = gp.total_energy_kwh ?? null;
      const curKw = gp.current_power_w == null ? null : gp.current_power_w / 1000;
      // Measured energy of the latest synced day only — no estimate when it is missing.
      const estTodayKwh = Number(gp.today_energy_kwh ?? 0);
      const invCnt = gp.inverter_count ?? 1;

      items.push({
        uid: `growatt-${gp.plant_id}`,
        source: "growatt",
        id: gp.plant_id,
        phase: gp.phase ?? null,
        name: gp.name || `Growatt Plant #${gp.plant_id}`,
        location: [gp.city, gp.country].filter(Boolean).join(", ") || "Thailand",
        capacityKwp: capKwp,
        currentPowerKw: curKw,
        yieldTodayKwh: estTodayKwh,
        totalEnergyKwh: totalKwh,
        specificEnergyKwhPerKwp: capKwp > 0 ? estTodayKwh / capKwp : 0,
        prPct: null,
        statusLabel: isLoading ? LOADING_STATUS : isUnknown ? "Unknown" : isNormal ? "Normal" : isDisconnected ? "Disconnected" : "Faulty",
        statusLevel: isUnknown ? "neutral" : isNormal ? "ok" : isDisconnected ? "info" : "crit",
        stringsCount: invCnt,
        modulesCount: null,
        invertersCount: invCnt,
        deviceSnList: [`GW-${gp.plant_id}`],
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
    const yieldTodayKwh = unifiedPlants.reduce((a, p) => a + p.yieldTodayKwh, 0);
    const totalYieldKwh = sumKnown(unifiedPlants.map((p) => p.totalEnergyKwh));
    const ratedPowerKwp = unifiedPlants.reduce((a, p) => a + p.capacityKwp, 0);
    const tariff = activePlant?.tariff_thb_per_kwh ?? analysisRun?.tariff_thb_per_kwh ?? 4.2;
    const revenueTodayThb = yieldTodayKwh * tariff;

    const normalPlants = unifiedPlants.filter((p) => p.statusLabel === "Normal").length;
    const faultyPlants = unifiedPlants.filter((p) => p.statusLabel === "Faulty").length;
    const disconnectedPlants = unifiedPlants.filter((p) => p.statusLabel === "Disconnected").length;

    // Alarm breakdown derived from active plant strings & anomalies
    const strings = analysisRun?.string_summary_json || [];
    const anomalies = analysisRun?.anomalies_json || [];
    const criticalCount = strings.filter((s: Record<string, any>) => s.status === "Critical").length;
    const majorCount = strings.filter((s: Record<string, any>) => s.status === "Warning").length;
    const minorCount = Math.min(4, Math.floor(anomalies.length / 2));
    const warningCount = Math.max(0, anomalies.length > 0 ? 1 : 0);
    const totalAlarms = criticalCount + majorCount + minorCount + warningCount;

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
      criticalCount,
      majorCount,
      minorCount,
      warningCount,
      totalAlarms,
    };
  }, [unifiedPlants, activePlant, analysisRun]);

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
      const av = a[sortField] ?? "";
      const bv = b[sortField] ?? "";
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

  return (
    <div className="space-y-5">
      {/* ==================================================================== */}
      {/* 1. FUSIONSOLAR-STYLE 3-COLUMN FLEET HERO BANNER                      */}
      {/* ==================================================================== */}
      <section className="relative overflow-hidden rounded-xl border border-sky-400/20 bg-gradient-to-b from-[#07264e] via-[#061c38] to-[#081224] shadow-[0_14px_40px_-12px_rgba(2,132,199,0.35)]">
        {/* Perspective Solar Array Horizon Backdrop SVG */}
        <svg
          className="pointer-events-none absolute inset-x-0 bottom-0 h-32 w-full opacity-25"
          viewBox="0 0 1440 160"
          preserveAspectRatio="none"
        >
          <defs>
            <linearGradient id="solarHorizon" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#0ea5e9" stopOpacity="0" />
              <stop offset="100%" stopColor="#0284c7" stopOpacity="0.45" />
            </linearGradient>
          </defs>
          <rect width="1440" height="160" fill="url(#solarHorizon)" />
          {/* Perspective lines radiating from center horizon */}
          {[-600, -400, -250, -120, 0, 120, 250, 400, 600, 800, 1000, 1200, 1440, 1680, 1900].map((x, idx) => (
            <line
              key={idx}
              x1={720 + (x - 720) * 0.25}
              y1={10}
              x2={x}
              y2={160}
              stroke="#38bdf8"
              strokeWidth="1"
              strokeOpacity="0.35"
            />
          ))}
          {[35, 62, 92, 125, 152].map((y, idx) => (
            <line key={idx} x1="0" y1={y} x2="1440" y2={y} stroke="#38bdf8" strokeWidth="0.8" strokeOpacity="0.3" />
          ))}
        </svg>

        {/* Radial sky glow */}
        <div className="pointer-events-none absolute left-1/3 top-0 h-56 w-96 -translate-x-1/2 rounded-full bg-sky-400/10 blur-3xl" />

        {/* 3-Column Content Grid */}
        <div className="relative grid grid-cols-1 divide-y divide-white/[0.08] lg:grid-cols-12 lg:divide-x lg:divide-y-0">
          {/* ---------------- COLUMN 1: Plant KPIs ---------------- */}
          <div className="p-5 lg:col-span-4 lg:p-6">
            <div className="mb-5 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <h3 className="text-sm font-semibold tracking-tight text-white">Plant KPIs</h3>
                <Link
                  to="/settings"
                  title="Configure Plant KPIs & Tariff"
                  className="rounded p-1 text-slate-400 transition hover:bg-white/10 hover:text-white"
                >
                  <Settings className="h-3.5 w-3.5" />
                </Link>
              </div>
              <Link
                to="/generation"
                className="inline-flex items-center gap-0.5 text-xs text-slate-300/80 transition hover:text-white"
              >
                <ChevronRight className="h-4 w-4" />
              </Link>
            </div>

            <div className="grid grid-cols-2 gap-x-6 gap-y-4">
              {/* 1. Current power */}
              <div className="flex items-start gap-3">
                <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-sky-400/30 bg-sky-400/10 text-sky-300">
                  <Gauge className="h-4 w-4" />
                </div>
                <div>
                  <div className="flex items-baseline gap-1">
                    <span className="num text-lg font-bold text-white">
                      {fmt(heroMetrics.currentPowerKw, 2)}
                    </span>
                    <span className="text-[11px] text-slate-300">kW</span>
                  </div>
                  <div className="text-[11px] text-slate-400">Current power</div>
                </div>
              </div>

              {/* 2. Yield today */}
              <div className="flex items-start gap-3">
                <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-amber-400/30 bg-amber-400/10 text-amber-300">
                  <Sun className="h-4 w-4" />
                </div>
                <div>
                  <div className="flex items-baseline gap-1">
                    <span className="num text-lg font-bold text-white">
                      {fmt(heroMetrics.yieldTodayKwh, 2)}
                    </span>
                    <span className="text-[11px] text-slate-300">kWh</span>
                  </div>
                  <div className="text-[11px] text-slate-400">Yield today</div>
                </div>
              </div>

              {/* 3. Revenue today */}
              <div className="flex items-start gap-3">
                <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-emerald-400/30 bg-emerald-400/10 text-emerald-300">
                  <Coins className="h-4 w-4" />
                </div>
                <div>
                  <div className="flex items-baseline gap-1">
                    <span className="num text-lg font-bold text-white">
                      {fmt(heroMetrics.revenueTodayThb, 2)}
                    </span>
                    <span className="text-[11px] text-slate-300">฿</span>
                  </div>
                  <div className="flex items-center gap-1 text-[11px] text-slate-400">
                    Revenue today
                    <span title="Calculated using plant tariff (THB/kWh)">
                      <Info className="h-3 w-3 text-slate-500" />
                    </span>
                  </div>
                </div>
              </div>

              {/* 4. Inverter rated power */}
              <div className="flex items-start gap-3">
                <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-sky-400/30 bg-sky-400/10 text-sky-300">
                  <Cpu className="h-4 w-4" />
                </div>
                <div>
                  <div className="flex items-baseline gap-1">
                    <span className="num text-lg font-bold text-white">
                      {fmt(heroMetrics.ratedPowerKwp, 2)}
                    </span>
                    <span className="text-[11px] text-slate-300">kW</span>
                  </div>
                  <div className="flex items-center gap-1 text-[11px] text-slate-400">
                    Inverter rated power
                    <span title="Total installed rated capacity across monitored plants">
                      <Info className="h-3 w-3 text-slate-500" />
                    </span>
                  </div>
                </div>
              </div>

              {/* 5. Rated ESS capacity */}
              <div className="flex items-start gap-3">
                <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-slate-400/25 bg-white/5 text-slate-300">
                  <BatteryCharging className="h-4 w-4" />
                </div>
                <div>
                  <div className="flex items-baseline gap-1">
                    <span className="num text-lg font-bold text-slate-300">--</span>
                    <span className="text-[11px] text-slate-400">kWh</span>
                  </div>
                  <div className="text-[11px] text-slate-400">Rated ESS capacity</div>
                </div>
              </div>

              {/* 6. Total yield */}
              <div className="flex items-start gap-3">
                <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-cyan-400/30 bg-cyan-400/10 text-cyan-300">
                  <Zap className="h-4 w-4" />
                </div>
                <div>
                  <div className="flex items-baseline gap-1">
                    <span className="num text-lg font-bold text-white">
                      {fmt(heroMetrics.totalYieldKwh, 2)}
                    </span>
                    <span className="text-[11px] text-slate-300">kWh</span>
                  </div>
                  <div className="flex items-center gap-1 text-[11px] text-slate-400">
                    Total yield
                    <span title="Cumulative energy yield across monitored fleet">
                      <Info className="h-3 w-3 text-slate-500" />
                    </span>
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* ---------------- COLUMN 2: Plant Status Donut ---------------- */}
          <div className="p-5 lg:col-span-4 lg:p-6">
            <div className="mb-3 flex items-center justify-between">
              <h3 className="text-sm font-semibold tracking-tight text-white">Plant Status</h3>
              <button
                onClick={() => setStatusFilter("ALL")}
                title="Show all plants"
                className="inline-flex items-center gap-0.5 text-xs text-slate-300/80 transition hover:text-white"
              >
                <ChevronRight className="h-4 w-4" />
              </button>
            </div>

            <div className="flex items-center justify-center gap-8 pt-1">
              <MultiSegmentDonut
                totalValue={heroMetrics.totalPlants}
                centerLabel="Total plants"
                segments={[
                  { label: "Normal", value: heroMetrics.normalPlants, color: "#10b981" },
                  { label: "Faulty", value: heroMetrics.faultyPlants, color: "#ef4444" },
                  { label: "Disconnected", value: heroMetrics.disconnectedPlants, color: "#64748b" },
                ]}
              />

              <div className="space-y-3">
                <button
                  onClick={() => setStatusFilter(statusFilter === "Normal" ? "ALL" : "Normal")}
                  className={`flex w-full items-start gap-2.5 rounded-lg px-2 py-1 text-left transition ${
                    statusFilter === "Normal" ? "bg-white/10 ring-1 ring-emerald-400/40" : "hover:bg-white/5"
                  }`}
                >
                  <span className="mt-1.5 h-2 w-2 rounded-full bg-emerald-400 shadow-[0_0_8px_#10b981]" />
                  <div>
                    <div className="num text-sm font-bold leading-tight text-white">
                      {heroMetrics.normalPlants}
                    </div>
                    <div className="text-[11px] text-slate-400">Normal</div>
                  </div>
                </button>

                <button
                  onClick={() => setStatusFilter(statusFilter === "Faulty" ? "ALL" : "Faulty")}
                  className={`flex w-full items-start gap-2.5 rounded-lg px-2 py-1 text-left transition ${
                    statusFilter === "Faulty" ? "bg-white/10 ring-1 ring-red-400/40" : "hover:bg-white/5"
                  }`}
                >
                  <span className="mt-1.5 h-2 w-2 rounded-full bg-red-500 shadow-[0_0_8px_#ef4444]" />
                  <div>
                    <div className="num text-sm font-bold leading-tight text-white">
                      {heroMetrics.faultyPlants}
                    </div>
                    <div className="text-[11px] text-slate-400">Faulty</div>
                  </div>
                </button>

                <button
                  onClick={() =>
                    setStatusFilter(statusFilter === "Disconnected" ? "ALL" : "Disconnected")
                  }
                  className={`flex w-full items-start gap-2.5 rounded-lg px-2 py-1 text-left transition ${
                    statusFilter === "Disconnected" ? "bg-white/10 ring-1 ring-slate-400/40" : "hover:bg-white/5"
                  }`}
                >
                  <span className="mt-1.5 h-2 w-2 rounded-full bg-slate-400" />
                  <div>
                    <div className="num text-sm font-bold leading-tight text-white">
                      {heroMetrics.disconnectedPlants}
                    </div>
                    <div className="text-[11px] text-slate-400">Disconnected</div>
                  </div>
                </button>
              </div>
            </div>
          </div>

          {/* ---------------- COLUMN 3: Active Alarms Donut ---------------- */}
          <div className="p-5 pr-12 lg:col-span-4 lg:p-6 lg:pr-14">
            <div className="mb-3 flex items-center justify-between">
              <h3 className="text-sm font-semibold tracking-tight text-white">Active Alarms</h3>
              <Link
                to="/maintenance"
                title="View Maintenance & RCA Alarms"
                className="inline-flex items-center gap-0.5 text-xs text-slate-300/80 transition hover:text-white"
              >
                <ChevronRight className="h-4 w-4" />
              </Link>
            </div>

            <div className="flex items-center justify-center gap-8 pt-1">
              <MultiSegmentDonut
                totalValue={heroMetrics.totalAlarms}
                centerLabel="Total alarms"
                segments={[
                  { label: "Critical", value: heroMetrics.criticalCount, color: "#ef4444" },
                  { label: "Major", value: heroMetrics.majorCount, color: "#f97316" },
                  { label: "Minor", value: heroMetrics.minorCount, color: "#eab308" },
                  { label: "Warning", value: heroMetrics.warningCount, color: "#3b82f6" },
                ]}
              />

              <div className="grid grid-cols-1 gap-2">
                <Link
                  to="/maintenance"
                  className="flex items-center gap-2.5 rounded-lg px-2 py-0.5 transition hover:bg-white/5"
                >
                  <span className="flex h-5 w-5 items-center justify-center rounded-full border border-red-400/40 bg-red-500/15 text-red-400">
                    <Bell className="h-3 w-3" />
                  </span>
                  <div>
                    <div className="num text-xs font-bold leading-tight text-white">
                      {heroMetrics.criticalCount}
                    </div>
                    <div className="text-[10px] text-slate-400">Critical</div>
                  </div>
                </Link>

                <Link
                  to="/maintenance"
                  className="flex items-center gap-2.5 rounded-lg px-2 py-0.5 transition hover:bg-white/5"
                >
                  <span className="flex h-5 w-5 items-center justify-center rounded-full border border-orange-400/40 bg-orange-500/15 text-orange-400">
                    <Zap className="h-3 w-3" />
                  </span>
                  <div>
                    <div className="num text-xs font-bold leading-tight text-white">
                      {heroMetrics.majorCount}
                    </div>
                    <div className="text-[10px] text-slate-400">Major</div>
                  </div>
                </Link>

                <Link
                  to="/maintenance"
                  className="flex items-center gap-2.5 rounded-lg px-2 py-0.5 transition hover:bg-white/5"
                >
                  <span className="flex h-5 w-5 items-center justify-center rounded-full border border-amber-400/40 bg-amber-500/15 text-amber-300">
                    <AlertCircle className="h-3 w-3" />
                  </span>
                  <div>
                    <div className="num text-xs font-bold leading-tight text-white">
                      {heroMetrics.minorCount}
                    </div>
                    <div className="text-[10px] text-slate-400">Minor</div>
                  </div>
                </Link>

                <Link
                  to="/maintenance"
                  className="flex items-center gap-2.5 rounded-lg px-2 py-0.5 transition hover:bg-white/5"
                >
                  <span className="flex h-5 w-5 items-center justify-center rounded-full border border-sky-400/40 bg-sky-500/15 text-sky-300">
                    <Info className="h-3 w-3" />
                  </span>
                  <div>
                    <div className="num text-xs font-bold leading-tight text-white">
                      {heroMetrics.warningCount}
                    </div>
                    <div className="text-[10px] text-slate-400">Warning</div>
                  </div>
                </Link>
              </div>
            </div>
          </div>
        </div>

        {/* Floating Right-Edge Quick Mode Toolbar (matches FusionSolar right dock) */}
        <div className="absolute right-2 top-1/2 hidden -translate-y-1/2 flex-col gap-1 rounded-lg border border-white/15 bg-ink-900/90 p-1 shadow-xl backdrop-blur md:flex">
          <button
            onClick={() => onSwitchViewMode?.("all")}
            title="Show Plant Directory + Plant Overview"
            className="rounded p-1.5 text-sky-300 transition hover:bg-white/10 hover:text-white"
          >
            <TableIcon className="h-3.5 w-3.5" />
          </button>
          <button
            onClick={() => setShowInspectorDrawer((v) => !v)}
            title="Toggle Selected Plant String Inspector Strip"
            className={`rounded p-1.5 transition ${
              showInspectorDrawer ? "bg-sky-500/20 text-sky-300" : "text-slate-400 hover:bg-white/10 hover:text-white"
            }`}
          >
            <LayoutGrid className="h-3.5 w-3.5" />
          </button>
          <button
            onClick={() => onSwitchViewMode?.("overview")}
            title="Focus Active Plant Overview"
            className="rounded p-1.5 text-slate-400 transition hover:bg-white/10 hover:text-white"
          >
            <Eye className="h-3.5 w-3.5" />
          </button>
          <button
            onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })}
            title="Scroll to top"
            className="rounded p-1.5 text-slate-400 transition hover:bg-white/10 hover:text-white"
          >
            <ChevronUp className="h-3.5 w-3.5" />
          </button>
        </div>
      </section>

      {/* ==================================================================== */}
      {/* 2. FUSIONSOLAR-STYLE MULTI-FILTER BAR + FULL-WIDTH PLANT TABLE        */}
      {/* ==================================================================== */}
      <section className="panel overflow-hidden">
        {/* Multi-Field Filter Toolbar */}
        <div className="border-b border-white/[0.07] bg-ink-900/70 px-4 py-3.5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap items-center gap-2">
              {/* Plant name */}
              <div className="flex items-center gap-1.5">
                <label className="whitespace-nowrap text-[11px] font-medium text-slate-300">
                  Plant name
                </label>
                <input
                  type="text"
                  value={plantNameFilter}
                  onChange={(e) => {
                    setPlantNameFilter(e.target.value);
                    setCurrentPage(1);
                  }}
                  placeholder="Plant name"
                  className="input input-sm w-28"
                />
              </div>

              {/* Country/Region */}
              <div className="flex items-center gap-1.5">
                <label className="whitespace-nowrap text-[11px] font-medium text-slate-300">
                  Country/Region
                </label>
                <input
                  type="text"
                  value={regionFilter}
                  onChange={(e) => {
                    setRegionFilter(e.target.value);
                    setCurrentPage(1);
                  }}
                  placeholder="Country/Region"
                  className="input input-sm w-28"
                />
              </div>

              {/* Device type */}
              <div className="flex items-center gap-1.5">
                <label className="whitespace-nowrap text-[11px] font-medium text-slate-300">
                  Device type
                </label>
                <select
                  value={deviceTypeFilter}
                  onChange={(e) => {
                    setDeviceTypeFilter(e.target.value);
                    setCurrentPage(1);
                  }}
                  className="select input-sm w-28"
                >
                  <option value="ALL">All</option>
                  <option value="String Inverter (SCADA)">SCADA String</option>
                  <option value="Growatt MAX Inverter">Growatt MAX</option>
                </select>
              </div>

              {/* Project phase (one Growatt account per phase) */}
              <div className="flex items-center gap-1.5">
                <label className="whitespace-nowrap text-[11px] font-medium text-slate-300">
                  Phase
                </label>
                <select
                  value={String(phaseFilter)}
                  onChange={(e) => {
                    const v = e.target.value;
                    setPhaseFilter(v === "ALL" || v === "NONE" ? v : Number(v));
                    setCurrentPage(1);
                  }}
                  className="select input-sm w-28"
                >
                  <option value="ALL">All phases</option>
                  {phaseOptions.phases.map(([ph, n]) => (
                    <option key={ph} value={ph}>
                      Phase {ph} ({n})
                    </option>
                  ))}
                  {phaseOptions.untagged > 0 && (
                    <option value="NONE">Untagged ({phaseOptions.untagged})</option>
                  )}
                </select>
              </div>

              {/* Device SN */}
              <div className="flex items-center gap-1.5">
                <label className="whitespace-nowrap text-[11px] font-medium text-slate-300">
                  Device SN
                </label>
                <input
                  type="text"
                  value={deviceSnFilter}
                  onChange={(e) => {
                    setDeviceSnFilter(e.target.value);
                    setCurrentPage(1);
                  }}
                  placeholder="Device SN"
                  className="input input-sm w-24"
                />
              </div>

              {/* Expand toggle */}
              <button
                type="button"
                onClick={() => setExpandedFilters((v) => !v)}
                className="inline-flex items-center gap-0.5 px-1 text-[11px] font-medium text-sky-400 transition hover:text-sky-300"
              >
                {expandedFilters ? "Collapse" : "Expand"}
                {expandedFilters ? (
                  <ChevronUp className="h-3.5 w-3.5" />
                ) : (
                  <ChevronDown className="h-3.5 w-3.5" />
                )}
              </button>

              {/* Search & Reset buttons */}
              <button
                type="button"
                onClick={() => fetchCloudPlants(false)}
                className="inline-flex cursor-pointer items-center gap-1 rounded-md bg-sky-600 px-3 py-1 text-[11px] font-semibold text-white shadow-sm transition hover:bg-sky-500"
              >
                Search
              </button>
              <button
                type="button"
                onClick={handleResetFilters}
                className="btn btn-sm"
              >
                Reset
              </button>
            </div>

            {/* Right actions: Sync Cloud + Add Plant */}
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={() => fetchCloudPlants(true)}
                disabled={loadingCloud}
                className="btn-ghost btn-sm"
                title="Refresh Growatt Cloud Plants"
              >
                <RefreshCw className={`h-3 w-3 ${loadingCloud ? "animate-spin text-sky-400" : ""}`} />
                Sync
              </button>
              <Link
                to="/settings"
                className="inline-flex items-center gap-1 rounded-md bg-sky-600 px-3 py-1 text-[11px] font-semibold text-white shadow-sm transition hover:bg-sky-500"
              >
                <Plus className="h-3 w-3" />
                Add Plant
              </Link>
            </div>
          </div>

          {/* Expandable secondary filters */}
          {expandedFilters && (
            <div className="mt-3 flex flex-wrap items-center gap-3 border-t border-white/[0.06] pt-3 text-xs">
              <span className="text-slate-400">Plant Status:</span>
              {(["ALL", "Normal", "Faulty", "Disconnected"] as const).map((st) => (
                <button
                  key={st}
                  onClick={() => {
                    setStatusFilter(st);
                    setCurrentPage(1);
                  }}
                  className={`rounded-md px-2.5 py-1 text-[11px] font-semibold transition ${
                    statusFilter === st
                      ? "bg-sky-500/20 text-sky-300 ring-1 ring-sky-400/40"
                      : "bg-white/5 text-slate-400 hover:text-slate-200"
                  }`}
                >
                  {st === "ALL" ? "All Statuses" : st}
                </button>
              ))}
              {cloudNotice && (
                <span className="ml-auto text-[11px] text-amber-300/90">
                  Cloud API status: {cloudNotice}
                </span>
              )}
            </div>
          )}
        </div>

        {/* Full-Width 12-Column Sortable Plant Directory Table */}
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-left text-[11px]">
            <thead>
              <tr className="bg-ink-850 text-[10px] uppercase tracking-wider text-slate-400">
                <th className="whitespace-nowrap px-2.5 py-2.5 font-semibold">
                  <span className="inline-flex items-center gap-1">
                    Status <ArrowUpDown className="h-2.5 w-2.5 opacity-50" />
                  </span>
                </th>
                <th className="whitespace-nowrap px-2 py-2.5 font-semibold">Plant Image</th>
                <th className="whitespace-nowrap px-2.5 py-2.5 font-semibold">
                  <button
                    onClick={() => handleSort("name")}
                    className="inline-flex items-center gap-1 font-semibold uppercase tracking-wider text-slate-400 hover:text-white"
                  >
                    Plant Name <ArrowUpDown className="h-2.5 w-2.5 opacity-60" />
                  </button>
                </th>
                <th className="whitespace-nowrap px-2 py-2.5 font-semibold">
                  <button
                    onClick={() => handleSort("location")}
                    className="inline-flex items-center gap-1 font-semibold uppercase tracking-wider text-slate-400 hover:text-white"
                  >
                    Country/Region <ArrowUpDown className="h-2.5 w-2.5 opacity-60" />
                  </button>
                </th>
                <th className="whitespace-nowrap px-2 py-2.5 font-semibold">
                  <button
                    onClick={() => handleSort("createdDate")}
                    className="inline-flex items-center gap-1 font-semibold uppercase tracking-wider text-slate-400 hover:text-white"
                  >
                    Grid Connecti... <ArrowUpDown className="h-2.5 w-2.5 opacity-60" />
                  </button>
                </th>
                <th className="whitespace-nowrap px-2 py-2.5 text-right font-semibold">
                  <button
                    onClick={() => handleSort("capacityKwp")}
                    title="Total String Capacity (kWp)"
                    className="inline-flex items-center justify-end gap-1 font-semibold uppercase tracking-wider text-slate-400 hover:text-white"
                  >
                    String Cap (kWp) <ArrowUpDown className="h-2.5 w-2.5 opacity-60" />
                  </button>
                </th>
                <th className="whitespace-nowrap px-2 py-2.5 text-right font-semibold">
                  <button
                    onClick={() => handleSort("stringsCount")}
                    className="inline-flex items-center justify-end gap-1 font-semibold uppercase tracking-wider text-slate-400 hover:text-white"
                  >
                    Strings / Opt <ArrowUpDown className="h-2.5 w-2.5 opacity-60" />
                  </button>
                </th>
                <th className="whitespace-nowrap px-2 py-2.5 font-semibold">Battery</th>
                <th className="whitespace-nowrap px-2 py-2.5 text-right font-semibold">
                  <button
                    onClick={() => handleSort("currentPowerKw")}
                    className="inline-flex items-center justify-end gap-1 font-semibold uppercase tracking-wider text-slate-400 hover:text-white"
                  >
                    Current Power (kW) <ArrowUpDown className="h-2.5 w-2.5 opacity-60" />
                  </button>
                </th>
                <th className="whitespace-nowrap px-2 py-2.5 text-right font-semibold">
                  <button
                    onClick={() => handleSort("specificEnergyKwhPerKwp")}
                    title="Specific Energy (kWh/kWp)"
                    className="inline-flex items-center justify-end gap-1 font-semibold uppercase tracking-wider text-slate-400 hover:text-white"
                  >
                    Specific Energy <ArrowUpDown className="h-2.5 w-2.5 opacity-60" />
                  </button>
                </th>
                <th className="whitespace-nowrap px-2 py-2.5 text-right font-semibold">
                  <button
                    onClick={() => handleSort("yieldTodayKwh")}
                    className="inline-flex items-center justify-end gap-1 font-semibold uppercase tracking-wider text-slate-400 hover:text-white"
                  >
                    Yield Today (kWh) <ArrowUpDown className="h-2.5 w-2.5 opacity-60" />
                  </button>
                </th>
                <th className="whitespace-nowrap px-2.5 py-2.5 text-right font-semibold">
                  <button
                    onClick={() => handleSort("totalEnergyKwh")}
                    className="inline-flex items-center justify-end gap-1 font-semibold uppercase tracking-wider text-slate-400 hover:text-white"
                  >
                    Total Yield (kWh) <ArrowUpDown className="h-2.5 w-2.5 opacity-60" />
                  </button>
                </th>
              </tr>
            </thead>
            <tbody>
              {filteredPlants.length === 0 ? (
                <tr>
                  <td colSpan={12} className="py-12 text-center">
                    <div className="mx-auto flex flex-col items-center justify-center gap-2 text-slate-500">
                      <Building2 className="h-8 w-8 stroke-1 text-slate-600" />
                      <div className="text-xs font-medium text-slate-400">No data</div>
                      <div className="text-[11px] text-slate-500">
                        No solar plants match the current filter criteria.
                      </div>
                    </div>
                  </td>
                </tr>
              ) : (
                pagedPlants.map((p) => {
                  const isSelected = p.id === selectedGrowattPlantId;
                  const loadPct =
                    p.capacityKwp > 0 && p.currentPowerKw != null
                      ? Math.min(100, (p.currentPowerKw / p.capacityKwp) * 100)
                      : 0;

                  return (
                    <tr
                      key={p.uid}
                      onClick={() => {
                        setSelectedUid(p.uid);
                        selectGrowattPlant(p.id, true);
                        onSwitchViewMode?.("overview");
                      }}
                      className={`group cursor-pointer border-t border-white/[0.05] transition ${
                        isSelected ? "bg-sky-500/[0.09]" : "hover:bg-white/[0.04]"
                      }`}
                    >
                      {/* 1. Status */}
                      <td className="px-2.5 py-2.5">
                        <StatusBadge status={p.statusLabel} level={p.statusLevel} loading={p.statusLabel === LOADING_STATUS} dot />
                      </td>

                      {/* 2. Plant Image */}
                      <td className="px-2 py-2.5">
                        <PlantThumbnail statusLevel={p.statusLevel} source={p.source} />
                      </td>

                      {/* 3. Plant Name */}
                      <td className="max-w-[220px] px-2.5 py-2.5">
                        <div
                          className="flex items-center gap-1.5 truncate font-semibold text-white group-hover:text-sky-300"
                          title={`Click to open ${p.name} Overview`}
                        >
                          <span className="truncate">{p.name}</span>
                          <ArrowUpRight className="h-3 w-3 shrink-0 text-sky-400 opacity-0 transition group-hover:opacity-100" />
                        </div>
                        <div className="mt-0.5 flex items-center gap-1 text-[10px] text-slate-500">
                          <span className="num">#{p.id}</span>
                          {p.phase != null && (
                            <>
                              <span>·</span>
                              <span className="whitespace-nowrap">Phase {p.phase}</span>
                            </>
                          )}
                          <span>·</span>
                          <span className="truncate">{p.source === "local" ? "SCADA" : "Growatt MAX"}</span>
                          {p.prPct != null && (
                            <>
                              <span>·</span>
                              <span className="num font-semibold text-emerald-400">
                                PR {fmt(p.prPct, 1)}%
                              </span>
                            </>
                          )}
                        </div>
                      </td>

                      {/* 4. Country/Region */}
                      <td className="max-w-[140px] px-2 py-2.5">
                        <div className="flex items-center gap-1 truncate text-[11px] text-slate-300" title={p.location}>
                          <MapPin className="h-3 w-3 shrink-0 text-slate-500" />
                          <span className="truncate">{p.location}</span>
                        </div>
                      </td>

                      {/* 5. Grid Connection */}
                      <td className="num whitespace-nowrap px-2 py-2.5 text-[11px] text-slate-300">
                        {p.createdDate || "—"}
                      </td>

                      {/* 6. Total String Capacity (kWp) */}
                      <td className="num whitespace-nowrap px-2 py-2.5 text-right font-semibold text-slate-200">
                        {fmt(p.capacityKwp, 2)}
                      </td>

                      {/* 7. Inverters / String Quantity */}
                      <td className="num whitespace-nowrap px-2 py-2.5 text-right text-[11px] text-slate-300">
                        {p.invertersCount != null ? (
                          <div>
                            <span className="font-semibold text-white">{p.invertersCount}</span> Inv
                          </div>
                        ) : (
                          "—"
                        )}
                      </td>

                      {/* 8. Battery */}
                      <td className="whitespace-nowrap px-2 py-2.5 text-[11px] text-slate-500">
                        {p.source === "local" ? "Grid-Tied" : "--"}
                      </td>

                      {/* 9. Current Power (kW) */}
                      <td className="num whitespace-nowrap px-2 py-2.5 text-right">
                        <div className="font-semibold text-energy-300">{fmt(p.currentPowerKw, 2)}</div>
                        <div className="ml-auto mt-1 h-1 w-14 overflow-hidden rounded-full bg-white/[0.07]">
                          <div
                            className="h-full rounded-full bg-sky-400"
                            style={{ width: `${loadPct}%` }}
                          />
                        </div>
                      </td>

                      {/* 10. Specific Energy (kWh/kWp) */}
                      <td className="num whitespace-nowrap px-2 py-2.5 text-right font-medium text-slate-200">
                        {fmt(p.specificEnergyKwhPerKwp, 2)}
                      </td>

                      {/* 11. Yield Today (kWh) */}
                      <td className="num whitespace-nowrap px-2 py-2.5 text-right font-semibold text-solar-300">
                        {fmt(p.yieldTodayKwh, 2)}
                      </td>

                      {/* 12. Total Yield (kWh) */}
                      <td className="num whitespace-nowrap px-2.5 py-2.5 text-right font-bold text-emerald-300">
                        {fmt(p.totalEnergyKwh, 2)}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>

        {/* Selected Plant Quick String & Inverter Strip (expandable below row) */}
        {showInspectorDrawer && selectedPlant && selectedPlant.source === "local" && strings.length > 0 && (
          <div className="border-t border-white/[0.07] bg-ink-950/60 px-5 py-3.5">
            <div className="mb-2.5 flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2 text-xs">
                <Cpu className="h-3.5 w-3.5 text-sky-400" />
                <span className="font-semibold text-white">{selectedPlant.name}</span>
                <span className="text-slate-500">—</span>
                <span className="text-slate-400">
                  Live String Array Telemetry (click any string to open Inspector Drawer)
                </span>
              </div>
              <div className="flex items-center gap-3">
                <Link
                  to="/strings"
                  className="inline-flex items-center gap-1 text-[11px] font-semibold text-sky-400 hover:text-sky-300"
                >
                  Full String Diagnostics <ArrowUpRight className="h-3 w-3" />
                </Link>
                <button
                  onClick={() => setShowInspectorDrawer(false)}
                  className="text-[11px] text-slate-500 hover:text-slate-300"
                >
                  Hide
                </button>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-8">
              {strings.map((s: Record<string, any>) => {
                const sid = String(s.string_id);
                const st = String(s.status);
                const level: StatusLevel =
                  st === "Critical" ? "crit" : st === "Warning" ? "warn" : "ok";
                return (
                  <button
                    key={sid}
                    onClick={() => setInspectedStringId(sid)}
                    className="group flex flex-col justify-between rounded-lg border border-white/[0.07] bg-ink-900/90 p-2.5 text-left transition hover:border-sky-400/40 hover:bg-ink-850"
                  >
                    <div className="flex items-center justify-between">
                      <span className="num text-xs font-bold text-white group-hover:text-sky-300">
                        {sid}
                      </span>
                      <Led level={level} pulse={level === "crit"} />
                    </div>
                    <div className="mt-1.5 flex items-baseline justify-between">
                      <span className="num text-xs font-semibold text-slate-200">
                        {fmt(Number(s.pr_pct), 1)}%
                      </span>
                      <span className="num text-[10px] text-slate-500">
                        {fmt(Number(s.actual_energy_kwh), 0)} kWh
                      </span>
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {/* Pagination Footer (matches FusionSolar bottom bar) */}
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-white/[0.07] bg-ink-900/50 px-5 py-3 text-xs text-slate-400">
          <div>
            Total: <span className="num font-semibold text-slate-200">{filteredPlants.length}</span>
          </div>
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-1">
              <button
                onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
                disabled={safePage <= 1}
                className="rounded px-2 py-1 text-slate-300 transition hover:bg-white/10 disabled:cursor-not-allowed disabled:text-slate-600"
              >
                ‹
              </button>
              {Array.from({ length: totalPages }, (_, i) => i + 1).map((pg) => (
                <button
                  key={pg}
                  onClick={() => setCurrentPage(pg)}
                  className={`num rounded px-2.5 py-0.5 text-xs font-semibold transition ${
                    pg === safePage
                      ? "bg-sky-500/20 text-sky-300 ring-1 ring-sky-400/30"
                      : "text-slate-400 hover:bg-white/5 hover:text-slate-200"
                  }`}
                >
                  {pg}
                </button>
              ))}
              <button
                onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
                disabled={safePage >= totalPages}
                className="rounded px-2 py-1 text-slate-300 transition hover:bg-white/10 disabled:cursor-not-allowed disabled:text-slate-600"
              >
                ›
              </button>
            </div>
            <select
              value={pageSize}
              onChange={(e) => {
                setPageSize(Number(e.target.value));
                setCurrentPage(1);
              }}
              className="select input-sm w-24"
            >
              <option value={10}>10 / page</option>
              <option value={25}>25 / page</option>
              <option value={50}>50 / page</option>
            </select>
          </div>
        </div>
      </section>
    </div>
  );
};
