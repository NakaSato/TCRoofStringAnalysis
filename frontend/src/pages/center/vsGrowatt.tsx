/** Engineering O&M, Meter vs Growatt: each report site's Cewe meter days against Growatt's own day
 * energy (`plant/energy`) of its Growatt plant, both measured (`/pwa/meter/vs-growatt`). The table
 * per site and the chart of the pooled days; nothing estimated. The ratio carries the AC losses
 * between the inverters and the grid-point meter, so about 98.5–99 % is normal. */
import React from "react";
import type { PwaVsGrowattDay, PwaVsGrowattSite } from "../../api/client";
import type { PanelChartSpec } from "../../components/PanelChart";
import { CATEGORICAL, SERIES, STATUS } from "../../components/chartTheme";
import { fmt, fmtInt } from "../../components/ui";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { fitRatioRange, ratioPanel } from "../pwaMeter/chart";
import { daysBetween, fmtDay, fmtDayShort } from "../pwaMeter/format";
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
          <SortHead k="ratio" label={t("Meter / Growatt")} sort={sort} desc={desc} onSort={onSort} className="text-right" title={t("Pooled over the compared days")} />
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
  /** sites compared that day (0 = none: a day with no site where both read > 0) */
  sites: number;
  meter_kwh: number | null;
  growatt_kwh: number | null;
}

/** The days of one phase (or all, summed over the phases), one row per calendar day from the first to
 * the last compared day: a day with nothing compared is a row of nulls, so the chart leaves it empty
 * instead of drawing a line across it. A phase row missing either side is left out of the sums. */
export const vsGrowattDays = (days: PwaVsGrowattDay[], phase: number | null): VsGrowattDayTotal[] => {
  const map = new Map<string, { sites: number; meter_kwh: number; growatt_kwh: number }>();
  for (const d of days) {
    if (phase != null && d.phase !== phase) continue;
    if (d.meter_kwh == null || d.growatt_kwh == null || d.sites <= 0) continue;
    const t = map.get(d.day) ?? { sites: 0, meter_kwh: 0, growatt_kwh: 0 };
    t.sites += d.sites;
    t.meter_kwh += d.meter_kwh;
    t.growatt_kwh += d.growatt_kwh;
    map.set(d.day, t);
  }
  const keys = [...map.keys()].sort();
  if (!keys.length) return [];
  return daysBetween(keys[0], keys[keys.length - 1]).map((day) => {
    const t = map.get(day);
    return t ? { day, ...t } : { day, sites: 0, meter_kwh: null, growatt_kwh: null };
  });
};

/** Pooled per day over the sites compared, one slot per calendar day: meter and Growatt energy, meter ÷
 * Growatt on an axis fitted to the period (100 % and the period's pooled ratio as reference lines), and
 * how many sites were compared, so a step in the energy lines reads as sites joining or leaving. */
export const vsGrowattDaySpec = (days: VsGrowattDayTotal[]): PanelChartSpec | null => {
  if (!days.some((d) => d.sites > 0)) return null;
  const mwh = (v: number) => `${fmt(v, 2)} MWh`;
  const ratio = days.map((d) => (d.meter_kwh != null && d.growatt_kwh != null && d.growatt_kwh > 0 ? (100 * d.meter_kwh) / d.growatt_kwh : null));
  const sumM = days.reduce((a, d) => a + (d.meter_kwh ?? 0), 0);
  const sumG = days.reduce((a, d) => a + (d.growatt_kwh ?? 0), 0);
  const pooled = sumG > 0 ? (100 * sumM) / sumG : null;
  const refs = [100, ...(pooled != null ? [pooled] : [])];
  const range = fitRatioRange(ratio, refs);
  const title = pooled != null ? translate("Meter / Growatt (%) · period {v} %", { v: fmt(pooled, 2) }) : translate("Meter / Growatt (%)");
  const ratioP = ratioPanel(title, translate("Meter / Growatt"), ratio, { y: 100, label: "100 %" }, range);
  // in-range days joined by a line (a pooled ratio moves little day to day); an empty day breaks it
  ratioP.series = ratioP.series.map((s) => (s.key === "ratio" ? { ...s, type: "line", width: 2 } : s));
  // the period's line only where its label clears the 100 % one; the title always gives the figure
  if (pooled != null && pooled >= range.lo && pooled <= range.hi && Math.abs(pooled - 100) >= 0.6)
    ratioP.refLines = [...(ratioP.refLines ?? []), { y: pooled, label: translate("Period {v} %", { v: fmt(pooled, 2) }), color: SERIES.reference }];
  ratioP.weight = 1.3;
  return {
    xKind: "band",
    x: days.map((d) => d.day),
    xTickLabel: (v) => fmtDayShort(String(v)),
    xTipLabel: (v) => fmtDay(String(v)),
    tipExtra: (i) => {
      const d = days[i];
      if (!d.sites) return [{ label: translate("Sites compared"), value: translate("None (no site with both readings)") }];
      const diff = d.growatt_kwh! - d.meter_kwh!;
      return [{ label: translate("Growatt − meter (derived)"), value: `${diff >= 0 ? "" : "−"}${fmt(Math.abs(diff) / 1000, 2)} MWh` }];
    },
    panels: [
      {
        key: "energy",
        title: translate("Energy of the sites compared (MWh/day)"),
        weight: 1.6,
        yMin: 0,
        series: [
          { key: "meter", name: translate("PWA meter (billed)"), color: SERIES.ac, type: "line", area: true, width: 2, y: days.map((d) => (d.meter_kwh == null ? null : d.meter_kwh / 1000)), format: mwh },
          { key: "growatt", name: translate("Growatt day energy"), color: SERIES.dc, type: "line", width: 2, y: days.map((d) => (d.growatt_kwh == null ? null : d.growatt_kwh / 1000)), format: mwh },
        ],
      },
      ratioP,
      {
        key: "sites",
        title: translate("Sites compared"),
        weight: 0.6,
        yMin: 0,
        tickFormat: (t) => (Number.isInteger(t) ? String(t) : ""),
        series: [
          // a count, not energy: the categorical slot no other series of this chart uses
          { key: "sites", name: translate("Sites compared"), color: CATEGORICAL[4], type: "bar", y: days.map((d) => (d.sites ? d.sites : null)), format: (v) => fmtInt(v) },
        ],
      },
    ],
  };
};

