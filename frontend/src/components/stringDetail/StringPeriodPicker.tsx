/**
 * shadcn date (range) + time picker: ‹ [date · time] › Latest. Used by the string detail (drawer
 * and page) and the Plant Overview power chart. The popover holds a range calendar (two months
 * from `sm` up, ≤ MAX_RANGE_DAYS), quick ranges and From / To time fields (a time-of-day window on
 * every day); nothing changes until Apply. ‹ › move by the period's length.
 */
import React, { useEffect, useId, useState } from "react";
import type { DateRange } from "react-day-picker";
import { CalendarIcon, ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ButtonGroup } from "@/components/ui/button-group";
import { Calendar } from "@/components/ui/calendar";
import { Field, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Separator } from "@/components/ui/separator";
import { dayLabel, fromDate, toDate } from "@/lib/day";
import { MAX_RANGE_DAYS, daysBetween, isRange, periodDayText, rangeDays, shiftDay, windowText } from "./period";
import type { StringPeriod } from "./period";

const QUICK = [
  { label: "Today", back: 0, days: 1 },
  { label: "Yesterday", back: 1, days: 1 },
  { label: "Last 7 days", back: 0, days: 7 },
  { label: "Last 30 days", back: 0, days: 30 },
] as const;

/** first month shown: with two months, the picked day's month stays visible and never shows a future month */
const calMonth = (day: string, today: string, months: number) => {
  const d = toDate(day);
  if (months > 1 && day.slice(0, 7) === today.slice(0, 7)) d.setMonth(d.getMonth() - 1);
  return d;
};

