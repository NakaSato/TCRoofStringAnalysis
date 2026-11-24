/**
 * Plant directory hero: fleet KPIs, plant status donut, today's alarms donut and the right-edge toolbar.
 * Realtime: current power, total yield, yield / revenue today, plant status and inverters by their
 * newest record (`maxs_data` snapshot) (live polls, never stored). The alarm donut is the worker's stored alarm log, labelled with its sync time; the live
 * count of faulty plants sits above it.
 */
import React from "react";
import { Link } from "react-router-dom";
import { Zap, Gauge, Cpu, Settings, ChevronRight, ChevronUp, Sun, Activity, Coins, Info, AlertCircle, Bell, LayoutGrid, Eye } from "lucide-react";
import { getLastPlantId } from "../../context/routes";
import { Led, fmt, fmtInt } from "../ui";
import { Spinner } from "@/components/ui/spinner";
import { Button } from "@/components/ui/button";
import type { FleetDirectory } from "./useFleetDirectory";
import { MultiSegmentDonut } from "./parts";
import { useI18n } from "../../i18n";

const hhmmLocal = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

export const HeroBanner: React.FC<{ d: FleetDirectory }> = ({ d }) => {
  const { selectGrowattPlant, statusFilter, setStatusFilter, showInspectorDrawer, setShowInspectorDrawer, heroMetrics, growattLiveStatus } = d;
  const { t } = useI18n();
  const yl = heroMetrics.yieldLive;
  const sweeping = yl.checked < yl.total;
  const kpiFresh = yl.loading || growattLiveStatus.loading
    ? { level: "off" as const, text: t("Loading…"), busy: true }
    : yl.stale || growattLiveStatus.stale
      ? { level: "warn" as const, text: `${t("Last sync")}${yl.fetchedAt ? ` · ${hhmmLocal(yl.fetchedAt)}` : ""}`, busy: false }
      : sweeping
        ? { level: "warn" as const, text: t("Checking {n}/{total}", { n: yl.checked, total: yl.total }), busy: true }
        : { level: "ok" as const, text: `${t("Live")}${yl.fetchedAt ? ` · ${hhmmLocal(yl.fetchedAt)}` : ""}`, busy: false };
  const il = heroMetrics.invLive;
  const invHint = t(
    "Live from Growatt (maxs_data, not stored): each inverter's newest record. Normal / waiting / fault = a record from today with that status; offline = no record today{other}. {n} of {total} inverters answered so far.",
    {
      other: il.other ? t("; {n} in another state", { n: il.other }) : "",
      n: fmtInt(il.answered),
      total: il.total != null ? fmtInt(il.total) : "—",
    }
  );
  const todayHint = t(
    "Live from Growatt (plant/data, not stored): {n} of {total} plants checked; a plant not checked yet or not reporting today counts as —",
    { n: yl.checked, total: yl.total }
  );
  return (
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
      <div className="relative grid grid-cols-1 divide-y divide-white/[0.08] xl:grid-cols-12 xl:divide-x xl:divide-y-0">
        {/* ---------------- COLUMN 1: Plant KPIs ---------------- */}
        <div className="min-w-0 p-5 xl:col-span-4 xl:p-6">
          <div className="mb-5 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <h3 className="text-sm font-semibold tracking-tight text-white">{t("Plant KPIs")}</h3>
              <span className="num inline-flex items-center gap-1.5 text-[11px] text-slate-400" title={todayHint}>
                {kpiFresh.busy ? <Spinner className="size-3" aria-hidden /> : <Led level={kpiFresh.level} pulse={kpiFresh.level === "ok"} />}
                {kpiFresh.text}
              </span>
              <Link
                to="/settings"
                title={t("Configure Plant KPIs & Tariff")}
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

          <div className="grid grid-cols-2 gap-x-4 gap-y-4">
            {/* 1. Current power */}
            <div className="flex min-w-0 items-start gap-3">
              <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-sky-400/30 bg-sky-400/10 text-sky-300">
                <Gauge className="h-4 w-4" />
              </div>
              <div className="min-w-0">
                <div className="flex flex-wrap items-baseline gap-x-1">
                  <span className="num text-lg font-bold text-white">
                    {fmt(heroMetrics.currentPowerKw, 2)}
                  </span>
                  <span className="text-[11px] text-slate-300">kW</span>
                </div>
                <div className="text-[11px] text-slate-400">{t("Current power")}</div>
              </div>
            </div>

            {/* 2. Yield today */}
            <div className="flex min-w-0 items-start gap-3">
              <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-amber-400/30 bg-amber-400/10 text-amber-300">
                <Sun className="h-4 w-4" />
              </div>
              <div className="min-w-0">
                <div className="flex flex-wrap items-baseline gap-x-1">
                  <span className="num text-lg font-bold text-white">
                    {fmt(heroMetrics.yieldTodayKwh, 2)}
                  </span>
                  <span className="text-[11px] text-slate-300">kWh</span>
                </div>
                <div className="flex items-center gap-1 text-[11px] text-slate-400">
                  {t("Yield today")}
                  <span title={todayHint}>
                    <Info className="h-3 w-3 text-slate-500" />
                  </span>
                </div>
              </div>
            </div>

            {/* 3. Revenue today */}
            <div className="flex min-w-0 items-start gap-3">
              <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-emerald-400/30 bg-emerald-400/10 text-emerald-300">
                <Coins className="h-4 w-4" />
              </div>
              <div className="min-w-0">
                <div className="flex flex-wrap items-baseline gap-x-1">
                  <span className="num text-lg font-bold text-white">
                    {fmt(heroMetrics.revenueTodayThb, 2)}
                  </span>
                  <span className="text-[11px] text-slate-300">฿</span>
                </div>
                <div className="flex items-center gap-1 text-[11px] text-slate-400">
                  {t("Revenue today")}
                  <span title={`${t("Estimated: each plant's live yield today × its own rate (PPA, or TOU weighted by its stored power today).")} ${todayHint}`}>
                    <Info className="h-3 w-3 text-slate-500" />
                  </span>
                </div>
              </div>
            </div>

            {/* 4. Inverter rated power */}
            <div className="flex min-w-0 items-start gap-3">
              <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-sky-400/30 bg-sky-400/10 text-sky-300">
                <Cpu className="h-4 w-4" />
              </div>
              <div className="min-w-0">
                <div className="flex flex-wrap items-baseline gap-x-1">
                  <span className="num text-lg font-bold text-white">
                    {fmt(heroMetrics.ratedPowerKwp, 2)}
                  </span>
                  <span className="text-[11px] text-slate-300">kW</span>
                </div>
                <div className="flex items-center gap-1 text-[11px] text-slate-400">
                  {t("Inverter rated power")}
                  <span title={t("Total installed rated capacity across monitored plants")}>
                    <Info className="h-3 w-3 text-slate-500" />
                  </span>
                </div>
              </div>
            </div>

            {/* 5. Inverters by their newest record (maxs_data snapshot, live) */}
            <div className="flex min-w-0 items-start gap-3">
              <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-emerald-400/30 bg-emerald-400/10 text-emerald-300">
                <Activity className="h-4 w-4" />
              </div>
              <div className="min-w-0">
                <div className="flex flex-wrap items-baseline gap-x-1">
                  <span className="num text-lg font-bold text-white">{il.answered ? fmtInt(il.normal) : "—"}</span>
                  <span className="text-[11px] text-slate-300">{t("normal")}</span>
                  {il.waiting > 0 && <span className="num text-[11px] text-amber-300">· {t("{n} waiting", { n: fmtInt(il.waiting) })}</span>}
                  {il.fault > 0 && <span className="num text-[11px] font-semibold text-red-300">· {t("{n} fault", { n: fmtInt(il.fault) })}</span>}
                  {il.offline > 0 && <span className="num text-[11px] text-slate-400">· {t("{n} offline", { n: fmtInt(il.offline) })}</span>}
                </div>
                <div className="flex items-center gap-1 text-[11px] text-slate-400">
                  {il.loading
                    ? `${t("Inverters")} · ${t("loading…")}`
                    : il.stale
                      ? `${t("Inverters")} · ${t("last sync")}${il.fetchedAt ? ` ${hhmmLocal(il.fetchedAt)}` : ""}`
                      : !il.complete
                        ? `${t("Inverters")} · ${t("checking {n}/{total}", { n: fmtInt(il.answered), total: il.total != null ? fmtInt(il.total) : "—" })}`
                        : t("Inverters")}
                  <span title={invHint}>
                    <Info className="h-3 w-3 text-slate-500" />
                  </span>
                </div>
              </div>
            </div>

            {/* 6. Total yield */}
            <div className="flex min-w-0 items-start gap-3">
              <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-cyan-400/30 bg-cyan-400/10 text-cyan-300">
                <Zap className="h-4 w-4" />
              </div>
              <div className="min-w-0">
                <div className="flex flex-wrap items-baseline gap-x-1">
                  <span className="num text-lg font-bold text-white">
                    {fmt(heroMetrics.totalYieldKwh, 2)}
                  </span>
                  <span className="text-[11px] text-slate-300">kWh</span>
                </div>
                <div className="flex items-center gap-1 text-[11px] text-slate-400">
                  {t("Total yield")}
                  <span title={t("Cumulative energy yield across monitored fleet")}>
                    <Info className="h-3 w-3 text-slate-500" />
                  </span>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* ---------------- COLUMN 2: Plant Status Donut ---------------- */}
        <div className="min-w-0 p-5 xl:col-span-4 xl:p-6">
          <div className="mb-3 flex items-center justify-between">
            <h3 className="text-sm font-semibold tracking-tight text-white">{t("Plant Status")}</h3>
            <Button
              variant="ghost"
              size="icon-xs"
              onClick={() => setStatusFilter("ALL")}
              title={t("Show all plants")}
              className="size-auto gap-0.5 rounded-none text-xs text-slate-300/80 hover:bg-transparent hover:text-white"
            >
              <ChevronRight className="size-4" />
            </Button>
          </div>

          <div className="flex items-center justify-center gap-8 pt-1">
            <MultiSegmentDonut
              totalValue={heroMetrics.totalPlants}
              centerLabel={t("Total plants")}
              segments={[
                { label: t("Normal"), value: heroMetrics.normalPlants, color: "#10b981" },
                { label: t("Faulty"), value: heroMetrics.faultyPlants, color: "#ef4444" },
                { label: t("Disconnected"), value: heroMetrics.disconnectedPlants, color: "#64748b" },
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
                  <div className="text-[11px] text-slate-400">{t("Normal")}</div>
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
                  <div className="text-[11px] text-slate-400">{t("Faulty")}</div>
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
                  <div className="text-[11px] text-slate-400">{t("Disconnected")}</div>
                </div>
              </button>
            </div>
          </div>
        </div>

        {/* ---------------- COLUMN 3: Active Alarms Donut ---------------- */}
        <div className="min-w-0 p-5 pr-14 xl:col-span-4 xl:p-6 xl:pr-14">
          <div className="mb-3 flex items-center justify-between">
            <div className="flex min-w-0 items-center gap-2">
              <h3 className="text-sm font-semibold tracking-tight text-white">{t("Active Alarms")}</h3>
              <Button
                variant="ghost"
                size="xs"
                onClick={() => setStatusFilter(statusFilter === "Faulty" ? "ALL" : "Faulty")}
                title={t("Plants Growatt reports as faulty right now (live plant status); click to list them")}
                className={`num h-auto gap-1.5 rounded-md px-1.5 py-0.5 text-[11px] font-normal hover:text-current ${
                  statusFilter === "Faulty" ? "bg-white/10 ring-1 ring-red-400/40" : "hover:bg-white/5"
                } ${heroMetrics.faultyPlants > 0 ? "text-red-300" : "text-slate-400"}`}
              >
                <Led
                  level={growattLiveStatus.loading ? "off" : heroMetrics.faultyPlants > 0 ? "crit" : "ok"}
                  pulse={!growattLiveStatus.loading && !growattLiveStatus.stale}
                />
                {growattLiveStatus.loading ? `${t("Live")} …` : t("{n} faulty now", { n: heroMetrics.faultyPlants })}
              </Button>
            </div>
            <Link
              to="/alarms"
              title={t("Open Active Alarm (whole fleet)")}
              className="inline-flex items-center gap-0.5 text-xs text-slate-300/80 transition hover:text-white"
            >
              <ChevronRight className="h-4 w-4" />
            </Link>
          </div>

          <div className="flex items-center justify-center gap-8 pt-1">
            <MultiSegmentDonut
              totalValue={heroMetrics.totalAlarms == null ? "—" : heroMetrics.totalAlarms}
              centerLabel={heroMetrics.alarmSyncedAt ? `${t("Log")} · ${hhmmLocal(heroMetrics.alarmSyncedAt)}` : t("Log today")}
              segments={[
                { label: t("Faults"), value: heroMetrics.faultCount ?? 0, color: "#ef4444" },
                { label: t("Warnings"), value: heroMetrics.warningCount ?? 0, color: "#f59e0b" },
                { label: t("Other"), value: heroMetrics.otherCount ?? 0, color: "#64748b" },
              ]}
            />

            <div className="grid grid-cols-1 gap-2">
              {[
                { label: t("Faults"), value: heroMetrics.faultCount, icon: Bell, cls: "border-red-400/40 bg-red-500/15 text-red-400" },
                { label: t("Warnings"), value: heroMetrics.warningCount, icon: AlertCircle, cls: "border-amber-400/40 bg-amber-500/15 text-amber-300" },
                { label: t("Other"), value: heroMetrics.otherCount, icon: Info, cls: "border-slate-400/40 bg-slate-500/15 text-slate-300" },
                { label: t("Still open"), value: heroMetrics.openCount, icon: Zap, cls: "border-sky-400/40 bg-sky-500/15 text-sky-300" },
              ].map((row) => {
                const Icon = row.icon;
                return (
                  <Link
                    key={row.label}
                    to="/alarms"
                    className="flex items-center gap-2.5 rounded-lg px-2 py-0.5 transition hover:bg-white/5"
                  >
                    <span className={`flex h-5 w-5 items-center justify-center rounded-full border ${row.cls}`}>
                      <Icon className="h-3 w-3" />
                    </span>
                    <div>
                      <div className="num text-xs font-bold leading-tight text-white">{fmtInt(row.value)}</div>
                      <div className="text-[11px] text-slate-400">{row.label}</div>
                    </div>
                  </Link>
                );
              })}
            </div>
          </div>
        </div>
      </div>

      {/* Floating Right-Edge Quick Mode Toolbar (matches FusionSolar right dock) */}
      <div className="absolute right-2 top-1/2 hidden -translate-y-1/2 flex-col gap-1 rounded-lg border border-white/15 bg-ink-900/90 p-1 shadow-xl backdrop-blur md:flex">
        <Button
          variant="ghost"
          size="icon-xs"
          onClick={() => setShowInspectorDrawer((v) => !v)}
          title={t("Toggle Selected Plant String Inspector Strip")}
          className={`size-auto rounded p-1.5 ${
            showInspectorDrawer ? "bg-sky-500/20 text-sky-300 hover:bg-sky-500/20 hover:text-sky-300" : "text-slate-400 hover:bg-white/10 hover:text-white"
          }`}
        >
          <LayoutGrid className="size-3.5" />
        </Button>
        <Button
          variant="ghost"
          size="icon-xs"
          onClick={() => {
            const last = getLastPlantId();
            if (last != null) selectGrowattPlant(last);
          }}
          disabled={getLastPlantId() == null}
          title={t("Open the last plant you viewed")}
          className="size-auto rounded p-1.5 text-slate-400 hover:bg-white/10 hover:text-white disabled:opacity-40"
        >
          <Eye className="size-3.5" />
        </Button>
        <Button
          variant="ghost"
          size="icon-xs"
          onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })}
          title={t("Scroll to top")}
          className="size-auto rounded p-1.5 text-slate-400 hover:bg-white/10 hover:text-white"
        >
          <ChevronUp className="size-3.5" />
        </Button>
      </div>
    </section>
  );
};
