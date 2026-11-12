import React, { useMemo, useState } from "react";
import { Layers, GitCommitHorizontal, Compass, Cpu, Zap, AlertTriangle } from "lucide-react";
import { useAppContext } from "../context/AppContext";
import { Panel, Led, statusLevel, fmt } from "./ui";

type TwinView = "roof" | "sld";
type OverlayMode = "status" | "pr" | "peer";

export const DigitalTwinPanel: React.FC = () => {
  const { analysisRun, activePlant, setInspectedStringId } = useAppContext();
  const [view, setView] = useState<TwinView>("roof");
  const [overlay, setOverlay] = useState<OverlayMode>("status");

  const strings = analysisRun?.string_summary_json || [];
  const kpis = analysisRun?.plant_kpis_json || {};
  // Module count per string (strings can differ); unknown strings draw no modules.
  const modulesByString = useMemo(
    () => new Map((activePlant?.string_specs ?? []).map((sp) => [sp.string_id, sp.modules_per_string])),
    [activePlant]
  );
  const modulesOf = (s: Record<string, any>): number =>
    modulesByString.get(String(s.string_id)) ?? activePlant?.modules_per_string ?? 0;

  const inverters = useMemo(() => {
    const map = new Map<
      string,
      { id: string; strings: Record<string, any>[]; energy: number; cap: number; worst: number }
    >();
    const rank = (s: string) => (s === "Critical" ? 2 : s === "Healthy" ? 0 : 1);
    for (const s of strings) {
      const id = String(s.inverter_id || "INV");
      const entry = map.get(id) || { id, strings: [], energy: 0, cap: 0, worst: 0 };
      entry.strings.push(s);
      entry.energy += Number(s.actual_energy_kwh || 0);
      entry.cap += Number(s.capacity_kwp || 0);
      entry.worst = Math.max(entry.worst, rank(String(s.status)));
      map.set(id, entry);
    }
    return Array.from(map.values()).sort((a, b) => a.id.localeCompare(b.id));
  }, [strings]);

  const peakKw = Math.max(
    0,
    ...(analysisRun?.daily_plant_json || []).map((r) => Number(r.peak_power_kw || 0))
  );

  // Module color helper for 2D rooftop array
  const getModuleStyle = (s: Record<string, any>, modIdx: number) => {
    const lvl = statusLevel(s.status);
    const diag = String(s.primary_diagnosis || "").toLowerCase();
    const pr = Number(s.pr_pct || 0);
    const gap = Number(s.peer_gap_pct || 0);

    if (overlay === "pr") {
      if (pr >= 88) return "bg-emerald-400/75 border-emerald-300/60";
      if (pr >= 82) return "bg-sky-400/75 border-sky-300/60";
      if (pr >= 74) return "bg-amber-400/80 border-amber-300/70";
      return "bg-red-500/80 border-red-300/70";
    }

    if (overlay === "peer") {
      if (gap >= -2) return "bg-emerald-400/75 border-emerald-300/60";
      if (gap >= -8) return "bg-amber-400/75 border-amber-300/60";
      return "bg-red-500/80 border-red-300/70";
    }

    // Default: "status" mode with realistic sub-string fault localization
    if (lvl === "crit") {
      return "bg-red-500/55 border-red-400/70";
    }
    if (lvl === "warn") {
      // Highlight partial shading on last 5 modules or bypassed diode on middle sub-string
      if (diag.includes("shad") && modIdx >= modulesOf(s) - 5) {
        return "bg-amber-400/85 border-amber-200";
      }
      if (diag.includes("diode") && modIdx >= 6 && modIdx < 12) {
        return "bg-amber-400/85 border-amber-200";
      }
      if (modIdx % 4 === 0) {
        return "bg-amber-400/75 border-amber-300/70";
      }
      return "bg-sky-500/45 border-amber-400/45";
    }
    return "bg-sky-500/45 border-sky-300/40 group-hover:bg-emerald-400/60";
  };

  return (
    <Panel
      icon={view === "roof" ? Layers : GitCommitHorizontal}
      title="Interactive Rooftop Digital Twin & Electrical Single-Line Diagram"
      subtitle="Click any PV string array or feeder to open the String Telemetry Inspector"
      actions={
        <div className="flex flex-wrap items-center gap-2">
          {view === "roof" && (
            <div className="tabs">
              <button
                onClick={() => setOverlay("status")}
                className={`tab text-[11px] ${overlay === "status" ? "tab-active" : ""}`}
              >
                Diagnostic Status
              </button>
              <button
                onClick={() => setOverlay("pr")}
                className={`tab text-[11px] ${overlay === "pr" ? "tab-active" : ""}`}
              >
                PR % Thermal
              </button>
              <button
                onClick={() => setOverlay("peer")}
                className={`tab text-[11px] ${overlay === "peer" ? "tab-active" : ""}`}
              >
                Peer Gap
              </button>
            </div>
          )}
          <div className="tabs">
            <button
              onClick={() => setView("roof")}
              className={`tab ${view === "roof" ? "tab-active" : ""}`}
            >
              <Layers className="h-3.5 w-3.5" />
              2D Roof Array Map
            </button>
            <button
              onClick={() => setView("sld")}
              className={`tab ${view === "sld" ? "tab-active" : ""}`}
            >
              <GitCommitHorizontal className="h-3.5 w-3.5" />
              Electrical SLD
            </button>
          </div>
        </div>
      }
    >
      {view === "roof" ? (
        /* ================================================================== */
        /* TAB 1: 2D ROOFTOP ARRAY DIGITAL TWIN                               */
        /* ================================================================== */
        <div className="space-y-4">
          <div className="grid-backdrop relative overflow-hidden rounded-xl border border-dashed border-amber-400/30 bg-ink-950/90 p-4 sm:p-5">
            {/* Roof Perimeter Safety Lifeline & Compass HUD */}
            <div className="mb-4 flex flex-wrap items-center justify-between gap-2 border-b border-white/[0.06] pb-3 text-[11px]">
              <div className="flex items-center gap-3">
                <span className="inline-flex items-center gap-1.5 rounded-full border border-amber-400/30 bg-amber-500/10 px-2.5 py-0.5 text-[11px] font-semibold text-amber-300">
                  Perimeter Lifeline & Fall-Arrest Zone (ISO 45001)
                </span>
                <span className="text-slate-500">
                  Tilt <strong className="num text-slate-300">12° S</strong> · Azimuth{" "}
                  <strong className="num text-slate-300">180°</strong>
                </span>
              </div>
              <div className="flex items-center gap-3 text-[11px] text-slate-400">
                <span className="inline-flex items-center gap-1">
                  <span className="h-2.5 w-2.5 rounded-xs bg-sky-500/60 ring-1 ring-sky-300/50" /> Healthy Module
                </span>
                <span className="inline-flex items-center gap-1">
                  <span className="h-2.5 w-2.5 rounded-xs bg-amber-400/85 ring-1 ring-amber-200" /> Shaded / Bypassed Diode
                </span>
                <span className="inline-flex items-center gap-1">
                  <span className="h-2.5 w-2.5 rounded-xs bg-red-500/70 ring-1 ring-red-300" /> Open-Circuit String
                </span>
                <span className="num inline-flex items-center gap-1 text-solar-400">
                  <Compass className="h-3.5 w-3.5" /> N ↑
                </span>
              </div>
            </div>

            {/* Roof Bays by Inverter */}
            <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
              {inverters.map((inv, invIdx) => (
                <div
                  key={inv.id}
                  className="rounded-xl border border-white/[0.08] bg-ink-900/85 p-4 shadow-inner"
                >
                  <div className="mb-3 flex items-center justify-between border-b border-white/[0.06] pb-2">
                    <div className="flex items-center gap-2">
                      <Cpu className="h-4 w-4 text-energy-400" />
                      <span className="text-xs font-bold text-white">
                        Roof Bay {invIdx === 0 ? "A (West Wing)" : "B (East Wing)"} — {inv.id}
                      </span>
                      <Led level={inv.worst === 2 ? "crit" : inv.worst === 1 ? "warn" : "ok"} pulse={inv.worst === 2} />
                    </div>
                    <span className="num text-[11px] text-slate-400">
                      {fmt(inv.cap, 1)} kWp · {fmt(inv.energy, 1)} kWh
                    </span>
                  </div>

                  <div className="space-y-2.5">
                    {inv.strings.map((s) => {
                      const lvl = statusLevel(s.status);
                      const gap = Number(s.peer_gap_pct || 0);
                      const borderTone =
                        lvl === "crit"
                          ? "border-red-400/50 bg-red-500/[0.07] hover:border-red-400"
                          : lvl === "warn"
                          ? "border-amber-400/40 bg-amber-500/[0.05] hover:border-amber-300"
                          : "border-white/10 bg-ink-950/60 hover:border-energy-400/50";

                      return (
                        <button
                          key={String(s.string_id)}
                          onClick={() => setInspectedStringId(String(s.string_id))}
                          className={`group flex w-full cursor-pointer flex-col gap-1.5 rounded-lg border p-2.5 text-left transition ${borderTone}`}
                        >
                          <div className="flex flex-wrap items-center justify-between gap-2 text-[11px]">
                            <div className="flex items-center gap-2">
                              <Led
                                level={lvl === "info" || lvl === "neutral" ? "ok" : lvl}
                                pulse={lvl === "crit"}
                              />
                              <span className="num font-bold text-white">{s.string_id}</span>
                              <span className="num text-[11px] text-slate-500">{s.mppt_id}</span>
                              {lvl !== "ok" && (
                                <span className="inline-flex items-center gap-1 rounded bg-white/5 px-1.5 py-0.5 text-[11px] text-amber-300">
                                  <AlertTriangle className="h-2.5 w-2.5" />
                                  {s.primary_diagnosis}
                                </span>
                              )}
                            </div>
                            <div className="num flex items-center gap-3 text-[11px]">
                              <span className="text-slate-400">
                                {fmt(s.avg_vmp_v, 0)}V · {fmt(s.avg_imp_a, 1)}A
                              </span>
                              <span className="font-bold text-solar-400">PR {fmt(s.pr_pct, 1)}%</span>
                              <span
                                className={
                                  gap < -8
                                    ? "font-semibold text-red-400"
                                    : gap < 0
                                    ? "text-amber-400"
                                    : "text-emerald-400"
                                }
                              >
                                {gap >= 0 ? "+" : ""}
                                {fmt(gap, 1)}%
                              </span>
                            </div>
                          </div>

                          {/* Physical PV modules on the rack (this string's own count) */}
                          <div
                            className="grid gap-1 pt-0.5"
                            style={{
                              gridTemplateColumns: `repeat(${Math.min(modulesOf(s), 24)}, minmax(0, 1fr))`,
                            }}
                          >
                            {Array.from({ length: Math.min(modulesOf(s), 24) }).map((_, mIdx) => (
                              <div
                                key={mIdx}
                                className={`h-5 rounded-[2px] border transition ${getModuleStyle(s, mIdx)}`}
                                title={`${s.string_id} · Module #${mIdx + 1}`}
                              />
                            ))}
                          </div>
                        </button>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      ) : (
        /* ================================================================== */
        /* TAB 2: INTERACTIVE ELECTRICAL SINGLE-LINE DIAGRAM (SLD)            */
        /* ================================================================== */
        <div className="scroll-x-hint overflow-x-auto">
          <div className="grid-backdrop min-w-[920px] rounded-xl border border-white/[0.08] bg-ink-950/90 p-5">
            <div className="grid grid-cols-12 items-center gap-4">
              {/* COLUMN 1: PV Strings + DC Fuses (col-span-5) */}
              <div className="col-span-5 space-y-2">
                <div className="eyebrow mb-2">1. Rooftop PV String Feeders (DC 1000V)</div>
                {strings.map((s) => {
                  const lvl = statusLevel(s.status);
                  const isCrit = lvl === "crit";
                  return (
                    <button
                      key={String(s.string_id)}
                      onClick={() => setInspectedStringId(String(s.string_id))}
                      className={`flex w-full cursor-pointer items-center justify-between gap-2 rounded-lg border px-3 py-1.5 text-left text-[11px] transition ${
                        isCrit
                          ? "border-red-400/50 bg-red-500/10 text-red-200"
                          : lvl === "warn"
                          ? "border-amber-400/40 bg-amber-500/[0.06] text-amber-100"
                          : "border-white/10 bg-ink-900/90 text-slate-200 hover:border-solar-400/50"
                      }`}
                    >
                      <div className="flex items-center gap-2">
                        <Led level={lvl === "info" || lvl === "neutral" ? "ok" : lvl} pulse={isCrit} />
                        <span className="num font-bold">{s.string_id}</span>
                        <span className="num text-[11px] text-slate-500">
                          {s.inverter_id}/{s.mppt_id}
                        </span>
                      </div>
                      <div className="num flex items-center gap-2 text-[11px]">
                        <span>{fmt(s.avg_vmp_v, 0)} V</span>
                        <span>·</span>
                        <span className={isCrit ? "font-bold text-red-400" : "text-energy-300"}>
                          {fmt(s.avg_imp_a, 2)} A
                        </span>
                        <span
                          className={`rounded border px-1.5 py-0.5 text-[10px] font-bold ${
                            isCrit
                              ? "border-red-400/50 bg-red-500/20 text-red-300"
                              : "border-emerald-400/30 bg-emerald-500/10 text-emerald-300"
                          }`}
                        >
                          {isCrit ? "FUSE OPEN" : "CLOSED"}
                        </span>
                      </div>
                    </button>
                  );
                })}
              </div>

              {/* COLUMN 2: String Inverters (col-span-3) */}
              <div className="col-span-3 space-y-4">
                <div className="eyebrow mb-2 text-center">2. String Inverters (DC/AC)</div>
                {inverters.map((inv) => (
                  <div
                    key={inv.id}
                    className="relative rounded-xl border border-energy-400/35 bg-ink-900/90 p-3.5 shadow-[0_0_24px_-8px_rgba(34,211,238,0.4)]"
                  >
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <Cpu className="h-4 w-4 text-energy-400" />
                        <span className="num text-xs font-bold text-white">{inv.id}</span>
                      </div>
                      <Led level={inv.worst === 2 ? "crit" : inv.worst === 1 ? "warn" : "ok"} />
                    </div>
                    <div className="mt-2 flex items-center justify-between text-[11px] text-slate-400">
                      <span>MPPT 1000V DC → 400V AC</span>
                      <span className="num font-semibold text-energy-300">{inv.strings.length} Strings</span>
                    </div>
                    <div className="num mt-2 grid grid-cols-2 gap-2 border-t border-white/[0.06] pt-2 text-[11px]">
                      <div>
                        <div className="text-[11px] text-slate-500">Capacity</div>
                        <div className="font-bold text-solar-400">{fmt(inv.cap, 1)} kWp</div>
                      </div>
                      <div>
                        <div className="text-[11px] text-slate-500">Yield</div>
                        <div className="font-bold text-white">{fmt(inv.energy, 1)} kWh</div>
                      </div>
                    </div>
                  </div>
                ))}
              </div>

              {/* COLUMN 3: LV ACB -> MV Transformer -> PCC Grid (col-span-4) */}
              <div className="col-span-4 space-y-3">
                <div className="eyebrow mb-2">3. LV Switchgear · MV Transformer · PCC Grid</div>

                <div className="rounded-xl border border-white/10 bg-ink-900/90 p-3.5">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-bold text-slate-100">LV Solar Main Switchboard (ACB-01)</span>
                    <span className="badge badge-ok">CLOSED · 400V</span>
                  </div>
                  <div className="num mt-1.5 flex justify-between text-[11px] text-slate-400">
                    <span>3P4W · 50.02 Hz · PF 0.992</span>
                    <span className="text-emerald-400">LOTO Clear</span>
                  </div>
                </div>

                <div className="rounded-xl border border-solar-400/30 bg-ink-900/90 p-3.5">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-bold text-slate-100">MV Step-Up Transformer (TX-01)</span>
                    <span className="badge badge-info">0.4 / 22 kV · Dyn11</span>
                  </div>
                  <div className="num mt-1.5 flex justify-between text-[11px] text-slate-400">
                    <span>Oil Temp: 54.2°C · Buchholz OK</span>
                    <span className="text-solar-400">Peak {fmt(peakKw, 1)} kW</span>
                  </div>
                </div>

                <div className="rounded-xl border border-emerald-400/35 bg-emerald-500/[0.07] p-3.5 shadow-[0_0_24px_-8px_rgba(52,211,153,0.5)]">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <Zap className="h-4 w-4 text-emerald-400" />
                      <span className="text-xs font-bold text-white">PCC Revenue Meter (PEA / MEA Grid)</span>
                    </div>
                    <Led level="ok" pulse />
                  </div>
                  <div className="num mt-2 grid grid-cols-2 gap-2 border-t border-white/10 pt-2 text-xs">
                    <div>
                      <div className="text-[11px] text-slate-400">Net Energy Export</div>
                      <div className="font-bold text-emerald-300">
                        {fmt(kpis.total_energy_kwh, 1)} kWh
                      </div>
                    </div>
                    <div>
                      <div className="text-[11px] text-slate-400">Plant PR</div>
                      <div className="font-bold text-solar-300">{fmt(kpis.plant_pr_pct, 2)}%</div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </Panel>
  );
};
