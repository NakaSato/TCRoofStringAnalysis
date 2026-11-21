/** Engineering O&M → Finance: the PWA meter report's billing (measured Cewe meter kWh × the contract's
 * book price, from the imported Excel report) against the O&M spend the team entered in the Site log,
 * per calendar month and per report site. No estimates and no forecast: billed ฿ is measured energy at
 * the contract price, spend is entered (an event without a cost is counted, never priced as 0, and a
 * sum with no priced event is null). Spend is joined to a site by its Growatt plant and kept to the
 * report's months, so both sides cover the same plants and months; the rest of the spend is reported
 * apart as "outside the report". Rows come filtered and sorted from the page. */
import React from "react";
import type { OmCenterSpendMonth, PwaBillingRow, PwaBillingSite } from "../../api/client";
import type { ChartSeries, PanelChartSpec } from "../../components/PanelChart";
import { CATEGORICAL, SERIES } from "../../components/chartTheme";
import { fmt, fmtInt } from "../../components/ui";
import { cn } from "@/lib/utils";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { MODELLED } from "../pwaMeter/format";
import { SiteCell, SortHead, Tag, pctTone } from "../pwaMeter/tables";
import { BILLED_HINT, fmtMonth } from "./billing";
import { ENTERED, thb } from "./format";
import { translate, useI18n } from "../../i18n";

/** Site log event types grouped for the spend split */
export const SPEND_GROUPS = [
  { key: "cleaning", label: "Cleaning", types: ["cleaning"], color: CATEGORICAL[0] },
  { key: "repair", label: "Repair & replacement", types: ["repair", "module_replaced", "inverter_replaced"], color: CATEGORICAL[3] },
  { key: "inspection", label: "Inspection & service", types: ["pm_inspection", "inverter_service", "ir_flight", "site_visit"], color: CATEGORICAL[2] },
  { key: "other", label: "Other", types: [] as string[], color: SERIES.reference },
] as const;
export type SpendGroup = (typeof SPEND_GROUPS)[number]["key"];
const groupOf = (type: string): SpendGroup => SPEND_GROUPS.find((g) => (g.types as readonly string[]).includes(type))?.key ?? "other";

export const FINANCE_HINT = "Billed = Cewe meter kWh × the contract's book price (measured). O&M spend = Site log costs (entered). No estimates.";

export interface Spend {
  /** null = no event in the sum has a cost */
  thb: number | null;
  events: number;
  priced: number;
  by: Record<SpendGroup, number>;
}
const emptySpend = (): Spend => ({ thb: null, events: 0, priced: 0, by: { cleaning: 0, repair: 0, inspection: 0, other: 0 } });
const addSpend = (s: Spend, r: { spend_thb: number | null; events: number; events_priced: number; event_type: string }) => {
  s.events += r.events;
  s.priced += r.events_priced;
  if (r.spend_thb != null) {
    s.thb = (s.thb ?? 0) + r.spend_thb;
    s.by[groupOf(r.event_type)] += r.spend_thb;
  }
};
const ratio = (spend: number | null, billed: number | null) => (spend != null && billed ? (100 * spend) / billed : null);

export interface FinanceMonth {
  month: string;
  sites: number;
  billed_kwh: number | null;
  billed_thb: number | null;
  spend: Spend;
  /** spend ÷ billed, % */
  ratio_pct: number | null;
}

export interface FinanceSite {
  site_id: string;
  name: string;
  region: string | null;
  phase: number;
  kwp: number | null;
  growatt_plant_id: number | null;
  billed_kwh: number | null;
  billed_thb: number | null;
  vs_contract_pct: number | null;
  spend: Spend;
  ratio_pct: number | null;
  /** spend ÷ contract kWp */
  per_kwp: number | null;
  /** billed − spend; null without a priced event */
  net_thb: number | null;
}

