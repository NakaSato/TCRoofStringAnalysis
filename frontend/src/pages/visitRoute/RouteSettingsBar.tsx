/* The day's settings above the panel and the map (docs/plans/site-visit-route.md §9.2):
   day, team, person (URL `d`, `team`, `user`: they choose the candidates), the start (a chip opening
   `StartPicker` in a popover), leave → latest finish, and round trip / end at the last stop
   (component state). Desktop: one row, wrapping below xl. Phone: one summary line that opens the
   same fields in a bottom sheet. */
import React from "react";
import { ChevronDown, Crosshair, Home, Pencil, X } from "lucide-react";
import type { RouteEndMode } from "../../api/client";
import { useI18n } from "../../i18n";
import { dayLabel } from "@/lib/day";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { personName } from "../calendar/format";
import { isHhmm } from "./format";
import { StartPicker, startSummary } from "./StartPicker";
import type { VisitRoute } from "./useVisitRoute";

const ALL = "all";
const END_MODES: [RouteEndMode, string][] = [
  ["return", "Round trip"],
  ["last", "End at the last stop"],
];

/* ---------------------------- fields (bar and sheet) ---------------------------- */

const DayField: React.FC<{ d: VisitRoute; id?: string; className?: string }> = ({ d, id, className }) => {
  const { t } = useI18n();
  return (
    <Input
      id={id}
      type="date"
      aria-label={t("Day")}
      value={d.day}
      onChange={(e) => {
        const v = e.target.value;
        if (/^\d{4}-\d{2}-\d{2}$/.test(v)) d.setUrl({ d: v === d.today ? null : v });
      }}
      className={cn("num h-8 text-xs", className)}
    />
  );
};

