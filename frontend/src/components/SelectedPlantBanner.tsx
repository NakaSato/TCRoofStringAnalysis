import React, { useState, useMemo } from "react";
import { Link, useLocation } from "react-router-dom";
import {
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
  FileText,
  Images,
} from "lucide-react";
import { useAppContext } from "../context/AppContext";
import { canAccessPlantPage } from "../auth/access";
import { parsePlantPath, plantPath } from "../context/routes";
import type { PlantPage } from "../context/routes";
import { StatusBadge, fmt, LOADING_STATUS } from "./ui";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { StatusLevel } from "./ui";
import type { GrowattPlant } from "../api/client";
import { Spinner } from "@/components/ui/spinner";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { useI18n } from "../i18n";

/** As-built PDF and site photo folder on Google Drive; a kind without a link shows no button. */
const PlantDocumentLinks: React.FC<{ documents: GrowattPlant["documents"] }> = ({ documents }) => {
  const { t } = useI18n();
  const asbuilt = documents?.asbuilt;
  const photos = documents?.site_photos;
  if (!asbuilt && !photos) return null;
  const hint = t("Opens Google Drive in a new tab. You need access to the company Drive.");
  return (
    <span className="inline-flex items-center gap-1">
      {asbuilt && (
        <Button asChild variant="ghost" size="xs" title={`${asbuilt.title ?? t("As-built drawing")}\n${hint}`}>
          <a href={asbuilt.url} target="_blank" rel="noreferrer">
            <FileText />
            {t("As-built")}
            {asbuilt.revision && <span className="text-muted-foreground">{asbuilt.revision}</span>}
          </a>
        </Button>
      )}
      {photos && (
        <Button asChild variant="ghost" size="xs" title={`${photos.title ?? t("Site photos")}\n${hint}`}>
          <a href={photos.url} target="_blank" rel="noreferrer">
            <Images />
            {t("Site photos")}
          </a>
        </Button>
      )}
    </span>
  );
};

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
  const { t } = useI18n();

  const plant = selectedPlantOverview?.plant;
  const capacityKwp = selectedPlantOverview?.kpis.capacity_kwp ?? null;
  const lifetimeKwh = selectedPlantOverview?.kpis.total_yield_kwh ?? null;
  const capacityHint =
    plant?.reported_peak_power_kwp != null && capacityKwp == null
      ? t("Growatt lists {kwp} kWp, impossible for its inverters", { kwp: fmt(plant.reported_peak_power_kwp, 0) })
      : undefined;

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
      ? `${liveStrings.at ? t("Live string check at {time}", { time: liveStrings.at.slice(11, 16) }) : t("Live string check")}: ${t("{critical} critical · {warning} warning · {healthy} healthy", { critical: liveStrings.critical, warning: liveStrings.warning, healthy: liveStrings.healthy })}${liveStrings.unknown ? ` · ${t("{n} not judged (low light / wiring unknown)", { n: liveStrings.unknown })}` : ""}`
      : t("Inverter status only: no live string data yet");

  const currentPage = parsePlantPath(location.pathname)?.page ?? "";
  const tabs: Array<{ page: PlantPage; label: string; icon: React.ComponentType<{ className?: string }> }> = [
    { page: "", label: t("Plant Overview"), icon: LayoutDashboard },
    { page: "generation", label: t("Performance Ratio"), icon: TrendingUp },
    { page: "inverters", label: t("Inverters"), icon: Cpu },
    { page: "sensors", label: t("Sensors"), icon: Gauge },
    { page: "strings", label: t("String Diagnostics & I-V / P-V Curves"), icon: Activity },
    { page: "string-layout", label: t("String Layout"), icon: Rows3 },
    { page: "maintenance", label: t("Maintenance"), icon: Wrench },
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
      {/* Top Row: Plant Title + Quick Plant Switcher + Key Specs */}
      <div className="flex flex-wrap items-center justify-between gap-4 border-b border-white/[0.08] px-5 py-3.5">
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-2.5">
            <div>
              <div className="flex flex-wrap items-center gap-2">
                {plant?.name ? (
                  <h2 className="text-sm font-bold text-white sm:text-base">{plant.name}</h2>
                ) : (
                  <Skeleton className="h-5 w-48" aria-label={t("Loading plant…")} />
                )}
                <span title={statusTitle}>
                  <StatusBadge status={statusLabel} level={statusLevel} loading={statusLoading} dot />
                </span>
                {plantOverviewLoading && (
                  <Spinner className="size-3.5" aria-label={t("Refreshing plant data…")} />
                )}
                <PlantDocumentLinks documents={plant?.documents} />
              </div>
              <div className="mt-0.5 flex flex-wrap items-center gap-2 text-[11px] text-slate-400">
                <span className="num text-slate-300">{t("ID")} #{plant?.plant_id ?? selectedGrowattPlantId}</span>
                <span>·</span>
                <span className="inline-flex items-center gap-1">
                  {[plant?.city, plant?.country].filter(Boolean).join(", ") || t("Thailand")}
                </span>
                <span>·</span>
                <span
                  className="inline-flex items-center gap-1"
                  title={capacityHint ?? t("DC capacity: PV modules connected to the inverters")}
                >
                  {t("DC capacity")}
                  <span className="num font-semibold text-slate-200">
                    {fmt(capacityKwp, 1)}
                    {capacityKwp != null && " kWp"}
                  </span>
                  {capacityHint && <span className="text-amber-400" aria-label={capacityHint}>!</span>}
                </span>
                <span>·</span>
                <span className="inline-flex items-center gap-1" title={t("Lifetime yield reported by the inverters")}>
                  {t("Lifetime yield")}
                  <span className="num font-semibold text-slate-200">
                    {fmt(lifetimeKwh == null ? null : lifetimeKwh / 1000, 1)}
                    {lifetimeKwh != null && " MWh"}
                  </span>
                </span>
                {plant?.create_date && (
                  <>
                    <span>·</span>
                    <span>{t("Grid Connected: {date}", { date: plant.create_date })}</span>
                  </>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* Right Side (ชิดขวา): Quick Plant Switcher */}
        <div className="ml-auto flex items-center gap-2">
          <label className="whitespace-nowrap text-[11px] font-medium text-slate-400">{t("Switch Plant:")}</label>
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
              placeholder={t("Search plant…")}
              className="h-7 w-36 pl-8 pr-7 text-xs border-white/10 bg-ink-950/90 placeholder:text-slate-500 focus:border-sky-400/40 focus:ring-1 focus:ring-sky-400/20 sm:w-44"
            />
            {plantSearch && (
              <button
                type="button"
                onClick={() => setPlantSearch("")}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-300"
                title={t("Clear search")}
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
              title={t("Select plant")}
            >
              <SelectValue
                placeholder={
                  !plantListLoaded
                    ? plant?.name ?? t("Select plant")
                    : plantSearch
                    ? filteredPlants.length > 0
                      ? t("Select from {n} matching…", { n: filteredPlants.length })
                      : t('No plants match "{q}"', { q: plantSearch })
                    : undefined
                }
              />
            </SelectTrigger>
            <SelectContent>
              {!plantListLoaded && (
                <div className="flex items-center gap-2 px-2 py-1.5 text-xs text-slate-500">
                  <Spinner className="size-3" /> {t("Loading plants…")}
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