export interface Finance {
  months: FinanceMonth[];
  sites: FinanceSite[];
  billed_kwh: number | null;
  billed_thb: number | null;
  spend: Spend;
  ratio_pct: number | null;
  /** spend ÷ billed MWh */
  per_mwh: number | null;
  net_thb: number | null;
  /** sites with at least one priced event */
  sites_with_spend: number;
  /** spend on plants not in the report, or in months the report does not cover */
  outside: Spend;
}

const add = (a: number | null, b: number | null) => (b == null ? a : (a ?? 0) + b);

/** Joins billing (rows per site × month, sites summed over the period) with the Site log spend. */
export const financeModel = (rows: PwaBillingRow[], sites: PwaBillingSite[], spendRows: OmCenterSpendMonth[]): Finance => {
  const siteOfPlant = new Map<number, string>();
  for (const s of sites) if (s.growatt_plant_id != null) siteOfPlant.set(s.growatt_plant_id, s.site_id);
  const months = [...new Set(rows.map((r) => r.month))].sort();
  const monthSet = new Set(months);

  const bySite = new Map<string, Spend>();
  const byMonth = new Map<string, Spend>();
  const outside = emptySpend();
  for (const r of spendRows) {
    const site = siteOfPlant.get(r.plant_id);
    if (!site || !monthSet.has(r.month)) {
      addSpend(outside, r);
      continue;
    }
    if (!bySite.has(site)) bySite.set(site, emptySpend());
    if (!byMonth.has(r.month)) byMonth.set(r.month, emptySpend());
    addSpend(bySite.get(site)!, r);
    addSpend(byMonth.get(r.month)!, r);
  }

  const monthRows: FinanceMonth[] = months.map((month) => {
    let billedKwh: number | null = null;
    let billedThb: number | null = null;
    let n = 0;
    for (const r of rows) {
      if (r.month !== month) continue;
      n += 1;
      billedKwh = add(billedKwh, r.billed_kwh);
      billedThb = add(billedThb, r.billed_thb);
    }
    const spend = byMonth.get(month) ?? emptySpend();
    return { month, sites: n, billed_kwh: billedKwh, billed_thb: billedThb, spend, ratio_pct: ratio(spend.thb, billedThb) };
  });

  const siteRows: FinanceSite[] = sites.map((s) => {
    const spend = bySite.get(s.site_id) ?? emptySpend();
    return {
      site_id: s.site_id,
      name: s.name,
      region: s.region,
      phase: s.phase,
      kwp: s.kwp,
      growatt_plant_id: s.growatt_plant_id,
      billed_kwh: s.billed_kwh,
      billed_thb: s.billed_thb,
      vs_contract_pct: s.vs_contract_pct,
      spend,
      ratio_pct: ratio(spend.thb, s.billed_thb),
      per_kwp: spend.thb != null && s.kwp ? spend.thb / s.kwp : null,
      net_thb: spend.thb != null && s.billed_thb != null ? s.billed_thb - spend.thb : null,
    };
  });

  const spend = emptySpend();
  for (const m of monthRows) {
    spend.events += m.spend.events;
    spend.priced += m.spend.priced;
    if (m.spend.thb != null) spend.thb = (spend.thb ?? 0) + m.spend.thb;
    for (const g of SPEND_GROUPS) spend.by[g.key] += m.spend.by[g.key];
  }
  const billedKwh = siteRows.reduce<number | null>((a, s) => add(a, s.billed_kwh), null);
  const billedThb = siteRows.reduce<number | null>((a, s) => add(a, s.billed_thb), null);
  return {
    months: monthRows,
    sites: siteRows,
    billed_kwh: billedKwh,
    billed_thb: billedThb,
    spend,
    ratio_pct: ratio(spend.thb, billedThb),
    per_mwh: spend.thb != null && billedKwh ? spend.thb / (billedKwh / 1000) : null,
    net_thb: spend.thb != null && billedThb != null ? billedThb - spend.thb : null,
    sites_with_spend: siteRows.filter((s) => s.spend.priced > 0).length,
    outside,
  };
};

