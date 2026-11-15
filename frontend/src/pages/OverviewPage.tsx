import React, { Suspense, useEffect, useMemo, useState } from "react";
import {
  ArrowRight,
  Banknote,
  Building2,
  ExternalLink,
  Grid3x3,
  MapPin,
  Sigma,
} from "lucide-react";
import { useAppContext, usePlantHref } from "../context/AppContext";
import { api } from "../api/client";
import type { GrowattLive, GrowattLiveWeather } from "../api/client";
import { useLivePoll } from "../context/useLivePoll";
import { EmptyState, LoadingState, fmt } from "../components/ui";
import { SelectedPlantBanner } from "../components/SelectedPlantBanner";
import { GrowattAlarmLogPanel } from "../components/GrowattAlarmLogPanel";
import { dayLabel } from "@/lib/day";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { hhmm, invName, sumOrNull } from "./inverters/shared";
import type { LiveInverter } from "./inverters/shared";
import { prTone } from "./generation/charts";
import { usePowerPeriod } from "./overview/usePowerPeriod";
import { StringPeriodPicker } from "../components/stringDetail/StringPeriodPicker";
import { slotTime } from "../components/stringDetail/period";
import { FillChart } from "./overview/FillChart";
import { Spinner } from "@/components/ui/spinner";
import { Link } from "react-router-dom";
import type { LucideIcon } from "lucide-react";
import { WeatherCard } from "./overview/WeatherCard";
import { SensorTodayCard } from "./overview/SensorTodayCard";
import { IssuesCard } from "./overview/IssuesCard";
import { InvertersOnlineTile, StringHealthTile } from "./overview/SummaryCards";
import { Meter, StatTile } from "./overview/StatTile";

// Leaflet (~40 KB gz) is fetched only when a plant map is shown.
/** "2026-11-11" → "11 Nov" */
const shortDay = (d: string | null | undefined) =>
  d ? new Date(`${d}T00:00:00`).toLocaleDateString("en-GB", { day: "numeric", month: "short" }) : undefined;

const PlantSatelliteMap = React.lazy(() => import("../components/PlantSatelliteMap"));

/** Plant facts strip at the top of the Production card: fixed registry numbers with visible labels. */
const PlantFacts: React.FC<{
  items: ReadonlyArray<{ icon: LucideIcon; label: string; value: string; unit: string; hint?: string }>;
}> = ({ items }) => (
  <dl className="grid grid-cols-3 divide-x divide-white/[0.06] rounded-lg border border-white/[0.06] bg-white/[0.015]">
    {items.map(({ icon: Icon, label, value, unit, hint }) => (
      <div key={label} className="flex min-w-0 items-center gap-2.5 px-3 py-2 sm:px-4" title={hint}>
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
      </div>
    ))}
  </dl>
);

/**
 * `/plant/:id`: the plant at a glance. Top: "Now" (newest live record) and the stored day with
 * its power curve, next to the site map and the weather. Then one summary card per detail tab
 * (Inverters, String Diagnostics) and Growatt's fault log. "Now" comes from `plantLive` (raw live
 * record), never from the overlay, because the stored day can be older than the live record.
 */
