import React, { useState, useMemo } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import {
  ArrowLeft,
  Building2,
  MapPin,
  Cpu,
  Zap,
  Gauge,
  Activity,
  LayoutDashboard,
  TrendingUp,
  Wrench,
  ShieldCheck,
  FileSpreadsheet,
  RefreshCw,
  Search,
  X,
} from "lucide-react";
import { useAppContext } from "../context/AppContext";
import { StatusBadge, fmt, fmtInt, LOADING_STATUS } from "./ui";
import type { StatusLevel } from "./ui";

export const SelectedPlantBanner: React.FC = () => {
  const {
    growattPlants,
    selectedGrowattPlantId,
    selectedPlantOverview,
    plantOverviewLoading,
    selectGrowattPlant,
    setDashboardMode,
  } = useAppContext();
  const navigate = useNavigate();
  const location = useLocation();

  const plant = selectedPlantOverview?.plant;
  const kpis = selectedPlantOverview?.kpis;

  const [plantSearch, setPlantSearch] = useState("");

  const filteredPlants = useMemo(() => {
    const q = plantSearch.trim().toLowerCase();
    if (!q) return growattPlants;
    return growattPlants.filter(
      (gp) =>
        gp.name.toLowerCase().includes(q) ||
        String(gp.plant_id).includes(q) ||
        (gp.city && gp.city.toLowerCase().includes(q))
    );
  }, [growattPlants, plantSearch]);

  // plant.status is realtime only: null until live data arrives, so show it as unknown.
  const statusUnknown = !!plant && plant.status == null;
  const statusLevel: StatusLevel = statusUnknown
    ? "neutral"
    : !plant || plant.status === 1
      ? kpis && kpis.critical_strings > 0
        ? "warn"
        : "ok"
      : "crit";

  // no live status yet (first poll running or live retrying): always "Loading…", never "unknown"
  const statusLoading = statusUnknown;
  const statusLabel = statusLoading
    ? LOADING_STATUS
    : !plant || plant.status === 1
      ? kpis && kpis.critical_strings > 0
        ? "String Warning"
        : "Normal"
      : "Disconnected";

  const handleBackToDirectory = () => {
    setDashboardMode("directory");
    if (location.pathname !== "/") {
      navigate("/");
    }
  };

  const navItems = [
    {
      step: "1",
      label: "Plant Overview",
      to: "/",
      icon: LayoutDashboard,
      active: location.pathname === "/",
      onClick: () => {
        setDashboardMode("plant");
        navigate("/");
      },
    },
    {
      step: "2",
      label: "Performance Ratio",
      to: "/generation",
      icon: TrendingUp,
      active: location.pathname === "/generation",
      onClick: () => navigate("/generation"),
    },
    {
      step: "3",
      label: "String Diagnostics & I-V / P-V Curves",
      to: "/strings",
      icon: Activity,
      active: location.pathname === "/strings",
      onClick: () => navigate("/strings"),
    },
    {
      step: "4",
      label: "Alarms & Maintenance",
      to: "/maintenance",
      icon: Wrench,
      active: location.pathname === "/maintenance",
      onClick: () => navigate("/maintenance"),
    },
    {
      step: "5",
      label: "Power Quality & Reports",
      to: "/quality",
      icon: ShieldCheck,
      active: location.pathname === "/quality" || location.pathname === "/reports",
      onClick: () => navigate("/quality"),
    },
  ];

  return (
    <section className="overflow-hidden rounded-xl border border-white/[0.08] bg-ink-900">
      {/* Top Row: Back Button + Plant Title + Quick Plant Switcher + Key Specs */}
      <div className="flex flex-wrap items-center justify-between gap-4 border-b border-white/[0.08] px-5 py-3.5">
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={handleBackToDirectory}
            className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg border border-sky-400/30 bg-sky-500/15 px-3 py-1.5 text-xs font-semibold text-sky-200 transition hover:bg-sky-500/25 hover:text-white"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            All Plants ({growattPlants.length || 43})
          </button>

          <div className="h-5 w-px bg-white/10" />

          <div className="flex items-center gap-2.5">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-solar-400/30 bg-solar-400/10 text-solar-300">
              <Building2 className="h-4 w-4" />
            </div>
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="text-sm font-bold text-white sm:text-base">
                  {plant?.name || "Loading Plant…"}
                </h2>
                <StatusBadge status={statusLabel} level={statusLevel} loading={statusLoading} dot />
                {plantOverviewLoading && (
                  <RefreshCw className="h-3.5 w-3.5 animate-spin text-sky-400" />
                )}
              </div>
              <div className="mt-0.5 flex flex-wrap items-center gap-2 text-[11px] text-slate-400">
                <span className="num text-slate-300">ID #{plant?.plant_id ?? selectedGrowattPlantId}</span>
                <span>·</span>
                <span className="inline-flex items-center gap-1">
                  <MapPin className="h-3 w-3 text-slate-500" />
                  {[plant?.city, plant?.country].filter(Boolean).join(", ") || "Thailand"}
                </span>
                {plant?.create_date && (
                  <>
                    <span>·</span>
                    <span>Grid Connected: {plant.create_date}</span>
                  </>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* Right Side (ชิดขวา): Live KPI Badges + Quick Plant Switcher */}
        <div className="ml-auto flex flex-wrap items-center gap-3">
          {kpis && location.pathname !== "/" && (
            <div className="hidden items-center gap-4 rounded-lg border border-white/[0.08] bg-ink-950/60 px-3.5 py-1.5 text-xs xl:flex">
              <div
                title={
                  selectedPlantOverview?.live
                    ? `Live from Growatt (memory only), fetched ${new Date(selectedPlantOverview.live.fetched_at).toLocaleTimeString()}`
                    : "Last synced value from the database"
                }
              >
                <span className="text-[10px] uppercase tracking-wider text-slate-500">
                  {selectedPlantOverview?.live && !selectedPlantOverview.live.stale ? "Power · Live" : "Power · Last sync"}
                </span>
                <div className="num font-bold text-sky-300">{fmt(kpis.current_power_kw, 1)} kW</div>
              </div>
              <div className="h-5 w-px bg-white/[0.07]" />
              <div>
                <span className="text-[10px] uppercase tracking-wider text-slate-500">Capacity</span>
                <div className="num font-bold text-solar-300">{fmt(kpis.capacity_kwp, 2)} kWp</div>
              </div>
              <div className="h-5 w-px bg-white/[0.07]" />
              <div>
                <span className="text-[10px] uppercase tracking-wider text-slate-500">Inverters</span>
                <div className="num font-bold text-white">
                  {fmtInt(kpis.online_inverters)}/{kpis.inverter_count}
                </div>
              </div>
              <div className="h-5 w-px bg-white/[0.07]" />
              <div>
                <span className="text-[10px] uppercase tracking-wider text-slate-500">Strings</span>
                <div className="num font-bold text-energy-300">{kpis.string_count}</div>
              </div>
              <div className="h-5 w-px bg-white/[0.07]" />
              <div>
                <span className="text-[10px] uppercase tracking-wider text-slate-500">Plant PR</span>
                <div className="num font-bold text-emerald-400">{fmt(kpis.plant_pr_pct, 1)}%</div>
              </div>
            </div>
          )}

          <div className="flex flex-wrap items-center gap-2">
            <label className="whitespace-nowrap text-[11px] font-medium text-slate-400">Switch Plant:</label>
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-500" />
              <input
                type="text"
                value={plantSearch}
                onChange={(e) => setPlantSearch(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && filteredPlants.length > 0) {
                    selectGrowattPlant(filteredPlants[0].plant_id, false);
                  }
                }}
                placeholder="Search plant…"
                className="input input-sm w-36 pl-8 pr-7 text-xs border-white/10 bg-ink-950/90 placeholder:text-slate-500 focus:border-sky-400/40 focus:ring-1 focus:ring-sky-400/20 sm:w-44"
              />
              {plantSearch && (
                <button
                  type="button"
                  onClick={() => setPlantSearch("")}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-300"
                  title="Clear search"
                >
                  <X className="h-3 w-3" />
                </button>
              )}
            </div>
            <select
              value={
                filteredPlants.some((gp) => gp.plant_id === selectedGrowattPlantId)
                  ? (selectedGrowattPlantId ?? "")
                  : ""
              }
              onChange={(e) => {
                const val = Number(e.target.value);
                if (val) selectGrowattPlant(val, false);
              }}
              className="select input-sm w-56 border-sky-400/30 bg-ink-950/90 text-xs font-medium text-white"
              title="Select plant"
            >
              {plantSearch && !filteredPlants.some((gp) => gp.plant_id === selectedGrowattPlantId) && (
                <option value="" disabled>
                  {filteredPlants.length > 0
                    ? `Select from ${filteredPlants.length} matching…`
                    : `No plants match "${plantSearch}"`}
                </option>
              )}
              {filteredPlants.map((gp) => (
                <option key={gp.plant_id} value={gp.plant_id}>
                  {gp.name} ({fmt(Number(gp.peak_power_kwp || 0), 1)} kWp)
                </option>
              ))}
            </select>
          </div>
        </div>
      </div>

      {/* Bottom Row: 1..5 Single-Plant Module Navigation Tabs */}
      <div className="flex flex-wrap items-center justify-between gap-2 bg-ink-950/50 px-5 py-2">
        <div className="flex flex-wrap items-center gap-1.5">
          {navItems.map((item) => {
            const Icon = item.icon;
            return (
              <button
                key={item.step}
                type="button"
                onClick={item.onClick}
                className={`inline-flex cursor-pointer items-center gap-2 rounded-lg px-3 py-1.5 text-xs font-semibold transition ${
                  item.active
                    ? "bg-sky-500/20 text-sky-200 ring-1 ring-sky-400/40 shadow-[0_0_15px_-4px_rgba(56,189,248,0.5)]"
                    : "text-slate-400 hover:bg-white/[0.05] hover:text-slate-200"
                }`}
              >
                <span
                  className={`num flex h-4 w-4 items-center justify-center rounded-full text-[10px] font-bold ${
                    item.active ? "bg-sky-400 text-ink-950" : "bg-white/10 text-slate-400"
                  }`}
                >
                  {item.step}
                </span>
                <Icon className="h-3.5 w-3.5" />
                <span>{item.label}</span>
              </button>
            );
          })}
        </div>

        <Link
          to="/reports"
          className="inline-flex items-center gap-1.5 rounded-md border border-white/10 bg-white/[0.04] px-2.5 py-1 text-[11px] font-medium text-slate-300 transition hover:bg-white/10 hover:text-white"
        >
          <FileSpreadsheet className="h-3 w-3 text-solar-400" />
          Export Plant Report
        </Link>
      </div>
    </section>
  );
};
