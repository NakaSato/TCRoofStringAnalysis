import React, { Suspense, useEffect, useMemo, useState } from "react";
import {
  ArrowRight,
  BatteryCharging,
  Building2,
  Coins,
  ExternalLink,
  MapPin,
  PanelsTopLeft,
  Sun,
  Zap,
} from "lucide-react";
import { useAppContext, usePlantHref } from "../context/AppContext";
import { api } from "../api/client";
import type { GrowattLive, GrowattLiveWeather } from "../api/client";
import { useLivePoll } from "../context/useLivePoll";
import { EmptyState, KpiTile, LoadingState, fmt } from "../components/ui";
import { SelectedPlantBanner } from "../components/SelectedPlantBanner";
import { GrowattAlarmLogPanel } from "../components/GrowattAlarmLogPanel";
import { dayLabel } from "@/lib/day";
import { cn } from "@/lib/utils";
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
import { WeatherCard } from "./overview/WeatherCard";
import { SensorTodayCard } from "./overview/SensorTodayCard";
import { IssuesCard } from "./overview/IssuesCard";
import { InvertersOnlineTile, StringHealthTile } from "./overview/SummaryCards";
import { IconStat, IconStats } from "./overview/IconStat";

// Leaflet (~40 KB gz) is fetched only when a plant map is shown.
const PlantSatelliteMap = React.lazy(() => import("../components/PlantSatelliteMap"));

const kw = (w: number | null) => fmt(w == null ? null : w / 1000, 1);

/** Plant-local "YYYY-MM-DD HH:MM:SS": before 06:00 or from 19:00 no production is expected. */
const isNight = (ts: string | null) => {
  if (!ts) return false;
  const h = Number(ts.slice(11, 13));
  return h < 6 || h >= 19;
};

