/** Plant Sensors tab, Status view: the stored-day card (chart, figures, CSV) and the sensor card. */
import React, { useEffect, useState } from "react";
import { useLocation } from "react-router-dom";
import { ChevronDown, ChevronLeft, ChevronRight, Download, CircleHelp, Clock, CloudOff, RefreshCw, WifiOff, X } from "lucide-react";
import type { SensorLiveRow, SensorStatus } from "../../api/client";
import { useAppContext } from "../../context/AppContext";
import { Led, LoadingState, StatusBadge, fmt, fmtInt } from "../../components/ui";
import { FlagList, STATUS_VIEW } from "../../components/sensorView";
import type { ViewRow } from "../../components/sensorView";
import { PanelChart } from "../../components/PanelChart";
import { cn } from "@/lib/utils";
import { pickDay, pickTime, useUrlState } from "@/lib/useUrlState";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Spinner } from "@/components/ui/spinner";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { ButtonGroup } from "@/components/ui/button-group";
import { Calendar } from "@/components/ui/calendar";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { dayLabel, fromDate, toDate } from "@/lib/day";
import { FIELDS, shiftDay, minutesBetween, fmtAge } from "./format";
import { useSensorDayChart } from "./useSensorDayChart";
import { Row } from "./SensorInfo";

/** One plain sentence on why the sensor has its status. */
const statusWhy = (st: SensorStatus, l: SensorLiveRow | null, now: string, th: { late_min: number; offline_min: number }) => {
  const age = l?.last_update_time ? fmtAge(minutesBetween(l.last_update_time, now)) : null;
  switch (st) {
    case "online":
      return `Uploading normally · last upload ${age ?? "—"}`;
    case "late":
      return `Last upload ${age ?? "—"}: later than the ${th.late_min} min it should take`;
    case "offline":
      return l?.lost ? `Growatt reports the sensor as lost · last upload ${age ?? "never"}` : `No upload for over ${th.offline_min} min · last ${age ?? "never"}`;
    case "not_synced":
      return "Nothing stored yet and not checked live";
    default:
      return l?.listed === false ? "Its datalogger no longer lists this sensor" : "Live check in progress…";
  }
};

/** Status → Alert variant: online needs no callout. */
const ALERT_VARIANT: Record<SensorStatus, "warn" | "destructive" | "default" | null> = {
  online: null,
  late: "warn",
  offline: "destructive",
  not_synced: "warn",
  unknown: "default",
};

/** What the O&M team can do about a sensor's state (shown under the reason). */
const statusAdvice = (st: SensorStatus, l: SensorLiveRow | null) =>
  st === "offline"
    ? l?.lost
      ? "Check the sensor's power and its RS485 link to the datalogger."
      : "Check the datalogger's connection."
    : st === "late"
      ? "Usually a slow datalogger upload; it clears by itself when the next upload arrives."
      : st === "not_synced"
        ? "The worker has not stored anything for this sensor yet, and Growatt has not been asked."
        : "Growatt's sensor list is checked a few dataloggers at a time.";

/** "1264 s" → "21 min" / "45 s" */

/** A cell of the stored day's figures: at least 9rem wide, rules on its left and bottom. */
const KPI_CELL = "-mb-px -ml-px min-w-36 flex-1 basis-36 border-b border-l border-white/[0.06] px-4 py-3";

/** One labelled number in a divided row (Active Alarm style). */
const Stat: React.FC<{ label: string; children: React.ReactNode; hint?: React.ReactNode; className?: string }> = ({ label, children, hint, className }) => (
  <div className={cn("flex min-w-0 flex-col gap-1 px-5 py-4", className)}>
    <span className="eyebrow">{label}</span>
    <span className="num truncate text-lg font-semibold tracking-tight text-foreground">{children}</span>
    {hint && <span className="truncate text-[11px] text-muted-foreground">{hint}</span>}
  </div>
);

/**
 * Plant tab "Sensors": most plants have one sensor, so it opens on that sensor at once. Cards, top
 * to bottom: status (why, what to do, upload / check / storage times), the newest reading Growatt
 * holds (labelled with its age, so an old record never reads as live), the stored day with its
 * chart, and device details folded away. With several sensors line tabs pick one (`?sensor=`).
 */
