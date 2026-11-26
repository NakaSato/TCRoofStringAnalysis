import React, { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Download, ExternalLink, Replace } from "lucide-react";
import { api, type InstalledDevice, type InstalledList, type InstalledQuery, type PartCategory } from "../../api/client";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { EmptyState, SkeletonRows, Suspended } from "../../components/ui";
import { useAppContext } from "../../context/AppContext";
import { useI18n } from "../../i18n";
import { appPath } from "@/lib/safeUrl";
import { notify } from "../../lib/notify";
import { pick, useUrlState } from "@/lib/useUrlState";
import { CATEGORY_LABEL, download } from "./shared";

/** categories of installed equipment, in the API's order */
export const INSTALLED_CATEGORIES = ["inverter", "datalogger", "weather_station", "revenue_meter", "router", "pqm", "shinemaster", "grid_meter"] as const satisfies readonly PartCategory[];
const CATS = ["all", ...INSTALLED_CATEGORIES] as const;
const PHASES = ["all", "1", "2", "3", "4"] as const;
const PAGE = 500;
const ALL = "all";

type Target = { plant_id: number; site_device_id: number | null; inverter_sn: string | null };

const csvRows = (items: InstalledDevice[]) => [
  ["key", "source", "category", "label", "serial", "model", "plant_id", "plant", "site_code", "phase", "ip", "network", "sim", "status", "spare_unit_id", "spare_part_id", "failed_open", "path"],
  ...items.map((d) => [d.key, d.source, d.category, d.label, d.serial, d.model, d.plant_id, d.plant_name, d.site_code, d.phase, d.ip, d.network, d.sim, d.status, d.spare_unit_id, d.spare_part_id, d.failed_open, d.path]),
];

/**
 * L-1 (docs/plans/inventory-installed-base.md): every installed device of the visible plants, read
 * from the Growatt registry and the site register (never copied). URL `icat`, `iplant`, `iphase`, `iq`.
 * Values the registry lacks are "—". 500 rows a page; the CSV has every row of the filter.
 */
