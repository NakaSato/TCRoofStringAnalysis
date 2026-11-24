/* The "Plants to visit" tab: plants that need a visit on the day (Calendar tasks of the team / person,
   issues, fault alarms, claims, cleaning / PM due), grouped by their most urgent reason, with an add
   button each and "Add all" per group (up to the 25-stop cap). A plant without a location in Growatt is
   listed but can't be added. The search at the top = the fleet picker (any plant). */
import React, { useEffect, useMemo, useRef, useState } from "react";
import { Check, ListPlus, Plus, RefreshCw, Search } from "lucide-react";
import type { RouteCandidate, RouteReasonKind } from "../../api/client";
import { useI18n } from "../../i18n";
import { cn } from "@/lib/utils";
import { SkeletonRows, fmtInt } from "../../components/ui";
import { Button } from "@/components/ui/button";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { FleetPicker } from "./FleetPicker";
import { ReasonBadges } from "./ReasonBadges";
import { REASON_LABEL, sortReasons } from "./mapUtils";
import { MAX_STOPS, REASON_KINDS, hasLocation } from "./format";
import type { VisitRoute } from "./useVisitRoute";

type Filter = "all" | RouteReasonKind;

const topKind = (c: RouteCandidate): RouteReasonKind | null =>
  (sortReasons(c.reasons.map((r) => r.kind))[0] as RouteReasonKind | undefined) ?? null;

const CandidateRow: React.FC<{
  c: RouteCandidate;
  inRoute: boolean;
  full: boolean;
  selected: boolean;
  onAdd: () => void;
  onRemove: () => void;
  onSelect: () => void;
}> = ({ c, inRoute, full, selected, onAdd, onRemove, onSelect }) => {
  const { t } = useI18n();
  const ref = useRef<HTMLLIElement>(null);
  const located = c.has_location && hasLocation(c.lat, c.lon);
  useEffect(() => {
    if (selected) ref.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [selected]);
  const add = (
    <Button
      variant={inRoute ? "ghost" : "outline"}
      size="icon-sm"
      disabled={!located || (!inRoute && full)}
      onClick={inRoute ? onRemove : onAdd}
      aria-label={inRoute ? t("Remove from route") : t("Add to route")}
      className={cn(inRoute && "text-emerald-300")}
    >
      {inRoute ? <Check /> : <Plus />}
    </Button>
  );
  return (
    <li
      ref={ref}
      className={cn(
        "flex items-start gap-2 px-3 py-2 transition-colors",
        selected ? "bg-solar-500/10 ring-1 ring-solar-400/30 ring-inset" : "hover:bg-white/[0.03]",
        !located && "opacity-70"
      )}
    >
      <button type="button" className="min-w-0 flex-1 text-left" onClick={onSelect} disabled={!located}>
        <div className="flex items-baseline gap-2">
          <span className="truncate text-xs font-semibold text-slate-100">{c.name}</span>
          <span className="shrink-0 text-[11px] text-muted-foreground">{c.city ?? "—"}</span>
        </div>
        <div className="mt-1">
          <ReasonBadges reasons={c.reasons} />
        </div>
        {!located && <div className="mt-1 text-[11px] text-amber-300">{t("No location in Growatt, can't be routed")}</div>}
      </button>
      {!inRoute && full && located ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <span tabIndex={0}>{add}</span>
          </TooltipTrigger>
          <TooltipContent>{t("At most {n} stops a day: split the day", { n: MAX_STOPS })}</TooltipContent>
        </Tooltip>
      ) : (
        add
      )}
    </li>
  );
};

