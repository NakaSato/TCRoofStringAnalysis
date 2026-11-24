/**
 * Curtailment: every visible plant's energy held back over a period (DB only, **estimated**;
 * backend services/growatt_curtailment.py, `/growatt/curtailment`).
 *
 * A slot counts when the plant's AC is held below its modelled available power and the plant shows
 * why: the meter at ~0 kW both ways (zero export: the inverters follow the load) or the AC at the
 * power-limit setting. The model is calibrated per plant on how it runs when nothing holds it back
 * (midday, importing well above the export band), from the 14 days before each day; a plant with
 * too few such slots takes the fleet's ratio, and the table says which. A row opens the plant's
 * overview on its last curtailed day, where the chart shows the band slot by slot.
 */
import React, { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { ArrowUpDown, ArrowUpRight, Gauge, Search } from "lucide-react";
import { api } from "../api/client";
import type { CurtailCalibrationSource, FleetCurtailment, FleetCurtailmentPlant } from "../api/client";
import { PanelChart } from "../components/PanelChart";
import { PageHeader, SkeletonChart, SkeletonRows, Suspended, fmt, fmtInt } from "../components/ui";
import { plantPath } from "../context/routes";
import { plantToday } from "../context/alarmLogStore";
import { pick, pickDay, useUrlState } from "@/lib/useUrlState";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import { Select, SelectContent, SelectItem, SelectSeparator, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { StatTile } from "./overview/StatTile";
import { dailyEnergySpec } from "./generation/charts";
import { useI18n } from "../i18n";

const RANGES = ["7", "14", "30"] as const;
type RangeDays = (typeof RANGES)[number];
const SORTS = ["kwh", "pct", "name", "phase", "kwp", "days", "ratio", "last"] as const;
type SortKey = (typeof SORTS)[number];

/** "YYYY-MM-DD" n days before `day` (UTC date arithmetic, so no zone shifts it). */
const daysBefore = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) - n * 86_400_000).toISOString().slice(0, 10);

const CAL_TONE: Record<CurtailCalibrationSource, string> = {
  plant: "border-energy-400/30 bg-energy-500/10 text-energy-300",
  fleet: "border-sky-400/30 bg-sky-500/10 text-sky-300",
  not_checked: "border-white/10 bg-white/[0.03] text-slate-400",
};
const CAL_LABEL: Record<CurtailCalibrationSource, string> = { plant: "Own", fleet: "Fleet", not_checked: "Not checked" };

const sortValue = (p: FleetCurtailmentPlant, k: SortKey): number | string | null => {
  switch (k) {
    case "kwh":
      return p.curtailed_kwh;
    case "pct":
      return p.curtailed_pct;
    case "name":
      return p.name.toLowerCase();
    case "phase":
      return p.phase;
    case "kwp":
      return p.capacity_kwp;
    case "days":
      return p.curtailed_days;
    case "ratio":
      return p.calibration.ratio;
    case "last":
      return p.last_curtailed_day;
  }
};

