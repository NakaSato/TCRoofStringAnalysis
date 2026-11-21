/**
 * String Analysis (`/plant/:id/string?sn=&no=`): one string in depth, for a stored day, a day
 * range and/or a time-of-day window (URL `day`, `to`, `from_t`, `to_t`). Stored data only
 * (`useStringDetail`); the newest live record appears only in the "Now" line.
 * Sections: figures, I-V / P-V (modelled curves, measured dots), profile with peers (current,
 * power, voltage), current mismatch per slot and by hour of day (thresholds of the live string
 * check), daily energy for a range, the inverter's strings (overview day), and the records (CSV).
 */
import React, { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  Activity,
  AlertTriangle,
  ArrowLeft,
  CalendarRange,
  Check,
  CheckCircle2,
  Clock,
  Copy,
  Download,
  Gauge,
  Info,
  Radio,
  Sparkles,
  Table2,
  TrendingDown,
} from "lucide-react";
import { useAppContext, usePlantHref } from "../context/AppContext";
import { plantToday } from "../context/alarmLogStore";
import { useUrlState } from "@/lib/useUrlState";
import { PanelChart } from "../components/PanelChart";
import type { PanelChartSpec } from "../components/PanelChart";
import { ivPvSpecFrom, stringDailySpecFrom } from "../components/ivPvSpec";
import { SelectedPlantBanner } from "../components/SelectedPlantBanner";
import { EmptyState, KpiTile, Led, LoadingState, Panel, StatusBadge, fmt, statusLevel } from "../components/ui";
import { TablePager, pageBounds } from "../components/TablePager";
import { StringPeriodPicker } from "../components/stringDetail/StringPeriodPicker";
import { useStringDetail } from "../components/stringDetail/useStringDetail";
import { StringRulesPanel } from "../components/stringDetail/StringRulesPanel";
import { StringIvSweepPanel } from "../components/stringDetail/StringIvSweepPanel";
import { daysBetween, isWindowed, periodDayText, periodFromQuery, periodToQuery, slotTime, windowText } from "../components/stringDetail/period";
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
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useI18n } from "../i18n";

