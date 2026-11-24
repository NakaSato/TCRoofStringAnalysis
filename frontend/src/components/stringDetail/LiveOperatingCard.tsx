/**
 * Live operating points (String Diagnostics, top): each string's newest live record (V, I, measured)
 * on the string curve modelled at the weather sensor's live irradiance and module temperature
 * (`api.getLiveStringOperating`, memory only, polled on `refresh_in_s`). The curve exists only for
 * strings whose module count is on String Layout; the rest are listed with their peer ratio only.
 * Gated points are drawn hollow and say why; stale records are never shown as now.
 *
 * Layout: header (freshness) → conditions strip (G, T_mod, modelled MPP, module) → verdict chips
 * (filter the list) → chart (near the operating points by default, or the full curve) beside the
 * selected string → compact list.
 */
import React, { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Activity, ArrowUpRight } from "lucide-react";
import { api } from "../../api/client";
import type { GrowattLive, LiveStringOperating, OperatingGate, StringOperatingPoint } from "../../api/client";
import { useLivePoll } from "../../context/useLivePoll";
import { usePlantHref } from "../../context/AppContext";
import { PanelChart } from "../PanelChart";
import type { ChartSeries, PanelChartSpec } from "../PanelChart";
import { CATEGORICAL, SERIES, STATUS } from "../chartTheme";
import { EmptyState, LoadingState, fmt } from "../ui";
import { TablePager, pageBounds } from "../TablePager";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { translate as tr, useI18n } from "../../i18n";

const PAGE = 10;
/** healthy operating points: muted, so the flagged and the selected string stand out */
const MUTED = "#94a3b8";
/** display bands of current vs the modelled Imp (a reading aid, not a rule) */
const LOW = 0.9;
const HIGH = 1.1;

const GATE_TEXT: Record<OperatingGate, string> = {
  no_reading: "No reading in the record",
  stale: "Record older than the stale limit: not now",
  not_producing: "Inverter not in normal production",
  clipped_or_limited: "Inverter at its power limit or clipping: the point is off the maximum power point",
  no_model: "No modelled curve for this string",
  weather_not_aligned: "Sensor and inverter records too far apart in time",
  low_irradiance: "Irradiance below the diagnostic minimum",
  out_of_range: "Reading outside the model's range (Isc / Voc): check the reading or the module data",
  off_mpp: "Voltage above the modelled MPP: zero export or curtailment moves the MPPT towards Voc",
};
const GATE_SHORT: Record<OperatingGate, string> = {
  no_reading: "No reading",
  stale: "Stale",
  not_producing: "Not producing",
  clipped_or_limited: "Limited",
  no_model: "No model",
  weather_not_aligned: "Out of step",
  low_irradiance: "Low light",
  out_of_range: "Out of range",
  off_mpp: "Off MPP",
};

export const stringIdOf = (sn: string, no: number) => `${sn} · STR-${String(no).padStart(2, "0")}`;
const strLabel = (no: number) => `STR-${String(no).padStart(2, "0")}`;
const hhmm = (ts: string | null | undefined) => (ts ? ts.slice(11, 16) : "—");
const pct = (r: number | null) => (r == null ? "—" : `${fmt(r * 100, 0)} %`);
const flagged = (s: StringOperatingPoint) => s.live_status === "Warning" || s.live_status === "Critical";
/** an input with nothing on it: no module count, no current, no live verdict */
const unused = (s: StringOperatingPoint) => s.modules == null && (s.current_a ?? 0) <= 0.3 && s.live_status == null;

type Verdict = "below" | "near" | "above" | "gated" | "unmodelled";
const verdictOf = (s: StringOperatingPoint): Verdict =>
  s.modules == null || s.r_imp == null ? "unmodelled" : !s.diagnostic ? "gated" : s.r_imp < LOW ? "below" : s.r_imp > HIGH ? "above" : "near";
const VERDICTS: Array<{ key: Verdict; label: string; hint: string; tone: string }> = [
  { key: "below", label: "Below model", hint: "Current under 90 % of the modelled Imp", tone: "text-amber-300" },
  { key: "near", label: "Near model", hint: "Current within ±10 % of the modelled Imp", tone: "text-emerald-300" },
  { key: "above", label: "Above model", hint: "Current over 110 % of the modelled Imp: more light than the sensor's plane, or module data off", tone: "text-sky-300" },
  { key: "gated", label: "Not diagnostic", hint: "On a curve, but a gate failed (see the reason)", tone: "text-slate-300" },
  { key: "unmodelled", label: "No module count", hint: "Not on String Layout: peer ratio only", tone: "text-slate-400" },
];
const VERDICT_TONE: Record<Verdict, string> = { below: "bg-amber-400", near: "bg-emerald-400", above: "bg-sky-400", gated: "bg-slate-500", unmodelled: "bg-slate-600" };

