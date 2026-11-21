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
      const out = [{ label: "Report day", value: DAY_STATUS[r.status].label }];
      if (r.growatt_implausible) out.push({ label: "Growatt", value: "withheld (impossible figure)" });
      if (r.weather) out.push({ label: "Weather", value: WEATHER[r.weather] ?? r.weather });
      if (r.note) out.push({ label: "Note", value: r.note.length > 80 ? `${r.note.slice(0, 80)}…` : r.note });
      return out;
    },
    panels: [
      {
        key: "energy",
        title: "Energy (kWh/day)",
        weight: 2,
        series: [
          { key: "meter", name: "PWA meter (billed)", color: SERIES.ac, type: "line", area: true, width: 1.5, y: d.days.map((r) => r.meter_kwh), format: kwh },
          { key: "growatt", name: "Growatt day energy", color: SERIES.secondary, type: "line", width: 1.25, y: d.days.map((r) => r.growatt_kwh), format: kwh },
          { key: "inv", name: "Inverter (report)", color: SERIES.dc, type: "line", width: 1, opacity: 0.7, y: d.days.map((r) => r.inverter_kwh), format: kwh },
          { key: "con", name: "Contract (modelled)", color: SERIES.reference, type: "line", dash: "dash", y: d.days.map((r) => r.contract_kwh), format: kwh },
        ],
      },
      ratioPanel(
        "Meter ÷ Growatt (%)",
        "Meter ÷ Growatt",
        d.days.map((r) => r.meter_vs_growatt_pct),
        d.summary.median_meter_vs_growatt_pct != null ? { y: d.summary.median_meter_vs_growatt_pct, label: `Median ${fmt(d.summary.median_meter_vs_growatt_pct, 2)} %` } : null
      ),
    ],
  };
};

export const PwaMeterCard: React.FC<{ plantId: number }> = ({ plantId }) => {
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
            PWA meter
            <Badge variant="neutral">daily report</Badge>
          </CardTitle>
          <CardDescription>
            Billed meter energy per day from the PWA report (imported monthly), beside Growatt's own day energy
            {data ? ` · report through ${fmtDay(data.last_report_day)}` : ""}
          </CardDescription>
        </div>
        {data && (
          <Link to={`/center?view=sites&site=${encodeURIComponent(data.site.site_id)}`} className="text-xs text-solar-400 hover:underline">
            {data.site.site_id} in O&M Dashboard →
          </Link>
        )}
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {state === "error" && <p className="text-xs text-red-300">Could not load the PWA meter days: {error}</p>}
        {data && (
          <div className="flex flex-wrap gap-x-8 gap-y-3">
            <div className="flex flex-col gap-0.5">
              <span className="eyebrow">Last report day</span>
              <span className="num text-sm font-semibold">
                {lastDay ? `${fmt(lastDay.meter_kwh, 0)} kWh` : "—"}
                <span className="ml-1.5 text-[11px] font-normal text-muted-foreground">{lastDay ? fmtDay(lastDay.day) : ""}</span>
              </span>
            </div>
            <div className="flex flex-col gap-0.5">
              <span className="eyebrow">Meter, {s?.report_days ?? 0} days</span>
              <span className="num text-sm font-semibold">{s?.meter_kwh == null ? "—" : `${fmt(s.meter_kwh / 1000, 2)} MWh`}</span>
            </div>
            <div className="flex flex-col gap-0.5" title="Median of meter ÷ Growatt day energy on days both read > 0">
              <span className="eyebrow">Meter ÷ Growatt</span>
              <span className="num text-sm font-semibold">
                {s?.median_meter_vs_growatt_pct == null ? "—" : `${fmt(s.median_meter_vs_growatt_pct, 2)} %`}
                <span className="ml-1.5 text-[11px] font-normal text-muted-foreground">
                  {s ? (s.compared_days ? `median of ${s.compared_days} days` : "no Growatt day stored for these days") : ""}
                </span>
              </span>
            </div>
          </div>
        )}
        {state === "loading" ? <SkeletonChart /> : data && <PanelChart spec={spec} height={300} legendToggle legendPosition="bottom" emptyLabel="No report days for this plant." />}
      </CardContent>
    </Card>
  );
};
