import React, { useEffect, useState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Download } from "lucide-react";
import { api, FAILED_STATUSES, type FailedUnit, type FailedUnitStatus } from "../../api/client";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { EmptyState, SkeletonRows, Suspended } from "../../components/ui";
import { TablePager, pageBounds } from "../../components/TablePager";
import { useI18n } from "../../i18n";
import { pick, useUrlState } from "@/lib/useUrlState";
import { FAILED_STATUS_LABEL, FAILED_STATUS_VARIANT, download, errorText } from "./shared";
import { RegistryChip, registryKey, useClearRegistryOn, useRegistryWhere } from "./RegistryWhere";

/** status filter: open (default) = tagged, in store or at the supplier */
const FILTERS = ["open", "all", ...FAILED_STATUSES] as const;
const PAGE_SIZE = 50;
type Filter = (typeof FILTERS)[number];

/** The overdue badge: open and not sent to the supplier after the set number of days. */
export const FailedStatusBadges: React.FC<{ unit: Pick<FailedUnit, "status" | "unsent_overdue"> }> = ({ unit }) => {
  const { t } = useI18n();
  return (
    <span className="flex flex-wrap items-center gap-1">
      <Badge variant={FAILED_STATUS_VARIANT[unit.status]}>{t(FAILED_STATUS_LABEL[unit.status])}</Badge>
      {unit.unsent_overdue && <Badge variant="warn">{t("Not sent")}</Badge>}
    </span>
  );
};

/**
 * Failed units bound to red tags (docs/plans/spares-failed-units.md §5.4–5.5): URL `fs` (status
 * filter, open by default), `fq` (red tag or serial). A row opens its detail (`fu`).
 */
export const FailedTab: React.FC<{ version: number }> = ({ version }) => {
  const { t } = useI18n();
  const [url, setUrl] = useUrlState();
  const filter = pick(url.get("fs"), FILTERS, "open");
  const q = url.get("fq") ?? "";
  const [rows, setRows] = useState<FailedUnit[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [page, setPage] = useState(0);
  useEffect(() => setPage(0), [filter, q]);
  // L-3: the registry device each serial belongs to
  useClearRegistryOn(version);
  const where = useRegistryWhere(rows?.map((u) => u.serial) ?? []);

  useEffect(() => {
    let alive = true;
    setBusy(true);
    const h = window.setTimeout(() => {
      api
        .listFailedUnits({
          open: filter === "open" ? true : undefined,
          status: filter === "open" || filter === "all" ? undefined : (filter as FailedUnitStatus),
          q: q.trim() || undefined,
        })
        .then((r) => {
          if (!alive) return;
          setRows(r);
          setError(null);
        })
        .catch((e) => alive && setError(errorText(e, t)))
        .finally(() => alive && setBusy(false));
    }, 200);
    return () => {
      alive = false;
      window.clearTimeout(h);
    };
  }, [filter, q, version, t]);
  const { pageNo } = pageBounds(rows?.length ?? 0, PAGE_SIZE, page);
  const pageRows = (rows ?? []).slice(pageNo * PAGE_SIZE, (pageNo + 1) * PAGE_SIZE);

  const exportCsv = () =>
    rows &&
    download("spares-failed-units.csv", [
      ["id", "red_tag", "part", "serial", "plant", "device", "inverter_sn", "removed_day", "age_days", "status", "unsent_overdue", "where", "claim", "fault", "created_by"],
      ...rows.map((u) => [
        u.id,
        u.red_tag,
        u.part_code,
        u.serial,
        u.plant_name ?? u.plant_id,
        u.site_device_label,
        u.inverter_sn,
        u.removed_day,
        u.age_days,
        u.status,
        u.unsent_overdue,
        u.location_code,
        u.claim_number,
        u.fault,
        u.created_by,
      ]),
    ]);

  return (
    <Card className="gap-3 py-3">
      <CardContent className="flex flex-col gap-3 px-0">
        <div className="flex flex-wrap items-center gap-2 px-4">
          <Select value={filter} onValueChange={(v) => setUrl({ fs: v === "open" ? null : v })}>
            <SelectTrigger size="sm" className="w-40" aria-label={t("Status")}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {FILTERS.map((f) => (
                <SelectItem key={f} value={f}>
                  {f === "open" ? t("All open") : f === "all" ? t("All") : t(FAILED_STATUS_LABEL[f])}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Input
            value={q}
            onChange={(e) => setUrl({ fq: e.target.value })}
            placeholder={t("Red tag or serial…")}
            className="h-8 w-48 font-mono"
            aria-label={t("Search")}
          />
          <span className="flex-1" />
          <Button variant="outline" size="sm" onClick={exportCsv} disabled={!rows?.length}>
            <Download data-icon="inline-start" />
            CSV
          </Button>
        </div>
        {error && (
          <Alert variant="destructive" className="mx-4 w-auto">
            <AlertDescription>{t("Could not load the failed units: {error}", { error })}</AlertDescription>
          </Alert>
        )}
        {!rows ? (
          !error && <SkeletonRows rows={5} className="px-4" />
        ) : (
          <Suspended busy={busy}>
          {!rows.length ? (
          <EmptyState title={filter === "open" && !q ? t("No failed units open.") : t("No failed units match.")} />
        ) : (
          <>
          <Table containerClassName="table-wrap">
            <TableHeader>
              <TableRow>
                <TableHead className="pl-4">{t("Red tag")}</TableHead>
                <TableHead>{t("Part / serial")}</TableHead>
                <TableHead>{t("Plant")}</TableHead>
                <TableHead>{t("Removed")}</TableHead>
                <TableHead>{t("Status")}</TableHead>
                <TableHead>{t("Where")}</TableHead>
                <TableHead className="pr-4">{t("Claim")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {pageRows.map((u) => (
                <TableRow
                  key={u.id}
                  className="cursor-pointer"
                  tabIndex={0}
                  onClick={() => setUrl({ fu: u.id })}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      setUrl({ fu: u.id });
                    }
                  }}
                >
                  <TableCell className="pl-4 font-mono text-xs whitespace-nowrap text-slate-100">{u.red_tag}</TableCell>
                  <TableCell className="text-xs">
                    <span className="font-mono text-slate-100">{u.serial ?? "—"}</span>
                    <span className="block text-[11px] text-muted-foreground">{u.part_code ?? t("Not in the catalogue")}</span>
                    <RegistryChip hits={where[registryKey(u.serial)]} className="mt-0.5 max-w-56" />
                  </TableCell>
                  <TableCell className="max-w-48 truncate text-xs">{u.plant_name ?? (u.plant_id != null ? t("Plant {id}", { id: u.plant_id }) : "—")}</TableCell>
                  <TableCell className="text-xs whitespace-nowrap">
                    <span className="num">{u.removed_day}</span>
                    <span className="block text-[11px] text-muted-foreground">{t("{n} days", { n: u.age_days })}</span>
                  </TableCell>
                  <TableCell className="text-xs">
                    <FailedStatusBadges unit={u} />
                  </TableCell>
                  <TableCell className="font-mono text-xs">{u.location_code ?? "—"}</TableCell>
                  <TableCell className="pr-4 font-mono text-xs whitespace-nowrap">{u.claim_number ?? "—"}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <TablePager rows={rows.length} pageSize={PAGE_SIZE} pageNo={pageNo} onPage={setPage} className="px-4" />
          </>
        )}
          </Suspended>
        )}
      </CardContent>
    </Card>
  );
};
