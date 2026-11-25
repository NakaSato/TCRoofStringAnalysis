import React, { Suspense, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowDownToLine,
  ArrowRight,
  ArrowUpFromLine,
  Building2,
  Cloud,
  ExternalLink,
  Gauge,
  House,
  MapPin,
  Mountain,
  Percent,
  Sun,
  Target,
  Zap,
} from "lucide-react";
import { useAppContext, usePlantHref } from "../context/AppContext";
import { api } from "../api/client";
import type { GrowattLive, GrowattLiveWeather, PwaPlantBaseline } from "../api/client";
import { useLivePoll } from "../context/useLivePoll";
import { EmptyState, LoadingState, Suspended, fmt } from "../components/ui";
import { SelectedPlantBanner } from "../components/SelectedPlantBanner";
import { GrowattAlarmLogPanel } from "../components/GrowattAlarmLogPanel";
import { dayLabel } from "@/lib/day";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { hhmm, invName, sumOrNull } from "./inverters/shared";
import type { LiveInverter } from "./inverters/shared";
import { prTone } from "./generation/charts";
import { usePowerPeriod } from "./overview/usePowerPeriod";
import type { PeriodFigures } from "./overview/usePowerPeriod";
import { StringPeriodPicker } from "../components/stringDetail/StringPeriodPicker";
import { slotTime } from "../components/stringDetail/period";
import { FillChart } from "./overview/FillChart";
import { Spinner } from "@/components/ui/spinner";
import { Link } from "react-router-dom";
import type { LucideIcon } from "lucide-react";
import { WeatherCard } from "./overview/WeatherCard";
import { LiveMeterCard } from "./overview/LiveMeterCard";
import { useLiveMeter } from "./overview/useLiveMeter";
import { usePlantBaseline } from "./overview/usePlantBaseline";
import { SensorTodayCard } from "./overview/SensorTodayCard";
import { SensorDayCard } from "./overview/SensorDayCard";
import { RadarRainCard } from "./overview/RadarRainCard";
import { InvertersOnlineTile, StringHealthTile } from "./overview/SummaryCards";
import { Meter, StatTile } from "./overview/StatTile";
import { hasLocation as validLocation } from "./visitRoute/format";
import { dateLocale, useI18n } from "../i18n";

// Leaflet (~40 KB gz) is fetched only when a plant map is shown.
/** "2026-11-11" → "11 Nov" */
const shortDay = (d: string | null | undefined) =>
  d ? new Date(`${d}T00:00:00`).toLocaleDateString(dateLocale(), { day: "numeric", month: "short" }) : undefined;

const PlantSatelliteMap = React.lazy(() => import("../components/PlantSatelliteMap"));

/** Facts strip under the Production chart (energy meter figures, Energy & Billing baseline), with
 * visible labels, one column each (wrapping on narrow screens). */
const PlantFacts: React.FC<{
  /** `hint`: a warning (amber "!"); `tip`: plain context, tooltip only; `href`: the item opens that page */
  items: ReadonlyArray<{ icon: LucideIcon; label: string; value: string; unit: string; hint?: string; tip?: string; href?: string }>;
  /** no frame of its own (a card footer gives it one) */
  flush?: boolean;
}> = ({ items, flush }) => (
  <dl
    style={{ gridTemplateColumns: `repeat(auto-fit, minmax(min(100%, 10.5rem), 1fr))` }}
    className={`grid divide-x divide-white/[0.06] overflow-hidden ${flush ? "" : "rounded-lg border border-white/[0.06] bg-white/[0.015]"}`}>
    {items.map(({ icon: Icon, label, value, unit, hint, tip, href }) => {
      const body = (
        <>
          <span className="hidden size-7 shrink-0 items-center justify-center rounded-md bg-white/[0.04] sm:flex">
            <Icon className="size-3.5 text-slate-400" aria-hidden />
          </span>
          <div className="flex min-w-0 flex-col">
            <dt className="truncate text-[11px] text-muted-foreground">
              {label}
              {hint && <span className="ml-1 text-amber-400" aria-label={hint}>!</span>}
            </dt>
            <dd className="num truncate">
              <span className="text-sm font-semibold text-slate-100">{value}</span>
              {value !== "—" && <span className="ml-1 text-[11px] text-muted-foreground">{unit}</span>}
            </dd>
          </div>
        </>
      );
      const cls = "flex min-w-0 items-center gap-2.5 px-3 py-2 sm:px-4";
      return href ? (
        <Link key={label} to={href} className={`${cls} transition-colors hover:bg-white/[0.04]`} title={hint ?? tip}>
          {body}
        </Link>
      ) : (
        <div key={label} className={cls} title={hint ?? tip}>
          {body}
        </div>
      );
    })}
  </dl>
);

