/**
 * Day / day-range / time-of-day picker for a string detail: ‹ date › · clock, plus "Latest".
 * The date dialog is one range calendar: one day, or a first and last day (≤ MAX_RANGE_DAYS), then Apply;
 * ‹ › move by the period's length.
 */
import React, { useEffect, useState } from "react";
import type { DateRange } from "react-day-picker";
import { CalendarDays, ChevronLeft, ChevronRight, Clock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ButtonGroup } from "@/components/ui/button-group";
import { Calendar } from "@/components/ui/calendar";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { dayLabel, fromDate, toDate } from "@/lib/day";
import {
  MAX_RANGE_DAYS,
  WINDOW_PRESETS,
  daysBetween,
  isRange,
  isWindowBad,
  isWindowed,
  periodDayText,
  rangeDays,
  shiftDay,
  windowText,
} from "./period";
import type { StringPeriod } from "./period";

export const StringPeriodPicker: React.FC<{
  period: StringPeriod;
  onChange: (p: StringPeriod) => void;
  /** the day(s) the loaded detail covers (labels the newest day before one is picked) */
  shownDay: string | null;
  shownEndDay?: string | null;
  today: string;
  loading?: boolean;
  /** the date dialog or time popover opened / closed (the drawer pauses its arrow-key shortcuts meanwhile) */
  onPopoverOpenChange?: (open: boolean) => void;
}> = ({ period, onChange, shownDay, shownEndDay, today, loading, onPopoverOpenChange }) => {
  const [dateOpen, setDateOpen] = useState(false);
  const [timeOpen, setTimeOpen] = useState(false);
  const [draft, setDraft] = useState<DateRange | undefined>(undefined);
  useEffect(() => onPopoverOpenChange?.(dateOpen || timeOpen), [dateOpen, timeOpen, onPopoverOpenChange]);

  const first = period.day ?? shownDay;
  const last = isRange(period) ? period.endDay : period.day ? null : (shownEndDay ?? null);
  const span = rangeDays(period);
  const winText = windowText(period);

  const move = (dir: 1 | -1) => {
    if (!first) return;
    const day = shiftDay(first, dir * span);
    onChange({ ...period, day, endDay: span > 1 ? shiftDay(day, span - 1) : null });
  };
  const lastShown = last ?? first;
  const canNext = Boolean(lastShown && lastShown < today);

  const openDate = (open: boolean) => {
    setDateOpen(open);
    if (open) {
      setDraft(first ? { from: toDate(first), to: last ? toDate(last) : undefined } : undefined);
    }
  };
  const draftDays = draft?.from && draft.to ? daysBetween(fromDate(draft.from), fromDate(draft.to)) + 1 : draft?.from ? 1 : 0;
  const lastN = (n: number) => onChange({ ...period, day: shiftDay(today, -(n - 1)), endDay: today });

  return (
    <div className="flex flex-wrap items-center gap-2">
      <ButtonGroup>
        <Button
          variant="outline"
          size="icon-sm"
          onClick={() => move(-1)}
          disabled={!first || loading}
          aria-label={span > 1 ? `Previous ${span} days` : "Previous day"}
          title={span > 1 ? `Previous ${span} days` : "Previous day"}
        >
          <ChevronLeft />
        </Button>
        <Dialog open={dateOpen} onOpenChange={openDate}>
          <DialogTrigger asChild>
            <Button
              variant="outline"
              size="sm"
              className="num"
              aria-label="Days shown"
              title={first ? (last && last !== first ? `${dayLabel(first)} – ${dayLabel(last)} (${span} days)` : dayLabel(first)) : undefined}
            >
              <CalendarDays data-icon="inline-start" className="h-3.5 w-3.5" />
              {first ? periodDayText(first, last, today) : "Newest day"}
            </Button>
          </DialogTrigger>
          <DialogContent className="w-auto gap-3 sm:max-w-fit">
            <DialogHeader className="items-center text-center">
              <DialogTitle>Days shown</DialogTitle>
              <DialogDescription>Pick a day, or a first and last day (max {MAX_RANGE_DAYS}).</DialogDescription>
            </DialogHeader>
            <div className="flex justify-center">
              <Calendar
                mode="range"
                selected={draft}
                defaultMonth={toDate(first ?? today)}
                max={MAX_RANGE_DAYS - 1}
                disabled={{ after: toDate(today) }}
                onSelect={(range, clicked) => {
                  // a finished multi-day range: the next click starts a new pick
                  const done = draft?.from && draft.to && fromDate(draft.from) !== fromDate(draft.to);
                  setDraft(done ? { from: clicked, to: undefined } : range);
                }}
              />
            </div>
            <div className="flex flex-wrap justify-center gap-1">
              {[7, 14, 30].map((n) => (
                <Button
                  key={n}
                  variant="outline"
                  size="xs"
                  onClick={() => {
                    lastN(n);
                    setDateOpen(false);
                  }}
                >
                  Last {n} days
                </Button>
              ))}
            </div>
            <DialogFooter className="-mx-5 -mb-5 items-center px-5 py-3 sm:flex-col sm:items-center sm:justify-center">
              <span className="num text-slate-400">
                {draftDays ? `${draftDays} day${draftDays === 1 ? "" : "s"} selected` : "Nothing selected"}
              </span>
              <div className="flex gap-2">
                <DialogClose asChild>
                  <Button variant="outline" size="sm">
                    Cancel
                  </Button>
                </DialogClose>
                <Button
                  size="sm"
                  disabled={!draft?.from}
                  onClick={() => {
                    if (!draft?.from) return;
                    const day = fromDate(draft.from);
                    const end = draft.to ? fromDate(draft.to) : null;
                    onChange({ ...period, day, endDay: end && end !== day ? end : null });
                    setDateOpen(false);
                  }}
                >
                  Apply
                </Button>
              </div>
            </DialogFooter>
          </DialogContent>
        </Dialog>
        <Button
          variant="outline"
          size="icon-sm"
          onClick={() => move(1)}
          disabled={!canNext || loading}
          aria-label={span > 1 ? `Next ${span} days` : "Next day"}
          title={span > 1 ? `Next ${span} days` : "Next day"}
        >
          <ChevronRight />
        </Button>
        <Popover open={timeOpen} onOpenChange={setTimeOpen}>
          <PopoverTrigger asChild>
            <Button
              variant="outline"
              size="sm"
              className={`num ${isWindowed(period) ? "border-sky-400/50 text-sky-200" : ""}`}
              aria-label="Time of day"
              title="Time-of-day window"
            >
              <Clock data-icon="inline-start" className="h-3.5 w-3.5" />
              {winText ?? "All day"}
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-64 space-y-3 p-3 text-xs" align="start">
            <div className="font-semibold text-slate-200">Time of day{span > 1 ? ", on every day" : ""}</div>
            <div className="flex items-center gap-2">
              <Input
                type="time"
                step={300}
                className="h-7 text-xs"
                value={period.start}
                onChange={(e) => onChange({ ...period, start: e.target.value })}
                aria-label="From time"
              />
              <span className="text-slate-500">–</span>
              <Input
                type="time"
                step={300}
                className="h-7 text-xs"
                value={period.end}
                onChange={(e) => onChange({ ...period, end: e.target.value })}
                aria-label="To time"
              />
            </div>
            {isWindowBad(period) && <div className="text-red-300">“From” is after “To”.</div>}
            <div className="flex flex-wrap gap-1">
              {WINDOW_PRESETS.map((p) => (
                <Button
                  key={p.label}
                  variant={period.start === p.start && period.end === p.end ? "accent" : "outline"}
                  size="xs"
                  onClick={() => onChange({ ...period, start: p.start, end: p.end })}
                >
                  {p.label}
                </Button>
              ))}
              <Button variant="ghost" size="xs" onClick={() => onChange({ ...period, start: "", end: "" })} disabled={!period.start && !period.end}>
                All day
              </Button>
            </div>
            <p className="text-[11px] text-slate-500">Inclusive 5-min slots. Or drag across the 5-min profile chart.</p>
          </PopoverContent>
        </Popover>
      </ButtonGroup>
      {period.day != null && (
        <Button variant="ghost" size="sm" onClick={() => onChange({ ...period, day: null, endDay: null })} title="The string's newest stored day">
          Latest
        </Button>
      )}
    </div>
  );
};
