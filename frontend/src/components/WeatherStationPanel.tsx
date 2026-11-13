import React, { useEffect, useMemo, useState } from "react";
import { CloudSun, Droplets, Gauge, Sun, Thermometer, Wind } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import {
  api,
  GrowattIecPr,
  GrowattLive,
  GrowattLiveWeather,
  GrowattWeatherDay,
  GrowattWeatherField,
} from "../api/client";
import { useLivePoll } from "../context/useLivePoll";
import { PanelChart } from "./PanelChart";
import type { ChartSeries, PanelChartSpec } from "./PanelChart";
import { SERIES } from "./chartTheme";
import { EmptyState, LoadingState, Meter, Panel, fmt } from "./ui";
import { Badge } from "@/components/ui/badge";

/** Plant-local (Bangkok) date, YYYY-MM-DD. */
function plantToday(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Bangkok" });
}

const COMPASS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
const compass = (deg: number | null | undefined) => (deg == null ? "" : COMPASS[Math.round(deg / 45) % 8]);

const Card: React.FC<{
  label: string;
  icon: LucideIcon;
  tone: string;
  value: React.ReactNode;
  unit?: string;
  hint?: React.ReactNode;
  meter?: { value: number | null | undefined; max: number; tone: "solar" | "energy" | "warn" | "ok" | "info" };
}> = ({ label, icon: Icon, tone, value, unit, hint, meter }) => (
  <div className="rounded-xl border border-white/[0.06] bg-ink-850/70 p-3.5">
    <div className="flex items-center justify-between">
      <span className="eyebrow">{label}</span>
      <Icon className={`h-3.5 w-3.5 ${tone}`} />
    </div>
    <div className={`num mt-1.5 text-xl font-bold ${tone}`}>
      {value} {unit && <span className="text-xs text-slate-500">{unit}</span>}
    </div>
    {hint && <div className="num mt-1 text-[11px] text-slate-400">{hint}</div>}
    {meter && meter.value != null && <Meter value={meter.value} max={meter.max} tone={meter.tone} className="mt-2" />}
  </div>
);

/**
 * Measured weather-sensor data for the selected Growatt plant: stored 5-minute history (DB) plus
 * the newest reading (live, today only). Fields the sensor does not measure show "—", and the
 * IEC 61724-1 PR is only shown when the sensor covered the plant's producing time.
 */
