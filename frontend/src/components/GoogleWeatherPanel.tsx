import React, { useEffect, useMemo, useState } from "react";
import { CloudRain, CloudSun, Droplets, Sun, Thermometer, Umbrella, Wind } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { api, GoogleWeatherDay, GoogleWeatherNow, GoogleWeatherSlot, GrowattLive } from "../api/client";
import { useLivePoll } from "../context/useLivePoll";
import { PanelChart } from "./PanelChart";
import type { PanelChartSpec } from "./PanelChart";
import { SERIES } from "./chartTheme";
import { EmptyState, LoadingState, Meter, Panel, fmt } from "./ui";
import { Badge } from "@/components/ui/badge";
import { useI18n } from "../i18n";

function plantToday(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Bangkok" });
}

const label = (c: string | null | undefined) =>
  c ? c.toLowerCase().replace(/_/g, " ").replace(/^\w/, (m) => m.toUpperCase()) : "—";

const Card: React.FC<{
  label: string;
  icon: LucideIcon;
  tone: string;
  value: React.ReactNode;
  unit?: string;
  hint?: React.ReactNode;
  meter?: { value: number | null | undefined; max: number; tone: "solar" | "energy" | "warn" | "ok" | "info" };
}> = ({ label: title, icon: Icon, tone, value, unit, hint, meter }) => (
  <div className="rounded-xl border border-white/[0.06] bg-ink-850/70 p-3.5">
    <div className="flex items-center justify-between">
      <span className="eyebrow">{title}</span>
      <Icon className={`h-3.5 w-3.5 ${tone}`} />
    </div>
    <div className={`num mt-1.5 text-xl font-bold ${tone}`}>
      {value} {unit && <span className="text-xs text-slate-500">{unit}</span>}
    </div>
    {hint && <div className="num mt-1 text-[10px] text-slate-400">{hint}</div>}
    {meter && meter.value != null && <Meter value={meter.value} max={meter.max} tone={meter.tone} className="mt-2" />}
  </div>
);

const Slot: React.FC<{ hour: string; slot: GoogleWeatherSlot | null }> = ({ hour, slot }) => {
  const { t } = useI18n();
  const tone =
    slot?.raining == null ? "border-white/[0.06] text-slate-400" : slot.raining ? "border-sky-400/40 text-sky-300" : "border-emerald-400/30 text-emerald-300";
  return (
    <div className={`flex items-center justify-between rounded-lg border bg-ink-850/70 px-3 py-2 ${tone}`}>
      <span className="num text-xs text-slate-400">{hour}:00</span>
      <span className="text-sm font-semibold">{slot?.status_th ?? "—"}</span>
      <span className="num text-[10px] text-slate-400">
        {slot ? `${fmt(slot.precip_mm, 1)} mm · ☁ ${fmt(slot.cloud_cover_pct, 0)}%` : t("not stored yet")}
      </span>
    </div>
  );
};

/**
 * Google Maps Weather for the selected plant: modelled for the plant's ~1 km grid cell, not
 * measured. Daytime only (06:00–18:00). Stored hourly history (DB, written daily at 18:15) plus current conditions (live,
 * cached 30 min on the backend, today only). Rain status at 09:00 / 12:00 / 17:00 is what the
 * Firestore daily summary carries.
 */
