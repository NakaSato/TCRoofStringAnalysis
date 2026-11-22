/**
 * Energy & Billing → TFRS 16 lease model (admins): charts of the TFRS 16 model workbook imported with
 * `python -m app.services.tfrs16 import --model …` (`/tfrs16/summary`, `/tfrs16/schedule`).
 *
 * Every figure is the model's accounting, never measured, and every card says so with its badge.
 * Phases 3–4 rest on an assumed start date (dotted lines, "est." in the legend). Fiscal years are the
 * Thai fiscal year (1 Oct – 30 Sep, B.E.); the first and last of a phase are partial. Read once on
 * mount, never polled. Engineers get nothing (the routes are admin only).
 */
import React, { useEffect, useMemo, useState } from "react";
import { api } from "../../api/client";
import type { Tfrs16Remeasurement, Tfrs16Schedule, Tfrs16Summary } from "../../api/client";
import { isAdmin } from "../../auth/access";
import { useAppContext } from "../../context/AppContext";
import { PanelChart } from "../../components/PanelChart";
import type { ChartSeries, PanelChartSpec } from "../../components/PanelChart";
import { CATEGORICAL, SERIES } from "../../components/chartTheme";
import { SkeletonChart, fmt, fmtInt } from "../../components/ui";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { dateLocale, translate, useI18n } from "../../i18n";

const DAY_MS = 864e5;
const PHASE_COLOR: Record<number, string> = { 1: CATEGORICAL[0], 2: CATEGORICAL[1], 3: CATEGORICAL[2], 4: CATEGORICAL[3] };
const TOTAL_COLOR = CATEGORICAL[4];
const MODEL_BADGE = "Modelled (TFRS 16 model)";
const MODEL_HINT = "Accounting figures of the TFRS 16 model workbook, not measured";

const mthb = (v: number | null | undefined) => (v == null ? null : v / 1e6);
const fmtM = (v: number) => `${fmt(v, 1)} M฿`;
const fmtThbM = (v: number | null | undefined, nd = 1) => (v == null ? "—" : `${fmt(v / 1e6, nd)} M฿`);
const pct = (v: number | null | undefined, nd = 1) => (v == null ? "—" : `${fmt(100 * v, nd)} %`);
const monthMs = (m: string) => {
  const [y, mo] = m.split("-").map(Number);
  return +new Date(y, mo - 1, 1);
};
const fyLabel = (y: number) => translate("FY{n}", { n: y });
const monthName = (m: number) => new Date(2000, m - 1, 1).toLocaleDateString(dateLocale(), { month: "short" });
const phaseName = (p: number, estimated: boolean) =>
  estimated ? translate("Phase {n} (est.)", { n: p }) : translate("Phase {n}", { n: p });

/* -------------------------------------------------------------------------- */
/* Chart specs                                                                */
/* -------------------------------------------------------------------------- */

/** B1: closing lease liability per month, a line per phase plus the total of the phases started. */
const liabilitySpec = (s: Tfrs16Schedule): PanelChartSpec | null => {
  if (!s.total.length) return null;
  const months = s.total.map((t) => t.month);
  const idx = new Map(months.map((m, i) => [m, i]));
  const series: ChartSeries[] = s.phases.map((p) => {
    const y = months.map(() => null as number | null);
    for (const r of p.periods) y[idx.get(r.month)!] = mthb(r.closing_thb);
    return { key: `p${p.phase}`, name: phaseName(p.phase, p.estimated), type: "line", color: PHASE_COLOR[p.phase] ?? SERIES.secondary, y, width: 1.6, dash: p.estimated ? "dot" : undefined, format: fmtM };
  });
  series.push({ key: "total", name: translate("All phases"), type: "line", color: TOTAL_COLOR, y: s.total.map((t) => mthb(t.liability_thb)), width: 2.4, format: fmtM });
  return {
    xKind: "time",
    x: months.map(monthMs),
    xStep: 31 * DAY_MS,
    panels: [{ key: "liab", title: translate("Lease liability, end of month (M฿)"), yMin: 0, series }],
  };
};

