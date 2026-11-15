import React, { useEffect, useMemo, useState } from "react";
import { Building2, Cpu } from "lucide-react";
import { useAppContext, usePlantHref } from "../context/AppContext";
import { pick, useUrlState } from "@/lib/useUrlState";
import { SelectedPlantBanner } from "../components/SelectedPlantBanner";
import { InverterProfilePanel } from "../components/InverterProfilePanel";
import { InverterTrendPanel, StringHeatmapPanel } from "../components/InverterCharts";
import { GrowattAlarmLogPanel } from "../components/GrowattAlarmLogPanel";
import { api } from "../api/client";
import type { GrowattInverterTimeseries } from "../api/client";
import { EmptyState, LoadingState } from "../components/ui";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { PlantInvertersCard } from "./inverters/PlantInvertersCard";
import { InverterCard } from "./inverters/InverterCard";
import { GridFaultCards, MpptCard, StringsCard } from "./inverters/DetailTabs";
import { invName, liveState } from "./inverters/shared";
import type { LiveState, OverviewInverter } from "./inverters/shared";

type DetailTab = "performance" | "strings" | "grid" | "history";
const DETAIL_TABS: Array<{ id: DetailTab; label: string }> = [
  { id: "performance", label: "Performance" },
  { id: "strings", label: "Strings" },
  { id: "grid", label: "Grid & faults" },
  { id: "history", label: "History" },
];
const DETAIL_TAB_IDS = DETAIL_TABS.map((t) => t.id);

/**
 * The plant's inverters, top to bottom: the plant card (now vs stored day, one comparison table
 * whose rows pick the inverter), the selected inverter's card, then its tabs. "Now" values come
 * from the live record as the backend sent it (`plantLive`), not from the overview overlay,
 * because the stored day can be an earlier day than the live record; the overlay is applied only
 * when both are the same day.
 */
