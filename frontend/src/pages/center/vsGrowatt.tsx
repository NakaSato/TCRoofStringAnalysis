/** Engineering O&M, Meter vs Growatt: each report site's Cewe meter days against Growatt's own day
 * energy (`plant/energy`) of its Growatt plant, both measured (`/pwa/meter/vs-growatt`). The table
 * per site and the chart of the pooled days; nothing estimated. The ratio carries the AC losses
 * between the inverters and the grid-point meter, so about 98.5–99 % is normal. */
import React from "react";
import type { PwaVsGrowattDay, PwaVsGrowattSite } from "../../api/client";
import type { PanelChartSpec } from "../../components/PanelChart";
import { SERIES } from "../../components/chartTheme";
import { fmt } from "../../components/ui";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { DAY_MS, ratioPanel } from "../pwaMeter/chart";
import { dayMs, fmtDay } from "../pwaMeter/format";
import { SiteCell, SortHead } from "../pwaMeter/tables";
import { translate, useI18n } from "../../i18n";

export const GROWATT_HINT = "Both measured: the Cewe meter kWh of the report against Growatt's own day energy of the site's Growatt plant, on days both read > 0";

export const VsGrowattSortKeys = ["median", "name", "ratio", "meter", "low", "missing"] as const;
export type VsGrowattSort = (typeof VsGrowattSortKeys)[number];

export const vsGrowattSortValue = (r: PwaVsGrowattSite, k: VsGrowattSort): number | string | null => {
  switch (k) {
    case "name":
      return r.name;
    case "median":
      return r.median_ratio_pct;
    case "ratio":
      return r.ratio_pct;
    case "meter":
      return r.meter_kwh;
    case "low":
      return r.low_days + r.meter_missing_days;
    case "missing":
      return r.growatt_missing_days;
  }
};

/** amber under 97 %, red under 90 % or above 100.5 % (the meter cannot read more than the inverters made) */
const ratioTone = (v: number | null) => (v == null ? "" : v < 90 || v > 100.5 ? "text-red-300" : v < 97 ? "text-amber-300" : "");

