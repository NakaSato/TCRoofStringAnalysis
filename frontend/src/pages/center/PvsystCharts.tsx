/**
 * PVsyst design charts (Energy & Billing), from `/pvsyst/design` and `/pvsyst/vs-meter`
 * (backend services/pvsyst.py, imported from the TFRS 16 model workbook's PVsyst sheets).
 *
 * Every figure here is **modelled** (PVsyst simulation reports, P50, unlimited load), so every card
 * carries the "Modelled (PVsyst design)" badge; DC/AC and monthly kWh/kWp are derived from them. The
 * one measured value is the PWA report meter in "Metered vs PVsyst". Engineers get only the stations
 * of their plants' report sites and no phase summaries (the backend leaves them out), so phase
 * figures are then built from the visible stations and say so.
 *
 * - Monthly E_Grid by phase (MWh, and kWh/kWp with one thin line per station when a phase is chosen)
 * - PR by phase (P25–P75 box, median, weighted PR, every station as a dot)
 * - Contract vs PVsyst specific yield per phase (kWh/kWp/yr) and their ratio
 * - Orientation: azimuth vs specific yield (single-orientation stations only)
 * - DC/AC ratio vs PR
 * - Metered vs PVsyst per site and month (D1)
 */
import React, { useEffect, useMemo, useState } from "react";
import * as d3 from "d3";
import { api } from "../../api/client";
import type { PvsystDesign, PvsystPhase, PvsystStation, PvsystVsMeter } from "../../api/client";
import { PanelChart } from "../../components/PanelChart";
import type { ChartSeries, PanelChartSpec } from "../../components/PanelChart";
import { CATEGORICAL, SERIES } from "../../components/chartTheme";
import { SkeletonChart, fmt, fmtInt } from "../../components/ui";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { dateLocale, translate, useI18n } from "../../i18n";
import { PHASE_COLOR } from "./chartSpecs";

const PH_COLOR: Record<number, string> = { ...PHASE_COLOR, 3: PHASE_COLOR[3] ?? CATEGORICAL[2], 4: PHASE_COLOR[4] ?? CATEGORICAL[3] };
const phaseColor = (p: number) => PH_COLOR[p] ?? SERIES.secondary;
const phaseName = (p: number) => translate("Phase {n}", { n: p });
const sum = (v: number[]) => v.reduce((a, b) => a + b, 0);

/* -------------------------------------------------------------------------- */
/* Spec builders                                                               */
/* -------------------------------------------------------------------------- */

/** Jan..Dec per phase: the stations' E_Grid summed (null for a month any station lacks) and as kWh/kWp;
 * with one phase chosen, each station's kWh/kWp as a thin line (no tooltip row). */
export const monthlySpec = (stations: PvsystStation[], phase: number | null): PanelChartSpec | null => {
  if (!stations.length) return null;
  const phases = [...new Set(stations.map((s) => s.phase))].sort();
  const locale = dateLocale();
  const x = d3.range(12).map((k) => new Date(2026, k, 1).toLocaleDateString(locale, { month: "short" }));
  const mwh: ChartSeries[] = [];
  const spec: ChartSeries[] = [];
  for (const ph of phases) {
    const st = stations.filter((s) => s.phase === ph);
    const tot = d3.range(12).map((k) => (st.every((s) => s.mwh_month[k] != null) ? sum(st.map((s) => s.mwh_month[k]!)) : null));
    const kwp = sum(st.map((s) => s.kwp ?? 0));
    const color = phaseColor(ph);
    const name = `${phaseName(ph)} (${translate("modelled")})`;
    mwh.push({ key: `m${ph}`, name, type: "line", color, y: tot, width: 2, format: (v) => `${fmt(v, 1)} MWh` });
    spec.push({ key: `k${ph}`, name, type: "line", color, y: tot.map((v) => (v != null && kwp ? (v * 1000) / kwp : null)), width: 2.4, noLegend: true, format: (v) => `${fmt(v, 1)} kWh/kWp` });
  }
  if (phase != null)
    for (const s of stations)
      spec.push({ key: `s${s.phase}-${s.seq}`, name: s.name, type: "line", color: phaseColor(s.phase), y: s.kwh_kwp_month, width: 1, opacity: 0.22, noLegend: true, noTip: true });
  return {
    xKind: "band",
    x,
    panels: [
      { key: "mwh", title: translate("E_Grid (MWh, modelled)"), series: mwh },
      { key: "kwp", title: translate("Specific yield (kWh/kWp, modelled)"), series: spec, zero: false },
    ],
  };
};

