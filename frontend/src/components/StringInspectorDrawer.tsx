/**
 * String I-V & Telemetry Inspector: modal for one string of the open plant (from the string
 * tiles, tables, alarm centre and command palette). Stored data from the DB string detail
 * (`useStringDetail`).
 * Period (`StringPeriodPicker`): any stored day (default: the string's newest) or a day range, and
 * a time-of-day window (also by dragging across the 5-min profile).
 * On the overview's day, whole day, the figures use the overview's string row (diagnosis, health,
 * peer median); for any other period they come from its own records (vs. the peer mean; no
 * diagnosis or health score, which the overview computes for its own whole day only).
 * I-V / P-V curves are modelled and labelled so; everything else is measured, missing = "—".
 * Keys: Esc closes, ← / → step through the strings of the same inverter.
 */
import React, { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  X,
  Activity,
  AlertTriangle,
  Wrench,
  CheckCircle2,
  ArrowUpRight,
  Sliders,
  ChevronLeft,
  ChevronRight,
  Info,
  Sparkles,
  Gauge,
  Copy,
  Check,
  CalendarRange,
} from "lucide-react";
import { useAppContext, usePlantHref } from "../context/AppContext";
import { api } from "../api/client";
import { PanelChart } from "./PanelChart";
import { ivPvSpecFrom, stringDailySpecFrom, stringProfileSpecFrom } from "./ivPvSpec";
import { StatusBadge, Led, Meter, LoadingState, EmptyState, Suspended, statusLevel, fmt } from "./ui";
import { plantToday } from "../context/alarmLogStore";
import { StringPeriodPicker } from "./stringDetail/StringPeriodPicker";
import { useStringDetail } from "./stringDetail/useStringDetail";
import { NEWEST, daysBetween, isWindowed, periodDayText, periodToQuery, slotTime, windowText } from "./stringDetail/period";
import type { StringPeriod } from "./stringDetail/period";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useI18n } from "../i18n";

