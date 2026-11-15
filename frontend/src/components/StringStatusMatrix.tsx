import React, { useEffect, useMemo, useState } from "react";
import { Grid3x3 } from "lucide-react";
import { useAppContext } from "../context/AppContext";
import { inverterStatusLevel } from "../context/PlantContext";
import { Panel, Led, Meter, statusLevel, fmt } from "./ui";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";

/**
 * Selected plant's string tiles, grouped by inverter and laid out by MPPT (string n sits on
 * MPPT ⌈n/2⌉), including inputs that carry no current today ("Not active"). Inverters with
 * no string rows stay listed. Click a tile to open its I-V curve in the String Inspector modal.
 */
export const StringStatusMatrix: React.FC = () => {
  const { selectedGrowattPlantId, selectedPlantOverview, setInspectedStringId, plantLiveLoading, plantLive } = useAppContext();

  const [selectedInverterSn, setSelectedInverterSn] = useState<string>("ALL");
  const [groupByInverter, setGroupByInverter] = useState(true);

  useEffect(() => {
    setSelectedInverterSn("ALL");
  }, [selectedGrowattPlantId]);

  const inverters = selectedPlantOverview?.inverters || [];
  const strings = selectedPlantOverview?.strings || [];
  const inactiveStrings = selectedPlantOverview?.inactive_strings || [];

  const filteredStrings = useMemo(() => {
    if (selectedInverterSn === "ALL") return strings;
    return strings.filter((s) => s.device_sn === selectedInverterSn);
  }, [strings, selectedInverterSn]);

  type StringRow = (typeof strings)[number];
  type InactiveRow = (typeof inactiveStrings)[number];
  type Slot = { kind: "active"; s: StringRow } | { kind: "inactive"; s: InactiveRow };
  const stringGroups = useMemo(() => {
    const bySn = new Map<string, Slot[]>();
    const add = (sn: string, slot: Slot) => bySn.set(sn, [...(bySn.get(sn) ?? []), slot]);
    for (const s of filteredStrings) add(s.device_sn, { kind: "active", s });
    for (const s of inactiveStrings) {
      if (selectedInverterSn === "ALL" || s.device_sn === selectedInverterSn) add(s.device_sn, { kind: "inactive", s });
    }
    const shown = selectedInverterSn === "ALL" ? inverters : inverters.filter((i) => i.device_sn === selectedInverterSn);
    return shown.map((inv) => {
      const slots = (bySn.get(inv.device_sn) ?? []).sort((a, b) => a.s.string_no - b.s.string_no);
      const mppts = new Map<number, Slot[]>();
      for (const slot of slots) mppts.set(slot.s.mppt_no, [...(mppts.get(slot.s.mppt_no) ?? []), slot]);
      const levels = slots.filter((x) => x.kind === "active").map((x) => statusLevel(x.s.status));
      return {
        inv,
        mppts: [...mppts.entries()].sort((a, b) => a[0] - b[0]),
        active: levels.length,
        inactive: slots.length - levels.length,
        crit: levels.filter((l) => l === "crit").length,
        warn: levels.filter((l) => l === "warn").length,
      };
    });
  }, [filteredStrings, inactiveStrings, inverters, selectedInverterSn]);

  if (!selectedPlantOverview) return null;

  const renderInactiveTile = (s: InactiveRow) => (
    <div
      key={s.string_id}
      title={
        s.reason === "no_current"
          ? `${s.string_id}: MPPT voltage present, no string current today (unused input or no light yet)`
          : `${s.string_id}: input not reported today`
      }
      className="rounded-xl border border-dashed border-white/[0.08] bg-transparent p-3 opacity-70"
    >
      <div className="flex items-center justify-between">
        <span className="num text-xs font-bold text-slate-400">{s.short_label}</span>
        <Led level="neutral" />
      </div>
      <div className="num mt-0.5 truncate text-[11px] text-slate-500">
        {s.device_sn} · {s.mppt_id}
      </div>
      <div className="mt-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Not active</div>
      <div className="num mt-2 text-[11px] text-slate-500">
        {s.reason === "no_current" ? `MPPT ${fmt(s.v_max, 0)}V · 0 A` : "No data"}
      </div>
    </div>
  );

  const renderStringTile = (s: StringRow) => {
    const lvl = statusLevel(s.status);
    const pr = s.pr_pct;
    const isLive = s.live_current_a != null;
    const border =
      lvl === "crit"
        ? "border-red-500/40 bg-red-500/[0.04] hover:border-red-400/70"
        : lvl === "warn"
        ? "border-amber-400/35 bg-amber-400/[0.03] hover:border-amber-400/60"
        : "border-white/[0.07] bg-ink-850/90 hover:border-emerald-400/40";
    return (
      <div
        key={s.string_id}
        onClick={() => setInspectedStringId(s.string_id)}
        title={`Click to inspect ${s.string_id} I-V & P-V curves`}
        className={`group relative cursor-pointer rounded-xl border p-3 transition-all hover:-translate-y-0.5 hover:shadow-lg ${border}`}
      >
        <div className="flex items-center justify-between">
          <span className="num text-xs font-bold text-white group-hover:text-solar-300">{s.short_label}</span>
          <Led level={lvl} pulse={lvl === "crit"} />
        </div>
        <div className="num mt-0.5 truncate text-[11px] text-slate-500">
          {s.device_sn} · {s.mppt_id}
        </div>

        <div className="mt-2 flex items-baseline justify-between">
          <div>
            <div className="text-[10px] uppercase text-slate-500">PR</div>
            <div className="num text-base font-bold text-white">{pr == null ? "—" : `${fmt(pr, 1)}%`}</div>
          </div>
          <div className="text-right">
            <div className="text-[10px] uppercase text-slate-500">Peak</div>
            <div className="num text-xs font-semibold text-slate-200">{fmt(s.p_max_w / 1000, 2)} kW</div>
          </div>
        </div>

        <div className="mt-2">
          <Meter value={pr ?? 0} tone={lvl === "crit" ? "crit" : lvl === "warn" ? "warn" : "ok"} />
        </div>

        <div className="mt-2 flex items-center justify-between text-[11px] text-slate-500">
          {isLive ? (
            <span className="num text-sky-300" title={`Live record ${s.live_at ?? ""}`}>
              Now {fmt(s.live_voltage_v, 0)}V · {fmt(s.live_current_a, 1)}A · {fmt((s.live_power_w ?? 0) / 1000, 2)}kW
            </span>
          ) : (
            <span className="num" title="Today's average from the database (no live value)">
              Avg {fmt(s.v_avg, 0)}V · {fmt(s.i_avg, 1)}A
            </span>
          )}
          <span className="text-solar-400 opacity-0 transition group-hover:opacity-100">I-V →</span>
        </div>
      </div>
    );
  };

  return (
    <Panel
      icon={Grid3x3}
      title={`String Status Matrix (${filteredStrings.length} Strings${
        selectedInverterSn !== "ALL" ? ` on ${selectedInverterSn}` : ""
      })`}
      subtitle={
        selectedPlantOverview.live
          ? `Now = newest Growatt record per string (live; fetched ${new Date(
              selectedPlantOverview.live.fetched_at
            ).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}). PR & Peak = today from the database. Click a tile for its I-V curve.`
          : plantLiveLoading
          ? "Loading live values… showing today's averages from the database meanwhile. Click a tile for its I-V curve."
          : "Live values unavailable — showing today's averages from the database. Click a tile for its I-V curve."
      }
      actions={
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex cursor-pointer items-center gap-1.5 text-xs text-slate-300">
            <input
              type="checkbox"
              checked={groupByInverter}
              onChange={(e) => setGroupByInverter(e.target.checked)}
              className="accent-sky-400"
            />
            Group by inverter
          </label>
          <Select value={selectedInverterSn} onValueChange={(v) => setSelectedInverterSn(v)}>
            <SelectTrigger size="sm" className="w-44 text-[11px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="ALL">All Inverters ({strings.length} strings)</SelectItem>
              {inverters.map((inv) => (
                <SelectItem key={inv.device_sn} value={inv.device_sn}>
                  {inv.device_sn} ({inv.string_count} strings)
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      }
    >
      {groupByInverter ? (
        <div className="space-y-4">
          {stringGroups.map(({ inv, mppts, active, inactive, crit, warn }) => {
            // Judged on the raw live answer (the overlay is not applied when the stored day is older).
            // Offline = Growatt answered and has no record of it today (or says it lost it); an
            // inverter Growatt refused (`errors`) is unknown, never Offline.
            const liveData = plantLive?.data ?? null;
            const rec = liveData?.inverters.find((r) => r.device_sn === inv.device_sn);
            const status = rec?.status ?? inv.status;
            const offline = Boolean(inv.lost) || (liveData != null && !rec && !(inv.device_sn in (liveData.errors ?? {})));
            const lvl = offline ? "crit" : inverterStatusLevel(status);
            return (
              <section key={inv.device_sn} className="rounded-xl border border-white/[0.06] bg-white/[0.015] p-3">
                <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
                  {/* spinner only while the live request runs; an inverter missing from the live answer
                      (no record yet today: asleep, offline) says so instead of loading forever */}
                  {status == null && !inv.lost && plantLiveLoading ? (
                    <Spinner className="size-3" aria-label="Loading live status…" />
                  ) : (
                    <Led level={lvl} />
                  )}
                  <button
                    type="button"
                    onClick={() => setSelectedInverterSn(selectedInverterSn === inv.device_sn ? "ALL" : inv.device_sn)}
                    className="num font-bold text-white hover:text-sky-300"
                    title="Show only this inverter"
                  >
                    {inv.device_sn}
                  </button>
                  <span className="num text-slate-500">{inv.model}</span>
                  {offline ? (
                    <span className="text-red-300" title="Growatt has no record of this inverter today">
                      Offline
                    </span>
                  ) : status === 0 ? (
                    <span className="text-amber-300" title="Growatt status 0: waiting to start (not producing)">
                      Waiting
                    </span>
                  ) : (
                    status == null &&
                    !plantLiveLoading && <span className="text-slate-500">Live unavailable</span>
                  )}
                  <span className="num text-sky-300">{active} active</span>
                  {inactive > 0 && <span className="num text-slate-500">{inactive} not active</span>}
                  {crit > 0 && <span className="num text-red-300">{crit} critical</span>}
                  {warn > 0 && <span className="num text-amber-300">{warn} warning</span>}
                  <span className="num ml-auto text-slate-400">
                    Now {fmt(inv.current_ac_kw, 2)} kW · Peak {fmt(inv.peak_ac_kw, 2)} kW
                  </span>
                </div>
                {mppts.length ? (
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                    {mppts.map(([mppt, slots]) => (
                      <div key={mppt} className="rounded-lg border border-white/[0.05] p-2">
                        <div className="num mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                          MPPT {mppt}
                        </div>
                        <div className="grid grid-cols-2 gap-2">
                          {slots.map((x) => (x.kind === "active" ? renderStringTile(x.s) : renderInactiveTile(x.s)))}
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="text-xs text-slate-500">No string data stored for this inverter today.</div>
                )}
              </section>
            );
          })}
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 xl:grid-cols-8">
            {filteredStrings.slice(0, 64).map(renderStringTile)}
          </div>
          {filteredStrings.length > 64 && (
            <div className="mt-3 text-xs text-slate-500">
              Showing 64 of {filteredStrings.length} strings. Group by inverter or pick an inverter to see all.
            </div>
          )}
        </>
      )}
    </Panel>
  );
};