export const VsGrowattTable: React.FC<{
  rows: PwaVsGrowattSite[];
  sort: VsGrowattSort;
  desc: boolean;
  onSort: (k: VsGrowattSort) => void;
  onOpen: (siteId: string) => void;
}> = ({ rows, sort, desc, onSort, onOpen }) => {
  const { t } = useI18n();
  return (
    <Table>
      <TableHeader className="sticky top-0 z-10 bg-card">
        <TableRow>
          <SortHead k="name" label={t("Site")} sort={sort} desc={desc} onSort={onSort} />
          <TableHead className="text-right" title={t("Days both read > 0 / report days")}>
            {t("Compared d")}
          </TableHead>
          <SortHead k="meter" label={t("Meter MWh")} sort={sort} desc={desc} onSort={onSort} className="text-right" title={t("Summed over the compared days")} />
          <TableHead className="text-right" title={t("Growatt's own day energy, summed over the compared days")}>
            {t("Growatt MWh")}
          </TableHead>
          <SortHead k="ratio" label={t("Meter ÷ Growatt")} sort={sort} desc={desc} onSort={onSort} className="text-right" title={t("Pooled over the compared days")} />
          <SortHead k="median" label={t("Median")} sort={sort} desc={desc} onSort={onSort} className="text-right" title={t("Median of the daily ratio")} />
          <TableHead className="text-right" title={t("5th percentile of the daily ratio")}>
            P05
          </TableHead>
          <SortHead k="low" label={t("Low / meter missing d")} sort={sort} desc={desc} onSort={onSort} className="text-right" title={t("Days the ratio fell > 3 points under the site's median, and days the meter read nothing while Growatt produced")} />
          <TableHead className="text-right" title={t("Days the meter read above Growatt (ratio > 1.005)")}>
            {t("High d")}
          </TableHead>
          <SortHead k="missing" label={t("Growatt missing d")} sort={sort} desc={desc} onSort={onSort} className="text-right" title={t("Days the meter read but no Growatt day is stored (only days Growatt is stored for some plant); withheld glitch days in brackets")} />
          <TableHead>{t("Flags")}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((r) => (
          <TableRow key={r.site_id} className="cursor-pointer" onClick={() => onOpen(r.site_id)}>
            <TableCell>
              <SiteCell name={r.name} siteId={r.site_id} region={r.region} />
            </TableCell>
            <TableCell className="num text-right text-muted-foreground">
              {r.compared_days} / {r.report_days}
            </TableCell>
            <TableCell className="num text-right">{r.meter_kwh == null ? "—" : fmt(r.meter_kwh / 1000, 1)}</TableCell>
            <TableCell className="num text-right">{r.growatt_kwh == null ? "—" : fmt(r.growatt_kwh / 1000, 1)}</TableCell>
            <TableCell className={cn("num whitespace-nowrap text-right", ratioTone(r.ratio_pct))}>{r.ratio_pct == null ? "—" : `${fmt(r.ratio_pct, 2)} %`}</TableCell>
            <TableCell className={cn("num whitespace-nowrap text-right", ratioTone(r.median_ratio_pct))}>{r.median_ratio_pct == null ? "—" : `${fmt(r.median_ratio_pct, 2)} %`}</TableCell>
            <TableCell className="num whitespace-nowrap text-right text-muted-foreground">{r.p05_ratio_pct == null ? "—" : `${fmt(r.p05_ratio_pct, 1)} %`}</TableCell>
            <TableCell className="num text-right">
              {r.low_days} / {r.meter_missing_days}
            </TableCell>
            <TableCell className="num text-right">{r.high_days}</TableCell>
            <TableCell className="num text-right">
              {r.growatt_missing_days}
              {r.implausible_days > 0 && (
                <span className="text-muted-foreground" title={t("Growatt days withheld as impossible figures")}>
                  {" "}
                  ({r.implausible_days})
                </span>
              )}
            </TableCell>
            <TableCell className="max-w-[260px]">
              <span className="flex flex-wrap gap-1">
                {r.growatt_plant_id == null && <Badge variant="neutral">{t("No Growatt plant")}</Badge>}
                {r.flags.map((f) => (
                  <Badge key={f} variant="warn">
                    {f}
                  </Badge>
                ))}
              </span>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
};

export interface VsGrowattDayTotal {
  day: string;
  sites: number;
  meter_kwh: number;
  growatt_kwh: number;
}

/** the days of one phase (or all), summed over the phases */
export const vsGrowattDays = (days: PwaVsGrowattDay[], phase: number | null): VsGrowattDayTotal[] => {
  const map = new Map<string, VsGrowattDayTotal>();
  for (const d of days) {
    if (phase != null && d.phase !== phase) continue;
    const t = map.get(d.day) ?? { day: d.day, sites: 0, meter_kwh: 0, growatt_kwh: 0 };
    t.sites += d.sites;
    t.meter_kwh += d.meter_kwh ?? 0;
    t.growatt_kwh += d.growatt_kwh ?? 0;
    map.set(d.day, t);
  }
  return [...map.values()].sort((a, b) => a.day.localeCompare(b.day));
};

/** Pooled per day over the sites compared: meter and Growatt energy, then meter ÷ Growatt. */
export const vsGrowattDaySpec = (days: VsGrowattDayTotal[]): PanelChartSpec | null => {
  if (!days.length) return null;
  const x = days.map((d) => dayMs(d.day));
  const dayOf = new Map(days.map((d, i) => [x[i], d.day]));
  const mwh = (v: number) => `${fmt(v, 2)} MWh`;
  const ratio = days.map((d) => (d.growatt_kwh > 0 ? (100 * d.meter_kwh) / d.growatt_kwh : null));
  return {
    xKind: "time",
    x,
    xStep: DAY_MS,
    xTipLabel: (v) => fmtDay(dayOf.get(Number(v))),
    tipExtra: (i) => [{ label: translate("Sites compared"), value: String(days[i].sites) }],
    panels: [
      {
        key: "energy",
        title: translate("Energy of the sites compared (MWh/day)"),
        weight: 2,
        yMin: 0,
        series: [
          { key: "meter", name: translate("PWA meter (billed)"), color: SERIES.ac, type: "line", area: true, width: 1.5, y: days.map((d) => d.meter_kwh / 1000), format: mwh },
          { key: "growatt", name: translate("Growatt day energy"), color: SERIES.dc, type: "line", width: 1.5, y: days.map((d) => d.growatt_kwh / 1000), format: mwh },
        ],
      },
      ratioLine(ratio),
    ],
  };
};

/** the shared 90–104 % ratio panel, its in-range points joined by a line (few days, pooled) */
const ratioLine = (ratio: Array<number | null>) => {
  const panel = ratioPanel(translate("Meter ÷ Growatt (%)"), translate("Meter ÷ Growatt"), ratio, { y: 100, label: "100 %" });
  panel.series = panel.series.map((s) => (s.key === "ratio" ? { ...s, type: "line", width: 2 } : s));
  return panel;
};
