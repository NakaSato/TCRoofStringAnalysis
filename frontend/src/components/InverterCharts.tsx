/**
 * Extra charts for the Inverters page (all from stored history, DB only):
 * - StringHeatmapPanel: string current × 5-minute slot for one inverter
 * - InverterTrendPanel: daily yield of one inverter vs the plant's average inverter, 7–90 days
 */
import { useUrlState } from "@/lib/useUrlState";
import React, { useEffect, useMemo, useState } from "react";
import { Grid3x3, TrendingUp } from "lucide-react";
import { api } from "../api/client";
import type { GrowattInverterDaily, GrowattInverterTimeseries } from "../api/client";
import { DailyTrendChart, StringHeatmap } from "./D3Charts";
import { EmptyState, LoadingState, Panel } from "./ui";
import { Button } from "@/components/ui/button";

/* -------------------------------------------------------------------------- */
/* 1. String current heatmap                                                  */
/* -------------------------------------------------------------------------- */
export const StringHeatmapPanel: React.FC<{
  label: string;
  series: GrowattInverterTimeseries | null;
  loading: boolean;
  className?: string;
}> = ({ label, series, loading, className = "" }) => {
  const h = series?.strings;
  return (
    <Panel
      className={className}
      icon={Grid3x3}
      title={`String Current Heatmap — ${label}`}
      subtitle={`Current of each string per 5-minute slot while producing; a dark row or band = open string, shading or a trip${
        series?.meta.day ? ` · ${series.meta.day}` : ""
      }`}
    >
      {loading ? (
        <LoadingState label="Loading string currents…" shape="chart" />
      ) : h && h.string_nos.length ? (
        <StringHeatmap stringNos={h.string_nos} timestamps={h.timestamps} currentA={h.current_a} />
      ) : (
        <EmptyState icon={Grid3x3} title="No string records" description="No string carried current on this day." />
      )}
    </Panel>
  );
};

/* -------------------------------------------------------------------------- */
/* 2. Multi-day trend                                                         */
/* -------------------------------------------------------------------------- */
const RANGES = [7, 30, 90] as const;

export const InverterTrendPanel: React.FC<{
  plantId: number;
  deviceSn: string;
  label: string;
  day: string | null;
  className?: string;
}> = ({ plantId, deviceSn, label, day, className = "" }) => {
  // history range in the URL (?days=), default 30
  const [query, setQuery] = useUrlState();
  const days = (RANGES.find((r) => String(r) === query.get("days")) ?? 30) as (typeof RANGES)[number];
  const setDays = (d: (typeof RANGES)[number]) => setQuery({ days: d === 30 ? null : d });
  const [data, setData] = useState<GrowattInverterDaily | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api
      .getGrowattInverterDaily(plantId, deviceSn, days, day ?? undefined)
      .then((r) => !cancelled && setData(r))
      .catch(() => !cancelled && setData(null))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [plantId, deviceSn, days, day]);

  const rows = data?.daily ?? [];
  const hasAny = rows.some((r) => r.yield_kwh != null);

  const trend = useMemo(
    () =>
      rows.map((r) => ({
        day: r.day,
        value: r.yield_kwh,
        average: r.plant_avg_yield_kwh,
        pct: r.vs_plant_pct,
        peakKw: r.peak_ac_kw,
        maxTempC: r.max_temp_c,
      })),
    [rows],
  );

  return (
    <Panel
      className={className}
      icon={TrendingUp}
      title={`Daily Yield Trend — ${label}`}
      subtitle={`Day yield vs the plant's average inverter; a falling blue line = this inverter is losing ground${
        data ? ` · ${data.meta.from} → ${data.meta.to}` : ""
      }`}
      actions={
        <div className="flex gap-1">
          {RANGES.map((n) => (
            <Button
              key={n}
              type="button"
              onClick={() => setDays(n)}
              variant={n === days ? "default" : "ghost"}
              size="sm"
            >
              {n}d
            </Button>
          ))}
        </div>
      }
    >
      {loading ? (
        <LoadingState label="Loading daily history…" shape="chart" />
      ) : hasAny ? (
        <DailyTrendChart rows={trend} height={300} />
      ) : (
        <EmptyState icon={TrendingUp} title="No daily history" description={`No stored yield for ${label} in the last ${days} days.`} />
      )}
    </Panel>
  );
};