/** The Production card's headline: the period's energy, specific yield, peak and Growatt's own
 * figure as large numbers above the chart (label and context in the tooltip). */
const HeadlineFigures: React.FC<{
  items: ReadonlyArray<{ label: string; value: string; unit: string; hint?: string; tip?: string }>;
}> = ({ items }) => (
  <dl className="grid grid-cols-2 gap-x-6 gap-y-3 px-(--card-spacing) pt-4 sm:flex sm:flex-wrap sm:gap-x-10">
    {items.map(({ label, value, unit, hint, tip }) => (
      <div key={label} className="min-w-0" title={hint ?? tip}>
        <dt className="truncate text-[11px] text-muted-foreground">
          {label}
          {hint && <span className="ml-1 text-amber-400" aria-label={hint}>!</span>}
        </dt>
        <dd className="num mt-1 flex items-baseline gap-1 whitespace-nowrap">
          <span className="text-lg leading-none font-semibold text-slate-50">{value}</span>
          {value !== "—" && <span className="text-[11px] text-muted-foreground">{unit}</span>}
        </dd>
      </div>
    ))}
  </dl>
);

const endOf = (pp: { day: string | null; endDay: string | null }) => pp.endDay ?? pp.day;

/** The stored day lags the live records by more than this: the freshness badge turns amber. */
const STORED_LAG_WARN_MIN = 20;

/** The Energy & Billing baseline items of the facts strip: the contract kWh of the period (modelled)
 * and the period's yield ÷ it. Both open the site in Energy & Billing. A period with a day that
 * has no contract figure shows "—", never a part sum. */
const baselineFacts = (
  b: PwaPlantBaseline,
  yieldKwh: number | null,
  period: string,
  open: boolean,
  t: (k: string, v?: Record<string, string | number>) => string
) => {
  const href = `/energy-billing?view=sites&site=${encodeURIComponent(b.site.site_id)}`;
  const gap = b.missing_days ? t("No contract figure for {n} day(s) of {period}", { n: b.missing_days, period }) : undefined;
  const pct = b.contract_kwh && yieldKwh != null ? (100 * yieldKwh) / b.contract_kwh : null;
  const pvsyst = b.pvsyst_kwh != null ? t(" · PVsyst P50 {v} kWh", { v: fmt(b.pvsyst_kwh, 0) }) : "";
  return [
    {
      icon: Target,
      label: t("Baseline (contract)"),
      value: fmt(b.contract_kwh, 1),
      unit: "kWh",
      hint: gap,
      tip: t("Energy & Billing baseline of {site} for {period}: the contract's expected energy, modelled{pvsyst}. Opens Energy & Billing.", { site: b.site.site_id, period, pvsyst }),
      href,
    },
    {
      icon: Percent,
      label: open ? t("Yield / baseline (so far)") : t("Yield / baseline"),
      value: fmt(pct, 1),
      unit: "%",
      hint: gap,
      tip: open
        ? t("Yield so far / the whole period's contract baseline: today is not finished")
        : t("The period's yield / its contract baseline (modelled)"),
      href,
    },
  ];
};

/** The headline items for the chart's period: energy, specific yield, grid import / export (energy
 * meter, measured), peak (with its time) and Growatt's own figure beside ours (never instead of it). */