export const InstalledTab: React.FC<{ version: number; keeper: boolean; onReplace?: (target: Target) => void }> = ({ version, onReplace }) => {
  const { t } = useI18n();
  const { growattPlants } = useAppContext();
  const [url, setUrl] = useUrlState();
  const cat = pick(url.get("icat"), CATS, ALL);
  const phase = pick(url.get("iphase"), PHASES, ALL);
  const plantRaw = Number(url.get("iplant"));
  const plantId = Number.isInteger(plantRaw) && plantRaw > 0 ? plantRaw : null;
  const q = url.get("iq") ?? "";
  const [page, setPage] = useState(0);
  const [data, setData] = useState<InstalledList | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);

  const query = useMemo<InstalledQuery>(
    () => ({
      category: cat === ALL ? undefined : cat,
      plant_id: plantId ?? undefined,
      phase: phase === ALL ? undefined : Number(phase),
      q: q.trim() || undefined,
    }),
    [cat, plantId, phase, q]
  );

  useEffect(() => setPage(0), [query]);

  useEffect(() => {
    let alive = true;
    setBusy(true);
    const h = window.setTimeout(() => {
      api
        .listInstalled({ ...query, limit: PAGE, offset: page * PAGE })
        .then((d) => {
          if (!alive) return;
          setData(d);
          setError(null);
        })
        .catch((e) => {
          if (!alive) return;
          setData((d) => d ?? { items: [], total: 0, counts: {}, meta: { source: "db" } });
          setError(e instanceof Error ? e.message : String(e));
        })
        .finally(() => alive && setBusy(false));
    }, 300);
    return () => {
      alive = false;
      window.clearTimeout(h);
    };
  }, [query, page, version]);

  const plants = useMemo(() => [...growattPlants].sort((a, b) => a.name.localeCompare(b.name)), [growattPlants]);

  const exportCsv = async () => {
    setExporting(true);
    try {
      const all: InstalledDevice[] = [];
      for (let offset = 0; ; offset += PAGE) {
        const r = await api.listInstalled({ ...query, limit: PAGE, offset });
        all.push(...r.items);
        if (!r.items.length || offset + PAGE >= r.total) break;
      }
      download("inventory-installed.csv", csvRows(all));
    } catch (e) {
      notify("crit", e instanceof Error ? e.message : String(e));
    } finally {
      setExporting(false);
    }
  };

  const counts = data ? INSTALLED_CATEGORIES.filter((c) => data.counts[c] != null) : [];

  return (
    <Card className="gap-3 py-3">
      <CardContent className="flex flex-col gap-3 px-0">
        <div className="flex flex-wrap items-center gap-2 px-4">
          <Select value={cat} onValueChange={(v) => setUrl({ icat: v === ALL ? null : v })}>
            <SelectTrigger size="sm" className="w-40" aria-label={t("Category")}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {CATS.map((c) => (
                <SelectItem key={c} value={c}>
                  {c === ALL ? t("All categories") : t(CATEGORY_LABEL[c])}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={plantId != null ? String(plantId) : ALL} onValueChange={(v) => setUrl({ iplant: v === ALL ? null : v })}>
            <SelectTrigger size="sm" className="w-48 max-w-full" aria-label={t("Plant")}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>{t("All plants")}</SelectItem>
              {plantId != null && !plants.some((p) => p.plant_id === plantId) && <SelectItem value={String(plantId)}>{t("Plant {id}", { id: plantId })}</SelectItem>}
              {plants.map((p) => (
                <SelectItem key={p.plant_id} value={String(p.plant_id)}>
                  {p.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={phase} onValueChange={(v) => setUrl({ iphase: v === ALL ? null : v })}>
            <SelectTrigger size="sm" className="w-32" aria-label={t("Phase")}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PHASES.map((p) => (
                <SelectItem key={p} value={p}>
                  {p === ALL ? t("All phases") : t("Phase {n}", { n: p })}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Input
            value={q}
            onChange={(e) => setUrl({ iq: e.target.value })}
            placeholder={t("Serial, model, plant, IP, SIM…")}
            className="h-8 w-56 max-w-full"
            aria-label={t("Search")}
          />
          <span className="flex-1" />
          <Button variant="outline" size="sm" onClick={() => void exportCsv()} disabled={!data?.total || exporting}>
            {exporting ? <Spinner data-icon="inline-start" className="size-3" /> : <Download data-icon="inline-start" />}
            CSV
          </Button>
        </div>
        {counts.length > 0 && (
          <div className="flex flex-wrap gap-1.5 px-4">
            {counts.map((c) => (
              <Button
                key={c}
                size="xs"
                variant={cat === c ? "accent" : "outline"}
                aria-pressed={cat === c}
                onClick={() => setUrl({ icat: cat === c ? null : c })}
              >
                {t(CATEGORY_LABEL[c])}
                <span className="num text-muted-foreground">{data!.counts[c]}</span>
              </Button>
            ))}
          </div>
        )}
        {error && <p className="px-4 text-xs text-red-300">{error}</p>}
        {!data ? (
          <SkeletonRows rows={6} className="px-4" />
        ) : !data.items.length ? (
          <EmptyState title={query.category || query.plant_id || query.phase || query.q ? t("No installed devices match.") : t("No installed devices.")} />
        ) : (
          <Suspended busy={busy}>
            <Table containerClassName="table-wrap">
              <TableHeader>
                <TableRow>
                  <TableHead className="pl-4">{t("Device")}</TableHead>
                  <TableHead>{t("Serial")}</TableHead>
                  <TableHead>{t("Model")}</TableHead>
                  <TableHead>{t("Plant")}</TableHead>
                  <TableHead>{t("IP / network")}</TableHead>
                  <TableHead>{t("SIM")}</TableHead>
                  <TableHead>{t("Status")}</TableHead>
                  <TableHead className="pr-4 text-right" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.items.map((d) => (
                  <DeviceRow key={d.key} d={d} onReplace={onReplace} />
                ))}
              </TableBody>
            </Table>
          </Suspended>
        )}
        {data && data.total > PAGE && (
          <div className="flex flex-wrap items-center justify-end gap-2 px-4 text-xs text-muted-foreground">
            {t("{from}–{to} of {total}", { from: page * PAGE + 1, to: Math.min((page + 1) * PAGE, data.total), total: data.total })}
            <Button size="xs" variant="outline" disabled={page === 0 || busy} onClick={() => setPage(page - 1)}>
              {t("Previous")}
            </Button>
            <Button size="xs" variant="outline" disabled={(page + 1) * PAGE >= data.total || busy} onClick={() => setPage(page + 1)}>
              {t("Next")}
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
};

const DeviceRow: React.FC<{ d: InstalledDevice; onReplace?: (target: Target) => void }> = ({ d, onReplace }) => {
  const { t } = useI18n();
  const href = appPath(d.path);
  const canReplace = !!onReplace && d.plant_id != null && (d.site_device_id != null || d.inverter_sn != null);
  return (
    <TableRow>
      <TableCell className="pl-4 text-xs">
        <span className="block max-w-56 truncate text-slate-100" title={d.label}>
          {d.label}
        </span>
        <span className="block text-[11px] text-muted-foreground">{t(CATEGORY_LABEL[d.category] ?? d.category)}</span>
        {(d.spare_unit_id != null || d.failed_open) && (
          <span className="mt-1 flex flex-wrap gap-1">
            {d.spare_unit_id != null && (
              <Badge variant="info" asChild>
                <Link to={d.spare_part_id != null ? `/inventory?tab=stock&part=${d.spare_part_id}&unit=${d.spare_unit_id}` : "/inventory?tab=stock"}>{t("Spare unit")}</Link>
              </Badge>
            )}
            {d.failed_open && <Badge variant="warn">{t("Failed unit open")}</Badge>}
          </span>
        )}
      </TableCell>
      <TableCell className="font-mono text-xs whitespace-nowrap">{d.serial ?? "—"}</TableCell>
      <TableCell className="max-w-40 truncate text-xs" title={d.model ?? undefined}>
        {d.model ?? "—"}
      </TableCell>
      <TableCell className="text-xs">
        <span className="block max-w-48 truncate" title={d.plant_name ?? undefined}>
          {d.plant_name ?? (d.plant_id != null ? t("Plant {id}", { id: d.plant_id }) : "—")}
        </span>
        <span className="block font-mono text-[11px] text-muted-foreground">
          {d.site_code ?? "—"}
          {d.phase != null && ` · P${d.phase}`}
        </span>
      </TableCell>
      <TableCell className="font-mono text-xs whitespace-nowrap">
        {d.ip ?? "—"}
        {d.network && <span className="block text-[11px] text-muted-foreground">{d.network}</span>}
      </TableCell>
      <TableCell className="font-mono text-xs whitespace-nowrap">{d.sim ?? "—"}</TableCell>
      <TableCell className="text-xs">{d.status ?? "—"}</TableCell>
      <TableCell className="pr-4 text-right whitespace-nowrap">
        {href && (
          <Button asChild size="icon-xs" variant="ghost" aria-label={t("Open {label}", { label: d.label })} title={t("Open {label}", { label: d.label })}>
            <Link to={href}>
              <ExternalLink className="size-3.5" />
            </Link>
          </Button>
        )}
        {canReplace && (
          <Button
            size="xs"
            variant="ghost"
            onClick={() => onReplace!({ plant_id: d.plant_id!, site_device_id: d.site_device_id, inverter_sn: d.inverter_sn })}
          >
            <Replace data-icon="inline-start" />
            {t("Replace")}
          </Button>
        )}
      </TableCell>
    </TableRow>
  );
};