export const OverviewPage: React.FC = () => {
  const { selectedPlantOverview: ov, plantOverviewLoading, plantError, plantLive, plantLiveLoading, plantLiveFailed } = useAppContext();
  const plantHref = usePlantHref();

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
  const pp = usePowerPeriod(ov, liveAt, recs);

  if (plantOverviewLoading && !ov) {
    return (
      <div className="flex flex-col gap-4">
        <SelectedPlantBanner />
        <LoadingState label="Loading the plant's inverters, strings & 5-minute history…" shape="page" />
      </div>
    );
  }
  if (!ov) {
    return (
      <div className="flex flex-col gap-4">
        <SelectedPlantBanner />
        <EmptyState
          icon={Building2}
          title="Plant overview unavailable"
          description={plantError?.message ?? "The plant's stored history could not be loaded."}
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
  const hasLocation = plant.latitude != null && plant.longitude != null;



  // KPI strip: inverters online = reporting in the live answer (status not 0); string health of the stored day
  const online = plantLive?.data ? recs.filter((r) => r.status !== 0).length : null;
  // Yield / revenue today from the live records (each inverter's own `eac_today` of today), so the
  // strip is current even when the stored day lags; only inverters with a record today are summed
  const todayRecs = liveDay ? recs.filter((r) => r.timestamp?.slice(0, 10) === liveDay && r.eac_today_kwh != null) : [];
  const liveYield = todayRecs.length ? todayRecs.reduce((a, r) => a + (r.eac_today_kwh ?? 0), 0) : null;
  const useLiveYield = liveYield != null;
  const yieldKwh = useLiveYield ? liveYield : k.yield_today_kwh;
  const yieldRevenue = yieldKwh != null ? yieldKwh * k.tariff_thb_per_kwh : null;
  const yieldSpecific = useLiveYield ? (k.capacity_kwp ? liveYield / k.capacity_kwp : null) : k.specific_yield_kwh_per_kwp;
  const yieldPartial = useLiveYield && k.inverter_count != null && todayRecs.length < k.inverter_count ? ` · ${todayRecs.length} of ${k.inverter_count} inverters` : "";
  const dayPr = k.iec_pr_pct ?? k.plant_pr_pct ?? null;
  const dayPrBar = dayPr == null || target == null ? "bg-slate-400" : dayPr >= target ? "bg-emerald-400" : dayPr >= target - 5 ? "bg-amber-400" : "bg-red-400";
  const yieldSrc = useLiveYield ? ` · live ${hhmm(liveAt ?? "")}${yieldPartial}` : "";

  return (
    <div className="flex flex-col gap-4">
      <SelectedPlantBanner />

      {/* KPI strip under the tab bar */}
      <div className="grid grid-cols-1 gap-3 min-[420px]:grid-cols-2 sm:grid-cols-3 xl:grid-cols-5">
        <StatTile
          label="PV Power"
          tag={liveAt ? `Live ${hhmm(liveAt)}` : undefined}
          value={acW == null ? "—" : fmt(acW / 1000, 1)}
          unit="kW"
          tone="text-solar-300"
          meter={<Meter segments={ofKwp != null ? [{ pct: ofKwp, className: "bg-solar-400" }] : []} title={ofKwp != null ? `${fmt(ofKwp, 0)}% of capacity` : undefined} />}
          footer={<span className="num">{k.capacity_kwp != null ? `${ofKwp == null ? "—" : fmt(ofKwp, 0)}% of ${fmt(k.capacity_kwp, 0)} kWp` : "Capacity unknown"}</span>}
        />
        <StatTile
          label="Yield"
          tag={useLiveYield ? `Live ${hhmm(liveAt ?? "")}` : shortDay(day)}
          tagWarn={!useLiveYield && behind}
          value={fmt(yieldKwh, 1)}
          unit="kWh"
          tone="text-energy-300"
          footer={
            <>
              {yieldRevenue != null && <span className="num font-semibold text-foreground">≈ ฿{fmt(yieldRevenue, 0)}</span>}
              <span className="num">{fmt(yieldSpecific, 2)} kWh/kWp</span>
              {yieldPartial && <span className="num text-amber-300" title={yieldPartial.replace(/^ · /, "")}>partial</span>}
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
              title={`PR ${fmt(dayPr, 1)}%${target != null ? ` · target ${fmt(target, 0)}%` : ""}`}
            />
          }
          footer={<span className="num">{target != null ? `target ${fmt(target, 0)}%` : "no target"} · {k.iec_pr_pct != null ? "IEC 61724" : "peer"}</span>}
        />
        <InvertersOnlineTile ov={ov} href={plantHref("inverters")} recs={recs} liveLoading={plantLiveLoading} online={online} />
        <StringHealthTile ov={ov} href={plantHref("strings")} />
      </div>

      {/* columns stretch to the row: the production card grows (its chart takes the room) to the bottom of Site + Weather */}
      <div className="grid gap-4 xl:grid-cols-3">
        <div className="flex flex-col gap-4 xl:col-span-2">
          {/* Three headline numbers and the period's power curve */}
          <Card className="flex-1 gap-5">
            <CardContent className="flex flex-1 flex-col gap-5">
              {/* the period the chart follows */}
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-3">
                  <CardTitle>Production</CardTitle>
                  {pp.mode === "own" && untilText && <span className="num text-xs text-muted-foreground">{dayText} · {untilText}</span>}
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  {pp.loading && <Spinner className="size-3" />}
                  <StringPeriodPicker
                    period={pp.period}
                    onChange={pp.setPeriod}
                    shownDay={pp.day}
                    today={pp.today}
                    loading={pp.loading}
                    time={false}
                    align="end"
                    resetLabel="Today"
                    resetTitle="Back to today"
                  />
                  <Button asChild variant="ghost" size="icon-sm" aria-label="Generation details" title="Generation details">
                    <Link to={plantHref("generation")}>
                      <ArrowRight />
                    </Link>
                  </Button>
                </div>
              </div>
              {/* plant facts (registry, not period-bound) */}
              <PlantFacts
                items={[
                  {
                    icon: Grid3x3,
                    label: "DC capacity",
                    value: fmt(k.capacity_kwp, 1),
                    unit: "kWp",
                    hint:
                      plant.reported_peak_power_kwp != null && k.capacity_kwp == null
                        ? `Growatt lists ${fmt(plant.reported_peak_power_kwp, 0)} kWp, impossible for its inverters`
                        : undefined,
                  },
                  {
                    icon: Sigma,
                    label: "Lifetime yield",
                    value: fmt(k.total_yield_kwh == null ? null : k.total_yield_kwh / 1000, 1),
                    unit: "MWh",
                  },
                  { icon: Banknote, label: "Tariff", value: `฿${fmt(k.tariff_thb_per_kwh, 2)}`, unit: "/kWh" },
                ]}
              />
              <FillChart
                spec={pp.spec}
                minHeight={240}
                legendToggle
                legendPosition="bottom"
                emptyLabel={pp.error ? `Could not load: ${pp.error}` : `No stored records for ${pp.label}${pp.day === pp.today ? " yet (the worker stores them every 30 min)" : ""}`}
                onBrush={pp.multi || !pp.day ? undefined : (lo, hi) => pp.setPeriod({ ...pp.period, day: pp.day, start: slotTime(lo, pp.day!, false), end: slotTime(hi, pp.day!, true) })}
              />

            </CardContent>
          </Card>
        </div>
        {/* Site + weather */}
        <div className="flex flex-col gap-4">
          <Card className="gap-3">
            <CardHeader>
              <CardTitle>Site</CardTitle>
              {hasLocation && (
                <CardAction>
                  <Button asChild variant="ghost" size="icon-sm" aria-label="Open in Google Maps" title="Open in Google Maps">
                    <a href={`https://www.google.com/maps?q=${plant.latitude},${plant.longitude}`} target="_blank" rel="noreferrer">
                      <ExternalLink />
                    </a>
                  </Button>
                </CardAction>
              )}
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              {hasLocation ? (
                <Suspense fallback={<Skeleton className="h-56 w-full" aria-label="Loading map…" />}>
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
                  <MapPin className="size-4" /> No location
                </div>
              )}
            </CardContent>
          </Card>

          <WeatherCard
            plantId={plant.plant_id}
            day={day ?? null}
            storedUntil={ov.weather?.data_until ?? null}
            liveWx={liveWx}
            liveWxFailed={liveWxFailed}
          />
          <IssuesCard plantId={plant.plant_id} />
        </div>
      </div>

      {/* Today's weather-sensor chart (the Sensors tab's "Today"), only when the plant has a sensor */}
      {hasSensor && <SensorTodayCard key={plant.plant_id} ov={ov} href={plantHref("sensors")} />}

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