const quant = (v: number[]) => {
  const s = [...v].sort((a, b) => a - b);
  return { q1: d3.quantileSorted(s, 0.25)!, median: d3.quantileSorted(s, 0.5)!, q3: d3.quantileSorted(s, 0.75)!, min: s[0], max: s[s.length - 1] };
};
const kwpWeightedPr = (st: PvsystStation[]): number | null => {
  const pts = st.filter((s) => s.pr != null && s.kwp);
  const w = sum(pts.map((s) => s.kwp!));
  return w ? sum(pts.map((s) => s.pr! * s.kwp!)) / w : null;
};

/** One category per phase: the stations' PR as a P25–P75 bar, the median and the weighted PR
 * (the sheet's when the user may see it, else kWp-weighted over the visible stations), every station a dot. */
export const prSpec = (stations: PvsystStation[], phases: PvsystPhase[]): PanelChartSpec | null => {
  const ph = [...new Set(stations.filter((s) => s.pr != null).map((s) => s.phase))].sort();
  if (!ph.length) return null;
  const box = ph.map((p) => quant(stations.filter((s) => s.phase === p && s.pr != null).map((s) => s.pr! * 100)));
  const sheet = new Map(phases.map((p) => [p.phase, p.pr_weighted]));
  const weighted = ph.map((p) => {
    const v = sheet.get(p) ?? kwpWeightedPr(stations.filter((s) => s.phase === p));
    return v == null ? null : v * 100;
  });
  const pct = (v: number) => `${fmt(v, 1)} %`;
  const dots = stations.filter((s) => s.pr != null);
  return {
    xKind: "band",
    x: ph,
    xTickLabel: (v) => phaseName(Number(v)),
    xTipLabel: (v) => phaseName(Number(v)),
    panels: [
      {
        key: "pr",
        title: translate("PR (%, modelled)"),
        zero: false,
        // a bar panel would start at 0 and flatten the boxes; start just under the lowest station
        yMin: Math.floor(Math.min(...box.map((b) => b.min)) - 1),
        series: [
          { key: "box", name: translate("Middle half (P25–P75)"), type: "bar", color: SERIES.reference, colors: ph.map(phaseColor), y: box.map((b) => b.q3), y0: box.map((b) => b.q1), opacity: 0.35, format: (v) => pct(v) },
          { key: "lo", name: translate("Lowest station"), type: "points", color: SERIES.reference, y: box.map((b) => b.min), size: 4, noLegend: true, format: pct },
          { key: "med", name: translate("Median"), type: "points", color: "#e2e8f0", y: box.map((b) => b.median), symbol: "ring", size: 10, format: pct },
          { key: "w", name: phases.length ? translate("Weighted PR (PVsyst_สรุป)") : translate("Weighted PR (kWp, visible stations)"), type: "points", color: CATEGORICAL[4], y: weighted, symbol: "diamond", size: 9, format: (v) => `${fmt(v, 2)} %` },
          { key: "hi", name: translate("Highest station"), type: "points", color: SERIES.reference, y: box.map((b) => b.max), size: 4, noLegend: true, format: pct },
          { key: "st", name: translate("Station"), type: "points", color: SERIES.reference, x: dots.map((s) => s.phase), y: dots.map((s) => s.pr! * 100), colors: dots.map((s) => phaseColor(s.phase)), size: 4, opacity: 0.45, noTip: true, noLegend: true },
        ],
      },
    ],
    tipExtra: (i) => [{ label: translate("Stations"), value: fmtInt(stations.filter((s) => s.phase === ph[i] && s.pr != null).length) }],
  };
};

