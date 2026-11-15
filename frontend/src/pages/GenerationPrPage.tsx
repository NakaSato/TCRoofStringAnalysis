import React, { useMemo } from "react";
import { Link } from "react-router-dom";
import { Building2 } from "lucide-react";
import { useAppContext, usePlantHref } from "../context/AppContext";
import { PanelChart } from "../components/PanelChart";
import { EmptyState, LoadingState, fmt } from "../components/ui";
import { SelectedPlantBanner } from "../components/SelectedPlantBanner";
import { GoogleWeatherPanel } from "../components/GoogleWeatherPanel";
import { pick, useUrlState } from "@/lib/useUrlState";
import { dayLabel } from "@/lib/day";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { GroupLabel, HOT_C, Stat, Unit, hhmm, invName } from "./inverters/shared";
import { inverterThermalSpec, inverterYieldSpec, powerSpec, prTone, waterfallSpec } from "./generation/charts";
import { InverterTable } from "./generation/InverterTable";

/** Four figures in one divided frame: 2 × 2 on phones, one row from md. */
const STAT_ROW = "grid grid-cols-2 overflow-hidden rounded-lg border border-white/[0.06] md:grid-cols-4";

const CHARTS = ["yield", "thermal"] as const;

/**
 * `/plant/:id/generation`: the stored day of the URL plant (DB overview, not the live overlay).
 * Top to bottom: day figures and the 5-min power curve, per-inverter comparison next to the
 * modelled loss breakdown, Google weather (modelled), and the per-inverter table.
 */
