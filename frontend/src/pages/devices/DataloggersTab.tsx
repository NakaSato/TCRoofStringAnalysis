/** Devices page, Dataloggers tab (docs/plans/devices-page.md §4.4): datalogger serials grouped from the
 * stored inverters, sensors and meters, with the site register's logger SN (DB only, no live state). */
import React, { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Download, Search } from "lucide-react";
import { api } from "../../api/client";
import type { DeviceDatalogger } from "../../api/client";
import { Suspended, fmtInt } from "../../components/ui";
import { TablePager, pageBounds } from "../../components/TablePager";
import { plantPath } from "../../context/routes";
import { pick, useUrlState } from "@/lib/useUrlState";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { SortHead } from "../pwaMeter/tables";
import { downloadCsv } from "../pwaMeter/format";
import { useI18n } from "../../i18n";
import { CountOf, PlantLink, RecordAge, RefreshButton, SyncedLine, TabLoading, TABS_PAGE, ageMinutes, sortNullsLast, useDeviceList } from "./tabsShared";

const SORTS = ["name", "serial", "model", "inverters", "sensors", "meters", "last", "match"] as const;
type SortKey = (typeof SORTS)[number];
const MATCHES = ["all", "match", "prefix", "differs", "none"] as const;
type MatchFilter = (typeof MATCHES)[number];

type Match = DeviceDatalogger["register_match"];
const matchKey = (m: Match): Exclude<MatchFilter, "all"> => m ?? "none";
const MATCH_LABEL: Record<Exclude<MatchFilter, "all">, string> = { match: "Matches", prefix: "Prefix only", differs: "Differs", none: "No register SN" };
const MATCH_VARIANT: Record<Exclude<MatchFilter, "all">, "ok" | "info" | "warn" | "neutral"> = { match: "ok", prefix: "info", differs: "warn", none: "neutral" };
const MATCH_TIP: Record<Exclude<MatchFilter, "all">, string> = {
  match: "The site register's logger SN is this serial",
  prefix: "The site register holds only the start of this serial (truncated)",
  differs: "The site register's logger SN is a different serial",
  none: "The plant's site register has no logger SN",
};
/** order for the match sort: problems first */
const MATCH_RANK: Record<Exclude<MatchFilter, "all">, number> = { differs: 0, prefix: 1, none: 2, match: 3 };

const sortValue = (d: DeviceDatalogger, k: SortKey): number | string | null => {
  switch (k) {
    case "name":
      return d.plant_name.toLowerCase();
    case "serial":
      return d.datalogger_sn;
    case "model":
      return d.model?.toLowerCase() ?? null;
    case "inverters":
      return d.inverters;
    case "sensors":
      return d.sensors;
    case "meters":
      return d.meters;
    case "last":
      return d.last_record;
    case "match":
      return MATCH_RANK[matchKey(d.register_match)];
  }
};