export const CandidatesPanel: React.FC<{
  d: VisitRoute;
  selectedPlantId: number | null;
  onSelect: (plantId: number) => void;
  /** add plants as stops (the page says what was added) */
  onAdd: (plantIds: number[]) => void;
}> = ({ d, selectedPlantId, onSelect, onAdd }) => {
  const { t } = useI18n();
  const [filter, setFilter] = useState<Filter>("all");
  const list = useMemo(() => [...(d.cands?.candidates ?? [])].sort((a, b) => a.rank - b.rank), [d.cands]);
  const counts = d.cands?.counts ?? {};
  const kinds = REASON_KINDS.filter((k) => (counts[k] ?? 0) > 0);

  const groups = useMemo(() => {
    if (filter !== "all") return [{ kind: filter as RouteReasonKind | null, rows: list.filter((c) => c.reasons.some((r) => r.kind === filter)) }];
    const by = new Map<RouteReasonKind | null, RouteCandidate[]>();
    for (const c of list) {
      const k = topKind(c);
      by.set(k, [...(by.get(k) ?? []), c]);
    }
    return [...REASON_KINDS, null].filter((k) => by.has(k)).map((k) => ({ kind: k, rows: by.get(k)! }));
  }, [list, filter]);

  /** rows of a group that can still be added */
  const addable = (rows: RouteCandidate[]) => rows.filter((c) => !d.inRoute.has(c.plant_id) && c.has_location && hasLocation(c.lat, c.lon));

  return (
    <div className="flex flex-col">
      <div className="flex flex-col gap-2 border-b border-white/[0.06] px-3 py-2">
        <FleetPicker
          plants={d.growattPlants}
          takenIds={d.inRoute}
          disabled={d.full}
          ariaLabel={t("Add any plant")}
          className="w-full justify-between text-muted-foreground"
          label={
            <span className="inline-flex items-center gap-1.5">
              <Search className="size-3.5" aria-hidden />
              {t("Add any plant: search the fleet…")}
            </span>
          }
          onPick={(id) => onAdd([id])}
        />
        {kinds.length > 0 && (
          <ToggleGroup
            type="single"
            size="xs"
            spacing={1}
            className="flex-wrap"
            aria-label={t("Reason")}
            value={filter}
            onValueChange={(v) => setFilter((v || "all") as Filter)}
          >
            <ToggleGroupItem value="all">
              {t("All")} <span className="num opacity-70">{fmtInt(list.length)}</span>
            </ToggleGroupItem>
            {kinds.map((k) => (
              <ToggleGroupItem key={k} value={k}>
                {t(REASON_LABEL[k] ?? k)} <span className="num opacity-70">{fmtInt(counts[k])}</span>
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        )}
      </div>
      {d.candLoading && !d.cands ? (
        <SkeletonRows rows={5} className="p-3" />
      ) : d.candError && !d.cands ? (
        <div className="flex flex-col items-start gap-2 p-3">
          <p className="callout-crit rounded-md px-2.5 py-1.5 text-[11px]">{t("Could not load the plants to visit: {error}", { error: d.candError })}</p>
          <Button size="xs" variant="outline" onClick={d.reloadCandidates}>
            <RefreshCw data-icon="inline-start" />
            {t("Try again")}
          </Button>
        </div>
      ) : list.length === 0 ? (
        <p className="p-3 text-xs text-muted-foreground">{t("Nothing calls for a visit on this day. Add plants with the search above.")}</p>
      ) : (
        groups.map((g) => {
          const free = addable(g.rows);
          return (
            <section key={g.kind ?? "other"}>
              <h3 className="flex items-center gap-2 border-b border-white/[0.04] bg-ink-900/95 py-1 pr-2 pl-3 text-[10px] font-semibold tracking-wide text-slate-500 uppercase backdrop-blur lg:sticky lg:top-0 lg:z-10">
                <span className="min-w-0 flex-1 truncate">
                  {filter === "all" ? (g.kind ? t(REASON_LABEL[g.kind] ?? g.kind) : t("Other")) : t(REASON_LABEL[filter] ?? filter)} ·{" "}
                  <span className="num">{fmtInt(g.rows.length)}</span>
                </span>
                {free.length > 1 && (
                  <Button
                    size="xs"
                    variant="ghost"
                    className="h-6 normal-case tracking-normal"
                    disabled={d.full}
                    onClick={() => onAdd(free.map((c) => c.plant_id))}
                  >
                    <ListPlus data-icon="inline-start" />
                    {t("Add all {n}", { n: fmtInt(free.length) })}
                  </Button>
                )}
              </h3>
              <ul className="divide-y divide-white/[0.04]">
                {g.rows.map((c) => (
                  <CandidateRow
                    key={c.plant_id}
                    c={c}
                    inRoute={d.inRoute.has(c.plant_id)}
                    full={d.full}
                    selected={selectedPlantId === c.plant_id}
                    onAdd={() => onAdd([c.plant_id])}
                    onRemove={() => d.removeStop(c.plant_id)}
                    onSelect={() => onSelect(c.plant_id)}
                  />
                ))}
              </ul>
            </section>
          );
        })
      )}
    </div>
  );
};