/** B2 / B4: fiscal-year stacked bars of two parts (bottom, top). */
const fyStackSpec = (
  s: Tfrs16Schedule,
  title: string,
  parts: Array<{ key: "interest_thb" | "principal_thb" | "depreciation_thb"; name: string; color: string }>,
): PanelChartSpec | null => {
  const fy = s.fiscal_years;
  if (!fy.length) return null;
  const base = fy.map(() => 0);
  const series: ChartSeries[] = parts.map((p) => {
    const y0 = fy.map((_, i) => base[i]);
    const y = fy.map((r, i) => {
      const v = mthb(r[p.key]);
      return v == null ? null : (base[i] += v);
    });
    return { key: p.key, name: p.name, type: "bar", color: p.color, y, y0, noTip: true };
  });
  return {
    xKind: "band",
    x: fy.map((r) => r.fiscal_year),
    xTickLabel: (v) => String(v),
    xTipLabel: (v) => fyLabel(Number(v)),
    panels: [{ key: "fy", title, stacked: true, yMin: 0, series }],
    tipExtra: (i) => {
      const r = fy[i];
      const rows = parts.map((p) => ({ label: p.name, value: fmtThbM(r[p.key]) }));
      const sum = parts.reduce<number | null>((a, p) => (a == null || r[p.key] == null ? null : a + r[p.key]!), 0);
      rows.push({ label: translate("Total"), value: fmtThbM(sum) });
      if (r.partial) rows.push({ label: translate("Partial year"), value: Object.entries(r.months_by_phase).map(([p, n]) => translate("Phase {n}: {m} months", { n: p, m: n })).join(" · ") });
      return rows;
    },
  };
};

/** B3: right-of-use asset (net) against the lease liability, all phases summed. */
const rouSpec = (s: Tfrs16Schedule): PanelChartSpec | null => {
  if (!s.total.length) return null;
  return {
    xKind: "time",
    x: s.total.map((t) => monthMs(t.month)),
    xStep: 31 * DAY_MS,
    panels: [
      {
        key: "rou",
        title: translate("All phases, end of month (M฿)"),
        yMin: 0,
        series: [
          { key: "liab", name: translate("Lease liability"), type: "line", color: TOTAL_COLOR, y: s.total.map((t) => mthb(t.liability_thb)), width: 2.2, format: fmtM },
          { key: "rou", name: translate("Right-of-use asset (net)"), type: "line", color: CATEGORICAL[5], y: s.total.map((t) => mthb(t.rou_net_thb)), width: 2.2, format: fmtM },
        ],
      },
    ],
    tipExtra: (i) => {
      const t = s.total[i];
      const gap = t.liability_thb == null || t.rou_net_thb == null ? null : t.liability_thb - t.rou_net_thb;
      return [
        { label: translate("Liability − asset"), value: fmtThbM(gap, 2) },
        { label: translate("Phases started"), value: t.phases.join(", ") },
      ];
    },
  };
};

/** B5: the 20-year minimum fee per phase. */
const minFeeSpec = (s: Tfrs16Summary): PanelChartSpec | null => {
  const ph = s.phases.filter((p) => p.min_fee_thb != null);
  if (!ph.length) return null;
  return {
    xKind: "band",
    x: ph.map((p) => p.phase),
    xTickLabel: (v) => {
      const p = ph.find((x) => x.phase === Number(v));
      return phaseName(Number(v), p?.estimated ?? false);
    },
    panels: [
      {
        key: "fee",
        title: translate("Minimum fee over 20 years, ex VAT (M฿)"),
        yMin: 0,
        series: [
          {
            key: "fee",
            name: translate("Minimum fee"),
            type: "bar",
            color: CATEGORICAL[0],
            colors: ph.map((p) => PHASE_COLOR[p.phase] ?? SERIES.secondary),
            y: ph.map((p) => mthb(p.min_fee_thb)),
            labels: ph.map((p) => fmt(mthb(p.min_fee_thb), 0)),
            noLegend: true,
            format: fmtM,
          },
        ],
      },
    ],
    tipExtra: (i) => [
      { label: translate("Stations"), value: fmtInt(ph[i].stations) },
      { label: "kWp", value: fmt(ph[i].kwp, 0) },
      { label: translate("Share of all phases"), value: s.min_fee_total_thb ? pct(ph[i].min_fee_thb! / s.min_fee_total_thb) : "—" },
    ],
  };
};