function operatingSpec(d: LiveStringOperating, names: Map<string, string>, selected: string | null, near: boolean): PanelChartSpec | null {
  if (!d.curves.length) return null;
  const byN = new Map(d.curves.map((c) => [c.modules, c]));
  const pts = d.strings.filter((s) => s.modules != null && byN.has(s.modules) && s.voltage_v != null && s.current_a != null);
  // near the operating points: from just under the lowest point / MPP to Voc, where every point sits
  const lo = near ? Math.max(0, Math.floor((Math.min(...pts.map((s) => s.voltage_v as number), ...d.curves.map((c) => c.v_mp_v)) * 0.85) / 50) * 50) : 0;
  const amps = (v: number) => `${fmt(v, 2)} A`;
  const watts = (v: number) => `${fmt(v, 0)} W`;
  const cur: ChartSeries[] = [];
  const pow: ChartSeries[] = [];
  for (const c of d.curves) {
    const p = c.points.filter((q) => q.v >= lo);
    const x = p.map((q) => q.v);
    const name = tr("Expected, {n} modules (modelled)", { n: c.modules });
    cur.push({ key: `m${c.modules}-i`, name, type: "line", dash: "dash", width: 1.5, color: SERIES.reference, x, y: p.map((q) => q.i), format: amps });
    pow.push({ key: `m${c.modules}-p`, name, type: "line", dash: "dash", width: 1.5, color: SERIES.reference, x, y: p.map((q) => q.p), format: watts, noLegend: true });
    pow.push({ key: `m${c.modules}-mpp`, name: tr("Modelled MPP"), type: "points", symbol: "ring", size: 10, color: SERIES.reference, x: [c.v_mp_v], y: [c.p_mp_w], noTip: true, noLegend: d.curves.length > 1 });
  }
  const note = (s: StringOperatingPoint) =>
    `${names.get(s.device_sn) ?? s.device_sn} · ${strLabel(s.string_no)} · ${tr("vs model")} ${pct(s.r_imp)}${s.gates.length ? ` · ${s.gates.map((g) => tr(GATE_SHORT[g])).join(", ")}` : ""}`;
  const group = (key: string, name: string, rows: StringOperatingPoint[], color: string, extra: Partial<ChartSeries>) => {
    if (!rows.length) return;
    const x = rows.map((s) => s.voltage_v as number);
    cur.push({ key: `${key}-i`, name, type: "points", size: 6, color, x, y: rows.map((s) => s.current_a as number), format: amps, tipNotes: rows.map(note), ...extra });
    pow.push({ key: `${key}-p`, name, type: "points", size: 6, color, x, y: rows.map((s) => (s.voltage_v as number) * (s.current_a as number)), format: watts, tipNotes: rows.map(note), noLegend: true, ...extra });
  };
  const isSel = (s: StringOperatingPoint) => stringIdOf(s.device_sn, s.string_no) === selected;
  const rest = pts.filter((s) => !isSel(s));
  // many strings: muted dots, the status colour only where the live check flags one, one highlighted string
  group("ok", tr("Strings (measured)"), rest.filter((s) => s.diagnostic && !flagged(s)), MUTED, { opacity: 0.75 });
  const warn = rest.filter((s) => s.diagnostic && flagged(s));
  group("flag", tr("Flagged by the live string check"), warn, STATUS.warn, { colors: warn.map((s) => (s.live_status === "Critical" ? STATUS.crit : STATUS.warn)) });
  group("gated", tr("Not diagnostic (hollow)"), rest.filter((s) => !s.diagnostic), STATUS.none, { symbol: "ring", opacity: 0.8 });
  group("sel", tr("Selected string"), pts.filter(isSel), CATEGORICAL[0], { symbol: "diamond", size: 12 });
  return {
    xKind: "linear",
    xZero: !near,
    x: d.curves[0].points.filter((q) => q.v >= lo).map((q) => q.v),
    xLabel: tr("String DC voltage (V)"),
    xTipNumber: (v) => `${fmt(v, 0)} V`,
    panels: [
      { key: "i", title: tr("Current (A)"), series: cur, yMin: 0 },
      { key: "p", title: tr("Power (W)"), series: pow, yMin: 0 },
    ],
  };
}

