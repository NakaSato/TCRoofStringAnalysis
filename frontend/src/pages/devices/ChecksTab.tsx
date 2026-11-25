/** Devices page, Checks tab (docs/plans/devices-page.md §4.5): automated device checks, computed by the
 * backend on request (never stored), each with its reason and where it gets fixed (`api.listDeviceChecks`, read by the Devices page). */
import React, { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { ChevronDown, Download, Search, Wrench } from "lucide-react";
import type { DeviceCheck, DeviceCheckCode, DeviceCheckList, DeviceKind } from "../../api/client";
import { LoadingState, Suspended, fmtInt } from "../../components/ui";
import { TablePager, pageBounds } from "../../components/TablePager";
import { appPath } from "@/lib/safeUrl";
import { pick, useUrlState } from "@/lib/useUrlState";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { downloadCsv } from "../pwaMeter/format";
import { useI18n } from "../../i18n";
import { PlantLink, RefreshButton, SyncedLine, TABS_PAGE } from "./tabsShared";

/** every check code in display order, with its title and a one-line explanation (English keys, Thai in i18n) */
const CHECKS: Record<DeviceCheckCode, { title: string; about: string }> = {
  inverter_never_reported: { title: "Inverter never reported", about: "Installed, but no history stored more than 3 days after it was added to Growatt." },
  inverter_silent: { title: "Inverter silent", about: "In daylight, its newest stored record is more than 2 h behind the plant's other inverters." },
  inverter_switched_off: { title: "Inverter switched off", about: "The inverter's on / off setting is off." },
  inverter_limited: { title: "Inverter power-limited", about: "The configured active power limit is below 100 %." },
  nameplate_missing: { title: "Nameplate missing", about: "No nominal or rated power is stored, so rated AC kW and the clipping checks are off." },
  info_not_read: { title: "Device info not read", about: "The inverter's info or settings were not read for more than 3 times their refresh interval." },
  firmware_minority: { title: "Firmware differs", about: "Runs other firmware than most inverters of the same model." },
  no_string_layout: { title: "No String Layout", about: "Plant with inverters that have no String Layout: voltage per module and per-kWp peer checks stay off." },
  inverter_count_mismatch: { title: "Inverter count differs", about: "The count entered in Growatt matches neither the installed inverters nor the registry total." },
  logger_sn_mismatch: { title: "Logger SN differs", about: "The site register's logger SN differs from Growatt's datalogger serial." },
  no_meter: { title: "No energy meter", about: "The plant has no registered meter, so grid import / export and load cannot be shown." },
  meter_silent: { title: "Meter silent", about: "In daylight, the newest stored meter record is more than 2 h behind the last history sync." },
  sensor_probe_missing: { title: "Sensor probe missing", about: "The weather sensor reports no value for one of its probes." },
  sensor_irradiance_zero_daylight: { title: "Irradiance zero in daylight", about: "The sensor reported zero irradiance through daylight hours." },
};
const CODES = Object.keys(CHECKS) as DeviceCheckCode[];
const SEVERITIES = ["all", "warn", "info"] as const;
const KIND_LABEL: Record<DeviceKind, string> = { inverter: "Inverter", meter: "Meter", sensor: "Sensor", datalogger: "Datalogger", plant: "Plant" };
const codeOrder = (c: DeviceCheckCode) => CODES.indexOf(c);

/** The checks list is read by the page (its header tile shows the same count), so one request serves both. */
export const ChecksTab: React.FC<{ data: DeviceCheckList | null; error: string | null; loading: boolean; refresh: () => void }> = ({
  data,
  error,
  loading,
  refresh,
}) => {
  const { t } = useI18n();
  const [url, setUrl] = useUrlState();
  const query = url.get("cq") ?? "";
  const code = pick<DeviceCheckCode | "">(url.get("ccode"), CODES, "");
  const sev = pick(url.get("csev"), SEVERITIES, "all");
  const plant = url.get("cplant") ?? "";

  const plants = useMemo(() => {
    const m = new Map<number, string>();
    for (const c of data?.checks ?? []) m.set(c.plant_id, c.plant_name);
    return [...m].sort((a, b) => a[1].localeCompare(b[1]));
  }, [data]);
  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = (data?.checks ?? []).filter(
      (c) =>
        (!code || c.code === code) &&
        (sev === "all" || c.severity === sev) &&
        (!plant || String(c.plant_id) === plant) &&
        (!q || [c.plant_name, String(c.plant_id), c.device_key, c.device_label, c.reason, c.code].some((v) => v != null && v.toLowerCase().includes(q)))
    );
    // warn first, then by check, then plant and device
    return [...list].sort(
      (a, b) =>
        (a.severity === b.severity ? 0 : a.severity === "warn" ? -1 : 1) ||
        codeOrder(a.code) - codeOrder(b.code) ||
        a.plant_name.localeCompare(b.plant_name) ||
        (a.device_label ?? a.device_key ?? "").localeCompare(b.device_label ?? b.device_key ?? "")
    );
  }, [data, code, sev, plant, query]);

  // the chips list every code that fired, in display order, with the backend's counts
  const chips = useMemo(() => {
    const by = data?.summary.by_code ?? {};
    return CODES.filter((c) => (by[c] ?? 0) > 0).map((c) => ({
      code: c,
      n: by[c] ?? 0,
      warn: (data?.checks ?? []).some((x) => x.code === c && x.severity === "warn"),
    }));
  }, [data]);

  const [page, setPage] = useState(0);
  useEffect(() => setPage(0), [code, sev, plant, query]);
  const { pageNo } = pageBounds(rows.length, TABS_PAGE, page);
  const pageRows = rows.slice(pageNo * TABS_PAGE, (pageNo + 1) * TABS_PAGE);

  const exportCsv = () =>
    downloadCsv(
      `device_checks_${data?.meta.day ?? "today"}.csv`,
      ["severity", "code", "check", "kind", "plant_id", "plant", "device_key", "device", "reason", "fix_path"],
      rows.map((c) => [c.severity, c.code, CHECKS[c.code]?.title ?? c.code, c.kind, c.plant_id, c.plant_name, c.device_key, c.device_label, c.reason, c.fix_path])
    );

  if (!data && loading) return <LoadingState shape="table" />;

  const filtered = !!(code || sev !== "all" || plant || query);
  const thresholds = Object.entries(data?.meta.thresholds ?? {});
  return (
    <div className="flex flex-col gap-4">
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      <Card className="gap-3">
        <CardHeader className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-col gap-0.5">
            <CardTitle className="flex flex-wrap items-center gap-2">
              {t("Device checks")}
              {data && (
                <>
                  <Badge variant={data.summary.warn ? "warn" : "neutral"}>{t("{n} warning(s)", { n: fmtInt(data.summary.warn) })}</Badge>
                  <Badge variant="info">{t("{n} info", { n: fmtInt(data.summary.info) })}</Badge>
                </>
              )}
            </CardTitle>
            <CardDescription>
              <SyncedLine syncedAt={data?.meta.synced_at} /> · {t("computed on request, never stored")}
            </CardDescription>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Select value={sev} onValueChange={(v) => setUrl({ csev: v === "all" ? null : v })}>
              <SelectTrigger size="sm" className="w-auto min-w-28" aria-label={t("Severity")}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{t("All severities")}</SelectItem>
                <SelectItem value="warn">{t("Warning")}</SelectItem>
                <SelectItem value="info">{t("Info")}</SelectItem>
              </SelectContent>
            </Select>
            <Select value={plant || "all"} onValueChange={(v) => setUrl({ cplant: v === "all" ? null : v })}>
              <SelectTrigger size="sm" className="w-auto max-w-56 min-w-32" aria-label={t("Plant")}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{t("All plants")}</SelectItem>
                {plant && !plants.some(([id]) => String(id) === plant) && <SelectItem value={plant}>{plant}</SelectItem>}
                {plants.map(([id, name]) => (
                  <SelectItem key={id} value={String(id)}>
                    {name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <InputGroup className="h-8 w-56">
              <InputGroupAddon>
                <Search />
              </InputGroupAddon>
              <InputGroupInput placeholder={t("Search plant, device, reason")} value={query} onChange={(e) => setUrl({ cq: e.target.value || null })} />
            </InputGroup>
            {filtered && (
              <Button variant="ghost" size="sm" onClick={() => setUrl({ ccode: null, csev: null, cplant: null, cq: null })}>
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
        {chips.length > 0 && (
          <CardContent className="flex flex-wrap gap-1.5">
            {chips.map((c) => {
              const on = code === c.code;
              return (
                <Button
                  key={c.code}
                  variant={on ? "accent" : "outline"}
                  size="xs"
                  aria-pressed={on}
                  title={t(CHECKS[c.code].about)}
                  onClick={() => setUrl({ ccode: on ? null : c.code })}
                >
                  <span className={cn("size-1.5 rounded-full", c.warn ? "bg-amber-400" : "bg-sky-400")} aria-hidden />
                  {t(CHECKS[c.code].title)}
                  <span className="num text-muted-foreground">{fmtInt(c.n)}</span>
                </Button>
              );
            })}
          </CardContent>
        )}
        <CardContent className="px-0">
          {!rows.length ? (
            <Empty>
              <EmptyHeader>
                <EmptyTitle>{data?.checks.length ? t("No check matches") : t("No device checks fired")}</EmptyTitle>
                <EmptyDescription>{data?.checks.length ? t("Change or clear the filters.") : t("Every device on your plants passed the checks.")}</EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <Suspended busy={loading}>
              <Table containerClassName="table-wrap">
                <TableHeader className="sticky top-0 z-10 bg-card">
                  <TableRow>
                    <TableHead className="pl-4">{t("Severity")}</TableHead>
                    <TableHead>{t("Plant")}</TableHead>
                    <TableHead>{t("Device")}</TableHead>
                    <TableHead>{t("Reason")}</TableHead>
                    <TableHead className="pr-4 text-right">{t("Fix")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {pageRows.map((c, i) => {
                    const prev = pageRows[i - 1];
                    const heading = !prev || prev.code !== c.code || prev.severity !== c.severity;
                    return (
                      <React.Fragment key={`${c.code}:${c.plant_id}:${c.device_key ?? ""}:${i}`}>
                        {heading && <GroupRow check={c} count={rows.filter((r) => r.code === c.code && r.severity === c.severity).length} />}
                        <CheckRow check={c} />
                      </React.Fragment>
                    );
                  })}
                </TableBody>
              </Table>
              <TablePager className="border-t border-white/[0.06] px-4 py-2.5" rows={rows.length} pageSize={TABS_PAGE} pageNo={pageNo} onPage={setPage} />
            </Suspended>
          )}
        </CardContent>
        {thresholds.length > 0 && (
          <CardFooter className="border-t border-white/[0.06] pt-3">
            <Collapsible className="w-full">
              <CollapsibleTrigger asChild>
                <Button variant="ghost" size="xs" className="group -ml-2 text-muted-foreground">
                  <ChevronDown data-icon="inline-start" className="transition group-data-[state=open]:rotate-180" />
                  {t("How checks are judged")}
                </Button>
              </CollapsibleTrigger>
              <CollapsibleContent className="pt-2">
                <p className="mb-2 text-[11px] text-muted-foreground">
                  {t("Thresholds the backend used for this list. Checks are separate from issues: they do not open issues.")}
                </p>
                <dl className="grid grid-cols-1 gap-x-6 gap-y-1 text-xs sm:grid-cols-2 lg:grid-cols-3">
                  {thresholds.map(([k, v]) => (
                    <div key={k} className="flex justify-between gap-3 border-b border-white/[0.04] py-0.5">
                      <dt className="font-mono text-[11px] text-muted-foreground">{k}</dt>
                      <dd className="num">{v.toLocaleString()}</dd>
                    </div>
                  ))}
                </dl>
              </CollapsibleContent>
            </Collapsible>
          </CardFooter>
        )}
      </Card>
    </div>
  );
};

const GroupRow: React.FC<{ check: DeviceCheck; count: number }> = ({ check, count }) => {
  const { t } = useI18n();
  const meta = CHECKS[check.code];
  return (
    <TableRow className="bg-white/[0.02] hover:bg-white/[0.02]">
      <TableCell colSpan={5} className="px-4 py-2">
        <span className="flex flex-wrap items-baseline gap-x-2">
          <span className="font-semibold">{meta ? t(meta.title) : check.code}</span>
          <span className="num text-xs text-muted-foreground">{fmtInt(count)}</span>
          {meta && <span className="text-xs text-muted-foreground">{t(meta.about)}</span>}
        </span>
      </TableCell>
    </TableRow>
  );
};

const CheckRow: React.FC<{ check: DeviceCheck }> = ({ check: c }) => {
  const { t } = useI18n();
  const fix = appPath(c.fix_path);
  return (
    <TableRow>
      <TableCell className="pl-4">
        <Badge variant={c.severity === "warn" ? "warn" : "info"}>{c.severity === "warn" ? t("Warning") : t("Info")}</Badge>
      </TableCell>
      <TableCell className="max-w-[260px]">
        <PlantLink id={c.plant_id} name={c.plant_name} />
      </TableCell>
      <TableCell className="whitespace-nowrap">
        <span className="flex flex-col">
          <span>{c.device_label ?? c.device_key ?? "—"}</span>
          <span className="text-[11px] text-muted-foreground">
            {t(KIND_LABEL[c.kind] ?? c.kind)}
            {c.device_label && c.device_key && c.device_key !== c.device_label && <span className="num"> · {c.device_key}</span>}
          </span>
        </span>
      </TableCell>
      {/* backend text, kept in English */}
      <TableCell className="min-w-[260px] whitespace-normal text-xs" lang="en">
        {c.reason}
      </TableCell>
      <TableCell className="pr-4 text-right">
        {fix ? (
          <Button variant="outline" size="xs" asChild>
            <Link to={fix}>
              <Wrench data-icon="inline-start" />
              {t("Fix")}
            </Link>
          </Button>
        ) : (
          <span className="text-muted-foreground">—</span>
        )}
      </TableCell>
    </TableRow>
  );
};