/** B9: one phase's remeasurement as a bridge: book liability → remeasured → difference (floating). */
const bridgeSpec = (r: Tfrs16Remeasurement): PanelChartSpec | null => {
  if (r.book_liability_thb == null || r.new_liability_thb == null) return null;
  const book = mthb(r.book_liability_thb)!;
  const nw = mthb(r.new_liability_thb)!;
  const cats = [translate("Book liability"), translate("Remeasured"), translate("Difference")];
  return {
    xKind: "band",
    x: cats,
    panels: [
      {
        key: "b",
        title: translate("Lease liability (M฿)"),
        yMin: 0,
        series: [
          {
            key: "b",
            name: translate("Lease liability"),
            type: "bar",
            color: TOTAL_COLOR,
            colors: [TOTAL_COLOR, CATEGORICAL[5], CATEGORICAL[3]],
            y: [book, nw, Math.max(book, nw)],
            y0: [0, 0, Math.min(book, nw)],
            labels: [fmt(book, 1), fmt(nw, 1), fmt(book - nw, 1)],
            noLegend: true,
            noTip: true,
          },
        ],
      },
    ],
    tipExtra: (i) => [{ label: cats[i], value: fmtThbM(i === 0 ? r.book_liability_thb : i === 1 ? r.new_liability_thb : r.difference_thb, 2) }],
  };
};

/** B10: modelled revenue per calendar month of contract year 1, a line per phase (October first). */
const seasonSpec = (s: Tfrs16Summary): PanelChartSpec | null => {
  const rv = s.revenue;
  if (!rv.phases.length || rv.months.length !== 12) return null;
  const est = new Map(s.phases.map((p) => [p.phase, p.estimated]));
  return {
    xKind: "band",
    x: rv.months,
    xTickLabel: (v) => monthName(Number(v)),
    panels: [
      {
        key: "rev",
        title: translate("Revenue in contract year 1 (M฿ per month)"),
        yMin: 0,
        series: rv.phases.map((p) => ({
          key: `p${p.phase}`,
          name: phaseName(p.phase, est.get(p.phase) ?? false),
          type: "line" as const,
          color: PHASE_COLOR[p.phase] ?? SERIES.secondary,
          dash: est.get(p.phase) ? ("dot" as const) : undefined,
          width: 2,
          y: p.revenue_thb.map((v) => mthb(v)),
          format: (v: number) => `${fmt(v, 2)} M฿`,
        })),
      },
    ],
  };
};

/** B11: phase 3–4 rollout funnel: stations → fee paid → interconnected → First Sync, a segment per phase. */
const funnelSpec = (s: Tfrs16Summary): PanelChartSpec | null => {
  const ro = s.rollout;
  if (!ro.total.stations) return null;
  const stages = [
    { key: "stations", label: translate("Stations") },
    { key: "fee_paid", label: translate("Interconnection fee paid") },
    { key: "interconnected", label: translate("Interconnected") },
    { key: "first_sync", label: translate("First Sync") },
  ] as const;
  const base = stages.map(() => 0);
  const series: ChartSeries[] = ro.phases.map((p) => {
    const y0 = stages.map((_, i) => base[i]);
    const y = stages.map((st, i) => (base[i] += p[st.key]));
    return { key: `p${p.phase}`, name: translate("Phase {n}", { n: p.phase }), type: "bar", color: PHASE_COLOR[p.phase] ?? SERIES.secondary, y, y0, noTip: true };
  });
  // the stage totals, written above the top segment
  if (series.length) series[series.length - 1].labels = stages.map((st) => String(ro.total[st.key]));
  return {
    xKind: "band",
    x: stages.map((st) => st.label),
    panels: [{ key: "f", title: translate("Stations"), stacked: true, yMin: 0, series }],
    tipExtra: (i) => [
      ...ro.phases.map((p) => ({ label: translate("Phase {n}", { n: p.phase }), value: String(p[stages[i].key]) })),
      { label: translate("Total"), value: String(ro.total[stages[i].key]) },
      ...(i > 0 ? [{ label: translate("Of all stations"), value: pct(ro.total[stages[i].key] / ro.total.stations, 0) }] : []),
    ],
  };
};

