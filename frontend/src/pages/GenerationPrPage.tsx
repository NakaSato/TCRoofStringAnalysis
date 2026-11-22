import React, { useMemo } from "react";
import { Link } from "react-router-dom";
import { Building2 } from "lucide-react";
import { useAppContext, usePlantHref } from "../context/AppContext";
import { PanelChart } from "../components/PanelChart";
import { EmptyState, LoadingState, fmt } from "../components/ui";
import { SelectedPlantBanner } from "../components/SelectedPlantBanner";
import { pick, useUrlState } from "@/lib/useUrlState";
import { dayLabel } from "@/lib/day";
import { Spinner } from "@/components/ui/spinner";
import { StringPeriodPicker } from "../components/stringDetail/StringPeriodPicker";
import { slotTime } from "../components/stringDetail/period";
import { usePowerPeriod } from "./overview/usePowerPeriod";
import { cn } from "@/lib/utils";
import { translate, useI18n } from "@/i18n";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { GroupLabel, HOT_C, Stat, Unit, hhmm, invName } from "./inverters/shared";
import { inverterThermalSpec, inverterYieldSpec, prTone, waterfallSpec } from "./generation/charts";
import { InverterTable } from "./generation/InverterTable";
import { PwaMeterCard } from "./generation/PwaMeterCard";
import { PrHistoryCard } from "./generation/PrHistoryCard";
import type { EpiFactor } from "../api/client";

/** Four figures in one divided frame: 2 × 2 on phones, one row from md. */
/** How the EPI model's system factor came about, for the EPI hint. */
const epiBasis = (f: EpiFactor | undefined): string =>
  !f
    ? translate("default factor")
    : f.basis === "fitted"
      ? translate("plant factor {f} from {n} clear days", { f: fmt(f.factor, 3), n: f.days_used })
      : f.status === "rejected" && f.fit_factor != null
        ? translate("default factor {f}; fit {fit} rejected", { f: fmt(f.factor, 3), fit: fmt(f.fit_factor, 2) })
        : translate("default factor {f}", { f: fmt(f.factor, 3) });

const STAT_ROW = "grid grid-cols-2 overflow-hidden rounded-lg border border-white/[0.06] md:grid-cols-4";

const CHARTS = ["yield", "thermal"] as const;
/** PR history length (URL `hdays`) when no day range is picked */
const HISTORY_DAYS = ["30", "7", "90", "365"] as const;

/**
 * `/plant/:id/generation`: stored data of the URL plant (DB, not the live overlay) for the period
 * picked at the top (URL `day`, `to`, `from_t`, `to_t`, as on the Plant Overview; default today).
 * A whole day shows that day's overview: figures, the 5-min power curve (drag = time window),
 * per-inverter comparison, the modelled loss breakdown and the inverter table. A day range or a
 * time window shows the stored curve and its integrated figures (`/power`); PR, the per-inverter
 * charts and the loss breakdown are whole-day figures and are not shown for it. Under it the
 * daily PR history (`/kpi-daily`): the picked range, else `hdays` days up to the picked day.
 */
