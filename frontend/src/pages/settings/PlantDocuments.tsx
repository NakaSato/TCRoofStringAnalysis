/**
 * Settings → Plant documents: each plant's as-built drawing PDF and site photo folder on Google Drive
 * (docs/plans/plant-asbuilt-links.md). Links only. Rows come from the Drive name matcher (matched) or an
 * admin (manual; a re-import keeps them). Everyone reads; admins edit.
 */
import React, { useEffect, useMemo, useState } from "react";
import { ExternalLink, FileText, Images, Pencil, Search } from "lucide-react";
import { ApiError, api } from "../../api/client";
import type { PlantDocument, PlantDocumentKind, PlantDocumentRow } from "../../api/client";
import { useAppContext } from "../../context/AppContext";
import { isAdmin } from "../../auth/access";
import { LoadingState, EmptyState, fmt } from "../../components/ui";
import { TablePager, pageBounds } from "../../components/TablePager";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/spinner";
import { notify } from "@/lib/notify";
import { pick, useUrlState } from "@/lib/useUrlState";
import { useI18n } from "../../i18n";
import { SectionHeader } from "./shared";

const PAGE = 25;
const FILTERS = ["all", "missing", "review"] as const;
type Filter = (typeof FILTERS)[number];
/** a matched link below this score is worth a look (the matcher auto-accepts from 0.9) */
const REVIEW_BELOW = 0.9;

const needsReview = (d: PlantDocument | null) => !!d && d.source === "matched" && (d.match_score ?? 0) < REVIEW_BELOW;

const DocCell: React.FC<{ doc: PlantDocument | null; icon: React.ComponentType<{ className?: string }> }> = ({ doc, icon: Icon }) => {
  const { t } = useI18n();
  if (!doc) return <span className="text-muted-foreground">—</span>;
  return (
    <div className="flex min-w-0 items-center gap-1.5">
      <a href={doc.url} target="_blank" rel="noreferrer" className="inline-flex min-w-0 items-center gap-1 text-solar-300 hover:underline" title={doc.title ?? doc.url}>
        <Icon className="size-3.5 shrink-0" />
        <span className="truncate">{doc.revision ?? t("Open")}</span>
        <ExternalLink className="size-3 shrink-0 opacity-60" />
      </a>
      <Badge variant={doc.source === "manual" ? "info" : needsReview(doc) ? "warn" : "neutral"} className="shrink-0">
        {doc.source === "manual" ? t("manual") : `${t("matched")} ${fmt(doc.match_score, 2)}`}
      </Badge>
    </div>
  );
};

type Draft = { row: PlantDocumentRow; asbuilt: string; site_photos: string };

