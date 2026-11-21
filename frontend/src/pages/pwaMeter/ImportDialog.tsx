/** PWA Meter → Import report (admin): upload the daily report workbooks, check the preview (day of
 * each sheet and where it came from, matched / unmatched rows, new / changed days, problems), set a
 * missing day or skip a sheet, then import. Nothing is stored until Import; the backend refuses it
 * while any included sheet has a problem. Every check re-sends the files (the backend keeps nothing). */
import React, { useMemo, useState } from "react";
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

const needsLook = (s: PwaImportSheet) => s.errors.length > 0 || s.warnings.length > 0 || s.new > 0 || s.changed > 0;
/** problems first, then notes, then the rest in workbook order */
const rank = (s: PwaImportSheet) => (s.errors.length ? 0 : s.warnings.length ? 1 : 2);

const SheetRow: React.FC<{
  s: PwaImportSheet;
  day: string;
  skip: boolean;
  onDay: (v: string) => void;
  onSkip: (v: boolean) => void;
}> = ({ s, day, skip, onDay, onSkip }) => {
  const [open, setOpen] = useState(false);
  const problems = s.errors.length + s.warnings.length;
  return (
    <>
      <TableRow className={cn(skip && "opacity-50")}>
        <TableCell className="max-w-[220px]">
          <span className="block truncate" title={s.file}>
            {s.sheet ?? s.file}
          </span>
          {s.sheet && <span className="block truncate text-[11px] text-muted-foreground">{s.file}</span>}
        </TableCell>
        <TableCell className="whitespace-nowrap">
          <Input
            type="date"
            className="h-7 w-36 [color-scheme:dark]"
            value={day}
            disabled={skip || !s.sheet}
            onChange={(e) => onDay(e.target.value)}
            aria-label={`Day of ${s.sheet}`}
          />
          <span className="mt-0.5 block text-[10px] text-muted-foreground">{s.day_source ? `from ${s.day_source}` : "no date found"}</span>
        </TableCell>
        <TableCell className="num text-right">
          {s.matched}/{s.rows}
        </TableCell>
        <TableCell className="num text-right">{s.new || "—"}</TableCell>
        <TableCell className="num text-right">{s.changed || "—"}</TableCell>
        <TableCell className="num text-right text-muted-foreground">{s.unchanged || "—"}</TableCell>
        <TableCell className="num text-right text-muted-foreground" title="Rows of days before the phase's contract start: not stored">
          {s.before_start || "—"}
        </TableCell>
        <TableCell className="max-w-[260px]">
          {problems === 0 ? (
            <span className="text-muted-foreground">—</span>
          ) : (
            <button type="button" className="text-left" onClick={() => setOpen((o) => !o)}>
              {s.errors.length > 0 && <Badge variant="crit">{s.errors.length} problem{s.errors.length > 1 ? "s" : ""}</Badge>}{" "}
              {s.warnings.length > 0 && <Badge variant="warn">{s.warnings.length} note{s.warnings.length > 1 ? "s" : ""}</Badge>}
              <span className="ml-1 text-[11px] text-muted-foreground">{open ? "hide" : "show"}</span>
            </button>
          )}
        </TableCell>
        <TableCell className="text-center">
          <Checkbox checked={skip} onCheckedChange={(v) => onSkip(v === true)} aria-label={`Skip ${s.sheet}`} disabled={!s.sheet} />
        </TableCell>
      </TableRow>
      {open && problems > 0 && (
        <TableRow>
          <TableCell colSpan={9} className="bg-muted/40 text-[11px]">
            <ul className="flex flex-col gap-0.5">
              {s.errors.map((e) => (
                <li key={e} className="text-red-300">
                  {e}
                </li>
              ))}
              {s.warnings.map((w) => (
                <li key={w} className="text-amber-300">
                  {w}
                </li>
              ))}
              {s.unmatched.slice(0, 20).map((u) => (
                <li key={u.row} className="text-muted-foreground">
                  Row {u.row}: {u.name}
                  {u.comp_id != null ? ` (comp_id ${u.comp_id})` : ""}
                  {u.meter_no ? ` · meter ${u.meter_no}` : ""} — {u.reason}
                </li>
              ))}
              {s.unmatched.length > 20 && <li className="text-muted-foreground">… {s.unmatched.length - 20} more</li>}
            </ul>
          </TableCell>
        </TableRow>
      )}
    </>
  );
};

