import React, { Suspense, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
  ArrowRight,
  BatteryCharging,
  Building2,
  Coins,
  Cpu,
  ExternalLink,
  Gauge,
  HeartPulse,
  Leaf,
  MapPin,
  PanelsTopLeft,
  Sun,
  TrendingUp,
  Zap,
} from "lucide-react";
import { useAppContext, usePlantHref } from "../context/AppContext";
import { api } from "../api/client";
import type { GrowattLive, GrowattLiveWeather } from "../api/client";
import { useLivePoll } from "../context/useLivePoll";
import { EmptyState, KpiTile, LoadingState, fmt } from "../components/ui";
import { SelectedPlantBanner } from "../components/SelectedPlantBanner";
import { GrowattAlarmLogPanel } from "../components/GrowattAlarmLogPanel";
import { PanelChart } from "../components/PanelChart";
import { dayLabel } from "@/lib/day";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { hhmm, invName, sumOrNull } from "./inverters/shared";
import type { LiveInverter } from "./inverters/shared";
import { powerSpec, prTone } from "./generation/charts";
import { WeatherCard } from "./overview/WeatherCard";
import { SensorTodayCard } from "./overview/SensorTodayCard";
import { InvertersSummary, StringsSummary } from "./overview/SummaryCards";
import { IconStat, IconStats } from "./overview/IconStat";

// Leaflet (~40 KB gz) is fetched only when a plant map is shown.
const PlantSatelliteMap = React.lazy(() => import("../components/PlantSatelliteMap"));

