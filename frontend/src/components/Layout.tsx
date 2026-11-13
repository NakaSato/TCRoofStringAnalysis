import React, { Suspense, useState, useEffect, useMemo } from "react";
import { NavLink, Outlet, useLocation } from "react-router-dom";
import {
  Sun,
  TrendingUp,
  Activity,
  Wrench,
  ShieldAlert,
  Settings,
  Save,
  LayoutDashboard,
  Cpu,
  Bell,
  SlidersHorizontal,
  Menu,
  X,
  Radio,
  Clock,
  LogOut,
  MapPin,
  RefreshCw,
  AlertTriangle,
  Search,
  Users,
  BellRing,
  Building2,
  Rows3,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useAppContext } from "../context/AppContext";
import { canAccessPath, canAccessPlantPage, isAdmin } from "../auth/access";
import { getLastPlantId, parsePlantPath, plantPath } from "../context/routes";
import type { PlantPage } from "../context/routes";
import { api } from "../api/client";
import { Led, LoadingState, fmt } from "./ui";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { StringInspectorDrawer } from "./StringInspectorDrawer";
import { CommandPaletteModal, AlarmCenterDrawer } from "./CommandPaletteAndAlarms";

interface NavItem {
  /** fleet-wide page; plant pages use `page` instead (their URL carries the plant id) */
  to?: string;
  page?: PlantPage;
  label: string;
  icon: LucideIcon;
  description?: string;
}

const NAV_GROUPS: { title: string; items: NavItem[] }[] = [
  {
    title: "Monitoring",
    items: [
      { to: "/", label: "All Plants", icon: Building2, description: "Every plant you can see, with live status" },
      { page: "", label: "Plant Overview", icon: LayoutDashboard },
      { page: "generation", label: "Generation & PR", icon: TrendingUp, description: "Daily / monthly yield, PR & loss waterfall" },
      { page: "inverters", label: "Inverters", icon: Cpu, description: "Inverter status, MPPT, 5-minute profile & fault log" },
      { page: "strings", label: "String Diagnostics", icon: Activity, description: "String performance, heatmap & I-V / P-V curves" },
      { page: "string-layout", label: "String Layout", icon: Rows3, description: "Modules per string for each inverter" },
      { to: "/growatt", label: "Growatt Fleet", icon: Radio, description: "Live Growatt OpenAPI plants & inverter status" },
    ],
  },
  {
    title: "Operations",
    items: [
      { to: "/alarms", label: "Active Alarm", icon: BellRing, description: "Plants in alarm & today's Growatt alarm log" },
      { page: "maintenance", label: "Maintenance & RCA", icon: Wrench, description: "PM schedule, CM work orders & root cause analysis" },
      { to: "/she", label: "Safety (SH&E)", icon: ShieldAlert, description: "Permit-to-work, LOTO & ISO 45001 compliance" },
    ],
  },
  {
    title: "System",
    items: [
      { to: "/settings", label: "Global Settings", icon: Settings, description: "Fleet-wide module & settings for every plant" },
      { to: "/users", label: "Users & Access", icon: Users, description: "Accounts, roles & plant assignments" },
    ],
  },
];

const ALL_NAV = NAV_GROUPS.flatMap((g) => g.items);

const useClock = () => {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);
  return now;
};

