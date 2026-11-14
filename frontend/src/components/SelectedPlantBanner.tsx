import React, { useState, useMemo } from "react";
import { Link, useLocation } from "react-router-dom";
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
  Search,
  X,
  Rows3,
} from "lucide-react";
import { useAppContext } from "../context/AppContext";
import { canAccessPlantPage } from "../auth/access";
import { parsePlantPath, plantPath } from "../context/routes";
import type { PlantPage } from "../context/routes";
import { StatusBadge, fmt, LOADING_STATUS } from "./ui";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { StatusLevel } from "./ui";
import { Spinner } from "@/components/ui/spinner";
import { Skeleton } from "@/components/ui/skeleton";

export const SelectedPlantBanner: React.FC = () => {
  const {
    growattPlants,
    selectedGrowattPlantId,
    selectedPlantOverview,
    plantOverviewLoading,
    selectGrowattPlant,
    ensurePlantList,
    plantListLoaded,
    user,
  } = useAppContext();
  const location = useLocation();

  const plant = selectedPlantOverview?.plant;

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

  // Realtime only: plant.status from the fleet poll, string verdicts from the newest live record
  // (each string vs. its inverter's other strings at that moment). Stored-day analysis is not used.
  const statusUnknown = !!plant && plant.status == null;
  const liveStrings = selectedPlantOverview?.live?.strings ?? null;
  const online = !plant || plant.status === 1;
  const stringFault = online && !!liveStrings && liveStrings.critical > 0;
  const stringWarn = online && !!liveStrings && liveStrings.warning > 0;
  const statusLevel: StatusLevel = statusUnknown ? "neutral" : !online ? "crit" : stringFault ? "crit" : stringWarn ? "warn" : "ok";

  // no live status yet (first poll running or live retrying): always "Loading…", never "unknown"
  const statusLoading = statusUnknown;
  const statusLabel = statusLoading
    ? LOADING_STATUS
    : !online
      ? "Disconnected"
      : stringFault
        ? "String Fault"
        : stringWarn
          ? "String Warning"
          : "Normal";
  const statusTitle = !online
    ? undefined
    : liveStrings
      ? `Live string check${liveStrings.at ? ` at ${liveStrings.at.slice(11, 16)}` : ""}: ${liveStrings.critical} critical · ${liveStrings.warning} warning · ${liveStrings.healthy} healthy${liveStrings.unknown ? ` · ${liveStrings.unknown} not judged (low light / wiring unknown)` : ""}`
      : "Inverter status only: no live string data yet";

  const currentPage = parsePlantPath(location.pathname)?.page ?? "";
  const tabs: Array<{ page: PlantPage; label: string; icon: React.ComponentType<{ className?: string }> }> = [
    { page: "", label: "Plant Overview", icon: LayoutDashboard },
    { page: "generation", label: "Performance Ratio", icon: TrendingUp },
    { page: "inverters", label: "Inverters", icon: Cpu },
    { page: "sensors", label: "Sensors", icon: Gauge },
    { page: "strings", label: "String Diagnostics & I-V / P-V Curves", icon: Activity },
    { page: "string-layout", label: "String Layout", icon: Rows3 },
    { page: "maintenance", label: "Alarms & Maintenance", icon: Wrench },
  ];
  const navItems =
    selectedGrowattPlantId == null
      ? []
      : tabs
          .filter((t) => canAccessPlantPage(user, t.page))
          .map((t, i) => ({
            ...t,
            step: String(i + 1),
            to: plantPath(selectedGrowattPlantId, t.page),
            // one string's page belongs to String Diagnostics
            active: currentPage === t.page || (currentPage === "string" && t.page === "strings"),
          }));

  return (
    <section className="overflow-hidden rounded-xl border border-white/[0.08] bg-ink-900">
      {/* Top Row: Back Button + Plant Title + Quick Plant Switcher + Key Specs */}
      <div className="flex flex-wrap items-center justify-between gap-4 border-b border-white/[0.08] px-5 py-3.5">
        <div className="flex flex-wrap items-center gap-3">
          <Link
            to="/"
            className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg border border-sky-400/30 bg-sky-500/15 px-3 py-1.5 text-xs font-semibold text-sky-200 transition hover:bg-sky-500/25 hover:text-white"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            All Plants{plantListLoaded ? ` (${growattPlants.length})` : ""}
          </Link>

          <div className="h-5 w-px bg-white/10" />

          <div className="flex items-center gap-2.5">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-solar-400/30 bg-solar-400/10 text-solar-300">
              <Building2 className="h-4 w-4" />
            </div>
            <div>
              <div className="flex flex-wrap items-center gap-2">
                {plant?.name ? (
                  <h2 className="text-sm font-bold text-white sm:text-base">{plant.name}</h2>
                ) : (
                  <Skeleton className="h-5 w-48" aria-label="Loading plant…" />
                )}
                <span title={statusTitle}>
                  <StatusBadge status={statusLabel} level={statusLevel} loading={statusLoading} dot />
                </span>
                {plantOverviewLoading && (
                  <Spinner className="size-3.5" aria-label="Refreshing plant data…" />
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

        {/* Right Side (ชิดขวา): Quick Plant Switcher */}
        <div className="ml-auto flex items-center gap-2">
          <label className="whitespace-nowrap text-[11px] font-medium text-slate-400">Switch Plant:</label>
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-500" />
            <Input
              type="text"
              value={plantSearch}
              onChange={(e) => setPlantSearch(e.target.value)}
              onFocus={ensurePlantList}
              onKeyDown={(e) => {
                if (e.key === "Enter" && filteredPlants.length > 0) {
                  selectGrowattPlant(filteredPlants[0].plant_id);
                }
              }}
              placeholder="Search plant…"
              className="h-7 w-36 pl-8 pr-7 text-xs border-white/10 bg-ink-950/90 placeholder:text-slate-500 focus:border-sky-400/40 focus:ring-1 focus:ring-sky-400/20 sm:w-44"
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
          <Select
            value={
              filteredPlants.some((gp) => gp.plant_id === selectedGrowattPlantId)
                ? String(selectedGrowattPlantId ?? "")
                : ""
            }
            onValueChange={(v) => {
              const val = Number(v);
              if (val) selectGrowattPlant(val);
            }}
            onOpenChange={(open) => open && ensurePlantList()}
          >
            <SelectTrigger
              size="sm"
              className="w-56 border-sky-400/30 bg-ink-950/90 text-xs font-medium text-white"
              title="Select plant"
            >
              <SelectValue
                placeholder={
                  !plantListLoaded
                    ? plant?.name ?? "Select plant"
                    : plantSearch
                    ? filteredPlants.length > 0
                      ? `Select from ${filteredPlants.length} matching…`
                      : `No plants match "${plantSearch}"`
                    : undefined
                }
              />
            </SelectTrigger>
            <SelectContent>
              {!plantListLoaded && (
                <div className="flex items-center gap-2 px-2 py-1.5 text-xs text-slate-500">
                  <Spinner className="size-3" /> Loading plants…
                </div>
              )}
              {filteredPlants.map((gp) => (
                <SelectItem key={gp.plant_id} value={String(gp.plant_id)}>
                  {gp.name} ({fmt(gp.peak_power_kwp, 1)} kWp)
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {/* Bottom Row: 1..6 Single-Plant Module Navigation Tabs */}
      <div className="flex flex-wrap items-center justify-between gap-2 bg-ink-950/50 px-5 py-2">
        <div className="flex flex-wrap items-center gap-1.5">
          {navItems.map((item) => {
            const Icon = item.icon;
            return (
              <Link
                key={item.step}
                to={item.to}
                aria-current={item.active ? "page" : undefined}
                className={`inline-flex cursor-pointer items-center gap-2 rounded-lg px-3 py-1.5 text-xs font-semibold transition ${
                  item.active
                    ? "bg-sky-500/20 text-sky-200 ring-1 ring-sky-400/40 shadow-[0_0_15px_-4px_rgba(56,189,248,0.5)]"
                    : "text-slate-400 hover:bg-white/[0.05] hover:text-slate-200"
                }`}
              >
                <span
                  className={`num flex h-4 w-4 items-center justify-center rounded-full text-[11px] font-bold ${
                    item.active ? "bg-sky-400 text-ink-950" : "bg-white/10 text-slate-400"
                  }`}
                >
                  {item.step}
                </span>
                <Icon className="h-3.5 w-3.5" />
                <span>{item.label}</span>
              </Link>
            );
          })}
        </div>

      </div>
    </section>
  );
};
