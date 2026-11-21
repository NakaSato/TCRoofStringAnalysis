/**
 * Operations → O&M Dashboard (`/center`, everyone, scoped to the user's plants): one page for a
 * period, from two stored sources that are shown side by side and never added together:
 *
 * - **Inverter side** (`/growatt/center`): what the decision rules say is being lost, in ฿ at the
 *   tariff, by cause, the issues to fix first and one row per plant.
 * - **PWA meter report** (`/pwa/meter/*`, phases 1–2, imported monthly): billed meter energy
 *   against the contract, estimated losses at the contract's book price, outage events and the
 *   meter vs inverter check. Admins import the report workbooks here.
 *
 * One period for both (the report lags, so its badge says how far it reaches). DB only, nothing
 * polls. Lost kWh / ฿ are estimates, contract / PVsyst / EPI / PR′ modelled, costs entered.
 * Engineers see their plants, no phase totals and no issues of rules in shadow mode.
 * Pieces in `pages/center/` and `pages/pwaMeter/`; docs/plans/om-center-dashboard.md.
 *
 * URL: `range` (mtd | 7d | 30d | 90d | ytd), `from`, `to` (YYYY-MM-DD, custom), `shadow`,
 * `view` (issues | plants | sites | outages | meter), `q`, `phase`, `show` (sites view),
 * `sort`, `desc`, `site` (site detail open). `/pwa-meter` redirects here.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { api } from "../api/client";
import type { PwaMeterCriteria, PwaMeterSiteSummary, PwaMeterWindow } from "../api/client";
import { isAdmin } from "../auth/access";
import { useAppContext } from "../context/AppContext";
import { PanelChart } from "../components/PanelChart";
import { SkeletonRows, fmt, fmtInt } from "../components/ui";
import { pick, pickDay, useUrlState } from "@/lib/useUrlState";
import type { UrlPatch } from "@/lib/useUrlState";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectSeparator, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Meter, StatTile } from "./overview/StatTile";
import { usePwaMeter } from "./pwaMeter/usePwaMeter";
import { PHASES, SHOW, byKey, downloadCsv, fmtDay as fmtDayLong } from "./pwaMeter/format";
import type { Show } from "./pwaMeter/format";
import {
  CheckSortKeys,
  MeterCheckTable,
  OutageSortKeys,
  OutagesTable,
  PhaseTotals,
  SiteSortKeys,
  SitesTable,
  checkSortValue,
  outageSortValue,
  siteSortValue,
} from "./pwaMeter/tables";
import { SiteDialog } from "./pwaMeter/SiteDialog";
import { ImportDialog } from "./pwaMeter/ImportDialog";
import { useCenter } from "./center/useCenter";
import { ENTERED, EST, FAMILY_COLOR, RANGES, RANGE_LABEL, VIEWS, fmtDay, lossSpec, rangeStart, thb } from "./center/format";
import type { Range, View } from "./center/format";
import { IssuesTable, PlantSortKeys, PlantsTable, plantSortValue } from "./center/tables";
import { fleetDailySpec, regionSpec, topPlantsSpec } from "./center/chartSpecs";
import { HEAT_LEGEND, Legend, OWNERS, StrategyMatrix, YieldHeatmap } from "./center/charts";

const ALL = "all";
const METER_VIEWS: readonly View[] = ["sites", "outages", "meter"];
/** default sort key and direction per view (the issues list keeps the backend's order) */
const DEFAULT_SORT: Record<Exclude<View, "issues">, readonly [string, boolean]> = {
  plants: ["lost", true],
  sites: ["rank", false],
  outages: ["days", true],
  meter: ["gap", true],
};
const SHOW_LABEL: Record<Show, string> = { all: "All sites", issues: "With issues", om: "O&M to act", pm: "PM (curtailment)" };
const PWA_EST = "Estimated from the PWA meter report and its criteria file, priced at the contract's book price";

const sum = <T,>(rows: T[], get: (r: T) => number | null): number | null => {
  const vals = rows.map(get).filter((v): v is number => v != null);
  return vals.length ? vals.reduce((a, b) => a + b, 0) : null;
};

/** A titled group of tiles: says which source its figures come from. */
const Group: React.FC<{ title: string; source: string; badge?: React.ReactNode; cols: string; children: React.ReactNode }> = ({ title, source, badge, cols, children }) => (
  <section className="flex flex-col gap-2">
    <div className="flex h-7 items-center gap-2">
      <h2 className="shrink-0 text-sm font-semibold">{title}</h2>
      <span className="min-w-0 truncate text-[11px] text-muted-foreground" title={source}>
        {source}
      </span>
      {badge && <span className="ml-auto shrink-0">{badge}</span>}
    </div>
    <div className={`grid grid-cols-2 gap-3 ${cols}`}>{children}</div>
  </section>
);

