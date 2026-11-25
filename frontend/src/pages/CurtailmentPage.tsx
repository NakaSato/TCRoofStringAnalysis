/**
 * Curtailment: every visible plant's energy held back over a period (DB only, **estimated**;
 * backend services/growatt_curtailment.py, `/growatt/curtailment`).
 *
 * A slot counts when the plant's AC is held below its modelled available power and the plant shows
 * why: the meter at ~0 kW both ways (zero export: the inverters follow the load) or the AC at the
 * power-limit setting. The model is calibrated per plant on how it runs when nothing holds it back
 * (midday, importing well above the export band), from the 14 days before each day; a plant with
 * too few such slots takes the mean of the fleet's ratio and its own 08 h / 15 h free running
 * (scaled to midday), else the fleet's ratio, and the table says which. Every figure carries its
 * typical error (±, from the backtest of each calibration source). A row opens the plant's
 * overview on its last curtailed day, where the chart shows the band slot by slot.
 */
import React, { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { ArrowUpRight, Download, RefreshCw, Search } from "lucide-react";
import { api } from "../api/client";
import type { CurtailCalibrationSource, FleetCurtailment, FleetCurtailmentPlant } from "../api/client";
import { PanelChart } from "../components/PanelChart";
import { SkeletonChart, SkeletonKpis, SkeletonRows, Suspended, fmt, fmtInt } from "../components/ui";
import { TablePager, pageBounds } from "../components/TablePager";
import { plantPath } from "../context/routes";
import { plantToday } from "../context/alarmLogStore";
import { pick, pickDay, useUrlState } from "@/lib/useUrlState";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import { Select, SelectContent, SelectItem, SelectSeparator, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { StatTile } from "./overview/StatTile";
import { dailyEnergySpec } from "./generation/charts";
import { SortHead } from "./pwaMeter/tables";
import { downloadCsv } from "./pwaMeter/format";
import { useI18n } from "../i18n";

const RANGES = ["7", "14", "30"] as const;
type RangeDays = (typeof RANGES)[number];
const SORTS = ["kwh", "pct", "name", "phase", "kwp", "days", "ratio", "last"] as const;
type SortKey = (typeof SORTS)[number];
/** rows per page of the plant table */
const PAGE = 50;

/** "YYYY-MM-DD" n days before `day` (UTC date arithmetic, so no zone shifts it). */
const daysBefore = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) - n * 86_400_000).toISOString().slice(0, 10);

const CAL_VARIANT: Record<CurtailCalibrationSource, "ok" | "info" | "warn" | "neutral"> = { plant: "ok", blend: "info", fleet: "warn", not_checked: "neutral" };
const CAL_LABEL: Record<CurtailCalibrationSource, string> = { plant: "Own", blend: "Own + fleet", fleet: "Fleet", not_checked: "Not checked" };

