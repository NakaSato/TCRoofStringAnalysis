/**
 * Plant → Energy & Billing (`/plant/:id/billing`): the fleet Energy & Billing page narrowed to this
 * plant's PWA meter report site. One request, `api.getPwaMeterPlantBilling` (DB only, never polled):
 * billed meter energy per month at the contract's book price against the contract (modelled), the
 * site's outage events and meter check, and the plant's Site log spend per month (entered); plus the
 * report days beside Growatt's own day energy (`api.getPwaMeterPlant`, both measured).
 *
 * No estimated lost kWh / ฿ (as on the fleet page). A plant outside the report (phases 3–4, 404)
 * shows an empty state, never made-up figures.
 *
 * URL: `range` (report (default) | 3m | 6m | 12m), `from`, `to` (a picked calendar month), `view`
 * (billing (default) | outages | meter), `site` (site dialog open).
 */
import React, { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { RefreshCw } from "lucide-react";
import { ApiError, api } from "../api/client";
import type { PwaPlantBilling, PwaPlantDays } from "../api/client";
import { PanelChart } from "../components/PanelChart";
import { SkeletonChart, SkeletonKpis, Suspended, fmt, fmtInt } from "../components/ui";
import { pick, pickDay, useUrlState } from "@/lib/useUrlState";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectSeparator, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { StatTile } from "./overview/StatTile";
import { plantSpec } from "./generation/PwaMeterCard";
import { BILLED_HINT, BillingTable, billSortValue, billedMonthSpec, fmtMonth, monthTotals } from "./center/billing";
import type { BillSort } from "./center/billing";
import { FINANCE_HINT, financeModel, financeMonthSpec } from "./center/finance";
import { contractBands } from "./center/chartSpecs";
import { ENTERED, monthWindow, thb, thbShort, windowMonth } from "./center/format";
import { MODELLED, byKey, fmtDay } from "./pwaMeter/format";
import { MeterCheckTable, OutagesTable, checkSortValue, outageSortValue } from "./pwaMeter/tables";
import type { CheckSort, OutageSort } from "./pwaMeter/tables";
import { SiteDialog } from "./pwaMeter/SiteDialog";
import type { PwaMeterCriteria } from "../api/client";
import { useAppContext } from "../context/AppContext";
import { SelectedPlantBanner } from "../components/SelectedPlantBanner";
import { useI18n } from "../i18n";

const RANGES = ["report", "3m", "6m", "12m"] as const;
type Range = (typeof RANGES)[number];
const RANGE_LABEL: Record<Range, string> = { report: "Latest report month", "3m": "Last 3 months", "6m": "Last 6 months", "12m": "Last 12 months" };
const VIEWS = ["billing", "outages", "meter"] as const;
type View = (typeof VIEWS)[number];

const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
/** whole calendar months: the first day of the month n − 1 months back, to today (≤ 366 days) */
const lastMonths = (n: number): { start: string; end: string } => {
  const now = new Date();
  return { start: iso(new Date(now.getFullYear(), now.getMonth() - (n - 1), 1)), end: iso(now) };
};
const mwh = (kwh: number | null | undefined, nd = 1) => (kwh == null ? "—" : fmt(kwh / 1000, nd));

type Load = { state: "loading" } | { state: "none" } | { state: "error"; error: string } | { state: "ok"; data: PwaPlantBilling };

const PlantBilling: React.FC<{ plantId: number }> = ({ plantId }) => {
  const { t } = useI18n();
  const [url, setUrl] = useUrlState();
  const range: Range = pick(url.get("range"), RANGES, "report");
  const from = pickDay(url.get("from"));
  const to = pickDay(url.get("to"));
  const picked = windowMonth(from, to);
  const view: View = pick(url.get("view"), VIEWS, "billing");
  const siteOpen = url.get("site");

  const win = useMemo(() => (picked ? { start: from, end: to } : range === "report" ? {} : lastMonths(range === "3m" ? 3 : range === "6m" ? 6 : 12)), [picked, from, to, range]);
  const [load, setLoad] = useState<Load>({ state: "loading" });
  const [days, setDays] = useState<PwaPlantDays | null>(null);
  const [busy, setBusy] = useState(false);
  const [tick, setTick] = useState(0);
  const [criteria, setCriteria] = useState<PwaMeterCriteria | null>(null);

  useEffect(() => {
    let live = true;
    api.getPwaMeterCriteria().then((c) => live && setCriteria(c), () => undefined);
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => {
    let live = true;
    setBusy(true);
    api
      .getPwaMeterPlantBilling(plantId, win)
      .then(async (d) => {
        if (!live) return;
        setLoad({ state: "ok", data: d });
        const w = d.window;
        const pd = w.start && w.end ? await api.getPwaMeterPlant(plantId, { start: w.start, end: w.end }).catch(() => null) : null;
        if (live) setDays(pd);
      })
      .catch((e) => {
        if (!live) return;
        if (e instanceof ApiError && e.status === 404) setLoad({ state: "none" });
        else setLoad({ state: "error", error: e instanceof Error ? e.message : String(e) });
      })
      .finally(() => live && setBusy(false));
    return () => {
      live = false;
    };
  }, [plantId, win, tick]);

  const data = load.state === "ok" ? load.data : null;
  const b = data?.billing ?? null;
  const months = useMemo(() => (b ? monthTotals(b.rows, b.months) : []), [b]);
  const fin = useMemo(() => (b ? financeModel(b.rows, b.sites, data?.spend_by_month ?? []) : null), [b, data]);
  const bands = useMemo(() => contractBands(criteria), [criteria]);
  const monthSpec = useMemo(() => billedMonthSpec(months, bands), [months, bands]);
  const finSpec = useMemo(() => (fin ? financeMonthSpec(fin.months) : null), [fin]);
  const daySpec = useMemo(() => (days ? plantSpec(days) : null), [days]);

  const [billSort, setBillSort] = useState<[BillSort, boolean]>(["month", false]);
  const [outSort, setOutSort] = useState<[OutageSort, boolean]>(["start", true]);
  const [checkSort, setCheckSort] = useState<[CheckSort, boolean]>(["name", false]);
  const flip = <K,>(cur: [K, boolean], k: K): [K, boolean] => [k, cur[0] === k ? !cur[1] : true];

  if (load.state === "none") {
    return (
      <Card>
        <CardContent>
          <Empty>
            <EmptyHeader>
              <EmptyTitle>{t("This plant is not in the PWA daily meter report")}</EmptyTitle>
              <EmptyDescription>
                {t("Energy & Billing covers the PWA contract sites of phases 1–2, from the daily meter report imported monthly. This plant has no report site, so there is no billed energy to show.")}
              </EmptyDescription>
            </EmptyHeader>
            <Button asChild variant="outline" size="sm">
              <Link to="/energy-billing">{t("Fleet Energy & Billing")}</Link>
            </Button>
          </Empty>
        </CardContent>
      </Card>
    );
  }

  const site = data?.sites[0];
  const reportMonth = data?.coverage.report_month ?? null;
  const contractKwh = months.reduce<number | null>((a, m) => (m.contract_kwh == null ? a : (a ?? 0) + m.contract_kwh), null);
  const billedC = months.reduce((a, m) => a + (m.contract_kwh == null ? 0 : m.billed_c_kwh), 0);
  const vsContract = contractKwh ? (100 * billedC) / contractKwh : null;
  const missing = months.reduce((a, m) => a + m.missing_days, 0);
  const spend = fin?.spend;
  const outsideSpend = fin && fin.outside.events > 0 ? fin.outside : null;
  const period = data?.window.start && data.window.end ? `${fmtDay(data.window.start)} – ${fmtDay(data.window.end)}` : "—";

  const rows = b ? byKey(b.rows, (r) => billSortValue(r, billSort[0]), billSort[1]) : [];
  const outRows = data ? byKey(data.outages, (r) => outageSortValue(r, outSort[0]), outSort[1]) : [];
  const checkRows = data ? byKey(data.meter_check, (r) => checkSortValue(r, checkSort[0]), checkSort[1]) : [];

  return (
    <div className="flex flex-col gap-5">
      {/* header: source, period, refresh */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-lg font-semibold">{t("Energy & Billing")}</h1>
          {site && (
            <Badge variant="neutral" title={site.name}>
              {site.site_id}
            </Badge>
          )}
          {data?.coverage.last_day && <Badge variant="info">{t("Meter report to {day}", { day: fmtDay(data.coverage.last_day) })}</Badge>}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Select
            value={picked ? "month" : range}
            onValueChange={(v) => {
              if (v === "month") setUrl({ ...monthWindow(reportMonth ?? iso(new Date()).slice(0, 7)), range: null });
              else setUrl({ range: v === "report" ? null : v, from: null, to: null });
            }}
          >
            <SelectTrigger size="sm" className="w-auto min-w-40" aria-label={t("Period")}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {RANGES.map((r) => (
                <SelectItem key={r} value={r}>
                  {r === "report" && reportMonth ? `${t(RANGE_LABEL[r])} · ${fmtMonth(reportMonth, true)}` : t(RANGE_LABEL[r])}
                </SelectItem>
              ))}
              <SelectSeparator />
              <SelectItem value="month">{t("Select month")}</SelectItem>
            </SelectContent>
          </Select>
          {picked && (
            <Input
              type="month"
              aria-label={t("Month")}
              className="h-8 w-40 [color-scheme:dark]"
              value={picked}
              onChange={(e) => /^\d{4}-\d{2}$/.test(e.target.value) && setUrl({ ...monthWindow(e.target.value), range: null })}
            />
          )}
          <Button variant="outline" size="sm" onClick={() => setTick((n) => n + 1)} disabled={busy}>
            {busy ? <Spinner data-icon="inline-start" className="size-3" /> : <RefreshCw data-icon="inline-start" />}
            {t("Refresh")}
          </Button>
          {site && (
            <Button asChild variant="ghost" size="sm">
              <Link to={`/energy-billing?view=sites&site=${encodeURIComponent(site.site_id)}`}>{t("Fleet Energy & Billing")} →</Link>
            </Button>
          )}
        </div>
      </div>

      {load.state === "error" && <p className="callout-crit text-xs">{t("Could not load Energy & Billing: {error}", { error: load.error })}</p>}

      {load.state === "loading" ? (
        <>
          <SkeletonKpis count={6} />
          <SkeletonChart />
        </>
      ) : data && !b ? (
        <Card>
          <CardContent>
            <Empty>
              <EmptyHeader>
                <EmptyTitle>{t("No report days yet")}</EmptyTitle>
                <EmptyDescription>{t("The site is in the report, but no day of it has been imported.")}</EmptyDescription>
              </EmptyHeader>
            </Empty>
          </CardContent>
        </Card>
      ) : (
        data &&
        b && (
          <Suspended busy={busy} label={t("Loading the period…")}>
            <div className="flex flex-col gap-5">
              <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
                <StatTile label={t("Billed energy")} value={mwh(fin?.billed_kwh, 2)} unit="MWh" footer={<span title={t(BILLED_HINT)}>{period}</span>} />
                <StatTile
                  label={t("Billed value")}
                  value={thbShort(fin?.billed_thb)}
                  footer={<span title={thb(fin?.billed_thb)}>{t("at the book price ฿{p}/kWh", { p: fmt(b.price_thb_per_kwh, 4) })}</span>}
                />
                <StatTile
                  label={`${t("vs contract")} (${t("mod.")})`}
                  value={vsContract == null ? "—" : fmt(vsContract, 1)}
                  unit={vsContract == null ? undefined : "%"}
                  tone={vsContract == null || !bands ? undefined : vsContract < bands.watch ? "text-red-300" : vsContract < bands.good ? "text-amber-300" : "text-emerald-300"}
                  footer={<span title={t(MODELLED)}>{t("Contract {v} MWh", { v: mwh(contractKwh, 1) })}</span>}
                />
                <StatTile
                  label={t("Days without a reading")}
                  value={fmtInt(missing)}
                  tone={missing > 0 ? "text-red-300" : undefined}
                  footer={t("Outage events: {n}", { n: data.outages.length })}
                />
                <StatTile
                  label={t("O&M spend")}
                  value={spend?.thb == null ? "—" : thbShort(spend.thb)}
                  footer={<span title={t(ENTERED)}>{spend ? t("{n} of {total} have a cost", { n: fmtInt(spend.priced), total: fmtInt(spend.events) }) : "—"}</span>}
                />
                <StatTile
                  label={t("Spend / billed")}
                  value={fin?.ratio_pct == null ? "—" : fmt(fin.ratio_pct, 2)}
                  unit={fin?.ratio_pct == null ? undefined : "%"}
                  footer={<span title={t(FINANCE_HINT)}>{t("entered ÷ measured")}</span>}
                />
              </div>
              {outsideSpend && (
                <p className="text-[11px] text-muted-foreground">
                  {t("Site log spend in months the report does not cover is left out: {thb} ({n} events).", { thb: thb(outsideSpend.thb), n: fmtInt(outsideSpend.events) })}
                </p>
              )}

              <div className="grid gap-4 xl:grid-cols-2">
                <Card>
                  <CardHeader>
                    <CardTitle>{t("Billed vs contract by month")}</CardTitle>
                    <CardDescription>{t("Billed meter energy; contract modelled (dashed)")}</CardDescription>
                  </CardHeader>
                  <CardContent>
                    <PanelChart spec={monthSpec} height={300} legendPosition="bottom" emptyLabel={t("No billed energy in this period.")} />
                  </CardContent>
                </Card>
                <Card>
                  <CardHeader>
                    <CardTitle>{t("Billing vs O&M spend by month")}</CardTitle>
                    <CardDescription>{t(FINANCE_HINT)}</CardDescription>
                  </CardHeader>
                  <CardContent>
                    <PanelChart spec={finSpec} height={300} legendToggle legendPosition="bottom" emptyLabel={t("No billed energy in this period.")} />
                  </CardContent>
                </Card>
              </div>

              <Card>
                <CardHeader>
                  <CardTitle>{t("Meter vs Growatt by day")}</CardTitle>
                  <CardDescription>{t("Billed meter energy per day from the PWA report beside Growatt's own day energy; both measured")}</CardDescription>
                </CardHeader>
                <CardContent>
                  {days ? <PanelChart spec={daySpec} height={300} legendToggle legendPosition="bottom" emptyLabel={t("No report days for this plant.")} /> : <SkeletonChart />}
                </CardContent>
              </Card>

              <Card className="gap-3">
                <CardHeader>
                  <Tabs value={view} onValueChange={(v) => setUrl({ view: v === "billing" ? null : v })}>
                    <TabsList variant="line">
                      <TabsTrigger value="billing">{t("Billing by month")}</TabsTrigger>
                      <TabsTrigger value="outages">
                        {t("Outage events")} <span className="num ml-1 text-muted-foreground">{data.outages.length}</span>
                      </TabsTrigger>
                      <TabsTrigger value="meter">{t("Meter check")}</TabsTrigger>
                    </TabsList>
                  </Tabs>
                </CardHeader>
                <CardContent>
                  {view === "billing" ? (
                    rows.length ? (
                      <BillingTable rows={rows} sort={billSort[0]} desc={billSort[1]} onSort={(k) => setBillSort((c) => flip(c, k))} onOpen={(s) => setUrl({ site: s })} />
                    ) : (
                      <p className="text-xs text-muted-foreground">{t("No billed energy in this period.")}</p>
                    )
                  ) : view === "outages" ? (
                    outRows.length ? (
                      <OutagesTable
                        rows={outRows}
                        sort={outSort[0]}
                        desc={outSort[1]}
                        onSort={(k) => setOutSort((c) => flip(c, k))}
                        onOpen={(s) => setUrl({ site: s })}
                        longDays={criteria?.outage_event?.long_event_days ?? Infinity}
                      />
                    ) : (
                      <p className="text-xs text-muted-foreground">{t("No outage in this period.")}</p>
                    )
                  ) : checkRows.length ? (
                    <MeterCheckTable rows={checkRows} sort={checkSort[0]} desc={checkSort[1]} onSort={(k) => setCheckSort((c) => flip(c, k))} onOpen={(s) => setUrl({ site: s })} />
                  ) : (
                    <p className="text-xs text-muted-foreground">{t("No meter check for this period.")}</p>
                  )}
                </CardContent>
              </Card>
            </div>
          </Suspended>
        )
      )}

      {data && siteOpen && (
        <SiteDialog
          siteId={siteOpen}
          window={data.window}
          row={undefined}
          check={data.meter_check.find((c) => c.site_id === siteOpen)}
          outages={data.outages.filter((o) => o.site_id === siteOpen)}
          onClose={() => setUrl({ site: null })}
        />
      )}
    </div>
  );
};

/** `/plant/:id/billing`: the plant banner and tab bar, then the plant's Energy & Billing. */
export const PlantBillingPage: React.FC = () => {
  const { selectedGrowattPlantId: plantId } = useAppContext();
  return (
    <div className="space-y-6">
      <SelectedPlantBanner />
      {plantId != null && <PlantBilling key={plantId} plantId={plantId} />}
    </div>
  );
};

export default PlantBillingPage;
