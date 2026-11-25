import React, { Suspense, useState, useEffect, useMemo } from "react";
import { NavLink, Outlet, useLocation } from "react-router-dom";
import {
  BookOpen,
  Ruler,
  FileWarning,
  Settings,
  Bell,
  Menu,
  PanelLeftClose,
  PanelLeftOpen,
  Radio,
  Clock,
  LogOut,
  RefreshCw,
  AlertTriangle,
  Users,
  ScrollText,
  BellRing,
  CalendarDays,
  Building2,
  Gauge,
  Map as MapIcon,
  Sparkles,
  Banknote,
  Route as RouteIcon,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useAppContext } from "../context/AppContext";
import { canAccessPath, isAdmin } from "../auth/access";
import { api, type AssistantStatus } from "../api/client";
import { AssistantDrawer } from "./assistant/AssistantDrawer";
import { PushToggle } from "./PushToggle";
import { parsePlantPath } from "../context/routes";
import type { PlantPage } from "../context/routes";
import { Led, LoadingState, fmt, fmtInt } from "./ui";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Breadcrumb, BreadcrumbItem, BreadcrumbList, BreadcrumbPage, BreadcrumbSeparator } from "@/components/ui/breadcrumb";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { StringInspectorDrawer } from "./StringInspectorDrawer";
import { CommandPaletteModal, AlarmCenterDrawer } from "./CommandPaletteAndAlarms";
import { Spinner } from "@/components/ui/spinner";
import { LanguageToggle, useI18n } from "../i18n";

interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  description?: string;
}

const NAV_GROUPS: { title: string; items: NavItem[] }[] = [
  {
    title: "Monitoring",
    items: [
      { to: "/", label: "All Plants", icon: Building2, description: "Every plant you can see, with live status" },
      { to: "/map", label: "Plant Map", icon: MapIcon, description: "Every plant on one map, coloured by live status" },
    ],
  },
  {
    title: "Operations",
    items: [
      { to: "/energy-billing", label: "Energy & Billing", icon: Banknote, description: "Billed meter energy, finance and the meter / inverter checks of one period" },
      { to: "/curtailment", label: "Curtailment", icon: Gauge },
      { to: "/alarms", label: "Active Alarm", icon: BellRing, description: "Plants in alarm & today's Growatt alarm log" },
      { to: "/calendar", label: "Calendar", icon: CalendarDays, description: "Team O&M plan: cleaning rounds, PM & repairs by week and month" },
      { to: "/route", label: "Visit Route", icon: RouteIcon, description: "Plan a day of site visits: best order, drive times, Google Maps" },
      { to: "/claims", label: "Claims", icon: FileWarning, description: "Warranty & insurance claims: what failed, who has it, where it stands" },
      { to: "/tools", label: "Measuring Tools", icon: Ruler, description: "Drones, meters & testers: who has them, calibration & due dates" },
      { to: "/kb", label: "Knowledge Base", icon: BookOpen, description: "O&M manuals: SOPs, troubleshooting, alarm codes, equipment & safety" },
    ],
  },
  {
    title: "System",
    items: [
      { to: "/settings", label: "Settings", icon: Settings, description: "Fleet-wide module & settings for every plant" },
      { to: "/users", label: "Users & Access", icon: Users, description: "Accounts, roles & plant assignments" },
      { to: "/logs", label: "Logs", icon: ScrollText },
      { to: "/ai-usage", label: "AI Usage", icon: Sparkles, description: "AI Assistant spend against the monthly cap, per user" },
    ],
  },
];

/** The signed-in user's initials circle in the sidebar footer. */
const AVATAR_CLS = "ring-1 ring-energy-400/30 after:hidden";
const AVATAR_FALLBACK_CLS = "bg-energy-500/20 text-energy-300";

/** localStorage key: "1" = desktop sidebar collapsed to icons (key name kept so saved choices carry over). */
const NAV_COLLAPSED_KEY = "tcroof.navCollapsed";

