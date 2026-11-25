/** Engineering O&M: the PWA meter report as billing. Per site and calendar month the billed meter
 * energy at the contract's book price, the contract's energy (modelled) and the shortfall against it.
 * No estimated causes or recoverable baht: only the report's measured meter energy and the contract.
 * Rows come filtered and sorted from the page; the month totals are summed here from the rows the user
 * may see (an engineer's own sites only). */
import React from "react";
import type { PwaBillingRow, PwaBillingSite } from "../../api/client";
import type { ChartSeries, PanelChartSpec } from "../../components/PanelChart";
import { SERIES } from "../../components/chartTheme";
import { fmt, fmtInt } from "../../components/ui";
import { cn } from "@/lib/utils";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { MODELLED } from "../pwaMeter/format";
import { SiteCell, SortHead, Tag, pctTone } from "../pwaMeter/tables";
import { PHASE_COLOR, contractRefLines } from "./chartSpecs";
import type { ContractBands } from "./chartSpecs";
import { thb } from "./format";
import { dateLocale, translate, useI18n } from "../../i18n";

export const BILLED_HINT = "Measured: the Cewe meter kWh the site billed, priced at the contract's book price";

const mwh = (kwh: number | null | undefined, nd = 1) => (kwh == null ? "—" : fmt(kwh / 1000, nd));
export const fmtMonth = (m: string, long = false) => {
  const [y, mo] = m.split("-").map(Number);
  return new Date(y, mo - 1, 1).toLocaleDateString(dateLocale(), long ? { month: "long", year: "numeric" } : { month: "short", year: "2-digit" });
};

/* -------------------------------------------------------------------------- */
/* Month totals (summed from the visible rows)                                */
/* -------------------------------------------------------------------------- */
export interface MonthTotal {
  month: string;
  sites: number;
  billed_kwh: number | null;
  billed_thb: number | null;
  /** per phase, for the stacked bars */
  billed_by_phase: Record<number, number>;
  contract_kwh: number | null;
  /** meter kWh on the days with a contract figure (contract − shortfall) */
  billed_c_kwh: number;
  shortfall_kwh: number | null;
  missing_days: number;
}

const add = (a: number | null, b: number | null) => (b == null ? a : (a ?? 0) + b);

export const monthTotals = (rows: PwaBillingRow[], months: string[]): MonthTotal[] =>
  months
    .map((month) => {
      const t: MonthTotal = {
        month,
        sites: 0,
        billed_kwh: null,
        billed_thb: null,
        billed_by_phase: {},
        contract_kwh: null,
        billed_c_kwh: 0,
        shortfall_kwh: null,
        missing_days: 0,
      };
      for (const r of rows) {
        if (r.month !== month) continue;
        t.sites += 1;
        t.billed_kwh = add(t.billed_kwh, r.billed_kwh);
        t.billed_thb = add(t.billed_thb, r.billed_thb);
        if (r.billed_kwh != null) t.billed_by_phase[r.phase] = (t.billed_by_phase[r.phase] ?? 0) + r.billed_kwh;
        if (r.contract_kwh != null) {
          t.contract_kwh = add(t.contract_kwh, r.contract_kwh);
          t.billed_c_kwh += r.contract_kwh - (r.shortfall_kwh ?? 0);
        }
        t.shortfall_kwh = add(t.shortfall_kwh, r.shortfall_kwh);
        t.missing_days += r.missing_days;
      }
      return t;
    })
    .filter((t) => t.sites > 0);

/* -------------------------------------------------------------------------- */
/* Charts                                                                     */
/* -------------------------------------------------------------------------- */
/** Billed MWh per month (a bar per month, a segment per phase) against the contract's MWh (modelled,
 * dashed), and billed ÷ contract % under it. Null without billed energy. */
