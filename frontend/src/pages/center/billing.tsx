/** Engineering O&M: the PWA meter report as billing. Per site and calendar month the billed meter
 * energy at the contract's book price, the contract's energy (modelled) and the shortfall against it,
 * split into the engineering causes: outage, under-performance and meter gap (what O&M can win back,
 * "recoverable") and curtailment (PM's: PWA's own load). Causes and recoverable baht are estimated,
 * the contract is modelled; the rest of the shortfall is "not explained" (weather against the model, …).
 * Rows come filtered and sorted from the page; the month totals are summed here from the rows the user
 * may see (an engineer's own sites only). */
import React from "react";
import type { PwaBillingCause, PwaBillingRow, PwaBillingSite } from "../../api/client";
import type { ChartSeries, PanelChartSpec } from "../../components/PanelChart";
import { SERIES } from "../../components/chartTheme";
import { fmt, fmtInt } from "../../components/ui";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { EST, MODELLED } from "../pwaMeter/format";
import { SiteCell, SortHead, Tag, pctTone } from "../pwaMeter/tables";
import { PHASE_COLOR } from "./chartSpecs";
import { thb } from "./format";
import { dateLocale, translate, useI18n } from "../../i18n";

/** the causes in stacking order: the three O&M can recover, then curtailment */
export const BILL_CAUSES: ReadonlyArray<{ key: PwaBillingCause; label: string; color: string; hint: string }> = [
  { key: "outage", label: "Outage", color: "#f87171", hint: "Meter and inverter both < 1 kWh; energy the phase's free-running sites made on those days" },
  { key: "under", label: "Under-performance", color: "#fbbf24", hint: "Below 95 % of the phase's free-running sites on producing days" },
  { key: "meter_gap", label: "Meter gap", color: "#a78bfa", hint: "Energy the inverters made that the meter did not bill (low or missing readings)" },
  { key: "curtailment", label: "Curtailment", color: "#38bdf8", hint: "Output limited to PWA's own load: a PM / contract matter, not recoverable by O&M" },
];
export const CAUSE_LABEL = Object.fromEntries(BILL_CAUSES.map((c) => [c.key, c.label])) as Record<PwaBillingCause, string>;
const causeKwh = (r: PwaBillingRow | PwaBillingSite, k: PwaBillingCause): number | null => r[`${k}_kwh`];

