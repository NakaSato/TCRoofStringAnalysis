/* The Route tab's itinerary (docs/plans/site-visit-route.md §9.3): the start, then each stop as a
   two-line row (sequence, name, district; arrive–leave, time on site, window, its own flags) with the
   drive between rows, then the way back. Click a row = edit it inline (time on site, arrival window,
   remove) and select it on the map; an invalid entry keeps the row open. Reorder by dragging (mouse)
   or the ⋮ menu. Times are modelled (drive estimates + entered times on site). */
import React, { useEffect, useRef, useState } from "react";
import { ArrowDown, ArrowUp, Clock, GripVertical, Home, MoreVertical, Moon, Plus, Timer, Trash2, Undo2 } from "lucide-react";
import type { RouteLegSource, RouteSolveResponse, RouteStopOut } from "../../api/client";
import { useI18n } from "../../i18n";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ReasonBadges } from "./ReasonBadges";
import { SERVICE_MIN_MAX, fmtClock, fmtDuration, fmtKm, fmtSpan } from "./format";
import { startSummary } from "./StartPicker";
import { serviceValue, windowValue, type StopDraft, type VisitRoute } from "./useVisitRoute";

/** Left column (sequence badge, start / return glyph, leg line), the same width in every row. */
const RAIL = "flex w-6 shrink-0 justify-center";

const Flag: React.FC<{ tone: "crit" | "warn"; icon: React.ElementType; label: string; why: string }> = ({ tone, icon: Icon, label, why }) => (
  <Tooltip>
    <TooltipTrigger asChild>
      <Badge variant={tone} tabIndex={0} className="cursor-default">
        <Icon className="size-3" aria-hidden />
        {label}
      </Badge>
    </TooltipTrigger>
    <TooltipContent className="max-w-64">{why}</TooltipContent>
  </Tooltip>
);

/** The drive between two rows: a dashed rail and "58 km · 50 min" (amber "straight line" when the
 * leg is not a road estimate). `null` km = no plan yet: a plain spacer. */
const Leg: React.FC<{ km: number | null; min: number | null; source: RouteLegSource | null; planned: boolean; children?: React.ReactNode }> = ({
  km,
  min,
  source,
  planned,
  children,
}) => {
  const { t } = useI18n();
  return (
    <div className="flex items-stretch gap-2 pl-1" aria-hidden={!planned || undefined}>
      <span className={RAIL}>
        <span className={cn("w-0 border-l border-white/15", source === "straight_line" ? "border-dashed border-amber-300/40" : "border-dotted")} />
      </span>
      {planned ? (
        <div className="flex flex-wrap items-center gap-x-1.5 py-1 text-[11px] text-slate-400">
          <span className="num">{fmtKm(km)}</span>
          <span aria-hidden>·</span>
          <span className="num">{fmtDuration(min)}</span>
          {source === "straight_line" && <span className="text-amber-300/90">{t("straight line")}</span>}
          {children}
        </div>
      ) : (
        <div className="h-2" />
      )}
    </div>
  );
};

const basisHint = (s: StopDraft): string =>
  s.basis === "cleaning_crew_days" ? "From the plant's cleaning crew-days" : s.basis === "default" ? "Default time: no task type behind it" : "From the task type";

