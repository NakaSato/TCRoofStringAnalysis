/**
 * String Analysis (`/plant/:id/string?sn=&no=`): one string in depth, for a stored day, a day
 * range and/or a time-of-day window (URL `day`, `to`, `from_t`, `to_t`). Stored data only
 * (`useStringDetail`); the newest live record appears only in the "Now" pill.
 *
 * Layout: one header card (string, inverter SN, MPPT, modules; period picker, CSV; the inverter's
 * strings as chips + the live "Now" pill; the overview diagnosis or what the period covers), the
 * period's figures as `overview/StatTile`s, then line tabs (URL `tab`):
 * - Analysis: I-V / P-V (modelled curves, measured dots), profile with peers (current, power,
 *   voltage), current mismatch per slot and by hour of day (thresholds of the live string check),
 *   daily energy for a range.
 * - Decision rules (`StringRulesPanel`), I-V sweeps (`StringIvSweepPanel`): mounted only when open.
 * - Inverter strings (overview day) and Records (paged; CSV in the header).
 * A period without stored records shows one empty state with the way to a day that has some.
 */
import React, { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Activity, AlertTriangle, ArrowLeft, CalendarSearch, Check, CheckCircle2, Copy, Download, Info, Sparkles } from "lucide-react";
import { useAppContext, usePlantHref } from "../context/AppContext";
import { plantToday } from "../context/alarmLogStore";
import { pick, useUrlState } from "@/lib/useUrlState";
import { cn } from "@/lib/utils";
import { PanelChart } from "../components/PanelChart";
import type { PanelChartSpec } from "../components/PanelChart";
import { ivPvSpecFrom, stringDailySpecFrom } from "../components/ivPvSpec";
import { SelectedPlantBanner } from "../components/SelectedPlantBanner";
import { EmptyState, Led, LoadingState, Panel, SkeletonKpis, StatusBadge, Suspended, fmt, statusLevel } from "../components/ui";
import { TablePager, pageBounds } from "../components/TablePager";
import { Meter, StatTile } from "./overview/StatTile";
import { StringPeriodPicker } from "../components/stringDetail/StringPeriodPicker";
import { useStringDetail } from "../components/stringDetail/useStringDetail";
import { StringRulesPanel } from "../components/stringDetail/StringRulesPanel";
import { StringIvSweepPanel } from "../components/stringDetail/StringIvSweepPanel";
import { NEWEST, daysBetween, shiftDay, isWindowed, periodDayText, periodFromQuery, periodToQuery, slotTime, windowText } from "../components/stringDetail/period";
import type { StringPeriod } from "../components/stringDetail/period";
import {
  DEV_CRIT_PCT,
  DEV_WARN_PCT,
  MISMATCH_MIN_PEER_A,
  byHour,
  currentDev,
  detailCsv,
  deviationSpec,
  fullProfileSpec,
  hourSpec,
  mismatchFacts,
} from "../components/stringDetail/analysis";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useI18n } from "../i18n";

const RECORDS_PAGE = 25;
const TABS = ["analysis", "rules", "iv", "strings", "records"] as const;
type Tab = (typeof TABS)[number];
const TAB_LABEL: Record<Tab, string> = {
  analysis: "Analysis",
  rules: "Decision rules",
  iv: "I-V sweeps",
  strings: "Inverter strings",
  records: "Records",
};

const hm = (ts: string | null) => (ts ? ts.slice(11, 16) : "—");
const signed = (v: number | null, d = 1) => (v == null ? "—" : `${v >= 0 ? "+" : ""}${fmt(v, d)}`);
const devTone = (d: number | null) => (d == null ? "text-slate-400" : d <= DEV_CRIT_PCT ? "text-red-400" : d <= DEV_WARN_PCT ? "text-amber-400" : "text-emerald-400");
const strLabel = (no: number) => `STR-${String(no).padStart(2, "0")}`;

/** One figure of the mismatch facts strip. */
const Fact: React.FC<{ label: string; value: React.ReactNode; sub?: React.ReactNode; tone?: string }> = ({ label, value, sub, tone }) => (
  <div className="bg-ink-900 px-3.5 py-2.5">
    <div className="truncate text-[11px] text-slate-500">{label}</div>
    <div className={cn("num mt-0.5 text-base font-semibold", tone ?? "text-white")}>{value}</div>
    {sub && <div className="num mt-0.5 text-[11px] text-slate-400">{sub}</div>}
  </div>
);

