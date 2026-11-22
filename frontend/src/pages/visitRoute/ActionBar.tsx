/* The panel's one action slot, sticky at its bottom (docs/plans/site-visit-route.md §9.2 item 3):
   exactly one primary button for the state the plan is in, plus a ⋯ menu.
     no start            → Choose a start (the start popover / the settings sheet)
     no stops            → Add plants to visit (that tab)
     not planned / stale → Plan best order · n stops
     planned             → Navigate in Google Maps (one button per link, each ≤ 3 waypoints so phones keep
                           every stop; each starts where the previous ended), "Best order again" after a
                           hand reorder
   A solve error or rate limit is a callout just above it; the hint and the 25-stop cap under it. */
import React from "react";
import { Copy, Eraser, Home, MoreHorizontal, Navigation, Plus, RefreshCw, Sparkles } from "lucide-react";
import { useI18n } from "../../i18n";
import { notify } from "@/lib/notify";
import { dayLabel } from "@/lib/day";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { MAX_STOPS, copyText, navLabels, stopListText } from "./format";
import type { VisitRoute } from "./useVisitRoute";

const SolveErrorLine: React.FC<{ d: VisitRoute }> = ({ d }) => {
  const { t } = useI18n();
  const err = d.solveError;
  if (!err) return null;
  return (
    <div className={cn("mb-2 flex flex-wrap items-center gap-2 rounded-md px-2.5 py-1.5 text-[11px]", err.kind === "rate" ? "callout-warn" : "callout-crit")}>
      <span className="min-w-0 flex-1">
        {err.kind === "rate" ? t("Too many plans in a minute. Wait a moment, then try again.") : err.text}
        {err.kind === "no_location" && err.plantIds.length > 0 && <> ({err.plantIds.map((id) => d.plantById.get(id)?.name ?? t("Plant {id}", { id })).join(", ")})</>}
      </span>
      {err.kind !== "no_location" && (
        <Button size="xs" variant="outline" onClick={d.retry} disabled={d.solving}>
          <RefreshCw data-icon="inline-start" />
          {t("Try again")}
        </Button>
      )}
    </div>
  );
};