/** measured values only: the first finite one, else null ("—"), never a typical-looking stand-in */
const num = (...vals: unknown[]): number | null => {
  for (const v of vals) {
    if (v == null || v === "") continue;
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
};
const str = (v: unknown): string | null => (v == null || v === "" ? null : String(v));
/** below this peer current (A) a slot says little about mismatch (dawn, dusk, heavy cloud) */
const MISMATCH_MIN_PEER_A = 1;
/** an energy gap below this is "none" (rounding noise of the 5-min integration) */
const GAP_NOISE_KWH = 0.05;

/** One figure of the summary card: label, value + unit, small foot line. */
const Stat: React.FC<{ label: string; title?: string; value: React.ReactNode; unit?: string; foot?: React.ReactNode }> = ({ label, title, value, unit, foot }) => (
  <div className="px-4 py-3" title={title}>
    <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">{label}</div>
    <div className="num mt-1 text-xl font-bold leading-none">
      {value}
      {unit && <span className="ml-0.5 text-xs font-medium text-slate-500">{unit}</span>}
    </div>
    {foot != null && <div className="num mt-1.5 text-[11px] text-slate-400">{foot}</div>}
  </div>
);

/** Labelled value pair with a meter under it (operating point). */
const MeterRow: React.FC<{ label: string; hint: string; value: string; of: string; children?: React.ReactNode }> = ({ label, hint, value, of, children }) => (
  <div>
    <div className="mb-1 flex items-baseline justify-between gap-2 text-[11px]">
      <span className="min-w-0 text-slate-400">
        {label} <span className="text-slate-500">· {hint}</span>
      </span>
      <span className="num shrink-0 text-slate-200">
        <strong>{value}</strong> / {of}
      </span>
    </div>
    {children}
  </div>
);

const TONE_TEXT = { ok: "text-emerald-400", warn: "text-amber-400", crit: "text-red-400" } as const;

const Fact: React.FC<{ label: React.ReactNode; title?: string; children: React.ReactNode }> = ({ label, title, children }) => (
  <div title={title}>
    <div className="text-[10px] text-slate-500">{label}</div>
    <div className="num font-semibold text-slate-100">{children}</div>
  </div>
);

export const StringInspectorDrawer: React.FC = () => {
  const { inspectedStringId, setInspectedStringId, analysisRun, activePlant, selectedGrowattPlantId, selectedPlantOverview } = useAppContext();
  // not remounted on a language switch: re-render through the hook
  const { t, lang } = useI18n();
  const navigate = useNavigate();
  const plantHref = usePlantHref();
  const [dispatching, setDispatching] = useState(false);
  const [dispatchedMsg, setDispatchedMsg] = useState<string | null>(null);
  const [chartTab, setChartTab] = useState<"iv" | "profile" | "daily">("iv");
  /** the period shown; kept while stepping through strings, reset on close / another plant */
  const [period, setPeriod] = useState<StringPeriod>(NEWEST);
  const [popoverOpen, setPopoverOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const windowed = isWindowed(period);
  const panelRef = useRef<HTMLElement>(null);

  const allStrings = analysisRun?.string_summary_json || [];
  const row = allStrings.find((s) => String(s.string_id) === inspectedStringId) || null;
  const deviceSn = str(row?.device_sn);
  const stringNo = num(row?.string_no);

  const peerStrings = row ? allStrings.filter((s) => s.inverter_id === row.inverter_id) : [];
  const peerIds = peerStrings.map((s) => String(s.string_id));

  const close = () => {
    setDispatchedMsg(null);
    setPeriod(NEWEST);
    setInspectedStringId(null);
  };
  // another plant: back to the newest stored day
  useEffect(() => setPeriod(NEWEST), [selectedGrowattPlantId]);
  const copySn = () => {
    if (!deviceSn) return;
    void navigator.clipboard?.writeText(deviceSn).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    });
  };
  const show = (id: string) => {
    setDispatchedMsg(null);
    setInspectedStringId(id);
  };

  const {
    detail: stringDetail,
    error: detailError,
    loading: loadingDetail,
  } = useStringDetail(inspectedStringId ? selectedGrowattPlantId : null, deviceSn, stringNo, period);

  // Esc closes, ← / → move through the inverter's strings; focus the panel on open
  const open = Boolean(inspectedStringId && analysisRun && row);
  useEffect(() => {
    if (!open) return;
    panelRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      if (popoverOpen) return; // the period popovers use the arrow keys and Esc themselves
      if (e.key === "Escape") {
        e.preventDefault();
        close();
      } else if ((e.key === "ArrowLeft" || e.key === "ArrowRight") && peerIds.length > 1) {
        const i = peerIds.indexOf(String(inspectedStringId));
        if (i < 0) return;
        e.preventDefault();
        show(peerIds[(i + (e.key === "ArrowRight" ? 1 : peerIds.length - 1)) % peerIds.length]);
      }
    };
    window.addEventListener("keydown", onKey, true); // capture: before the popover's own Esc handling
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey, true);
      document.body.style.overflow = prevOverflow;
    };
  }, [open, inspectedStringId, peerIds.join("|"), popoverOpen]);

  // the spec builders translate their labels: rebuild on a language switch
  const ivPvSpec = useMemo(() => (stringDetail ? ivPvSpecFrom(stringDetail.iv_pv_curve) : null), [stringDetail, lang]);
  const profileSpec = useMemo(() => (stringDetail ? stringProfileSpecFrom(stringDetail) : null), [stringDetail, lang]);
  const dailySpec = useMemo(() => (stringDetail ? stringDailySpecFrom(stringDetail) : null), [stringDetail, lang]);

  if (!open || !row || !analysisRun) return null;

  const tariff = num(activePlant?.tariff_thb_per_kwh, analysisRun.tariff_thb_per_kwh);
  const s = stringDetail?.summary;
  const today = plantToday();
  const ovDay = selectedPlantOverview?.meta.day ?? null;
  // the day(s) on screen: what the backend answered, else what was asked for
  const day = stringDetail?.meta.day ?? period.day ?? today;
  const endDay = stringDetail ? (stringDetail.meta.end_day ?? null) : period.endDay;
  const ranged = Boolean(endDay && endDay !== day);
  const periodText = day ? periodDayText(day, endDay, today) : null;
  /** a day other than the overview's: figures from that day's own records */
  const otherDay = ranged || (day != null && ovDay != null && day !== ovDay);
  /** figures from the detail (the period shown) instead of the overview's whole-day row */
  const ownFigures = otherDay || windowed;
  const winText = windowText(period);
  // the Daily tab exists only for a range
  const tab = chartTab === "daily" && !ranged ? "iv" : chartTab;

  // current vs. the peer mean over the day's slots with enough light (measured)
  const dayCurrentGap = (() => {
    if (!stringDetail) return null;
    let own = 0;
    let peer = 0;
    for (const r of stringDetail.timeseries) {
      if (r.peer_current_a == null || r.peer_current_a < MISMATCH_MIN_PEER_A) continue;
      own += r.current_a;
      peer += r.peer_current_a;
    }
    return peer > 0 ? ((own - peer) / peer) * 100 : null;
  })();

  const lvl = ownFigures ? "neutral" : statusLevel(row.status);
  const tone = lvl === "crit" ? "crit" : lvl === "warn" ? "warn" : "ok";
  const health = ownFigures ? null : num(row.health_score);
  const pr = ownFigures ? (s?.pr_pct ?? null) : num(row.pr_pct);
  const peerGap = ownFigures ? dayCurrentGap : num(row.current_mismatch_pct, row.peer_gap_pct);
  const energy = ownFigures ? (s?.energy_kwh ?? null) : num(row.actual_energy_kwh);
  const peerEnergy = ownFigures ? (s?.peer_energy_kwh ?? null) : num(row.expected_energy_kwh);
  const lossKwh = ownFigures
    ? energy != null && peerEnergy != null
      ? Math.max(0, peerEnergy - energy)
      : null
    : num(row.energy_loss_kwh, row.estimated_loss_kwh);
  const lossThb = lossKwh == null || tariff == null ? null : lossKwh * tariff;
  const vAvg = ownFigures ? (s?.v_avg ?? null) : num(row.v_avg, row.avg_vmp_v);
  const vMax = ownFigures ? (s?.v_max ?? null) : num(row.v_max);
  const iAvg = ownFigures ? (s?.i_avg ?? null) : num(row.i_avg, row.avg_imp_a);
  const iMax = ownFigures ? (s?.i_max ?? null) : num(row.i_max);
  const pMaxW = ownFigures ? (s?.p_max_w ?? null) : num(row.p_max_w);
  const peerRef = ownFigures ? t("peer mean") : t("peer median");

  const noGap = lossKwh != null && lossKwh < GAP_NOISE_KWH;
  const peerIndex = Math.max(0, peerIds.indexOf(String(inspectedStringId)));
  const step = (d: 1 | -1) => show(peerIds[(peerIndex + d + peerIds.length) % peerIds.length]);
  const basis = ownFigures ? stringDetail?.peer_basis : row.peer_basis;
  const basisNote =
    basis === "per_module" ? t("scaled per module") : basis === "per_kwp" ? t("scaled per kWp") : basis === "raw" ? t("raw: module count not set for every string") : null;
  // the string's own analysis page, same period
  const pageQuery = new URLSearchParams({ sn: deviceSn ?? "", no: String(stringNo ?? "") });
  for (const [k, v] of Object.entries(periodToQuery(period))) if (v) pageQuery.set(k, v);
  const stringPageHref = `${plantHref("string")}?${pageQuery}`;

  const handleDispatchCm = async () => {
    setDispatching(true);
    setDispatchedMsg(null);
    try {
      await api.regenerateCmWorkOrders(analysisRun.id);
      setDispatchedMsg(t("Synced CM work order queue for {id}.", { id: inspectedStringId }));
    } catch (err: unknown) {
      setDispatchedMsg(t("Failed: {error}", { error: err instanceof Error ? err.message : String(err) }));
    } finally {
      setDispatching(false);
    }
  };

  // drag on the 5-min profile → time-of-day window (one day only: on a range it would be ambiguous)
  const zoomTo = (lo: number, hi: number) => {
    if (!day || ranged) return;
    setPeriod((p) => ({ ...p, start: slotTime(lo, day, false), end: slotTime(hi, day, true) }));
  };
  const chartBody = (spec: ReturnType<typeof ivPvSpecFrom>, empty: string, onBrush?: (lo: number, hi: number) => void) =>
    loadingDetail && !stringDetail ? (
      <LoadingState label={t("Loading {period}…", { period: `${periodText ?? t("the newest stored day")}${winText ? ` ${winText}` : ""}` })} shape="chart" />
    ) : detailError ? (
      <EmptyState
        icon={AlertTriangle}
        title={winText ? t("No stored data {window}", { window: winText }) : day ? t("No stored data on {day}", { day: periodText }) : t("Stored day not available")}
        description={
          winText
            ? t("This string has no stored records in that time window. Widen it, or pick All day.")
            : day
              ? t("This string has no stored records then. Pick another day, or Today.")
              : detailError
        }
        className="py-8"
      />
    ) : spec ? (
      <Suspended busy={loadingDetail} pill="center">
        <PanelChart spec={spec} height={300} onBrush={onBrush} />
      </Suspended>
    ) : (
      <EmptyState icon={Activity} title={t("Nothing to draw")} description={empty} className="py-8" />
    );

  const gapTone = noGap ? "ok" : lossKwh == null ? null : tone === "ok" ? "warn" : tone;
  const accent = lvl === "crit" ? "bg-red-500" : lvl === "warn" ? "bg-amber-400" : lvl === "ok" ? "bg-emerald-400" : "bg-sky-400";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center sm:px-4">
      <div className="absolute inset-0 bg-black/65 backdrop-blur-sm animate-in fade-in-0 duration-150" onClick={close} aria-hidden />
      <aside
        ref={panelRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={t("String inspector {id}", { id: row.string_id })}
        className="relative flex h-full w-full flex-col overflow-hidden bg-ink-900 shadow-2xl outline-none animate-in fade-in-0 zoom-in-95 duration-150 sm:h-[86vh] sm:max-w-[74rem] sm:rounded-xl sm:border sm:border-white/10"
      >
        {/* ── Header: SN · MPPT · string + day + actions, live line, strings ──── */}
        <header className="space-y-2.5 border-b border-white/[0.07] bg-ink-950/70 px-5 pb-3 pt-3">
          {/* SN (copies) · MPPT · STR + status, the day shown (any stored day; default = newest), AI Analysis, close */}
          <div className="flex items-start gap-2">
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-2">
              <div className="flex min-w-0 items-center gap-2" title={t("Inverter {sn}", { sn: String(row.inverter_id) })}>
                <h3 className="num flex min-w-0 items-center gap-2 text-lg font-extrabold tracking-tight text-white">
                  {deviceSn ? (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <button
                          type="button"
                          onClick={copySn}
                          aria-label={t("Copy inverter SN {sn}", { sn: deviceSn })}
                          className="group inline-flex min-w-0 items-center gap-1.5 rounded-md px-1 -mx-1 hover:bg-white/[0.06] focus-visible:outline-1 focus-visible:outline-ring"
                        >
                          <span className="truncate">{deviceSn}</span>
                          {copied ? (
                            <Check className="h-4 w-4 shrink-0 text-emerald-400" />
                          ) : (
                            <Copy className="h-4 w-4 shrink-0 text-slate-500 opacity-60 group-hover:opacity-100" />
                          )}
                        </button>
                      </TooltipTrigger>
                      <TooltipContent side="bottom">{copied ? t("Copied") : t("Click to copy the inverter SN")}</TooltipContent>
                    </Tooltip>
                  ) : (
                    <span className="truncate">{String(row.inverter_id)}</span>
                  )}
                  <span className="shrink-0 text-slate-500">·</span>
                  <span className="shrink-0">{String(row.mppt_id)}</span>
                  <span className="shrink-0 text-slate-500">·</span>
                  <span className="shrink-0 text-solar-300">{String(row.short_label || row.string_id).replace(/^.*·\s*/, "")}</span>
                </h3>
                {!otherDay && <StatusBadge status={row.status} />}
              </div>
            <StringPeriodPicker
              period={period}
              onChange={setPeriod}
              shownDay={stringDetail?.meta.day ?? today}
              shownEndDay={stringDetail?.meta.end_day ?? null}
              today={today}
              loading={loadingDetail}
              hint={t("Or drag across the 5-min profile chart.")}
              onPopoverOpenChange={setPopoverOpen}
            />
          </div>
            <div className="flex shrink-0 items-center gap-1">
              <Tooltip>
                <TooltipTrigger asChild>
                  {/* span: a disabled button gets no pointer events, so the tooltip needs a wrapper */}
                  <span tabIndex={0} aria-label={t("AI Analysis (coming soon)")}>
                    <Button variant="outline" size="icon-sm" disabled className="pointer-events-none border-violet-400/40 disabled:opacity-80">
                      <Sparkles className="h-4 w-4 text-violet-300" />
                    </Button>
                  </span>
                </TooltipTrigger>
                <TooltipContent side="bottom">{t("AI Analysis · coming soon: a written diagnosis of this string's day")}</TooltipContent>
              </Tooltip>
              <Button onClick={close} variant="ghost" size="icon" aria-label={t("Close string inspector")} title={t("Close (Esc)")}>
                <X className="h-4 w-4" />
              </Button>
            </div>
          </div>

          {/* Strings of the same inverter: one scrollable line, ← / → */}
          {peerIds.length > 1 && (
            <div className="flex items-center gap-1">
              <Button onClick={() => step(-1)} variant="ghost" size="icon-sm" aria-label={t("Previous string")} title={t("Previous string (←)")}>
                <ChevronLeft className="h-4 w-4" />
              </Button>
              <div className="scroll-x-hint flex min-w-0 flex-1 gap-1 overflow-x-auto py-0.5">
                {peerStrings.map((p) => {
                  const id = String(p.string_id);
                  const active = id === inspectedStringId;
                  const pLvl = statusLevel(p.status);
                  return (
                    <button
                      key={id}
                      type="button"
                      onClick={() => show(id)}
                      aria-current={active ? "true" : undefined}
                      title={`${id} · ${p.status ? t(String(p.status)) : ""}`}
                      className={`num inline-flex shrink-0 items-center gap-1.5 rounded-md border px-2 py-1 text-[11px] font-semibold transition ${
                        active
                          ? "border-solar-400/60 bg-solar-500/20 text-solar-300"
                          : "border-white/[0.07] bg-ink-850 text-slate-400 hover:border-white/20 hover:text-slate-200"
                      }`}
                    >
                      <Led level={pLvl === "info" || pLvl === "neutral" ? "ok" : pLvl} />
                      {String(p.short_label || p.string_id).replace(/^.*·\s*/, "")}
                    </button>
                  );
                })}
              </div>
              <Button onClick={() => step(1)} variant="ghost" size="icon-sm" aria-label={t("Next string")} title={t("Next string (→)")}>
                <ChevronRight className="h-4 w-4" />
              </Button>
              <span className="num w-10 shrink-0 text-right text-[11px] text-slate-500">
                {peerIndex + 1}/{peerIds.length}
              </span>
            </div>
          )}

        </header>

        {/* ── Body ──────────────────────────────────────────────────────────── */}
        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-5 text-xs">
          {/* Summary: diagnosis + the day's four figures in one card */}
          <section className="relative overflow-hidden rounded-xl border border-white/[0.07] bg-ink-850/70">
            <span className={`absolute inset-y-0 left-0 w-1 ${accent}`} aria-hidden />
            <div className="flex items-start gap-2.5 border-b border-white/[0.06] px-4 py-3 pl-5">
              {ownFigures ? (
                <Info className="mt-0.5 h-4 w-4 shrink-0 text-sky-400" />
              ) : lvl === "ok" ? (
                <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-400" />
              ) : (
                <AlertTriangle className={`mt-0.5 h-4 w-4 shrink-0 ${lvl === "crit" ? "text-red-400" : "text-amber-400"}`} />
              )}
              {ownFigures ? (
                <div className="text-slate-300">
                  {ranged ? t("Measured over") : t("Measured on")} <span className="num font-semibold text-white">{periodText}</span>
                  {ranged && day && endDay && <span className="num"> ({t("{n} days", { n: daysBetween(day, endDay) + 1 })})</span>}
                  {winText && (
                    <>
                      {t(", only")} <span className="num font-semibold text-white">{winText}</span>
                    </>
                  )}
                  {t(", compared with the mean of the other strings. Diagnosis, status and health are computed for the whole of")}{" "}
                  <button
                    type="button"
                    className="num font-semibold text-sky-300 hover:underline"
                    onClick={() => setPeriod({ ...NEWEST, day: ovDay })}
                  >
                    {ovDay}
                  </button>{" "}
                  {t("only.")}
                </div>
              ) : (
                <div className="space-y-0.5">
                  <div className="font-semibold text-slate-100">{String(row.diagnosis || row.primary_diagnosis || t("String operating diagnostics"))}</div>
                  {str(row.recommended_action) && <div className="text-[11px] text-slate-400">{String(row.recommended_action)}</div>}
                </div>
              )}
            </div>
            <div className="grid grid-cols-2 divide-white/[0.06] sm:grid-cols-4 sm:divide-x">
              <Stat
                label={t("Health")}
                title={ownFigures ? t("Computed by the plant overview for {day} only", { day: ovDay }) : t("String health score of the overview's day")}
                value={<span className="text-white">{fmt(health, 0)}</span>}
                unit="/100"
                foot={ownFigures ? t("whole {day} only", { day: ovDay }) : health != null ? <Meter value={health} tone={tone} /> : null}
              />
              <Stat
                label={t("String PR")}
                title={t("Peer-relative PR (modelled): energy vs. the inverter's other strings, not IEC 61724")}
                value={<span className={ownFigures ? "text-solar-400" : TONE_TEXT[tone]}>{fmt(pr, 1)}</span>}
                unit="%"
                foot={`${fmt(energy, 2)} kWh`}
              />
              <Stat
                label={t("Current vs peers")}
                title={
                  ownFigures
                    ? t("Day's string current vs. the mean of the other strings, over slots where they carry ≥ {a} A", { a: MISMATCH_MIN_PEER_A })
                    : t("Current mismatch against the inverter's other strings")
                }
                value={
                  <span className={peerGap == null ? "text-slate-400" : peerGap < -10 ? "text-red-400" : peerGap < -4 ? "text-amber-400" : "text-emerald-400"}>
                    {peerGap != null && peerGap >= 0 ? "+" : ""}
                    {fmt(peerGap, 1)}
                  </span>
                }
                unit="%"
                foot={t("Peak {v} kW", { v: fmt(pMaxW == null ? null : pMaxW / 1000, 2) })}
              />
              <Stat
                label={t("Energy gap")}
                title={
                  tariff == null
                    ? t("Energy below the expected ({ref}) energy of the day; no plant tariff set", { ref: peerRef })
                    : t("Energy below the expected ({ref}) energy of the day, at the plant tariff ฿{rate}/kWh", { ref: peerRef, rate: fmt(tariff, 2) })
                }
                value={noGap ? <span className="text-emerald-400">{t("None")}</span> : <span className={gapTone ? TONE_TEXT[gapTone] : "text-slate-400"}>{fmt(lossKwh, 1)}</span>}
                unit={noGap ? undefined : "kWh"}
                foot={noGap ? t("at or above peers") : lossThb == null ? "—" : t("≈ ฿{thb} lost", { thb: Math.round(lossThb).toLocaleString() })}
              />
            </div>
          </section>

          {/* Charts of the day shown */}
          <section className="rounded-xl border border-white/[0.07] bg-ink-850/70 p-4">
            <Tabs value={tab} onValueChange={(v) => setChartTab(v as "iv" | "profile" | "daily")} className="gap-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <TabsList variant="line">
                  <TabsTrigger value="iv">
                    <Gauge data-icon="inline-start" className="h-3.5 w-3.5" />
                    I-V & P-V
                  </TabsTrigger>
                  <TabsTrigger value="profile">
                    <Activity data-icon="inline-start" className="h-3.5 w-3.5" />
                    {t("5-min profile")}
                  </TabsTrigger>
                  {ranged && (
                    <TabsTrigger value="daily">
                      <CalendarRange data-icon="inline-start" className="h-3.5 w-3.5" />
                      {t("Daily")}
                    </TabsTrigger>
                  )}
                </TabsList>
                <span className="text-[11px] text-slate-500">
                  {tab === "iv"
                    ? ranged
                      ? t("Curves modelled from the range's peak · dots measured")
                      : t("Curves modelled · dots measured")
                    : tab === "daily"
                      ? t("Measured energy · PR modelled")
                      : t("Measured · peer = mean of the other strings")}
                </span>
              </div>
              <TabsContent value="iv" className="space-y-3">
                {chartBody(ivPvSpec, t("No record on {day} has both voltage and current, so no curve can be modelled.", { day: periodText ?? t("the day") }))}
                {s && !loadingDetail && (
                  <div className="grid grid-cols-2 gap-3 rounded-lg bg-ink-950/60 p-3 text-center sm:grid-cols-4">
                    <Fact
                      label={
                        <>
                          V<sub>mpp</sub> / V<sub>oc</sub> {t("est.")}
                        </>
                      }
                      title={t("V at the day's peak-power record / open-circuit voltage estimated from the day's highest voltage (modelled)")}
                    >
                      {fmt(s.v_mpp, 0)} / {fmt(s.v_oc_est, 0)} V
                    </Fact>
                    <Fact
                      label={
                        <>
                          I<sub>mpp</sub> / I<sub>sc</sub> {t("est.")}
                        </>
                      }
                      title={t("I at the day's peak-power record / short-circuit current estimated from the day's highest current (modelled)")}
                    >
                      {fmt(s.i_mpp, 2)} / {fmt(s.i_sc_est, 2)} A
                    </Fact>
                    <Fact label={t("Peak power")} title={t("The record with the day's highest power (measured)")}>
                      {fmt(s.p_max_w, 0)} W
                    </Fact>
                    <Fact label={t("Energy / peer mean")} title={t("This string's energy vs. the mean of the inverter's other strings, per 5-min slot (measured)")}>
                      {fmt(s.energy_kwh, 2)} / {fmt(s.peer_energy_kwh, 2)} kWh
                    </Fact>
                  </div>
                )}
              </TabsContent>
              <TabsContent value="profile" className="space-y-2">
                {chartBody(profileSpec, winText ? t("No stored records on {day} between {window}.", { day: periodText ?? t("the day"), window: winText }) : t("No stored records on {day}.", { day: periodText ?? t("the day") }), ranged ? undefined : zoomTo)}
                {!ranged && (
                  <p className="text-[11px] text-slate-500 max-sm:hidden">
                    {windowed ? t("Drag across the chart to look at that time only (the clock button → All day zooms out).") : t("Drag across the chart to look at that time only.")}
                  </p>
                )}
              </TabsContent>
              {ranged && <TabsContent value="daily">{chartBody(dailySpec, t("No day of the range has stored records."))}</TabsContent>}
            </Tabs>
          </section>

          {/* Operating point of the day shown */}
          <section className="rounded-xl border border-white/[0.07] bg-ink-850/70 p-4">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-1.5 font-semibold text-slate-100">
                <Sliders className="h-3.5 w-3.5 text-solar-400" />
                {t("Operating point")}
              </div>
              <span className="num text-[11px] text-slate-400">
                {row.modules != null && (
                  <>
                    {t("{n} modules", { n: String(row.modules) })}{row.module_wp ? ` × ${fmt(row.module_wp, 0)} Wp` : ""} ·{" "}
                  </>
                )}
                {fmt(row.capacity_kwp, 2)} kWp
              </span>
            </div>
            <div className="space-y-3">
              <MeterRow label={t("MPPT voltage")} hint={t("avg / max")} value={`${fmt(vAvg, 1)} V`} of={`${fmt(vMax, 1)} V`}>
                {vAvg != null && vMax != null && vMax > 0 && <Meter value={vAvg} max={vMax} tone="solar" />}
              </MeterRow>
              <MeterRow label={t("String current")} hint={t("avg / peak")} value={`${fmt(iAvg, 2)} A`} of={`${fmt(iMax, 2)} A`}>
                {iAvg != null && iMax != null && iMax > 0 && <Meter value={iAvg} max={iMax} tone="energy" />}
              </MeterRow>
              <MeterRow label={t("Energy")} hint={`${t("vs. expected ({ref})", { ref: peerRef })}${basisNote ? ` · ${basisNote}` : ""}`} value={`${fmt(energy, 2)} kWh`} of={`${fmt(peerEnergy, 2)} kWh`}>
                {energy != null && peerEnergy != null && peerEnergy > 0 && <Meter value={energy} max={peerEnergy} tone={ownFigures ? "solar" : tone} />}
              </MeterRow>
            </div>
          </section>

          {dispatchedMsg && (
            <div className="callout-ok flex items-center justify-between">
              <span>{dispatchedMsg}</span>
              <Button
                onClick={() => {
                  close();
                  navigate(plantHref("maintenance"));
                }}
                size="sm"
              >
                {t("View CM queue")} <ArrowUpRight data-icon="inline-end" className="h-3 w-3" />
              </Button>
            </div>
          )}
        </div>

        {/* ── Footer ────────────────────────────────────────────────────────── */}
        <footer className="flex flex-wrap items-center justify-between gap-2 border-t border-white/[0.07] bg-ink-950/70 px-5 py-3">
          <span className="hidden text-[11px] text-slate-500 sm:inline">{t("Esc close · ← / → string")}</span>
          <div className="flex flex-wrap items-center gap-2">
            {analysisRun.id ? (
              <Button onClick={handleDispatchCm} disabled={dispatching} variant="outline" size="sm">
                <Wrench data-icon="inline-start" className="h-3.5 w-3.5" />
                {dispatching ? t("Syncing CM queue…") : t("Dispatch CM work order")}
              </Button>
            ) : null}
            <Button
              size="sm"
              onClick={() => {
                close();
                navigate(stringPageHref);
              }}
              disabled={!deviceSn || stringNo == null}
              title={t("This string in depth: curves, profile, mismatch by hour, daily energy, records")}
            >
              {t("Open full analysis")}
              <ArrowUpRight data-icon="inline-end" className="h-3.5 w-3.5" />
            </Button>
          </div>
        </footer>
      </aside>
    </div>
  );
};