const periodFacts = (
  f: PeriodFigures,
  pp: { label: string; multi: boolean; mode: "own" | "day" | "curve"; day: string | null; today: string },
  t: (k: string, v?: Record<string, string | number>) => string
) => {
  const open = pp.day === pp.today && !pp.multi;
  // today: the chart's live tail shows live meter values, but the kWh figures cover the stored records only
  const storedOnly = pp.day === pp.today ? t(" (stored records only, the chart's live tail is not counted)") : "";
  const peakAt = f.peakAt ? `${pp.multi ? `${shortDay(f.peakAt.slice(0, 10))} ` : ""}${hhmm(f.peakAt)}` : null;
  const items: Array<{ icon: LucideIcon; label: string; value: string; unit: string; hint?: string; tip?: string }> = [
    {
      icon: Zap,
      label: open ? t("Energy (so far)") : t("Energy"),
      value: fmt(f.energyKwh, 1),
      unit: "kWh",
      tip:
        pp.mode === "curve"
          ? t("AC energy for {period}, integrated from the stored 5-min records", { period: pp.label })
          : t("AC energy for {period}, from the inverters' own day counters", { period: pp.label }),
    },
    {
      icon: Sun,
      label: t("Specific yield"),
      value: fmt(f.specificKwhKwp, 2),
      unit: "kWh/kWp",
      tip: t("Energy / the plant's DC capacity for {period}", { period: pp.label }),
    },
    // the energy meter (measured), when the period has meter readings
    ...(f.gridImportKwh != null || f.gridExportKwh != null
      ? [
          {
            icon: ArrowDownToLine,
            label: t("Grid import"),
            value: fmt(f.gridImportKwh, 1),
            unit: "kWh",
            tip: t("Bought from the grid for {period}, measured by the energy meter{note}", { period: pp.label, note: storedOnly }),
          },
          {
            icon: ArrowUpFromLine,
            label: t("Grid export"),
            value: fmt(f.gridExportKwh, 1),
            unit: "kWh",
            tip: t("Sent to the grid for {period}, measured by the energy meter{note}", { period: pp.label, note: storedOnly }),
          },
        ]
      : []),
    {
      icon: Mountain,
      label: t("Peak power"),
      value: fmt(f.peakKw, 1),
      unit: peakAt ? `kW · ${peakAt}` : "kW",
      tip: t("Highest AC power for {period}", { period: pp.label }),
    },
  ];
  if (f.growattKwh != null || f.growattImplausible)
    items.push({
      icon: Cloud,
      label: t("Growatt (plant/energy)"),
      value: fmt(f.growattKwh, 1),
      unit: "kWh",
      hint: f.growattImplausible ? t("Growatt figure withheld (impossible)") : undefined,
      tip: t("Growatt's own figure for the whole days of {period}, shown beside ours, never instead", { period: pp.label }),
    });
  return items;
};

/**
 * `/plant/:id`: the plant at a glance. Top: "Now" (newest live record) and the stored day with
 * its power curve, next to the site map and the weather. Then one summary card per detail tab
 * (Inverters, String Diagnostics) and Growatt's fault log. "Now" comes from `plantLive` (raw live
 * record), never from the overlay, because the stored day can be older than the live record.
 */