/** One figure of the conditions strip. */
const Cond: React.FC<{ label: string; value: React.ReactNode; sub?: React.ReactNode; title?: string }> = ({ label, value, sub, title }) => (
  <div className="min-w-0 px-3.5 py-2.5" title={title}>
    <div className="truncate text-[11px] font-medium text-slate-400">{label}</div>
    <div className="num truncate text-base font-semibold text-slate-100">{value}</div>
    {sub && <div className="truncate text-[11px] text-muted-foreground">{sub}</div>}
  </div>
);

/** Ratio with a thin bar on a 0–150 % scale and a tick at 100 %. */
const RatioBar: React.FC<{ r: number | null; tone: string }> = ({ r, tone }) => (
  <div className="relative h-1.5 w-full rounded-full bg-white/[0.06]">
    {r != null && <div className={cn("h-full rounded-full", tone)} style={{ width: `${Math.min(100, (r / 1.5) * 100)}%` }} />}
    <span className="absolute -top-0.5 h-2.5 w-px bg-slate-300/70" style={{ left: `${100 / 1.5}%` }} aria-hidden />
  </div>
);

const GateChips: React.FC<{ s: StringOperatingPoint; full?: boolean }> = ({ s, full }) => {
  const { t } = useI18n();
  if (s.diagnostic) return <Badge variant="ok">{t("Diagnostic")}</Badge>;
  if (full)
    return (
      <ul className="flex flex-col gap-1 text-xs text-slate-300">
        {s.gates.map((g) => (
          <li key={g} className="flex gap-2">
            <Badge variant="neutral" className="shrink-0">{t(GATE_SHORT[g])}</Badge>
            <span className="text-muted-foreground">{g === "no_model" && s.model_reason ? s.model_reason : t(GATE_TEXT[g])}</span>
          </li>
        ))}
      </ul>
    );
  return (
    <span className="flex flex-wrap gap-1">
      {s.gates.map((g) => (
        <Tooltip key={g}>
          <TooltipTrigger asChild>
            <Badge variant="neutral">{t(GATE_SHORT[g])}</Badge>
          </TooltipTrigger>
          <TooltipContent>{g === "no_model" && s.model_reason ? s.model_reason : t(GATE_TEXT[g])}</TooltipContent>
        </Tooltip>
      ))}
    </span>
  );
};

const LiveBadge: React.FC<{ s: StringOperatingPoint }> = ({ s }) => {
  const { t } = useI18n();
  return s.live_status ? (
    <Badge variant={s.live_status === "Critical" ? "crit" : s.live_status === "Warning" ? "warn" : "ok"} title={s.live_reason ?? undefined}>
      {t(s.live_status)}
    </Badge>
  ) : (
    <span className="text-muted-foreground" title={s.live_reason ?? undefined}>—</span>
  );
};

