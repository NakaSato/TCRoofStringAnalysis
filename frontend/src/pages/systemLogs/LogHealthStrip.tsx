import React from "react";
import type { SystemLogSource, SystemLogSummary } from "../../api/client";
import { fmtInt } from "../../components/ui";
import type { StatusLevel } from "../../components/ui";
import { cn } from "@/lib/utils";
import { Card } from "@/components/ui/card";
import { SOURCE_VIEW, bkk, shortLogger } from "./shared";
import { useI18n } from "../../i18n";

const LevelCount: React.FC<{ label: string; value: number | null; active: boolean; hot: string; onClick: () => void; hint: string }> = ({
  label,
  value,
  active,
  hot,
  onClick,
  hint,
}) => {
  const { t } = useI18n();
  return (
  <button
    type="button"
    onClick={onClick}
    aria-pressed={active}
    title={hint}
    className={cn(
      "group flex min-w-0 flex-col items-start rounded-lg px-3 py-2 text-left transition-colors hover:bg-white/[0.04]",
      active && "bg-white/[0.05] ring-1 ring-white/10",
    )}
  >
    <span className="eyebrow">{label}</span>
    <span className={cn("num mt-0.5 text-2xl font-bold tracking-tight", value ? hot : "text-slate-500")}>{fmtInt(value)}</span>
    <span className="text-[11px] text-slate-500 group-hover:text-slate-400">{active ? t("Filtered") : t("Show only these")}</span>
  </button>
  );
};

/** Last-24 h health: one strip with a verdict, clickable level counts, records by source and the
 *  newest error. Counts are "—" until the summary arrives (never a made-up 0). */
export const LogHealthStrip: React.FC<{
  summary: SystemLogSummary | null;
  level: string;
  source: string;
  onLevel: (level: "ERROR" | "WARNING" | "INFO") => void;
  onSource: (source: SystemLogSource | "all") => void;
}> = ({ summary, level, source, onLevel, onSource }) => {
  const { t } = useI18n();
  const errors = summary ? summary.by_level.ERROR + summary.by_level.CRITICAL : null;
  const warnings = summary ? summary.by_level.WARNING : null;
  const total = summary?.total ?? null;
  const lastError = summary?.last_error ?? null;
  const tone: StatusLevel = summary == null ? "neutral" : errors ? "crit" : warnings ? "warn" : "ok";
  const verdict =
    summary == null
      ? t("Loading…")
      : errors
        ? errors === 1 ? t("{n} error", { n: fmtInt(errors) }) : t("{n} errors", { n: fmtInt(errors) })
        : warnings
          ? warnings === 1 ? t("{n} warning", { n: fmtInt(warnings) }) : t("{n} warnings", { n: fmtInt(warnings) })
          : t("All clear");
  const toneText = { ok: "text-emerald-300", warn: "text-amber-300", crit: "text-red-300", info: "text-sky-300", neutral: "text-slate-300" }[tone];
  const toneBar = { ok: "bg-emerald-400", warn: "bg-amber-400", crit: "bg-red-400", info: "bg-sky-400", neutral: "bg-slate-600" }[tone];

  return (
    <Card className="gap-0 overflow-hidden py-0">
      <div className="grid grid-cols-1 divide-y divide-white/[0.06] lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)_minmax(0,1.4fr)] lg:divide-x lg:divide-y-0">
        {/* Verdict */}
        <div className="flex items-center gap-3 px-4 py-4">
          <span className={cn("h-10 w-1 shrink-0 rounded-full", toneBar)} aria-hidden />
          <div className="min-w-0">
            <div className="eyebrow">{t("Last 24 h")}</div>
            <div className={cn("text-lg font-bold tracking-tight", toneText)}>{verdict}</div>
            <div className="text-[11px] text-slate-500">
              {summary == null
                ? t("Reading the summary")
                : errors
                  ? t("ERROR or CRITICAL records need a look")
                  : warnings
                    ? t("No errors · e.g. rate limits, partial runs")
                    : t("No errors or warnings")}
            </div>
          </div>
        </div>

        {/* Level counts */}
        <div className="grid grid-cols-2 gap-1 px-2 py-2">
          <LevelCount
            label={t("Errors")}
            value={errors}
            hot="text-red-300"
            active={level === "ERROR"}
            hint={t("ERROR and CRITICAL")}
            onClick={() => onLevel(level === "ERROR" ? "INFO" : "ERROR")}
          />
          <LevelCount
            label={t("Warnings")}
            value={warnings}
            hot="text-amber-300"
            active={level === "WARNING"}
            hint={t("WARNING and above")}
            onClick={() => onLevel(level === "WARNING" ? "INFO" : "WARNING")}
          />
        </div>

        {/* Records by source */}
        <div className="flex flex-col justify-center gap-2 px-4 py-3">
          <div className="flex items-baseline justify-between gap-2">
            <span className="eyebrow">{t("Records")}</span>
            <span className="num text-sm font-semibold text-white">{fmtInt(total)}</span>
          </div>
          <div className="flex h-2 w-full overflow-hidden rounded-full bg-white/[0.05]" aria-hidden>
            {summary && total
              ? SOURCE_VIEW.map((s) =>
                  summary.by_source[s.key] ? (
                    <div key={s.key} className={cn("h-full", s.bar)} style={{ width: `${(summary.by_source[s.key] / total) * 100}%` }} />
                  ) : null,
                )
              : null}
          </div>
          <div className="flex flex-wrap gap-1">
            {SOURCE_VIEW.map((s) => {
              const active = source === s.key;
              return (
                <button
                  key={s.key}
                  type="button"
                  aria-pressed={active}
                  onClick={() => onSource(active ? "all" : s.key)}
                  className={cn(
                    "flex items-center gap-1.5 rounded-md px-2 py-0.5 text-[11px] text-slate-400 transition-colors hover:bg-white/[0.05] hover:text-slate-200",
                    active && "bg-white/[0.06] text-slate-100 ring-1 ring-white/10",
                  )}
                >
                  <span className={cn("h-1.5 w-1.5 rounded-full", s.dot)} />
                  {t(s.label)}
                  <span className="num font-semibold text-slate-200">{fmtInt(summary ? summary.by_source[s.key] : null)}</span>
                </button>
              );
            })}
          </div>
        </div>
      </div>

      {/* Newest error */}
      <div
        className={cn(
          "flex items-center gap-2 border-t px-4 py-2 text-[11px]",
          lastError ? "border-red-400/15 bg-red-400/[0.05]" : "border-white/[0.06]",
        )}
      >
        <span className="eyebrow shrink-0">{t("Last error")}</span>
        {lastError ? (
          <button
            type="button"
            className="flex min-w-0 items-baseline gap-2 text-left text-slate-300 hover:text-white"
            title={lastError.message}
            onClick={() => onLevel("ERROR")}
          >
            <span className="num shrink-0 text-red-300">{bkk(lastError.ts).time.slice(0, 5)}</span>
            <span className="shrink-0 font-medium text-slate-400">{shortLogger(lastError.logger)}</span>
            <span className="truncate">{lastError.message}</span>
          </button>
        ) : (
          <span className="text-slate-500">{summary == null ? "—" : t("None in 24 h")}</span>
        )}
      </div>
    </Card>
  );
};