export const GenerationPrPage: React.FC = () => {
  const { selectedPlantOverview: plantOv, plantOverviewLoading } = useAppContext();
  const plantHref = usePlantHref();
  const { t } = useI18n();
  const [url, setUrl] = useUrlState();
  const chart = pick(url.get("chart"), CHARTS, "yield");
  const historyDays = Number(pick(url.get("hdays"), HISTORY_DAYS, "30"));

  // stored records only: the live tail belongs to the Plant Overview / Inverters
  const pp = usePowerPeriod(plantOv, null, [], [], { live: false });
  const ov = pp.dayOv;

  const inverters = useMemo(() => ov?.inverters ?? [], [ov]);
  const target = ov?.kpis.target_pr_pct ?? plantOv?.kpis.target_pr_pct ?? null;

  const perInverter = useMemo(
    () => (chart === "thermal" ? inverterThermalSpec(inverters) : target != null ? inverterYieldSpec(inverters, target) : null),
    [chart, inverters, target]
  );
  const waterfall = useMemo(() => waterfallSpec(ov?.loss_waterfall ?? []), [ov]);

  if (plantOverviewLoading && !plantOv) {
    return (
      <div className="flex flex-col gap-4">
        <SelectedPlantBanner />
        <LoadingState label={t("Loading the plant's stored day…")} shape="page" />
      </div>
    );
  }
  if (!plantOv) {
    return (
      <div className="flex flex-col gap-4">
        <SelectedPlantBanner />
        <EmptyState icon={Building2} title={t("No stored day for this plant")} description={t("The worker has not stored history for it yet.")} />
      </div>
    );
  }

  const plantId = plantOv.plant.plant_id;
  const historyEnd = pp.endDay ?? pp.day ?? pp.today;
  const pickDay = (d: string) => pp.setPeriod({ day: d, endDay: null, start: "", end: "" });
  const onBrush = pp.multi || !pp.day ? undefined : (lo: number, hi: number) => pp.setPeriod({ ...pp.period, day: pp.day, start: slotTime(lo, pp.day!, false), end: slotTime(hi, pp.day!, true) });
  const emptyLabel = pp.error
    ? t("Could not load: {error}", { error: pp.error })
    : pp.day === pp.today
      ? t("No stored records for {period} yet (the worker stores them every 10 min)", { period: pp.label })
      : t("No stored records for {period}", { period: pp.label });

  const periodBar = (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div className="flex flex-col gap-0.5">
        <span className="text-sm font-semibold text-white">{pp.label}</span>
        <span className="text-[11px] text-muted-foreground">
          {pp.windowed
            ? t("Time window · PR is a whole-day figure, not shown")
            : pp.multi
              ? t("Day range · the PR history below gives the range's energy-weighted PR")
              : t("Whole day")}
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {pp.loading && <Spinner className="size-3" aria-label={t("Loading the period…")} />}
        <StringPeriodPicker
          period={pp.period}
          onChange={pp.setPeriod}
          shownDay={pp.day}
          shownEndDay={pp.endDay}
          today={pp.today}
          loading={pp.loading}
          align="end"
          hint={pp.multi ? undefined : t("Or drag across the power chart.")}
          resetLabel={t("Today")}
          resetTitle={t("Back to today")}
        />
      </div>
    </div>
  );

  const history = (
    <PrHistoryCard
      plantId={plantId}
      endDay={historyEnd}
      startDay={pp.multi ? pp.day : null}
      days={historyDays}
      onDaysChange={(n) => setUrl({ hdays: n === 30 ? null : String(n) })}
      target={target}
      selectedDay={pp.multi ? null : pp.day}
      onPickDay={pickDay}
    />
  );

  // a day range or a time window: the stored curve and its integrated figures only
  if (!ov) {
    const f = pp.figures;
    const kwp = plantOv.kpis.capacity_kwp ?? null;
    return (
      <div className="flex flex-col gap-4">
        <SelectedPlantBanner />
        <Card className="gap-4">
          <CardContent className="flex flex-col gap-4">
            {periodBar}
            {pp.loading && !f ? (
              <LoadingState label={t("Loading the period…")} shape="chart" />
            ) : (
              <>
                <div className="flex flex-col gap-2">
                  <GroupLabel title="Energy" note={t("measured · integrated from the stored 5-min records")} />
                  <div className={STAT_ROW}>
                    <Stat label="Yield" hint={f?.growattKwh != null ? t("Growatt {v} kWh", { v: fmt(f.growattKwh, 1) }) : undefined}>
                      {fmt(f?.energyKwh, 1)} <Unit>kWh</Unit>
                    </Stat>
                    <Stat label="Specific yield" hint={kwp != null ? t("of {v} kWp", { v: fmt(kwp, 1) }) : undefined}>
                      {fmt(f?.specificKwhKwp, 2)} <Unit>kWh/kWp</Unit>
                    </Stat>
                    <Stat label="Peak AC" hint={f?.peakAt ? t("at {t}", { t: `${pp.multi ? `${dayLabel(f.peakAt.slice(0, 10))} ` : ""}${hhmm(f.peakAt)}` }) : undefined}>
                      {fmt(f?.peakKw, 1)} <Unit>kW</Unit>
                    </Stat>
                    <Stat label="PR" hint={pp.windowed ? t("whole-day figure") : t("see the PR history below")}>
                      — <Unit>%</Unit>
                    </Stat>
                  </div>
                </div>
                <div className="flex flex-col gap-2">
                  <GroupLabel title="Plant power" note={t("AC and DC summed over the inverters · stored records")} />
                  <PanelChart spec={pp.spec} height={320} legendToggle emptyLabel={emptyLabel} onBrush={onBrush} />
                </div>
              </>
            )}
          </CardContent>
        </Card>
        {history}
        {pp.mode === "curve" && (
          <p className="text-[11px] text-muted-foreground">
            {t("The per-inverter comparison, loss breakdown and inverter table need a single whole day: pick one above or click a day in the PR history.")}
          </p>
        )}
      </div>
    );
  }

  const k = ov.kpis;
  const day = ov.meta.day;
  const dayText = day ? dayLabel(day) : "—";

  // PR: IEC 61724 when a weather sensor allows it, else the peer-relative index (labelled as such)
  const iec = k.iec_pr_pct ?? null;
  const pr = iec ?? k.plant_pr_pct;
  const prDelta = pr != null && target != null ? pr - target : null;
  const iecReason = ov.weather?.has_sensor && iec == null ? ov.weather.iec_pr.reason : null;
  // R16: the day's weather sensor failed a health check, so IEC PR / PR' / EPI are shown greyed
  const sensorSuspect = iec != null && k.sensor_health?.ok === false ? k.sensor_health.reasons.join("; ") : null;

  const revenue = k.yield_today_kwh != null ? k.yield_today_kwh * k.tariff_thb_per_kwh : null;
  const peak = ov.timeseries.reduce<(typeof ov.timeseries)[number] | null>((m, r) => (r.pac_kw != null && (m?.pac_kw == null || r.pac_kw > m.pac_kw) ? r : m), null);
  const hottest = inverters.reduce<(typeof inverters)[number] | null>(
    (m, i) => (i.max_temp_c != null && (m?.max_temp_c == null || i.max_temp_c > m.max_temp_c) ? i : m),
    null
  );
  const insolation = k.insolation_kwh_m2 ?? null;

  return (
    <div className="flex flex-col gap-4">
      <SelectedPlantBanner />

      <Card className="gap-4">
        <CardContent className="flex flex-col gap-4">
          {periodBar}
          <div className="grid gap-4 min-[1600px]:grid-cols-2">
            <div className="flex flex-col gap-2">
              <GroupLabel title="Energy" note={t("measured")} />
              <div className={STAT_ROW}>
                <Stat label="Yield" hint={revenue != null ? `฿${fmt(revenue, 0)} · ฿${fmt(k.tariff_thb_per_kwh, 2)}/kWh` : undefined}>
                  {fmt(k.yield_today_kwh, 1)} <Unit>kWh</Unit>
                </Stat>
                <Stat label="Specific yield" hint={k.capacity_kwp != null ? t("of {v} kWp", { v: fmt(k.capacity_kwp, 1) }) : undefined}>
                  {fmt(k.specific_yield_kwh_per_kwp, 2)} <Unit>kWh/kWp</Unit>
                </Stat>
                <Stat label="Peak AC" hint={peak ? t("at {t}", { t: hhmm(peak.timestamp) }) : undefined}>
                  {fmt(k.peak_power_kw, 1)} <Unit>kW</Unit>
                </Stat>
                <Stat label="Lifetime">
                  {fmt(k.total_yield_kwh == null ? null : k.total_yield_kwh / 1000, 1)} <Unit>MWh</Unit>
                </Stat>
              </div>
            </div>
            <div className="flex flex-col gap-2">
              <GroupLabel title="Performance" note={
                  sensorSuspect
                    ? t("IEC 61724 · weather sensor suspect: {r}", { r: sensorSuspect })
                    : iec != null
                    ? t("IEC 61724 from the weather sensor")
                    : iecReason
                      ? t("peer-relative · no IEC PR: {r}", { r: iecReason })
                      : t("peer-relative · no weather sensor for IEC PR")
                } />
              <div className={STAT_ROW}>
                <Stat
                  label={iec != null ? "PR · IEC 61724" : "PR · peer-relative"}
                  hint={
                    k.iec_pr_temp_corrected_pct != null
                      ? `${
                          k.irradiance_weighted_module_temp_c != null
                            ? t("PR' {v} % (temp-corrected at {c} °C)", { v: fmt(k.iec_pr_temp_corrected_pct, 1), c: fmt(k.irradiance_weighted_module_temp_c, 1) })
                            : t("PR' {v} % (temp-corrected)", { v: fmt(k.iec_pr_temp_corrected_pct, 1) })
                        }${k.epi != null ? ` · ${t("EPI {v} (modelled, {basis})", { v: fmt(k.epi, 2), basis: epiBasis(k.epi_factor) })}` : ""}`
                      : prDelta != null
                        ? t("{d} pts vs target {t} %", { d: `${prDelta >= 0 ? "+" : ""}${fmt(prDelta, 1)}`, t: fmt(target, 0) })
                        : undefined
                  }
                >
                  <span
                    className={cn(sensorSuspect ? "text-muted-foreground" : target != null && prTone(pr, target))}
                    title={sensorSuspect ? t("Weather sensor suspect (R16): {r}", { r: sensorSuspect }) : undefined}
                  >
                    {fmt(pr, 1)}
                  </span>{" "}
                  <Unit>%</Unit>
                </Stat>
                <Stat
                  label="DC→AC efficiency"
                  hint={
                    k.ya_minus_yf != null
                      ? t("Ya − Yf {v} h/d · energy-weighted", { v: fmt(k.ya_minus_yf, 2) })
                      : t("energy-weighted")
                  }
                >
                  {fmt(k.conversion_efficiency_pct, 2)} <Unit>%</Unit>
                </Stat>
                <Stat label="Inverter temp" hint={hottest ? t("avg / max ({name})", { name: invName(hottest) }) : t("avg / max")}>
                  {fmt(k.avg_temp_c, 1)} /{" "}
                  <span className={cn(k.max_temp_c != null && k.max_temp_c >= HOT_C && "text-amber-300")}>{fmt(k.max_temp_c, 1)}</span>{" "}
                  <Unit>°C</Unit>
                </Stat>
                <Stat
                  label="Insolation"
                  hint={
                    insolation != null
                      ? t("peak {v} W/m²", { v: fmt(k.peak_irradiance_wm2, 0) })
                      : ov.weather?.has_sensor
                        ? t("no sensor reading")
                        : t("no weather sensor")
                  }
                >
                  {fmt(insolation, 2)} <Unit>kWh/m²</Unit>
                </Stat>
              </div>
            </div>
          </div>

          <div className="flex flex-col gap-2">
            <GroupLabel title="Plant power" note={t("AC and DC summed over the inverters · stored records")} />
            <PanelChart spec={pp.spec} height={320} legendToggle emptyLabel={emptyLabel} onBrush={onBrush} />
          </div>
        </CardContent>
      </Card>

      <div className="grid gap-4 xl:grid-cols-2">
        <Card className="gap-4">
          <CardHeader className="flex flex-wrap items-start justify-between gap-3">
            <div className="flex flex-col gap-1">
              <CardTitle>{t("By inverter")}</CardTitle>
              <CardDescription>
                {chart === "yield" ? t("Peer-relative PR against the target, and specific yield") : t("Day temperature and DC→AC efficiency")}
              </CardDescription>
            </div>
            <Tabs value={chart} onValueChange={(v) => setUrl({ chart: v === "yield" ? null : v })}>
              <TabsList variant="line" aria-label={t("Inverter chart")}>
                <TabsTrigger value="yield">{t("Yield & PR")}</TabsTrigger>
                <TabsTrigger value="thermal">{t("Temperature")}</TabsTrigger>
              </TabsList>
            </Tabs>
          </CardHeader>
          <CardContent>
            <PanelChart spec={perInverter} height={340} />
          </CardContent>
        </Card>

        <Card className="gap-4">
          <CardHeader>
            <CardTitle className="flex flex-wrap items-center gap-2">
              {t("Loss breakdown")}
              <Badge variant="neutral">{t("modelled")}</Badge>
            </CardTitle>
            <CardDescription>
              {ov.loss_waterfall[0]?.stage.includes("measured")
                ? t("From measured plane-of-array insolation × kWp to the measured AC yield")
                : t("From a reference derived from peer-relative PR to the measured AC yield")}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {waterfall ? (
              <PanelChart spec={waterfall} height={340} />
            ) : (
              <p className="py-10 text-center text-xs text-muted-foreground">
                {t("Not built for this day: it needs the day's yield, a PR, and inverter temperature and efficiency, all measured.")}
              </p>
            )}
          </CardContent>
        </Card>
      </div>

      {history}

      <PwaMeterCard plantId={ov.plant.plant_id} />

      {inverters.length > 0 && target != null && <InverterTable inverters={inverters} target={target} dayText={dayText} />}

      <p className="text-[11px] text-muted-foreground">
        {t("Live values per inverter are on the")}{" "}
        <Link className="text-solar-300 underline-offset-2 hover:underline" to={plantHref("inverters")}>
          {t("Inverters")}
        </Link>{" "}
        {t("tab; irradiance and module temperature on")}{" "}
        <Link className="text-solar-300 underline-offset-2 hover:underline" to={`${plantHref("sensors")}#weather-station`}>
          {t("Sensors")}
        </Link>
        .
      </p>
    </div>
  );
};
