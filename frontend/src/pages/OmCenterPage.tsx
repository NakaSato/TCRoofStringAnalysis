/**
 * Operations → Engineering O&M (`/center`, everyone, scoped to the user's plants): one page for a
 * period, from two stored sources that are shown side by side and never added together:
 *
 * - **Billing** (PWA meter report imported from the Excel workbooks, `/pwa/meter/*`, phases 1–2,
 *   imported monthly): billed meter energy per month at the contract's book price against the
 *   contract (modelled), then the report's lists: sites, outage events, the meter vs inverter
 *   check and meter vs Growatt (the Cewe meter day against Growatt's own day energy, both
 *   measured, `center/vsGrowatt.tsx`). Admins import the workbooks here.
 * - **Finance** (`center/finance.tsx`): that billing against the O&M spend entered in the Site log
 *   (`spend_by_month` of `/growatt/center`), per month and per report site: spend ÷ billed, ฿ / kWp,
 *   ฿ / MWh, billed − spend. Measured × book price against entered costs, nothing estimated.
 * - **Inverter side** (`/growatt/center`, the stored Growatt dataset): produced energy, availability,
 *   the decision rules' active issues and one row per plant.
 *
 * Only stored data and the imported report: no estimated lost kWh / ฿ (no forecast of what the plants
 * should have made), contract / PVsyst / EPI / PR′ labelled modelled, costs entered. One period for
 * both (the report lags, so its badge says how far it reaches). DB only, nothing polls. Engineers
 * see their plants, no phase totals; issues of rules in shadow mode are never counted here.
 * Pieces in `pages/center/` and `pages/pwaMeter/`; docs/plans/om-center-dashboard.md.
 *
 * URL: `range` (mtd | 7d | 30d | 90d | ytd), `from`, `to` (YYYY-MM-DD, custom),
 * `view` (issues | plants | billing | finance | sites | outages | meter | growatt), `q`, `phase`, `show`
 * (sites view), `month` (billing view, YYYY-MM), `sort`, `desc`, `site` (site detail open).
 * `/pwa-meter` redirects here.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation } from "react-router-dom";
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
import { ENTERED, RANGES, RANGE_LABEL, VIEWS, rangeStart, thb, thbShort } from "./center/format";
import type { Range, View } from "./center/format";
import { IssuesTable, PlantSortKeys, PlantsTable, plantSortValue } from "./center/tables";
import { fleetDailySpec } from "./center/chartSpecs";
import { HEAT_LEGEND, Legend, YieldHeatmap } from "./center/charts";
import { BILLED_HINT, BillSortKeys, BillingTable, billSortValue, billedMonthSpec, fmtMonth, monthTotals } from "./center/billing";
import { FINANCE_HINT, FinanceSortKeys, FinanceTable, SPEND_GROUPS, financeModel, financeMonthSpec, financeSortValue } from "./center/finance";
import { GROWATT_HINT, VsGrowattSortKeys, VsGrowattTable, vsGrowattDaySpec, vsGrowattDays, vsGrowattSortValue } from "./center/vsGrowatt";
import { useI18n } from "../i18n";

const ALL = "all";
const METER_VIEWS: readonly View[] = ["billing", "finance", "sites", "outages", "meter", "growatt"];
/** default sort key and direction per view (the issues list keeps the backend's order) */
const DEFAULT_SORT: Record<Exclude<View, "issues">, readonly [string, boolean]> = {
  plants: ["issues", true],
  billing: ["month", true],
  finance: ["spend", true],
  sites: ["yield", false],
  outages: ["days", true],
  meter: ["low", true],
  growatt: ["median", false],
};
const SORT_KEYS: Record<Exclude<View, "issues">, readonly string[]> = {
  plants: PlantSortKeys,
  billing: BillSortKeys,
  finance: FinanceSortKeys,
  sites: SiteSortKeys,
  outages: OutageSortKeys,
  meter: CheckSortKeys,
  growatt: VsGrowattSortKeys,
};
const SHOW_LABEL: Record<Show, string> = { all: "All sites", issues: "With issues", om: "O&M to act", pm: "PM (curtailment)" };

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
  const { t } = useI18n();
  const { user } = useAppContext();
  const admin = isAdmin(user);
  const [url, setUrl] = useUrlState();
  const from = pickDay(url.get("from"));
  const to = pickDay(url.get("to"));
  const custom = from != null || to != null;
  const range: Range = pick(url.get("range"), RANGES, "mtd");
  const view: View = pick(url.get("view"), VIEWS, "issues");
  const query = url.get("q") ?? "";
  const phase = pick(url.get("phase"), PHASES, ALL);
  const show: Show = pick(url.get("show"), SHOW, "all");
  const siteId = url.get("site");
  const monthParam = url.get("month");
  const sortKey = view === "issues" ? "" : pick(url.get("sort"), SORT_KEYS[view], DEFAULT_SORT[view][0] as never);
  const desc = view === "issues" ? false : url.get("desc") == null ? DEFAULT_SORT[view][1] : url.get("desc") === "1";

  // one window for both sources; a preset counts back from today
  const start = custom ? from : rangeStart(range);
  const end = custom ? to : null;
  const win: PwaMeterWindow = useMemo(() => ({ start, end }), [start, end]);
  const center = useCenter(start, end, false); // shadow-mode rules are never counted on this page
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
    for (const k of ["sort", "desc", "show", "month"]) p.delete(k);
    for (const [k, v] of Object.entries(patch)) {
      if (v == null || v === "" || v === false) p.delete(k);
      else p.set(k, String(v));
    }
    return `?${p.toString()}#lists`;
  };

  // ---- inverter side
  const m = c?.money;

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
  const omSites = inPhase.filter((r) => r.owner?.includes("O&M")).length;
  const issueSites = inPhase.filter((r) => r.issues.length).length;
  const pmSites = inPhase.filter((r) => r.owner?.includes("PM")).length;
  const flaggedChecks = (pwa.data?.checks ?? []).filter((r) => (phase === ALL || r.phase === Number(phase)) && r.flags.length);
  // ---- meter vs Growatt (both measured)
  const vsg = pwa.data?.vsGrowatt ?? null;
  const vsgSites = useMemo(() => (vsg?.sites ?? []).filter((r) => phase === ALL || r.phase === Number(phase)), [vsg, phase]);
  const vsgMeter = sum(vsgSites, (r) => r.meter_kwh);
  const vsgGrowatt = sum(vsgSites, (r) => r.growatt_kwh);
  const vsgRatio = vsgMeter != null && vsgGrowatt ? (100 * vsgMeter) / vsgGrowatt : null;
  const vsgFlagged = vsgSites.filter((r) => r.flags.length).length;
  const vsgCompared = vsgSites.filter((r) => r.compared_days > 0).length;
  const phases = (pwa.data?.summary.phases ?? []).filter((p) => phase === ALL || p.phase === Number(phase));

  // ---- billing: the meter report by calendar month, and the causes of its shortfall
  const bill = pwa.data?.billing ?? null;
  const billRowsAll = useMemo(() => (bill?.rows ?? []).filter((r) => phase === ALL || r.phase === Number(phase)), [bill, phase]);
  const billSites = useMemo(() => (bill?.sites ?? []).filter((r) => phase === ALL || r.phase === Number(phase)), [bill, phase]);
  const months = useMemo(() => monthTotals(billRowsAll, bill?.months ?? []), [billRowsAll, bill]);
  const billMonth = monthParam && bill?.months.includes(monthParam) ? monthParam : ALL;
  const billedKwh = sum(billSites, (r) => r.billed_kwh);
  const billedThb = sum(billSites, (r) => r.billed_thb);
  const contractKwh = sum(billSites, (r) => r.contract_kwh);
  const billedOnContract = sum(billSites, (r) => (r.contract_kwh == null ? null : r.contract_kwh - (r.shortfall_kwh ?? 0)));
  const vsContract = contractKwh && billedOnContract != null ? (100 * billedOnContract) / contractKwh : null;
  const shortKwh = sum(billSites, (r) => r.shortfall_kwh);
  const belowContract = billSites.filter((r) => (r.shortfall_kwh ?? 0) > 0).length;
  const missingDays = billSites.reduce((s, r) => s + r.missing_days, 0);
  const billSpec = useMemo(() => billedMonthSpec(months), [months]);
  // ---- finance: the billing against the O&M spend entered in the Site log (same plants, same months)
  const fin = useMemo(() => financeModel(billRowsAll, billSites, c?.spend_by_month ?? []), [billRowsAll, billSites, c]);
  const finSpec = useMemo(() => financeMonthSpec(fin.months), [fin]);
  const finReady = !!bill && !!c;
  const price = bill?.price_thb_per_kwh ?? criteria?.tariff.book_price_thb_per_kwh ?? null;

  // ---- charts
  const daily = pwa.data?.daily ?? null;
  const phaseNo = phase === ALL ? null : Number(phase);
  const vsgSpec = useMemo(() => (vsg ? vsGrowattDaySpec(vsGrowattDays(vsg.days, phaseNo)) : null), [vsg, phaseNo]);
  const fleetSpec = useMemo(() => (daily ? fleetDailySpec(daily, phaseNo) : null), [daily, phaseNo]);
  // heatmap rows: lowest measured yield first (sites without one last)
  const heatOrder = useMemo(() => byKey(inPhase, (r) => r.yield_kwh_kwp, false).map((r) => r.site_id), [inPhase]);
  const pwaLoading = pwa.loading && !pwa.data;
  const noReport = t("No meter report days in this period");

  // ---- the lists
  const words = useMemo(() => query.trim().toLowerCase().split(/\s+/).filter(Boolean), [query]);
  const has = useCallback((text: string) => words.every((w) => text.toLowerCase().includes(w)), [words]);
  const matchSite = useCallback(
    (r: { phase: number; name: string; site_id: string; region: string | null }) => (phase === ALL || r.phase === Number(phase)) && has(`${r.name} ${r.site_id} ${r.region ?? ""}`),
    [phase, has]
  );
  const issueRows = useMemo(() => (c?.issues.top ?? []).filter((i) => has(`${i.plant_name ?? ""} ${i.inverter_name ?? ""} ${i.device_sn ?? ""} ${i.name} ${i.rule}`)), [c, has]);
  const plantRows = useMemo(
    () => byKey((c?.plants ?? []).filter((r) => has(`${r.name} ${r.plant_id}`)), (r) => plantSortValue(r, pick(sortKey, PlantSortKeys, "issues"), siteByPlant), desc),
    [c, has, sortKey, desc, siteByPlant]
  );
  const siteRows = useMemo(() => {
    const rows = sites.filter(
      (r) => matchSite(r) && (show === "all" || (show === "issues" && r.issues.length > 0) || (show === "om" && !!r.owner?.includes("O&M")) || (show === "pm" && !!r.owner?.includes("PM")))
    );
    return byKey(rows, (r) => siteSortValue(r, pick(sortKey, SiteSortKeys, "yield")), desc);
  }, [sites, matchSite, show, sortKey, desc]);
  const outageAll = useMemo(() => (pwa.data?.outages ?? []).filter((r) => phase === ALL || r.phase === Number(phase)), [pwa.data, phase]);
  const outageRows = useMemo(() => byKey((pwa.data?.outages ?? []).filter(matchSite), (r) => outageSortValue(r, pick(sortKey, OutageSortKeys, "days")), desc), [pwa.data, matchSite, sortKey, desc]);
  const checkRows = useMemo(() => byKey((pwa.data?.checks ?? []).filter(matchSite), (r) => checkSortValue(r, pick(sortKey, CheckSortKeys, "low")), desc), [pwa.data, matchSite, sortKey, desc]);
  const vsgRows = useMemo(() => byKey((vsg?.sites ?? []).filter(matchSite), (r) => vsGrowattSortValue(r, pick(sortKey, VsGrowattSortKeys, "median")), desc), [vsg, matchSite, sortKey, desc]);
  const billRows = useMemo(
    () => byKey(billRowsAll.filter((r) => (billMonth === ALL || r.month === billMonth) && matchSite(r)), (r) => billSortValue(r, pick(sortKey, BillSortKeys, "month")), desc),
    [billRowsAll, billMonth, matchSite, sortKey, desc]
  );
  const financeRows = useMemo(() => byKey(fin.sites.filter(matchSite), (r) => financeSortValue(r, pick(sortKey, FinanceSortKeys, "spend")), desc), [fin, matchSite, sortKey, desc]);
  const mttr = outageAll.length ? outageAll.reduce((s, e) => s + e.days, 0) / outageAll.length : null;
  const longCount = longDays != null ? outageAll.filter((e) => e.days >= longDays).length : null;
  const fastPct = fastDays != null && outageAll.length ? (100 * outageAll.filter((e) => e.days <= fastDays).length) / outageAll.length : null;

  const meterView = METER_VIEWS.includes(view);
  const rowsShown = { issues: issueRows.length, plants: plantRows.length, billing: billRows.length, finance: financeRows.length, sites: siteRows.length, outages: outageRows.length, meter: checkRows.length, growatt: vsgRows.length }[view];
  const viewLoading = meterView ? pwa.loading && !pwa.data : center.loading && !c;
  const anyFilter = query.trim() !== "" || (meterView && phase !== ALL) || (view === "sites" && show !== "all") || (view === "billing" && billMonth !== ALL);
  const cnt = (ready: unknown, v: number) => (ready ? fmtInt(v) : "—"); // not read yet ≠ none

  const switchView = (v: string) =>
    setUrl({ view: v === "issues" ? null : v, sort: null, desc: null, show: v === "sites" && show !== "all" ? show : null, month: v === "billing" && billMonth !== ALL ? billMonth : null });
  const onSort = (k: string) => {
    if (view === "issues") return;
    // a new column starts worst-first, except names and dates; yield and the meter ratio start lowest
    const nextDesc = k === sortKey ? !desc : !["name", "start", "visit", "yield", "median", "ratio"].includes(k);
    setUrl({ sort: k === DEFAULT_SORT[view][0] ? null : k, desc: nextDesc ? "1" : "0" });
  };
  const openSite = (id: string) => setUrl({ site: id });

  const exportCsv = () => {
    const tag = `${c?.window.start ?? start ?? "start"}_${c?.window.end ?? end ?? "end"}`;
    if (view === "issues")
      downloadCsv(
        `om-center-issues-${tag}.csv`,
        ["id", "tier", "safety", "rule", "issue", "plant_id", "plant", "inverter", "device_sn", "string_no", "age_days", "status", "ack_by", "next_visit"],
        issueRows.map((i) => [i.id, i.tier, i.safety ? 1 : 0, i.rule, i.name, i.plant_id, i.plant_name, i.inverter_name, i.device_sn, i.string_no, i.age_days, i.status, i.ack_by, i.next_visit])
      );
    else if (view === "plants")
      downloadCsv(
        `om-center-plants-${tag}.csv`,
        ["plant_id", "name", "capacity_kwp", "energy_kwh", "active_issues", "availability_pct", "epi_median_modelled", "pr_temp_corrected_median_pct", "pwa_site_id", "meter_vs_contract_pct_modelled", "days_since_cleaning", "next_visit", "om_spend_thb_entered"],
        plantRows.map((r) => [r.plant_id, r.name, r.capacity_kwp, r.energy_kwh, r.active_issues, r.availability_pct, r.epi_median, r.pr_temp_corrected_median_pct, siteByPlant.get(r.plant_id)?.site_id ?? null, siteByPlant.get(r.plant_id)?.vs_contract_pct ?? null, r.days_since_cleaning, r.next_visit, r.spend_thb])
      );
    else if (view === "billing")
      downloadCsv(
        `engineering-om-billing-${billMonth === ALL ? tag : billMonth}.csv`,
        ["month", "site_id", "phase", "name", "region", "kwp", "growatt_plant_id", "start", "end", "report_days", "meter_days", "missing_days", "outage_days", "curtailment_note_days", "billed_kwh", "billed_thb_book_price", "contract_kwh_modelled", "vs_contract_pct_modelled", "shortfall_kwh_modelled", "shortfall_thb_modelled"],
        billRows.map((r) => [r.month, r.site_id, r.phase, r.name, r.region, r.kwp, r.growatt_plant_id, r.start, r.end, r.days, r.meter_days, r.missing_days, r.outage_days, r.curtailment_note_days, r.billed_kwh, r.billed_thb, r.contract_kwh, r.vs_contract_pct, r.shortfall_kwh, r.shortfall_thb])
      );
    else if (view === "finance")
      downloadCsv(
        `engineering-om-finance-${tag}.csv`,
        ["site_id", "phase", "name", "region", "kwp", "growatt_plant_id", "billed_kwh", "billed_thb_book_price", "vs_contract_pct_modelled", "om_spend_thb_entered", ...SPEND_GROUPS.map((g) => `spend_${g.key}_thb_entered`), "site_log_events", "site_log_events_priced", "spend_vs_billed_pct", "spend_thb_per_kwp", "billed_minus_spend_thb"],
        financeRows.map((r) => [r.site_id, r.phase, r.name, r.region, r.kwp, r.growatt_plant_id, r.billed_kwh, r.billed_thb, r.vs_contract_pct, r.spend.thb, ...SPEND_GROUPS.map((g) => (r.spend.thb == null ? null : r.spend.by[g.key])), r.spend.events, r.spend.priced, r.ratio_pct, r.per_kwp, r.net_thb])
      );
    else if (view === "sites")
      downloadCsv(
        `pwa-meter-sites-${tag}.csv`,
        ["site_id", "phase", "name", "region", "kwp", "growatt_plant_id", "days", "meter_mwh", "contract_mwh_modelled", "pvsyst_mwh_modelled", "vs_contract_pct", "vs_pvsyst_pct", "yield_kwh_kwp", "availability_pct", "data_availability_pct", "outage_days", "data_gap_days", "curtailment_note_days", "curtailed", "issues", "owner"],
        siteRows.map((r) => [r.site_id, r.phase, r.name, r.region, r.kwp, r.growatt_plant_id, r.days, r.meter_mwh, r.contract_mwh, r.pvsyst_mwh, r.vs_contract_pct, r.vs_pvsyst_pct, r.yield_kwh_kwp, r.availability_pct, r.data_availability_pct, r.outage_days, r.data_gap_days, r.curtailment_note_days, r.curtailed ? 1 : 0, r.issues.join(" | "), r.owner])
      );
    else if (view === "outages")
      downloadCsv(
        `pwa-meter-outages-${tag}.csv`,
        ["site_id", "phase", "name", "region", "start", "end", "days", "cause", "note"],
        outageRows.map((r) => [r.site_id, r.phase, r.name, r.region, r.start, r.end, r.days, r.cause, r.note])
      );
    else if (view === "growatt")
      downloadCsv(
        `pwa-meter-vs-growatt-${tag}.csv`,
        ["site_id", "phase", "name", "region", "kwp", "growatt_plant_id", "report_days", "compared_days", "meter_kwh", "growatt_kwh", "meter_vs_growatt_pct", "median_ratio_pct", "p05_ratio_pct", "low_days", "high_days", "meter_missing_days", "growatt_missing_days", "growatt_withheld_days", "flags"],
        vsgRows.map((r) => [r.site_id, r.phase, r.name, r.region, r.kwp, r.growatt_plant_id, r.report_days, r.compared_days, r.meter_kwh, r.growatt_kwh, r.ratio_pct, r.median_ratio_pct, r.p05_ratio_pct, r.low_days, r.high_days, r.meter_missing_days, r.growatt_missing_days, r.implausible_days, r.flags.join(" | ")])
      );
    else
      downloadCsv(
        `pwa-meter-check-${tag}.csv`,
        ["site_id", "phase", "name", "region", "median_ratio_pct", "p05_ratio_pct", "low_days", "high_days", "inverter_missing_days", "meter_missing_days", "flags"],
        checkRows.map((r) => [r.site_id, r.phase, r.name, r.region, r.median_ratio_pct, r.p05_ratio_pct, r.low_days, r.high_days, r.inverter_missing_days, r.meter_missing_days, r.flags.join(" | ")])
      );
  };

  const emptyTitle =
    view === "issues"
      ? !c ? t("Not available") : query.trim() ? t("No matching issues") : t("No active issues")
      : view === "plants"
        ? !c ? t("Not available") : query.trim() ? t("No plant matches the search") : t("No plants")
        : !pwa.data ? t("Report unavailable") : !sites.length ? t("No meter report days in this period") : view === "outages" ? t("No outage events") : view === "billing" ? t("No matching site-months") : t("No matching sites");
  const emptyText =
    view === "issues" && c && !query.trim()
      ? t("The decision rules have nothing open on these plants.")
      : meterView && pwa.data && !sites.length
        ? admin ? t("Import the report (Import report), or widen the period: the report is imported monthly.") : t("None of your plants is in the report for this period.")
        : null;
  const footnote = {
    issues: t("Active issues of the decision rules on the stored data: safety first, then tier. Next visit = the plant's next planned task in the Calendar."),
    plants: t("Inverter side, stored data. EPI and PR′ are modelled medians of the period. Meter vs contract comes from the PWA meter report and opens the site's days."),
    billing: t("Billing, one row per site and calendar month (the period's first and last month may be partial). Billed = Cewe meter kWh at the book price; red − = days without a reading since the site's first report day. Shortfall = contract (modelled) − billed. A row opens the site's days."),
    finance: `${t("Finance, per report site over the report's months: billed value (Cewe meter kWh × book price, measured) against the Site log costs of the site's Growatt plant (entered; events without a cost are counted, not priced). Nothing estimated. A row opens the site's days.")}${fin.outside.events ? ` ${t("Outside the report (other plants or months): {thb} in {n} events.", { thb: thb(fin.outside.thb), n: fmtInt(fin.outside.events) })}` : ""}`,
    sites: t("PWA meter report. Contract and PVsyst are modelled. Lowest yield first. A site's row opens its days."),
    outages: `${t("Consecutive outage days of a site (meter and inverter both < 1 kWh). Cause = first keyword group in the notes.")}${longDays != null ? ` ${t("Red = {n} days or more.", { n: longDays })}` : ""}`,
    meter: t("Meter ÷ inverter per site, judged on productive days."),
    growatt: `${t("Cewe meter (PWA report) ÷ Growatt's own day energy of the site's plant, per site on the days both read > 0; both measured. About 98.5–99 % is normal (AC losses to the grid-point meter). A Growatt day above 10 kWh/kWp is withheld. A row opens the site's days.")}${vsg?.summary.growatt_first_day ? ` ${t("Growatt day energy stored {from} – {to}.", { from: fmtDayLong(vsg.summary.growatt_first_day), to: fmtDayLong(vsg.summary.growatt_last_day) })}` : ` ${t("No Growatt day energy stored for this period.")}`}`,
  }[view];

  return (
    <div className="flex flex-col gap-5">
      {/* ---- header: title, period, actions */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-lg font-semibold">{t("Engineering O&M")}</h1>
          {c && <Badge variant="neutral">{c.scope === "fleet" ? t("Fleet · {n} plants", { n: fmtInt(c.plant_count) }) : t("Your plants · {n}", { n: fmtInt(c.plant_count) })}</Badge>}
          {pwa.data && (
            <Badge variant={dataEnd ? "neutral" : "warn"} title={t("The PWA meter report is imported monthly; nothing after this day is in the app yet")}>
              {dataEnd ? t("Meter report to {day}", { day: fmtDayLong(dataEnd) }) : t("No meter report days in this period")}
            </Badge>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Select value={custom ? "custom" : range} onValueChange={(v) => v !== "custom" && setUrl({ range: v === "mtd" ? null : v, from: null, to: null })}>
            <SelectTrigger size="sm" className="w-40" aria-label={t("Period")}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {RANGES.map((r) => (
                <SelectItem key={r} value={r}>
                  {t(RANGE_LABEL[r])}
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
          <Input type="date" aria-label={t("From")} className="h-8 w-36 [color-scheme:dark]" value={start ?? ""} max={to ?? c?.window.today} onChange={(e) => setUrl({ from: pickDay(e.target.value), to: to ?? c?.window.end ?? null, range: null })} />
          <Input type="date" aria-label={t("To")} className="h-8 w-36 [color-scheme:dark]" value={to ?? c?.window.end ?? ""} min={start ?? undefined} max={c?.window.today} onChange={(e) => setUrl({ to: pickDay(e.target.value), from: start, range: null })} />
          <Button variant="outline" size="sm" onClick={reload} disabled={loading}>
            {loading && <Spinner data-icon="inline-start" className="size-3" />}
            {loading ? t("Refreshing…") : t("Refresh")}
          </Button>
          {admin && (
            <Button size="sm" onClick={() => setImporting(true)}>
              {t("Import report")}
            </Button>
          )}
        </div>
      </div>

      {center.error && (
        <Alert variant="destructive">
          <AlertTitle>{t("Could not load the inverter-side figures")}</AlertTitle>
          <AlertDescription>{center.error}</AlertDescription>
        </Alert>
      )}
      {pwa.error && (
        <Alert variant="destructive">
          <AlertTitle>{t("Could not load the PWA meter report")}</AlertTitle>
          <AlertDescription>{pwa.error}</AlertDescription>
        </Alert>
      )}
      {/* ---- figures: billing first, then engineering (meter report, inverters) and the team's work; sources are never added together */}
      <div className="grid gap-x-5 gap-y-5 xl:grid-cols-2">
        <Group
          title={t("Billing")}
          source={t("PWA meter report · ฿ at the contract's book price")}
          cols="sm:grid-cols-3"
          badge={
            <Select value={phase} onValueChange={(v) => setUrl({ phase: v === ALL ? null : v })}>
              <SelectTrigger size="sm" className="h-6 w-28 text-[11px]" aria-label={t("Phase")}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>{t("Phases 1–2")}</SelectItem>
                <SelectSeparator />
                <SelectItem value="1">{t("Phase {n}", { n: 1 })}</SelectItem>
                <SelectItem value="2">{t("Phase {n}", { n: 2 })}</SelectItem>
              </SelectContent>
            </Select>
          }
        >
          <StatTile
            label={t("Billed energy")}
            value={billedKwh == null ? "—" : fmt(billedKwh / 1000, 0)}
            unit="MWh"
            href={listHref({ view: "billing" })}
            linkLabel={t("Open the billing by month")}
            footer={
              <span title={`${t(BILLED_HINT)}. ${t("Days without a reading are counted from each site's first report day.")}`}>
                {t("{n} sites", { n: cnt(bill, billSites.length) })}{missingDays > 0 ? <span className="text-red-300"> · {t("{n} days unread", { n: fmtInt(missingDays) })}</span> : ""}
              </span>
            }
          />
          <StatTile
            label={t("Billed value")}
            value={thbShort(billedThb)}
            footer={<span title={`${t(BILLED_HINT)}: ${thb(billedThb)}`}>{price != null ? t("at ฿{price} / kWh", { price: fmt(price, 4) }) : t("Book price")}</span>}
          />
          <StatTile
            label={t("vs contract")}
            tag={t("mod.")}
            value={vsContract == null ? "—" : fmt(vsContract, 1)}
            unit="%"
            tone={vsContract == null ? undefined : vsContract >= 100 ? "text-emerald-300" : vsContract < 90 ? "text-red-300" : "text-amber-300"}
            meter={vsContract != null ? <Meter segments={[{ pct: Math.min(100, vsContract), className: vsContract >= 100 ? "bg-emerald-400" : "bg-amber-400" }]} mark={100} title={t("Tick = the contract's energy (modelled)")} /> : undefined}
            footer={
              <span title={t("Contract − billed energy on the days with a contract figure; the contract is modelled")}>
                {shortKwh == null ? "—" : shortKwh > 0 ? t("{v} MWh short", { v: fmt(shortKwh / 1000, 1) }) : t("{v} MWh above", { v: fmt(-shortKwh / 1000, 1) })} · {t("{n} sites below", { n: cnt(bill, belowContract) })}
              </span>
            }
          />
        </Group>

        <Group title={t("Finance")} source={t("Billing (measured × book price) vs Site log costs (entered)")} cols="sm:grid-cols-4">
          <StatTile
            label={t("O&M spend")}
            value={thbShort(fin.spend.thb)}
            href={listHref({ view: "finance" })}
            linkLabel={t("Open the finance by site")}
            footer={
              <span title={`${t("Site log costs of the report sites' Growatt plants, in the report's months.")} ${t(ENTERED)}`}>
                {!finReady ? "—" : fin.spend.events ? t("{n} of {total} events have a cost", { n: fmtInt(fin.spend.priced), total: fmtInt(fin.spend.events) }) : t("No Site log events")}
              </span>
            }
          />
          <StatTile
            label={t("Spend ÷ billed")}
            value={fin.ratio_pct == null ? "—" : fmt(fin.ratio_pct, 2)}
            unit="%"
            footer={<span title={t(FINANCE_HINT)}>{t("{n} sites with a cost", { n: finReady ? fmtInt(fin.sites_with_spend) : "—" })}</span>}
          />
          <StatTile
            label={t("O&M ฿ / MWh")}
            value={fin.per_mwh == null ? "—" : fmt(fin.per_mwh, 0)}
            footer={<span title={t(FINANCE_HINT)}>{price != null ? t("Book price ฿{v} / MWh", { v: fmt(price * 1000, 0) }) : t("Per billed MWh")}</span>}
          />
          <StatTile
            label={t("Billed − spend")}
            value={thbShort(fin.net_thb)}
            footer={<span title={t("Billed value minus the entered O&M spend; — when no cost is entered")}>{t("After entered O&M costs")}</span>}
          />
        </Group>

        <Group title={t("Engineering · meter report")} source={t("PWA meter report and its criteria file")} cols="sm:grid-cols-4">
          <StatTile
            label={t("O&M to act")}
            value={cnt(pwa.data, omSites)}
            unit={t("sites")}
            tone={omSites ? "text-amber-300" : undefined}
            href={listHref({ view: "sites", show: "om" })}
            linkLabel={t("Open the sites O&M has to act on")}
            footer={
              <span title={t("Sites with an issue; PM = curtailment loss over the threshold, a PM matter")}>
                {t("{n} with issues · {pm} PM", { n: cnt(pwa.data, issueSites), pm: cnt(pwa.data, pmSites) })}
              </span>
            }
          />
          <StatTile
            label={t("Outage events")}
            value={cnt(pwa.data, outageAll.length)}
            href={listHref({ view: "outages" })}
            linkLabel={t("Open the outage events")}
            footer={
              outageAll.length ? (
                <span title={t("Mean event length; fixed fast = {fast} days or less, long = {long} days or more (criteria file)", { fast: fastDays ?? "—", long: longDays ?? "—" })}>
                  {t("MTTR {d} d · {fast} fast · {long} long", { d: fmt(mttr, 1), fast: fastPct == null ? "—" : `${fmt(fastPct, 0)} %`, long: longCount ?? "—" })}
                </span>
              ) : (
                <span>{pwa.data ? t("None in the period") : "—"}</span>
              )
            }
          />
          <StatTile
            label={t("Meter check")}
            value={cnt(pwa.data, flaggedChecks.length)}
            unit={t("sites")}
            tone={flaggedChecks.length ? "text-amber-300" : undefined}
            href={listHref({ view: "meter" })}
            linkLabel={t("Open the meter check")}
            footer={<span title={t("Sites with a meter vs inverter flag")}>{t("Meter ÷ inverter, productive days")}</span>}
          />
          <StatTile
            label={t("Meter ÷ Growatt")}
            value={vsgRatio == null ? "—" : fmt(vsgRatio, 2)}
            unit="%"
            tone={vsgRatio == null ? undefined : vsgRatio < 97 || vsgRatio > 100.5 ? "text-amber-300" : undefined}
            href={listHref({ view: "growatt" })}
            linkLabel={t("Open meter vs Growatt")}
            footer={
              <span title={`${t(GROWATT_HINT)}. ${t("{n} of {total} sites compared", { n: cnt(vsg, vsgCompared), total: cnt(vsg, vsgSites.length) })}`}>
                {t("{n} sites flagged", { n: cnt(vsg, vsgFlagged) })}
              </span>
            }
          />
        </Group>

        <Group title={t("Engineering · inverters")} source={t("Stored Growatt data · decision rules")} cols="sm:grid-cols-3">
          <StatTile
            label={t("Active issues")}
            value={cnt(m, m?.active_issues ?? 0)}
            tone={m?.active_issues ? "text-amber-300" : undefined}
            href={listHref({ view: null })}
            linkLabel={t("Open the issues to fix first")}
            footer={(m?.safety_issues ?? 0) > 0 ? <span className="text-red-300">{t("{n} safety", { n: fmtInt(m?.safety_issues) })}</span> : <span>{t("Decision rules, live only")}</span>}
          />
          <StatTile
            label={t("Produced")}
            value={m?.produced_kwh == null ? "—" : fmt(m.produced_kwh / 1000, 1)}
            unit="MWh"
            footer={<span title={t("Measured: each inverter's day energy, summed over the period")}>{t("Measured, inverters")}</span>}
          />
          <StatTile
            label={t("Availability")}
            value={m?.availability_pct == null ? "—" : fmt(m.availability_pct, 2)}
            unit="%"
            tone={m?.availability_pct == null ? undefined : m.availability_pct >= 99 ? "text-emerald-300" : m.availability_pct < 95 ? "text-red-300" : "text-amber-300"}
            meter={m?.availability_pct != null ? <Meter segments={[{ pct: m.availability_pct, className: "bg-emerald-400" }]} mark={99} title={t("Tick = 99 %")} /> : undefined}
            footer={<span title={t("Inverter minutes not in fault / off / standby ÷ daylight minutes with data. Power limiting is not downtime.")}>{t("Time based")}{m?.limited_min ? ` · ${t("{n} h limited", { n: fmtInt(Math.round(m.limited_min / 60)) })}` : ""}</span>}
          />
        </Group>

        <Group title={t("Work")} source={t("Entered by the team")} cols="sm:grid-cols-2">
          <StatTile
            label={t("O&M spend")}
            value={m?.spend_thb == null ? "—" : thb(m.spend_thb)}
            footer={<span title={t(ENTERED)}>{!m ? "—" : m.spend_events ? t("{n} of {total} Site log events have a cost", { n: fmtInt(m.spend_events_priced), total: fmtInt(m.spend_events) }) : t("No Site log events")}</span>}
          />
          <StatTile
            label={t("Committed")}
            value={m?.committed_thb == null ? "—" : thb(m.committed_thb)}
            href="/calendar"
            linkLabel={t("Open the Calendar")}
            footer={<span title={t(ENTERED)}>{!m ? "—" : m.committed_tasks ? t("{n} of {total} open tasks have a cost", { n: fmtInt(m.committed_tasks_priced), total: fmtInt(m.committed_tasks) }) : t("No open tasks")}</span>}
          />
        </Group>
      </div>

      {/* ---- billing by month: what was billed against the contract, and against the O&M spend */}
      <div className="grid gap-4 xl:grid-cols-2">
        <ChartCard
          title={t("Billed vs contract by month")}
          source={t("PWA meter")}
          badge={t("Contract modelled")}
          badgeTitle={t("Measured meter kWh; the contract's energy is modelled")}
          loading={pwaLoading}
          empty={!billSpec ? noReport : null}
          note={t("Bars = billed meter energy per calendar month (a segment per phase); dashed = the contract's energy (modelled). The first and last month of the period may be partial.")}
        >
          <PanelChart spec={billSpec} height={330} />
        </ChartCard>
        <ChartCard
          title={t("Billing vs O&M spend by month")}
          source={t("PWA meter · Site log")}
          badge={t("Measured · entered")}
          badgeTitle={t(FINANCE_HINT)}
          loading={pwaLoading || (center.loading && !c)}
          empty={!finSpec ? noReport : null}
          note={t("Top: billed value per month. Middle: O&M spend entered in the Site log for the report sites' plants, by work type. Bottom: spend ÷ billed. Months without a priced event have no spend bar.")}
        >
          <PanelChart spec={finSpec} height={330} legendPosition="bottom" />
        </ChartCard>
      </div>

      {/* ---- charts: where to look, per source */}
      <div className="grid gap-4 xl:grid-cols-2">
        {admin && (
          <ChartCard title={t("Fleet by day: daily specific yield of the fleet (kWh/kWp)")} source={t("PWA meter")} badge={t("Contract modelled")} badgeTitle={t("Measured meter kWh; the contract's energy is modelled")} className="xl:col-span-2" loading={pwaLoading} empty={!fleetSpec ? noReport : null}>
            <PanelChart spec={fleetSpec} height={372} />
          </ChartCard>
        )}
        <ChartCard
          title={t("Meter vs Growatt by day")}
          source={t("PWA meter · Growatt plant/energy")}
          badge={t("Measured")}
          badgeTitle={t(GROWATT_HINT)}
          className="xl:col-span-2"
          loading={pwaLoading}
          empty={!vsgSpec ? t("No day with both a meter reading and a Growatt day energy in this period") : null}
          note={t("Summed per day over the sites with both readings (the phase above applies). Bottom: meter ÷ Growatt; a day outside 90–104 % is drawn on the edge in red.")}
        >
          <PanelChart spec={vsgSpec} height={330} legendPosition="bottom" />
        </ChartCard>
        <ChartCard
          title={t("Daily heatmap: site × day (kWh/kWp)")}
          source={t("PWA meter")}
          badge={t("Measured")}
          badgeTitle={t("Meter kWh ÷ kWp per report day")}
          className="xl:col-span-2"
          loading={pwaLoading}
          empty={!daily || !daily.days.length || !heatOrder.length ? noReport : null}
          note={t("One row per site, lowest yield first · hover for the value, click a row to open the site")}
        >
          <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
            <label className="flex items-center gap-2 text-xs font-semibold">
              {t("Phase")}
              <Select value={phase} onValueChange={(v) => setUrl({ phase: v === ALL ? null : v })}>
                <SelectTrigger size="sm" className="w-28" aria-label={t("Phase")}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL}>{t("All phases")}</SelectItem>
                  <SelectSeparator />
                  <SelectItem value="1">{t("Phase {n}", { n: 1 })}</SelectItem>
                  <SelectItem value="2">{t("Phase {n}", { n: 2 })}</SelectItem>
                </SelectContent>
              </Select>
            </label>
            <Legend items={HEAT_LEGEND} />
          </div>
          {daily && <YieldHeatmap daily={daily} order={heatOrder} onOpen={openSite} />}
        </ChartCard>
      </div>

      {/* ---- the lists */}
      <Card className="scroll-mt-4 gap-0 py-0" ref={listsRef} id="lists">
        <div className="flex flex-wrap items-center justify-between gap-x-3 border-b px-4 pt-2 sm:px-5">
          <Tabs value={view} onValueChange={switchView}>
            <TabsList variant="line" className="border-0 p-0">
              <TabsTrigger value="issues" className="px-3 py-2.5 text-sm">
                {t("Fix first")} <span className="num text-muted-foreground">{cnt(c, c?.issues.total ?? 0)}</span>
              </TabsTrigger>
              <TabsTrigger value="plants" className="px-3 py-2.5 text-sm">
                {t("Plants")} <span className="num text-muted-foreground">{cnt(c, c?.plants.length ?? 0)}</span>
              </TabsTrigger>
              <TabsTrigger value="billing" className="px-3 py-2.5 text-sm">
                {t("Billing by month")} <span className="num text-muted-foreground">{cnt(bill, billRowsAll.length)}</span>
              </TabsTrigger>
              <TabsTrigger value="finance" className="px-3 py-2.5 text-sm">
                {t("Finance")} <span className="num text-muted-foreground">{finReady ? fmtInt(fin.sites_with_spend) : "—"}</span>
              </TabsTrigger>
              <TabsTrigger value="sites" className="px-3 py-2.5 text-sm">
                {t("Meter sites")} <span className="num text-muted-foreground">{cnt(pwa.data, inPhase.length)}</span>
              </TabsTrigger>
              <TabsTrigger value="outages" className="px-3 py-2.5 text-sm">
                {t("Outage events")} <span className="num text-muted-foreground">{cnt(pwa.data, outageAll.length)}</span>
              </TabsTrigger>
              <TabsTrigger value="meter" className="px-3 py-2.5 text-sm">
                {t("Meter check")} <span className="num text-muted-foreground">{cnt(pwa.data, (pwa.data?.checks ?? []).filter((r) => (phase === ALL || r.phase === Number(phase)) && r.flags.length).length)}</span>
              </TabsTrigger>
              <TabsTrigger value="growatt" className="px-3 py-2.5 text-sm">
                {t("Meter vs Growatt")} <span className="num text-muted-foreground">{cnt(vsg, vsgFlagged)}</span>
              </TabsTrigger>
            </TabsList>
          </Tabs>
          <div className="flex flex-wrap items-center gap-2 pb-2">
            {view === "billing" && (
              <Select value={billMonth} onValueChange={(v) => setUrl({ month: v === ALL ? null : v })}>
                <SelectTrigger size="sm" className="w-40" aria-label={t("Month")}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL}>{t("Every month")}</SelectItem>
                  <SelectSeparator />
                  {[...(bill?.months ?? [])].reverse().map((mo) => (
                    <SelectItem key={mo} value={mo}>
                      {fmtMonth(mo, true)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
            {view === "sites" && (
              <Select value={show} onValueChange={(v) => setUrl({ show: v === "all" ? null : v })}>
                <SelectTrigger size="sm" className="w-40" aria-label={t("Show sites")}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {SHOW.map((s) => (
                    <SelectItem key={s} value={s}>
                      {t(SHOW_LABEL[s])}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
            <Input className="h-8 w-52" placeholder={meterView ? t("Search site, id, region") : view === "plants" ? t("Search plant") : t("Search plant, inverter, rule")} value={query} onChange={(e) => setUrl({ q: e.target.value })} aria-label={t("Search the list")} />
            {anyFilter && (
              <Button variant="ghost" size="sm" onClick={() => setUrl({ q: null, phase: null, show: null, month: null })}>
                {t("Clear")}
              </Button>
            )}
            <Button variant="outline" size="sm" onClick={exportCsv} disabled={!rowsShown}>
              {t("Export CSV")}
            </Button>
          </div>
        </div>

        {view === "sites" && admin && phases.length > 0 && (
          <div className="border-b">
            <p className="eyebrow px-4 pt-3 sm:px-5">{t("Phase totals")}</p>
            <PhaseTotals phases={phases} />
          </div>
        )}
        {meterView && !admin && pwa.data && sites.length > 0 && (
          <p className="border-b px-4 py-2 text-[11px] text-muted-foreground sm:px-5">{t("Phase totals are for admins: they include plants you are not assigned.")}</p>
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
            <PlantsTable rows={plantRows} sort={pick(sortKey, PlantSortKeys, "issues")} desc={desc} onSort={onSort} sites={siteByPlant} onOpenSite={openSite} />
          ) : view === "billing" ? (
            <BillingTable rows={billRows} sort={pick(sortKey, BillSortKeys, "month")} desc={desc} onSort={onSort} onOpen={openSite} />
          ) : view === "finance" ? (
            <FinanceTable rows={financeRows} sort={pick(sortKey, FinanceSortKeys, "spend")} desc={desc} onSort={onSort} onOpen={openSite} />
          ) : view === "sites" ? (
            <SitesTable rows={siteRows} sort={pick(sortKey, SiteSortKeys, "yield")} desc={desc} onSort={onSort} onOpen={openSite} />
          ) : view === "outages" ? (
            <OutagesTable rows={outageRows} sort={pick(sortKey, OutageSortKeys, "days")} desc={desc} onSort={onSort} onOpen={openSite} longDays={longDays ?? Infinity} />
          ) : view === "growatt" ? (
            <VsGrowattTable rows={vsgRows} sort={pick(sortKey, VsGrowattSortKeys, "median")} desc={desc} onSort={onSort} onOpen={openSite} />
          ) : (
            <MeterCheckTable rows={checkRows} sort={pick(sortKey, CheckSortKeys, "low")} desc={desc} onSort={onSort} onOpen={openSite} />
          )}
        </CardContent>
        <CardContent className="border-t py-2.5 text-[11px] text-muted-foreground">
          {view === "issues" && c && c.issues.total > c.issues.top.length ? `${t("The {n} most urgent of {total}.", { n: c.issues.top.length, total: fmtInt(c.issues.total) })} ` : ""}
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