export const GenerationPrPage: React.FC = () => {
  const { selectedPlantOverview: ov, plantOverviewLoading, plantLive } = useAppContext();
  const plantHref = usePlantHref();
  const [url, setUrl] = useUrlState();
  const chart = pick(url.get("chart"), CHARTS, "yield");

  const inverters = useMemo(() => ov?.inverters ?? [], [ov]);
  const target = ov?.kpis.target_pr_pct ?? null;
  const liveAt = (plantLive?.data?.inverters ?? []).reduce<string | null>(
    (a, r) => (r.timestamp && (a == null || r.timestamp > a) ? r.timestamp : a),
    null
  );

  const power = useMemo(() => (ov ? powerSpec(ov, liveAt, { irradiance: true, grid: true }) : null), [ov, liveAt]);
  const perInverter = useMemo(
    () => (chart === "thermal" ? inverterThermalSpec(inverters) : target != null ? inverterYieldSpec(inverters, target) : null),
    [chart, inverters, target]
  );
  const waterfall = useMemo(() => waterfallSpec(ov?.loss_waterfall ?? []), [ov]);

  if (plantOverviewLoading && !ov) {
    return (
      <div className="flex flex-col gap-4">
        <SelectedPlantBanner />
        <LoadingState label="Loading the plant's stored day…" shape="page" />
      </div>
    );
  }
  if (!ov) {
    return (
      <div className="flex flex-col gap-4">
        <SelectedPlantBanner />
        <EmptyState icon={Building2} title="No stored day for this plant" description="The worker has not stored history for it yet." />
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

  const revenue = k.yield_today_kwh != null ? k.yield_today_kwh * k.tariff_thb_per_kwh : null;
  const peak = ov.timeseries.reduce<(typeof ov.timeseries)[number] | null>((m, r) => (m == null || r.pac_kw > m.pac_kw ? r : m), null);
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
          <div className="grid gap-4 min-[1600px]:grid-cols-2">
            <div className="flex flex-col gap-2">
              <GroupLabel title="Energy" note="measured" />
              <div className={STAT_ROW}>
                <Stat label="Yield" hint={revenue != null ? `฿${fmt(revenue, 0)} · ฿${fmt(k.tariff_thb_per_kwh, 2)}/kWh` : undefined}>
                  {fmt(k.yield_today_kwh, 1)} <Unit>kWh</Unit>
                </Stat>
                <Stat label="Specific yield" hint={k.capacity_kwp != null ? `of ${fmt(k.capacity_kwp, 1)} kWp` : undefined}>
                  {fmt(k.specific_yield_kwh_per_kwp, 2)} <Unit>kWh/kWp</Unit>
                </Stat>
                <Stat label="Peak AC" hint={peak ? `at ${hhmm(peak.timestamp)}` : undefined}>
                  {fmt(k.peak_power_kw, 1)} <Unit>kW</Unit>
                </Stat>
                <Stat label="Lifetime">
                  {fmt(k.total_yield_kwh == null ? null : k.total_yield_kwh / 1000, 1)} <Unit>MWh</Unit>
                </Stat>
              </div>
            </div>
            <div className="flex flex-col gap-2">
              <GroupLabel title="Performance" note={
                  iec != null
                    ? "IEC 61724 from the weather sensor"
                    : iecReason
                      ? `peer-relative · no IEC PR: ${iecReason}`
                      : "peer-relative · no weather sensor for IEC PR"
                } />
              <div className={STAT_ROW}>
                <Stat
                  label={iec != null ? "PR · IEC 61724" : "PR · peer-relative"}
                  hint={
                    k.iec_pr_temp_corrected_pct != null
                      ? `PR' ${fmt(k.iec_pr_temp_corrected_pct, 1)} % (temp-corrected${k.irradiance_weighted_module_temp_c != null ? ` at ${fmt(k.irradiance_weighted_module_temp_c, 1)} °C` : ""})${k.epi != null ? ` · EPI ${fmt(k.epi, 2)} (modelled)` : ""}`
                      : prDelta != null
                        ? `${prDelta >= 0 ? "+" : ""}${fmt(prDelta, 1)} pts vs target ${fmt(target, 0)} %`
                        : undefined
                  }
                >
                  <span className={cn(target != null && prTone(pr, target))}>{fmt(pr, 1)}</span> <Unit>%</Unit>
                </Stat>
                <Stat
                  label="DC→AC efficiency"
                  hint={
                    k.ya_minus_yf != null
                      ? `Ya − Yf ${fmt(k.ya_minus_yf, 2)} h/d · energy-weighted`
                      : "energy-weighted"
                  }
                >
                  {fmt(k.conversion_efficiency_pct, 2)} <Unit>%</Unit>
                </Stat>
                <Stat label="Inverter temp" hint={hottest ? `avg / max (${invName(hottest)})` : "avg / max"}>
                  {fmt(k.avg_temp_c, 1)} /{" "}
                  <span className={cn(k.max_temp_c != null && k.max_temp_c >= HOT_C && "text-amber-300")}>{fmt(k.max_temp_c, 1)}</span>{" "}
                  <Unit>°C</Unit>
                </Stat>
                <Stat
                  label="Insolation"
                  hint={
                    insolation != null
                      ? `peak ${fmt(k.peak_irradiance_wm2, 0)} W/m²`
                      : ov.weather?.has_sensor
                        ? "no sensor reading"
                        : "no weather sensor"
                  }
                >
                  {fmt(insolation, 2)} <Unit>kWh/m²</Unit>
                </Stat>
              </div>
            </div>
          </div>

          <div className="flex flex-col gap-2">
            <GroupLabel title="Plant power" note="AC and DC summed over the inverters · clear-sky envelope is modelled (82 % of kWp at noon)" />
            <PanelChart spec={power} height={320} legendToggle emptyLabel="No stored records for this day" />
          </div>
        </CardContent>
      </Card>

      <div className="grid gap-4 xl:grid-cols-2">
        <Card className="gap-4">
          <CardHeader className="flex flex-wrap items-start justify-between gap-3">
            <div className="flex flex-col gap-1">
              <CardTitle>By inverter</CardTitle>
              <CardDescription>
                {chart === "yield" ? "Peer-relative PR against the target, and specific yield" : "Day temperature and DC→AC efficiency"}
              </CardDescription>
            </div>
            <Tabs value={chart} onValueChange={(v) => setUrl({ chart: v === "yield" ? null : v })}>
              <TabsList variant="line" aria-label="Inverter chart">
                <TabsTrigger value="yield">Yield & PR</TabsTrigger>
                <TabsTrigger value="thermal">Temperature</TabsTrigger>
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
              Loss breakdown
              <Badge variant="neutral">modelled</Badge>
            </CardTitle>
            <CardDescription>
              {ov.loss_waterfall[0]?.stage.includes("measured")
                ? "From measured plane-of-array insolation × kWp to the measured AC yield"
                : "From a reference derived from peer-relative PR to the measured AC yield"}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {waterfall ? (
              <PanelChart spec={waterfall} height={340} />
            ) : (
              <p className="py-10 text-center text-xs text-muted-foreground">
                Not built for this day: it needs the day's yield, a PR, and inverter temperature and efficiency, all measured.
              </p>
            )}
          </CardContent>
        </Card>
      </div>

      <GoogleWeatherPanel plantId={ov.plant.plant_id} day={day} />

      {inverters.length > 0 && target != null && <InverterTable inverters={inverters} target={target} dayText={dayText} />}

      <p className="text-[11px] text-muted-foreground">
        Live values per inverter are on the{" "}
        <Link className="text-solar-300 underline-offset-2 hover:underline" to={plantHref("inverters")}>
          Inverters
        </Link>{" "}
        tab; irradiance and module temperature on{" "}
        <Link className="text-solar-300 underline-offset-2 hover:underline" to={`${plantHref("sensors")}#weather-station`}>
          Sensors
        </Link>
        .
      </p>
    </div>
  );
};