/** One of the three headline numbers: small label, big value, optional short note and capacity bar. */
const Headline: React.FC<{
  label: string;
  value: string;
  unit: string;
  tone: string;
  sub?: string;
  badge?: React.ReactNode;
  /** 0–100: fills a thin bar under the value */
  bar?: number | null;
  barTitle?: string;
}> = ({ label, value, unit, tone, sub, badge, bar, barTitle }) => (
  <div className="flex min-w-0 flex-col gap-1 rounded-lg border border-white/[0.06] bg-white/[0.02] px-4 py-3">
    <span className="flex items-center justify-between gap-2 text-xs text-slate-400">
      {label}
      {badge}
    </span>
    <span className="num truncate">
      <span className={cn("text-3xl font-semibold tracking-tight", tone)}>{value}</span>
      {value !== "—" && <span className="ml-1.5 text-sm text-muted-foreground">{unit}</span>}
    </span>
    {bar != null && (
      <div className="h-1 overflow-hidden rounded-full bg-white/[0.06]" title={barTitle} role="img" aria-label={barTitle}>
        <div className="h-full rounded-full bg-solar-400" style={{ width: `${Math.max(0, Math.min(100, bar))}%` }} />
      </div>
    )}
    {sub && <span className="num truncate text-xs text-muted-foreground">{sub}</span>}
  </div>
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
  const pp = usePowerPeriod(ov, liveAt);

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

  // The top card's period: today by default, or what the picker chose
  const f = pp.figures;
  const pr = f?.prPct ?? null;
  const target = k.target_pr_pct ?? null;
  const energy = f?.energyKwh ?? null;
  // the period's own day rate when it is one day; a range / window uses today's rate (estimate, "≈")
  const revenue = energy != null ? energy * (f?.tariffThbPerKwh ?? k.tariff_thb_per_kwh) : null;
  const hasLocation = plant.latitude != null && plant.longitude != null;

  const night = isNight(liveAt);
  // the overview's own day keeps "Today"; a picked period is named as picked
  const periodCap = pp.mode === "own" ? (day ? (behind ? dayText : "Today") : "Today") : pp.label;


  // KPI strip: inverters online = reporting in the live answer (status not 0); string health of the stored day
  const online = plantLive?.data ? recs.filter((r) => r.status !== 0).length : null;
  const dayCap = behind ? dayText : "Today";
  // Yield / revenue today from the live records (each inverter's own `eac_today` of today), so the
  // strip is current even when the stored day lags; only inverters with a record today are summed
  const todayRecs = liveDay ? recs.filter((r) => r.timestamp?.slice(0, 10) === liveDay && r.eac_today_kwh != null) : [];
  const liveYield = todayRecs.length ? todayRecs.reduce((a, r) => a + (r.eac_today_kwh ?? 0), 0) : null;
  const useLiveYield = liveYield != null;
  const yieldKwh = useLiveYield ? liveYield : k.yield_today_kwh;
  const yieldCap = useLiveYield ? "Today" : dayCap;
  const yieldRevenue = yieldKwh != null ? yieldKwh * k.tariff_thb_per_kwh : null;
  const yieldSpecific = useLiveYield ? (k.capacity_kwp ? liveYield / k.capacity_kwp : null) : k.specific_yield_kwh_per_kwp;
  const yieldPartial = useLiveYield && k.inverter_count != null && todayRecs.length < k.inverter_count ? ` · ${todayRecs.length} of ${k.inverter_count} inverters` : "";
  const yieldSrc = useLiveYield ? ` · live ${hhmm(liveAt ?? "")}${yieldPartial}` : "";

  return (
    <div className="flex flex-col gap-4">
      <SelectedPlantBanner />

      {/* KPI strip under the tab bar */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-5">
        <KpiTile
          label="PV Power"
          icon={Sun}
          tone="solar"
          accentBar={false}
          value={acW == null ? "—" : fmt(acW / 1000, 1)}
          unit="kW"
          hint={k.capacity_kwp != null ? `${ofKwp == null ? "—" : fmt(ofKwp, 0)}% of ${fmt(k.capacity_kwp, 1)} kWp` : "Capacity unknown"}
        />
        <KpiTile
          label={`Yield ${yieldCap}`}
          icon={Zap}
          tone="energy"
          accentBar={false}
          value={fmt(yieldKwh, 1)}
          unit="kWh"
          hint={`${fmt(yieldSpecific, 2)} kWh/kWp${yieldSrc}`}
        />
        <KpiTile
          label={`Revenue ${yieldCap}`}
          icon={Coins}
          accentBar={false}
          value={yieldRevenue == null ? "—" : `฿${fmt(yieldRevenue, 0)}`}
          hint={`Tariff ฿${fmt(k.tariff_thb_per_kwh, 2)}/kWh`}
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
              {/* the period every stored figure below follows ("Power now" stays live) */}
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
              <div className="grid gap-3 sm:grid-cols-3">
                <Headline
                  label="Power now"
                  value={night && (acW ?? 0) === 0 ? "0" : kw(acW)}
                  unit="kW"
                  tone="text-solar-300"
                  bar={night ? null : ofKwp}
                  barTitle={ofKwp != null ? `${fmt(ofKwp, 0)}% of ${fmt(k.capacity_kwp, 1)} kWp` : undefined}
                  sub={night ? "night" : liveAt ? undefined : "no live record"}
                />
                <Headline
                  label={`Energy · ${periodCap}`}
                  value={pp.loading && !f ? "…" : fmt(energy, energy != null && energy < 100 ? 1 : 0)}
                  unit="kWh"
                  tone="text-energy-300"
                  sub={
                    [
                      revenue != null ? `≈ ฿${fmt(revenue, 0)}` : null,
                      f?.growattKwh != null ? `Growatt ${fmt(f.growattKwh, 0)} kWh` : null,
                      f?.growattImplausible ? "Growatt figure withheld (impossible)" : null,
                    ]
                      .filter(Boolean)
                      .join(" · ") || undefined
                  }
                />
                <Headline
                  label={`PR · ${periodCap}`}
                  value={pp.loading && !f ? "…" : fmt(pr, 1)}
                  unit="%"
                  tone={target != null ? prTone(pr, target) : "text-foreground"}
                  sub={
                    pp.mode === "curve"
                      ? "whole single day only"
                      : target != null
                        ? `target ${fmt(target, 0)}%${f?.prIec ? "" : " · peer"}`
                        : undefined
                  }
                />
              </div>

              <FillChart
                spec={pp.spec}
                minHeight={240}
                legendToggle
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
              <IconStats cols="grid-cols-3">
                <IconStat
                  icon={PanelsTopLeft}
                  label="DC capacity"
                  value={fmt(k.capacity_kwp, 1)}
                  unit="kWp"
                  hint={
                    plant.reported_peak_power_kwp != null && k.capacity_kwp == null
                      ? `Growatt lists ${fmt(plant.reported_peak_power_kwp, 0)} kWp, impossible for its inverters`
                      : undefined
                  }
                />
                <IconStat
                  icon={BatteryCharging}
                  label="Lifetime yield"
                  value={fmt(k.total_yield_kwh == null ? null : k.total_yield_kwh / 1000, 1)}
                  unit="MWh"
                />
                <IconStat icon={Coins} label="Tariff" value={`฿${fmt(k.tariff_thb_per_kwh, 2)}`} unit="/kWh" />
              </IconStats>
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