/** A chart with its source and label; a skeleton while loading, a line of text when there is nothing to draw. */
const ChartCard: React.FC<{
  title: string;
  source: string;
  badge?: string;
  badgeTitle?: string;
  className?: string;
  loading: boolean;
  empty: string | null;
  note?: React.ReactNode;
  children: React.ReactNode;
}> = ({ title, source, badge, badgeTitle, className, loading, empty, note, children }) => (
  <Card className={className}>
    <CardHeader>
      <CardTitle className="flex flex-wrap items-center gap-2">
        {title}
        <span className="text-[11px] font-normal text-muted-foreground">{source}</span>
        {badge && (
          <Badge variant="neutral" title={badgeTitle}>
            {badge}
          </Badge>
        )}
      </CardTitle>
    </CardHeader>
    <CardContent className="flex flex-col gap-3">
      {loading ? (
        <SkeletonRows rows={5} />
      ) : empty ? (
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

export const OmCenterPage: React.FC = () => {
  const { user } = useAppContext();
  const admin = isAdmin(user);
  const [url, setUrl] = useUrlState();
  const from = pickDay(url.get("from"));
  const to = pickDay(url.get("to"));
  const custom = from != null || to != null;
  const range: Range = pick(url.get("range"), RANGES, "mtd");
  const shadow = admin && url.get("shadow") === "1";
  const view: View = pick(url.get("view"), VIEWS, "issues");
  const query = url.get("q") ?? "";
  const phase = pick(url.get("phase"), PHASES, ALL);
  const show: Show = pick(url.get("show"), SHOW, "all");
  const siteId = url.get("site");
  const sortKey = view === "issues" ? "" : pick(url.get("sort"), view === "plants" ? PlantSortKeys : view === "sites" ? SiteSortKeys : view === "outages" ? OutageSortKeys : CheckSortKeys, DEFAULT_SORT[view][0] as never);
  const desc = view === "issues" ? false : url.get("desc") == null ? DEFAULT_SORT[view][1] : url.get("desc") === "1";

  // one window for both sources; a preset counts back from today
  const start = custom ? from : rangeStart(range);
  const end = custom ? to : null;
  const win: PwaMeterWindow = useMemo(() => ({ start, end }), [start, end]);
  const center = useCenter(start, end, shadow);
  const pwa = usePwaMeter(win);
  const c = center.data;
  const loading = center.loading || pwa.loading;
  const reload = () => {
    void center.reload();
    void pwa.reload();
  };

  const [importing, setImporting] = useState(false);
  const [criteria, setCriteria] = useState<PwaMeterCriteria | null>(null);
  useEffect(() => {
    api.getPwaMeterCriteria().then(setCriteria, () => setCriteria(null));
  }, []);
  const longDays = criteria?.outage_event.long_event_days ?? null;
  const fastDays = criteria?.outage_event.fixed_fast_days ?? null;

  // a tile that opens a list scrolls to it (`#lists`)
  const listsRef = useRef<HTMLDivElement>(null);
  const location = useLocation();
  useEffect(() => {
    if (location.hash === "#lists") listsRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [location.key, location.hash]);
  const listHref = (patch: UrlPatch) => {
    const p = new URLSearchParams(url);
    for (const k of ["sort", "desc", "show"]) p.delete(k);
    for (const [k, v] of Object.entries(patch)) {
      if (v == null || v === "" || v === false) p.delete(k);
      else p.set(k, String(v));
    }
    return `?${p.toString()}#lists`;
  };

  // ---- inverter side
  const m = c?.money;
  const spec = useMemo(() => (c ? lossSpec(c) : null), [c]);
  const totals = c?.loss_by_cause.totals ?? [];
  const totalThb = totals.reduce((s, t) => s + (t.thb_est ?? 0), 0);
  const famLabel = (k: string) => c?.loss_by_cause.families.find((f) => f.key === k)?.label ?? k;

  // ---- PWA meter report
  const sites = useMemo(() => pwa.data?.summary.sites ?? [], [pwa.data]);
  const inPhase = useMemo(() => sites.filter((r) => phase === ALL || r.phase === Number(phase)), [sites, phase]);
  const siteByPlant = useMemo(() => {
    const map = new Map<number, PwaMeterSiteSummary>();
    for (const s of sites) if (s.growatt_plant_id != null) map.set(s.growatt_plant_id, s);
    return map;
  }, [sites]);
  const dataEnd = pwa.data?.summary.window.end ?? null;
  const meterMwh = sum(inPhase, (r) => r.meter_mwh);
  const lossThb = sum(inPhase, (r) => r.loss_thb);
  const split = [
    { key: "curtail", label: "Curtailment", note: "PM matter, not an O&M KPI", mwh: sum(inPhase, (r) => r.curtailment_loss_mwh), color: "bg-sky-400" },
    { key: "outage", label: "Outage", note: "Meter and inverter both < 1 kWh", mwh: sum(inPhase, (r) => r.outage_loss_mwh), color: "bg-red-400" },
    { key: "under", label: "Under-performance", note: "Below 95 % of the phase's free-running sites", mwh: sum(inPhase, (r) => r.under_loss_mwh), color: "bg-amber-400" },
  ];
  const splitMax = Math.max(0, ...split.map((s) => s.mwh ?? 0));
  const omSites = inPhase.filter((r) => r.owner?.includes("O&M")).length;
  const issueSites = inPhase.filter((r) => r.issues.length).length;
  const pmSites = inPhase.filter((r) => r.owner?.includes("PM")).length;
  const phases = (pwa.data?.summary.phases ?? []).filter((p) => phase === ALL || p.phase === Number(phase));

  // ---- charts
  const daily = pwa.data?.daily ?? null;
  const phaseNo = phase === ALL ? null : Number(phase);
  const fleetSpec = useMemo(() => (daily ? fleetDailySpec(daily, phaseNo) : null), [daily, phaseNo]);
  const regSpec = useMemo(() => regionSpec(inPhase), [inPhase]);
  const plantSpec = useMemo(() => (c ? topPlantsSpec(c.plants) : null), [c]);
  const heatOrder = useMemo(() => inPhase.map((r) => r.site_id), [inPhase]);
  const pwaLoading = pwa.loading && !pwa.data;
  const noReport = "No meter report days in this period";

  // ---- the lists
  const words = useMemo(() => query.trim().toLowerCase().split(/\s+/).filter(Boolean), [query]);
  const has = useCallback((text: string) => words.every((w) => text.toLowerCase().includes(w)), [words]);
  const matchSite = useCallback(
    (r: { phase: number; name: string; site_id: string; region: string | null }) => (phase === ALL || r.phase === Number(phase)) && has(`${r.name} ${r.site_id} ${r.region ?? ""}`),
    [phase, has]
  );
  const issueRows = useMemo(() => (c?.issues.top ?? []).filter((i) => has(`${i.plant_name ?? ""} ${i.inverter_name ?? ""} ${i.device_sn ?? ""} ${i.name} ${i.rule}`)), [c, has]);
  const plantRows = useMemo(
    () => byKey((c?.plants ?? []).filter((r) => has(`${r.name} ${r.plant_id}`)), (r) => plantSortValue(r, pick(sortKey, PlantSortKeys, "lost"), siteByPlant), desc),
    [c, has, sortKey, desc, siteByPlant]
  );
  const siteRows = useMemo(() => {
    const rows = sites.filter(
      (r) => matchSite(r) && (show === "all" || (show === "issues" && r.issues.length > 0) || (show === "om" && !!r.owner?.includes("O&M")) || (show === "pm" && !!r.owner?.includes("PM")))
    );
    return byKey(rows, (r) => siteSortValue(r, pick(sortKey, SiteSortKeys, "rank")), desc);
  }, [sites, matchSite, show, sortKey, desc]);
  const outageAll = useMemo(() => (pwa.data?.outages ?? []).filter((r) => phase === ALL || r.phase === Number(phase)), [pwa.data, phase]);
  const outageRows = useMemo(() => byKey((pwa.data?.outages ?? []).filter(matchSite), (r) => outageSortValue(r, pick(sortKey, OutageSortKeys, "days")), desc), [pwa.data, matchSite, sortKey, desc]);
  const checkRows = useMemo(() => byKey((pwa.data?.checks ?? []).filter(matchSite), (r) => checkSortValue(r, pick(sortKey, CheckSortKeys, "gap")), desc), [pwa.data, matchSite, sortKey, desc]);
  const mttr = outageAll.length ? outageAll.reduce((s, e) => s + e.days, 0) / outageAll.length : null;
  const longCount = longDays != null ? outageAll.filter((e) => e.days >= longDays).length : null;
  const fastPct = fastDays != null && outageAll.length ? (100 * outageAll.filter((e) => e.days <= fastDays).length) / outageAll.length : null;

  const meterView = METER_VIEWS.includes(view);
  const rowsShown = { issues: issueRows.length, plants: plantRows.length, sites: siteRows.length, outages: outageRows.length, meter: checkRows.length }[view];
  const viewLoading = meterView ? pwa.loading && !pwa.data : center.loading && !c;
  const anyFilter = query.trim() !== "" || (meterView && phase !== ALL) || (view === "sites" && show !== "all");
  const cnt = (ready: unknown, v: number) => (ready ? fmtInt(v) : "—"); // not read yet ≠ none

  const switchView = (v: string) => setUrl({ view: v === "issues" ? null : v, sort: null, desc: null, show: v === "sites" && show !== "all" ? show : null });
  const onSort = (k: string) => {
    if (view === "issues") return;
    // a new column starts worst-first, except names, rank and dates
    const nextDesc = k === sortKey ? !desc : !["name", "rank", "start", "visit"].includes(k);
    setUrl({ sort: k === DEFAULT_SORT[view][0] ? null : k, desc: nextDesc ? "1" : "0" });
  };
  const openSite = (id: string) => setUrl({ site: id });

  const exportCsv = () => {
    const tag = `${c?.window.start ?? start ?? "start"}_${c?.window.end ?? end ?? "end"}`;
    if (view === "issues")
      downloadCsv(
        `om-center-issues-${tag}.csv`,
        ["id", "tier", "safety", "rule", "issue", "plant_id", "plant", "inverter", "device_sn", "string_no", "thb_per_day_est", "thb_total_est", "lost_kwh_per_day_est", "age_days", "status", "ack_by", "next_visit", "cost_of_waiting_thb_est", "shadow"],
        issueRows.map((i) => [i.id, i.tier, i.safety ? 1 : 0, i.rule, i.name, i.plant_id, i.plant_name, i.inverter_name, i.device_sn, i.string_no, i.thb_per_day_est, i.thb_total_est, i.lost_kwh_est, i.age_days, i.status, i.ack_by, i.next_visit, i.cost_of_waiting_thb_est, i.shadow ? 1 : 0])
      );
    else if (view === "plants")
      downloadCsv(
        `om-center-plants-${tag}.csv`,
        ["plant_id", "name", "capacity_kwp", "energy_kwh", "lost_kwh_est", "lost_thb_est", "loss_share_pct_est", "thb_per_day_now_est", "active_issues", "availability_pct", "epi_median_modelled", "pr_temp_corrected_median_pct", "pwa_site_id", "meter_vs_contract_pct_modelled", "days_since_cleaning", "next_visit", "om_spend_thb_entered"],
        plantRows.map((r) => [r.plant_id, r.name, r.capacity_kwp, r.energy_kwh, r.lost_kwh_est, r.lost_thb_est, r.loss_share_pct, r.thb_per_day_est, r.active_issues, r.availability_pct, r.epi_median, r.pr_temp_corrected_median_pct, siteByPlant.get(r.plant_id)?.site_id ?? null, siteByPlant.get(r.plant_id)?.vs_contract_pct ?? null, r.days_since_cleaning, r.next_visit, r.spend_thb])
      );
    else if (view === "sites")
      downloadCsv(
        `pwa-meter-sites-${tag}.csv`,
        ["rank", "site_id", "phase", "name", "region", "kwp", "growatt_plant_id", "days", "meter_mwh", "contract_mwh_modelled", "pvsyst_mwh_modelled", "vs_contract_pct", "vs_pvsyst_pct", "yield_kwh_kwp", "availability_pct", "data_availability_pct", "outage_days", "data_gap_days", "curtailment_note_days", "curtailed", "curtailment_loss_mwh_est", "outage_loss_mwh_est", "under_loss_mwh_est", "loss_thb_est", "issues", "owner"],
        siteRows.map((r) => [r.rank, r.site_id, r.phase, r.name, r.region, r.kwp, r.growatt_plant_id, r.days, r.meter_mwh, r.contract_mwh, r.pvsyst_mwh, r.vs_contract_pct, r.vs_pvsyst_pct, r.yield_kwh_kwp, r.availability_pct, r.data_availability_pct, r.outage_days, r.data_gap_days, r.curtailment_note_days, r.curtailed ? 1 : 0, r.curtailment_loss_mwh, r.outage_loss_mwh, r.under_loss_mwh, r.loss_thb, r.issues.join(" | "), r.owner])
      );
    else if (view === "outages")
      downloadCsv(
        `pwa-meter-outages-${tag}.csv`,
        ["site_id", "phase", "name", "region", "start", "end", "days", "cause", "lost_mwh_est", "lost_thb_est", "note"],
        outageRows.map((r) => [r.site_id, r.phase, r.name, r.region, r.start, r.end, r.days, r.cause, r.lost_mwh, r.lost_thb, r.note])
      );
    else
      downloadCsv(
        `pwa-meter-check-${tag}.csv`,
        ["site_id", "phase", "name", "region", "median_ratio_pct", "p05_ratio_pct", "low_days", "high_days", "inverter_missing_days", "meter_missing_days", "gap_mwh_est", "gap_thb_est", "flags"],
        checkRows.map((r) => [r.site_id, r.phase, r.name, r.region, r.median_ratio_pct, r.p05_ratio_pct, r.low_days, r.high_days, r.inverter_missing_days, r.meter_missing_days, r.gap_mwh, r.gap_thb, r.flags.join(" | ")])
      );
  };

  const emptyTitle =
    view === "issues"
      ? !c ? "Not available" : query.trim() ? "No matching issues" : "No active issues"
      : view === "plants"
        ? !c ? "Not available" : query.trim() ? "No plant matches the search" : "No plants"
        : !pwa.data ? "Report unavailable" : !sites.length ? "No meter report days in this period" : view === "outages" ? "No outage events" : "No matching sites";
  const emptyText =
    view === "issues" && c && !query.trim()
      ? admin && (c.shadow_hidden ?? 0) > 0 ? "Every active issue is from a rule in shadow mode." : "The decision rules have nothing open on these plants."
      : meterView && pwa.data && !sites.length
        ? admin ? "Import the report (Import report), or widen the period: the report is imported monthly." : "None of your plants is in the report for this period."
        : null;
  const footnote = {
    issues: "Active issues: safety first, then tier, then ฿ / day (mean of the last 3 days each fired). Cost of waiting = ฿ / day × days until the plant's next planned visit. All ฿ are estimates.",
    plants: "Inverter side. ฿ lost counts each kWh once across overlapping rules. EPI and PR′ are modelled medians of the period. Meter vs contract comes from the PWA meter report and opens the site's days.",
    sites: "PWA meter report. Losses and ฿ are estimated; contract and PVsyst are modelled. Rank = estimated loss ฿. A site's row opens its days.",
    outages: `Consecutive outage days of a site (meter and inverter both < 1 kWh). Cause = first keyword group in the notes.${longDays != null ? ` Red = ${longDays} days or more.` : ""}`,
    meter: "Meter ÷ inverter per site, judged on productive days. The gap is the energy the meter may have missed (estimated).",
  }[view];

  return (
    <div className="flex flex-col gap-5">
      {/* ---- header: title, period, actions */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-lg font-semibold">O&amp;M Dashboard</h1>
          {c && <Badge variant="neutral">{c.scope === "fleet" ? `Fleet · ${fmtInt(c.plant_count)} plants` : `Your plants · ${fmtInt(c.plant_count)}`}</Badge>}
          {pwa.data && (
            <Badge variant={dataEnd ? "neutral" : "warn"} title="The PWA meter report is imported monthly; nothing after this day is in the app yet">
              {dataEnd ? `Meter report to ${fmtDayLong(dataEnd)}` : "No meter report days in this period"}
            </Badge>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Select value={custom ? "custom" : range} onValueChange={(v) => v !== "custom" && setUrl({ range: v === "mtd" ? null : v, from: null, to: null })}>
            <SelectTrigger size="sm" className="w-40" aria-label="Period">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {RANGES.map((r) => (
                <SelectItem key={r} value={r}>
                  {RANGE_LABEL[r]}
                </SelectItem>
              ))}
              {custom && (
                <>
                  <SelectSeparator />
                  <SelectItem value="custom">Custom</SelectItem>
                </>
              )}
            </SelectContent>
          </Select>
          <Input type="date" aria-label="From" className="h-8 w-36 [color-scheme:dark]" value={start ?? ""} max={to ?? c?.window.today} onChange={(e) => setUrl({ from: pickDay(e.target.value), to: to ?? c?.window.end ?? null, range: null })} />
          <Input type="date" aria-label="To" className="h-8 w-36 [color-scheme:dark]" value={to ?? c?.window.end ?? ""} min={start ?? undefined} max={c?.window.today} onChange={(e) => setUrl({ to: pickDay(e.target.value), from: start, range: null })} />
          {admin && (
            <Button variant={shadow ? "accent" : "outline"} size="sm" aria-pressed={shadow} title="Also count issues of rules still in shadow mode (not calibrated yet, hidden from engineers)" onClick={() => setUrl({ shadow: !shadow })}>
              Shadow rules {shadow ? "on" : "off"}
            </Button>
          )}
          <Button variant="outline" size="sm" onClick={reload} disabled={loading}>
            {loading && <Spinner data-icon="inline-start" className="size-3" />}
            {loading ? "Refreshing…" : "Refresh"}
          </Button>
          {admin && (
            <Button size="sm" onClick={() => setImporting(true)}>
              Import report
            </Button>
          )}
        </div>
      </div>

      {center.error && (
        <Alert variant="destructive">
          <AlertTitle>Could not load the inverter-side figures</AlertTitle>
          <AlertDescription>{center.error}</AlertDescription>
        </Alert>
      )}
      {pwa.error && (
        <Alert variant="destructive">
          <AlertTitle>Could not load the PWA meter report</AlertTitle>
          <AlertDescription>{pwa.error}</AlertDescription>
        </Alert>
      )}
      {c && admin && c.meta.tariff_source === "default" && (
        <Alert>
          <AlertTitle>Inverter-side baht use the default tariff</AlertTitle>
          <AlertDescription>
            No tariff has been saved yet. Save the real tariff and per-plant rates in{" "}
            <Link to="/rules" className="underline">
              Rule review
            </Link>
            .
          </AlertDescription>
        </Alert>
      )}

      {/* ---- figures: two sources and the team's work, never added together */}
      <div className="grid gap-x-5 gap-y-5 xl:grid-cols-[5fr_5fr_2.4fr]">
        <Group title="Inverter side" source="Decision rules · ฿ at the tariff" cols="sm:grid-cols-4 xl:grid-cols-2">
          <StatTile
            label="Losing now"
            tag="est."
            value={m?.losing_now_thb_per_day_est == null ? "—" : thb(m.losing_now_thb_per_day_est)}
            unit="/ day"
            tone={m?.losing_now_thb_per_day_est ? "text-red-300" : undefined}
            href={listHref({ view: null })}
            linkLabel="Open the issues to fix first"
            footer={
              <>
                <span title={EST}>{cnt(m, m?.active_issues ?? 0)} active issues</span>
                {(m?.safety_issues ?? 0) > 0 && <span className="text-red-300">{fmtInt(m?.safety_issues)} safety</span>}
              </>
            }
          />
          <StatTile
            label="Lost in period"
            tag="est."
            value={m?.lost_thb_est == null ? "—" : thb(m.lost_thb_est)}
            meter={m?.loss_share_pct != null ? <Meter segments={[{ pct: m.loss_share_pct, className: "bg-red-400" }]} title={`${fmt(m.loss_share_pct, 2)} % of produced + lost kWh`} /> : undefined}
            href={listHref({ view: "plants" })}
            linkLabel="Open the plants, most lost first"
            footer={<span title={EST}>{!m ? "—" : m.lost_kwh_est == null ? "No priced loss" : `${fmt(m.lost_kwh_est, 0)} kWh${m.loss_share_pct != null ? ` · ${fmt(m.loss_share_pct, 1)} % of energy` : ""}`}</span>}
          />
          <StatTile
            label="Produced"
            value={m?.produced_kwh == null ? "—" : fmt(m.produced_kwh / 1000, 1)}
            unit="MWh"
            footer={<span title="Measured: each inverter's day energy, summed over the period">Measured, inverters</span>}
          />
          <StatTile
            label="Availability"
            value={m?.availability_pct == null ? "—" : fmt(m.availability_pct, 2)}
            unit="%"
            tone={m?.availability_pct == null ? undefined : m.availability_pct >= 99 ? "text-emerald-300" : m.availability_pct < 95 ? "text-red-300" : "text-amber-300"}
            meter={m?.availability_pct != null ? <Meter segments={[{ pct: m.availability_pct, className: "bg-emerald-400" }]} mark={99} title="Tick = 99 %" /> : undefined}
            footer={<span title="Inverter minutes not in fault / off / standby ÷ daylight minutes with data. Power limiting is not downtime.">Time based{m?.limited_min ? ` · ${fmtInt(Math.round(m.limited_min / 60))} h limited` : ""}</span>}
          />
        </Group>

        <Group
          title="PWA meter"
          source="Billing report · ฿ at the contract price"
          cols="sm:grid-cols-4 xl:grid-cols-2"
          badge={
            <Select value={phase} onValueChange={(v) => setUrl({ phase: v === ALL ? null : v })}>
              <SelectTrigger size="sm" className="h-6 w-28 text-[11px]" aria-label="Phase">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>Phases 1–2</SelectItem>
                <SelectSeparator />
                <SelectItem value="1">Phase 1</SelectItem>
                <SelectItem value="2">Phase 2</SelectItem>
              </SelectContent>
            </Select>
          }
        >
          <StatTile
            label="Billed energy"
            value={meterMwh == null ? "—" : fmt(meterMwh, 1)}
            unit="MWh"
            href={listHref({ view: "sites" })}
            linkLabel="Open the meter sites"
            footer={<span title="Measured: the Cewe meter kWh of the report days in the period">{cnt(pwa.data, inPhase.length)} sites · meter</span>}
          />
          <StatTile
            label="Estimated loss"
            tag="est."
            value={lossThb == null ? "—" : thb(lossThb)}
            tone={lossThb ? "text-red-300" : undefined}
            href={listHref({ view: "sites" })}
            linkLabel="Open the meter sites, largest loss first"
            footer={<span title={PWA_EST}>Curtailment, outage, under-performance</span>}
          />
          <StatTile
            label="O&M to act"
            value={cnt(pwa.data, omSites)}
            unit="sites"
            tone={omSites ? "text-amber-300" : undefined}
            href={listHref({ view: "sites", show: "om" })}
            linkLabel="Open the sites O&M has to act on"
            footer={
              <span title="Sites with an issue; PM = curtailment loss over the threshold, a PM matter">
                {cnt(pwa.data, issueSites)} with issues · {cnt(pwa.data, pmSites)} PM
              </span>
            }
          />
          <StatTile
            label="Outage events"
            value={cnt(pwa.data, outageAll.length)}
            href={listHref({ view: "outages" })}
            linkLabel="Open the outage events"
            footer={
              outageAll.length ? (
                <span title={`Mean event length; fixed fast = ${fastDays ?? "—"} days or less, long = ${longDays ?? "—"} days or more (criteria file)`}>
                  MTTR {fmt(mttr, 1)} d · {fastPct == null ? "—" : `${fmt(fastPct, 0)} %`} fast · {longCount ?? "—"} long
                </span>
              ) : (
                <span>{pwa.data ? "None in the period" : "—"}</span>
              )
            }
          />
        </Group>

        <Group title="Work" source="Entered by the team" cols="sm:grid-cols-4 xl:grid-cols-1">
          <StatTile
            label="O&M spend"
            value={m?.spend_thb == null ? "—" : thb(m.spend_thb)}
            footer={<span title={ENTERED}>{!m ? "—" : m.spend_events ? `${fmtInt(m.spend_events_priced)} of ${fmtInt(m.spend_events)} Site log events have a cost` : "No Site log events"}</span>}
          />
          <StatTile
            label="Committed"
            value={m?.committed_thb == null ? "—" : thb(m.committed_thb)}
            href="/calendar"
            linkLabel="Open the Calendar"
            footer={<span title={ENTERED}>{!m ? "—" : m.committed_tasks ? `${fmtInt(m.committed_tasks_priced)} of ${fmtInt(m.committed_tasks)} open tasks have a cost` : "No open tasks"}</span>}
          />
        </Group>
      </div>

      {/* ---- where the loss is, per source */}
      <div className="grid gap-4 xl:grid-cols-3">
        <Card className="xl:col-span-2">
          <CardHeader>
            <CardTitle className="flex flex-wrap items-center gap-2">
              Loss by cause
              <span className="text-[11px] font-normal text-muted-foreground">Inverter side</span>
              <Badge variant="neutral" title={EST}>
                Estimated
              </Badge>
            </CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            {spec ? (
              <>
                <PanelChart spec={spec} height={250} />
                <div className="flex flex-wrap gap-x-5 gap-y-1.5 text-xs">
                  {totals.map((t) => (
                    <span key={t.family} className="flex items-center gap-1.5">
                      <span className="inline-block size-2.5 rounded-sm" style={{ background: FAMILY_COLOR[t.family] }} />
                      <span className="text-muted-foreground">{famLabel(t.family)}</span>
                      <span className="num font-medium">{thb(t.thb_est)}</span>
                      <span className="num text-muted-foreground">
                        {fmt(t.kwh_est, 0)} kWh{totalThb > 0 ? ` · ${fmt(((t.thb_est ?? 0) / totalThb) * 100, 0)} %` : ""}
                      </span>
                    </span>
                  ))}
                </div>
              </>
            ) : center.loading && !c ? (
              <SkeletonRows rows={5} />
            ) : (
              <Empty className="py-10">
                <EmptyHeader>
                  <EmptyTitle>No priced loss in this period</EmptyTitle>
                  <EmptyDescription>
                    No issue with an estimated loss fired on these plants between {fmtDay(c?.window.start)} and {fmtDay(c?.window.end)}.
                  </EmptyDescription>
                </EmptyHeader>
              </Empty>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex flex-wrap items-center gap-2">
              Loss by cause
              <span className="text-[11px] font-normal text-muted-foreground">PWA meter</span>
              <Badge variant="neutral" title={PWA_EST}>
                Estimated
              </Badge>
            </CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            {pwa.loading && !pwa.data ? (
              <SkeletonRows rows={3} />
            ) : splitMax > 0 ? (
              <>
                {split.map((s) => (
                  <div key={s.key} className="flex flex-col gap-1">
                    <div className="flex items-baseline justify-between gap-2 text-xs">
                      <span>{s.label}</span>
                      <span className="num font-medium">{s.mwh == null ? "—" : `${fmt(s.mwh, 1)} MWh`}</span>
                    </div>
                    <div className="h-2 overflow-hidden rounded-full bg-white/[0.06]">
                      <div className={`h-full rounded-full ${s.color}`} style={{ width: `${s.mwh ? Math.max(1, (s.mwh / splitMax) * 100) : 0}%` }} />
                    </div>
                    <span className="text-[11px] text-muted-foreground">{s.note}</span>
                  </div>
                ))}
                <p className="border-t pt-3 text-xs text-muted-foreground">
                  Total <span className="num font-medium text-foreground">{thb(lossThb)}</span> at the contract's book price
                  {criteria ? ` (฿${fmt(criteria.tariff.book_price_thb_per_kwh, 4)} / kWh)` : ""}. Not comparable with the inverter-side baht, which use the tariff.
                </p>
              </>
            ) : (
              <Empty className="py-10">
                <EmptyHeader>
                  <EmptyTitle>{pwa.data && sites.length ? "No estimated loss" : "No meter report days in this period"}</EmptyTitle>
                  {pwa.data && !sites.length && <EmptyDescription>The report is imported monthly{dataEnd ? "" : "; try a longer period"}.</EmptyDescription>}
                </EmptyHeader>
              </Empty>
            )}
          </CardContent>
        </Card>
      </div>

      {/* ---- charts: where to look, per source */}
      <div className="grid gap-4 xl:grid-cols-2">
        <ChartCard
          title="Strategy matrix"
          source="PWA meter"
          badge="Estimated"
          badgeTitle={PWA_EST}
          loading={pwaLoading}
          empty={!inPhase.length ? noReport : null}
          note="One dot per site: lower right loses the most and produces the least against PVsyst (modelled). Dot size follows kWp. Click a dot for the site's days."
        >
          <Legend items={OWNERS} />
          <StrategyMatrix sites={inPhase} onOpen={openSite} />
        </ChartCard>
        {admin ? (
          <ChartCard title="Fleet by day" source="PWA meter" badge="Contract modelled" badgeTitle="Measured meter kWh; the contract's energy is modelled" loading={pwaLoading} empty={!fleetSpec ? noReport : null}>
            <PanelChart spec={fleetSpec} height={372} />
          </ChartCard>
        ) : (
          <ChartCard title="Loss by region" source="PWA meter" badge="Estimated" badgeTitle={PWA_EST} loading={pwaLoading} empty={!inPhase.length ? noReport : !regSpec ? "No estimated loss" : null}>
            <PanelChart spec={regSpec} height={300} />
          </ChartCard>
        )}
        <ChartCard
          title="Yield by site and day"
          source="PWA meter"
          badge="Measured"
          badgeTitle="Meter kWh ÷ kWp per report day"
          className="xl:col-span-2"
          loading={pwaLoading}
          empty={!daily || !daily.days.length || !heatOrder.length ? noReport : null}
          note="One row per site, the largest estimated loss on top; one column per report day (kWh/kWp). Click a row for the site's days."
        >
          <Legend items={HEAT_LEGEND} />
          {daily && <YieldHeatmap daily={daily} order={heatOrder} onOpen={openSite} />}
        </ChartCard>
        {admin && (
          <ChartCard title="Loss by region" source="PWA meter" badge="Estimated" badgeTitle={PWA_EST} loading={pwaLoading} empty={!inPhase.length ? noReport : !regSpec ? "No estimated loss" : null}>
            <PanelChart spec={regSpec} height={300} />
          </ChartCard>
        )}
        <ChartCard
          title="Plants losing the most"
          source="Inverter side"
          badge="Estimated"
          badgeTitle={EST}
          className={admin ? undefined : "xl:col-span-2"}
          loading={center.loading && !c}
          empty={!plantSpec ? "No priced loss in this period" : null}
        >
          <PanelChart spec={plantSpec} height={300} />
        </ChartCard>
      </div>

      {/* ---- the lists */}
      <Card className="scroll-mt-4 gap-0 py-0" ref={listsRef} id="lists">
        <div className="flex flex-wrap items-center justify-between gap-x-3 border-b px-4 pt-2 sm:px-5">
          <Tabs value={view} onValueChange={switchView}>
            <TabsList variant="line" className="border-0 p-0">
              <TabsTrigger value="issues" className="px-3 py-2.5 text-sm">
                Fix first <span className="num text-muted-foreground">{cnt(c, c?.issues.total ?? 0)}</span>
              </TabsTrigger>
              <TabsTrigger value="plants" className="px-3 py-2.5 text-sm">
                Plants <span className="num text-muted-foreground">{cnt(c, c?.plants.length ?? 0)}</span>
              </TabsTrigger>
              <TabsTrigger value="sites" className="px-3 py-2.5 text-sm">
                Meter sites <span className="num text-muted-foreground">{cnt(pwa.data, inPhase.length)}</span>
              </TabsTrigger>
              <TabsTrigger value="outages" className="px-3 py-2.5 text-sm">
                Outage events <span className="num text-muted-foreground">{cnt(pwa.data, outageAll.length)}</span>
              </TabsTrigger>
              <TabsTrigger value="meter" className="px-3 py-2.5 text-sm">
                Meter check <span className="num text-muted-foreground">{cnt(pwa.data, (pwa.data?.checks ?? []).filter((r) => (phase === ALL || r.phase === Number(phase)) && r.flags.length).length)}</span>
              </TabsTrigger>
            </TabsList>
          </Tabs>
          <div className="flex flex-wrap items-center gap-2 pb-2">
            {view === "sites" && (
              <Select value={show} onValueChange={(v) => setUrl({ show: v === "all" ? null : v })}>
                <SelectTrigger size="sm" className="w-40" aria-label="Show sites">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {SHOW.map((s) => (
                    <SelectItem key={s} value={s}>
                      {SHOW_LABEL[s]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
            <Input className="h-8 w-52" placeholder={meterView ? "Search site, id, region" : view === "plants" ? "Search plant" : "Search plant, inverter, rule"} value={query} onChange={(e) => setUrl({ q: e.target.value })} aria-label="Search the list" />
            {anyFilter && (
              <Button variant="ghost" size="sm" onClick={() => setUrl({ q: null, phase: null, show: null })}>
                Clear
              </Button>
            )}
            <Button variant="outline" size="sm" onClick={exportCsv} disabled={!rowsShown}>
              Export CSV
            </Button>
          </div>
        </div>

        {view === "sites" && admin && phases.length > 0 && (
          <div className="border-b">
            <p className="eyebrow px-4 pt-3 sm:px-5">Phase totals</p>
            <PhaseTotals phases={phases} />
          </div>
        )}
        {meterView && !admin && pwa.data && sites.length > 0 && (
          <p className="border-b px-4 py-2 text-[11px] text-muted-foreground sm:px-5">Phase totals are for admins: they include plants you are not assigned. Losses still compare each site with every site of its phase.</p>
        )}

        <CardContent className="max-h-[70vh] overflow-auto px-0">
          {rowsShown === 0 ? (
            viewLoading ? (
              <SkeletonRows rows={8} className="p-4" />
            ) : (
              <Empty className="py-16">
                <EmptyHeader>
                  <EmptyTitle>{emptyTitle}</EmptyTitle>
                  {emptyText && <EmptyDescription>{emptyText}</EmptyDescription>}
                </EmptyHeader>
              </Empty>
            )
          ) : view === "issues" ? (
            <IssuesTable rows={issueRows} />
          ) : view === "plants" ? (
            <PlantsTable rows={plantRows} sort={pick(sortKey, PlantSortKeys, "lost")} desc={desc} onSort={onSort} sites={siteByPlant} onOpenSite={openSite} />
          ) : view === "sites" ? (
            <SitesTable rows={siteRows} sort={pick(sortKey, SiteSortKeys, "rank")} desc={desc} onSort={onSort} onOpen={openSite} />
          ) : view === "outages" ? (
            <OutagesTable rows={outageRows} sort={pick(sortKey, OutageSortKeys, "days")} desc={desc} onSort={onSort} onOpen={openSite} longDays={longDays ?? Infinity} />
          ) : (
            <MeterCheckTable rows={checkRows} sort={pick(sortKey, CheckSortKeys, "gap")} desc={desc} onSort={onSort} onOpen={openSite} />
          )}
        </CardContent>
        <CardContent className="border-t py-2.5 text-[11px] text-muted-foreground">
          {view === "issues" && c && c.issues.total > c.issues.top.length ? `The ${c.issues.top.length} most urgent of ${fmtInt(c.issues.total)}. ` : ""}
          {footnote}
        </CardContent>
      </Card>

      <ImportDialog open={importing} onClose={() => setImporting(false)} onImported={() => void pwa.reload()} />
      <SiteDialog
        siteId={siteId}
        window={win}
        row={sites.find((r) => r.site_id === siteId)}
        check={pwa.data?.checks.find((r) => r.site_id === siteId)}
        outages={(pwa.data?.outages ?? []).filter((r) => r.site_id === siteId)}
        onClose={() => setUrl({ site: null })}
      />
    </div>
  );
};

export default OmCenterPage;