export const InvertersPage: React.FC = () => {
  const { selectedGrowattPlantId, selectedPlantOverview, plantOverviewLoading, plantLive, plantLiveLoading, plantLiveFailed } =
    useAppContext();
  const plantHref = usePlantHref();
  // selected inverter and tab live in the URL (?sn=&tab=): reload / shared link keep them
  const [query, setQuery] = useUrlState();
  const selectedSn = query.get("sn");
  const tab = pick(query.get("tab"), DETAIL_TAB_IDS, "performance");
  const setTab = (t: DetailTab) => setQuery({ tab: t === "performance" ? null : t });

  const ov = selectedPlantOverview;
  const inverters = useMemo(() => ov?.inverters ?? [], [ov]);
  const day = ov?.meta.day ?? null;

  const inv = useMemo(() => inverters.find((i) => i.device_sn === selectedSn) ?? inverters[0] ?? null, [inverters, selectedSn]);
  const index = inv ? inverters.indexOf(inv) : -1;

  // live state per inverter, from the newest live record only
  const live = plantLive?.data ?? null;
  const states = useMemo(() => {
    const bySn = new Map((live?.inverters ?? []).map((r) => [r.device_sn, r]));
    return new Map<string, LiveState>(
      inverters.map((i) => [i.device_sn, liveState(bySn.get(i.device_sn), plantLiveLoading, plantLiveFailed)])
    );
  }, [live, inverters, plantLiveLoading, plantLiveFailed]);
  const liveAt = (live?.inverters ?? []).reduce<string | null>((a, r) => (r.timestamp && (a == null || r.timestamp > a) ? r.timestamp : a), null);

  // stored day: each inverter's yield against the mean of the inverters with a yield
  const avgYield = useMemo(() => {
    const ys = inverters.map((i) => i.yield_today_kwh).filter((v): v is number => v != null);
    return ys.length ? ys.reduce((a, b) => a + b, 0) / ys.length : null;
  }, [inverters]);
  const pctOfAvg = (i: OverviewInverter) => (i.yield_today_kwh != null && avgYield ? (i.yield_today_kwh / avgYield) * 100 : null);

  // one inverter-day of stored 5-min history, shared by the profile chart and the string heatmap
  const [series, setSeries] = useState<GrowattInverterTimeseries | null>(null);
  const [seriesLoading, setSeriesLoading] = useState(false);
  const invSn = inv?.device_sn ?? null;
  useEffect(() => {
    if (selectedGrowattPlantId == null || !invSn) {
      setSeries(null);
      return;
    }
    let cancelled = false;
    setSeriesLoading(true);
    api
      .getGrowattInverterTimeseries(selectedGrowattPlantId, invSn, day ?? undefined)
      .then((r) => !cancelled && setSeries(r))
      .catch(() => !cancelled && setSeries(null))
      .finally(() => !cancelled && setSeriesLoading(false));
    return () => {
      cancelled = true;
    };
  }, [selectedGrowattPlantId, invSn, day]);

  if (plantOverviewLoading && !ov) {
    return (
      <div className="flex flex-col gap-4">
        <SelectedPlantBanner />
        <LoadingState label="Loading the plant's inverters…" shape="page" />
      </div>
    );
  }
  if (!ov || selectedGrowattPlantId == null) {
    return (
      <div className="flex flex-col gap-4">
        <SelectedPlantBanner />
        <EmptyState icon={Building2} title="Select a plant from the directory" description="Pick a plant on Plant Overview to see its inverters." />
      </div>
    );
  }
  if (inverters.length === 0 || !inv) {
    return (
      <div className="flex flex-col gap-4">
        <SelectedPlantBanner />
        <EmptyState icon={Cpu} title="No inverters" description="This plant has no inverters in the registry yet." />
      </div>
    );
  }

  const select = (sn: string) => {
    setQuery({ sn });
    // bring the inverter card into view when it is mostly below the screen (phones, long tables)
    const el = document.getElementById("inverter-detail");
    if (el && el.getBoundingClientRect().top > window.innerHeight * 0.6) el.scrollIntoView({ behavior: "smooth", block: "start" });
  };
  const step = (delta: -1 | 1) => setQuery({ sn: inverters[(index + delta + inverters.length) % inverters.length].device_sn });
  const state = states.get(inv.device_sn) ?? ({ kind: "waiting" } as LiveState);
  const invStrings = ov.strings.filter((s) => s.device_sn === inv.device_sn).sort((a, b) => a.string_no - b.string_no);
  const invInactive = (ov.inactive_strings ?? []).filter((s) => s.device_sn === inv.device_sn);
  const invAnomalies = ov.anomalies.filter((a) => a.device_sn === inv.device_sn);
  const check = live?.string_check?.inverters[inv.device_sn] ?? null;
  // stored day: strings with a finding or inactive, per inverter (table filter and badge)
  const issues = new Map<string, number>();
  for (const x of [...ov.anomalies, ...(ov.inactive_strings ?? [])]) issues.set(x.device_sn, (issues.get(x.device_sn) ?? 0) + 1);

  return (
    <div className="flex flex-col gap-4">
      <SelectedPlantBanner />

      <PlantInvertersCard
        inverters={inverters}
        kpis={ov.kpis}
        day={day}
        dataUntil={ov.meta.data_until ?? null}
        liveDay={live?.day ?? null}
        liveAt={liveAt}
        liveLoading={plantLiveLoading}
        liveFailed={plantLiveFailed && !live}
        liveErrors={live?.errors ?? {}}
        states={states}
        pctOfAvg={pctOfAvg}
        issues={issues}
        selectedSn={inv.device_sn}
        onSelect={select}
      />

      <InverterCard
        inv={inv}
        state={state}
        datalogger={live?.dataloggers?.find((d) => d.datalogger_sn === inv.datalogger_sn) ?? null}
        day={day}
        pct={pctOfAvg(inv)}
        anomalies={invAnomalies}
        inactiveCount={invInactive.length}
        index={index}
        count={inverters.length}
        onStep={step}
        onTab={setTab}
      />

      <Tabs value={tab} onValueChange={(v) => setTab(v as DetailTab)}>
        <TabsList variant="line" aria-label={`${invName(inv)} details`}>
          {DETAIL_TABS.map(({ id, label }) => (
            <TabsTrigger key={id} value={id}>
              {label}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>

      {tab === "performance" && (
        <div className="flex flex-col gap-4">
          <InverterProfilePanel deviceSn={inv.device_sn} label={invName(inv)} series={series} loading={seriesLoading} />
          <MpptCard inv={inv} state={state} />
        </div>
      )}

      {tab === "strings" && (
        <div className="flex flex-col gap-4">
          <StringsCard
            inv={inv}
            state={state}
            check={check}
            strings={invStrings}
            inactive={invInactive}
            day={day}
            stringsHref={`${plantHref("strings")}?inv=${encodeURIComponent(inv.device_sn)}`}
          />
          <StringHeatmapPanel label={invName(inv)} series={series} loading={seriesLoading} />
        </div>
      )}

      {tab === "grid" && (
        <div className="flex flex-col gap-4">
          <GridFaultCards state={state} />
          <GrowattAlarmLogPanel plantId={ov.plant.plant_id} plantName={ov.plant.name} day={day} deviceSn={inv.device_sn} />
        </div>
      )}

      {tab === "history" && <InverterTrendPanel plantId={ov.plant.plant_id} deviceSn={inv.device_sn} label={invName(inv)} day={day} />}
    </div>
  );
};