export const PlantSensorView: React.FC<{
  sensors: ViewRow[];
  selected: ViewRow | null;
  now: string;
  until: string | null;
  onPick: (key: string) => void;
  thresholds: { late_min: number; offline_min: number };
  notes: string[];
  onRefresh: () => void;
  refreshing: boolean;
}> = ({ sensors, selected, now, until, onPick, thresholds, notes, onRefresh, refreshing }) => {
  const sensor = selected ?? sensors[0] ?? null;
  const [url, setUrl] = useUrlState();
  // time-of-day window (?from=&to=, HH:MM): day numbers and chart cover it only; "from" after "to" = whole day
  const timeFrom = pickTime(url.get("from"));
  const timeTo = pickTime(url.get("to"));
  const badWindow = Boolean(timeFrom && timeTo && timeFrom > timeTo);
  const windowed = Boolean(timeFrom || timeTo) && !badWindow;
  // IEC 61724 PR is a whole-day figure of the plant overview's day (null day = today)
  const { selectedPlantOverview } = useAppContext();
  const ov = selectedPlantOverview?.plant.plant_id === sensor?.plant_id ? selectedPlantOverview : null;
  const { detail, detailError, storedError, today, day, liveDayError, dayStored, pts, tailPts, dayMeasured, daySpec } = useSensorDayChart(sensor, now, {
    day: pickDay(url.get("day")) ?? undefined,
    from: windowed ? timeFrom : undefined,
    to: windowed ? timeTo : undefined,
    ov,
  });
  const iecPr = !windowed && ov && (ov.meta.day ?? today) === day ? ov.weather?.iec_pr ?? null : null;
  // "#weather-station" (Plant Overview tile): scroll to the stored-day card once it has loaded
  const { hash } = useLocation();
  const dayLoaded = Boolean(dayStored);
  useEffect(() => {
    if (hash === "#weather-station" && dayLoaded) document.getElementById("weather-station")?.scrollIntoView({ behavior: "smooth" });
  }, [hash, dayLoaded]);
  const setDay = (d: string) => setUrl({ day: d >= today ? null : d });

  // drag-to-zoom: the dragged range, widened to whole 5-min slots, becomes the ?from=&to= window
  const zoomTo = (lo: number, hi: number) => {
    const slot = (ms: number, up: boolean) => {
      const d = new Date(ms);
      const ymd = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      if (ymd < day) return "00:00";
      if (ymd > day) return "23:59";
      const min = d.getHours() * 60 + d.getMinutes();
      const m = Math.min(23 * 60 + 55, up ? Math.ceil(min / 5) * 5 : Math.floor(min / 5) * 5);
      return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
    };
    const from = slot(lo, false);
    const to = slot(hi, true);
    if (from < to) setUrl({ from, to });
  };

  const exportCsv = () => {
    if (!sensor || !pts.length) return;
    const cols = FIELDS.filter((f) => dayMeasured.has(f));
    const head = ["timestamp", ...cols.map((f) => `${f}`)];
    const body = pts.map((p) => [p.timestamp, ...cols.map((f) => (p[f] == null ? "" : String(p[f])))].join(","));
    const meta = `# plant ${sensor.plant_id} ${sensor.plant_name.replace(/[\r\n,]/g, " ")} · sensor ${sensor.datalogger_sn}#${sensor.address} · ${day}${windowed ? ` ${timeFrom || "00:00"}-${timeTo || "24:00"}` : ""} · stored 5-min records, plant-local time`;
    const blob = new Blob([[meta, head.join(","), ...body].join("\n")], { type: "text/csv" });
    const href = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = href;
    a.download = `weather-sensor-${sensor.plant_id}-${sensor.datalogger_sn}-${sensor.address}-${day}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(href), 60_000);
  };

  const [pickerOpen, setPickerOpen] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);

  if (!sensor) return null;

  // the sensor's own live answer is newer than the sweep's row once it has arrived
  const l = detail?.data.status ?? sensor.live;
  const st: SensorStatus = l && l.status !== "unknown" ? l.status : sensor.status;
  const view = STATUS_VIEW[st];
  const plantFlags = [...sensor.flags, ...(l?.flags ?? [])];
  const th = detail?.data.thresholds ?? thresholds;
  const raw = detail?.data.raw ?? null;
  const readingError = detail?.data.errors.reading ?? detail?.data.errors.status;
  const alertVariant = ALERT_VARIANT[st];
  const isToday = day === today;

  // peak includes the live points not stored yet (real readings), so it matches the chart
  const tailPeak = tailPts.reduce<number | null>((m, p) => (p.irradiance_wm2 != null && (m == null || p.irradiance_wm2 > m) ? p.irradiance_wm2 : m), null);
  const storedPeak = dayStored?.kpis.peak_irradiance_wm2 ?? null;
  const peakIrr = tailPeak != null && (storedPeak == null || tailPeak > storedPeak) ? tailPeak : storedPeak;
  const dayKpis = (
    [
      ["Insolation", dayStored?.kpis.insolation_kwh_m2, 2, "kWh/m²", "irradiance_wm2"],
      ["Peak irradiance", peakIrr, 0, "W/m²", "irradiance_wm2"],
      ["Max module", dayStored?.kpis.max_module_temp_c, 1, "°C", "module_temp_c"],
      ["Avg module (day)", dayStored?.kpis.avg_module_temp_daylight_c, 1, "°C", "module_temp_c"],
      ["Max ambient", dayStored?.kpis.max_ambient_temp_c, 1, "°C", "ambient_temp_c"],
      ["Avg ambient", dayStored?.kpis.avg_ambient_temp_c, 1, "°C", "ambient_temp_c"],
      ["Avg humidity", dayStored?.kpis.avg_humidity_pct, 0, "%", "humidity_pct"],
      ["Avg wind", dayStored?.kpis.avg_wind_speed_ms, 1, "m/s", "wind_speed_ms"],
      ["Max wind", dayStored?.kpis.max_wind_speed_ms, 1, "m/s", "wind_speed_ms"],
    ] as const
  ).filter(([, , , , f]) => dayMeasured.has(f));

  return (
    <div className="flex flex-col gap-4">
      {sensors.length > 1 && (
        <Tabs value={sensor.key} onValueChange={onPick}>
          <TabsList variant="line" aria-label="Sensors of this plant">
            {sensors.map((s) => (
              <TabsTrigger key={s.key} value={s.key} className="num">
                <Led level={STATUS_VIEW[s.st].level === "info" ? "off" : STATUS_VIEW[s.st].level} />
                {s.datalogger_sn}#{s.address}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
      )}

      {/* stored day (Plant Overview's weather tile links here) */}
      <Card id="weather-station" className="scroll-mt-4">
        <CardHeader className="max-sm:grid-cols-1!">
          <CardTitle>{isToday ? "Today" : dayLabel(day)}</CardTitle>
          <CardDescription>
            Stored 5-min records{windowed ? ` · ${timeFrom || "00:00"}–${timeTo || "24:00"} only` : ""}
            {badWindow ? " · “From” is after “To”: whole day shown" : ""}
            {pts.length ? ` · ${fmtInt(pts.length)} from ${pts[0].timestamp.slice(11, 16)} to ${pts[pts.length - 1].timestamp.slice(11, 16)}` : ""}
            {tailPts.length ? ` · + ${tailPts.length} from Growatt live to ${tailPts[tailPts.length - 1].timestamp.slice(11, 16)}, not stored yet` : ""}
            {isToday && liveDayError ? ` · Today's live records failed: ${liveDayError}` : ""}
          </CardDescription>
          <CardAction className="flex flex-wrap items-center justify-end gap-2 max-sm:col-start-1 max-sm:row-span-1 max-sm:row-start-3 max-sm:mt-2 max-sm:justify-self-start max-sm:justify-start">
            <ButtonGroup>
              <Button variant="outline" size="icon-sm" onClick={() => setDay(shiftDay(day, -1))} aria-label="Previous day">
                <ChevronLeft />
              </Button>
              <Popover open={pickerOpen} onOpenChange={setPickerOpen}>
                <PopoverTrigger asChild>
                  <Button variant="outline" size="sm" className="num min-w-36" aria-label="Day">
                    {dayLabel(day)}
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-auto p-0" align="end">
                  <Calendar
                    mode="single"
                    selected={toDate(day)}
                    defaultMonth={toDate(day)}
                    disabled={{ after: toDate(today) }}
                    onSelect={(d) => {
                      if (!d) return;
                      setDay(fromDate(d));
                      setPickerOpen(false);
                    }}
                  />
                </PopoverContent>
              </Popover>
              <Button variant="outline" size="icon-sm" onClick={() => setDay(shiftDay(day, 1))} disabled={isToday} aria-label="Next day">
                <ChevronRight />
              </Button>
            </ButtonGroup>
            <Button variant="outline" size="sm" onClick={() => setDay(today)} disabled={isToday}>
              Today
            </Button>
            <ButtonGroup aria-label="Time of day">
              <Input type="time" step={300} className="h-7 w-[6.5rem] text-xs" value={timeFrom} onChange={(e) => setUrl({ from: e.target.value })} aria-label="From time" />
              <Input type="time" step={300} className="h-7 w-[6.5rem] text-xs" value={timeTo} onChange={(e) => setUrl({ to: e.target.value })} aria-label="To time" />
            </ButtonGroup>
            {(timeFrom || timeTo) && (
              <Button variant="ghost" size="sm" onClick={() => setUrl({ from: null, to: null })} title="Show the whole day">
                <X data-icon="inline-start" />
                Whole day
              </Button>
            )}
            <Button variant="outline" size="sm" onClick={exportCsv} disabled={!pts.length} title="Download this day's stored 5-min records as CSV">
              <Download data-icon="inline-start" />
              CSV
            </Button>
          </CardAction>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {dayStored && pts.length > 0 && dayKpis.length > 0 && (
            // cells wrap instead of shrinking (10 tiles with the IEC PR one); each draws its own left and
            // bottom rule, and the ones on the outer edge are clipped under the frame
            <div className="flex flex-wrap overflow-hidden rounded-lg border border-white/[0.06]">
              {dayKpis.map(([label, v, d, unit]) => (
                <Stat key={label} label={label} className={KPI_CELL}>
                  {fmt(v, d)} <span className="text-xs font-normal text-muted-foreground">{unit}</span>
                </Stat>
              ))}
              {iecPr && (
                <Stat
                  label="IEC 61724 PR"
                  className={KPI_CELL}
                  hint={
                    iecPr.pr_pct == null
                      ? iecPr.reason ?? undefined
                      : `Yf ${fmt(iecPr.final_yield_h, 2)} h ÷ Yr ${fmt(iecPr.reference_yield_h, 2)} h · ${fmt(iecPr.coverage_pct, 0)}% coverage`
                  }
                >
                  <span className={iecPr.pr_pct == null ? "text-muted-foreground" : iecPr.pr_pct >= 80 ? "text-emerald-300" : "text-amber-300"}>{fmt(iecPr.pr_pct, 1)}</span>
                  {iecPr.pr_pct != null && <span className="text-xs font-normal text-muted-foreground"> %</span>}
                </Stat>
              )}
            </div>
          )}
          {daySpec ? (
            <div className="flex flex-col gap-1.5">
              <PanelChart spec={daySpec} height={120 + daySpec.panels.length * 110} legendToggle onBrush={zoomTo} />
              <p className="text-[11px] text-muted-foreground max-sm:hidden">
                Drag across the chart to zoom in to that time{windowed ? " (“Whole day” zooms out)" : ""} · click a legend item to hide or show it.
              </p>
            </div>
          ) : !dayStored && !storedError ? (
            <LoadingState label="Loading stored readings…" shape="chart" className="border-0 bg-transparent p-0 shadow-none" />
          ) : (
            <Empty className="border border-dashed border-white/[0.08] py-10">
              <EmptyHeader>
                <EmptyTitle>
                  {windowed ? "No readings stored in this time window" : isToday ? "No readings stored today" : `No readings stored for ${dayLabel(day)}`}
                </EmptyTitle>
                <EmptyDescription>
                  {storedError ?? (isToday ? "The worker stores this sensor's 5-min records every 10 min; nothing has arrived for today yet." : "Raw readings are kept for 90 days.")}
                </EmptyDescription>
              </EmptyHeader>
              {!storedError && sensor.last_reading_at && sensor.last_reading_at.slice(0, 10) !== day && (
                <EmptyContent>
                  <Button variant="outline" size="sm" onClick={() => setDay(sensor.last_reading_at!.slice(0, 10))}>
                    Show {dayLabel(sensor.last_reading_at.slice(0, 10))}, the newest stored day
                  </Button>
                </EmptyContent>
              )}
            </Empty>
          )}
        </CardContent>
      </Card>

      {/* sensor: status, why, and its device table */}
      <Card className="gap-0">
        <CardHeader className="pb-4">
          <CardTitle className="flex flex-wrap items-center gap-2">
            <span className="num">
              {sensor.datalogger_sn}#{sensor.address}
            </span>
            <StatusBadge status={view.label} level={view.level} />
          </CardTitle>
          <CardDescription>
            {[sensor.device_name, sensor.phase != null ? `Phase ${sensor.phase}` : null, "Growatt weather sensor"].filter(Boolean).join(" · ")}
          </CardDescription>
          <CardAction>
            <Button variant="outline" size="sm" onClick={onRefresh} disabled={refreshing}>
              {refreshing ? <Spinner data-icon="inline-start" className="size-3" /> : <RefreshCw data-icon="inline-start" />}
              Refresh
            </Button>
          </CardAction>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {alertVariant ? (
            <Alert variant={alertVariant}>
              {st === "offline" ? <WifiOff /> : st === "late" ? <Clock /> : st === "not_synced" ? <CloudOff /> : <CircleHelp />}
              <AlertTitle>{statusWhy(st, l, now, th)}</AlertTitle>
              <AlertDescription>{statusAdvice(st, l)}</AlertDescription>
            </Alert>
          ) : (
            <p className="text-sm text-slate-300">{statusWhy(st, l, now, th)}</p>
          )}
          {plantFlags.length > 0 && <FlagList flags={plantFlags} />}
          {(detailError || readingError) && <p className="text-[11px] text-amber-300">Live request failed: {detailError ?? readingError}</p>}
          <div className="grid gap-x-8 rounded-lg border border-white/[0.06] px-4 py-2 md:grid-cols-2">
            <div>
              <Row label="Datalogger SN">{sensor.datalogger_sn}</Row>
              <Row label="Bus address">{sensor.address}</Row>
              <Row label="Device name">{sensor.device_name ?? "—"}</Row>
              <Row label="Phase (Growatt account)">{sensor.phase ?? "—"}</Row>
            </div>
            <div>
              <Row label="Growatt says lost">{l?.lost == null ? "—" : l.lost ? "Yes" : "No"}</Row>
              <Row label="Listed by datalogger">{l?.listed == null ? "—" : l.listed ? "Yes" : "No"}</Row>
              <Row label="Last upload (plant time)">{l?.last_update_time ?? "—"}</Row>
              <Row label="Status rule">
                <span className="text-xs">
                  online ≤ {th.late_min} min · late ≤ {th.offline_min} min
                </span>
              </Row>
            </div>
          </div>
          {raw && (
            <Collapsible open={detailsOpen} onOpenChange={setDetailsOpen}>
              <CollapsibleTrigger asChild>
                <Button variant="ghost" size="sm" className="self-start">
                  <ChevronDown data-icon="inline-start" className={cn("transition-transform", detailsOpen && "rotate-180")} />
                  Raw record ({Object.keys(raw).length} fields, admin only)
                </Button>
              </CollapsibleTrigger>
              <CollapsibleContent>
                <div className="grid gap-x-8 rounded-lg border border-white/[0.06] px-4 py-2 sm:grid-cols-2 xl:grid-cols-3">
                  {Object.entries(raw)
                    .sort(([a], [b]) => a.localeCompare(b))
                    .map(([k, v]) => (
                      <Row key={k} label={k}>
                        {v == null ? "null" : String(v)}
                      </Row>
                    ))}
                </div>
              </CollapsibleContent>
            </Collapsible>
          )}
        </CardContent>
      </Card>

      <p className="text-[11px] text-muted-foreground">
        “—” = no value.
        {notes.length ? ` ${notes.join(" · ")}` : ""}
      </p>
    </div>
  );
};