export const StringPeriodPicker: React.FC<{
  period: StringPeriod;
  onChange: (p: StringPeriod) => void;
  /** the day(s) the loaded data covers (labels the newest day before one is picked) */
  shownDay: string | null;
  shownEndDay?: string | null;
  today: string;
  loading?: boolean;
  /** the popover opened / closed (the drawer pauses its arrow-key shortcuts meanwhile) */
  onPopoverOpenChange?: (open: boolean) => void;
  /** a line under the time fields, e.g. "Or drag across the chart." */
  hint?: string;
  /** show the From / To time fields (default true); without them Apply picks whole days */
  time?: boolean;
  /** popover edge aligned to the trigger: "end" when the picker sits at the right of its row */
  align?: "start" | "end";
}> = ({ period, onChange, shownDay, shownEndDay, today, loading, onPopoverOpenChange, hint, time = true, align = "start" }) => {
  const uid = useId();
  const [open, setOpen] = useState(false);
  useEffect(() => onPopoverOpenChange?.(open), [open, onPopoverOpenChange]);
  const [range, setRange] = useState<DateRange | undefined>();
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [months, setMonths] = useState(1);

  const first = period.day ?? shownDay;
  const shownLast = !period.day && shownEndDay && shownEndDay !== shownDay ? shownEndDay : null;
  const last = isRange(period) ? period.endDay : shownLast;
  const span = rangeDays(period);
  const win = windowText(period);
  const label = first ? `${periodDayText(first, last, today)}${win ? ` · ${win}` : ""}` : "Pick a date";

  const openChange = (o: boolean) => {
    setOpen(o);
    if (!o) return;
    setRange(first ? { from: toDate(first), to: toDate(last ?? first) } : undefined);
    setFrom(period.start);
    setTo(period.end);
    setMonths(window.matchMedia("(min-width: 640px)").matches ? 2 : 1);
  };

  const move = (dir: 1 | -1) => {
    if (!first) return;
    const day = shiftDay(first, dir * span);
    onChange({
      ...period,
      day,
      endDay: span > 1 ? shiftDay(day, span - 1) : null,
    });
  };
  const canNext = Boolean((last ?? first) && (last ?? first)! < today);

  const badTime = Boolean(from && to && from > to);
  const picked = range?.from ? (range.to ? daysBetween(fromDate(range.from), fromDate(range.to)) + 1 : 1) : 0;
  const apply = () => {
    if (!range?.from || badTime) return;
    const day = fromDate(range.from);
    const end = range.to ? fromDate(range.to) : null;
    onChange({
      day,
      endDay: end && end !== day ? end : null,
      start: time ? from : "",
      end: time ? to : "",
    });
    setOpen(false);
  };
  const quick = (back: number, days: number) => {
    const end = shiftDay(today, -back);
    setRange({ from: toDate(shiftDay(end, -(days - 1))), to: toDate(end) });
  };

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
        <Popover open={open} onOpenChange={openChange}>
          <PopoverTrigger asChild>
            <Button
              variant="outline"
              size="sm"
              data-empty={!first}
              className="num justify-start font-normal data-[empty=true]:text-muted-foreground"
              aria-label="Period shown"
              title={first ? (last ? `${dayLabel(first)} – ${dayLabel(last)} (${span} days)` : dayLabel(first)) : undefined}
            >
              <CalendarIcon data-icon="inline-start" />
              {label}
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-auto p-0" align={align}>
            <Calendar
              mode="range"
              numberOfMonths={months}
              defaultMonth={calMonth(first ?? today, today, months)}
              selected={range}
              max={MAX_RANGE_DAYS - 1}
              disabled={{ after: toDate(today) }}
              onSelect={(r, clicked) => {
                // a finished multi-day range: the next click starts a new pick
                const done = range?.from && range.to && fromDate(range.from) !== fromDate(range.to);
                setRange(done ? { from: clicked, to: undefined } : r);
              }}
            />
            <Separator />
            <div className="flex flex-col gap-3 p-3">
              <div className="flex flex-wrap gap-1">
                {QUICK.map((q) => (
                  <Button key={q.label} variant="outline" size="xs" onClick={() => quick(q.back, q.days)}>
                    {q.label}
                  </Button>
                ))}
              </div>
              {time && (
                <FieldGroup className="flex-row gap-3">
                  <Field data-invalid={badTime}>
                    <FieldLabel htmlFor={`${uid}-from`}>From</FieldLabel>
                    <Input
                      id={`${uid}-from`}
                      type="time"
                      step={300}
                      value={from}
                      onChange={(e) => setFrom(e.target.value)}
                      aria-invalid={badTime}
                      className="appearance-none [&::-webkit-calendar-picker-indicator]:hidden"
                    />
                  </Field>
                  <Field data-invalid={badTime}>
                    <FieldLabel htmlFor={`${uid}-to`}>To</FieldLabel>
                    <Input
                      id={`${uid}-to`}
                      type="time"
                      step={300}
                      value={to}
                      onChange={(e) => setTo(e.target.value)}
                      aria-invalid={badTime}
                      className="appearance-none [&::-webkit-calendar-picker-indicator]:hidden"
                    />
                  </Field>
                </FieldGroup>
              )}
              {time && badTime && <FieldError>“From” is after “To”.</FieldError>}
              {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
              <div className="flex items-center justify-between gap-2">
                <span className="num text-xs text-muted-foreground">
                  {picked ? `${picked} day${picked === 1 ? "" : "s"}` : "Pick a day or a range"}
                  {!time ? "" : from || to ? ` · ${from || "00:00"}–${to || "24:00"}` : " · all day"}
                </span>
                <div className="flex gap-2">
                  {time && (
                    <Button variant="ghost" size="sm" onClick={() => (setFrom(""), setTo(""))} disabled={!from && !to}>
                      All day
                    </Button>
                  )}
                  <Button size="sm" onClick={apply} disabled={!range?.from || (time && badTime)}>
                    Apply
                  </Button>
                </div>
              </div>
            </div>
          </PopoverContent>
        </Popover>
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
      </ButtonGroup>
      {(period.day != null || win) && (
        <Button variant="ghost" size="sm" onClick={() => onChange({ day: null, endDay: null, start: "", end: "" })} title="The newest stored day, all day">
          Latest
        </Button>
      )}
    </div>
  );
};
