/** Generation page: daily PR history of the plant (`api.getPlantKpiDaily`, stored plant-days, DB only).
 * IEC 61724 PR and PR' from the plant's weather sensor (null without one) over specific yield Yf;
 * the period PR is energy-weighted (Σ Yf ÷ Σ Yr). Read on mount and when the plant or period changes,
 * never polled; a stale answer (an older plant / period) is dropped. */
import React, { useEffect, useMemo, useState } from "react";
import { api } from "../../api/client";
import type { PlantKpiDaily } from "../../api/client";
import { PanelChart } from "../../components/PanelChart";
import { EmptyState, SkeletonChart, Suspended, fmt } from "../../components/ui";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useI18n } from "@/i18n";
import { prTone } from "./charts";
import { prHistorySpec, prHistorySummary } from "./prHistory";
import { daysBetween, fmtDay } from "../pwaMeter/format";

/** day counts the toggle offers (the endpoint takes 1–365) */
export const PR_HISTORY_DAYS = [7, 30, 90, 365] as const;
/** a history length: a day count, or "year" = 1 Jan of `endDay`'s year to `endDay` */
export type PrHistoryLength = number | "year";
const MAX_DAYS = 365;

export interface PrHistoryCardProps {
  plantId: number;
  /** last day shown (YYYY-MM-DD) */
  endDay: string;
  /** days up to `endDay` (ignored when `startDay` is given) */
  days: PrHistoryLength;
  onDaysChange: (n: PrHistoryLength) => void;
  /** the plant's target PR % (dashed line; colours the period PR); null = none */
  target: number | null;
  /** day marked on the chart (e.g. the day shown above) */
  selectedDay?: string | null;
  /** a click on a day of the chart */
  onPickDay?: (day: string) => void;
  /** when given, exactly `startDay`..`endDay` (at most 365 days, counted back from `endDay`) */
  startDay?: string | null;
}

const Figure: React.FC<{ label: string; value: React.ReactNode; sub?: React.ReactNode; title?: string; className?: string }> = ({
  label,
  value,
  sub,
  title,
  className,
}) => (
  <div className="flex flex-col gap-0.5" title={title}>
    <span className="eyebrow">{label}</span>
    <span className={`num text-sm font-semibold ${className ?? ""}`}>
      {value}
      {sub ? <span className="ml-1.5 text-[11px] font-normal text-muted-foreground">{sub}</span> : null}
    </span>
  </div>
);

export const PrHistoryCard: React.FC<PrHistoryCardProps> = ({ plantId, endDay, days, onDaysChange, target, selectedDay, onPickDay, startDay }) => {
  const { t } = useI18n();
  const ranged = Boolean(startDay && startDay <= endDay);
  const first = ranged ? startDay! : days === "year" ? `${endDay.slice(0, 4)}-01-01` : null;
  const n = first ? Math.min(MAX_DAYS, Math.max(1, daysBetween(first, endDay).length)) : Math.min(MAX_DAYS, Math.max(1, Math.round(days as number) || 30));
  const key = `${plantId}|${n}|${endDay}`;

  const [res, setRes] = useState<{ key: string; plantId: number; data: PlantKpiDaily | null; error: string | null } | null>(null);
  useEffect(() => {
    let cancelled = false;
    api.getPlantKpiDaily(plantId, n, endDay).then(
      (d) => !cancelled && setRes({ key, plantId, data: d, error: null }),
      (e) => !cancelled && setRes({ key, plantId, data: null, error: e instanceof Error ? e.message : String(e) })
    );
    return () => {
      cancelled = true;
    };
  }, [key, plantId, n, endDay]);

  const loading = res?.key !== key;
  // another plant's answer is never shown under this one; a new period of the same plant stays, dimmed
  const shown = res && res.plantId === plantId ? res : null;
  const data = shown?.data ?? null;

  const spec = useMemo(
    () => (data && data.days.length ? prHistorySpec(data.days, data.start, data.end, { target, selectedDay }) : null),
    [data, target, selectedDay]
  );
  const sum = useMemo(() => (data ? prHistorySummary(data.days, daysBetween(data.start, data.end).length) : null), [data]);

  const energy =
    sum?.energyKwh == null ? "—" : sum.energyKwh >= 10000 ? `${fmt(sum.energyKwh / 1000, 2)} MWh` : `${fmt(sum.energyKwh, 0)} kWh`;

  return (
    <Card className="gap-4">
      <CardHeader className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <CardTitle>{t("PR history")}</CardTitle>
          <CardDescription>
            {t("Daily IEC 61724 PR and specific yield of the stored plant-days")}
            {data ? ` · ${fmtDay(data.start)} – ${fmtDay(data.end)}` : ""}
            {onPickDay ? ` · ${t("click a day to show it")}` : ""}
          </CardDescription>
        </div>
        {!ranged && (
          <Tabs value={days === "year" ? "year" : String(n)} onValueChange={(v) => onDaysChange(v === "year" ? "year" : Number(v))}>
            <TabsList variant="line" aria-label={t("PR history length")}>
              {PR_HISTORY_DAYS.map((d) => (
                <TabsTrigger key={d} value={String(d)}>
                  {t("{n} days", { n: d })}
                </TabsTrigger>
              ))}
              <TabsTrigger value="year">{t("This year")}</TabsTrigger>
            </TabsList>
          </Tabs>
        )}
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {shown?.error && !loading && <p className="text-xs text-red-300">{t("Could not load the PR history: {error}", { error: shown.error })}</p>}
        {!data && loading ? (
          <SkeletonChart height={320} />
        ) : data && !data.days.length ? (
          <Suspended busy={loading} pill={false}>
            <EmptyState title={t("No stored daily KPIs for this period")} />
          </Suspended>
        ) : data && sum ? (
          <Suspended busy={loading} pill="center" contentClassName="flex flex-col gap-4">
            <div className="flex flex-wrap gap-x-8 gap-y-3">
              <Figure
                label={t("Period PR")}
                value={sum.periodPr == null ? "—" : `${fmt(sum.periodPr, 1)} %`}
                sub={t("IEC 61724 · energy-weighted")}
                title={t("Σ Yf / Σ Yr over the days with an IEC PR; days with a suspect sensor are left out")}
                className={target != null ? prTone(sum.periodPr, target) : undefined}
              />
              <Figure
                label={t("Days with PR")}
                value={`${sum.prDays} / ${sum.totalDays}`}
                sub={sum.suspectDays ? t("{n} with a suspect sensor", { n: sum.suspectDays }) : undefined}
              />
              <Figure label={t("Mean Yf")} value={sum.meanYf == null ? "—" : `${fmt(sum.meanYf, 2)} kWh/kWp`} />
              <Figure
                label={t("Total energy")}
                value={energy}
                sub={sum.storedDays < sum.totalDays ? t("{n} of {total} days stored", { n: sum.storedDays, total: sum.totalDays }) : undefined}
              />
            </div>
            {sum.noPr && (
              <p className="text-xs text-muted-foreground">{t("No IEC PR for these days: no weather sensor reading (IEC PR needs plane-of-array irradiance).")}</p>
            )}
            <PanelChart
              spec={spec}
              height={320}
              legendToggle
              legendPosition="bottom"
              emptyLabel={t("No stored daily KPIs for this period")}
              onPick={onPickDay && spec ? (i) => onPickDay(String(spec.x[i])) : undefined}
            />
          </Suspended>
        ) : null}
      </CardContent>
    </Card>
  );
};
