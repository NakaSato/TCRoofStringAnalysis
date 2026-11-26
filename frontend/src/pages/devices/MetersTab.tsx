/** Devices page, Meters tab (docs/plans/devices-page.md §4.3): every registered energy meter with its
 * stored freshness and today's measured import / export (DB only, `api.listDeviceMeters`). */
import React, { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Download, Search } from "lucide-react";
import { api } from "../../api/client";
import type { DeviceMeter } from "../../api/client";
import { Suspended, fmt, fmtInt } from "../../components/ui";
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

const SORTS = ["name", "phase", "province", "logger", "last", "import", "export", "records"] as const;
type SortKey = (typeof SORTS)[number];

const sortValue = (m: DeviceMeter, k: SortKey): number | string | null => {
  switch (k) {
    case "name":
      return m.plant_name.toLowerCase();
    case "phase":
      return m.phase;
    case "province":
      return m.province?.toLowerCase() ?? null;
    case "logger":
      return `${m.datalogger_sn}:${String(m.address).padStart(4, "0")}`;
    case "last":
      return m.last_record;
    case "import":
      return m.import_today_kwh;
    case "export":
      return m.export_today_kwh;
    case "records":
      return m.records_today;
  }
};

/** `reloadSignal`: bumped by the page-level Refresh to re-read this tab. */
export const MetersTab: React.FC<{ reloadSignal?: number }> = ({ reloadSignal = 0 }) => {
  const { t } = useI18n();
  const { data, error, loading, refresh } = useDeviceList(api.listDeviceMeters, reloadSignal);
  const [url, setUrl] = useUrlState();
  const query = url.get("mq") ?? "";
  const phase = url.get("mphase") ?? "";
  const sort: SortKey = pick(url.get("msort"), SORTS, "name");
  const desc = url.get("mdesc") === "1";

  const phases = useMemo(
    () => [...new Set((data?.meters ?? []).map((m) => m.phase).filter((p): p is number => p != null))].sort((a, b) => a - b),
    [data]
  );
  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = (data?.meters ?? []).filter(
      (m) =>
        (!phase || String(m.phase ?? "") === phase) &&
        (!q ||
          [m.plant_name, String(m.plant_id), m.province, m.datalogger_sn, m.device_name, m.device_type].some((v) => v != null && v.toLowerCase().includes(q)))
    );
    return sortNullsLast(list, (m) => sortValue(m, sort), desc);
  }, [data, phase, query, sort, desc]);

  const setSort = (k: SortKey) =>
    setUrl({ msort: k === "name" ? null : k, mdesc: sort === k ? !desc : ["import", "export", "records"].includes(k) });

  const [page, setPage] = useState(0);
  useEffect(() => setPage(0), [phase, query, sort, desc]);
  const { pageNo } = pageBounds(rows.length, TABS_PAGE, page);
  const pageRows = rows.slice(pageNo * TABS_PAGE, (pageNo + 1) * TABS_PAGE);

  const exportCsv = () =>
    downloadCsv(
      `device_meters_${data?.meta.day ?? "today"}.csv`,
      ["plant_id", "plant", "phase", "province", "datalogger_sn", "address", "device_name", "device_type", "last_record", "age_min", "import_today_kwh", "export_today_kwh", "records_today"],
      rows.map((m) => {
        const age = ageMinutes(m.last_record);
        return [
          m.plant_id, m.plant_name, m.phase, m.province, m.datalogger_sn, m.address, m.device_name, m.device_type, m.last_record,
          age == null ? null : Math.round(age), m.import_today_kwh, m.export_today_kwh, m.records_today,
        ];
      })
    );

  if (!data && loading) return <TabLoading title={t("Energy meters")} cols={10} controls={4} />;

  const without = data?.plants_without_meter ?? [];
  return (
    <div className="flex flex-col gap-4">
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {without.length > 0 && (
        <Alert>
          <AlertTitle>{t("{n} plant(s) without a registered energy meter", { n: without.length })}</AlertTitle>
          <AlertDescription>
            <span className="text-muted-foreground">{t("Grid import / export and load cannot be shown for these plants.")}</span>
            <span className="mt-1 flex flex-wrap gap-1.5">
              {without.map((p) => (
                <Badge key={p.plant_id} variant="neutral" asChild>
                  <Link to={plantPath(p.plant_id)} title={String(p.plant_id)}>
                    {p.plant_name}
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
              {t("Energy meters")}
              {data && <span className="num text-xs font-normal text-muted-foreground"><CountOf n={rows.length} total={data.meters.length} /></span>}
            </CardTitle>
            <CardDescription>
              <SyncedLine syncedAt={data?.meta.synced_at} />
            </CardDescription>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Select value={phase || "all"} onValueChange={(v) => setUrl({ mphase: v === "all" ? null : v })}>
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
              <InputGroupInput placeholder={t("Search plant, SN, name")} value={query} onChange={(e) => setUrl({ mq: e.target.value || null })} />
            </InputGroup>
            {(phase || query) && (
              <Button variant="ghost" size="sm" onClick={() => setUrl({ mphase: null, mq: null })}>
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
                <EmptyTitle>{t("No meters")}</EmptyTitle>
                <EmptyDescription>{data?.meters.length ? t("No meter matches the filter.") : t("No energy meter is registered on your plants.")}</EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <Suspended busy={loading}>
              <Table containerClassName="table-wrap">
                <TableHeader className="sticky top-0 z-10 bg-card">
                  <TableRow>
                    <SortHead k="name" label={t("Plant")} sort={sort} desc={desc} onSort={setSort} className="pl-4" />
                    <SortHead k="phase" label={t("Phase")} sort={sort} desc={desc} onSort={setSort} />
                    <SortHead k="province" label={t("Province")} sort={sort} desc={desc} onSort={setSort} />
                    <SortHead k="logger" label={t("Datalogger SN")} sort={sort} desc={desc} onSort={setSort} />
                    <TableHead className="text-right">{t("Address")}</TableHead>
                    <TableHead>{t("Name / type")}</TableHead>
                    <SortHead k="last" label={t("Last record")} sort={sort} desc={desc} onSort={setSort} title={t("Newest stored record; amber when more than 2 h old")} />
                    <SortHead k="import" label={t("Import today (kWh)")} sort={sort} desc={desc} onSort={setSort} className="text-right" title={t("Measured by the meter, from the stored records")} />
                    <SortHead k="export" label={t("Export today (kWh)")} sort={sort} desc={desc} onSort={setSort} className="text-right" title={t("Measured by the meter, from the stored records")} />
                    <SortHead k="records" label={t("Records today")} sort={sort} desc={desc} onSort={setSort} className="pr-4 text-right" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {pageRows.map((m) => (
                    <TableRow key={`${m.plant_id}:${m.datalogger_sn}:${m.address}`}>
                      <TableCell className="max-w-[280px] pl-4">
                        <PlantLink id={m.plant_id} name={m.plant_name} />
                      </TableCell>
                      <TableCell className="num text-muted-foreground">{m.phase ?? "—"}</TableCell>
                      <TableCell className="text-muted-foreground">{m.province ?? "—"}</TableCell>
                      <TableCell className="num">{m.datalogger_sn}</TableCell>
                      <TableCell className="num text-right text-muted-foreground">{m.address}</TableCell>
                      <TableCell className="max-w-[220px]">
                        <span className="block truncate" title={m.device_name ?? undefined}>
                          {m.device_name ?? "—"}
                        </span>
                        {m.device_type && <span className="block truncate text-[11px] text-muted-foreground">{m.device_type}</span>}
                      </TableCell>
                      <TableCell>
                        <RecordAge value={m.last_record} />
                      </TableCell>
                      <TableCell className="num text-right">{fmt(m.import_today_kwh, 1)}</TableCell>
                      <TableCell className="num text-right">{fmt(m.export_today_kwh, 1)}</TableCell>
                      <TableCell className="num pr-4 text-right text-muted-foreground">{fmtInt(m.records_today)}</TableCell>
                    </TableRow>
                  ))}
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