interface YieldRow {
  phase: number;
  pvsyst: number | null;
  contract: number | null;
  ratio: number | null;
  sheetRatio: number | null;
  n: number;
}
/** Per phase PVsyst vs first-year contract kWh/kWp/yr: the sheet's figures for admins, else summed over
 * the visible stations (contract on the model's kWp, PVsyst on the report's). */
export const yieldRows = (stations: PvsystStation[], phases: PvsystPhase[]): YieldRow[] => {
  if (phases.length)
    return phases.map((p) => ({ phase: p.phase, pvsyst: p.specific_yield, contract: p.contract_specific_yield, ratio: p.contract_over_pvsyst_per_kwp, sheetRatio: p.contract_over_pvsyst, n: p.station_rows }));
  return [...new Set(stations.map((s) => s.phase))].sort().map((ph) => {
    const st = stations.filter((s) => s.phase === ph);
    const pk = sum(st.filter((s) => s.mwh_year != null && s.kwp).map((s) => s.kwp!));
    const pv = pk ? (sum(st.filter((s) => s.mwh_year != null && s.kwp).map((s) => s.mwh_year!)) * 1000) / pk : null;
    const cs = st.filter((s) => s.contract_kwh_y1 != null && (s.kwp_model ?? s.kwp));
    const ck = sum(cs.map((s) => (s.kwp_model ?? s.kwp)!));
    const con = ck ? sum(cs.map((s) => s.contract_kwh_y1!)) / ck : null;
    return { phase: ph, pvsyst: pv, contract: con, ratio: pv && con ? con / pv : null, sheetRatio: null, n: st.length };
  });
};

export const yieldSpec = (rows: YieldRow[]): PanelChartSpec | null => {
  if (!rows.length) return null;
  const yr = (v: number) => `${fmtInt(v)} kWh/kWp/${translate("yr")}`;
  return {
    xKind: "band",
    x: rows.map((r) => r.phase),
    xTickLabel: (v) => phaseName(Number(v)),
    xTipLabel: (v) => phaseName(Number(v)),
    panels: [
      {
        key: "y",
        title: translate("Specific yield (kWh/kWp/yr, modelled)"),
        weight: 1.6,
        series: [
          { key: "pv", name: translate("PVsyst P50"), type: "bar", color: SERIES.secondary, y: rows.map((r) => r.pvsyst), format: yr },
          { key: "con", name: translate("Contract, first year"), type: "bar", color: SERIES.reference, y: rows.map((r) => r.contract), format: yr },
        ],
      },
      {
        key: "r",
        title: translate("Contract ÷ PVsyst per kWp (%)"),
        zero: false,
        refLines: [{ y: 100, label: "100 %" }],
        series: [
          { key: "ratio", name: translate("Contract ÷ PVsyst per kWp"), type: "points", color: CATEGORICAL[4], symbol: "diamond", size: 10, y: rows.map((r) => (r.ratio == null ? null : r.ratio * 100)), noLegend: true, format: (v) => `${fmt(v, 1)} %` },
        ],
      },
    ],
    tipExtra: (i) => {
      const r = rows[i];
      return [
        ...(r.sheetRatio != null ? [{ label: translate("Sheet's contract ÷ PVsyst (kWh ÷ kWh)"), value: `${fmt(r.sheetRatio * 100, 1)} %` }] : []),
        { label: translate("Stations"), value: fmtInt(r.n) },
      ];
    },
  };
};