const TeamSelect: React.FC<{ d: VisitRoute; className?: string }> = ({ d, className }) => {
  const { t } = useI18n();
  const teams = d.people?.teams ?? [];
  return (
    <Select value={d.teamId != null ? String(d.teamId) : ALL} onValueChange={(v) => d.setUrl({ team: v === ALL ? null : v })}>
      <SelectTrigger size="sm" className={className} aria-label={t("Team")}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={ALL}>{t("All teams")}</SelectItem>
        {d.teamId != null && !teams.some((x) => x.id === d.teamId) && <SelectItem value={String(d.teamId)}>{t("Team {id}", { id: d.teamId })}</SelectItem>}
        {teams.map((x) => (
          <SelectItem key={x.id} value={String(x.id)}>
            {x.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
};

const PersonSelect: React.FC<{ d: VisitRoute; className?: string }> = ({ d, className }) => {
  const { t } = useI18n();
  const users = d.people?.users ?? [];
  return (
    <Select value={d.userId != null ? String(d.userId) : ALL} onValueChange={(v) => d.setUrl({ user: v === ALL ? null : v })}>
      <SelectTrigger size="sm" className={className} aria-label={t("Person")}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={ALL}>{t("Everyone")}</SelectItem>
        {d.userId != null && !users.some((u) => u.id === d.userId) && <SelectItem value={String(d.userId)}>{t("User {id}", { id: d.userId })}</SelectItem>}
        {users.map((u) => (
          <SelectItem key={u.id} value={String(u.id)}>
            {personName(u)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
};

const TimeInput: React.FC<{ id: string; label: string; value: string; onChange: (v: string) => void; className?: string }> = ({
  id,
  label,
  value,
  onChange,
  className,
}) => (
  <Input
    id={id}
    type="time"
    aria-label={label}
    value={value}
    onChange={(e) => onChange(e.target.value)}
    aria-invalid={!isHhmm(value) || undefined}
    className={cn("num h-8 text-xs", className)}
  />
);

const EndModeSelect: React.FC<{ d: VisitRoute; className?: string }> = ({ d, className }) => {
  const { t } = useI18n();
  return (
    <Select value={d.endMode} onValueChange={(v) => d.setEndMode(v as RouteEndMode)}>
      <SelectTrigger size="sm" className={className} aria-label={t("End of the day")}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {END_MODES.map(([v, label]) => (
          <SelectItem key={v} value={v}>
            {t(label)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
};

const Caption: React.FC<{ htmlFor?: string; children: React.ReactNode; className?: string }> = ({ htmlFor, children, className }) => (
  <label htmlFor={htmlFor} className={cn("text-[10px] font-semibold tracking-wide whitespace-nowrap text-slate-500 uppercase", className)}>
    {children}
  </label>
);

const Divider = () => <span className="mx-1 hidden h-5 w-px bg-white/10 xl:block" aria-hidden />;

/* ---------------------------- the bar ---------------------------- */

export const RouteSettingsBar: React.FC<{
  d: VisitRoute;
  picking: boolean;
  setPicking: (on: boolean) => void;
  /** the desktop start popover (opened from the action slot's "Choose a start" too) */
  startOpen: boolean;
  setStartOpen: (open: boolean) => void;
  /** the phone settings sheet */
  sheetOpen: boolean;
  setSheetOpen: (open: boolean) => void;
  /** picking on the map began from the sheet: bring the map into view */
  onPickFromSheet: () => void;
}> = ({ d, picking, setPicking, startOpen, setStartOpen, sheetOpen, setSheetOpen, onPickFromSheet }) => {
  const { t } = useI18n();
  const s = d.start ? startSummary(d.start, t) : null;
  const team = d.teamId != null ? (d.people?.teams.find((x) => x.id === d.teamId)?.name ?? t("Team {id}", { id: d.teamId })) : null;
  const timesOk = isHhmm(d.leaveAt) && isHhmm(d.latestFinish);

  const startChip = picking ? (
    <div className="flex h-8 items-center gap-1.5 rounded-md border border-emerald-400/40 bg-emerald-500/10 pr-1 pl-2.5 text-xs text-emerald-200">
      <Crosshair className="size-3.5" aria-hidden />
      {t("Click the map to set the start")}
      <Button variant="ghost" size="icon-xs" onClick={() => setPicking(false)} aria-label={t("Cancel picking")}>
        <X />
      </Button>
    </div>
  ) : (
    <Popover open={startOpen} onOpenChange={setStartOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className={cn("max-w-48 justify-start", !s && "border-dashed border-amber-400/50 text-amber-200")}
          aria-label={t("Start point")}
        >
          {s ? <s.icon data-icon="inline-start" className="text-solar-300" /> : <Home data-icon="inline-start" />}
          <span className="truncate">{s ? s.text : t("Choose a start")}</span>
          <ChevronDown data-icon="inline-end" className="opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80">
        <div className="text-[10px] font-semibold tracking-wide text-slate-500 uppercase">{t("Start point")}</div>
        <StartPicker d={d} picking={picking} setPicking={setPicking} onDone={() => setStartOpen(false)} />
      </PopoverContent>
    </Popover>
  );

  return (
    <>
      {/* desktop: one row */}
      <div className="hidden flex-wrap items-center gap-x-2 gap-y-2 rounded-xl border border-white/10 bg-ink-900/30 px-3 py-2 lg:flex">
        <DayField d={d} className="w-[8.5rem]" />
        <TeamSelect d={d} className="w-32" />
        <PersonSelect d={d} className="w-36" />
        <Divider />
        {startChip}
        <Divider />
        <div className="flex items-center gap-1" title={`${t("Leave at")} → ${t("Latest finish")}`}>
          <Caption htmlFor="route-leave" className="mr-1">
            {t("Hours")}
          </Caption>
          <TimeInput id="route-leave" label={t("Leave at")} value={d.leaveAt} onChange={d.setLeaveAt} className="w-[5.75rem]" />
          <span className="text-slate-500" aria-hidden>
            →
          </span>
          <TimeInput id="route-latest" label={t("Latest finish")} value={d.latestFinish} onChange={d.setLatestFinish} className="w-[5.75rem]" />
        </div>
        <EndModeSelect d={d} className="w-36" />
      </div>

      {/* phone: one line, the fields in a sheet */}
      <button
        type="button"
        onClick={() => setSheetOpen(true)}
        className="flex w-full items-center gap-2 rounded-xl border border-white/10 bg-ink-900/30 px-3 py-2 text-left lg:hidden"
        aria-label={t("Route settings")}
      >
        <span className="min-w-0 flex-1 truncate text-xs text-slate-300">
          <span className="font-semibold text-slate-100">{dayLabel(d.day)}</span>
          {team && <> · {team}</>}
          {" · "}
          {s ? t("from {name}", { name: s.text }) : <span className="text-amber-300">{t("Choose a start")}</span>}
          {" · "}
          <span className={cn("num", !timesOk && "text-red-300")}>
            {d.leaveAt || "—"}–{d.latestFinish || "—"}
          </span>
          {" · "}
          {t(d.endMode === "return" ? "Round trip" : "End at the last stop")}
        </span>
        <Pencil className="size-3.5 shrink-0 text-slate-400" aria-hidden />
      </button>
      <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
        <SheetContent side="bottom" className="lg:hidden" onOpenAutoFocus={(e) => e.preventDefault()}>
          <SheetHeader>
            <SheetTitle>{t("Route settings")}</SheetTitle>
            <SheetDescription>{t("The day, who it is for, where it starts and the working hours.")}</SheetDescription>
          </SheetHeader>
          <div className="grid grid-cols-2 gap-2">
            <div className="col-span-2 flex flex-col gap-1">
              <Caption htmlFor="route-day-sheet">{t("Day")}</Caption>
              <DayField d={d} id="route-day-sheet" />
            </div>
            <div className="flex min-w-0 flex-col gap-1">
              <Caption>{t("Team")}</Caption>
              <TeamSelect d={d} className="w-full" />
            </div>
            <div className="flex min-w-0 flex-col gap-1">
              <Caption>{t("Person")}</Caption>
              <PersonSelect d={d} className="w-full" />
            </div>
          </div>
          <div className="flex flex-col gap-1">
            <Caption>{t("Start point")}</Caption>
            <StartPicker
              d={d}
              picking={picking}
              setPicking={(on) => {
                setPicking(on);
                if (on) onPickFromSheet();
              }}
              onDone={() => setSheetOpen(false)}
            />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div className="flex flex-col gap-1">
              <Caption htmlFor="route-leave-sheet">{t("Leave at")}</Caption>
              <TimeInput id="route-leave-sheet" label={t("Leave at")} value={d.leaveAt} onChange={d.setLeaveAt} />
            </div>
            <div className="flex flex-col gap-1">
              <Caption htmlFor="route-latest-sheet">{t("Latest finish")}</Caption>
              <TimeInput id="route-latest-sheet" label={t("Latest finish")} value={d.latestFinish} onChange={d.setLatestFinish} />
            </div>
            <div className="col-span-2 flex flex-col gap-1">
              <Caption>{t("End of the day")}</Caption>
              <EndModeSelect d={d} className="w-full" />
            </div>
          </div>
          <SheetFooter>
            <Button size="lg" variant="secondary" onClick={() => setSheetOpen(false)}>
              {t("Done")}
            </Button>
          </SheetFooter>
        </SheetContent>
      </Sheet>
    </>
  );
};
