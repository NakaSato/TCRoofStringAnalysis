/**
 * Devices page, Inverters tab (docs/plans/devices-page.md §4.1): every inverter the user may see in
 * one table. Registry, settings, stored freshness / yield and work come from the DB list
 * (`useDeviceInverters`, read on mount / Refresh / "show not installed", never polled); the "Now"
 * group is the fleet inverter snapshot (`maxs_data`, memory only), overlaid by serial, each value
 * with its own record time. Missing = "—", never 0.
 *
 * Parts: `invertersTable` (filter, sort, CSV), `InvertersFilterBar`, `InverterTableRow`.
 */
import React, { useEffect, useMemo, useState } from "react";
import { Download } from "lucide-react";
import { SkeletonRows, Suspended, fmtInt } from "../../components/ui";
import { TablePager, pageBounds } from "../../components/TablePager";
import { pick, useUrlState } from "@/lib/useUrlState";
import { cn } from "@/lib/utils";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { Field, FieldLabel } from "@/components/ui/field";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { SortHead } from "../pwaMeter/tables";
import { hhmm, plantNow } from "../sensors/format";
import { useI18n } from "../../i18n";
import { LIVE_STATES, liveState } from "./inverters";
import type { DeviceInverters, LiveFilter } from "./inverters";
import { InverterTableRow } from "./InverterTableRow";
import { InvertersFilterBar } from "./InvertersFilterBar";
import { PAGE, SHOWS, SORTS, TEXT_SORTS, exportInvertersCsv, filterAndSort, modelOf } from "./invertersTable";
import type { InverterFilters, Row, SortKey } from "./invertersTable";

/** The second header row: [sort key, label, class, tooltip]. */
const COLUMNS: Array<[SortKey, string, string?, string?]> = [
  ["plant", "Plant", "pl-4"],
  ["phase", "Phase"],
  ["province", "Province"],
  ["inv", "Inverter"],
  ["sn", "SN"],
  ["model", "Model"],
  ["kw", "Rated kW", "text-right", "Nameplate AC kW"],
  ["fw", "Firmware"],
  ["dl", "Datalogger"],
  ["status", "Status", "border-l border-white/[0.06]"],
  ["pac", "AC kW", "text-right"],
  ["eac", "Today kWh", "text-right", "Today's energy in the live record (only when the record is from today)"],
  ["temp", "°C", "text-right", "Inverter temperature in the live record"],
  ["rec", "Record", undefined, "Time of Growatt's newest record: a silent inverter's record can be months old"],
  ["last", "Last stored", "border-l border-white/[0.06]", "Newest record in our history"],
  ["yield", "Yield today", "text-right", "Today's stored yield, kWh"],
  ["pct", "% of plant", "text-right", "Stored yield today ÷ the mean of the plant's installed inverters with a yield today"],
  ["limit", "Limit", "border-l border-white/[0.06] text-right", "Configured active power limit"],
  ["onoff", "On / off"],
  ["issues", "Issues", "border-l border-white/[0.06]", "Open issues and the highest tier"],
  ["alarms", "Alarms today", "pr-4", "Stored alarm-log records today (open ones)"],
];
/** The first header row: [group, columns, class]. */
const GROUPS: Array<[string, number, string?]> = [
  ["Inverter", 9, "border-l-0 pl-4"],
  ["Now (live)", 5],
  ["Stored", 3],
  ["Settings", 2],
  ["Work", 2],
];
const UNTRANSLATED = new Set(["SN", "AC kW", "°C"]);

const uniqueSorted = <T,>(values: Array<T | null | undefined>, by?: (a: T, b: T) => number) =>
  [...new Set(values.filter((v): v is T => v != null && v !== ""))].sort(by);