export const ActionBar: React.FC<{
  d: VisitRoute;
  onChooseStart: () => void;
}> = ({ d, onChooseStart }) => {
  const { t } = useI18n();
  const r = d.answer;
  const planned = r != null && d.sameSet;
  const links = planned ? r.google_maps_links : [];
  const n = d.stops.length;

  const copy = async () => {
    if (!r) return;
    const ok = await copyText(stopListText(r, dayLabel(r.day)));
    notify(ok ? "ok" : "crit", ok ? t("Stop list copied") : t("Could not copy: your browser blocked the clipboard."));
  };

  const menu =
    n > 0 ? (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon" className="size-11 shrink-0" aria-label={t("More route actions")}>
            <MoreHorizontal />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" side="top">
          <DropdownMenuItem disabled={!planned} onSelect={() => void copy()}>
            <Copy />
            {t("Copy stop list")}
          </DropdownMenuItem>
          <DropdownMenuItem disabled={!planned || !d.canSolve || d.solving || n < 2} onSelect={() => void d.solve(false)}>
            <Sparkles />
            {t("Plan best order again")}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive" onSelect={d.clearStops}>
            <Eraser />
            {t("Clear all stops")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    ) : null;
  /** several links: a compact grid with the ⋯ menu in its label row (25 stops = 7 links) */
  const multi = planned && links.length > 1;
  const linksNote = (children: React.ReactNode) => (
    <Tooltip>
      <TooltipTrigger asChild>
        <span tabIndex={0} className="cursor-default">
          {children}
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-64">
        {t("Opens Google Maps in a new tab; times there are Google's own.")}{" "}
        {t("Each link holds at most 3 stops, so phones keep every waypoint; the next link starts where the last ended.")}
      </TooltipContent>
    </Tooltip>
  );

  let primary: React.ReactNode;
  let hint: string | null = null;
  if (!d.start) {
    primary = (
      <Button size="lg" variant="default" className="h-11 w-full text-sm" onClick={onChooseStart}>
        <Home data-icon="inline-start" />
        {t("Choose a start")}
      </Button>
    );
  } else if (n === 0) {
    if (d.tab === "plants") hint = t("Add at least one stop.");
    else
      primary = (
        <Button size="lg" variant="default" className="h-11 w-full text-sm" onClick={() => d.setTab("plants")}>
          <Plus data-icon="inline-start" />
          {t("Add plants to visit")}
        </Button>
      );
  } else if (!planned) {
    if (!d.canSolve) hint = t("Fix the highlighted times first.");
    primary = (
      <Button size="lg" variant="default" className="h-11 w-full text-sm" disabled={!d.canSolve || d.solving}
        onClick={() => {
          d.setTab("route");
          void d.solve(false);
        }}
      >
        {d.solving ? <Spinner data-icon="inline-start" /> : <Sparkles data-icon="inline-start" />}
        {n === 1 ? t("Plan best order · 1 stop") : t("Plan best order · {n} stops", { n })}
      </Button>
    );
  } else if (links.length === 0) {
    hint = t("Google Maps links are not available for this plan.");
  } else {
    // planned: links follow the plan's order; after a hand reorder they wait for the re-timed plan
    const ready = d.sameOrder;
    const labels = navLabels(r);
    primary =
      links.length === 1 ? (
        <Button asChild={ready} size="lg" variant="default" className="h-11 w-full text-sm" disabled={!ready}>
          {ready ? (
            <a href={links[0]} target="_blank" rel="noopener noreferrer">
              <Navigation data-icon="inline-start" />
              {t("Navigate in Google Maps")}
            </a>
          ) : (
            <>
              <Spinner data-icon="inline-start" />
              {t("Updating the times…")}
            </>
          )}
        </Button>
      ) : (
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-1.5 text-[11px] text-slate-400">
            <Navigation className="size-3.5 shrink-0 text-solar-300" aria-hidden />
            <span className="min-w-0 flex-1 truncate">{linksNote(t("Navigate in Google Maps, leg by leg"))}</span>
            {!ready && <Spinner className="size-3" />}
            <span className="-my-2 -mr-2 [&_button]:size-8">{menu}</span>
          </div>
          <div className="grid grid-cols-4 gap-1">
            {links.map((href, i) =>
              ready ? (
                <Button key={href} asChild size="default" variant={i === 0 ? "default" : "outline"} className="num h-8 px-1 text-[11px]">
                  <a href={href} target="_blank" rel="noopener noreferrer" aria-label={t("Navigate {range}", { range: labels[i] })}>
                    {labels[i]}
                  </a>
                </Button>
              ) : (
                <Button key={href} size="default" variant="outline" className="num h-8 px-1 text-[11px]" disabled>
                  {labels[i]}
                </Button>
              )
            )}
          </div>
        </div>
      );
  }

  const bestAgain = planned && r.method === "fixed" && n > 1;

  return (
    <div className="sticky bottom-0 z-20 border-t border-white/10 bg-ink-950/95 px-3 pt-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] backdrop-blur">
      <SolveErrorLine d={d} />
      <div className="flex items-end gap-1.5">
        <div className="min-w-0 flex-1">
          {primary}
          {hint && <p className={cn("text-center text-[11px] text-slate-400", primary ? "mt-1" : "py-2")}>{hint}</p>}
        </div>
        {!multi && menu}
      </div>
      {((planned && links.length === 1) || bestAgain) && (
        <div className="mt-1 flex flex-wrap items-center justify-between gap-x-2 text-[10px] text-slate-500">
          {planned && links.length === 1 ? (
            linksNote(t("Opens Google Maps in a new tab; times there are Google's own."))
          ) : (
            <span />
          )}
          {bestAgain && (
            <Button size="xs" variant="ghost" className="text-solar-200" disabled={!d.canSolve || d.solving} onClick={() => void d.solve(false)}>
              <Sparkles data-icon="inline-start" />
              {t("Best order again")}
            </Button>
          )}
        </div>
      )}
      {d.full && d.tab === "plants" && <p className="mt-0.5 text-center text-[11px] text-amber-300">{t("At most {n} stops a day: split the day", { n: MAX_STOPS })}</p>}
    </div>
  );
};