export const OverviewPage: React.FC = () => {
  const { selectedPlantOverview: ov, plantOverviewLoading, plantError, plantLive, plantLiveLoading, plantLiveFailed } = useAppContext();
  const plantHref = usePlantHref();
  const { t } = useI18n();

  const plantId = ov?.plant.plant_id ?? null;
  const hasSensor = Boolean(ov?.weather?.has_sensor);

  // live weather: one poll shared by the "Now" irradiance and the Weather card (memory only)
  const [liveWx, setLiveWx] = useState<GrowattLive<GrowattLiveWeather> | null>(null);
  const [liveWxFailed, setLiveWxFailed] = useState(false);
  useEffect(() => {
    setLiveWx(null);
    setLiveWxFailed(false);
  }, [plantId]);
  useLivePoll(
    hasSensor && plantId != null,
    plantId,
    () => api.getGrowattLiveWeather(plantId as number),
    (r) => {
      setLiveWx(r);
      setLiveWxFailed(false);
    },
    () => setLiveWxFailed(true)
  );

  const recs: LiveInverter[] = useMemo(() => plantLive?.data?.inverters ?? [], [plantLive]);
  const liveAt = recs.reduce<string | null>((a, r) => (r.timestamp && (a == null || r.timestamp > a) ? r.timestamp : a), null);
  // the top card's period (stored data): the overview's day, or a picked day / range / time window
  // live energy meter: one poll for the Energy meter card and the chart's live tail (memory only)
  const liveMeter = useLiveMeter(plantId);
  const pp = usePowerPeriod(ov, liveAt, recs, liveMeter.points, { singlePanel: true, expected: true, dailyBars: true });
  const pf = pp.figures;
  // a newly picked period has no curve until it answers: keep this plant's last curve on screen, suspended
  const lastSpec = useRef<{ plantId: number | null; spec: NonNullable<typeof pp.spec> } | null>(null);
  if (pp.spec) lastSpec.current = { plantId, spec: pp.spec };
  const heldSpec = pp.loading && !pp.spec && lastSpec.current?.plantId === plantId ? lastSpec.current.spec : null;
  const meter = pf && (pf.loadKwh != null || pf.gridImportKwh != null || pf.gridExportKwh != null) ? pf : null;
  // curtailment estimate of the period: only where some slot could be judged (sensor + kWp)
  const curt = pf?.curtailment?.kwh != null ? pf.curtailment : null;
  // today: the chart's live tail shows live meter values, but the kWh figures cover the stored records only
  const meterStoredOnly = pp.day === pp.today ? t(" (stored records only, the chart's live tail is not counted)") : "";
  // Energy & Billing baseline (PWA contract kWh per day, modelled) for the chart's whole days
  const baseline = usePlantBaseline(plantId, pp.day, pp.endDay, pp.windowed);


  if (plantOverviewLoading && !ov) {
    return (
      <div className="flex flex-col gap-4">
        <SelectedPlantBanner />
        <LoadingState label={t("Loading the plant's inverters, strings & 5-minute history…")} shape="page" />
      </div>
    );
  }
  if (!ov) {
    return (
      <div className="flex flex-col gap-4">
        <SelectedPlantBanner />
        <EmptyState
          icon={Building2}
          title={t("Plant overview unavailable")}
          description={plantError?.message ?? t("The plant's stored history could not be loaded.")}
        />
      </div>
    );
  }

  const { plant, kpis: k } = ov;
  const day = ov.meta.day;
  const dayText = day ? dayLabel(day) : "—";
  const untilText = ov.meta.data_until ? hhmm(ov.meta.data_until) : null;
  const liveDay = plantLive?.data?.day ?? null;
  const behind = day != null && liveDay != null && day < liveDay;

  // Now: summed over the inverters' newest live records
  const acW = sumOrNull(recs.map((r) => r.pac_w));
  const ofKwp = acW != null && k.capacity_kwp ? (acW / 1000 / k.capacity_kwp) * 100 : null;

  const target = k.target_pr_pct ?? null;
  // set, finite, in range and not 0,0 (Growatt's "not set"): the satellite map and the radar card ask
  // nothing for a plant without a real location
  const hasLocation = validLocation(plant.latitude, plant.longitude);
  // with a sensor: beside the Today chart; without: in the Site column under the Energy meter
  const weatherCard = (className?: string) => (
    <WeatherCard
      key={`weather-${plantId}`}
      plantId={plant.plant_id}
      day={day ?? null}
      storedUntil={ov.weather?.data_until ?? null}
      liveWx={liveWx}
      liveWxFailed={liveWxFailed}
      className={className}
    />
  );

  // KPI strip: inverters online = in the live answer and not Waiting (status not 0); string health of the stored day
  const online = plantLive?.data ? recs.filter((r) => r.status !== 0).length : null;
  // Yield / revenue today from the live records (each inverter's own `eac_today` of today), so the
  // strip is current even when the stored day lags; only inverters with a record today are summed
  const todayRecs = liveDay ? recs.filter((r) => r.timestamp?.slice(0, 10) === liveDay && r.eac_today_kwh != null) : [];
  const liveYield = todayRecs.length ? todayRecs.reduce((a, r) => a + (r.eac_today_kwh ?? 0), 0) : null;
  const useLiveYield = liveYield != null;
  const yieldKwh = useLiveYield ? liveYield : k.yield_today_kwh;
  const yieldRevenue = yieldKwh != null ? yieldKwh * k.tariff_thb_per_kwh : null;
  const yieldSpecific = useLiveYield ? (k.capacity_kwp ? liveYield / k.capacity_kwp : null) : k.specific_yield_kwh_per_kwp;
  const yieldPartial = useLiveYield && k.inverter_count != null && todayRecs.length < k.inverter_count ? t(" · {n} of {total} inverters", { n: todayRecs.length, total: k.inverter_count }) : "";
  const dayPr = k.iec_pr_pct ?? k.plant_pr_pct ?? null;
  const dayPrBar = dayPr == null || target == null ? "bg-slate-400" : dayPr >= target ? "bg-emerald-400" : dayPr >= target - 5 ? "bg-amber-400" : "bg-red-400";
  const yieldSrc = useLiveYield ? ` · live ${hhmm(liveAt ?? "")}${yieldPartial}` : "";

  // Production card: freshness of today's curve (live records continue the stored ones)
  const showsToday = pp.day === pp.today && !pp.multi && !pp.windowed;
  const lagMin =
    liveAt && ov.meta.data_until && day === pp.today
      ? (Date.parse(liveAt.replace(" ", "T")) - Date.parse(ov.meta.data_until.replace(" ", "T"))) / 60_000
      : null;
  const storedBehind = lagMin == null ? !ov.meta.data_until || day !== pp.today : lagMin > STORED_LAG_WARN_MIN;
  const fresh =
    showsToday && liveAt
      ? {
          text: t("Live {time}", { time: hhmm(liveAt) }),
          warn: storedBehind,
          tip: storedBehind
            ? untilText && day === pp.today
              ? t("Stored records end at {t}; the rest of today comes from live records, not stored yet", { t: untilText })
              : t("No stored records today yet; the curve comes from live records, not stored yet")
            : t("Stored records to {t}, then the newest live records", { t: untilText ?? "—" }),
        }
      : null;

  return (
    <div className="flex flex-col gap-4">
      <SelectedPlantBanner />

      {/* KPI strip under the tab bar */}
      {/* keyed by plant: another plant's figures appear at once, never eased from this one's */}
      <div key={plantId} className="grid grid-cols-1 gap-3 min-[420px]:grid-cols-2 sm:grid-cols-3 xl:grid-cols-5">
        <StatTile
          label={t("PV Power")}
          tag={liveAt ? t("Live {time}", { time: hhmm(liveAt) }) : undefined}
          num={acW == null ? null : acW / 1000}
          unit="kW"
          tone="text-solar-300"
          meter={<Meter segments={ofKwp != null ? [{ pct: ofKwp, className: "bg-solar-400" }] : []} title={ofKwp != null ? t("{pct}% of capacity", { pct: fmt(ofKwp, 0) }) : undefined} />}
          footer={<span className="num">{k.capacity_kwp != null ? t("{pct}% of {kwp} kWp", { pct: ofKwp == null ? "—" : fmt(ofKwp, 0), kwp: fmt(k.capacity_kwp, 0) }) : t("Capacity unknown")}</span>}
        />
        <StatTile
          label={t("Yield")}
          tag={useLiveYield ? t("Live {time}", { time: hhmm(liveAt ?? "") }) : shortDay(day)}
          tagWarn={!useLiveYield && behind}
          num={yieldKwh}
          unit="kWh"
          tone="text-energy-300"
          footer={
            <>
              {yieldRevenue != null && <span className="num font-semibold text-foreground">≈ ฿{fmt(yieldRevenue, 0)}</span>}
              <span className="num">{fmt(yieldSpecific, 2)} kWh/kWp</span>
              {yieldPartial && <span className="num text-amber-300" title={yieldPartial.replace(/^ · /, "")}>{t("partial")}</span>}
            </>
          }
        />
        <StatTile
          label="PR"
          tag={shortDay(day)}
          tagWarn={behind}
          value={fmt(dayPr, 1)}
          unit="%"
          tone={target != null ? prTone(dayPr, target) : undefined}
          meter={
            <Meter
              segments={dayPr != null ? [{ pct: dayPr, className: dayPrBar }] : []}
              mark={target}
              title={`PR ${fmt(dayPr, 1)}%${target != null ? t(" · target {pct}%", { pct: fmt(target, 0) }) : ""}`}
            />
          }
          footer={<span className="num">{target != null ? t("target {pct}%", { pct: fmt(target, 0) }) : t("no target")} · {k.iec_pr_pct != null ? "IEC 61724" : t("peer")}</span>}
        />
        <InvertersOnlineTile ov={ov} href={plantHref("inverters")} recs={recs} liveLoading={plantLiveLoading} online={online}
          liveLoaded={plantLive?.data != null}
          unanswered={ov.inverters.filter((i) => i.device_sn in (plantLive?.data?.errors ?? {})).length}
        />
        <StringHealthTile ov={ov} href={plantHref("strings")} />
      </div>

      {/* columns stretch to the row: the production card grows (its chart takes the room) to the bottom of Site + Energy meter (+ Weather without a sensor) */}
      <div className="grid gap-4 xl:grid-cols-3">
        <div className="flex flex-col gap-4 xl:col-span-2">
          {/* Production: header (title, freshness, period) · headline figures · chart · secondary facts */}
          <Card className="flex-1 gap-0 overflow-hidden py-0">
            <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-white/[0.06] px-(--card-spacing) py-3">
              <div className="flex min-w-0 items-center gap-2.5">
                <CardTitle className="text-sm">{t("Production")}</CardTitle>
                {fresh && (
                  <Badge variant={fresh.warn ? "warn" : "ok"} className="num" title={fresh.tip}>
                    {fresh.text}
                  </Badge>
                )}
                {pp.loading && <Spinner className="size-3" aria-label={t("Loading the period…")} />}
              </div>
              <div className="flex items-center gap-1">
                <StringPeriodPicker
                  period={pp.period}
                  onChange={pp.setPeriod}
                  shownDay={pp.day}
                  today={pp.today}
                  loading={pp.loading}
                  time={false}
                  align="end"
                  resetLabel={t("Today")}
                  resetTitle={t("Back to today")}
                />
                <Button asChild variant="ghost" size="icon-sm" aria-label={t("Generation details")} title={t("Generation details")}>
                  <Link to={plantHref("performance")}>
                    <ArrowRight />
                  </Link>
                </Button>
              </div>
            </div>
            {pf && <HeadlineFigures items={periodFacts(pf, pp, t)} />}
            <div className="flex flex-1 flex-col px-(--card-spacing) pt-3 pb-4">
              <Suspended busy={heldSpec != null} pill="center" className="flex flex-1 flex-col" contentClassName="flex flex-1 flex-col">
                <FillChart
                  spec={heldSpec ?? pp.spec}
                  minHeight={260}
                  legendToggle
                  legendPosition="bottom"
                  emptyLabel={
                    pp.error
                      ? t("Could not load: {error}", { error: pp.error })
                      : pp.day === pp.today
                        ? t("No stored records for {period} yet (the worker stores them every 10 min)", { period: pp.label })
                        : t("No stored records for {period}", { period: pp.label })
                  }
                  onBrush={pp.multi || !pp.day ? undefined : (lo, hi) => pp.setPeriod({ ...pp.period, day: pp.day, start: slotTime(lo, pp.day!, false), end: slotTime(hi, pp.day!, true) })}
                  onPick={pp.barDays ? (i) => pp.barDays?.[i] && pp.setPeriod({ day: pp.barDays[i], endDay: null, start: "", end: "" }) : undefined}
                />
              </Suspended>
            </div>
            {/* the Energy & Billing baseline (PWA report sites), the energy meter (when the period
                has meter readings) and the curtailment estimate, for the chart's period */}
            {(baseline || meter || curt) && (
              <div className="border-t border-white/[0.06] bg-white/[0.015]">
                <PlantFacts
                  flush
                  items={[
                    ...(baseline ? baselineFacts(baseline, pf?.energyKwh ?? null, pp.label, (endOf(pp) ?? "") >= pp.today, t) : []),
                    ...(meter ? [
                    {
                      icon: House,
                      label: t("Load (derived)"),
                      value: fmt(meter.loadKwh, 1),
                      unit: "kWh",
                      tip: t("Site consumption for {period}: PV AC + grid, derived from the energy meter, not measured{note}", { period: pp.label, note: meterStoredOnly }),
                    },
                    ] : []),
                    ...(curt ? [
                    {
                      icon: Gauge,
                      label: t("Curtailed (estimated)"),
                      value: fmt(curt.kwh, 1),
                      unit: "kWh",
                      tip: t("Estimated energy held back for {period}: modelled available power (kWp × POA × temperature × EPI factor {f}) − AC, in {n} slot(s) where the meter held ~0 kW (zero export) or the AC sat at the power limit. Not measured{note}", {
                        period: pp.label,
                        f: fmt(curt.factor, 3),
                        n: curt.slots,
                        note: meterStoredOnly,
                      }) + " " + (curt.calibration?.ratio != null
                        ? t(curt.calibration.status === "plant"
                            ? "Model scaled to {r} %: how this plant ran when nothing held it back over the 14 days before."
                            : "Model scaled to {r} %: the fleet's ratio, as this plant had too few free-running slots of its own.", { r: fmt(curt.calibration.ratio * 100, 0) })
                        : t("Model not checked yet against free running, so it may read high.")),
                    },
                    ] : []),
                  ]}
                />
              </div>
            )}
          </Card>
        </div>
        {/* Site + energy meter (+ weather without a sensor) */}
        <div className="flex flex-col gap-4">
          <Card className="gap-3">
            <CardHeader>
              <CardTitle>{t("Location")}</CardTitle>
              {hasLocation && (
                <CardAction>
                  <Button asChild variant="ghost" size="icon-sm" aria-label={t("Open in Google Maps")} title={t("Open in Google Maps")}>
                    <a href={`https://www.google.com/maps?q=${plant.latitude},${plant.longitude}`} target="_blank" rel="noreferrer">
                      <ExternalLink />
                    </a>
                  </Button>
                </CardAction>
              )}
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              {hasLocation ? (
                <Suspense fallback={<Skeleton className="h-56 w-full" aria-label={t("Loading map…")} />}>
                  <PlantSatelliteMap
                    lat={plant.latitude as number}
                    lon={plant.longitude as number}
                    name={plant.name}
                    capacityKwp={plant.peak_power_kwp}
                    heightClass="h-56"
                  />
                </Suspense>
              ) : (
                <div className="flex h-32 items-center justify-center gap-2 rounded-lg border border-dashed border-white/[0.08] text-xs text-muted-foreground">
                  <MapPin className="size-4" /> {t("No location")}
                </div>
              )}
            </CardContent>
          </Card>

          <LiveMeterCard key={`meter-${plantId}`} m={liveMeter} />

          {/* no sensor: no Today chart, so the Weather card (Google rain) stays in this column */}
          {!hasSensor && weatherCard()}
          {!hasSensor && hasLocation && <RadarRainCard key={`radar-${plantId}`} plantId={plant.plant_id} />}
        </div>
      </div>

      {/* Today's weather-sensor chart (the Sensors tab's "Today") with the Weather card to its right, only when the plant has a sensor */}
      {hasSensor && (
        <div className="grid gap-4 xl:grid-cols-3">
          <div className="flex min-w-0 flex-col xl:col-span-2 [&>*]:flex-1">
            <SensorTodayCard key={`sensor-${plant.plant_id}`} ov={ov} href={plantHref("sensors")} />
          </div>
          {/* own height, not stretched to the (much taller) chart beside it; the space under Weather
              holds the stored day's sensor figures and the radar rain now */}
          <div className="flex min-w-0 flex-col gap-4 xl:self-start">
            {weatherCard()}
            <SensorDayCard key={`sensorday-${plantId}`} ov={ov} dayText={dayText} />
            {hasLocation && <RadarRainCard key={`radar-${plantId}`} plantId={plant.plant_id} />}
          </div>
        </div>
      )}

      {/* Fault log reported by Growatt (string diagnostics are on String Diagnostics) */}
      <GrowattAlarmLogPanel
        plantId={plant.plant_id}
        plantName={plant.name}
        day={day ?? null}
        compact
        inverterNames={Object.fromEntries(ov.inverters.map((i) => [i.device_sn, invName(i)]))}
        inverterHref={(sn) => `${plantHref("inverters")}?sn=${encodeURIComponent(sn)}`}
      />
    </div>
  );
};