/** The selected string: what the point says, the figures behind it, and why it is (not) diagnostic. */
const SelectedPanel: React.FC<{ s: StringOperatingPoint | null; name: string; href: string | null }> = ({ s, name, href }) => {
  const { t } = useI18n();
  if (!s)
    return <div className="flex h-full items-center justify-center rounded-lg border border-dashed border-white/[0.08] p-6 text-center text-xs text-muted-foreground">{t("Pick a string in the list below.")}</div>;
  const v = verdictOf(s);
  const meta = VERDICTS.find((x) => x.key === v)!;
  return (
    <div className="flex h-full flex-col gap-3 rounded-lg border border-white/[0.07] bg-white/[0.02] p-4">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="truncate text-[11px] text-muted-foreground">{name}</div>
          <div className="text-sm font-semibold">
            {strLabel(s.string_no)} <span className="font-normal text-muted-foreground">· MPPT {s.mppt_no ?? "—"} · {s.modules != null ? t("{n} modules", { n: s.modules }) : t("modules not entered")}</span>
          </div>
        </div>
        <LiveBadge s={s} />
      </div>
      <div>
        <div className="flex items-baseline justify-between gap-2">
          <span className="text-xs text-slate-400">{t("Current vs model")}</span>
          <span className={cn("num text-2xl font-semibold", meta.tone)}>{pct(s.r_imp)}</span>
        </div>
        <RatioBar r={s.r_imp} tone={VERDICT_TONE[v]} />
        <div className={cn("mt-1 text-[11px]", meta.tone)}>{t(meta.label)}</div>
      </div>
      <dl className="grid grid-cols-3 gap-2 text-center">
        {[
          [t("vs peers"), pct(s.r_i)],
          [t("V vs model"), pct(s.r_v)],
          [t("Power"), s.power_w == null ? "—" : `${fmt(s.power_w / 1000, 2)} kW`],
          ["V", s.voltage_v == null ? "—" : `${fmt(s.voltage_v, 0)} V`],
          ["I", s.current_a == null ? "—" : `${fmt(s.current_a, 2)} A`],
          [t("Record"), hhmm(s.timestamp)],
        ].map(([k, val]) => (
          <div key={k} className="rounded-md bg-white/[0.03] px-2 py-1.5">
            <dt className="truncate text-[10px] text-muted-foreground">{k}</dt>
            <dd className="num text-xs font-medium text-slate-100">{val}</dd>
          </div>
        ))}
      </dl>
      <GateChips s={s} full />
      {s.live_reason && <p className="text-[11px] leading-snug text-muted-foreground">{s.live_reason}</p>}
      {href && (
        <Button asChild size="sm" variant="outline" className="mt-auto self-start">
          <Link to={href}>
            {t("Open full analysis")}
            <ArrowUpRight data-icon="inline-end" />
          </Link>
        </Button>
      )}
    </div>
  );
};

