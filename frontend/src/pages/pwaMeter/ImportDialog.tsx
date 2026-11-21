/** Engineering O&M → Import daily report (admin): three steps in one dialog.
 *  1. Files: drop or pick the daily report workbooks; choosing them runs the check at once.
 *  2. Check: totals, a status line (ready / problems / check again), and the sheets that need a
 *     look (problems first) with their day, rows and changes; set a missing day or skip a sheet.
 *  3. Imported: what was stored.
 * Nothing is stored until Import; the backend refuses it while any included sheet has a problem.
 * Every check re-sends the files (the backend keeps nothing). */
import React, { useMemo, useRef, useState } from "react";
import { AlertTriangle, Check, CheckCircle2, ChevronDown, FileSpreadsheet, MinusCircle, Upload, X, XCircle } from "lucide-react";
import { api } from "../../api/client";
import type { PwaImportResult, PwaImportSheet } from "../../api/client";
import { fmtInt } from "../../components/ui";
import { cn } from "@/lib/utils";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { fmtDay, isDay } from "./format";
import { translate, useI18n } from "../../i18n";

const ACCEPT = /\.(xlsx|xlsm)$/i;
const needsLook = (s: PwaImportSheet) => s.errors.length > 0 || s.warnings.length > 0 || s.new > 0 || s.changed > 0;
/** problems first, then notes, then the rest in workbook order */
const rank = (s: PwaImportSheet) => (s.errors.length ? 0 : s.warnings.length ? 1 : 2);
const fileKey = (f: File) => `${f.name}:${f.size}:${f.lastModified}`;
const fmtSize = (b: number) => (b >= 1 << 20 ? `${(b / (1 << 20)).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} kB`);
/** "{n} sheet" / "{n} sheets": one dictionary key per form, so Thai (no plural) can word each */
const plural = (n: number, one: string, many = `${one}s`) => translate(`{n} ${n === 1 ? one : many}`, { n: fmtInt(n) });

// ---- step indicator
const STEPS = ["Files", "Check", "Imported"] as const;
const Steps: React.FC<{ at: number }> = ({ at }) => {
  const { t } = useI18n();
  return (
  <ol className="flex items-center gap-2 text-[11px]" aria-label={t("Import steps")}>
    {STEPS.map((label, i) => (
      <li key={label} className="flex items-center gap-2" aria-current={i === at ? "step" : undefined}>
        {i > 0 && <span className={cn("h-px w-6", i <= at ? "bg-solar-400/60" : "bg-white/10")} />}
        <span
          className={cn(
            "flex size-5 items-center justify-center rounded-full border text-[10px] font-bold",
            i < at ? "border-solar-400/50 bg-solar-500/20 text-solar-300" : i === at ? "border-solar-400 text-solar-300" : "border-white/15 text-muted-foreground"
          )}
        >
          {i < at ? <Check className="size-3" /> : i + 1}
        </span>
        <span className={cn(i === at ? "font-semibold text-foreground" : "text-muted-foreground")}>{t(label)}</span>
      </li>
    ))}
  </ol>
  );
};