/** `reloadSignal`: bumped by the page-level Refresh to re-read this tab. */
export const DataloggersTab: React.FC<{ reloadSignal?: number }> = ({ reloadSignal = 0 }) => {
  const { t } = useI18n();
  const { data, error, loading, refresh } = useDeviceList(api.listDeviceDataloggers, reloadSignal);
  const [url, setUrl] = useUrlState();
  const query = url.get("dq") ?? "";
  const match: MatchFilter = pick(url.get("dmatch"), MATCHES, "all");
  const sort: SortKey = pick(url.get("dsort"), SORTS, "name");
  const desc = url.get("ddesc") === "1";

  const counts = useMemo(() => {
    const c: Record<Exclude<MatchFilter, "all">, number> = { match: 0, prefix: 0, differs: 0, none: 0 };
    for (const d of data?.dataloggers ?? []) c[matchKey(d.register_match)]++;
    return c;
  }, [data]);
  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = (data?.dataloggers ?? []).filter(
      (d) =>
        (match === "all" || matchKey(d.register_match) === match) &&
        (!q || [d.plant_name, String(d.plant_id), d.datalogger_sn, d.model, d.register_sn, d.province].some((v) => v != null && v.toLowerCase().includes(q)))
    );
    return sortNullsLast(list, (d) => sortValue(d, sort), desc);
  }, [data, match, query, sort, desc]);
  const countGaps = useMemo(() => (data?.plants ?? []).filter((p) => p.growatt_count != null && p.growatt_count !== p.found), [data]);

  const setSort = (k: SortKey) => setUrl({ dsort: k === "name" ? null : k, ddesc: sort === k ? !desc : ["inverters", "sensors", "meters"].includes(k) });

  const [page, setPage] = useState(0);
  useEffect(() => setPage(0), [match, query, sort, desc]);
  const { pageNo } = pageBounds(rows.length, TABS_PAGE, page);
  const pageRows = rows.slice(pageNo * TABS_PAGE, (pageNo + 1) * TABS_PAGE);

  const exportCsv = () =>
    downloadCsv(
      `device_dataloggers_${data?.meta.day ?? "today"}.csv`,
      ["plant_id", "plant", "phase", "province", "datalogger_sn", "model", "inverters", "sensors", "meters", "last_record", "age_min", "register_sn", "register_match"],
      rows.map((d) => {
        const age = ageMinutes(d.last_record);
        return [
          d.plant_id, d.plant_name, d.phase, d.province, d.datalogger_sn, d.model, d.inverters, d.sensors, d.meters, d.last_record,
          age == null ? null : Math.round(age), d.register_sn, d.register_match,
        ];
      })
    );

  if (!data && loading) return <TabLoading title={t("Dataloggers")} cols={8} controls={4} />;

  return (
    <div className="flex flex-col gap-4">
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {countGaps.length > 0 && (
        <Alert>
          <AlertTitle>{t("{n} plant(s) where Growatt's datalogger count differs from the serials found", { n: countGaps.length })}</AlertTitle>
          <AlertDescription>
            <span className="text-muted-foreground">{t("Growatt's count is what was entered for the plant; found = serials behind its stored inverters, sensors and meters.")}</span>
            <span className="mt-1 flex flex-wrap gap-1.5">
              {countGaps.map((p) => (
                <Badge key={p.plant_id} variant="warn" asChild>
                  <Link to={plantPath(p.plant_id)}>
                    {p.plant_name} · {t("Growatt {g} / found {f}", { g: p.growatt_count ?? "—", f: p.found })}
                  </Link>
                </Badge>
              ))}
            </span>
          </AlertDescription>
        </Alert>
      )}
      <Card className="gap-3">
        <CardHeader className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-col gap-0.5">
            <CardTitle className="flex items-center gap-2">
              {t("Dataloggers")}
              {data && <span className="num text-xs font-normal text-muted-foreground"><CountOf n={rows.length} total={data.dataloggers.length} /></span>}
            </CardTitle>
            <CardDescription>
              <SyncedLine syncedAt={data?.meta.synced_at} />
            </CardDescription>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Select value={match} onValueChange={(v) => setUrl({ dmatch: v === "all" ? null : v })}>
              <SelectTrigger size="sm" className="w-auto min-w-36" aria-label={t("Site register SN")}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{t("Any register SN")}</SelectItem>
                {(["differs", "prefix", "none", "match"] as const).map((m) => (
                  <SelectItem key={m} value={m}>
                    {t(MATCH_LABEL[m])} ({fmtInt(counts[m])})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <InputGroup className="h-8 w-56">
              <InputGroupAddon>
                <Search />
              </InputGroupAddon>
              <InputGroupInput placeholder={t("Search plant, SN, model")} value={query} onChange={(e) => setUrl({ dq: e.target.value || null })} />
            </InputGroup>
            {(match !== "all" || query) && (
              <Button variant="ghost" size="sm" onClick={() => setUrl({ dmatch: null, dq: null })}>
                {t("Clear")}
              </Button>
            )}
            <RefreshButton loading={loading} onClick={refresh} />
            <Button variant="outline" size="sm" onClick={exportCsv} disabled={!rows.length}>
              <Download data-icon="inline-start" />
              {t("Export CSV")}
            </Button>
          </div>
        </CardHeader>
        <CardContent className="px-0">
          {!rows.length ? (
            <Empty>
              <EmptyHeader>
                <EmptyTitle>{t("No dataloggers")}</EmptyTitle>
                <EmptyDescription>{data?.dataloggers.length ? t("No datalogger matches the filter.") : t("No datalogger serial is stored for your plants.")}</EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <Suspended busy={loading}>
              <Table containerClassName="table-wrap">
                <TableHeader className="sticky top-0 z-10 bg-card">
                  <TableRow>
                    <SortHead k="name" label={t("Plant")} sort={sort} desc={desc} onSort={setSort} className="pl-4" />
                    <SortHead k="serial" label={t("Serial")} sort={sort} desc={desc} onSort={setSort} />
                    <SortHead k="model" label={t("Model")} sort={sort} desc={desc} onSort={setSort} />
                    <SortHead k="inverters" label={t("Inverters")} sort={sort} desc={desc} onSort={setSort} className="text-right" />
                    <SortHead k="sensors" label={t("Sensors")} sort={sort} desc={desc} onSort={setSort} className="text-right" />
                    <SortHead k="meters" label={t("Meters")} sort={sort} desc={desc} onSort={setSort} className="text-right" />
                    <SortHead k="last" label={t("Last record")} sort={sort} desc={desc} onSort={setSort} title={t("Newest stored record of any device behind it; amber when more than 2 h old")} />
                    <SortHead k="match" label={t("Site register SN")} sort={sort} desc={desc} onSort={setSort} className="pr-4" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {pageRows.map((d) => {
                    const m = matchKey(d.register_match);
                    return (
                      <TableRow key={`${d.plant_id}:${d.datalogger_sn}`}>
                        <TableCell className="max-w-[280px] pl-4">
                          <PlantLink id={d.plant_id} name={d.plant_name} />
                        </TableCell>
                        <TableCell className="num">{d.datalogger_sn}</TableCell>
                        <TableCell className="text-muted-foreground">{d.model ?? "—"}</TableCell>
                        <TableCell className="num text-right">{fmtInt(d.inverters)}</TableCell>
                        <TableCell className="num text-right">{fmtInt(d.sensors)}</TableCell>
                        <TableCell className="num text-right">{fmtInt(d.meters)}</TableCell>
                        <TableCell>
                          <RecordAge value={d.last_record} />
                        </TableCell>
                        <TableCell className="whitespace-nowrap pr-4">
                          <span className="flex items-center gap-2">
                            <Badge variant={MATCH_VARIANT[m]} title={t(MATCH_TIP[m])}>
                              {t(MATCH_LABEL[m])}
                            </Badge>
                            {d.register_sn && m !== "match" && <span className="num text-[11px] text-muted-foreground">{d.register_sn}</span>}
                          </span>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
              <TablePager className="border-t border-white/[0.06] px-4 py-2.5" rows={rows.length} pageSize={TABS_PAGE} pageNo={pageNo} onPage={setPage} />
            </Suspended>
          )}
        </CardContent>
      </Card>
    </div>
  );
};