const RECORDS_PAGE = 25;
const hm = (ts: string | null) => (ts ? ts.slice(11, 16) : "—");
const signed = (v: number | null, d = 1) => (v == null ? "—" : `${v >= 0 ? "+" : ""}${fmt(v, d)}`);
const devTone = (d: number | null) => (d == null ? "text-slate-400" : d <= DEV_CRIT_PCT ? "text-red-400" : d <= DEV_WARN_PCT ? "text-amber-400" : "text-emerald-400");

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
  const [copied, setCopied] = useState(false);
  const [recPage, setRecPage] = useState(0);

  const { detail, error, loading } = useStringDetail(selectedGrowattPlantId, sn, stringNo, period);

  const strings = selectedPlantOverview?.strings ?? [];
  const row = strings.find((s) => s.device_sn === sn && s.string_no === stringNo) ?? null;
  const peers = strings.filter((s) => s.device_sn === sn).sort((a, b) => a.string_no - b.string_no);
  const today = plantToday();
  const ovDay = selectedPlantOverview?.meta.day ?? null;

  const day = detail?.meta.day ?? period.day;
  const endDay = detail ? (detail.meta.end_day ?? null) : period.endDay;
  const ranged = Boolean(endDay && endDay !== day);
  const windowed = isWindowed(period);
  const winText = windowText(period);
  const periodText = day ? periodDayText(day, endDay, today) : null;
  /** the overview's own day and whole day: its diagnosis and status apply */
  const overviewPeriod = !ranged && !windowed && day != null && day === ovDay;
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
  const gapKwh = energy != null && peerEnergy != null ? Math.max(0, peerEnergy - energy) : null;
  const peakRow = detail?.timeseries.length ? detail.timeseries.reduce((a, b) => (b.power_w > a.power_w ? b : a)) : null;

  const go = (deviceSn: string, no: number) =>
    navigate(`${plantHref("string")}?${new URLSearchParams({ sn: deviceSn, no: String(no), ...Object.fromEntries(Object.entries(periodToQuery(period)).filter(([, v]) => v)) as Record<string, string> })}`);
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

  const chart = (spec: PanelChartSpec | null, height: number, empty: string, onBrush?: (lo: number, hi: number) => void) =>
    loading ? (
      <LoadingState label={t("Loading {period}…", { period: `${periodText ?? t("the newest stored day")}${winText ? ` ${winText}` : ""}` })} shape="chart" />
    ) : error ? (
      <EmptyState icon={AlertTriangle} title={t("No stored data for this period")} description={error} className="py-10" />
    ) : spec ? (
      <PanelChart spec={spec} height={height} onBrush={onBrush} legendToggle />
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
  const stringLabel = `STR-${String(stringNo).padStart(2, "0")}`;

  return (
    <div className="space-y-5">
      <SelectedPlantBanner />

      {/* Identity, period, actions */}
      <Card className="gap-3 px-5 py-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2">
            <Button variant="ghost" size="icon-sm" onClick={() => navigate(plantHref("strings"))} aria-label={t("Back to String Diagnostics")} title={t("Back to String Diagnostics")}>
              <ArrowLeft className="h-4 w-4" />
            </Button>
            <h1 className="num flex min-w-0 items-center gap-2 text-2xl font-extrabold tracking-tight text-white">
              <Tooltip>
                <TooltipTrigger asChild>
                  <button type="button" onClick={copySn} aria-label={t("Copy inverter SN {sn}", { sn })} className="group inline-flex items-center gap-1.5 rounded-md px-1 -mx-1 hover:bg-white/[0.06]">
                    {sn}
                    {copied ? <Check className="h-4 w-4 text-emerald-400" /> : <Copy className="h-4 w-4 text-slate-500 opacity-60 group-hover:opacity-100" />}
                  </button>
                </TooltipTrigger>
                <TooltipContent side="bottom">{copied ? t("Copied") : t("Click to copy the inverter SN")}</TooltipContent>
              </Tooltip>
              <span className="text-slate-500">·</span>
              <span>{row?.mppt_id ?? (detail ? `MPPT-${detail.mppt_no}` : "MPPT")}</span>
              <span className="text-slate-500">·</span>
              <span className="text-solar-300">{stringLabel}</span>
            </h1>
            {row && overviewPeriod && <StatusBadge status={row.status} />}
            {detail?.modules != null && (
              <Badge variant="neutral" className="num">
                {t("{n} modules", { n: detail.modules })}{detail.module_wp ? ` × ${fmt(detail.module_wp, 0)} Wp` : ""}
              </Badge>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <StringPeriodPicker
              period={period}
              onChange={setPeriod}
              shownDay={detail?.meta.day ?? null}
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
            <Button variant="outline" size="sm" onClick={exportCsv} disabled={!detail}>
              <Download data-icon="inline-start" className="h-3.5 w-3.5" /> CSV
            </Button>
          </div>
        </div>

        {/* strings of the same inverter + live line */}
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="scroll-x-hint flex min-w-0 flex-1 gap-1 overflow-x-auto py-0.5">
            {peers.map((p) => {
              const active = p.string_no === stringNo;
              const pl = statusLevel(p.status);
              return (
                <button
                  key={p.string_id}
                  type="button"
                  onClick={() => go(p.device_sn, p.string_no)}
                  aria-current={active ? "true" : undefined}
                  title={`${p.string_id} · ${t(p.status)} (${ovDay ?? t("overview day")})`}
                  className={`num inline-flex shrink-0 items-center gap-1.5 rounded-md border px-2 py-1 text-[11px] font-semibold transition ${
                    active ? "border-solar-400/60 bg-solar-500/20 text-solar-300" : "border-white/[0.07] bg-ink-850 text-slate-400 hover:border-white/20 hover:text-slate-200"
                  }`}
                >
                  <Led level={pl === "info" || pl === "neutral" ? "ok" : pl} />
                  STR-{String(p.string_no).padStart(2, "0")}
                </button>
              );
            })}
          </div>
          <div className="num flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[11px]" title={row?.live_reason ?? undefined}>
            <span className="inline-flex items-center gap-1 font-semibold text-sky-300">
              <Radio className="h-3 w-3" />
              {row?.live_current_a != null ? t("Now {time}", { time: hm(row.live_at ?? null) }) : t("Now")}
            </span>
            {row?.live_current_a != null ? (
              <>
                <span className="text-slate-200">{fmt(row.live_voltage_v, 0)} V</span>
                <span className="text-slate-200">{fmt(row.live_current_a, 2)} A</span>
                <span className="text-slate-200">{fmt(row.live_power_w == null ? null : row.live_power_w / 1000, 2)} kW</span>
                {row.live_status && <StatusBadge status={row.live_status} />}
              </>
            ) : (
              <span className="text-slate-500">{t("no live record")}</span>
            )}
          </div>
        </div>
      </Card>

      {/* What the figures cover */}
      {plantOverviewLoading && !selectedPlantOverview ? null : overviewPeriod && row ? (
        <div className={lvl === "crit" ? "callout-crit" : lvl === "warn" ? "callout-warn" : "callout-ok"}>
          <div className="flex items-start gap-2.5">
            {lvl === "ok" ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-400" /> : <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />}
            <div>
              <div className="font-semibold text-slate-100">{row.diagnosis}</div>
              <div className="num text-[11px] opacity-80">
                {t("Overview diagnosis of {day} · health {health}/100 · peer-relative PR {pr}% (modelled)", { day: ovDay, health: fmt(row.health_score, 0), pr: fmt(row.pr_pct, 1) })}
              </div>
            </div>
          </div>
        </div>
      ) : (
        <div className="flex items-start gap-2.5 rounded-xl border border-white/[0.08] bg-white/[0.03] px-4 py-3 text-xs text-slate-300">
          <Info className="mt-0.5 h-4 w-4 shrink-0 text-sky-400" />
          <div>
            {ranged ? t("Measured over") : t("Measured on")} <span className="num font-semibold text-white">{periodText ?? t("the newest stored day")}</span>
            {ranged && day && endDay && <span className="num"> ({t("{n} days", { n: daysBetween(day, endDay) + 1 })})</span>}
            {winText && (
              <>
                {t(", only")} <span className="num font-semibold text-white">{winText}</span>
              </>
            )}
            {t(", compared with the mean of the inverter's other strings. The overview's diagnosis and status are for the whole of")}{" "}
            <button type="button" className="num font-semibold text-sky-300 hover:underline" onClick={() => setPeriod({ day: ovDay, endDay: null, start: "", end: "" })}>
              {ovDay ?? t("its day")}
            </button>{" "}
            {t("only.")}
          </div>
        </div>
      )}

      {/* Figures of the period */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-7">
        <KpiTile compact label={t("Energy")} value={fmt(energy, 2)} unit="kWh" hint={t("peer avg {v} kWh", { v: fmt(peerEnergy, 2) })} tone="info" />
        <KpiTile
          compact
          label={t("Energy gap")}
          value={gapKwh != null && gapKwh < 0.05 ? t("None") : fmt(gapKwh, 2)}
          unit={gapKwh != null && gapKwh < 0.05 ? undefined : "kWh"}
          hint={gapKwh == null || gapKwh < 0.05 || tariff == null ? t("vs. peer average") : t("≈ ฿{thb} at ฿{rate}/kWh", { thb: Math.round(gapKwh * tariff).toLocaleString(), rate: fmt(tariff, 2) })}
          tone={gapKwh != null && gapKwh >= 0.05 ? "warn" : "ok"}
        />
        <KpiTile compact label={t("String PR · peer")} value={fmt(s?.pr_pct, 1)} unit="%" hint={t("peer-relative, modelled")} tone="info" />
        <KpiTile
          compact
          label={t("Current vs peers")}
          value={signed(facts?.meanDevPct ?? null)}
          unit="%"
          hint={t("slots with peers ≥ {a} A", { a: MISMATCH_MIN_PEER_A })}
          tone={facts?.meanDevPct == null ? "info" : facts.meanDevPct <= DEV_CRIT_PCT ? "crit" : facts.meanDevPct <= DEV_WARN_PCT ? "warn" : "ok"}
        />
        <KpiTile compact label={t("Peak power")} value={fmt(s?.p_max_w, 0)} unit="W" hint={peakRow ? t("at {time}", { time: peakRow.timestamp.slice(ranged ? 5 : 11, 16) }) : undefined} tone="info" />
        <KpiTile compact label={t("Vmpp / Voc est.")} value={`${fmt(s?.v_mpp, 0)} / ${fmt(s?.v_oc_est, 0)}`} unit="V" hint={t("avg {avg} V · max {max} V", { avg: fmt(s?.v_avg, 0), max: fmt(s?.v_max, 0) })} tone="info" />
        <KpiTile compact label={t("Impp / Isc est.")} value={`${fmt(s?.i_mpp, 2)} / ${fmt(s?.i_sc_est, 2)}`} unit="A" hint={t("avg {avg} A · max {max} A", { avg: fmt(s?.i_avg, 2), max: fmt(s?.i_max, 2) })} tone="info" />
      </div>

      {/* Curves and profile */}
      <div className="grid grid-cols-1 gap-5 xl:grid-cols-2">
        <Panel icon={Gauge} title={t("I-V & P-V curves")} subtitle={ranged ? t("Curves modelled from the range's peak · dots measured") : t("Curves modelled · dots measured")}>
          {chart(ivSpec, 380, t("No record has both voltage and current, so no curve can be modelled."))}
        </Panel>
        <Panel icon={Activity} title={t("Profile vs. peers")} subtitle={ranged ? t("Every record of the range") : t("Drag across the chart to look at that time only")}>
          {chart(profileSpec, 380, t("No stored records in this period."), ranged ? undefined : zoomTo)}
        </Panel>
      </div>

      {/* Mismatch analysis */}
      <Panel
        icon={TrendingDown}
        title={t("Current mismatch vs. peers")}
        subtitle={t("Measured · each 5-min slot where the other strings carry ≥ {a} A · thresholds of the live string check ({warn} % warning, {crit} % critical)", { a: MISMATCH_MIN_PEER_A, warn: DEV_WARN_PCT, crit: DEV_CRIT_PCT })}
      >
        {facts && facts.judged > 0 && (
          <div className="mb-4 grid grid-cols-2 gap-3 text-xs md:grid-cols-4">
            <div className="rounded-lg bg-ink-950/60 p-3">
              <div className="text-[10px] uppercase text-slate-500">{t("Slots judged")}</div>
              <div className="num text-lg font-bold text-white">{facts.judged}</div>
            </div>
            <div className="rounded-lg bg-ink-950/60 p-3">
              <div className="text-[10px] uppercase text-slate-500">{t("At or below {v} %", { v: DEV_WARN_PCT })}</div>
              <div className={`num text-lg font-bold ${facts.belowWarn ? "text-amber-400" : "text-emerald-400"}`}>
                {facts.belowWarn} <span className="text-xs font-medium text-slate-500">({fmt((facts.belowWarn / facts.judged) * 100, 0)}%)</span>
              </div>
              {facts.belowCrit > 0 && <div className="num text-[11px] text-red-300">{t("{n} at or below {v} %", { n: facts.belowCrit, v: DEV_CRIT_PCT })}</div>}
            </div>
            <div className="rounded-lg bg-ink-950/60 p-3">
              <div className="text-[10px] uppercase text-slate-500">{t("Longest run below {v} %", { v: DEV_WARN_PCT })}</div>
              <div className="num text-lg font-bold text-white">
                {facts.longestRunSlots ? t("{n} slots", { n: facts.longestRunSlots }) : t("None")}
              </div>
              {facts.longestRunFrom && (
                <div className="num text-[11px] text-slate-400">
                  {ranged ? facts.longestRunFrom.slice(5, 16) : hm(facts.longestRunFrom)} → {ranged ? facts.longestRunTo?.slice(5, 16) : hm(facts.longestRunTo)}
                </div>
              )}
            </div>
            <div className="rounded-lg bg-ink-950/60 p-3">
              <div className="text-[10px] uppercase text-slate-500">{t("Worst hour of day")}</div>
              <div className={`num text-lg font-bold ${devTone(facts.worstHour?.dev_pct ?? null)}`}>
                {facts.worstHour ? `${String(facts.worstHour.hour).padStart(2, "0")}:00 · ${signed(facts.worstHour.dev_pct)}%` : "—"}
              </div>
              {facts.worstHour && <div className="num text-[11px] text-slate-400">{t("{n} slots", { n: facts.worstHour.slots })}</div>}
            </div>
          </div>
        )}
        <div className="grid grid-cols-1 gap-5 xl:grid-cols-5">
          <div className="xl:col-span-3">{chart(devSpec, 260, t("No slot where the peers carry ≥ {a} A.", { a: MISMATCH_MIN_PEER_A }))}</div>
          <div className="xl:col-span-2">{chart(hSpec, 260, t("No hour with judged slots."))}</div>
        </div>
      </Panel>

      {/* Daily (range) */}
      {ranged && (
        <Panel icon={CalendarRange} title={t("Daily energy vs. peers")} subtitle={t("Measured energy per day · PR peer-relative, modelled")}>
          {chart(dailySpec, 300, t("No day of the range has stored records."))}
        </Panel>
      )}

      {/* Decision rules: open issues + last 30 days of the daily table */}
      {selectedGrowattPlantId != null && sn && stringNo != null && (
        <StringRulesPanel plantId={selectedGrowattPlantId} sn={sn} stringNo={stringNo} />
      )}

      {/* Measured I-V curve sweeps + IEC 60891 STC translation + fault signatures */}
      {selectedGrowattPlantId != null && sn && stringNo != null && (
        <StringIvSweepPanel plantId={selectedGrowattPlantId} sn={sn} stringNo={stringNo} />
      )}

      {/* Strings of the inverter (overview day) */}
      <Panel
        icon={Table2}
        title={t("Strings of inverter {sn}", { sn })}
        subtitle={t("Overview day {day}, whole day · click a row to open that string", { day: ovDay ?? "—" })}
        bodyClassName="p-0"
      >
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
            {peers.map((p) => (
              <TableRow
                key={p.string_id}
                onClick={() => go(p.device_sn, p.string_no)}
                className={`cursor-pointer ${p.string_no === stringNo ? "bg-solar-500/10" : "hover:bg-white/[0.03]"}`}
              >
                <TableCell className="num font-semibold text-white">STR-{String(p.string_no).padStart(2, "0")}</TableCell>
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
            ))}
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

      {/* Records */}
      <Panel icon={Clock} title={t("Stored records")} subtitle={t("Newest first · plant-local time · peer = mean of the other strings in the same 5-min slot")} bodyClassName="p-0">
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
            {!loading && records.length === 0 && (
              <TableRow>
                <TableCell colSpan={8} className="py-6 text-center text-slate-500">
                  {t("No stored records in this period.")}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
        <TablePager className="border-t border-white/[0.06] px-4 py-2.5" rows={records.length} pageSize={RECORDS_PAGE} pageNo={pageNo} onPage={setRecPage} />
      </Panel>
    </div>
  );
};