export const CurtailmentPage: React.FC = () => {
  const { t, locale } = useI18n();
  const today = plantToday();
  const [url, setUrl] = useUrlState();
  const range: RangeDays = pick(url.get("range"), RANGES, "7");
  const end = pickDay(url.get("to")) ?? today;
  const start = pickDay(url.get("from")) ?? daysBefore(end, Number(range) - 1);
  const custom = url.get("from") != null;
  const phase = url.get("phase") ?? "";
  const query = url.get("q") ?? "";
  const sort: SortKey = pick(url.get("sort"), SORTS, "kwh");
  const asc = url.get("asc") === "1";

  const [data, setData] = useState<FleetCurtailment | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api
      .getFleetCurtailment(start, end)
      .then((r) => !cancelled && (setData(r), setError(null)))
      .catch((e) => !cancelled && setError(e instanceof Error ? e.message : String(e)))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [start, end, tick]);

  const phases = useMemo(
    () => [...new Set((data?.plants ?? []).map((p) => p.phase).filter((p): p is number => p != null))].sort((a, b) => a - b),
    [data]
  );
  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = (data?.plants ?? []).filter(
      (p) => (!phase || String(p.phase ?? "") === phase) && (!q || p.name.toLowerCase().includes(q) || String(p.plant_id).includes(q))
    );
    const dir = asc ? 1 : -1;
    return [...list].sort((a, b) => {
      const va = sortValue(a, sort);
      const vb = sortValue(b, sort);
      if (va == null && vb == null) return 0;
      if (va == null) return 1; // unjudged rows last, either direction
      if (vb == null) return -1;
      return (va < vb ? -1 : va > vb ? 1 : 0) * dir;
    });
  }, [data, phase, query, sort, asc]);

  // the KPIs follow the phase / search filter, so they always describe the rows below
  const kpi = useMemo(() => {
    const judged = rows.filter((r) => r.curtailed_kwh != null);
    const kwh = judged.reduce((s, r) => s + (r.curtailed_kwh ?? 0), 0);
    const energy = judged.reduce((s, r) => s + (r.energy_kwh ?? 0), 0);
    const by = (k: CurtailCalibrationSource) => judged.filter((r) => r.calibration.status === k).length;
    return {
      judged: judged.length,
      kwh: judged.length ? kwh : null,
      pct: judged.length && energy + kwh > 0 ? (kwh / (energy + kwh)) * 100 : null,
      curtailed: judged.filter((r) => (r.curtailed_kwh ?? 0) > 0).length,
      plant: by("plant"),
      fleet: by("fleet"),
      unchecked: by("not_checked"),
    };
  }, [rows]);

  const spec = useMemo(
    () =>
      data && !phase && !query.trim()
        ? dailyEnergySpec(
            data.days.map((d) => ({ day: d.day, energy_kwh: d.energy_kwh, curtailed_kwh: d.kwh })),
            { kwp: null, windowed: false, locale }
          )
        : null,
    [data, phase, query, locale]
  );

  const setSort = (k: SortKey) => setUrl({ sort: k === "kwh" ? null : k, asc: sort === k ? (asc ? null : "1") : k === "name" || k === "phase" ? "1" : null });
  const head = (k: SortKey, label: string, cls = "", title?: string) => (
    <TableHead className={cls}>
      <Button
        variant="ghost"
        size="xs"
        onClick={() => setSort(k)}
        title={title}
        className={cn(
          "h-auto gap-1 rounded-none p-0 text-[11px] font-semibold text-slate-400 hover:bg-transparent hover:text-white",
          cls.includes("text-right") && "ml-auto",
          sort === k && "text-slate-100"
        )}
      >
        {label} <ArrowUpDown className="size-2.5 opacity-60" />
      </Button>
    </TableHead>
  );
  const fmtDay = (d: string) => new Date(`${d}T00:00:00`).toLocaleDateString(locale, { day: "numeric", month: "short" });

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        icon={Gauge}
        eyebrow={t("Operations")}
        title={t("Curtailment")}
        description={t(
          "Energy each plant held back: the AC below its modelled available power while the meter held ~0 kW (zero export: the inverters followed the site load) or the AC sat at the power limit. Estimated, not measured; the model is calibrated per plant on how it runs when nothing holds it back."
        )}
        actions={
          <>
            <Select
              value={custom ? "custom" : range}
              onValueChange={(v) => v !== "custom" && setUrl({ range: v === "7" ? null : v, from: null, to: null })}
            >
              <SelectTrigger size="sm" className="w-auto min-w-32" aria-label={t("Period")}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {RANGES.map((r) => (
                  <SelectItem key={r} value={r}>
                    {t("Last {n} days", { n: r })}
                  </SelectItem>
                ))}
                {custom && (
                  <>
                    <SelectSeparator />
                    <SelectItem value="custom">{t("Custom")}</SelectItem>
                  </>
                )}
              </SelectContent>
            </Select>
            <Input type="date" aria-label={t("From")} className="h-8 w-36 [color-scheme:dark]" value={start} max={end} onChange={(e) => pickDay(e.target.value) && setUrl({ from: e.target.value, to: end, range: null })} />
            <Input type="date" aria-label={t("To")} className="h-8 w-36 [color-scheme:dark]" value={end} min={start} max={today} onChange={(e) => pickDay(e.target.value) && setUrl({ to: e.target.value, from: start, range: null })} />
            <Button variant="outline" size="sm" onClick={() => setTick((n) => n + 1)} disabled={loading}>
              {loading && <Spinner data-icon="inline-start" className="size-3" />}
              {loading ? t("Refreshing…") : t("Refresh")}
            </Button>
          </>
        }
      />

      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile
          label={t("Curtailed (estimated)")}
          tag={`${fmtDay(start)} – ${fmtDay(end)}`}
          value={kpi.kwh == null ? "—" : kpi.kwh >= 10_000 ? fmt(kpi.kwh / 1000, 1) : fmtInt(kpi.kwh)}
          unit={kpi.kwh != null && kpi.kwh >= 10_000 ? "MWh" : "kWh"}
          tone="text-amber-300"
          footer={t("{n} plant(s) judged", { n: kpi.judged })}
        />
        <StatTile
          label={t("Of what the plants could give")}
          value={kpi.pct == null ? "—" : fmt(kpi.pct, 1)}
          unit="%"
          footer={t("curtailed ÷ (produced + curtailed)")}
        />
        <StatTile
          label={t("Plants curtailed")}
          value={fmtInt(kpi.curtailed)}
          unit={t("of {n}", { n: kpi.judged })}
          footer={t("at least one curtailed slot in the period")}
        />
        <StatTile
          label={t("Model calibration")}
          value={fmtInt(kpi.plant)}
          unit={t("own")}
          footer={t("{fleet} fleet ratio · {none} not checked", { fleet: kpi.fleet, none: kpi.unchecked })}
        />
      </div>

      {(phase || query.trim()) ? null : (
        <Card className="gap-2">
          <CardHeader>
            <CardTitle>{t("Fleet energy per day")}</CardTitle>
            <CardDescription>{t("AC energy of every plant with the curtailed energy (estimated) stacked on top")}</CardDescription>
          </CardHeader>
          <CardContent>
            {spec ? (
              <Suspended busy={loading} pill="center">
                <PanelChart spec={spec} height={240} />
              </Suspended>
            ) : loading ? (
              <SkeletonChart height={240} />
            ) : (
              <p className="py-10 text-center text-xs text-slate-500">{t("No stored days in this period")}</p>
            )}
          </CardContent>
        </Card>
      )}

      <Card className="gap-3">
        <CardHeader className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle>{t("Plants")}</CardTitle>
          <div className="flex flex-wrap items-center gap-2">
            <Select value={phase || "all"} onValueChange={(v) => setUrl({ phase: v === "all" ? null : v })}>
              <SelectTrigger size="sm" className="w-auto min-w-28" aria-label={t("Phase")}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{t("All phases")}</SelectItem>
                {phases.map((p) => (
                  <SelectItem key={p} value={String(p)}>
                    {t("Phase {n}", { n: p })}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <InputGroup className="h-8 w-56">
              <InputGroupAddon>
                <Search />
              </InputGroupAddon>
              <InputGroupInput placeholder={t("Search plants")} value={query} onChange={(e) => setUrl({ q: e.target.value || null })} />
            </InputGroup>
          </div>
        </CardHeader>
        <CardContent className="px-0">
          {!data && loading ? (
            <SkeletonRows rows={8} className="px-4" />
          ) : !rows.length ? (
            <Empty>
              <EmptyHeader>
                <EmptyTitle>{t("No plants")}</EmptyTitle>
                <EmptyDescription>{t("No plant matches, or nothing is stored for this period yet.")}</EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <Suspended busy={loading}>
              <Table containerClassName="table-wrap">
                <TableHeader>
                  <TableRow>
                    {head("name", t("Plant"), "pl-4")}
                    {head("phase", t("Phase"))}
                    {head("kwp", "kWp", "text-right")}
                    {head("kwh", t("Curtailed (kWh)"), "text-right", t("Estimated energy held back over the period"))}
                    {head("pct", t("Share"), "text-right", t("curtailed ÷ (produced + curtailed)"))}
                    {head("days", t("Days"), "text-right", t("Days with a curtailed slot / days judged"))}
                    <TableHead>{t("Why")}</TableHead>
                    {head("ratio", t("Model scale"), "", t("How the plant runs when free, as a share of the plain model (14 days before)"))}
                    {head("last", t("Last curtailed"), "pr-4")}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((p) => {
                    const href = `${plantPath(p.plant_id)}${p.last_curtailed_day ? `?day=${p.last_curtailed_day}` : ""}`;
                    const exp = p.by.export_limit ?? 0;
                    const lim = p.by.power_limit ?? 0;
                    return (
                      <TableRow key={p.plant_id} className="group">
                        <TableCell className="max-w-[320px] pl-4">
                          <Link to={href} className="flex min-w-0 items-center gap-1 font-medium text-slate-100 hover:text-sky-300">
                            <span className="truncate" title={p.name}>
                              {p.name}
                            </span>
                            <ArrowUpRight className="size-3 shrink-0 text-sky-400 opacity-0 transition group-hover:opacity-100" />
                          </Link>
                        </TableCell>
                        <TableCell className="num text-slate-400">{p.phase ?? "—"}</TableCell>
                        <TableCell className="num text-right text-slate-400">{fmtInt(p.capacity_kwp)}</TableCell>
                        <TableCell className={cn("num text-right font-semibold", (p.curtailed_kwh ?? 0) > 0 ? "text-amber-300" : "text-slate-400")}>
                          {p.curtailed_kwh == null ? <span title={t("No slot could be judged: no weather sensor or no kWp")}>—</span> : fmtInt(p.curtailed_kwh)}
                        </TableCell>
                        <TableCell className="num text-right text-slate-300">{p.curtailed_pct == null ? "—" : `${fmt(p.curtailed_pct, 1)} %`}</TableCell>
                        <TableCell className="num text-right text-slate-400">
                          {p.judged_days ? `${p.curtailed_days} / ${p.judged_days}` : "—"}
                        </TableCell>
                        <TableCell className="whitespace-nowrap text-slate-400">
                          {exp + lim <= 0 ? "—" : exp >= lim ? t("Followed the load") : t("Power limit")}
                        </TableCell>
                        <TableCell className="whitespace-nowrap">
                          <span className="num mr-1.5 text-slate-300">{p.calibration.ratio == null ? "—" : `${fmt(p.calibration.ratio * 100, 0)} %`}</span>
                          <Badge
                            variant="outline"
                            className={cn("h-4 px-1.5 text-[10px]", CAL_TONE[p.calibration.status])}
                            title={
                              p.calibration.status === "plant"
                                ? t("From the plant's own {n} free-running slot(s)", { n: p.calibration.slots ?? 0 })
                                : p.calibration.status === "fleet"
                                  ? t("Too few free-running slots of its own ({n}): the fleet's ratio", { n: p.calibration.slots ?? 0 })
                                  : t("No free-running slots yet: the plain model, likely high")
                            }
                          >
                            {t(CAL_LABEL[p.calibration.status])}
                          </Badge>
                        </TableCell>
                        <TableCell className="num whitespace-nowrap pr-4 text-slate-400">
                          {p.last_curtailed_day ? (
                            <Link to={href} className="hover:text-sky-300 hover:underline">
                              {fmtDay(p.last_curtailed_day)}
                            </Link>
                          ) : (
                            "—"
                          )}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </Suspended>
          )}
        </CardContent>
      </Card>
      <p className="text-[11px] leading-relaxed text-slate-500">
        {t(
          "How it is estimated: available power = kWp × irradiance × temperature × system factor × the plant's model scale (modelled). A plant's model scale is how it ran when nothing held it back (09–15 h, ≥ 400 W/m², buying more than 30 % of the model from the grid) over the 14 days before each day; with fewer than {n} such slots the fleet's ratio is used. A plant without a weather sensor cannot be judged (—).",
          { n: data?.meta.calibration_min_slots ?? 12 }
        )}
      </p>
    </div>
  );
};