/** Points per phase on a numeric x, each with the station's name in the tooltip. */
const scatter = (stations: PvsystStation[], xOf: (s: PvsystStation) => number | null, yOf: (s: PvsystStation) => number | null, note: (s: PvsystStation) => string, fmtY: (v: number) => string): ChartSeries[] =>
  [...new Set(stations.map((s) => s.phase))].sort().flatMap((ph) => {
    const st = stations.filter((s) => s.phase === ph && xOf(s) != null && yOf(s) != null);
    if (!st.length) return [];
    return [{ key: `p${ph}`, name: phaseName(ph), type: "points" as const, color: phaseColor(ph), x: st.map((s) => xOf(s)!), y: st.map((s) => yOf(s)), size: 6, opacity: 0.85, tipNotes: st.map(note), format: fmtY }];
  });

export const orientationSpec = (stations: PvsystStation[]): PanelChartSpec | null => {
  const series = scatter(stations, (s) => s.azimuth_deg, (s) => s.specific_yield, (s) => `${s.name} · ${fmt(s.tilt_deg, 0)}° / ${fmt(s.azimuth_deg, 0)}°`, (v) => `${fmtInt(v)} kWh/kWp`);
  if (!series.length) return null;
  return {
    xKind: "linear",
    x: [],
    xDomain: [-180, 180],
    xLabel: translate("Azimuth (°, PVsyst: 0 = south, −90 = east, 90 = west)"),
    xTipNumber: (v) => `${translate("Azimuth")} ${fmt(v, 0)}°`,
    panels: [{ key: "y", title: translate("Specific yield (kWh/kWp/yr, modelled)"), series, zero: false }],
  };
};

export const dcAcSpec = (stations: PvsystStation[]): PanelChartSpec | null => {
  const series = scatter(stations, (s) => s.dc_ac_ratio, (s) => (s.pr == null ? null : s.pr * 100), (s) => `${s.name} · DC/AC ${fmt(s.dc_ac_ratio, 2)} (${fmtInt(s.kwp)} kWp / ${fmtInt(s.kwac)} kWac)`, (v) => `PR ${fmt(v, 1)} %`);
  if (!series.length) return null;
  return {
    xKind: "linear",
    x: [],
    xLabel: translate("DC/AC ratio (kWp ÷ kWac, derived)"),
    xTipNumber: (v) => `DC/AC ${fmt(v, 2)}`,
    panels: [{ key: "pr", title: translate("PR (%, modelled)"), series, zero: false }],
  };
};

/** D1: one point per site and month, PVsyst (modelled) across, metered up; the 1 : 1 line dashed. */
export const vsMeterSpec = (d: PvsystVsMeter, phase: number | null): PanelChartSpec | null => {
  const sites = d.sites.filter((s) => phase == null || s.phase === phase);
  const series: ChartSeries[] = [];
  let hi = 0;
  for (const ph of [...new Set(sites.map((s) => s.phase))].sort()) {
    const pts = sites.filter((s) => s.phase === ph).flatMap((s) => s.months.filter((m) => m.pvsyst_kwh != null).map((m) => ({ s, m })));
    if (!pts.length) continue;
    pts.forEach(({ m }) => (hi = Math.max(hi, m.pvsyst_kwh! / 1000, m.meter_kwh / 1000)));
    series.push({
      key: `p${ph}`,
      name: phaseName(ph),
      type: "points",
      color: phaseColor(ph),
      x: pts.map(({ m }) => m.pvsyst_kwh! / 1000),
      y: pts.map(({ m }) => m.meter_kwh / 1000),
      size: 6,
      tipNotes: pts.map(({ s, m }) => `${s.name} · ${m.month} · ${translate("{n} days", { n: m.days_read })} · ${translate("PVsyst")} ${fmt(m.pvsyst_kwh! / 1000, 2)} MWh${m.meter_over_pvsyst != null ? ` · ${fmt(m.meter_over_pvsyst * 100, 1)} %` : ""}`),
      format: (v) => `${fmt(v, 2)} MWh`,
    });
  }
  if (!series.length) return null;
  series.push({ key: "one", name: translate("Meter = PVsyst"), type: "line", color: SERIES.reference, dash: "dash", width: 1.2, x: [0, hi], y: [0, hi], noTip: true });
  return {
    xKind: "linear",
    x: [],
    xZero: true,
    xLabel: translate("PVsyst E_Grid on the days read (MWh, modelled)"),
    xTipNumber: (v) => `${translate("PVsyst")} ${fmt(v, 2)} MWh`,
    panels: [{ key: "m", title: translate("Metered (MWh, measured)"), series }],
  };
};

