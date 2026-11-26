import React, { useEffect, useMemo, useState } from "react";
import { Download, Plus } from "lucide-react";
import { api, type ModelRow, type PartCategory } from "../../api/client";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { EmptyState, SkeletonRows, Suspended } from "../../components/ui";
import { useI18n } from "../../i18n";
import { pick, useUrlState } from "@/lib/useUrlState";
import { FromModelsDialog } from "./FromModelsDialog";
import { CATEGORY_LABEL, download } from "./shared";

const ALL = "all";

/** the active parts' minimum summed over the ones that have one (as `below_min`); null when none has one */
const minSum = (r: ModelRow): number | null => {
  const set = r.parts.filter((p) => p.active).map((p) => p.min_qty).filter((x): x is number => x != null);
  return set.length ? set.reduce((a, b) => a + b, 0) : null;
};

/** "1", "2", … in order, "none" last */
const phaseEntries = (r: ModelRow) =>
  Object.entries(r.installed_by_phase)
    .filter(([, n]) => n > 0)
    .sort(([a], [b]) => (a === "none" ? 1 : b === "none" ? -1 : Number(a) - Number(b)));

/**
 * L-4 (docs/plans/inventory-installed-base.md), "Spares per model": installed per model and phase
 * against the spares of the matching catalogue parts. Counts only. "Thin" = in stock below the sum of
 * the active parts' minimums (only where a minimum is set). URL `mcat`.
 */