/* -------------------------------------------------------------------------- */
/* Component                                                                  */
/* -------------------------------------------------------------------------- */

const LeaseCard: React.FC<{ title: string; badge?: string; empty: string | null; note: React.ReactNode; className?: string; children?: React.ReactNode }> = ({
  title,
  badge = MODEL_BADGE,
  empty,
  note,
  className,
  children,
}) => {
  const { t } = useI18n();
  return (
    <Card className={className}>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2">
          {t(title)}
          <span className="text-[11px] font-normal text-muted-foreground">{t("TFRS 16 model")}</span>
          <Badge variant="neutral" title={badge === MODEL_BADGE ? t(MODEL_HINT) : undefined}>
            {t(badge)}
          </Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {empty ? (
          <Empty className="py-10">
            <EmptyHeader>
              <EmptyTitle>{t(empty)}</EmptyTitle>
            </EmptyHeader>
          </Empty>
        ) : (
          <>
            {children}
            <p className="text-xs text-muted-foreground">{note}</p>
          </>
        )}
      </CardContent>
    </Card>
  );
};

export const LeaseCharts: React.FC = () => {
  const { t, locale } = useI18n();
  const { user } = useAppContext();
  const admin = isAdmin(user);
  const [summary, setSummary] = useState<Tfrs16Summary | null>(null);
  const [sched, setSched] = useState<Tfrs16Schedule | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!admin) return;
    let live = true;
    Promise.all([api.getTfrs16Summary(), api.getTfrs16Schedule()])
      .then(([a, b]) => {
        if (!live) return;
        setSummary(a);
        setSched(b);
      })
      .catch((e: unknown) => live && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      live = false;
    };
  }, [admin]);

  const specs = useMemo(() => {
    if (!summary || !sched) return null;
    return {
      liability: liabilitySpec(sched),
      split: fyStackSpec(sched, translate("Lease payments by fiscal year (M฿)"), [
        { key: "interest_thb", name: translate("Interest"), color: CATEGORICAL[3] },
        { key: "principal_thb", name: translate("Principal"), color: CATEGORICAL[0] },
      ]),
      rou: rouSpec(sched),
      expense: fyStackSpec(sched, translate("Expense by fiscal year (M฿)"), [
        { key: "depreciation_thb", name: translate("Depreciation"), color: CATEGORICAL[2] },
        { key: "interest_thb", name: translate("Interest"), color: CATEGORICAL[3] },
      ]),
      minFee: minFeeSpec(summary),
      season: seasonSpec(summary),
      funnel: funnelSpec(summary),
      bridges: summary.remeasurements.map((r) => ({ r, spec: bridgeSpec(r) })),
    };
  }, [summary, sched]);

  if (!admin) return null;
  if (error)
    return (
      <Empty className="py-10">
        <EmptyHeader>
          <EmptyTitle>{t("The TFRS 16 model could not be read")}</EmptyTitle>
          <EmptyDescription>{error}</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  if (!summary || !sched || !specs) return <SkeletonChart />;
  if (!summary.imported)
    return (
      <Empty className="py-10">
        <EmptyHeader>
          <EmptyTitle>{t("No TFRS 16 model imported")}</EmptyTitle>
          <EmptyDescription>
            {t("An admin imports the model workbook with")} <code>python -m app.services.tfrs16 import --model …</code>
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );

  const none = "Not in the imported model";
  const est = summary.phases.filter((p) => p.estimated).map((p) => p.phase);
  const estNote = est.length ? t("Dotted = estimated phases ({list}): start date assumed.", { list: est.join(", ") }) : "";
  const imported = summary.imported_at ? new Date(summary.imported_at).toLocaleString(locale, { dateStyle: "medium", timeStyle: "short" }) : "—";

  return (
    <div className="flex flex-col gap-4">
      <p className="text-xs text-muted-foreground">
        {t("Source: {file} · imported {when}", { file: summary.source ?? "—", when: imported })}
        {summary.warnings.length > 0 && <span className="text-amber-400"> · {t("{n} check warnings in the import", { n: summary.warnings.length })}</span>}
      </p>
      <div className="grid gap-4 xl:grid-cols-2">
        <LeaseCard
          title="Lease liability run-off"
          empty={specs.liability ? null : none}
          note={`${t("Liability at the end of each month per phase; All phases = the sum of the phases whose lease has started.")} ${estNote}`}
        >
          <PanelChart spec={specs.liability} height={330} legendToggle />
        </LeaseCard>
        <LeaseCard
          title="Right-of-use asset vs lease liability"
          empty={specs.rou ? null : none}
          note={t("All phases summed. The asset is depreciated on a straight line over the contract, while the liability falls with each payment net of interest, so the two lines part in the middle years and meet at zero at the end.")}
        >
          <PanelChart spec={specs.rou} height={330} />
        </LeaseCard>
        <LeaseCard
          title="Interest vs principal by fiscal year"
          empty={specs.split ? null : none}
          note={t("Each bar = the minimum-fee payments of a Thai fiscal year (1 Oct – 30 Sep), split into interest and repayment of the liability (principal = payment − interest). The first and last years are partial.")}
        >
          <PanelChart spec={specs.split} height={330} />
        </LeaseCard>
        <LeaseCard
          title="Depreciation and interest expense by fiscal year"
          empty={specs.expense ? null : none}
          note={t("Expense in the income statement = depreciation of the right-of-use asset + interest on the liability, before remeasurements. The first and last years are partial.")}
        >
          <PanelChart spec={specs.expense} height={330} />
        </LeaseCard>
        <LeaseCard
          title="Minimum fee over 20 years by phase"
          badge="Contract minimum (model)"
          empty={specs.minFee ? null : none}
          note={t("Minimum energy-management fee, ex VAT. All phases: {total}; project budget in the contract: {budget}. Phases 3–4 split the remaining budget by kWp.", {
            total: fmtThbM(summary.min_fee_total_thb),
            budget: fmtThbM(summary.project_budget_thb),
          })}
        >
          <PanelChart spec={specs.minFee} height={300} />
        </LeaseCard>
        <LeaseCard
          title="Seasonal revenue profile, contract year 1"
          empty={specs.season ? null : none}
          note={t("Modelled revenue per month of each phase's first contract year, in contract-year order (October first); the phases start on different dates, so the months are not the same calendar year. Case: {case} · {price} ฿/kWh.", {
            case: summary.revenue.case ?? "—",
            price: fmt(summary.revenue.price_thb_kwh, 2),
          })}
        >
          <PanelChart spec={specs.season} height={300} legendToggle />
        </LeaseCard>
        <LeaseCard
          title="Lease liability remeasurement"
          empty={specs.bridges.length ? null : none}
          note={t("At a fiscal year end the liability is measured again at the expected production share, with the original discount rate. The difference goes to account 6279030 only when it exceeds the threshold.")}
        >
          <div className="grid gap-4 md:grid-cols-2">
            {specs.bridges.map(({ r, spec }) => (
              <div key={r.phase} className="flex flex-col gap-2">
                <div className="flex flex-wrap items-center gap-2 text-xs">
                  <span className="font-medium">{t("Phase {n}", { n: r.phase })}</span>
                  <span className="text-muted-foreground">{r.assessed_on ? new Date(r.assessed_on).toLocaleDateString(locale, { dateStyle: "medium" }) : "—"}</span>
                  {r.decision && <Badge variant="neutral">{r.decision}</Badge>}
                </div>
                <PanelChart spec={spec} height={240} />
                <p className="text-[11px] text-muted-foreground">
                  {t("Production share {share} · difference {diff} of the book liability (threshold {thr}) · account {acc}", {
                    share: pct(r.production_share),
                    diff: pct(r.difference_share),
                    thr: pct(r.threshold_share, 0),
                    acc: r.account ?? "—",
                  })}
                </p>
              </div>
            ))}
          </div>
        </LeaseCard>
        <LeaseCard
          title="Phase 3–4 rollout"
          badge="Status list (workbook)"
          empty={specs.funnel ? null : none}
          note={`${t("Stations of phases 3–4 by stage, from the status list in the model workbook: interconnection fee paid, interconnected with PEA, First Sync date given.")} ${summary.rollout.note ?? ""}`}
        >
          <PanelChart spec={specs.funnel} height={300} />
        </LeaseCard>
      </div>
    </div>
  );
};
