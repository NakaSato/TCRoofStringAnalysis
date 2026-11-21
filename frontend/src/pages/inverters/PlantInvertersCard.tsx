/**
 * Inverters page, plant card: what the plant's inverters do now (live record, memory only) next to
 * the stored day (DB), and one table comparing them. "Now" and "stored day" are always labelled
 * apart: the stored day can be an earlier day than the live record.
 */
import React from "react";
import { CloudOff, History, Unplug, X } from "lucide-react";
import { Led, fmt } from "../../components/ui";
import { cn } from "@/lib/utils";
import { useI18n } from "@/i18n";
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
  low: "Below {n} % of avg",
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
  const { t } = useI18n();
  const showLabel = (k: Show) => t(SHOW_LABEL[k], { n: LOW_PCT });
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
          {t("Inverters")}
          <Badge variant="neutral" className="num">
            {inverters.length}
          </Badge>
        </CardTitle>
        <CardDescription>
          {untilText
            ? t("Status and “Now” from each inverter's newest live record · day figures from stored 5-min history of {day}, up to {until}", { day: dayText, until: untilText })
            : t("Status and “Now” from each inverter's newest live record · day figures from stored 5-min history of {day}", { day: dayText })}
        </CardDescription>
      </CardHeader>

      <CardContent className="flex flex-col gap-4">
        {behind && (
          <Alert variant="warn">
            <History />
            <AlertTitle>
              {untilText
                ? t("Stored history ends {day} at {until}", { day: dayText, until: untilText })
                : t("Stored history ends {day}", { day: dayText })}
            </AlertTitle>
            <AlertDescription>
              {t(
                "Live records are from {day}. Day figures, charts and string results below are from the stored day until the worker stores newer records.",
                { day: dayLabel(liveDay!) }
              )}
            </AlertDescription>
          </Alert>
        )}
        {liveFailed && (
          <Alert variant="warn">
            <CloudOff />
            <AlertTitle>{t("Live data unavailable")}</AlertTitle>
            <AlertDescription>{t("Growatt did not answer; status and “Now” show — until the next try. Stored figures are unaffected.")}</AlertDescription>
          </Alert>
        )}
        {offline.length + unanswered.length > 0 && (
          <Alert>
            <Unplug />
            <AlertTitle>
              {offline.length > 0
                ? t("{n} of {total} inverters offline: {names}", { n: offline.length, total: inverters.length, names: offline.map(invName).join(", ") })
                : t("No live answer for {n} of {total} inverters: {names}", { n: unanswered.length, total: inverters.length, names: unanswered.map(invName).join(", ") })}
            </AlertTitle>
            <AlertDescription>
              {offline.length > 0 &&
                (offline.length === 1
                  ? t("Offline = Growatt has no record of it today, so “Now” shows —.")
                  : t("Offline = Growatt has no record of them today, so “Now” shows —."))}
              {offline.length > 0 && unanswered.length > 0 && ` ${t("No live answer for {names}.", { names: unanswered.map(invName).join(", ") })}`}
              {errorList.length > 0 && ` ${errorList.map(([k, v]) => `${k}: ${v}`).join(" · ")}`}
            </AlertDescription>
          </Alert>
        )}

        <div className="grid gap-4 xl:grid-cols-2">
          <div className="flex flex-col gap-2">
            <GroupLabel
              title="Now"
              note={
                liveAt
                  ? liveDay && behind
                    ? t("live · newest record {t} on {day}", { t: hhmm(liveAt), day: dayLabel(liveDay) })
                    : t("live · newest record {t}", { t: hhmm(liveAt) })
                  : liveLoading
                    ? t("asking Growatt…")
                    : t("no live record")
              }
            />
            <div className={KPI_ROW}>
              <Stat label="Online" hint={recs.length ? t("{n} of {total} reporting live", { n: recs.length, total: inverters.length }) : undefined}>
                <span className={cn(recs.length > 0 && online < inverters.length && "text-amber-300")}>{recs.length ? online : "—"}</span>
                <Unit> / {inverters.length}</Unit>
              </Stat>
              <Stat label="AC power">
                {nowKw(acNow)} <Unit>kW</Unit>
              </Stat>
              <Stat label="DC input">
                {nowKw(dcNow)} <Unit>kW</Unit>
              </Stat>
              <Stat label="Energy today" hint={t("Growatt's day counter")}>
                {fmt(todayKwh, 1)} <Unit>kWh</Unit>
              </Stat>
            </div>
          </div>
          <div className="flex flex-col gap-2">
            <GroupLabel title="Stored day" note={untilText ? t("{day} · to {until}", { day: dayText, until: untilText }) : dayText} />
            <div className={KPI_ROW}>
              <Stat label="Yield">
                {fmt(kpis.yield_today_kwh, 1)} <Unit>kWh</Unit>
              </Stat>
              <Stat label="Peak AC" hint={t("plant, 5-min")}>
                {fmt(kpis.peak_power_kw, 1)} <Unit>kW</Unit>
              </Stat>
              <Stat label="DC→AC efficiency" hint={t("energy-weighted")}>
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
            placeholder={t("Search inverter name or SN")}
            value={q}
            onChange={(e) => setUrl({ q: e.target.value })}
            aria-label={t("Search inverters")}
          />
          <Select value={show} onValueChange={(v) => setUrl({ show: v === "all" ? null : v })}>
            <SelectTrigger size="sm" className="w-52" aria-label={t("Show")}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {SHOW.map((k) => (
                  <SelectItem key={k} value={k}>
                    {showLabel(k)} ({inverters.filter(keeps[k]).length})
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
          {filtered && (
            <>
              <span className="num text-[11px] text-muted-foreground">
                {t("{n} of {total}", { n: shown.length, total: inverters.length })}
              </span>
              <Button variant="ghost" size="sm" onClick={() => setUrl({ q: null, show: null })}>
                <X data-icon="inline-start" />
                {t("Clear")}
              </Button>
            </>
          )}
        </div>

        <Table containerClassName="table-wrap">
          <TableHeader>
            <TableRow>
              <TableHead rowSpan={2} className="align-bottom">
                {t("Inverter")}
              </TableHead>
              <TableHead colSpan={4} className="border-l border-white/[0.06] text-slate-300">
                {t("Now · live")}
              </TableHead>
              <TableHead colSpan={6} className="border-l border-white/[0.06] text-slate-300">
                {t("Stored day · {day}", { day: day ?? "—" })}
              </TableHead>
            </TableRow>
            <TableRow>
              <TableHead className="border-l border-white/[0.06]">{t("Status")}</TableHead>
              <TableHead className="text-right">AC kW</TableHead>
              <TableHead className="text-right">DC kW</TableHead>
              <TableHead className="text-right">°C</TableHead>
              <TableHead className="border-l border-white/[0.06] text-right">{t("Yield kWh")}</TableHead>
              <TableHead className="min-w-40">{t("vs plant avg")}</TableHead>
              <TableHead className="text-right">kWh/kWp</TableHead>
              <TableHead className="text-right">{t("Peak AC kW")}</TableHead>
              <TableHead className="text-right">{t("Eff. %")}</TableHead>
              <TableHead className="text-right">{t("Max °C")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {shown.length === 0 && (
              <TableRow>
                <TableCell colSpan={11} className="py-8 text-center text-muted-foreground">
                  {needle ? t("No inverter matches “{q}”", { q: q.trim() }) : t("No inverter matches")}
                  {show !== "all" ? ` · ${showLabel(show).toLowerCase()}` : ""}.
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
                        <Badge variant="warn" className="num text-[10px]" title={t("Strings with a finding or inactive on the stored day")}>
                          {t("{n} strings", { n: issues.get(i.device_sn) })}
                        </Badge>
                      )}
                      {isSwitchedOff(i) ? (
                        <Badge variant="crit" className="text-[10px]">
                          {t("OFF")}
                        </Badge>
                      ) : lim != null ? (
                        <Badge variant="warn" className="text-[10px]" title={t("Active power limit set on the inverter")}>
                          {t("LIMIT {v}%", { v: fmt(lim, 0) })}
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
                      <span className="flex items-center gap-1.5 whitespace-nowrap" title={t("Record {t}", { t: s.rec.timestamp })}>
                        <Led level={s.rec.stale ? "warn" : s.level} />
                        <span className="text-slate-200">{t(s.label)}</span>
                        <span className="num text-[11px] text-muted-foreground">{hhmm(s.rec.timestamp)}</span>
                      </span>
                    ) : s?.kind === "none" && !s.failed ? (
                      <span className="flex items-center gap-1.5 whitespace-nowrap" title={t("Growatt has no record of this inverter today")}>
                        <Led level="crit" />
                        <span className="text-slate-200">{t("Offline")}</span>
                      </span>
                    ) : (
                      <span className="text-muted-foreground">{s?.kind === "waiting" ? "…" : t("No answer")}</span>
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
          {t(
            "vs plant avg = the inverter's day yield ÷ the mean of the plant's inverters (tick = 100 %); amber below {n} %. Inverters can differ in rating and DC capacity, so compare kWh/kWp as well. Click a row to open the inverter below.",
            { n: LOW_PCT }
          )}
        </p>
      </CardContent>
    </Card>
  );
};