export const billedMonthSpec = (t: MonthTotal[], bands: ContractBands | null = null): PanelChartSpec | null => {
  if (!t.some((m) => m.billed_kwh != null)) return null;
  const phases = [...new Set(t.flatMap((m) => Object.keys(m.billed_by_phase).map(Number)))].sort();
  const base = t.map(() => 0);
  const bars: ChartSeries[] = phases.map((ph) => {
    const y0 = t.map((_, i) => base[i]);
    const y = t.map((m, i) => (m.billed_by_phase[ph] == null ? null : (base[i] += m.billed_by_phase[ph] / 1000)));
    return { key: `p${ph}`, name: phases.length > 1 ? translate("Billed, phase {n}", { n: ph }) : translate("Billed (meter)"), type: "bar", color: PHASE_COLOR[ph] ?? SERIES.secondary, y, y0, noTip: true };
  });
  const pct = t.map((m) => (m.contract_kwh ? (100 * m.billed_c_kwh) / m.contract_kwh : null));
  return {
    xKind: "band",
    x: t.map((m) => m.month),
    xTickLabel: (v) => fmtMonth(String(v)),
    xTipLabel: (v) => fmtMonth(String(v), true),
    panels: [
      {
        key: "mwh",
        title: translate("Billed energy (MWh)"),
        stacked: true,
        yMin: 0,
        series: [
          ...bars,
          { key: "contract", name: translate("Contract (modelled)"), type: "line", color: SERIES.reference, dash: "dash", width: 2, y: t.map((m) => (m.contract_kwh == null ? null : m.contract_kwh / 1000)), format: (v) => `${fmt(v, 1)} MWh` },
        ],
      },
      {
        key: "pct",
        title: translate("Billed / contract (%)"),
        weight: 0.6,
        zero: false,
        tickSuffix: " %",
        refLines: contractRefLines(bands),
        series: [{ key: "pct", name: translate("Billed / contract"), type: "line", color: SERIES.ac, width: 2, y: pct, noLegend: true, format: (v) => `${fmt(v, 1)} %` }],
      },
    ],
    tipExtra: (i) => [
      ...phases.filter((ph) => t[i].billed_by_phase[ph] != null).map((ph) => ({ label: translate("Phase {n}", { n: ph }), value: `${mwh(t[i].billed_by_phase[ph])} MWh` })),
      { label: translate("Billed"), value: `${mwh(t[i].billed_kwh)} MWh · ${thb(t[i].billed_thb)}` },
      { label: translate("Sites"), value: String(t[i].sites) },
      ...(t[i].missing_days ? [{ label: translate("Days without a reading"), value: fmtInt(t[i].missing_days) }] : []),
    ],
  };
};

/* -------------------------------------------------------------------------- */
/* By region (the sites' period totals)                                       */
/* -------------------------------------------------------------------------- */
export interface RegionTotal {
  region: string;
  sites: number;
  kwp: number;
  billed_kwh: number | null;
  billed_by_phase: Record<number, number>;
  contract_kwh: number | null;
  /** meter kWh on the days with a contract figure (contract − shortfall) */
  billed_c_kwh: number;
}

const NO_REGION = "—";

/** the visible sites' billing summed per PWA region (เขต), in the region's number order */
export const regionTotals = (sites: PwaBillingSite[]): RegionTotal[] => {
  const by = new Map<string, RegionTotal>();
  for (const s of sites) {
    const key = s.region?.trim() || NO_REGION;
    const t = by.get(key) ?? { region: key, sites: 0, kwp: 0, billed_kwh: null, billed_by_phase: {}, contract_kwh: null, billed_c_kwh: 0 };
    t.sites += 1;
    t.kwp += s.kwp ?? 0;
    t.billed_kwh = add(t.billed_kwh, s.billed_kwh);
    if (s.billed_kwh != null) t.billed_by_phase[s.phase] = (t.billed_by_phase[s.phase] ?? 0) + s.billed_kwh;
    if (s.contract_kwh != null) {
      t.contract_kwh = add(t.contract_kwh, s.contract_kwh);
      t.billed_c_kwh += s.contract_kwh - (s.shortfall_kwh ?? 0);
    }
    by.set(key, t);
  }
  return [...by.values()].sort((a, b) => (a.region === NO_REGION ? 1 : b.region === NO_REGION ? -1 : a.region.localeCompare(b.region, "th", { numeric: true })));
};