// ---- step 1: the drop zone and the chosen files
const DropZone: React.FC<{ files: File[]; disabled: boolean; onAdd: (f: File[]) => void; onRemove: (f: File) => void }> = ({ files, disabled, onAdd, onRemove }) => {
  const { t } = useI18n();
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const [rejected, setRejected] = useState<string[]>([]);
  const take = (list: FileList | null) => {
    const all = Array.from(list ?? []);
    setRejected(all.filter((f) => !ACCEPT.test(f.name)).map((f) => f.name));
    const ok = all.filter((f) => ACCEPT.test(f.name));
    if (ok.length) onAdd(ok);
  };
  return (
    <div className="flex flex-col gap-2">
      <button
        type="button"
        disabled={disabled}
        onClick={() => input.current?.click()}
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          if (!disabled) take(e.dataTransfer.files);
        }}
        className={cn(
          "flex w-full flex-col items-center justify-center gap-1.5 rounded-lg border border-dashed px-4 text-center transition-colors disabled:opacity-50",
          files.length ? "py-3" : "py-8",
          over ? "border-solar-400 bg-solar-500/10" : "border-white/15 bg-white/[0.02] hover:border-white/30 hover:bg-white/[0.04]"
        )}
      >
        <Upload className={cn("size-5", over ? "text-solar-300" : "text-muted-foreground")} />
        <span className="text-xs font-medium text-foreground">{files.length ? t("Add more workbooks") : t("Drop the daily report workbooks here, or click to choose")}</span>
        {!files.length && <span className="text-[11px] text-muted-foreground">{t(".xlsx / .xlsm · phase 1: one day per file · phase 2: one sheet per day")}</span>}
      </button>
      <input
        ref={input}
        type="file"
        accept=".xlsx,.xlsm"
        multiple
        hidden
        onChange={(e) => {
          take(e.target.files);
          e.target.value = "";
        }}
        aria-label={t("Report workbooks")}
      />
      {rejected.length > 0 && <p className="text-[11px] text-amber-300">{t("Not a workbook, left out: {names}", { names: rejected.join(", ") })}</p>}
      {files.length > 0 && (
        <ul className="flex flex-wrap gap-1.5">
          {files.map((f) => (
            <li key={fileKey(f)} className="flex max-w-full items-center gap-1.5 rounded-md border border-white/10 bg-white/[0.03] py-1 pr-1 pl-2 text-[11px]">
              <FileSpreadsheet className="size-3.5 shrink-0 text-emerald-300" />
              <span className="truncate" title={f.name}>
                {f.name}
              </span>
              <span className="num shrink-0 text-muted-foreground">{fmtSize(f.size)}</span>
              <Button variant="ghost" size="icon-xs" disabled={disabled} onClick={() => onRemove(f)} aria-label={t("Remove {name}", { name: f.name })}>
                <X />
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};

// ---- step 2: totals
const Stat: React.FC<{ label: string; value: React.ReactNode; sub?: React.ReactNode; tone?: string }> = ({ label, value, sub, tone }) => (
  <div className="rounded-lg border border-white/[0.07] bg-white/[0.02] px-3 py-2">
    <div className="text-[10px] font-semibold tracking-wide text-muted-foreground uppercase">{label}</div>
    <div className={cn("num mt-0.5 text-lg leading-tight font-bold", tone)}>{value}</div>
    {sub != null && <div className="mt-0.5 truncate text-[10px] text-muted-foreground">{sub}</div>}
  </div>
);

const Totals: React.FC<{ r: PwaImportResult }> = ({ r }) => {
  const { t: tr } = useI18n();
  const t = r.totals;
  const pct = t.rows ? (100 * t.matched) / t.rows : null;
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
      <Stat
        label={tr("Rows matched")}
        value={
          <>
            {fmtInt(t.matched)}
            <span className="text-xs font-medium text-muted-foreground"> / {fmtInt(t.rows)}</span>
          </>
        }
        sub={
          pct == null ? undefined : (
            <span className="mt-1 block h-1 overflow-hidden rounded-full bg-white/10" title={tr("{pct} % matched a site", { pct: pct.toFixed(1) })}>
              <span className={cn("block h-full", t.unmatched ? "bg-amber-400" : "bg-emerald-400")} style={{ width: `${pct}%` }} />
            </span>
          )
        }
        tone={t.unmatched ? "text-amber-300" : undefined}
      />
      <Stat label={tr("New days")} value={fmtInt(t.new)} tone={t.new ? "text-emerald-300" : "text-muted-foreground"} sub={tr("not stored yet")} />
      <Stat label={tr("Changed")} value={fmtInt(t.changed)} tone={t.changed ? "text-sky-300" : "text-muted-foreground"} sub={tr("stored, will be updated")} />
      <Stat label={tr("Unchanged")} value={fmtInt(t.unchanged)} tone="text-muted-foreground" sub={t.before_start ? tr("{n} before contract start", { n: fmtInt(t.before_start) }) : tr("already stored")} />
      <Stat
        label={tr("Days")}
        value={<span className="text-sm">{r.days.first ? (r.days.first === r.days.last ? fmtDay(r.days.first) : `${fmtDay(r.days.first)} –`) : "—"}</span>}
        sub={r.days.first && r.days.first !== r.days.last ? fmtDay(r.days.last) : plural(r.sheets.length, "sheet")}
      />
    </div>
  );
};

// ---- step 2: one sheet
const SheetIcon: React.FC<{ s: PwaImportSheet; skip: boolean }> = ({ s, skip }) => {
  const { t } = useI18n();
  return skip ? (
    <MinusCircle className="size-4 text-muted-foreground" aria-label={t("Skipped")} />
  ) : s.errors.length ? (
    <XCircle className="size-4 text-red-400" aria-label={t("Problem")} />
  ) : s.warnings.length ? (
    <AlertTriangle className="size-4 text-amber-400" aria-label={t("Note")} />
  ) : (
    <CheckCircle2 className="size-4 text-emerald-400" aria-label={t("OK")} />
  );
};

const SheetRow: React.FC<{
  s: PwaImportSheet;
  day: string;
  skip: boolean;
  onDay: (v: string) => void;
  onSkip: (v: boolean) => void;
}> = ({ s, day, skip, onDay, onSkip }) => {
  const { t } = useI18n();
  const details = s.errors.length + s.warnings.length + s.unmatched.length;
  const [open, setOpen] = useState(s.errors.length > 0);
  const missingDay = !day && !skip;
  return (
    <>
      <TableRow className={cn(skip && "opacity-50", s.errors.length > 0 && !skip && "bg-red-500/[0.04]")}>
        <TableCell className="w-8 pr-0">
          <SheetIcon s={s} skip={skip} />
        </TableCell>
        <TableCell className="max-w-[240px]">
          <span className="block truncate font-medium" title={s.sheet ?? s.file}>
            {s.sheet ?? s.file}
          </span>
          {s.sheet && (
            <span className="block truncate text-[11px] text-muted-foreground" title={s.file}>
              {s.file}
            </span>
          )}
        </TableCell>
        <TableCell className="whitespace-nowrap">
          <Input
            type="date"
            className={cn("h-7 w-36 [color-scheme:dark]", missingDay && "border-red-400/60")}
            value={day}
            disabled={skip || !s.sheet}
            onChange={(e) => onDay(e.target.value)}
            aria-label={t("Day of {sheet}", { sheet: s.sheet })}
          />
          <span className={cn("mt-0.5 block text-[10px]", missingDay ? "text-red-300" : "text-muted-foreground")}>{s.day_source ? t("from {src}", { src: s.day_source }) : t("no date found: set it")}</span>
        </TableCell>
        <TableCell className="num text-right whitespace-nowrap">
          <span className={cn(s.matched < s.rows && "text-amber-300")}>{fmtInt(s.matched)}</span>
          <span className="text-muted-foreground">/{fmtInt(s.rows)}</span>
        </TableCell>
        <TableCell>
          <div className="flex flex-wrap gap-1">
            {s.new > 0 && <Badge variant="ok">{t("+{n} new", { n: fmtInt(s.new) })}</Badge>}
            {s.changed > 0 && <Badge variant="info">{t("{n} changed", { n: fmtInt(s.changed) })}</Badge>}
            {s.unchanged > 0 && <Badge variant="neutral">{t("{n} same", { n: fmtInt(s.unchanged) })}</Badge>}
            {s.before_start > 0 && (
              <Badge variant="neutral" title={t("Rows of days before the phase's contract start: not stored")}>
                {t("{n} pre-start", { n: fmtInt(s.before_start) })}
              </Badge>
            )}
            {!s.new && !s.changed && !s.unchanged && !s.before_start && <span className="text-muted-foreground">—</span>}
          </div>
        </TableCell>
        <TableCell>
          {details === 0 ? (
            <span className="text-muted-foreground">—</span>
          ) : (
            <button type="button" className="flex items-center gap-1 text-left" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
              {s.errors.length > 0 && <Badge variant="crit">{plural(s.errors.length, "problem")}</Badge>}
              {s.warnings.length > 0 && <Badge variant="warn">{plural(s.warnings.length, "note")}</Badge>}
              {s.unmatched.length > 0 && !s.errors.length && !s.warnings.length && <Badge variant="warn">{t("{n} unmatched", { n: fmtInt(s.unmatched.length) })}</Badge>}
              <ChevronDown className={cn("size-3.5 text-muted-foreground transition-transform", open && "rotate-180")} />
            </button>
          )}
        </TableCell>
        <TableCell className="text-center">
          <Checkbox checked={skip} onCheckedChange={(v) => onSkip(v === true)} aria-label={t("Skip {sheet}", { sheet: s.sheet })} disabled={!s.sheet} />
        </TableCell>
      </TableRow>
      {open && details > 0 && (
        <TableRow className="hover:bg-transparent">
          <TableCell />
          <TableCell colSpan={6} className="pt-0 pb-3">
            <ul className="flex flex-col gap-1 rounded-md border border-white/[0.07] bg-black/20 p-2.5 text-[11px]">
              {s.errors.map((e) => (
                <li key={e} className="flex gap-1.5 text-red-300">
                  <XCircle className="mt-px size-3 shrink-0" />
                  {e}
                </li>
              ))}
              {s.warnings.map((w) => (
                <li key={w} className="flex gap-1.5 text-amber-300">
                  <AlertTriangle className="mt-px size-3 shrink-0" />
                  {w}
                </li>
              ))}
              {s.unmatched.length > 0 && (
                <li className="mt-1 text-[10px] font-semibold tracking-wide text-muted-foreground uppercase">{t("Rows that match no site ({n})", { n: fmtInt(s.unmatched.length) })}</li>
              )}
              {s.unmatched.slice(0, 20).map((u) => (
                <li key={u.row} className="text-muted-foreground">
                  <span className="num text-foreground/80">{t("Row {n}", { n: u.row })}</span> · {u.name}
                  {u.comp_id != null ? ` (comp_id ${u.comp_id})` : ""}
                  {u.meter_no ? ` · ${t("meter {no}", { no: u.meter_no })}` : ""} — {u.reason}
                </li>
              ))}
              {s.unmatched.length > 20 && <li className="text-muted-foreground">{t("… {n} more", { n: fmtInt(s.unmatched.length - 20) })}</li>}
            </ul>
          </TableCell>
        </TableRow>
      )}
    </>
  );
};

// ---- the dialog
export const ImportDialog: React.FC<{ open: boolean; onClose: () => void; onImported: () => void }> = ({ open, onClose, onImported }) => {
  const { t: tr } = useI18n();
  const [files, setFiles] = useState<File[]>([]);
  const [result, setResult] = useState<PwaImportResult | null>(null);
  const [days, setDays] = useState<Record<string, string>>({});
  const [stale, setStale] = useState(false);
  const [busy, setBusy] = useState<"check" | "import" | null>(null);
  const [error, setError] = useState<{ commit: boolean; text: string } | null>(null);
  const [showAll, setShowAll] = useState(false);

  const reset = () => {
    setFiles([]);
    setResult(null);
    setDays({});
    setStale(false);
    setError(null);
    setShowAll(false);
  };
  const close = () => {
    if (busy) return;
    reset();
    onClose();
  };

  const run = async (commit: boolean, list: File[] = files, overrides: Record<string, string> = days) => {
    if (!list.length) return;
    setBusy(commit ? "import" : "check");
    setError(null);
    try {
      const r = await api.importPwaReport(list, commit, overrides);
      setResult(r);
      setStale(false);
      if (r.committed) onImported();
    } catch (e) {
      setError({ commit, text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(null);
    }
  };

  /** a new file set: keep the overrides of files still there, then check at once */
  const changeFiles = (next: File[]) => {
    const names = new Set(next.map((f) => f.name));
    const kept = Object.fromEntries(Object.entries(days).filter(([k]) => names.has(k.split("::")[0])));
    setFiles(next);
    setDays(kept);
    setStale(false);
    if (next.length) void run(false, next, kept);
    else {
      setResult(null);
      setError(null);
    }
  };
  const addFiles = (add: File[]) => {
    const have = new Set(files.map(fileKey));
    // a file of the same name replaces the earlier one (the backend keys sheets by file name)
    const fresh = add.filter((f) => !have.has(fileKey(f)));
    if (!fresh.length) return;
    const freshNames = new Set(fresh.map((f) => f.name));
    changeFiles([...files.filter((f) => !freshNames.has(f.name)), ...fresh]);
  };

  const setOverride = (key: string, v: string | null) => {
    setDays((d) => {
      const next = { ...d };
      if (v == null || v === "") delete next[key];
      else next[key] = v;
      return next;
    });
    setStale(true);
  };

  const sheets = useMemo(() => result?.sheets ?? [], [result]);
  const attention = useMemo(() => sheets.filter(needsLook), [sheets]);
  const shown = useMemo(
    () => (showAll || !attention.length ? sheets : attention).map((s, i) => ({ s, i })).sort((a, b) => rank(a.s) - rank(b.s) || a.i - b.i).map((x) => x.s),
    [sheets, attention, showAll]
  );
  const problemSheets = sheets.filter((s) => s.errors.length && days[s.key] !== "skip").length;
  const committed = !!result?.committed;
  const step = committed ? 2 : result ? 1 : 0;
  const t = result?.totals;
  const toStore = t ? t.new + t.changed : 0;

  return (
    <Dialog open={open} onOpenChange={(o) => !o && close()}>
      <DialogContent className="flex max-h-[90vh] flex-col gap-4 sm:max-w-5xl">
        <DialogHeader className="gap-3">
          <div className="flex flex-wrap items-center justify-between gap-3 pr-8">
            <DialogTitle>{tr("Import daily report")}</DialogTitle>
            <Steps at={step} />
          </div>
          <DialogDescription>
            {tr("The PWA daily report workbooks as the sites send them. Nothing is stored until you press Import; a day already stored is updated.")}
          </DialogDescription>
        </DialogHeader>

        <div className="-mx-5 flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-5">
          {!committed && <DropZone files={files} disabled={busy != null} onAdd={addFiles} onRemove={(f) => changeFiles(files.filter((x) => x !== f))} />}

          {error && (
            <Alert variant="destructive">
              <AlertTitle>{error.commit ? tr("Import failed") : tr("Check failed")}</AlertTitle>
              <AlertDescription>{error.text}</AlertDescription>
            </Alert>
          )}

          {busy === "check" && !result && (
            <div className="flex items-center justify-center gap-2 py-8 text-xs text-muted-foreground">
              <Spinner className="size-4" /> {tr("Reading {files}…", { files: plural(files.length, "workbook") })}
            </div>
          )}

          {committed && t && (
            <div className="flex flex-col items-center gap-3 py-6 text-center">
              <span className="flex size-12 items-center justify-center rounded-full border border-emerald-400/30 bg-emerald-400/10">
                <CheckCircle2 className="size-6 text-emerald-300" />
              </span>
              <div>
                <div className="text-sm font-semibold">{tr("{days} stored", { days: plural(t.new + t.changed, "day") })}</div>
                <div className="mt-1 text-xs text-muted-foreground">
                  {tr("{new} new · {changed} updated · {same} unchanged", { new: fmtInt(t.new), changed: fmtInt(t.changed), same: fmtInt(t.unchanged) })}
                  {result.days.first && (
                    <>
                      {" "}
                      · {fmtDay(result.days.first)}
                      {result.days.last !== result.days.first ? ` – ${fmtDay(result.days.last)}` : ""}
                    </>
                  )}
                </div>
                <div className="mt-1 text-[11px] text-muted-foreground">{tr("The page shows them now.")}</div>
              </div>
            </div>
          )}

          {result && !committed && t && (
            <div className={cn("flex flex-col gap-3 transition-opacity", busy === "check" && "pointer-events-none opacity-60")}>
              <Totals r={result} />

              {stale ? (
                <Alert>
                  <AlertTriangle className="text-amber-300!" />
                  <AlertTitle>{tr("You changed a day or a skip")}</AlertTitle>
                  <AlertDescription>{tr("Check again to see what the import would store with your changes.")}</AlertDescription>
                </Alert>
              ) : !result.ok ? (
                <Alert variant="destructive">
                  <XCircle />
                  <AlertTitle>{tr("{sheets} with problems", { sheets: plural(problemSheets || 1, "sheet") })}</AlertTitle>
                  <AlertDescription>
                    {tr("Set the sheet's day, or tick Skip, then check again. Rows that match no site must be fixed in the report or the site list.")}
                  </AlertDescription>
                </Alert>
              ) : toStore > 0 ? (
                <Alert>
                  <CheckCircle2 className="text-emerald-300!" />
                  <AlertTitle>{tr("Ready to import {days}", { days: plural(toStore, "day") })}</AlertTitle>
                  <AlertDescription>
                    {tr("{new} new and {changed} changed site-days from {sheets}.", { new: fmtInt(t.new), changed: fmtInt(t.changed), sheets: plural(sheets.filter((s) => days[s.key] !== "skip").length, "sheet") })}
                  </AlertDescription>
                </Alert>
              ) : (
                <Alert>
                  <CheckCircle2 className="text-muted-foreground!" />
                  <AlertTitle>{tr("Nothing new")}</AlertTitle>
                  <AlertDescription>{tr("Every day in these workbooks is already stored with the same figures.")}</AlertDescription>
                </Alert>
              )}

              {result.months_without_expected.length > 0 && (
                <Alert>
                  <AlertTriangle className="text-amber-300!" />
                  <AlertTitle>{tr("No expected energy for {months}", { months: result.months_without_expected.join(", ") })}</AlertTitle>
                  <AlertDescription>
                    {tr("Those days get no contract / PVsyst figure (shown as —, left out of the contract and PVsyst ratios). Build the months from the model workbook:")}{" "}
                    <code>python -m app.services.pwa_meter expected --model …</code>
                  </AlertDescription>
                </Alert>
              )}

              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="inline-flex rounded-lg border border-white/[0.07] bg-ink-900/80 p-0.5" role="tablist" aria-label={tr("Sheets shown")}>
                  {[
                    { all: false, label: "Needs a look", n: attention.length },
                    { all: true, label: "All sheets", n: sheets.length },
                  ].map((o) => {
                    const on = o.all ? showAll || !attention.length : !showAll && attention.length > 0;
                    return (
                      <button
                        key={o.label}
                        type="button"
                        role="tab"
                        aria-selected={on}
                        disabled={!o.all && !attention.length}
                        onClick={() => setShowAll(o.all)}
                        className={cn(
                          "rounded-md px-2.5 py-1 text-[11px] font-medium transition-colors disabled:opacity-40",
                          on ? "bg-white/10 text-foreground" : "text-muted-foreground hover:text-foreground"
                        )}
                      >
                        {tr(o.label)} <span className="num ml-0.5 text-muted-foreground">{o.n}</span>
                      </button>
                    );
                  })}
                </div>
                <span className="text-[11px] text-muted-foreground">{tr('Problems first · "needs a look" = problems, notes, new or changed days')}</span>
              </div>

              <Table containerClassName="table-wrap max-h-[45vh]">
                <TableHeader className="sticky top-0 z-10 bg-ink-900">
                  <TableRow>
                    <TableHead className="w-8 pr-0">
                      <span className="sr-only">{tr("Status")}</span>
                    </TableHead>
                    <TableHead>{tr("Sheet")}</TableHead>
                    <TableHead>{tr("Day")}</TableHead>
                    <TableHead className="text-right">{tr("Matched")}</TableHead>
                    <TableHead>{tr("Site-days")}</TableHead>
                    <TableHead>{tr("Issues")}</TableHead>
                    <TableHead className="text-center">{tr("Skip")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {shown.map((s) => (
                    <SheetRow
                      key={s.key}
                      s={s}
                      day={days[s.key] && isDay(days[s.key]) ? days[s.key] : (s.day ?? "")}
                      skip={days[s.key] === "skip"}
                      onDay={(v) => setOverride(s.key, isDay(v) && v !== s.day ? v : null)}
                      onSkip={(v) => setOverride(s.key, v ? "skip" : null)}
                    />
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </div>

        <DialogFooter className="items-center sm:justify-between">
          <span className="text-[11px] text-muted-foreground">
            {committed ? "" : busy === "check" ? tr("Checking…") : files.length ? tr("{files} · checked by the server, nothing stored yet", { files: plural(files.length, "workbook") }) : tr("No files chosen")}
          </span>
          <div className="flex gap-2">
            {committed ? (
              <>
                <Button variant="ghost" onClick={reset}>
                  {tr("Import more")}
                </Button>
                <Button onClick={close}>{tr("Done")}</Button>
              </>
            ) : (
              <>
                <Button variant="ghost" onClick={close} disabled={busy != null}>
                  {tr("Cancel")}
                </Button>
                {result && stale ? (
                  <Button onClick={() => void run(false)} disabled={busy != null}>
                    {busy === "check" && <Spinner data-icon="inline-start" className="size-3" />}
                    {tr("Check again")}
                  </Button>
                ) : (
                  <Button
                    onClick={() => void run(true)}
                    disabled={busy != null || !result || !result.ok || toStore === 0}
                    title={!result ? tr("Choose the workbooks first") : !result.ok ? tr("Fix the problems first") : toStore === 0 ? tr("Nothing new to store") : undefined}
                  >
                    {busy === "import" && <Spinner data-icon="inline-start" className="size-3" />}
                    {toStore > 0 ? tr("Import {days}", { days: plural(toStore, "day") }) : tr("Import")}
                  </Button>
                )}
              </>
            )}
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