/** √Σ err² of the rows' curtailed-kWh errors (plants are independent); null when a curtailed row has none. */
const totalErr = (rows: FleetCurtailmentPlant[]): number | null => {
  let s = 0;
  for (const r of rows) {
    if (!r.curtailed_kwh) continue;
    if (r.curtailed_err_kwh == null) return null;
    s += r.curtailed_err_kwh ** 2;
  }
  return Math.sqrt(s);
};
/** kWh, or MWh from 10,000 kWh (the tile's unit) */
const bigKwh = (v: number, mwh: boolean) => (mwh ? fmt(v / 1000, 1) : fmtInt(v));

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
      err: judged.length ? totalErr(judged) : null,
      plant: by("plant"),
      blend: by("blend"),
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
  const fmtDay = (d: string) => new Date(`${d}T00:00:00`).toLocaleDateString(locale, { day: "numeric", month: "short" });

  // PAGE rows at a time; back to page 1 when the list, the sort or the period changes
  const [page, setPage] = useState(0);
  useEffect(() => setPage(0), [phase, query, sort, asc, start, end]);
  const { pageNo } = pageBounds(rows.length, PAGE, page);
  const pageRows = rows.slice(pageNo * PAGE, (pageNo + 1) * PAGE);

  const exportCsv = () =>
    downloadCsv(
      `curtailment_${start}_${end}.csv`,
      ["plant_id", "plant", "phase", "kwp", "curtailed_kwh_est", "curtailed_kwh_err", "share_pct", "days_curtailed", "days_judged", "export_limit_kwh_est", "power_limit_kwh_est", "model_scale_pct", "calibration", "last_curtailed_day"],
      rows.map((p) => [
        p.plant_id, p.name, p.phase, p.capacity_kwp, p.curtailed_kwh, p.curtailed_err_kwh, p.curtailed_pct, p.curtailed_days, p.judged_days,
        p.by.export_limit ?? null, p.by.power_limit ?? null,
        p.calibration.ratio == null ? null : Math.round(p.calibration.ratio * 1000) / 10, p.calibration.status, p.last_curtailed_day,
      ])
    );

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-col">
          <h1 className="text-lg font-semibold">{t("Curtailment")}</h1>
          <p className="text-xs text-muted-foreground">
            {t("Estimated from the stored days")} · {fmtDay(start)} – {fmtDay(end)}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Select value={custom ? "custom" : range} onValueChange={(v) => v !== "custom" && setUrl({ range: v === "7" ? null : v, from: null, to: null })}>
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
            {loading ? <Spinner data-icon="inline-start" className="size-3" /> : <RefreshCw data-icon="inline-start" />}
            {t("Refresh")}
          </Button>
        </div>
      </div>

      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {!data && loading ? (
        <SkeletonKpis count={4} />
      ) : (
        <Suspended busy={loading && !!data} pill={false}>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <StatTile
              label={t("Curtailed (estimated)")}
              value={kpi.kwh == null ? "—" : bigKwh(kpi.kwh, kpi.kwh >= 10_000)}
              unit={kpi.kwh != null && kpi.kwh >= 10_000 ? "MWh" : "kWh"}
              tone="text-amber-300"
              footer={
                <span title={t("Typical error of the total from the model calibration: the plants' errors are independent, so they partly cancel. A bias shared by every plant would not cancel and is not included.")}>
                  {kpi.kwh != null && kpi.kwh > 0 && (kpi.err == null ? `${t("± unknown")} · ` : `± ${bigKwh(kpi.err, kpi.kwh >= 10_000)} · `)}
                  {t("{n} plant(s) judged", { n: kpi.judged })}
                </span>
              }
            />
            <StatTile label={t("Of what the plants could give")} value={kpi.pct == null ? "—" : fmt(kpi.pct, 1)} unit="%" footer={t("curtailed ÷ (produced + curtailed)")} />
            <StatTile label={t("Plants curtailed")} value={fmtInt(kpi.curtailed)} unit={t("of {n}", { n: kpi.judged })} footer={t("at least one curtailed slot in the period")} />
            <StatTile
              label={t("Model calibration")}
              value={fmtInt(kpi.plant)}
              unit={t("own")}
              footer={t("{blend} own + fleet · {fleet} fleet ratio · {none} not checked", { blend: kpi.blend, fleet: kpi.fleet, none: kpi.unchecked })}
            />
          </div>
        </Suspended>
      )}

      {!(phase || query.trim()) && (
        <Card className="gap-2">
          <CardHeader>
            <CardTitle className="flex flex-wrap items-center gap-2">
              {t("Fleet energy per day")}
              <Badge variant="warn">{t("Estimated")}</Badge>
            </CardTitle>
            <CardDescription>{t("AC energy of every plant with the curtailed energy (estimated) stacked on top")}</CardDescription>
          </CardHeader>
          <CardContent>
            {spec ? (
              <Suspended busy={loading} pill="center">
                <PanelChart spec={spec} height={260} />
              </Suspended>
            ) : loading ? (
              <SkeletonChart height={260} />
            ) : (
              <p className="py-10 text-center text-xs text-muted-foreground">{t("No stored days in this period")}</p>
            )}
          </CardContent>
        </Card>
      )}

      <Card className="gap-3">
        <CardHeader className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="flex items-center gap-2">
            {t("Plants")}
            {data && <span className="num text-xs font-normal text-muted-foreground">{t("{n} of {total}", { n: rows.length, total: data.plants.length })}</span>}
          </CardTitle>
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
            {(phase || query) && (
              <Button variant="ghost" size="sm" onClick={() => setUrl({ phase: null, q: null })}>
                {t("Clear")}
              </Button>
            )}
            <Button variant="outline" size="sm" onClick={exportCsv} disabled={!rows.length}>
              <Download data-icon="inline-start" />
              {t("Export CSV")}
            </Button>
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
                <TableHeader className="sticky top-0 z-10 bg-card">
                  <TableRow>
                    <SortHead k="name" label={t("Plant")} sort={sort} desc={!asc} onSort={setSort} className="pl-4" />
                    <SortHead k="phase" label={t("Phase")} sort={sort} desc={!asc} onSort={setSort} />
                    <SortHead k="kwp" label="kWp" sort={sort} desc={!asc} onSort={setSort} className="text-right" />
                    <SortHead k="kwh" label={t("Curtailed (kWh)")} sort={sort} desc={!asc} onSort={setSort} className="text-right" title={t("Estimated energy held back over the period")} />
                    <SortHead k="pct" label={t("Share")} sort={sort} desc={!asc} onSort={setSort} className="text-right" title={t("curtailed ÷ (produced + curtailed)")} />
                    <SortHead k="days" label={t("Days")} sort={sort} desc={!asc} onSort={setSort} className="text-right" title={t("Days with a curtailed slot / days judged")} />
                    <TableHead>{t("Why")}</TableHead>
                    <SortHead k="ratio" label={t("Model scale")} sort={sort} desc={!asc} onSort={setSort} title={t("How the plant runs when free, as a share of the plain model (14 days before)")} />
                    <SortHead k="last" label={t("Last curtailed")} sort={sort} desc={!asc} onSort={setSort} className="pr-4" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {pageRows.map((p) => {
                    const href = `${plantPath(p.plant_id)}${p.last_curtailed_day ? `?day=${p.last_curtailed_day}` : ""}`;
                    const exp = p.by.export_limit ?? 0;
                    const lim = p.by.power_limit ?? 0;
                    return (
                      <TableRow key={p.plant_id} className="group">
                        <TableCell className="max-w-[320px] pl-4">
                          <Link to={href} className="flex min-w-0 items-center gap-1 font-medium text-foreground hover:text-sky-300">
                            <span className="truncate" title={p.name}>
                              {p.name}
                            </span>
                            <ArrowUpRight className="size-3 shrink-0 text-sky-400 opacity-0 transition group-hover:opacity-100" />
                          </Link>
                          <span className="num text-[11px] text-muted-foreground">{p.plant_id}</span>
                        </TableCell>
                        <TableCell className="num text-muted-foreground">{p.phase ?? "—"}</TableCell>
                        <TableCell className="num text-right text-muted-foreground">{fmtInt(p.capacity_kwp)}</TableCell>
                        <TableCell className={cn("num text-right font-semibold", (p.curtailed_kwh ?? 0) > 0 ? "text-amber-300" : "text-muted-foreground")}>
                          {p.curtailed_kwh == null ? <span title={t("No slot could be judged: no weather sensor or no kWp")}>—</span> : fmtInt(p.curtailed_kwh)}
                          {(p.curtailed_kwh ?? 0) > 0 && (
                            <span
                              className="block text-[11px] font-normal text-muted-foreground"
                              title={
                                p.curtailed_err_kwh == null
                                  ? t("Some curtailed day rests on the uncalibrated model: the error is not known")
                                  : t("Typical error of the estimate from the model calibration ({source}); about 1 plant in 10 is off by up to twice this", { source: t(CAL_LABEL[p.calibration.status]) })
                              }
                            >
                              ± {p.curtailed_err_kwh == null ? "?" : fmtInt(p.curtailed_err_kwh)}
                            </span>
                          )}
                        </TableCell>
                        <TableCell className="num text-right">{p.curtailed_pct == null ? "—" : `${fmt(p.curtailed_pct, 1)} %`}</TableCell>
                        <TableCell className="num text-right text-muted-foreground">{p.judged_days ? `${p.curtailed_days} / ${p.judged_days}` : "—"}</TableCell>
                        <TableCell className="whitespace-nowrap">
                          {exp + lim <= 0 ? (
                            <span className="text-muted-foreground">—</span>
                          ) : (
                            <Badge variant={exp >= lim ? "info" : "warn"}>{exp >= lim ? t("Followed the load") : t("Power limit")}</Badge>
                          )}
                        </TableCell>
                        <TableCell className="whitespace-nowrap">
                          <span className="num mr-1.5">{p.calibration.ratio == null ? "—" : `${fmt(p.calibration.ratio * 100, 0)} %`}</span>
                          <Badge
                            variant={CAL_VARIANT[p.calibration.status]}
                            title={
                              p.calibration.status === "plant"
                                ? t("From the plant's own {n} free-running slot(s)", { n: p.calibration.slots ?? 0 })
                                : p.calibration.status === "blend"
                                  ? t("Too few midday free-running slots of its own ({n}): the mean of the fleet's ratio and its own free running at 08 h / 15 h (scaled to midday)", { n: p.calibration.slots ?? 0 })
                                  : p.calibration.status === "fleet"
                                  ? t("Too few free-running slots of its own ({n}): the fleet's ratio", { n: p.calibration.slots ?? 0 })
                                  : t("No free-running slots yet: the plain model, likely high")
                            }
                          >
                            {t(CAL_LABEL[p.calibration.status])}
                          </Badge>
                        </TableCell>
                        <TableCell className="num whitespace-nowrap pr-4 text-muted-foreground">
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
              <TablePager className="border-t border-white/[0.06] px-4 py-2.5" rows={rows.length} pageSize={PAGE} pageNo={pageNo} onPage={setPage} />
            </Suspended>
          )}
        </CardContent>
        <CardFooter className="border-t border-white/[0.06] pt-3">
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            {t(
              "How it is estimated: available power = kWp × irradiance × temperature × system factor × the plant's model scale (modelled). A plant's model scale is how it ran when nothing held it back (09–15 h, ≥ 400 W/m², buying more than 30 % of the model from the grid) over the 14 days before each day; with fewer than {n} such slots it is the mean of the fleet's ratio and the plant's own free running at 08 h / 15 h (scaled to midday by the fleet's hour factors), else the fleet's ratio. ± = typical error from that calibration (backtest: own 5 %, own + fleet 10 %, fleet 15 % on the available power, 2–3× that on the curtailed kWh). A plant without a weather sensor cannot be judged (—).",
              { n: data?.meta.calibration_min_slots ?? 12 }
            )}
          </p>
        </CardFooter>
      </Card>
    </div>
  );
};