/** Fleet pages not in the sidebar (reached by links, e.g. from Active Alarm or Weather Station).
 * Listed here only for the header breadcrumb. */
const HIDDEN_NAV: NavItem[] = [
  { to: "/sensors", label: "Weather Sensors", icon: Gauge, description: "Every weather sensor: status, last upload & newest reading" },
];

/** The tab title index.html starts with; each page puts its name in front of it. */
const APP_TITLE = document.title || "TC Roof";
const ALL_NAV = [...NAV_GROUPS.flatMap((g) => g.items), ...HIDDEN_NAV];

/** Plant pages: reached from the plant's own tab bar (`SelectedPlantBanner`), not the sidebar.
 * Listed here only for the header breadcrumb. */
const PLANT_NAV: Record<PlantPage, { label: string; description?: string }> = {
  "": { label: "Plant Overview" },
  performance: { label: "Generation & PR", description: "Daily / monthly yield, PR & loss waterfall" },
  inverters: { label: "Inverters", description: "Inverter status, MPPT, 5-minute profile & fault log" },
  sensors: { label: "Plant Sensors", description: "This plant's weather sensors: live status & newest reading" },
  strings: { label: "String Diagnostics", description: "String performance, heatmap & I-V / P-V curves" },
  string: { label: "String Analysis", description: "One string in depth: I-V / P-V, profile, mismatch by hour, daily energy" },
  "string-layout": { label: "String Layout", description: "Modules per string for each inverter" },
  maintenance: { label: "Maintenance", description: "Upcoming tasks and the site log (cleanings, repairs)" },
  documents: { label: "Documents", description: "As-built drawings, manuals for its equipment, SOPs and reports" },
  billing: { label: "Energy & Billing", description: "Billed meter energy against the contract, outages and O&M spend" },
};

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
    growattPlants,
    plantListLoaded,
    livePlant,
    growattLiveStatus,
    refreshAll,
    analysisRun,
    loading,
    error,
    selectedGrowattPlantId,
    selectedPlantOverview,
  } = useAppContext();
  const location = useLocation();
  const now = useClock();
  const { t, locale, lang } = useI18n();

  const [mobileNavOpen, setMobileNavOpen] = useState<boolean>(false);
  // desktop sidebar full / collapsed to icons (top-bar button or Ctrl/⌘+B); remembered per browser
  const [navCollapsed, setNavCollapsed] = useState<boolean>(() => {
    try {
      return localStorage.getItem(NAV_COLLAPSED_KEY) === "1";
    } catch {
      return false;
    }
  });
  const toggleNav = () =>
    setNavCollapsed((h) => {
      try {
        localStorage.setItem(NAV_COLLAPSED_KEY, h ? "0" : "1");
      } catch {
        /* storage blocked: the choice lasts this tab only */
      }
      return !h;
    });
  const [cmdOpen, setCmdOpen] = useState<boolean>(false);
  const [alarmsOpen, setAlarmsOpen] = useState<boolean>(false);
  // AI Assistant: shown only when the backend has a key and the user's role is enabled
  const [assistant, setAssistant] = useState<AssistantStatus | null>(null);
  const [assistantOpen, setAssistantOpen] = useState<boolean>(false);
  const assistantEnabled = !!assistant?.enabled;
  useEffect(() => {
    setAssistant(null);
    setAssistantOpen(false);
    if (!user) return;
    let alive = true;
    api
      .getAssistantStatus()
      .then((s) => alive && setAssistant(s))
      .catch(() => alive && setAssistant(null));
    return () => {
      alive = false;
    };
  }, [user?.id]);
  useEffect(() => {
    if (!assistantEnabled) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "j") {
        e.preventDefault();
        setAssistantOpen((o) => !o);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [assistantEnabled]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setCmdOpen((prev) => !prev);
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "b" && window.matchMedia("(min-width: 1024px)").matches) {
        e.preventDefault();
        toggleNav();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  useEffect(() => {
    setMobileNavOpen(false);
  }, [location.pathname]);

  const canSee = (n: NavItem) => canAccessPath(user, n.to);
  const plantRoute = parsePlantPath(location.pathname);
  const current = plantRoute
    ? plantRoute.page != null ? PLANT_NAV[plantRoute.page] : undefined
    : ALL_NAV.find((n) => (n.to === "/" ? location.pathname === "/" : location.pathname.startsWith(n.to)));
  // Browser tab title: the page's name (as in the header), then the app's own title from index.html.
  const pageTitle = current?.label ? t(current.label) : null;
  useEffect(() => {
    document.title = pageTitle ? `${pageTitle} · ${APP_TITLE}` : APP_TITLE;
  }, [pageTitle]);
  // Name / place of the plant in the URL; on fleet pages the legacy analysis plant, if loaded.
  const shownPlantName =
    selectedPlantOverview?.plant.name ??
    (activePlant && activePlant.name !== "TC Roof Solar PV Plant" ? activePlant.name : null);
  const kpis = analysisRun?.plant_kpis_json || {};
  const alarmCount = useMemo(
    () => (analysisRun?.anomalies_json || []).filter((a) => String(a.severity) === "Critical").length,
    [analysisRun]
  );
  // Fleet summary card: every plant the user may see. Status and power are live only (fleet poll);
  // a plant with no live record yet counts as neither online nor offline.
  const fleet = useMemo(() => {
    const live = growattPlants.map((p) => livePlant(p.plant_id));
    const known = live.filter((l) => l?.status != null);
    const powers = live.map((l) => l?.current_power_w).filter((w): w is number => w != null);
    const caps = growattPlants.map((p) => p.peak_power_kwp).filter((k): k is number => k != null);
    return {
      plants: growattPlants.length,
      online: known.length ? known.filter((l) => l!.status === 1).length : null,
      offline: known.length ? known.filter((l) => l!.status === 4).length : null,
      acKw: powers.length ? powers.reduce((a, w) => a + w, 0) / 1000 : null,
      dcKwp: caps.length ? caps.reduce((a, k) => a + k, 0) : null,
    };
  }, [growattPlants, livePlant]);
  const fleetLiveLabel = growattLiveStatus.loading
    ? t("Loading…")
    : !growattLiveStatus.fetchedAt
    ? t("Live unavailable")
    : `${growattLiveStatus.stale ? t("Last sync") : t("Live")} · ${new Date(growattLiveStatus.fetchedAt).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" })}`;
  const fleetLevel = !growattLiveStatus.fetchedAt || growattLiveStatus.stale ? "warn" : fleet.offline ? "crit" : "ok";

  const initials = (user?.full_name || "Guest")
    .split(" ")
    .map((p) => p[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();

  // compact = the desktop bar collapsed to an icon strip (names in tooltips)
  const renderSidebar = (compact: boolean) => (
    <aside
      className={`flex h-full flex-col border-r border-white/[0.06] bg-ink-900/95 backdrop-blur-xl transition-[width] duration-200 ease-out motion-reduce:transition-none ${
        compact ? "w-16" : "w-64"
      }`}
    >
      {/* Brand */}
      <div className={`flex items-center gap-3 pb-4 pt-5 ${compact ? "justify-center px-0" : "px-5"}`}>
        <img src="/favicon.svg" alt="TC Renewable" className="h-9 w-9 shrink-0 rounded-xl ring-1 ring-white/10" />
        {!compact && (
          <div className="min-w-0">
            <div className="text-sm font-extrabold tracking-tight text-white">GenZ Monitoring</div>
            <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-solar-400/80">{t("Control Center")}</div>
          </div>
        )}
      </div>

      {/* Fleet summary card (compact: status LED, figures in the tooltip) */}
      {compact ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <div
              className="mx-auto mb-3 flex h-8 w-10 items-center justify-center rounded-lg border border-white/[0.06] bg-ink-850/80"
              aria-label={`${t("Fleet")}: ${fleetLiveLabel}`}
            >
              <Led level={fleetLevel} pulse={!growattLiveStatus.stale && growattLiveStatus.fetchedAt != null} />
            </div>
          </TooltipTrigger>
          <TooltipContent side="right">
            <div className="font-semibold">{t("Fleet")} · {fleetLiveLabel}</div>
            <div>{plantListLoaded ? t("{n} plants", { n: fmtInt(fleet.plants) }) : "—"} · {t("Online")} {fmtInt(fleet.online)} · {t("Offline")} {fmtInt(fleet.offline)}</div>
            <div>AC {fmt(fleet.acKw, 1)} kW · DC {fmt(fleet.dcKwp, 1)} kWp</div>
          </TooltipContent>
        </Tooltip>
      ) : (
        <div className="mx-3 mb-3 rounded-xl border border-white/[0.06] bg-ink-850/80 p-3">
          <div className="flex items-center justify-between">
            <span className="eyebrow">{t("Fleet")}</span>
            <span className="flex items-center gap-1.5 text-[11px] font-semibold text-slate-400">
              <Led level={fleetLevel} pulse={!growattLiveStatus.stale && growattLiveStatus.fetchedAt != null} />
              {fleetLiveLabel}
            </span>
          </div>
          <div className="mt-1.5 text-[13px] font-semibold text-slate-100">
            {plantListLoaded ? t("{n} plants", { n: fmtInt(fleet.plants) }) : "—"}
          </div>
          <div className="mt-0.5 text-[11px] text-slate-500">
            {t("Online")} <span className="num font-semibold text-emerald-300">{fmtInt(fleet.online)}</span>
            {" · "}
            {t("Offline")} <span className="num font-semibold text-red-300">{fmtInt(fleet.offline)}</span>
          </div>
          <div className="mt-2.5 grid grid-cols-2 gap-2 border-t border-white/[0.05] pt-2.5 text-[11px]">
            <div>
              <div className="text-slate-500">{t("AC Power")}</div>
              <div className="num font-semibold text-energy-300">{fmt(fleet.acKw, 1)} kW</div>
            </div>
            <div>
              <div className="text-slate-500">{t("DC Capacity")}</div>
              <div className="num font-semibold text-solar-400">{fmt(fleet.dcKwp, 1)} kWp</div>
            </div>
          </div>
        </div>
      )}

      {/* Navigation */}
      {/* compact: no scrollbar gutter (an 8 px bar would push the icons off-centre); still scrolls */}
      <nav
        className={`flex-1 space-y-4 overflow-y-auto overflow-x-hidden pb-4 ${
          compact ? "px-0 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden" : "px-3"
        }`}
      >
        {NAV_GROUPS.map((group) => ({ ...group, items: group.items.filter(canSee) }))
          .filter((group) => group.items.length > 0)
          .map((group) => (
          <div key={group.title}>
            {compact ? (
              <div className="mx-4 mb-2 border-t border-white/[0.06]" aria-hidden />
            ) : (
              <div className="eyebrow px-3 pb-1.5">{t(group.title)}</div>
            )}
            <div className="space-y-0.5">
              {group.items.map((item) => {
                const Icon = item.icon;
                const link = (
                  <NavLink
                    key={item.label}
                    to={item.to}
                    end={item.to === "/"}
                    aria-label={compact ? t(item.label) : undefined}
                    className={({ isActive }) =>
                      `group relative flex items-center gap-2.5 rounded-lg py-2 text-[13px] font-medium transition ${
                        compact ? "mx-auto size-10 justify-center px-0 py-0" : "px-3"
                      } ${
                        isActive
                          ? "bg-white/[0.07] text-white ring-1 ring-inset ring-white/10"
                          : "text-slate-400 hover:bg-white/[0.04] hover:text-slate-100"
                      }`
                    }
                  >
                    {({ isActive }) => (
                      <>
                        {isActive && !compact && <span className="absolute inset-y-2 left-0 w-[3px] rounded-r bg-solar-400" />}
                        <Icon className={`h-4 w-4 shrink-0 ${isActive ? "text-solar-400" : "text-slate-500 group-hover:text-slate-300"}`} />
                        {!compact && <span className="flex-1 truncate">{t(item.label)}</span>}
                      </>
                    )}
                  </NavLink>
                );
                return compact ? (
                  <Tooltip key={item.label}>
                    {/* trigger on a wrapper: asChild on NavLink would stringify its className function */}
                    <TooltipTrigger asChild>
                      <div className="flex justify-center">{link}</div>
                    </TooltipTrigger>
                    <TooltipContent side="right">{t(item.label)}</TooltipContent>
                  </Tooltip>
                ) : (
                  link
                );
              })}
            </div>
          </div>
        ))}
      </nav>

      {/* User */}
      <div
        className={`flex items-center border-t border-white/[0.06] py-3 ${
          compact ? "flex-col gap-2 px-0" : "gap-3 px-4"
        }`}
      >
        {compact ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <Avatar className={AVATAR_CLS} aria-label={user?.full_name}>
                <AvatarFallback className={AVATAR_FALLBACK_CLS}>{initials}</AvatarFallback>
              </Avatar>
            </TooltipTrigger>
            <TooltipContent side="right">
              <div className="font-semibold">{user?.full_name}</div>
              <div>{user ? `${user.username ?? user.email} · ${t(user.role)}` : ""}</div>
            </TooltipContent>
          </Tooltip>
        ) : (
          <>
            <Avatar className={AVATAR_CLS}>
              <AvatarFallback className={AVATAR_FALLBACK_CLS}>{initials}</AvatarFallback>
            </Avatar>
            <div className="min-w-0 flex-1">
              <div className="truncate text-xs font-semibold text-slate-100">{user?.full_name}</div>
              <div className="truncate text-[11px] uppercase tracking-wider text-slate-500">
                {user ? `${user.username ?? user.email} · ${t(user.role)}` : ""}
              </div>
            </div>
          </>
        )}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon" onClick={logout} aria-label={t("Sign out")}>
              <LogOut className="h-3.5 w-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side={compact ? "right" : undefined}>{t("Sign out")}</TooltipContent>
        </Tooltip>
      </div>
    </aside>
  );

  return (
    <div className="flex min-h-screen text-slate-200">
      {/* Desktop sidebar */}
      <div className="sticky top-0 hidden h-screen shrink-0 lg:block">{renderSidebar(navCollapsed)}</div>

      {/* Mobile sidebar */}
      {mobileNavOpen && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={() => setMobileNavOpen(false)} />
          <div className="absolute inset-y-0 left-0">{renderSidebar(false)}</div>
        </div>
      )}

      {/* Main */}
      <div className="flex min-w-0 flex-1 flex-col">
        {/* Top bar */}
        <header className="sticky top-0 z-30 border-b border-white/[0.06] bg-ink-950/80 backdrop-blur-xl">
          <div className="flex h-14 items-center gap-1.5 px-3 sm:gap-3 sm:px-6">
            <Button variant="ghost" size="icon" className="lg:hidden" onClick={() => setMobileNavOpen(true)} aria-label={t("Open navigation")}>
              <Menu className="size-5" />
            </Button>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="hidden lg:inline-flex"
                  onClick={toggleNav}
                  aria-label={navCollapsed ? t("Expand left tab bar") : t("Collapse left tab bar")}
                  aria-pressed={!navCollapsed}
                >
                  {navCollapsed ? <PanelLeftOpen className="size-5" /> : <PanelLeftClose className="size-5" />}
                </Button>
              </TooltipTrigger>
              <TooltipContent>{t("Resize left tab bar")}</TooltipContent>
            </Tooltip>

            <div className="min-w-0 flex-1">
              <Breadcrumb>
                <BreadcrumbList className="flex-nowrap gap-2 whitespace-nowrap">
                  <BreadcrumbItem className="hidden min-w-0 sm:inline-flex">
                    <span className="truncate">{shownPlantName ?? t("Solar Fleet")}</span>
                  </BreadcrumbItem>
                  <BreadcrumbSeparator className="hidden sm:block">/</BreadcrumbSeparator>
                  <BreadcrumbItem className="min-w-0">
                    <BreadcrumbPage className="truncate" title={t(current?.label || "Monitoring")}>
                      {t(current?.label || "Monitoring")}
                    </BreadcrumbPage>
                  </BreadcrumbItem>
                </BreadcrumbList>
              </Breadcrumb>
              {current?.description && (
                <div className="hidden truncate text-[11px] text-slate-500 md:block">{t(current.description)}</div>
              )}
            </div>

            {/* Link status */}
            <div className="hidden shrink-0 items-center gap-2 rounded-full border border-emerald-400/20 bg-emerald-400/[0.06] px-3 py-1 text-[11px] font-semibold text-emerald-300 lg:flex">
              <Radio className="h-3.5 w-3.5" />
              {loading ? t("SYNCING") : error ? t("LINK ERROR") : t("DATA LINK ONLINE")}
            </div>

            {/* Clock */}
            <div className="hidden shrink-0 items-center gap-1.5 rounded-full border border-white/[0.07] bg-ink-900/80 px-3 py-1 text-[11px] text-slate-300 sm:flex">
              <Clock className="h-3.5 w-3.5 text-slate-500" />
              <span className="num text-slate-400">
                {now.toLocaleDateString(locale, { weekday: "short", day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Bangkok" })}
              </span>
              <span className="num">
                {now.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit", second: "2-digit", timeZone: "Asia/Bangkok" })}
              </span>
              <span className="text-slate-500">ICT</span>
            </div>

            {assistantEnabled && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => setAssistantOpen((o) => !o)}
                    aria-label={t("AI Assistant")}
                    aria-pressed={assistantOpen}
                    className={assistantOpen ? "text-solar-300" : undefined}
                  >
                    <Sparkles className="size-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>{t("AI Assistant (Ctrl/⌘ J)")}</TooltipContent>
              </Tooltip>
            )}

            <LanguageToggle />

            {user && <PushToggle user={user} />}

            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="ghost" size="icon" onClick={() => refreshAll()} aria-label={t("Refresh plant data")}>
                  {loading ? <Spinner /> : <RefreshCw className="size-4" />}
                </Button>
              </TooltipTrigger>
              <TooltipContent>{t("Refresh plant data")}</TooltipContent>
            </Tooltip>


            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => setAlarmsOpen(true)}
                  className="relative"
                  aria-label={t("Open SCADA Alarm Center")}
                >
                  <Bell className="size-4" />
                  {alarmCount > 0 && (
                    <span className="num absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-bold text-white shadow-[0_0_8px_rgba(239,68,68,0.8)]">
                      {alarmCount}
                    </span>
                  )}
                </Button>
              </TooltipTrigger>
              <TooltipContent>{t("Open SCADA Alarm Center")}</TooltipContent>
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
            <span>{t("No plants are assigned to your account yet. Ask an admin to assign the plants you work on.")}</span>
          </div>
        )}

        <main className="flex-1 px-4 py-6 sm:px-6">
          <div className="mx-auto max-w-[1600px]">
            {/* key = language: a switch remounts the page, so text made outside React (helpers using
                `translate`) follows it too; contexts above keep their data */}
            <Suspense key={lang} fallback={<LoadingState label={t("Loading page…")} shape="page" />}>
              <Outlet />
            </Suspense>
          </div>
        </main>
      </div>

      {/* Global Slide-Over Drawers & Command Palette */}
      <StringInspectorDrawer />
      <AlarmCenterDrawer open={alarmsOpen} onClose={() => setAlarmsOpen(false)} />
      {assistantEnabled && user && (
        <AssistantDrawer
          key={user.id}
          open={assistantOpen}
          onClose={() => setAssistantOpen(false)}
          userId={user.id}
          model={assistant?.model}
        />
      )}
      <CommandPaletteModal
        open={cmdOpen}
        onClose={() => setCmdOpen(false)}
        onOpenAlarms={() => setAlarmsOpen(true)}
        onSignOut={logout}
      />
    </div>
  );
};