const StopRow: React.FC<{
  s: StopDraft;
  i: number;
  count: number;
  out: RouteStopOut | null;
  latest: string | null;
  dim: boolean;
  selected: boolean;
  open: boolean;
  dragOver: boolean;
  d: VisitRoute;
  onToggle: () => void;
  onDragStart: (e: React.DragEvent, i: number) => void;
  onDragEnd: () => void;
  onDragOver: (e: React.DragEvent, i: number) => void;
  onDrop: (e: React.DragEvent, i: number) => void;
}> = ({ s, i, count, out, latest, dim, selected, open, dragOver, d, onToggle, onDragStart, onDragEnd, onDragOver, onDrop }) => {
  const { t } = useI18n();
  const ref = useRef<HTMLLIElement>(null);
  const reasons = d.candById.get(s.plant_id)?.reasons;
  const service = serviceValue(s);
  const win = windowValue(s);
  const invalid = service == null || win === "invalid";
  const expanded = open || invalid;
  // selected on the map: bring the row into view
  useEffect(() => {
    if (selected) ref.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [selected]);

  return (
    <li
      ref={ref}
      data-stop={s.plant_id}
      onDragOver={(e) => onDragOver(e, i)}
      onDrop={(e) => onDrop(e, i)}
      className={cn(
        "group rounded-lg border transition-colors",
        invalid
          ? "border-red-400/50 bg-red-500/[0.04]"
          : selected
            ? "border-solar-400/40 bg-solar-500/[0.07]"
            : "border-transparent hover:border-white/10 hover:bg-white/[0.02]",
        dragOver && "border-dashed border-solar-300/60"
      )}
    >
      <div className="flex items-start gap-2 py-1.5 pr-1 pl-1">
        <span className={cn(RAIL, "relative pt-0.5")}>
          <span
            className={cn(
              "num flex size-6 items-center justify-center rounded-full text-[11px] font-bold",
              !out
                ? "border border-dashed border-sky-400/60 text-sky-200"
                : out.after_sunset || out.after_latest || out.late_min > 0
                  ? "bg-amber-500 text-ink-950"
                  : "bg-sky-500 text-white"
            )}
          >
            {i + 1}
          </span>
        </span>
        <button type="button" onClick={onToggle} aria-expanded={expanded} className="min-w-0 flex-1 text-left">
          <div className="flex items-baseline gap-2">
            <span className="truncate text-xs font-semibold text-slate-100" title={s.name}>
              {s.name}
            </span>
            <span className="shrink-0 text-[11px] text-muted-foreground">{s.city ?? "—"}</span>
          </div>
          <div className={cn("mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-slate-400 transition-opacity", dim && "opacity-50")}>
            <span className="num font-medium text-slate-200">{out ? fmtSpan(out.eta, out.etd) : "—"}</span>
            <span className="num">{service != null ? t("{m} min on site", { m: service }) : t("Time on site?")}</span>
            {win && win !== "invalid" && (
              <span className="num inline-flex items-center gap-0.5 text-sky-300">
                <Clock className="size-3" aria-hidden />
                {win.open}–{win.close}
              </span>
            )}
            {out && out.wait_min > 0 && <span>{t("Wait {d}", { d: fmtDuration(out.wait_min) })}</span>}
          </div>
        </button>
        <div className="flex shrink-0 items-center gap-1 pt-0.5">
          {out?.after_sunset && (
            <Flag
              tone="crit"
              icon={Moon}
              label={t("Sunset")}
              why={t("Work ends {etd}; sunset at the plant {sunset} (modelled).", { etd: fmtClock(out.etd), sunset: fmtClock(out.sunset) })}
            />
          )}
          {out?.after_latest && !out.after_sunset && (
            <Flag tone="warn" icon={Timer} label={t("Late")} why={t("Work ends {etd}, after the latest finish {latest}.", { etd: fmtClock(out.etd), latest: fmtClock(latest) })} />
          )}
          {out && out.late_min > 0 && (
            <Flag
              tone="crit"
              icon={Clock}
              label={t("Window")}
              why={t("Arrives {d} after the window closes ({close}).", { d: fmtDuration(out.late_min), close: out.window?.close ?? "—" })}
            />
          )}
          <span
            draggable
            onDragStart={(e) => onDragStart(e, i)}
            onDragEnd={onDragEnd}
            className="cursor-grab px-0.5 text-slate-600 opacity-0 group-hover:opacity-100 hover:text-slate-300 active:cursor-grabbing pointer-coarse:hidden"
            title={t("Drag to reorder")}
            aria-hidden
          >
            <GripVertical className="size-4" />
          </span>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon-xs" aria-label={t("Stop actions")}>
                <MoreVertical />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem disabled={i === 0} onSelect={() => d.moveStop(i, i - 1)}>
                <ArrowUp />
                {t("Move up")}
              </DropdownMenuItem>
              <DropdownMenuItem disabled={i === count - 1} onSelect={() => d.moveStop(i, i + 1)}>
                <ArrowDown />
                {t("Move down")}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" onSelect={() => d.removeStop(s.plant_id)}>
                <Trash2 />
                {t("Remove stop")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {expanded && (
        <div className="flex flex-col gap-2 border-t border-white/[0.06] py-2 pr-2 pl-9 text-[11px]">
          {reasons && reasons.length > 0 && <ReasonBadges reasons={reasons} max={4} />}
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
            <label className="flex items-center gap-1.5 text-slate-400">
              {t("Time on site")}
              <Input
                type="number"
                inputMode="numeric"
                min={0}
                max={SERVICE_MIN_MAX}
                step={5}
                value={s.service}
                onChange={(e) => d.patchStop(s.plant_id, { service: e.target.value })}
                aria-invalid={service == null || undefined}
                className="num h-7 w-[4.5rem] px-2 text-xs"
              />
              {t("min")}
            </label>
            <span className="text-slate-500">{t(basisHint(s))}</span>
          </div>
          {s.windowOn ? (
            <span className="flex flex-wrap items-center gap-1 text-slate-400">
              {t("Arrive between")}
              <Input
                type="time"
                value={s.open}
                onChange={(e) => d.patchStop(s.plant_id, { open: e.target.value })}
                aria-label={t("Window opens")}
                aria-invalid={win === "invalid" || undefined}
                className="num h-7 w-[6.5rem] px-2 text-xs"
              />
              –
              <Input
                type="time"
                value={s.close}
                onChange={(e) => d.patchStop(s.plant_id, { close: e.target.value })}
                aria-label={t("Window closes")}
                aria-invalid={win === "invalid" || undefined}
                className="num h-7 w-[6.5rem] px-2 text-xs"
              />
              <Button variant="ghost" size="icon-xs" onClick={() => d.patchStop(s.plant_id, { windowOn: false })} aria-label={t("No arrival window")}>
                <Undo2 />
              </Button>
            </span>
          ) : (
            <div>
              <Button variant="ghost" size="xs" onClick={() => d.patchStop(s.plant_id, { windowOn: true })}>
                <Clock data-icon="inline-start" />
                {t("Arrival window")}
              </Button>
            </div>
          )}
          {service == null && <span className="text-red-300">{t("Enter 0–{max} minutes", { max: SERVICE_MIN_MAX })}</span>}
          {win === "invalid" && <span className="text-red-300">{t("Enter both times; the window closes after it opens")}</span>}
          <div>
            <Button variant="ghost" size="xs" className="text-red-300" onClick={() => d.removeStop(s.plant_id)}>
              <Trash2 data-icon="inline-start" />
              {t("Remove stop")}
            </Button>
          </div>
        </div>
      )}
    </li>
  );
};

export const StopList: React.FC<{
  d: VisitRoute;
  selectedPlantId: number | null;
  onSelect: (plantId: number) => void;
  /** "Add plants to visit" in the empty state */
  onAddPlants: () => void;
}> = ({ d, selectedPlantId, onSelect, onAddPlants }) => {
  const { t } = useI18n();
  const [drag, setDrag] = useState<number | null>(null);
  const [over, setOver] = useState<number | null>(null);
  const [openId, setOpenId] = useState<number | null>(null);
  const res: RouteSolveResponse | null = d.sameSet ? d.answer : null;
  const outById = new Map((res?.stops ?? []).map((s) => [s.plant_id, s]));
  const dim = d.pending || d.solving;
  const showLegs = d.sameOrder && res != null;
  const start = d.start ? startSummary(d.start, t) : null;

  if (d.stops.length === 0) {
    return (
      <div className="m-3 flex flex-col items-center gap-2 rounded-lg border border-dashed border-white/10 px-3 py-6 text-center">
        <p className="text-xs text-muted-foreground">{t("No stops yet. Add plants from the list or on the map.")}</p>
        <Button size="sm" variant="outline" onClick={onAddPlants}>
          <Plus data-icon="inline-start" />
          {t("Add plants to visit")}
        </Button>
      </div>
    );
  }

  return (
    <div className="px-2 py-2">
      {/* start */}
      <div className="flex items-center gap-2 py-1 pl-1">
        <span className={RAIL}>
          <span className="flex size-6 items-center justify-center rounded-full bg-emerald-500/20 text-emerald-200">
            <Home className="size-3.5" aria-hidden />
          </span>
        </span>
        <div className="flex min-w-0 flex-1 items-baseline gap-2">
          <span className={cn("truncate text-xs font-semibold", start ? "text-slate-100" : "text-amber-300")}>{start ? start.text : t("No start yet")}</span>
          <span className="num shrink-0 text-[11px] text-slate-400">{t("Leave {time}", { time: res?.totals.leave_at ?? (d.leaveAt || "—") })}</span>
        </div>
      </div>

      <ol aria-label={t("Stops")}>
        {d.stops.map((s, i) => {
          const out = outById.get(s.plant_id) ?? null;
          return (
            <React.Fragment key={s.plant_id}>
              <Leg km={out?.leg_km ?? null} min={out?.leg_min ?? null} source={out?.leg_source ?? null} planned={showLegs && out != null} />
              <StopRow
                s={s}
                i={i}
                count={d.stops.length}
                out={out}
                latest={res?.latest_finish ?? d.latestFinish}
                dim={dim}
                selected={selectedPlantId === s.plant_id}
                open={openId === s.plant_id}
                dragOver={drag != null && over === i && drag !== i}
                d={d}
                onToggle={() => {
                  setOpenId((o) => (o === s.plant_id ? null : s.plant_id));
                  onSelect(s.plant_id);
                }}
                onDragStart={(e, idx) => {
                  setDrag(idx);
                  e.dataTransfer.effectAllowed = "move";
                  e.dataTransfer.setData("text/plain", String(idx));
                  const row = (e.currentTarget as HTMLElement).closest("li");
                  if (row) e.dataTransfer.setDragImage(row, 24, 16);
                }}
                onDragEnd={() => {
                  setDrag(null);
                  setOver(null);
                }}
                onDragOver={(e, idx) => {
                  if (drag == null) return;
                  e.preventDefault();
                  e.dataTransfer.dropEffect = "move";
                  if (over !== idx) setOver(idx);
                }}
                onDrop={(e, idx) => {
                  e.preventDefault();
                  if (drag != null) d.moveStop(drag, idx);
                  setDrag(null);
                  setOver(null);
                }}
              />
            </React.Fragment>
          );
        })}
      </ol>

      {/* the end of the day: back at the start, or the last stop (its day warnings are in the summary) */}
      {d.endMode === "return" ? (
        <>
          <Leg km={res?.return_leg?.leg_km ?? null} min={res?.return_leg?.leg_min ?? null} source={res?.return_leg?.leg_source ?? null} planned={showLegs && !!res?.return_leg} />
          <div className="flex items-center gap-2 py-1 pl-1">
            <span className={RAIL}>
              <span className="flex size-6 items-center justify-center rounded-full bg-emerald-500/20 text-emerald-200">
                <Home className="size-3.5" aria-hidden />
              </span>
            </span>
            <div className="flex min-w-0 flex-1 items-baseline gap-2 text-[11px] text-slate-400">
              <span className="text-xs font-semibold text-slate-200">{t("Back at the start")}</span>
              <span className={cn("num font-medium", res?.return_leg?.after_latest ? "text-amber-300" : "text-slate-200")}>
                {showLegs && res?.return_leg ? fmtClock(res.return_leg.eta) : "—"}
              </span>
            </div>
          </div>
        </>
      ) : (
        <p className="py-2 pl-10 text-[11px] text-slate-500">{t("Ends at the last stop")}</p>
      )}
    </div>
  );
};