export const ModelsTab: React.FC<{ version: number; keeper: boolean; onChanged: () => void }> = ({ version, keeper, onChanged }) => {
  const { t } = useI18n();
  const [url, setUrl] = useUrlState();
  const [rows, setRows] = useState<ModelRow[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // kept after closing so the dialog keeps its filter while it animates out
  const [adding, setAdding] = useState<{ category: PartCategory; modelKey: string } | null>(null);
  const [addOpen, setAddOpen] = useState(false);

  useEffect(() => {
    let alive = true;
    setBusy(true);
    api
      .listInstalledModels()
      .then((r) => {
        if (!alive) return;
        setRows(r.items);
        setError(null);
      })
      .catch((e) => {
        if (!alive) return;
        setRows((x) => x ?? []);
        setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => alive && setBusy(false));
    return () => {
      alive = false;
    };
  }, [version]);

  const cats = useMemo(() => [...new Set((rows ?? []).map((r) => r.category))], [rows]);
  const cat: PartCategory | typeof ALL = pick<PartCategory | typeof ALL>(url.get("mcat"), cats, ALL);
  const shown = useMemo(() => (rows ?? []).filter((r) => cat === ALL || r.category === cat), [rows, cat]);

  const exportCsv = () =>
    download("inventory-spares-per-model.csv", [
      ["category", "model", "installed", "installed_by_phase", "in_stock", "failed_open", "at_supplier", "min_qty_sum", "thin", "parts"],
      ...shown.map((r) => {
        const m = minSum(r);
        return [
          r.category,
          r.model,
          r.installed,
          phaseEntries(r)
            .map(([p, n]) => `${p === "none" ? "none" : `P${p}`} ${n}`)
            .join("; "),
          r.in_stock,
          r.failed_open,
          r.at_supplier,
          m,
          m != null && m > r.in_stock,
          r.parts.map((p) => p.code).join("; "),
        ];
      }),
    ]);

  return (
    <Card className="gap-3 py-3">
      <CardContent className="flex flex-col gap-3 px-0">
        <div className="flex flex-wrap items-center gap-2 px-4">
          <Select value={cat} onValueChange={(v) => setUrl({ mcat: v === ALL ? null : v })}>
            <SelectTrigger size="sm" className="w-44" aria-label={t("Category")}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>{t("All categories")}</SelectItem>
              {cats.map((c) => (
                <SelectItem key={c} value={c}>
                  {t(CATEGORY_LABEL[c] ?? c)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <span className="flex-1" />
          <Button variant="outline" size="sm" onClick={exportCsv} disabled={!shown.length}>
            <Download data-icon="inline-start" />
            CSV
          </Button>
        </div>
        <p className="px-4 text-[11px] text-muted-foreground">
          {t("Installed counts come from the Growatt registry and the site register; spares from the catalogue parts that match the model. Counts only.")}
        </p>
        {error && <p className="px-4 text-xs text-red-300">{error}</p>}
        {!rows ? (
          <SkeletonRows rows={6} className="px-4" />
        ) : !shown.length ? (
          <EmptyState title={t("No installed models.")} />
        ) : (
          <Suspended busy={busy}>
            <Table containerClassName="table-wrap">
              <TableHeader>
                <TableRow>
                  <TableHead className="pl-4">{t("Model")}</TableHead>
                  <TableHead className="text-right">{t("Installed")}</TableHead>
                  <TableHead>{t("By phase")}</TableHead>
                  <TableHead className="text-right">{t("In stock")}</TableHead>
                  <TableHead className="text-right">{t("Failed open")}</TableHead>
                  <TableHead className="text-right">{t("At supplier")}</TableHead>
                  <TableHead className="pr-4">{t("Catalogue parts")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {shown.map((r) => {
                  const m = minSum(r);
                  const thin = m != null && m > r.in_stock;
                  return (
                    <TableRow key={`${r.category}|${r.model_key ?? ""}`}>
                      <TableCell className="pl-4 text-xs">
                        <span className={r.model ? "block max-w-56 truncate text-slate-100" : "block text-muted-foreground italic"} title={r.model ?? undefined}>
                          {r.model ?? t("Model not recorded")}
                        </span>
                        <span className="block text-[11px] text-muted-foreground">{t(CATEGORY_LABEL[r.category] ?? r.category)}</span>
                      </TableCell>
                      <TableCell className="num text-right text-xs">{r.installed}</TableCell>
                      <TableCell className="num text-[11px] whitespace-nowrap text-muted-foreground">
                        {phaseEntries(r)
                          .map(([p, n]) => (p === "none" ? `${t("No phase")} ${n}` : `P${p} ${n}`))
                          .join(" · ") || "—"}
                      </TableCell>
                      <TableCell className="num text-right text-xs whitespace-nowrap">
                        {r.in_stock}
                        {thin && (
                          <Badge variant="warn" className="ml-2" title={t("In stock is below the parts' minimum ({n})", { n: m })}>
                            {t("Thin")}
                          </Badge>
                        )}
                      </TableCell>
                      <TableCell className="num text-right text-xs">{r.failed_open}</TableCell>
                      <TableCell className="num text-right text-xs">{r.at_supplier}</TableCell>
                      <TableCell className="pr-4 text-xs">
                        {r.parts.length ? (
                          <span className="flex flex-col gap-0.5">
                            {r.parts.map((p) => (
                              <span key={p.id} className="font-mono whitespace-nowrap" title={p.name}>
                                {p.code}
                                {p.min_qty != null && <span className="ml-1.5 font-sans text-[11px] text-muted-foreground">{t("min {n}", { n: p.min_qty })}</span>}
                              </span>
                            ))}
                          </span>
                        ) : keeper && r.model && r.model_key ? (
                          <Button size="xs" variant="outline" onClick={() => {
                              setAdding({ category: r.category, modelKey: r.model_key! });
                              setAddOpen(true);
                            }}>
                            <Plus data-icon="inline-start" />
                            {t("Add to catalogue")}
                          </Button>
                        ) : (
                          <span className="text-muted-foreground">{t("No part")}</span>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </Suspended>
        )}
      </CardContent>
      <FromModelsDialog open={addOpen} onOpenChange={setAddOpen} onDone={onChanged} only={adding ?? undefined} />
    </Card>
  );
};
