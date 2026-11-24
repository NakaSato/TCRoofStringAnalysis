/**
 * Settings → Site register (docs/plans/om-asset-network.md): every station of the O&M asset & network workbook,
 * the Growatt plant it was matched to, its devices and what needs a look. Admins re-import the workbook (.xlsx)
 * or its JSON: a preview first, then the whole register is replaced in one go. Everyone reads their own plants.
 */
import React, { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { ChevronRight, Download, FileUp, Network, Search, TriangleAlert } from "lucide-react";
import { ApiError, api } from "../../api/client";
import type { SiteRegisterImport, SiteRegisterRow } from "../../api/client";
import { useAppContext } from "../../context/AppContext";
import { isAdmin } from "../../auth/access";
import { plantPath } from "../../context/routes";
import { LoadingState, EmptyState } from "../../components/ui";
import { TablePager, pageBounds } from "../../components/TablePager";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/spinner";
import { notify } from "@/lib/notify";
import { pick, useUrlState } from "@/lib/useUrlState";
import { useI18n } from "../../i18n";
import { SectionHeader } from "./shared";

const PAGE = 25;
const FILTERS = ["all", "review", "unmatched"] as const;
type Filter = (typeof FILTERS)[number];

const RULE_SHORT: Record<string, string> = {
  logger_sn: "Logger SN",
  logger_sn_prefix: "Logger SN (incomplete)",
  name_code: "Code in Growatt name",
  kept: "Earlier import",
};

/** The admin import: choose a file → preview → apply. */
const ImportDialog: React.FC<{ open: boolean; onClose: () => void; onDone: () => void }> = ({ open, onClose, onDone }) => {
  const { t } = useI18n();
  const ref = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<SiteRegisterImport | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      setFile(null);
      setPreview(null);
      setError(null);
    }
  }, [open]);

  const check = async (f: File) => {
    setFile(f);
    setPreview(null);
    setError(null);
    setBusy(true);
    try {
      setPreview(await api.importSiteRegister(f, false));
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const apply = async () => {
    if (!file) return;
    setBusy(true);
    try {
      const out = await api.importSiteRegister(file, true);
      notify("ok", t("Site register imported: {n} stations, {d} devices.", { n: out.sites, d: out.devices }));
      onDone();
      onClose();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t("Import the site register")}</DialogTitle>
          <DialogDescription>
            {t("The O&M asset & network workbook (.xlsx) or its JSON. Nothing changes until you apply; applying replaces the whole register.")}
          </DialogDescription>
        </DialogHeader>
        <input
          ref={ref}
          type="file"
          accept=".xlsx,.json,application/json,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = "";
            if (f) void check(f);
          }}
        />
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="outline" onClick={() => ref.current?.click()} disabled={busy}>
            <FileUp data-icon="inline-start" />
            {file ? t("Choose another file") : t("Choose file")}
          </Button>
          {file && <span className="truncate text-xs text-muted-foreground">{file.name}</span>}
          {busy && <Spinner className="size-3.5" />}
        </div>
        {error && (
          <Alert variant="destructive">
            <AlertTitle>{t("Could not import")}</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        {preview && (
          <div className="flex max-h-[50vh] flex-col gap-3 overflow-y-auto text-xs">
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              {[
                [t("Stations"), preview.sites],
                [t("Devices"), preview.devices],
                [t("Matched to a plant"), `${preview.matched} / ${preview.sites}`],
                [t("New"), preview.new],
              ].map(([label, v]) => (
                <div key={String(label)} className="rounded-md border border-white/[0.07] px-3 py-2">
                  <div className="text-[10px] text-muted-foreground">{label}</div>
                  <div className="num text-sm text-slate-100">{v}</div>
                </div>
              ))}
            </div>
            <p className="text-muted-foreground">
              {Object.entries(preview.by_rule)
                .map(([k, n]) => `${t(RULE_SHORT[k] ?? "Not matched")} ${n}`)
                .join(" · ")}
            </p>
            {preview.removed.length > 0 && (
              <Alert variant="warn">
                <TriangleAlert />
                <AlertTitle>{t("{n} stations will be removed", { n: preview.removed.length })}</AlertTitle>
                <AlertDescription>{preview.removed.join(", ")}</AlertDescription>
              </Alert>
            )}
            {preview.needs_review.length > 0 && (
              <div className="flex flex-col gap-1">
                <div className="font-medium text-slate-200">{t("Worth a look ({n})", { n: preview.needs_review.length })}</div>
                <ul className="flex flex-col gap-1">
                  {preview.needs_review.map((r) => (
                    <li key={r.site_code} className="rounded border border-white/[0.05] px-2 py-1">
                      <span className="num text-slate-200">{r.site_code}</span>{" "}
                      <span className="text-slate-400">{r.name}</span>{" "}
                      <span className="text-muted-foreground">→ {r.plant_name ?? t("not matched")}</span>
                      {r.checks.length > 0 && <div className="text-amber-200/80">{r.checks.map((c) => c.text).join(" · ")}</div>}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {preview.warnings.length > 0 && (
              <Collapsible>
                <CollapsibleTrigger className="group flex cursor-pointer items-center gap-1 text-muted-foreground outline-none hover:text-foreground focus-visible:text-foreground">
                  <ChevronRight className="size-3.5 transition-transform group-data-[state=open]:rotate-90" aria-hidden />
                  {t("{n} notes from the file", { n: preview.warnings.length })}
                </CollapsibleTrigger>
                <CollapsibleContent>
                  <ul className="mt-1 list-disc pl-4 text-muted-foreground">
                    {preview.warnings.map((w, i) => (
                      <li key={i}>{w}</li>
                    ))}
                  </ul>
                </CollapsibleContent>
              </Collapsible>
            )}
          </div>
        )}
        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            {t("Cancel")}
          </Button>
          <Button onClick={() => void apply()} disabled={busy || !preview}>
            {busy && preview && <Spinner className="size-3.5" data-icon="inline-start" />}
            {t("Apply import")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

export const SiteRegisterSettings: React.FC = () => {
  const { user } = useAppContext();
  const admin = isAdmin(user);
  const { t } = useI18n();
  const [url, setUrl] = useUrlState();
  const filter = pick(url.get("reg"), FILTERS, "all");
  const [q, setQ] = useState("");
  const [page, setPage] = useState(0);
  const [rows, setRows] = useState<SiteRegisterRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [exporting, setExporting] = useState(false);
  const exportXlsx = async () => {
    setExporting(true);
    try {
      await api.exportSiteRegister();
    } catch (e) {
      notify("crit", e instanceof Error ? e.message : String(e));
    } finally {
      setExporting(false);
    }
  };

  const load = () =>
    api.listSiteRegister().then(
      (r) => {
        setRows(r.sites);
        setError(null);
      },
      (e) => setError(e instanceof Error ? e.message : String(e))
    );
  useEffect(() => {
    void load();
  }, []);

  const counts = useMemo(() => {
    const all = rows ?? [];
    return {
      all: all.length,
      review: all.filter((r) => r.checks.length > 0).length,
      unmatched: all.filter((r) => r.plant_id == null).length,
    };
  }, [rows]);

  const shown = useMemo(() => {
    const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
    return (rows ?? []).filter((r) => {
      if (filter === "review" && r.checks.length === 0) return false;
      if (filter === "unmatched" && r.plant_id != null) return false;
      const hay = [r.site_code, r.name, r.plant_name, r.logger_sn, r.plant_id].join(" ").toLowerCase();
      return words.every((w) => hay.includes(w));
    });
  }, [rows, q, filter]);
  const { pageNo } = pageBounds(shown.length, PAGE, page);
  const pageRows = shown.slice(pageNo * PAGE, (pageNo + 1) * PAGE);
  const filterLabel: Record<Filter, string> = { all: t("All"), review: t("Needs review"), unmatched: t("Not matched") };

  return (
    <div className="space-y-4">
      <SectionHeader
        title={t("Site register")}
        description={t("Station data and the devices on site (data logger, weather station, revenue meters, 4G router, PQM, ShineMaster) from the O&M asset & network workbook, matched to each Growatt plant. Shown on the plant's Documents tab.")}
        aside={
          <div className="flex items-center gap-2">
            <Button size="sm" variant="outline" onClick={() => void exportXlsx()} disabled={exporting || !rows?.length}>
              {exporting ? <Spinner className="size-3" data-icon="inline-start" /> : <Download data-icon="inline-start" />}
              {t("Export .xlsx")}
            </Button>
            {admin && (
              <Button size="sm" onClick={() => setImporting(true)}>
                <FileUp data-icon="inline-start" />
                {t("Import workbook")}
              </Button>
            )}
          </div>
        }
      />
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setPage(0);
            }}
            placeholder={t("Code, station, SN…")}
            className="h-8 w-60 pl-8 text-xs"
          />
        </div>
        {FILTERS.map((f) => (
          <Button
            key={f}
            size="sm"
            variant={filter === f ? "secondary" : "ghost"}
            onClick={() => {
              setUrl({ reg: f === "all" ? null : f });
              setPage(0);
            }}
          >
            {filterLabel[f]} <span className="num text-muted-foreground">{counts[f]}</span>
          </Button>
        ))}
      </div>

      {error ? (
        <div className="callout-crit text-xs" role="alert">
          {error}
        </div>
      ) : rows == null ? (
        <LoadingState label={t("Loading the site register…")} shape="table" />
      ) : rows.length === 0 ? (
        <EmptyState icon={Network} title={t("No site register yet")} />
      ) : shown.length === 0 ? (
        <EmptyState icon={Network} title={t("No stations match")} />
      ) : (
        <Card className="gap-0 overflow-hidden py-0">
          <Table className="text-xs">
            <TableHeader>
              <TableRow>
                <TableHead className="w-20">{t("Code")}</TableHead>
                <TableHead>{t("Station")}</TableHead>
                <TableHead>{t("Growatt plant")}</TableHead>
                <TableHead className="text-right">{t("Revenue meters")}</TableHead>
                <TableHead>{t("Worth a look")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {pageRows.map((r) => (
                <TableRow key={r.site_code} className="align-top">
                  <TableCell className="num">{r.site_code}</TableCell>
                  <TableCell className="max-w-64">
                    <div className="truncate" title={r.name}>
                      {r.name}
                    </div>
                    <div className="num text-[11px] text-muted-foreground">{r.logger_sn ?? "—"}</div>
                  </TableCell>
                  <TableCell className="max-w-56">
                    {r.plant_id != null ? (
                      <>
                        <Link to={plantPath(r.plant_id, "documents")} className="block truncate text-solar-300 hover:underline" title={r.plant_name ?? ""}>
                          {r.plant_name ?? `#${r.plant_id}`}
                        </Link>
                        <div className="text-[11px] text-muted-foreground">{t(RULE_SHORT[r.match_rule ?? ""] ?? "")}</div>
                      </>
                    ) : (
                      <Badge variant="warn">{t("Not matched")}</Badge>
                    )}
                  </TableCell>
                  <TableCell className="num text-right">{r.devices.revenue_meter ?? 0}</TableCell>
                  <TableCell className="max-w-72 whitespace-normal">
                    {r.checks.length === 0 ? (
                      <span className="text-muted-foreground">—</span>
                    ) : (
                      <ul className="flex flex-col gap-0.5 text-amber-200/90">
                        {r.checks.map((c, i) => (
                          <li key={i}>{c.text}</li>
                        ))}
                      </ul>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <TablePager className="border-t border-white/[0.06] px-4 py-2.5" rows={shown.length} pageSize={PAGE} pageNo={pageNo} onPage={setPage} />
        </Card>
      )}

      {admin && <ImportDialog open={importing} onClose={() => setImporting(false)} onDone={() => void load()} />}
    </div>
  );
};