/* -------------------------------------------------------------------------- */
/* Component                                                                   */
/* -------------------------------------------------------------------------- */

const PvCard: React.FC<{ title: string; empty: string | null; note?: React.ReactNode; measured?: boolean; children: React.ReactNode }> = ({ title, empty, note, measured, children }) => {
  const { t } = useI18n();
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2">
          {title}
          <span className="text-[11px] font-normal text-muted-foreground">{t("PVsyst simulation reports")}</span>
          <Badge variant="neutral" title={t("PVsyst design figures (P50, unlimited load), not measured")}>
            {t("Modelled (PVsyst design)")}
          </Badge>
          {measured && <Badge variant="info">{t("Meter measured")}</Badge>}
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {empty ? (
          <Empty className="py-10">
            <EmptyHeader>
              <EmptyTitle>{empty}</EmptyTitle>
            </EmptyHeader>
          </Empty>
        ) : (
          <>
            {children}
            {note && <p className="text-xs text-muted-foreground">{note}</p>}
          </>
        )}
      </CardContent>
    </Card>
  );
};

export const PvsystCharts: React.FC<{ phase: number | null; start?: string | null; end?: string | null }> = ({ phase, start = null, end = null }) => {
  const { t } = useI18n();
  const [design, setDesign] = useState<PvsystDesign | null>(null);
  const [meter, setMeter] = useState<PvsystVsMeter | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    api
      .getPvsystDesign()
      .then((d) => live && setDesign(d))
      .catch((e: unknown) => live && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      live = false;
    };
  }, []);
  useEffect(() => {
    let live = true;
    api
      .getPvsystVsMeter({ start, end })
      .then((d) => live && setMeter(d))
      .catch(() => live && setMeter(null));
    return () => {
      live = false;
    };
  }, [start, end]);

  const stations = useMemo(() => (design?.stations ?? []).filter((s) => phase == null || s.phase === phase), [design, phase]);
  const phases = useMemo(() => (design?.phases ?? []).filter((p) => phase == null || p.phase === phase), [design, phase]);
  const monthly = useMemo(() => monthlySpec(stations, phase), [stations, phase]);
  const pr = useMemo(() => prSpec(stations, phases), [stations, phases]);
  const yRows = useMemo(() => yieldRows(stations, phases), [stations, phases]);
  const yields = useMemo(() => yieldSpec(yRows), [yRows]);
  const orient = useMemo(() => orientationSpec(stations), [stations]);
  const dcac = useMemo(() => dcAcSpec(stations), [stations]);
  const vs = useMemo(() => (meter ? vsMeterSpec(meter, phase) : null), [meter, phase]);

  if (error)
    return (
      <Empty className="py-10">
        <EmptyHeader>
          <EmptyTitle>{t("PVsyst design data could not be read")}</EmptyTitle>
          <EmptyDescription>{error}</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  if (!design) return <SkeletonChart />;
  if (!design.stations.length)
    return (
      <Empty className="py-10">
        <EmptyHeader>
          <EmptyTitle>{t("No PVsyst design data")}</EmptyTitle>
          <EmptyDescription>{design.meta.scope === "assigned" ? t("None of your plants is a PVsyst station of the model.") : t("Not imported yet (python -m app.services.pvsyst import --model …).")}</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );

  const noStations = stations.length ? null : t("No PVsyst stations in this phase.");
  const single = stations.filter((s) => s.azimuth_deg != null).length;
  const several = stations.filter((s) => s.orientations && s.orientations.length > 1).length;
  const unread = stations.filter((s) => s.orientations == null).length;
  const scope = design.meta.scope === "assigned" ? t("Your plants' stations only.") : null;
  const p1 = yRows.find((r) => r.phase === 1);
  const vsSites = meter ? meter.sites.filter((s) => phase == null || s.phase === phase) : [];

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <PvCard title={t("Monthly E_Grid by phase")} empty={noStations || (monthly ? null : t("No monthly E_Grid in the model."))}
        note={<>{t("E_Grid per calendar month from each station's PVsyst report, summed per phase; below as kWh/kWp.")} {phase != null ? t("Thin lines: one per station.") : t("Choose a phase to see each station.")} {scope}</>}>
        <PanelChart spec={monthly} height={360} legendToggle />
      </PvCard>

      <PvCard title={t("PR by phase")} empty={noStations || (pr ? null : t("No PR in the model."))}
        note={<>{t("Each station's PVsyst PR: box = middle half, ring = median, dots = stations, diamond = weighted PR.")} {phases.length ? t("Weighted PR as the PVsyst_สรุป sheet states it.") : t("Weighted by kWp over the stations you can see.")}</>}>
        <PanelChart spec={pr} height={320} />
      </PvCard>

      <PvCard title={t("Contract vs PVsyst specific yield")} empty={noStations || (yields ? null : t("No contract figures in the model."))}
        note={<>
          {t("First-year contract kWh/kWp (on the model's kWp) against PVsyst P50 kWh/kWp (on the reports' kWp). Phase 1's contract comes from the contract sheet; phases 2–4 are the model's estimate.")}{" "}
          {p1?.sheetRatio != null && p1.ratio != null && Math.abs(p1.sheetRatio - p1.ratio) > 0.005
            ? t("Phase 1: the sheet's kWh ÷ kWh is {a} %, but its PVsyst reports cover {p} kWp against the contract's {c} kWp, so per kWp it is {b} %.", {
                a: fmt(p1.sheetRatio * 100, 1),
                b: fmt(p1.ratio * 100, 1),
                p: fmtInt(phases.find((x) => x.phase === 1)?.kwp_pvsyst ?? null),
                c: fmtInt(phases.find((x) => x.phase === 1)?.kwp_model ?? null),
              })
            : null}
        </>}>
        <PanelChart spec={yields} height={340} />
      </PvCard>

      <PvCard title={t("Orientation and specific yield")} empty={noStations || (orient ? null : t("No station with a single orientation."))}
        note={t("{n} stations with one orientation; {m} with several and {u} whose Tilt/Azimuth text did not read are left out.", { n: single, m: several, u: unread })}>
        <PanelChart spec={orient} height={320} legendToggle />
      </PvCard>

      <PvCard title={t("DC/AC ratio and PR")} empty={noStations || (dcac ? null : t("No kWac in the model."))}
        note={t("DC/AC = the report's kWp ÷ kWac (derived); PR from the same report.")}>
        <PanelChart spec={dcac} height={320} legendToggle />
      </PvCard>

      <PvCard title={t("Metered vs PVsyst by site and month")} measured
        empty={!meter ? t("Meter comparison not loaded.") : vs ? null : t("No report day with a meter reading for a matched site in this period.")}
        note={meter && (
          <>
            {t("Each point is a site-month: the meter's kWh on the days read against PVsyst E_Grid on the same days (the month ÷ its days, × site kWp ÷ PVsyst kWp).")}{" "}
            {t("{m} sites matched by report id, {u} not matched (left out), {w} without a reading in the period; {n} site-months shown.", {
              m: meter.matched,
              u: meter.unmatched,
              w: meter.sites_without_readings,
              n: vsSites.reduce((a, s) => a + s.months.filter((m) => m.pvsyst_kwh != null).length, 0),
            })}
          </>
        )}>
        <PanelChart spec={vs} height={320} legendToggle />
      </PvCard>
    </div>
  );
};