const BIN_LO = 96;
const BIN_HI = 101;
const BIN_W = 0.5;

/** How many sites have their median meter ÷ Growatt in each half-point bin (open bins under 96 % and
 * from 101 %), coloured by the criteria file's normal range like the tile (green inside, amber outside;
 * one neutral colour until the criteria file answers). Hovering a bin names its sites. */
export const vsGrowattSiteSpec = (sites: PwaVsGrowattSite[], band: { low: number; high: number } | null): PanelChartSpec | null => {
  const rated = sites.filter((s) => s.median_ratio_pct != null);
  if (!rated.length) return null;
  const n = Math.round((BIN_HI - BIN_LO) / BIN_W);
  // bin 0 = below BIN_LO, 1..n = [BIN_LO + (k-1)·w, +w), n+1 = from BIN_HI
  const bins: PwaVsGrowattSite[][] = Array.from({ length: n + 2 }, () => []);
  for (const s of rated) {
    const v = s.median_ratio_pct!;
    const k = v < BIN_LO ? 0 : v >= BIN_HI ? n + 1 : 1 + Math.floor((v - BIN_LO) / BIN_W + 1e-9);
    bins[k].push(s);
  }
  const lower = (k: number) => BIN_LO + (k - 1) * BIN_W;
  const mid = (k: number) => (k === 0 ? BIN_LO - 1 : k === n + 1 ? BIN_HI + 1 : lower(k) + BIN_W / 2);
  const tick = (k: number) => (k === 0 ? `< ${BIN_LO}` : k === n + 1 ? `≥ ${BIN_HI}` : fmt(lower(k), 1));
  const range = (k: number) => (k === 0 ? `< ${BIN_LO} %` : k === n + 1 ? `≥ ${BIN_HI} %` : `${fmt(lower(k), 1)}–${fmt(lower(k) + BIN_W, 1)} %`);
  const inside = (k: number) => band != null && mid(k) >= band.low && mid(k) < band.high;
  const keys = bins.map((_, k) => String(k));
  const counts = bins.map((b) => b.length);
  const NORMAL = STATUS.good;
  const OUTSIDE = STATUS.warn;
  return {
    xKind: "band",
    x: keys,
    xTickLabel: (v) => tick(Number(v)),
    xTipLabel: (v) => translate("Site median {range}", { range: range(Number(v)) }),
    xLabel: translate("Site median meter / Growatt (%, bin start)"),
    legend: band
      ? [
          { label: translate("Normal {lo}–{hi} %", { lo: fmt(band.low, 1), hi: fmt(band.high, 1) }), color: NORMAL, shape: "bar" },
          { label: translate("Outside the normal range"), color: OUTSIDE, shape: "bar" },
        ]
      : undefined,
    tipExtra: (i) => {
      const b = [...bins[i]].sort((a, z) => a.median_ratio_pct! - z.median_ratio_pct!);
      if (!b.length) return [];
      const shown = b.slice(0, 6).map((s) => ({ label: s.name, value: `${fmt(s.median_ratio_pct, 2)} %` }));
      return b.length > 6 ? [...shown, { label: translate("and {n} more", { n: b.length - 6 }), value: "" }] : shown;
    },
    panels: [
      {
        key: "sites",
        title: translate("Sites (count)"),
        yMin: 0,
        tickFormat: (t) => (Number.isInteger(t) ? String(t) : ""),
        series: [
          {
            key: "sites",
            name: translate("Sites"),
            color: SERIES.secondary,
            colors: band ? bins.map((_, k) => (inside(k) ? NORMAL : OUTSIDE)) : undefined,
            type: "bar",
            y: counts.map((c) => (c ? c : null)),
            labels: counts.map((c) => (c ? String(c) : null)),
            format: (v) => fmtInt(v),
          },
        ],
      },
    ],
  };
};