/** Billed MWh per region over the period (a segment per phase) against the contract's (modelled,
 * dashed), and billed ÷ contract % with the criteria file's watch / red lines. Null without billed energy. */
export const billedRegionSpec = (t: RegionTotal[], bands: ContractBands | null = null): PanelChartSpec | null => {
  if (!t.some((r) => r.billed_kwh != null)) return null;
  const phases = [...new Set(t.flatMap((r) => Object.keys(r.billed_by_phase).map(Number)))].sort();
  const base = t.map(() => 0);
  const bars: ChartSeries[] = phases.map((ph) => {
    const y0 = t.map((_, i) => base[i]);
    const y = t.map((r, i) => (r.billed_by_phase[ph] == null ? null : (base[i] += r.billed_by_phase[ph] / 1000)));
    return { key: `p${ph}`, name: phases.length > 1 ? translate("Billed, phase {n}", { n: ph }) : translate("Billed (meter)"), type: "bar", color: PHASE_COLOR[ph] ?? SERIES.secondary, y, y0, noTip: true };
  });
  const pct = t.map((r) => (r.contract_kwh ? (100 * r.billed_c_kwh) / r.contract_kwh : null));
  return {
    xKind: "band",
    x: t.map((r) => r.region),
    panels: [
      {
        key: "mwh",
        title: translate("Billed energy (MWh)"),
        stacked: true,
        yMin: 0,
        series: [
          ...bars,
          { key: "contract", name: translate("Contract (modelled)"), type: "points", symbol: "diamond", size: 7, color: SERIES.reference, y: t.map((r) => (r.contract_kwh == null ? null : r.contract_kwh / 1000)), format: (v) => `${fmt(v, 1)} MWh` },
        ],
      },
      {
        key: "pct",
        title: translate("Billed / contract (%)"),
        weight: 0.8,
        zero: false,
        tickSuffix: " %",
        refLines: contractRefLines(bands),
        series: [{ key: "pct", name: translate("Billed / contract"), type: "points", size: 6, color: SERIES.ac, y: pct, noLegend: true, format: (v) => `${fmt(v, 1)} %` }],
      },
    ],
    tipExtra: (i) => [
      ...phases.filter((ph) => t[i].billed_by_phase[ph] != null).map((ph) => ({ label: translate("Phase {n}", { n: ph }), value: `${mwh(t[i].billed_by_phase[ph])} MWh` })),
      { label: translate("Billed"), value: `${mwh(t[i].billed_kwh)} MWh` },
      { label: translate("Billed per kWp"), value: t[i].billed_kwh != null && t[i].kwp ? `${fmt(t[i].billed_kwh! / t[i].kwp, 0)} kWh/kWp` : "—" },
      { label: translate("Sites"), value: String(t[i].sites) },
    ],
  };
};

/* -------------------------------------------------------------------------- */
/* Tables                                                                     */
/* -------------------------------------------------------------------------- */
export const BillSortKeys = ["month", "name", "billed", "contract", "short", "missing"] as const;
export type BillSort = (typeof BillSortKeys)[number];

export const billSortValue = (r: PwaBillingRow, k: BillSort): number | string | null =>
  k === "month" ? r.month : k === "name" ? r.name : k === "billed" ? r.billed_kwh : k === "contract" ? r.vs_contract_pct : k === "short" ? r.shortfall_kwh : r.missing_days;

const shortTone = (v: number | null) => (v == null ? "" : v > 0 ? "text-red-300" : "text-emerald-300");