const kthb = (v: number) => `฿${fmt(v / 1000, 0)}k`;

/** Per month: billed ฿ (measured × book price), O&M spend ฿ stacked by work type (entered), and spend ÷
 * billed %. One y scale per panel, so the small spend is readable next to the billing. Null without billing. */
export const financeMonthSpec = (months: FinanceMonth[]): PanelChartSpec | null => {
  if (!months.some((m) => m.billed_thb != null)) return null;
  const base = months.map(() => 0);
  const spendBars: ChartSeries[] = SPEND_GROUPS.map((g) => {
    const y0 = months.map((_, i) => base[i]);
    const y = months.map((m, i) => (m.spend.thb == null ? null : (base[i] += m.spend.by[g.key])));
    return { key: g.key, name: translate(g.label), type: "bar", color: g.color, y, y0, noTip: true };
  });
  return {
    xKind: "band",
    x: months.map((m) => m.month),
    xTickLabel: (v) => fmtMonth(String(v)),
    xTipLabel: (v) => fmtMonth(String(v), true),
    panels: [
      {
        key: "billed",
        title: translate("Billed value (฿, meter × book price)"),
        yMin: 0,
        tickFormat: kthb,
        series: [{ key: "billed", name: translate("Billed value"), type: "bar", color: SERIES.ac, y: months.map((m) => m.billed_thb), noLegend: true, format: (v) => thb(v) }],
      },
      {
        key: "spend",
        title: translate("O&M spend (฿, entered)"),
        stacked: true,
        yMin: 0,
        tickFormat: kthb,
        series: spendBars,
      },
      {
        key: "ratio",
        title: translate("O&M spend ÷ billed (%)"),
        weight: 0.6,
        yMin: 0,
        tickSuffix: " %",
        series: [{ key: "ratio", name: translate("Spend ÷ billed"), type: "line", color: SERIES.secondary, width: 2, y: months.map((m) => m.ratio_pct), noLegend: true, format: (v) => `${fmt(v, 2)} %` }],
      },
    ],
    tipExtra: (i) => {
      const m = months[i];
      return [
        { label: translate("Billed"), value: `${m.billed_kwh == null ? "—" : fmt(m.billed_kwh / 1000, 1)} MWh · ${thb(m.billed_thb)}` },
        ...SPEND_GROUPS.filter((g) => m.spend.by[g.key] > 0).map((g) => ({ label: translate(g.label), value: thb(m.spend.by[g.key]) })),
        { label: translate("O&M spend"), value: m.spend.thb == null ? translate("No cost entered") : thb(m.spend.thb) },
        { label: translate("Site log events"), value: translate("{n} of {total} have a cost", { n: fmtInt(m.spend.priced), total: fmtInt(m.spend.events) }) },
        { label: translate("Sites"), value: String(m.sites) },
      ];
    },
  };
};

export const FinanceSortKeys = ["spend", "name", "billed", "contract", "ratio", "perkwp", "net", "events"] as const;
export type FinanceSort = (typeof FinanceSortKeys)[number];

export const financeSortValue = (r: FinanceSite, k: FinanceSort): number | string | null =>
  k === "spend"
    ? r.spend.thb
    : k === "name"
      ? r.name
      : k === "billed"
        ? r.billed_thb
        : k === "contract"
          ? r.vs_contract_pct
          : k === "ratio"
            ? r.ratio_pct
            : k === "perkwp"
              ? r.per_kwp
              : k === "net"
                ? r.net_thb
                : r.spend.events;

/** a thin bar of the spend by work type, in proportion to the largest row's spend */
const SpendBar: React.FC<{ s: Spend; max: number }> = ({ s, max }) => {
  const { t } = useI18n();
  const title = SPEND_GROUPS.filter((g) => s.by[g.key] > 0)
    .map((g) => `${t(g.label)} ${thb(s.by[g.key])}`)
    .join(" · ");
  return (
    <div className="flex h-1.5 w-24 overflow-hidden rounded-full bg-white/[0.06]" title={title || undefined}>
      {SPEND_GROUPS.map((g) => (s.by[g.key] > 0 ? <div key={g.key} style={{ width: `${max ? (s.by[g.key] / max) * 100 : 0}%`, background: g.color }} /> : null))}
    </div>
  );
};

