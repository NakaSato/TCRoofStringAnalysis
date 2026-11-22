/* The Route tab's summary strip (docs/plans/site-visit-route.md §9.3): the finish time first (amber
   after the latest finish or after sunset, red when a visit window is missed), then drive km · time
   and time on site (+ waiting). Below: where the drive times come from (road estimate or straight
   line; why, the order method and, for admins, the Geoapify credits in its tooltip) and the day's
   warnings, shown here once. Before a plan, "—". Every figure is modelled. */
import React from "react";
import { Info } from "lucide-react";
import { useAppContext } from "../../context/AppContext";
import { isAdmin } from "../../auth/access";
import { useI18n } from "../../i18n";
import { cn } from "@/lib/utils";
import { fmt, fmtInt } from "../../components/ui";
import { Badge } from "@/components/ui/badge";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { FALLBACK_TEXT, METHOD_LABEL, fmtClock, fmtDuration, fmtKm, splitClock } from "./format";
import type { VisitRoute } from "./useVisitRoute";

const Figure: React.FC<{ label: string; value: React.ReactNode; sub?: React.ReactNode; className?: string }> = ({ label, value, sub, className }) => (
  <div className="min-w-0">
    <div className="text-[10px] tracking-wide text-slate-500 uppercase">{label}</div>
    <div className={cn("num truncate text-sm font-semibold text-slate-100", className)}>{value}</div>
    {sub && <div className="num truncate text-[10px] text-slate-500">{sub}</div>}
  </div>
);

export const RouteSummary: React.FC<{ d: VisitRoute }> = ({ d }) => {
  const { t } = useI18n();
  const { user } = useAppContext();
  const r = d.answer;
  const updating = (d.solving || d.pending) && r != null && !d.outdated;
  const sunsetStops = r ? r.stops.filter((s) => s.after_sunset === true).length : 0;
  const missed = (r?.totals.late_min ?? 0) > 0;
  const lateTone = !r ? null : missed ? "crit" : r.totals.after_latest || sunsetStops > 0 ? "warn" : null;

  const notes: string[] = [];
  if (r) {
    notes.push(t(METHOD_LABEL[r.method] ?? r.method));
    if (r.source === "straight_line" && r.fallback_reason) notes.push(t(FALLBACK_TEXT[r.fallback_reason]));
    if (r.source === "geoapify" && r.straight_line_pairs > 0)
      notes.push(t("{n} pairs Geoapify could not route are straight-line estimates.", { n: fmtInt(r.straight_line_pairs) }));
    if (r.source === "geoapify" && r.geometry_source === "straight_line")
      notes.push(
        t("The map line is straight segments, not the road.") + (r.geometry_fallback_reason ? ` ${t(FALLBACK_TEXT[r.geometry_fallback_reason])}` : "")
      );
    if (r.estimate)
      notes.push(
        t("Straight-line estimate (modelled): distance × {f} road factor, {v} km/h average.", { f: fmt(r.estimate.road_factor, 1), v: fmtInt(r.estimate.speed_kmh) })
      );
    if (isAdmin(user))
      notes.push(
        t("Geoapify credits: {used} this plan · {today} / {cap} today", {
          used: fmtInt(r.credits_used),
          today: fmtInt(r.credits_today),
          cap: fmtInt(r.credits_daily_cap),
        })
      );
  }

  return (
    <div className={cn("flex flex-col gap-1.5 border-b border-white/[0.06] bg-ink-950/90 px-3 py-2 backdrop-blur", "lg:sticky lg:top-0 lg:z-20")}>
      <div className={cn("grid grid-cols-[1.2fr_1fr_1fr] gap-3 transition-opacity", (d.outdated || updating) && "opacity-50")}>
        <Figure
          label={t("Finish")}
          value={
            r ? (
              <span className="flex items-baseline gap-1">
                <span className="text-lg leading-tight">{splitClock(r.totals.finish).time}</span>
                {splitClock(r.totals.finish).day > 0 && (
                  <span className="text-[11px] font-medium">{t("+{n} day", { n: splitClock(r.totals.finish).day })}</span>
                )}
              </span>
            ) : (
              <span className="text-lg leading-tight">—</span>
            )
          }
          sub={r ? t("Leave {time}", { time: r.totals.leave_at }) : t("Leave {time}", { time: d.leaveAt || "—" })}
          className={cn(lateTone === "warn" && "text-amber-300", lateTone === "crit" && "text-red-300")}
        />
        <Figure label={t("Drive")} value={r ? fmtKm(r.totals.drive_km) : "—"} sub={r ? fmtDuration(r.totals.drive_min) : undefined} />
        <Figure
          label={t("Time on site")}
          value={r ? fmtDuration(r.totals.service_min) : "—"}
          sub={r && r.totals.wait_min ? t("Wait {d}", { d: fmtDuration(r.totals.wait_min) }) : undefined}
        />
      </div>

      {(r || updating) && (
        <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
          {r && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Badge variant={r.source === "geoapify" ? "info" : "warn"} tabIndex={0} className="cursor-default">
                  {r.source === "geoapify" ? t("Road estimate (Geoapify, OpenStreetMap)") : t("Straight line, not road")}
                  <Info className="size-3 opacity-70" aria-hidden />
                </Badge>
              </TooltipTrigger>
              <TooltipContent className="max-w-72">
                <ul className="flex flex-col gap-0.5">
                  {notes.map((n) => (
                    <li key={n}>{n}</li>
                  ))}
                </ul>
              </TooltipContent>
            </Tooltip>
          )}
          {r && r.totals.after_latest && <Badge variant="warn">{t("Ends after {latest}", { latest: fmtClock(r.latest_finish) })}</Badge>}
          {sunsetStops > 0 && <Badge variant="crit">{t("{n} stops after sunset", { n: fmtInt(sunsetStops) })}</Badge>}
          {missed && <Badge variant="crit">{t("Window missed by {d}", { d: fmtDuration(r!.totals.late_min) })}</Badge>}
          {r && d.outdated && !d.solving && <span className="text-amber-300">{t("Changed since the plan")}</span>}
          {updating && (
            <span className="flex items-center gap-1 text-slate-400">
              <Spinner className="size-3" />
              {t("Updating the times…")}
            </span>
          )}
        </div>
      )}
    </div>
  );
};
