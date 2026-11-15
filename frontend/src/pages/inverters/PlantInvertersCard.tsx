/**
 * Inverters page, plant card: what the plant's inverters do now (live record, memory only) next to
 * the stored day (DB), and one table comparing them. "Now" and "stored day" are always labelled
 * apart: the stored day can be an earlier day than the live record.
 */
import React from "react";
import { CloudOff, History, Unplug, X } from "lucide-react";
import { Led, fmt } from "../../components/ui";
import { cn } from "@/lib/utils";
import { pick, useUrlState } from "@/lib/useUrlState";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { dayLabel } from "@/lib/day";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  GroupLabel,
  HOT_C,
  KPI_ROW,
  LOW_PCT,
  Stat,
  Unit,
  hhmm,
  invName,
  isSwitchedOff,
  limitPct,
  sumOrNull,
} from "./shared";
import type { LiveState, OverviewInverter, PlantKpis } from "./shared";

export interface PlantInvertersCardProps {
  inverters: OverviewInverter[];
  kpis: PlantKpis;
  /** stored day and its newest record (plant-local) */
  day: string | null;
  dataUntil: string | null;
  /** today's date per the live answer (plant-local), null before it arrives */
  liveDay: string | null;
  /** newest live record time (plant-local) */
  liveAt: string | null;
  liveLoading: boolean;
  liveFailed: boolean;
  /** per-inverter errors of the live answer */
  liveErrors: Record<string, string>;
  states: Map<string, LiveState>;
  pctOfAvg: (i: OverviewInverter) => number | null;
  /** stored day: anomalies + inactive strings per inverter */
  issues: Map<string, number>;
  selectedSn: string | null;
  onSelect: (sn: string) => void;
}

/** Table filter (`?show=`): what each choice keeps. */
const SHOW = ["all", "online", "not_online", "low", "issues"] as const;
type Show = (typeof SHOW)[number];
const SHOW_LABEL: Record<Show, string> = {
  all: "All inverters",
  online: "Normal now",
  not_online: "Waiting / Offline / Fault now",
  low: `Below ${LOW_PCT} % of avg`,
  issues: "With string issues",
};

/** A number of the "now" columns: em dash without a live record. */
const nowKw = (w: number | null | undefined) => fmt(w == null ? null : w / 1000, 1);

