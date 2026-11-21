/** Generation page: the plant's PWA meter days (billed, from the monthly daily report) beside
 * Growatt's own day energy (`plant/energy`, finished days): a third check on the meter. Hidden when
 * the plant is not in the report (404). DB only, read once per plant. docs/plans/pwa-meter-daily.md */
import React, { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { ApiError, api } from "../../api/client";
import type { PwaPlantDays } from "../../api/client";
import { PanelChart } from "../../components/PanelChart";
import type { PanelChartSpec } from "../../components/PanelChart";
import { SERIES } from "../../components/chartTheme";
import { SkeletonChart, fmt } from "../../components/ui";
import { Badge } from "@/components/ui/badge";
import { translate, useI18n } from "@/i18n";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { DAY_MS, ratioPanel, statusBands } from "../pwaMeter/chart";
import { DAY_STATUS, WEATHER, dayMs, fmtDay } from "../pwaMeter/format";

const plantSpec = (d: PwaPlantDays): PanelChartSpec | null => {
  if (!d.days.length) return null;
  const x = d.days.map((r) => dayMs(r.day));
  const dayOf = new Map(d.days.map((r, i) => [x[i], r.day]));
  const kwh = (v: number) => `${fmt(v, 0)} kWh`;
  return {
    xKind: "time",
    x,
    xStep: DAY_MS,
    xTipLabel: (v) => fmtDay(dayOf.get(Number(v))),
    bands: statusBands(d.days, x),
    tipExtra: (i) => {
      const r = d.days[i];
      const out = [{ label: translate("Report day"), value: translate(DAY_STATUS[r.status].label) }];
      if (r.growatt_implausible) out.push({ label: "Growatt", value: translate("withheld (impossible figure)") });
      if (r.weather) out.push({ label: translate("Weather"), value: WEATHER[r.weather] ?? r.weather });
      if (r.note) out.push({ label: translate("Note"), value: r.note.length > 80 ? `${r.note.slice(0, 80)}…` : r.note });
      return out;
    },
    panels: [
      {
        key: "energy",
        title: translate("Energy (kWh/day)"),
        weight: 2,
        series: [
          { key: "meter", name: translate("PWA meter (billed)"), color: SERIES.ac, type: "line", area: true, width: 1.5, y: d.days.map((r) => r.meter_kwh), format: kwh },
          { key: "growatt", name: translate("Growatt day energy"), color: SERIES.secondary, type: "line", width: 1.25, y: d.days.map((r) => r.growatt_kwh), format: kwh },
          { key: "inv", name: translate("Inverter (report)"), color: SERIES.dc, type: "line", width: 1, opacity: 0.7, y: d.days.map((r) => r.inverter_kwh), format: kwh },
          { key: "con", name: translate("Contract (modelled)"), color: SERIES.reference, type: "line", dash: "dash", y: d.days.map((r) => r.contract_kwh), format: kwh },
        ],
      },
      ratioPanel(
        translate("Meter ÷ Growatt (%)"),
        translate("Meter ÷ Growatt"),
        d.days.map((r) => r.meter_vs_growatt_pct),
        d.summary.median_meter_vs_growatt_pct != null ? { y: d.summary.median_meter_vs_growatt_pct, label: translate("Median {v} %", { v: fmt(d.summary.median_meter_vs_growatt_pct, 2) }) } : null
      ),
    ],
  };
};

export const PwaMeterCard: React.FC<{ plantId: number }> = ({ plantId }) => {
  const { t } = useI18n();
  const [data, setData] = useState<PwaPlantDays | null>(null);
  const [state, setState] = useState<"loading" | "ok" | "none" | "error">("loading");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setState("loading");
    setData(null);
    api.getPwaMeterPlant(plantId).then(
      (d) => {
        if (!live) return;
        setData(d);
        setState("ok");
      },
      (e) => {
        if (!live) return;
        if (e instanceof ApiError && e.status === 404) setState("none");
        else {
          setError(e instanceof Error ? e.message : String(e));
          setState("error");
        }
      }
    );
    return () => {
      live = false;
    };
  }, [plantId]);

  const spec = useMemo(() => (data ? plantSpec(data) : null), [data]);
  if (state === "none") return null; // not a PWA report site

  const s = data?.summary;
  const lastDay = data?.days.at(-1);
  return (
    <Card className="gap-4">
      <CardHeader className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <CardTitle className="flex flex-wrap items-center gap-2">
            {t("PWA meter")}
            <Badge variant="neutral">{t("daily report")}</Badge>
          </CardTitle>
          <CardDescription>
            {t("Billed meter energy per day from the PWA report (imported monthly), beside Growatt's own day energy")}
            {data ? ` · ${t("report through {day}", { day: fmtDay(data.last_report_day) })}` : ""}
          </CardDescription>
        </div>
        {data && (
          <Link to={`/center?view=sites&site=${encodeURIComponent(data.site.site_id)}`} className="text-xs text-solar-400 hover:underline">
            {t("{site} in Engineering O&M →", { site: data.site.site_id })}
          </Link>
        )}
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {state === "error" && <p className="text-xs text-red-300">{t("Could not load the PWA meter days: {error}", { error })}</p>}
        {data && (
          <div className="flex flex-wrap gap-x-8 gap-y-3">
            <div className="flex flex-col gap-0.5">
              <span className="eyebrow">{t("Last report day")}</span>
              <span className="num text-sm font-semibold">
                {lastDay ? `${fmt(lastDay.meter_kwh, 0)} kWh` : "—"}
                <span className="ml-1.5 text-[11px] font-normal text-muted-foreground">{lastDay ? fmtDay(lastDay.day) : ""}</span>
              </span>
            </div>
            <div className="flex flex-col gap-0.5">
              <span className="eyebrow">{t("Meter, {n} days", { n: s?.report_days ?? 0 })}</span>
              <span className="num text-sm font-semibold">{s?.meter_kwh == null ? "—" : `${fmt(s.meter_kwh / 1000, 2)} MWh`}</span>
            </div>
            <div className="flex flex-col gap-0.5" title={t("Median of meter ÷ Growatt day energy on days both read > 0")}>
              <span className="eyebrow">{t("Meter ÷ Growatt")}</span>
              <span className="num text-sm font-semibold">
                {s?.median_meter_vs_growatt_pct == null ? "—" : `${fmt(s.median_meter_vs_growatt_pct, 2)} %`}
                <span className="ml-1.5 text-[11px] font-normal text-muted-foreground">
                  {s ? (s.compared_days ? t("median of {n} days", { n: s.compared_days }) : t("no Growatt day stored for these days")) : ""}
                </span>
              </span>
            </div>
          </div>
        )}
        {state === "loading" ? <SkeletonChart /> : data && <PanelChart spec={spec} height={300} legendToggle legendPosition="bottom" emptyLabel={t("No report days for this plant.")} />}
      </CardContent>
    </Card>
  );
};