export const PlantDocuments: React.FC = () => {
  const { user } = useAppContext();
  const admin = isAdmin(user);
  const { t } = useI18n();
  const [url, setUrl] = useUrlState();
  const filter = pick(url.get("docs"), FILTERS, "all");
  const [q, setQ] = useState("");
  const [page, setPage] = useState(0);
  const [rows, setRows] = useState<PlantDocumentRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);

  const load = () =>
    api.listPlantDocuments().then(
      (r) => {
        setRows(r.plants);
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
      missing: all.filter((r) => !r.asbuilt).length,
      review: all.filter((r) => needsReview(r.asbuilt) || needsReview(r.site_photos)).length,
    };
  }, [rows]);

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (rows ?? []).filter((r) => {
      if (filter === "missing" && r.asbuilt) return false;
      if (filter === "review" && !(needsReview(r.asbuilt) || needsReview(r.site_photos))) return false;
      return !needle || r.name.toLowerCase().includes(needle) || String(r.plant_id).includes(needle);
    });
  }, [rows, q, filter]);
  const { pageNo } = pageBounds(shown.length, PAGE, page);
  const pageRows = shown.slice(pageNo * PAGE, (pageNo + 1) * PAGE);

  const save = async () => {
    if (!draft) return;
    setBusy(true);
    try {
      for (const kind of ["asbuilt", "site_photos"] as PlantDocumentKind[]) {
        const next = draft[kind].trim();
        const prev = draft.row[kind]?.url ?? "";
        if (next === prev) continue;
        if (next) await api.putPlantDocument(draft.row.plant_id, kind, { url: next });
        else if (prev) await api.deletePlantDocument(draft.row.plant_id, kind);
      }
      notify("ok", t("Saved links of {name}.", { name: draft.row.name }));
      setDraft(null);
      await load();
    } catch (e) {
      notify("crit", e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const invalid = !!draft && (["asbuilt", "site_photos"] as const).some((k) => draft[k].trim() !== "" && !/^https:\/\//i.test(draft[k].trim()));

  const filterLabel: Record<Filter, string> = { all: t("All"), missing: t("No as-built"), review: t("Needs review") };

  return (
    <div className="space-y-4">
      <SectionHeader
        title={t("Plant documents")}
        description={t("Each plant's as-built drawing (PDF) and site photo folder on Google Drive, shown as buttons in the plant header. Links only: the files stay on Drive, and opening one needs access to the company Drive.")}
      />
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input value={q} onChange={(e) => { setQ(e.target.value); setPage(0); }} placeholder={t("Search plant…")} className="h-8 w-56 pl-8 text-xs" />
        </div>
        {FILTERS.map((f) => (
          <Button
            key={f}
            size="sm"
            variant={filter === f ? "secondary" : "ghost"}
            onClick={() => { setUrl({ docs: f === "all" ? null : f }); setPage(0); }}
          >
            {filterLabel[f]} <span className="num text-muted-foreground">{counts[f]}</span>
          </Button>
        ))}
      </div>

      {error ? (
        <div className="callout-crit text-xs" role="alert">{error}</div>
      ) : rows == null ? (
        <LoadingState label={t("Loading plant documents…")} shape="table" />
      ) : shown.length === 0 ? (
        <EmptyState icon={FileText} title={t("No plants match")} />
      ) : (
        <Card className="gap-0 overflow-hidden py-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("Plant")}</TableHead>
                <TableHead className="w-16">{t("Phase")}</TableHead>
                <TableHead>{t("As-built (PDF)")}</TableHead>
                <TableHead>{t("Site photos")}</TableHead>
                {admin && <TableHead className="w-12" />}
              </TableRow>
            </TableHeader>
            <TableBody>
              {pageRows.map((r) => (
                <TableRow key={r.plant_id}>
                  <TableCell className="max-w-72">
                    <div className="truncate text-sm" title={r.name}>{r.name}</div>
                    <div className="num text-[11px] text-muted-foreground">#{r.plant_id}</div>
                  </TableCell>
                  <TableCell className="num">{r.phase ?? "—"}</TableCell>
                  <TableCell className="max-w-64"><DocCell doc={r.asbuilt} icon={FileText} /></TableCell>
                  <TableCell className="max-w-64"><DocCell doc={r.site_photos} icon={Images} /></TableCell>
                  {admin && (
                    <TableCell>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={t("Edit links of {name}", { name: r.name })}
                        onClick={() => setDraft({ row: r, asbuilt: r.asbuilt?.url ?? "", site_photos: r.site_photos?.url ?? "" })}
                      >
                        <Pencil />
                      </Button>
                    </TableCell>
                  )}
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <TablePager className="border-t border-white/[0.06] px-4 py-2.5" rows={shown.length} pageSize={PAGE} pageNo={pageNo} onPage={setPage} />
        </Card>
      )}

      <Dialog open={!!draft} onOpenChange={(o) => !o && !busy && setDraft(null)}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{t("Document links")}</DialogTitle>
            <DialogDescription>{draft?.row.name}</DialogDescription>
          </DialogHeader>
          {draft && (
            <div className="space-y-3">
              {(["asbuilt", "site_photos"] as const).map((k) => (
                <div key={k} className="space-y-1">
                  <Label htmlFor={`doc-${k}`}>{k === "asbuilt" ? t("As-built drawing (PDF)") : t("Site photo folder")}</Label>
                  <Input
                    id={`doc-${k}`}
                    value={draft[k]}
                    onChange={(e) => setDraft({ ...draft, [k]: e.target.value })}
                    placeholder="https://drive.google.com/…"
                    aria-invalid={draft[k].trim() !== "" && !/^https:\/\//i.test(draft[k].trim())}
                    className="text-xs"
                  />
                </div>
              ))}
              <p className="text-[11px] text-muted-foreground">
                {t("A link saved here is marked manual: a later Drive import leaves it alone. Leave a field empty to remove that link.")}
              </p>
            </div>
          )}
          <DialogFooter>
            <Button variant="ghost" onClick={() => setDraft(null)} disabled={busy}>{t("Cancel")}</Button>
            <Button onClick={() => void save()} disabled={busy || invalid}>
              {busy && <Spinner className="size-3.5" />}
              {t("Save")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};
