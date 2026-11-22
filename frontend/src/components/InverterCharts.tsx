/**
 * Extra charts for the Inverters page (all from stored history, DB only):
 * - StringHeatmapPanel: string current × 5-minute slot for one inverter
 * - InverterTrendPanel: daily yield of one inverter vs the plant's average inverter, 7–90 days
 */
import { useUrlState } from "@/lib/useUrlState";
import React, { useEffect, useMemo, useRef, useState } from "react";
import { Grid3x3, TrendingUp } from "lucide-react";
import { api } from "../api/client";
import type { GrowattInverterDaily, GrowattInverterTimeseries } from "../api/client";
import { DailyTrendChart, StringHeatmap } from "./D3Charts";
import { EmptyState, LoadingState, Panel, Suspended } from "./ui";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/i18n";

/* -------------------------------------------------------------------------- */
/* 1. String current heatmap                                                  */
/* -------------------------------------------------------------------------- */
export const StringHeatmapPanel: React.FC<{
  label: string;
  series: GrowattInverterTimeseries | null;
  loading: boolean;
  className?: string;
}> = ({ label, series, loading, className = "" }) => {
  const { t } = useI18n();
  const h = series?.strings;
  return (
    <Panel
      className={className}
      icon={Grid3x3}
      title={t("String Current Heatmap — {name}", { name: label })}
      subtitle={`${t("Current of each string per 5-minute slot while producing; a dark row or band = open string, shading or a trip")}${
        series?.meta.day ? ` · ${series.meta.day}` : ""
      }`}
    >
      {loading && !series ? (
        <LoadingState label={t("Loading string currents…")} shape="chart" />
      ) : h && h.string_nos.length ? (
        <Suspended busy={loading} pill="center">
          <StringHeatmap stringNos={h.string_nos} timestamps={h.timestamps} currentA={h.current_a} />
        </Suspended>
      ) : (
        <EmptyState icon={Grid3x3} title={t("No string records")} description={t("No string carried current on this day.")} />
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
  const { t } = useI18n();
  // history range in the URL (?days=), default 30
  const [query, setQuery] = useUrlState();
  const days = (RANGES.find((r) => String(r) === query.get("days")) ?? 30) as (typeof RANGES)[number];
  const setDays = (d: (typeof RANGES)[number]) => setQuery({ days: d === 30 ? null : d });
  const [data, setData] = useState<GrowattInverterDaily | null>(null);
  const [loading, setLoading] = useState(false);
  // another inverter: drop the old one's history; a new range of the same one stays on screen, suspended
  const shownSn = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (shownSn.current !== `${plantId}/${deviceSn}`) {
      shownSn.current = `${plantId}/${deviceSn}`;
      setData(null);
    }
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
      title={t("Daily Yield Trend — {name}", { name: label })}
      subtitle={`${t("Day yield vs the plant's average inverter; a falling blue line = this inverter is losing ground")}${
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
              {t("{n}d", { n })}
            </Button>
          ))}
        </div>
      }
    >
      {loading && !data ? (
        <LoadingState label={t("Loading daily history…")} shape="chart" />
      ) : hasAny ? (
        <Suspended busy={loading} label={t("Loading daily history…")} pill="center">
          <DailyTrendChart rows={trend} height={300} />
        </Suspended>
      ) : (
        <EmptyState icon={TrendingUp} title={t("No daily history")} description={t("No stored yield for {name} in the last {n} days.", { name: label, n: days })} />
      )}
    </Panel>
  );
};