export const FinanceTable: React.FC<{
  rows: FinanceSite[];
  sort: FinanceSort;
  desc: boolean;
  onSort: (k: FinanceSort) => void;
  onOpen: (siteId: string) => void;
}> = ({ rows, sort, desc, onSort, onOpen }) => {
  const { t } = useI18n();
  const max = Math.max(0, ...rows.map((r) => r.spend.thb ?? 0));
  const h = { sort, desc, onSort };
  return (
    <Table>
      <TableHeader className="sticky top-0 z-10 bg-card">
        <TableRow>
          <SortHead k="name" label={t("Site")} {...h} />
          <SortHead k="billed" label={t("Billed ฿")} className="text-right" title={t(BILLED_HINT)} {...h} />
          <TableHead className="text-right" title={t(BILLED_HINT)}>
            {t("Billed MWh")}
          </TableHead>
          <SortHead
            k="contract"
            label={
              <>
                {t("vs contract")} <Tag kind="mod" />
              </>
            }
            className="text-right"
            title={`${t("Billed ÷ contract energy on the days with a contract figure.")} ${t(MODELLED)}`}
            {...h}
          />
          <SortHead k="spend" label={t("O&M spend ฿")} className="text-right" title={`${t("Site log costs of the site's Growatt plant in the report's months.")} ${t(ENTERED)}`} {...h} />
          <SortHead k="events" label={t("Events")} className="text-right" title={t("Site log events with a cost / all events")} {...h} />
          <SortHead k="ratio" label={t("Spend ÷ billed")} className="text-right" title={t("O&M spend ÷ billed value")} {...h} />
          <SortHead k="perkwp" label={t("฿ / kWp")} className="text-right" title={t("O&M spend ÷ the contract kWp")} {...h} />
          <SortHead k="net" label={t("Billed − spend ฿")} className="text-right" title={t("Billed value minus the entered O&M spend; — when no cost is entered")} {...h} />
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((r) => (
          <TableRow key={r.site_id} className="cursor-pointer" onClick={() => onOpen(r.site_id)}>
            <TableCell>
              <SiteCell name={r.name} siteId={r.site_id} region={r.region} />
            </TableCell>
            <TableCell className="num text-right">{fmtInt(r.billed_thb)}</TableCell>
            <TableCell className="num text-right text-muted-foreground">{r.billed_kwh == null ? "—" : fmt(r.billed_kwh / 1000, 1)}</TableCell>
            <TableCell className={cn("num text-right", pctTone(r.vs_contract_pct, 100, 90))}>{r.vs_contract_pct == null ? "—" : `${fmt(r.vs_contract_pct, 1)} %`}</TableCell>
            <TableCell className="num text-right">
              <span className="flex flex-col items-end gap-1">
                <span>{r.spend.thb == null ? (r.spend.events ? <span className="text-muted-foreground">{t("Not entered")}</span> : "—") : fmtInt(r.spend.thb)}</span>
                {r.spend.thb != null && <SpendBar s={r.spend} max={max} />}
              </span>
            </TableCell>
            <TableCell className="num text-right text-muted-foreground">{r.spend.events ? `${fmtInt(r.spend.priced)} / ${fmtInt(r.spend.events)}` : "—"}</TableCell>
            <TableCell className="num text-right">{r.ratio_pct == null ? "—" : `${fmt(r.ratio_pct, 2)} %`}</TableCell>
            <TableCell className="num text-right">{r.per_kwp == null ? "—" : fmt(r.per_kwp, 1)}</TableCell>
            <TableCell className="num text-right">{fmtInt(r.net_thb)}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
};