export const GoogleWeatherPanel: React.FC<{ plantId: number; day: string | null }> = ({ plantId, day }) => {
  const [wx, setWx] = useState<GoogleWeatherDay | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [live, setLive] = useState<GrowattLive<GoogleWeatherNow> | null>(null);
  const { t, locale } = useI18n();

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api
      .getGoogleWeatherDay(plantId, day ?? undefined)
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
  }, [plantId, day]);

  useEffect(() => setLive(null), [plantId]);
  const viewingToday = (day ?? plantToday()) === plantToday();
  useLivePoll(
    Boolean(wx?.configured && wx.has_location) && viewingToday,
    plantId,
    () => api.getGoogleWeatherLive(plantId),
    (r) => setLive(r),
    () => undefined
  );

  const now = live?.data ?? null;
  const k = wx?.kpis;

  // rain, cloud cover and air temperature: three measures, three panels on one hour axis (all modelled)
  const spec = useMemo<PanelChartSpec | null>(() => {
    const hours = wx?.hours ?? [];
    if (!hours.length) return null;
    const hh = (v: string | number) => {
      const s = String(v);
      return s.length > 5 ? s.slice(11, 16) : s;
    };
    return {
      xKind: "band",
      x: hours.map((h) => h.hour),
      xTickLabel: hh,
      xTipLabel: (v) => `${hh(v)} · ${t("modelled")}`,
      panels: [
        {
          key: "rain",
          title: t("Rain (mm/h)"),
          series: [{ key: "rain", name: t("Rain"), type: "bar", color: SERIES.ambient, y: hours.map((h) => h.precip_mm), unit: "mm/h" }],
        },
        {
          key: "cloud",
          title: t("Cloud cover (%)"),
          yMin: 0,
          yMax: 100,
          tickSuffix: "%",
          series: [{ key: "cloud", name: t("Cloud cover"), type: "line", color: SERIES.reference, y: hours.map((h) => h.cloud_cover_pct), format: (v) => `${fmt(v, 0)}%` }],
        },
        {
          key: "temp",
          title: t("Air temp (°C)"),
          zero: false,
          series: [{ key: "temp", name: t("Air temp"), type: "line", color: SERIES.temp, y: hours.map((h) => h.temp_c), unit: "°C" }],
        },
      ],
    };
  }, [wx, t]);

  const cell = wx?.meta.cell;
  const subtitle = `${t("Modelled by Google Maps Platform")}${cell ? ` · ${t("cell {key}", { key: cell.key })}` : ""} · ${t("hourly")} · ${wx?.meta.day ?? t("no data")}`;

  return (
    <Panel
      icon={CloudRain}
      title={t("Google Weather (modelled)")}
      subtitle={subtitle}
      actions={
        live ? (
          <Badge
            variant={live.stale ? "warn" : "ok"}
            className="px-2 py-0.5 text-[10px] font-semibold"
            title={`${t("Fetched {time}", { time: new Date(live.fetched_at).toLocaleTimeString(locale) })}${live.error ? ` · ${live.error}` : ""}`}
          >
            {live.stale ? t("LIVE (STALE)") : t("LIVE")} {new Date(live.fetched_at).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Bangkok" })}
          </Badge>
        ) : null
      }
    >
      {loading && !wx ? (
        <LoadingState label={t("Loading Google weather…")} shape="lines" />
      ) : error ? (
        <EmptyState icon={CloudSun} title={t("Google weather unavailable")} description={error} />
      ) : !wx?.has_location ? (
        <EmptyState icon={CloudSun} title={t("Plant has no coordinates")} description={t("Google weather is looked up by the plant's latitude/longitude from Growatt.")} />
      ) : !wx.configured && !wx.hours.length ? (
        <EmptyState icon={CloudSun} title={t("Google Weather not configured")} description={t("Set GOOGLE_WEATHER_API_KEY on the backend and worker.")} />
      ) : (
        <div className="space-y-4">
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
            {(["09", "12", "17"] as const).map((h) => (
              <Slot key={h} hour={h} slot={wx.slots[h]} />
            ))}
          </div>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
            <Card
              label={now ? t("Now") : t("Condition")}
              icon={Thermometer}
              tone="text-amber-300"
              value={`${fmt(now ? now.temp_c : k?.temp_max_c, 1)}°`}
              unit="C"
              hint={
                now
                  ? `${now.condition_text ?? label(now.condition)} · ${t("feels {t}°C", { t: fmt(now.feels_like_c, 1) })}`
                  : `${label(k?.condition)} · ${t("min {t}°C", { t: fmt(k?.temp_min_c, 1) })}`
              }
            />
            <Card
              label={t("Cloud cover")}
              icon={CloudSun}
              tone="text-slate-300"
              value={fmt(now ? now.cloud_cover_pct : k?.cloud_cover_daytime_pct, 0)}
              unit="%"
              hint={now ? t("Daytime mean {pct}% (stored day)", { pct: fmt(k?.cloud_cover_daytime_pct, 0) }) : t("Daytime mean")}
              meter={{ value: now ? now.cloud_cover_pct : k?.cloud_cover_daytime_pct, max: 100, tone: "info" }}
            />
            <Card
              label={t("Rain")}
              icon={Droplets}
              tone="text-sky-300"
              value={fmt(now ? now.past24h_precip_mm : k?.rain_mm, 1)}
              unit="mm"
              hint={
                now
                  ? t("Past 24 h · chance now {pct}%", { pct: fmt(now.precip_prob_pct, 0) })
                  : t("{n} rain hours · {h}/12 h stored (06–18)", { n: fmt(k?.rain_hours, 0), h: k?.hours ?? 0 })
              }
            />
            <Card
              label={t("Days since rain")}
              icon={Umbrella}
              tone={wx.rain.days_since_rain != null && wx.rain.days_since_rain >= 14 ? "text-amber-300" : "text-emerald-300"}
              value={fmt(wx.rain.days_since_rain, 0)}
              hint={wx.rain.last_rain_day ? t("Last ≥ 1 mm: {day} ({mm} mm)", { day: wx.rain.last_rain_day, mm: fmt(wx.rain.last_rain_mm, 1) }) : t("No rain day in stored history")}
            />
            <Card
              label={t("UV · wind")}
              icon={now?.uv_index || k?.uv_max ? Sun : Wind}
              tone="text-solar-400"
              value={fmt(now ? now.uv_index : k?.uv_max, 0)}
              unit="UV"
              hint={t("Gust {v} m/s", { v: fmt(now ? now.wind_gust_ms : k?.wind_gust_max_ms, 1) })}
            />
          </div>
          {spec ? (
            <PanelChart spec={spec} height={320} />
          ) : (
            <EmptyState
              icon={CloudRain}
              title={t("No hourly weather stored for this day")}
              description={t("The worker stores Google's daytime hours (06:00–18:00) every day at 18:15 (Bangkok), so today's hours appear this evening.")}
            />
          )}
        </div>
      )}
    </Panel>
  );
};

export default GoogleWeatherPanel;
