/**
 * Line diff of two Markdown texts (`diff`'s `diffLines`), computed in the browser. Unchanged runs
 * longer than a few lines fold to "… N unchanged lines". A diff that takes too long (huge, very
 * different texts) says so instead of freezing the page.
 */
import React, { useMemo, useState } from "react";
import { diffLines } from "diff";
import { cn } from "@/lib/utils";
import { fmtInt } from "../../components/ui";
import { useI18n } from "../../i18n";

const CONTEXT = 3;

type Line = { kind: "same" | "add" | "del"; text: string };
type Row = Line | { kind: "fold"; count: number; id: number };

const splitLines = (value: string): string[] => {
  const lines = value.split("\n");
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  return lines;
};

/** null when the diff gave up (timeout) */
export const lineDiff = (a: string, b: string): Line[] | null => {
  const changes = diffLines(a, b, { timeout: 1500 });
  if (!changes) return null;
  return changes.flatMap((c) => splitLines(c.value).map((text): Line => ({ kind: c.added ? "add" : c.removed ? "del" : "same", text })));
};

export const DiffView: React.FC<{
  /** older / theirs */
  a: string;
  /** newer / mine */
  b: string;
  /** legend for removed (only in a) and added (only in b) lines */
  delLabel: string;
  addLabel: string;
  className?: string;
}> = ({ a, b, delLabel, addLabel, className }) => {
  const { t } = useI18n();
  const lines = useMemo(() => lineDiff(a, b), [a, b]);
  const [open, setOpen] = useState<Set<number>>(() => new Set());

  const rows = useMemo<Row[]>(() => {
    if (!lines) return [];
    const out: Row[] = [];
    let i = 0;
    let id = 0;
    while (i < lines.length) {
      if (lines[i].kind !== "same") {
        out.push(lines[i++]);
        continue;
      }
      let j = i;
      while (j < lines.length && lines[j].kind === "same") j++;
      const run = lines.slice(i, j);
      const head = i === 0 ? 0 : CONTEXT;
      const tail = j === lines.length ? 0 : CONTEXT;
      const foldId = id++;
      if (run.length > head + tail + 1 && !open.has(foldId)) {
        out.push(...run.slice(0, head), { kind: "fold", count: run.length - head - tail, id: foldId }, ...run.slice(run.length - tail));
      } else out.push(...run);
      i = j;
    }
    return out;
  }, [lines, open]);

  if (!lines) return <p className="callout-warn">{t("Too many changes to show a diff.")}</p>;
  const added = lines.filter((l) => l.kind === "add").length;
  const removed = lines.filter((l) => l.kind === "del").length;

  return (
    <div className={cn("flex min-w-0 flex-col gap-2", className)}>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <span className="inline-flex items-center gap-1.5">
          <span className="num rounded bg-red-500/15 px-1 text-red-300">−{fmtInt(removed)}</span>
          {delLabel}
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="num rounded bg-emerald-500/15 px-1 text-emerald-300">+{fmtInt(added)}</span>
          {addLabel}
        </span>
      </div>
      {added === 0 && removed === 0 ? (
        <p className="text-xs text-muted-foreground">{t("The text is the same.")}</p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-white/[0.07] bg-ink-950/60">
          <pre className="num min-w-full text-[12px] leading-5">
            {rows.map((r, k) =>
              r.kind === "fold" ? (
                <button
                  key={`f${r.id}`}
                  type="button"
                  className="block w-full bg-white/[0.03] px-3 py-0.5 text-left text-[11px] text-sky-300 hover:bg-white/[0.06]"
                  onClick={() => setOpen((s) => new Set(s).add(r.id))}
                >
                  {t("… {n} unchanged lines (show)", { n: fmtInt(r.count) })}
                </button>
              ) : (
                <div
                  key={k}
                  className={cn(
                    "flex whitespace-pre-wrap break-words px-2",
                    r.kind === "add" && "bg-emerald-500/[0.12] text-emerald-100",
                    r.kind === "del" && "bg-red-500/[0.12] text-red-100",
                    r.kind === "same" && "text-slate-400"
                  )}
                >
                  <span className="w-4 shrink-0 select-none text-slate-500" aria-hidden>
                    {r.kind === "add" ? "+" : r.kind === "del" ? "−" : " "}
                  </span>
                  <span className="min-w-0 flex-1">{r.text || " "}</span>
                </div>
              )
            )}
          </pre>
        </div>
      )}
    </div>
  );
};
