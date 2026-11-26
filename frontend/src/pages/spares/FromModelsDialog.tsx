import React, { useEffect, useMemo, useState } from "react";
import { ApiError, api, type FromModelsItem, type ModelProposal, type PartCategory, type StockBatchError } from "../../api/client";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import { EmptyState, SkeletonRows } from "../../components/ui";
import { useI18n } from "../../i18n";
import { notify } from "../../lib/notify";
import { CATEGORY_LABEL, errorText } from "./shared";

/** the backend's model key: upper case, spaces collapsed */
const modelKey = (s: string) => s.trim().replace(/\s+/g, " ").toUpperCase();

type Draft = { p: ModelProposal; on: boolean; code: string; name: string; make: string };

/**
 * L-2 (docs/plans/inventory-installed-base.md): propose catalogue parts for the models installed;
 * the store keeper reviews, edits code / name / make and applies the ticked ones (all or nothing).
 * `only` narrows the list to one (category, model), from the Spares per model tab.
 */
export const FromModelsDialog: React.FC<{
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDone: () => void;
  only?: { category: PartCategory; model: string };
}> = ({ open, onOpenChange, onDone, only }) => {
  const { t } = useI18n();
  const [rows, setRows] = useState<Draft[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** row errors of a 409, by proposal index in `rows` */
  const [rowErrors, setRowErrors] = useState<Map<number, string>>(new Map());
  const [busy, setBusy] = useState(false);
  const onlyCat = only?.category;
  const onlyModel = only?.model;

  useEffect(() => {
    if (!open) return;
    let alive = true;
    setRows(null);
    setLoadError(null);
    setError(null);
    setRowErrors(new Map());
    api
      .previewPartsFromModels()
      .then((r) => {
        if (!alive) return;
        const list = r.proposals.filter((p) => onlyCat == null || onlyModel == null || (p.category === onlyCat && modelKey(p.model) === modelKey(onlyModel)));
        setRows(list.map((p) => ({ p, on: p.part_id == null, code: p.code, name: p.name, make: p.make ?? "" })));
      })
      .catch((e) => alive && setLoadError(errorText(e, t)));
    return () => {
      alive = false;
    };
  }, [open, onlyCat, onlyModel, t]);

  const ticked = useMemo(() => (rows ?? []).map((r, i) => ({ r, i })).filter(({ r }) => r.on && r.p.part_id == null), [rows]);
  const invalid = ticked.some(({ r }) => !r.code.trim() || r.code.trim().length > 40 || !r.name.trim());
  const newCount = (rows ?? []).filter((r) => r.p.part_id == null).length;

  const patch = (i: number, d: Partial<Draft>) => setRows((xs) => xs && xs.map((x, j) => (j === i ? { ...x, ...d } : x)));

  const apply = async () => {
    if (!ticked.length || invalid) return;
    setBusy(true);
    setError(null);
    setRowErrors(new Map());
    const items: FromModelsItem[] = ticked.map(({ r }) => ({
      category: r.p.category,
      model: r.p.model,
      make: r.make.trim() || null,
      code: r.code.trim().toUpperCase(),
      name: r.name.trim(),
    }));
    try {
      const res = await api.applyPartsFromModels(items);
      notify("ok", t("Added {n} parts to the catalogue.", { n: res.created.length }));
      onDone();
      onOpenChange(false);
    } catch (e) {
      setError(errorText(e, t));
      if (e instanceof ApiError && e.status === 409 && e.detail && typeof e.detail === "object" && "errors" in e.detail) {
        const m = new Map<number, string>();
        for (const x of (e.detail as StockBatchError).errors) if (x.row != null && ticked[x.row]) m.set(ticked[x.row].i, x.error);
        setRowErrors(m);
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t("From installed models")}</DialogTitle>
          <DialogDescription>
            {t("A catalogue part for each model on the plants. Check the code, name and make; only the ticked rows are added, all or none.")}
          </DialogDescription>
        </DialogHeader>
        {loadError ? (
          <Alert variant="destructive">
            <AlertDescription className="whitespace-pre-line">{loadError}</AlertDescription>
          </Alert>
        ) : !rows ? (
          <SkeletonRows rows={4} />
        ) : !rows.length ? (
          <EmptyState title={t("No installed models with a model recorded.")} />
        ) : (
          <ul className="-mx-1 flex max-h-[60vh] flex-col gap-2 overflow-y-auto px-1">
            {rows.map((r, i) => {
              const exists = r.p.part_id != null;
              const id = `fm-${i}`;
              const rowErr = rowErrors.get(i);
              return (
                <li
                  key={`${r.p.category}|${r.p.model}`}
                  className={
                    rowErr
                      ? "flex flex-col gap-2 rounded-lg border border-red-400/50 px-3 py-2"
                      : exists
                        ? "flex flex-col gap-2 rounded-lg border border-white/[0.07] px-3 py-2 opacity-60"
                        : "flex flex-col gap-2 rounded-lg border border-white/[0.07] px-3 py-2"
                  }
                >
                  <div className="flex flex-wrap items-center gap-2 text-xs">
                    <Checkbox
                      id={id}
                      checked={exists ? false : r.on}
                      disabled={exists || busy}
                      onCheckedChange={(v) => patch(i, { on: v === true })}
                      aria-label={t("Add {model}", { model: r.p.model })}
                    />
                    <Label htmlFor={id} className="min-w-0 flex-1 text-xs">
                      <span className="truncate font-medium text-slate-100">{r.p.model}</span>
                      <span className="text-muted-foreground">· {t(CATEGORY_LABEL[r.p.category] ?? r.p.category)}</span>
                    </Label>
                    <span className="num text-[11px] text-muted-foreground">{t("{n} installed", { n: r.p.installed })}</span>
                    {exists && <Badge variant="neutral">{t("Already in the catalogue")}</Badge>}
                  </div>
                  {!exists && r.on && (
                    <div className="grid gap-2 sm:grid-cols-[minmax(0,1.2fr)_minmax(0,1.4fr)_minmax(0,0.8fr)]">
                      <Input
                        value={r.code}
                        maxLength={40}
                        onChange={(e) => patch(i, { code: e.target.value.toUpperCase() })}
                        className="h-8 font-mono"
                        aria-label={t("Part code")}
                        placeholder={t("Part code")}
                        aria-invalid={!r.code.trim() || undefined}
                      />
                      <Input
                        value={r.name}
                        onChange={(e) => patch(i, { name: e.target.value })}
                        className="h-8"
                        aria-label={t("Name")}
                        placeholder={t("Name")}
                        aria-invalid={!r.name.trim() || undefined}
                      />
                      <Input value={r.make} onChange={(e) => patch(i, { make: e.target.value })} className="h-8" aria-label={t("Make")} placeholder={t("Make")} />
                    </div>
                  )}
                  {rowErr && <p className="text-[11px] text-red-300">{rowErr}</p>}
                </li>
              );
            })}
          </ul>
        )}
        {error && (
          <Alert variant="destructive">
            <AlertDescription className="whitespace-pre-line">{error}</AlertDescription>
          </Alert>
        )}
        <DialogFooter className="items-center">
          {rows && rows.length > 0 && (
            <span className="mr-auto text-[11px] text-muted-foreground">{t("{n} of {total} new models ticked", { n: ticked.length, total: newCount })}</span>
          )}
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {t("Cancel")}
          </Button>
          <Button disabled={busy || !ticked.length || invalid || !!loadError} onClick={() => void apply()}>
            {busy && <Spinner data-icon="inline-start" />}
            {t("Add {n} parts", { n: ticked.length })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
