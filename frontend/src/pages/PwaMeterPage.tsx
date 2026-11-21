/**
 * Operations → PWA Meter (`/pwa-meter`, everyone, scoped to the user's plants): the PWA daily meter
 * report of phases 1–2: the Cewe meter kWh each site bills per day, against the contract and
 * PVsyst (modelled), with availability, estimated losses, issues and owner per site, outage events
 * and the meter vs inverter check. DB only (`/pwa/meter/*`), imported monthly, so nothing polls.
 * Engineers see the sites of their plants and no phase totals. Pieces in `pages/pwaMeter/`;
 * docs/plans/pwa-meter-daily.md.
 *
 * URL: `tab` (sites | outages | meter), `from`, `to` (YYYY-MM-DD; none = the whole report),
 * `phase`, `q`, `show` (all | issues | om | pm, sites tab), `sort`, `desc`, `site` (detail open).
 */
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "../api/client";
import type { PwaMeterCriteria, PwaMeterWindow } from "../api/client";
import { isAdmin } from "../auth/access";
import { useAppContext } from "../context/AppContext";
import { SkeletonRows, fmt, fmtInt } from "../components/ui";
import { pick, useUrlState } from "@/lib/useUrlState";
import { cn } from "@/lib/utils";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectSeparator, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { usePwaMeter } from "./pwaMeter/usePwaMeter";
import { PHASES, PRESETS, PRESET_LABEL, SHOW, TABS, byKey, downloadCsv, fmtDay, isDay, presetOf, presetWindow } from "./pwaMeter/format";
import type { Preset, Show } from "./pwaMeter/format";
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
import type { CheckSort, OutageSort, SiteSort } from "./pwaMeter/tables";
import { SiteDialog } from "./pwaMeter/SiteDialog";

const ALL = "all";
/** default sort and direction per tab */
const DEFAULT_SORT = { sites: ["rank", false], outages: ["days", true], meter: ["gap", true] } as const;

const Stat: React.FC<{ label: string; value: React.ReactNode; tone?: string; active?: boolean; onClick?: () => void; title?: string; sub?: React.ReactNode }> = ({
  label,
  value,
  tone,
  active,
  onClick,
  title,
  sub,
}) => (
  <button
    type="button"
    onClick={onClick}
    title={title}
    disabled={!onClick}
    className={cn("flex flex-col gap-1 px-5 py-4 text-left transition-colors enabled:hover:bg-muted", active && "bg-muted")}
  >
    <span className="eyebrow">{label}</span>
    <span className={cn("num text-3xl font-bold tracking-tight", tone)}>{value}</span>
    {sub && <span className="text-[11px] text-muted-foreground">{sub}</span>}
  </button>
);