export const BILL_EST = "Estimated from the PWA meter report and its criteria file, judged per month, priced at the contract's book price";
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
  recoverable_kwh: number;
  recoverable_thb: number;
  causes: Record<PwaBillingCause, number>;
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
        recoverable_kwh: 0,
        recoverable_thb: 0,
        causes: { outage: 0, under: 0, meter_gap: 0, curtailment: 0 },
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
        t.recoverable_kwh += r.recoverable_kwh ?? 0;
        t.recoverable_thb += r.recoverable_thb ?? 0;
        for (const c of BILL_CAUSES) t.causes[c.key] += causeKwh(r, c.key) ?? 0;
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
export const billedMonthSpec = (t: MonthTotal[]): PanelChartSpec | null => {
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
        title: translate("Billed ÷ contract (%)"),
        weight: 0.6,
        zero: false,
        tickSuffix: " %",
        refLines: [{ y: 100, label: translate("Contract") }],
        series: [{ key: "pct", name: translate("Billed ÷ contract"), type: "line", color: SERIES.ac, width: 2, y: pct, noLegend: true, format: (v) => `${fmt(v, 1)} %` }],
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

/** Per month, the estimated MWh of each cause (stacked; recoverable first) against the measured
 * shortfall vs the modelled contract (line; negative = above contract). Null with no cause and no shortfall. */
export const shortfallMonthSpec = (t: MonthTotal[]): PanelChartSpec | null => {
  if (!t.some((m) => m.shortfall_kwh != null || Object.values(m.causes).some((v) => v > 0))) return null;
  const base = t.map(() => 0);
  const bars: ChartSeries[] = BILL_CAUSES.map((c) => {
    const y0 = t.map((_, i) => base[i]);
    const y = t.map((m, i) => (base[i] += m.causes[c.key] / 1000));
    return { key: c.key, name: translate(c.label), type: "bar", color: c.color, y, y0, noTip: true, noLegend: true }; // the card lists the causes with their totals
  });
  return {
    xKind: "band",
    x: t.map((m) => m.month),
    xTickLabel: (v) => fmtMonth(String(v)),
    xTipLabel: (v) => fmtMonth(String(v), true),
    panels: [
      {
        key: "mwh",
        title: translate("Shortfall vs contract and its causes (MWh)"),
        stacked: true,
        series: [
          ...bars,
          { key: "short", name: translate("Shortfall vs contract"), type: "line", color: "#e5e7eb", width: 2, y: t.map((m) => (m.shortfall_kwh == null ? null : m.shortfall_kwh / 1000)), format: (v) => `${fmt(v, 1)} MWh` },
        ],
        refLines: [{ y: 0, label: translate("On contract") }],
      },
    ],
    tipExtra: (i) => {
      const m = t[i];
      const explained = Object.values(m.causes).reduce((a, b) => a + b, 0);
      return [
        ...BILL_CAUSES.map((c) => ({ label: translate("{label} (est.)", { label: translate(c.label) }), value: `${mwh(m.causes[c.key], 2)} MWh` })),
        { label: translate("Recoverable (est.)"), value: `${mwh(m.recoverable_kwh)} MWh · ${thb(m.recoverable_thb)}` },
        ...(m.shortfall_kwh != null ? [{ label: translate("Not explained"), value: `${mwh(m.shortfall_kwh - explained)} MWh` }] : []),
      ];
    },
  };
};

/* -------------------------------------------------------------------------- */
/* Tables                                                                     */
/* -------------------------------------------------------------------------- */
export const BillSortKeys = ["month", "name", "billed", "contract", "short", "recover", "missing"] as const;
export type BillSort = (typeof BillSortKeys)[number];
export const RecoverSortKeys = ["rank", "name", "billed", "contract", "short", "recover", "unexplained"] as const;
export type RecoverSort = (typeof RecoverSortKeys)[number];

export const billSortValue = (r: PwaBillingRow, k: BillSort): number | string | null =>
  k === "month" ? r.month : k === "name" ? r.name : k === "billed" ? r.billed_kwh : k === "contract" ? r.vs_contract_pct : k === "short" ? r.shortfall_kwh : k === "recover" ? r.recoverable_thb : r.missing_days;

export const recoverSortValue = (r: PwaBillingSite, k: RecoverSort): number | string | null =>
  k === "rank" ? r.rank : k === "name" ? r.name : k === "billed" ? r.billed_kwh : k === "contract" ? r.vs_contract_pct : k === "short" ? r.shortfall_kwh : k === "recover" ? r.recoverable_thb : r.unexplained_kwh;

const shortTone = (v: number | null) => (v == null ? "" : v > 0 ? "text-red-300" : "text-emerald-300");

/** a thin bar of the causes, in proportion to the largest row's explained energy */
const CauseBar: React.FC<{ r: PwaBillingRow | PwaBillingSite; max: number }> = ({ r, max }) => {
  const { t } = useI18n();
  const parts = BILL_CAUSES.map((c) => ({ ...c, v: causeKwh(r, c.key) ?? 0 })).filter((p) => p.v > 0);
  const title = BILL_CAUSES.map((c) => `${t(c.label)} ${mwh(causeKwh(r, c.key), 2)} MWh`).join(" · ");
  return (
    <div className="flex h-2 w-28 overflow-hidden rounded-full bg-white/[0.06]" title={t("{label} (est.)", { label: title })}>
      {parts.map((p) => (
        <div key={p.key} style={{ width: `${max ? (p.v / max) * 100 : 0}%`, background: p.color }} />
      ))}
    </div>
  );
};

const explained = (r: PwaBillingRow | PwaBillingSite) => BILL_CAUSES.reduce((s, c) => s + (causeKwh(r, c.key) ?? 0), 0);

const ShortCell: React.FC<{ r: PwaBillingRow | PwaBillingSite }> = ({ r }) => {
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
    title={`${t("Billed ÷ contract energy on the days with a contract figure.")} ${t(MODELLED)}`}
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
  const max = Math.max(0, ...rows.map(explained));
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
          <TableHead title={`${t("Outage · under-performance · meter gap · curtailment.")} ${t(BILL_EST)}`}>
            {t("Causes")} <Tag kind="est" />
          </TableHead>
          <SortHead
            k="recover"
            label={
              <>
                {t("Recoverable ฿")} <Tag kind="est" />
              </>
            }
            sort={sort}
            desc={desc}
            onSort={onSort}
            className="text-right"
            title={`${t("(Outage + under-performance + meter gap) × book price.")} ${t(BILL_EST)}`}
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
            <TableCell>
              <CauseBar r={r} max={max} />
            </TableCell>
            <TableCell className="num text-right">{fmtInt(r.recoverable_thb)}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
};

export const RecoverTable: React.FC<{
  rows: PwaBillingSite[];
  sort: RecoverSort;
  desc: boolean;
  onSort: (k: RecoverSort) => void;
  onOpen: (siteId: string) => void;
}> = ({ rows, sort, desc, onSort, onOpen }) => {
  const { t } = useI18n();
  const max = Math.max(0, ...rows.map(explained));
  return (
    <Table>
      <TableHeader className="sticky top-0 z-10 bg-card">
        <TableRow>
          <SortHead k="rank" label="#" sort={sort} desc={desc} onSort={onSort} title={t("Rank by recoverable ฿ (estimated)")} />
          <SortHead k="name" label={t("Site")} sort={sort} desc={desc} onSort={onSort} />
          <SortHead k="billed" label={t("Billed MWh")} sort={sort} desc={desc} onSort={onSort} className="text-right" title={t(BILLED_HINT)} />
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
            title={t("Contract − billed energy over the period (modelled contract); negative = above contract")}
          />
          {BILL_CAUSES.map((c) => (
            <TableHead key={c.key} className="text-right" title={`${t(c.hint)}. ${t(BILL_EST)}`}>
              <span className="mr-1 inline-block size-2 rounded-sm align-middle" style={{ background: c.color }} />
              {t(c.label)} <Tag kind="est" />
            </TableHead>
          ))}
          <SortHead
            k="unexplained"
            label={t("Not explained")}
            sort={sort}
            desc={desc}
            onSort={onSort}
            className="text-right"
            title={t("Shortfall − every cause (MWh): weather against the modelled contract, model error, or losses the criteria do not see. Negative = the causes add up to more than the shortfall")}
          />
          <SortHead
            k="recover"
            label={
              <>
                {t("Recoverable ฿")} <Tag kind="est" />
              </>
            }
            sort={sort}
            desc={desc}
            onSort={onSort}
            className="text-right"
            title={`${t("(Outage + under-performance + meter gap) × book price.")} ${t(BILL_EST)}`}
          />
          <TableHead title={t("The recoverable cause with the most energy, its owner and what to do (criteria file)")}>{t("Act on")}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((r) => (
          <TableRow key={r.site_id} className="cursor-pointer" onClick={() => onOpen(r.site_id)}>
            <TableCell className="num text-muted-foreground">{r.rank}</TableCell>
            <TableCell>
              <SiteCell name={r.name} siteId={r.site_id} region={r.region} />
              <div className="mt-1">
                <CauseBar r={r} max={max} />
              </div>
            </TableCell>
            <TableCell className="num text-right">{mwh(r.billed_kwh, 1)}</TableCell>
            <TableCell className={cn("num text-right", pctTone(r.vs_contract_pct, 100, 90))}>{r.vs_contract_pct == null ? "—" : `${fmt(r.vs_contract_pct, 1)} %`}</TableCell>
            <ShortCell r={r} />
            {BILL_CAUSES.map((c) => (
              <TableCell key={c.key} className={cn("num text-right", !causeKwh(r, c.key) && "text-muted-foreground")}>
                {mwh(causeKwh(r, c.key), 2)}
              </TableCell>
            ))}
            <TableCell className="num text-right text-muted-foreground">{mwh(r.unexplained_kwh, 2)}</TableCell>
            <TableCell className="num text-right font-medium">{fmtInt(r.recoverable_thb)}</TableCell>
            <TableCell className="min-w-[200px] max-w-[280px]">
              {r.action_cause ? (
                <span className="flex flex-col gap-1">
                  <span className="flex flex-wrap items-center gap-1">
                    <Badge variant={r.action_cause === "outage" ? "crit" : r.action_cause === "meter_gap" ? "info" : "warn"}>{t(CAUSE_LABEL[r.action_cause])}</Badge>
                    {r.owner && <span className="text-[11px] text-muted-foreground">{r.owner}</span>}
                  </span>
                  <span className="text-[11px] text-muted-foreground">{r.action}</span>
                </span>
              ) : r.top_cause === "curtailment" ? (
                <Badge variant="neutral" title={t("Only curtailment: a PM / contract matter")}>
                  {t("PM: curtailment")}
                </Badge>
              ) : (
                <span className="text-muted-foreground">—</span>
              )}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
};