export const StringDetailPage: React.FC = () => {
  const { selectedGrowattPlantId, selectedPlantOverview, plantOverviewLoading, activePlant } = useAppContext();
  const { t } = useI18n();
  const navigate = useNavigate();
  const plantHref = usePlantHref();
  const [query, setQuery] = useUrlState();
  const sn = query.get("sn");
  const noRaw = query.get("no");
  const stringNo = noRaw && /^\d+$/.test(noRaw) ? Number(noRaw) : null;
  const period = periodFromQuery(query);
  const setPeriod = (p: StringPeriod) => setQuery(periodToQuery(p));
  const tab = pick(query.get("tab"), TABS, "analysis");
  const setTab = (v: Tab) => setQuery({ tab: v === "analysis" ? null : v });
  const [copied, setCopied] = useState(false);
  const [recPage, setRecPage] = useState(0);

  const { detail, error, loading } = useStringDetail(selectedGrowattPlantId, sn, stringNo, period);

  const strings = selectedPlantOverview?.strings ?? [];
  const row = strings.find((s) => s.device_sn === sn && s.string_no === stringNo) ?? null;
  const peers = strings.filter((s) => s.device_sn === sn).sort((a, b) => a.string_no - b.string_no);
  const today = plantToday();
  const ovDay = selectedPlantOverview?.meta.day ?? null;

  const day = detail?.meta.day ?? period.day ?? today;
  const endDay = detail ? (detail.meta.end_day ?? null) : period.endDay;
  const ranged = Boolean(endDay && endDay !== day);
  const windowed = isWindowed(period);
  const winText = windowText(period);
  const periodText = day ? periodDayText(day, endDay, today) : null;
  /** the overview's own day and whole day: its diagnosis and status apply */
  const overviewPeriod = !ranged && !windowed && day != null && day === ovDay;
  /** the period was read and has no stored records */
  const noData = !loading && !detail && error != null;
  const s = detail?.summary;
  const tariff = activePlant?.tariff_thb_per_kwh ?? selectedPlantOverview?.kpis.tariff_thb_per_kwh ?? null;

  const hours = useMemo(() => (detail ? byHour(detail) : []), [detail]);
  const facts = useMemo(() => (detail ? mismatchFacts(detail, hours) : null), [detail, hours]);
  const ivSpec = useMemo(() => (detail ? ivPvSpecFrom(detail.iv_pv_curve) : null), [detail]);
  const profileSpec = useMemo(() => (detail ? fullProfileSpec(detail) : null), [detail]);
  const devSpec = useMemo(() => (detail ? deviationSpec(detail) : null), [detail]);
  const hSpec = useMemo(() => hourSpec(hours), [hours]);
  const dailySpec = useMemo(() => (detail ? stringDailySpecFrom(detail) : null), [detail]);

  const energy = s?.energy_kwh ?? null;
  const peerEnergy = s?.peer_energy_kwh ?? null;
  const energyDiff = energy != null && peerEnergy != null ? energy - peerEnergy : null;
  const peakRow = detail?.timeseries.length ? detail.timeseries.reduce((a, b) => (b.power_w > a.power_w ? b : a)) : null;
  /** entered nameplate of the string (String Layout), W */
  const ratedW = detail?.modules != null && detail.module_wp ? detail.modules * detail.module_wp : null;
  const peakPct = ratedW && s?.p_max_w != null ? (s.p_max_w / ratedW) * 100 : null;

  const go = (deviceSn: string, no: number) => {
    const q = new URLSearchParams({ sn: deviceSn, no: String(no) });
    for (const [k, v] of Object.entries(periodToQuery(period))) if (v) q.set(k, v);
    if (tab !== "analysis") q.set("tab", tab);
    navigate(`${plantHref("string")}?${q}`);
  };
  const zoomTo = (lo: number, hi: number) => {
    if (!day || ranged) return;
    setPeriod({ ...period, start: slotTime(lo, day, false), end: slotTime(hi, day, true) });
  };
  const copySn = () => {
    if (!sn) return;
    void navigator.clipboard?.writeText(sn).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    });
  };
  const exportCsv = () => {
    if (!detail) return;
    const blob = new Blob([`# ${detail.plant_name} · ${detail.string_id} · ${periodText}${winText ? ` ${winText}` : ""} · stored records, plant-local time\n${detailCsv(detail)}\n`], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `string_${detail.device_sn}_STR${String(detail.string_no).padStart(2, "0")}_${day}${ranged ? `_${endDay}` : ""}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  // records, newest first, paged; back to page 1 for another string or period
  useEffect(() => setRecPage(0), [sn, stringNo, period.day, period.endDay, period.start, period.end]);
  const records = useMemo(() => (detail ? [...detail.timeseries].reverse() : []), [detail]);
  const { pageNo } = pageBounds(records.length, RECORDS_PAGE, recPage);
  const pageRecords = records.slice(pageNo * RECORDS_PAGE, (pageNo + 1) * RECORDS_PAGE);

  const loadingLabel = t("Loading {period}…", { period: `${periodText ?? t("the newest stored day")}${winText ? ` ${winText}` : ""}` });
  const chart = (spec: PanelChartSpec | null, height: number, empty: string, onBrush?: (lo: number, hi: number) => void) =>
    loading && !detail ? (
      <LoadingState label={loadingLabel} shape="chart" className="border-0 bg-transparent p-0 shadow-none" />
    ) : spec ? (
      <Suspended busy={loading} pill="center">
        <PanelChart spec={spec} height={height} onBrush={onBrush} legendToggle />
      </Suspended>
    ) : (
      <EmptyState icon={Activity} title={t("Nothing to draw")} description={empty} className="py-10" />
    );

  if (!sn || stringNo == null) {
    return (
      <div className="space-y-6">
        <SelectedPlantBanner />
        <EmptyState icon={AlertTriangle} title={t("No string selected")} description={t("Open a string from String Diagnostics.")} />
        <Button onClick={() => navigate(plantHref("strings"))}>
          <ArrowLeft data-icon="inline-start" className="h-3.5 w-3.5" /> {t("String Diagnostics")}
        </Button>
      </div>
    );
  }

  const lvl = row ? statusLevel(row.status) : "neutral";
  const stringLabel = strLabel(stringNo);
  const mpptLabel = row?.mppt_id ?? (detail ? `MPPT-${detail.mppt_no}` : null);
  const live = row?.live_current_a != null ? row : null;

  /* ------------------------------------------------------------------ header */
  const header = (
    <Card className="gap-0 overflow-hidden py-0">
      {/* identity + period + actions */}
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3 px-4 pb-3 pt-4 sm:px-5">
        <div className="flex min-w-0 items-start gap-2.5">
          <Button
            variant="ghost"
            size="icon-sm"
            className="mt-0.5"
            onClick={() => navigate(plantHref("strings"))}
            aria-label={t("Back to String Diagnostics")}
            title={t("Back to String Diagnostics")}
          >
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="num text-2xl font-bold leading-tight tracking-tight text-white">{stringLabel}</h1>
              {row && overviewPeriod && <StatusBadge status={row.status} />}
            </div>
            <div className="num mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-slate-400">
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="xs"
                    onClick={copySn}
                    aria-label={t("Copy inverter SN {sn}", { sn })}
                    className="group -mx-1 h-auto gap-1 rounded px-1 text-[length:inherit] font-medium text-slate-200 hover:bg-white/[0.06] hover:text-slate-200"
                  >
                    {sn}
                    {copied ? <Check className="size-3 text-emerald-400" /> : <Copy className="size-3 text-slate-500 opacity-60 group-hover:opacity-100" />}
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="bottom">{copied ? t("Copied") : t("Click to copy the inverter SN")}</TooltipContent>
              </Tooltip>
              {mpptLabel && (
                <>
                  <span className="text-slate-600">·</span>
                  <span>{mpptLabel}</span>
                </>
              )}
              {detail?.modules != null && (
                <>
                  <span className="text-slate-600">·</span>
                  <span>
                    {t("{n} modules", { n: detail.modules })}
                    {detail.module_wp ? ` × ${fmt(detail.module_wp, 0)} Wp` : ""}
                  </span>
                </>
              )}
            </div>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <StringPeriodPicker
            period={period}
            onChange={setPeriod}
            shownDay={detail?.meta.day ?? today}
            shownEndDay={detail?.meta.end_day ?? null}
            today={today}
            loading={loading}
            hint={t("Or drag across the 5-min profile chart.")}
          />
          <Tooltip>
            <TooltipTrigger asChild>
              <span tabIndex={0} aria-label={t("AI Analysis (coming soon)")}>
                <Button variant="outline" size="sm" disabled className="pointer-events-none gap-1.5 border-violet-400/40 text-violet-200 disabled:opacity-80">
                  <Sparkles data-icon="inline-start" className="h-3.5 w-3.5 text-violet-300" />
                  {t("AI Analysis")}
                </Button>
              </span>
            </TooltipTrigger>
            <TooltipContent side="bottom">{t("Coming soon: a written diagnosis of this string's period")}</TooltipContent>
          </Tooltip>
          <Button variant="outline" size="sm" onClick={exportCsv} disabled={!detail} title={t("Stored records of the period as CSV")}>
            <Download data-icon="inline-start" className="h-3.5 w-3.5" /> CSV
          </Button>
        </div>
      </div>

      {/* the inverter's strings + the live record */}
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-t border-white/[0.06] bg-ink-950/40 px-4 py-2 sm:px-5">
        <div className="flex w-full min-w-0 items-center gap-2 sm:w-auto sm:flex-1">
          <span className="hidden shrink-0 text-[11px] text-slate-500 sm:inline">{t("Inverter strings")}</span>
          <div className="flex min-w-0 gap-1 overflow-x-auto py-0.5" role="list">
            {peers.map((p) => {
              const active = p.string_no === stringNo;
              const pl = statusLevel(p.status);
              return (
                <Button
                  key={p.string_id}
                  type="button"
                  variant="outline"
                  size="xs"
                  role="listitem"
                  onClick={() => go(p.device_sn, p.string_no)}
                  aria-current={active ? "true" : undefined}
                  title={`${p.string_id} · ${t(p.status)} (${ovDay ?? t("overview day")}) · ${t("I mismatch")} ${signed(p.current_mismatch_pct)}%`}
                  className={cn(
                    "num h-auto shrink-0 gap-1.5 rounded-md px-2 py-1 text-[11px]",
                    active
                      ? "border-solar-400/60 bg-solar-500/15 text-solar-300"
                      : "border-white/[0.06] bg-ink-900 text-slate-400 hover:border-white/20 hover:bg-ink-900 hover:text-slate-200"
                  )}
                >
                  <Led level={pl === "info" || pl === "neutral" ? "ok" : pl} />
                  {String(p.string_no).padStart(2, "0")}
                </Button>
              );
            })}
            {peers.length === 0 && <span className="text-[11px] text-slate-500">{plantOverviewLoading ? t("Loading the overview…") : "—"}</span>}
          </div>
        </div>
        <div
          className={cn(
            "num inline-flex shrink-0 items-center gap-2 rounded-full border px-2.5 py-1 text-[11px]",
            live ? "border-sky-400/25 bg-sky-400/[0.06]" : "border-white/[0.06] bg-white/[0.02]"
          )}
          title={row?.live_reason ?? undefined}
        >
          <span className="relative flex size-1.5">
            {live && <span className="absolute inline-flex size-full animate-ping rounded-full bg-sky-400 opacity-60 motion-reduce:hidden" />}
            <span className={cn("relative inline-flex size-1.5 rounded-full", live ? "bg-sky-400" : "bg-slate-600")} />
          </span>
          {live ? (
            <>
              <span className="font-semibold text-sky-300">{t("Now {time}", { time: hm(live.live_at ?? null) })}</span>
              <span className="text-slate-200">{fmt(live.live_voltage_v, 0)} V</span>
              <span className="text-slate-200">{fmt(live.live_current_a, 2)} A</span>
              <span className="text-slate-200">{fmt(live.live_power_w == null ? null : live.live_power_w / 1000, 2)} kW</span>
              {live.live_status && <StatusBadge status={live.live_status} />}
            </>
          ) : (
            <span className="text-slate-500">
              {t("Now")} · {t("no live record")}
            </span>
          )}
        </div>
      </div>

      {/* what the figures cover */}
      {plantOverviewLoading && !selectedPlantOverview ? null : overviewPeriod && row ? (
        <div
          className={cn(
            "flex items-start gap-2.5 border-t px-4 py-2.5 text-xs sm:px-5",
            lvl === "crit" ? "border-red-500/20 bg-red-500/[0.06]" : lvl === "warn" ? "border-amber-400/20 bg-amber-400/[0.06]" : "border-emerald-400/15 bg-emerald-400/[0.04]"
          )}
        >
          {lvl === "ok" ? (
            <CheckCircle2 className="mt-px size-4 shrink-0 text-emerald-400" />
          ) : (
            <AlertTriangle className={cn("mt-px size-4 shrink-0", lvl === "crit" ? "text-red-400" : "text-amber-400")} />
          )}
          <div className="min-w-0">
            <div className="font-medium text-slate-100">{row.diagnosis}</div>
            <div className="num mt-0.5 text-[11px] text-slate-400">
              {t("Overview diagnosis of {day} · health {health}/100 · peer-relative PR {pr}% (modelled)", { day: ovDay, health: fmt(row.health_score, 0), pr: fmt(row.pr_pct, 1) })}
            </div>
          </div>
        </div>
      ) : (
        !noData && (
          <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1.5 border-t border-white/[0.06] px-4 py-2.5 text-xs text-slate-300 sm:px-5">
            <div className="flex min-w-0 items-start gap-2">
              <Info className="mt-px size-4 shrink-0 text-sky-400" />
              <span>
                {ranged ? t("Measured over") : t("Measured on")} <span className="num font-semibold text-white">{periodText ?? t("the newest stored day")}</span>
                {ranged && day && endDay && <span className="num"> ({t("{n} days", { n: daysBetween(day, endDay) + 1 })})</span>}
                {winText && (
                  <>
                    {t(", only")} <span className="num font-semibold text-white">{winText}</span>
                  </>
                )}{" "}
                · {t("vs. the mean of the inverter's other strings")}
              </span>
            </div>
            {ovDay && row && (
              <Button variant="ghost" size="xs" className="num text-sky-300" onClick={() => setPeriod({ ...NEWEST, day: ovDay })}>
                {t("Diagnosis is of {day} · show it", { day: periodDayText(ovDay, null, today) })}
              </Button>
            )}
          </div>
        )
      )}
    </Card>
  );

  /* -------------------------------------------------------------- KPI strip */
  const currentTone = facts?.meanDevPct == null ? undefined : facts.meanDevPct <= DEV_CRIT_PCT ? "text-red-400" : facts.meanDevPct <= DEV_WARN_PCT ? "text-amber-400" : "text-emerald-400";
  const energyMax = Math.max(energy ?? 0, peerEnergy ?? 0);
  const kpis = (
    <Suspended busy={loading && detail != null} pill={false} contentClassName="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
      <StatTile
        label={t("Energy")}
        tag={periodText ?? undefined}
        value={fmt(energy, 2)}
        unit="kWh"
        tone="text-sky-300"
        meter={
          energyMax > 0 ? (
            <Meter
              segments={[{ pct: ((energy ?? 0) / energyMax) * 100, className: "bg-sky-400" }]}
              mark={peerEnergy != null ? (peerEnergy / energyMax) * 100 : null}
              title={t("Tick = peer average {v} kWh", { v: fmt(peerEnergy, 2) })}
            />
          ) : undefined
        }
        footer={
          <>
            <span>{t("peer avg {v} kWh", { v: fmt(peerEnergy, 2) })}</span>
            {energyDiff != null && (
              <span className={energyDiff <= -0.05 ? "text-amber-300" : "text-emerald-300"}>
                {signed(energyDiff, 2)} kWh
                {energyDiff <= -0.05 && tariff != null && ` ≈ ฿${Math.round(-energyDiff * tariff).toLocaleString()}`}
              </span>
            )}
          </>
        }
      />
      <StatTile
        label={t("String PR · peer")}
        tag="mod."
        value={fmt(s?.pr_pct, 1)}
        unit="%"
        meter={s?.pr_pct != null ? <Meter segments={[{ pct: s.pr_pct, className: "bg-solar-400" }]} /> : undefined}
        footer={t("peer-relative, modelled")}
      />
      <StatTile
        label={t("Current vs peers")}
        value={facts?.meanDevPct == null ? "—" : signed(facts.meanDevPct)}
        unit="%"
        tone={currentTone}
        meter={
          facts && facts.judged > 0 ? (
            <Meter
              segments={[
                { pct: ((facts.judged - facts.belowWarn) / facts.judged) * 100, className: "bg-emerald-400" },
                { pct: ((facts.belowWarn - facts.belowCrit) / facts.judged) * 100, className: "bg-amber-400" },
                { pct: (facts.belowCrit / facts.judged) * 100, className: "bg-red-400" },
              ]}
              title={t("Slots above {w} % / at or below {w} % / at or below {c} %", { w: DEV_WARN_PCT, c: DEV_CRIT_PCT })}
            />
          ) : undefined
        }
        footer={facts && facts.judged > 0 ? t("{n} slots judged", { n: facts.judged }) : t("slots with peers ≥ {a} A", { a: MISMATCH_MIN_PEER_A })}
      />
      <StatTile
        label={t("Peak power")}
        value={s?.p_max_w == null ? "—" : fmt(s.p_max_w / 1000, 2)}
        unit="kW"
        meter={peakPct != null ? <Meter segments={[{ pct: peakPct, className: "bg-energy-400" }]} title={t("{v} % of the entered STC rating", { v: fmt(peakPct, 0) })} /> : undefined}
        footer={
          <>
            {peakRow && <span>{t("at {time}", { time: peakRow.timestamp.slice(ranged ? 5 : 11, 16) })}</span>}
            {peakPct != null && <span>{t("{v} % of STC rating", { v: fmt(peakPct, 0) })}</span>}
          </>
        }
      />
      <StatTile
        label={t("Vmpp / Voc est.")}
        value={s?.v_mpp == null ? "—" : `${fmt(s.v_mpp, 0)} / ${fmt(s.v_oc_est, 0)}`}
        unit="V"
        footer={t("avg {avg} V · max {max} V", { avg: fmt(s?.v_avg, 0), max: fmt(s?.v_max, 0) })}
      />
      <StatTile
        label={t("Impp / Isc est.")}
        value={s?.i_mpp == null ? "—" : `${fmt(s.i_mpp, 2)} / ${fmt(s.i_sc_est, 2)}`}
        unit="A"
        footer={t("avg {avg} A · max {max} A", { avg: fmt(s?.i_avg, 2), max: fmt(s?.i_max, 2) })}
      />
    </Suspended>
  );

  /* ------------------------------------------------------------ no records */
  const noDataCard = (
    <Card className="items-center gap-0 px-6 py-12 text-center">
      <div className="rounded-full bg-white/5 p-3 text-slate-400 ring-1 ring-white/10">
        <CalendarSearch className="size-5" />
      </div>
      <div className="mt-3 text-sm font-medium text-slate-200">
        {t("No stored records for {period}", { period: `${periodText ?? t("the newest stored day")}${winText ? ` ${winText}` : ""}` })}
      </div>
      <div className="mt-1 max-w-md text-xs text-slate-500">{error}</div>
      <div className="mt-4 flex flex-wrap justify-center gap-2">
        {day === today && (
          <Button size="sm" onClick={() => setPeriod({ ...NEWEST, day: shiftDay(today, -1) })}>
            {t("Yesterday")}
          </Button>
        )}
        {ovDay && ovDay !== day && (
          <Button size="sm" variant="outline" className="num" onClick={() => setPeriod({ ...NEWEST, day: ovDay })}>
            {t("Overview day · {day}", { day: periodDayText(ovDay, null, today) })}
          </Button>
        )}
      </div>
    </Card>
  );

  /* ------------------------------------------------------------- tab views */
  const analysis = noData ? (
    noDataCard
  ) : (
    <div className="space-y-5">
      <div className="grid grid-cols-1 gap-5 xl:grid-cols-2">
        <Panel title={t("I-V & P-V curves")} subtitle={ranged ? t("Curves modelled from the range's peak · dots measured") : t("Curves modelled · dots measured")}>
          {chart(ivSpec, 380, t("No record has both voltage and current, so no curve can be modelled."))}
        </Panel>
        <Panel title={t("Profile vs. peers")} subtitle={ranged ? t("Every record of the range") : t("Drag across the chart to look at that time only")}>
          {chart(profileSpec, 380, t("No stored records in this period."), ranged ? undefined : zoomTo)}
        </Panel>
      </div>

      <Panel
        title={t("Current mismatch vs. peers")}
        subtitle={t("Measured · each 5-min slot where the other strings carry ≥ {a} A · thresholds of the live string check ({warn} % warning, {crit} % critical)", {
          a: MISMATCH_MIN_PEER_A,
          warn: DEV_WARN_PCT,
          crit: DEV_CRIT_PCT,
        })}
      >
        {facts && facts.judged > 0 && (
          <div className="mb-4 grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-white/[0.06] bg-white/[0.06] md:grid-cols-4">
            <Fact label={t("Slots judged")} value={facts.judged} />
            <Fact
              label={t("At or below {v} %", { v: DEV_WARN_PCT })}
              tone={facts.belowWarn ? "text-amber-400" : "text-emerald-400"}
              value={
                <>
                  {facts.belowWarn} <span className="text-xs font-normal text-slate-500">({fmt((facts.belowWarn / facts.judged) * 100, 0)}%)</span>
                </>
              }
              sub={facts.belowCrit > 0 ? <span className="text-red-300">{t("{n} at or below {v} %", { n: facts.belowCrit, v: DEV_CRIT_PCT })}</span> : undefined}
            />
            <Fact
              label={t("Longest run below {v} %", { v: DEV_WARN_PCT })}
              value={facts.longestRunSlots ? t("{n} slots", { n: facts.longestRunSlots }) : t("None")}
              sub={
                facts.longestRunFrom
                  ? `${ranged ? facts.longestRunFrom.slice(5, 16) : hm(facts.longestRunFrom)} → ${ranged ? (facts.longestRunTo?.slice(5, 16) ?? "—") : hm(facts.longestRunTo)}`
                  : undefined
              }
            />
            <Fact
              label={t("Worst hour of day")}
              tone={devTone(facts.worstHour?.dev_pct ?? null)}
              value={facts.worstHour ? `${String(facts.worstHour.hour).padStart(2, "0")}:00 · ${signed(facts.worstHour.dev_pct)}%` : "—"}
              sub={facts.worstHour ? t("{n} slots", { n: facts.worstHour.slots }) : undefined}
            />
          </div>
        )}
        <div className="grid grid-cols-1 gap-5 xl:grid-cols-5">
          <div className="xl:col-span-3">{chart(devSpec, 260, t("No slot where the peers carry ≥ {a} A.", { a: MISMATCH_MIN_PEER_A }))}</div>
          <div className="xl:col-span-2">{chart(hSpec, 260, t("No hour with judged slots."))}</div>
        </div>
      </Panel>

      {ranged && (
        <Panel title={t("Daily energy vs. peers")} subtitle={t("Measured energy per day · PR peer-relative, modelled")}>
          {chart(dailySpec, 300, t("No day of the range has stored records."))}
        </Panel>
      )}
    </div>
  );

  const stringsTable = (
    <Panel title={t("Strings of inverter {sn}", { sn })} subtitle={t("Overview day {day}, whole day · click a row to open that string", { day: ovDay ?? "—" })} bodyClassName="p-0">
      <Table containerClassName="scroll-x-hint">
        <TableHeader>
          <TableRow>
            <TableHead>{t("String")}</TableHead>
            <TableHead>{t("Status")}</TableHead>
            <TableHead>MPPT</TableHead>
            <TableHead className="text-right">{t("Energy (kWh)")}</TableHead>
            <TableHead className="text-right">PR (%)</TableHead>
            <TableHead className="text-right">{t("Avg / peak I (A)")}</TableHead>
            <TableHead className="text-right">{t("Avg / max V (V)")}</TableHead>
            <TableHead className="text-right">{t("I mismatch (%)")}</TableHead>
            <TableHead>{t("Diagnosis")}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {peers.map((p) => {
            const active = p.string_no === stringNo;
            return (
              <TableRow
                key={p.string_id}
                onClick={() => go(p.device_sn, p.string_no)}
                aria-current={active ? "true" : undefined}
                className={cn("cursor-pointer", active ? "bg-solar-500/10 shadow-[inset_2px_0_0_0_var(--color-solar-400)]" : "hover:bg-white/[0.03]")}
              >
                <TableCell className={cn("num font-semibold", active ? "text-solar-300" : "text-white")}>{strLabel(p.string_no)}</TableCell>
                <TableCell>
                  <StatusBadge status={p.status} dot />
                </TableCell>
                <TableCell className="num text-slate-400">{p.mppt_id}</TableCell>
                <TableCell className="num text-right">{fmt(p.actual_energy_kwh, 2)}</TableCell>
                <TableCell className="num text-right">{fmt(p.pr_pct, 1)}</TableCell>
                <TableCell className="num text-right">
                  {fmt(p.i_avg, 2)} / {fmt(p.i_max, 2)}
                </TableCell>
                <TableCell className="num text-right">
                  {fmt(p.v_avg, 0)} / {fmt(p.v_max, 0)}
                </TableCell>
                <TableCell className={`num text-right ${devTone(p.current_mismatch_pct)}`}>{signed(p.current_mismatch_pct)}</TableCell>
                <TableCell className="max-w-xs truncate text-xs text-slate-400" title={p.diagnosis}>
                  {p.diagnosis}
                </TableCell>
              </TableRow>
            );
          })}
          {peers.length === 0 && (
            <TableRow>
              <TableCell colSpan={9} className="py-6 text-center text-slate-500">
                {plantOverviewLoading ? t("Loading the overview…") : t("No strings of this inverter in the overview.")}
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
    </Panel>
  );

  const recordsTable = (
    <Panel
      title={t("Stored records")}
      subtitle={t("Newest first · plant-local time · peer = mean of the other strings in the same 5-min slot")}
      bodyClassName="p-0"
      actions={
        <Button variant="outline" size="sm" onClick={exportCsv} disabled={!detail}>
          <Download data-icon="inline-start" className="h-3.5 w-3.5" /> CSV
        </Button>
      }
    >
      <Suspended busy={loading && detail != null} pill={false}>
        <Table containerClassName="scroll-x-hint">
          <TableHeader>
            <TableRow>
              <TableHead>{t("Time")}</TableHead>
              <TableHead className="text-right">V</TableHead>
              <TableHead className="text-right">I (A)</TableHead>
              <TableHead className="text-right">P (W)</TableHead>
              <TableHead className="text-right">{t("Peer V")}</TableHead>
              <TableHead className="text-right">{t("Peer I (A)")}</TableHead>
              <TableHead className="text-right">{t("Peer P (W)")}</TableHead>
              <TableHead className="text-right">{t("I vs peers")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {pageRecords.map((r) => {
              const d = currentDev(r);
              return (
                <TableRow key={r.timestamp}>
                  <TableCell className="num whitespace-nowrap text-slate-300">{ranged ? r.timestamp.slice(5, 16) : r.timestamp.slice(11, 16)}</TableCell>
                  <TableCell className="num text-right">{fmt(r.voltage_v, 0)}</TableCell>
                  <TableCell className="num text-right">{fmt(r.current_a, 2)}</TableCell>
                  <TableCell className="num text-right">{fmt(r.power_w, 0)}</TableCell>
                  <TableCell className="num text-right text-slate-400">{fmt(r.peer_voltage_v, 0)}</TableCell>
                  <TableCell className="num text-right text-slate-400">{fmt(r.peer_current_a, 2)}</TableCell>
                  <TableCell className="num text-right text-slate-400">{fmt(r.peer_power_w, 0)}</TableCell>
                  <TableCell className={`num text-right ${devTone(d)}`}>{d == null ? "—" : `${signed(d)}%`}</TableCell>
                </TableRow>
              );
            })}
            {loading && !detail && (
              <TableRow>
                <TableCell colSpan={8} className="py-6 text-center text-slate-500">
                  {loadingLabel}
                </TableCell>
              </TableRow>
            )}
            {!loading && records.length === 0 && (
              <TableRow>
                <TableCell colSpan={8} className="py-6 text-center text-slate-500">
                  {t("No stored records in this period.")}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </Suspended>
      <TablePager className="border-t border-white/[0.06] px-4 py-2.5" rows={records.length} pageSize={RECORDS_PAGE} pageNo={pageNo} onPage={setRecPage} />
    </Panel>
  );

  const count = (tb: Tab) => (tb === "strings" ? peers.length || null : tb === "records" ? (detail ? records.length : null) : null);

  return (
    <div className="space-y-5">
      <SelectedPlantBanner />
      {header}

      {noData ? null : loading && !detail ? <SkeletonKpis count={6} className="sm:grid-cols-3 md:grid-cols-3 xl:grid-cols-6" /> : kpis}

      <div className="space-y-4">
        <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)}>
          <TabsList variant="line" aria-label={t("{name} details", { name: stringLabel })} className="w-full flex-nowrap justify-start overflow-x-auto rounded-none border-0 border-b border-white/[0.06] p-0">
            {TABS.map((id) => {
              const n = count(id);
              return (
                <TabsTrigger key={id} value={id} className="flex-none">
                  {t(TAB_LABEL[id])}
                  {n != null && (
                    <Badge variant="neutral" className="num h-4 px-1.5 text-[10px]">
                      {n.toLocaleString()}
                    </Badge>
                  )}
                </TabsTrigger>
              );
            })}
          </TabsList>
        </Tabs>

        {tab === "analysis" && analysis}
        {tab === "rules" && selectedGrowattPlantId != null && <StringRulesPanel plantId={selectedGrowattPlantId} sn={sn} stringNo={stringNo} />}
        {tab === "iv" && selectedGrowattPlantId != null && <StringIvSweepPanel plantId={selectedGrowattPlantId} sn={sn} stringNo={stringNo} />}
        {tab === "strings" && stringsTable}
        {tab === "records" && recordsTable}
      </div>
    </div>
  );
};