export const PwaMeterPage: React.FC = () => {
  const { user } = useAppContext();
  const admin = isAdmin(user);
  const [url, setUrl] = useUrlState();
  const tab = pick(url.get("tab"), TABS, "sites");
  const from = isDay(url.get("from")) ? url.get("from") : null;
  const to = isDay(url.get("to")) ? url.get("to") : null;
  const phase = pick(url.get("phase"), PHASES, ALL);
  const query = url.get("q") ?? "";
  const show: Show = pick(url.get("show"), SHOW, "all");
  const siteId = url.get("site");
  const desc = url.get("desc") == null ? DEFAULT_SORT[tab][1] : url.get("desc") === "1";
  const siteSort: SiteSort = pick(url.get("sort"), SiteSortKeys, "rank");
  const outageSort: OutageSort = pick(url.get("sort"), OutageSortKeys, "days");
  const checkSort: CheckSort = pick(url.get("sort"), CheckSortKeys, "gap");

  const win: PwaMeterWindow = useMemo(() => ({ start: from, end: to }), [from, to]);
  const { data, loading, error, reload } = usePwaMeter(win);

  // the report's last day: what the presets count back from (the report lags up to a month)
  const [lastDay, setLastDay] = useState<string | null>(null);
  useEffect(() => {
    const end = data?.summary.window.end;
    if (end && !to) setLastDay((d) => (d && d > end ? d : end));
  }, [data, to]);
  const preset = presetOf(win, lastDay);

  const [criteria, setCriteria] = useState<PwaMeterCriteria | null>(null);
  useEffect(() => {
    api.getPwaMeterCriteria().then(setCriteria, () => setCriteria(null));
  }, []);
  const longDays = criteria?.outage_event.long_event_days ?? null;
  const fastDays = criteria?.outage_event.fixed_fast_days ?? null;

  const words = useMemo(() => query.trim().toLowerCase().split(/\s+/).filter(Boolean), [query]);
  const match = useCallback(
    (r: { phase: number; name: string; site_id: string; region: string | null }) =>
      (phase === ALL || r.phase === Number(phase)) && words.every((w) => `${r.name} ${r.site_id} ${r.region ?? ""}`.toLowerCase().includes(w)),
    [phase, words]
  );

  const sites = useMemo(() => data?.summary.sites ?? [], [data]);
  const inPhase = useMemo(() => sites.filter((r) => phase === ALL || r.phase === Number(phase)), [sites, phase]);
  const siteRows = useMemo(() => {
    const rows = sites.filter(
      (r) => match(r) && (show === "all" || (show === "issues" && r.issues.length > 0) || (show === "om" && !!r.owner?.includes("O&M")) || (show === "pm" && !!r.owner?.includes("PM")))
    );
    return byKey(rows, (r) => siteSortValue(r, siteSort), desc);
  }, [sites, match, show, siteSort, desc]);
  const outageRows = useMemo(() => byKey((data?.outages ?? []).filter(match), (r) => outageSortValue(r, outageSort), desc), [data, match, outageSort, desc]);
  const checkRows = useMemo(() => byKey((data?.checks ?? []).filter(match), (r) => checkSortValue(r, checkSort), desc), [data, match, checkSort, desc]);

  // outage KPIs of the filtered events (criteria: long = ≥ long_event_days, fixed fast = ≤ fixed_fast_days)
  const ev = outageRows;
  const mttr = ev.length ? ev.reduce((s, e) => s + e.days, 0) / ev.length : null;
  const longCount = longDays != null ? ev.filter((e) => e.days >= longDays).length : null;
  const fastPct = fastDays != null && ev.length ? (100 * ev.filter((e) => e.days <= fastDays).length) / ev.length : null;

  const phases = (data?.summary.phases ?? []).filter((p) => phase === ALL || p.phase === Number(phase));
  const dataEnd = data?.summary.window.end ?? null;
  const dataStart = data?.summary.window.start ?? null;
  const firstRead = loading && !data;
  const n = (v: number) => (data ? fmtInt(v) : "—"); // not read yet ≠ none

  const setPreset = (p: Preset) => {
    const w = presetWindow(p, lastDay);
    setUrl({ from: w.start ?? null, to: null });
  };
  const onSort = (k: string) => {
    const cur = tab === "sites" ? siteSort : tab === "outages" ? outageSort : checkSort;
    // a new column starts worst-first, except names, rank and dates
    const nextDesc = k === cur ? !desc : !["name", "rank", "start"].includes(k);
    setUrl({ sort: k === DEFAULT_SORT[tab][0] ? null : k, desc: nextDesc ? "1" : "0" });
  };
  const switchTab = (t: string) => setUrl({ tab: t === "sites" ? null : t, sort: null, desc: null, show: t === "sites" ? (show === "all" ? null : show) : null });
  const pickShow = (s: Show) => setUrl({ tab: null, sort: null, desc: null, show: show === s ? null : s });

  const exportCsv = () => {
    const tag = `${from ?? dataStart ?? "start"}_${to ?? dataEnd ?? "end"}`;
    if (tab === "sites")
      downloadCsv(
        `pwa-meter-sites-${tag}.csv`,
        ["rank", "site_id", "phase", "name", "region", "kwp", "growatt_plant_id", "days", "meter_mwh", "contract_mwh_modelled", "pvsyst_mwh_modelled", "vs_contract_pct", "vs_pvsyst_pct", "yield_kwh_kwp", "availability_pct", "data_availability_pct", "outage_days", "data_gap_days", "curtailment_note_days", "curtailed", "curtailment_loss_mwh_est", "outage_loss_mwh_est", "under_loss_mwh_est", "loss_thb_est", "issues", "owner"],
        siteRows.map((r) => [r.rank, r.site_id, r.phase, r.name, r.region, r.kwp, r.growatt_plant_id, r.days, r.meter_mwh, r.contract_mwh, r.pvsyst_mwh, r.vs_contract_pct, r.vs_pvsyst_pct, r.yield_kwh_kwp, r.availability_pct, r.data_availability_pct, r.outage_days, r.data_gap_days, r.curtailment_note_days, r.curtailed ? 1 : 0, r.curtailment_loss_mwh, r.outage_loss_mwh, r.under_loss_mwh, r.loss_thb, r.issues.join(" | "), r.owner])
      );
    else if (tab === "outages")
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

  const rowsShown = tab === "sites" ? siteRows.length : tab === "outages" ? outageRows.length : checkRows.length;
  const anyFilter = query.trim() !== "" || phase !== ALL || (tab === "sites" && show !== "all");
  const openSite = (id: string) => setUrl({ site: id });

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-col">
          <h1 className="text-lg font-semibold">PWA Meter</h1>
          <p className="text-xs text-muted-foreground">
            Daily meter report of phases 1–2: billed meter energy per site against the contract and PVsyst, losses, outages and the meter check
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {data && (
            <Badge variant={lastDay ?? dataEnd ? "neutral" : "warn"} title="The report is imported monthly; nothing after this day is in the app yet">
              {lastDay ?? dataEnd ? `Report through ${fmtDay(lastDay ?? dataEnd)}` : "No report days in this window"}
            </Badge>
          )}
          <Button variant="outline" size="sm" onClick={() => void reload()} disabled={loading}>
            {loading && <Spinner data-icon="inline-start" className="size-3" />}
            {loading ? "Refreshing…" : "Refresh"}
          </Button>
        </div>
      </div>

      {error && (
        <Alert variant="destructive">
          <AlertTitle>Could not load the PWA meter report</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <Card className="py-0">
        <CardContent className="flex flex-wrap items-center gap-2 py-3">
          <Select value={preset ?? "custom"} onValueChange={(v) => v !== "custom" && setPreset(v as Preset)}>
            <SelectTrigger size="sm" className="w-40" aria-label="Period">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PRESETS.map((p) => (
                <SelectItem key={p} value={p}>
                  {PRESET_LABEL[p]}
                </SelectItem>
              ))}
              {preset == null && (
                <>
                  <SelectSeparator />
                  <SelectItem value="custom">Custom</SelectItem>
                </>
              )}
            </SelectContent>
          </Select>
          <Input
            type="date"
            className="h-8 w-40 [color-scheme:dark]"
            aria-label="From"
            value={from ?? ""}
            max={to ?? undefined}
            onChange={(e) => setUrl({ from: isDay(e.target.value) ? e.target.value : null })}
          />
          <span className="text-xs text-muted-foreground">to</span>
          <Input
            type="date"
            className="h-8 w-40 [color-scheme:dark]"
            aria-label="To"
            value={to ?? ""}
            min={from ?? undefined}
            onChange={(e) => setUrl({ to: isDay(e.target.value) ? e.target.value : null })}
          />
          {data && dataStart && (
            <span className="text-xs text-muted-foreground">
              Data in window: {fmtDay(dataStart)} – {fmtDay(dataEnd)}
            </span>
          )}
          <Select value={phase} onValueChange={(v) => setUrl({ phase: v === ALL ? null : v })}>
            <SelectTrigger size="sm" className="ml-auto w-36" aria-label="Phase">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>Phases 1–2</SelectItem>
              <SelectSeparator />
              <SelectItem value="1">Phase 1</SelectItem>
              <SelectItem value="2">Phase 2</SelectItem>
            </SelectContent>
          </Select>
        </CardContent>
      </Card>

      <Card className="py-0">
        <CardContent className="grid grid-cols-2 divide-white/[0.06] px-0 lg:grid-cols-5 lg:divide-x">
          <Stat label="Sites" value={n(inPhase.length)} active={tab === "sites" && show === "all"} onClick={() => pickShow("all")} />
          <Stat label="With issues" value={n(inPhase.filter((r) => r.issues.length).length)} tone="text-amber-300" active={show === "issues"} onClick={() => pickShow("issues")} />
          <Stat label="O&M to act" value={n(inPhase.filter((r) => r.owner?.includes("O&M")).length)} tone="text-red-300" active={show === "om"} onClick={() => pickShow("om")} title="Under-performance, outages, data gaps or a recent outage" />
          <Stat label="PM (curtailment)" value={n(inPhase.filter((r) => r.owner?.includes("PM")).length)} tone="text-sky-300" active={show === "pm"} onClick={() => pickShow("pm")} title="Curtailment loss over the threshold: a PM matter, not an O&M KPI" />
          <Stat
            label="Outage events"
            value={data ? fmtInt(ev.length) : "—"}
            active={tab === "outages"}
            onClick={() => switchTab("outages")}
            sub={
              data && ev.length ? (
                <>
                  MTTR {fmt(mttr, 1)} d · {fastPct == null ? "—" : `${fmt(fastPct, 0)} %`} fixed ≤ {fastDays ?? "—"} d · {longCount ?? "—"} long
                </>
              ) : undefined
            }
          />
        </CardContent>
      </Card>

      {admin && phases.length > 0 && (
        <Card className="gap-2 py-3">
          <CardHeader className="px-4 sm:px-5">
            <CardTitle className="text-sm">Phase totals</CardTitle>
          </CardHeader>
          <CardContent className="px-0">
            <PhaseTotals phases={phases} />
          </CardContent>
        </Card>
      )}
      {!admin && data && (
        <p className="text-[11px] text-muted-foreground">Phase totals are for admins: they include plants you are not assigned. Losses still compare each site with every site of its phase.</p>
      )}

      <Card className="gap-0 py-0">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b px-4 pt-2 sm:px-5">
          <Tabs value={tab} onValueChange={switchTab}>
            <TabsList variant="line" className="border-0 p-0">
              <TabsTrigger value="sites" className="px-3 py-2.5 text-sm">
                Sites <span className="num text-muted-foreground">{n(siteRows.length)}</span>
              </TabsTrigger>
              <TabsTrigger value="outages" className="px-3 py-2.5 text-sm">
                Outage events <span className="num text-muted-foreground">{n(outageRows.length)}</span>
              </TabsTrigger>
              <TabsTrigger value="meter" className="px-3 py-2.5 text-sm">
                Meter check <span className="num text-muted-foreground">{n(checkRows.filter((r) => r.flags.length).length)}</span>
              </TabsTrigger>
            </TabsList>
          </Tabs>
          <div className="flex items-center gap-2 pb-2">
            <Input className="h-8 w-56" placeholder="Search site, id, region" value={query} onChange={(e) => setUrl({ q: e.target.value })} aria-label="Search sites" />
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

        <CardContent className="max-h-[70vh] overflow-auto px-0">
          {rowsShown === 0 ? (
            firstRead ? (
              <SkeletonRows rows={8} className="p-4" />
            ) : (
              <Empty className="py-16">
                <EmptyHeader>
                  <EmptyTitle>
                    {!data ? "Report unavailable" : !sites.length && !anyFilter ? "No report days in this window" : tab === "outages" ? "No outage events" : "No matching sites"}
                  </EmptyTitle>
                  {data && !sites.length && !anyFilter && (
                    <EmptyDescription>{admin ? "Import the report with the CLI (docs/plans/pwa-meter-daily.md), or widen the period." : "None of your plants is in the report for this period."}</EmptyDescription>
                  )}
                </EmptyHeader>
              </Empty>
            )
          ) : tab === "sites" ? (
            <SitesTable rows={siteRows} sort={siteSort} desc={desc} onSort={onSort} onOpen={openSite} />
          ) : tab === "outages" ? (
            <OutagesTable rows={outageRows} sort={outageSort} desc={desc} onSort={onSort} onOpen={openSite} longDays={longDays ?? Infinity} />
          ) : (
            <MeterCheckTable rows={checkRows} sort={checkSort} desc={desc} onSort={onSort} onOpen={openSite} />
          )}
        </CardContent>
        <CardContent className="border-t py-2.5 text-[11px] text-muted-foreground">
          {tab === "sites"
            ? "Losses and ฿ are estimated; contract and PVsyst are modelled. Rank = estimated loss ฿. A site's row opens its days."
            : tab === "outages"
              ? `Consecutive outage days of a site (meter and inverter both < 1 kWh). Cause = first keyword group in the notes.${longDays != null ? ` Red = ${longDays} days or more.` : ""}`
              : "Meter ÷ inverter per site, judged on productive days. The gap is the energy the meter may have missed (estimated)."}
        </CardContent>
      </Card>

      <SiteDialog
        siteId={siteId}
        window={win}
        row={sites.find((r) => r.site_id === siteId)}
        check={data?.checks.find((r) => r.site_id === siteId)}
        outages={(data?.outages ?? []).filter((r) => r.site_id === siteId)}
        onClose={() => setUrl({ site: null })}
      />
    </div>
  );
};

export default PwaMeterPage;