export const ImportDialog: React.FC<{ open: boolean; onClose: () => void; onImported: () => void }> = ({ open, onClose, onImported }) => {
  const [files, setFiles] = useState<File[]>([]);
  const [result, setResult] = useState<PwaImportResult | null>(null);
  const [days, setDays] = useState<Record<string, string>>({});
  const [stale, setStale] = useState(false);
  const [busy, setBusy] = useState<"check" | "import" | null>(null);
  const [error, setError] = useState<string | null>(null);
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

  const run = async (commit: boolean) => {
    setBusy(commit ? "import" : "check");
    setError(null);
    try {
      const r = await api.importPwaReport(files, commit, days);
      setResult(r);
      setStale(false);
      if (r.committed) onImported();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
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
  const shown = useMemo(
    () => (showAll ? sheets : sheets.filter(needsLook)).map((s, i) => ({ s, i })).sort((a, b) => rank(a.s) - rank(b.s) || a.i - b.i).map((x) => x.s),
    [sheets, showAll]
  );
  const t = result?.totals;

  return (
    <Dialog open={open} onOpenChange={(o) => !o && close()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-5xl">
        <DialogHeader>
          <DialogTitle>Import daily report</DialogTitle>
          <DialogDescription>
            The PWA daily report workbooks (.xlsx) as the sites send them: phase 1 (one day per file) or phase 2 (a sheet per day). Nothing is stored
            until you press Import; a day already stored is updated.
          </DialogDescription>
        </DialogHeader>

        {!result?.committed && (
          <div className="flex flex-wrap items-center gap-2">
            <Input
              type="file"
              accept=".xlsx,.xlsm"
              multiple
              className="h-9 max-w-md"
              onChange={(e) => {
                setFiles(Array.from(e.target.files ?? []));
                setResult(null);
                setDays({});
                setStale(false);
              }}
              aria-label="Report workbooks"
            />
            <Button variant="outline" size="sm" disabled={!files.length || busy != null} onClick={() => void run(false)}>
              {busy === "check" && <Spinner data-icon="inline-start" className="size-3" />}
              {result ? "Check again" : "Preview"}
            </Button>
            {files.length > 0 && <span className="text-xs text-muted-foreground">{files.map((f) => f.name).join(", ")}</span>}
          </div>
        )}

        {error && (
          <Alert variant="destructive">
            <AlertTitle>Import failed</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        {result?.committed && t && (
          <Alert>
            <AlertTitle>Imported</AlertTitle>
            <AlertDescription>
              {fmtInt(t.new)} new and {fmtInt(t.changed)} changed days stored ({fmtDay(result.days.first)} – {fmtDay(result.days.last)});{" "}
              {fmtInt(t.unchanged)} unchanged. The page shows them now.
            </AlertDescription>
          </Alert>
        )}

        {result && !result.committed && t && (
          <>
            <div className="flex flex-wrap gap-x-6 gap-y-1 text-xs">
              <span>
                <span className="num font-semibold">{fmtInt(t.matched)}</span> of {fmtInt(t.rows)} rows matched a site
              </span>
              <span>
                <span className="num font-semibold">{fmtInt(t.new)}</span> new days
              </span>
              <span>
                <span className="num font-semibold">{fmtInt(t.changed)}</span> changed
              </span>
              <span className="text-muted-foreground">{fmtInt(t.unchanged)} unchanged</span>
              {t.before_start > 0 && <span className="text-muted-foreground">{fmtInt(t.before_start)} before contract start (not stored)</span>}
              {result.days.first && (
                <span className="text-muted-foreground">
                  {fmtDay(result.days.first)} – {fmtDay(result.days.last)}
                </span>
              )}
            </div>
            {result.months_without_expected.length > 0 && (
              <Alert>
                <AlertTitle>No expected energy for {result.months_without_expected.join(", ")}</AlertTitle>
                <AlertDescription>
                  Those days get no contract / PVsyst figure (shown as —, left out of the contract and PVsyst ratios). Build the months from the model
                  workbook: <code>python -m app.services.pwa_meter expected --model …</code>
                </AlertDescription>
              </Alert>
            )}
            {!result.ok && (
              <Alert variant="destructive">
                <AlertDescription>
                  Some sheets have problems. Set their day, or tick Skip, then Check again. Rows that match no site must be fixed in the report or
                  the site list.
                </AlertDescription>
              </Alert>
            )}
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span>
                {shown.length} of {sheets.length} sheets shown{!showAll && sheets.length > shown.length ? " (those with problems or changes)" : ""}
              </span>
              {sheets.length > shown.length || showAll ? (
                <Button variant="ghost" size="xs" onClick={() => setShowAll((v) => !v)}>
                  {showAll ? "Show fewer" : `Show all ${sheets.length}`}
                </Button>
              ) : null}
            </div>
            <Table containerClassName="table-wrap max-h-[45vh]">
              <TableHeader className="sticky top-0 z-10 bg-popover">
                <TableRow>
                  <TableHead>Sheet</TableHead>
                  <TableHead>Day</TableHead>
                  <TableHead className="text-right">Matched</TableHead>
                  <TableHead className="text-right">New</TableHead>
                  <TableHead className="text-right">Changed</TableHead>
                  <TableHead className="text-right">Same</TableHead>
                  <TableHead className="text-right">Pre-start</TableHead>
                  <TableHead>Problems</TableHead>
                  <TableHead className="text-center">Skip</TableHead>
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
          </>
        )}

        <DialogFooter>
          <Button variant="ghost" onClick={close} disabled={busy != null}>
            {result?.committed ? "Close" : "Cancel"}
          </Button>
          {result && !result.committed && (
            <Button
              onClick={() => void run(true)}
              disabled={busy != null || stale || !result.ok || result.totals.new + result.totals.changed === 0}
              title={stale ? "Check again first: you changed a day or a skip" : !result.ok ? "Fix the problems first" : undefined}
            >
              {busy === "import" && <Spinner data-icon="inline-start" className="size-3" />}
              {stale ? "Check again first" : `Import ${fmtInt(result.totals.new + result.totals.changed)} days`}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