export const LiveOperatingCard: React.FC<{
  plantId: number;
  selectedId: string | null;
  onSelect: (stringId: string) => void;
}> = ({ plantId, selectedId, onSelect }) => {
  const { t } = useI18n();
  const plantHref = usePlantHref();
  const [res, setRes] = useState<GrowattLive<LiveStringOperating> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(0);
  const [show, setShow] = useState<Verdict | "all">("all");
  const [range, setRange] = useState<"near" | "full">("near");
  // another plant: drop the old answer first, so it is never shown under the new name
  useEffect(() => {
    setRes(null);
    setError(null);
    setPage(0);
    setShow("all");
  }, [plantId]);
  useEffect(() => setPage(0), [show]);
  useLivePoll(
    true,
    plantId,
    () => api.getLiveStringOperating(plantId),
    (r) => {
      setRes(r);
      setError(null);
    },
    (e) => setError(e instanceof Error ? e.message : String(e))
  );

  const d = res?.data ?? null;
  const names = useMemo(() => new Map((d?.inverters ?? []).map((i) => [i.device_sn, i.alias || i.device_sn])), [d]);
  const listed = useMemo(() => {
    const key = (s: StringOperatingPoint) => s.r_imp ?? (s.r_i != null ? 10 + s.r_i : 100);
    return (d?.strings ?? []).filter((s) => !unused(s)).sort((a, b) => key(a) - key(b) || a.device_sn.localeCompare(b.device_sn) || a.string_no - b.string_no);
  }, [d]);
  const counts = useMemo(() => {
    const c: Record<Verdict, number> = { below: 0, near: 0, above: 0, gated: 0, unmodelled: 0 };
    for (const s of listed) c[verdictOf(s)] += 1;
    return c;
  }, [listed]);
  const rows = show === "all" ? listed : listed.filter((s) => verdictOf(s) === show);
  // the page's string when it has a live point, else the lowest one against the model
  const selected = listed.find((s) => stringIdOf(s.device_sn, s.string_no) === selectedId) ?? listed.find((s) => s.r_imp != null) ?? listed[0] ?? null;
  const selId = selected ? stringIdOf(selected.device_sn, selected.string_no) : null;
  const spec = useMemo(() => (d ? operatingSpec(d, names, selId, range === "near") : null), [d, names, selId, range]);
  const { pageNo } = pageBounds(rows.length, PAGE, page);
  const pageRows = rows.slice(pageNo * PAGE, (pageNo + 1) * PAGE);
  const hidden = (d?.strings.length ?? 0) - listed.length;

  const staleRecords = d ? d.inverters.filter((i) => i.stale || (i.age_s != null && i.age_s > d.criteria.stale_s)).length : 0;
  const newest = d?.inverters.map((i) => i.timestamp ?? "").sort().pop();
  const w = d?.weather ?? null;
  const curve = d?.curves[0] ?? null;
  const layoutLink = (
    <Link className="text-solar-300 underline-offset-2 hover:underline" to={plantHref("string-layout")}>
      String Layout
    </Link>
  );

  return (
    <Card className="gap-0 py-0">
      <CardHeader className="flex flex-wrap items-start justify-between gap-3 border-b border-white/[0.06] px-4 py-3 sm:px-5">
        <div className="min-w-0">
          <CardTitle className="text-sm">{t("Live operating points")}</CardTitle>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge variant="neutral" title={t("Single-diode model of the fleet module ({m}); not a measured sweep", { m: d ? `${d.module.manufacturer ?? ""} ${d.module.model ?? ""}`.trim() || "—" : "—" })}>
            {t("Curve modelled")}
          </Badge>
          {res &&
            (res.stale || staleRecords > 0 ? (
              <Badge variant="warn" title={t("{n} inverters without a fresh record", { n: staleRecords })}>{t("Stale")}</Badge>
            ) : (
              <Badge variant="ok">{t("Live · {t}", { t: hhmm(newest) })}</Badge>
            ))}
        </div>
      </CardHeader>

      {!res && !error ? (
        <CardContent className="px-4 py-4 sm:px-5">
          <LoadingState label={t("Reading the live records…")} shape="chart" />
        </CardContent>
      ) : !d ? (
        <CardContent className="px-4 py-4 sm:px-5">
          <EmptyState icon={Activity} title={t("Live data unavailable")} description={error ?? undefined} className="py-8" />
        </CardContent>
      ) : (
        <>
          {/* conditions the curve is modelled at */}
          <div className="grid grid-cols-2 divide-white/[0.06] border-b border-white/[0.06] sm:grid-cols-4 sm:divide-x">
            <Cond label={t("Irradiance (POA)")} value={w ? `${fmt(w.irradiance_wm2, 0)} W/m²` : "—"} sub={w ? t("Sensor · {t}", { t: hhmm(w.timestamp) }) : t("No sensor reading")} title={t("Weather sensor, live ({n} averaged)", { n: w?.sensors ?? 0 })} />
            <Cond label={t("Module temperature")} value={w ? `${fmt(w.module_temp_c, 1)} °C` : "—"} sub={w?.ambient_temp_c != null ? t("Ambient {v} °C", { v: fmt(w.ambient_temp_c, 1) }) : undefined} />
            <Cond
              label={t("Modelled MPP")}
              value={curve ? `${fmt(curve.v_mp_v, 0)} V / ${fmt(curve.i_mp_a, 2)} A` : "—"}
              sub={curve ? `${t("{n} modules", { n: curve.modules })} · ${fmt(curve.p_mp_w / 1000, 2)} kW${d.curves.length > 1 ? ` +${d.curves.length - 1}` : ""}` : undefined}
            />
            <Cond label={t("Module")} value={d.module.wp != null ? `${fmt(d.module.wp, 0)} Wp` : "—"} sub={`${d.module.manufacturer ?? ""} ${d.module.model ?? ""}`.trim() || undefined} />
          </div>

          <CardContent className="flex flex-col gap-4 px-4 py-4 sm:px-5">
            {/* verdicts: each one filters the list */}
            <div className="flex flex-wrap items-center gap-2">
              <ToggleGroup
                type="single"
                variant="outline"
                value={show === "all" ? "" : show}
                // Clicking the pressed verdict again gives "": back to all strings.
                onValueChange={(v) => setShow((v || "all") as Verdict | "all")}
                className="flex-wrap"
              >
                {VERDICTS.map((v) => (
                  <ToggleGroupItem
                    key={v.key}
                    value={v.key}
                    title={t(v.hint)}
                    disabled={!counts[v.key]}
                    className="h-auto gap-2 rounded-md border-white/[0.07] px-2.5 py-1.5 text-xs font-normal hover:border-white/[0.15] hover:bg-transparent disabled:opacity-40 data-[state=on]:border-solar-400/50 data-[state=on]:bg-solar-400/10 data-[state=on]:font-normal"
                  >
                    <span className={cn("size-2 rounded-full", VERDICT_TONE[v.key])} aria-hidden />
                    <span className="text-slate-300">{t(v.label)}</span>
                    <span className={cn("num font-semibold", v.tone)}>{counts[v.key]}</span>
                  </ToggleGroupItem>
                ))}
              </ToggleGroup>
              {spec && (
                <Tabs className="ml-auto" value={range} onValueChange={(v) => setRange(v as "near" | "full")}>
                  <TabsList>
                    <TabsTrigger value="near">{t("Near the points")}</TabsTrigger>
                    <TabsTrigger value="full">{t("Full curve")}</TabsTrigger>
                  </TabsList>
                </Tabs>
              )}
            </div>

            <div className="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(280px,1fr)]">
              <div className="flex min-w-0 flex-col gap-2">
                {spec ? (
                  <>
                    <PanelChart spec={spec} height={360} legendToggle legendPosition="bottom" />
                  </>
                ) : (
                  <div className="flex min-h-48 items-center justify-center rounded-lg border border-dashed border-white/[0.08] p-6 text-center text-xs text-muted-foreground">
                    {d.weather_reason ?? (
                      <span>
                        {t("No string of this plant has its module count entered, so no curve can be modelled.")} {t("Enter it on")} {layoutLink}.
                      </span>
                    )}
                  </div>
                )}
              </div>
              <SelectedPanel
                s={selected}
                name={selected ? names.get(selected.device_sn) ?? selected.device_sn : ""}
                href={selected ? `${plantHref("string")}?sn=${encodeURIComponent(selected.device_sn)}&no=${selected.string_no}` : null}
              />
            </div>

            <Table containerClassName="table-wrap">
              <TableHeader>
                <TableRow>
                  <TableHead>{t("String")}</TableHead>
                  <TableHead className="text-right">MPPT</TableHead>
                  <TableHead className="text-right">{t("Modules")}</TableHead>
                  <TableHead className="text-right">V</TableHead>
                  <TableHead className="text-right">I</TableHead>
                  <TableHead className="w-40" title={t("Current ÷ the modelled Imp")}>{t("I vs model")}</TableHead>
                  <TableHead className="text-right">{t("vs peers")}</TableHead>
                  <TableHead>{t("Point")}</TableHead>
                  <TableHead>{t("Live check")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {pageRows.map((s) => {
                  const id = stringIdOf(s.device_sn, s.string_no);
                  const v = verdictOf(s);
                  return (
                    <TableRow key={id} className={cn("cursor-pointer", id === selId && "bg-sky-400/[0.07]")} onClick={() => onSelect(id)} aria-selected={id === selId}>
                      <TableCell className="whitespace-nowrap">
                        <span className="text-muted-foreground">{names.get(s.device_sn) ?? s.device_sn}</span> · {strLabel(s.string_no)}
                      </TableCell>
                      <TableCell className="num text-right">{s.mppt_no ?? "—"}</TableCell>
                      <TableCell className="num text-right">{s.modules ?? "—"}</TableCell>
                      <TableCell className="num text-right">{fmt(s.voltage_v, 0)}</TableCell>
                      <TableCell className="num text-right">{fmt(s.current_a, 2)}</TableCell>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          <span className="num w-11 shrink-0 text-right">{pct(s.r_imp)}</span>
                          <RatioBar r={s.r_imp} tone={VERDICT_TONE[v]} />
                        </div>
                      </TableCell>
                      <TableCell className="num text-right">{pct(s.r_i)}</TableCell>
                      <TableCell>
                        <GateChips s={s} />
                      </TableCell>
                      <TableCell>
                        <LiveBadge s={s} />
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>

            <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-muted-foreground">
              <span className="max-w-3xl">
                {t("Lowest against the model first.")}
                {hidden > 0 ? ` ${t("{n} unused inputs hidden (no module count, no current).", { n: hidden })}` : ""}{" "}
                {counts.unmodelled > 0 && (
                  <>
                    {t("Strings without a module count show their ratio to their inverter's other strings only: enter it on")} {layoutLink}.{" "}
                  </>
                )}
                {t("The sensor measures one plane: strings facing another way sit above or below the curve without a fault. Strings on one MPPT share its voltage. Thresholds are proposed ({v}).", { v: d.criteria.version })}
              </span>
              {rows.length > PAGE && <TablePager rows={rows.length} pageSize={PAGE} pageNo={pageNo} onPage={setPage} />}
            </div>
          </CardContent>
        </>
      )}
    </Card>
  );
};