/** Thailand grid emission factor (TGO), kg CO2e per kWh. */
const GRID_EF_KG_PER_KWH = 0.4999;

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
  const power = useMemo(() => (ov ? powerSpec(ov, liveAt) : null), [ov, liveAt]);

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
  const liveStale = Boolean(plantLive?.stale) || recs.some((r) => r.stale);
  const acW = sumOrNull(recs.map((r) => r.pac_w));
  const dcW = sumOrNull(recs.map((r) => r.ppv_w));
  const etaNow = acW != null && dcW != null && dcW > 500 ? Math.min(100, (acW / dcW) * 100) : null;
  const ofKwp = acW != null && k.capacity_kwp ? (acW / 1000 / k.capacity_kwp) * 100 : null;
  const wx = liveWx?.data.sensors[0] ?? null;

  // Stored day
  const iec = k.iec_pr_pct ?? null;
  const pr = iec ?? k.plant_pr_pct;
  const target = k.target_pr_pct ?? null;
  const revenue = k.yield_today_kwh != null ? k.yield_today_kwh * k.tariff_thb_per_kwh : null;
  const co2t = k.yield_today_kwh != null ? (k.yield_today_kwh * GRID_EF_KG_PER_KWH) / 1000 : null;
  const peak = ov.timeseries.reduce<(typeof ov.timeseries)[number] | null>((m, r) => (m == null || r.pac_kw > m.pac_kw ? r : m), null);
  const hasLocation = plant.latitude != null && plant.longitude != null;

  const night = isNight(liveAt);
  const dayShort = day ? (behind ? dayText : "Today") : "Today";

  const freshness = liveAt ? (
    <Badge
      variant={liveStale ? "warn" : "ok"}
      className="num"
      title={liveStale ? "Growatt refused the last call; showing the previous record" : undefined}
    >
      {liveStale ? "Stale" : "Live"} · {hhmm(liveAt)}
    </Badge>
  ) : untilText ? (
    <Badge variant="neutral" className="num" title="Newest stored 5-minute record (the worker syncs every 30 min)">
      Last sync · {untilText}
    </Badge>
  ) : null;

  // KPI strip: inverters online = reporting in the live answer (status not 0); string health of the stored day
  const online = plantLive?.data ? recs.filter((r) => r.status !== 0).length : null;
  const critical = k.critical_strings ?? 0;
  const warning = k.warning_strings ?? 0;
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
        <KpiTile
          label="Inverters Online"
          icon={Cpu}
          tone="ok"
          accentBar={false}
          value={`${online ?? "—"} / ${k.inverter_count ?? "—"}`}
          hint={`Avg temp ${fmt(k.avg_temp_c, 1)}°C`}
        />
        <KpiTile
          label="String Health"
          icon={HeartPulse}
          tone={critical > 0 ? "crit" : warning > 0 ? "warn" : "ok"}
          accentBar={false}
          value={fmt(k.avg_health_score, 1)}
          unit="/ 100"
          hint={`${critical} critical · ${warning} warning`}
          hintTone={critical > 0 ? "crit" : warning > 0 ? "warn" : "neutral"}
        />
      </div>

      <div className="grid items-start gap-4 xl:grid-cols-3">
        <div className="flex flex-col gap-4 xl:col-span-2">
          {/* Three headline numbers and the day's power curve */}
          <Card className="gap-5">
            <CardContent className="flex flex-col gap-5">
              <div className="grid gap-3 sm:grid-cols-3">
                <Headline
                  label="Power now"
                  badge={freshness}
                  value={night && (acW ?? 0) === 0 ? "0" : kw(acW)}
                  unit="kW"
                  tone="text-solar-300"
                  bar={night ? null : ofKwp}
                  barTitle={ofKwp != null ? `${fmt(ofKwp, 0)}% of ${fmt(k.capacity_kwp, 1)} kWp` : undefined}
                  sub={night ? "night" : liveAt ? undefined : "no live record"}
                />
                <Headline
                  label={`Energy · ${dayShort}`}
                  value={fmt(k.yield_today_kwh, 0)}
                  unit="kWh"
                  tone="text-energy-300"
                  sub={revenue != null ? `≈ ฿${fmt(revenue, 0)}` : undefined}
                />
                <Headline
                  label={`PR · ${dayShort}`}
                  value={fmt(pr, 1)}
                  unit="%"
                  tone={target != null ? prTone(pr, target) : "text-foreground"}
                  sub={target != null ? `target ${fmt(target, 0)}%${iec != null ? "" : " · peer"}` : undefined}
                />
              </div>

              <div className="flex flex-col gap-2">
                <div className="flex items-center justify-between gap-3">
                  <span className="num text-xs text-muted-foreground">
                    {dayText}
                    {untilText ? ` · ${untilText}` : ""}
                  </span>
                  <Button asChild variant="ghost" size="icon-sm" aria-label="Generation details" title="Generation details">
                    <Link to={plantHref("generation")}>
                      <ArrowRight />
                    </Link>
                  </Button>
                </div>
                <PanelChart spec={power} height={240} legendToggle emptyLabel="No stored records for this day" />
              </div>

              <IconStats cols={hasSensor ? "grid-cols-2 sm:grid-cols-5" : "grid-cols-2 sm:grid-cols-4"}>
                <IconStat
                  icon={Zap}
                  label="DC input now"
                  value={kw(dcW)}
                  unit="kW"
                  hint={etaNow != null ? `${fmt(etaNow, 1)}% converted to AC` : undefined}
                />
                {hasSensor && (
                  <IconStat icon={Sun} label="Irradiance now" value={fmt(wx?.irradiance_wm2, 0)} unit="W/m²" hint="Plant weather sensor" />
                )}
                <IconStat
                  icon={TrendingUp}
                  label="Peak power"
                  value={fmt(k.peak_power_kw, 1)}
                  unit="kW"
                  hint={peak ? `at ${hhmm(peak.timestamp)} · ${dayText}` : dayText}
                />
                <IconStat icon={Gauge} label="Specific yield" value={fmt(k.specific_yield_kwh_per_kwp, 2)} unit="kWh/kWp" hint={dayText} />
                <IconStat icon={Leaf} label="CO₂ avoided" value={fmt(co2t, 2)} unit="t" hint={`${dayText} · TGO grid factor`} />
              </IconStats>
            </CardContent>
          </Card>
          <div className="grid gap-4 lg:grid-cols-2">
            <InvertersSummary ov={ov} href={plantHref("inverters")} recs={recs} liveLoading={plantLiveLoading} />
            <StringsSummary ov={ov} href={plantHref("strings")} />
          </div>
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