const ShortCell: React.FC<{ r: PwaBillingRow }> = ({ r }) => {
  const { t } = useI18n();
  return (
    <TableCell className={cn("num text-right", shortTone(r.shortfall_kwh))} title={r.shortfall_thb == null ? undefined : t("{thb} at the book price; negative = above contract", { thb: thb(r.shortfall_thb) })}>
      {mwh(r.shortfall_kwh, 2)}
    </TableCell>
  );
};

const ContractHead = <K extends string>({ k, sort, desc, onSort }: { k: K; sort: K; desc: boolean; onSort: (k: K) => void }) => {
  const { t } = useI18n();
  return (
  <SortHead
    k={k}
    label={
      <>
        {t("vs contract")} <Tag kind="mod" />
      </>
    }
    sort={sort}
    desc={desc}
    onSort={onSort}
    className="text-right"
    title={`${t("Billed / contract energy on the days with a contract figure.")} ${t(MODELLED)}`}
  />
  );
};

export const BillingTable: React.FC<{
  rows: PwaBillingRow[];
  sort: BillSort;
  desc: boolean;
  onSort: (k: BillSort) => void;
  onOpen: (siteId: string) => void;
}> = ({ rows, sort, desc, onSort, onOpen }) => {
  const { t } = useI18n();
  return (
    <Table>
      <TableHeader className="sticky top-0 z-10 bg-card">
        <TableRow>
          <SortHead k="month" label={t("Month")} sort={sort} desc={desc} onSort={onSort} title={t("Calendar month (the period's first and last months may be partial)")} />
          <SortHead k="name" label={t("Site")} sort={sort} desc={desc} onSort={onSort} />
          <SortHead k="missing" label={t("Read d")} sort={sort} desc={desc} onSort={onSort} className="text-right" title={t("Days with a billed reading; red = days without one since the site's first report day")} />
          <SortHead k="billed" label={t("Billed MWh")} sort={sort} desc={desc} onSort={onSort} className="text-right" title={t(BILLED_HINT)} />
          <TableHead className="text-right" title={t(BILLED_HINT)}>
            {t("Billed ฿")}
          </TableHead>
          <TableHead className="text-right" title={t(MODELLED)}>
            {t("Contract MWh")} <Tag kind="mod" />
          </TableHead>
          <ContractHead k="contract" sort={sort} desc={desc} onSort={onSort} />
          <SortHead
            k="short"
            label={
              <>
                {t("Shortfall MWh")} <Tag kind="mod" />
              </>
            }
            sort={sort}
            desc={desc}
            onSort={onSort}
            className="text-right"
            title={t("Contract − billed energy (modelled contract); negative = above contract")}
          />
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((r) => (
          <TableRow key={`${r.site_id}-${r.month}`} className="cursor-pointer" onClick={() => onOpen(r.site_id)}>
            <TableCell className="whitespace-nowrap" title={`${r.start} – ${r.end}`}>
              {fmtMonth(r.month)}
            </TableCell>
            <TableCell>
              <SiteCell name={r.name} siteId={r.site_id} region={r.region} />
            </TableCell>
            <TableCell className="num text-right whitespace-nowrap">
              {fmtInt(r.meter_days)}
              {r.missing_days > 0 && <span className="ml-1 text-[11px] text-red-300">−{fmtInt(r.missing_days)}</span>}
            </TableCell>
            <TableCell className="num text-right">{mwh(r.billed_kwh, 2)}</TableCell>
            <TableCell className="num text-right">{fmtInt(r.billed_thb)}</TableCell>
            <TableCell className="num text-right">{mwh(r.contract_kwh, 2)}</TableCell>
            <TableCell className={cn("num text-right", pctTone(r.vs_contract_pct, 100, 90))}>{r.vs_contract_pct == null ? "—" : `${fmt(r.vs_contract_pct, 1)} %`}</TableCell>
            <ShortCell r={r} />
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
};