export const WeatherStationPanel: React.FC<{
  plantId: number;
  /** plant-local day shown by the overview (null = latest) */
  day: string | null;
  /** changes when new history is synced, to re-read the stored day */
  dataUntil?: string | null;
  iecPr?: GrowattIecPr | null;
}> = ({ plantId, day, dataUntil, iecPr }) => {
  const [wx, setWx] = useState<GrowattWeatherDay | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [live, setLive] = useState<GrowattLive<GrowattLiveWeather> | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api
      .getGrowattPlantWeather(plantId, day ?? undefined)
      .then((r) => {
        if (cancelled) return;
        setWx(r);
        setError(null);
      })
      .catch((err) => !cancelled && setError(err instanceof Error ? err.message : String(err)))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [plantId, day, dataUntil]);

  useEffect(() => setLive(null), [plantId]);
  const viewingToday = (day ?? wx?.meta.day) === plantToday();
  useLivePoll(
    Boolean(wx?.has_sensor) && viewingToday,
    plantId,
    () => api.getGrowattLiveWeather(plantId),
    (r) => setLive(r),
    () => undefined // live unavailable: the stored history stays on screen
  );

  const measured = useMemo(() => {
    const set = new Set<GrowattWeatherField>();
    wx?.sensors.forEach((s) => s.measured.forEach((f) => set.add(f)));
    return set;
  }, [wx]);

  const now = live?.data.sensors[0] ?? null;
  const k = wx?.kpis;

  const spec = useMemo<PanelChartSpec | null>(() => {
    const series = wx?.series ?? [];
    if (!series.length) return null;
    const temps: ChartSeries[] = [];
    if (measured.has("module_temp_c"))
      temps.push({ key: "mod", name: "Module temp", type: "line", color: SERIES.temp, y: series.map((p) => p.module_temp_c), unit: "°C" });
    if (measured.has("ambient_temp_c"))
      temps.push({ key: "amb", name: "Ambient temp", type: "line", color: SERIES.ambient, width: 1.5, y: series.map((p) => p.ambient_temp_c), unit: "°C" });
    return {
      xKind: "time",
      x: series.map((p) => p.timestamp),
      panels: [
        {
          key: "g",
          title: "POA irradiance (W/m²)",
          weight: temps.length ? 1.4 : 1,
          series: [
            { key: "g", name: "POA irradiance", type: "line", area: true, color: SERIES.irradiance, y: series.map((p) => p.irradiance_wm2), format: (v) => `${fmt(v, 0)} W/m²` },
          ],
        },
        ...(temps.length ? [{ key: "t", title: "Temperature (°C)", zero: false, series: temps }] : []),
      ],
    };
  }, [wx, measured]);

  const subtitle = wx?.sensors.length
    ? `${wx.sensors.length > 1 ? `${wx.sensors.length} sensors` : "Sensor"} ${wx.sensors
        .map((s) => `${s.datalogger_sn}#${s.address}`)
        .join(", ")} · measured, 5-min · ${wx.meta.day ?? "no data"}`
    : "Plane-of-array irradiance, module & ambient temperature";

  return (
    <Panel
      icon={CloudSun}
      title="Weather Station"
      subtitle={subtitle}
      actions={
        live ? (
          <Badge
            variant={live.stale ? "warn" : "ok"}
            className="px-2 py-0.5 text-[11px] font-semibold"
            title={`Fetched ${new Date(live.fetched_at).toLocaleTimeString()}`}
          >
            {live.stale ? "LIVE (STALE)" : "LIVE"} {now?.timestamp?.slice(11, 16)}
          </Badge>
        ) : null
      }
    >
      {loading && !wx ? (
        <LoadingState label="Loading weather-sensor history…" />
      ) : error ? (
        <EmptyState icon={CloudSun} title="Weather data unavailable" description={error} />
      ) : !wx?.has_sensor ? (
        <EmptyState
          icon={CloudSun}
          title="No weather sensor at this plant"
          description="Growatt lists no environmental sensor on this plant's datalogger, so irradiance and IEC 61724 PR cannot be measured here."
        />
      ) : (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
            <Card
              label={now ? "Irradiance now" : "Peak irradiance"}
              icon={Sun}
              tone="text-solar-400"
              value={fmt(now ? now.irradiance_wm2 : k?.peak_irradiance_wm2, 0)}
              unit="W/m²"
              hint={now ? `Peak today ${fmt(k?.peak_irradiance_wm2, 0)} W/m²` : "Plane of array"}
              meter={{ value: now ? now.irradiance_wm2 : k?.peak_irradiance_wm2, max: 1100, tone: "solar" }}
            />
            <Card
              label="Insolation"
              icon={Gauge}
              tone="text-energy-400"
              value={fmt(k?.insolation_kwh_m2, 2)}
              unit="kWh/m²"
              hint={`= ${fmt(k?.insolation_kwh_m2, 2)} peak-sun hours`}
              meter={{ value: k?.insolation_kwh_m2, max: 7.5, tone: "energy" }}
            />
            <Card
              label="Module vs. ambient"
              icon={Thermometer}
              tone="text-amber-300"
              value={`${fmt(now ? now.module_temp_c : k?.avg_module_temp_daylight_c, 1)}°`}
              unit="C"
              hint={
                now
                  ? `Ambient ${fmt(now.ambient_temp_c, 1)}°C · max module ${fmt(k?.max_module_temp_c, 1)}°C`
                  : `Daylight mean · ambient ${fmt(k?.avg_ambient_temp_c, 1)}°C`
              }
              meter={{ value: now ? now.module_temp_c : k?.avg_module_temp_daylight_c, max: 75, tone: "warn" }}
            />
            <Card
              label="IEC 61724 PR"
              icon={Gauge}
              tone={iecPr?.pr_pct == null ? "text-slate-400" : iecPr.pr_pct >= 80 ? "text-emerald-300" : "text-amber-300"}
              value={fmt(iecPr?.pr_pct, 1)}
              unit={iecPr?.pr_pct == null ? undefined : "%"}
              hint={
                iecPr?.pr_pct == null
                  ? iecPr?.reason ?? "needs the plant overview"
                  : `Yf ${fmt(iecPr.final_yield_h, 2)} h ÷ Yr ${fmt(iecPr.reference_yield_h, 2)} h · ${fmt(iecPr.coverage_pct, 0)}% coverage`
              }
            />
            <Card
              label="Humidity · wind"
              icon={measured.has("wind_speed_ms") ? Wind : Droplets}
              tone="text-sky-300"
              value={measured.has("humidity_pct") ? `${fmt(now ? now.humidity_pct : k?.avg_humidity_pct, 0)}%` : "—"}
              hint={
                measured.has("wind_speed_ms")
                  ? `Wind ${fmt(now ? now.wind_speed_ms : k?.avg_wind_speed_ms, 1)} m/s ${now ? compass(now.wind_dir_deg) : `avg · max ${fmt(k?.max_wind_speed_ms, 1)}`}`
                  : "Wind not measured"
              }
            />
          </div>
          {spec ? (
            <PanelChart spec={spec} height={300} />
          ) : (
            <EmptyState icon={Sun} title="No readings stored for this day" description="The weather sensor uploaded nothing for the selected day." />
          )}
        </div>
      )}
    </Panel>
  );
};

export default WeatherStationPanel;