export const Layout: React.FC = () => {
  const {
    user,
    logout,
    activePlant,
    activeDataset,
    refreshAll,
    analysisRun,
    loading,
    error,
    selectedGrowattPlantId,
    selectedPlantOverview,
    ensureLegacy,
  } = useAppContext();
  const location = useLocation();
  const now = useClock();

  // Quick plant parameters (drawer)
  const [modulesPerString, setModulesPerString] = useState<number>(18);
  const [moduleWp, setModuleWp] = useState<number>(550);
  const [targetPrPct, setTargetPrPct] = useState<number>(84.0);
  const [tariffThb, setTariffThb] = useState<number>(4.2);
  const [underperfThresh, setUnderperfThresh] = useState<number>(10.0);
  const [savingConfig, setSavingConfig] = useState<boolean>(false);
  const [specsOpen, setSpecsOpen] = useState<boolean>(false);
  const [mobileNavOpen, setMobileNavOpen] = useState<boolean>(false);
  const [cmdOpen, setCmdOpen] = useState<boolean>(false);
  const [alarmsOpen, setAlarmsOpen] = useState<boolean>(false);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setCmdOpen((prev) => !prev);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  useEffect(() => {
    if (activePlant) {
      setModulesPerString(activePlant.modules_per_string);
      setModuleWp(activePlant.module_wp);
      setTargetPrPct(activePlant.target_pr_pct);
      setTariffThb(activePlant.tariff_thb_per_kwh);
      setUnderperfThresh(activePlant.underperformance_threshold_pct);
    }
  }, [activePlant]);

  useEffect(() => {
    setMobileNavOpen(false);
  }, [location.pathname]);

  // Plant pages link to the plant in the URL, else to the last plant opened (none: disabled).
  const navPlantId = selectedGrowattPlantId ?? getLastPlantId();
  const hrefOf = (n: NavItem): string | null =>
    n.page != null ? (navPlantId != null ? plantPath(navPlantId, n.page) : null) : n.to ?? null;
  const canSee = (n: NavItem) => (n.page != null ? canAccessPlantPage(user, n.page) : canAccessPath(user, n.to ?? "/"));
  const plantRoute = parsePlantPath(location.pathname);
  const current = plantRoute
    ? ALL_NAV.find((n) => n.page != null && n.page === plantRoute.page)
    : ALL_NAV.find((n) => n.to != null && (n.to === "/" ? location.pathname === "/" : location.pathname.startsWith(n.to)));
  // Name / place of the plant in the URL; on fleet pages the legacy analysis plant, if loaded.
  const shownPlantName =
    selectedPlantOverview?.plant.name ??
    (activePlant && activePlant.name !== "TC Roof Solar PV Plant" ? activePlant.name : null);
  const shownPlantPlace = selectedPlantOverview
    ? [selectedPlantOverview.plant.city, selectedPlantOverview.plant.country].filter(Boolean).join(", ") || null
    : activePlant?.location ?? null;

  const kpis = analysisRun?.plant_kpis_json || {};
  const criticalStrings = Number(kpis.critical_strings || 0);
  const warningStrings = Number(kpis.warning_strings || 0);
  const alarmCount = useMemo(
    () => (analysisRun?.anomalies_json || []).filter((a) => String(a.severity) === "Critical").length,
    [analysisRun]
  );
  const plantLevel = criticalStrings > 0 ? "crit" : warningStrings > 0 ? "warn" : "ok";
  const plantStateLabel = criticalStrings > 0 ? "Fault Detected" : warningStrings > 0 ? "Degraded" : "Normal Operation";
  // Strings can have different module counts / ratings. The plant-level values are defaults:
  // a string still on the saved default follows the drawer's value, others keep their own.
  const stringSpecs = activePlant?.string_specs ?? [];
  const specCapacityKwp = (mods: number, wp: number): number | null =>
    stringSpecs.length && activePlant
      ? stringSpecs.reduce(
          (sum, s) =>
            sum +
            (s.modules_per_string === activePlant.modules_per_string ? mods : s.modules_per_string) *
              (s.module_wp === activePlant.module_wp ? wp : s.module_wp),
          0
        ) / 1000
      : null;
  const dcCapacityKwp: number | null =
    Number(kpis.total_capacity_kwp) ||
    (activePlant ? specCapacityKwp(activePlant.modules_per_string, activePlant.module_wp) : null);
  const draftCapacityKwp = specCapacityKwp(modulesPerString, moduleWp);
  const moduleCounts = stringSpecs.map((s) => s.modules_per_string);
  const customStrings = activePlant
    ? stringSpecs.filter(
        (s) => s.modules_per_string !== activePlant.modules_per_string || s.module_wp !== activePlant.module_wp
      ).length
    : 0;
  const sidebarStringCount = kpis.num_strings ?? activeDataset?.string_count ?? "—";

  const handleApplySidebarSpecs = async () => {
    if (!activePlant) return;
    setSavingConfig(true);
    try {
      await api.updatePlant(activePlant.id, {
        ...activePlant,
        modules_per_string: modulesPerString,
        module_wp: moduleWp,
        target_pr_pct: targetPrPct,
        tariff_thb_per_kwh: tariffThb,
        underperformance_threshold_pct: underperfThresh,
      });
      await refreshAll();
      setSpecsOpen(false);
    } catch (err: any) {
      alert(`Failed to update plant parameters: ${err.message}`);
    } finally {
      setSavingConfig(false);
    }
  };

  const initials = (user?.full_name || "Guest")
    .split(" ")
    .map((p) => p[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();

  const sidebar = (
    <aside className="flex h-full w-64 flex-col border-r border-white/[0.06] bg-ink-900/95 backdrop-blur-xl">
      {/* Brand */}
      <div className="flex items-center gap-3 px-5 pb-4 pt-5">
        <div className="rounded-xl bg-solar-500 p-2 text-ink-950">
          <Sun className="h-5 w-5" strokeWidth={2.5} />
        </div>
        <div className="min-w-0">
          <div className="text-sm font-extrabold tracking-tight text-white">GenZ Monitoring</div>
          <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-solar-400/80">Control Center</div>
        </div>
      </div>

      {/* Plant status card */}
      <div className="mx-3 mb-3 rounded-xl border border-white/[0.06] bg-ink-850/80 p-3">
        <div className="flex items-center justify-between">
          <span className="eyebrow">Active Fleet</span>
          <span className="flex items-center gap-1.5 text-[11px] font-semibold text-slate-400">
            <Led level={plantLevel} pulse />
            {plantStateLabel}
          </span>
        </div>
        <div className="mt-1.5 truncate text-[13px] font-semibold text-slate-100">
          {shownPlantName ?? "Solar Fleet Monitoring"}
        </div>
        <div className="mt-0.5 flex items-center gap-1 text-[11px] text-slate-500">
          <MapPin className="h-3 w-3" />
          <span className="truncate">{shownPlantPlace ?? "—"}</span>
        </div>
        <div className="mt-2.5 grid grid-cols-2 gap-2 border-t border-white/[0.05] pt-2.5 text-[11px]">
          <div>
            <div className="text-slate-500">DC Capacity</div>
            <div className="num font-semibold text-solar-400">{fmt(dcCapacityKwp, 1)} kWp</div>
          </div>
          <div>
            <div className="text-slate-500">Strings</div>
            <div className="num font-semibold text-slate-200">{sidebarStringCount}</div>
          </div>
        </div>
      </div>

      {/* Navigation */}
      <nav className="flex-1 space-y-4 overflow-y-auto px-3 pb-4">
        {NAV_GROUPS.map((group) => ({ ...group, items: group.items.filter(canSee) }))
          .filter((group) => group.items.length > 0)
          .map((group) => (
          <div key={group.title}>
            <div className="eyebrow px-3 pb-1.5">{group.title}</div>
            <div className="space-y-0.5">
              {group.items.map((item) => {
                const Icon = item.icon;
                // badges describe the open plant only
                const badge =
                  plantRoute && item.page === "" && alarmCount > 0
                    ? { n: alarmCount, cls: "bg-red-500/15 text-red-300 border-red-400/30" }
                    : plantRoute && item.page === "strings" && criticalStrings + warningStrings > 0
                    ? { n: criticalStrings + warningStrings, cls: "bg-amber-500/15 text-amber-300 border-amber-400/30" }
                    : null;
                const href = hrefOf(item);
                if (href == null) {
                  return (
                    <div
                      key={item.label}
                      title="Open a plant from All Plants first"
                      className="flex cursor-not-allowed items-center gap-2.5 rounded-lg px-3 py-2 text-[13px] font-medium text-slate-600"
                    >
                      <Icon className="h-4 w-4 shrink-0" />
                      <span className="flex-1 truncate">{item.label}</span>
                    </div>
                  );
                }
                return (
                  <NavLink
                    key={item.label}
                    to={href}
                    end={item.to === "/" || item.page === ""}
                    className={({ isActive }) =>
                      `group relative flex items-center gap-2.5 rounded-lg px-3 py-2 text-[13px] font-medium transition ${
                        isActive
                          ? "bg-solar-500/15 text-white"
                          : "text-slate-400 hover:bg-white/[0.04] hover:text-slate-100"
                      }`
                    }
                  >
                    {({ isActive }) => (
                      <>
                        {isActive && <span className="absolute inset-y-1.5 left-0 w-[3px] rounded-r bg-solar-400 shadow-[0_0_10px_rgba(245,180,42,0.8)]" />}
                        <Icon className={`h-4 w-4 shrink-0 ${isActive ? "text-solar-400" : "text-slate-500 group-hover:text-slate-300"}`} />
                        <span className="flex-1 truncate">{item.label}</span>
                        {badge && (
                          <span className={`num rounded-full border px-1.5 py-px text-[11px] font-bold ${badge.cls}`}>{badge.n}</span>
                        )}
                      </>
                    )}
                  </NavLink>
                );
              })}
            </div>
          </div>
        ))}
      </nav>

      {/* User */}
      <div className="flex items-center gap-3 border-t border-white/[0.06] px-4 py-3">
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-energy-500/20 text-[11px] font-bold text-energy-300 ring-1 ring-energy-400/30">
          {initials}
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-xs font-semibold text-slate-100">{user?.full_name}</div>
          <div className="truncate text-[11px] uppercase tracking-wider text-slate-500">
            {user ? `${user.username ?? user.email} · ${user.role}` : ""}
          </div>
        </div>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon" onClick={logout} aria-label="Sign out">
              <LogOut className="h-3.5 w-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Sign out</TooltipContent>
        </Tooltip>
      </div>
    </aside>
  );

  return (
    <div className="flex min-h-screen text-slate-200">
      {/* Desktop sidebar */}
      <div className="sticky top-0 hidden h-screen shrink-0 lg:block">{sidebar}</div>

      {/* Mobile sidebar */}
      {mobileNavOpen && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={() => setMobileNavOpen(false)} />
          <div className="absolute inset-y-0 left-0">{sidebar}</div>
        </div>
      )}

      {/* Main */}
      <div className="flex min-w-0 flex-1 flex-col">
        {/* Top bar */}
        <header className="sticky top-0 z-30 border-b border-white/[0.06] bg-ink-950/80 backdrop-blur-xl">
          <div className="flex h-14 items-center gap-3 px-4 sm:px-6">
            <Button variant="ghost" size="icon" className="lg:hidden" onClick={() => setMobileNavOpen(true)} aria-label="Open navigation">
              <Menu className="size-5" />
            </Button>

            <div className="min-w-0 flex-1">
              <div className="flex min-w-0 items-center gap-2 whitespace-nowrap text-[11px] text-slate-500">
                <span className="hidden min-w-0 truncate sm:inline">
                  {shownPlantName ?? "Solar Fleet"}
                </span>
                <span className="hidden sm:inline text-slate-700">/</span>
                <span className="shrink-0 font-semibold text-slate-200">{current?.label || "Monitoring"}</span>
              </div>
              {current?.description && (
                <div className="hidden truncate text-[11px] text-slate-500 md:block">{current.description}</div>
              )}
            </div>

            {/* Link status */}
            <div className="hidden shrink-0 items-center gap-2 rounded-full border border-emerald-400/20 bg-emerald-400/[0.06] px-3 py-1 text-[11px] font-semibold text-emerald-300 lg:flex">
              <Radio className="h-3.5 w-3.5" />
              {loading ? "SYNCING" : error ? "LINK ERROR" : "DATA LINK ONLINE"}
            </div>

            {/* Clock */}
            <div className="hidden shrink-0 items-center gap-1.5 rounded-full border border-white/[0.07] bg-ink-900/80 px-3 py-1 text-[11px] text-slate-300 sm:flex">
              <Clock className="h-3.5 w-3.5 text-slate-500" />
              <span className="num">
                {now.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit", timeZone: "Asia/Bangkok" })}
              </span>
              <span className="text-slate-500">ICT</span>
            </div>

            {/* Quick Jump / Command Palette (⌘K) */}
            <button
              onClick={() => setCmdOpen(true)}
              className="hidden shrink-0 cursor-pointer items-center gap-2 rounded-full border border-white/[0.08] bg-ink-900/90 px-2 py-1 text-[11px] text-slate-400 transition hover:border-solar-400/40 hover:text-slate-200 sm:flex lg:px-3"
              title="Command Palette (⌘K)"
              aria-label="Quick Jump"
            >
              <Search className="h-3.5 w-3.5 text-solar-400" />
              <span className="hidden lg:inline">Quick Jump…</span>
              <kbd className="num hidden rounded border border-white/10 bg-ink-850 px-1.5 py-px text-[11px] text-slate-400 lg:inline">
                ⌘K
              </kbd>
            </button>

            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="ghost" size="icon" onClick={() => refreshAll()} aria-label="Refresh plant data">
                  <RefreshCw className={`size-4 ${loading ? "animate-spin" : ""}`} />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Refresh plant data</TooltipContent>
            </Tooltip>

            {isAdmin(user) && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => {
                      ensureLegacy(); // the drawer edits the legacy analysis plant: load it now
                      setSpecsOpen(true);
                    }}
                    aria-label="Quick plant parameters"
                  >
                    <SlidersHorizontal className="size-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Quick plant parameters</TooltipContent>
              </Tooltip>
            )}

            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => setAlarmsOpen(true)}
                  className="relative"
                  aria-label="Open SCADA Alarm Center"
                >
                  <Bell className="size-4" />
                  {alarmCount > 0 && (
                    <span className="num absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-bold text-white shadow-[0_0_8px_rgba(239,68,68,0.8)]">
                      {alarmCount}
                    </span>
                  )}
                </Button>
              </TooltipTrigger>
              <TooltipContent>Open SCADA Alarm Center</TooltipContent>
            </Tooltip>
          </div>
          {loading && (
            <div className="relative h-px overflow-hidden bg-transparent">
              <div className="absolute inset-y-0 w-1/3 animate-sweep bg-solar-400" />
            </div>
          )}
        </header>

        {error && (
          <div className="mx-4 mt-4 flex items-center gap-2 sm:mx-6 callout-crit">
            <AlertTriangle className="h-4 w-4 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        {user && !isAdmin(user) && user.plant_ids?.length === 0 && (
          <div className="mx-4 mt-4 flex items-center gap-2 sm:mx-6 callout-warn">
            <AlertTriangle className="h-4 w-4 shrink-0" />
            <span>No plants are assigned to your account yet. Ask an admin to assign the plants you work on.</span>
          </div>
        )}

        <main className="flex-1 px-4 py-6 sm:px-6">
          <div className="mx-auto max-w-[1600px]">
            <Suspense fallback={<LoadingState label="Loading page…" />}>
              <Outlet />
            </Suspense>
          </div>
        </main>
      </div>

      {/* Quick plant parameters drawer */}
      {specsOpen && isAdmin(user) && (
        <div className="fixed inset-0 z-50 flex justify-end">
          <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={() => setSpecsOpen(false)} />
          <div className="relative flex h-full w-full max-w-sm flex-col border-l border-white/[0.08] bg-ink-900 shadow-2xl">
            <div className="flex items-center justify-between border-b border-white/[0.06] px-5 py-4">
              <div>
                <div className="flex items-center gap-2 text-sm font-semibold text-white">
                  <SlidersHorizontal className="h-4 w-4 text-solar-400" />
                  Quick Plant Parameters
                </div>
                <div className="mt-0.5 text-[11px] text-slate-500">Changes trigger a full PR & loss recalculation</div>
              </div>
              <Button variant="ghost" size="icon" onClick={() => setSpecsOpen(false)} aria-label="Close">
                <X className="size-4" />
              </Button>
            </div>
            <div className="flex-1 space-y-4 overflow-y-auto p-5">
              <div className="rounded-xl border border-solar-400/20 bg-solar-500/[0.06] p-4">
                <div className="eyebrow text-solar-400/80">Calculated DC Capacity</div>
                <div className="num mt-1 text-2xl font-bold text-solar-400">
                  {fmt(draftCapacityKwp, 1)} <span className="text-sm text-slate-500">kWp</span>
                </div>
                <div className="mt-0.5 text-[11px] text-slate-500">Sum of {stringSpecs.length} string specs</div>
              </div>
              {customStrings > 0 && (
                <div className="callout-warn text-[11px] leading-relaxed">
                  Strings have different sizes ({Math.min(...moduleCounts)}–{Math.max(...moduleCounts)} modules).
                  The values below are the plant defaults: they apply to the {stringSpecs.length - customStrings}{" "}
                  strings on the default; the {customStrings} strings set individually keep their own values. Edit
                  those under{" "}
                  <NavLink to="/settings" className="font-semibold text-solar-400 underline" onClick={() => setSpecsOpen(false)}>
                    Global Settings → Legacy analysis plant
                  </NavLink>
                  .
                </div>
              )}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label className="mb-1 block text-[11px] font-medium text-slate-400">{customStrings > 0 ? "Default Modules / String" : "Modules / String"}</Label>
                  <Input type="number" value={modulesPerString} onChange={(e) => setModulesPerString(Number(e.target.value))} />
                </div>
                <div>
                  <Label className="mb-1 block text-[11px] font-medium text-slate-400">{customStrings > 0 ? "Default Module Wp" : "Module Rating (Wp)"}</Label>
                  <Input type="number" value={moduleWp} onChange={(e) => setModuleWp(Number(e.target.value))} />
                </div>
                <div>
                  <Label className="mb-1 block text-[11px] font-medium text-slate-400">Target PR (%)</Label>
                  <Input type="number" step="0.5" value={targetPrPct} onChange={(e) => setTargetPrPct(Number(e.target.value))} />
                </div>
                <div>
                  <Label className="mb-1 block text-[11px] font-medium text-slate-400">Tariff (THB/kWh)</Label>
                  <Input type="number" step="0.1" value={tariffThb} onChange={(e) => setTariffThb(Number(e.target.value))} />
                </div>
              </div>
              <div>
                <div className="mb-1 flex justify-between text-[11px]">
                  <span className="text-slate-400">Underperformance Alert Threshold</span>
                  <span className="num font-semibold text-solar-400">{underperfThresh}%</span>
                </div>
                <input
                  type="range"
                  min={5}
                  max={25}
                  step={1}
                  value={underperfThresh}
                  onChange={(e) => setUnderperfThresh(Number(e.target.value))}
                  className="w-full"
                />
              </div>
            </div>
            <div className="border-t border-white/[0.06] p-5">
              <Button variant="default" onClick={handleApplySidebarSpecs} disabled={savingConfig} className="h-auto w-full py-2.5">
                <Save className="size-4" />
                {savingConfig ? "Recalculating…" : "Apply & Recalculate"}
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Global Slide-Over Drawers & Command Palette */}
      <StringInspectorDrawer />
      <AlarmCenterDrawer open={alarmsOpen} onClose={() => setAlarmsOpen(false)} />
      <CommandPaletteModal
        open={cmdOpen}
        onClose={() => setCmdOpen(false)}
        onOpenSpecs={() => {
          ensureLegacy();
          setSpecsOpen(true);
        }}
        onOpenAlarms={() => setAlarmsOpen(true)}
        onSignOut={logout}
      />
    </div>
  );
};