export const InvertersTab: React.FC<{ d: DeviceInverters }> = ({ d }) => {
  const { t } = useI18n();
  const [url, setUrl] = useUrlState();
  const statusParam = url.get("status");
  const f: InverterFilters = {
    query: url.get("q") ?? "",
    phase: url.get("phase") ?? "",
    model: url.get("model") ?? "",
    fw: url.get("fw") ?? "",
    status: statusParam != null && (LIVE_STATES as readonly string[]).includes(statusParam) ? (statusParam as LiveFilter) : "",
    show: pick(url.get("show"), SHOWS, "all"),
    ni: url.get("ni") === "1",
  };
  const sort: SortKey = pick(url.get("sort"), SORTS, "plant");
  const desc = url.get("desc") === "1";

  const { list, error, loading, snap, snapError, counts, sweepDone } = d;
  const day = snap?.data.day;
  const [now, setNow] = useState(plantNow);
  useEffect(() => setNow(plantNow()), [list, snap]);

  const all = useMemo<Row[]>(
    () =>
      (list?.inverters ?? []).map((inv) => {
        const live = inv.not_installed ? undefined : snap?.data.inverters[inv.device_sn];
        return { inv, live, st: inv.not_installed ? null : liveState(live, day) };
      }),
    [list, snap, day]
  );
  const phases = useMemo(() => uniqueSorted(all.map((r) => r.inv.phase), (a, b) => a - b), [all]);
  const models = useMemo(() => uniqueSorted(all.map((r) => modelOf(r.inv))), [all]);
  const fws = useMemo(() => uniqueSorted(all.map((r) => r.inv.fw_version)), [all]);

  const filterKey = JSON.stringify(f);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- `f` is rebuilt each render; `filterKey` is its value
  const rows = useMemo(() => filterAndSort(all, f, sort, desc), [all, filterKey, sort, desc]);

  // PAGE rows at a time; back to page 1 when a filter or the sort changes (not on a re-read)
  const [page, setPage] = useState(0);
  useEffect(() => setPage(0), [filterKey, sort, desc]);
  const { pageNo } = pageBounds(rows.length, PAGE, page);
  const pageRows = rows.slice(pageNo * PAGE, (pageNo + 1) * PAGE);

  const onSort = (k: SortKey) => setUrl({ sort: k === "plant" ? null : k, desc: sort === k ? !desc : !TEXT_SORTS.has(k) });

  const liveBadge = snapError && !snap ? (
    <Badge variant="crit" title={snapError}>{t("Live unavailable")}</Badge>
  ) : sweepDone && snap ? (
    <Badge variant="ok" title={t("Oldest inverter check {time}", { time: snap.fetched_at })}>
      {t("Live")} · {hhmm(snap.fetched_at)}
    </Badge>
  ) : (
    <Badge variant="info" title={t("Growatt's newest inverter records are fetched 50 inverters per call, a few calls per request")}>
      {t("Checked {n}/{total}", { n: fmtInt(counts?.checked ?? 0), total: fmtInt(counts?.total ?? list?.summary.installed ?? 0) })}
    </Badge>
  );

  return (
    <Card className="gap-0 py-0">
      <CardHeader className="flex flex-col gap-3 border-b border-white/[0.06] px-4 py-3">
        <div className="flex w-full flex-wrap items-center justify-between gap-2">
          <div className="flex min-w-0 flex-col gap-0.5">
            <CardTitle className="flex flex-wrap items-center gap-2">
              {t("Inverters")}
              {list && <span className="num text-xs font-normal text-muted-foreground">{t("{n} of {total}", { n: fmtInt(rows.length), total: fmtInt(all.length) })}</span>}
              {liveBadge}
            </CardTitle>
            <CardDescription>{t("Now = Growatt's newest record (live, never stored) · Stored = our history · a row opens the inverter")}</CardDescription>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Field orientation="horizontal" className="w-auto gap-2">
              <Switch id="devices-ni" size="sm" checked={f.ni} onCheckedChange={(on) => setUrl({ ni: on ? "1" : null })} />
              <FieldLabel htmlFor="devices-ni" className="text-xs font-normal">
                {t("Show not installed")}
              </FieldLabel>
            </Field>
            <Button variant="outline" size="sm" onClick={() => exportInvertersCsv(rows, list?.meta.day ?? now.slice(0, 10))} disabled={!rows.length}>
              <Download data-icon="inline-start" />
              {t("Export CSV")}
            </Button>
          </div>
        </div>
        <InvertersFilterBar f={f} phases={phases} models={models} fws={fws} setUrl={setUrl} />
      </CardHeader>
      <CardContent className="px-0">
        {error && (
          <Alert variant="destructive" className="m-4 w-auto">
            <AlertDescription>{list ? t("Refresh failed: {error}", { error }) : t("Inverter list unavailable: {error}", { error })}</AlertDescription>
          </Alert>
        )}
        {!list && loading ? (
          <SkeletonRows rows={10} className="px-4 py-3" />
        ) : !list ? null : !rows.length ? (
          <Empty className="py-10">
            <EmptyHeader>
              <EmptyTitle>{t("No inverter matches")}</EmptyTitle>
              <EmptyDescription>
                {all.length ? t("Change the filter or search.") : t("None of the plants you can see has an inverter registered. Engineers see only the plants an admin assigned to them.")}
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <Suspended busy={loading}>
            <Table containerClassName="table-wrap max-h-[70vh] overflow-auto">
              <TableHeader className="sticky top-0 z-10 bg-card">
                <TableRow>
                  {GROUPS.map(([label, span, className]) => (
                    <TableHead
                      key={label}
                      colSpan={span}
                      className={cn("h-7 border-l border-white/[0.06] text-[10px] font-semibold uppercase tracking-wider text-muted-foreground", className)}
                    >
                      {t(label)}
                    </TableHead>
                  ))}
                </TableRow>
                <TableRow>
                  {COLUMNS.map(([k, label, className, title]) => (
                    <SortHead
                      key={k}
                      k={k}
                      label={UNTRANSLATED.has(label) ? label : t(label)}
                      sort={sort}
                      desc={desc}
                      onSort={onSort}
                      className={className}
                      title={title ? t(title) : undefined}
                    />
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {pageRows.map((r) => (
                  <InverterTableRow key={r.inv.device_sn} row={r} day={day} listDay={list.meta.day} now={now} />
                ))}
              </TableBody>
            </Table>
            <TablePager className="border-t border-white/[0.06] px-4 py-2.5" rows={rows.length} pageSize={PAGE} pageNo={pageNo} onPage={setPage} />
          </Suspended>
        )}
      </CardContent>
      <CardFooter className="border-t border-white/[0.06] px-4 py-3">
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          {t(
            "Status: normal / waiting / fault = a status 1 / 0 / 3 record from today; offline = no record today (an older record is never read as current); not checked = the live sweep has not reached it yet. AC kW and °C are shown only for a record from today."
          )}{" "}
          {t("Stored values come from our history, not from the live record. Limit and on / off are configured settings as last read from Growatt.")}{" "}
          {t("Inverters marked not installed are left out of every count; Show not installed lists them greyed.")}
          {snapError && snap ? ` ${t("Live refresh failed: {error}", { error: snapError })}` : ""}
          {list?.meta.synced_at ? ` ${t("History stored up to the sync that started {time}.", { time: hhmm(list.meta.synced_at) })}` : ""}
        </p>
      </CardFooter>
    </Card>
  );
};