export const PlantInvertersCard: React.FC<PlantInvertersCardProps> = ({
  inverters,
  kpis,
  day,
  dataUntil,
  liveDay,
  liveAt,
  liveLoading,
  liveFailed,
  liveErrors,
  states,
  pctOfAvg,
  issues,
  selectedSn,
  onSelect,
}) => {
  // filter in the URL (?q=&show=): search by name / serial, and a state
  const [url, setUrl] = useUrlState();
  const q = url.get("q") ?? "";
  const show = pick(url.get("show"), SHOW, "all");
  const keeps: Record<Show, (i: OverviewInverter) => boolean> = {
    all: () => true,
    online: (i) => {
      const s = states.get(i.device_sn);
      return s?.kind === "live" && s.rec.status === 1;
    },
    not_online: (i) => {
      const s = states.get(i.device_sn);
      return s?.kind !== "waiting" && !(s?.kind === "live" && s.rec.status === 1);
    },
    low: (i) => {
      const p = pctOfAvg(i);
      return p != null && p < LOW_PCT;
    },
    issues: (i) => (issues.get(i.device_sn) ?? 0) > 0,
  };
  const needle = q.trim().toLowerCase();
  const matches = (i: OverviewInverter) =>
    !needle || [i.alias, i.device_sn, i.model, i.datalogger_sn].some((v) => v?.toLowerCase().includes(needle));
  const shown = inverters.filter((i) => matches(i) && keeps[show](i));
  const filtered = needle !== "" || show !== "all";

  const recs = inverters.flatMap((i) => {
    const s = states.get(i.device_sn);
    return s?.kind === "live" ? [s.rec] : [];
  });
  const online = recs.filter((r) => r.status === 1).length;
  const noRecord = (failed: boolean) =>
    liveLoading || liveFailed
      ? []
      : inverters.filter((i) => {
          const s = states.get(i.device_sn);
          return s?.kind === "none" && s.failed === failed;
        });
  const offline = noRecord(false); // Growatt answered: no record today
  const unanswered = noRecord(true); // Growatt refused this inverter: state unknown
  const acNow = sumOrNull(recs.map((r) => r.pac_w));
  const dcNow = sumOrNull(recs.map((r) => r.ppv_w));
  const todayKwh = sumOrNull(recs.map((r) => r.eac_today_kwh));
  const hottest = inverters.reduce<OverviewInverter | null>(
    (m, i) => (i.max_temp_c != null && (m?.max_temp_c == null || i.max_temp_c > m.max_temp_c) ? i : m),
    null
  );
  const behind = day != null && liveDay != null && day < liveDay;
  const dayText = day ? dayLabel(day) : "—";
  const untilText = dataUntil ? hhmm(dataUntil) : null;
  const errorList = Object.entries(liveErrors);

  return (
    <Card className="gap-4">
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2">
          Inverters
          <Badge variant="neutral" className="num">
            {inverters.length}
          </Badge>
        </CardTitle>
        <CardDescription>
          Status and “Now” from each inverter's newest live record · day figures from stored 5-min history of {dayText}
          {untilText ? `, up to ${untilText}` : ""}
        </CardDescription>
      </CardHeader>

      <CardContent className="flex flex-col gap-4">
        {behind && (
          <Alert variant="warn">
            <History />
            <AlertTitle>
              Stored history ends {dayText}
              {untilText ? ` at ${untilText}` : ""}
            </AlertTitle>
            <AlertDescription>
              Live records are from {dayLabel(liveDay!)}. Day figures, charts and string results below are from the stored day until
              the worker stores newer records.
            </AlertDescription>
          </Alert>
        )}
        {liveFailed && (
          <Alert variant="warn">
            <CloudOff />
            <AlertTitle>Live data unavailable</AlertTitle>
            <AlertDescription>Growatt did not answer; status and “Now” show — until the next try. Stored figures are unaffected.</AlertDescription>
          </Alert>
        )}
        {offline.length + unanswered.length > 0 && (
          <Alert>
            <Unplug />
            <AlertTitle>
              {offline.length > 0
                ? `${offline.length} of ${inverters.length} inverters offline: ${offline.map(invName).join(", ")}`
                : `No live answer for ${unanswered.length} of ${inverters.length} inverters: ${unanswered.map(invName).join(", ")}`}
            </AlertTitle>
            <AlertDescription>
              {offline.length > 0 && `Offline = Growatt has no record of ${offline.length === 1 ? "it" : "them"} today, so “Now” shows —.`}
              {offline.length > 0 && unanswered.length > 0 && ` No live answer for ${unanswered.map(invName).join(", ")}.`}
              {errorList.length > 0 && ` ${errorList.map(([k, v]) => `${k}: ${v}`).join(" · ")}`}
            </AlertDescription>
          </Alert>
        )}

        <div className="grid gap-4 xl:grid-cols-2">
          <div className="flex flex-col gap-2">
            <GroupLabel
              title="Now"
              note={liveAt ? `live · newest record ${hhmm(liveAt)}${liveDay && behind ? ` on ${dayLabel(liveDay)}` : ""}` : liveLoading ? "asking Growatt…" : "no live record"}
            />
            <div className={KPI_ROW}>
              <Stat label="Online" hint={recs.length ? `${recs.length} of ${inverters.length} reporting live` : undefined}>
                <span className={cn(recs.length > 0 && online < inverters.length && "text-amber-300")}>{recs.length ? online : "—"}</span>
                <Unit> / {inverters.length}</Unit>
              </Stat>
              <Stat label="AC power">
                {nowKw(acNow)} <Unit>kW</Unit>
              </Stat>
              <Stat label="DC input">
                {nowKw(dcNow)} <Unit>kW</Unit>
              </Stat>
              <Stat label="Energy today" hint="Growatt's day counter">
                {fmt(todayKwh, 1)} <Unit>kWh</Unit>
              </Stat>
            </div>
          </div>
          <div className="flex flex-col gap-2">
            <GroupLabel title="Stored day" note={`${dayText}${untilText ? ` · to ${untilText}` : ""}`} />
            <div className={KPI_ROW}>
              <Stat label="Yield">
                {fmt(kpis.yield_today_kwh, 1)} <Unit>kWh</Unit>
              </Stat>
              <Stat label="Peak AC" hint="plant, 5-min">
                {fmt(kpis.peak_power_kw, 1)} <Unit>kW</Unit>
              </Stat>
              <Stat label="DC→AC efficiency" hint="energy-weighted">
                {fmt(kpis.conversion_efficiency_pct, 2)} <Unit>%</Unit>
              </Stat>
              <Stat label="Max temp" hint={hottest ? invName(hottest) : undefined}>
                <span className={cn(hottest?.max_temp_c != null && hottest.max_temp_c >= HOT_C && "text-amber-300")}>
                  {fmt(hottest?.max_temp_c, 1)}
                </span>{" "}
                <Unit>°C</Unit>
              </Stat>
            </div>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Input
            className="h-8 w-56"
            placeholder="Search inverter name or SN"
            value={q}
            onChange={(e) => setUrl({ q: e.target.value })}
            aria-label="Search inverters"
          />
          <Select value={show} onValueChange={(v) => setUrl({ show: v === "all" ? null : v })}>
            <SelectTrigger size="sm" className="w-52" aria-label="Show">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {SHOW.map((k) => (
                  <SelectItem key={k} value={k}>
                    {SHOW_LABEL[k]} ({inverters.filter(keeps[k]).length})
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
          {filtered && (
            <>
              <span className="num text-[11px] text-muted-foreground">
                {shown.length} of {inverters.length}
              </span>
              <Button variant="ghost" size="sm" onClick={() => setUrl({ q: null, show: null })}>
                <X data-icon="inline-start" />
                Clear
              </Button>
            </>
          )}
        </div>

        <Table containerClassName="table-wrap">
          <TableHeader>
            <TableRow>
              <TableHead rowSpan={2} className="align-bottom">
                Inverter
              </TableHead>
              <TableHead colSpan={4} className="border-l border-white/[0.06] text-slate-300">
                Now · live
              </TableHead>
              <TableHead colSpan={6} className="border-l border-white/[0.06] text-slate-300">
                Stored day · {day ?? "—"}
              </TableHead>
            </TableRow>
            <TableRow>
              <TableHead className="border-l border-white/[0.06]">Status</TableHead>
              <TableHead className="text-right">AC kW</TableHead>
              <TableHead className="text-right">DC kW</TableHead>
              <TableHead className="text-right">°C</TableHead>
              <TableHead className="border-l border-white/[0.06] text-right">Yield kWh</TableHead>
              <TableHead className="min-w-40">vs plant avg</TableHead>
              <TableHead className="text-right">kWh/kWp</TableHead>
              <TableHead className="text-right">Peak AC kW</TableHead>
              <TableHead className="text-right">Eff. %</TableHead>
              <TableHead className="text-right">Max °C</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {shown.length === 0 && (
              <TableRow>
                <TableCell colSpan={11} className="py-8 text-center text-muted-foreground">
                  No inverter matches{needle ? ` “${q.trim()}”` : ""}
                  {show !== "all" ? ` · ${SHOW_LABEL[show].toLowerCase()}` : ""}.
                </TableCell>
              </TableRow>
            )}
            {shown.map((i) => {
              const s = states.get(i.device_sn);
              const rec = s?.kind === "live" ? s.rec : null;
              const active = i.device_sn === selectedSn;
              const pct = pctOfAvg(i);
              const lim = limitPct(i);
              const select = () => onSelect(i.device_sn);
              return (
                <TableRow
                  key={i.device_sn}
                  tabIndex={0}
                  aria-selected={active}
                  onClick={select}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      select();
                    }
                  }}
                  className={cn("cursor-pointer outline-none focus-visible:bg-white/[0.04]", active && "bg-solar-400/[0.07] hover:bg-solar-400/[0.09]")}
                >
                  <TableCell className={cn("border-l-2 border-transparent", active && "border-solar-400")}>
                    <div className="flex items-center gap-2">
                      <span className="font-semibold whitespace-nowrap text-slate-100">{invName(i)}</span>
                      {(issues.get(i.device_sn) ?? 0) > 0 && (
                        <Badge variant="warn" className="num text-[10px]" title="Strings with a finding or inactive on the stored day">
                          {issues.get(i.device_sn)} strings
                        </Badge>
                      )}
                      {isSwitchedOff(i) ? (
                        <Badge variant="crit" className="text-[10px]">
                          OFF
                        </Badge>
                      ) : lim != null ? (
                        <Badge variant="warn" className="text-[10px]" title="Active power limit set on the inverter">
                          LIMIT {fmt(lim, 0)}%
                        </Badge>
                      ) : null}
                    </div>
                    <div className="num text-[11px] text-muted-foreground">
                      {i.alias ? `${i.device_sn} · ` : ""}
                      {fmt(i.nominal_power_kw, 0)} kW · {fmt(i.capacity_kwp, 1)} kWp
                    </div>
                  </TableCell>
                  <TableCell className="border-l border-white/[0.06]">
                    {s?.kind === "live" ? (
                      <span className="flex items-center gap-1.5 whitespace-nowrap" title={`Record ${s.rec.timestamp}`}>
                        <Led level={s.rec.stale ? "warn" : s.level} />
                        <span className="text-slate-200">{s.label}</span>
                        <span className="num text-[11px] text-muted-foreground">{hhmm(s.rec.timestamp)}</span>
                      </span>
                    ) : (
                      <span className="text-muted-foreground">{s?.kind === "waiting" ? "…" : "No record"}</span>
                    )}
                  </TableCell>
                  <TableCell className="num text-right whitespace-nowrap">{nowKw(rec?.pac_w)}</TableCell>
                  <TableCell className="num text-right whitespace-nowrap text-slate-300">{nowKw(rec?.ppv_w)}</TableCell>
                  <TableCell className={cn("num text-right whitespace-nowrap text-slate-300", rec?.temperature_c != null && rec.temperature_c >= HOT_C && "text-amber-300")}>
                    {fmt(rec?.temperature_c, 0)}
                  </TableCell>
                  <TableCell className="num border-l border-white/[0.06] text-right whitespace-nowrap">{fmt(i.yield_today_kwh, 1)}</TableCell>
                  <TableCell>
                    {pct == null ? (
                      <span className="text-muted-foreground">—</span>
                    ) : (
                      <div className="flex items-center gap-2">
                        <div className="relative h-1.5 flex-1 overflow-hidden rounded-full bg-white/[0.06]">
                          <div
                            className={cn("h-full rounded-full", pct < LOW_PCT ? "bg-amber-400" : "bg-solar-400/80")}
                            style={{ width: `${Math.min(100, pct / 1.5)}%` }}
                          />
                          {/* plant average = 100 % sits at two thirds of the bar */}
                          <div className="absolute inset-y-0 left-2/3 w-px bg-white/40" />
                        </div>
                        <span className={cn("num w-10 text-right", pct < LOW_PCT ? "text-amber-300" : "text-slate-300")}>{fmt(pct, 0)}%</span>
                      </div>
                    )}
                  </TableCell>
                  <TableCell className="num text-right whitespace-nowrap text-slate-300">{fmt(i.specific_yield, 2)}</TableCell>
                  <TableCell className="num text-right whitespace-nowrap text-slate-300">{fmt(i.peak_ac_kw, 1)}</TableCell>
                  <TableCell className="num text-right whitespace-nowrap text-slate-300">{fmt(i.efficiency_pct, 2)}</TableCell>
                  <TableCell className={cn("num text-right whitespace-nowrap text-slate-300", i.max_temp_c != null && i.max_temp_c >= HOT_C && "text-amber-300")}>
                    {fmt(i.max_temp_c, 1)}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
        <p className="text-[11px] text-muted-foreground">
          vs plant avg = the inverter's day yield ÷ the mean of the plant's inverters (tick = 100 %); amber below {LOW_PCT} %. Inverters can differ in
          rating and DC capacity, so compare kWh/kWp as well. Click a row to open the inverter below.
        </p>
      </CardContent>
    </Card>
  );
};
